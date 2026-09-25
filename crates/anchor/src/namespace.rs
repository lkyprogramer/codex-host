//! Linux: the anchor as init of its own pid namespace.
//!
//! When the init of a pid namespace dies, the kernel kills every process in
//! that namespace, whatever group or session it moved to. The Host-facing
//! anchor (the outer one) therefore starts a second copy of itself as that
//! init, with a parent-death signal tied to the outer anchor: if the outer
//! anchor is killed, even by SIGKILL, the inner one dies and the kernel ends
//! the whole Harness tree. The inner anchor runs the normal anchor logic; the
//! outer one only relays signals and mirrors the outcome.
//!
//! Creating the namespace needs an unprivileged user namespace and a fresh
//! /proc mount. Where either is refused (a hardened distribution, a
//! container with masked /proc), the anchor runs without it: the leader's
//! own parent-death signal, the subreaper and the ledger still apply.

use std::ffi::{CString, OsString};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;

use nix::sys::signal::{Signal, kill};
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
use nix::unistd::Pid;

/// Internal: marks the inner anchor, followed by its outcome descriptor.
pub const INNER_FLAG: &str = "--namespace-init";
/// Opts out of the namespace (`group`): the Harness then keeps the Host's
/// pid and user namespace, which `sudo` and other setuid programs need.
pub const ISOLATION_ENV: &str = "CODEXHOST_PROCESS_ISOLATION";

pub fn requested() -> bool {
    std::env::var_os(ISOLATION_ENV).as_deref() != Some(std::ffi::OsStr::new("group"))
}

pub struct Inner {
    pid: Pid,
    outcome: OwnedFd,
}

/// Where setup stopped, reported by the child before it gives up.
const STEPS: [&str; 6] = [
    "wait for the user namespace map",
    "make mounts private",
    "mount /proc",
    "arm the parent-death signal",
    "keep the outcome descriptor",
    "exec the inner anchor",
];

fn pipe() -> Result<(OwnedFd, OwnedFd), String> {
    let mut descriptors = [0; 2];
    // SAFETY: `descriptors` has room for the two returned descriptors.
    if unsafe { libc::pipe2(descriptors.as_mut_ptr(), libc::O_CLOEXEC) } == -1 {
        return Err(format!("pipe: {}", std::io::Error::last_os_error()));
    }
    // SAFETY: pipe2 returned two new descriptors owned by nothing else.
    Ok(unsafe {
        (
            OwnedFd::from_raw_fd(descriptors[0]),
            OwnedFd::from_raw_fd(descriptors[1]),
        )
    })
}

