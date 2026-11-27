# ovis-acp-keeper

Holds one ACP agent for any number of clients: Ovis, when an agent calls another agent through
an Ovis tool, and runs nobody watches in a terminal. People see such a session in Ovis (chat and
cards); an agent a person opens runs as its real TUI instead. The keeper starts the agent on pipes
and is its only ACP client: it sends `initialize` and `session/new` (or `session/load`) itself,
so the session is open before any client attaches. Nothing in Ovis starts it yet.

```
ovis-acp-keeper ROOT [--cwd DIR] [--name NAME] [--resume 'CMD {session}' | '["CMD","{session}"]']
                [--session-meta JSON] [--mcp-servers ARRAY] [--config-options ARRAY] [--announce-subagents]
                [--ask-every-time] [--load SESSION] [--headless] -- AGENT [ARGS...]
```

`--config-options` goes on `session/new` as its `configOptions` (`[{"configId":"mode","value":"default"}]`):
an agent that takes them applies them before it answers, so the session never runs in another mode first.

ROOT is a directory private to the user (0700). The keeper keeps there:

| File | What |
|---|---|
| `archive.jsonl` | every JSON-RPC line in either direction and the keeper's own `_keeper/*` notes, one numbered row each: `{"seq","dir","ts","raw"}` with `dir` `to-agent`, `from-agent`, `keeper` or `to-client` (those also carry `"client"`) |
| `acp.sock` | clients connect here (on Windows `acp.pipe` names the pipe) |
| `keeper.lock` | held while a keeper runs; a second keeper in the same ROOT exits with `another keeper is running in ROOT` |
| `process.json` | the keeper's pid, the ACP agent's or the real TUI's, and their systemd scope |
| `agent.stderr` | the agent's stderr, appended across restarts |

A client sends `{"replay":N}` and gets rows N.. from the file, a
`{"through":seq,"pid":pid,"client":conn}` watermark, then live rows. Every client sees every row:
`acp.sock` is one shared log for the user's own clients (ROOT is private to the user), not a
per-client channel.

A client's requests reach the agent under an id of the keeper's own, and the answer comes back as
a `to-client` row addressed to that `client`, with the client's own id. A client reads the rows
addressed to its number, so clients that count ids alike never take each other's answers. Client
numbers and every id the keeper makes up count on across restarts in the same ROOT, so no row of
an earlier run looks like this run's. A client reusing an id still in flight gets error -32600. Once
the agent has exited, every request still waiting for it, and every new one, gets error -32603.

Every agent request is archived under a keeper id (`agent-N`), including `fs/*` and
`terminal/*` requests the keeper answers itself. An answer meant for one
approval therefore never resolves a later one the agent asks under the same id. The request waits
for the first answer from any client; the pane never answers one. That answer alone goes to the agent, under the
agent's own id. An answer to a permission request that is no outcome, or that selects an option the
agent did not offer, is dropped with a note, and the request stays pending.

## The pane and the real TUI

Without `--headless` and on a terminal (a herdr-core pane), the keeper shows one status line:
`ACP로 실행 중 · <agent> · 모델 … · 모드 …`, a running turn, how many approvals wait (answered in
Ovis), how many clients are attached, `F4: 진짜 TUI로 열기 · Ctrl+Q: 닫기`, and the last notice.
F4 and Ctrl+Q, without other modifiers, are the only keys it acts on; every other key is dropped.

