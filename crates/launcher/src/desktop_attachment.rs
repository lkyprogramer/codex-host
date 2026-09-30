#[cfg(target_os = "windows")]
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use codexhost_platform::{
    DesktopInstallation, descendant_executable_exists, desktop_root_process_ids_for_installation,
};
#[cfg(target_os = "windows")]
use codexhost_platform::{process_executable_path, process_exists, terminate_process_by_id};

use crate::ResolvedLaunchOptions;
use crate::runtime_instance::{
    LauncherGuard, RuntimeDescriptor, RuntimeDescriptorGuard, default_descriptor_path,
    default_guard_path, random_nonce, read_descriptor, remove_matching_descriptor,
    try_acquire_launcher_guard,
};

#[derive(Debug)]
pub(super) struct RuntimeControl {
    pub(super) renderer_cdp_endpoint: String,
    pub(super) renderer_cdp_arguments: [OsString; 2],
    pub(super) attachment_port: u16,
    pub(super) nonce: String,
}

pub(super) fn allocate_runtime_control() -> Result<RuntimeControl, Box<dyn Error>> {
    let renderer_cdp = TcpListener::bind(("127.0.0.1", 0))?;
    let attachment = TcpListener::bind(("127.0.0.1", 0))?;
    let renderer_cdp_port = renderer_cdp.local_addr()?.port();
    let attachment_port = attachment.local_addr()?.port();
    drop(attachment);
    drop(renderer_cdp);
    Ok(RuntimeControl {
        renderer_cdp_endpoint: format!("http://127.0.0.1:{renderer_cdp_port}"),
        renderer_cdp_arguments: [
            OsString::from("--remote-debugging-address=127.0.0.1"),
            OsString::from(format!("--remote-debugging-port={renderer_cdp_port}")),
        ],
        attachment_port,
        nonce: random_nonce()?,
    })
}

pub(super) enum LauncherOwnership {
    Acquired(LauncherGuard),
    Attached,
}

pub(super) fn acquire_launcher_ownership(
    installation: &DesktopInstallation,
    timeout: Duration,
) -> Result<LauncherOwnership, Box<dyn Error>> {
    let guard_path = default_guard_path()?;
    if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
        return Ok(LauncherOwnership::Acquired(guard));
    }

    let descriptor_path = default_descriptor_path()?;
    let started = Instant::now();
    let mut retry_delay = Duration::from_millis(100);
    while started.elapsed() < timeout {
        let descriptor = read_descriptor(&descriptor_path).ok().flatten();
        if let Some(descriptor) = &descriptor {
            if try_activate_controlled_instance_with_timeout(
                descriptor,
                timeout.saturating_sub(started.elapsed()),
            )? {
                return Ok(LauncherOwnership::Attached);
            }
            if started.elapsed() >= timeout {
                break;
            }
            if desktop_root_process_ids_for_installation(installation)?.is_empty()
                && !endpoint_ready(
                    descriptor.control_port,
                    timeout
                        .saturating_sub(started.elapsed())
                        .min(Duration::from_millis(100)),
                )
            {
                stop_stale_launcher(descriptor)?;
                let _ = remove_matching_descriptor(&descriptor_path, descriptor)?;
            }
        }
        if let Some(guard) = try_acquire_launcher_guard(&guard_path)? {
            return Ok(LauncherOwnership::Acquired(guard));
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        thread::sleep(retry_delay.min(remaining));
        retry_delay = next_retry_delay(retry_delay);
    }
    Err("another codexhost Launcher did not become attachable before timeout".into())
}

pub(super) fn endpoint_ready(port: u16, timeout: Duration) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .expect("valid loopback socket address"),
        timeout,
    )
    .is_ok()
}

pub(super) fn wait_for_host_chain(
    desktop_pid: u32,
    options: &ResolvedLaunchOptions,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if descendant_executable_exists(desktop_pid, &options.shim)?
            && descendant_executable_exists(desktop_pid, &options.node)?
        {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(100));
    }
    Ok(false)
}

pub(super) fn publish_runtime_descriptor(
    descriptor_path: &Path,
    control: &RuntimeControl,
) -> Result<RuntimeDescriptorGuard, Box<dyn Error>> {
    let descriptor = RuntimeDescriptor::new(
        std::process::id(),
        control.attachment_port,
        control.nonce.clone(),
    )?;
    Ok(RuntimeDescriptorGuard::publish(
        descriptor_path.to_path_buf(),
        descriptor,
    )?)
}

fn connect_controlled_instance(
    descriptor: &RuntimeDescriptor,
    timeout: Duration,
) -> std::io::Result<TcpStream> {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{}", descriptor.control_port)
            .parse()
            .expect("valid loopback socket address"),
        timeout.min(Duration::from_secs(2)),
    )
}

