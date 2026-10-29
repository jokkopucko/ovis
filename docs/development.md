# Development

## Run it

Run the server and Vite side by side:

```bash
bun install
bun run server   # API + WebSocket on :7317
bun run dev      # Vite on :5173, proxies /api and /ws
```

`bun run server` and `bun run dev` never update themselves; only `bun run start` and the plugin run the update supervisor.

The plugin's `start` and `stop` (`scripts/plugin.ts`) take turns through `lifecycle.lock` in the
plugin's state directory (the owner lock of `server/owner-guard.ts`, taken over once its owner is
proved gone): a start holds it until its server answers or the start fails, a stop until the server
is gone, and one that waits says so and gives up after 60 s, never blocking on the lock's file guard.
A start also keeps its server's birth in `server.owner` beside `server.pid` (or that it could not be
read), opens no second server while that process may still run, even when it does not answer and its
port looks free, and stops a server it could not record. `stop` on Linux and macOS leaves alone a
pid the record proves another process holds now. A start keeps the run before it as
`server.log.1` unless the recorded server still runs, and a failed start shows the last 15 lines of
what its own server wrote, reading at most the log's last 64 KiB. That bounds what a failed start
reads, not the size of a running server's log.

## Connection diagnostics

Transport failures write one JSON line to the server's standard error, with an ISO timestamp,
an opaque failure-episode ID and a fixed event name (`herdr.rpc.failed`, `machine.local.failed`,
`machine.remote.failed` or `websocket.failed`). RPC records include the method, request ID,
elapsed time, connection time when known, deadline and other in-flight request count. Compare the
request ID with Herdr's own log; a timeout alone does not identify which process stalled.

A later successful RPC or machine connection writes one `.recovered` line. Repeated failures are
summarized at most once every 30 seconds per RPC method/peer or machine, with suppressed counts;
bookkeeping retains at most 128 recent keys per logger, including healthy keys so flapping cannot
reset the throttle. Only a visible failure episode emits a recovery; a silent one (every failure
suppressed) keeps its `episode_id` and start into the next visible failure, so that line's
`since_first_failure_ms` can span a healthy gap. Abnormal browser WebSocket closes are
coalesced separately for local and relayed connections; normal closes and server shutdown are quiet.
`websocket.failed` means any close other than 1000 or 1001, so it also covers closes the server starts
itself (device revoke 1008, output stall 4008, a remote PC disconnecting 1012); `close_code` tells them apart.
The close reason, input, credentials, peer names, socket paths and raw exception messages are never
included. A remote machine's opaque UUID may appear, not its name or SSH address. These records are
separate from the request-completion log and do not add timestamps to older console messages.

Every request reaching the server's fetch boundary gets a new server UUID in `X-Request-Id`.
Same-origin API calls also send a fresh client UUID unless the caller supplies one. Client IDs
are accepted only as 1-64 ASCII letters, digits, dots, underscores or hyphens; repeated client
IDs never replace server uniqueness. Unexpected-error handles use the same server ID.

The server keeps `http-requests.jsonl` in its resolved state directory, rotating before a write
would exceed 1 MiB and retaining only `http-requests.jsonl.1`: at most two 1 MiB files. The
directory is created with mode 0700 when missing; an existing directory keeps the operator's
permissions. Regular log files use mode 0600 on platforms with POSIX permissions; the writer
refuses symlinked log paths where no-follow opens are supported.
Each line is at most 1024 bytes and contains only `request_id`, optional `client_request_id`,
normalized `method`, fixed `route` template, `status` and monotonic `latency_ms`. Unknown
methods become `OTHER`; static and unmatched routes are fixed categories, and dynamic
identifiers become placeholders. Matched dispatch branches assign the templates; the writer
never reconstructs them from URLs. Startup and access refusals use fixed categories too.
No URL queries, bodies, credentials, labels, file or socket
paths, or exception text enter this file. Storage failures never change HTTP responses.
The per-server writer has no pending queue and closes at shutdown.

A completion means response creation, not completion of body delivery: an SSE or file stream
is recorded without reading or waiting for it. A successful local or relayed WebSocket upgrade
is one 101 completion; its handshake carries the same response headers, and the fetch handler
still returns `undefined`. Ordinary responses carry the server ID too. The default
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer` fill absent headers only,
preserving each route's CSP, framing, MIME, caching and compression headers.

## Checks

Production builds create Brotli (`.br`) and gzip (`.gz`) sidecars for JavaScript and CSS under
`dist/assets/`. The static handler negotiates these with `Accept-Encoding` and sends
`Vary: Accept-Encoding`; a client that excludes every available representation gets 406.
Older builds without sidecars retain identity responses. The shell and service worker keep
their revalidation policy, and user files and API responses are never compressed by this path.

`bun run check` runs what CI runs, from the same script (`scripts/check.ts`):

```bash
bun run check fast                  # CI's Fast checks: workflow syntax, generated types, typecheck, build, unit tests
bun run check integration browser   # CI's Integration and browser: a build, then both lanes side by side
bun run check full                  # fast, then both lanes
bun run check concurrent            # full, with the unit tests moved beside both lanes: same steps, less wall time
bun run check run bun test --timeout 15000 ./server/api.contract.test.ts   # one command on the same isolated herdr
bun run check run --build bun scripts/ui-regression.ts                     # build and browser script under the same lock
```

`fast` needs no herdr. The other modes run on a herdr of their own: its config, its plugin state
and Ovis's state live in a directory made for the run (`XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`OVIS_STATE_DIR`), under a session name made for the run. Nothing reads your herdr config,
so no plugin installed there starts with the test servers, and two runs on one PC share no
socket and no file. The run stops its herdr servers and removes the directory when it ends, also
when it is interrupted; `CHECK_DIR=<path>` keeps it there instead. A few lane or `check run`
invocations may run at a time on a PC, each in a slot: a loopback port from 41737 up that the run
listens on while it runs, so a run that died holds none. `CHECK_MAX_RUNS` sets how many (1 to 8);
the default is one per eight cores, from 1 to 2. The contract and browser tests are bound by
timing, so more runs side by side make them fail each other: on a 32-core PC three at once
already lost Chromium screenshots in the browser lane, so raise it only to look for such failures. A run that finds every slot taken
names the holders and exits, or, with `CHECK_WAIT_SECONDS` (0 to 7200), waits that long for one
first, as CI's herdr-backed lanes do. A second run in the same checkout exits at once, even with
slots free: runs in one checkout share `dist/` and the generated types. A checkout is its real
path, plus `RUNNER_NAME` when that is set: the self-hosted runners of one PC share a loopback and
all check out to the same path. The
generated-types and generated-themes checks (`bun run generate:types --check`,
`bun run generate:themes --check`) are read-only, but `test:unit` includes
`scripts/generate-protocol-types.test.ts`, which rewrites the generated file while it runs. Fast
checks and the browser lane also build into `dist/`; avoid overlapping runs that write to the same
checkout. (`check run` runs only its named command unless `--build` is supplied.)
Theme colors are edited only in the theme blocks of `src/styles.css`. Never edit the generated
copies (`src/lib/themes.generated.ts`, the DESIGN.md region between the `GENERATED THEMES`
markers, the `theme-color` tag in `index.html`, the colors in `public/manifest.webmanifest`); run
`bun run generate:themes` after a color change.
The case folding a typed answer compares option names with (`src/lib/caseFolding.generated.ts`) is
generated from Unicode's CaseFolding.txt for the version pinned in `scripts/generate-case-folding.ts`,
and the letters drawn like Latin ones (`src/lib/confusables.generated.ts`) from that version's
confusables.txt by `scripts/generate-confusables.ts`. Each script refuses a source whose SHA-256 is not
the one it pins. Never edit the tables: after raising the version, review both files, set their
digests, and run `bun run generate:case-folding` and `bun run generate:confusables`.
Admission is serialized briefly on port 41745. After taking a candidate slot, the run checks all
eight slots again for its checkout and counts every active holder against its requested limit,
including holders above its candidate range. A busy admission port refuses rather than waits.

`check concurrent` runs the same steps as `check full`: workflow syntax, generated types,
typecheck and build first, then the unit tests side by side with both lanes instead of before them.

