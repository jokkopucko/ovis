# Real multi-question terminal captures

Captured on 2026-10-31 in the isolated headless herdr session `qs-capture`.
Every agent ran in `~/.cache/qs-capture`. No owner's default-session panes were
inspected or controlled.

## Capture method

Each screen was read while the agent was blocked on its native question form:

```sh
herdr --session qs-capture pane read <pane> --source visible --format ansi
herdr --session qs-capture pane read <pane> --source visible --format text
```

The command stdout supplies the fixture content, including real ANSI escape
bytes in the `.ansi` files. The patch-based fixture writer normalizes ANSI
stdout's CRLF line endings to LF and adds a trailing newline.
The plain snapshots contain no escape sequences. No form text was synthesized.

Pane dimensions are 120 columns by 40 rows. `pane get` reports
`scroll.viewport_rows: 40` but does not expose a columns field in this herdr
version; `pane layout --pane <pane>` supplies the actual `rect.width: 120` and
`rect.height: 40`. Terminal control was requested with `--cols 120 --rows 40`,
without `--takeover`.

## OmO 5.1.51

Pane: `w1:p1`, 120 x 40. Engine: `senpi 2026.10.27-1`.
Model: `anthropic/claude-haiku-4-5-20251001`, thinking off.

The initial launch failed with `internal_key_unavailable`: the shell inherited
`SENPI_RPC_INTERNAL_KEY_STDIN`, which made a new OmO process try to read an
RPC-host key from its terminal. Removing the parent's other RPC/session
identifiers alone did not fix it; switching to Node also did not fix it.
The successful launch command was:

```sh
env -u SENPI_RPC_INTERNAL_KEY_STDIN -u SENPI_RUNTIME -u SENPI_RPC_HOST_INSTANCE_ID -u SENPI_RPC_SESSION_IDLE_EVICTION_MS -u PI_CODING_AGENT -u OMO_NATIVE -u SENPI_RPC_HOST_GENERATION -u SENPI_RPC_CLIENT_CAPABILITIES -u SENPI_RPC_HOST_DAEMON_DIR -u PI_PROMPT_CACHE_SAFE_WAIT_SECONDS -u PI_SESSION_ID -u PI_SESSION_CWD -u PI_GOAL_STORE_FILE -u PI_SESSION_FILE -u PI_PROVIDER -u PI_MODEL -u PI_REASONING_LEVEL omo --model anthropic/claude-haiku-4-5-20251001 --thinking off
```

Prompt pasted with `pane send-text`, followed by Enter:

> Call ask_user_question exactly once with waitForAnswer true and three single-choice questions: Color (Red/Blue), Size (Small/Large), Shape (Circle/Square). Do nothing else.

Keys below are cumulative from the initial blocked form. No question was
answered; the single typed `x` remained an unsubmitted draft.

| File | Agent / version | Pane size | Screen | Exact keys after form opened |
| --- | --- | --- | --- | --- |
| `question-steps-omo-5.1.51-q1.ansi` | OmO 5.1.51 | 120 x 40 | Color active, Red focused, 0/3 answered | none |
| `question-steps-omo-5.1.51-q1.txt` | OmO 5.1.51 | 120 x 40 | Plain counterpart of Q1 | none |
| `question-steps-omo-5.1.51-q2.ansi` | OmO 5.1.51 | 120 x 40 | Size active, Small focused, 0/3 answered | Tab |
| `question-steps-omo-5.1.51-q2.txt` | OmO 5.1.51 | 120 x 40 | Plain counterpart of Q2 | Tab |
| `question-steps-omo-5.1.51-q3.ansi` | OmO 5.1.51 | 120 x 40 | Shape active, Circle focused, 0/3 answered | Tab, Tab |
| `question-steps-omo-5.1.51-q3.txt` | OmO 5.1.51 | 120 x 40 | Plain counterpart of Q3 | Tab, Tab |
| `question-steps-omo-5.1.51-review.ansi` | OmO 5.1.51 | 120 x 40 | Submit active, all three unanswered, optional comment editor | Tab, Tab, Tab |
| `question-steps-omo-5.1.51-review.txt` | OmO 5.1.51 | 120 x 40 | Plain counterpart of Submit/review | Tab, Tab, Tab |
| `question-steps-omo-5.1.51-q1-typing.ansi` | OmO 5.1.51 | 120 x 40 | Color own-answer editor, `> x`, typing-specific hint | Tab, Tab, Tab, Tab, literal `x` |
| `question-steps-omo-5.1.51-q1-typing.txt` | OmO 5.1.51 | 120 x 40 | Plain counterpart of own-answer typing | Tab, Tab, Tab, Tab, literal `x` |
| `question-steps-omo-5.1.51.jsonl` | OmO 5.1.51 | 120 x 40 source pane | Real three-question tool call, question metadata, canceled tool result | After screenshots: Esc, Esc |

`question-steps-omo-5.1.51.jsonl` was extracted from the actual isolated session
`01a192b6-556e-7c11-b7fd-14465d447602`. Sanitization follows
`omo-pending-5.1.48-two.jsonl`: retain only the assistant's `ask_user_question`
tool call, its `ask-user:question` metadata, and the matching tool result.
Remove unrelated session/environment records, assistant prose, provider/usage
metadata, and paths. No home paths or credentials remain in this JSONL.
Unlike the pending precedent, this synchronous call's result is `cancelled`,
because it was recorded after cancellation.

