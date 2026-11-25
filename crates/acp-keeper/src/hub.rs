//! Where every message goes. The keeper is the agent's only ACP client: it sends `initialize` and
//! `session/new` (or `session/load`) itself, so the session is open before any client attaches. A
//! client's request reaches the agent under an id of the keeper's own and its answer comes back to
//! that client alone (a `to-client` row), so clients that count ids alike never get each other's
//! answers. An agent request is archived under an id of the keeper's own too (`agent-N`), so an
//! answer meant for one approval can never resolve a later one the agent asked under the same id.
//! Only the first answer from a client goes to the agent (under the agent's id). After the writer
//! delivers it, a `_keeper/resolved` note says who won. A later answer gets a `_keeper/dropped` note.
//!
//! The switch: once the turn is over and nothing waits, F4 in the pane or a client's
//! `_keeper/open_terminal` request asks for the agent's real TUI on the same conversation. The run
//! loop ends the ACP agent, hands the pane to the TUI, and when the TUI exits starts the ACP agent
//! again and loads the same session (now with the turns made in the TUI). `_keeper/mode` notes mark
//! each step; client requests in between are refused, since one conversation is never driven by
//! ACP and a live TUI at once.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::archive::{key_of, rpc, Archive, MAX_LINE};
use crate::model::Model;
use crate::status::{Key, Mode};
use crate::Opts;

/// Agent lines carry the generation of the agent process that wrote them: lines of an agent the
/// keeper already ended for the switch are dropped.
pub enum Ev {
    Agent(u64, String),
    Written(u64, Receipt),
    AgentWriteFailed(u64, std::io::Error),
    Client {
        conn: u64,
        line: String,
    },
    Oversize {
        conn: Option<u64>,
        bytes: usize,
        id: Option<Value>,
        request: bool,
        generation: u64,
    },
    Open(u64),
    Gone,
    Key(Key),
}

pub struct ToAgent {
    pub bytes: Vec<u8>,
    pub receipt: Option<Receipt>,
}

pub enum Receipt {
    Answer(PendingAnswer),
    Request { conn: u64, id: Value },
    Hold { route: String, generation: u64 },
}

pub struct PendingAnswer {
    key: String,
    by: String,
    option: Option<String>,
    outcome: Option<String>,
}

/// A mode or model change from the screen or a client, shown in the header once the agent accepts it.
#[derive(Clone)]
enum Change {
    Mode(String),
    Model(String),
    Config { config: String, value: String },
}

impl Change {
    fn of(method: &str, params: &Value) -> Option<Change> {
        let field = |key: &str| params.get(key).and_then(Value::as_str).map(str::to_string);
        match method {
            "session/set_mode" => field("modeId").map(Change::Mode),
            "session/set_model" => field("modelId").map(Change::Model),
            "session/set_config_option" => Some(Change::Config {
                config: field("configId")?,
                value: field("value")?,
            }),
            _ => None,
        }
    }
}

enum Own {
    Initialize,
    NewSession,
    LoadSession { resumed: bool },
}

struct Route {
    conn: u64,
    id: Value,
    change: Option<Change>,
}

struct ToolStop {
    conn: u64,
    id: Value,
    deadline: Instant,
}

/// Why an answer to a permission request is not one (the request stays pending), or None. An error
/// answer, a cancellation and a selection of one of the offered options are answers.
fn invalid_answer(pending: &crate::model::Pending, answer: &Value) -> Option<&'static str> {
    if pending.method != "session/request_permission" || answer.get("error").is_some() {
        return None;
    }
    match answer.pointer("/result/outcome/outcome").and_then(Value::as_str) {
        Some("cancelled") => None,
        Some("selected") => {
            let option = answer.pointer("/result/outcome/optionId").and_then(Value::as_str);
            (!pending.options.iter().any(|o| Some(o.as_str()) == option)).then_some("not one of the offered options")
        }
        _ => Some("not a permission outcome"),
    }
}

pub fn note(archive: &Archive, method: &str, params: Value) {
    archive.append("keeper", &json!({"jsonrpc": "2.0", "method": method, "params": params}).to_string());
}