fn send_controlled_attachment(
    mut stream: TcpStream,
    descriptor: &RuntimeDescriptor,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    let started = Instant::now();
    stream.set_write_timeout(Some(timeout.min(Duration::from_secs(2))))?;
    if let Err(error) = writeln!(stream, "ATTACH {}", descriptor.nonce) {
        return if transient_socket_error(&error) {
            Ok(false)
        } else {
            Err(error.into())
        };
    }
    // Read the short protocol line against one deadline. A timeout on each fragment
    // would let a slow peer extend the launch deadline indefinitely.
    stream.set_nonblocking(true)?;
    let read_deadline = timeout.min(Duration::from_secs(10));
    let read_started = Instant::now();
    let mut response = [0_u8; 16];
    let mut length = 0;
    loop {
        let remaining = timeout
            .saturating_sub(started.elapsed())
            .min(read_deadline.saturating_sub(read_started.elapsed()));
        if remaining.is_zero() {
            return Ok(false);
        }
        match stream.read(&mut response[length..length + 1]) {
            Ok(0) => return Ok(false),
            Ok(_) => {
                length += 1;
                if started.elapsed() >= timeout {
                    return Ok(false);
                }
                if response[length - 1] == b'\n' {
                    break;
                }
                if length == response.len() {
                    return Err("Desktop Controller sent an invalid attachment response".into());
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                thread::sleep(remaining.min(Duration::from_millis(5)));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) if transient_socket_error(&error) => return Ok(false),
            Err(error) => return Err(error.into()),
        }
    }
    match &response[..length] {
        b"ready\n" | b"ready\r\n" => Ok(true),
        b"busy\n" | b"busy\r\n" => Ok(false),
        b"rejected\n" | b"rejected\r\n" => {
            Err("Desktop Controller rejected the attachment nonce".into())
        }
        b"failed\n" | b"failed\r\n" => {
            Err("Desktop Controller could not restore the running Desktop".into())
        }
        _ => Err("Desktop Controller sent an invalid attachment response".into()),
    }
}

fn next_retry_delay(delay: Duration) -> Duration {
    (delay * 2).min(Duration::from_secs(1))
}

fn transient_socket_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::ConnectionRefused
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::NotConnected
            | io::ErrorKind::TimedOut
            | io::ErrorKind::WouldBlock
            | io::ErrorKind::Interrupted
            | io::ErrorKind::UnexpectedEof
    )
}

pub(super) fn try_activate_controlled_instance_with_timeout(
    descriptor: &RuntimeDescriptor,
    timeout: Duration,
) -> Result<bool, Box<dyn Error>> {
    if timeout.is_zero() {
        return Ok(false);
    }
    let started = Instant::now();
    let stream = match connect_controlled_instance(descriptor, timeout) {
        Ok(stream) => stream,
        Err(error) if transient_socket_error(&error) => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    let remaining = timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Ok(false);
    }
    send_controlled_attachment(stream, descriptor, remaining)
}

#[cfg(test)]
pub(super) fn try_activate_controlled_instance(
    descriptor: &RuntimeDescriptor,
) -> Result<bool, Box<dyn Error>> {
    try_activate_controlled_instance_with_timeout(descriptor, Duration::from_secs(12))
}

#[cfg(test)]
mod tests {
    use super::{next_retry_delay, transient_socket_error};
    use std::io;
    use std::time::Duration;

    #[test]
    fn retry_delay_doubles_and_caps_at_one_second() {
        let delays = [100, 200, 400, 800, 1_000, 1_000];
        let mut delay = Duration::from_millis(delays[0]);
        for expected in delays.into_iter().skip(1) {
            delay = next_retry_delay(delay);
            assert_eq!(delay, Duration::from_millis(expected));
        }
    }

    #[test]
    fn permission_failure_is_not_a_transient_socket_error() {
        assert!(!transient_socket_error(&io::Error::from(
            io::ErrorKind::PermissionDenied
        )));
        assert!(transient_socket_error(&io::Error::from(
            io::ErrorKind::TimedOut
        )));
    }
}

#[cfg(target_os = "windows")]
pub(super) fn stop_stale_launcher(descriptor: &RuntimeDescriptor) -> Result<(), Box<dyn Error>> {
    if descriptor.launcher_pid == std::process::id() || !process_exists(descriptor.launcher_pid) {
        return Ok(());
    }
    let expected = env::current_exe()?.canonicalize()?;
    let actual = process_executable_path(descriptor.launcher_pid)?.canonicalize()?;
    if actual != expected {
        return Ok(());
    }
    terminate_process_by_id(descriptor.launcher_pid)?;
    let started = Instant::now();
    while process_exists(descriptor.launcher_pid) && started.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(20));
    }
    if process_exists(descriptor.launcher_pid) {
        return Err(format!(
            "stale codexhost launcher PID {} did not exit before timeout",
            descriptor.launcher_pid
        )
        .into());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub(super) fn stop_stale_launcher(_descriptor: &RuntimeDescriptor) -> Result<(), Box<dyn Error>> {
    Ok(())
}
