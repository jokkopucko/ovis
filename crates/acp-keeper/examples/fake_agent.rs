//! A scripted ACP agent for the keeper's tests. It answers `initialize`, `session/new`,
//! `session/load` and the mode and model setters (with an empty result and no update, like an
//! agent that only answers), and runs the first word of each prompt as a command:
//!
//! - `echo ...`: one `agent_message_chunk` saying `echo bytes=<prompt length>`, then the end of the turn
//! - `hold`: no answer until a later `release`, which answers every held prompt before itself
//! - `helpers DIR`: starts a `sleep` in the agent's process group and one in a new session (as an
//!   agent's broker does), writes `group PID` and `session PID` lines to DIR/helpers, ends the turn
//! - `ask`: a `session/request_permission`; the turn ends with a chunk naming the answer
//! - `answer-and-quit`: the end of the turn, then the agent exits
//! - `quit`: one `agent_message_chunk` saying `bye`, then the agent exits without answering
//! - `big N`: one `agent_message_chunk` line of exactly N bytes, then the end of the turn
//!
//! `session/load` adopts the loaded id, and fails while the file named by `--refuse-load FILE`
//! exists; with `--no-load` the agent does not offer `loadSession`. With `--ask-on-close` it asks for one more approval as its stdin closes, and with
//! `--linger` it stays alive after that, as an agent busy elsewhere would. With `--exit-after-session` it exits
//! right after answering `session/new`.

use std::io::{BufRead, Write};

use serde_json::{json, Value};

fn send(out: &mut impl Write, msg: &Value) {
    let mut line = msg.to_string();
    line.push('\n');
    out.write_all(line.as_bytes()).expect("stdout");
    out.flush().expect("stdout");
}

