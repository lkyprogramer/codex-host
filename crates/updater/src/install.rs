#[cfg(target_os = "macos")]
use std::env;
use std::error::Error;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::fs::{self, File};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::io::Read;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use codexhost_platform::configure_background_command;
#[cfg(target_os = "macos")]
use codexhost_platform::{PlatformError, exchange_paths};
#[cfg(any(target_os = "windows", target_os = "macos"))]
use serde::Deserialize;
#[cfg(any(target_os = "windows", target_os = "macos"))]
use sha2::{Digest, Sha256};

#[cfg(any(target_os = "windows", target_os = "macos"))]
use crate::request::validate_version;
use crate::request::{
    Installation, MacOsInstallation, NpmInstallation, UpdateRequest, WindowsInstallation,
};
#[cfg(target_os = "macos")]
use crate::status::unix_seconds;

const NPM_PACKAGE_NAME: &str = "@codexhost/cli";
#[cfg(any(target_os = "windows", target_os = "macos"))]
const DISTRIBUTION_FILE: &str = "codexhost-distribution.json";

#[cfg(any(target_os = "windows", target_os = "macos"))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DistributionMetadata {
    schema_version: u8,
    version: String,
    distribution: String,
    target: String,
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn sha256_file(path: &Path) -> Result<String, Box<dyn Error>> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 128 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn verify_artifact(path: &Path, expected: &str) -> Result<(), Box<dyn Error>> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(
            format!("update artifact SHA-256 mismatch: expected {expected}, got {actual}").into(),
        );
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn distribution_metadata(path: &Path) -> Result<DistributionMetadata, Box<dyn Error>> {
    let metadata = serde_json::from_slice::<DistributionMetadata>(&fs::read(path)?)?;
    if metadata.schema_version != 1 || metadata.target.is_empty() {
        return Err("installed distribution metadata is invalid".into());
    }
    validate_version(&metadata.version)?;
    Ok(metadata)
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn verify_distribution(
    path: &Path,
    version: &str,
    expected_distribution: &str,
) -> Result<(), Box<dyn Error>> {
    let metadata = distribution_metadata(path)?;
    if metadata.version != version || metadata.distribution != expected_distribution {
        return Err(format!(
            "installed distribution metadata does not match {expected_distribution} {version}"
        )
        .into());
    }
    Ok(())
}

fn run_checked(command: &mut Command, label: &str) -> Result<(), Box<dyn Error>> {
    let status = command.status()?;
    if !status.success() {
        return Err(format!("{label} failed with {status}").into());
    }
    Ok(())
}

fn install_npm(request: &UpdateRequest, npm: &NpmInstallation) -> Result<(), Box<dyn Error>> {
    run_checked(
        Command::new(&npm.node_path)
            .arg(&npm.npm_cli_path)
            .args(["install", "--global", "--no-audit", "--no-fund"])
            .arg(format!("{NPM_PACKAGE_NAME}@{}", request.version)),
        "npm update",
    )
}

#[cfg(target_os = "windows")]
fn install_windows(
    request: &UpdateRequest,
    windows: &WindowsInstallation,
) -> Result<(), Box<dyn Error>> {
    verify_artifact(&windows.installer_path, &windows.artifact_sha256)?;
    let mut command = Command::new(&windows.installer_path);
    command.args(["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"]);
    configure_background_command(&mut command);
    run_checked(&mut command, "Windows installer")?;
    verify_distribution(
        &windows.install_root.join("app").join(DISTRIBUTION_FILE),
        &request.version,
        "installer",
    )
}

#[cfg(not(target_os = "windows"))]
fn install_windows(
    _request: &UpdateRequest,
    _windows: &WindowsInstallation,
) -> Result<(), Box<dyn Error>> {
    Err("Windows installer updates require Windows".into())
}

/// Names an update gives the copies it keeps beside the application: the
/// staged new version, which becomes the previous version once exchanged in;
/// the previous version renamed aside where the volume cannot exchange (and
/// by earlier updaters); and a rejected new version put aside by a restore.
#[cfg(target_os = "macos")]
const MACOS_LEFTOVER_PREFIXES: [&str; 3] = [
    ".codexhost-update-",
    ".codexhost-backup-",
    ".codexhost-rejected-",
];

/// Removes what earlier updates left beside an intact application: a previous
/// version kept because its update never proved healthy, or a partial copy
/// from an interrupted staging. Best effort: a copy that cannot be removed
/// (another owner, an immutable flag) is reported, never a reason to refuse
/// this update and every later one.
#[cfg(target_os = "macos")]
fn remove_macos_leftovers(parent: &Path) {
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(error) => {
            eprintln!(
                "codexhost updater: could not list {}: {error}",
                parent.display()
            );
            return;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let ours = name.ends_with(".app")
            && MACOS_LEFTOVER_PREFIXES
                .iter()
                .any(|prefix| name.starts_with(prefix));
        // Never follow a link out of the application's directory.
        if ours
            && entry.file_type().is_ok_and(|kind| kind.is_dir())
            && let Err(error) = fs::remove_dir_all(entry.path())
        {
            eprintln!(
                "codexhost updater: could not remove the earlier update copy {}: {error}",
                entry.path().display()
            );
        }
    }
}

/// Puts `incoming` at `application` and returns where the displaced version
/// now is. One atomic exchange where the volume supports it; otherwise
/// (exFAT, SMB) two renames through `aside`, as earlier updaters did, and
/// only between them does the application path lack a version.
#[cfg(target_os = "macos")]
fn replace_macos_application(
    incoming: &Path,
    application: &Path,
    aside: &Path,
) -> Result<PathBuf, Box<dyn Error>> {
    match exchange_paths(incoming, application) {
        Ok(()) => return Ok(incoming.to_path_buf()),
        Err(PlatformError::Unsupported(_)) => {}
        Err(error) => return Err(error.into()),
    }
    fs::rename(application, aside)?;
    if let Err(error) = fs::rename(incoming, application) {
        return Err(match fs::rename(aside, application) {
            Ok(()) => error.into(),
            Err(restore) => format!(
                "{error}; the application could not be put back ({restore}) and is at {}",
                aside.display()
            )
            .into(),
        });
    }
    Ok(aside.to_path_buf())
}

#[cfg(target_os = "macos")]
fn install_macos(
    request: &UpdateRequest,
    macos: &MacOsInstallation,
) -> Result<PathBuf, Box<dyn Error>> {
    verify_artifact(&macos.dmg_path, &macos.artifact_sha256)?;
    let parent = macos
        .app_path
        .parent()
        .ok_or("macOS application path has no parent")?;
    if !macos.app_path.is_dir() {
        return Err("macOS application to update is missing".into());
    }
    remove_macos_leftovers(parent);
    let unique = format!("{}-{}", std::process::id(), unix_seconds());
    let mount = env::temp_dir().join(format!("codexhost-update-mount-{unique}"));
    let staged = parent.join(format!(".codexhost-update-{unique}.app"));
    let aside = parent.join(format!(".codexhost-backup-{unique}.app"));
    fs::create_dir_all(&mount)?;
    if staged.exists() || aside.exists() {
        return Err("macOS update staging path already exists".into());
    }
    let attach_result = run_checked(
        Command::new("/usr/bin/hdiutil")
            .args(["attach", "-nobrowse", "-readonly", "-mountpoint"])
            .arg(&mount)
            .arg(&macos.dmg_path),
        "macOS DMG mount",
    );
    if let Err(error) = attach_result {
        let _ = fs::remove_dir_all(&mount);
        return Err(error);
    }

    let prepare_result = (|| -> Result<(), Box<dyn Error>> {
        let source = mount.join("codexhost.app");
        if !source.is_dir() {
            return Err("macOS DMG does not contain codexhost.app".into());
        }
        run_checked(
            Command::new("/usr/bin/ditto").arg(&source).arg(&staged),
            "macOS application staging",
        )?;
        verify_distribution(
            &staged
                .join("Contents")
                .join("Resources")
                .join("app")
                .join(DISTRIBUTION_FILE),
            &request.version,
            "installer",
        )?;
        run_checked(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&staged),
            "macOS application integrity check",
        )
    })();
    let detach_result = run_checked(
        Command::new("/usr/bin/hdiutil").arg("detach").arg(&mount),
        "macOS DMG detach",
    );
    let _ = fs::remove_dir_all(&mount);
    if let Err(error) = prepare_result {
        let _ = fs::remove_dir_all(&staged);
        return Err(error);
    }
    detach_result?;

    let previous = match replace_macos_application(&staged, &macos.app_path, &aside) {
        Ok(previous) => previous,
        Err(error) => {
            // A failed replacement leaves the new copy where it was staged.
            let _ = fs::remove_dir_all(&staged);
            return Err(format!("could not activate updated macOS application: {error}").into());
        }
    };
    if let Err(error) = verify_distribution(
        &macos
            .app_path
            .join("Contents")
            .join("Resources")
            .join("app")
            .join(DISTRIBUTION_FILE),
        &request.version,
        "installer",
    ) {
        let rejected = parent.join(format!(".codexhost-rejected-{unique}.app"));
        return Err(
            match replace_macos_application(&previous, &macos.app_path, &rejected) {
                Ok(rejected) => {
                    let _ = fs::remove_dir_all(rejected);
                    error
                }
                Err(restore) => {
                    // The previous version is the only good copy; move it off a
                    // name the next update clears.
                    let kept = parent.join(format!("codexhost-previous-{unique}.app"));
                    let location = if fs::rename(&previous, &kept).is_ok() {
                        kept
                    } else {
                        previous
                    };
                    format!(
                    "{error}; the previous version could not be restored ({restore}) and is at {}",
                    location.display()
                )
                .into()
                }
            },
        );
    }
    Ok(previous)
}

