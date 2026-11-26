# Grok chat

The reader shows Grok's user messages, assistant text and expandable tool rows in
the existing Chat view. Terminal remains the place for approvals. Reading chat makes no
model calls. Reasoning, images and child-session expansion are outside this first scope.

**Supported executable:** chat follows any Grok executable named `grok` or `grok-…`,
including a versioned build such as `grok-1.0.52-linux-x86_64` or `grok-macos-aarch64`,
and a binary replaced while it was still running. Linux reads the held file from `/proc`.
macOS reads it from `lsof`, and that process's home from the kernel's copy of its
environment. Windows shows the terminal view. Lifecycle checks used Grok 1.0.50 and Herdr
0.9.3 on Linux; on macOS the binding is tested against real `lsof` with a stand-in process.
No installer changes the Grok configuration.

Chat shows Thinking or Working from the bound transcript's current turn even if Herdr
reports ready or done. A native completion clears that indicator; late background tool
results do not restart it. This describes the transcript's turn, not input readiness, and
an interrupted turn without a saved completion may remain active until another native
turn or rewind replaces it. Unavailable native history is explicitly marked in Chat.

## Finding the active session

The bridge reads the one foreground Grok process's environment for `GROK_HOME`, or
`HOME/.grok` when unset: `/proc/<pid>/environ` on Linux, `sysctl` `KERN_PROCARGS2` on
macOS, never the bridge's own home. A relative `GROK_HOME` does not fall through to
`HOME`. The pane's Grok process is found in Herdr's foreground list, and chat needs exactly
one: a process whose `argv[0]` is a Grok executable is preferred over a `node`/`bun`
launcher (such as an npm wrapper), and on Linux, if only one `node`/`bun` launcher is listed
(as on herdr-core, which reports only the foreground leader), the bridge follows its single
direct child whose `/proc/<pid>/exe` is a Grok executable. Multiple Grok executables or
multiple Grok children remain ambiguous and use the terminal view. Foreground discovery and the
executable check both accept `grok` or `grok-…`, with packaging suffixes removed; neither
requires a particular build number or a numeric suffix. On macOS the executable is the
first `txt` entry from `lsof` (later `txt` lines are mapped files such as dyld). A
reported ID is looked up exactly across session groups, including hashed directory names
for long paths; a duplicate ID is ambiguous. Directory or modification time never chooses
a conversation, and a symlinked session is not followed.

Grok keeps `events.jsonl` open for earlier sessions as well as the one on screen, and an
in-TUI `/resume` on Grok 1.0.50 does not fire `SessionStart`, so Herdr can keep an old ID.
`active_sessions.json` does not say which session is on screen, and neither does the newest
file. When Herdr reports no Grok session (herdr-core), on Linux `<GROK_HOME>/active_sessions.json`
stands in for Herdr's report only: the bridge reads it with a size cap, validates every entry,
matches the owner Grok process's PID and `/proc/<pid>/stat` start time (`pid_start`), and
takes the entry with the strictly latest `opened_at` (a tie, missing entry, or malformed or
oversized file falls back to the terminal view). A Herdr-reported session keeps priority
whenever present. Chat follows the reported session—whether from Herdr or, on Linux without
a Herdr report, from `active_sessions.json`—only when that process holds its
`events.jsonl`, that ID occurs in exactly one held session directory, and that file was
written more recently than every other held session's `events.jsonl`. Older open session
files do not hide it. Duplicate held IDs remain ambiguous even when only one directory has
`updates.jsonl`; tied write times also use the terminal view.
A held file in the store that may be a session's events file under another name uses the
terminal, since that session could be the newest one written:

- a held file whose name starts with `events.jsonl` anywhere in the store other than a
  resolved real `<group>/<session>/events.jsonl` with an accepted session ID: deleted, renamed
  with a suffix such as `events.jsonl.old`, in a session directory renamed to a name the ID
  filter skips (`.archived-resumed`), or deeper in the store;