Unit tests run in parallel processes; `UNIT_TEST_WORKERS` sets the count (default: min(cores/2, 8)
locally, 4 in CI). Each file runs independently in its own process; no shared state between
processes. The queue is ordered largest file first, so long files start early. Without `sh`
(native Windows) the files run serially in one process.
Explicit `CHECK_DIR` and `CHECK_REPORT` paths are claimed exclusively by canonical path, even for
`fast`, before writing reports, logs or isolated state. Pid markers are released at exit after the
final report and session cleanup; a dead owner's marker is reclaimed under serialized admission.
Lock refusal exits with the holder's identity before writing a report, so it cannot overwrite
an active run's output or stop its sessions.

Each admitted check run writes a JSON verification report and per-command logs. The default report is
`node_modules/.cache/check/<run-id>/report.json`, or `CHECK_DIR/report.json` when `CHECK_DIR` is set;
`CHECK_REPORT=<path>` selects another location. Keep reports outside tracked source. CI retains
reports and logs on success and failure. Reports identify the checked HEAD, available PR base,
tracked and untracked source fingerprints, tool versions, commands, timings, exit codes, and
skipped, not-run or interrupted steps. A command failure is recorded even when its test runner
does not expose individual test names.

Read the verification status and source identity, not just a zero exit code. Changes during a
run invalidate its source verification; a later edit or restack requires new verification.
An unavailable source fingerprint, or an unreadable artifact after a successful build, fails
the check even when its commands returned zero.
Whatever a step leaves running in its process group (with its output closed or not) is ended
when the step ends, and the step's report says so.
A teardown that did not finish also fails the check: a step's process group still there after
SIGTERM, then SIGKILL and their grace (only "no such process" proves it gone; a process the run may not signal
is still there), or a herdr session of the run whose stop failed. Every other stop is still
tried. The run then keeps its isolated directory instead of removing it, prints its absolute
path, lists it under `evidence.retained` in the report and adds the failures to `errors`. A
run that passed exits 1 with status `failure`. An interrupted run keeps exit code 130 or 143
and status `interrupted`, with the same errors and kept directory. Look through the kept
directory, stop what is left, and remove the directory yourself.
`check run --build` records the build made for the command. Without it, an existing `dist/`
has unknown provenance and cannot establish that a browser tested current source. Report and
log collection is for isolated fixtures: do not pass real credentials or live-user commands to
the test runner. A report is evidence, not an authorization to merge or publish.

A local pass is not CI's: the PC has its own Node (CI pins 22), its own cores and its own system
libraries. The browser lane uses the lockfile's Chromium, which it downloads into Playwright's
cache on first use.
`HERDR_TEST_SHARDS=4` runs four integration files at a time, each with an
isolated herdr session. Local checks and hosted CI default to one; self-hosted CI uses four.

The single commands still work on their own:

```bash
bun run typecheck
bun run build
bun run test:unit               # no herdr needed; CI's Fast checks run it
bun test                        # needs herdr installed; creates and removes its own workspaces
bun run test:ui                 # browser regression against isolated test servers
bun scripts/sticky-modifiers-regression.ts # mobile held keys through real legacy/Kitty PTYs
bun scripts/key-bar-customization-demo-regression.ts # mobile key layout, saved combinations and migration on demo fixtures
bun scripts/key-bar-hold-repeat-regression.ts # phone touch key-bar taps, holds (arrows and editing keys), swipes and sticky Ctrl on demo fixtures
bun scripts/settings-pages-demo-regression.ts # every Settings page on a 390px and a 320px phone, and Back stepping out of the dialog
bun scripts/interface-font-demo-regression.ts # Interface font at 390 and 1440: System and a typed list lead --font-ui, a reload keeps it, Default restores it; the message box takes the Chat font
bun scripts/theme-first-paint-demo-regression.ts # the saved theme in every painted frame before and after the app starts, root and demo builds under the app's CSP
bun scripts/push-health-demo-regression.ts # the alerts health notice with a stand-in PushManager: a retired subscription told once over the pane and in Settings, repaired once; a refusal, a key mismatch, denied, unsupported, offline, loading and a watching device's refused test, at 390 and 1440, light and dark, Korean at 390
bun scripts/device-security-demo-regression.ts # Phone & devices on demo fixtures: revoking every device (the caller's warning, the confirmation, a refused write, a watching device) and the line every window gets when a device pairs
bun scripts/chat-browser-qa.ts  # chat lens end to end
bun scripts/omo-plan-browser-regression.ts # OmO todo progress and plan panel on isolated native fixtures
bun scripts/pane-input-focus-demo-regression.ts # the input focus shortcut against fictional panes
bun scripts/mirror-scroll-demo-regression.ts # fixed mirror wheel/touch, native history, no guessed program input, observe guards
bun scripts/mirror-fold-demo-regression.ts # a mirror, or an attached pane a phone watches at a wider grid, folded whole (portrait, landscape), Original width from the pane menu, driving phones and desktops unfolded
bun scripts/shortcut-exact-modifiers-demo-regression.ts # recording exact-modifier chords: confirm, refusals, dispatch
bun scripts/output-browser-qa.ts # terminal output flow control end to end
bun scripts/math-browser-qa.ts  # chat math: KaTeX loads with the first expression
bun scripts/recent-folders-regression.ts # owned workspaces: PC-scoped history, reload, three chips on one row that fill Directory, pending and failures
bun scripts/phone-worktree-sheet-regression.ts # a phone's New worktree sheet: the agent list's own stroke, and a Shell checkout's terminal opening
bun run test:ssh                # remote-PC integration over SSH
bun scripts/fresh-install-docker.ts [owner/repo] [ref]  # a new user's install in a bare Ubuntu (Docker)
```

`fresh-install-docker.ts` is the check for "does a new user get a working install": a disposable
Ubuntu 24.04 with only curl, git and the distro's Node 18, a normal user, herdr and Bun from their
installers, a headless herdr, then `herdr plugin install` of a pushed ref (default: the current
branch), the start action, `/api/health`, the PTY smoke test on the box's Node, and the startup hook
after a herdr restart. It prints the time each step took. `KEEP=1` leaves the container for a look.

Tests run against a herdr session of their own, `ovis-test`. The first run starts a headless `herdr --session ovis-test server` and later runs reuse it, so test workspaces never show in the herdr you work in (`scripts/test-herdr.ts`). Stop it with `herdr --session ovis-test server stop`. `HERDR_TEST_SESSION` picks another name, and `HERDR_TEST_LIVE=1` runs against `HERDR_SOCKET` or your default session instead.

Browser checks launch `CHROME_PATH` when it is set, else Google Chrome at `/opt/google/chrome/chrome` where that exists, else the lockfile's Playwright Chromium (`scripts/chrome-path.ts`; install it with `bun node_modules/playwright-core/cli.js install chromium`). After a herdr upgrade, refresh the generated wire types with `bun run generate:types --refresh` (and `--check` to verify).

`HEADED=1 bun scripts/chat-browser-qa.ts` opens its owned native-transcript fixture in a
visible Chrome window. Its detected Codex fixture process keeps the rollout open; no
real model is invoked by this script. Set `CHROME_PATH` to the macOS Chrome binary there.

For isolated phone viewer and keyboard layout regressions (no herdr session; the demo runner builds the real client locally):

