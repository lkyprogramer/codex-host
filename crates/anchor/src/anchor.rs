//! The anchor's lifecycle: spawn one Harness group, pin it, and end it only
//! when every member is confirmed gone.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::os::fd::{AsFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::Command;
use std::time::{Duration, Instant};

use nix::fcntl::{FcntlArg, FdFlag, fcntl};
use nix::poll::{PollFd, PollFlags, PollTimeout, poll};
use nix::sys::signal::Signal;
use nix::sys::wait::waitpid;
use nix::unistd::{Pid, dup2_stderr, dup2_stdin, dup2_stdout};
use serde_json::{Value, json};

use crate::control::{Command as ControlCommand, Control, Received};
use crate::group::{self, LeaderExit};

/// The Host passes the control socket as this descriptor.
const CONTROL_FD: i32 = 3;
const DEFAULT_GRACE: Duration = Duration::from_secs(2);
/// A KILL is never followed by a shorter wait than this.
const MIN_KILL_WAIT: Duration = Duration::from_millis(500);
/// Without a Host there is nobody to retry for; keep trying this long.
const ORPHANED_RETRY_LIMIT: Duration = Duration::from_secs(30);
const ACTIVE_TICK: Duration = Duration::from_millis(20);
const IDLE_TICK: Duration = Duration::from_secs(1);

const EXIT_USAGE: i32 = 2;
const EXIT_SPAWN_FAILED: i32 = 127;
/// The Host is gone and the group still has members after every retry.
const EXIT_ABANDONED: i32 = 70;

struct Options {
    exit_grace: Duration,
    lifeline_grace: Duration,
    program: OsString,
    arguments: Vec<OsString>,
}

pub fn run(arguments: Vec<OsString>) -> ! {
    let options = match parse_options(arguments) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("codexhost-anchor: {message}");
            std::process::exit(EXIT_USAGE);
        }
    };
    let control = match take_control_descriptor() {
        Ok(control) => control,
        Err(message) => {
            eprintln!("codexhost-anchor: {message}");
            std::process::exit(EXIT_USAGE);
        }
    };
    let wakeups = match Wakeups::register() {
        Ok(wakeups) => wakeups,
        Err(error) => {
            eprintln!("codexhost-anchor: cannot watch signals: {error}");
            std::process::exit(EXIT_USAGE);
        }
    };
    #[cfg(target_os = "linux")]
    {
        // Descendants that leave the group through setsid or a double fork
        // come back to the anchor once their parent is gone.
        let _ = nix::sys::prctl::set_child_subreaper(true);
    }
    let mut anchor = Anchor::new(control, &options);
    let leader = anchor.spawn(&options);
    silence_standard_streams();
    anchor.announce_ready(leader);
    anchor.supervise(wakeups)
}

fn parse_options(arguments: Vec<OsString>) -> Result<Options, String> {
    let mut exit_grace = DEFAULT_GRACE;
    let mut lifeline_grace = DEFAULT_GRACE;
    let mut arguments = arguments.into_iter();
    loop {
        let Some(argument) = arguments.next() else {
            return Err("expected `-- <program> [arguments...]`".into());
        };
        match argument.to_str() {
            Some("--") => break,
            Some("--exit-grace-ms") => exit_grace = parse_millis(arguments.next(), &argument)?,
            Some("--lifeline-grace-ms") => {
                lifeline_grace = parse_millis(arguments.next(), &argument)?;
            }
            _ => return Err(format!("unknown option {}", argument.to_string_lossy())),
        }
    }
    let program = arguments
        .next()
        .ok_or_else(|| "missing program after `--`".to_string())?;
    Ok(Options {
        exit_grace,
        lifeline_grace,
        program,
        arguments: arguments.collect(),
    })
}

fn parse_millis(value: Option<OsString>, option: &OsString) -> Result<Duration, String> {
    value
        .as_deref()
        .and_then(|value| value.to_str())
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .ok_or_else(|| format!("{} needs a millisecond count", option.to_string_lossy()))
}

