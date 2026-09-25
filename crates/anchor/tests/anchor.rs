#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::io::{BufRead, BufReader, ErrorKind, Write};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

/// One anchor under test, with the Host end of its fd 3 socket.
struct Anchored {
    child: Child,
    host: BufReader<UnixStream>,
    /// Set from `ready`, so a failing test still reclaims the whole group.
    leader: Option<i32>,
}

impl Anchored {
    /// An anchor in plain process-group mode: these tests follow the
    /// Harness by its pid, which a pid namespace would renumber.
    fn start(options: &[&str], program: &[&str]) -> Self {
        Self::start_with_env(
            options,
            program,
            &[("CODEXHOST_PROCESS_ISOLATION", Some("group"))],
        )
    }

    fn start_with_env(options: &[&str], program: &[&str], env: &[(&str, Option<&str>)]) -> Self {
        let (host, anchor_end) = UnixStream::pair().unwrap();
        // Before spawning: macOS rejects the option once a fast anchor has
        // already exited and closed its end.
        host.set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let descriptor = anchor_end.as_raw_fd();
        let mut command = Command::new(env!("CARGO_BIN_EXE_codexhost-anchor"));
        command
            .args(options)
            .arg("--")
            .args(program)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            // Never the user's own records: a reclaim there is not a test's.
            .env("CODEXHOST_PROCESS_LEDGER_DIR", ledger_directory())
            .env_remove("CODEXHOST_PROCESS_ANCHOR_DRY_RUN");
        for (name, value) in env {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        // SAFETY: dup2 is async-signal-safe; it only places the socket on fd 3
        // (and clears close-on-exec there) between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if libc::dup2(descriptor, 3) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        drop(anchor_end);
        Self {
            child,
            host: BufReader::new(host),
            leader: None,
        }
    }

    fn message(&mut self) -> Value {
        let mut line = String::new();
        let read = self.host.read_line(&mut line).unwrap();
        assert!(read > 0, "anchor closed its control socket early");
        serde_json::from_str(&line).unwrap()
    }

    fn expect(&mut self, kind: &str) -> Value {
        let message = self.message();
        assert_eq!(message["type"], kind, "unexpected message {message}");
        if kind == "ready" {
            self.leader = message["pid"].as_i64().map(|pid| pid as i32);
        }
        message
    }

    fn terminate(&mut self, grace_ms: u64) {
        let stream = self.host.get_mut();
        writeln!(stream, r#"{{"op":"terminate","graceMs":{grace_ms}}}"#).unwrap();
    }

    fn wait(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "anchor did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Anchored {
    fn drop(&mut self) {
        if let Some(leader) = self.leader {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(leader),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// One private ledger directory for this test process.
fn ledger_directory() -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("codexhost-anchor-ledger-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::set_permissions(
        &directory,
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )
    .unwrap();
    directory
}

fn pid_file(name: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let path = std::env::temp_dir().join(format!(
        "codexhost-anchor-{name}-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = std::fs::remove_file(&path);
    path
}

/// Waits for a fixture to publish a pid, then returns it.
fn read_pid(path: &PathBuf) -> i32 {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && let Ok(pid) = text.trim().parse()
        {
            return pid;
        }
        assert!(Instant::now() < deadline, "fixture never wrote {path:?}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn alive(pid: i32) -> bool {
    // A zombie reports as present to kill(2); only its state says it is dead.
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    let state = state.trim();
    !state.is_empty() && !state.starts_with('Z')
}

fn zombie(pid: i32) -> bool {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .starts_with('Z')
}

fn wait_until(condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "condition not reached in time");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn reports_ready_and_mirrors_the_harness_exit_code() {
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", "exit 7"]);
    let ready = anchor.expect("ready");
    assert_eq!(ready["pid"], ready["pgid"]);
    assert_eq!(anchor.expect("exit")["code"], 7);
    anchor.expect("released");
    assert_eq!(anchor.wait().code(), Some(7));
}

#[test]
fn mirrors_a_harness_that_died_from_a_signal() {
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", "kill -TERM $$"]);
    anchor.expect("ready");
    assert_eq!(anchor.expect("exit")["signal"], "SIGTERM");
    anchor.expect("released");
    assert_eq!(anchor.wait().signal(), Some(libc::SIGTERM));
}

#[test]
fn reports_a_harness_that_cannot_be_created() {
    let mut anchor = Anchored::start(&[], &["/nonexistent/codexhost-harness"]);
    let failure = anchor.expect("spawnError");
    assert_eq!(failure["code"], "ENOENT");
    assert_eq!(anchor.wait().code(), Some(127));
}

#[test]
fn reclaims_descendants_after_the_leader_exits_and_keeps_it_unreaped_until_then() {
    let file = pid_file("orphan");
    let script = format!(
        "trap '' TERM; (trap '' TERM; exec sleep 60) & echo $! > {}; exit 0",
        file.display()
    );
    let mut anchor = Anchored::start(&["--exit-grace-ms", "300"], &["/bin/sh", "-c", &script]);
    let leader = anchor.expect("ready")["pid"].as_i64().unwrap() as i32;
    let descendant = read_pid(&file);
    assert_eq!(anchor.expect("exit")["code"], 0);
    // The descendant ignores TERM, so the group outlives the leader for the
    // grace period. Until the group is empty the leader stays a zombie: its
    // pid, and with it the group id, cannot be handed to anyone else.
    assert!(alive(descendant));
    assert!(zombie(leader), "the exited leader must stay unreaped");
    anchor.expect("released");
    assert_eq!(anchor.wait().code(), Some(0));
    assert!(!alive(descendant));
    let _ = std::fs::remove_file(file);
}

#[test]
fn terminate_escalates_to_kill_for_descendants_that_ignore_term() {
    let file = pid_file("stubborn");
    let script = format!(
        "trap '' TERM; (trap '' TERM; exec sleep 60) & echo $! > {}; wait",
        file.display()
    );
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", &script]);
    anchor.expect("ready");
    let descendant = read_pid(&file);
    anchor.terminate(150);
    assert_eq!(anchor.expect("exit")["signal"], "SIGKILL");
    anchor.expect("released");
    assert_eq!(anchor.wait().signal(), Some(libc::SIGKILL));
    assert!(!alive(descendant));
    let _ = std::fs::remove_file(file);
}

#[test]
fn a_lost_lifeline_ends_the_whole_group() {
    let file = pid_file("lifeline");
    let script = format!("sleep 60 & echo $! > {}; wait", file.display());
    let mut anchor = Anchored::start(&["--lifeline-grace-ms", "200"], &["/bin/sh", "-c", &script]);
    anchor.expect("ready");
    let descendant = read_pid(&file);
    // The Host dying closes its socket end; nothing else is sent.
    let _ = anchor.host.get_ref().shutdown(std::net::Shutdown::Both);
    let status = anchor.wait();
    assert_eq!(status.signal(), Some(libc::SIGTERM));
    assert!(!alive(descendant));
    let _ = std::fs::remove_file(file);
}

#[test]
fn a_termination_signal_to_the_anchor_ends_the_group() {
    let file = pid_file("signalled");
    let script = format!("sleep 60 & echo $! > {}; wait", file.display());
    let mut anchor = Anchored::start(&["--lifeline-grace-ms", "200"], &["/bin/sh", "-c", &script]);
    anchor.expect("ready");
    let descendant = read_pid(&file);
    let anchor_pid = nix::unistd::Pid::from_raw(anchor.child.id() as i32);
    nix::sys::signal::kill(anchor_pid, nix::sys::signal::Signal::SIGTERM).unwrap();
    assert_eq!(anchor.expect("exit")["signal"], "SIGTERM");
    anchor.expect("released");
    anchor.wait();
    assert!(!alive(descendant));
    let _ = std::fs::remove_file(file);
}

#[test]
fn a_zero_grace_terminate_kills_at_once() {
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", "trap '' TERM; sleep 60"]);
    anchor.expect("ready");
    let started = Instant::now();
    anchor.terminate(0);
    assert_eq!(anchor.expect("exit")["signal"], "SIGKILL");
    anchor.expect("released");
    anchor.wait();
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn the_harness_never_inherits_the_control_socket() {
    // fd 3 is the Host's lifeline; a Harness holding it would keep the anchor
    // from ever seeing the Host die.
    let mut anchor = Anchored::start(
        &[],
        &[
            "/bin/sh",
            "-c",
            "if [ -e /dev/fd/3 ]; then exit 3; fi; exit 0",
        ],
    );
    anchor.expect("ready");
    assert_eq!(anchor.expect("exit")["code"], 0);
    anchor.expect("released");
    anchor.wait();
}

#[test]
fn ignores_malformed_control_lines() {
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", "sleep 60"]);
    anchor.expect("ready");
    writeln!(anchor.host.get_mut(), "not json\n{{\"op\":\"reboot\"}}").unwrap();
    anchor.terminate(100);
    assert_eq!(anchor.expect("exit")["signal"], "SIGTERM");
    anchor.expect("released");
    anchor.wait();
}

#[cfg(target_os = "linux")]
#[test]
fn adopts_and_reclaims_descendants_that_escape_the_group() {
    let file = pid_file("escaped");
    // setsid leaves the group; once its parent exits, the subreaper adopts it.
    let script = format!(
        "setsid sh -c 'echo $$ > {}; exec sleep 60' & sleep 0.3; exit 0",
        file.display()
    );
    let mut anchor = Anchored::start(&["--exit-grace-ms", "300"], &["/bin/sh", "-c", &script]);
    anchor.expect("ready");
    let escaped = read_pid(&file);
    anchor.expect("exit");
    anchor.expect("released");
    anchor.wait();
    wait_until(|| !alive(escaped));
    let _ = std::fs::remove_file(file);
}

#[test]
fn the_socket_peer_end_reads_eof_when_the_anchor_exits() {
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", "exit 0"]);
    anchor.expect("ready");
    anchor.expect("exit");
    anchor.expect("released");
    anchor.wait();
    let mut line = String::new();
    match anchor.host.read_line(&mut line) {
        Ok(read) => assert_eq!(read, 0),
        Err(error) => assert_ne!(error.kind(), ErrorKind::WouldBlock),
    }
}

#[test]
fn a_shorter_terminate_overtakes_one_in_progress() {
    let file = pid_file("urgent");
    let script = format!("trap '' TERM; echo $$ > {}; exec sleep 60", file.display());
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", &script]);
    anchor.expect("ready");
    // Only once TERM is ignored does the long grace have to be overtaken.
    read_pid(&file);
    let started = Instant::now();
    anchor.terminate(10_000);
    // The long grace would hold the KILL for ten seconds; the urgent request
    // must not wait it out.
    anchor.terminate(0);
    assert_eq!(anchor.expect("exit")["signal"], "SIGKILL");
    anchor.expect("released");
    anchor.wait();
    assert!(started.elapsed() < Duration::from_secs(5));
    let _ = std::fs::remove_file(file);
}

#[test]
fn reclaims_a_stopped_member() {
    let file = pid_file("stopped");
    let script = format!("sleep 60 & echo $! > {}; exec sleep 60", file.display());
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", &script]);
    let leader = anchor.expect("ready")["pid"].as_i64().unwrap().to_string();
    let member = read_pid(&file);
    // While the leader is still a shell it resumes a stopped child on its
    // own; stop the member only once the leader has become sleep.
    wait_until(|| {
        let output = Command::new("ps")
            .args(["-o", "command=", "-p", &leader])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .starts_with("sleep")
    });
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(member),
        nix::sys::signal::Signal::SIGSTOP,
    )
    .unwrap();
    wait_until(|| {
        let output = Command::new("ps")
            .args(["-o", "stat=", "-p", &member.to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .starts_with('T')
    });
    anchor.terminate(150);
    anchor.expect("exit");
    anchor.expect("released");
    anchor.wait();
    assert!(!alive(member));
    let _ = std::fs::remove_file(file);
}

#[cfg(target_os = "linux")]
fn zombie_children(parent: u32) -> usize {
    let output = Command::new("ps")
        .args(["-o", "stat=", "--ppid", &parent.to_string()])
        .output()
        .unwrap();
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|state| state.trim().starts_with('Z'))
        .count()
}

#[cfg(target_os = "linux")]
#[test]
fn reaps_adopted_descendants_while_the_leader_still_runs() {
    let file = pid_file("reaped");
    // Each background sleep is orphaned when its sh exits, adopted by the
    // subreaper anchor, and exits shortly after, while the leader stays up.
    let script = format!(
        "for i in 1 2 3 4 5 6 7 8 9 10; do sh -c 'sleep 0.05 &'; done; echo done > {}; sleep 60",
        file.display()
    );
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", &script]);
    anchor.expect("ready");
    let deadline = Instant::now() + Duration::from_secs(5);
    while !file.exists() {
        assert!(Instant::now() < deadline, "fixture never finished");
        std::thread::sleep(Duration::from_millis(10));
    }
    wait_until(|| zombie_children(anchor.child.id()) == 0);
    // Stays at zero, not only momentarily.
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(zombie_children(anchor.child.id()), 0);
    anchor.terminate(100);
    anchor.expect("exit");
    anchor.expect("released");
    anchor.wait();
    let _ = std::fs::remove_file(file);
}

#[cfg(target_os = "linux")]
#[test]
fn kills_a_descendant_adopted_after_the_kill_was_sent() {
    let file = pid_file("late");
    // A ignores TERM and has a setsid'd child B outside the group. B is only
    // adopted once A dies from the KILL, after the KILL edge was signalled.
    let script = format!(
        "(trap '' TERM; setsid sh -c 'echo $$ > {}; exec sleep 60' & exec sleep 60) & sleep 0.3; exit 0",
        file.display()
    );
    let mut anchor = Anchored::start(&["--exit-grace-ms", "300"], &["/bin/sh", "-c", &script]);
    anchor.expect("ready");
    let escaped = read_pid(&file);
    anchor.expect("exit");
    anchor.expect("released");
    anchor.wait();
    assert!(!alive(escaped));
    let _ = std::fs::remove_file(file);
}

/// A process that leaves the group with setsid and then sleeps, writing its
/// pid first. perl ships with both macOS and Debian; macOS has no setsid(1).
fn escapee(file: &std::path::Path, seconds: &str) -> String {
    format!(
        "perl -MPOSIX -e 'POSIX::setsid(); open(F, \">\", $ARGV[0]) or die; print F $$; close F; exec \"sleep\", $ARGV[1]' {} {seconds}",
        file.display()
    )
}

/// The record a live anchor keeps for its group, once it names `pid`.
fn record_naming(anchor: u32, pid: i32) -> PathBuf {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        for entry in std::fs::read_dir(ledger_directory()).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(&format!("{anchor}-"))
                && name.ends_with(".json")
                && let Ok(text) = std::fs::read_to_string(entry.path())
                && let Ok(record) = serde_json::from_str::<Value>(&text)
                && record["escapees"]
                    .as_array()
                    .is_some_and(|escapees| escapees.iter().any(|e| e["pid"] == pid))
            {
                return entry.path();
            }
        }
        assert!(Instant::now() < deadline, "no record named escapee {pid}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn reclaim(arguments: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_codexhost-anchor"))
        .arg("--reclaim")
        .args(arguments)
        .env("CODEXHOST_PROCESS_LEDGER_DIR", ledger_directory())
        .output()
        .unwrap()
}

#[test]
fn a_killed_anchor_leaves_a_record_that_a_reclaim_ends_exactly() {
    let escaped = pid_file("record-escapee");
    let member = pid_file("record-member");
    // The escapee's parent (the leader) stays up, so the tracker finds it
    // while it is still linked to the group.
    let script = format!(
        "{} & sleep 60 & echo $! > {}; exec sleep 60",
        escapee(&escaped, "60"),
        member.display()
    );
    let mut anchor = Anchored::start(&[], &["/bin/sh", "-c", &script]);
    anchor.expect("ready");
    let escaped_pid = read_pid(&escaped);
    let member_pid = read_pid(&member);
    let record = record_naming(anchor.child.id(), escaped_pid);

    // Killed outright, the anchor ends nothing itself.
    anchor.child.kill().unwrap();
    anchor.child.wait().unwrap();
    assert!(alive(escaped_pid) && alive(member_pid));

    // A dry run names exactly what it would end and changes nothing.
    let dry = reclaim(&["--dry-run"]);
    assert!(dry.status.success());
    let listed = String::from_utf8_lossy(&dry.stdout);
    assert!(listed.contains(&escaped_pid.to_string()), "{listed}");
    assert!(listed.contains(&member_pid.to_string()), "{listed}");
    assert!(alive(escaped_pid) && alive(member_pid) && record.exists());

    let reclaimed = reclaim(&[]);
    assert_eq!(reclaimed.status.code(), Some(0), "{reclaimed:?}");
    wait_until(|| !alive(escaped_pid) && !alive(member_pid));
    assert!(!record.exists());
    let _ = std::fs::remove_file(escaped);
    let _ = std::fs::remove_file(member);
}

#[test]
fn a_dry_run_reports_escapees_and_never_signals_them() {
    let escaped = pid_file("dry-escapee");
    let script = format!("{} & exec sleep 60", escapee(&escaped, "60"));
    let mut anchor = Anchored::start_with_env(
        &[],
        &["/bin/sh", "-c", &script],
        &[
            ("CODEXHOST_PROCESS_ISOLATION", Some("group")),
            ("CODEXHOST_PROCESS_ANCHOR_DRY_RUN", Some("1")),
        ],
    );
    anchor.expect("ready");
    let escaped_pid = read_pid(&escaped);
    let report = loop {
        let message = anchor.message();
        if message["type"] == "dryRun"
            && message["escapees"]
                .as_array()
                .is_some_and(|e| !e.is_empty())
        {
            break message;
        }
    };
    let reported: Vec<i64> = report["escapees"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|escapee| escapee["pid"].as_i64())
        .collect();
    assert_eq!(reported, [i64::from(escaped_pid)]);
    assert_eq!(report["rejected"], serde_json::json!([]));
    anchor.terminate(100);
    std::thread::sleep(Duration::from_millis(800));
    // On Linux the escapee is adopted by the subreaper anchor once the
    // leader dies and is then ended as its own child, which a dry run does
    // not change; only the tracker's signals to processes it does not
    // parent are withheld.
    #[cfg(target_os = "macos")]
    assert!(alive(escaped_pid), "a dry run signalled an escapee");
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(escaped_pid),
        nix::sys::signal::Signal::SIGKILL,
    );
    anchor.wait();
    let _ = std::fs::remove_file(escaped);
}

#[cfg(target_os = "linux")]
#[test]
fn in_a_pid_namespace_killing_the_anchor_ends_the_whole_tree() {
    // A marker only this test's processes carry, found from outside.
    let marker = format!("61.{}", std::process::id() % 1000);
    let marked = |marker: &str| {
        std::fs::read_dir("/proc")
            .unwrap()
            .flatten()
            .filter(|entry| {
                std::fs::read(entry.path().join("cmdline")).is_ok_and(|command| {
                    String::from_utf8_lossy(&command).contains(&format!("sleep\0{marker}"))
                })
            })
            .count()
    };
    let escaped = pid_file("namespace-escapee");
    let script = format!(
        "{} & sleep {marker} & exec sleep {marker}",
        escapee(&escaped, &marker)
    );
    let mut anchor = Anchored::start_with_env(
        &[],
        &["/bin/sh", "-c", &script],
        &[("CODEXHOST_PROCESS_ISOLATION", None)],
    );
    let ready = anchor.expect("ready");
    if ready["namespace"] != true {
        eprintln!("skipped: this system does not allow an unprivileged pid namespace");
        anchor.terminate(0);
        anchor.wait();
        return;
    }
    wait_until(|| marked(&marker) == 3);
    // SIGKILL leaves the anchor no chance to act; the kernel ends the tree.
    anchor.child.kill().unwrap();
    anchor.child.wait().unwrap();
    wait_until(|| marked(&marker) == 0);
    let _ = std::fs::remove_file(escaped);
}
