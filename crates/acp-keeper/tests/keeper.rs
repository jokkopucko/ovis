#![cfg(target_os = "linux")]

mod common;

use common::*;
use serde_json::json;

const LIMIT: usize = 64 << 20;

#[tokio::test]
async fn a_stuck_scope_probe_does_not_stop_the_keeper_running() {
    use std::os::unix::fs::PermissionsExt;
    use std::process::Stdio;
    use std::time::Duration;

    let root = Root::new("stuck-scope");
    let probe = root.0.join("systemd-run");
    std::fs::write(&probe, "#!/bin/sh\n: >\"$0.ran\"\nexec /bin/sleep 7\n").unwrap();
    std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut keeper = tokio::process::Command::new(env!("CARGO_BIN_EXE_ovis-acp-keeper"));
    keeper.env("PATH", &root.0).arg(&root.0).args(["--headless", "--", "/bin/true"]).kill_on_drop(true).stdin(Stdio::null());
    let output = tokio::time::timeout(Duration::from_secs(6), keeper.output()).await.expect("the scope probe blocked startup").unwrap();
    assert!(probe.with_extension("ran").exists());
    assert!(output.status.success());
    assert_eq!(output.stdout, b"KEEPER_READY\n");
}

#[test]
fn an_archive_write_error_stops_the_keeper_and_its_agent() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let root = Root::new("write-error");
    let stderr = root.0.join("keeper.stderr");
    let mut child = Command::new("/bin/sh")
        .args(["-c", "ulimit -f 64; trap '' XFSZ; exec \"$@\"", "sh"])
        .arg(env!("CARGO_BIN_EXE_ovis-acp-keeper"))
        .arg(&root.0)
        .args(["--headless", "--"])
        .arg(fake_agent())
        .arg("--linger")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(&stderr).unwrap())
        .spawn()
        .unwrap();
    let mut ready = BufReader::new(child.stdout.take().unwrap());
    let mut keeper = Keeper { child, stderr };
    let mut line = String::new();
    ready.read_line(&mut line).unwrap();
    assert_eq!(line, "KEEPER_READY\n");
    let mut client = Client::connect(&root);
    let session = client.session();
    let agent = process_json(&root)["child"].as_i64().unwrap().try_into().unwrap();
    client.send(&prompt(1, &session, &format!("helpers {}", root.0.display())));
    client.turn_end("the helpers turn");
    let (group, own_session) = helpers(&root);
    let _reap = Reap(vec![agent, group, own_session]);
    client.send(&prompt(2, &session, &"x".repeat(128 * 1024)));
    assert_eq!(keeper.wait_exit().code(), Some(1));
    assert!(wait_gone(agent), "the agent outlived the failed keeper");
    assert!(wait_gone(group), "the agent's helper outlived the failed keeper");
    let archive = std::fs::read(root.0.join("archive.jsonl")).unwrap();
    assert_ne!(archive.last(), Some(&b'\n'), "the file limit must cut a row short");
}

#[test]
fn an_approval_answer_is_not_resolved_when_the_agent_closed_stdin() {
    let root = Root::new("closed-input");
    let _keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, "ask-and-close-input"));
    let asked = client.wait("the approval", |r| method(r) == Some("session/request_permission"));
    let id = &asked["msg"]["id"];
    client.send(&json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}}));
    let fate = client.wait("the approval's fate", |r| matches!(method(r), Some("_keeper/resolved" | "_keeper/expired")));
    assert_eq!(method(&fate), Some("_keeper/expired"));
    assert_eq!(&fate["msg"]["params"]["id"], id);
    let answer = client.answer(json!(1));
    assert_eq!(answer["msg"]["error"]["code"], -32603);
}

#[test]
fn a_prompt_above_the_old_line_limit_reaches_the_agent() {
    let root = Root::new("big-prompt");
    let _keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    let text = format!("echo {}", "y".repeat(1_500_000));
    client.send(&prompt(1, &session, &text));
    let want = format!("echo bytes={}", text.len());
    client.wait("the agent's echo of the 1.5 MB prompt", |r| chunk_text(r) == Some(want.as_str()));
}