fn take_control_descriptor() -> Result<Control, String> {
    // SAFETY: F_GETFD only inspects the descriptor table entry.
    let valid = unsafe { libc::fcntl(CONTROL_FD, libc::F_GETFD) } != -1;
    if !valid {
        return Err("fd 3 must carry the Host control socket".into());
    }
    // SAFETY: fd 3 is open (checked above), was inherited for this purpose,
    // and nothing else in this process owns it.
    let descriptor = unsafe { OwnedFd::from_raw_fd(CONTROL_FD) };
    // The Harness must never inherit the Host's lifeline.
    fcntl(descriptor.as_fd(), FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC))
        .map_err(|error| format!("cannot mark fd 3 close-on-exec: {error}"))?;
    Ok(Control::new(descriptor))
}

/// The Harness owns stdio now. The anchor keeps none of it open, so the
/// Host sees EOF and EPIPE exactly when the Harness side closes.
fn silence_standard_streams() {
    let Ok(null) = OpenOptions::new().read(true).write(true).open("/dev/null") else {
        return;
    };
    let _ = dup2_stdin(&null);
    let _ = dup2_stdout(&null);
    let _ = dup2_stderr(&null);
}

/// Self-pipes that wake `poll` for child state changes and for termination
/// signals sent to the anchor itself (the Shim's fallback cleanup, Ctrl-C).
struct Wakeups {
    child: UnixStream,
    termination: UnixStream,
}

impl Wakeups {
    fn register() -> std::io::Result<Self> {
        let (child, child_writer) = UnixStream::pair()?;
        let (termination, termination_writer) = UnixStream::pair()?;
        for stream in [&child, &child_writer, &termination, &termination_writer] {
            stream.set_nonblocking(true)?;
        }
        signal_hook::low_level::pipe::register(signal_hook::consts::SIGCHLD, child_writer)?;
        for signal in [
            signal_hook::consts::SIGTERM,
            signal_hook::consts::SIGINT,
            signal_hook::consts::SIGHUP,
        ] {
            signal_hook::low_level::pipe::register(signal, termination_writer.try_clone()?)?;
        }
        Ok(Self { child, termination })
    }

    fn drain(stream: &mut UnixStream) -> bool {
        use std::io::Read;
        let mut buffer = [0_u8; 64];
        let mut woke = false;
        while let Ok(read) = stream.read(&mut buffer) {
            if read == 0 {
                break;
            }
            woke = true;
        }
        woke
    }
}

enum Stage {
    Graceful { until: Instant },
    Forced { until: Instant },
}

struct Termination {
    grace: Duration,
    stage: Stage,
}

struct Anchor {
    control: Option<Control>,
    exit_grace: Duration,
    lifeline_grace: Duration,
    leader: Option<Pid>,
    exit: Option<LeaderExit>,
    termination: Option<Termination>,
    orphaned_at: Option<Instant>,
}

impl Anchor {
    fn new(control: Control, options: &Options) -> Self {
        Self {
            control: Some(control),
            exit_grace: options.exit_grace,
            lifeline_grace: options.lifeline_grace,
            leader: None,
            exit: None,
            termination: None,
            orphaned_at: None,
        }
    }

    fn send(&mut self, message: Value) {
        if let Some(control) = self.control.as_mut() {
            control.send(&message);
        }
    }

