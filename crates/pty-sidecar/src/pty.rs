use std::ffi::{OsStr, OsString};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

fn check(rc: libc::c_int) -> io::Result<libc::c_int> {
    if rc == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
}

/// node-pty 1.1.0's termios (src/unix/pty.cc), so a program sees the same line discipline under either host.
fn termios() -> libc::termios {
    let mut term: libc::termios = unsafe { std::mem::zeroed() };
    term.c_iflag = libc::ICRNL | libc::IXON | libc::IXANY | libc::IMAXBEL | libc::BRKINT | libc::IUTF8;
    term.c_oflag = libc::OPOST | libc::ONLCR;
    term.c_cflag = libc::CREAD | libc::CS8 | libc::HUPCL;
    term.c_lflag = libc::ICANON | libc::ISIG | libc::IEXTEN | libc::ECHO | libc::ECHOE | libc::ECHOK | libc::ECHOKE | libc::ECHOCTL;
    let cc = &mut term.c_cc;
    cc[libc::VEOF] = 4;
    // node-pty assigns -1 to an unsigned cc_t
    cc[libc::VEOL] = 0xff;
    cc[libc::VEOL2] = 0xff;
    cc[libc::VERASE] = 0x7f;
    cc[libc::VWERASE] = 23;
    cc[libc::VKILL] = 21;
    cc[libc::VREPRINT] = 18;
    cc[libc::VINTR] = 3;
    cc[libc::VQUIT] = 0x1c;
    cc[libc::VSUSP] = 26;
    cc[libc::VSTART] = 17;
    cc[libc::VSTOP] = 19;
    cc[libc::VLNEXT] = 22;
    cc[libc::VDISCARD] = 15;
    cc[libc::VMIN] = 1;
    cc[libc::VTIME] = 0;
    #[cfg(target_os = "macos")]
    {
        cc[libc::VDSUSP] = 25;
        cc[libc::VSTATUS] = 20;
    }
    unsafe {
        libc::cfsetispeed(&mut term, libc::B38400);
        libc::cfsetospeed(&mut term, libc::B38400);
    }
    term
}

fn set_flags(fd: &OwnedFd, nonblocking: bool) -> io::Result<()> {
    let fd = fd.as_raw_fd();
    let flags = check(unsafe { libc::fcntl(fd, libc::F_GETFD) })?;
    check(unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) })?;
    if nonblocking {
        let status = check(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
        check(unsafe { libc::fcntl(fd, libc::F_SETFL, status | libc::O_NONBLOCK) })?;
    }
    Ok(())
}

/// pty-host.mjs runs the command in `HOME`, or `/` without one; node-pty takes an empty one as its own cwd.
fn working_directory() -> io::Result<PathBuf> {
    match std::env::var_os("HOME") {
        None => Ok(PathBuf::from("/")),
        Some(home) if home.is_empty() => std::env::current_dir(),
        Some(home) => Ok(PathBuf::from(home)),
    }
}

/// This process's environment as pty-host.mjs and node-pty hand it on: no bridge token under either name,
/// `TERM=xterm-256color`, `PWD` the working directory.
fn environment(cwd: &OsStr) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os()
        .filter(|(key, _)| key != "OVIS_TOKEN" && key != "HERDR_WEB_TOKEN" && key != "TERM" && key != "PWD")
        .collect();
    env.push(("PWD".into(), cwd.to_owned()));
    env.push(("TERM".into(), "xterm-256color".into()));
    env
}

/// Starts `command` as the session leader of a new pty, its controlling terminal: the master and the child's pid.
pub fn spawn(command: &OsStr, args: &[OsString], cols: u16, rows: u16) -> io::Result<(OwnedFd, libc::pid_t)> {
    let (mut master, mut slave): (RawFd, RawFd) = (-1, -1);
    let mut term = termios();
    let mut size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    // *mut: macOS declares both mutable, Linux const
    check(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), &raw mut term, &raw mut size) })?;
    let master = unsafe { OwnedFd::from_raw_fd(master) };
    let slave = unsafe { OwnedFd::from_raw_fd(slave) };
    set_flags(&master, false)?;
    set_flags(&slave, false)?;

    let cwd = working_directory()?;
    #[cfg(target_os = "linux")]
    let host = std::process::id() as libc::pid_t;
    let mut cmd = Command::new(command);
    cmd.args(args)
        .env_clear()
        .envs(environment(cwd.as_os_str()))
        .current_dir(&cwd)
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave.try_clone()?));
    unsafe {
        // runs in the child after std has put the slave on 0, 1 and 2, and before exec
        cmd.pre_exec(move || {
            check(libc::setsid())?;
            check(libc::ioctl(0, libc::TIOCSCTTY as _, 0))?;
            let mut none: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut none);
            libc::pthread_sigmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
            // a host killed outright (SIGKILL, the OOM killer) takes the command with it
            #[cfg(target_os = "linux")]
            {
                check(libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL))?;
                if libc::getppid() != host {
                    return Err(io::Error::other("the PTY host exited"));
                }
            }
            Ok(())
        });
    }
    let child = cmd.spawn()?;
    drop(cmd);
    drop(slave);
    Ok((master, child.id() as libc::pid_t))
}

