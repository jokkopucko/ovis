# Harness contract (draft, H0)

The contract for Ovis's harness layer: what it says about machines, harnesses and sessions, the
harness tool Ovis hands to agents it starts, and the safety rules around both. The owner decided
D18, D19, D21 and D23 on 2026-11-24 and updated the D19 default on 2026-11-25
([decisions](#decisions)). For the local ACP implementation, see
[Ask another coding agent](harness-tool.md) and `shared/harness-contract.schema.json`. The terminal
fallback and starts on other machines below describe future work.

- Source: the direction plan `ovis-direction-1123` (`PLAN.ko.md`, revision 2), chapters 11 and 12
  and step H0 of 4.7. ACP background is in its chapters 10 and 13.
- Code cited at `origin/main` 1d71a718d (2026-11-24).
- Marks: **(read)** seen in the code or docs at that commit, **(plan)** taken from the plan,
  **(proposal)** this draft's own suggestion, **(unverified)** nobody has checked it.
- Revised on the owner's direction (2026-11-23 and 2026-11-24, relayed by Dori): Ovis drives the
  harness an agent asks for as the ACP client, and every approval goes to a person. See
  [the goal](#decisions) and [where ACP stands](#what-ovis-is-in-this-contract).
- Not in this draft: the M15 result table that H0's exit asks for. M15 is a measurement (does the
  Ovis path report turn end, the turn's last answer and a pending approval better than `hc wait` and
  `hc read`?). It has not run. If it fails, the harness tool keeps only the view and safety verbs and
  leaves send, wait and result to hc (plan, M15).

## Decisions

**The goal (owner, 2026-11-23).** With Ovis installed, an agent such as Claude Code or omo uses
other harnesses, Gemini CLI or agy (Antigravity) first, freely over ACP:

- The calling agent calls one tool Ovis gave it (ask another harness, or hand it a task).
- Ovis is the ACP client. It starts that harness, sends the task and returns the answer.
- The harness's conversation shows in Ovis's screens, under the agent that asked.
- Every permission request (`session/request_permission`) goes to a person as Ovis's approval card,
  never to the calling agent. An ask whose harness requests nothing, a read-only question, ends with
  no card.
- The calling agent never becomes the ACP client itself and never receives an approval request.
- Scope: this PC first.

The owner decided the four questions H0 waited on (2026-11-24, in the Dori session):

| # | Question | Decision | Where it lands |
|---|---|---|---|
| D18 | Does Ovis own a common harness-layer interface? | (c), as far as H2: this contract, the read-only commands for people (H1) and the harness tool handed to agents on this PC (H2). Another machine (H3) is not part of it yet. Ovis still never decides or hands out work (D22): it runs the one ask the calling agent made. | [Commands](#commands-and-the-code-they-use), the ACP drive path, [the safety rules](#safety-rules-g1g12) |
| D19 | What may an agent do through the harness tool? | View, start and send on this PC by default, subject to the launch checks. The person may narrow the list of harnesses, switch to view only or turn the tool off. Starting on another machine only through a person's approval card, every time. Answering a child's approval: never; only a person approves. Machine commands (`exec`, `file`) stay hc's and Ovis does not open them. | The `Scope` values in [the schema](#schema-draft); rules G2, G3 and G8 |
| D21 | What shape is the contract? | (a): one schema generates the types, and the commands' `--json` output is the stable surface. It survives a Rust port of the inside unchanged (plan 11.3). | [Schema](#schema-draft) |
| D23 | Default limits of the harness tool | Depth 1, settable up to 3. No limit on running children per parent (owner decision 2026-11-24). 60 minutes per child. 30 calls per minute per run. Cost is shown wherever the harness reports it. No further limit. | `Limits`; rules G4, G5 and G7 |

**How agents are run (owner, 2026-11-24).**

- An agent a person opens is a real TUI in a herdr-core terminal. Where the harness allows it,
  approvals also go through a hook or the server.
- ACP is used only when an agent calls another agent through Ovis's tool, and for runs no person
  is watching.
- People see an ACP run in Ovis's web chat and approval cards. The keeper program it runs under has
  no shared terminal screen of its own: its terminal shows one status line, and F4 there opens the
  session as the real TUI.
- A child's conversation shows in the sidebar under its parent.

Related decisions:

- D15, D16, D17 (ACP drive). The direction above turns D15 toward drive by Ovis for children an
  agent asks for and for unattended runs. The ACP agent process lives under a keeper program in a
  herdr-core terminal (plan 13, D16 (b)), so an Ovis server restart does not end its turn. Adapters
  (`claude-agent-acp`, `codex-acp`) are installed by the user; Ovis does not download them (D17).
- D20: how another machine is reached. hc machines come first, then a PC-to-PC path over the Ovis
  relay as H6.
- D9: how far hooks go. The turn-end hook in the G-rules and
  [results](#where-wait-and-result-come-from) assumes D9 reaches (c).

## What Ovis is in this contract

Ovis does not orchestrate (D22, received 2026-11-23). What to do and who does it is decided by an
orchestrator (dori, omo, a skill) or by the agent itself. Ovis has three roles (plan 12.1):

1. **The window people look through.** People see every agent, including the ones agents start,
   and answer their approvals. An agent a person opens is a real TUI in a herdr-core terminal that
   people can step into. An agent Ovis drives over ACP is drawn in Ovis's chat view, under its
   parent; F4 in its keeper's terminal opens it as the real TUI.
2. **The place agents get tools.** Ovis puts tools into an agent when it starts it (today the browser
   tool; next the harness tool and the memory tool).
3. **The safety rails.** Limits, human approval and a record for every agent an agent starts.

The harness tool therefore offers one start, one send and one result at a time, done safely. It has
no queue, schedule, automatic retry, fan-out, "look at the result and decide the next step", no
approval verb and no machine commands (plan 12.2). If any of these comes in, Ovis has become an
orchestrator.

**Where ACP stands.** ACP is a secondary channel beside the terminal (plan 10, 13; this replaces
the earlier "ACP is not Ovis's path"). In this contract it is four things:

- **The vocabulary.** Sessions, turns, `session/update` kinds, permission option kinds and stop
  reasons use ACP's names, whatever the transport.
- **How the harness tool drives a child (owner, 2026-11-23).** For a harness that speaks ACP
  (`drive` includes `acp`), Ovis runs the child as its ACP client. That changes plan 12.4 as
  follows:
  - The ACP connection is Ovis's. The calling agent holds none: it gets no socket, no ACP command
    and no adapter to run, only the harness tool's answers.
  - Every `session/request_permission` becomes a card for a person. For ask-every-time launches,
    the keeper forwards only `allow_once` and `reject_once`. The calling agent sees only
    `waiting_human` (G8 holds).
  - Ovis adds no approval of its own, so a child that requests nothing ends with no card.
  - Ovis offers the agent no client file or terminal methods (`fs/*`, `terminal/*`). ACP v2 drops
    them anyway (plan 10.1).
  - A harness without ACP is driven in a terminal instead (see the fallback after the schema).
- **A read channel.** An agent Ovis has no transcript reader for can be read with `session/list` and
  `session/load` once M13 shows that is safe (A2, D14). That surfaces as `transcript: "acp"` in the
  capabilities.
- **The keeper.** Each ACP child runs under a small keeper program in a herdr-core terminal
  (plan 13). The keeper owns the agent process, logs the messages with numbers so a reconnect can
  ask from where it left off, and shows one status line. An orchestrator that wants to drive an
  agent as data itself can use the same keeper.

Still blocked: the calling agent becoming the ACP client itself through Ovis and taking the child's
approvals ("option 1"). Ovis's tool never offers that. An agent with a shell can still run
`<agent> acp` on its own, as it can run `hc run`; nothing here stops that, and Ovis does not see it.

What ACP drive costs (plan 10.3): while driven over ACP, the child has no TUI to type into, and
menus, sign-in screens and other TUI-only features are out of reach. F4 hands the session to the
real TUI; whether each harness opens an ACP-made session there is **(unverified)** (M14).

## Schema draft

Per D21 (a), the source of truth would be one JSON Schema file, `shared/harness-contract.schema.json`
**(proposal)**, from which `bun run generate:types` writes `shared/harness-contract.generated.ts`,
the way it already writes `server/herdr-core/hc-api.generated.ts` from `scripts/hc-schema.json`
(read, `scripts/generate-protocol-types.ts`). Two generator rules carry over: an enum becomes a
union widened with `(string & {})`, so a value from a newer side still flows; and a caller that meets
a value it does not know falls back to the terminal level instead of failing (plan 11.4).

The draft is written below as TypeScript for reading.

```ts
// Every --json line and every MCP tool answer is one of these, one JSON object per line.
type Envelope<K extends string, B> = { contract: "ovis-harness/0"; kind: K } & B;

// ---- identity --------------------------------------------------------------
interface Machine {
  id: string;                 // stable id; names may repeat
  name: string;
  reach: "local" | "hc-ssh" | "hc-via" | "relay";   // "relay" only after H6
  online: boolean;
  versions: { ovis?: string; hc?: string; herdr?: string };
}

interface Harness {
  kind: string;               // catalog kind: "claude", "codex", "opencode", ...
  version: string | null;
  installed: boolean;
  signed_in: boolean | null;  // null: the harness gives no way to tell
  capabilities: Capabilities;
}

interface SessionRef {
  address: string;            // terminal address "machine/t7"; for an ACP child, its keeper's terminal
  drive: "terminal" | "acp";  // how this child is driven
  machine: string;            // Machine.id
  harness: string;            // Harness.kind
  agent_session_id: string | null;  // only when a reader proved it, never guessed by folder or time
  parent: string | null;      // address of the terminal that started it
  started_by: "human" | "agent";
}

// ---- capabilities: read flags, never harness names (rule 4 of plan 11.1) ----
interface Capabilities {
  level: "terminal" | "structured";             // what this harness gets here, now
  drive: ("terminal" | "acp")[];                // "acp": Ovis can be its ACP client on this machine,
                                                // directly or through an adapter the user installed
  acp_protocol: 1 | 2 | null;                   // the version it answered `initialize` with
  transcript: "none" | "file" | "acp";
  approvals: ("keys" | "hook" | "acp")[];       // every path that answers some approval
  turn_end: "strong" | "weak" | "none";          // how far "the turn ended" can be trusted
  turn_end_from: ("acp" | "hook" | "reader" | "terminal")[];
  model_switch: "none" | "launch" | "session";
  resume: boolean;
  images: boolean;
  slash_commands: boolean;
  subagents: boolean;
  tool_delivery: ("mcp" | "shell")[];           // how the harness and browser tools reach it
  browser_tool: boolean;
  memory_tool: boolean;                         // false until U2
}

// ---- state, turns and results ---------------------------------------------
type SessionState =
  | { state: "idle" | "working" | "done" | "gone"; turn: number | null }
  | { state: "waiting_human"; turn: number | null; on: "approval" | "question" };
  // A parent learns only that the child waits for a person, never the card itself (G8).

interface SendAccepted {           // `send` answers "received", never the result (rule 1)
  accepted: true;
  turn_id: string;
  key: string | null;              // the caller's key; the same key again types nothing (rule 2, G7)
  duplicate: boolean;              // true when this key was already sent
}

interface TurnResult {
  turn_id: string;
  stop_reason: "end_turn" | "cancelled" | "refusal" | "max_tokens" | "max_turn_requests"
             | "gone" | "unknown";           // ACP's reasons, plus Ovis's own two
  end_from: "acp" | "hook" | "reader" | "terminal";     // what said the turn ended
  answer_from: "acp" | "reader" | "terminal" | null;    // what supplied final_message
  final_message: Untrusted | null;
  usage: { tokens?: number; cost?: { amount: number; currency: string } } | null;
                                             // shown only where the harness reports it (ACP usage_update)
}

interface Untrusted {               // G11: another agent's words are data, never instructions
  untrusted: true;
  from: string;                     // SessionRef.address
  text: string;
}

interface TranscriptPage {
  items: SessionUpdate[];
  next: string | null;              // cursor; resume with (session, turn, cursor) after a drop
}

type SessionUpdate =                // ACP's names
  | { type: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk"; text: Untrusted }
  | { type: "tool_call" | "tool_call_update"; id: string; title: string; status: "pending" | "in_progress" | "completed" | "failed" }
  | { type: "plan"; entries: { content: Untrusted; status: string }[] }
  | { type: "native"; harness: string; value: unknown };   // passed through, meaning not promised

interface Screen { cols: number; rows: number; text: Untrusted }

// ---- safety ---------------------------------------------------------------
type Scope = "view" | "start" | "send" | "start_elsewhere";   // never "approve" (D19)

interface Grant {                    // what the policy allows, and where
  scope: Scope;
  where: { session: string } | { project: string } | { machine: string };
}

interface Limits {                   // D23, decided 2026-11-24; no other limit
  depth: 1 | 2 | 3;                  // default 1
  child_minutes: number;             // default 60
  calls_per_minute: number;          // per run; default 30
}

interface AuditRecord {              // G6: one per start, send and stop
  at: string;                        // ISO time
  run: string;                       // the calling run's id (its token names it)
  parent: string;                    // SessionRef.address
  child: string;
  machine: string;
  harness: string;
  verb: "start" | "send" | "stop";
  turn_id: string | null;
  stop_reason: TurnResult["stop_reason"] | null;
}

interface Refusal {
  error: {
    code: "tools_off" | "not_granted" | "approval_required" | "approval_denied" | "waiting_human"
        | "depth_exceeded" | "time_limit" | "rate_limited"
        | "ancestor_target" | "self_target" | "not_owner" | "taken_over"
        | "unknown_session" | "unknown_contract";
    message: string;
  };
}
```

The four rules the schema serves (plan 11.1; Ovis and hc already keep them):

1. `send` answers "received" and a turn id. A result changes only on evidence tied to that turn
   (read, [the third contract](agent-commands.md#the-three-contracts)).
2. When unsure, read before sending again. `send` takes the caller's key so a retry cannot type twice.
3. Attaching never takes over. A send waits while a person types; `--takeover` stays a person's act.
4. Capabilities say what is true. A flag that is on and then fails is a bug.

### Capability flags

A caller decides what to offer from the flags, never from the harness's name: no `if kind ===
"claude"` in a caller, in Ovis's screens or in a skill. Ovis announces only what it can prove on
this machine now; a flag it has not proven reports its safe value (`none`, `false`, the empty
list), so today's flags understate rather than overstate. A control whose result Ovis cannot draw
is not offered. `harnessCapabilities` in `server/agent-tools/harnesses.ts` builds every harness's
flags in that one place. This section was read at `origin/main` 7d9229772 (2026-11-25), not at the
commit named at the top.

What `agent_harnesses` reports today, and from what:

| Flag | Reported today | From |
|---|---|---|
| `drive` | `["terminal", "acp"]` when Ovis finds an ACP command here, else `["terminal"]` | `resolveHarness`: gjc, OpenCode and agy found on the PATH (presence only); Claude Code and Codex through an adapter version the runs checked (read, `server/agent-tools/harnesses.ts`). `agent_start` still refuses a harness without a checked permission launch (read, `server/agent-tools/permission-launch.ts`) |
| `level` | `structured` with ACP drive, else `terminal` | as `drive` |
| `acp_protocol` | `1` with ACP drive, else `null` | the version the checked launches answered; not read again from each launch's `initialize` |
| `approvals` | `keys` always; `hook` when the approval hub has an adapter for the harness (Claude Code, pi, OmO, omp), whether or not the launched version gets the hook; `acp` with ACP drive. Codex's app-server answers are not announced yet | `approvals.handles` (read, `server/approvals/hub.ts`) |
| `transcript` | `acp` with ACP drive, else `none` | the file readers are not announced here yet |
| `turn_end`, `turn_end_from` | `strong` from `acp` with ACP drive (the `session/prompt` response); else `weak` from `terminal` | as `drive` |
| `tool_delivery`, `browser_tool` | `mcp` and `shell` for a browser-tool harness (Claude Code, Codex, Copilot) or with ACP drive; `browser_tool` for the first three. OmO and pi report none, though their launch extension adds the server (`server/agent-tools/launch.ts`) | `BROWSER_TOOL_AGENTS` (read, `shared/browser-tools.ts`) |
| `model_switch`, `resume`, `images`, `slash_commands`, `subagents`, `memory_tool` | the safe value (`none`, `false`) | not gathered per harness yet (H4) |

What a caller can read from these without a flag of its own:

- **A pending approval survives an Ovis restart** when it came through `acp`: the keeper holds the
  request until a client answers it, and the restarted server takes the keeper up again and rebuilds
  the unanswered requests from the keeper's log (read, `crates/acp-keeper/README.md`,
  `server/acp/client.ts`). A `hook` request held when the server stops does not survive as data:
  Claude Code's own terminal dialog stands (read, `server/approvals/hub.ts`), while the pi, OmO
  and omp extensions take the hub's empty answer as a denial (read, `server/approvals/pi.ts`,
  `server/approvals/omo.ts`, `server/approvals/omp.ts`).
- **Answers come as data** through `hook` or `acp`. `approvals` lists the paths this contract
  announces, not every path: Codex's app server and a pending OpenCode v2 form are answered as data
  too (`server/approvals/codex.ts`, `server/opencode-service.ts`), while they report only `keys`.
- **How far "done" can be trusted** is `turn_end`: `weak` means a caller reads the result before it
  sends again (rule 2).
- **Switching the model inside a session** is `model_switch: "session"`. No harness advertises it
  through this contract yet, so an agent caller does not offer it. Ovis's own chat still offers
  the pickers it can draw as cards (`/model` for omp, for one).

**Fallback when ACP is missing.** `start` uses ACP only when the harness's `drive` includes `acp`.
Otherwise the child is a real TUI in a herdr-core terminal and is driven as one:

- `send` goes through the terminal input path.
- `wait` and `result` come from the hook, the reader or hc's turn count.
- `TurnResult.end_from` and `answer_from` name which of them answered.

The calling agent uses the same verbs either way and reads `drive` on the `SessionRef`. The same
fallback applies when the ACP start fails, for example a missing adapter or an `initialize` with no
answer.

## Three harnesses

Claude Code and Codex because they are the two largest readers (plan 8.22); OpenCode as the third
because it speaks ACP directly and takes no MCP server on its command line, so it shows the two
paths the other two do not. The plan offered agy or OpenCode for the third.

| | Claude Code | Codex | OpenCode |
|---|---|---|---|
| Transcript (`transcript`) | `file`: `claude-transcript` (read, `server/claude-transcript.ts`, `server/claude-store.ts`) | `file`: `codex-transcript` (read, `server/codex.ts`) | `file`: `opencode-transcript` (read, `server/opencode.ts`); `acp` also possible after M13 (plan 10.1: `opencode acp`, v1, loadSession, list) |
| Approvals (`approvals`) | `keys` for every dialog (`server/dialogs/`); `hook` for Bash requests through the PermissionRequest hook, via the approval hub that any agent's adapter can join (read, `server/approvals/claude.ts`, `server/approvals/hub.ts`) | `keys` (read, `server/dialogs/`) | `keys`; a pending OpenCode v2 form is answered natively (read, `docs/agent-commands.md`, `server/opencode-native.ts`) |
| Turn end (`turn_end`, `turn_end_from`) | `strong` once the `Stop` hook is in (plan 12.4, H5); today `weak`, from the reader and hc's turn count | `weak`: reader and hc's turn count. Codex documents a `Stop` hook (plan 13.4, unverified in use) | `strong` for a v2 pane: its own service's turn-completion events (read, `server/opencode-native.ts`); `weak` otherwise |
| Tools at launch (`tool_delivery`) | `mcp` (`--mcp-config <file>`) and `shell` | `mcp` (`-c mcp_servers.…`) and `shell` | `shell` only: its `mcp` commands write its own settings, which Ovis does not touch (read, `shared/browser-tools.ts`) |
| Browser tool (`browser_tool`) | yes | yes | no (same reason) |
| Drive (`drive`) | `acp` only through the `claude-agent-acp` adapter, which the user installs (plan 10.1); else `terminal` | `acp` only through the `codex-acp` adapter, which the user installs (plan 10.1); else `terminal` | `acp` direct, `opencode acp`, which answered `initialize` with protocol 1 on this PC (plan 10.1); `terminal` too |
| Resume (`resume`) | yes, `POST /api/sessions/resume`, bound to the pane's store (read, `server/session-history-routes.ts`) | unverified for this draft | unverified for this draft |
| Model switch, images, slash commands, subagents | Not filled in. H4 gathers them per harness; until then they report the safe value (`none` / `false`). | same | same |
| Level when the reader fails | `terminal`: `screen` and `send` keep working | same | same |

The two harnesses the goal names first:

| | Gemini CLI | agy (Antigravity) |
|---|---|---|
| In Ovis today | A display name only (read, `server/agents-routes.ts`); no catalog entry, no transcript reader. Not installed on this PC. | Catalog entry (read, `shared/agent-catalog.ts`); transcript reader `agy-transcript` (read, `server/agy.ts`); installed on this PC. |
| ACP | Speaks ACP directly according to its docs (plan 10.1). The plan read the flag as `gemini --acp`; the exact flag name is **(unverified)**, not run here. | **(unverified)**. Only others' lists say it attaches over ACP (`agy acp` on the ACP site's client list; T3 Code's docs); nobody has run it. |
| Drive until checked | `terminal` (`drive: ["terminal"]`) until the flag answers `initialize` | `terminal`, with its reader for results, until `agy acp` answers `initialize` |

## Commands and the code they use

Two faces (plan 11.3). People and scripts get read-only commands (H1). Agents Ovis starts get
`ovis agent` and MCP tools of the same names (H2, H3). Both answer with the schema above. The first
build is thin: each command calls a route this PC's Ovis server already has. Today `ovis` has 11
subcommands (read, `scripts/plugin.ts`: start, stop, status, pair, link, logout, recover, confirm,
phone, phone-setup, tui); these join them.

| Command | Answers | Existing path | New work |
|---|---|---|---|
| `ovis machines` | `Machine[]` | `GET /api/machines` (`server/machine-api.ts`, `server/machines.ts`); hc `machine.list` | Map each PC's way in to `reach` |
| `ovis harnesses [--on m]` | `Harness[]` | `GET /api/agent-catalog` (`server/agent-catalog-routes.ts`, `shared/agent-catalog.ts`), `GET /api/agents` (`server/agents-routes.ts`); another PC through the `/api/machines/<id>/` proxy (`server/dispatch.ts`) | `capabilities`, built today from scattered facts: `BROWSER_TOOL_AGENTS` (`shared/browser-tools.ts`), which `source` a reader yields (`shared/protocol.ts`), the hook (`server/approvals/hub.ts`) |
| `ovis ls [--on m]` | `SessionRef[]` with `SessionState` | `GET /api/session`, whose herdr-core snapshot carries `parent_pane_id` and the turn count (`server/herdr-core/snapshot.ts`, `shared/agent-roster.ts`); `GET /api/pane/summary` (`server/pane-routes.ts`) | `started_by` |
| `ovis read <s> --state` | `SessionState` | the snapshot's agent status; `GET /api/pane/prompt` for a waiting approval or question (`server/prompt.ts`) | Collapse to the five states |
| `ovis read <s> --transcript` | `TranscriptPage` | `GET /api/pane/conversation` (`server/pane-routes.ts` → `server/conversation.ts`) | Map Ovis turns to ACP update kinds; mark text `Untrusted` |
| `ovis read <s> --result` | `TurnResult` | the conversation's last turn | Bind it to a `turn_id`; take the end from the hook where there is one |
| `ovis read <s> --screen` | `Screen` | `GET /api/pane/read` (`server/pane-routes.ts`) | none |
| `ovis agent machines` / `harnesses` / `ls` / `read` | as above | as above | Run token checks (G2). While the child waits on an approval, `read --screen` and `--transcript` answer `waiting_human` with no text (G8) |
| `ovis agent start --harness h [--on m] [--cwd d] ["task"]` | `SessionRef` | this PC: `POST /api/tab/create` or `/api/workspace/create` with `agent` (`server/workspace-routes.ts` → `agentLaunch` in `server/agent-launch.ts`), first message checked by `firstMessageFault` (`shared/launch-rules.ts`); another machine: hc `terminal.run` with `on` (`server/herdr-core/machine-scope.ts`) | Terminal drive: pass hc's `parent` (Ovis reads it today but never sets it), with `labels` for the run. ACP drive on this PC, which has no code in Ovis today: run the keeper in a new herdr-core terminal (hc `terminal.run` with `parent`), which starts `<agent> acp` (or the user's adapter) on a pipe; then `initialize` with no `fs`/`terminal` client capabilities and with `subagents`, then `session/new`. Both drives: G2 to G5 and G10 checks, and an approval card for `--on` (G3). |
| `ovis agent send <s> "task" [--key k]` | `SendAccepted` | `POST /api/pane/input` (`server/pane-routes.ts`; keeps the Claude rewind-dialog refusal); hc `terminal.send` takes `caller` and waits for a person (plan 11.1) | `turn_id` and the caller key (the one route the plan says must be new); G7 and G9 checks; refused with `waiting_human` before any text is typed while the child waits on an approval (G8). ACP drive: `session/prompt`, sent once per key |
| `ovis agent wait <s> [--turn id]` | `SessionState` once the turn ends or waits on a person | the snapshot's turn count and status, the conversation reader, the hook (`server/approvals/hub.ts` for approvals) | A wait that resumes by (session, turn id, cursor) after a drop. ACP drive: the `session/prompt` response, with `waiting_human` while a permission card is open |
| `ovis agent result <s> [--turn id]` | `TurnResult` | as `ovis read --result` | as above. ACP drive: the stop reason and the turn's `agent_message_chunk`s, converted in the one place plan A1 names (today that code sits inside `server/grok.ts`, which reads Grok's `session/update` file) |
| `ovis agent ask --harness h [--cwd d] "task" [--key k]` | `TurnResult` | none: it is `start`, `send`, `wait` and `result` above in one call | The one tool the goal names **(proposal)**. One harness, one task, one answer; no retry, queue or fan-out (it is not orchestration). It leaves the child running for a follow-up `send` until `stop` or the G5 time limit. |
| `ovis agent stop <s>` | `{ stopped: true }` | `POST /api/pane/close` (`server/pane-routes.ts`) | Refuse any session this run did not start (`not_owner`). ACP drive: `session/cancel` for a running turn, then `session/close` and end the keeper |
| *(no verb)* approve | Only a person, in Ovis's screens | `POST /api/pane/prompt/answer` (`server/prompt.ts`); the Claude hook card | none; the tool never gets it (G8). ACP drive: Ovis answers `session/request_permission` with the `optionId` the person picked on the card, which needs an ACP source for the card (plan A5) |
| *(no verb)* `exec`, `file` | hc's own commands | `hc exec --on`, `hc file … --on` | none; Ovis does not reopen them (plan 11.4) |

Removed in revision 2 and not coming back in this contract: `ovis run`, `turn`, `wait`, `events`,
`approve`, `cancel` and `stop` as human commands (they read as Ovis handing out work), and a TS SDK
face (orchestrators wrap the command or the MCP tool themselves).

### Where wait and result come from

- **ACP drive:** the `session/prompt` response ends the turn with its stop reason (`end_from: "acp"`, `answer_from: "acp"`).
  The answer is the turn's `agent_message_chunk`s. Both are data, with no screen reading.
- **Terminal drive:** "hook plus reader" (plan 12.4). The hook says early that the turn ended and
  the reader takes out the answer. A harness with neither falls back to the terminal level, hc's
  status and turn count, and `turn_end` says so.

### How the tool reaches an agent

- MCP: at launch, for harnesses that take a server on the command line (Claude, Codex, Copilot), the
  way the browser tool is added (read, `withBrowserTool` in `server/agent-launch.ts`); for OmO and pi,
  an extension written for the launch and added with `-e`, which registers the server for that run
  (`pi.registerMcpServer`, `server/agent-tools/launch.ts`). Ovis never writes an agent's own settings.
- Shell: `ovis agent` for any agent with a shell. Its run token must be in the terminal's environment.
  herdr's `agent.start` takes no environment (plan 12.2), so the first version is herdr-core terminals
  only.

## Safety rules G1–G12

These apply only to calls made through Ovis's tool. A shell agent can call `hc run --on` itself and
bypass limits and approval; it stays visible, but nothing here stops it. Whether hc can enforce
anything is unverified (plan 12.3, 8.25). The run token tells runs apart; it does not stop another
program of the same OS account (as R20).

| # | Rule | Default (D23) | Enforced at | Proof (G12) |
|---|---|---|---|---|
| G1 Visible | Every agent an agent starts shows under its parent in the sidebar. A terminal child is a real TUI in a herdr-core terminal that a person can step into and take over at any time. An ACP child is drawn as a chat in Ovis's view, and a person can cancel it at any time. | always | Terminal: `start` sets hc `parent`; the sidebar already nests by `parent_pane_id` (read, `shared/agent-roster.ts`, `src/components/AgentSidebar.tsx`). Across machines the parent is not found today (same machine only): H3. ACP: the keeper's terminal, started with `parent`, so the same nesting applies; its chat and cards in Ovis, F4 for the real TUI. | A started child of either drive appears under its parent; one started on another machine shows its parent. |
| G2 Local delegation by default | An agent caller may view (list, state, transcript), start and send locally by default. The policy includes the ACP launch harnesses but does not bypass launch checks. | `start` on this PC; saved `view` and `off` stay in effect | Run token → grants check before every verb. Agent callers are a new kind of principal: neither `drive` nor `watch` (read, `shared/access.ts`). | An explicit view-only grant still refuses `start` and `send` with `not_granted`. |
| G3 Other machine | Starting on another machine goes through a person's approval card showing who, which machine, which harness and what task. "Always allow" binds to one parent and one machine. | card each time | `start --on`; the card reuses the approval card surface. Touches authentication: owner check and a real review. | Zero starts elsewhere without an approval. |
| G4 Depth | An agent may start agents only while its depth is below the limit. At the default of 1, a child cannot start agents and gets view-only tools; at 2 or 3, descendants may start agents until the limit. | 1, settable to 3 | Depth carried in the run token, one more for each generation. | Past the depth, `depth_exceeded`, at 1, 2 and 3. |
| G5 Limits | No limit on running children per parent (owner decision 2026-11-24); 60 minutes per child; cost shown wherever the harness reports it, with no cost cap. Past a limit no new work is taken and a person is told; a running child is never killed. | 60 min | `start` and `send`. | Past the limit, `time_limit`, and the running child still runs. |
| G6 Record | Each parent → child act is recorded: who, machine, harness, when, turn id, stop reason. What was sent is in the session's own transcript and is not copied. | always | `AuditRecord` on every start, send and stop; a screen for it in H3. | Every start, send and stop leaves exactly one record. |
| G7 No loops | Sending to an ancestor or to oneself is refused. The same key types once. Calls per minute are limited. | 30/min per run | `send`, using the `parent` chain and the key store. | `ancestor_target`, `self_target`, a repeated key gives `duplicate: true` and types nothing, a burst gets `rate_limited`. |
| G8 Only people approve | The tool has no approval verb. A child's approval request goes to a person as a card; the parent only sees `waiting_human`. While a child waits on an approval, the parent's `send` is refused (`waiting_human`) before any text is typed, so it cannot answer a dialog by typing, and `read --screen` and `--transcript` return no text, so the dialog's content never reaches the parent. For an ACP child, Ovis is the only ACP client: each `session/request_permission` becomes a card, with only one-time options in ask-every-time launches. The calling agent never holds the connection or sees the request. Ovis adds no approval of its own, so a child that requests nothing ends with no card. If an "Always allow" option is available, it holds for that child session only. Exact scope: this covers the requests that reach Ovis; a call the harness's own settings already allow never asks. | always | Schema: no approve scope. The ACP client is Ovis's (server and keeper) and its connection is never handed out. | No verb exists, and the parent's view of a waiting child holds no card content. A `send` to a child with a dialog open types nothing and returns `waiting_human`; a screen read then returns no dialog text. With a fake ACP agent: a permission request shows a card, the turn waits until a person answers, and the parent's tool has no way to answer it. A turn with no request ends with no card. |
| G9 People win | A send waits while a person types in that terminal; once a person takes over, the parent's sends are refused. For an ACP child, a person's cancel or card answer wins over the parent; after a person cancels a turn, the parent's next send is refused until a person resumes the child. | always | The existing send path and attach claims (`server/input-guard.ts`, hc `terminal.send`); for ACP, the server's client. | A send during typing waits; after take-over, `taken_over`; after a person cancels an ACP turn, `taken_over`. |
| G10 Off switch | Setting the policy to `off` turns the whole tool off and revokes every agent caller's token at once. Look-only (`view`) turns off starting and sending. | `start` on this PC | Settings, checked before every verb. | With the policy `off`, every verb is `tools_off` and old tokens fail. |
| G11 Untrusted text | `read` and `result` mark another agent's words as data so they do not read as instructions. | always | `Untrusted` wrapper in the schema; the skill text says how to treat it. | Every text field from another session is `Untrusted`. |
| G12 Tests | Removing any one guard turns a test red. Each state change has a test: off then on, parent ends first, child on another machine, late answer, and for ACP children the Ovis server restarting mid-turn (the keeper keeps the turn) and an adapter that never answers `initialize` (falls back to terminal drive). | n/a | the H2 and H3 test suites, in an isolated session (`mkdtempSync` state, `port: 0`). | Guard-removal run per guard. |

### Known risks for H2

The same few gaps keep turning up in other tools that let one agent run another. H2 checks each:

- **Depth survives the process boundary.** Depth travels in the run token, so a shell or helper
  process inside a child that calls `start` with the child's token is still refused
  (`depth_exceeded`).
- **A child never has more permission than its parent.** It starts in the harness's default mode;
  a request for a wider mode (full access, "allow everything") goes to a person's card. The mode
  stays the same on every later `send`.
- **"Always allow" stays with one child session.** It never spreads to the parent or to another
  child.
- **A child waiting on a person wakes its parent.** `wait` returns as soon as the child is
  `waiting_human`, so a parent does not sit blocked on an approval nobody has seen.
- **Grandchildren are visible.** Ovis announces `subagents` in ACP `initialize`, so a harness's
  own subagents show as sessions under the child, and their permission requests come to Ovis's
  cards. They do not count toward Ovis's depth, because Ovis cannot stop them, but people see and
  approve them.

H2's exit tests come from these rules and risks: "local delegation by default, explicit view
stays read-only", "refused past the depth, also from a process inside the child", "the same key types once", "waits while a person
types", "a child's mode does not widen on a later send", "a parent's `wait` returns when its child
waits on a person", and for ACP drive "a permission request reaches only the card" and "a read-only
ask ends with no card". H3 adds "zero starts elsewhere without approval" and
"no new work past a limit". H2 and H3 change an HTTP contract and touch authentication, so both need
the owner's word and a real review (plan 4.7).