pub struct Hub {
    archive: Arc<Archive>,
    pub agent: Option<UnboundedSender<ToAgent>>,
    pub model: Model,
    pub opts: Opts,
    resumed: bool,
    pub mode: Mode,
    pub generation: u64,
    /// When the switch to the real TUI was asked for; the run loop carries it out.
    pub want_terminal: Option<Instant>,
    /// Whether the pane is a terminal with job control, which the real TUI can be given.
    pub job_control: bool,
    next: u64,
    own: HashMap<String, Own>,
    routes: HashMap<String, Route>,
    agent_ids: HashMap<String, Value>,
    answering: HashSet<String>,
    client_ids: HashSet<(u64, String)>,
    prompts: HashSet<String>,
    hold: Option<u64>,
    stop: Option<ToolStop>,
    pub quit: bool,
    /// The pane was resized: paint the status line again.
    pub redraw: bool,
}

impl Hub {
    /// `resumed`: the session to load came from the archive, so a failed load opens a new one.
    pub fn new(archive: Arc<Archive>, agent: UnboundedSender<ToAgent>, opts: Opts, resumed: bool, job_control: bool) -> Hub {
        // Ids the keeper makes up (`keeper-N`, `client-C-N`, `agent-N`) count on from the archive's
        // last row, so no id of an earlier run in the same ROOT is ever given out again.
        let next = archive.replay_from(1).map(|(_, _, last)| last).unwrap_or(0);
        Hub {
            archive,
            agent: Some(agent),
            model: Model::new(opts.name.clone()),
            opts,
            resumed,
            mode: Mode::Acp,
            generation: 0,
            want_terminal: None,
            job_control,
            next,
            own: HashMap::new(),
            routes: HashMap::new(),
            agent_ids: HashMap::new(),
            answering: HashSet::new(),
            client_ids: HashSet::new(),
            prompts: HashSet::new(),
            hold: None,
            stop: None,
            quit: false,
            redraw: false,
        }
    }

    pub fn resume_argv(&self) -> Option<Vec<String>> {
        let session = self.model.session.as_deref()?;
        let template = self.opts.resume.as_deref()?;
        let words: Vec<String> = match serde_json::from_str::<Vec<String>>(template) {
            Ok(words) => words,
            Err(_) => template.split_whitespace().map(str::to_string).collect(),
        };
        (!words.is_empty()).then(|| words.iter().map(|w| w.replace("{session}", session)).collect())
    }

    pub fn mode_note(&self, mode: &str, phase: &str, extra: Value) {
        let mut params = json!({"mode": mode, "phase": phase, "sessionId": self.model.session});
        if let (Some(target), Value::Object(extra)) = (params.as_object_mut(), extra) {
            target.extend(extra);
        }
        self.note_row("_keeper/mode", params);
    }

