//! Runs ONE command on a pseudo-terminal and bridges it to its parent, with the protocol of
//! server/pty/pty-host.mjs:
//!   argv:   <cols> <rows> <command> [args...]
//!   stdin:  newline-delimited JSON control frames (see frames.rs)
//!   stdout: the pty's bytes
//!   stderr: diagnostics only
//!   exit:   the child's exit code; 128 + the signal's number when a signal the host did not send ended it
//!
//! However the host ends, the command's whole process group goes with it.

mod frames;
mod input;
mod pty;

use frames::Frame;
use input::{InputQueue, LineSplitter, Pushed};
use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::ManuallyDrop;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

/// After the child exits, what is left in the pty is read until EOF, or until it has been quiet this long
/// (the rest of its process group is hung up first, so that EOF usually comes first)...
const EXIT_QUIET: Duration = Duration::from_millis(200);
/// ...and for at most this long once reads may go on: a re-attach waits for the host.
const EXIT_DRAIN_LIMIT: Duration = Duration::from_secs(2);
/// Output paused when the child exits is held for the parent this long: the server resumes or drops a
/// slow client within 10 s (OUTPUT_PAUSE_MAX_MS), and its kill unpauses.
const EXIT_PAUSED_LIMIT: Duration = Duration::from_secs(15);
const KILL_AFTER: Duration = Duration::from_secs(2);
const REAP_WAIT: Duration = Duration::from_secs(1);
const READ_CHUNK: usize = 64 * 1024;
/// The longest frame held: every input the server writes comes from one WebSocket message, which Bun
/// caps at 16 MiB by default and which escapes the text the way this frame does.
const MAX_FRAME_BYTES: usize = 17 * 1024 * 1024;
/// Input the command has not read yet, each frame counted with its FRAME_COST, past which more is dropped
/// (see InputQueue).
const MAX_QUEUED_INPUT_BYTES: usize = 16 * 1024 * 1024;
/// What the last read after a limit takes before the host ends.
const FINAL_READ_BYTES: usize = 16 * 1024 * 1024;

struct State {
    paused: bool,
    stopping: bool,
    /// the host hung up (SIGHUP) or killed (SIGKILL) a command still running: that signal ending it is the
    /// host's own end, not the command's; any other signal is the command's
    hup_sent: bool,
    kill_sent: bool,
    /// when the child exited (it is reaped only by `finish`)
    exit: Option<Instant>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
    /// the child's pid, and its process group's id; it is not reaped before `finish`, so neither is reused
    pid: libc::pid_t,
    wake: OwnedFd,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn notify(&self) {
        self.changed.notify_all();
        pty::wake(self.wake.as_raw_fd());
    }
}

