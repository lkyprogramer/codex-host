//! `codexhost-anchor --reclaim`: ends what anchors that are gone still own.
//!
//! An anchor removes its record after confirming its group released, so a
//! record whose anchor instance no longer runs belongs to an anchor that was
//! killed or crashed. Its group is still pinned if it has live members: a
//! group id is not handed out again while the group exists, so members of
//! group G are the recorded ones unless pid G now belongs to a different
//! instance (the group emptied and the id was reused). Escapees and their
//! descendants are matched by instance.

use std::collections::HashSet;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use nix::sys::signal::Signal;

use crate::ledger::{self, Record};
use crate::process_table::{self, Entry, Identity};
use crate::tracking::Boundary;

const GRACE: Duration = Duration::from_secs(2);
const KILL_WAIT: Duration = Duration::from_secs(1);
const POLL: Duration = Duration::from_millis(50);

pub const EXIT_RECLAIMED: i32 = 0;
/// Some recorded processes survived; their records stay for the next run.
pub const EXIT_SURVIVORS: i32 = 1;
pub const EXIT_UNAVAILABLE: i32 = 2;

struct Stale {
    path: PathBuf,
    record: Record,
}

/// With `dry_run`, prints what would be signalled and changes nothing.
pub fn run(dry_run: bool) -> i32 {
    let (directory, boot) = match ledger::directory()
        .and_then(|directory| process_table::boot_id().map(|boot| (directory, boot)))
    {
        Ok(found) => found,
        Err(message) => {
            eprintln!("codexhost-anchor: {message}");
            return EXIT_UNAVAILABLE;
        }
    };
    let stale = stale_records(&directory, &boot, dry_run);
    if stale.is_empty() {
        return EXIT_RECLAIMED;
    }
    if dry_run {
        let Ok(table) = process_table::snapshot() else {
            return EXIT_UNAVAILABLE;
        };
        for stale in &stale {
            let mut targets: Vec<Identity> = targets(&stale.record, &table).into_iter().collect();
            targets.sort_by_key(|target| target.pid);
            println!(
                "{}: group {} ({}), would signal {:?}",
                stale.path.display(),
                stale.record.group(),
                if group_is_recorded(&stale.record, &table) {
                    "still recorded"
                } else {
                    "reused, skipped"
                },
                targets.iter().map(|target| target.pid).collect::<Vec<_>>()
            );
        }
        return EXIT_RECLAIMED;
    }
    signal_round(&stale, Signal::SIGTERM);
    if !wait_for_release(&stale, GRACE) {
        signal_round(&stale, Signal::SIGKILL);
        wait_for_release(&stale, KILL_WAIT);
    }
    let Ok(table) = process_table::snapshot() else {
        return EXIT_SURVIVORS;
    };
    let mut survivors = false;
    for stale in &stale {
        if targets(&stale.record, &table).is_empty() {
            let _ = fs::remove_file(&stale.path);
        } else {
            survivors = true;
        }
    }
    if survivors {
        EXIT_SURVIVORS
    } else {
        EXIT_RECLAIMED
    }
}

/// Records whose anchor is gone. Records from an earlier boot name nothing
/// that exists any more and are dropped.
fn stale_records(directory: &std::path::Path, boot: &str, dry_run: bool) -> Vec<Stale> {
    let remove = |path: &std::path::Path| {
        if !dry_run {
            let _ = fs::remove_file(path);
        }
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let uid = nix::unistd::geteuid().as_raw();
    let mut stale = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file() || metadata.uid() != uid {
            continue;
        }
        let Some(record) = fs::read_to_string(&path)
            .ok()
            .and_then(|text| Record::parse(&text))
        else {
            // Records are replaced atomically, so this is not one.
            remove(&path);
            continue;
        };
        if record.boot != boot {
            remove(&path);
            continue;
        }
        if process_table::instance(record.anchor.pid) == Some(record.anchor.instance) {
            continue;
        }
        stale.push(Stale { path, record });
    }
    stale
}

/// Whether the recorded group id still names the recorded group.
fn group_is_recorded(record: &Record, table: &[Entry]) -> bool {
    table
        .iter()
        .find(|entry| entry.pid == record.group())
        .is_none_or(|holder| holder.instance == record.leader.instance)
}

/// Live processes the record still owns, within the same boundary an anchor
/// applies: never a process older than the recorded leader, another user's,
/// or this reclaimer and the processes above it.
fn targets(record: &Record, table: &[Entry]) -> HashSet<Identity> {
    let recorded = Boundary::new(record.anchor.pid, record.leader, table);
    let me = Boundary::new(std::process::id() as i32, record.leader, table);
    let admits = |entry: &Entry| recorded.admits(entry) && me.admits(entry);
    let mut roots: HashSet<Identity> = record.escapees.iter().copied().collect();
    roots.insert(record.leader);
    if group_is_recorded(record, table) {
        roots.extend(
            table
                .iter()
                .filter(|entry| entry.group == record.group() && admits(entry))
                .map(Entry::identity),
        );
    }
    let owned = process_table::descendants(table, &roots, admits);
    table
        .iter()
        .filter(|entry| entry.live && admits(entry) && owned.contains(&entry.identity()))
        .map(Entry::identity)
        .collect()
}

fn signal_round(stale: &[Stale], signal: Signal) {
    let Ok(table) = process_table::snapshot() else {
        return;
    };
    for stale in stale {
        // Group members are signalled one by one like every other target,
        // each checked against the boundary: a group signal would also
        // reach a member that fails it.
        for target in targets(&stale.record, &table) {
            process_table::signal(target, signal);
        }
    }
}

fn wait_for_release(stale: &[Stale], limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        let released = process_table::snapshot().is_ok_and(|table| {
            stale
                .iter()
                .all(|stale| targets(&stale.record, &table).is_empty())
        });
        if released || Instant::now() >= deadline {
            return released;
        }
        std::thread::sleep(POLL);
    }
}
