//! ovis-acp-keeper: holds one ACP agent on pipes for any number of clients. Every JSON-RPC line in
//! either direction, plus the keeper's own `_keeper/*` notes, is numbered into ROOT/archive.jsonl;
//! clients on ROOT/acp.sock (a named pipe on Windows) replay from any row and then follow live.
//! Routing, approvals and the switch to the real TUI are in `hub`, the agent's process tree and the
//! terminal hand-over in `agent`, the pane's status line in `status`. A keeper started again in the
//! same ROOT numbers on, expires the approvals the dead agent asked, and loads the last session.

mod agent;
mod archive;
mod hub;
mod model;
mod status;

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};
use tokio::task::JoinHandle;

use agent::{Agent, Io};
use archive::{pump, Archive, Framed, Framer, MAX_LINE, PUSH};
use hub::{Ev, Hub, ToAgent};
use status::{Mode, Status};

pub struct Opts {
    pub root: PathBuf,
    pub cwd: String,
    pub name: String,
    pub resume: Option<String>,
    pub session_meta: Option<Value>,
    pub mcp_servers: Vec<Value>,
    pub config_options: Option<Vec<Value>>,
    pub announce_subagents: bool,
    pub ask_every_time: bool,
    pub load: Option<String>,
    pub headless: bool,
    pub command: String,
    pub args: Vec<String>,
}

/// Stops the pane's key reader while the real TUI owns the terminal, so no keystroke is taken from it.
struct Gate {
    state: Mutex<(bool, bool)>,
    cv: Condvar,
}

impl Gate {
    /// Closes the gate and waits (briefly) for the reader to stop at it; false when it did not, so
    /// the caller can keep the pane rather than hand a terminal the keeper may still read.
    fn pause(&self) -> bool {
        let mut state = self.state.lock().expect("gate");
        state.0 = true;
        let deadline = Instant::now() + Duration::from_millis(300);
        while !state.1 && Instant::now() < deadline {
            state = self.cv.wait_timeout(state, Duration::from_millis(20)).expect("gate").0;
        }
        state.1
    }

    fn resume(&self) {
        self.state.lock().expect("gate").0 = false;
        self.cv.notify_all();
    }

    fn wait_open(&self) {
        let mut state = self.state.lock().expect("gate");
        while state.0 {
            state.1 = true;
            self.cv.notify_all();
            state = self.cv.wait(state).expect("gate");
        }
        state.1 = false;
    }
}

async fn serve_client<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(conn: u64, archive: Arc<Archive>, pid: Arc<AtomicU32>, tx: UnboundedSender<Ev>, stream: S) {
    let (mut input, output) = tokio::io::split(stream);
    let mut framer = Framer::new(MAX_LINE);
    let mut chunk = vec![0u8; PUSH];
    let mut pumping: Option<tokio::task::JoinHandle<()>> = None;
    let mut output = Some(output);
    let _ = tx.send(Ev::Open(conn));
    while let Ok(n) = input.read(&mut chunk).await {
        if n == 0 {
            break;
        }
        for item in framer.push(&chunk[..n]) {
            let line = match item {
                Framed::Line(line) => line,
                Framed::Oversize { bytes, id, request } => {
                    if pumping.is_some() {
                        let _ = tx.send(Ev::Oversize {
                            conn: Some(conn),
                            bytes,
                            id,
                            request,
                            generation: 0,
                        });
                    }
                    continue;
                }
            };
            let Ok(text) = String::from_utf8(line) else { continue };
            if pumping.is_none() {
                let Ok(Value::Object(request)) = serde_json::from_str::<Value>(&text) else { continue };
                let Some(n) = request.get("replay").and_then(Value::as_u64) else { continue };
                let Some((cursor, boundary, through)) = archive.replay_from(n) else { continue };
                let (archive, mut out, pid) = (archive.clone(), output.take().expect("one replay per connection"), pid.load(Ordering::Relaxed));
                pumping = Some(tokio::spawn(async move {
                    let _ = pump(&archive, &mut out, cursor, boundary, through, pid, conn).await;
                    let _ = out.shutdown().await;
                }));
            } else {
                let _ = tx.send(Ev::Client { conn, line: text });
            }
        }
        if pumping.as_ref().is_some_and(|task| task.is_finished()) {
            break;
        }
    }
    if let Some(task) = pumping {
        task.abort();
    }
    let _ = tx.send(Ev::Gone);
}

