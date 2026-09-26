//! Descendants that left the Harness group.
//!
//! `setsid` or `setpgid` takes a process out of the group the anchor
//! signals. The tracker finds such escapees through their parents while
//! those still run: anything descended from a group member or from a
//! process the anchor adopted (Linux). Every process a scan finds is then
//! followed by its identity, so a group member that later leaves the group
//! and loses its parent stays owned. What neither can see is a process
//! created and orphaned between two scans: on Linux
//! the subreaper still adopts it; on macOS it is reparented to launchd,
//! which also overwrites its recorded parent, so nothing links it back. A
//! fork on any tracked process therefore triggers a scan at once on macOS,
//! keeping that window to the time one fork-and-exit takes.

use std::collections::HashSet;

use nix::sys::signal::Signal;

use crate::process_table::{self, Entry, Identity};

/// Whether `entry` can possibly be a descendant of the Harness leader. This
/// is the hard boundary of ownership, checked before every other rule: only
/// the user's own processes, created no earlier than the leader, never pid 0
/// or 1, never the anchor or anything above it. An earlier lineage rule
/// without it claimed launchd's children; with it no lineage error can reach
/// a process that existed before the Harness did.
#[derive(Debug, Clone)]
pub struct Boundary {
    anchor: i32,
    leader: Identity,
    uid: u32,
    /// The anchor's ancestors, which on Linux can share the leader's start
    /// tick and so are excluded by pid as well.
    ancestors: HashSet<i32>,
}

impl Boundary {
    pub fn new(anchor: i32, leader: Identity, table: &[Entry]) -> Self {
        let mut ancestors = HashSet::new();
        let mut current = anchor;
        while let Some(entry) = table.iter().find(|entry| entry.pid == current) {
            if !ancestors.insert(entry.parent) || entry.parent <= 1 {
                break;
            }
            current = entry.parent;
        }
        Self {
            anchor,
            leader,
            uid: nix::unistd::geteuid().as_raw(),
            ancestors,
        }
    }

    pub fn admits(&self, entry: &Entry) -> bool {
        entry.pid > 1
            && entry.pid != self.anchor
            && !self.ancestors.contains(&entry.pid)
            && entry.uid == self.uid
            && (entry.identity() == self.leader || self.after_leader(entry.instance))
    }

    /// Instances order by creation: macOS unique ids are strictly
    /// increasing, Linux start times only non-decreasing.
    fn after_leader(&self, instance: u64) -> bool {
        #[cfg(target_os = "macos")]
        return instance > self.leader.instance;
        #[cfg(target_os = "linux")]
        return instance >= self.leader.instance;
    }
}

pub struct Tracker {
    group: i32,
    boundary: Boundary,
    /// Every live process found so far, group members included.
    known: HashSet<Identity>,
    escapees: HashSet<Identity>,
    /// Escapees the anchor does not parent. On Linux the adopted ones are
    /// already counted and signalled as the anchor's own children.
    foreign_escapees: usize,
    #[cfg(target_os = "macos")]
    forks: fork_watch::ForkWatch,
    /// Report what the boundary refused (a dry run).
    dry_run: bool,
    /// End escapees with the group. Off in a dry run, and when the user
    /// keeps processes that detached on purpose (tmux, agents, build
    /// servers).
    release_escapees: bool,
}

/// What one refresh found, for a dry-run report.
pub struct Report {
    pub escapees: Vec<Entry>,
    /// Processes the walk reached that the boundary refused. Always empty
    /// unless a rule is wrong; a dry run makes that visible without harm.
    pub rejected: Vec<Entry>,
}

impl Tracker {
    pub fn new(
        anchor: i32,
        leader: Identity,
        dry_run: bool,
        release_escapees: bool,
    ) -> Result<Self, String> {
        let table = process_table::snapshot()?;
        Ok(Self {
            group: leader.pid,
            boundary: Boundary::new(anchor, leader, &table),
            known: HashSet::new(),
            escapees: HashSet::new(),
            foreign_escapees: 0,
            #[cfg(target_os = "macos")]
            forks: fork_watch::ForkWatch::new()?,
            dry_run,
            release_escapees,
        })
    }

