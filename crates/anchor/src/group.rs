//! Process-group facts the anchor decides on. Nothing here reaps the leader.

use std::io;

use nix::sys::signal::{Signal, killpg};
use nix::unistd::Pid;

/// How the Harness leader ended, read without reaping it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaderExit {
    Code(i32),
    Signal(i32),
}

/// Reports the leader's exit while leaving it a zombie. An unreaped leader
/// keeps both its pid and its process-group id reserved, which is what makes
/// every later group signal land on this spawn and nothing else.
pub fn peek_leader_exit(leader: Pid) -> io::Result<Option<LeaderExit>> {
    loop {
        // SAFETY: an all-zero siginfo_t is a valid value; waitid fills it in.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is a valid, writable siginfo_t for the whole call.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                leader.as_raw() as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        // SAFETY: waitid succeeded, so the SIGCHLD fields of `info` are set;
        // with WNOHANG and no change they stay zero.
        let (pid, status) = unsafe { (info.si_pid(), info.si_status()) };
        if pid == 0 {
            return Ok(None);
        }
        return Ok(match info.si_code {
            libc::CLD_EXITED => Some(LeaderExit::Code(status)),
            libc::CLD_KILLED | libc::CLD_DUMPED => Some(LeaderExit::Signal(status)),
            _ => None,
        });
    }
}

/// Signals the whole owned group. ESRCH (already empty) and EPERM (only
/// zombies left on macOS) are not failures: the caller counts live members.
pub fn signal_group(group: Pid, signal: Signal) {
    let _ = killpg(group, signal);
}

/// Signals one adopted child. Its pid stays reserved until the anchor reaps
/// it, so this cannot reach a recycled pid.
#[cfg(target_os = "linux")]
pub fn signal_process(process: Pid, signal: Signal) {
    let _ = nix::sys::signal::kill(process, signal);
}

/// Live, non-zombie members of `group` other than the leader, whose state the
/// caller tracks separately.
#[cfg(target_os = "macos")]
pub fn live_group_members(group: Pid, leader: Pid) -> usize {
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::proc_pid::pidinfo;
    use libproc::processes::{ProcFilter, pids_by_type};

    let Ok(group_id) = u32::try_from(group.as_raw()) else {
        return 0;
    };
    let Ok(members) = pids_by_type(ProcFilter::ByProgramGroup { pgrpid: group_id }) else {
        // An unreadable table must not read as "empty": that would report a
        // release nobody observed.
        return 1;
    };
    members
        .into_iter()
        .filter(|member| *member != 0 && i64::from(*member) != i64::from(leader.as_raw()))
        .filter(|member| {
            let Ok(native) = i32::try_from(*member) else {
                return false;
            };
            // A member that exits between listing and inspection is gone.
            pidinfo::<BSDInfo>(native, 0)
                .is_ok_and(|info| info.pbi_status != libc::SZOMB && info.pbi_pgid == group_id)
        })
        .count()
}

#[cfg(target_os = "linux")]
pub fn live_group_members(group: Pid, leader: Pid) -> usize {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return 1;
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
        .filter(|process| *process != leader.as_raw())
        .filter_map(|process| linux::stat(Pid::from_raw(process)))
        .filter(|stat| stat.group == group.as_raw() && stat.live())
        .count()
}

#[cfg(target_os = "linux")]
pub mod linux {
    use nix::sys::wait::{WaitPidFlag, waitpid};
    use nix::unistd::Pid;

    pub struct Stat {
        pub state: char,
        pub parent: i32,
        pub group: i32,
    }

    impl Stat {
        pub fn live(&self) -> bool {
            !matches!(self.state, 'Z' | 'X' | 'x')
        }
    }

    pub fn stat(process: Pid) -> Option<Stat> {
        let text = std::fs::read_to_string(format!("/proc/{process}/stat")).ok()?;
        // The command name may contain spaces and parentheses; fields resume
        // after the last closing parenthesis.
        let rest = text.get(text.rfind(')')? + 2..)?;
        let mut fields = rest.split_ascii_whitespace();
        let state = fields.next()?.chars().next()?;
        let parent = fields.next()?.parse().ok()?;
        let group = fields.next()?.parse().ok()?;
        Some(Stat {
            state,
            parent,
            group,
        })
    }

    /// Children the anchor adopted as a subreaper, excluding the leader.
    /// Zombies among them are reaped here; the live ones are returned.
    pub fn live_adopted_children(anchor: Pid, leader: Pid) -> Vec<Pid> {
        let children = direct_children(anchor);
        let mut live = Vec::new();
        for child in children {
            if child == leader {
                continue;
            }
            match stat(child) {
                Some(stat) if stat.live() => live.push(child),
                _ => {
                    let _ = waitpid(child, Some(WaitPidFlag::WNOHANG));
                }
            }
        }
        live
    }

    fn direct_children(anchor: Pid) -> Vec<Pid> {
        let listed = std::fs::read_to_string(format!("/proc/{anchor}/task/{anchor}/children"));
        if let Ok(listed) = listed {
            return listed
                .split_ascii_whitespace()
                .filter_map(|process| process.parse().ok())
                .map(Pid::from_raw)
                .collect();
        }
        // Kernels without CONFIG_PROC_CHILDREN: find children by parent id.
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
            .map(Pid::from_raw)
            .filter(|process| stat(*process).is_some_and(|stat| stat.parent == anchor.as_raw()))
            .collect()
    }
}