    /// Creates the Harness as the leader of a new process group. The group id
    /// equals the leader's pid, which the anchor keeps unreaped.
    fn spawn(&mut self, options: &Options) -> Pid {
        let mut command = Command::new(&options.program);
        command.args(&options.arguments).process_group(0);
        #[cfg(target_os = "linux")]
        {
            let anchor = nix::unistd::getpid();
            // SAFETY: the closure only makes async-signal-safe syscalls
            // (prctl, getppid) between fork and exec.
            unsafe {
                command.pre_exec(move || {
                    // If the anchor dies, the leader must not outlive it.
                    nix::sys::prctl::set_pdeathsig(Signal::SIGKILL)?;
                    if nix::unistd::getppid() != anchor {
                        return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    Ok(())
                });
            }
        }
        match command.spawn() {
            // Dropping `Child` neither waits nor kills; the anchor reaps the
            // leader itself once the group is empty.
            Ok(child) => {
                let leader = Pid::from_raw(child.id() as i32);
                self.leader = Some(leader);
                leader
            }
            Err(error) => {
                let code = match error.raw_os_error() {
                    Some(raw) => format!("{:?}", nix::errno::Errno::from_raw(raw)),
                    None => "UNKNOWN".to_string(),
                };
                self.send(json!({
                    "type": "spawnError",
                    "code": code,
                    "message": error.to_string(),
                }));
                std::process::exit(EXIT_SPAWN_FAILED);
            }
        }
    }

    fn announce_ready(&mut self, leader: Pid) {
        self.send(json!({ "type": "ready", "pid": leader.as_raw(), "pgid": leader.as_raw() }));
    }

    fn supervise(mut self, mut wakeups: Wakeups) -> ! {
        loop {
            let tick = if self.termination.is_some() {
                ACTIVE_TICK
            } else {
                IDLE_TICK
            };
            let (control_ready, child_ready, termination_ready) = {
                let mut descriptors = vec![
                    PollFd::new(wakeups.child.as_fd(), PollFlags::POLLIN),
                    PollFd::new(wakeups.termination.as_fd(), PollFlags::POLLIN),
                ];
                if let Some(control) = self.control.as_ref() {
                    descriptors.push(PollFd::new(control.fd(), PollFlags::POLLIN));
                }
                let timeout = PollTimeout::try_from(tick).unwrap_or(PollTimeout::MAX);
                let _ = poll(&mut descriptors, timeout);
                let ready = |index: usize| {
                    descriptors
                        .get(index)
                        .and_then(PollFd::revents)
                        .is_some_and(|events| {
                            events.intersects(
                                PollFlags::POLLIN | PollFlags::POLLHUP | PollFlags::POLLERR,
                            )
                        })
                };
                (ready(2), ready(0), ready(1))
            };
            if child_ready {
                Wakeups::drain(&mut wakeups.child);
            }
            if termination_ready && Wakeups::drain(&mut wakeups.termination) {
                self.request_termination(self.lifeline_grace);
            }
            if control_ready {
                self.receive_control();
            }
            self.advance();
        }
    }

    fn receive_control(&mut self) {
        let Some(control) = self.control.as_mut() else {
            return;
        };
        match control.receive() {
            Received::Commands(commands) => {
                for command in commands {
                    match command {
                        ControlCommand::Terminate { grace } => self.request_termination(grace),
                    }
                }
            }
            Received::Closed => {
                // The lifeline: the Host exited or crashed. Nobody will ask
                // again, so the anchor ends the group on its own.
                self.control = None;
                self.orphaned_at = Some(Instant::now());
                self.request_termination(self.lifeline_grace);
            }
        }
    }

    fn request_termination(&mut self, grace: Duration) {
        if self.termination.is_some() {
            return;
        }
        let now = Instant::now();
        let stage = if grace.is_zero() {
            self.signal_all(Signal::SIGKILL);
            Stage::Forced {
                until: now + MIN_KILL_WAIT,
            }
        } else {
            self.signal_all(Signal::SIGTERM);
            Stage::Graceful { until: now + grace }
        };
        self.termination = Some(Termination { grace, stage });
    }

    fn signal_all(&self, signal: Signal) {
        let Some(leader) = self.leader else {
            return;
        };
        group::signal_group(leader, signal);
        #[cfg(target_os = "linux")]
        for adopted in group::linux::live_adopted_children(nix::unistd::getpid(), leader) {
            group::signal_process(adopted, signal);
        }
    }

    fn live_members(&self) -> usize {
        let Some(leader) = self.leader else {
            return 0;
        };
        let leader_live = usize::from(self.exit.is_none());
        let group = group::live_group_members(leader, leader);
        #[cfg(target_os = "linux")]
        let adopted = group::linux::live_adopted_children(nix::unistd::getpid(), leader).len();
        #[cfg(not(target_os = "linux"))]
        let adopted = 0;
        leader_live + group + adopted
    }

    fn advance(&mut self) {
        let Some(leader) = self.leader else {
            return;
        };
        if self.exit.is_none()
            && let Ok(Some(exit)) = group::peek_leader_exit(leader)
        {
            self.exit = Some(exit);
            self.send(exit_message(exit));
            // A leader that leaves on its own can leave MCP servers and
            // shells behind; reclaim them the same way a close would.
            self.request_termination(self.exit_grace);
        }
        let Some(exit) = self.exit else {
            self.advance_termination();
            return;
        };
        if self.live_members() == 0 {
            self.finish(leader, exit);
        }
        self.advance_termination();
    }

    fn advance_termination(&mut self) {
        let Some(termination) = self.termination.as_mut() else {
            return;
        };
        let now = Instant::now();
        match termination.stage {
            Stage::Graceful { until } if now >= until => {
                termination.stage = Stage::Forced {
                    until: now + termination.grace.max(MIN_KILL_WAIT),
                };
                self.signal_all(Signal::SIGKILL);
            }
            Stage::Forced { until } if now >= until => {
                self.termination = None;
                let live = self.live_members();
                self.send(json!({ "type": "unconfirmed", "live": live }));
                if let Some(orphaned_at) = self.orphaned_at {
                    if now.duration_since(orphaned_at) >= ORPHANED_RETRY_LIMIT {
                        // Exiting releases the pinned group id, but a group
                        // that survives this many KILLs is beyond the anchor.
                        std::process::exit(EXIT_ABANDONED);
                    }
                    self.request_termination(self.lifeline_grace);
                }
            }
            _ => {}
        }
    }

    /// Every member is gone: reap the leader and end with its outcome, so the
    /// Host's `exit` event reports the Harness, not the anchor.
    fn finish(&mut self, leader: Pid, exit: LeaderExit) -> ! {
        self.send(json!({ "type": "released" }));
        let _ = waitpid(leader, None);
        match exit {
            LeaderExit::Code(code) => std::process::exit(code),
            LeaderExit::Signal(signal) => end_with_signal(signal),
        }
    }
}

fn exit_message(exit: LeaderExit) -> Value {
    match exit {
        LeaderExit::Code(code) => json!({ "type": "exit", "code": code }),
        LeaderExit::Signal(signal) => {
            let name = Signal::try_from(signal).map_or("UNKNOWN", Signal::as_str);
            json!({ "type": "exit", "signal": name })
        }
    }
}

fn end_with_signal(signal: i32) -> ! {
    use nix::sys::resource::{Resource, setrlimit};
    // Mirror the signal without writing a core file for the anchor itself.
    let _ = setrlimit(Resource::RLIMIT_CORE, 0, 0);
    if signal == libc::SIGKILL {
        let _ = nix::sys::signal::raise(Signal::SIGKILL);
    } else {
        let _ = signal_hook::low_level::emulate_default_handler(signal);
    }
    std::process::exit(128 + signal);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_graces_and_program() {
        let options = parse_options(arguments(&[
            "--exit-grace-ms",
            "150",
            "--lifeline-grace-ms",
            "40",
            "--",
            "node",
            "--version",
        ]))
        .unwrap();
        assert_eq!(options.exit_grace, Duration::from_millis(150));
        assert_eq!(options.lifeline_grace, Duration::from_millis(40));
        assert_eq!(options.program, OsString::from("node"));
        assert_eq!(options.arguments, arguments(&["--version"]));
    }

    #[test]
    fn rejects_missing_program_and_unknown_options() {
        assert!(parse_options(arguments(&["--"])).is_err());
        assert!(parse_options(arguments(&["node"])).is_err());
        assert!(parse_options(arguments(&["--exit-grace-ms", "soon", "--", "x"])).is_err());
    }
}
