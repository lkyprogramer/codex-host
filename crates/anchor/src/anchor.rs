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
use crate::ledger::Ledger;
use crate::process_table::{self, Identity};
use crate::tracking::Tracker;

/// The Host passes the control socket as this descriptor.
const CONTROL_FD: i32 = 3;
const DEFAULT_GRACE: Duration = Duration::from_secs(2);
/// `1`: track and report escapees but never signal them or write a ledger.
const DRY_RUN_ENV: &str = "CODEXHOST_PROCESS_ANCHOR_DRY_RUN";
/// `keep`: processes that left the Harness group (a tmux server, gpg-agent,
/// an ssh ControlMaster, a build daemon) outlive the Harness instead of
/// ending with it. The group itself, and on Linux a pid namespace, still end.
const ESCAPEES_ENV: &str = "CODEXHOST_PROCESS_ESCAPEES";
/// A KILL is never followed by a shorter wait than this.
const MIN_KILL_WAIT: Duration = Duration::from_millis(500);
/// Without a Host there is nobody to retry for; keep trying this long.
const ORPHANED_RETRY_LIMIT: Duration = Duration::from_secs(30);
const ACTIVE_TICK: Duration = Duration::from_millis(20);
const IDLE_TICK: Duration = Duration::from_secs(1);
/// Membership scans back off from this to MAX_SCAN_INTERVAL: a group that
/// empties fast is released at once, a lingering one does not cost a core.
const FIRST_SCAN_INTERVAL: Duration = Duration::from_millis(20);
const MAX_SCAN_INTERVAL: Duration = Duration::from_millis(250);
/// How often a running tree is rescanned for escapees. On macOS a fork
/// triggers a scan at once, at most every FORK_SCAN_GAP; Linux adopts
/// orphans as a subreaper and scans only to keep the ledger current.
#[cfg(target_os = "macos")]
const TRACK_INTERVAL: Duration = Duration::from_secs(1);
#[cfg(target_os = "linux")]
const TRACK_INTERVAL: Duration = Duration::from_secs(2);
#[cfg(target_os = "macos")]
const FORK_SCAN_GAP: Duration = Duration::from_millis(20);

// These can equal a Harness's own exit codes. The Host never reads them as
// such: a real Harness outcome always follows `released`, a failed spawn
// `spawnError`, on the control socket.
pub(crate) const EXIT_USAGE: i32 = 2;
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
    if arguments
        .first()
        .is_some_and(|argument| argument == "--reclaim")
    {
        let dry_run = arguments
            .get(1)
            .is_some_and(|argument| argument == "--dry-run");
        std::process::exit(crate::reclaim::run(dry_run));
    }
    let (outcome, arguments) = match split_inner(arguments) {
        Ok(split) => split,
        Err(message) => usage_error(&message),
    };
    let options = match parse_options(arguments.clone()) {
        Ok(options) => options,
        Err(message) => usage_error(&message),
    };
    if let Err(message) = check_control_descriptor() {
        usage_error(&message);
    }
    let wakeups = match Wakeups::register() {
        Ok(wakeups) => wakeups,
        Err(error) => usage_error(&format!("cannot watch signals: {error}")),
    };
    // Why the tree runs without its own pid namespace, told to the Host once
    // it can be: isolation the user expects must not fail silently.
    #[cfg_attr(not(target_os = "linux"), allow(unused_mut))]
    let mut isolation_fallback: Option<String> = None;
    #[cfg(target_os = "linux")]
    if outcome.is_none() && crate::namespace::requested() {
        // Blocked before the clone so the outer anchor misses none of them;
        // a fallback unblocks them into the handlers registered above.
        let relayed = crate::namespace::relayed();
        let _ = relayed.thread_block();
        match crate::namespace::spawn_inner(&arguments) {
            Ok(inner) => crate::namespace::relay(inner),
            Err(reason) => {
                isolation_fallback = Some(format!(
                    "running without pid-namespace isolation ({reason}); a killed anchor leaves its group to a later reclaim"
                ));
            }
        }
        let _ = relayed.thread_unblock();
    }
    let control = match take_control_descriptor() {
        Ok(control) => control,
        Err(message) => usage_error(&message),
    };
    #[cfg(target_os = "linux")]
    // Descendants that leave the group through setsid or a double fork come
    // back to the anchor once their parent is gone.
    let subreaper = nix::sys::prctl::set_child_subreaper(true)
        .err()
        .map(|error| format!("cannot become a child subreaper: {error}"));
    #[cfg(not(target_os = "linux"))]
    let subreaper: Option<String> = None;
    let mut anchor = Anchor::new(control, &options, outcome);
    let leader = anchor.spawn(&options);
    silence_standard_streams();
    anchor.announce_ready(leader);
    if let Some(message) = subreaper {
        anchor.diagnose(message);
    }
    if let Some(message) = isolation_fallback {
        anchor.diagnose(message);
    }
    // Inside its own pid namespace the kernel ends the tree with the anchor,
    // and the namespace's pids would mean nothing to a reclaim outside it.
    anchor.start_tracking(leader, outcome.is_none());
    anchor.supervise(wakeups)
}

