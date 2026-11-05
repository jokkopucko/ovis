# Agent commands in Chat

How the chat lists an agent's `/` commands and skills, sends them, and says what became of them.
It covers every agent the bridge knows (Claude Code, Codex, OpenCode, pi, omp, OmO, gjc, Hermes,
Grok, Antigravity, Devin CLI and Command Code) and is written for people who change that code.
For what a user sees, read the [user guide](guide.md#features); for skill status inside an
answer, read [Skill activity in chat](chat-skill-activity.md).

## The three contracts

Everything here rests on three rules. A change that breaks one of them is a bug, whatever it fixes.

1. **The catalog describes forms, not just names.** Each row of `GET /api/pane/commands`
   ([`SlashCommand`](../shared/protocol.ts)) says how each typed form behaves: bare, with a given
   subcommand, or with any other argument. A form needs nothing (`none`), opens a dialog a reader
   knows (`dialog`, naming the reader), only works in the terminal (`terminal`), or is not known
   (`unknown`). Rows also carry `visibility`, `provenance` (scan, static or native, and whether it
   was checked against the running version), `shadows` and a stable `id`.
2. **The terminal is the only way a command is sent.** Chat types into the pane exactly as the
   user would, through the same submit path as any message. No command goes through an agent's
   API. The one native write the bridge keeps is answering a pending OpenCode v2 form, which is an
   answer, not a command.
3. **An outcome changes only on evidence tied to that send.** Sending a command records
   `accepted` and nothing more. A later state needs evidence that belongs to this send, listed
   under [Outcome states](#outcome-states-and-their-evidence). A screen that changed, an idle agent
   or a timer proves nothing.

## Where the rows come from

Every agent has a source in [`server/skills/`](../server/skills/), registered in
`AGENT_SOURCES` of [`server/skills/index.ts`](../server/skills/index.ts) and compiled into rows by
[`server/commands.ts`](../server/commands.ts). A source has a static builtin table pinned to one
upstream release (the pin is in the file header), and a scan of the skill and command folders the
agent itself reads. A row is `verified` only when the pane's agent version, read from its own
store by [`server/agent-version.ts`](../server/agent-version.ts), matches the pin.
[`resolveAgent`](../server/pane-context.ts) is the one place that decides a pane's agent and
version.

Some agents also answer for themselves. A native provider registers in
[`server/catalog-sources.ts`](../server/catalog-sources.ts); `/api/pane/commands` gives each
provider 1.5 seconds and merges its answer over the scanned rows. A provider owns the backend
commands and skills it answers with: those scanned rows are replaced and the new ones are marked
`native` and verified. It can never remove or add a builtin. A timeout, an error or no answer
leaves the scanned rows as they were. No provider starts an agent, a daemon or a broker, and none
installs anything into the agent's configuration. GJC uses the scanned command and skill
catalog; the bridge does not query its SDK broker.

| Agent | Builtins pinned to | Folders scanned | Native source | Not listed (runtime only) |
| --- | --- | --- | --- | --- |
| Claude Code | the official commands reference, 2.1.301 | user, project and plugin `skills/` and `commands/`, `skillOverrides` | none | MCP prompts a server declares only at run time |
| Codex | `codex-rs` rust-v0.163.0 slash table | `.codex/skills` of each ancestor, `$CODEX_HOME/skills`, `~/.agents/skills`, system and admin roots, plugin skills as `namespace:name`, to depth 6; custom prompts only before 0.118.0 | skills from a running app-server daemon's `skills/list`, 0.157 or later, never on Windows ([`codex-daemon.ts`](../server/codex-daemon.ts)) | none known |
| OpenCode | shared builtins pinned to 1.19.3 (so unverified on v2); the rows only one version has are checked against 1.19.3 or 2.0.32, by major.minor | v1 `command/` and `commands/`; v2 skills as `@id`, both command dirs, loose `.md` skills | v2 only: `GET /api/command` and `GET /api/skill` of the service its `service.json` names, checked by pid and version, never started ([`opencode-native.ts`](../server/opencode-native.ts)) | plugin commands on v1 |
| pi | `earendil-works/pi` slash-commands at 5c1736f8 | agent dir, `~/.agents`, `settings.json` skills, project roots that pi's trust allows | none | extension and package commands |
| omp | `oh-my-pi` builtin registry at 53a0377d (18.12.3) | omp's skill providers, namespaced on a clash, `disabledProviders` and `enabledProviders` | none | extension and plugin commands |
| OmO | Senpi 46d15a1c and OmO b6230fcd tables | bundled skills minus the `disabled_skills` union of user, project and profile config | none | extension commands not in the pinned tables |
| gjc | `builtin-registry.ts` v0.18.12 | bundled workflow skills, `.gjc/commands` of the project and the active profile | none | runtime-only skills not present in scanned roots |
| Hermes | `CommandDef`s at 0.21.5 | skill roots and `quick_commands` | none | plugin slash commands, registered at run time |
| Grok | `grok-build` 1.0.62 pager and shell tables | `.grok`, `.claude`, `.cursor` and `.agents` roots at every tier, bundled skills, collisions as `/local:x` and friends | none | none known |
| Antigravity | the recorded agy 1.4.0 palette | `~/.gemini/config/skills` and the two loaded builtin skills | none | none known |
| Devin CLI | 3000.11.92, checked against its changelog | native roots, plus Claude, Windsurf, Copilot and Cursor roots unless `read_config_from` turns them off | none | MCP prompts not declared on disk |
| Command Code | its bundled reference at 1.84.0 | `skills/`, nested `commands/`, bundled skills | none | none known |

A command typed by hand that no row lists (an extension command, an undeclared MCP prompt) still
sends, and a leading command is still tracked. Its outcome stays `accepted` and ends as
`unknown` unless evidence turns up: for Claude Code, its transcript's command echo or output, or a
user turn with the exact text, gives `result-observed`.

The new workspace and new tab dialogs list the same rows before any pane exists, from
`GET /api/agent/commands?agent=&cwd=`. That route reads only the static tables and a scan of the
folder and home, so its rows are never native and never verified.

## The terminal group

Some commands only make sense in the terminal: pickers the chat has no reader for, pagers, or
reports the agent never writes to its transcript. The rule for a row: a typed form that leaves a
screen waiting for a key (a picker, panel, form, confirmation, prompt or editor) that no reader
turns into a card is `terminal`. The form decides, so Claude Code's bare `/fast` is a terminal
command while `/fast off` is an ordinary send. A command that prints and returns to the agent's
input stays an ordinary send, even when what it printed reaches only the screen. Check a new
row by sending it in an isolated session of the pinned version, and read the command's own
definition instead when it signs in, buys, uploads or installs: Claude Code's `/ide` installs
the editor extension on the PC, and agy updates its own binary when it starts. Rows with
`visibility: "terminal"`, or with a
bare form whose interaction is `terminal`, are listed apart in the composer under Terminal
commands ([`src/lib/compose.ts`](../src/lib/compose.ts)). Picking one inserts it like any other
completion. Send/Enter sends it through the usual path and, once accepted, opens a terminal peek
([`src/lib/terminalPeek.ts`](../src/lib/terminalPeek.ts)): the pane's own terminal over the
chat's transcript, in this browser only. The chat stays mounted under it, where it was; the pane's
lens and the address stay Chat, nothing attaches anew and herdr's focus never moves. On a desktop
the composer stays under the terminal, dimmed and inert, and the terminal takes the keys; on a
phone the key bar takes the composer's place. Busy commands wait in the existing queue: only an
explicit **Send now** opens a peek, never automatic delivery. A refusal or unconfirmed send keeps
the draft and note. View-only devices never send or peek. `/resume` keeps opening **Earlier
sessions…**.

The peek's head says what ran and offers **Back to Chat** and **Keep Terminal** (which keeps the
Terminal lens). The header's Chat, Mod+Shift+J, a phone's Back, another pane and a reload end it
too. Escape belongs to the agent. Claude Code's chat can come back by itself: when one of its
panels closes, Claude writes a `local_command` answer ("Settings dialog dismissed"), and a
local-command notice written after the send's own outcome was created ends the peek. Only the
commands Claude Code 2.1.306 was recorded answering that way at close, sent bare, arm it: `/usage`,
`/cost`, `/status`, `/stats`, `/help`, `/config`, `/theme`, `/permissions`, `/hooks`, `/skills`,
`/workflows`, `/passes`, `/resume`, `/powerup` and `/fast` (each only where the catalog lists it
as a terminal command, since no other command opens a peek). `/diff` writes its answer when its
panel opens, `/export`, `/plugin`, `/mobile`, `/autocompact`, `/add-dir`, `/mcp` and
`/scroll-speed` write entries the chat does not show, `/sandbox` and `/tasks` write nothing, and a
custom or unknown command is unrecorded: those come back by hand. Under Claude's fullscreen
renderer most panels write nothing at close, and a session writes nothing before its first
message, so the peek never waits for the answer, and its head says the chat may come back, never
that it will. Held terminal input, the terminal's find bar or an IME composition in the grid or
its input line leave the return to the reader.

The other agents write nothing when a picker or panel closes, and herdr reports those screens as
idle, so their chat comes back from the screen instead
([`src/lib/inputRow.ts`](../src/lib/inputRow.ts)): each draws its own empty input row again when
the screen closes. One recognizer per agent reads the terminal's bottom rows off whole frames
(never inside one of herdr's synchronized-update blocks, nor between a resize and the agent's
redraw; when the pane's grid changes size, the first frame for it, which may be herdr's own of
the old screen reflowed, neither arms nor ends the peek). The peek arms once the row has gone, or
been covered by a panel drawn over it, after the send, and ends on the first frame that shows it
back, empty. It arms only when the row was read empty as the command left, and only for the
commands each agent was recorded hiding and redrawing it for, sent bare:

| Agent (version recorded) | Comes back by itself after | Arms on |
|---|---|---|
| Codex (0.163.0) | `/permissions`, `/theme`, `/statusline`, `/resume`, `/review`, `/rename`, `/new`, `/fork`, `/usage`, `/diff` (closed with `q`), `/cd <folder>` it does not trust yet | row gone |
| omp (18.8.7) | `/settings`, `/hotkeys`, `/tree`, `/resume`, `/extensions`, `/agents`, `/usage`, `/context`, `/btw` | row gone or covered |
| pi (0.86.0) | `/settings`, `/tree`, `/resume`, `/scoped-models` | row gone |
| gjc (0.18.12) | `/settings`, `/theme`, `/tree`, `/resume`, `/sessions`, `/transcript`, `/routing` | row gone |
| OmO (5.1.40) | `/settings`, `/tree`, `/thinking`, `/scoped-models`, `/favorite-models`, `/sessions`, `/resume`, `/rename`, `/share`, `/trust` | row gone |
| Hermes classic CLI (0.21.5) | `/model`, `/reload-mcp`, `/new`, `/reset`, `/clear` | row covered only: it draws the empty row for a moment before every screen |
| Devin (3000.11.92) | `/model`, `/models`, `/config`, `/resume`, `/theme`, `/shortcuts`, `/mode`, `/btw` | row gone |
| agy (1.4.4) | `/model`, `/resume`, `/config`, `/permissions`, `/mcp`, `/skills`, `/usage`, `/context`, `/help`, `/tasks`, `/rewind`, `/artifact`, `/codesearch`, `/diff`, `/changelog` | row gone or covered |
| Grok (1.0.67) | `/settings`, `/sessions`, `/resume`, `/plugins`, `/skills`, `/hooks`, `/help`, `/usage`, `/context`, `/history` | row gone or covered |

A command that prints and keeps the row (Codex `/status`, omp `/plan`, pi `/hotkeys`, Devin
`/mcp`…) never arms; one that hands the screen to `$EDITOR` (Hermes `/prompt`, agy `/open`) or
closes onto text in the row (Hermes `/palette`, Grok `/model`, Codex `/mention`) is left to the
reader. Codex's `/side` and `/btw` come back by hand: their side thread draws a composer of its
own. So does OpenCode, whose in-session layout was not recorded, and every unrecorded command
or agent.

A peek ended by hand while its command's screen is still open (Claude Code's `/btw` answer, a
picker left up) leaves the next message to be typed into that screen, where it does nothing.
Where the agent has a recognizer (Claude Code's reads its input box between the screen's last
two rules) and it read the empty row as the peek began, the composer then says **/command is
still open in the terminal** (**A screen is still open in the terminal** after a peek opened
from a chat row, where the reader may have opened another), with **Show terminal**. Send keeps
the message and says it was not sent, with **Send anyway** to send it once; a quick reply and a
queued message's **Send now** are held the same way, without it. A command on the list whose
screen had not opened yet when the reader left (gjc's `/sessions` keeps its empty box for 10 to
15 seconds while it loads) gets the notice once a frame shows the screen, unless the agent starts
a turn first. The notice goes as soon as a frame shows the row back, or with another pane, agent
or session; a peek left for another pane sets none. For Claude Code and Codex, a screen opened
over the input row some other way (Codex's transcript search, Claude Code's `/config`, a peek's
screen kept in the Terminal lens) gets the same notice, **A screen is still open in the
terminal**, once Chat shows it with the agent at rest; its **Show terminal** opens the Terminal
lens, and dismissing it holds until the row is back. Messages the PC delivers by itself at the end
of a turn are not held. Nothing is typed to close the screen.

