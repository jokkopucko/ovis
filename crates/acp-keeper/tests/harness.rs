#![cfg(target_os = "linux")]

mod common;

use common::{fake_agent, method, Client, Keeper, Root};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[test]
fn mcp_servers_flag_reaches_session_new_and_load() {
    let root = Root::new("mcp");
    let servers = json!([{"name":"ovis-agent","command":"/test/relay","args":["--token-file","/test/token"],"env":[]}]);
    for opening in ["session/new", "session/load"] {
        let stderr = root.0.join("keeper.stderr");
        let child = Command::new(env!("CARGO_BIN_EXE_ovis-acp-keeper"))
            .arg(&root.0)
            .args(["--headless", "--announce-subagents", "--mcp-servers", &servers.to_string(), "--"])
            .arg(fake_agent())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(&stderr).unwrap())
            .spawn()
            .unwrap();
        let mut keeper = Keeper { child, stderr };
        let mut ready = String::new();
        BufReader::new(keeper.child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "KEEPER_READY");
        let mut client = Client::connect(&root);
        let initialize = client.wait("initialize", |r| method(r) == Some("initialize"));
        assert_eq!(initialize["msg"]["params"]["clientCapabilities"]["subagents"], json!({}));
        let session = client.wait(opening, |r| method(r) == Some(opening));
        assert_eq!(session["msg"]["params"]["mcpServers"], servers);
        client.session();
    }
}

#[test]
fn launch_settings_reach_session_new_and_load() {
    let root = Root::new("config");
    let options = json!([{"configId":"mode","value":"default"}]);
    let meta = json!({"claudeCode":{"options":{"settingSources":[]}}});
    for opening in ["session/new", "session/load"] {
        let stderr = root.0.join("keeper.stderr");
        let child = Command::new(env!("CARGO_BIN_EXE_ovis-acp-keeper"))
            .arg(&root.0)
            .args(["--headless", "--config-options", &options.to_string(), "--session-meta", &meta.to_string(), "--"])
            .arg(fake_agent())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(std::fs::File::create(&stderr).unwrap())
            .spawn()
            .unwrap();
        let mut keeper = Keeper { child, stderr };
        let mut ready = String::new();
        BufReader::new(keeper.child.stdout.take().unwrap()).read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "KEEPER_READY");
        let mut client = Client::connect(&root);
        let session = client.wait(opening, |r| method(r) == Some(opening));
        assert_eq!(session["msg"]["params"]["configOptions"], options);
        assert_eq!(session["msg"]["params"]["_meta"], meta);
        client.session();
    }
}

#[test]
fn mcp_servers_flag_rejects_what_is_not_an_array() {
    let root = Root::new("bad-mcp");
    let output = Command::new(env!("CARGO_BIN_EXE_ovis-acp-keeper"))
        .arg(&root.0)
        .args(["--mcp-servers", "{}", "--", "/bin/true"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("array"));
}