    fn switch_blocker(&self) -> Option<&'static str> {
        if self.quit || self.stop.is_some() {
            Some("the keeper is stopping")
        } else if self.mode != Mode::Acp {
            Some("already switching")
        } else if !self.job_control {
            Some("the pane has no terminal with job control")
        } else if self.agent.is_none() {
            Some("the agent is not accepting requests")
        } else if self.resume_argv().is_none() {
            Some(if self.model.session.is_none() {
                "no session yet"
            } else {
                "no resume command for this agent (--resume)"
            })
        } else if !self.model.pending.is_empty() {
            Some("an approval is waiting")
        } else if self.model.working {
            Some("a turn is running")
        } else if !self.own.is_empty() || !self.routes.is_empty() {
            Some("a request to the agent is still open")
        } else {
            None
        }
    }

    /// Asks for the switch to the real TUI: refused (and noted) unless the agent is idle.
    fn open_terminal(&mut self, by: &str) -> Result<(), &'static str> {
        if let Some(reason) = self.switch_blocker() {
            self.note_row("_keeper/switch_refused", json!({"by": by, "reason": reason}));
            self.model.error(format!("진짜 TUI로 열지 않았습니다: {reason}"));
            return Err(reason);
        }
        // From here on nothing new reaches the agent: it is about to be ended for the real TUI.
        self.mode = Mode::Switching;
        self.want_terminal = Some(Instant::now());
        Ok(())
    }

    /// Agent requests the ended agent can no longer receive an answer to: noted as expired, so
    /// clients close their cards, and any later answer is dropped.
    pub fn expire_pending(&mut self, reason: &str) {
        self.answering.clear();
        for pending in std::mem::take(&mut self.model.pending) {
            self.agent_ids.remove(&pending.key);
            self.note_row("_keeper/expired", json!({"id": pending.id, "seq": pending.seq, "reason": reason}));
        }
    }

    /// A new ACP agent after the real TUI: everything the old one had open is gone, and the same
    /// session is loaded (a new one opens when the agent cannot load it).
    pub fn restarted(&mut self, agent: UnboundedSender<ToAgent>) {
        self.fail_routes("the agent was ended for the real TUI");
        self.agent = Some(agent);
        self.own.clear();
        self.prompts.clear();
        self.expire_pending("the agent that asked it was ended for the real TUI");
        self.model.working = false;
        self.model.agent_gone = None;
        self.opts.load = self.model.session.clone();
        // The conversation the TUI just had must come back; a failed load is reported, never replaced by a new session.
        self.resumed = false;
        self.start();
    }

    pub fn note_row(&self, method: &str, params: Value) {
        note(&self.archive, method, params);
    }

    fn forward(&self, raw: &str) {
        self.queue(raw, None);
    }

    fn queue(&self, raw: &str, receipt: Option<Receipt>) {
        if self.archive.append("to-agent", raw).is_none() {
            return;
        }
        if let Some(agent) = &self.agent {
            let mut bytes = raw.as_bytes().to_vec();
            bytes.push(b'\n');
            let _ = agent.send(ToAgent { bytes, receipt });
        }
    }

    /// The agent is gone: every client request still waiting for it gets an error, and requests
    /// sent from now on are answered the same way instead of waiting forever.
    pub fn agent_gone(&mut self) {
        self.disconnect_agent("the agent has exited");
    }

    fn disconnect_agent(&mut self, reason: &str) {
        self.agent = None;
        self.expire_pending(reason);
        self.fail_routes(reason);
        self.own.clear();
        self.prompts.clear();
        self.model.working = false;
        self.finish_stop();
    }

    fn fail_routes(&mut self, message: &str) {
        let routes: Vec<Route> = self.routes.drain().map(|(_, route)| route).collect();
        for route in routes {
            self.client_ids.remove(&(route.conn, key_of(&route.id)));
            self.reply(route.conn, &json!({"jsonrpc": "2.0", "id": route.id, "error": {"code": -32603, "message": message}}));
        }
    }

    fn back_failed(&mut self, reason: &str) {
        if self.mode == Mode::Switching {
            self.mode = Mode::Acp;
            self.mode_note("acp", "failed", json!({"reason": reason}));
        }
    }

    fn reply(&self, conn: u64, msg: &Value) {
        self.archive.append_for(conn, &msg.to_string());
    }

    fn request(&mut self, method: &str, params: Value, own: Own) -> String {
        self.next += 1;
        let id = Value::String(format!("keeper-{}", self.next));
        let key = key_of(&id);
        self.own.insert(key.clone(), own);
        self.forward(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string());
        key
    }

    pub fn start(&mut self) {
        let mut capabilities = json!({"fs": {"readTextFile": false, "writeTextFile": false}, "terminal": false});
        if self.opts.announce_subagents {
            capabilities["subagents"] = json!({});
        }
        self.request(
            "initialize",
            json!({"protocolVersion": 1, "clientCapabilities": capabilities, "clientInfo": {"name": "acp-keeper", "version": env!("CARGO_PKG_VERSION")}}),
            Own::Initialize,
        );
    }

    /// What opens a session, new or loaded again (after the real TUI): the same launch settings both times, so a
    /// reloaded session does not come back under settings the launch had left out.
    fn session_params(&self, mut params: Value) -> Value {
        params["cwd"] = json!(self.opts.cwd);
        params["mcpServers"] = json!(self.opts.mcp_servers);
        if let Some(meta) = &self.opts.session_meta {
            params["_meta"] = meta.clone();
        }
        if let Some(options) = &self.opts.config_options {
            params["configOptions"] = Value::Array(options.clone());
        }
        params
    }

    fn new_session(&mut self) {
        let params = self.session_params(json!({}));
        self.request("session/new", params, Own::NewSession);
    }

    pub fn handle(&mut self, ev: Ev) {
        if self.archive.error().is_some() {
            return;
        }
        match ev {
            Ev::Agent(generation, text) => {
                if generation == self.generation {
                    self.on_agent(text);
                }
            }
            Ev::Written(generation, receipt) => {
                if generation == self.generation {
                    match receipt {
                        Receipt::Answer(answer) => self.answer_written(answer),
                        Receipt::Hold { route, generation } => {
                            if let Some(r) = self.routes.remove(&route) {
                                self.client_ids.remove(&(r.conn, key_of(&r.id)));
                                self.reply(r.conn, &json!({"jsonrpc":"2.0","id":r.id,"result":{"generation":generation}}));
                            }
                        }
                        Receipt::Request { conn, id } => self.note_row("_keeper/delivered", json!({"client": conn, "id": id})),
                    }
                }
            }
            Ev::AgentWriteFailed(generation, error) => {
                if generation == self.generation {
                    self.generation += 1;
                    let reason = format!("could not write to the agent: {error}");
                    self.disconnect_agent(&reason);
                    self.model.agent_gone = Some(reason);
                }
            }
            Ev::Client { conn, line } => self.on_client(conn, line),
            Ev::Oversize { conn, bytes, id, request, generation } => {
                if conn.is_some() || generation == self.generation {
                    self.oversize(conn, bytes, id, request);
                }
            }
            Ev::Open(conn) => {
                self.note_row("_keeper/client", json!({"client": conn}));
                self.model.clients += 1;
            }
            Ev::Gone => self.model.clients = self.model.clients.saturating_sub(1),
            Ev::Key(Key::OpenTui) => {
                let _ = self.open_terminal("terminal");
            }
            Ev::Key(Key::Quit) => self.quit = true,
            Ev::Key(Key::Redraw) => self.redraw = true,
        }
    }

    /// A line past MAX_LINE was dropped: say so in the archive, and answer whoever would otherwise
    /// wait for it forever (the client that sent a request, the agent that sent one, or the client
    /// whose request the dropped answer was for).
    fn oversize(&mut self, conn: Option<u64>, bytes: usize, id: Option<Value>, request: bool) {
        let dir = if conn.is_some() { "from-client" } else { "from-agent" };
        self.note_row("_keeper/oversize", json!({"dir": dir, "client": conn, "bytes": bytes, "limit": MAX_LINE, "id": id}));
        let message = format!("line too long: {bytes} bytes, the limit is {MAX_LINE}");
        match (conn, id) {
            (Some(conn), Some(id)) if request => self.reply(conn, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": message}})),
            (None, Some(id)) if request => self.forward(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": message}}).to_string()),
            (None, Some(id)) => {
                let answer = json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": message}});
                if let Value::Object(answer) = answer {
                    self.agent_response(&key_of(&id), &answer);
                }
            }
            _ => {}
        }
        if conn.is_none() {
            self.model.error(format!("에이전트가 보낸 줄이 너무 길어 버렸습니다 ({bytes}바이트, 한도 {MAX_LINE})"));
        }
    }

    fn on_agent(&mut self, text: String) {
        let Some(mut msg) = rpc(&text) else { return };
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        match (method, msg.get("id").cloned()) {
            (Some(method), Some(id)) => {
                if self.quit {
                    return;
                }
                self.next += 1;
                let ours = Value::String(format!("agent-{}", self.next));
                msg.insert("id".into(), ours.clone());
                if self.opts.ask_every_time && method == "session/request_permission" {
                    if let Some(options) = msg.get_mut("params").and_then(|params| params.get_mut("options")).and_then(Value::as_array_mut) {
                        options.retain(|o| matches!(o.get("kind").and_then(Value::as_str), Some("allow_once" | "reject_once")));
                    }
                }
                let Some(seq) = self.archive.append("from-agent", &Value::Object(msg.clone()).to_string()) else {
                    return;
                };
                if method.starts_with("fs/") || method.starts_with("terminal/") {
                    let raw = json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}}).to_string();
                    self.forward(&raw);
                    self.note_row("_keeper/auto_answered", json!({"id": ours, "method": method}));
                    return;
                }
                self.agent_ids.insert(key_of(&ours), id);
                self.model.request(key_of(&ours), ours, seq, &msg);
                if self.stop.is_some() && method == "session/request_permission" {
                    self.cancel_pending(None, "tool-stop");
                }
            }
            (Some(method), None) => {
                self.archive.append("from-agent", &text);
                if method == "session/update" {
                    let params = msg.get("params").unwrap_or(&Value::Null);
                    self.model.update(params);
                    if matches!(params.pointer("/update/sessionUpdate").and_then(Value::as_str), Some("config_option_update" | "current_mode_update")) {
                        self.selections_note();
                    }
                }
            }
            (None, Some(id)) => {
                self.archive.append("from-agent", &text);
                self.agent_response(&key_of(&id), &msg);
            }
            (None, None) => {}
        }
    }

    fn agent_response(&mut self, key: &str, msg: &Map<String, Value>) {
        let error = msg.get("error").map(|e| e.get("message").and_then(Value::as_str).unwrap_or("error").to_string());
        let result = msg.get("result").cloned().unwrap_or(Value::Null);
        if self.prompts.remove(key) {
            self.model.working = !self.prompts.is_empty();
            match &error {
                Some(e) => self.model.error(format!("턴 실패: {e}")),
                None => self.model.note(format!("턴 끝 ({})", result.get("stopReason").and_then(Value::as_str).unwrap_or("?"))),
            }
        }
        if let Some(route) = self.routes.remove(key) {
            self.client_ids.remove(&(route.conn, key_of(&route.id)));
            if let (None, Some(change)) = (&error, &route.change) {
                self.apply(change, &result);
            }
            let mut answer = msg.clone();
            answer.insert("id".into(), route.id);
            self.reply(route.conn, &Value::Object(answer));
            return;
        }
        let Some(own) = self.own.remove(key) else { return };
        match own {
            Own::Initialize => {
                if let Some(e) = error {
                    self.back_failed(&e);
                    self.model.error(format!("initialize 실패: {e}"));
                    return;
                }
                let can_load = result.pointer("/agentCapabilities/loadSession") == Some(&Value::Bool(true));
                match self.opts.load.clone() {
                    Some(_) if !can_load && !self.resumed => {
                        let reason = "the agent cannot load a session";
                        self.back_failed(reason);
                        self.model.error(format!("세션을 불러오지 못했습니다: {reason}"));
                    }
                    Some(id) if can_load => {
                        self.model.session = Some(id.clone());
                        let params = self.session_params(json!({"sessionId": id}));
                        self.request("session/load", params, Own::LoadSession { resumed: self.resumed });
                    }
                    _ => self.new_session(),
                }
            }
            Own::NewSession | Own::LoadSession { .. } if error.is_some() => {
                let e = error.unwrap_or_default();
                if let Own::LoadSession { resumed: true } = own {
                    self.model.session = None;
                    self.model.note(format!("지난 세션을 이어 가지 못해 새 세션을 엽니다: {e}"));
                    self.new_session();
                    return;
                }
                // After the real TUI the session id stays: F4 can still reopen that conversation in its TUI.
                if self.mode == Mode::Switching {
                    self.back_failed(&e);
                } else {
                    self.model.session = None;
                }
                let auth = msg.get("error").and_then(|e| e.get("code")).and_then(Value::as_i64) == Some(-32000);
                self.model.error(if auth {
                    format!("로그인이 필요합니다: {e}. 에이전트의 진짜 TUI나 로그인 명령으로 먼저 로그인하세요")
                } else {
                    format!("세션을 열지 못했습니다: {e}")
                });
            }
            Own::NewSession | Own::LoadSession { .. } => {
                if let Some(id) = result.get("sessionId").and_then(Value::as_str) {
                    self.model.session = Some(id.to_string());
                }
                self.model.session_result(&result);
                self.selections_note();
                let session = self.model.session.clone().unwrap_or_default();
                self.model.note(format!("세션 {session} 열림 · 폴더 {}", self.opts.cwd));
                self.note_row(
                    "_keeper/session",
                    json!({"sessionId": session, "cwd": self.opts.cwd, "agent": self.opts.name, "resume": self.resume_argv()}),
                );
                if self.mode == Mode::Switching {
                    self.mode = Mode::Acp;
                    self.mode_note("acp", "ready", json!({}));
                }
            }
        }
    }

    fn apply(&mut self, change: &Change, result: &Value) {
        let (selector, value) = match change {
            Change::Mode(id) => (self.model.modes.as_mut(), id),
            Change::Model(id) => (self.model.models.as_mut(), id),
            Change::Config { config, value } => (
                [self.model.modes.as_mut(), self.model.models.as_mut()]
                    .into_iter()
                    .flatten()
                    .find(|s| s.config_id.as_deref() == Some(config)),
                value,
            ),
        };
        if let Some(selector) = selector {
            selector.current = value.clone();
        }
        if let Some(options) = result.get("configOptions") {
            self.model.config_options(options);
        }
        self.model.note(format!("{value}(으)로 바꿈"));
        self.selections_note();
    }

    fn selections_note(&self) {
        self.note_row(
            "_keeper/selections",
            json!({"mode":self.model.modes.as_ref().map(|s| &s.current),"model":self.model.models.as_ref().map(|s| &s.current)}),
        );
    }

    fn on_client(&mut self, conn: u64, line: String) {
        let Some(mut msg) = rpc(&line) else { return };
        let by = format!("client-{conn}");
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        if self.stop.is_some() || self.quit {
            if let (Some(_), Some(id)) = (method, msg.get("id")) {
                self.reply(conn, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"the keeper is stopping"}}));
            }
            return;
        }
        match (method, msg.get("id").cloned()) {
            (None, Some(id)) => self.answer(&key_of(&id), &line, &by),
            (Some(_), Some(id)) if self.client_ids.contains(&(conn, key_of(&id))) => {
                self.note_row("_keeper/rejected", json!({"id": id, "by": by, "reason": "id already in flight"}));
                self.reply(conn, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32600, "message": "id already in flight"}}));
            }
            (Some(method), Some(id)) if method == "_keeper/open_terminal" => {
                let answer = match self.open_terminal(&by) {
                    Ok(()) => json!({"jsonrpc": "2.0", "id": id, "result": {"accepted": true, "argv": self.resume_argv()}}),
                    Err(reason) => json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32002, "message": reason}}),
                };
                self.reply(conn, &answer);
            }
            (Some(method), Some(id)) if method == "_keeper/tool_stop" => {
                if self.mode != Mode::Acp || self.hold.is_some() {
                    self.reply(conn, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"held by a person"}}));
                } else {
                    self.stop = Some(ToolStop {
                        conn,
                        id,
                        deadline: Instant::now() + Duration::from_secs(1),
                    });
                    self.cancel_pending(None, &by);
                    if self.answering.is_empty() {
                        self.finish_stop();
                    }
                }
            }
            (Some(_), Some(id)) if self.mode != Mode::Acp => {
                self.note_row("_keeper/rejected", json!({"id": id, "by": by, "reason": "terminal mode"}));
                self.reply(
                    conn,
                    &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32002, "message": "the agent's real TUI has the conversation"}}),
                );
            }
            (Some(method), Some(id)) => {
                if self.agent.is_none() {
                    self.reply(conn, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": "the agent is not accepting requests"}}));
                    return;
                }
                self.client_ids.insert((conn, key_of(&id)));
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                if matches!(method.as_str(), "_keeper/hold" | "_keeper/release" | "_keeper/tool_prompt") {
                    if self.model.session.is_none() || params.get("sessionId").and_then(Value::as_str) != self.model.session.as_deref() {
                        self.client_ids.remove(&(conn, key_of(&id)));
                        self.reply(conn, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"session changed"}}));
                        return;
                    }
                    if method == "_keeper/hold" {
                        self.next += 1;
                        let generation = self.next;
                        self.hold = Some(generation);
                        self.note_row("_keeper/hold_changed", json!({"generation":generation}));
                        let route = format!("hold-{generation}");
                        self.routes.insert(route.clone(), Route { conn, id, change: None });
                        let session = self.model.session.clone();
                        let cancel = json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":session}});
                        self.queue(&cancel.to_string(), Some(Receipt::Hold { route, generation }));
                        self.cancel_pending(session.as_deref(), &by);
                        return;
                    }
                    if method == "_keeper/release" {
                        self.client_ids.remove(&(conn, key_of(&id)));
                        if self.hold.is_some() && self.hold == params.get("generation").and_then(Value::as_u64) {
                            self.hold = None;
                            self.note_row("_keeper/hold_changed", json!({"generation":null}));
                            self.reply(conn, &json!({"jsonrpc":"2.0","id":id,"result":{"released":true}}));
                        } else {
                            self.reply(conn, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"hold changed"}}));
                        }
                        return;
                    }
                    if self.hold.is_some() {
                        self.client_ids.remove(&(conn, key_of(&id)));
                        self.reply(conn, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"held by a person"}}));
                        return;
                    }
                    let expected = msg.remove("expectedMode");
                    if !self.prompts.is_empty() || !self.model.pending.is_empty() {
                        self.client_ids.remove(&(conn, key_of(&id)));
                        self.reply(conn, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32005,"message":"a turn or decision is already pending"}}));
                        return;
                    }
                    if self.model.modes.is_none()
                        || self.routes.values().any(|r| r.change.is_some())
                        || expected.as_ref().and_then(Value::as_str) != self.model.modes.as_ref().map(|m| m.current.as_str())
                    {
                        self.client_ids.remove(&(conn, key_of(&id)));
                        self.reply(conn, &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32004,"message":"permission ceiling not proven"}}));
                        return;
                    }
                    msg.insert("method".into(), json!("session/prompt"));
                }
                self.next += 1;
                let routed = Value::String(format!("{by}-{}", self.next));
                let key = key_of(&routed);
                let receipt = Receipt::Request { conn, id: id.clone() };
                if matches!(method.as_str(), "session/prompt" | "_keeper/tool_prompt") && params.get("sessionId").and_then(Value::as_str) == self.model.session.as_deref() {
                    self.prompts.insert(key.clone());
                    self.model.working = true;
                }
                self.routes.insert(
                    key,
                    Route {
                        conn,
                        id,
                        change: Change::of(&method, &params).filter(|_| params.get("sessionId").and_then(Value::as_str) == self.model.session.as_deref()),
                    },
                );
                msg.insert("id".into(), routed);
                self.queue(&Value::Object(msg).to_string(), Some(receipt));
            }
            (Some(_), None) if self.mode != Mode::Acp => {}
            (Some(method), None) => {
                self.forward(&line);
                if method == "session/cancel" {
                    let session = msg.get("params").and_then(|p| p.get("sessionId")).and_then(Value::as_str).map(str::to_string);
                    self.cancel_pending(session.as_deref(), &by);
                }
            }
            (None, None) => {}
        }
    }

    /// Reserve the first valid answer while the writer sends it; only its receipt resolves the card.
    fn answer(&mut self, key: &str, raw: &str, by: &str) {
        let mut answer: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let id: Value = serde_json::from_str(key).unwrap_or(Value::Null);
        if let Some(reason) = self.model.pending.iter().find(|p| p.key == key).and_then(|p| invalid_answer(p, &answer)) {
            self.note_row("_keeper/dropped", json!({"id": id, "by": by, "reason": reason}));
            return;
        }
        if self.agent.is_none() {
            self.note_row("_keeper/dropped", json!({"id": id, "by": by, "reason": "the agent that asked it is gone"}));
            return;
        }
        let Some(wire_id) = self.agent_ids.get(key).filter(|_| !self.answering.contains(key)) else {
            self.note_row(
                "_keeper/dropped",
                json!({"id": id, "by": by, "reason": "not pending (already answered or unknown)", "answering": self.answering.contains(key)}),
            );
            return;
        };
        let option = answer.pointer("/result/outcome/optionId").and_then(Value::as_str).map(str::to_string);
        let outcome = answer.pointer("/result/outcome/outcome").and_then(Value::as_str).map(str::to_string);
        answer["id"] = wire_id.clone();
        self.answering.insert(key.to_string());
        self.queue(
            &answer.to_string(),
            Some(Receipt::Answer(PendingAnswer {
                key: key.to_string(),
                by: by.to_string(),
                option,
                outcome,
            })),
        );
    }

    fn answer_written(&mut self, PendingAnswer { key, by, option, outcome }: PendingAnswer) {
        self.answering.remove(&key);
        let Some(pending) = self.model.resolve(&key) else {
            return;
        };
        self.agent_ids.remove(&key);
        self.note_row("_keeper/resolved", json!({"id": pending.id, "by": by, "optionId": option, "outcome": outcome, "seq": pending.seq}));
        let chosen = option.or(outcome).unwrap_or_else(|| "error".into());
        self.model.note(format!("승인 답함 ({by}): {chosen}"));
        if self.answering.is_empty() {
            self.finish_stop();
        }
    }

    pub fn stop_deadline(&self) -> Option<Instant> {
        self.stop.as_ref().map(|stop| stop.deadline)
    }

    pub fn finish_stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            // A closed or stuck pipe cannot acknowledge cancellation. Expire those cards
            // without recording a delivered answer, and still end the child.
            self.expire_pending("the keeper is stopping");
            self.quit = true;
            self.reply(stop.conn, &json!({"jsonrpc":"2.0","id":stop.id,"result":{"stopping":true}}));
        }
    }

    fn cancel_pending(&mut self, session: Option<&str>, by: &str) {
        let keys: Vec<(String, Value)> = self
            .model
            .pending
            .iter()
            .filter(|p| p.method == "session/request_permission" && (self.stop.is_some() || p.session.as_deref() == session) && !self.answering.contains(&p.key))
            .map(|p| (p.key.clone(), p.id.clone()))
            .collect();
        for (key, id) in keys {
            let raw = json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": {"outcome": "cancelled"}}}).to_string();
            self.answer(&key, &raw, "keeper-cancel");
        }
        self.model.note(format!("취소 보냄 ({by})"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

    fn hub(dir: &std::path::Path) -> (Hub, UnboundedReceiver<ToAgent>) {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        let (archive, _) = Archive::open(dir.join("archive.jsonl")).unwrap();
        let (tx, rx) = unbounded_channel();
        let opts = crate::parse(vec!["keeper".into(), dir.display().to_string(), "--".into(), "agent".into()]).unwrap();
        (Hub::new(Arc::new(archive), tx, opts, false, false), rx)
    }

    #[test]
    fn replay_keeps_the_approval_when_a_file_request_reuses_its_keeper_id() {
        let dir = std::env::temp_dir().join(format!("ak-unit-{}-fs-id", std::process::id()));
        let (mut hub, mut sent) = hub(&dir);
        hub.handle(Ev::Agent(0, json!({"jsonrpc": "2.0", "id": 1, "method": "session/request_permission", "params": {}}).to_string()));
        let id = hub.model.pending[0].id.clone();
        hub.handle(Ev::Agent(0, json!({"jsonrpc": "2.0", "id": id, "method": "fs/read_text_file", "params": {}}).to_string()));
        let response: Value = serde_json::from_slice(&sent.try_recv().unwrap().bytes).unwrap();
        assert_eq!(response["id"], id);
        let path = dir.join("archive.jsonl");
        drop(hub);
        let previous = Archive::open(path).unwrap().1;
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(previous.pending, vec![(id, 1)]);
    }

    #[test]
    fn requests_waiting_on_an_exited_agent_get_an_error() {
        let dir = std::env::temp_dir().join(format!("ak-unit-{}-gone", std::process::id()));
        let (mut hub, _sent) = hub(&dir);
        hub.model.session = Some("s".into());
        let prompt = |id: u64| json!({"jsonrpc": "2.0", "id": id, "method": "session/prompt", "params": {"sessionId": "s", "prompt": []}}).to_string();
        hub.handle(Ev::Client { conn: 1, line: prompt(1) });
        hub.agent_gone();
        hub.handle(Ev::Client { conn: 1, line: prompt(2) });
        let archive = std::fs::read_to_string(dir.join("archive.jsonl")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let errors: Vec<Value> = archive
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|r| r["dir"] == "to-client")
            .map(|r| serde_json::from_str::<Value>(r["raw"].as_str().unwrap()).unwrap())
            .filter(|m| m["error"].is_object())
            .map(|m| m["id"].clone())
            .collect();
        assert_eq!(errors, vec![json!(1), json!(2)]);
        assert!(!hub.model.working);
    }

    #[test]
    fn a_reused_id_is_refused_before_a_switch_is_asked_for() {
        let dir = std::env::temp_dir().join(format!("ak-unit-{}-reuse", std::process::id()));
        let (mut hub, _sent) = hub(&dir);
        hub.model.session = Some("s".into());
        hub.handle(Ev::Client {
            conn: 1,
            line: json!({"jsonrpc": "2.0", "id": 7, "method": "session/prompt", "params": {"sessionId": "s", "prompt": []}}).to_string(),
        });
        hub.handle(Ev::Client {
            conn: 1,
            line: json!({"jsonrpc": "2.0", "id": 7, "method": "_keeper/open_terminal"}).to_string(),
        });
        let archive = std::fs::read_to_string(dir.join("archive.jsonl")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let answers: Vec<Value> = archive
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap())
            .filter(|r| r["dir"] == "to-client")
            .map(|r| serde_json::from_str::<Value>(r["raw"].as_str().unwrap()).unwrap())
            .collect();
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0]["error"]["message"], "id already in flight", "the switch was asked for under an id in flight");
        assert!(!archive.contains("_keeper/switch_refused"));
    }

    #[test]
    fn a_clients_mode_and_model_change_reaches_the_header() {
        let dir = std::env::temp_dir().join(format!("ak-unit-{}-change", std::process::id()));
        let (mut hub, mut sent) = hub(&dir);
        hub.model.session = Some("s".into());
        hub.model.session_result(&json!({
            "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code", "name": "Code"}]},
            "models": {"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "One"}, {"modelId": "m2", "name": "Two"}]},
        }));
        let mut change = |hub: &mut Hub, id: u64, method: &str, params: Value| {
            hub.handle(Ev::Client {
                conn: 1,
                line: json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}).to_string(),
            });
            let forwarded: Value = serde_json::from_slice(&sent.try_recv().expect("forwarded to the agent").bytes).unwrap();
            hub.handle(Ev::Agent(0, json!({"jsonrpc": "2.0", "id": forwarded["id"], "result": {}}).to_string()));
        };
        change(&mut hub, 5, "session/set_model", json!({"sessionId": "s", "modelId": "m2"}));
        change(&mut hub, 6, "session/set_mode", json!({"sessionId": "s", "modeId": "code"}));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(hub.model.models.as_ref().unwrap().current, "m2");
        assert_eq!(hub.model.modes.as_ref().unwrap().current, "code");
        change(&mut hub, 7, "session/set_model", json!({"sessionId": "other", "modelId": "m1"}));
        assert_eq!(hub.model.models.as_ref().unwrap().current, "m2", "another session's change moved this session's header");
    }
}