    /// Rescans the process table. Returns a report when the escapee set
    /// changed or, in a dry run, when the boundary refused anything.
    pub fn refresh(&mut self) -> Result<Option<Report>, String> {
        let table = process_table::snapshot()?;
        let boundary = self.boundary.clone();
        let tracked = self.tracked(&table, |entry| boundary.admits(entry));
        let rejected = if self.dry_run {
            let anchor = boundary.anchor;
            self.tracked(&table, |entry| entry.pid != anchor)
                .into_iter()
                .filter(|entry| !tracked.contains(entry))
                .collect()
        } else {
            Vec::new()
        };
        self.known = tracked
            .iter()
            .filter(|entry| entry.live)
            .map(Entry::identity)
            .collect();
        #[cfg(target_os = "macos")]
        self.forks.watch(self.known.iter().copied());
        let escapees: Vec<Entry> = tracked
            .into_iter()
            .filter(|entry| entry.live && entry.group != self.group)
            .collect();
        self.foreign_escapees = escapees
            .iter()
            .filter(|entry| entry.parent != self.boundary.anchor)
            .count();
        let identities: HashSet<Identity> = escapees.iter().map(Entry::identity).collect();
        let changed = identities != self.escapees;
        self.escapees = identities;
        Ok((changed || !rejected.is_empty()).then_some(Report { escapees, rejected }))
    }

    /// Group members, the anchor's children and every process found before,
    /// with everything descended from them.
    fn tracked(&self, table: &[Entry], admits: impl Fn(&Entry) -> bool) -> Vec<Entry> {
        let mut roots: HashSet<Identity> = table
            .iter()
            .filter(|entry| {
                admits(entry) && (entry.group == self.group || entry.parent == self.boundary.anchor)
            })
            .map(Entry::identity)
            .collect();
        roots.extend(self.known.iter().copied());
        let found = process_table::descendants(table, &roots, &admits);
        table
            .iter()
            .filter(|entry| admits(entry) && found.contains(&entry.identity()))
            .copied()
            .collect()
    }

    /// Live escapees as of the last refresh that no other count includes,
    /// when the group waits for them.
    pub fn foreign_escapees(&self) -> usize {
        if self.release_escapees {
            self.foreign_escapees
        } else {
            0
        }
    }

    /// What a reclaim may end should the anchor be killed: every owned
    /// process, less the escapees the user keeps.
    pub fn recorded(&self) -> HashSet<Identity> {
        if self.release_escapees {
            self.known.clone()
        } else {
            self.known.difference(&self.escapees).copied().collect()
        }
    }

    /// Escapees the user keeps. A reclaim must exclude them explicitly:
    /// leaving them out of `recorded` is not enough while a recorded parent
    /// still links to them.
    pub fn kept(&self) -> HashSet<Identity> {
        if self.release_escapees || self.dry_run {
            HashSet::new()
        } else {
            self.escapees.clone()
        }
    }

    pub fn signal(&self, signal: Signal) {
        if !self.release_escapees {
            return;
        }
        for escapee in &self.escapees {
            process_table::signal(*escapee, signal);
        }
    }

    /// The descriptor that turns readable when a tracked process forks.
    #[cfg(target_os = "macos")]
    pub fn fork_events(&self) -> std::os::fd::BorrowedFd<'_> {
        self.forks.descriptor()
    }

    /// Consumes pending fork events; true when there were any.
    #[cfg(target_os = "macos")]
    pub fn drain_fork_events(&mut self) -> bool {
        self.forks.drain()
    }
}

#[cfg(target_os = "macos")]
mod fork_watch {
    use std::collections::HashSet;
    use std::os::fd::{AsFd, BorrowedFd, FromRawFd, OwnedFd};

    use crate::process_table::Identity;

    /// A kqueue with a fork note on every live tracked process. macOS has no
    /// NOTE_TRACK, so each new process is registered once a scan finds it.
    pub struct ForkWatch {
        queue: OwnedFd,
        watched: HashSet<Identity>,
    }

    impl ForkWatch {
        pub fn new() -> Result<Self, String> {
            // SAFETY: kqueue has no preconditions.
            let raw = unsafe { libc::kqueue() };
            if raw == -1 {
                return Err(format!(
                    "cannot create a kqueue: {}",
                    std::io::Error::last_os_error()
                ));
            }
            // SAFETY: `raw` is a new descriptor owned by nothing else.
            let queue = unsafe { OwnedFd::from_raw_fd(raw) };
            // The Harness must not inherit it.
            nix::fcntl::fcntl(
                queue.as_fd(),
                nix::fcntl::FcntlArg::F_SETFD(nix::fcntl::FdFlag::FD_CLOEXEC),
            )
            .map_err(|error| format!("cannot mark the kqueue close-on-exec: {error}"))?;
            Ok(Self {
                queue,
                watched: HashSet::new(),
            })
        }

        pub fn descriptor(&self) -> BorrowedFd<'_> {
            self.queue.as_fd()
        }

