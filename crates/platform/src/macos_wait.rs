use std::io;
use std::os::unix::process::ExitStatusExt;
use std::process::ExitStatus;

/// The exit status of the exited child `process_id` without reaping it, or
/// `None` while it runs. The zombie keeps the pid, and the process group id
/// it leads, from being reused until the child is reaped.
pub(crate) fn exit_status_retaining(process_id: u32) -> io::Result<Option<ExitStatus>> {
    let id = libc::id_t::from(process_id);
    // SAFETY: an all-zero siginfo_t is a valid value, and `waitid` only
    // writes into the one it is given.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    loop {
        // SAFETY: `info` outlives the call.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                id,
                &raw mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == 0 {
            break;
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
    // WNOHANG leaves the record empty while the child runs.
    if info.si_pid == 0 {
        return Ok(None);
    }
    // The raw wait status `waitpid` would report for the same exit.
    let raw = match info.si_code {
        libc::CLD_EXITED => (info.si_status & 0xff) << 8,
        libc::CLD_KILLED => info.si_status & 0x7f,
        libc::CLD_DUMPED => (info.si_status & 0x7f) | 0x80,
        code => {
            return Err(io::Error::other(format!(
                "waitid reported unexpected child state {code} for PID {process_id}"
            )));
        }
    };
    Ok(Some(ExitStatus::from_raw(raw)))
}

#[cfg(test)]
mod tests {
    use std::process::Command;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::exit_status_retaining;

    fn retained(child: &std::process::Child) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = exit_status_retaining(child.id()).expect("peek child") {
                return status;
            }
            assert!(Instant::now() < deadline, "child did not exit");
            thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn reports_an_exit_without_reaping_the_child() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 7"])
            .spawn()
            .expect("spawn child");
        let status = retained(&child);
        assert_eq!(status.code(), Some(7));
        // Still unreaped: the pid stays reserved and reads again.
        assert_eq!(retained(&child).code(), Some(7));
        assert_eq!(child.wait().expect("reap child").code(), Some(7));
    }

    #[test]
    fn reports_nothing_while_running_and_the_signal_after_a_kill() {
        use std::os::unix::process::ExitStatusExt;

        let mut child = Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn child");
        assert!(exit_status_retaining(child.id()).expect("peek").is_none());
        child.kill().expect("kill child");
        assert_eq!(retained(&child).signal(), Some(9));
        assert_eq!(child.wait().expect("reap child").signal(), Some(9));
    }
}