#[cfg(unix)]
fn check_root(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(root).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::getuid() } || meta.mode() & 0o077 != 0 {
        return Err("ROOT must be owned by this user and private (0700)".into());
    }
    unsafe { libc::umask(0o077) };
    Ok(())
}

#[cfg(windows)]
fn check_root(root: &Path) -> Result<(), String> {
    if std::fs::metadata(root).map_err(|e| e.to_string())?.is_dir() {
        Ok(())
    } else {
        Err("ROOT must be a directory".into())
    }
}

#[cfg(unix)]
async fn listen(root: &Path, archive: Arc<Archive>, pid: Arc<AtomicU32>, tx: UnboundedSender<Ev>, mut conn: u64) -> std::io::Result<impl std::future::Future<Output = ()>> {
    let path = root.join("acp.sock");
    match std::fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = tokio::net::UnixListener::bind(path)?;
    Ok(async move {
        while let Ok((stream, _)) = listener.accept().await {
            conn += 1;
            tokio::spawn(serve_client(conn, archive.clone(), pid.clone(), tx.clone(), stream));
        }
    })
}

#[cfg(windows)]
async fn listen(root: &Path, archive: Arc<Archive>, pid: Arc<AtomicU32>, tx: UnboundedSender<Ev>, mut conn: u64) -> std::io::Result<impl std::future::Future<Output = ()>> {
    use tokio::net::windows::named_pipe::ServerOptions;
    let name = format!(r"\\.\pipe\acp-keeper-{}", std::process::id());
    std::fs::write(root.join("acp.pipe"), &name)?;
    let mut server = ServerOptions::new().first_pipe_instance(true).create(&name)?;
    Ok(async move {
        loop {
            if server.connect().await.is_err() {
                return;
            }
            let Ok(next) = ServerOptions::new().create(&name) else { return };
            let stream = std::mem::replace(&mut server, next);
            conn += 1;
            tokio::spawn(serve_client(conn, archive.clone(), pid.clone(), tx.clone(), stream));
        }
    })
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut hup = signal(SignalKind::hangup()).expect("SIGHUP handler");
        let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! { _ = hup.recv() => {}, _ = int.recv() => {}, _ = term.recv() => {} }
    }
    #[cfg(windows)]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

const USAGE: &str =
    "Usage: ovis-acp-keeper ROOT [--cwd DIR] [--name NAME] [--resume 'CMD {session}' | '[\"CMD\",\"{session}\"]'] [--session-meta JSON] [--mcp-servers ARRAY] [--config-options ARRAY] [--announce-subagents] [--ask-every-time] [--load SESSION] [--headless] -- AGENT [ARGS...]";

fn default_resume(command: &str, args: &[String]) -> Option<String> {
    let base = |s: &str| Path::new(s).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let words: Vec<String> = std::iter::once(base(command)).chain(args.iter().map(|a| base(a))).collect();
    let has = |name: &str| words.iter().any(|w| w == name || w.starts_with(&format!("{name}.")));
    if has("gjc") {
        Some("gjc --resume {session}".into())
    } else if has("agy") {
        Some("agy --conversation {session}".into())
    } else if words.iter().any(|w| w.contains("claude")) {
        Some("claude --resume {session}".into())
    } else if has("hermes") {
        Some("hermes --tui --resume {session}".into())
    } else if has("opencode") {
        Some("opencode --session {session}".into())
    } else if words.iter().any(|w| w.starts_with("codex")) {
        Some("codex resume {session}".into())
    } else {
        None
    }
}

