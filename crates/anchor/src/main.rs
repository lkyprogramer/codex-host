//! Native owner of exactly one Harness process group.
//!
//! The Host starts every Harness through this anchor. The anchor creates the
//! Harness in its own process group and never reaps the Harness leader while
//! any member of that group is still alive, so the group id cannot be handed
//! to another process. The Host reaches it through fd 3 only; that descriptor
//! is also the lifeline, and its end means the Host is gone.

#![deny(unsafe_op_in_unsafe_fn)]

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod anchor;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod control;
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod group;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn main() {
    anchor::run(std::env::args_os().skip(1).collect());
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn main() -> std::process::ExitCode {
    eprintln!("codexhost-anchor is only supported on macOS and Linux");
    std::process::ExitCode::from(2)
}
