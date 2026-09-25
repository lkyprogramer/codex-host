//! The on-disk record of what a live anchor owns.
//!
//! An anchor that is itself killed cannot end its group, and on macOS no
//! kernel mechanism ends it for it. Each anchor therefore keeps one file
//! naming its own instance, its group and the escapees it tracks, and
//! removes it only after confirming the group released. A file whose anchor
//! is gone is reclaimed later (`codexhost-anchor --reclaim`, which the Shim
//! runs). Instances make that exact: a recorded pid now held by another
//! process is never signalled.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::process_table::{self, Identity};

/// Overrides where records live; tests use it to stay isolated.
pub const DIRECTORY_ENV: &str = "CODEXHOST_PROCESS_LEDGER_DIR";
const VERSION: u64 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub boot: String,
    pub anchor: Identity,
    pub leader: Identity,
    pub escapees: Vec<Identity>,
}

impl Record {
    /// The group id is the leader's pid.
    pub fn group(&self) -> i32 {
        self.leader.pid
    }

    fn to_json(&self) -> Value {
        let identity =
            |identity: &Identity| json!({ "pid": identity.pid, "instance": identity.instance });
        json!({
            "version": VERSION,
            "boot": self.boot,
            "anchor": identity(&self.anchor),
            "leader": identity(&self.leader),
            "escapees": self.escapees.iter().map(identity).collect::<Vec<_>>(),
        })
    }

    pub fn parse(text: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(text).ok()?;
        if value.get("version")?.as_u64()? != VERSION {
            return None;
        }
        let identity = |value: &Value| {
            Some(Identity {
                pid: i32::try_from(value.get("pid")?.as_i64()?).ok()?,
                instance: value.get("instance")?.as_u64()?,
            })
        };
        Some(Self {
            boot: value.get("boot")?.as_str()?.to_owned(),
            anchor: identity(value.get("anchor")?)?,
            leader: identity(value.get("leader")?)?,
            escapees: value
                .get("escapees")?
                .as_array()?
                .iter()
                .map(identity)
                .collect::<Option<_>>()?,
        })
    }
}

pub struct Ledger {
    path: PathBuf,
    record: Record,
}

impl Ledger {
    /// Records a new group before anything else can happen to it.
    pub fn create(anchor: Identity, leader: Identity) -> Result<Self, String> {
        let directory = directory()?;
        let ledger = Self {
            path: directory.join(format!("{}-{}.json", anchor.pid, anchor.instance)),
            record: Record {
                boot: process_table::boot_id()?,
                anchor,
                leader,
                escapees: Vec::new(),
            },
        };
        ledger.write()?;
        Ok(ledger)
    }

    pub fn record_escapees(&mut self, escapees: &HashSet<Identity>) -> Result<(), String> {
        let mut escapees: Vec<Identity> = escapees.iter().copied().collect();
        escapees.sort_by_key(|identity| (identity.pid, identity.instance));
        if escapees == self.record.escapees {
            return Ok(());
        }
        self.record.escapees = escapees;
        self.write()
    }

    /// The group is confirmed released: nothing is left to reclaim.
    pub fn remove(&self) {
        let _ = fs::remove_file(&self.path);
    }

    /// Replaces the record atomically, so a reader never sees half of one.
    fn write(&self) -> Result<(), String> {
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", std::process::id()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(self.record.to_json().to_string().as_bytes())?;
            fs::rename(&temporary, &self.path)
        })();
        result.map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!(
                "cannot record the owned group in {}: {error}",
                self.path.display()
            )
        })
    }
}

/// A private per-user directory. It needs to survive only until the next
/// boot, since instances are meaningless after one.
pub fn directory() -> Result<PathBuf, String> {
    let directory = match std::env::var_os(DIRECTORY_ENV).map(PathBuf::from) {
        Some(configured) if configured.is_absolute() => configured,
        Some(configured) => {
            return Err(format!(
                "{DIRECTORY_ENV} must be absolute: {}",
                configured.display()
            ));
        }
        None => default_base()?.join(format!(
            "codexhost-process-ledger-{}",
            nix::unistd::geteuid()
        )),
    };
    ensure_private_directory(&directory)?;
    Ok(directory)
}

#[cfg(target_os = "macos")]
fn default_base() -> Result<PathBuf, String> {
    use std::os::unix::ffi::OsStrExt;

    // The per-user temporary directory, found without trusting TMPDIR: the
    // Harness environment and the Shim's may differ.
    let mut buffer = vec![0_u8; libc::PATH_MAX as usize];
    // SAFETY: `buffer` is writable for its full length.
    let length = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        )
    };
    if length == 0 || length > buffer.len() {
        return Err("cannot find the per-user temporary directory".into());
    }
    buffer.truncate(length - 1);
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(&buffer)))
}

#[cfg(target_os = "linux")]
fn default_base() -> Result<PathBuf, String> {
    // The user's runtime directory is private and cleared at boot. Its path
    // is fixed by uid, so an environment without XDG_RUNTIME_DIR agrees.
    let runtime = PathBuf::from(format!("/run/user/{}", nix::unistd::geteuid()));
    let owned = fs::symlink_metadata(&runtime).is_ok_and(|metadata| {
        metadata.is_dir() && metadata.uid() == nix::unistd::geteuid().as_raw()
    });
    Ok(if owned {
        runtime
    } else {
        PathBuf::from("/tmp")
    })
}

fn ensure_private_directory(directory: &Path) -> Result<(), String> {
    match fs::DirBuilder::new().mode(0o700).create(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => {
            return Err(format!("cannot create {}: {error}", directory.display()));
        }
    }
    let metadata = fs::symlink_metadata(directory)
        .map_err(|error| format!("cannot inspect {}: {error}", directory.display()))?;
    // Another user could otherwise plant records that make a reclaim signal
    // processes chosen by them.
    if !metadata.is_dir()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(format!(
            "{} is not a private directory owned by this user",
            directory.display()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_round_trips_and_rejects_other_versions() {
        let record = Record {
            boot: "boot".into(),
            anchor: Identity {
                pid: 7,
                instance: 70,
            },
            leader: Identity {
                pid: 8,
                instance: 80,
            },
            escapees: vec![Identity {
                pid: 9,
                instance: u64::MAX,
            }],
        };
        let text = record.to_json().to_string();
        assert_eq!(Record::parse(&text), Some(record));
        assert_eq!(
            Record::parse(&text.replace("\"version\":1", "\"version\":2")),
            None
        );
        assert_eq!(Record::parse("{"), None);
    }
}