fn usage_error(message: &str) -> ! {
    eprintln!("codexhost-anchor: {message}");
    std::process::exit(EXIT_USAGE);
}

/// Separates the inner anchor's outcome descriptor (Linux namespace mode)
/// from the ordinary arguments.
fn split_inner(arguments: Vec<OsString>) -> Result<(Option<i32>, Vec<OsString>), String> {
    #[cfg(target_os = "linux")]
    if arguments
        .first()
        .is_some_and(|argument| argument == crate::namespace::INNER_FLAG)
    {
        let outcome = arguments
            .get(1)
            .and_then(|value| value.to_str())
            .and_then(|value| value.parse::<i32>().ok())
            .ok_or("the inner anchor needs its outcome descriptor")?;
        // The Harness must not inherit it: its end tells the outer anchor
        // the inner one is gone.
        // SAFETY: F_SETFD only changes the descriptor table entry.
        if unsafe { libc::fcntl(outcome, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(format!(
                "cannot mark the outcome descriptor close-on-exec: {}",
                std::io::Error::last_os_error()
            ));
        }
        return Ok((Some(outcome), arguments.into_iter().skip(2).collect()));
    }
    Ok((None, arguments))
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

fn check_control_descriptor() -> Result<(), String> {
    // SAFETY: F_GETFD only inspects the descriptor table entry.
    let valid = unsafe { libc::fcntl(CONTROL_FD, libc::F_GETFD) } != -1;
    if !valid {
        return Err("fd 3 must carry the Host control socket".into());
    }
    Ok(())
}

fn take_control_descriptor() -> Result<Control, String> {
    check_control_descriptor()?;
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
pub(crate) fn silence_standard_streams() {
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
    next_scan: Instant,
    scan_interval: Duration,
    /// A diagnostic already told the Host why the group cannot be observed.
    scan_diagnosed: bool,
    tracker: Option<Tracker>,
    ledger: Option<Ledger>,
    next_track: Instant,
    #[cfg(target_os = "macos")]
    last_track: Option<Instant>,
    track_diagnosed: bool,
    /// Escapees are only reported, never signalled, and nothing is recorded.
    dry_run: bool,
    /// Linux namespace mode: where the inner anchor reports a Harness that
    /// died from a signal, which a namespace init cannot mirror itself.
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    outcome: Option<i32>,
}

impl Anchor {
    fn new(control: Control, options: &Options, outcome: Option<i32>) -> Self {
        Self {
            control: Some(control),
            exit_grace: options.exit_grace,
            lifeline_grace: options.lifeline_grace,
            leader: None,
            exit: None,
            termination: None,
            orphaned_at: None,
            next_scan: Instant::now(),
            scan_interval: FIRST_SCAN_INTERVAL,
            scan_diagnosed: false,
            tracker: None,
            ledger: None,
            next_track: Instant::now(),
            #[cfg(target_os = "macos")]
            last_track: None,
            track_diagnosed: false,
            dry_run: std::env::var_os(DRY_RUN_ENV).is_some_and(|value| value == "1"),
            outcome,
        }
    }

    /// Starts watching for escapees and, when `record` is set, records the
    /// group so a reclaim can end it should this anchor be killed.
    fn start_tracking(&mut self, leader: Pid, record: bool) {
        let anchor = nix::unistd::getpid().as_raw();
        let identity =
            |pid: i32| process_table::instance(pid).map(|instance| Identity { pid, instance });
        // A leader that already exited cannot be identified, and without its
        // instance there is no boundary to own escapees by. Its group is
        // still reclaimed through the pinned group id, as always.
        let Some(anchor_identity) = identity(anchor) else {
            // Its own identity is always readable; failing here means the
            // platform layout changed, and nothing below would work either.
            self.diagnose(
                "cannot read process identities; escapees are not tracked and the group is not recorded"
                    .into(),
            );
            return;
        };
        let Some(leader) = identity(leader.as_raw()) else {
            return;
        };
        let keep = std::env::var_os(ESCAPEES_ENV).is_some_and(|value| value == "keep");
        match Tracker::new(anchor, leader, self.dry_run, !self.dry_run && !keep) {
            Ok(tracker) => self.tracker = Some(tracker),
            Err(message) => self.diagnose(message),
        }
        if record && !self.dry_run {
            match Ledger::create(anchor_identity, leader) {
                Ok(ledger) => self.ledger = Some(ledger),
                Err(message) => self.diagnose(message),
            }
        }
    }

    /// Rescans for escapees and keeps the ledger in step.
    fn track(&mut self) {
        let now = Instant::now();
        self.next_track = now + TRACK_INTERVAL;
        #[cfg(target_os = "macos")]
        {
            self.last_track = Some(now);
        }
        let Some(tracker) = self.tracker.as_mut() else {
            return;
        };
        let failure = match tracker.refresh() {
            Ok(report) => {
                let recorded = tracker.recorded();
                let failure = self
                    .ledger
                    .as_mut()
                    .and_then(|ledger| ledger.record_owned(&recorded).err());
                if let Some(report) = report
                    && self.dry_run
                {
                    self.send(dry_run_report(&report));
                }
                failure
            }
            Err(message) => Some(message),
        };
        if let Some(message) = failure
            && !self.track_diagnosed
        {
            self.track_diagnosed = true;
            self.diagnose(message);
        }
    }

    /// A tracked process forked: scan now, so a child that leaves the group
    /// is seen before its parent can exit and hide the link.
    #[cfg(target_os = "macos")]
    fn schedule_fork_scan(&mut self) {
        let now = Instant::now();
        let earliest = self
            .last_track
            .map_or(now, |last| (last + FORK_SCAN_GAP).max(now));
        self.next_track = self.next_track.min(earliest);
    }

    fn send(&mut self, message: Value) {
        if let Some(control) = self.control.as_mut() {
            control.send(&message);
        }
    }

    /// Ends the anchor once its final messages had a chance to be read.
    fn exit(&mut self, code: i32) -> ! {
        if let Some(control) = self.control.as_mut() {
            control.flush_before_exit();
        }
        std::process::exit(code);
    }

    /// Standard error is /dev/null once the Harness runs; the Host is told
    /// why a group cannot be observed or fully owned instead.
    fn diagnose(&mut self, message: String) {
        self.send(json!({ "type": "diagnostic", "message": message }));
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
                    // If the anchor dies, the leader must not outlive it. Only
                    // the leader is covered: the rest of the group survives an
                    // anchor that is itself killed, which is why nothing may
                    // SIGKILL the anchor on purpose.
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
                self.exit(EXIT_SPAWN_FAILED);
            }
        }
    }

    fn announce_ready(&mut self, leader: Pid) {
        if self.outcome.is_some() {
            // Inside the namespace the leader's pid means nothing outside it.
            self.send(json!({ "type": "ready", "namespace": true }));
            return;
        }
        self.send(json!({ "type": "ready", "pid": leader.as_raw(), "pgid": leader.as_raw() }));
    }

    fn supervise(mut self, mut wakeups: Wakeups) -> ! {
        loop {
            let tick = if self.termination.is_some() {
                ACTIVE_TICK
            } else {
                IDLE_TICK
            };
            let tick = tick.min(
                self.next_track
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(1)),
            );
            let (control_ready, control_writable, child_ready, termination_ready, forked) = {
                let mut descriptors = vec![
                    PollFd::new(wakeups.child.as_fd(), PollFlags::POLLIN),
                    PollFd::new(wakeups.termination.as_fd(), PollFlags::POLLIN),
                ];
                let control_index = self.control.as_ref().map(|control| {
                    let interest = if control.wants_write() {
                        PollFlags::POLLIN | PollFlags::POLLOUT
                    } else {
                        PollFlags::POLLIN
                    };
                    descriptors.push(PollFd::new(control.fd(), interest));
                    descriptors.len() - 1
                });
                #[cfg(target_os = "macos")]
                let fork_index = self.tracker.as_ref().map(|tracker| {
                    descriptors.push(PollFd::new(tracker.fork_events(), PollFlags::POLLIN));
                    descriptors.len() - 1
                });
                #[cfg(not(target_os = "macos"))]
                let fork_index: Option<usize> = None;
                let timeout = PollTimeout::try_from(tick).unwrap_or(PollTimeout::MAX);
                let _ = poll(&mut descriptors, timeout);
                let events = |index: Option<usize>, wanted: PollFlags| {
                    index
                        .and_then(|index| descriptors.get(index))
                        .and_then(PollFd::revents)
                        .is_some_and(|events| events.intersects(wanted))
                };
                let readable = PollFlags::POLLIN | PollFlags::POLLHUP | PollFlags::POLLERR;
                (
                    events(control_index, readable),
                    events(control_index, PollFlags::POLLOUT),
                    events(Some(0), readable),
                    events(Some(1), readable),
                    events(fork_index, readable),
                )
            };
            #[cfg(target_os = "macos")]
            if forked
                && let Some(tracker) = self.tracker.as_mut()
                && tracker.drain_fork_events()
            {
                self.schedule_fork_scan();
            }
            #[cfg(not(target_os = "macos"))]
            let _ = forked;
            if control_writable && let Some(control) = self.control.as_mut() {
                control.flush();
            }
            if child_ready && Wakeups::drain(&mut wakeups.child) {
                self.reap_adopted();
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

    /// Adopted descendants that exit while the leader still runs would stay
    /// zombies for the whole session; reap them as they go.
    fn reap_adopted(&self) {
        #[cfg(target_os = "linux")]
        if let Some(leader) = self.leader {
            group::linux::live_adopted_children(leader);
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

    /// Starts a termination round, or brings the one in progress forward when
    /// the new request is more urgent: a later, shorter grace (or a lost
    /// lifeline) must never wait out an earlier, longer one.
    fn request_termination(&mut self, grace: Duration) {
        let now = Instant::now();
        self.scan_interval = FIRST_SCAN_INTERVAL;
        self.next_scan = now;
        if let Some(termination) = self.termination.as_mut() {
            if let Stage::Graceful { until } = termination.stage {
                if grace.is_zero() {
                    termination.stage = Stage::Forced {
                        until: now + MIN_KILL_WAIT,
                    };
                    self.signal_all(Signal::SIGKILL);
                } else if now + grace < until {
                    termination.stage = Stage::Graceful { until: now + grace };
                    // The forced window follows the grace that now applies.
                    termination.grace = grace;
                }
            }
            return;
        }
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
        group::linux::signal_adopted(leader, signal);
        if let Some(tracker) = self.tracker.as_ref() {
            tracker.signal(signal);
        }
    }

    fn live_members(&mut self) -> usize {
        let Some(leader) = self.leader else {
            return 0;
        };
        self.track();
        let escapees = self.tracker.as_ref().map_or(0, Tracker::foreign_escapees);
        let leader_live = usize::from(self.exit.is_none()) + escapees;
        let others = match group::live_members(leader, leader) {
            Ok(others) => others,
            Err(message) => {
                if !self.scan_diagnosed {
                    self.scan_diagnosed = true;
                    self.diagnose(message);
                }
                1
            }
        };
        leader_live + others
    }

    fn advance(&mut self) {
        let Some(leader) = self.leader else {
            return;
        };
        if Instant::now() >= self.next_track {
            self.track();
        }
        if self.exit.is_none()
            && let Ok(Some(exit)) = group::peek_leader_exit(leader)
        {
            self.exit = Some(exit);
            self.send(exit_message(exit));
            // A leader that leaves on its own can leave MCP servers and
            // shells behind; reclaim them the same way a close would.
            self.request_termination(self.exit_grace);
        }
        if let Some(exit) = self.exit {
            let now = Instant::now();
            if now >= self.next_scan {
                if self.live_members() == 0 {
                    self.finish(leader, exit);
                }
                self.next_scan = now + self.scan_interval;
                self.scan_interval = (self.scan_interval * 2).min(MAX_SCAN_INTERVAL);
            }
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
                        // The record stays for a later reclaim; make it current.
                        if let Some(ledger) = self.ledger.as_mut() {
                            let _ = ledger.flush();
                        }
                        self.exit(EXIT_ABANDONED);
                    }
                    self.request_termination(self.lifeline_grace);
                }
            }
            // Members that join late (a descendant adopted after the first
            // KILL, one that escaped its parent) are killed on every tick of
            // the forced window rather than surviving until the next round.
            Stage::Forced { .. } => self.signal_all(Signal::SIGKILL),
            Stage::Graceful { .. } => {}
        }
    }

    /// Every member is gone: reap the leader and end with its outcome, so the
    /// Host's `exit` event reports the Harness, not the anchor.
    fn finish(&mut self, leader: Pid, exit: LeaderExit) -> ! {
        if let Some(ledger) = self.ledger.take() {
            ledger.remove();
        }
        self.send(json!({ "type": "released" }));
        if let Some(control) = self.control.as_mut() {
            control.flush_before_exit();
        }
        let _ = waitpid(leader, None);
        match exit {
            LeaderExit::Code(code) => std::process::exit(code),
            LeaderExit::Signal(signal) => {
                #[cfg(target_os = "linux")]
                if let Some(outcome) = self.outcome {
                    crate::namespace::report_signal(outcome, signal);
                }
                end_with_signal(signal)
            }
        }
    }
}

/// Tells the Host which processes would be treated as escapees, and which
/// the walk reached but the ownership boundary refused.
fn dry_run_report(report: &crate::tracking::Report) -> Value {
    let describe = |entries: &[process_table::Entry]| {
        entries
            .iter()
            .map(|entry| {
                json!({
                    "pid": entry.pid,
                    "parent": entry.parent,
                    "group": entry.group,
                    "uid": entry.uid,
                    "instance": entry.instance,
                })
            })
            .collect::<Vec<_>>()
    };
    json!({
        "type": "dryRun",
        "escapees": describe(&report.escapees),
        "rejected": describe(&report.rejected),
    })
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

pub(crate) fn end_with_signal(signal: i32) -> ! {
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