pub(crate) fn parse(args: Vec<String>) -> Result<Opts, String> {
    let split = args.iter().position(|a| a == "--").ok_or(USAGE)?;
    let (head, tail) = args.split_at(split);
    let tail = &tail[1..];
    let (command, rest) = tail.split_first().ok_or(USAGE)?;
    let mut head = head.iter().skip(1);
    let root = PathBuf::from(head.next().ok_or(USAGE)?);
    let mut opts = Opts {
        root,
        cwd: std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into()),
        name: Path::new(command).file_name().and_then(|n| n.to_str()).unwrap_or(command).to_string(),
        resume: default_resume(command, rest),
        session_meta: None,
        mcp_servers: Vec::new(),
        config_options: None,
        announce_subagents: false,
        ask_every_time: false,
        load: None,
        headless: false,
        command: command.clone(),
        args: rest.to_vec(),
    };
    while let Some(flag) = head.next() {
        let mut value = || head.next().cloned().ok_or_else(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--cwd" => opts.cwd = value()?,
            "--name" => opts.name = value()?,
            "--resume" => opts.resume = Some(value()?),
            "--session-meta" => opts.session_meta = Some(serde_json::from_str(&value()?).map_err(|e| format!("--session-meta: {e}"))?),
            "--load" => opts.load = Some(value()?),
            "--headless" => opts.headless = true,
            "--mcp-servers" => opts.mcp_servers = serde_json::from_str(&value()?).map_err(|e| format!("--mcp-servers needs a JSON array: {e}"))?,
            "--config-options" => opts.config_options = Some(serde_json::from_str(&value()?).map_err(|e| format!("--config-options needs a JSON array: {e}"))?),
            "--announce-subagents" => opts.announce_subagents = true,
            "--ask-every-time" => opts.ask_every_time = true,
            other => return Err(format!("unknown option {other}\n{USAGE}")),
        }
    }
    Ok(opts)
}

fn main() {
    let opts = match parse(std::env::args().collect()) {
        Ok(opts) => opts,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    std::process::exit(runtime.block_on(run(opts)));
}

fn is_terminal() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal() && std::io::stdin().is_terminal()
}

/// Holds ROOT for this keeper's lifetime; the lock goes with the process, however it ends.
#[cfg(unix)]
fn lock(root: &Path) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::os::unix::io::AsRawFd;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("keeper.lock"))
        .map_err(|e| format!("keeper.lock: {e}"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err("another keeper is running in ROOT".into());
    }
    Ok(file)
}

#[cfg(windows)]
fn lock(root: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join("keeper.lock"))
        .map_err(|_| "another keeper is running in ROOT".to_string())
}

/// Starts the ACP agent (generation `generation`): its stdin fed from the returned sender, its stdout
/// framed into hub events by the returned reader task.
async fn start_acp(opts: &Opts, stderr: &File, generation: u64, tx: &UnboundedSender<Ev>) -> std::io::Result<(Agent, UnboundedSender<ToAgent>, JoinHandle<()>)> {
    let mut agent = Agent::spawn(&opts.command, &opts.args, &opts.cwd, Io::Pipes(stderr.try_clone()?), &opts.root).await?;
    let (agent_tx, mut agent_rx) = unbounded_channel::<ToAgent>();
    let mut stdin = agent.child.stdin.take().expect("piped stdin");
    let writes = tx.clone();
    tokio::spawn(async move {
        while let Some(ToAgent { bytes, receipt }) = agent_rx.recv().await {
            if let Err(error) = stdin.write_all(&bytes).await {
                let _ = writes.send(Ev::AgentWriteFailed(generation, error));
                break;
            }
            if let Some(receipt) = receipt {
                let _ = writes.send(Ev::Written(generation, receipt));
            }
        }
    });
    let mut stdout = agent.child.stdout.take().expect("piped stdout");
    let lines = tx.clone();
    let reader = tokio::spawn(async move {
        let mut framer = Framer::new(MAX_LINE);
        let mut chunk = vec![0u8; PUSH];
        while let Ok(n) = stdout.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            for item in framer.push(&chunk[..n]) {
                let ev = match item {
                    Framed::Line(line) => match String::from_utf8(line) {
                        Ok(text) => Ev::Agent(generation, text),
                        Err(_) => continue,
                    },
                    Framed::Oversize { bytes, id, request } => Ev::Oversize {
                        conn: None,
                        bytes,
                        id,
                        request,
                        generation,
                    },
                };
                let _ = lines.send(ev);
            }
        }
    });
    Ok((agent, agent_tx, reader))
}