#[test]
fn a_line_over_the_limit_is_noted_and_its_request_answered() {
    let root = Root::new("oversize");
    let _keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();

    let params = json!({"sessionId": session, "prompt": [{"type": "text", "text": "z".repeat(LIMIT)}]});
    let line = format!("{{\"jsonrpc\":\"2.0\",\"method\":\"session/prompt\",\"params\":{params},\"id\":7}}");
    client.send_raw(format!("{line}\n").as_bytes());
    let note = client.wait("the note on the client's oversize line", |r| method(r) == Some("_keeper/oversize"));
    assert_eq!(note["msg"]["params"]["dir"], "from-client");
    assert_eq!(note["msg"]["params"]["bytes"], line.len());
    assert_eq!(note["msg"]["params"]["id"], 7);
    let answer = client.answer(json!(7));
    assert_eq!(answer["msg"]["error"]["code"], -32600);

    client.send(&prompt(8, &session, &format!("big {}", LIMIT + 10)));
    let note = client.wait("the note on the agent's oversize line", |r| method(r) == Some("_keeper/oversize"));
    assert_eq!(note["msg"]["params"]["dir"], "from-agent");
    assert_eq!(note["msg"]["params"]["bytes"], LIMIT + 10);
    client.turn_end("the turn after the agent's oversize line");
}

#[test]
fn sigterm_ends_every_process_the_agent_started() {
    let root = Root::new("sigterm");
    let mut keeper = Keeper::start(&root, &["--linger"]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, &format!("helpers {}", root.0.display())));
    client.turn_end("the helpers turn");
    let agent = process_json(&root)["child"].as_i64().expect("child pid") as i32;
    let (group, own_session) = helpers(&root);
    let _reap = Reap(vec![agent, group, own_session]);

    keeper.signal(libc::SIGTERM);
    keeper.wait_exit();
    assert!(wait_gone(agent), "the agent outlived the keeper");
    assert!(wait_gone(group), "the helper in the agent's process group outlived the keeper");
    if scope_available() {
        assert!(wait_gone(own_session), "the helper in its own session outlived the keeper");
    } else {
        eprintln!("no user systemd scope here: the helper in its own session is not checked");
    }
}

#[test]
fn sigkill_of_the_keeper_takes_the_agent_with_it() {
    let root = Root::new("sigkill");
    let mut keeper = Keeper::start(&root, &["--linger"]);
    Client::connect(&root).session();
    let agent = process_json(&root)["child"].as_i64().expect("child pid") as i32;
    let _reap = Reap(vec![agent]);

    keeper.signal(libc::SIGKILL);
    keeper.wait_exit();
    assert!(wait_gone(agent), "the agent outlived a killed keeper");
}

#[test]
fn restarts_in_the_same_root_and_loads_the_last_session() {
    let root = Root::new("restart");
    let mut first = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let opened = client.wait("the session note", |r| method(r) == Some("_keeper/session"));
    let session = opened["msg"]["params"]["sessionId"].as_str().expect("session id").to_string();
    client.send(&prompt(1, &session, "echo first run"));
    let first_answer = client.answer(json!(1));
    drop(client);
    first.signal(libc::SIGKILL);
    first.wait_exit();

    let _second = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let load = client.wait("the load of the last session", |r| {
        r["dir"] == "to-agent" && method(r) == Some("session/load") && r["msg"]["params"]["sessionId"] == session.as_str()
    });
    assert!(load["seq"].as_u64() > opened["seq"].as_u64(), "the archive did not continue its numbering");
    let loaded = client.wait("the loaded session's note", |r| method(r) == Some("_keeper/session") && r["seq"].as_u64() > load["seq"].as_u64());
    client.send(&prompt(1, &session, "echo second run"));
    let answer = client.answer(json!(1));
    assert!(
        answer["seq"].as_u64() > loaded["seq"].as_u64(),
        "the first run's answer to client {} was taken for this run's",
        first_answer["client"]
    );

    let mut seqs = vec![];
    let mut addressed = vec![];
    let mut replay = Client::connect(&root);
    replay.wait("every row up to the answer, in order", |r| {
        seqs.push(r["seq"].as_u64().expect("seq"));
        if r["dir"] == "to-client" && r["client"].as_u64() == client.conn {
            addressed.push(r["seq"].as_u64().expect("seq"));
        }
        r["seq"] == answer["seq"]
    });
    assert_eq!(seqs, (1..=answer["seq"].as_u64().unwrap()).collect::<Vec<_>>());
    assert_eq!(addressed, vec![answer["seq"].as_u64().unwrap()], "rows of an earlier run carry this client's number");
}