```bash
bun scripts/file-viewer-mobile-regression.ts  # 8 viewport cases × tall/wide images
bun scripts/keyboard-viewport-regression.ts   # keyboard, rotation and measured standalone status inset
bun scripts/keyboard-viewport-demo-regression.ts # original real-app viewport suite on disposable demo fixtures
bun scripts/terminal-keyboard-demo-regression.ts # the key bar's Show/Hide keyboard control: current-mode focus, measured state, composition refusal, observe/held/offline/ended; `--serve-ios` only serves the build on loopback for a Simulator
bun scripts/droplet-demo-regression.ts        # real-app alerts below the header, keyboard and landscape
bun scripts/chat-greeting-demo-regression.ts  # an empty chat's greeting: centred on a desktop, docked on a phone
bun scripts/reply-comments-demo-regression.ts # comments on a reply (#511): the floating Comment moves nothing, one chip, the next message carries them for an agent alone, a slash command leaves them; 1280 and 390, Codex palette in UI_EVIDENCE_DIR
bun scripts/composer-fit-demo-regression.ts   # one Send/Stop control, pending Send now actions, context/label fit and Chat font sizing
bun scripts/plan-chip-demo-regression.ts      # the plan chip's step in progress: one row at 390 and 1440, cut when long, with tasks, the list's read states, offline and in a split, Korean too
bun scripts/held-rows-demo-regression.ts      # held messages: the fold under an approval card, its button, a row's error
bun scripts/sidebar-activity-demo-regression.ts # Agents order Activity and pins: blocked pinned, recency, Pin agent / Unpin agent and Pin workspace / Unpin workspace from a right-click and the context-menu key, the ⋯ on a phone, and a finish opened here drawn as ready until the next one
bun scripts/hide-pc-demo-regression.ts       # Remote PCs → Show in sidebar at 390 and 1440 on two demo PCs: a hidden PC leaves the sidebar, Agents and palette, the selection moves, the last PC stays, a reload keeps it, its link still opens, the sidebar's note shows it again
bun scripts/sidebar-filter-demo-regression.ts # the roster's label filter on two demo PCs: fuzzy matches with their ancestors, the selection kept as context, pins and folds untouched, a live and an offline roster, the drawer and a reload clearing it; screenshots at 390 and 1440 in UI_EVIDENCE_DIR
bun scripts/sidebar-branch-line-demo-regression.ts # herdr's branch line: a repository and an unmarked git folder say their branch under the name, worktrees and folders outside git stay one line, desktop and phone, dark and light
bun scripts/sidebar-tokens-demo-regression.ts # herdr plugin tokens on agent rows: a dim line of their own on One line and Two lines, cut with the whole text in the tooltip and a phone's sheet, as text, following herdr's `$name` rows, and changing live
bun scripts/pane-mute-demo-regression.ts    # Mute alerts from an agent's row menu: one shared list for push, droplet, chime and tab notification, two tabs of one server, a second PC's same-named pane, an older server and a watching device
bun scripts/prompt-dock-demo-regression.ts    # the prompt card docked over the input card: its place, its height on a short phone, the grip, a typed pick
bun scripts/plugin-actions-demo-regression.ts # a plugin action that ends after the server stopped waiting: the late failure said, a traceback's height on a phone with its keyboard up
bun scripts/background-agent-detail-demo-regression.ts # a running Claude subagent's detail sheet from the background-task list on demo fixtures: open, Refresh, Escape, a phone's Back, focus return, late answers dropped, and the unsupported and older-bridge notes
bun scripts/font-swap-demo-regression.ts      # the app's faces arriving late on a slow link: a reader at the end of a chat stays there, a tab strip the user scrolled stays put
bun scripts/narrow-pane-demo-regression.ts    # a split pane under 80 columns: the smaller font, a zoom, and a pane no font can bring to 80
bun scripts/agent-skill-menu-demo-regression.ts [agent …] # each agent's `/` (and `$`) skill menu, its origin groups and its skill chips at 1280 and 390px, one case file per agent in scripts/skill-menu-cases/, screenshots in evidence/agent-skill-menu/<agent>/
bun scripts/install-state-demo-regression.ts  # Install app against a real CDP install on a throwaway profile and HOME: the help or the prompt before, gone in the app window and a tab of its origin, back after uninstall
bun scripts/terminal-paste-insert-demo-regression.ts # a phone's Paste key into the terminal's input line and Insert without Enter on the demo shell: the caret, a held or refused clipboard read, the acknowledged clear, an older bridge; with UI_EVIDENCE_DIR, every state at 390 and 1440, light and dark, and Korean
bun scripts/link-menu-demo-regression.ts       # a long press on a chat link in the Android app: Copy link, Open link and, where the WebView shares, Share link; a tap, other words, a mouse's menu, a swipe and a browser keep their own; with UI_EVIDENCE_DIR, the sheet at 390 in English and Korean
```

`FILE_VIEWER_CASE=landscape-notch` selects a viewer case; `FILE_VIEWER_CSS=/path/to/before.css` compares another stylesheet. These checks use Chromium mobile emulation and synthetic safe-area/keyboard geometry; they cannot verify actual iOS Safari keyboard dismissal or notch insets. The existing `bun scripts/file-viewer-regression.ts` separately checks history with an owned herdr pane. The original `scripts/mobile-viewport-regression.ts` exports `checkMobileViewport` for the real-app `bun run test:ui` suite; it also checks the command palette and xterm focus transitions. The demo runners build the real client into a temporary directory, inject the committed fictional-session transport and serve it only on loopback; they do not use a live herdr session or download website media. Run on its own, each builds the client itself (`scripts/demo-build.ts`); the browser lane builds it once and names the directory in `HERDR_DEMO_BUILD`, and each runner copies that instead. They exercise real-app viewport and alert geometry, but not live herdr connectivity.

## Codex Send now

Codex's `Enter` steers the current turn, but can leave the message pending until the next
tool call. The explicit, connection-owned pending-message **Send now** action checks the
live native steering panel beside the empty composer, and that the panel holds the message it
just submitted, before sending one `Escape` to interrupt and submit it. A normal Send,
automatic delivery, another agent or idle Codex never takes this interruption path.
Browser-held copies retain their ordinary Submit path. Every fresh read retains the existing
identity, connection, interactive-menu and secret input guards; if the panel or delivery
cannot be confirmed, the message is uncertain and must be checked in the terminal rather than
retried automatically. The restart gate waits for the interrupted turn's readiness followed
by the new turn's working/ready cycle. If Codex never exposes that cycle, remaining messages
are held for explicit review.

## GJC parent-turn status

GJC status follows the native transcript bound to that pane, rather than a provider child's stale status or session ID. A user message, tool result or tool call keeps the parent turn working; an explicit final answer ends it. Native background-result, monitor and scheduled-task notifications start another turn, and an open `ask` waits for input.

This is parent-turn state, not a count of live background jobs. GJC's job manager keeps that live state in memory, so historical job starts are not treated as proof that a job still runs. Missing or unreadable native evidence leaves herdr's status in charge; interrupted old turns are not successful completions. The isolated `scripts/gjc-status-browser-regression.ts` fixture exercises the real server and browser without invoking a provider or touching existing sessions.

## OmO runtime recognition

A pane runs OmO when its foreground processes prove it. The first proof is the program
itself (`isOmoProcess`): omo's own binary, the omo-ai script a JS runtime runs, the
claude-sdk child, or a hoisted senpi entry loading omo-ai's plugin.

A launcher whose own argv says nothing — a renamed entrypoint, a profile wrapper — is
recognized only by native session ownership, verified read-only on every lookup
(`omoProcessIdentity`):

- its environment as it was at `exec` resolves to an OmO store: an explicit
  `OMO_CODING_AGENT_DIR` entry (an empty value still means the default), or no entry at
  all so the store stays the default `~/.omo/agent`. A store moved only by
  `SENPI_CODING_AGENT_DIR` or `PI_CODING_AGENT_DIR` is not an OmO identity;
- the OS reports a live start time for the exact pid, and the store's
  `sessions/<cwd-slug>/session-holders/` keeps a holder record naming that pid, a
  matching `processStartedAtMs` and the process's own cwd.

An environment marker alone, an argv mention, a stale or reused pid, a foreign cwd or
an unreadable start never identify a custom OmO, and a custom runtime never falls back
to cwd/time inference, file mtimes or launch hints — only its current holders bind it,
so `/new` reports the pending held id and releasing a holder never resurrects an older
transcript. Binding is per owning store: a held or reported session id, a pending check
and an open descriptor match only inside the canonical stores that pane's own processes
resolved, so the same id in two stores stays two independent sessions and two panes
claiming one file fail closed. A held claim survives a missing or unreadable session
file with its store scope intact — a broken header never resolves to another store's
same-id file, and a holder whose own store cannot be resolved claims nothing.

The folder a pane binds is the one its OmO processes actually run in: a process-reported
cwd wins over the pane's `foreground_cwd`/`cwd`, which count only when no process reports
(`omoTranscriptsOfCwd`, `omoSessionForPane` and `omoPanes` resolve it the same way, and
same-cwd peers are the panes resolving to that folder, not the ones sharing a stale pane
cwd). A pane whose holders run in two different cwds is ambiguous and selects nothing.

The process evidence lives in `/proc`: a launcher argv does not identify is verifiable
only where `/proc/<pid>/environ` and `/proc/<pid>/cwd` (or a reported process cwd) are
readable — Linux today; on macOS or Windows such a launcher stays unrecognized until
its argv is added to `isOmoProcess`. A custom launcher must therefore set the store in
the child's environment before `exec` (`OMO_CODING_AGENT_DIR=… my-launcher`): a
variable the process sets only in-process later may never appear in
`/proc/<pid>/environ`, which reports the environment the kernel recorded at `exec`.

## Browser connection diagnostics

