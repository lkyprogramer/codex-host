use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

fn c_path(path: &Path) -> io::Result<CString> {
    CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains a NUL byte"))
}

/// Atomically exchanges two existing entries on one volume: at no moment is
/// either path missing, so a crash leaves each holding one complete version.
pub(crate) fn exchange_paths(left: &Path, right: &Path) -> io::Result<()> {
    let left = c_path(left)?;
    let right = c_path(right)?;
    // SAFETY: both arguments are NUL-terminated paths that outlive the call.
    let result = unsafe { libc::renamex_np(left.as_ptr(), right.as_ptr(), libc::RENAME_SWAP) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::exchange_paths;

    #[test]
    fn exchanges_two_directories_in_place() {
        let root = std::env::temp_dir().join(format!("codexhost-exchange-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (left, right) = (root.join("left"), root.join("right"));
        std::fs::create_dir_all(&left).unwrap();
        std::fs::create_dir_all(&right).unwrap();
        std::fs::write(left.join("version"), "old").unwrap();
        std::fs::write(right.join("version"), "new").unwrap();

        exchange_paths(&right, &left).unwrap();

        assert_eq!(
            std::fs::read_to_string(left.join("version")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(right.join("version")).unwrap(),
            "old"
        );
        assert!(exchange_paths(&left, &root.join("missing")).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