#[test]
fn tool_stop_cancels_the_pending_approval_before_acknowledging_shutdown() {
    let root = Root::new("stop-approval");
    let mut keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, "ask"));
    let ask = client.wait("the approval request", |r| r["dir"] == "from-agent" && method(r) == Some("session/request_permission"));
    client.send(&json!({"jsonrpc":"2.0","id":2,"method":"_keeper/tool_stop","params":{}}));

    let mut resolution = None;
    let receipt = client.wait("the stop receipt", |r| {
        if method(r) == Some("_keeper/resolved") {
            assert!(resolution.is_none(), "the approval was resolved twice");
            resolution = Some(r["msg"]["params"].clone());
        }
        r["dir"] == "to-client" && r["msg"]["id"] == 2
    });
    assert_eq!(receipt["msg"]["result"], json!({"stopping": true}), "{receipt}");
    let resolved = resolution.expect("the approval must close before stop is acknowledged");
    assert_eq!(resolved["id"], ask["msg"]["id"]);
    assert_eq!(resolved["outcome"], "cancelled");
    assert_eq!(resolved["optionId"], serde_json::Value::Null);
    assert!(keeper.wait_exit().success());
}

#[test]
fn restart_expires_the_dead_agents_pending_approval() {
    let root = Root::new("expire");
    let mut first = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, "ask"));
    let asked = client.wait("the approval request", |r| r["dir"] == "from-agent" && method(r) == Some("session/request_permission"));
    drop(client);
    first.signal(libc::SIGKILL);
    first.wait_exit();

    let _second = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let expired = client.wait("the expiry of the old approval", |r| method(r) == Some("_keeper/expired"));
    assert_eq!(expired["msg"]["params"]["id"], asked["msg"]["id"]);
    assert_eq!(expired["msg"]["params"]["seq"], asked["seq"]);
}

#[test]
fn restart_clears_what_the_dead_keeper_left_running() {
    if !scope_available() {
        eprintln!("no user systemd scope here: skipped");
        return;
    }
    let root = Root::new("leftovers");
    let mut first = Keeper::start(&root, &["--linger"]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, &format!("helpers {}", root.0.display())));
    client.turn_end("the helpers turn");
    let agent = process_json(&root)["child"].as_i64().expect("child pid") as i32;
    let (group, own_session) = helpers(&root);
    let _reap = Reap(vec![agent, group, own_session]);
    drop(client);
    first.signal(libc::SIGKILL);
    first.wait_exit();

    let _second = Keeper::start(&root, &[]);
    assert!(wait_gone(group), "the helper in the dead agent's process group survived the restart");
    assert!(wait_gone(own_session), "the helper in its own session survived the restart");
}

#[test]
fn refuses_to_start_beside_a_live_keeper() {
    let root = Root::new("twice");
    let _first = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();

    let (mut second, stderr) = spawn(&root.0, &[]);
    let _reap = Reap(vec![second.id() as i32]);
    assert!(wait_gone(second.id() as i32), "a second keeper kept running on a live ROOT");
    let status = second.wait().expect("second keeper status");
    let said = std::fs::read_to_string(&stderr).unwrap_or_default();
    let _ = std::fs::remove_file(&stderr);
    assert!(!status.success(), "a second keeper started on a live ROOT");
    assert!(said.contains("running"), "the refusal names the running keeper: {said}");

    client.send(&prompt(1, &session, "echo still here"));
    client.wait("the first keeper's next turn", |r| chunk_text(r) == Some("echo bytes=15"));
}