The browser keeps at most 32 recent connection breadcrumbs plus one pinned 16-record incident
report in memory, so healthy traffic cannot erase the trigger before upload. A missed heartbeat, close/error,
pagehide, stuck-closing socket, held input or unanswered send can send the latest 16 records to
`POST /api/connection-diagnostics` on this app's own origin. Healthy traffic does not generate an
access log. An opaque, per-connection-object ID and connection epoch correlate lifecycle events,
visibility/online flags, socket states, probe timing, pending counts and numeric receipt IDs.
The browser's online flag is not proof of network reachability; reports are marked client-reported.

Reports never include message/secret text, payloads, terminal output, close reasons, URLs,
credentials or PC names. They are unrelated to anonymous install/update telemetry and never leave
this server. Browser storage is not used. Reports are best effort: a failed HTTP attempt retains
bounded metadata for a later connection event, but a full app/page restart can lose unsent records.
The HTTP attempt is bounded to five seconds and uses same-origin credentials, no redirects and
keepalive for pagehide. Explicit disposal stops new reports; no user input is retained or retried.

The authenticated, same-origin endpoint accepts watch-device reports, but no terminal input.
It revalidates and normalizes every field, accepts at most 16 events and 8192 bytes, and limits one
peer to four reports/minute and the whole server to 16/minute with 128 peer buckets. A valid report
writes one `client.connection_trace` JSON line to stderr. Old/locked endpoints disable reporting;
rate limits back it off without affecting the socket or composer. The demo consumes reports locally.

## Conversation refresh

The chat reads `/api/pane/conversation` after a `conversation-changed` WebSocket frame.
The frame contains only `pane_id` and an opaque `signature`; REST remains the authoritative
paged conversation, including metadata and history identity.

A mounted, visible Chat enables `conversation-watch {pane_id, enabled:true}` on its existing
machine-bound WebSocket, after attaching. Bridges advertise the `"conversation-watch"` feature;
older bridges receive no unknown control frame, and their visible Chat reads every 2 s as before.
The client retains current interest through reconnect, replaying it after attachment and
capability discovery. Hiding the page, leaving Chat or unmounting disables interest. The bridge
drops interest with the attachment, and the client asks again with the pane's next attach: a
tab that let go of its pane while out of use or idle (Settings → Use alongside herdr's own
window) has no pushes while it only watches, so it reads every 2 s, and gets pushes back when it
attaches.
Observers may subscribe without gaining input or resize authority.

The bridge shares one native-file monitor per interested attached pane and one 250 ms stat
timer. Terminal-only and hidden clients do not keep a conversation monitor alive. The monitor
resolves through existing provider/process evidence, checks file identity, size and timestamps
without parsing turns, and rechecks session resolution every 5 s (2 s while a transcript is
missing). The last interested client, failed/ended attachment and server stop release it.

Newest-page refreshes are single-flight. Push-triggered reads start at least 1 s apart using
monotonic elapsed time, with one trailing refresh at a fixed deadline: continuous writes cannot
keep postponing it. A push after idle reads immediately. Initial display, explicit sends,
status/history repairs, reconnect and visibility return bypass that delay but not serialization.
Gap fills run inside the newest read. An older page starts once the newest read in flight has
settled, so a history change found there drops it first, but it never holds the next newest read
back: a clear or a new turn shows while a slow older page loads. A visible Chat with pushes retains a 10 s
backstop for lost notifications; without pushes (an older bridge, a released pane) the backstop
is the former 2 s poll. Hidden Chat starts no new automatic reads or queued
pagination work; returning preserves held history and scroll. Pending work never follows a
pane or machine switch.

A Chat showing the scrollback stand-in (no native transcript yet, or none recognized) has no
file for the monitor to watch. While it is visible, the pane's own `pty-data` (a mirror's screen
frames on Windows) invalidates it through the same coordinator, so continuous output rereads
at most every 1 s and a quiet pane is not read. A Chat showing a native transcript ignores
terminal output.

Conversation responses are gzipped like every other text answer (`server/compress.ts`), with
weak ETags so conditional reads hold across encodings.
Prompt polling remains separate at 2 s: approval cards and suggestions can change on the
terminal screen without a transcript write or agent-status transition.

### Initial push + gzip measurement

On macOS, headed Chrome read an owned native omp fixture with 22 prompt/answer pairs
(initial JSON about 580.7 KB). Five assistant appends ran in a 30 s interval with the agent
status held constant. Initial loading was excluded. The same loopback fixture was measured
before and after; this is not a bandwidth estimate for arbitrary conversations.

These measurements predate explicit visible-Chat subscriptions and the 2 s push-read bound.
They are evidence for the initial push/gzip implementation, not a remeasurement of the current
refresh policy.

| Metric | Before: 2 s polling | After: push + gzip |
| --- | ---: | ---: |
| Write-to-visible latency (ms) | 1659, 666, 684, 697, 710 | 233, 292, 55, 102, 137 |
| Mean latency | 883.2 ms | 163.8 ms |
| Conversation requests / 30 s | 15 (5 × 200, 10 × 304) | 5 (200) |
| Encoded HTTP body bytes | 2,903,810 | 324,544 |
| New conversation WS payload bytes | 0 | 430 |
| Body + invalidation payload bytes | 2,903,810 | 324,974 |

Mean latency fell 81.5% and the measured payload fell 88.8%. HTTP/TLS headers, terminal
traffic and prompt requests are excluded. The deliberately repetitive fixture compressed
to about 11.2% of its identity response; real tool output and conversations will differ.

### Visible-Chat subscription and bounded-refresh resource measurement

The push policy was compared with upstream 2 s polling on macOS in headed Chrome,
using owned native Codex fixtures initially about 60 KB each. Each row is a paired
20 s sample, excluding initial loading, with fresh bridge processes and the same
16 owned workspaces present for both versions. Both versions retain the existing
WebSocket connections; "push" below means WS invalidation followed by REST reads,
not conversation bodies delivered over WS.

CPU is cumulative CPU time of the Bun bridge during the sample; RSS is its sampled
mean. Chrome, herdr, PTY and resolver subprocess CPU is excluded. Hidden visibility
was simulated; these are not physical-phone or long-running leak measurements.
Quota requests were blocked equally in both versions.

| Scenario | Conversation REST reads: polling → push | Bun CPU ms: polling → push | Mean Bun RSS MiB: polling → push |
| --- | ---: | ---: | ---: |
| One idle Chat | 9 → 2 | 119 → 135 | 54.4 → 60.6 |
| Eight idle Chats, same pane | 78 → 15 | 381 → 275 | 58.2 → 68.4 |
| Eight idle Chats, distinct panes | 78 → 16 | 351 → 343 | 70.4 → 71.4 |
| Eight distinct Chats, writes every 4 s | 78 → 39 | 370 → 333 | 70.4 → 73.2 |
| Eight distinct Terminal views | 0 → 0 | 108 → 112 | 58.7 → 58.3 |
| Eight hidden Chats | 0 → 0 | 82 → 100 | 67.6 → 67.8 |
| Eight distinct Chats, writes about every 100 ms | 78 → 80 | 416 → 485 | 73.3 → 72.7 |
| Eight ordinary-shell Terminal views | 0 → 0 | 143 → 150 | 57.2 → 57.1 |

The high-frequency run wrote 197 updates per pane: 656 WS invalidations produced
80 REST reads across eight views, and every view eventually rendered its final
update. Its bridge CPU remained about 16.5% above polling; bounded reads do not
eliminate server monitor work. Resolver subprocess launches were 78 → 110 in that
sample, so bridge CPU alone must not be presented as total system CPU.

Terminal-only, hidden and ordinary-shell Terminal samples had zero conversation
monitors, file-stat checks, transcript resolutions, invalidations and REST reads.
Eight views kept eight live sockets in both versions; same-pane Chats shared one
monitor. Leaving Chat released interest, reconnect restored it, and returning from
hidden rendered an appended marker in under 2 s. Closing seven same-pane views
retained the monitor; closing the last view removed all monitors, the monitor timer
and owned PTY children. No browser errors occurred in these samples.

These resource results do not remeasure the latency or compressed payload figures
in the historical table above. They were taken with a 2 s push-read bound; the bound is now
1 s, so a pane written continuously gets up to twice the REST reads shown in the last rows.

## README media

`bun run build && bun scripts/readme-media/capture.ts` regenerates the stills and demos in `docs/screenshots/` from a staged, fictional session in its own herdr session (`ovis-demo`). Pass `shots` or `video` to redo only one of them. It needs ffmpeg.