Rows marked `agent-hidden` mirror the agent's own menu, which hides them (Claude Code's
`/heapdump`, for instance). They are left out of the menu too, but typing one sends it like any
other command. No other row a source finds is ever hidden.

## Outcome states and their evidence

[`server/outcome.ts`](../server/outcome.ts) tracks each command sent from Chat per pane, found in
the text by the same per-agent syntax the composer uses
([`shared/skill-syntax.ts`](../shared/skill-syntax.ts)). Recording an outcome never delays the
send: delivery comes first and tracking catches up. The pane's outcomes ride on
`GET /api/pane/prompt` as `outcomes`. Ordinary commands show a chip under their bubble
([`src/lib/outcomeChip.ts`](../src/lib/outcomeChip.ts)). Terminal-only commands instead show one
quiet **Ran in terminal** row with **Open Terminal**, which opens a peek ended by hand, without
chips or unconfirmed previews.
Recognized Hermes informational result cards remain available.

| State | Means | Set by |
| --- | --- | --- |
| `accepted` | the bridge typed it, nothing more | the send |
| `interaction-required` | the agent shows a dialog this send opened | a registered reader parses the dialog the form names, or any dialog this send owns when the form names none |
| `result-observed` | the command did what it does | correlated evidence, below |
| `terminal-required` | the answer lives in the terminal | a `terminal` form, or a dialog form whose dialog never showed once the screen settled, or the agent still waiting two seconds later |
| `unknown` | ten minutes passed, or a newer send closed the window, without evidence | the window closing |