/// Starts the inner anchor as init of a new user and pid namespace, passing
/// it `arguments`. Nothing is left behind on failure.
pub fn spawn_inner(arguments: &[OsString]) -> Result<Inner, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("cannot locate the anchor executable: {error}"))?;
    let (go_reader, go_writer) = pipe()?;
    let (status_reader, status_writer) = pipe()?;
    let (outcome_reader, outcome_writer) = pipe()?;
    // Everything the child needs is built before the clone: after it, the
    // child may only make async-signal-safe calls.
    let c_string = |bytes: &[u8]| CString::new(bytes).map_err(|_| "NUL in an argument".to_string());
    let path = c_string(executable.as_os_str().as_bytes())?;
    let mut argv = vec![
        path.clone(),
        c_string(INNER_FLAG.as_bytes())?,
        c_string(outcome_writer.as_raw_fd().to_string().as_bytes())?,
    ];
    for argument in arguments {
        argv.push(c_string(argument.as_bytes())?);
    }
    let mut argv_pointers: Vec<*const libc::c_char> =
        argv.iter().map(|argument| argument.as_ptr()).collect();
    argv_pointers.push(std::ptr::null());
    // SAFETY: sigemptyset initialises the set it is given.
    let unblocked = unsafe {
        let mut set = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
        libc::sigemptyset(set.as_mut_ptr());
        set.assume_init()
    };
    let child = ChildSetup {
        unblocked,
        go: go_reader.as_raw_fd(),
        status: status_writer.as_raw_fd(),
        outcome: outcome_writer.as_raw_fd(),
        path: path.as_ptr(),
        argv: argv_pointers.as_ptr(),
    };

    let flags = libc::CLONE_NEWUSER | libc::CLONE_NEWPID | libc::CLONE_NEWNS | libc::SIGCHLD;
    // SAFETY: a clone without CLONE_VM and with no new stack behaves like
    // fork: the child gets a copy of this (single-threaded) address space.
    // The remaining arguments are zero, so their per-architecture order does
    // not matter.
    let raw = unsafe { libc::syscall(libc::SYS_clone, flags as libc::c_ulong, 0, 0, 0, 0) };
    if raw == 0 {
        // SAFETY: this is the freshly cloned child; `child` points at data
        // that stays valid in its copy of the address space.
        unsafe { child.run() }
    }
    if raw < 0 {
        return Err(format!(
            "cannot create a pid namespace: {}",
            std::io::Error::last_os_error()
        ));
    }
    let pid = Pid::from_raw(raw as i32);
    drop(go_reader);
    drop(status_writer);
    drop(outcome_writer);
    let abandon = |message: String| {
        let _ = kill(pid, Signal::SIGKILL);
        let _ = waitpid(pid, None);
        message
    };
    if let Err(error) = map_identity(pid) {
        return Err(abandon(format!("cannot map the user namespace: {error}")));
    }
    if write_all(go_writer.as_raw_fd(), &[1]).is_err() {
        return Err(abandon("cannot release the inner anchor".into()));
    }
    // The child holds the write end until exec closes it (close-on-exec).
    let mut report = [0_u8; 5];
    let read = read_full(status_reader.as_raw_fd(), &mut report);
    if read != 0 {
        let step = STEPS.get(usize::from(report[0])).unwrap_or(&"start");
        let errno = i32::from_ne_bytes([report[1], report[2], report[3], report[4]]);
        return Err(abandon(format!(
            "cannot {step} in the pid namespace: {}",
            std::io::Error::from_raw_os_error(errno)
        )));
    }
    // Kept open for the outer anchor's lifetime: its end tells the child,
    // during setup, that the outer anchor died before the death signal was
    // armed.
    std::mem::forget(go_writer);
    Ok(Inner {
        pid,
        outcome: outcome_reader,
    })
}

/// Maps only the current user and group into the namespace, as the kernel
/// allows without privileges. Supplementary groups keep working; setuid
/// programs do not, since root has no mapping.
fn map_identity(pid: Pid) -> std::io::Result<()> {
    std::fs::write(format!("/proc/{pid}/setgroups"), "deny")?;
    let uid = nix::unistd::geteuid();
    let gid = nix::unistd::getegid();
    std::fs::write(format!("/proc/{pid}/uid_map"), format!("{uid} {uid} 1"))?;
    std::fs::write(format!("/proc/{pid}/gid_map"), format!("{gid} {gid} 1"))
}

struct ChildSetup {
    /// The caller blocks the relayed signals; the inner anchor must not
    /// start with them blocked.
    unblocked: libc::sigset_t,
    go: RawFd,
    status: RawFd,
    outcome: RawFd,
    path: *const libc::c_char,
    argv: *const *const libc::c_char,
}

impl ChildSetup {
    /// # Safety
    /// Must run only in the child of the clone, which it never returns from.
    unsafe fn run(&self) -> ! {
        let fail = |step: u8| -> ! {
            // SAFETY: errno location, write and _exit are async-signal-safe.
            unsafe {
                let errno = *libc::__errno_location();
                let mut report = [step, 0, 0, 0, 0];
                report[1..].copy_from_slice(&errno.to_ne_bytes());
                libc::write(self.status, report.as_ptr().cast(), report.len());
                libc::_exit(1)
            }
        };
        // SAFETY: only async-signal-safe system calls follow, on descriptors
        // and strings prepared before the clone.
        unsafe {
            let mut go = 0_u8;
            if libc::read(self.go, (&raw mut go).cast(), 1) != 1 {
                fail(0);
            }
            if libc::mount(
                std::ptr::null(),
                c"/".as_ptr(),
                std::ptr::null(),
                libc::MS_REC | libc::MS_PRIVATE,
                std::ptr::null(),
            ) != 0
            {
                fail(1);
            }
            // The inherited /proc shows the parent namespace's pids, which
            // the inner anchor cannot use as its own.
            if libc::mount(
                c"proc".as_ptr(),
                c"/proc".as_ptr(),
                c"proc".as_ptr(),
                libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
                std::ptr::null(),
            ) != 0
            {
                fail(2);
            }
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL, 0, 0, 0) != 0 {
                fail(3);
            }
            // If the outer anchor died before the signal was armed, its end of
            // the go pipe is closed: a read now sees end-of-file.
            libc::fcntl(self.go, libc::F_SETFL, libc::O_NONBLOCK);
            if libc::read(self.go, (&raw mut go).cast(), 1) == 0 {
                libc::_exit(1);
            }
            if libc::fcntl(self.outcome, libc::F_SETFD, 0) != 0 {
                fail(4);
            }
            libc::sigprocmask(libc::SIG_SETMASK, &self.unblocked, std::ptr::null_mut());
            libc::execv(self.path, self.argv);
            fail(5)
        }
    }
}