- `stage.ts` builds the session from `site/demo/fixtures.ts`: two git repositories under `/tmp/herdr-demo`, each with two agent worktrees herdr adds, a release shell tab, curated chats served in place of transcripts, and the hostname rewritten.
- `record.ts` records a walkthrough at 2x (Chrome's screencast, with `--force-device-scale-factor=2`), logging pointer moves, clicks, taps and camera cues as it drives the page.
- `compose.ts` draws every output frame on a canvas: a backdrop, a browser window or a phone, the frame under an eased camera, and a vector cursor with click ripples or touch rings. It writes `demo-*.mp4` (1920×1200 and 1080×1920, 30 fps) and a GIF of each. Stills get the same window or phone on a transparent background.

The MP4s are not committed: GitHub plays a README video only from an upload (`github.com/user-attachments/…`), so drop them into an issue or PR comment and use the link it gives.
The README's feature grid shows a looping ~7-second cut of each feature video (`docs/media/readme/*.webp`, 800×450, 15 fps), each linking to its upload. Cut one with
`ffmpeg -ss <start> -t <seconds> -i clip.mp4 -vf "fps=15,scale=800:450:force_original_aspect_ratio=increase:flags=lanczos,crop=800:450" -c:v libwebp_anim -loop 0 -quality 72 -compression_level 6 -an out.webp`;
the scale and crop fill 800×450 from any source aspect. Start on a sharp frame, not mid camera move. The top video stays a GitHub upload so it plays at full quality.

The user guide's gallery and the retained banner assets are rendered from the film's stills (below): `bun scripts/readme-media/banner.ts [banner] [look]`
draws `banner.html` in headless Chrome into `docs/media/banner.png` (1920×800) and
`docs/media/look-{chat,prompt,terminal}.png` (1760×1150), each quantized to 256 colours. `docs/media/chat-loop.gif`
comes from `scripts/film/render.ts loop`.

## The film

The film (`site/media/ovis-film.mp4`, 56 s) and chat loop (`site/media/chat-loop.mp4`, with the README's
`docs/media/chat-loop.gif`) are the real client on the demo's fixtures, recorded and composited by `scripts/film/`.
Raw footage and renders go to `_film/` (gitignored); only the outputs under `docs/media/` are committed.
herdrweb.dev no longer publishes `site/media/` (it forwards to ovis.sh), so the film and loop MP4s wait for a
home on ovis.sh. Needs ffmpeg and Chrome at `/usr/bin/google-chrome` (`CHROME_PATH` otherwise).

```bash
bun run build:site                              # the demo the takes are recorded from
bun scripts/film/capture.ts [stills] [rec] [stepped] [R10 R11 … | still names]   # _film/footage/
bun scripts/readme-media/banner.ts              # banner, look-*.png from the stills
bun scripts/film/render.ts film                 # site/media/ovis-film.{mp4,jpg}
bun scripts/film/render.ts loop                 # site/media/chat-loop.{mp4,jpg}, docs/media/chat-loop.gif
bun scripts/film/render.ts check                # acceptance frame grabs, sizes, loop seam
```

- `capture.ts` serves `_site/` under `/herdr-web-ui/` and records `demo/app/` (no demo banner) at 2x with `hand.ts`
  (CDP screencast frames with paint times, plus a cue log of every pointer move, click and tap). Film-only staging lives
  here as init scripts, never in `site/demo/`: fixture `mods` (`todo`, `real`, `stream`, `story`, `worked`) change what
  the fixtures say, and `filmHold` holds the demo's own 4.5 s / 2.4 s timers so a turn stays running on camera.
  `_film/footage/INDEX.md` lists every take, its mods and its marks.
- `timeline.ts` is the film shot by shot as data (source ranges from each take's `marks.json`, camera, type);
  `camera.ts` the easing and matrices; `stage.ts` the compositor page that draws one frame; `footage.ts` reads the takes.
- `render.ts` renders frames in parallel Chromes and encodes once. `render.ts report` prints the shot table with the
  maximum magnification (never above 1 source px per output px); `render.ts stills 8 13.6 …` grabs single frames.
- After a re-capture, re-check what was placed by hand on the frames (the header of `render.ts` lists it), then
  re-render.

## Website

The project's website is <https://ovis.sh/>, served from `ovis-site/`. <https://herdrweb.dev/> (GitHub
Pages, built from `site/`) keeps only what installed users and CI fetch from it: `install.sh`,
`install.ps1` and the browser demo at `/demo/`. Its home page (`site/index.html`, and `site/zh/index.html`
at `/zh/`) is a page whose canonical link, meta refresh and script forward to
<https://ovis.sh/>; ovis.sh hands `/install.sh`, `/install.ps1` and `/demo/` back to herdrweb.dev
(`ovis-site/_redirects`). `bun run build:site` assembles `_site/`: those pages, the Google site
verification file, the installers, the favicons and the demo. It writes no sitemap.

`.github/workflows/pages.yml` runs after CI completes
on `main`, or on manual dispatches from `main`. A completed CI run only builds and deploys when it
succeeded for a push from this repository; PR runs and forks cannot publish. It builds that CI run's
head SHA without running validation again. Manual dispatches run reusable CI validation and the site
build in parallel against the dispatch SHA, and deployment requires both to succeed.
Deployments are serialized. Immediately before deploying,
the workflow checks that the validated SHA is still the latest `main` commit; it fails closed if it is
stale or that check cannot be completed. This does not change the separate Release workflow.
The standalone `main` CI supplies that validation. Its push runs share one concurrency group: the
running one finishes, and a newer push cancels the one still waiting, so a burst of merges runs
main's checks at most twice and the newest run covers the merges in between. The Website workflow
deploys only after a successful push run of main's newest commit; a cancelled run's Website run
skips building. Re-running an older main run while a newer one waits cancels the newer one, and
main's newest commit then waits for the next push or a manual Pages run.

### The browser demo

<https://herdrweb.dev/demo/> is the real client on a fictional session, no server.
`build-site.ts` builds the client a second time with `vite build --base ./` into `_site/demo/app/`,
bundles `site/demo/transport.ts` in front of it and frames it with `site/demo/index.html`. The
transport answers the app's `fetch("/api/…")`, the machines event stream and the `/ws` terminal
socket from `site/demo/fixtures/`: the chats and the Codex approval are the README's
(`site/demo/fixtures.ts`, shared with `scripts/readme-media/stage.ts`), and `machines.json`,
`agents.json`, `commands.json` and the shell pane's `terminal.json` are captured from that staged
session by `bun scripts/demo-fixtures.ts` (needs herdr; it uses the `ovis-demo` session and
scrubs the hostname and login). Recapture them after a herdr upgrade changes the snapshot shapes, or
after changing the staged session. Files, images, push and remote PCs are not part of the demo.

## Releasing

1. Open a release PR that bumps `version` in `package.json` and `herdr-plugin.toml`,
   runs `bun scripts/changelog-fold.ts X.Y.Z [YYYY-MM-DD]` (it moves the `Unreleased` notes in
   [CHANGELOG.md](../CHANGELOG.md) and the [changelog.d/](../changelog.d/README.md) fragments under
   the new version, dated today in local time by default, links each fragment's PR and deletes the
   fragments; then add the `by @login` credits; a fragment merged later must be moved into the
   version by hand, since the release workflow refuses while one is left), and tells the release
   in [release-summaries.json](../release-summaries.json) the way a game's patch notes do: under
   the version, for each language in `SUMMARY_LANGUAGES` (`shared/update.ts`: `en`, `ko`, `ja` and `zh`), the lists `new`, `improved` and `fixed` (a list with nothing to say is left out), the same number of
   lines in every language. From 0.5.0 the notes are short: at most five lines in a list, each one
   plain sentence of at most 70 characters in English (about as short in the other languages),
   naming the change most people will notice first. A change that does not make the cut stays in
   the changelog section, so no line joins two changes to fit it in. It is what an install shows
   before and after the update, with the changelog section folded under it, so a line names what
   changes for the people who use the app and leaves out PR numbers and internals. The unit suite and the release workflow fail without every language.
   The GitHub release is written from the same files by `scripts/release-notes.ts`: the
   English lists under New features, Improvements and Bug fixes, then the version's whole
   changelog section folded under **Full changelog**.
   When the release guards (below) say so, the same PR raises `REMOTE_BUNDLE_VERSION` in
   `shared/machines.ts`, and after deploying the telemetry Worker
   ([telemetry/README.md](../telemetry/README.md#deploy)) commits `telemetry/deployed.json` written by
   `bun scripts/release-guards.ts --worker-deployed`.
2. Merge it after CI passes.
3. If it raised `REMOTE_BUNDLE_VERSION` to N, push the tag `remote-vN` on the merged commit and wait
   for the **Remote PC bundles** workflow to publish it ([remote PCs](remote-pcs.md)); the Release
   run refuses until its manifest and archives can be downloaded, not only tagged. Merge nothing
   that touches `server/`, `shared/`, `bun.lock` or `patches/` until the Release run is done: the
   Release run would then ask for a follow-up PR that raises the number again and a new tag.
4. Run **Actions → Release → Run workflow**, select `main`, and enter `X.Y.Z` without `v`.
   The CLI equivalent is `gh workflow run release.yml --ref main -f version=X.Y.Z`.

The workflow validates metadata, then runs the same unit, integration and browser checks
as PRs against the exact `main` commit selected when the run starts. Only after all checks
pass does it create the tag and GitHub release. A failed validation creates neither. Beside the
checks it builds the Rust PTY host (**Rust PTY host binaries**, `.github/workflows/pty-sidecar.yml`):
static Linux x64 and arm64 binaries, a universal macOS one, `ovis-pty-sidecar.json` (the version,
the `crates/pty-sidecar` git tree they were built from, and each file's SHA-256) and `SHA256SUMS`,
all attached when the release is created, so no tag is seen without them. `bun
scripts/pty-sidecar.ts install` (herdr's plugin build, each update installed from the app, and
`install.sh`) puts the binary for its PC in `bin/ovis-pty-sidecar` only when the release's crate
tree matches the checkout and the SHA-256 matches; otherwise that install runs the Node sidecar where
the PC has Node, and mirrors its panes where it has none.
A release without them gets them from **Actions → Attach the Rust PTY host** with its tag. Then it
attaches the signed Ovis for Mac `Ovis.dmg` to the release, or skips that with a notice while the
signing secrets are unset ([app/mac/README.md](../app/mac/README.md#releases)), and Ovis for Windows'
`Ovis.exe` ([app/windows/README.md](../app/windows/README.md#releases)); the release becomes GitHub's
latest only once it has both. A red `mac-dmg` or `windows-app` job leaves the release published: run
**Actions → Mac app** or **Actions → Windows app** for its tag instead of releasing again.
Do not push release tags by hand: installed updaters read Git tags directly, so a tag is
visible to them even without a GitHub release. Existing tags cannot be reused; fix a
published version with a new patch release. If publishing fails after a tag was created,
verify that tag's commit and repair its GitHub release rather than moving the tag.

Remote-PC runtime bundles are published by a `remote-vN` tag, and an app release requires the bundle
that matches its server (step 3). See [remote PCs](remote-pcs.md).

`scripts/release-guards.ts` fails a release PR (CI's Fast checks) and the Release run when the bundle's
inputs changed since the published `remote-vN` without a raised `REMOTE_BUNDLE_VERSION`, when the raised
one is not published yet (Release only), when `telemetry/worker.ts` or `shared/telemetry.ts` changed
since the deploy recorded in `telemetry/deployed.json` ([telemetry/README.md](../telemetry/README.md#deploy)),
or when the step 1 metadata is incomplete. In CI only the change that bumps the version is checked;
PRs merged before the Release run pass, and the Release run checks the whole tree again.

## Growth snapshot

GitHub shows a repository's traffic (views, clones, referring sites, popular pages) for the last 14
days only. `.github/workflows/growth-snapshot.yml` saves it every Monday, with the stars and the day
each was given (never who gave it), through `scripts/growth-snapshot.ts`. Anyone signed in to
GitHub can download the artifacts of a public repository, so the workflow encrypts the snapshot
before it uploads it, and its log shows totals only.

It needs two repository secrets (Settings → Secrets and variables → Actions); without them the run
says so and ends green:

- `GROWTH_METRICS_TOKEN`: a fine-grained personal access token for devswha/ovis only, with
  the repository permissions **Administration: Read-only** (the traffic endpoints need it) and
  **Metadata: Read-only**. Such a token expires within a year: put the expiry date in the token's
  name. An expired or wrong token turns the run red (exit 1 for no access to the repository, exit
  2 when every traffic endpoint is refused, exit 3 when a stargazer page fails), and GitHub emails
  the failure.
- `GROWTH_SNAPSHOT_KEY`: the encryption password, for example from `openssl rand -base64 32`.
  Keep a copy outside GitHub: without it the artifacts cannot be read.

Artifacts are kept 90 days. To read one:

```sh
gh run download <run-id> -R devswha/ovis -n growth-snapshot-<run-id>
GROWTH_SNAPSHOT_KEY=… openssl enc -d -aes-256-cbc -pbkdf2 -pass env:GROWTH_SNAPSHOT_KEY -in growth.tar.gz.enc | tar xzf -
```

which gives `growth/snapshot-<day>.json` and `growth/stars-by-day.csv`. The same script runs
locally from the repository root with your own `gh` sign-in:
`bun scripts/growth-snapshot.ts --out <dir>`. Exit 0 allows individual traffic errors in the JSON;
exit 2 still writes both files when every traffic endpoint fails. Exit 3 writes neither file,
including no traffic-only snapshot, and preserves any previous output unchanged. This takes
precedence over exit 2 if both stars and traffic fail. Exit 1 covers usage, repository access and
output errors. Both files are staged before publication; a CSV write or replacement failure
does not publish new JSON. No failed run reaches encryption or upload in the workflow. Installs and
daily actives by country come from the telemetry database instead:
run `bunx wrangler login` from `telemetry/` once, then
`bun scripts/telemetry-report.ts --out <file.md>` from the repository root
([telemetry/README.md](../telemetry/README.md#reading-the-counts)).

## Pull requests and CI

Contributors: [CONTRIBUTING.md](../CONTRIBUTING.md) is the short version of this section.

Contributors use short-lived `feat/*`, `fix/*`, `chore/*` or `docs/*` branches from `main`.
Independent changes normally get independent PRs. A stack is a narrow exception only when a
maintainer explicitly manages it for a genuine code dependency. Code conflicts and approval gates
are scheduling constraints, not reasons to stack; similar goals or shared CI results alone are not
dependencies. Keep each PR focused on one change. Squash merge it after required checks pass, and
delete its remote branch after merging only when dependent work is preserved. There is no permanent
`develop` branch. Release metadata changes also go through a PR.

### Stored-format changes

These rules bind the next PR that changes the structure of a store this app owns: a browser record
(an `ovis:` key in `localStorage`, such as `ovis:settings` or `ovis:themes`) or a bridge document in the
state directory (`preferences.json`, `devices.json` and the others beside them). Renaming, moving,
splitting or re-encoding a field, or changing what a stored value means, is structural. So is adding a field to a record an older
writer rewrites whole: an old tab's next unrelated save writes the record back without the field
it does not know, and erases it. Only an addition an older writer cannot erase, such as a value
kept in its own key or document, is not structural and needs none of this.

Most stores carry no schema version today. What follows is what the format-changing PR has to
bring, not a description of what every store already does. The `revision` in `preferences.json`
orders writes; it is not a schema version and says nothing about whether a reader understands
the document. The layout check in [`server/session-history.ts`](../server/session-history.ts)
validates a native agent transcript the bridge only reads; it is not a bridge-store migration and
no precedent for one.

The PR description names the store's owner (the key or file, and the module that writes it), the
old and the new shape, which releases read and which write each shape (and what the oldest reader
still running does with the new one), and the HTTP or WebSocket contract that carries the store,
or that none does. Then the change keeps these rules:

- **Tabs already open keep their old code.** An old tab that saves an unrelated setting after the
  new code wrote must not erase the new shape. Already in place for the theme pair: it lives in
  its own key, and the main record keeps the legacy mirrors an old sanitizer reads (`saveSettings`
  in [`src/lib/settings.ts`](../src/lib/settings.ts), old code pinned in
  [`settings.legacy-fixture.ts`](../src/lib/settings.legacy-fixture.ts)).
- **Migrate passively.** A browser that reads an old shared document derives the new shape into
  its own state and advances its baseline to it. It never sends a corrective PUT that writes its
  interpretation back, and a value it cannot read stays the other browsers'. Already in place for
  the theme sides (`takePreferences` in [`src/lib/preferencesSync.ts`](../src/lib/preferencesSync.ts)).
- **Never write over data too new to read.** A reader that finds a structural version it does not
  know keeps the bytes as they are and refuses to write that store. It does not treat the unknown
  version as absent, and does not sanitize the document to defaults and save them over it.
- **Devices fail closed.** A `devices.json` that is damaged or too new keeps the gate closed and
  the registry unwritable. It is never a first installation or an empty registry, and nothing
  reopens pairing. [`server/devices.ts`](../server/devices.ts) already does this for a damaged
  file (`error`, `gated`, `assertWritable`); a too-new version must take the same path.
- **Rollback restores code, not data.** The update supervisor restores the previous release when
  a candidate bridge fails its startup health check
  ([`server/supervisor.ts`](../server/supervisor.ts), [app updates](app-updates.md#boundaries)).
  Both releases share one state directory, so this does not undo a rewrite the candidate already
  made, and a later manual downgrade meets the new shape too. Make old readers safe before the new
  shape is written: ship the reading side or the too-new refusal in a release before the one that
  writes, or keep writing a shape the previous release reads.

The PR's tests, on `mkdtempSync` state directories or a stand-in `localStorage` and event-driven,
cover: an old-shape fixture loading into the new shape; an old tab's unrelated save after the new
code wrote; old and new readers and writers side by side, each keeping the other's values with no
corrective write; a too-new document read without being written (its bytes unchanged after a
write is refused, and for devices the gate still closed); and a failed activation, where the
previous release serves again and reads, or refuses, what the candidate left on disk.

### Coordinated work

For coordinated work, record one small task entry in the existing PR/issue or another single,
explicitly chosen authoritative place before work starts. Use fields `owner`, `scope`,
`branch/worktree`, `start SHA`, `dependencies`, `verification` and `status`. Do not use this guide as
a task-history log.

Assign one writer per branch/worktree, including for generated files and build outputs such as
`dist/`. Keep independent work in separate branches/worktrees. Herdr-backed runs (a lane or `check run`) take one of
a few PC-wide slots ([Checks](#checks)) and only one per checkout, so a worktree runs its checks one at a
time and waits when every slot is taken; serialize other heavy checks when they contend for that PC, runner or shared outputs. The CI workflow's
within-run lane scheduling remains unchanged. Implementation and independent review are separate
roles: an implementer may self-check, but another person reviews when review is required. Human
approvals remain optional under the existing policy; external contributions still need maintainer
review.

For a maintainer-managed stack, state the genuine code dependency. A code conflict or external
approval gate may affect scheduling, but does not justify a stack by itself. After a predecessor is
squash-merged, restack only the child's changes onto updated `main`, retarget its PR to `main`, and
rerun affected verification.
Delete a branch or worktree only after its work and every dependent change are safely preserved.
After an interruption, reconcile the task record with actual branch, worktree, PR and CI state before
resuming; do not duplicate in-flight work or rewrite branches owned by someone else.

Coordinators must have actual authorization and credentials for each repository or branch mutation,
including workflow dispatch; do not infer privileges from the coordinator role. A non-admin
implementation identity must already have the required permission—repository code cannot provision
credentials, and this procedure does not claim they are provisioned. Release actions require explicit
user authorization.

The [CI workflow](../.github/workflows/ci.yml) runs on every PR and `main` push:

- **Fast checks**: frozen dependency install, then `bun run check fast`: workflow syntax
  (checksum-pinned actionlint), generated type freshness, application and critical-tools typechecks
  (`tsconfig.tools.json`), build, and
  `bun run test:unit`. This suite does not start herdr.
- **Integration and browser**: a summary job that fails when any of three jobs fails, each with
  checksum-pinned herdr 0.9.3, Node 22 and the lockfile's Chromium:
  - **Integration tests** runs `bun run check integration`: a build and
    `bun run test:integration` on a herdr of the run's own ([Checks](#checks)). The
    integration files can run a few at a time, each worker on a herdr session of its own
    (`scripts/ci-tests.ts`); hosted CI runs one by one, while self-hosted CI sets
    `HERDR_TEST_SHARDS=4`. `scripts/check.ts` still defaults to one for local checks.
    Missing herdr fails the run. Its herdr servers are stopped even on failure.
    Integration tests have a 15-second default timeout so their bounded process-startup
    probes can finish; individual tests can still specify a longer timeout.
  - **Browser regression (ui-regression)** runs `scripts/ui-regression.ts` and
    `scripts/ui-contexts-regression.ts` concurrently. The core's stateful flow stays serial;
    the extracted feature checks own a separate temporary herdr config/session, Chromium
    process, server and fixture panes. Those helpers stay sequential within their own fixture.
    The context suite prints each helper's elapsed time and stops its owned daemon on exit.
    `bun run test:ui` also runs both suites.
  - **Browser regression (other scripts)** runs every other browser script, four at a time
    on hosted CI and six at a time on self-hosted CI.

  Both browser jobs run `scripts/ci-browser-parallel.ts`, which takes its script list from
  `scripts/ci-browser.sh` (`BROWSER_SCRIPTS` picks from it, `BROWSER_EXCLUDE` leaves scripts out,
  and a name the list does not hold is an error). `scripts/pages-gate.test.ts` fails if the two
  jobs together do not run that list exactly once. A new browser script therefore only needs its
  `run_script` line in `scripts/ci-browser.sh`. `scripts/ci-browser.test.ts` fails if a
  `*-regression.ts` or `*-browser-qa.ts` script is neither run by that list (itself, or through a
  script that imports or spawns it) nor named in its list of scripts CI does not run, and if the
  list names a script that does not exist; it pins no count, so PRs that add scripts do not
  conflict on it.

  `scripts/windows-terminal-browser-qa.ts` needs native Windows, so the browser lane leaves it out
  (it is on that list) and `windows-terminal-qa.yml` runs it on a GitHub-hosted Windows runner: on pull requests
  that touch the mirror, the terminal's viewport code or the xterm patch (on the pull request's
  merge with main, so a branch cut before a fix to the script runs the fixed one), weekly on
  main, and on a manual dispatch (**Actions → Windows terminal QA**). It is not a required check. To run it on
  a Windows PC: `bun install --frozen-lockfile`, `bun run build`, then
  `bun scripts/windows-terminal-browser-qa.ts` with herdr on PATH and Chromium installed.

`bun run check browser` and `bun run check full` still run the serial lane, `scripts/ci-browser.sh`
(`BROWSER_PARALLEL=1` hands it to the parallel runner).
The serial lane prints each script's wall seconds and exit code, including the shared demo
build, then a summary on success or failure. The first failing script stops it.
The parallel runner builds the demo once, prints a line when each script starts and ends (and
every minute a script is still running), and keeps running the other scripts after one fails.
Each script's full output goes to `${CHECK_DIR:-.ci}/browser-logs/<script>.log`, with
`summary.json` beside it; a failure prints the last 400 lines of its log and the log's path, and
the job then fails. CI uploads `browser-logs` with the evidence on success or failure.
A script that fails is run a second time (`BROWSER_RETRY=0` turns that off). One that then passes
does not fail the job, and is not counted as a plain pass either: its first log is kept as
`<script>.attempt-1.log` and printed, the summary marks it `~` and `summary.json` lists it under
`flaky`, and on GitHub it gets a warning annotation and a line in the job summary. A flaky script
is a bug to fix in the script or the app, not noise: the second run only keeps one PR's merge
from waiting on another change's race. A script that fails twice fails the job.
One run of a script may take `BROWSER_SCRIPT_TIMEOUT_SECONDS` (default 600). A run past it is
stopped with every process it started, prints `TIMEOUT <script>` and its last 40 log lines at
once, is not run again and fails the lane (the summary and `summary.json` give it exit 124), so a
hang names itself instead of running into the job's `timeout-minutes`. A script that exits while
a process it started still holds its output open is stopped the same way, as `STOPPED`; on
Linux such a process is found through `/proc` even after its parent has exited. A job cancelled at its `timeout-minutes` with scripts still logging
was usually short of time, not hung: check how long `check: took a slot after` says it waited.
The console, GitHub annotations, job summary and `summary.json` name the failing assertion and
its first script file and line when the log contains them.
`bun scripts/ci-flakes.ts` ranks, across the last 24 hours of `ci.yml` runs and every attempt of
each, which script failed or passed only on a second run, and at which assertion and site. It reads
through `gh` and changes nothing: a failed job's log, and a passed job's only when the job carries
the flaky warning.
Use `--hours 30` for a different window, `--repo owner/name` to select a repository instead of
the current one, or `--json` for counts and rows as JSON; running jobs and unavailable logs are
counted as skipped.

Under `CI` or with `CHECK_DIR` set, both runners create `UI_EVIDENCE_DIR` at
`${CHECK_DIR:-.ci}/browser-evidence`. Only the existing sticky-modifier and file-viewer captures
are enabled automatically: the UI suite and key-bar demo have evidence branches that add
assertions, viewport changes or font waits, so those remain disabled in the lane. Outside
`CI`/`CHECK_DIR`, an explicit `UI_EVIDENCE_DIR` still works as before.
The lane also sets `CHECK_BROWSER_EVIDENCE_DIR` independently of those checkpoint options.
Explicitly registered fixture pages in `ui-regression.ts` and `prompt-dock-demo-regression.ts`
capture their failure screen and bounded console/page errors before cleanup. Set
`CHECK_BROWSER_EVIDENCE_TRACE=1` for Playwright traces with screenshots retained on failure;
DOM snapshots and network recording are disabled, but action parameters and console events can
still appear in the trace. Use only synthetic fixture data. Imported checks and other scripts are not
automatically covered. Evidence failures never replace the original test failure.
CI uploads nested failure artifacts alongside herdr's `test-server.log`; reports and command
logs are retained for successful runs too. All captures use isolated fixtures, never live-user
pages or credentials.

### Self-hosted runner

`ci.yml`'s Linux jobs of a push or a same-repository pull request run on the maintainer PC's runners
(labels `["self-hosted","self-hosted-ovis"]`) by default; other events stay on `ubuntu-24.04`. The repository variable `CI_SELF_HOSTED_LABELS`
overrides that with another JSON array of runner labels that contains `"self-hosted"`, or with the
JSON string `"ubuntu-24.04"` to keep every job GitHub-hosted while that PC is offline. `pages.yml`
and `release.yml` stay on `ubuntu-24.04` unless the variable holds labels. The variable routes:

- in `ci.yml`: Fast checks, Integration tests and both Browser regression jobs;
- in `pages.yml`: the site build and the deploy after successful same-repository main push CI,
  or on a manual dispatch with reusable CI validation;
- in `release.yml`: the preflight and publish jobs.

A push to main takes the repository variable `CI_MAIN_SELF_HOSTED_LABELS` over
`CI_SELF_HOSTED_LABELS` when it is set: `["self-hosted","self-hosted-ovis-main"]` sends main's Linux
jobs to the runners `run.sh --reserved` keeps for them, so a merge's CI does not queue behind pull
request runs, and `"ubuntu-24.04"` keeps only main GitHub-hosted. `CI_SELF_HOSTED_LABELS` set to
`"ubuntu-24.04"` still keeps every job hosted. Delete the variable while no reserved runner is online,
or main's jobs wait for one.

Detect changes, the Integration and browser summary, the Windows and macOS jobs,
`remote-bundles.yml`, `windows-install.yml`, `windows-terminal-qa.yml` and `pr-title.yml` always
stay GitHub-hosted.

In `ci.yml`, Detect changes picks the runner with `scripts/ci-runner-route.sh`. A fork pull request
always gets `ubuntu-24.04`, whatever the variable says. Since that script runs from the pull
request's own revision, the runner also refuses fork code itself: its job-started hook kills the
job's worker before any step, `if: always()` ones included, can run
(`scripts/self-hosted-runner/job-started.sh`). Otherwise the `self_hosted_labels`
workflow_dispatch input, when not empty, overrides the variable for that one manual run. A value
that is not a non-empty array of strings containing `"self-hosted"` fails the job instead of
falling back. `pages.yml` and `release.yml` read the variable directly.

Only a `pull_request` may skip the heavy jobs as docs-only, and only when every changed file is
under `docs/`, ends in `.md` or `.txt`, is the root `LICENSE` or sits under
`.github/ISSUE_TEMPLATE/`. Pushes, dispatches and runs called from `release.yml` or manual
`pages.yml` dispatches always validate in full. Automatic Website runs reuse CI's successful
main push validation instead of calling CI again.

The runner is an ephemeral Docker container that runs one job and exits. Containers have no CPU
quota or total-memory limit; concurrent slots share the host's available resources. The
runners of one PC share one network namespace (a container of its own, not the host's), so
`check.ts`'s slots bound the Integration and both Browser regression jobs of every runner
together: `ci.yml` runs each of them through `bun run check` with `CHECK_MAX_RUNS` and
`CHECK_WAIT_SECONDS`, and a job that finds the slots taken waits for one. A check run on the host
itself is not in that namespace and does not count against it. Its image ships Bun,
Node 22, checksum-pinned herdr, Playwright Chromium and its system libraries, ffmpeg, git, the
checksum-pinned GitHub CLI (`gh`) for deployment and release publishing, curl, jq, unzip,
xz-utils and CA certificates, with no sudo. Self-hosted setup verifies the prepared tools and
fails on a stale image instead of downloading replacements. Rebuild the image after changing
its pins; its Bun pin must match `.github/actions/setup-ci/action.yml`, and its Playwright pin
must match `bun.lock`.

The composite setup action used by `ci.yml`, `pages.yml` and `release.yml` keeps Bun's dependency
cache in `.ci-cache/bun`. Only GitHub-hosted jobs restore/save that cache remotely: on the measured
self-hosted connection, downloading the archive took longer than a fresh dependency install.
Self-hosted jobs install directly from the lockfile without transferring a remote dependency cache.
Hosted browsers use
`.ci-cache/playwright`; self-hosted browsers come from the image. Neither cache restores a
home-directory archive across different workspace depths. Tool/browser preparation no longer
downloads on self-hosted jobs, but dependency installation, checkout and artifact transfers still
do; measure setup, test execution and retries separately when comparing speed. Setup, routing and the security model are in
[scripts/self-hosted-runner/README.md](../scripts/self-hosted-runner/README.md).

`scripts/ci-tests.ts` discovers all `.test.ts` and `.test.tsx` files under
src/shared/server/scripts/telemetry/push-relay/integrations.
Files named `*.contract.test.ts`, tests under `server/herdr/` and `server/pty/`, and
`server/updater.test.ts` (which includes real bridge restart/rollback cases) belong
to integration; everything else belongs to unit. Name new live-server tests
`*.contract.test.ts`. Plain `bun test` still runs both suites for local development.

Remote/server/shared/dependency changes also run the existing four-platform bundle and
SSH workflow on PRs; its publishing job only runs for `remote-v*` tags. Website publishing
continues after `main` pushes.

Repository protection should require PRs and all three checks on `main`—**Fast checks**,
**Integration and browser**, and **Native Windows install** (GitHub App ID `15368`)—including for
administrators. Branch protection does not require branches to be up to date before merging and
does not enforce resolved review threads; resolve every review thread before merging anyway, as a
practice. Force pushes and branch deletion are disabled. Human approvals are optional for this maintainer-led
project; external contributions still need maintainer review. CodeRabbit is advisory, not a required
check. It reviews a pull request once when it opens and not on later pushes; after a later
commit that changes behaviour, comment `@coderabbitai review` on the final head and wait for it.
Which PRs wait for a review, and what stands in when CodeRabbit skips one, is in
[AGENTS.md](../AGENTS.md) (Maintainer workflow).
Release tags must not be moved or deleted. These GitHub settings are separate from files
in the checkout.

The [CodeRabbit configuration](../.coderabbit.yaml) reviews non-draft PRs, reads the committed
[review guidelines](../.github/REVIEW.md) and the AGENTS.md files,
and focuses on protocol, permissions and terminal lifecycle regressions. Generated output
and media are excluded. Enable the [CodeRabbit GitHub App](https://github.com/apps/coderabbitai)
for this repository to activate it; the YAML alone does not install the app. Reassess
useful findings versus false positives after two weeks. Keep final merge decisions with
the maintainer.

See [Terminal input](terminal-input.md) for input readiness, draft ownership and the mobile
input regression matrix.

## Layout

| Path | Contents |
| --- | --- |
| [`src/`](../src/) | React UI: chat, terminal, composer, sidebar, settings |
| [`server/`](../server/) | API, WebSockets, transcript readers, push, PTY bridge, remote PCs and updater |
| [`shared/`](../shared/) | HTTP/WebSocket contract and generated herdr types |
| [`scripts/`](../scripts/) | Plugin lifecycle, type generation, remote bundles, README media, the film and browser checks |
| [`public/`](../public/) | PWA manifest, service worker and icons |
| [`docs/`](.) | Remote PCs, updates, flow control, chat audit, brand assets and README media (`docs/media/`) |
| [`site/`](../site/) | herdrweb.dev (the installers, the browser demo and pages that forward to ovis.sh), built by `scripts/build-site.ts` and deployed by GitHub Pages |
| [`DESIGN.md`](../DESIGN.md) | Design tokens and UI conventions |