`result-observed` takes one of these evidence kinds, each tied to this send and seen after it:

- `transcript`: the agent's own record. Claude Code's local command echo, or its user turn with
  the exact text; a `model_change`, `thinking_level_change` or `compaction` record in pi, omp, gjc
  and OmO sessions (omp's `/handoff` writes a compaction with method `handoff`); a `compacted`
  record for Codex `/compact`. Records are claimed in send order, so two equal sends never share
  one, and a rewritten transcript drops what it no longer holds. Known limit: a pi-family send the
  agent dropped without a record takes the record of a later equal send on the same branch, and
  that later send ends as unknown. In pi, only the session's active
  branch counts: a send stays with the branch it was sent on, also after the session goes to
  another branch and `/tree` comes back to it, unless meanwhile something was written under that
  branch's last entry or a record a result could be was written elsewhere (`resumedBranch` in
  [`server/conversation.ts`](../server/conversation.ts)); then the send ends as unknown.
- `dialog`: a card answered from Chat, counted only for the send that raised that card.
- `recognized-result`: a reader of kind `result` matched a complete, recorded layout that appeared
  after this send's own echo and was not on screen when it was sent. Hermes `/help`, `/status`,
  `/version`, `/profile` and `/reload-skills` work this way, and the text is shown verbatim on a
  card with a **Dismiss** that sends no keys.