#[test]
fn request_ids_of_different_clients_do_not_collide() {
    let root = Root::new("ids");
    let _keeper = Keeper::start(&root, &[]);
    let mut first = Client::connect(&root);
    let session = first.session();
    first.send(&prompt(1, &session, "hold"));
    first.wait("the held prompt on its way", |r| r["dir"] == "to-agent" && method(r) == Some("session/prompt"));
    drop(first);

    let mut second = Client::connect(&root);
    second.send(&prompt(1, &session, "echo second"));
    let answer = second.answer(json!(1));
    assert_eq!(answer["msg"]["result"]["stopReason"], "end_turn");
    second.send(&prompt(2, &session, "release"));
    second.answer(json!(2));

    let mut answers_to_one = 0;
    let mut late = Client::connect(&root);
    let conn = second.conn;
    let release = late.wait("the release turn's answer", |r| {
        if r["dir"] == "to-client" && r["client"].as_u64() == conn && r["msg"]["id"] == 1 {
            answers_to_one += 1;
        }
        r["dir"] == "to-client" && r["client"].as_u64() == conn && r["msg"]["id"] == 2
    });
    assert!(release["msg"]["result"].is_object());
    assert_eq!(answers_to_one, 1, "the held prompt's late answer went to the second client as its id 1");
}

#[test]
fn a_late_answer_never_reaches_a_later_approval() {
    let root = Root::new("late");
    let _keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    let ask = |client: &mut Client, id: u64| {
        client.send(&prompt(id, &session, "ask"));
        client.wait("an approval request", |r| r["dir"] == "from-agent" && method(r) == Some("session/request_permission"))
    };
    let first = ask(&mut client, 1);
    let allow = json!({"jsonrpc": "2.0", "id": first["msg"]["id"], "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}});
    client.send(&allow);
    client.answer(json!(1));
    let second = ask(&mut client, 2);
    client.send(&allow);
    let late = client.wait("the late answer's fate", |r| matches!(method(r), Some("_keeper/dropped" | "_keeper/resolved")));
    assert_eq!(method(&late), Some("_keeper/dropped"), "an answer to the first approval resolved the second");
    client.send(&json!({"jsonrpc": "2.0", "id": second["msg"]["id"], "result": {"outcome": {"outcome": "selected", "optionId": "reject"}}}));
    client.wait("the agent's word on the second approval", |r| chunk_text(r) == Some("answered reject"));
}

#[test]
fn the_last_lines_of_an_exiting_agent_are_archived() {
    let root = Root::new("last-lines");
    let mut keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, "quit"));
    keeper.wait_exit();
    let archive = std::fs::read_to_string(root.0.join("archive.jsonl")).expect("archive");
    assert!(archive.contains(r#"\"text\":\"bye\""#), "the agent's last line is missing from the archive");
}

#[test]
fn client_numbers_go_on_without_answers() {
    let root = Root::new("numbers");
    let mut first = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let before = client.number();
    drop(client);
    first.signal(libc::SIGTERM);
    first.wait_exit();

    let _second = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    assert!(client.number() > before, "the restarted keeper numbered its first client like the last run's");
}

#[test]
fn an_answer_that_is_no_permission_outcome_leaves_the_approval_pending() {
    let root = Root::new("invalid-answer");
    let _keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, "ask"));
    let ask = client.wait("the approval request", |r| r["dir"] == "from-agent" && method(r) == Some("session/request_permission"));
    let id = ask["msg"]["id"].clone();
    client.send(&json!({"jsonrpc": "2.0", "id": id, "result": {}}));
    let dropped = client.wait("the invalid answer's note", |r| matches!(method(r), Some("_keeper/dropped" | "_keeper/resolved")));
    assert_eq!(method(&dropped), Some("_keeper/dropped"), "an empty result resolved the approval");
    client.send(&json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": {"outcome": "selected", "optionId": "nope"}}}));
    let dropped = client.wait("the unknown option's note", |r| {
        matches!(method(r), Some("_keeper/dropped" | "_keeper/resolved")) && r["seq"].as_u64() > dropped["seq"].as_u64()
    });
    assert_eq!(method(&dropped), Some("_keeper/dropped"), "an option the agent did not offer resolved the approval");
    client.send(&json!({"jsonrpc": "2.0", "id": id, "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}}));
    client.wait("the agent's word on the approval", |r| chunk_text(r) == Some("answered allow"));
}

#[test]
fn an_answer_written_just_before_the_agent_exits_reaches_its_client() {
    let root = Root::new("last-answer");
    let mut keeper = Keeper::start(&root, &[]);
    let mut client = Client::connect(&root);
    let session = client.session();
    client.send(&prompt(1, &session, "answer-and-quit"));
    let answer = client.answer(json!(1));
    assert_eq!(answer["msg"]["result"]["stopReason"], "end_turn", "the agent's last answer became an exit error");
    keeper.wait_exit();
}