#[cfg(not(target_os = "macos"))]
fn install_macos(
    _request: &UpdateRequest,
    _macos: &MacOsInstallation,
) -> Result<PathBuf, Box<dyn Error>> {
    Err("macOS DMG updates require macOS".into())
}

/// Installs the update. Returns the previous version when it was kept aside:
/// it may be discarded only once the updated one has started.
pub(crate) fn install(request: &UpdateRequest) -> Result<Option<PathBuf>, Box<dyn Error>> {
    match &request.installation {
        Installation::Npm(npm) => install_npm(request, npm).map(|()| None),
        Installation::WindowsInstaller(windows) => install_windows(request, windows).map(|()| None),
        Installation::MacosDmg(macos) => install_macos(request, macos).map(Some),
    }
}

pub(crate) fn relaunch(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    let mut command = match &request.installation {
        Installation::Npm(npm) => {
            let mut command = Command::new(&npm.node_path);
            command.arg(&npm.npm_launcher_path);
            command
        }
        Installation::WindowsInstaller(windows) => {
            let mut command = Command::new(windows.install_root.join("bin/codexhost-start.exe"));
            configure_background_command(&mut command);
            command
        }
        Installation::MacosDmg(macos) => {
            let mut command = Command::new("/usr/bin/open");
            command.arg(&macos.app_path);
            command
        }
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.spawn()?;
    Ok(())
}

#[cfg(all(test, any(target_os = "windows", target_os = "macos")))]
mod tests {
    use super::DistributionMetadata;

    #[test]
    fn distribution_metadata_rejects_unknown_fields() {
        let metadata = br#"{"schemaVersion":1,"version":"1.2.3","distribution":"npm","target":"macos-arm64","extra":true}"#;
        assert!(serde_json::from_slice::<DistributionMetadata>(metadata).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn removes_only_update_leftovers_beside_the_application() {
        use std::fs;

        let root = std::env::temp_dir().join(format!(
            "codexhost-updater-leftovers-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let parent = root.join("Applications");
        let outside = root.join("outside.app");
        for directory in [
            parent.join("codexhost.app"),
            parent.join("Other.app"),
            parent.join(".codexhost-update-1-2.app/Contents"),
            parent.join(".codexhost-backup-3-4.app"),
            outside.clone(),
        ] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::create_dir_all(parent.join(".codexhost-rejected-7-8.app")).unwrap();
        std::os::unix::fs::symlink(&outside, parent.join(".codexhost-backup-5-6.app")).unwrap();

        super::remove_macos_leftovers(&parent);

        let mut names = fs::read_dir(&parent)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            [".codexhost-backup-5-6.app", "Other.app", "codexhost.app"]
        );
        assert!(outside.is_dir());
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "macos")]
    fn assert_replaces_application(parent: &std::path::Path) {
        use std::fs;

        let _ = fs::remove_dir_all(parent);
        let (application, incoming, aside) = (
            parent.join("codexhost.app"),
            parent.join(".codexhost-update-1-2.app"),
            parent.join(".codexhost-backup-1-2.app"),
        );
        fs::create_dir_all(&application).unwrap();
        fs::create_dir_all(&incoming).unwrap();
        fs::write(application.join("version"), "old").unwrap();
        fs::write(incoming.join("version"), "new").unwrap();

        let previous = super::replace_macos_application(&incoming, &application, &aside).unwrap();

        assert_eq!(
            fs::read_to_string(application.join("version")).unwrap(),
            "new"
        );
        assert_eq!(fs::read_to_string(previous.join("version")).unwrap(), "old");
        // And back, as a failed verification restores it.
        let rejected = parent.join(".codexhost-rejected-1-2.app");
        let displaced =
            super::replace_macos_application(&previous, &application, &rejected).unwrap();
        assert_eq!(
            fs::read_to_string(application.join("version")).unwrap(),
            "old"
        );
        assert_eq!(
            fs::read_to_string(displaced.join("version")).unwrap(),
            "new"
        );
        fs::remove_dir_all(parent).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replaces_the_application_by_exchange() {
        assert_replaces_application(
            &std::env::temp_dir().join(format!("codexhost-updater-replace-{}", std::process::id())),
        );
    }

    /// Needs a volume without exchange support: set
    /// CODEXHOST_TEST_NO_EXCHANGE_DIR to a directory on, e.g., a mounted exFAT
    /// disk image.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "needs a volume without RENAME_SWAP"]
    fn replaces_the_application_by_renames_where_exchange_is_unsupported() {
        let root = std::path::PathBuf::from(
            std::env::var_os("CODEXHOST_TEST_NO_EXCHANGE_DIR")
                .expect("CODEXHOST_TEST_NO_EXCHANGE_DIR"),
        );
        let probe = (root.join("probe-a"), root.join("probe-b"));
        std::fs::create_dir_all(&probe.0).unwrap();
        std::fs::create_dir_all(&probe.1).unwrap();
        assert!(matches!(
            codexhost_platform::exchange_paths(&probe.0, &probe.1),
            Err(codexhost_platform::PlatformError::Unsupported(_))
        ));
        std::fs::remove_dir_all(&probe.0).unwrap();
        std::fs::remove_dir_all(&probe.1).unwrap();
        assert_replaces_application(&root.join("replace"));
    }
}
