#![forbid(unsafe_code)]

mod install;
mod request;
mod status;

use std::env;
use std::error::Error;
use std::fs;
use std::path::Path;
use std::process::ExitCode;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{ProcessSnapshot, process_exists, process_snapshot};
use serde::Deserialize;

use install::{install, relaunch};
use request::UpdateRequest;
use status::write_status;

const WAIT_TIMEOUT: Duration = Duration::from_secs(180);
const RELAUNCH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_RUNTIME_DESCRIPTOR_BYTES: u64 = 4 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeDescriptorProbe {
    schema_version: u8,
    launcher_pid: u32,
    control_port: u16,
    nonce: String,
}

fn same_executable(left: &Path, right: &Path) -> bool {
    let normalize = |path: &Path| {
        let value = path.to_string_lossy().replace('/', "\\");
        if cfg!(target_os = "windows") {
            value.to_lowercase()
        } else {
            value
        }
    };
    normalize(left) == normalize(right)
}

fn wait_for_launcher_exit(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    if !process_exists(request.wait_pid) {
        return Err("Launcher exited before the background Updater started".into());
    }
    let launcher = process_snapshot(request.wait_pid)?;
    let expected = request.wait_executable.canonicalize()?;
    let actual = launcher.executable.canonicalize()?;
    if !same_executable(&expected, &actual) {
        return Err(format!(
            "refusing update because PID {} is not the expected Launcher",
            request.wait_pid
        )
        .into());
    }
    let started = Instant::now();
    while same_instance_running(
        launcher.started_at_micros,
        process_snapshot(request.wait_pid).ok(),
    ) {
        if started.elapsed() >= WAIT_TIMEOUT {
            return Err("Launcher did not exit before the update timeout".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

/// A reused pid is another process: the Launcher is the one that started
/// when first observed.
fn same_instance_running(started_at_micros: u64, current: Option<ProcessSnapshot>) -> bool {
    current.is_some_and(|process| process.started_at_micros == started_at_micros)
}

fn relaunched_launcher_is_ready(
    descriptor_launcher_pid: u32,
    previous_launcher_pid: u32,
    process_is_alive: impl FnOnce(u32) -> bool,
) -> bool {
    descriptor_launcher_pid != previous_launcher_pid && process_is_alive(descriptor_launcher_pid)
}

fn wait_for_relaunch(request: &UpdateRequest) -> Result<(), Box<dyn Error>> {
    let descriptor_path = &request.runtime_descriptor_path;
    let started = Instant::now();
    while started.elapsed() < RELAUNCH_TIMEOUT {
        let bytes = match fs::symlink_metadata(descriptor_path) {
            Ok(metadata)
                if metadata.is_file()
                    && !metadata.file_type().is_symlink()
                    && metadata.len() <= MAX_RUNTIME_DESCRIPTOR_BYTES =>
            {
                fs::read(descriptor_path)?
            }
            Ok(_) => return Err("runtime descriptor is not a bounded regular file".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let descriptor = serde_json::from_slice::<RuntimeDescriptorProbe>(&bytes)?;
        if descriptor.schema_version != 1
            || descriptor.launcher_pid == 0
            || descriptor.control_port == 0
            || descriptor.nonce.len() != 32
            || !descriptor
                .nonce
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("runtime descriptor is invalid".into());
        }
        if relaunched_launcher_is_ready(descriptor.launcher_pid, request.wait_pid, process_exists) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err("updated codexhost did not become ready after relaunch".into())
}

fn apply(request_path: &Path) -> Result<(), Box<dyn Error>> {
    let request = UpdateRequest::parse(request_path)?;
    write_status(&request, "waiting-for-exit", None)?;
    let result = (|| -> Result<(), Box<dyn Error>> {
        wait_for_launcher_exit(&request)?;
        write_status(&request, "installing", None)?;
        let previous = install(&request)?;
        write_status(&request, "restarting", None)?;
        if let Err(error) = relaunch(&request).and_then(|()| wait_for_relaunch(&request)) {
            return Err(match previous {
                Some(previous) => format!(
                    "{error}; the previous version is kept at {}",
                    previous.display()
                )
                .into(),
                None => error,
            });
        }
        if let Some(previous) = previous
            && let Err(error) = fs::remove_dir_all(&previous)
        {
            // The update itself succeeded; the next one removes this copy.
            eprintln!(
                "codexhost updater: could not remove the previous version at {}: {error}",
                previous.display()
            );
        }
        write_status(&request, "succeeded", None)?;
        Ok(())
    })();
    if let Err(error) = &result {
        let message = error.to_string();
        let _ = write_status(&request, "failed", Some(&message));
    }
    result
}

fn usage() {
    eprintln!("usage: codexhost-updater apply --request <absolute-json-file>");
}

fn run(arguments: &[String]) -> Result<(), Box<dyn Error>> {
    if arguments.len() != 3 || arguments[0] != "apply" || arguments[1] != "--request" {
        usage();
        return Err("invalid updater arguments".into());
    }
    apply(Path::new(&arguments[2]))
}

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match run(&arguments) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("codexhost updater: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use codexhost_platform::ProcessSnapshot;

    use super::{relaunched_launcher_is_ready, same_instance_running};

    fn started_at(started_at_micros: u64) -> ProcessSnapshot {
        ProcessSnapshot {
            id: 41,
            parent_id: 1,
            process_group_id: 41,
            executable: PathBuf::from("/Applications/codexhost.app/Contents/MacOS/codexhost"),
            started_at_micros,
        }
    }

    #[test]
    fn waits_only_while_the_observed_launcher_instance_runs() {
        assert!(same_instance_running(7, Some(started_at(7))));
        assert!(!same_instance_running(7, None));
        // The pid now names a process that started later.
        assert!(!same_instance_running(7, Some(started_at(9))));
    }

    #[test]
    fn accepts_a_live_relaunched_launcher_without_executable_path_matching() {
        assert!(relaunched_launcher_is_ready(42, 41, |pid| pid == 42));
    }

    #[test]
    fn rejects_the_previous_launcher_descriptor() {
        assert!(!relaunched_launcher_is_ready(41, 41, |_| true));
    }

    #[test]
    fn rejects_a_relaunched_launcher_that_has_exited() {
        assert!(!relaunched_launcher_is_ready(42, 41, |_| false));
    }
}