- `native`: the agent's own event stream. Today only OpenCode v2, whose service announces the
  session's message and the end of its execution.
- `side-store`: reserved for an agent's own side store, such as omp's saved BTW answers. Nothing
  produces it yet, so omp `/btw` is a terminal command.

A screen that changed after the send folds under the chip as an unconfirmed preview, only when the
send recorded the screen as it was at send time and only inside the send's window. It is never
merged into history, never starts another action, and is withheld from observe-role connections.
A command the agent keeps no transcript turn for, such as Claude Code's `/btw`, still shows a sent
row.

A row belongs to the agent session it was sent in (`commandOutcomes` in
[`server/prompt.ts`](../server/prompt.ts)): once herdr reports another session, terminal or agent
process in the pane, the row is hidden. A send made before the agent reports a session is bound to
the agent process it went to and stays with the session that process reports first. Where no
process could be matched (native Windows lists only the shell; an agent may run under another
program name), it stays with the next session herdr reports in the same terminal under the same
agent, or under the label herdr gave the pane at the send (herdr names an OmO pane `pi`). A send to
a restarted agent while herdr still shows the session of the process before waits up to a minute
(`STALE_SESSION_LAG_MS`) for the agent's own session. Known limits, all of which hide a row rather
than show a wrong result, except the last two:

- That minute is counted when Chat next asks. A session that appeared within it while no Chat was
  open is taken for a later one, and the row is hidden.
- Within that minute, a session change typed in the terminal of an agent that resumed the same
  session (`claude -c`, `codex resume`) keeps the row in the new session until the next change.
- Outside Linux, an agent restarted under the same process number cannot be told apart from the
  one before it.
- The order of repeated identical sends trusts the history row numbers herdr reports
  (`printedPastEarlier` in [`server/outcome.ts`](../server/outcome.ts)): a herdr that renumbered
  its history between two sends could credit one with the other's result. herdr 0.9.5 does not.

## Readers

A reader turns a screen into a card. Each agent's readers live in
`server/dialogs/<agent>.ts` and are registered, in a fixed order, by
[`server/dialogs/index.ts`](../server/dialogs/index.ts) through
[`registry.ts`](../server/dialogs/registry.ts). Each reader declares `reread: "each-move"`, `"before-commit"` or `"none"` in its descriptor
([`shared.ts`](../server/dialogs/shared.ts)); omp's `omp-model` is an `each-move` reader. A picker reader also has an interaction plan
([`interaction-plan.ts`](../server/dialogs/interaction-plan.ts)): where the cursor is, which keys
move it, how it commits, and when it gives up to the terminal. Running a plan always reads the
screen again before the committing key and refuses when the prompt changed; `rereadMoves`, set
for `each-move` readers and for list readers, adds a check after each move as well.