/// The parent left or asked us to end: hang up the command's group, read on to EOF, and give it KILL_AFTER.
fn stop(shared: &Arc<Shared>) {
    {
        let mut state = shared.lock();
        if state.stopping {
            return;
        }
        state.stopping = true;
        state.paused = false;
        state.hup_sent = !pty::has_exited(shared.pid);
        pty::signal_group(shared.pid, libc::SIGHUP);
    }
    shared.notify();
    let shared = Arc::clone(shared);
    thread::spawn(move || {
        thread::sleep(KILL_AFTER);
        shared.lock().kill_sent |= !pty::has_exited(shared.pid);
        pty::signal_group(shared.pid, libc::SIGKILL);
        let mut state = shared.lock();
        let deadline = Instant::now() + REAP_WAIT;
        while state.exit.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = shared.changed.wait_timeout(state, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
        drop(state);
        finish(&shared, 0);
    });
}

/// The one way out once the command runs: kill what is left of its group, reap it, and exit with its code,
/// or with `unexited` when it never exited (a stop that outlasted SIGKILL, a failure before it ran on).
fn finish(shared: &Shared, unexited: i32) -> ! {
    static FINISHING: AtomicBool = AtomicBool::new(false);
    if FINISHING.swap(true, Ordering::SeqCst) {
        loop {
            thread::park();
        }
    }
    // a command the host ended itself (hung up by a stop, or killed then or just below) ends with 0 as before
    let (exited, sent) = {
        let mut state = shared.lock();
        state.kill_sent |= !pty::has_exited(shared.pid);
        let mut sent = Vec::new();
        if state.hup_sent {
            sent.push(libc::SIGHUP);
        }
        if state.kill_sent {
            sent.push(libc::SIGKILL);
        }
        (state.exit.is_some(), sent)
    };
    pty::signal_group(shared.pid, libc::SIGKILL);
    // an exit the waiter has not recorded yet is still the command's own code
    let code = pty::reap(shared.pid, !exited).map_or(unexited, |status| pty::exit_code(status, &sent));
    std::process::exit(code);
}

fn main() {
    let argv: Vec<OsString> = std::env::args_os().skip(1).collect();
    if argv.len() < 3 {
        eprintln!("pty-sidecar: usage: ovis-pty-sidecar <cols> <rows> <command> [args...]");
        std::process::exit(2);
    }
    let cols = frames::initial_size(&argv[0].to_string_lossy(), 80);
    let rows = frames::initial_size(&argv[1].to_string_lossy(), 24);

    // blocked before any thread starts, so only the signal thread takes them
    let stop_signals = unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::sigaddset(&mut set, libc::SIGHUP);
        libc::sigaddset(&mut set, libc::SIGQUIT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
        set
    };

    if let Err(error) = pty::default_sigchld() {
        eprintln!("pty-sidecar: {error}");
        std::process::exit(1);
    }
    let (wake_read, wake_write) = pty::wake_pipe().unwrap_or_else(|error| {
        eprintln!("pty-sidecar: {error}");
        std::process::exit(1);
    });
    // on the main thread, which lives until `finish`: Linux's PR_SET_PDEATHSIG follows the thread that forked
    let (master, pid) = match pty::spawn(&argv[2], &argv[3..], cols, rows) {
        Ok(started) => started,
        Err(error) => {
            eprintln!("pty-sidecar: {}: {error}", String::from_utf8_lossy(argv[2].as_bytes()));
            std::process::exit(1);
        }
    };
    let shared = Arc::new(Shared {
        state: Mutex::new(State { paused: false, stopping: false, hup_sent: false, kill_sent: false, exit: None }),
        changed: Condvar::new(),
        pid,
        wake: wake_write,
    });
    if let Err(error) = pty::kill_group_on_crash(pid) {
        eprintln!("pty-sidecar: {error}");
        finish(&shared, 1);
    }
    let writer = match master.try_clone() {
        Ok(writer) => writer,
        Err(error) => {
            eprintln!("pty-sidecar: {error}");
            finish(&shared, 1);
        }
    };

    {
        let shared = Arc::clone(&shared);
        thread::spawn(move || {
            if let Err(error) = pty::wait_exited(shared.pid) {
                eprintln!("pty-sidecar: waiting for the command: {error}");
            }
            // the rest of its group goes with it, and their ends close the pty
            pty::signal_group(shared.pid, libc::SIGHUP);
            shared.lock().exit = Some(Instant::now());
            shared.notify();
        });
    }
    {
        let shared = Arc::clone(&shared);
        thread::spawn(move || loop {
            let mut signal = 0;
            if unsafe { libc::sigwait(&stop_signals, &mut signal) } == 0 {
                stop(&shared);
            }
        });
    }
    let input = Arc::new(InputQueue::new(MAX_QUEUED_INPUT_BYTES));
    {
        let input = Arc::clone(&input);
        thread::spawn(move || write_input(writer, &input));
    }
    {
        let shared = Arc::clone(&shared);
        let master = master.as_raw_fd();
        thread::spawn(move || control(&shared, &input, master));
    }

    pump(&shared, master.as_raw_fd(), wake_read.as_raw_fd());
    finish(&shared, 0);
}

/// Input goes through its own thread: a command that does not read must never hold up the control frames.
fn write_input(master: OwnedFd, input: &InputQueue) {
    let mut master = File::from(master);
    loop {
        let data = input.next();
        // a pty whose command has gone refuses it (EIO): the pump ends the host then
        let _ = master.write_all(&data);
        input.written(data);
    }
}

fn control(shared: &Arc<Shared>, input: &InputQueue, master: RawFd) {
    let mut stdin = io::stdin().lock();
    let mut buf = vec![0u8; READ_CHUNK];
    let mut lines = LineSplitter::new(MAX_FRAME_BYTES);
    loop {
        let read = match stdin.read(&mut buf) {
            Ok(0) => break,
            Ok(read) => read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        let discarded = lines.feed(&buf[..read], |line| {
            let text = String::from_utf8_lossy(line);
            let Some(frame) = frames::parse(text.trim()) else { return };
            match frame {
                Frame::Input(text) => match input.push(text.into_bytes()) {
                    Pushed::Queued | Pushed::Empty | Pushed::Dropped => {}
                    Pushed::Overflowed => {
                        eprintln!("pty-sidecar: the command is not reading its input: {MAX_QUEUED_INPUT_BYTES} bytes wait, dropping input until it takes some");
                    }
                }
                Frame::Resize(cols, rows) => {
                    if let Err(error) = pty::resize(master, cols, rows) {
                        eprintln!("pty-sidecar: {error}");
                    }
                }
                Frame::Winch => pty::signal(shared.pid, libc::SIGWINCH),
                Frame::Pause(paused) => {
                    let mut state = shared.lock();
                    if !state.stopping {
                        state.paused = paused;
                        drop(state);
                        shared.changed.notify_all();
                    }
                }
            }
        });
        if discarded > 0 {
            eprintln!("pty-sidecar: discarded a control frame longer than {MAX_FRAME_BYTES} bytes");
        }
    }
    // a last line without its newline is not a frame (pty-host.mjs drops it too)
    stop(shared);
}

enum Gate {
    /// how long to wait for output: None until the child exits
    Read(Option<Duration>),
    Finish,
}

struct Drain {
    /// when output last moved
    active: Instant,
    /// when reads last resumed after the child exited
    resumed: Option<Instant>,
}

/// Holds reads while the parent has output paused (input stays live meanwhile), and ends them once the
/// exited child's output is done.
fn gate(shared: &Shared, drain: &mut Drain) -> Gate {
    let mut state = shared.lock();
    let mut held = false;
    loop {
        let paused = state.paused && !state.stopping;
        let now = Instant::now();
        let Some(exited) = state.exit else {
            if !paused {
                return Gate::Read(None);
            }
            held = true;
            state = shared.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
            continue;
        };
        if paused {
            let limit = exited + EXIT_PAUSED_LIMIT;
            if now >= limit {
                return Gate::Finish;
            }
            held = true;
            state = shared.changed.wait_timeout(state, limit - now).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
            continue;
        }
        if held {
            drain.resumed = Some(now);
        }
        let since = drain.resumed.map_or(exited, |resumed| resumed.max(exited));
        let end = (drain.active.max(since) + EXIT_QUIET).min(since + EXIT_DRAIN_LIMIT);
        if now >= end {
            return Gate::Finish;
        }
        return Gate::Read(Some(end - now));
    }
}

/// Copies the pty to stdout until it ends, then waits for the child's exit. A blocking write to stdout
/// holds the reads, so a parent that stops reading stops the pty too.
fn pump(shared: &Arc<Shared>, master: RawFd, wake: RawFd) {
    let mut stdout = ManuallyDrop::new(unsafe { File::from_raw_fd(1) });
    let mut buf = vec![0u8; READ_CHUNK];
    let mut discard = false;
    let mut drain = Drain { active: Instant::now(), resumed: None };
    let mut copy = |data: &[u8], discard: &mut bool| {
        if !*discard && stdout.write_all(data).is_err() {
            // the parent is gone (EPIPE): end the child, and keep reading so it never blocks on output
            *discard = true;
            stop(shared);
        }
    };
    loop {
        let wait = match gate(shared, &mut drain) {
            Gate::Finish => {
                // what is already there when a limit ends the reads still goes out
                let mut taken = 0;
                while taken < FINAL_READ_BYTES {
                    match pty::wait_readable(master, wake, Some(Duration::ZERO)) {
                        Ok(Some(ready)) if ready.master => {}
                        _ => break,
                    }
                    match pty::read(master, &mut buf) {
                        Ok(read) if read > 0 => {
                            copy(&buf[..read], &mut discard);
                            taken += read;
                        }
                        _ => break,
                    }
                }
                if taken >= FINAL_READ_BYTES {
                    eprintln!("pty-sidecar: output went on after the command exited: the last {FINAL_READ_BYTES} bytes were read, the rest is dropped");
                }
                break;
            }
            Gate::Read(wait) => wait,
        };
        let ready = match pty::wait_readable(master, wake, wait) {
            Ok(Some(ready)) => ready,
            Ok(None) => continue,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        if ready.wake {
            pty::drain(wake);
        }
        if !ready.master {
            continue;
        }
        // a pause taken while waiting holds what arrived after it
        {
            let state = shared.lock();
            if state.paused && !state.stopping {
                continue;
            }
        }
        match pty::read(master, &mut buf) {
            Ok(0) => break,
            Ok(read) => {
                copy(&buf[..read], &mut discard);
                // time spent blocked on stdout is not the pty being quiet
                drain.active = Instant::now();
            }
            Err(error) if matches!(error.kind(), io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock) => continue,
            // EIO: every slave descriptor is closed
            Err(_) => break,
        }
    }
    // a command dying closes its terminal before it can be waited for: its end is its own unless it is
    // still running after EXIT_QUIET, when it has closed its terminal without exiting
    {
        let mut state = shared.lock();
        let deadline = Instant::now() + EXIT_QUIET;
        while state.exit.is_none() {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = shared.changed.wait_timeout(state, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
    }
    // a command that closed its terminal without exiting ends as a stopped one does
    stop(shared);
    let mut state = shared.lock();
    while state.exit.is_none() {
        state = shared.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}