pub fn resize(master: RawFd, cols: u16, rows: u16) -> io::Result<()> {
    let size = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    check(unsafe { libc::ioctl(master, libc::TIOCSWINSZ as _, &size) }).map(drop)
}

pub fn wake_pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds: [RawFd; 2] = [-1, -1];
    check(unsafe { libc::pipe(fds.as_mut_ptr()) })?;
    let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    set_flags(&read, true)?;
    set_flags(&write, true)?;
    Ok((read, write))
}

pub struct Ready {
    pub master: bool,
    pub wake: bool,
}

/// Waits until the master or the wake pipe can be read, or `timeout` passes (None).
/// select, not poll: macOS's poll does not support terminal devices.
pub fn wait_readable(master: RawFd, wake: RawFd, timeout: Option<Duration>) -> io::Result<Option<Ready>> {
    if master.max(wake) >= libc::FD_SETSIZE as RawFd {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "descriptor above FD_SETSIZE"));
    }
    unsafe {
        let mut set: libc::fd_set = std::mem::zeroed();
        libc::FD_ZERO(&mut set);
        libc::FD_SET(master, &mut set);
        libc::FD_SET(wake, &mut set);
        let mut limit = timeout.map(|left| libc::timeval { tv_sec: left.as_secs() as _, tv_usec: left.subsec_micros() as _ });
        let limit = limit.as_mut().map_or(std::ptr::null_mut(), |limit| limit as *mut libc::timeval);
        let ready = check(libc::select(master.max(wake) + 1, &mut set, std::ptr::null_mut(), std::ptr::null_mut(), limit))?;
        if ready == 0 {
            return Ok(None);
        }
        Ok(Some(Ready { master: libc::FD_ISSET(master, &set), wake: libc::FD_ISSET(wake, &set) }))
    }
}

pub fn read(fd: RawFd, buf: &mut [u8]) -> io::Result<usize> {
    let read = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
    if read < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(read as usize)
    }
}

pub fn drain(fd: RawFd) {
    let mut buf = [0u8; 64];
    while unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
}

pub fn wake(fd: RawFd) {
    let byte = 1u8;
    unsafe { libc::write(fd, (&byte as *const u8).cast(), 1) };
}

/// Blocks until the child has exited, without reaping it, so that its pid (also its process group's id)
/// cannot be reused before `reap`. SIGCHLD must not be ignored (`default_sigchld`), or the kernel reaps it.
pub fn wait_exited(pid: libc::pid_t) -> io::Result<()> {
    loop {
        // SAFETY: an all-zero siginfo_t is valid, and waitid writes only into it
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// Whether the child has exited, without waiting for it or reaping it.
pub fn has_exited(pid: libc::pid_t) -> bool {
    // SAFETY: an all-zero siginfo_t is valid, and waitid writes only into it
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) };
    // with WNOHANG a child still running leaves si_pid 0
    // SAFETY: waitid filled `info` (or left it zeroed)
    rc == 0 && unsafe { info.si_pid() } != 0
}

/// SIGCHLD back to its default: an ignored one, which survives exec, would have the kernel reap the child.
pub fn default_sigchld() -> io::Result<()> {
    // SAFETY: an all-zero sigaction with SIG_DFL is valid
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = libc::SIG_DFL;
        libc::sigemptyset(&mut action.sa_mask);
        check(libc::sigaction(libc::SIGCHLD, &action, std::ptr::null_mut())).map(drop)
    }
}

