//! The program in a PTY with no core running and a fake `hc` on `PATH` that records any call: it
//! starts no core (a core started from it would inherit its environment and hand it to every
//! agent), says how to start one, and leaves.
#![cfg(unix)]

#[path = "../upstream/crates/hc-tui/tests/common/pty.rs"]
mod pty;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use hc_vt::Vt;
use pty::{POLL, Pty, screen};

const DEADLINE: Duration = Duration::from_secs(15);

fn scratch() -> PathBuf {
    // short: the core's socket path under it must fit the system's limit of about 107 bytes
    let root = std::env::temp_dir().join(format!("nc{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    for dir in ["home", "state", "config", "runtime", "bin", "work"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    root
}

/// The hosted program, killed when the test ends however it ends: a failed assertion must not
/// leave it running.
struct Hosted(Pty);

impl Drop for Hosted {
    fn drop(&mut self) {
        let _ = self.0.child.kill();
        let _ = self.0.child.wait();
    }
}

fn until_screen(pty: &Pty, vt: &mut Vt, words: &str) {
    let deadline = Instant::now() + DEADLINE;
    loop {
        pty.pump(vt);
        let text = screen(vt);
        if text.contains(words) {
            return;
        }
        assert!(Instant::now() < deadline, "no {words:?} on screen:\n{text}");
        std::thread::sleep(POLL);
    }
}

#[test]
fn with_no_core_running_it_starts_none_and_says_how() {
    let root = scratch();
    let record = root.join("hc.record");
    let hc = root.join("bin").join("hc");
    fs::write(
        &hc,
        format!(
            "#!/bin/sh\nprintf 'hc %s token=%s\\n' \"$*\" \"${{OVIS_TOKEN-unset}}\" >> \"{}\"\n",
            record.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&hc, fs::Permissions::from_mode(0o755)).unwrap();
    let path = |dir: &str| root.join(dir).display().to_string();
    let env: Vec<(String, String)> = [
        ("PATH", format!("{}:/usr/bin:/bin", path("bin"))),
        ("TERM", "xterm-256color".into()),
        ("HOME", path("home")),
        ("XDG_STATE_HOME", path("state")),
        ("XDG_CONFIG_HOME", path("config")),
        ("XDG_RUNTIME_DIR", path("runtime")),
        ("HC_SESSION", "scratch".into()),
        ("OVIS_TOKEN", "t0ken-for-this-test".into()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let mut hosted = Hosted(Pty::spawn(
        Path::new(env!("CARGO_BIN_EXE_ovis-tui")),
        &[],
        &env,
        &root.join("work"),
        120,
        24,
    ));
    let pty = &mut hosted.0;
    let mut vt = Vt::new(120, 24, 1000);
    until_screen(pty, &mut vt, "HC_SESSION=scratch hc server start");
    let deadline = Instant::now() + DEADLINE;
    let status = loop {
        pty.pump(&mut vt);
        if let Some(status) = pty.child.try_wait().expect("try_wait") {
            break status;
        }
        assert!(Instant::now() < deadline, "the program did not exit");
        std::thread::sleep(POLL);
    };
    assert!(!status.success());
    assert!(
        !record.exists(),
        "hc was run: {}",
        fs::read_to_string(&record).unwrap_or_default()
    );
    let _ = fs::remove_dir_all(&root);
}