fn chunk(session: &str, text: &str) -> Value {
    json!({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session, "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})
}

fn end_turn(id: &Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": {"stopReason": "end_turn"}})
}

#[cfg(unix)]
fn helpers(dir: &str) {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let start = |command: &mut Command| command.arg("600").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().expect("sleep").id();
    let group = start(&mut Command::new("sleep"));
    let mut own = Command::new("sleep");
    unsafe {
        own.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let session = start(&mut own);
    std::fs::write(format!("{dir}/helpers"), format!("group {group}\nsession {session}\n")).expect("helpers file");
}

#[cfg(not(unix))]
fn helpers(_dir: &str) {}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let refuse_load = args.iter().position(|a| a == "--refuse-load").and_then(|at| args.get(at + 1)).cloned();
    let refuse_session = args.iter().position(|a| a == "--refuse-session").and_then(|at| args.get(at + 1)).and_then(|s| s.parse::<i64>().ok());
    let mut session = format!("fake-{}", std::process::id());
    let mut out = std::io::stdout().lock();
    let mut held: Vec<Value> = vec![];
    let mut asked: Option<Value> = None;
    let mut always = false;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        if method.is_empty() {
            if id == json!("question") {
                if let Some(prompt) = asked.take() {
                    send(&mut out, &chunk(&session, &msg["result"].to_string()));
                    send(&mut out, &end_turn(&prompt));
                }
            } else if id == json!("perm-1") {
                if let Some(prompt) = asked.take() {
                    let outcome = msg
                        .pointer("/result/outcome/optionId")
                        .or(msg.pointer("/result/outcome/outcome"))
                        .and_then(Value::as_str)
                        .unwrap_or("error");
                    always |= outcome == "always";
                    send(&mut out, &chunk(&session, &format!("answered {outcome}")));
                    send(&mut out, &end_turn(&prompt));
                }
            }
            continue;
        }
        if id.is_null() {
            if method == "fixture/ask" && asked.is_none() {
                if let Some(prompt) = held.pop() {
                    asked = Some(prompt);
                    send(
                        &mut out,
                        &json!({"jsonrpc":"2.0","id":"perm-1","method":"session/request_permission","params":{
                            "sessionId":session,"toolCall":{"toolCallId":"held","title":"a deferred request","kind":"execute"},
                            "options":[{"optionId":"reject","name":"Reject","kind":"reject_once"}]
                        }}),
                    );
                }
            }
            if method == "session/cancel" && msg.pointer("/params/sessionId").and_then(Value::as_str) == Some(&session) {
                for prompt in held.drain(..) {
                    send(&mut out, &json!({"jsonrpc":"2.0","id":prompt,"result":{"stopReason":"cancelled"}}));
                }
            }
            continue;
        }
        let result = match method {
            "initialize" => json!({"protocolVersion": 1, "agentCapabilities": {"loadSession": !args.iter().any(|a| a == "--no-load")}}),
            "session/new" if refuse_session.is_some() => {
                send(&mut out, &json!({"jsonrpc":"2.0","id":id,"error":{"code":refuse_session,"message":"session refused"}}));
                continue;
            }
            "session/new" => {
                let opened = json!({
                    "sessionId": session,
                    "modes": {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}, {"id": "code", "name": "Code"}]},
                    "models": {"currentModelId": "m1", "availableModels": [{"modelId": "m1", "name": "One"}, {"modelId": "m2", "name": "Two"}]},
                });
                if args.iter().any(|a| a == "--exit-after-session") {
                    send(&mut out, &json!({"jsonrpc": "2.0", "id": id, "result": opened}));
                    std::process::exit(0);
                }
                opened
            }
            "session/load" if refuse_load.as_ref().is_some_and(|f| std::path::Path::new(f).exists()) => {
                send(&mut out, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32603, "message": "the session is locked"}}));
                continue;
            }
            "session/load" => {
                session = msg.pointer("/params/sessionId").and_then(Value::as_str).unwrap_or(&session).to_string();
                json!({})
            }
            "session/set_mode" | "session/set_model" | "session/set_config_option" => json!({}),
            "session/prompt" => {
                let text = msg.pointer("/params/prompt/0/text").and_then(Value::as_str).unwrap_or("").to_string();
                let mut words = text.split_whitespace();
                match words.next().unwrap_or("") {
                    "fixture-stop-reason" => {
                        send(&mut out, &json!({"jsonrpc":"2.0","id":id,"result":{"stopReason":"fixture annotation"}}));
                        continue;
                    }
                    "echo" => send(&mut out, &chunk(&session, &format!("echo bytes={}", text.len()))),
                    "hold" => {
                        held.push(id);
                        continue;
                    }
                    "release" => {
                        for prompt in held.drain(..) {
                            send(&mut out, &end_turn(&prompt));
                        }
                    }
                    "helpers" => helpers(words.next().unwrap_or(".")),
                    "elicit" => {
                        let mut params: Value = serde_json::from_str(text.strip_prefix("elicit ").unwrap()).unwrap();
                        params["sessionId"] = json!(session);
                        asked = Some(id);
                        send(&mut out, &json!({"jsonrpc":"2.0","id":"question","method":"elicitation/create","params":params}));
                        continue;
                    }
                    "question" => {
                        asked = Some(id);
                        send(
                            &mut out,
                            &json!({"jsonrpc":"2.0","id":"question","method":"elicitation/create","params":{
                            "mode":"form","sessionId":session,"toolCallId":"tool-1","message":"Questions","requestedSchema":{
                                "type":"object","properties":{"q0":{"type":"string","title":"Color","description":"Which color?",
                                    "oneOf":[{"const":"red","title":"Red"},{"const":"blue","title":"Blue"}]}},"required":["q0"]}}}),
                        );
                        continue;
                    }
                    "widen" if always => send(&mut out, &chunk(&session, "already allowed here")),
                    "widen" | "ask" | "ask-and-close-input" | "end-and-close-input" => {
                        #[cfg(unix)]
                        if text.ends_with("-and-close-input") {
                            // SAFETY: this fixture owns its stdin; it stops reading after this row.
                            assert_eq!(unsafe { libc::close(libc::STDIN_FILENO) }, 0);
                        }
                        if text == "end-and-close-input" {
                            send(&mut out, &end_turn(&id));
                            loop {
                                std::thread::park();
                            }
                        }
                        asked = Some(id);
                        let title = if text == "widen" { "Request wider permissions" } else { "touch x" };
                        let mut options = vec![
                            json!({"optionId": "allow", "name": "Allow", "kind": "allow_once"}),
                            json!({"optionId": "reject", "name": "Reject", "kind": "reject_once"}),
                        ];
                        if text == "widen" {
                            options.push(json!({"optionId":"always","name":"Always allow","kind":"allow_always"}));
                        }
                        send(
                            &mut out,
                            &json!({"jsonrpc": "2.0", "id": "perm-1", "method": "session/request_permission", "params": {
                                "sessionId": session,
                                "toolCall": {"toolCallId": "t1", "title": title, "kind": "execute", "rawInput": {"command": title}},
                                "options": options,
                            }}),
                        );
                        if text == "ask-and-close-input" {
                            loop {
                                std::thread::park();
                            }
                        }
                        continue;
                    }
                    "answer-and-quit" => {
                        send(&mut out, &end_turn(&id));
                        std::process::exit(0);
                    }
                    "quit" => {
                        send(&mut out, &chunk(&session, "bye"));
                        std::process::exit(0);
                    }
                    "big" => {
                        let size: usize = words.next().and_then(|n| n.parse().ok()).unwrap_or(0);
                        let mut line = chunk(&session, "").to_string();
                        let pad = "x".repeat(size.saturating_sub(line.len()));
                        line = chunk(&session, &pad).to_string();
                        line.push('\n');
                        out.write_all(line.as_bytes()).expect("stdout");
                    }
                    _ => {}
                }
                json!({"stopReason": "end_turn"})
            }
            _ => {
                send(&mut out, &json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}}));
                continue;
            }
        };
        send(&mut out, &json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }
    if args.iter().any(|a| a == "--ask-on-close") {
        send(
            &mut out,
            &json!({"jsonrpc": "2.0", "id": "perm-close", "method": "session/request_permission", "params": {
                "sessionId": session,
                "toolCall": {"toolCallId": "t-close", "title": "rm -rf x", "kind": "execute"},
                "options": [{"optionId": "allow", "name": "Allow", "kind": "allow_once"}],
            }}),
        );
    }
    if args.iter().any(|a| a == "--linger") {
        loop {
            std::thread::park();
        }
    }
}