- any other file held in a directory of a cwd group (a session's, or one renamed past the ID
  filter) that has no `events.jsonl` on disk, as when the held events file was renamed to
  `old-events.jsonl`, or renamed along with its directory.

A held `events.jsonl` must also match its path's device and inode; a replacement file at the
same path uses the terminal. Write times come from the held descriptors, not path
replacements. Other held files are ignored, so a held events file moved to a place that still
has an `events.jsonl`, or to no session directory at all, is not detected and can leave the
previous conversation visible: renamed with a new `events.jsonl` created beside it, moved into
another session's directory, moved up to its cwd group, or moved out of `sessions/`. Treating
every unexpected held file as ambiguous would catch these, but which files real Grok builds
keep open in the store needs native descriptor captures first; without them, that rule could
send ordinary sessions to the terminal.

On macOS, `lsof -nPbw -a -p <pid> -FfDin` lists the holds: only numeric
descriptors count (`cwd`, `rtd` and `mem` do not), and the device and inode in that
listing must match the named file. Its write time comes from the named file only after
that identity matches. A missing device or inode is not a match. The `lsof` read has a
three-second timeout.

The newest file only confirms the reported ID (Herdr's, or the latest `active_sessions.json`
entry on Linux when Herdr names none); it never chooses another session. A missing held
file or a newer write to another held session uses the terminal view. An in-TUI `/resume`
that writes to another session without updating that report therefore shows the terminal
until the reported session matches and the same checks pass. The same rule applies to every
Grok executable. Builds other than 1.0.50 were not each re-checked.

**Resume limitation:** a `/resume` that Herdr does not hear about can keep showing the
previous conversation until the resumed session writes its `events.jsonl`, because the
previous session may still have the newest held file. This is a display limitation;
approvals stay in the terminal.

## History and limits

The adapter reuses the shared transcript pager and response contract. It applies rewind
markers in file order before paging; a marker changes history identity even before a new
prompt arrives. Old cursors return 409. Compaction records do not discard displayed turns.
Hidden prompts still separate turns; `syntheticPrompt` alone does not hide a message.

Tool updates replace present fields and preserve omitted fields. Native tool names come
from `_meta["x.ai/tool"].name` when ACP `name` is absent. Diffs are retained separately when
later content replaces them. Long output references include store, session/history, call
and output revision, so expanded output cannot remain pinned to an earlier result.
Terminal-reference blocks are shown as references; their separate ACP output is not fetched.

Reads scan at most 32 MiB per catch-up, in bounded chunks, and keep at most 100,000 indexed
prompts/tools per file and 16 indexes. Lines over 16 MiB and unreconstructable history use
the terminal fallback. Newest pages use the shared 16 MiB window; older pages can widen to
64 MiB. A mid-turn page missing its tool-call seed, an unknown/abandoned/earlier-owner update,
or a malformed history-control record is unavailable rather than silently misrepresented.

**Known limitation:** one malformed or unreconstructable record makes that file
terminal-only until it is replaced or shrinks. Later appends do not bring chat back, because
skipping the record could misplace a rewind.

## Verification

```sh
HERDR_TEST_MODE=unit bun test ./server/grok.test.ts
bun run check run bun test ./server/api.contract.test.ts --test-name-pattern 'Grok conversation API'
bun run check run --build bun scripts/grok-chat-browser-qa.ts
bun run check fast
```

The contract test uses an isolated real Herdr and a disposable stand-in process named
`grok-1.0.52-linux-x86_64`; it also unlinks the running binary to cover Linux's ` (deleted)`
marker. It verifies HTTP identity and cursor behavior, not the native TUI.
Native fictional captures separately establish replay equivalence after nested rewinds.
The browser test runs the real built client against fictional files and checks retained
expanded output after updates, shrink and rewind. It never opens the user's browser session.
Native tool writes are also captured from a fictional printf call. Dashboard/background
switching, forks and other builds and platforms remain release-validation work; synthetic
fixtures do not establish those behaviors.