Claude Code's `/effort` card (`claude-effort` in [`claude.ts`](../server/dialogs/claude.ts))
offers the five levels, low to max. A level's row moves the slider with ←/→ and presses `s`, never
Enter (Enter saves the level as the default for new sessions), so the level holds for this session
only. Since 2.1.284 Ultracode is no level but a switch the slider draws beside itself in a pane of
70 columns or more, and on two lines of its own under itself in a narrower one; while it is on,
Claude writes "Ultracode: dynamic workflows on every task" under the level names. The reader takes
either layout, with the switch on or off. Where the slider names Tab as the switch's key, the card
has one more row, **Turn Ultracode on** or **Turn Ultracode off** ("Keeps the effort level, for
this session only"; "Ultracode" stays English in every language). It presses Tab, then `s` once the
slider, read again, shows the switch flipped with ▲ still on the same level: Claude applies
Ultracode with that level for this session and writes nothing to its settings. Otherwise no `s`
goes out and the answer is refused with `prompt_changed`; Claude keeps the unapplied flip in its
dialog until Esc. A level's row, too, presses `s` only while the switch still shows the state the
card was read with. A model without Ultracode (one without xhigh) or dynamic workflows turned off
leaves only the level rows, at every level including max, where Claude writes max's description
right under the level names. Another key bound to the switch also leaves only the level rows, and
so does a key unbound in `keybindings.json` (`"tab": null` in the `EffortSlider` context): Claude
then draws the switch's state with no "… to toggle" line. A key without its state, a switch drawn
twice or both beside and under the slider, and a line under the level names that does not match
the switch (Claude's Ultracode line while it is on, a blank line while it is off, no Ultracode line
without a switch) give no card, and neither does a pane of about 44 columns or fewer, where Claude
cuts the level names. Known limit: the switch row applies the level ▲ stands over in Claude's
dialog, so a level moved in the terminal and not applied goes with it, and a level row likewise
applies a flip left unapplied there.

Readers that show results in Chat today include Claude Code's `/goal` status card,
Hermes's informational results, and the steps of omp's `/handoff` that can be
answered from a card. A step that needs an editor or native editing ends as `terminal-required`
and keeps the draft.

Messages in Chat carry no rewind action. For an agent with its own `/rewind` (Claude Code, grok,
Antigravity), run it in the pane's terminal, where its dialog is answered. Chat follows the native transcript's active branch when the agent
records it; Claude Code records that branch on the next prompt or command.

## Earlier sessions

`GET /api/sessions/history` lists a folder's earlier sessions from each agent's own store
([`server/session-history.ts`](../server/session-history.ts)), newest first. It reads at most the
first 64 KiB of a file, looks at most at 400 files and returns at most 50 rows, and refuses any
path that resolves outside the store. Resume opens a new tab with the agent's own resume flag,
only where that flag is cited in the code; a row without one has no Resume button.

## Starting an agent with a first message

New workspace and New tab can pass a model and an effort only where the agent's launch takes them:
Claude Code (`--model`, and `--effort` low, medium, high, xhigh or max) and Codex (`--model`,
`-c model_reasoning_effort=`). Every other agent starts with its own configuration.

Claude Code also gets an Ultracode switch. On, it adds `--settings '{"ultracode":true}'` after the
effort, which it keeps; off adds nothing, so Claude Code's own settings decide. Claude Code applies
the setting for that session only. On a Windows PC the bridge passes the same text as the path of a
file holding it ([`claude-settings-file.ts`](../server/claude-settings-file.ts)): Windows
PowerShell 5.1 strips the JSON's quotes on the way through the `claude.ps1` shim of an npm install,
and a path arrives intact (if the file cannot be written, the JSON goes as it is). The file is in
`%LOCALAPPDATA%\ovis\claude-settings`, a folder only that Windows user and the administrators
reach, where `%TEMP%` can be one other accounts write to. Ultracode needs Claude Code 2.1.284 or
later (Claude Code's settings reference says an older one runs the session at xhigh), a model with
xhigh and dynamic workflows turned on; otherwise Claude Code ignores it without an error, and the
dialog cannot tell. The bridge still takes `--effort ultracode` from other clients, which Claude
Code reads as xhigh with Ultracode on. A resumed session, from herdr's own auto-resume or from
Resume in Earlier sessions, starts with the agent's resume flag alone, so no launch argument is
applied again, Ultracode included.

Any agent can get a first message. Codex takes the message as its own argument after `--`, so a
message such as `logout` is never read as a subcommand. Claude Code and every other agent get it
through the bridge's pending record (`first_message` on the create request): it is queued for the
pane and sent once when the agent is ready, like any queued message, and it can be discarded or sent
now. Only the page that sent the request (`first_message_connection`) types it on its own, while it
has the pane attached; if that page disconnects or leaves the pane first, the message is held until
someone sends it now or discards it, and the pane's other messages go at their turn. A request that
names no page connection (a script or CLI) gets its message held from the start, and the answer says
so: `first_message: { id, held: "first_message_unattended" }`. A pane holds
one first message, bound to the agent the launch brought up: its process (the one a shell-started
agent's launch saw come up) and session, as known when the message is queued and as learned at each
event of the pane after. A `/resume` or another process of the same kind holds it with
`pending_target_changed`, and that agent ending before the message went holds it with
`first_message_launch_ended`, at the pane's next event; Send now then answers the same code to a
client whose `pending-action` frame says `launch_ended`, and `pending_target_changed` to an older
one. First messages live in the bridge's memory, so a restart drops the ones not sent yet. The
bridge checks launch arguments by the dialog's rules in `shared/launch-rules.ts`.

## Adding a command form or a reader

To describe a form, add it to the agent's source in `server/skills/<agent>.ts`: the name, its
`match`, and its interaction. A `dialog` form names the reader id that will parse it.

To add a reader:

1. Record the screen at two widths from an isolated session of the pinned version, and save it
   under `server/fixtures/`. A typical name is `<agent>-<feature>-<version>-<state>-<width>.txt`,
   though not every fixture follows it (`omp-switch-18.11.1-*` and `omo-pending-5.1.30-extension-tail.txt` don't): the width is the column count (`claude-goal-2.1.304-active-40.txt`) or `narrow` and
   `wide` (`omp-handoff-18.8.7-done-narrow.txt`). A set of result screens may get its own folder
   (`server/fixtures/hermes-results/help-120.txt`).
2. Add the reader to `server/dialogs/<agent>.ts`, with an interaction plan if it moves a cursor,
   or `kind: "result"` if it recognizes a finished result. Words the card gets from the bridge
   rather than from the screen (a title, the Close an Esc is offered as) go in as `own("…")`, with
   their English key added to `shared/card-text.ts` and translated in `src/lib/i18n/composer.*.ts`:
   the client shows them in the user's language (`own_text`), and the agent's own text as drawn.
3. Switch the form to `dialog` with that reader's id.
4. Test the reader against its fixtures in the agent's test file.

[`server/catalog.conventions.test.ts`](../server/catalog.conventions.test.ts) fails when a
`dialog` form names a reader that is not registered, a registered reader has no test, a static
table has no pin, or a source, the session history or the Codex daemon client imports
`node:child_process` or calls `Bun.spawn`.

## Adding an agent

There is no single place for a new agent. These files each need it:

- [`server/pane-context.ts`](../server/pane-context.ts): `resolveAgent`, and the version source if
  the agent's store records one ([`server/agent-version.ts`](../server/agent-version.ts)).
- [`server/skills/index.ts`](../server/skills/index.ts) and a new `server/skills/<agent>.ts`, with
  its test.
- [`shared/skill-syntax.ts`](../shared/skill-syntax.ts): how the agent's commands and skills are
  typed.
- [`server/dialogs/index.ts`](../server/dialogs/index.ts) and a new `server/dialogs/<agent>.ts`
  for any reader.
- [`server/conversation.ts`](../server/conversation.ts) for its transcript, and
  [`server/outcome.ts`](../server/outcome.ts) for the transcript records that count as evidence.
- [`server/session-history.ts`](../server/session-history.ts) for its store and resume flag.
- [`src/lib/agentLaunchMode.ts`](../src/lib/agentLaunchMode.ts) for model, effort and a first
  message at launch.
- [`shared/supported-agents.ts`](../shared/supported-agents.ts): `SUPPORTED_AGENT_KINDS`, the
  agents the app treats as its own.
- [`shared/telemetry.ts`](../shared/telemetry.ts): `TELEMETRY_HARNESSES`, or the agent counts as
  `other`.
- The agent-specific branches of [`server/prompt.ts`](../server/prompt.ts),
  [`server/core/composer.ts`](../server/core/composer.ts) and
  [`server/core/pending.ts`](../server/core/pending.ts) where its prompt, input box or queue
  differs, and [`src/lib/sessionHistory.ts`](../src/lib/sessionHistory.ts) for its history rows.
- The [Supported agents](guide.md#supported-agents) table in the user guide.

## Not done yet

These are tracked as issues rather than built: sending a command through an agent's own API, a
link between a Codex pane and its thread, opt-in companions that would let an agent report its
own runtime commands, probes that are certified free of side effects, versions for the nine
agents whose stores do not record one, translations of card labels the server writes,
and skill activity rows for Grok, agy and Devin.
