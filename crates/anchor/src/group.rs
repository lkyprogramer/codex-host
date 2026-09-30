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

/// Live members the anchor still owns, the leader excluded (the caller tracks
/// it through `peek_leader_exit`). An unreadable process table is an error,
/// never "empty": that would report a release nobody observed.
pub fn live_members(group: Pid, leader: Pid) -> Result<usize, String> {
    #[cfg(target_os = "macos")]
    {
        macos::live_group_members(group, leader)
    }
    #[cfg(target_os = "linux")]
    {
        linux::live_members(group, leader)
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use nix::unistd::Pid;

    /// Short BSD info is readable for every process, whatever its uid. The
    /// full BSD info is not: a setuid member of the group (sudo, su) would
    /// otherwise read as gone while it is still running.
    fn status(process: i32) -> Result<Option<(u32, u32)>, ()> {
        // SAFETY: an all-zero proc_bsdshortinfo is a valid value.
        let mut info: libc::proc_bsdshortinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdshortinfo>() as libc::c_int;
        // SAFETY: `info` is writable for exactly `size` bytes.
        let written = unsafe {
            libc::proc_pidinfo(
                process,
                libc::PROC_PIDT_SHORTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdshortinfo).cast(),
                size,
            )
        };
        if written == size {
            return Ok(Some((info.pbsi_status, info.pbsi_pgid)));
        }
        // errno describes only a failed call; a short positive read leaves a
        // stale value that must not turn a live member into a missing one.
        if written <= 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return Ok(None);
        }
        Err(())
    }

    pub fn live_group_members(group: Pid, leader: Pid) -> Result<usize, String> {
        use libproc::processes::{ProcFilter, pids_by_type};

        let group_id = u32::try_from(group.as_raw())
            .map_err(|_| format!("process group {group} is not representable"))?;
        let members = pids_by_type(ProcFilter::ByProgramGroup { pgrpid: group_id })
            .map_err(|error| format!("cannot list process group {group}: {error}"))?;
        let mut live = 0;
        for member in members {
            let Ok(native) = i32::try_from(member) else {
                continue;
            };
            if native == 0 || native == leader.as_raw() {
                continue;
            }
            match status(native) {
                // Exited between listing and inspection.
                Ok(None) => {}
                Ok(Some((state, pgid))) => {
                    if state != libc::SZOMB && pgid == group_id {
                        live += 1;
                    }
                }
                // Unreadable is not evidence of absence.
                Err(()) => live += 1,
            }
        }
        Ok(live)
    }

    #[cfg(test)]
    mod tests {
        use super::status;

        #[test]
        fn reads_the_state_of_a_process_owned_by_another_user() {
            // launchd runs as root; the full BSD info would refuse it with
            // EPERM and a setuid group member would then read as gone.
            let (state, _) = status(1).expect("readable").expect("present");
            assert_ne!(state, libc::SZOMB);
        }

        #[test]
        fn reports_a_missing_process_as_gone() {
            assert_eq!(status(i32::MAX), Ok(None));
        }
    }
}

#[cfg(target_os = "linux")]
pub mod linux {
    use std::collections::HashSet;

    use nix::sys::signal::{Signal, kill};
    use nix::sys::wait::{WaitPidFlag, waitpid};
    use nix::unistd::{Pid, getpid};

    pub struct Stat {
        pub state: char,
        pub parent: i32,
        pub group: i32,
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

    /// A process whose main thread exited reads as a zombie while its other
    /// threads keep running; only a process with no live thread is gone.
    fn live(process: Pid, stat: &Stat) -> bool {
        match stat.state {
            'X' | 'x' => false,
            'Z' => std::fs::read_dir(format!("/proc/{process}/task"))
                .map(|threads| threads.count() > 1)
                .unwrap_or(false),
            _ => true,
        }
    }

    /// Group members and adopted escapees, each counted once.
    pub fn live_members(group: Pid, leader: Pid) -> Result<usize, String> {
        let entries =
            std::fs::read_dir("/proc").map_err(|error| format!("cannot read /proc: {error}"))?;
        let mut members: HashSet<i32> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
            .filter(|process| *process != leader.as_raw())
            .filter(|process| {
                let process = Pid::from_raw(*process);
                stat(process)
                    .is_some_and(|stat| stat.group == group.as_raw() && live(process, &stat))
            })
            .collect();
        members.extend(live_adopted_children(leader).into_iter().map(Pid::as_raw));
        Ok(members.len())
    }

    /// Children the anchor adopted as a subreaper, excluding the leader.
    /// Exited ones are reaped here, so they never pile up as zombies; the
    /// live ones are returned. An adopted child's pid stays reserved until
    /// this reaps it, so signalling it by pid cannot reach a recycled pid.
    pub fn live_adopted_children(leader: Pid) -> Vec<Pid> {
        let mut live_children = Vec::new();
        for child in direct_children(getpid()) {
            if child == leader {
                continue;
            }
            match stat(child) {
                Some(stat) if live(child, &stat) => live_children.push(child),
                _ => {
                    let _ = waitpid(child, Some(WaitPidFlag::WNOHANG));
                }
            }
        }
        live_children
    }

    pub fn signal_adopted(leader: Pid, signal: Signal) {
        for child in live_adopted_children(leader) {
            let _ = kill(child, signal);
        }
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
