# Agent input-row screens

Recorded 2026-10-22 in an isolated herdr session (herdr 0.9.5) for the terminal peek's automatic
return (`src/lib/inputRow.ts`, `src/lib/terminalPeek.ts`), read by `src/lib/inputRow.test.ts`.
Each agent ran in a scratch project folder under a temporary directory; every command was sent bare,
its screen held open, then closed with Escape (or `q` for Codex's `/diff` pager).

- `<agent>/<command>-<state>-<cols>.ansi`: one screen as `herdr pane read --format ansi` gave it
  (SGR only, one line per row, 40 rows). States: `idle` before the send, `open` with the command's
  screen up, `closed` after Escape (`closed-q` after `q`), and the few named states the recorder
  kept (`open-early`, `open-loading10s`, `typed-autocomplete`, `after-first-enter`).
- `<agent>/<name>.frames.jsonl`: herdr observe frames (`terminal.frame`) decoded to text, one per
  line as `{cols, rows, data}`. Each frame is one synchronized-update block, as the attach stream
  draws it.

Versions: Claude Code 2.1.308 (`claude/btw-*`, signed out, so the answer is an API error; default and fullscreen renderers), Codex 0.163.0, omp 18.8.7, pi 0.86.0, gjc 0.18.12, OmO 5.1.40 (`omo`), Hermes Agent
0.21.5 (classic CLI), Devin 3000.11.92, Antigravity CLI 1.4.4 (`agy`), Grok 1.0.67.

Redacted: account emails read `user@example.test` and account plans `(plan 00)` / `(Demo plan    )`,
both at their original width so the layout is unchanged; session and request ids are zeroed. The
Codex screens that still show an earlier `/status` card above the composer (the 40-column ones,
`diff-closed-q-120` and `diff-send-120`) read `00000` credits and a weekly limit that resets
`0:00 AM on 01 Jan`, with the session id all zeros. In the observe frames an email or id drawn in
pieces was mapped piece by piece (where herdr's diff skipped a cell the zeroed text no longer
matched, the frame writes it out), and each frame was replayed to check that none is left.
Screens opened to list the account's own sessions, usage, MCP servers or status (Codex `/status`,
gjc `/sessions` open, Devin `/status` and `/mcp`, agy `/resume` and `/usage`) are not here. The
scratch folder paths under the temporary directory are kept.

## `pi/draft-*`, `omo/draft-*`: the chat send's draft check

Recorded 2026-11-12 in an isolated herdr session (herdr 0.9.5, 119 columns by 40 rows) for the chat send's
check of text typed into an agent's own box (`shared/input-row.ts` `typedDraft`), read by
`src/lib/inputRow.test.ts` and `server/core/agent-input-send.test.ts`. pi 1.4.0 (no model signed in) and OmO
5.1.69 ran in a scratch folder with `PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 SENPI_OMO_LOCAL_UPDATE=0`, so neither
looked for an update. Each screen is `herdr pane read --source visible --format ansi`:
`draft-empty` at rest, `draft-typed` with `leftover draft` typed into the box, `draft-slash` with `/mo` typed and
the command list open. Redacted: the shell's user name and host read `tester0` and `host000`, at their width.

`pi/powerline-draft-*-200.ansi`: recorded 2026-11-17 on herdr-core (hc, 200 columns) through Ovis's own
`pane.read --source visible --format ansi`, pi 1.5.2 with the pi-powerline-footer 0.22.0 extension (its status
bar above the editor) in a scratch folder: `draft-empty` at rest, `draft-typed` with `2` typed, `draft-multiline`
with `line1`, Shift+Enter, `line2`. Only the screen's last 20 rows are kept (the status bar and the editor).

## `<agent>/draft-*` for gjc, muse, qwen, cline and dsh-tui: the chat send's draft check

Recorded 2026-11-12 in the agent lab (`~/.dori-sa/agent-lab`, its own HOME and pinned installs, update checks off)
inside an isolated herdr session (herdr 0.9.5, 119 columns by 40 rows), read by `src/lib/inputRow.test.ts` and
`server/core/agent-input-send.test.ts`: gjc 0.18.12, Muse Code 1.4.14, Qwen Code 0.27.2, cline 3.0.74 and dsh-tui
0.19.0, each with its default theme. Same three states as above (`draft-empty`, `draft-typed` with `leftover draft`,
`draft-slash` with `/mo` and the command list open), same redactions. Only gjc's box is read by the terminal peek too.

## `<agent>/draft-*` for letta, maki, kimi, gemini and kilo

Recorded 2026-11-12 in the agent lab the same way (isolated herdr session, 119 by 40, default themes, update checks
off): Letta Code 0.34.23, maki 0.7.1, Kimi Code 2.5.3 (herdr names it `kimi`), Kilo 7.8.27 on the lab's QA backend
(`run --qa`), and Gemini CLI 0.68.0 on the team proxy (it speaks only the Gemini API). Same three states;
`kilo/draft-session-*` are Kilo's box under its first answer, the others its home screen. Letta's agent id reads
all zeros.

## `omp/draft-*`: omp 18.14's editor for the draft check