fn write_all(descriptor: RawFd, bytes: &[u8]) -> std::io::Result<()> {
    let mut written = 0;
    while written < bytes.len() {
        let rest = bytes.get(written..).unwrap_or_default();
        // SAFETY: `rest` is readable for its full length.
        let result = unsafe { libc::write(descriptor, rest.as_ptr().cast(), rest.len()) };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        written += result as usize;
    }
    Ok(())
}

/// Reads until `buffer` is full or end-of-file; returns the bytes read.
fn read_full(descriptor: RawFd, buffer: &mut [u8]) -> usize {
    let mut read = 0;
    while read < buffer.len() {
        let rest = buffer.get_mut(read..).unwrap_or_default();
        // SAFETY: `rest` is writable for its full length.
        let result = unsafe { libc::read(descriptor, rest.as_mut_ptr().cast(), rest.len()) };
        if result < 0 {
            if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            break;
        }
        if result == 0 {
            break;
        }
        read += result as usize;
    }
    read
}

/// The outer anchor after a successful start: forwards termination signals
/// and ends the way the inner anchor did.
pub fn relay(inner: Inner) -> ! {
    // The inner anchor owns the Host's control socket and stdio now; holding
    // them here would hide their end from the Host.
    // SAFETY: fd 3 was inherited for the anchor and nothing here uses it.
    unsafe {
        libc::close(3);
    }
    crate::anchor::silence_standard_streams();
    // `relayed()` stays blocked from before the clone, so nothing sent in
    // between is lost: each one is taken here.
    let relayed = relayed();
    loop {
        if let Some(status) = reap(inner.pid) {
            mirror(status, &inner.outcome);
        }
        if let Ok(signal) = relayed.wait()
            && signal != Signal::SIGCHLD
        {
            let _ = kill(inner.pid, signal);
        }
    }
}

/// The signals the outer anchor relays, plus the one that ends its wait.
pub fn relayed() -> nix::sys::signal::SigSet {
    let mut set = nix::sys::signal::SigSet::empty();
    for signal in [
        Signal::SIGTERM,
        Signal::SIGINT,
        Signal::SIGHUP,
        Signal::SIGCHLD,
    ] {
        set.add(signal);
    }
    set
}

fn reap(pid: Pid) -> Option<WaitStatus> {
    loop {
        match waitpid(pid, Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::StillAlive) => return None,
            Ok(status @ (WaitStatus::Exited(..) | WaitStatus::Signaled(..))) => {
                return Some(status);
            }
            Ok(_) | Err(nix::errno::Errno::EINTR) => {}
            // Not our child any more: nothing to mirror.
            Err(_) => std::process::exit(crate::anchor::EXIT_USAGE),
        }
    }
}

fn mirror(status: WaitStatus, outcome: &OwnedFd) -> ! {
    // A namespace init cannot die from a signal it raises on itself, so the
    // inner anchor reports a Harness killed by a signal here instead.
    let mut signal = [0_u8; 1];
    if read_full(outcome.as_raw_fd(), &mut signal) == 1 {
        crate::anchor::end_with_signal(i32::from(signal[0]));
    }
    match status {
        WaitStatus::Exited(_, code) => std::process::exit(code),
        WaitStatus::Signaled(_, signal, _) => crate::anchor::end_with_signal(signal as i32),
        _ => std::process::exit(crate::anchor::EXIT_USAGE),
    }
}

/// The inner anchor's side of `mirror`.
pub fn report_signal(outcome: RawFd, signal: i32) {
    if let Ok(byte) = u8::try_from(signal) {
        let _ = write_all(outcome, &[byte]);
    }
}
