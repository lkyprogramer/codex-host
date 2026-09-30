//! The on-disk record of what a live anchor owns.
//!
//! An anchor that is itself killed cannot end its group, and on macOS no
//! kernel mechanism ends it for it. Each anchor therefore keeps one file
//! naming its own instance and every process it owns by identity (pid plus
//! instance), and removes it only after confirming the group released. A
//! file whose anchor is gone is reclaimed later (`codexhost-anchor
//! --reclaim`, which the Shim runs): the recorded processes that still run
//! and what they spawned since. Nothing is claimed by process-group id: once
//! the anchor is gone that id may name a stranger's group.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::process_table::{self, Identity};

/// Overrides where records live; tests use it to stay isolated.
pub const DIRECTORY_ENV: &str = "CODEXHOST_PROCESS_LEDGER_DIR";
/// Version 1 claimed the leader's process group; version 2 names every
/// owned process instead.
const VERSION: u64 = 2;
/// Owned processes change on every fork; the record follows them at most
/// this often. A process younger than the last write is still found as a
/// descendant of a recorded one.
const MIN_WRITE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub boot: String,
    pub anchor: Identity,
    pub leader: Identity,
    /// Every owned process as of the last write, the leader included.
    pub owned: Vec<Identity>,
    /// Escapees the user keeps (CODEXHOST_PROCESS_ESCAPEES=keep): a reclaim
    /// never ends them or anything below them, even when a recorded parent
    /// still links to them.
    pub kept: Vec<Identity>,
}

/// What a reader can tell about a file it found in the directory.
#[derive(Debug, PartialEq, Eq)]
pub enum Parsed {
    Current(Record),
    /// Written in an earlier boot: it names nothing that exists any more.
    OtherBoot,
    /// Another version, or not a record: never this reader's to act on or
    /// remove, since a newer anchor may still be using it.
    Unknown,
}

impl Record {
    fn to_json(&self) -> Value {
        let identity =
            |identity: &Identity| json!({ "pid": identity.pid, "instance": identity.instance });
        json!({
            "version": VERSION,
            "boot": self.boot,
            "anchor": identity(&self.anchor),
            "leader": identity(&self.leader),
            "owned": self.owned.iter().map(identity).collect::<Vec<_>>(),
            "kept": self.kept.iter().map(identity).collect::<Vec<_>>(),
        })
    }

    pub fn parse(text: &str, boot: &str) -> Parsed {
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            return Parsed::Unknown;
        };
        // The boot is checked first: a record from an earlier boot is stale
        // whatever version wrote it.
        match value.get("boot").and_then(Value::as_str) {
            Some(recorded) if recorded != boot => return Parsed::OtherBoot,
            Some(_) => {}
            None => return Parsed::Unknown,
        }
        if value.get("version").and_then(Value::as_u64) != Some(VERSION) {
            return Parsed::Unknown;
        }
        Self::parse_current(&value).map_or(Parsed::Unknown, Parsed::Current)
    }

    fn parse_current(value: &Value) -> Option<Self> {
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
            owned: value
                .get("owned")?
                .as_array()?
                .iter()
                .map(identity)
                .collect::<Option<_>>()?,
            kept: value
                .get("kept")?
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
    /// The in-memory record changed since the last write.
    dirty: bool,
    last_write: Instant,
}

impl Ledger {
    /// Records a new group before anything else can happen to it.
    pub fn create(anchor: Identity, leader: Identity) -> Result<Self, String> {
        let directory = directory()?;
        let mut ledger = Self {
            path: directory.join(format!("{}-{}.json", anchor.pid, anchor.instance)),
            record: Record {
                boot: process_table::boot_id()?,
                anchor,
                leader,
                owned: vec![leader],
                kept: Vec::new(),
            },
            dirty: true,
            last_write: Instant::now(),
        };
        ledger.write()?;
        Ok(ledger)
    }

    /// Follows the owned and kept sets; writes when they changed and the
    /// last write is old enough, or later through `flush_if_due`.
    pub fn record_owned(
        &mut self,
        owned: &HashSet<Identity>,
        kept: &HashSet<Identity>,
    ) -> Result<(), String> {
        let mut kept: Vec<Identity> = kept.iter().copied().collect();
        kept.sort_by_key(|identity| (identity.pid, identity.instance));
        if kept != self.record.kept {
            self.record.kept = kept;
            self.dirty = true;
        }
        let mut owned: Vec<Identity> = owned.iter().copied().collect();
        // The leader stays recorded until the group is released: it is the
        // root its unrecorded descendants are found from.
        if !owned.contains(&self.record.leader) {
            owned.push(self.record.leader);
        }
        owned.sort_by_key(|identity| (identity.pid, identity.instance));
        if owned != self.record.owned {
            self.record.owned = owned;
            self.dirty = true;
        }
        self.flush_if_due()
    }

    /// Writes a pending change now, whatever the interval.
    pub fn flush(&mut self) -> Result<(), String> {
        if self.dirty {
            self.write()?;
        }
        Ok(())
    }

    pub fn flush_if_due(&mut self) -> Result<(), String> {
        if self.dirty && self.last_write.elapsed() >= MIN_WRITE_INTERVAL {
            self.write()?;
        }
        Ok(())
    }

    /// The group is confirmed released: nothing is left to reclaim.
    pub fn remove(&self) {
        let _ = fs::remove_file(&self.path);
    }

    /// Replaces the record atomically, so a reader never sees half of one.
    fn write(&mut self) -> Result<(), String> {
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
        self.last_write = Instant::now();
        match result {
            Ok(()) => {
                self.dirty = false;
                Ok(())
            }
            Err(error) => {
                let _ = fs::remove_file(&temporary);
                Err(format!(
                    "cannot record the owned group in {}: {error}",
                    self.path.display()
                ))
            }
        }
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

    fn record() -> Record {
        Record {
            boot: "boot".into(),
            anchor: Identity {
                pid: 7,
                instance: 70,
            },
            leader: Identity {
                pid: 8,
                instance: 80,
            },
            owned: vec![
                Identity {
                    pid: 8,
                    instance: 80,
                },
                Identity {
                    pid: 9,
                    instance: u64::MAX,
                },
            ],
            kept: vec![Identity {
                pid: 10,
                instance: 100,
            }],
        }
    }

    #[test]
    fn a_record_round_trips() {
        let text = record().to_json().to_string();
        assert_eq!(Record::parse(&text, "boot"), Parsed::Current(record()));
    }

    #[test]
    fn a_record_from_another_boot_or_version_is_never_this_readers() {
        let text = record().to_json().to_string();
        assert_eq!(Record::parse(&text, "later boot"), Parsed::OtherBoot);
        // A newer anchor's record in this boot: neither acted on nor removed.
        let newer = text.replace("\"version\":2", "\"version\":3");
        assert_eq!(Record::parse(&newer, "boot"), Parsed::Unknown);
        assert_eq!(Record::parse("{", "boot"), Parsed::Unknown);
    }
}