Recorded 2026-11-14 in an isolated herdr session (herdr 0.9.5, 119 columns by 40 rows): omp 18.14.0 in a scratch
folder with a scratch HOME (its setup skipped, no model signed in, default theme) and `PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1`. Same states as above, plus `draft-lines` with `second line` typed on a second row
(Shift+Enter). omp 18.14 draws its status line without the frame 18.8.7 drew, so the peek's omp recognizer
reads these as `gone`; only the draft check reads them. Nothing to redact: the folder is the scratch one.

## `codex-0.167.0/`: Codex's own screens, as the bridge reads them

Recorded 2026-11-11 in an isolated herdr session (herdr 0.9.5) for the bridge's rule that no chat
message is typed into one of Codex's own screens (`server/dialogs/codex.ts` `codexOwnScreenOpen`),
read by `server/dialogs/codex-own-screen.test.ts`, `server/core/codex-own-screen-send.test.ts` and,
for the Ultra composer, `src/lib/inputRow.test.ts`. Codex 0.167.0 ran with a scratch `CODEX_HOME`
and a loopback stand-in for its provider (no account, no request to a model) in a scratch git
folder, with no `[tui]` setting. herdr reported the pane `idle` under every screen here but the
folder question: that one read `blocked` at 100 columns and `idle` at 40, and any screen reads
`unknown` for the first seconds after Codex starts.

- `<screen>-<cols>.txt`: the screen as `pane.read` with `source: "detection"`, `format: "text"`
  gave it, at 100 columns by 30 rows and at 40 by 15. Trailing spaces are cut.
- `<screen>-<cols>.ansi`: the same screen as `herdr pane read --format ansi` gave it (the Ultra
  composer only), for the recognizer that reads cells.
- Screens: `/model` (`model-list`, `model-effort` with the cursor on a level, `model-effort-last-row`
  on the row that opens more, `model-advanced`), `/permissions`, `/review`, `/theme`, `/resume`,
  `/statusline`, `/experimental`, `/rename`, `/agents` and its `?` help, `/keymap`, `/diff`, Find
  (F3), the search through earlier prompts (Ctrl+R), and the folder question (`trust`). The
  composer: `composer-empty`, `composer-draft`, `composer-shortcuts` (after `?`), `slash-popup`
  (`/mo` typed), and at Ultra reasoning effort (`composer-ultra-*`, after `s` on `/model`'s Ultra
  row; `-banner` is the moment after it, with the banner where the status line belongs).
- Recorded the same day with the lists' cancel key remapped in `/keymap` (`tui.keymap.list.cancel`):
  `*-cancel-ctrl-*` (Ctrl+Q, which a footer draws `^q`) and `*-cancel-alt-*` (Alt+X, drawn
  `alt+x`); `keymap-edit` is the list a shortcut's row opens, and `keymap-capture` the view that
  waits for the new key (`Press the new key now. Esc cancels.`).
- Not here: the transcript's own pager. Ctrl+T redraws the history in place in this layout and
  leaves the composer; with `[tui] fullscreen_transcript = false` it opens a pager (seen once,
  not recorded), and that setting draws the composer's rows differently too.

Redacted: the scratch folder's user name reads `tester0`, at its original width.

## `grok-1.0.77/`: Grok's prompt queue, as the chat's Send now reads it

Recorded 2026-11-16 in the isolated herdr session `ovis-test` (herdr 0.9.5, 119 columns by 40 rows) for the chat's
Send now to a working Grok (`server/core/grok-queue.ts`), read by `server/core/grok-queue.test.ts`. Grok 1.0.77 ran
in a scratch git folder with a scratch `GROK_HOME` whose one model was a loopback stand-in (OpenAI chat completions
that streamed a numbered word every half second, or asked for one shell command): no account, no request to a
model, and Grok's own screens unchanged. Every screen is `pane.read` with `source: "detection"`, `format: "text"`
(`herdr agent read --source detection --format text`), trailing spaces cut. herdr reported the pane `working`
under each fullscreen screen with a turn running, `blocked` under `permission`, and `done` under `idle` and
under every minimal-mode screen, a turn running or not.

- Fullscreen, nothing queued: `idle` (at rest after turns), `working` (a turn running).
- Queued rows, each sent by herdr's `agent prompt` during the turn, drawn as `#N <text>` above the turn's status
  row: `queued-1-hint` (150 ms after the first queueing Enter of the session, with Grok's one-time `Queued · Enter
  to send now` hint above the input box), `queued-1` (a later one, no hint), `queued-3`, `queued-long` (a row cut
  with `…`), `queued-multiline` (a two-line message drawn `multi line A (+1 line)`). With anything queued and
  the prompt empty, the shortcuts row starts `Enter:send now`.
- `after-send-now`: 150 ms after an Enter on the empty prompt with three rows queued: the top row went as a new turn
  (the turn at work was cancelled), two stay.
- Focus elsewhere: `queue-pane-focused` (Ctrl+;, the rows framed with `[Send now]`, the prompt drawing its
  placeholder `Build anything`), `scrollback-focused` (Esc from there).
- `permission`: the shell command's approval card during a turn; it replaces the input box.
- Drafts during a turn: `draft-lines` (two lines, Alt+Enter between), `draft-second-line` (an empty first line).
- Minimal mode (`/minimal`): `minimal-working`, `minimal-queued-1`, `minimal-queued-2`: no input box, the
  queue only as `N queued · /queue` on the info row.

Nothing to redact: the folder is the scratch one, shown shortened.