/// Reaps the child, waiting for it unless `nohang`: its wait status (see `exit_code`), or None when it
/// has not exited.
pub fn reap(pid: libc::pid_t, nohang: bool) -> Option<libc::c_int> {
    let mut status = 0;
    loop {
        let rc = unsafe { libc::waitpid(pid, &mut status, if nohang { libc::WNOHANG } else { 0 }) };
        if rc == pid {
            break;
        }
        if rc == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
            continue;
        }
        return if rc == 0 { None } else { Some(0) };
    }
    Some(status)
}

/// A wait status as the host's exit code: the child's own code, or 128 + the signal's number when a
/// signal ended it (as a shell reports it, and pty-host.mjs), never the 0 a caller reads as success.
/// One of the signals the host sent the running child itself (`sent`) is the host's own end: 0, as before.
pub fn exit_code(status: libc::c_int, sent: &[libc::c_int]) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) && !sent.contains(&libc::WTERMSIG(status)) {
        128 + libc::WTERMSIG(status)
    } else {
        0
    }
}

pub fn signal(pid: libc::pid_t, signal: libc::c_int) {
    unsafe { libc::kill(pid, signal) };
}

/// Signals every process in the group `group`, the child's: it is a session leader, so its pid is the group's id.
/// Never 0 or 1: kill(0) and kill(-1) would reach this host's own group (the server's) or every process.
pub fn signal_group(group: libc::pid_t, signal: libc::c_int) {
    if group > 1 {
        unsafe { libc::kill(-group, signal) };
    }
}

static GROUP: AtomicI32 = AtomicI32::new(0);

extern "C" fn kill_group(signal: libc::c_int) {
    let group = GROUP.load(Ordering::Relaxed);
    // SAFETY: kill and raise are async-signal-safe
    unsafe {
        if group > 1 {
            libc::kill(-group, libc::SIGKILL);
        }
        // SA_RESETHAND restored the default action: once this returns, it ends the host
        libc::raise(signal);
    }
}

/// A crash (an abort: an allocation that failed, a panic; a fault) kills `group` on the host's way out: the
/// host's own end never leaves the command running. SA_ONSTACK: a stack overflow runs it on std's own stack.
pub fn kill_group_on_crash(group: libc::pid_t) -> io::Result<()> {
    GROUP.store(group, Ordering::Relaxed);
    for signal in [libc::SIGABRT, libc::SIGSEGV, libc::SIGBUS, libc::SIGILL, libc::SIGFPE] {
        // SAFETY: an all-zero sigaction is valid; the handler only reads an atomic and calls kill and raise
        unsafe {
            let mut action: libc::sigaction = std::mem::zeroed();
            action.sa_sigaction = kill_group as extern "C" fn(libc::c_int) as libc::sighandler_t;
            action.sa_flags = libc::SA_RESETHAND | libc::SA_ONSTACK;
            libc::sigemptyset(&mut action.sa_mask);
            check(libc::sigaction(signal, &action, std::ptr::null_mut()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status_of(script: &str) -> libc::c_int {
        let child = Command::new("sh").args(["-c", script]).spawn().unwrap();
        reap(child.id() as libc::pid_t, false).unwrap()
    }

    #[test]
    fn tells_a_signal_end_as_128_plus_its_number() {
        assert_eq!(exit_code(status_of("kill -TERM $$"), &[]), 128 + libc::SIGTERM);
    }

    #[test]
    fn tells_an_exit_as_its_own_code() {
        assert_eq!(exit_code(status_of("exit 3"), &[]), 3);
        assert_eq!(exit_code(status_of("exit 3"), &[libc::SIGHUP, libc::SIGKILL]), 3);
    }

    #[test]
    fn tells_a_running_child_from_an_exited_one_without_reaping_it() {
        let mut child = Command::new("sh").args(["-c", "read -r _; exit 0"]).stdin(Stdio::piped()).spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        assert!(!has_exited(pid));
        drop(child.stdin.take());
        wait_exited(pid).unwrap();
        assert!(has_exited(pid));
        assert_eq!(reap(pid, false).map(|status| exit_code(status, &[])), Some(0));
    }

    #[test]
    fn tells_a_signal_the_host_did_not_send_as_its_own() {
        assert_eq!(exit_code(status_of("kill -TERM $$"), &[libc::SIGHUP, libc::SIGKILL]), 128 + libc::SIGTERM);
    }

    #[test]
    fn tells_an_end_the_host_asked_for_as_before() {
        assert_eq!(exit_code(status_of("kill -HUP $$"), &[libc::SIGHUP]), 0);
    }
}