After the last capture: Esc discarded the own-answer draft; a second Esc
canceled the form. Once the agent returned to its empty composer, Ctrl+D exited.

## Codex 0.166.0

Pane: `w1:p2`, 120 x 40. Model: `gpt-5.6-luna`, existing default provider.
`codex features list` reports `default_mode_request_user_input` as an
under-development feature, disabled by default; enabling it made the tool
available without switching to plan mode.

Launch:

```sh
codex --no-daemon -m gpt-5.6-luna --enable default_mode_request_user_input -c 'model_reasoning_effort="low"'
```

Prompt pasted with `pane send-text`, followed by Enter twice (the first Enter
left the pasted prompt in the composer; the second submitted it):

> Use request_user_input exactly once to ask me two single-choice multiple-choice questions: Color (Red/Blue) and Size (Small/Large). Do nothing else.

Keys below are cumulative from the initial blocked form, after prompt submission.
No question was answered.

| File | Agent / version | Pane size | Screen | Exact keys after form opened |
| --- | --- | --- | --- | --- |
| `question-steps-codex-0.166.0-q1.ansi` | Codex 0.166.0 | 120 x 40 | Question 1/2, color choices, Red focused, 2 unanswered | none |
| `question-steps-codex-0.166.0-q1.txt` | Codex 0.166.0 | 120 x 40 | Plain counterpart of Q1 | none |
| `question-steps-codex-0.166.0-q2.ansi` | Codex 0.166.0 | 120 x 40 | Question 2/2, size choices, Small focused, 2 unanswered | Right |
| `question-steps-codex-0.166.0-q2.txt` | Codex 0.166.0 | 120 x 40 | Plain counterpart of Q2 | Right |
| `question-steps-codex-0.166.0-q1-back.ansi` | Codex 0.166.0 | 120 x 40 | Back at Question 1/2, Red focused, 2 unanswered | Right, Left |
| `question-steps-codex-0.166.0-q1-back.txt` | Codex 0.166.0 | 120 x 40 | Plain counterpart after navigating back | Right, Left |

After the last capture: Esc canceled the form. `/quit`, Enter, Enter exited
Codex; `pane get` then showed the shell, with no agent.

## Hermes: BLOCKED before the TUI opened

Installed version: `0.21.5+8892.g354724f` (upstream `354724fb`).
Pane: `w1:p3`, 120 x 40. The existing configuration selects provider
`openai-codex` and model `gpt-6-luna`; neither was changed.

The Ovis reader explicitly targets `ui-tui/src/components/prompts.tsx`, so
classic CLI output was not substituted for the requested Ink TUI.

All three launch attempts exited before a prompt could be sent:

```sh
hermes chat --tui --model gpt-6-luna --ignore-rules
hermes chat --tui --dev --model gpt-6-luna --ignore-rules
hermes chat --tui --native --model gpt-6-luna --ignore-rules
```

Every attempt printed:

```text
Failed to load bundled provider plugin solstice: No module named 'httpx'
pm.package.InstallError: npm: node's entry is missing its bundled npm-cli.js
```

The fatal traceback runs through `main_tui_launch.py:_make_tui_argv`,
`source_build.py:source_build_env`, and `pm.ensure("npm")`. No prebuilt
`ui-tui/dist/entry.js` or `hermes_cli/tui_dist/entry.js` exists under
`~/.hermes`, so the existing prebuilt-bundle path could not bypass the broken
build environment. Repairing the owner's installed runtime or installing/building
Hermes outside the requested fixture scope was not performed.

Missing Hermes states: Q1 choices, Q2 after Tab, active open-ended question and
its navigation hint, and the same open-ended question after typing one character.
There are no Hermes fixtures falsely labeled as question forms.

## Verification

All eight ANSI/plain pairs were checked against their live snapshot strings
after line-ending normalization. Stripping the ANSI styling and trimming
line-end padding matches each independently captured plain snapshot. Every
ANSI fixture retains real escape sequences, and every plain fixture is
escape-free. All three sanitized JSONL records parse; the tool call contains
three questions and `waitForAnswer: true`, and the file contains no home paths
or credentials.

`ls -la server/fixtures/question-steps-*` lists 18 new files: 16 screens,
one JSONL, and this manifest. `git status --short` also shows concurrent
modifications outside this task in `server/dialogs/hermes.ts`,
`server/dialogs/omo.ts`, `server/opencode-answer.test.ts`, `server/prompt.ts`,
and `server/question-steps.test.ts`. Those files were not edited by this
capture task. Only the 18 new fixture files belong to this task.

No code tests, fast checks, or full checks were run for this capture-only task.

## Teardown receipts

- `herdr --session qs-capture server stop` succeeded; the background server
  process exited with code 0.
- `herdr --session qs-capture session delete qs-capture` returned
  `deleted session qs-capture`.
- `herdr --session qs-capture session list` succeeded and contained no
  `qs-capture` entry.
- Removal of `~/.cache/qs-capture` was followed by
  `test ! -e ~/.cache/qs-capture`, which succeeded and printed
  `SCRATCH_GONE`.
- Both successfully launched agents had exited to their shells before server
  shutdown. Hermes's failed launches had already exited.
