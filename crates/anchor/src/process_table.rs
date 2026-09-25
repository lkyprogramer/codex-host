//! A snapshot of the process table with identities that survive pid reuse.
//!
//! A pid alone names whoever holds that number now. The anchor records and
//! later signals processes it no longer parents, so every entry carries an
//! instance id that differs between two processes that share a pid within
//! one boot: the kernel's 64-bit unique id on macOS, the start time on Linux
//! (a reused pid needs a later start). `boot_id` scopes those ids.

use std::collections::{HashMap, HashSet};

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub pid: i32,
    pub parent: i32,
    pub group: i32,
    /// Effective uid: only the user's own processes can ever be owned.
    pub uid: u32,
    pub instance: u64,
    /// False for a zombie: it has exited and only waits to be reaped.
    pub live: bool,
}

/// A process as recorded for later: its pid and the instance holding it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Identity {
    pub pid: i32,
    pub instance: u64,
}

impl Entry {
    pub fn identity(&self) -> Identity {
        Identity {
            pid: self.pid,
            instance: self.instance,
        }
    }
}

pub fn snapshot() -> Result<Vec<Entry>, String> {
    platform::snapshot()
}

/// The current instance holding `pid`, or `None` once nothing does.
pub fn instance(pid: i32) -> Option<u64> {
    platform::entry(pid).map(|entry| entry.instance)
}

pub fn boot_id() -> Result<String, String> {
    platform::boot_id()
}

/// Signals `identity` only while that exact instance still holds its pid.
/// The check and the signal are two steps; a pid is reused only after the
/// whole pid space wraps, which does not happen between them in practice.
pub fn signal(identity: Identity, signal: Signal) {
    if platform::entry(identity.pid).is_some_and(|entry| entry.instance == identity.instance) {
        let _ = kill(Pid::from_raw(identity.pid), signal);
    }
}