/// SIGCHLD, listened to from the start so a TUI that stops right away is not missed.
struct ChildSignal(#[cfg(unix)] tokio::signal::unix::Signal);

impl ChildSignal {
    fn new() -> ChildSignal {
        ChildSignal(
            #[cfg(unix)]
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child()).expect("SIGCHLD handler"),
        )
    }

    async fn recv(&mut self) {
        #[cfg(unix)]
        self.0.recv().await;
        #[cfg(windows)]
        std::future::pending::<()>().await;
    }
}

async fn wait_for(agent: &mut Option<Agent>) -> std::io::Result<std::process::ExitStatus> {
    match agent {
        Some(agent) => agent.wait().await,
        None => std::future::pending().await,
    }
}

async fn finish_reader(reader: Option<JoinHandle<()>>) {
    if let Some(mut task) = reader {
        if tokio::time::timeout(Duration::from_millis(500), &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
    }
}

fn write_process(root: &Path, acp: Option<&Agent>, tui: Option<&Agent>) {
    let pid = |a: Option<&Agent>| a.map(|a| a.pid);
    let scope = acp.or(tui).and_then(|a| a.scope.clone());
    // Renamed into place: a client asking whether the keeper runs never reads it half written.
    let next = root.join("process.json.next");
    let body = json!({"keeper": std::process::id(), "child": pid(acp), "tui": pid(tui), "scope": scope}).to_string();
    if std::fs::write(&next, body).is_ok() {
        let _ = std::fs::rename(&next, root.join("process.json"));
    }
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

/// Hands the pane back to the keeper after the real TUI: the status line's raw mode first, then the
/// terminal, then the key reader.
fn take_pane_back(status: &mut Option<Status>, gate: &Gate, job_control: bool) {
    let mut resume = || {
        if let Some(status) = status.as_mut() {
            let _ = status.resume();
        }
    };
    if job_control {
        agent::take_terminal(resume);
    } else {
        resume();
    }
    gate.resume();
}

/// After the real TUI (or a failed start of it): the ACP agent again, loading the same session.
async fn restart_acp(hub: &mut Hub, stderr: &File, tx: &UnboundedSender<Ev>) -> Option<(Agent, JoinHandle<()>)> {
    hub.mode = Mode::Switching;
    hub.generation += 1;
    match start_acp(&hub.opts, stderr, hub.generation, tx).await {
        Ok((agent, agent_tx, reader)) => {
            write_process(&hub.opts.root, Some(&agent), None);
            hub.restarted(agent_tx);
            Some((agent, reader))
        }
        Err(e) => {
            hub.mode = Mode::Acp;
            hub.mode_note("acp", "failed", json!({"reason": e.to_string()}));
            hub.model.agent_gone = Some(format!("ACP 에이전트를 다시 띄우지 못했습니다 ({e})"));
            hub.agent_gone();
            None
        }
    }
}

async fn run(mut opts: Opts) -> i32 {
    let started = Instant::now();
    if let Err(message) = check_root(&opts.root) {
        eprintln!("{message}");
        return 1;
    }
    let _lock = match lock(&opts.root) {
        Ok(lock) => lock,
        Err(message) => {
            eprintln!("{message}");
            return 1;
        }
    };
    // The ROOT is this keeper's from here: a previous keeper's pid must not say it is gone while the agent starts.
    write_process(&opts.root, None, None);
    let root = opts.root.clone();
    let (archive, previous) = match Archive::open(root.join("archive.jsonl")) {
        Ok((archive, previous)) => (Arc::new(archive), previous),
        Err(e) => {
            eprintln!("archive: {e}");
            return 1;
        }
    };
    for (id, seq) in &previous.pending {
        hub::note(&archive, "_keeper/expired", json!({"id": id, "seq": seq, "reason": "the agent that asked it is gone"}));
    }
    if let Some(error) = archive.error() {
        eprintln!("archive: {error}");
        return 1;
    }
    let resumed = opts.load.is_none() && previous.session.is_some();
    if resumed {
        opts.load = previous.session.clone();
    }
    let stderr = match archive::append_file(&root.join("agent.stderr")) {
        Ok(file) => file,
        Err(e) => {
            eprintln!("agent.stderr: {e}");
            return 1;
        }
    };
    let (tx, mut rx) = unbounded_channel::<Ev>();
    let (agent, agent_tx, reader) = match start_acp(&opts, &stderr, 0, &tx).await {
        Ok(started) => started,
        Err(e) => {
            eprintln!("{}: {e}", opts.command);
            return 1;
        }
    };
    let child_pid = agent.pid;
    let mut acp = Some(agent);
    let mut reader = Some(reader);
    let mut tui: Option<Agent> = None;
    // The pid a replaying client is told: the ACP agent's, or the real TUI's while it has the pane.
    let agent_pid = Arc::new(AtomicU32::new(child_pid));
    // Before the socket: a client refused by a socket not listening yet asks process.json whether the keeper runs.
    write_process(&root, acp.as_ref(), None);
    let accept = match listen(&root, archive.clone(), agent_pid.clone(), tx.clone(), previous.last_client).await {
        Ok(accept) => accept,
        Err(e) => {
            eprintln!("listen: {e}");
            if let Some(agent) = acp.as_mut() {
                let _ = agent.stop(Duration::ZERO).await;
            }
            return 1;
        }
    };
    let accepting = tokio::spawn(accept);

    let tty = !opts.headless && is_terminal();
    let job_control = tty && agent::job_control();
    let mut status = if tty {
        std::panic::set_hook(Box::new(|info| {
            status::restore_terminal();
            eprintln!("{info}");
        }));
        match Status::enter() {
            Ok(status) => Some(status),
            Err(e) => {
                eprintln!("terminal: {e}");
                if let Some(agent) = acp.as_mut() {
                    let _ = agent.stop(Duration::ZERO).await;
                }
                return 1;
            }
        }
    } else {
        None
    };
    let gate = Arc::new(Gate {
        state: Mutex::new((false, false)),
        cv: Condvar::new(),
    });
    if tty {
        let keys = tx.clone();
        let gate = gate.clone();
        std::thread::spawn(move || loop {
            gate.wait_open();
            match crossterm::event::poll(Duration::from_millis(25)) {
                Ok(true) => match crossterm::event::read() {
                    Ok(event) => {
                        if let Some(key) = status::key(&event) {
                            if keys.send(Ev::Key(key)).is_err() {
                                break;
                            }
                        }
                    }
                    Err(_) => break,
                },
                Ok(false) => {}
                Err(_) => break,
            }
        });
    } else {
        std::thread::spawn(|| {
            let mut sink = [0u8; 4096];
            let mut stdin = std::io::stdin();
            while std::io::Read::read(&mut stdin, &mut sink).is_ok_and(|n| n > 0) {}
        });
    }
    let mut hub = Hub::new(archive.clone(), agent_tx, opts, resumed, job_control);
    hub.note_row(
        "_keeper/ready",
        json!({"sinceStartMs": ms(started), "keeper": std::process::id(), "child": child_pid, "tty": tty, "jobControl": job_control, "scope": acp.as_ref().and_then(|a| a.scope.clone()), "resumed": resumed, "expired": previous.pending.len()}),
    );
    hub.start();
    if !tty && archive.error().is_none() {
        println!("KEEPER_READY");
    }

    let signal = shutdown_signal();
    tokio::pin!(signal);
    let mut children = ChildSignal::new();
    let mut exited: Option<std::io::Result<std::process::ExitStatus>> = None;
    let mut by_signal = false;
    let mut tui_started = Instant::now();
    loop {
        if let Some(status) = status.as_mut().filter(|_| hub.mode != Mode::Terminal) {
            if std::mem::take(&mut hub.redraw) {
                status.redraw();
            }
            status.draw(status::lines(&hub.model, hub.mode));
        }
        if hub.quit || archive.error().is_some() {
            break;
        }
        tokio::select! {
            ev = rx.recv() => {
                let Some(ev) = ev else { break };
                hub.handle(ev);
                while archive.error().is_none() {
                    match rx.try_recv() {
                        Ok(ev) => hub.handle(ev),
                        Err(_) => break,
                    }
                }
            }
            result = wait_for(&mut acp) => {
                // What the agent wrote before it exited (a last answer, a last request) is handled first.
                finish_reader(reader.take()).await;
                while let Ok(ev) = rx.try_recv() {
                    hub.handle(ev);
                }
                hub.generation += 1;
                let text = match &result {
                    Ok(s) => format!("에이전트 끝남 ({s})"),
                    Err(e) => format!("에이전트 끝남 ({e})"),
                };
                hub.note_row("_keeper/agent_exit", json!({"status": text}));
                hub.model.agent_gone = Some(format!("{text} · Ctrl+Q: 닫기"));
                hub.agent_gone();
                exited = Some(result);
                if let Some(agent) = acp.take() {
                    agent.stop_remaining_scope().await;
                }
                if !tty {
                    break;
                }
            }
            result = wait_for(&mut tui) => {
                let ran = ms(tui_started);
                if let Some(agent) = tui.take() {
                    agent.stop_remaining_scope().await;
                }
                take_pane_back(&mut status, &gate, job_control);
                let code = result.as_ref().ok().and_then(|s| s.code());
                if !result.as_ref().is_ok_and(|s| s.success()) && ran < 10_000.0 {
                    hub.model.error(format!("진짜 TUI가 {:.1}초 만에 끝났습니다 (종료 코드 {code:?}). 이어 열기가 안 된 것 같습니다", ran / 1000.0));
                }
                hub.mode_note("acp", "start", json!({"tuiExit": code, "tuiRanMs": ran}));
                if archive.error().is_some() {
                    break;
                }
                if let Some((agent, task)) = restart_acp(&mut hub, &stderr, &tx).await {
                    agent_pid.store(agent.pid, Ordering::Relaxed);
                    acp = Some(agent);
                    reader = Some(task);
                    exited = None;
                }
            }
            _ = children.recv(), if tui.is_some() => {
                if let Some(agent) = tui.as_ref().filter(|a| agent::stopped(a.pid)) {
                    agent::continue_job(agent.pid);
                    hub.note_row("_keeper/tui_continued", json!({"tuiPid": agent.pid}));
                }
            }
            _ = &mut signal => {
                by_signal = true;
                break;
            }
        }
        if archive.error().is_some() {
            break;
        }
        if let Some(pressed) = hub.want_terminal.take() {
            if !gate.pause() {
                gate.resume();
                hub.mode = Mode::Acp;
                hub.note_row("_keeper/switch_refused", json!({"by": "keeper", "reason": "the pane's key reader did not stop"}));
                hub.model.error("진짜 TUI로 열지 않았습니다: the pane's key reader did not stop");
                continue;
            }
            let argv = hub.resume_argv().expect("checked before the switch was accepted");
            hub.mode = Mode::Switching;
            if let Some(status) = status.as_mut() {
                status.draw(status::lines(&hub.model, hub.mode));
            }
            hub.mode_note("terminal", "start", json!({"argv": argv}));
            if archive.error().is_some() {
                break;
            }
            hub.agent = None;
            if let Some(mut agent) = acp.take() {
                if tokio::time::timeout(Duration::from_millis(800), agent.wait()).await.is_err() {
                    let _ = agent.stop(Duration::from_millis(1500)).await;
                } else {
                    agent.stop_remaining_scope().await;
                }
            }
            finish_reader(reader.take()).await;
            while let Ok(ev) = rx.try_recv() {
                hub.handle(ev);
            }
            hub.expire_pending("the agent that asked it was ended for the real TUI");
            if archive.error().is_some() {
                break;
            }
            hub.generation += 1;
            let agent_ended = ms(pressed);
            if let Some(status) = status.as_mut() {
                status.suspend();
            }
            match Agent::spawn(&argv[0], &argv[1..], &hub.opts.cwd, Io::Terminal { foreground: job_control }, &root).await {
                Ok(agent) => {
                    tui_started = Instant::now();
                    hub.mode = Mode::Terminal;
                    hub.mode_note("terminal", "ready", json!({"tuiPid": agent.pid, "agentEndedMs": agent_ended, "spawnedMs": ms(pressed)}));
                    write_process(&root, None, Some(&agent));
                    agent_pid.store(agent.pid, Ordering::Relaxed);
                    tui = Some(agent);
                }
                Err(e) => {
                    take_pane_back(&mut status, &gate, job_control);
                    hub.model.error(format!("진짜 TUI를 띄우지 못했습니다 ({}: {e})", argv[0]));
                    hub.mode_note("terminal", "failed", json!({"reason": e.to_string()}));
                    if let Some((agent, task)) = restart_acp(&mut hub, &stderr, &tx).await {
                        agent_pid.store(agent.pid, Ordering::Relaxed);
                        acp = Some(agent);
                        reader = Some(task);
                    }
                }
            }
        }
    }
    hub.agent = None;
    if let Some(mut agent) = tui.take() {
        let _ = agent.stop(Duration::from_millis(1500)).await;
        take_pane_back(&mut status, &gate, job_control);
    }
    let result = match (exited, acp.as_mut()) {
        (Some(result), _) => result,
        (None, Some(agent)) => agent.stop(Duration::from_millis(1500)).await,
        (None, None) => Ok(Default::default()),
    };
    finish_reader(reader.take()).await;
    while let Ok(ev) = rx.try_recv() {
        // a client's number is noted even when it connected just before the end, so the next keeper
        // in this ROOT numbers on past it
        if matches!(ev, Ev::Agent(..) | Ev::Written(..) | Ev::AgentWriteFailed(..) | Ev::Oversize { conn: None, .. } | Ev::Open(_)) {
            hub.handle(ev);
        }
    }
    archive.close(Duration::from_millis(1000)).await;
    accepting.abort();
    #[cfg(unix)]
    let _ = std::fs::remove_file(root.join("acp.sock"));
    if status.is_some() {
        status::restore_terminal();
    }
    if let Some(error) = archive.error() {
        eprintln!("archive: {error}");
        return 1;
    }
    match result {
        Ok(result) if result.success() || by_signal || hub.quit => 0,
        _ => 1,
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn the_reader_cannot_keep_running_past_the_drain_deadline() {
        let reader = tokio::spawn(std::future::pending());
        let state = reader.abort_handle();
        super::finish_reader(Some(reader)).await;
        assert!(state.is_finished());
    }
}