        /// Watches exactly `live`: new processes are registered, and ones
        /// that are gone are forgotten (the kernel drops their notes).
        pub fn watch(&mut self, live: impl Iterator<Item = Identity>) {
            let live: HashSet<Identity> = live.collect();
            let changes: Vec<libc::kevent> = live
                .difference(&self.watched)
                .map(|process| libc::kevent {
                    ident: process.pid as libc::uintptr_t,
                    filter: libc::EVFILT_PROC,
                    // EV_RECEIPT reports each registration's result without
                    // consuming pending events; a process that already
                    // exited simply fails to register.
                    flags: libc::EV_ADD | libc::EV_CLEAR | libc::EV_RECEIPT,
                    fflags: libc::NOTE_FORK,
                    data: 0,
                    udata: std::ptr::null_mut(),
                })
                .collect();
            if !changes.is_empty() {
                let mut receipts = changes.clone();
                let none = libc::timespec {
                    tv_sec: 0,
                    tv_nsec: 0,
                };
                // SAFETY: both buffers hold `changes.len()` kevents.
                unsafe {
                    libc::kevent(
                        std::os::fd::AsRawFd::as_raw_fd(&self.queue),
                        changes.as_ptr(),
                        changes.len() as libc::c_int,
                        receipts.as_mut_ptr(),
                        receipts.len() as libc::c_int,
                        &none,
                    );
                }
            }
            self.watched = live;
        }

        pub fn drain(&mut self) -> bool {
            let mut events = [libc::kevent {
                ident: 0,
                filter: 0,
                flags: 0,
                fflags: 0,
                data: 0,
                udata: std::ptr::null_mut(),
            }; 32];
            let none = libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            };
            let mut any = false;
            loop {
                // SAFETY: `events` is writable for its full length.
                let count = unsafe {
                    libc::kevent(
                        std::os::fd::AsRawFd::as_raw_fd(&self.queue),
                        std::ptr::null(),
                        0,
                        events.as_mut_ptr(),
                        events.len() as libc::c_int,
                        &none,
                    )
                };
                if count <= 0 {
                    return any;
                }
                any = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::Boundary;
    use crate::process_table::{Entry, Identity, descendants};

    fn entry(pid: i32, parent: i32, uid: u32) -> Entry {
        Entry {
            pid,
            parent,
            group: pid,
            uid,
            // As on macOS before the pid space first wraps.
            instance: pid as u64,
            live: true,
        }
    }

    #[test]
    fn nothing_older_than_the_leader_or_foreign_is_ever_owned() {
        let uid = nix::unistd::geteuid().as_raw();
        let table = [
            entry(1, 0, 0),           // launchd / init
            entry(300, 1, uid),       // a login-session app
            entry(400, 300, uid),     // the Host
            entry(500, 400, uid),     // the anchor
            entry(600, 500, uid),     // the leader
            entry(700, 600, uid),     // a Harness child
            entry(800, 1, uid),       // an orphan reparented to launchd
            entry(900, 600, uid + 1), // another user's process
        ];
        let leader = Identity {
            pid: 600,
            instance: 600,
        };
        let boundary = Boundary::new(500, leader, &table);
        let admitted: Vec<i32> = table
            .iter()
            .filter(|entry| boundary.admits(entry))
            .map(|entry| entry.pid)
            .collect();
        assert_eq!(admitted, [600, 700, 800]);

        // A walk rooted at launchd (the old failure) reaches nothing.
        let roots = HashSet::from([Identity {
            pid: 1,
            instance: 1,
        }]);
        let found = descendants(&table, &roots, |entry| boundary.admits(entry));
        assert!(found.is_empty(), "{found:?}");
        // One rooted at the leader reaches only its own subtree.
        let roots = HashSet::from([leader]);
        let found = descendants(&table, &roots, |entry| boundary.admits(entry));
        assert_eq!(
            found,
            HashSet::from([
                leader,
                Identity {
                    pid: 700,
                    instance: 700
                }
            ])
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_process_started_in_the_leaders_tick_is_owned_unless_it_is_above_the_anchor() {
        let uid = nix::unistd::geteuid().as_raw();
        // Linux start times are clock ticks: several processes share one.
        let entry = |pid: i32, parent: i32, instance: u64| Entry {
            pid,
            parent,
            group: pid,
            uid,
            instance,
            live: true,
        };
        let table = [
            entry(400, 1, 50),   // the Host, started in the leader's tick
            entry(500, 400, 50), // the anchor
            entry(600, 500, 50), // the leader
            entry(610, 600, 50), // a child started in the same tick
            entry(620, 1, 49),   // older than the leader
        ];
        let boundary = Boundary::new(
            500,
            Identity {
                pid: 600,
                instance: 50,
            },
            &table,
        );
        let admitted: Vec<i32> = table
            .iter()
            .filter(|entry| boundary.admits(entry))
            .map(|entry| entry.pid)
            .collect();
        assert_eq!(admitted, [600, 610]);
    }
}