/// Every live-linked process descended from `roots` through a parent pid,
/// the roots included. Only present roots count: they must pass `eligible`,
/// and a recorded root that exited links to nothing, since its pid may now
/// name a stranger. A process that fails `eligible` is never added, and
/// nothing is found through it.
pub fn descendants(
    table: &[Entry],
    roots: &HashSet<Identity>,
    eligible: impl Fn(&Entry) -> bool,
) -> HashSet<Identity> {
    let mut by_parent: HashMap<i32, Vec<&Entry>> = HashMap::new();
    for entry in table {
        by_parent.entry(entry.parent).or_default().push(entry);
    }
    let mut found: HashSet<Identity> = table
        .iter()
        .filter(|entry| roots.contains(&entry.identity()) && eligible(entry))
        .map(Entry::identity)
        .collect();
    let mut pending: Vec<Identity> = found.iter().copied().collect();
    while let Some(parent) = pending.pop() {
        for child in by_parent.get(&parent.pid).into_iter().flatten() {
            if child.pid != parent.pid && eligible(child) && found.insert(child.identity()) {
                pending.push(child.identity());
            }
        }
    }
    found
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Entry;

    const PROC_PIDUNIQIDENTIFIERINFO: libc::c_int = 17;

    /// `struct proc_uniqidentifierinfo` from <sys/proc_info.h>.
    #[repr(C)]
    struct UniqueIdentifiers {
        uuid: [u8; 16],
        unique_id: u64,
        parent_unique_id: u64,
        id_version: i32,
        original_parent_id_version: i32,
        reserved: [u64; 2],
    }

    fn read<T>(pid: i32, flavor: libc::c_int) -> Option<T> {
        let mut value = std::mem::MaybeUninit::<T>::zeroed();
        let size = std::mem::size_of::<T>() as libc::c_int;
        // SAFETY: `value` is writable for exactly `size` bytes.
        let written =
            unsafe { libc::proc_pidinfo(pid, flavor, 0, value.as_mut_ptr().cast(), size) };
        // SAFETY: a full-size read initialised every byte; T is plain data.
        (written == size).then(|| unsafe { value.assume_init() })
    }

    pub fn entry(pid: i32) -> Option<Entry> {
        let short: libc::proc_bsdshortinfo = read(pid, libc::PROC_PIDT_SHORTBSDINFO)?;
        let unique: UniqueIdentifiers = read(pid, PROC_PIDUNIQIDENTIFIERINFO)?;
        Some(Entry {
            pid,
            parent: short.pbsi_ppid as i32,
            group: short.pbsi_pgid as i32,
            uid: short.pbsi_uid,
            instance: unique.unique_id,
            live: short.pbsi_status != libc::SZOMB,
        })
    }

    pub fn snapshot() -> Result<Vec<Entry>, String> {
        use libproc::processes::{ProcFilter, pids_by_type};

        let pids = pids_by_type(ProcFilter::All)
            .map_err(|error| format!("cannot list processes: {error}"))?;
        // A process that exits between listing and inspection is simply gone.
        Ok(pids
            .into_iter()
            .filter_map(|pid| i32::try_from(pid).ok())
            .filter(|pid| *pid > 0)
            .filter_map(entry)
            .collect())
    }

    pub fn boot_id() -> Result<String, String> {
        let mut buffer = [0_u8; 64];
        let mut size = buffer.len();
        // SAFETY: the name is NUL-terminated and `buffer` is writable for
        // `size` bytes, which sysctlbyname updates to the bytes written.
        let result = unsafe {
            libc::sysctlbyname(
                c"kern.bootsessionuuid".as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if result != 0 {
            return Err(format!(
                "cannot read the boot session: {}",
                std::io::Error::last_os_error()
            ));
        }
        let text = buffer.get(..size).unwrap_or_default();
        let text = text.split(|byte| *byte == 0).next().unwrap_or_default();
        Ok(String::from_utf8_lossy(text).into_owned())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::Entry;

    pub fn entry(pid: i32) -> Option<Entry> {
        let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The command name may contain spaces and parentheses; fields resume
        // after the last closing parenthesis, starting at field 3 (state).
        let rest = text.get(text.rfind(')')? + 2..)?;
        let fields: Vec<&str> = rest.split_ascii_whitespace().collect();
        let state = fields.first()?.chars().next()?;
        let start = fields.get(19)?.parse().ok()?;
        // /proc/<pid> is owned by the process's effective uid.
        let uid =
            std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(format!("/proc/{pid}")).ok()?);
        Some(Entry {
            pid,
            parent: fields.get(1)?.parse().ok()?,
            group: fields.get(2)?.parse().ok()?,
            uid,
            instance: start,
            live: !matches!(state, 'Z' | 'X' | 'x') || zombie_leader_with_threads(pid, state),
        })
    }

    /// A process whose main thread exited reads as a zombie while its other
    /// threads keep running.
    fn zombie_leader_with_threads(pid: i32, state: char) -> bool {
        state == 'Z'
            && std::fs::read_dir(format!("/proc/{pid}/task"))
                .map(|threads| threads.count() > 1)
                .unwrap_or(false)
    }

    pub fn snapshot() -> Result<Vec<Entry>, String> {
        let entries =
            std::fs::read_dir("/proc").map_err(|error| format!("cannot read /proc: {error}"))?;
        Ok(entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
            .filter_map(entry)
            .collect())
    }

    pub fn boot_id() -> Result<String, String> {
        std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
            .map(|text| text.trim().to_owned())
            .map_err(|error| format!("cannot read the boot id: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(pid: i32, parent: i32, instance: u64) -> Entry {
        Entry {
            pid,
            parent,
            group: pid,
            uid: 0,
            instance,
            live: true,
        }
    }

    #[test]
    fn identifies_this_process_and_its_boot() {
        let me = std::process::id() as i32;
        let current = instance(me).expect("own instance");
        assert_eq!(instance(me), Some(current));
        assert!(
            snapshot()
                .unwrap()
                .iter()
                .any(|entry| entry.pid == me && entry.live)
        );
        assert!(!boot_id().unwrap().is_empty());
    }

    #[test]
    fn follows_live_parent_links_only() {
        let table = [
            entry(10, 1, 100),
            entry(11, 10, 101),
            entry(12, 11, 102),
            // Holds the pid of a recorded root that exited: not its child.
            entry(14, 99, 105),
            entry(99, 1, 200),
        ];
        let roots = HashSet::from([
            Identity {
                pid: 10,
                instance: 100,
            },
            Identity {
                pid: 99,
                instance: 50,
            },
        ]);
        let found = descendants(&table, &roots, |_| true);
        assert_eq!(
            found,
            HashSet::from([
                Identity {
                    pid: 10,
                    instance: 100
                },
                Identity {
                    pid: 11,
                    instance: 101
                },
                Identity {
                    pid: 12,
                    instance: 102
                },
            ])
        );
    }
}
