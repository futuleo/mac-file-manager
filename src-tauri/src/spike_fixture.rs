//! Exclusively owned scratch directories for the native spike examples
//! (`src-tauri/examples/*`) and unit tests. Not used by the application.
//!
//! Each fixture is created with `create_dir`, which fails if the path already
//! exists, so a run never writes into or deletes anything it did not create.
//! Cleanup removes only that run's directory and reports failures.

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug)]
pub struct Fixture {
    root: PathBuf,
    cleaned: bool,
}

impl Fixture {
    /// Creates a fresh, uniquely named directory directly under `base`.
    pub fn create_in(base: &Path, prefix: &str) -> io::Result<Self> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for attempt in 0..32u32 {
            let root = base.join(format!("{prefix}-{}-{nanos}-{attempt}", std::process::id()));
            match fs::create_dir(&root) {
                Ok(()) => {
                    return Ok(Self {
                        root,
                        cleaned: false,
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not create an unused fixture directory",
        ))
    }

    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Writes a new file; `name` must be a single plain file name and must not exist.
    pub fn write(&self, name: &str, contents: &str) -> io::Result<PathBuf> {
        self.write_bytes(name, contents.as_bytes())
    }

    /// Like `write`, for binary contents.
    pub fn write_bytes(&self, name: &str, contents: &[u8]) -> io::Result<PathBuf> {
        let mut parts = Path::new(name).components();
        match (parts.next(), parts.next()) {
            (Some(Component::Normal(_)), None) => {}
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "fixture file name must be a single path component",
                ));
            }
        }
        let path = self.root.join(name);
        use io::Write;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?
            .write_all(contents)?;
        Ok(path)
    }

    /// Removes this fixture's directory only. Errors are returned, not ignored.
    pub fn cleanup(mut self) -> io::Result<()> {
        self.cleaned = true;
        fs::remove_dir_all(&self.root)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if !self.cleaned {
            if let Err(e) = fs::remove_dir_all(&self.root) {
                eprintln!("failed to remove fixture {}: {e}", self.root.display());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_fixtures_and_preexisting_data_survive_cleanup() {
        let scratch = Fixture::create_in(&std::env::temp_dir(), "mfm-test").unwrap();
        let sentinel = scratch.write("sentinel.txt", "keep").unwrap();
        let shared_name = scratch.write("quicklook.txt", "pre-existing").unwrap();

        let a = Fixture::create_in(scratch.path(), "run").unwrap();
        let b = Fixture::create_in(scratch.path(), "run").unwrap();
        assert_ne!(a.path(), b.path());
        let b_file = b.write("quicklook.txt", "b").unwrap();

        a.cleanup().unwrap();
        assert_eq!(fs::read_to_string(&sentinel).unwrap(), "keep");
        assert_eq!(fs::read_to_string(&shared_name).unwrap(), "pre-existing");
        assert_eq!(fs::read_to_string(&b_file).unwrap(), "b");

        b.cleanup().unwrap();
        assert!(sentinel.exists());
        scratch.cleanup().unwrap();
    }

    #[test]
    fn writes_never_follow_existing_paths_or_escape_the_fixture() {
        let fixture = Fixture::create_in(&std::env::temp_dir(), "mfm-test").unwrap();
        fixture.write("a.txt", "1").unwrap();
        assert_eq!(
            fixture.write("a.txt", "2").unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert!(fixture.write("../escape.txt", "x").is_err());
        assert!(fixture.write("/abs.txt", "x").is_err());
        assert!(fixture.write("sub/a.txt", "x").is_err());
        fixture.cleanup().unwrap();
    }

    #[test]
    fn cleanup_failure_is_reported() {
        let fixture = Fixture::create_in(&std::env::temp_dir(), "mfm-test").unwrap();
        fs::remove_dir(fixture.path()).unwrap();
        assert!(fixture.cleanup().is_err());
    }
}