F4, or a client's `_keeper/open_terminal` request, hands the pane to the agent's real TUI on the
same conversation, once the turn is over and nothing waits (otherwise `_keeper/switch_refused`
with the reason, and an error answer to the client). Once a switch is accepted nothing new reaches
the agent; it needs a terminal with job control. The keeper ends the ACP agent with its whole tree
(approvals it still asked are noted `_keeper/expired`), starts the resume command (`--resume`, or a default for gjc, agy, claude, codex, hermes and
opencode) in the agent's scope as the terminal's foreground job, and stops reading keys. Client
requests in the meantime get an error: one conversation is never driven by ACP and a live TUI at
once. When the TUI exits, the keeper takes the terminal back, ends what the TUI left, starts the
ACP agent again (on the terminal settings the pane started with, whatever the TUI left) and loads
the same session, now with the turns made in the TUI; if it cannot (or the agent does not offer
`loadSession`), `acp` `failed` says why, no other conversation takes its place, and F4 can still
reopen it in the TUI. While loading, the agent replays the whole conversation as `session/update`
rows: the rows between `acp` `start` and `acp` `ready` are that replay, turns made in the TUI
included, and a client that rebuilds a transcript replaces it with them. A TUI stopped with Ctrl+Z
is let go on at once (`_keeper/tui_continued`): the pane has no shell to bring it back. `_keeper/mode`
notes mark each step: `terminal` `start`/`ready`/`failed`, then `acp` `start`/`ready`/`failed`.
Switching needs job control (the pane's terminal) and is not built for Windows.

## Notes in the archive

| Note | When |
|---|---|
| `_keeper/ready`, `_keeper/session`, `_keeper/agent_exit` | start, session opened or loaded, agent ended |
| `_keeper/mode`, `_keeper/switch_refused` | the steps of a switch to the real TUI and back; a switch that was not allowed |
| `_keeper/resolved`, `_keeper/dropped` | the answer that went to the agent and who sent it; a later answer that did not (`answering`: another client's answer is still on its way to the agent) |
| `_keeper/auto_answered` | the agent asked for `fs/*` or `terminal/*`, which the keeper does not offer |
| `_keeper/client` | a client connected, with its number |
| `_keeper/rejected` | a client reused an id it still has in flight, or sent a request while the real TUI had the pane |
| `_keeper/oversize` | a line longer than 64 MiB was dropped (`dir`, `bytes`, `id`); a request among them is answered with an error so nobody waits for it (unless its id is longer than 64 KiB: then the note has no id) |
| `_keeper/expired` | an approval the agent that asked it can no longer receive, or one without a recorded delivery after restart |

## Ending and starting again

The agent leads its own process group. When the keeper ends (SIGTERM, SIGINT, SIGHUP, Ctrl+Q in
the pane, or the agent exiting with `--headless`) it sends the group SIGTERM, SIGKILL after
1.5 s, and stops the agent's scope. On
Linux the agent also dies with a keeper killed outright (`PR_SET_PDEATHSIG`). Where the user's
systemd is reachable, the agent runs in a transient scope named after ROOT
(`acp-keeper-<hash>.scope`, its command passed on without `# ovis-acp-keeper

Holds one ACP agent for any number of clients: Ovis, when an agent calls another agent through
an Ovis tool, and runs nobody watches in a terminal. People see such a session in Ovis (chat and
cards); an agent a person opens runs as its real TUI instead. The keeper starts the agent on pipes
and is its only ACP client: it sends `initialize` and `session/new` (or `session/load`) itself,
so the session is open before any client attaches. Nothing in Ovis starts it yet.

```
ovis-acp-keeper ROOT [--cwd DIR] [--name NAME] [--resume 'CMD {session}' | '["CMD","{session}"]']
                [--session-meta JSON] [--load SESSION] [--headless] -- AGENT [ARGS...]
```

ROOT is a directory private to the user (0700). The keeper keeps there:

| File | What |
|---|---|
| `archive.jsonl` | every JSON-RPC line in either direction and the keeper's own `_keeper/*` notes, one numbered row each: `{"seq","dir","ts","raw"}` with `dir` `to-agent`, `from-agent`, `keeper` or `to-client` (those also carry `"client"`) |
| `acp.sock` | clients connect here (on Windows `acp.pipe` names the pipe) |
| `keeper.lock` | held while a keeper runs; a second keeper in the same ROOT exits with `another keeper is running in ROOT` |
| `process.json` | the keeper's pid, the ACP agent's or the real TUI's, and their systemd scope |
| `agent.stderr` | the agent's stderr, appended across restarts |

A client sends `{"replay":N}` and gets rows N.. from the file, a
`{"through":seq,"pid":pid,"client":conn}` watermark, then live rows. Every client sees every row:
`acp.sock` is one shared log for the user's own clients (ROOT is private to the user), not a
per-client channel.

A client's requests reach the agent under an id of the keeper's own, and the answer comes back as
a `to-client` row addressed to that `client`, with the client's own id. A client reads the rows
addressed to its number, so clients that count ids alike never take each other's answers. Client
numbers and every id the keeper makes up count on across restarts in the same ROOT, so no row of
an earlier run looks like this run's. A client reusing an id still in flight gets error -32600. Once
the agent has exited, every request still waiting for it, and every new one, gets error -32603.

Every agent request is archived under a keeper id (`agent-N`), including `fs/*` and
`terminal/*` requests the keeper answers itself. An answer meant for one
approval therefore never resolves a later one the agent asks under the same id. The request waits
for the first answer from any client; the pane never answers one. That answer alone goes to the agent, under the
agent's own id. An answer to a permission request that is no outcome, or that selects an option the
agent did not offer, is dropped with a note, and the request stays pending.

## The pane and the real TUI

Without `--headless` and on a terminal (a herdr-core pane), the keeper shows one status line:
`ACP로 실행 중 · <agent> · 모델 … · 모드 …`, a running turn, how many approvals wait (answered in
Ovis), how many clients are attached, `F4: 진짜 TUI로 열기 · Ctrl+Q: 닫기`, and the last notice.
F4 and Ctrl+Q, without other modifiers, are the only keys it acts on; every other key is dropped.

F4, or a client's `_keeper/open_terminal` request, hands the pane to the agent's real TUI on the
same conversation, once the turn is over and nothing waits (otherwise `_keeper/switch_refused`
with the reason, and an error answer to the client). Once a switch is accepted nothing new reaches
the agent; it needs a terminal with job control. The keeper ends the ACP agent with its whole tree
(approvals it still asked are noted `_keeper/expired`), starts the resume command (`--resume`, or a default for gjc, agy, claude, codex, hermes and
opencode) in the agent's scope as the terminal's foreground job, and stops reading keys. Client
requests in the meantime get an error: one conversation is never driven by ACP and a live TUI at
once. When the TUI exits, the keeper takes the terminal back, ends what the TUI left, starts the
ACP agent again (on the terminal settings the pane started with, whatever the TUI left) and loads
the same session, now with the turns made in the TUI; if it cannot (or the agent does not offer
`loadSession`), `acp` `failed` says why, no other conversation takes its place, and F4 can still
reopen it in the TUI. While loading, the agent replays the whole conversation as `session/update`
rows: the rows between `acp` `start` and `acp` `ready` are that replay, turns made in the TUI
included, and a client that rebuilds a transcript replaces it with them. A TUI stopped with Ctrl+Z
is let go on at once (`_keeper/tui_continued`): the pane has no shell to bring it back. `_keeper/mode`
notes mark each step: `terminal` `start`/`ready`/`failed`, then `acp` `start`/`ready`/`failed`.
Switching needs job control (the pane's terminal) and is not built for Windows.

## Notes in the archive

| Note | When |
|---|---|
| `_keeper/ready`, `_keeper/session`, `_keeper/agent_exit` | start, session opened or loaded, agent ended |
| `_keeper/mode`, `_keeper/switch_refused` | the steps of a switch to the real TUI and back; a switch that was not allowed |
| `_keeper/resolved`, `_keeper/dropped` | the answer that went to the agent and who sent it; a later answer that did not |
| `_keeper/auto_answered` | the agent asked for `fs/*` or `terminal/*`, which the keeper does not offer |
| `_keeper/client` | a client connected, with its number |
| `_keeper/rejected` | a client reused an id it still has in flight, or sent a request while the real TUI had the pane |
| `_keeper/oversize` | a line longer than 64 MiB was dropped (`dir`, `bytes`, `id`); a request among them is answered with an error so nobody waits for it (unless its id is longer than 64 KiB: then the note has no id) |
| `_keeper/expired` | an approval the agent that asked it can no longer receive, or one without a recorded delivery after restart |

## Ending and starting again

The agent leads its own process group. When the keeper ends (SIGTERM, SIGINT, SIGHUP, Ctrl+Q in
the pane, or the agent exiting with `--headless`) it sends the group SIGTERM, SIGKILL after
1.5 s, and stops the agent's scope. On
Linux the agent also dies with a keeper killed outright (`PR_SET_PDEATHSIG`). Where the user's
systemd is reachable, the agent runs in a transient scope named after ROOT
 expansion), which holds the helpers that leave the group (a broker that calls
`setsid`); a keeper that starts in a ROOT whose keeper died stops that scope before it starts the
agent, so the agent's session is free to load. The group and the scope are ended as soon as the
agent exits, not when the pane closes. A user systemd that cannot be reached leaves the agent
without a scope (and an earlier scope unstopped).

Started again in the same ROOT, the keeper numbers on from the last whole row (a row cut short is
dropped), notes `_keeper/expired` for each approval nobody answered, and loads the last session it
noted, unless `--load` names another one. When the agent cannot load the noted session it gets a
new one; when it cannot load the one `--load` names, the status line says so and there is no session.
Nothing restarts a keeper by itself yet. A keeper that cannot write its archive (a full disk) stops
at once and takes the agent with it, rather than going on without a record; the row it was writing
is dropped on the next start.

## Memory

The keeper keeps no conversation: the archive file has it. What grows with a session is the
archive's row index, 8 bytes a row (a million rows, 8 MB), kept so that a replay can start at any
row. Each reading stream (the agent's stdout and every client) holds at most one line of 64 MiB
while it frames it.

## Checks

```bash
cargo test --manifest-path crates/acp-keeper/Cargo.toml
```

The tests in `tests/keeper.rs` run the keeper against `examples/fake_agent.rs`, a scripted agent,
and need Linux; `tests/pane.rs` runs it on a pseudo-terminal of its own, switches to a stand-in TUI
and back, and checks that keys in the pane never answer an approval. The ones about helpers that leave the process group need a user systemd and are
skipped, with a line saying so, without one. macOS and Windows build (`cargo check --target
aarch64-apple-darwin`, `--target x86_64-pc-windows-gnu`): on macOS the process group is all the
keeper ends, on Windows only the agent itself.
