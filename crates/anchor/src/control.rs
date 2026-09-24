//! Line-delimited JSON on fd 3, the only channel between Host and anchor.

use std::io::{ErrorKind, Read, Write};
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use serde_json::Value;

/// Longest grace a Host may ask for; anything above is clamped.
const MAX_GRACE: Duration = Duration::from_secs(600);
/// A command line longer than this is discarded rather than buffered forever.
const MAX_LINE_BYTES: usize = 64 * 1024;

pub enum Command {
    Terminate { grace: Duration },
}

pub enum Received {
    Commands(Vec<Command>),
    /// The Host closed its end or died: the lifeline is gone.
    Closed,
}

pub struct Control {
    stream: UnixStream,
    pending: Vec<u8>,
}

impl Control {
    pub fn new(fd: OwnedFd) -> Self {
        Self {
            stream: UnixStream::from(fd),
            pending: Vec::new(),
        }
    }

    pub fn fd(&self) -> BorrowedFd<'_> {
        self.stream.as_fd()
    }

    /// Reads what is available after poll reported the descriptor readable.
    pub fn receive(&mut self) -> Received {
        let mut buffer = [0_u8; 4096];
        match self.stream.read(&mut buffer) {
            Ok(0) => Received::Closed,
            Ok(read) => {
                self.pending.extend_from_slice(&buffer[..read]);
                Received::Commands(self.drain_lines())
            }
            Err(error)
                if matches!(error.kind(), ErrorKind::Interrupted | ErrorKind::WouldBlock) =>
            {
                Received::Commands(Vec::new())
            }
            Err(_) => Received::Closed,
        }
    }

    /// Best effort: a Host that stopped reading has nothing left to learn.
    pub fn send(&mut self, message: &Value) {
        let mut line = message.to_string();
        line.push('\n');
        let _ = self.stream.write_all(line.as_bytes());
    }

    fn drain_lines(&mut self) -> Vec<Command> {
        let mut commands = Vec::new();
        while let Some(end) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=end).collect();
            if let Some(command) = parse_command(&line[..line.len() - 1]) {
                commands.push(command);
            }
        }
        if self.pending.len() > MAX_LINE_BYTES {
            self.pending.clear();
        }
        commands
    }
}

fn parse_command(line: &[u8]) -> Option<Command> {
    let value: Value = serde_json::from_slice(line).ok()?;
    match value.get("op")?.as_str()? {
        "terminate" => {
            let grace = value
                .get("graceMs")
                .and_then(Value::as_u64)
                .map(Duration::from_millis)
                .unwrap_or(Duration::ZERO)
                .min(MAX_GRACE);
            Some(Command::Terminate { grace })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_terminate_and_clamps_grace() {
        let Some(Command::Terminate { grace }) =
            parse_command(br#"{"op":"terminate","graceMs":250}"#)
        else {
            panic!("terminate was not parsed");
        };
        assert_eq!(grace, Duration::from_millis(250));
        let Some(Command::Terminate { grace }) =
            parse_command(br#"{"op":"terminate","graceMs":99999999}"#)
        else {
            panic!("terminate was not parsed");
        };
        assert_eq!(grace, MAX_GRACE);
    }

    #[test]
    fn ignores_unknown_and_malformed_lines() {
        assert!(parse_command(br#"{"op":"reboot"}"#).is_none());
        assert!(parse_command(b"not json").is_none());
        assert!(parse_command(br#"{"graceMs":1}"#).is_none());
    }

    #[test]
    fn splits_commands_across_reads() {
        let (left, right) = UnixStream::pair().unwrap();
        let mut control = Control::new(OwnedFd::from(left));
        let mut host = right;
        host.write_all(br#"{"op":"terminate","graceMs":1}"#)
            .unwrap();
        assert!(matches!(control.receive(), Received::Commands(commands) if commands.is_empty()));
        host.write_all(b"\n{\"op\":\"terminate\"}\n").unwrap();
        assert!(matches!(control.receive(), Received::Commands(commands) if commands.len() == 2));
        drop(host);
        assert!(matches!(control.receive(), Received::Closed));
    }
}
