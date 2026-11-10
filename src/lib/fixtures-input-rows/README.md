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
- Not here: the transcript's own pager. Ctrl+T redraws the history in place in this layout and
  leaves the composer; with `[tui] fullscreen_transcript = false` it opens a pager (seen once,
  not recorded), and that setting draws the composer's rows differently too.

Redacted: the scratch folder's user name reads `tester0`, at its original width.
