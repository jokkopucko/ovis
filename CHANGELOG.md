# Changelog

herdr web ui is versioned with [semantic versioning](https://semver.org/). Each release is a
`vX.Y.Z` Git tag with a GitHub release. Installs update only to releases; commits on `main`
between releases do not reach them. Remote-PC runtime bundles are versioned separately as
`remote-vN` releases.

## [Unreleased]

## [0.4.22] - 2026-10-31

### Added
- Read DeepSeek Harness v4 chat on Linux, including reasoning, tools, and history, for the dsh
  terminal UIs (dsh-tui, dsh-tui-pi) and headless runs.
  ([#2453](https://github.com/devswha/ovis/pull/2453) by @jokkopucko)
- With `OVIS_RUNTIME=herdr-core`, New workspace, New tab and Close work on the PC's herdr-core
  terminals, and an agent picked in the dialog starts in the new terminal. A workspace or tab made
  here shows in the Herdr app too, where the app places its own.
  ([#2449](https://github.com/devswha/ovis/pull/2449))
- `OVIS_RUNTIME=herdr-core` shows the terminals of the Herdr desktop app (herdr-core, `hc`) instead
  of herdr's TUI server: the app's spaces and tabs in the sidebar, agent status and alerts from what
  agents report, and the live terminal streamed from herdr-core. Requested by @Ploppy3 (#2439).
  ([#2442](https://github.com/devswha/ovis/pull/2442) by @nahwan-kim)
- Drag a key bar key by its leading handle to change its order in Settings, with edge scrolling
  for long moves. Up/down buttons remain available without dragging; Escape cancels a drag.
  ([#2463](https://github.com/devswha/ovis/pull/2463) by @zerodice0)
- An OmO pane's background tasks now count and list its background commands (`bash` with
  `run_in_background`, or a command auto-detached past the foreground window) and its monitors,
  as a Claude Code pane's background commands are, read from the session's own transcript.
  Detached eval cells, which already counted, are listed too. A persistent monitor is listed
  but not counted, and work started before the OmO process now holding the session reads as lost.
  ([#2468](https://github.com/devswha/ovis/pull/2468) by @Yoonwoo-Ha)
- **Settings → Phone & devices → Portal** can put Portal's own sign-in in front of the address: a
  private link, an Ethereum wallet, or Google or company login (OpenID Connect), each with the
  names, wallets or accounts it lets in. Whoever gets through may watch by default, with no access
  token asked. Invitations keep a watch role on the server; the owner's app token still drives
  and paired devices keep their roles. Devices says who signed in. A visitor let in this way cannot
  pair or revoke devices, subscribe to push alerts or control Portal, and a page of theirs left
  open loses access within 5 minutes of the link expiring or a sign-out. A private-link Portal
  offers **Invite someone**: a link for 1, 7, 30 or 90 days, shown once. The app believes who
  Portal signed in only with a proof it hands that Portal in its environment, so other ways to
  the app's port cannot pass for it. A sign-in needs Portal v2.7.0 or later, which lists
  `--auth-identity-proof` and the OIDC flags; the panel says plainly when the installed `portal`
  does not. Google or company login reads its client secret from
  `OVIS_PORTAL_OIDC_CLIENT_SECRET`. The default, the access token or a paired device, is
  unchanged.
  ([#2065](https://github.com/devswha/ovis/pull/2065) by @rabbitson87)
- A browser that Portal's sign-in let in can sign out from **Settings → Devices**. One click ends
  both app and Portal sessions when both exist; it does not sign out of the identity provider.
  Google or company login shows both callback addresses to register, including the short host.
  ([#2065](https://github.com/devswha/ovis/pull/2065) by @rabbitson87)
- Chat shows the pictures in a GitHub Copilot CLI session: those attached to a prompt and those
  its view tool read, from the bytes Copilot keeps in its own session file.
  ([#2479](https://github.com/devswha/ovis/pull/2479))
- Chat shows the picture attached to a Hermes prompt, from the local file Hermes names for it,
  the way it shows a local image in Markdown; a picture it cannot read stays a link.
  ([#2482](https://github.com/devswha/ovis/pull/2482))
- Chat shows the pictures in a Grok CLI session: those sent with a prompt and those a tool read,
  from the update log Grok keeps for the session.
  ([#2481](https://github.com/devswha/ovis/pull/2481))
- Chat draws a ```svg fence as the figure it is, in the theme's colors, with the same enlarge view
  as a Mermaid diagram. The figure is shown as an image, so its markup never runs in the page; a
  fence still streaming, one that does not draw, one past 256 KiB, or one holding a script, an
  event handler or a reference outside the figure stays a code block.
  ([#2477](https://github.com/devswha/ovis/pull/2477) reported by @affeek)
- Chat draws math written with dollar signs: `$…$` inline, `$$…$$` and a ```math fence as display
  math, beside `\(…\)` and `\[…\]`. A dollar sign reads as math only where a price or a shell
  variable cannot: after no Latin letter or digit, with no space inside its ends, on one line,
  before no Latin letter, digit or shell mark (`{ ( # @ *`), and not a number followed by a word,
  so "$5 and $10", `$HOME/${PATH}` and `$(whoami)` stay as written while `$x$는` and
  `$2 + 2 = 4$` are drawn. A formula KaTeX cannot draw shows as written.
  ([#2498](https://github.com/devswha/ovis/pull/2498) reported by @kjohnsen)
- Settings → Chat → Expand thinking opens the agent's reasoning in the chat instead of folding it
  (#2346), and Collapse work starts a turn's work folded to its one header line, also while the
  agent works; a block waiting on you still opens (#2228). Both are off by default and kept per
  device, and a block you open or fold yourself stays that way for its message.
  ([#2484](https://github.com/devswha/ovis/pull/2484) reported by @altgans and @Ploppy3)
- The card for Claude Code's questions (AskUserQuestion) and its "Ready to submit your answers?"
  review now list the questions as steps, with Back, as omo's and pi's forms do. A step moves
  Claude's own tabs with ←/→ and keeps the answers already given. When the terminal does not show
  the tab expected after a move, the card stops and leaves the rest to the terminal.
  ([#2503](https://github.com/devswha/ovis/pull/2503) reported and co-authored by @jpcarranza94)
- A tab still named by its number ("Tab 2") now shows a few words of its first message, in every
  browser of the server. A name you gave a tab is kept, herdr's own tab names do not change, only
  those words are kept (until the tab closes), and Settings → Name tabs from the first message turns
  it off and deletes them.
  ([#2502](https://github.com/devswha/ovis/pull/2502) reported by @vibewriter-hand)
- A line of a file's diff takes a note for the agent: a + beside a hovered row, a click or tap on the
  row and the bar's Add a note (a full touch target on a phone), or the arrow keys and Enter. The note
  waits with the comments on a reply and goes first in the pane's next message, with where the line
  is, the comparison as it was read and the line's text; nothing is sent until you send. A note that
  would make the message too long is refused, and a pane with no agent says why it takes none.
  ([#2505](https://github.com/devswha/ovis/pull/2505))
- The Ovis relay service (`relay/`): the meeting point where a PC running Ovis and a phone that
  cannot reach it directly both dial out, carrying only end-to-end encrypted frames it has no key
  for and keeping no logs. A PC must prove it holds its key to serve its `server_id`. It runs as a
  Cloudflare Worker deployed from CI with the maintainer's approval, or as a plain Bun server. Ovis
  uses it only once a PC's relay link (below) is turned on in Settings; it is off by default.
  ([#2499](https://github.com/devswha/ovis/pull/2499))
- The PC side of the Ovis relay: a link from this PC to the relay that answers the relay's server
  proof, with `/api/relay` routes to start and stop it that only the owner may use, and only over a
  direct connection to the PC. `plugin pair` prints a relay QR when the relay is online. It is off
  by default: nothing connects until it is turned on in Settings (below).
  ([#2504](https://github.com/devswha/ovis/pull/2504))
- The phone side of the Ovis relay: a hosted shell (`bun run build:shell`) that pairs from the PC's
  relay QR, keeps a device key the browser cannot export, and opens the full app through the relay,
  end-to-end encrypted: terminals, chat, event streams and push alerts. A shell and PC on different
  versions reload onto the newer shell or ask for the PC's update. Like the PC side it is off by
  default: nothing connects until the PC's relay is turned on in Settings.
  ([#2509](https://github.com/devswha/ovis/pull/2509))
- Files and chat images load through the Ovis relay, including PDFs, rendered HTML pages and
  seekable videos in browsers. Clients without a service worker open files up to 64 MiB and
  explain when a file needs to be downloaded on the PC. Copied file links reopen the paired PC's
  reader, and rendered pages remain isolated from the app and its stored device keys. Like the
  rest of the relay it is off by default.
  ([#2509](https://github.com/devswha/ovis/pull/2509))
- Remote access through the Ovis relay can be turned on in **Settings → Phone & devices → Remote
  access through Ovis relay**; it is off by default. Once on, it shows a QR that pairs a phone
  through the relay and says whether a phone is connected; turning it on closes the device gate,
  only the PC's owner on a direct connection can control it, and the PC's relay identity can be
  reset there. The iOS and Android apps open a PC paired over the relay from its pairing link and
  save it by its own address on the hosted shell (app.ovis.sh), which is deployed separately.
  ([#2514](https://github.com/devswha/ovis/pull/2514))
- **Reset relay identity**, under the relay switch, gives the PC a new relay ID and key and removes
  every phone paired through the relay; each then scans a new QR code. The relay ID is derived from
  the PC's key, and the relay lets a PC in only after it proves it holds that key, so knowing the
  ID is not enough to take the PC's place or catch its phones.
  ([#2514](https://github.com/devswha/ovis/pull/2514))
- A Letta Code pane on Letta's local backend shows its model and reasoning effort in the composer,
  as Letta runs the turn: the conversation's own `/model` choice, else its agent's.
  ([#2519](https://github.com/devswha/ovis/pull/2519) by @homebodify)
- Large files and videos over the relay keep up to 384 KiB in flight, so a download isn't held
  back by waiting for each receipt (over 5 MB/s at a 50 ms round trip), while terminal output still
  goes ahead of it.
  ([#2522](https://github.com/devswha/ovis/pull/2522))
- Remote access through the Ovis relay, off until you turn it on under **Settings → Phone &
  devices**: scan its QR code and the phone opens Ovis at app.ovis.sh, end-to-end encrypted to the
  PC, with no Tailscale, account or port forwarding. A phone pairs once with a pairing code and then
  proves itself with its own device key, never a token. Terminals, files, pictures, PDFs, seekable
  videos and push alerts work through it, and **Revoke** cuts a phone off at once. `pair` prints
  the relay's QR code too, and the iOS and Android apps open relay pairing links.
  ([#2522](https://github.com/devswha/ovis/pull/2522))
- Run your own relay with `bun relay/bun.ts` and `OVIS_RELAY_URL`, or host the app yourself with
  `OVIS_RELAY_APP_URL`.
  ([#2522](https://github.com/devswha/ovis/pull/2522))
- Each release attaches the hosted app it deploys to app.ovis.sh as `dist-shell.tar.gz` with its
  SHA-256, so anyone can compare the two. The user guide and docs/relay.md explain what
  relay.ovis.sh and app.ovis.sh can and can't see.
  ([#2522](https://github.com/devswha/ovis/pull/2522))
- DeepSeek Harness is in Settings → Agents and the setup guide: Ovis finds it (`dsh` with the
  dsh-tui terminal UI), installs it with its makers' npm command in a terminal tab, and starts
  dsh-tui from New workspace, New tab and New worktree.
  ([#2524](https://github.com/devswha/ovis/pull/2524))

### Changed
- On a PC with `OVIS_RUNTIME=herdr-core`, Ovis no longer offers renaming, moving, splitting, zooming
  or resizing workspaces, tabs and panes, nor the worktree actions: the Herdr app's window owns that
  layout, and herdr-core refused them.
  ([#2451](https://github.com/devswha/ovis/pull/2451))
- With `OVIS_RUNTIME=herdr-core`, a terminal's live view streams over the server's own connection to
  herdr-core, instead of an `hc attach` process and a PTY host for every open pane.
  ([#2447](https://github.com/devswha/ovis/pull/2447))
- Settings → Phone & devices is shorter: one Connect button opens a Connect a phone dialog with the
  Ovis relay, Tailscale and a pairing code, and the QR codes and longer explanations are there
  instead of on the page. Pair a device opens it on a fresh pairing code.
  ([#2533](https://github.com/devswha/ovis/pull/2533))
- The `tailscale serve` command box no longer has a blue accent stripe on its left edge.
  ([#2533](https://github.com/devswha/ovis/pull/2533))
- Chat shows pictures larger, as a desktop chat app does: a picture you attached and one a tool
  read are drawn whole, up to the message column's width and never past their own size, instead
  of a cropped 9 by 7 rem thumbnail. A tall screenshot, there or in an answer, stops at 70% of the
  window's height (60% on a phone), and a diagram may now grow to the same height instead of
  24 rem. A small icon stays its own size, and a tap still opens the image viewer.
  ([#2539](https://github.com/devswha/ovis/pull/2539))
- Connect a phone makes it plain that a phone can connect without Tailscale: the ways to connect are
  three cards with a one-line hint each (Ovis relay: from anywhere, nothing to install; Tailscale;
  Pairing code), and the Phone row names the relay beside the Tailscale address. The dialog opens on
  the relay whenever it is on or Tailscale is not set up; on a tailnet with the relay off it opens on
  Tailscale, with the relay's switch right on its card. The relay still starts off.
  ([#2567](https://github.com/devswha/ovis/pull/2567))
- A chat opened from a tab, a workspace row or an agent row starts loading when the press begins,
  not after the app has drawn the new pane, so its messages show sooner.
  ([#2562](https://github.com/devswha/ovis/pull/2562) by @jpcarranza94)
- Selecting text in a Chat reply now offers Quote first: it puts the words in the message box as a
  `> ` quote after what you typed, ready to write under, without sending. Comment is still there,
  as the icon beside it.
  ([#2574](https://github.com/devswha/ovis/pull/2574))
- Settings → Phone & devices says each thing once: the separate Ovis relay group is gone, its switch,
  Reset relay identity and start failures are in the Connect a phone dialog's relay card, the
  Connect a phone row shows the relay's state (Online, Off, Blocked), and what a paired device can
  do is explained only under Devices.
  ([#2578](https://github.com/devswha/ovis/pull/2578))

### Fixed
- New workspace's folder picker puts **Use this folder** and the folder filter on one compact row, and
  moves Show hidden into the path bar, leaving more room for the folder list on phones and desktops.
  ([#2555](https://github.com/devswha/ovis/pull/2555) by @iwangjie)
- An answer to one of Claude Code's questions (AskUserQuestion) comes back once the terminal shows
  the next question, the review or nothing. The question just answered, or a generic card from a
  half-drawn screen, no longer comes back for two seconds after the answer.
  ([#2466](https://github.com/devswha/ovis/pull/2466) by @jpcarranza94)
- Claude context uses the session's captured limit, including 1M windows below 200k tokens.
  ([#2452](https://github.com/devswha/ovis/pull/2452) by @jokkopucko)
- Codex Chat no longer falls back to the terminal once Codex has let go of its conversation store:
  Ovis reads the store even when no Codex holds it open, still without writing to it.
  ([#2446](https://github.com/devswha/ovis/pull/2446))
- Codex Chat shows a pane's conversation again after an answer finishes: the "Worked for 4s •
  7:05 PM" line Codex draws below a finished answer no longer keeps the answer from being
  recognised, which left Chat on the terminal view.
  ([#2443](https://github.com/devswha/ovis/pull/2443))
- Copilot Chat recognizes a verified parent-to-child handoff when the parent's complete log first
  identifies its session at release, without requiring an earlier registration entry.
  ([#2457](https://github.com/devswha/ovis/pull/2457) by @YuuuXie)
- With `OVIS_RUNTIME=herdr-core`, starting an agent no longer types into a pane whose own program is
  not a shell, a terminal Ovis started into a Herdr app space or tab with nothing else live in it
  keeps its place when the app adopts it, and resuming a Claude session checks the store a new
  terminal really gets (herdr-core's environment, not Ovis's).
  ([#2456](https://github.com/devswha/ovis/pull/2456))
- With `OVIS_RUNTIME=herdr-core`, a pane shows a finished turn only when its program reported it
  (working, then idle or done): a program's error, a pause it reported, or a report it cleared no
  longer shows as done.
  ([#2455](https://github.com/devswha/ovis/pull/2455))
- Codex Chat on macOS can read a conversation behind Kiro's shell-integration terminal wrapper
  when the wrapper's nested foreground Codex is uniquely proven, even without a herdr agent label.
  ([#2420](https://github.com/devswha/ovis/pull/2420) by @cheol-95)
- Cached nested conversations also require matching wrapper, shell and Codex process start times,
  so reused process IDs cannot retain a previous conversation's binding.
  ([#2420](https://github.com/devswha/ovis/pull/2420) by @cheol-95)
- Same-host web links can open in a closable in-app popup on narrow screens when Web links is set
  to In the app.
  ([#2459](https://github.com/devswha/ovis/pull/2459) by @Haeminway1)
- On the Node PTY host, a terminal whose command exits while its output is paused or still being
  sent keeps that last output: the host now holds the pty until it has read everything, as the Rust
  PTY host does, instead of dropping what was left after 200 ms.
  ([#2461](https://github.com/devswha/ovis/pull/2461))
- After an answer, the question card stays, waiting, until the next question takes its place. It
  no longer disappears and comes back between two questions of one form.
  ([#2467](https://github.com/devswha/ovis/pull/2467) by @jpcarranza94)
- Before updating a bridge that replaces a PC's independently managed Ovis,
  verify the replacement's live ownership. A stale descriptor cannot trigger
  a bundle installation or discard the prior server's reconnect guard.
  ([#2450](https://github.com/devswha/ovis/pull/2450) by @briantcl1992)
- A Chat message to Pi that starts or ends with a space, holds a tab, or ends with an `@mention`
  no longer stays "waiting for transcript" forever and holds every later send on the pane behind it.
  ([#2474](https://github.com/devswha/ovis/pull/2474) reported by @BeerBelly69)
- A message that went to the terminal no longer stays "Not confirmed" when the connection dropped
  before its receipt arrived: the browser that sent it gets the receipt back when it reconnects or
  reloads, within ten minutes. Nothing is sent again, and a message whose delivery was never
  confirmed stays unconfirmed.
  ([#2475](https://github.com/devswha/ovis/pull/2475) reported by @christso)
- Chat no longer rebuilds every message when the pane's skill names load after its transcript, so
  a decoded image no longer drops back to its loading slot as a chat opens.
  ([#2490](https://github.com/devswha/ovis/pull/2490) by @nocstah)
- A Copilot chat no longer splits a turn whose pictures fill the page window: the newest page
  showed only the answer, and the older one the tool calls without their output.
  ([#2483](https://github.com/devswha/ovis/pull/2483))
- Question cards keep terminal context and its caption above the question without overlapping
  on short mobile screens.
  ([#2494](https://github.com/devswha/ovis/pull/2494) by @todor-a)
- At a small or large Chat font size, the space between and inside messages shrinks and grows with
  the text instead of staying at the page's spacing; the view's edges and touch targets keep their
  sizes. On a touch screen, a folded work block's head keeps a 44 px minimum row height, so the
  default Chat font size keeps the same spacing as before.
  ([#2491](https://github.com/devswha/ovis/pull/2491) by @nocstah)
- A shared setting changed just before a reload or a closed tab is no longer lost. Show plan limits
  no longer comes back on: the change is sent as the page goes, or is hidden.
  ([#2487](https://github.com/devswha/ovis/pull/2487))
- A settings change in one Ovis tab no longer undoes a change made meanwhile in another open tab
  of the same browser. A tab now saves only the settings it changed.
  ([#2486](https://github.com/devswha/ovis/pull/2486))
- On Linux without `secret-tool`, Settings → Agents no longer calls a signed-in Antigravity CLI
  "Not signed in": it says the sign-in cannot be read until `secret-tool` (libsecret-tools) is
  installed, and finds the account on the next look once it is.
  ([#2472](https://github.com/devswha/ovis/pull/2472) reported by @matiemer)
- Starting Portal and reading remote access settings over a relay session now use this server's
  listening port instead of the default port.
  ([#2476](https://github.com/devswha/ovis/pull/2476))
- An OmO question card with several questions now moves between them without an answer, as Tab
  and Shift+Tab do in the terminal: tap another question's step, or use Back and the new Next
  button. Codex's question card gets Back and Next (its ←/→), and Hermes's batch of questions
  gets its steps, Back and Next (its Tab and Shift+Tab). Each move sends the agent's own key and
  waits until the screen shows the question it moved to. If the screen shows anything else, the
  card stops and sends nothing more.
  ([#2506](https://github.com/devswha/ovis/pull/2506))
- The iOS and Android apps no longer show the hosted shell's Safari home-screen pairing hint (the
  relay is off by default).
  ([#2509](https://github.com/devswha/ovis/pull/2509))
- Limit self-hosted relay connections, rooms, open sockets per address and address bookkeeping by
  default, with configurable per-address and global rate budgets.
  ([#2514](https://github.com/devswha/ovis/pull/2514))
- Close a relay client that waits 30 s for a PC that is not connected, so waiting clients cannot
  fill the relay while the PC is away.
  ([#2514](https://github.com/devswha/ovis/pull/2514))
- The hosted shell now reads the PC's copy-on-select preference and sends relay-control requests
  through the paired relay connection instead of the static shell host.
  ([#2514](https://github.com/devswha/ovis/pull/2514))
- Opening a Claude Code pane's background-task list reads its subagent history on a file thread,
  so that request's filesystem work no longer blocks other requests and terminal connections.
  ([#2511](https://github.com/devswha/ovis/pull/2511) by @duytbp)
- Words typed in the "Tell Claude what to change" field of Claude Code's plan card go to Claude as
  feedback, and Claude keeps planning, as Enter does in its terminal. The card used to send
  Shift+Tab, which approved the plan with the feedback and started to run it.
  ([#2518](https://github.com/devswha/ovis/pull/2518) by @jpcarranza94)
- Chat's question card can move to unanswered later pi-ask questions with Next, and between omp
  Ask questions without answering. Omp moves need a complete styled tab strip and its matching
  open call; omp's review page is not a step the card moves to, and offers no moves itself.
  Unsent edits stay visible until sent or cleared.
  ([#2508](https://github.com/devswha/ovis/pull/2508))
- Before each key the card sends, a move or an answer, the server reads the terminal again and sends
  the key only if it still shows the question the card was tapped on; otherwise nothing is sent.
  ([#2508](https://github.com/devswha/ovis/pull/2508))
- An omp question cut short on screen keeps the terminal's text on the card instead of the call's
  Markdown, since what is shown may be another call's question that starts the same way.
  ([#2508](https://github.com/devswha/ovis/pull/2508))
- With `OVIS_RUNTIME=herdr-core`, a tab no longer stays paused after a reconnect, and a tab out of use
  no longer starts herdr's read-only view, which cannot reach herdr-core and only logged a failure:
  the server offers no watch there, so a reconnecting tab attaches again at once and a tab out of use
  keeps its last screen until you are back.
  ([#2512](https://github.com/devswha/ovis/pull/2512) by @lifeofpi-ux)
- Over the relay in Firefox, a request made before the connection dropped (such as a prompt answer)
  now fails as not sent instead of going out on the reconnected link, and an upload over the PC's
  limit is refused before Firefox reads it into memory.
  ([#2516](https://github.com/devswha/ovis/pull/2516))
- A relay terminal socket that is sent more than 4 MiB faster than it can hand it on now fails like
  a browser socket with a full send buffer, instead of queueing it all in memory.
  ([#2516](https://github.com/devswha/ovis/pull/2516))
- An answer to a Claude Code tool approval, plan or folder-trust check comes back once Claude has
  closed the dialog. The dialog just answered no longer comes back as a new card for two seconds,
  and Claude's own input box no longer shows as a "Waiting for input" card with Enter and Esc.
  ([#2521](https://github.com/devswha/ovis/pull/2521) by @jpcarranza94)
- A first message typed in the New tab or New workspace dialog goes to Claude Code once it is ready.
  It was often held as "the pane's terminal or agent session changed" or "the agent started for this
  message has ended", because it was bound to a program Claude Code runs as it starts (git, gh), not
  to Claude Code itself.
  ([#2526](https://github.com/devswha/ovis/pull/2526) by @jpcarranza94)
- A Claude Code pane whose session has kept thousands of subagent transcripts no longer has the
  server check every one of them on each status poll: files last written over a day ago are
  checked again once a minute, so the server's event loop stays free for terminals and requests.
  ([#2527](https://github.com/devswha/ovis/pull/2527) reported by @duytbp)
- The first message sent from an empty chat no longer brings up "No conversation yet — say something
  below" for a moment, beside the message itself, before the agent starts working.
  ([#2531](https://github.com/devswha/ovis/pull/2531) by @jpcarranza94)
- An API key or token typed or pasted into the terminal input line is no longer saved in the
  browser's storage while it waits to be sent: such a line stays in the open page only, a reload
  or a replaced herdr does not keep it, and a key an earlier version saved there is removed.
  ([#2532](https://github.com/devswha/ovis/pull/2532))
- Panes show again on iOS 16.4 and later and on Safari 16.4 to 17.3, where every pane said
  "This pane can't be shown.": the app now brings its own `Promise.withResolvers` and
  `AbortSignal.any`, and its own `crypto.randomUUID` for a plain-http address.
  ([#2535](https://github.com/devswha/ovis/pull/2535) reported by @devtm1123)
- In a chat long enough to scroll, a message sent from Chat shows its faded bubble at the end,
  wholly above the message box, instead of partly under it, and the chat no longer jumps up by
  that gap when the agent writes the turn. A long message's bubble shows its words as its turn
  does, up to the same 12 lines, instead of its first 160 characters.
  ([#2538](https://github.com/devswha/ovis/pull/2538) by @jpcarranza94)
- Claude Code's plan shows as its "Ready to code?" card in a narrow pane too, as on a phone or in
  two panes side by side. It used to show as a "Waiting for input" card with only Enter and Esc,
  because the plan file's path in the dialog's last line wrapped onto a line of its own.
  ([#2541](https://github.com/devswha/ovis/pull/2541) by @jpcarranza94)
- An open question or approval card stays in Chat when you come back from the Terminal view and
  across a reconnect. It no longer goes for a moment and comes back with the next read.
  ([#2543](https://github.com/devswha/ovis/pull/2543) by @jpcarranza94)
- Chat reads the agent's question or approval as soon as the pane turns blocked, so the card shows
  with the turn's "Needs you" instead of up to two seconds after it. A question answered in the
  terminal leaves Chat as soon as the agent works again.
  ([#2543](https://github.com/devswha/ovis/pull/2543) by @jpcarranza94)
- A notice or a subagent's result that Claude Code writes while it works no longer draws the turn at
  work again: the tool rows and the work block you opened in it stay open.
  ([#2545](https://github.com/devswha/ovis/pull/2545) by @jpcarranza94)
- A long chat opened again (back from the Terminal lens, or a tab no longer kept) shows its latest
  turns at once, not an older page that then jumps to them.
  ([#2545](https://github.com/devswha/ovis/pull/2545) by @jpcarranza94)
- /clear in a long chat goes from the old turns straight to the new conversation, without an empty
  chat and "Loading conversation…" in between.
  ([#2545](https://github.com/devswha/ovis/pull/2545) by @jpcarranza94)
- A queued follow-up stays in Chat as a sent message from the moment it leaves its row until its
  turn shows: at the end of a turn, after Send now, and when the turn ended before it arrived.
  ([#2547](https://github.com/devswha/ovis/pull/2547) by @jpcarranza94)
- After Stop, a message sent in place of the stopped one no longer brings the stopped message back
  into Chat for a moment.
  ([#2547](https://github.com/devswha/ovis/pull/2547) by @jpcarranza94)
- Stop with a follow-up queued no longer erases the stopped message from Claude Code's input box:
  the stopped message comes back to the composer, and the follow-up waits for Send now.
  ([#2547](https://github.com/devswha/ovis/pull/2547) by @jpcarranza94)
- Clicking Stop keeps the keyboard focus in the message box, as Send does.
  ([#2547](https://github.com/devswha/ovis/pull/2547) by @jpcarranza94)
- A Claude Code `/compact` sent from Chat says "Done" once the conversation is compacted, not as
  soon as the command starts. After `/clear`, a command sent to the conversation left behind (such
  as that `/compact`) no longer shows in the new, empty chat.
  ([#2549](https://github.com/devswha/ovis/pull/2549) by @jpcarranza94)
- A finished turn no longer opens again as "Working…" for a moment when Claude starts a new turn by
  itself, as when a background task ends, or when a message comes from the terminal.
  ([#2551](https://github.com/devswha/ovis/pull/2551) by @jpcarranza94)
- Switching to a working agent's chat no longer shows a "Working…" head above "Loading
  conversation…" before the turn's own rows are drawn.
  ([#2551](https://github.com/devswha/ovis/pull/2551) by @jpcarranza94)
- A long chat opened for the first time now lands at its newest message. Before, the view could
  stop several hundred pixels short of it when a long answer or table near the end grew while the
  chat went down to it, and it stayed there.
  ([#2564](https://github.com/devswha/ovis/pull/2564) by @jpcarranza94)
- A chat opened again after a minute or more draws its skill chips and "Ran in terminal" rows at
  once, not as plain text that changes when the pane's command list arrives.
  ([#2560](https://github.com/devswha/ovis/pull/2560) by @jpcarranza94)
- Opening a chat asks the server for the pane's command list once, not four times at the same
  moment.
  ([#2560](https://github.com/devswha/ovis/pull/2560) by @jpcarranza94)
- A hidden page (a phone put away, or a desktop window minimized or behind a full-screen app) no
  longer watches its pane read-only, including one that opens or reconnects while hidden: a frozen
  page could not parse those frames, so the whole burst was drawn on return and a weak link's
  unacknowledged queue could close the connection (4008). The pane still reads as view only;
  returning attaches afresh and the pane's replay draws the current screen, and a window shown
  again without the focus starts watching its pane then.
  ([#2554](https://github.com/devswha/ovis/pull/2554) by @iwangjie)
- A triple-clicked paragraph in a Chat reply, or a selection dragged past its last word, offers Quote
  and Comment again, and quotes the reply's words without its copy row or time.
  ([#2577](https://github.com/devswha/ovis/pull/2577))
- A chat opened right after its agent moved to another session shows the new session, not the old
  one from the tab press or from a page an earlier chat was still loading.
  ([#2576](https://github.com/devswha/ovis/pull/2576))
- On the herdr-core runtime, a pane running Claude Code shows its conversation again, along with
  everything else Ovis does for Claude panes: herdr-core names Claude Code `claude-code`, and Ovis
  now reads that as Claude.
  ([#2572](https://github.com/devswha/ovis/pull/2572) reported by @rkqksk)
- A browser connecting to a large herdr session (a snapshot over 1 MiB) gets its terminals again
  instead of closing at once with "Terminal output stopped because this device could not keep
  up": only output still queued for the browser counts as a stall, not the size of one message.
  ([#2570](https://github.com/devswha/ovis/pull/2570) reported by @nathanvale)
- The browser tab's title shows an Oh My Pi pane's `π` glyph and working spinner again; the sidebar
  row and the header still leave them out, as the row's mark and badge say the same.
  ([#2571](https://github.com/devswha/ovis/pull/2571) reported by @altgans)
- Copying a wrapped reply from an agent's pane in the Terminal lens gives one line again, as herdr's
  own copy does: the line breaks and two-space indent the agent drew at the pane's edge are left out,
  so a long command it wrapped pastes whole.
  ([#2575](https://github.com/devswha/ovis/pull/2575) reported by @matiemer)
- Cloudflare relay connections now close both ends after a frame send fails, so clients can
  reconnect without waiting for a later transport close event or timeout.
  ([#2580](https://github.com/devswha/ovis/pull/2580))
- A folder opened in New workspace's Browse no longer loses to a Show hidden toggle pressed while
  the folder loads; the toggle waits for the listing. The path bar wraps at very narrow widths so
  New folder is not clipped.
  ([#2582](https://github.com/devswha/ovis/pull/2582) by @iwangjie)

### Maintenance
- The installer test for a PC without its own Node no longer finds the host's `/usr/bin/node`, so
  it passes on a Linux PC that has a recent Node installed.
  ([#2448](https://github.com/devswha/ovis/pull/2448) by @briantcl1992)

## [0.4.21] - 2026-10-30

### Added
- The agent picker of New workspace, New tab and New worktree ends with "Add another agent…": it shows
  the agents the PC does not have yet as the setup guide's tiles, installs the one you tap right
  there, then picks it.
  ([#2413](https://github.com/devswha/ovis/pull/2413))
- Settings → Agent integrations lists what the PC open there has, with versions, and the agents it
  can install as the same tiles; herdr's integrations stay below. "Open setup guide" at its top opens
  the first-run guide again.
  ([#2413](https://github.com/devswha/ovis/pull/2413))
- An agent can be installed and signed in to from Ovis: the server opens a terminal tab on that PC
  and types the vendor's own install command for it, or the agent's own sign-in, so every line
  shows and Ctrl+C stops it (`POST /api/agent-catalog/install` and `/sign-in`, also for remote
  PCs). A setup card follows the install, finds the agent once it is in place, and offers its
  sign-in.
  ([#2328](https://github.com/devswha/ovis/pull/2328))
- Claude Code and Codex sign in from the browser. **Sign in** on an agent's row in Settings →
  Agents, **Sign in again**, **Add account → On this PC** and the setup guide's **Sign in to …** run
  the agent's own login on the PC as before, and a small dialog follows it: the sign-in page to open
  (on the provider's own address), Codex's one-time code to enter there, and a box for the code
  Claude's page shows, typed into the login for you. It says how the sign-in ended; **Open terminal**
  stops the private login before starting a visible terminal tab. The private prompt belongs to the
  device that started it, and closing it frees an unused account name. The agent writes its own
  credentials; Ovis keeps no code after the login ends.
  ([#2428](https://github.com/devswha/ovis/pull/2428))
- The user guide shows how to run Ovis on one PC that stays on and add your other PCs to it as
  remote PCs, instead of an Ovis on every PC kept on the same version. Suggested by @WOULDU-pres
  in #2056.
  ([#2347](https://github.com/devswha/ovis/pull/2347))
- Chat: select text in an agent's reply to comment on it. Comments wait in one chip over the message
  box and go first in your next message, each as a `> quote` and then the comment. A slash command or
  an answer to the agent's question leaves them waiting, and they only ever go to an agent: the bridge
  refuses them where no agent is in front. Requested by @aNNdii (#511).
  ([#2350](https://github.com/devswha/ovis/pull/2350))
- A Claude Code pane's message box can show an **Artifacts** chip beside the background tasks chip
  once the session publishes a page with Claude Code's Artifact tool. It lists each page once, with
  the title and time of its latest publish, newest first, and opens the page on claude.ai in a new
  tab. It is off until turned on in **Settings → Chat → Composer → Artifacts chip**, so the
  message box stays minimal. Ovis reads the pages from the session's transcript; a remote PC needs
  this version to list them.
  ([#2405](https://github.com/devswha/ovis/pull/2405) by @jpcarranza94)
- Settings → Subscription usage has **Read Claude's limits from its status line** for networks where
  Anthropic's usage endpoint is refused (a 403 that showed as an expired sign-in). Turned on, the
  server's PC wraps the status line set in Claude's `settings.json` (under `CLAUDE_CONFIG_DIR` too)
  and runs that command unchanged, keeping only the five-hour and weekly windows and the account,
  owner-only, in `~/.herdr/statusline-last.json`; turned off, it puts `settings.json` back as it was
  and deletes what it added, never a file there it did not write. A Claude account refused that way
  offers **Read from Claude's status line instead** in the usage popover. A reading counts only for
  the account that drew it and only until its window resets; the endpoint stays the fallback. A
  watching device cannot turn it on. By @CharleoYang.
  ([#2269](https://github.com/devswha/ovis/pull/2269) by @CharleoYang)
- omp's context ring shows a percent, read from the context figure in omp's own status bar while
  the pane is scrolled to the bottom. By @CharleoYang.
  ([#2269](https://github.com/devswha/ovis/pull/2269) by @CharleoYang)
- The user guide shows how to reach Ovis through a Cloudflare Tunnel, and what to keep on behind
  Cloudflare Access, which cannot hand the app its token.
  ([#2412](https://github.com/devswha/ovis/pull/2412))
- Letta Code panes show Letta's own mark in the sidebar, the agent picker and the composer, in place
  of the initial in a disc.
  ([#2414](https://github.com/devswha/ovis/pull/2414) by @homebodify)
- A setup guide on a fresh install: Ovis asks whether this is your first time, then checks which
  coding agents this PC has and shows every one as a tile, the same whatever it found. Pick an
  installed one and Start opens your first project with it (Claude Code, else Codex, else the
  first found); tap Install on a missing one and Ovis runs its official installer right there, a
  ring turning on its tile until it is installed. Plan usage turns on for accounts already signed
  in, and Connect your phone beside Start shows a QR code and the address to open on the phone (on a fresh
  install it pairs this browser first, so the phone does not shut it out). It
  opens by itself only once, when herdr has no workspaces and Ovis has no saved settings or paired
  devices; "I've used Ovis before" goes straight to the app.
  ([#2332](https://github.com/devswha/ovis/pull/2332))
- Settings → Shortcuts has Previous tab, Next tab, Previous workspace and Next workspace, with no
  key until you choose one: they step through the open workspace's tabs in the tab strip's order,
  or the workspaces in the sidebar's order, and wrap around at the ends.
  Requested by @odfalik (#2038).
  ([#2349](https://github.com/devswha/ovis/pull/2349))
- A bare file name in the terminal (`design.md`, no folder in it) opens in the file viewer on
  Cmd+click (Ctrl+click off a Mac), underlined while the key is held, as in VS Code's terminal.
  It is looked for under the pane's folder, and several files of that name are listed to choose
  from. A plain click or a tap on one still lands on the terminal.
  ([#2348](https://github.com/devswha/ovis/pull/2348))

- An OpenCode pane's background commands show in the Background tasks list with its subagents,
  as a Claude Code pane's do: running first, then the ones that ended. Reported by @sulthonzh
  (#2340).
  ([#2341](https://github.com/devswha/ovis/pull/2341) by @sulthonzh)

### Changed
- Ovis checks agent versions in the background when its server starts, so opening the agent catalog
  after those checks finish no longer waits for slow version commands.
  ([#2401](https://github.com/devswha/ovis/pull/2401))
- The sidebar's Agents section remembers whether you folded it, on each device, across reloads
  and launches. With nothing remembered it still starts folded in the phone drawer and open on a
  desktop.
  Reported by @Ploppy3 (#2236).
  ([#2351](https://github.com/devswha/ovis/pull/2351))
- Settings → Subscription usage and Settings → Agent integrations are one page, **Settings →
  Agents**: one row per coding agent on the PC with its version, whether it is signed in (as far
  as its plan accounts show), and, opened, its accounts and their limits, Add account, Sign in
  again and herdr's session resume for it; **New agents** keeps how New workspace starts Claude
  Code and Codex. Accounts no agent there signs in to (Cursor, an agent not installed) and the hub
  are under **Other accounts**; the agents to install are under **Install another agent**, and the
  plan-limit display settings close the page. Links and the command palette that named either old
  page open Agents.
  ([#2427](https://github.com/devswha/ovis/pull/2427))
- The daily anonymous usage message now also says which kinds of screen opened the app that day
  (the phone and Mac apps, an installed web app or a browser tab), how they reached the PC, and how
  many prompt answers were sent and pane alerts delivered and tapped. Counts only: never which pane,
  agent, device or time. The one-time notice is shown again, and nothing of the usage is counted or
  sent until it has been.
  ([#2392](https://github.com/devswha/ovis/pull/2392))

### Removed
- The sidebar no longer shows Install app; install from Settings → Phone & devices → Install,
  which offers it when the browser can install and says how otherwise.
  ([#2391](https://github.com/devswha/ovis/pull/2391))

### Fixed
- Pi's Earlier sessions list retries a busy reader automatically and offers Retry if it stays busy,
  rather than showing an error or an empty list. A bounded metadata cache avoids rereading
  unchanged transcripts while picking up new prompts and renamed or cleared session names.
  ([#2377](https://github.com/devswha/ovis/pull/2377) by @IdrisGit)
- Opening the setup guide again from Settings no longer turns plan usage back on.
  ([#2413](https://github.com/devswha/ovis/pull/2413))
- An agent whose installer adds its folder to the login shell's PATH is offered in the agent picker
  once that PATH has it: the server reads it again for the install, and the dialog waits for up to
  a minute before saying it is not offered yet.
  ([#2413](https://github.com/devswha/ovis/pull/2413))
- Opening Ovis on a slow link, such as a phone on mobile data or the app's first connect, shows a
  loading spinner while the app downloads instead of an empty screen that looks frozen. Thanks to
  @Shunamxiao for the report (#2329).
  ([#2367](https://github.com/devswha/ovis/pull/2367))
- An installed agent that does not start (a wrapper whose target was removed, for example) is no
  longer shown with a version read from its error message: the agent catalog marks it as not
  running, and the setup card does not call it ready.
  ([#2375](https://github.com/devswha/ovis/pull/2375))
- The agent catalog runs a version check with the PATH the agent was found on, so an agent run by
  an interpreter only the login shell knows (nvm's Node, for one) is not taken for broken.
  ([#2375](https://github.com/devswha/ovis/pull/2375))
- The install catalog says what installs on a real PC showed: Oh My Pi's installer stops while an
  older Bun is on PATH, Devin's may wait at its own sign-in until you press Ctrl+C, and OpenCode's
  installer puts its folder first on PATH ahead of an opencode of your own. Copilot gets its
  `copilot login` sign-in, and Hermes, whose version check is slow, is no longer shown without a
  version.
  ([#2382](https://github.com/devswha/ovis/pull/2382))
- Local Markdown images in Chat answers render inline using the pane's PC and working directory,
  with the file viewer's size limit and link fallback. Click or keyboard activation opens the
  existing image viewer. URL-encoded filename characters resolve correctly.
  ([#2435](https://github.com/devswha/ovis/pull/2435) by @cheol-95)
- Relative Chat images follow the foreground process folder. Failed local lookups offer Try again
  so a delayed file or temporary server failure can recover without reconnecting.
  ([#2435](https://github.com/devswha/ovis/pull/2435) by @cheol-95)
- A message sent while the chat was still loading no longer shows twice, as its turn and its faded
  waiting bubble, for up to a minute when the agent writes whole-second times and nothing after
  that turn: the turn alone settles the bubble.
  ([#2365](https://github.com/devswha/ovis/pull/2365))
- A Chat message to Claude Code is no longer refused as "input box may not be empty" because of
  Claude's grey suggested prompt while the pane's terminal is scrolled up into its history.
  ([#2406](https://github.com/devswha/ovis/pull/2406))
- A Codex pane's chat no longer shows another session's conversation from weaker screen evidence:
  it reads the screen only while a Codex process runs in the pane, a long answer must match the
  one shown with its punctuation (`a < b` is not `a > b`, `feature-one` is not `feature_one`), and
  a command Codex shows it or you ran, or is running, and a tool's output, are not taken for an
  answer. When nothing proves the conversation, the pane shows its terminal.
  ([#2430](https://github.com/devswha/ovis/pull/2430))
- A Codex pane's chat no longer shows another session's conversation: short answers count only
  below the prompts they answered, a long answer quoted in a prompt or the input box is no match,
  and the thread herdr reports for the pane (which can be stale, or another pane's through Codex's
  shared daemon) is shown before its answer is on screen only when it is the pane's brand-new
  conversation. When ownership cannot be established, the pane shows its terminal.
  ([#2426](https://github.com/devswha/ovis/pull/2426))
- Codex Chat can identify a conversation whose answer links an absolute local file path
  containing spaces, which the terminal displays relative to its working directory.
  ([#2417](https://github.com/devswha/ovis/pull/2417) by @cheol-95)
- Large OmO and GJC session replays yield between read chunks so the web server keeps answering
  requests while it reconstructs agent status.
  ([#2361](https://github.com/devswha/ovis/pull/2361) by @eddieparc)
- A trackpad wheel held with Ctrl scrolls a terminal application at its normal speed again, as
  before the xterm.js 6 upgrade, instead of faster; only Alt speeds the wheel up.
  ([#2357](https://github.com/devswha/ovis/pull/2357))
- Recently viewed terminal tabs keep their screen current while this window is in use, so switching
  back shows the pane as it is now at once: the three recent tabs, or the most recent one on a
  phone. A hidden tab still lets go of the pane and its input; the existing alongside-herdr setting
  still releases hidden panes.
  ([#2418](https://github.com/devswha/ovis/pull/2418) by @eddieparc)
- On an iPhone, tapping the mic records with the browser's speech recognition instead of saying the
  microphone permission was denied: iOS starts it only from a tap, so a touch starts and finishes a
  take by tapping, where a mouse still holds to talk. In a home-screen app, turning Voice input on
  no longer asks for the microphone at once, the request reported to close or reload the app; the
  first tap of the mic asks. Speech recognition that is off on the device (Siri & Dictation) says so
  instead of blaming the permission. Thanks to @osamahbeig for the report and the diagnosis.
  ([#2370](https://github.com/devswha/ovis/pull/2370))
- A sentence dictated into the terminal grid with an iPhone keyboard that types it all at once
  (FluidVoice, other dictation keyboards) now reaches the pane whole, not only its first letter.
  Thanks to @blaker3115-Agri for the report (#1488).
  ([#2386](https://github.com/devswha/ovis/pull/2386))
- The key bar's Show/Hide keyboard control on a touch screen no longer fights itself: its label,
  pressed state and its tap's action are one word from the tap, held until the keyboard measured
  after that tap confirms it or the settle window runs out — a tap can never do the opposite of what
  the control just said, and a quick reversal is not undone by the last animation. The word is the
  tapping pane's own, so another pane's control is never stuck on it. Show puts a keyboard back
  after Android's back gesture (blur and refocus inside the tap; a focus alone raises nothing
  there), and the blur reads as the keyboard going where the measurement is blind (a zoomed page, a
  floating keyboard), the word standing through the hiding animation the measurement still reports.
  ([#2333](https://github.com/devswha/ovis/pull/2333) by @IdrisGit)
- Switching the key bar's Input line and direct typing on a touch screen no longer raises a
  keyboard the user put away (including after Android's back gesture), and with the keyboard up
  the new mode's field takes it, focus and all. A keyboard the page cannot measure (an iPad's
  floating keyboard, a zoomed page) counts as down there: Show brings it back after the switch.
  ([#2333](https://github.com/devswha/ovis/pull/2333) by @IdrisGit)
- In the installed desktop app with the title bar hidden, the image and diagram previews' top bar
  now sits below the title bar area: its buttons no longer sit under the browser's own window
  controls (a click on the close button could close the whole app) or start a window drag.
  Thanks to @Hyd3-14 for the report and the root cause (#2026).
  ([#2381](https://github.com/devswha/ovis/pull/2381))
- One slow snapshot no longer marks a connected local PC as a connection error. A second
  consecutive timeout, a startup failure, or a definite transport failure still reports the error.
  ([#2418](https://github.com/devswha/ovis/pull/2418) by @eddieparc)
- An OmO pane keeps its chat when OmO's runtime started a few seconds late on a busy machine,
  instead of falling back to the terminal with no conversation. Reported by @Noobear (#2281).
  ([#2424](https://github.com/devswha/ovis/pull/2424))
- In an OpenCode pane, a drag in the desktop terminal goes to OpenCode, as a click already did, so
  OpenCode selects inside the panel the drag starts in instead of Ovis selecting whole rows across
  its side panel. Shift+drag (Option+drag on a Mac) still selects and copies in Ovis. Reported by
  @matiemer in #2362.
  ([#2368](https://github.com/devswha/ovis/pull/2368))
- OpenCode's shared event connection now closes when a snapshot confirms its last pane stopped
  running OpenCode, even when no status event arrived, without dropping it during server handover.
  ([#2389](https://github.com/devswha/ovis/pull/2389))
- Pi's Earlier sessions keeps available sessions visible when a large transcript takes too long to
  scan. Unfinished labels show the session ID; later opens resume the scan and fill in the labels.
  ([#2410](https://github.com/devswha/ovis/pull/2410))
- Pi's Earlier sessions list now shows names and first prompts recorded deep in long sessions,
  follows later renames, and restores the first prompt when a name is cleared.
  ([#2377](https://github.com/devswha/ovis/pull/2377) by @IdrisGit)
- With Windows high contrast on, the selected workspace and agent rows in the sidebar keep a
  Highlight bar on their leading edge, so the selection no longer disappears there.
  ([#2352](https://github.com/devswha/ovis/pull/2352))
- Turning anonymous usage counts off now holds when two Ovis servers of this version or later share
  one state folder (an installed app and a source checkout, say): the other server recording a visit
  or a count at that moment could turn them back on, and the next day's message would go out.
  ([#2408](https://github.com/devswha/ovis/pull/2408))
- A screenshot pasted into the phone's terminal input line is uploaded and its path put in the line,
  as in the Chat composer and the terminal itself; before, the paste did nothing (#801). The key
  bar's Paste pastes an image the same way where the browser can read one, and otherwise says to
  press and hold the line to paste it instead of calling the clipboard empty.
  ([#2390](https://github.com/devswha/ovis/pull/2390))
- Terminal gutters follow the active theme instead of showing a black frame after the xterm.js 6
  upgrade.
  ([#2355](https://github.com/devswha/ovis/pull/2355) by @imurfutur3)

### Maintenance
- The installer test times the unattended question beside its real 20-second read, so a slow reader
  of the terminal no longer measures zero.
  ([#2359](https://github.com/devswha/ovis/pull/2359) by @YuuuXie)
- CI's parallel browser lane starts its longest scripts first, so the lane no longer ends with one
  slow script running alone for about three minutes; on the self-hosted PC the slowest CI job
  takes about 2.5 minutes less.
  ([#2339](https://github.com/devswha/ovis/pull/2339))
- CI's browser-other job uploads its ~2,000 screenshots only when it fails or is cancelled; a green
  run keeps the report and every script's log, and ends about 45 s sooner.
  ([#2376](https://github.com/devswha/ovis/pull/2376))
- The chat tool-paths demo check keeps opening folded tool rows until every file shows, instead of
  one pass over the rows it counted first, which left the last row folded on a busy run.
  ([#2394](https://github.com/devswha/ovis/pull/2394))
- The Copilot integration tests wait for a transcript answer through a switch's in-between replies
  (scrollback, or a 409 when ownership changes mid-read) instead of reading every reply as one,
  and print each reply they wait past.
  ([#2385](https://github.com/devswha/ovis/pull/2385))
- The input line's image-paste check waits for the frame that puts the caret after a pasted path
  before it rewrites the line, so on a busy PC that frame no longer collapses the next rewrite's
  selection and makes it add to the line instead of replacing it.
  ([#2399](https://github.com/devswha/ovis/pull/2399))
- The integration test for a launched agent replaced before its page attaches starts the replacement
  before the first agent ends, so no status read lands while the shell alone is in front and
  rightly finds the launch ended.
  ([#2380](https://github.com/devswha/ovis/pull/2380))
- Two take-over integration tests lengthen the attach hold, so a busy runner never passes on a
  failing or displaced attach's last line before its exit arrives.
  ([#2373](https://github.com/devswha/ovis/pull/2373))
- The key bar focus check proves the shell took the bar's Enter by the output of a command it ran,
  not by a count of prompts on screen, which a prompt pushed off the top can leave unchanged.
  ([#2395](https://github.com/devswha/ovis/pull/2395))
- Markdown parser regression tests bound closer searches by count and scanned characters instead of
  CPU-time ratios, so shared-runner load cannot fail the two search bounds.
  ([#2393](https://github.com/devswha/ovis/pull/2393))
- The output contract tests for a terminal attach that cannot spawn now make the spawn fail on the
  Rust PTY host too, so they pass in a checkout with the Rust host built, not only with the Node
  sidecar. Thanks to @kilhyeonjun for the report and the diagnosis (#2344).
  ([#2364](https://github.com/devswha/ovis/pull/2364))
- The terminal keyboard demo check lets the recorded shell finish playing before it writes its
  focus-reporting marker, on a line of its own, so a late recorded frame cannot overwrite it.
  ([#2379](https://github.com/devswha/ovis/pull/2379))
- The terminal viewport browser check waits for the jump-to-bottom button to go once native paging
  reaches the bottom, instead of sampling it before the page has drawn the scroll answer.
  ([#2378](https://github.com/devswha/ovis/pull/2378))
- The Codex process tests read their fixtures' whole READY line, which a busy pipe can hand over in
  two pieces, instead of taking the first read for the line.
  ([#2383](https://github.com/devswha/ovis/pull/2383))
- The omp picture test that reads two 20 MiB records gets the 30 s budget its 40 MiB neighbour
  has, instead of the default 5 s, which its passing Windows runs came within half a second of
  and three runs went past.
  ([#2372](https://github.com/devswha/ovis/pull/2372))
- The two Pi session listing tests that read 50 long sessions (the reader's and the history API's)
  check what is listed with the listing deadline set past their own timeout, instead of racing the
  two-second production deadline on a busy runner.
  ([#2402](https://github.com/devswha/ovis/pull/2402))
- The plugin start test counts a stopped server that has exited but is not yet reaped as gone, as
  `stop` itself does, instead of failing while signal 0 still reaches it.
  ([#2388](https://github.com/devswha/ovis/pull/2388))
- The two Portal unit tests that spawn an unrelated process (a shell, a Bun script) give it 20 s to
  print READY and to exit, instead of 2 s, which a loaded runner's Bun start exceeded.
  ([#2409](https://github.com/devswha/ovis/pull/2409))
- The usage browser check reloads only once the shared preference has saved usage off, and reads
  the reloaded page's requests after it has applied the server's preferences.
  ([#2387](https://github.com/devswha/ovis/pull/2387))

## [0.4.20] - 2026-10-29

### Added
- In New workspace and New tab, Claude Code's Ultracode switch fits on one line under Model and
  Effort, with its minimum version visible on a phone too.
  ([#2282](https://github.com/devswha/ovis/pull/2282) by @fivetaku)
- The server lists every agent Ovis can install, with each vendor's own install command for the
  PC's operating system and whether the agent is installed there, at which version
  (`GET /api/agent-catalog`, also for remote PCs). Nothing is installed yet: the install flow
  builds on it.
  ([#2326](https://github.com/devswha/ovis/pull/2326))
- Add Black, with pure black backgrounds and the Tokyo Night accent colors.
  ([#1911](https://github.com/devswha/ovis/pull/1911) by @jjsteffen)
- When Chat does not send a message because Claude Code's input box already holds a draft, the
  note now has a **Send it** button beside **Clear it and send**. It sends the draft as Claude
  Code holds it, and your Chat message stays in the box.
  ([#2301](https://github.com/devswha/ovis/pull/2301) by @jpcarranza94)
- Chat shows a Claude Code bash-mode command (`!`) as one card: the command, then what it
  printed, with the output of a failed command in red. Before, Chat showed the raw
  `<bash-input>` and `<bash-stdout>` tags in two messages.
  ([#2176](https://github.com/devswha/ovis/pull/2176) by @jpcarranza94)
- New workspace and New tab have an Ultracode switch for Claude Code, on one line under Model and
  Effort, so a session can start with Ultracode on at any effort level
  (`--settings '{"ultracode":true}'`, which a Windows PC passes as a small settings file in
  `%LOCALAPPDATA%\ovis\claude-settings`). It needs Claude Code 2.1.284 or later, a model with xhigh
  and dynamic workflows on. Reported by @fivetaku, whose #2282 suggested the compact line under the
  effort level.
  ([#2266](https://github.com/devswha/ovis/pull/2266))
- Claude Code's `/effort` card has a Turn Ultracode on or Turn Ultracode off row where Tab, the
  default key, flips the switch: it switches Ultracode for this session and keeps the effort level.
  ([#2266](https://github.com/devswha/ovis/pull/2266))
- Chat shows a Letta Code pane's conversation, read from Letta's own transcript, when herdr's Letta
  integration reports it and Letta's own record names the same conversation; otherwise the
  terminal's text stays.
  ([#2312](https://github.com/devswha/ovis/pull/2312))
  ([#2338](https://github.com/devswha/ovis/pull/2338))
- The `ask_user` form of the `@eko24ive/pi-ask` pi package shows as a chat card and is answered
  from the chat, one question per step, once the web UI's pi extension is installed with
  `bun scripts/install-pi-integration.ts`. The answer goes to pi-ask through its own events,
  never as typed keys; without the extension the form stays in Terminal (#1202). Reported by
  @chobijaeyu.
  ([#2218](https://github.com/devswha/ovis/pull/2218))
- An expired Claude or Codex account in Subscription usage has a **Sign in again** button, in Settings and in the
  usage popover: it opens the official sign-in in a terminal tab for that same account, replacing
  its expired sign-in instead of adding a new account.
  ([#2309](https://github.com/devswha/ovis/pull/2309))

### Changed
- A message sent from Chat shows at once as your own bubble, faded, until the agent writes it as a
  turn, so the chat is never blank between Send and the agent's turn. A small clock joins it only
  when the agent has not taken it after 5 seconds. A command (`/cost`, `! ls`) gets no bubble, since
  it never comes back as that message, and a bubble whose turn has not come within a minute goes.
  ([#2270](https://github.com/devswha/ovis/pull/2270) by @CharleoYang)
- New workspace and New tab no longer list `ultracode` among Claude Code's effort levels; the PC
  still accepts `--effort ultracode` from other clients.
  ([#2266](https://github.com/devswha/ovis/pull/2266))
- Switching tabs is faster: a tab's terminal takes input about 100 ms sooner. The bridge passes an
  attach's screen on as soon as herdr draws its text, instead of holding every attach 100 ms.
  The hold stays for an attach that shows no text yet, one that was resized while it started, and
  a pane another web bridge held, so herdr's refusal is still never shown.
  ([#2255](https://github.com/devswha/ovis/pull/2255))
- A long OMO or GJC chat refreshes faster while its agent works: each update now parses only the
  records the agent added since the last one, as OMP, Claude Code and Codex chats already do,
  instead of the whole running task again. Based on
  [#1634](https://github.com/devswha/ovis/pull/1634) by @Yoonwoo-Ha.
  ([#2291](https://github.com/devswha/ovis/pull/2291))
- The Beta page on ovis.sh tells Android testers, in all four of its languages, to open the
  opt-in link in Chrome on the phone rather than inside another app, that **You are a tester**
  means they are in, to check that the Play Store app's profile is the same account, and that
  Google Play takes a few hours after they join the group, so an app that is not found right
  after joining is worth trying again later.
  ([#2076](https://github.com/devswha/ovis/pull/2076))
- The terminal draws its Latin text in the bundled JetBrains Mono (regular and bold) on every device,
  so Ovis for Mac, Safari (the installed app) and Chrome on the same Mac show the same font, row height
  and number of rows. A font chosen in Settings still takes its place.
  ([#2272](https://github.com/devswha/ovis/pull/2272))

### Fixed
- A message to Claude Code is sent at once when its own turn has ended and only background
  agents are still working, instead of waiting for those agents to finish.
  ([#2271](https://github.com/devswha/ovis/pull/2271) by @CharleoYang)
- Switching Chat tabs loads a smaller page of history and keeps more tabs' pages ready, instead
  of fetching the whole page again at each switch. Settings lets you choose the history page size.
  ([#2274](https://github.com/devswha/ovis/pull/2274) by @CharleoYang)
- A terminal resized while it attaches no longer shows its first screen at the old size, or takes
  input before the program has the new size. The bridge now waits for herdr's redraw at the
  terminal's current size, also after a resize back to the size it started at, for up to a
  second.
  ([#2324](https://github.com/devswha/ovis/pull/2324))
- A folded work block no longer opens again when hidden reasoning before it joins the same run of
  work (#2111).
  ([#2240](https://github.com/devswha/ovis/pull/2240))
- A chat message sent to a PC whose server cannot confirm messages and does not name its herdr
  now stays in Recover unsent text after a reload, instead of being lost with the page (#2172).
  ([#2240](https://github.com/devswha/ovis/pull/2240))
- A diagonal trackpad swipe over an overflowing tab strip is left to the browser, so the strip
  no longer moves against the swipe's sideways motion (#2103).
  ([#2240](https://github.com/devswha/ovis/pull/2240))
- Chat keeps following new output to the end when part of the transcript folds on its own: a turn
  settling at the end, or a block above the view folding while the view still glides to the end.
  Before, the list holding the rows in place read as the reader scrolling up: following stopped
  mid-transcript and **New messages** showed.
  ([#2117](https://github.com/devswha/ovis/pull/2117))
- The numbers of a numbered list in the chat are no longer cut off on the left with a wide Chat font
  such as a monospace one, or once a list reaches 10 or 100: the indent grows with the Chat font
  and the widest number.
  ([#2096](https://github.com/devswha/ovis/pull/2096))
- A chat work block you folded no longer opens again when the words before its tools join it, as
  when a later Codex record marks them commentary or a blank commentary is filled in.
  ([#2098](https://github.com/devswha/ovis/pull/2098))
- A chat copy that reaches past the chat, such as Select All, keeps a tool card's whole file paths
  instead of the short labels read from the pane's folder.
  ([#2195](https://github.com/devswha/ovis/pull/2195))
- A pane on a UNC folder written with forward slashes (`//server/share/app`) shows its chat tool
  card paths as written, as it already did for `\\server\share\app`.
  ([#2195](https://github.com/devswha/ovis/pull/2195))
- A message queued for a `claude attach` pane waits for the conversation of the job it opened, as it
  does for any Claude Code pane, instead of going wherever the pane ends up.
  ([#2119](https://github.com/devswha/ovis/pull/2119))
- Chat follows a `claude attach <name>` pane whose name is followed by debug options or
  `--setting-sources`, as Claude Code reads it.
  ([#2119](https://github.com/devswha/ovis/pull/2119))
- A `/resume` of a background session no longer reads that job's state without a size limit, nor
  waits on a FIFO put in its place.
  ([#2119](https://github.com/devswha/ovis/pull/2119))
- A Claude Code pane whose turn has ended no longer reads as working while a background subagent it
  started works on: Claude Code keeps its busy title spinner up for the subagent, which herdr reads
  as work. The pane now waits on that work (BG), as it does when the subagent is quiet, so the chat
  no longer shows "Working…" with a Stop button under the finished answer. (#2069)
  ([#2072](https://github.com/devswha/ovis/pull/2072) by @Noobear)
- After Claude Code's `/branch`, Chat takes a transcript as the branch only from its own first message,
  and keeps to the branch file it checked when another project holds a file of the same id.
  ([#2126](https://github.com/devswha/ovis/pull/2126))
- After Claude Code's `/branch`, Chat follows the branch Claude went on in and shows its replies,
  also when Herdr still reports the session the branch was copied from. Reported by @Hyd3-14 in
  [#2020](https://github.com/devswha/ovis/issues/2020).
  ([#2099](https://github.com/devswha/ovis/pull/2099))
- A Claude skill or command sent from Chat that asks a question while Claude's fullscreen diff
  panel is shown now waits on that question in its receipt, as it does without the panel.
  ([#2199](https://github.com/devswha/ovis/pull/2199))
- After `/model` or `/effort` in a Claude Code pane, the composer's model pill shows the new model
  and effort as soon as Claude Code confirms the change, not after the next answer. A model name
  printed in a form that does not map back to one model id keeps the old pill until that answer.
  Thanks to @jpcarranza94 for the report and the list of forms.
  ([#2305](https://github.com/devswha/ovis/pull/2305))
- In a Claude Code pane, the composer's model pill and effort no longer go back to an older model
  when many records with no answer (bash-mode commands, a long tool output) follow the answer or
  the `/model` / `/effort` change that set them.
  ([#2319](https://github.com/devswha/ovis/pull/2319))
- Large files opened from Claude Code's scratch folder keep their size (and download progress)
  when many are fetched at once, instead of some arriving without a length.
  ([#2317](https://github.com/devswha/ovis/pull/2317))
- Chat no longer shows an OmO tool's output as a big message from you when OmO runs Claude Code
  through its SDK (a `Tool result (mcp__custom-tools__eval, id=…):` bubble between work blocks).
  The output now folds into the work block as that call's result, and the call no longer counts as
  failed while OmO runs it. A message you sent along while the tools ran still shows as yours.
  ([#2310](https://github.com/devswha/ovis/pull/2310))
- Chat no longer shows OmO's own notices as messages from you when OmO runs Claude Code through its
  SDK: reminders, monitor events, recalled memory notes, goal continuations and the history a new
  session replays stay hidden, like Claude Code's own reminders. A background task that ended shows
  as its task card, and a team member's message as a message from another session.
  ([#2322](https://github.com/devswha/ovis/pull/2322))
- A message queued for a Claude Code conversation is no longer typed into another one when
  `/clear`, `/resume` or a `claude attach` job switches the pane's session while the message is
  being sent: the session is checked again right before the paste, and once the paste is in, an
  Enter is pressed only while the conversation can still be told. Otherwise the message is held
  before the paste, or left marked uncertain without its Enter.
  ([#2318](https://github.com/devswha/ovis/pull/2318))
- After Claude Code's `/branch`, Chat follows the branch's continuation in the branch's own project
  instead of a file of the same id in another project, and reads a transcript's records however
  their keys are spelled or spaced.
  ([#2241](https://github.com/devswha/ovis/pull/2241))
- A `claude attach <name>` pane with a debug value given apart from its option (`-d api,hooks`,
  `--debug api`) keeps its terminal: Claude Code then looks no name up.
  ([#2241](https://github.com/devswha/ovis/pull/2241))
- A message queued for a Claude Code conversation is held, not sent, once the conversation in the
  pane can no longer be told (its PID record or its job's state cannot be read).
  ([#2241](https://github.com/devswha/ovis/pull/2241))
- A Chat or queued message to Claude Code that ends in a backslash is now sent. Before, Claude
  Code read the backslash and the Enter after it as a new line, and the message stayed in its
  input box.
  ([#2278](https://github.com/devswha/ovis/pull/2278) by @jpcarranza94)
- Claude Code's `/effort` card now shows while Ultracode is on, at max where Claude Code offers no
  Ultracode, and in panes narrower than 70 columns down to about 45, where the slider was left to
  the terminal before. A pane of about 44 columns or fewer still leaves it there, as Claude Code
  cuts the level names.
  ([#2266](https://github.com/devswha/ovis/pull/2266))
- Chat shows what Claude wrote right before a question card, read from the terminal, while the card
  waits. Claude Code 2.1.311 saves those words to its session file only with the answer, so the card
  lacked the context the terminal showed above the question. Words whose start is above the
  terminal's screen are left to the terminal, and once Claude's own record of the turn arrives the
  chat shows that instead. Reported by @Xelanor.
  ([#2217](https://github.com/devswha/ovis/pull/2217))
- The message box no longer names an older model before an agent's first message when its terminal
  is scrolled up, or was cleared, above an earlier Codex or Claude frame: the model is read from the
  live screen only, and none is named while the terminal is scrolled into its history.
  ([#2163](https://github.com/devswha/ovis/pull/2163))
- A Codex pane that resumed another folder's conversation through the picker is no longer bound to
  it while another loaded conversation could be the one it shows: on a busy Linux PC one read of
  the kernel's lock table could leave a loaded conversation out.
  ([#2101](https://github.com/devswha/ovis/pull/2101))
- Listing a pane's slash commands no longer stops the whole server while its skill and command
  folders sit on a slow filesystem (a Windows folder mounted into a container, a network share):
  the scan runs on the file threads, so terminals, typed input and other requests keep answering
  while it reads. Thanks to @PayrollFuchs for the report and the measurements (#2254).
  ([#2311](https://github.com/devswha/ovis/pull/2311))
- Copilot Chat retries a failed process lookup once and revalidates log continuity after temporary
  descriptor read errors, without restoring stale or revoked session evidence.
  ([#2283](https://github.com/devswha/ovis/pull/2283) by @YuuuXie)
- Copilot Chat keeps its messages while retrying a failed transcript page read when the same
  conversation is still verified, instead of briefly showing the terminal fallback.
  ([#2068](https://github.com/devswha/ovis/pull/2068) by @YuuuXie)
- A failed read of the gap between Chat pages no longer discards the messages already displayed.
  ([#2068](https://github.com/devswha/ovis/pull/2068) by @YuuuXie)
- Copilot conversation ownership uses the kernel's stable process birth, so clock corrections no
  longer reset a verified binding or make a previously denied fallback eligible again.
  ([#2293](https://github.com/devswha/ovis/pull/2293) by @YuuuXie)
- Find in a diff now brings the match itself into view on a wrapped line taller than the screen,
  such as a long line on a phone, instead of the line's middle, which could leave the match below.
  ([#2156](https://github.com/devswha/ovis/pull/2156))
- A Codex pane's DONE dot now clears when you read the answer in Chat even if Codex recorded the
  turn's completion after the chat first loaded the answer. Before, it stayed until the next finish.
  ([#2136](https://github.com/devswha/ovis/pull/2136))
- A message sent from Chat right after the page reconnects (after a server restart, or while the PC is
  busy) no longer fails with "this PC has not said yet what it supports": the server now says what it
  supports as soon as the connection opens, instead of only with the pane list, which can take seconds
  to read from herdr or fail. Older servers keep the previous behaviour.
  ([#2268](https://github.com/devswha/ovis/pull/2268))
- Opening, previewing or looking up a file on a slow or stalled disk (a network share, a large
  rendered page) no longer freezes every terminal and request: the file routes read the disk on a
  few background threads, and answer 503 to try again when those are busy or the disk does not
  answer in time.
  ([#2256](https://github.com/devswha/ovis/pull/2256))
- On Windows, Hermes skills show in the command menu again when `%LOCALAPPDATA%` is redirected: Ovis
  cannot read a Windows pane's environment, and now looks in the server's `%LOCALAPPDATA%\hermes`, as
  it already did for Hermes transcripts, instead of `<profile>\AppData\Local\hermes`.
  ([#2316](https://github.com/devswha/ovis/pull/2316))
- The installer no longer links the Node it installs into `~/.local/bin`, where it went before the
  Node of your own projects. Once Ovis runs this release, running the installer again removes a link
  it made earlier and says so: if that link was the only `node` your shells had, install your own
  Node to keep using `node` outside Ovis.
  Terminals that run on the Node fallback, and updates from Settings, use the right runtime even
  when herdr's PATH starts with an older Node (reported by @wafe).
  ([#2100](https://github.com/devswha/ovis/pull/2100))
- Sending an `@skill` to OpenCode no longer types a second space after the skill when the pane redraws
  blank while Ovis waits for Tab's result.
  ([#2239](https://github.com/devswha/ovis/pull/2239))
- On Windows, Hermes transcripts, session history and skills are found under `%LOCALAPPDATA%\hermes`,
  where Hermes 0.21.5 keeps them (a store an earlier Hermes left in `%USERPROFILE%\.hermes` is still
  read), and agent stores are looked up under USERPROFILE even when HOME is set for Git or Emacs.
  ([#2239](https://github.com/devswha/ovis/pull/2239))
- Korean typed in the terminal in the iOS app now reaches the pane as whole syllables (안녕).
  Before, each jamo went out on its own (ㅇㅏㄴㄴㅕㅇ) because the app's web view does not say
  "Safari" in its user agent. Safari and the Home Screen app already worked.
  This comes with the PC update; no new iOS app build is needed.
  ([#2307](https://github.com/devswha/ovis/pull/2307))
- The iOS app no longer shows WebKit's form bar (the up and down arrows and the check mark) over
  the keyboard, so only Ovis's own key bar sits above it and the page keeps that row of the
  screen. This needs the new iOS app build; updating the PC alone does not remove the bar.
  ([#2109](https://github.com/devswha/ovis/pull/2109))
- A message sent to a PC whose Ovis is too old to confirm messages is no longer treated as delivered:
  the composer, Send now on a held copy and the held queue's Send now keep its text as a
  "Not confirmed" row to copy or discard, instead of dropping it.
  ([#2164](https://github.com/devswha/ovis/pull/2164))
- A terminal command sent from Chat right after a pane opens now opens the terminal view even when
  the terminal had not loaded the pane's command list yet, and a chat shown again draws its
  "Ran in terminal" rows at once instead of as plain messages first.
  ([#2164](https://github.com/devswha/ovis/pull/2164))
- Ovis for Mac takes the installer only over HTTPS from ovis.sh or herdrweb.dev, reads the phone
  address only from this Mac's own server, and draws the QR code only for Tailscale's `.ts.net`
  HTTPS address.
  ([#2116](https://github.com/devswha/ovis/pull/2116))
- Ovis for Mac makes the phone address with the Ovis release that runs now, not the one first
  installed, and shows Tailscale's answer when it fails.
  ([#2116](https://github.com/devswha/ovis/pull/2116))
- Remove in Ovis for Mac stops at a step that fails (herdr's plugin list included) and shows why,
  and takes the phone address off Tailscale even when the server is down.
  ([#2116](https://github.com/devswha/ovis/pull/2116))
- Start in Ovis for Mac no longer adds a login item for herdr set up from a terminal; it runs herdr
  for this login only.
  ([#2116](https://github.com/devswha/ovis/pull/2116))
- Ovis for Mac moves herdr's log to `herdr-server.log.1` once it passes 10 MB, when the app opens
  or starts herdr, and its refresh button has a VoiceOver label.
  ([#2116](https://github.com/devswha/ovis/pull/2116))
- The sidebar no longer goes stale for about three seconds when many agents change status at
  once. A burst of more than five status changes closed the browser's event stream, which then
  reconnected and read the whole roster again, and a finish in between rang no sound and showed
  no drop-in on the page. The stream now lets a browser fall up to 4 MiB behind, beside the one
  large roster it may be reading, before ending it, and every browser's stream together holds at
  most 32 MiB for those that fell behind, so stalled devices can no longer fill the server's memory.
  ([#2260](https://github.com/devswha/ovis/pull/2260))
- A PC set up at another SSH address no longer shows or saves the roster of the address it left once
  it moves there. When the new address's roster waits for that server to prove it is the one
  answering, the PC's card has no panes until it does, and then shows that address's own.
  ([#2181](https://github.com/devswha/ovis/pull/2181))
- A command sent to a custom OmO (one whose launcher does not name omo) keeps its row in Chat after
  the turn ends: the row follows the OmO process that holds the session, as a queued message does,
  instead of the bundled Claude SDK process that exits with each turn.
  ([#2186](https://github.com/devswha/ovis/pull/2186))
- A question OmO 5.1.48 asks without waiting for the answer shows in the chat as its question card
  with its options again, instead of a "Waiting for input" card offering only Enter and Esc.
  ([#2090](https://github.com/devswha/ovis/pull/2090))
- omp's tool approval card now also shows when omp's composer is not the default status band: a
  box (`composer.shape: box`), the Claude Code, Pi, borderless, rule, field and rail shapes, any
  status-line preset, and the ascii symbols. omp's Ask card shows under the rule, field and rail
  shapes too.
  ([#2245](https://github.com/devswha/ovis/pull/2245))
- An omp card no longer shows, and an answer sends no key, while omp is stopped behind its shell
  (Ctrl+Z, or a suspended job): herdr still names the pane omp, but the shell holds the input.
  ([#2245](https://github.com/devswha/ovis/pull/2245))
- An omp Ask card now shows the question and its options in the agent's own Markdown (bold, code,
  links, lists, a fenced block), and a question omp cuts at four rows in full. The card takes the
  text from the session's open ask call only when it matches the menu on screen; otherwise it
  shows the screen's text as before, and the answer keys still come from the terminal's menu.
  ([#2220](https://github.com/devswha/ovis/pull/2220))
- Chat shows omp's pictures from its blob store on macOS and Windows too, not only on Linux: the
  bridge opens a blob through the store directory it holds open, so a link or a directory swapped
  in above it can never stand in for the store.
  ([#2114](https://github.com/devswha/ovis/pull/2114))
- An omp started from its npm package (bunx or npx run `dist/cli.js` with bun) shows its approval
  card in Chat again; the card stayed hidden and the answer had to be given in the terminal (#2280).
  ([#2320](https://github.com/devswha/ovis/pull/2320))
- An omp Ask question with a Mermaid diagram, or with options that would read alike on the card,
  shows as omp draws it, so the card never shows a diagram in place of the code or two identical
  rows (#2233).
  ([#2320](https://github.com/devswha/ovis/pull/2320))
- A prompt card's typed answer no longer picks one of two rows that look alike across scripts
  (Cyrillic `о` beside Latin `o`), and a typed row number picks its row even when its name looks
  like another row's. Commas or spaces alone on a multiple choice are the typed text, not an empty
  answer (#2233).
  ([#2320](https://github.com/devswha/ovis/pull/2320))
- Chat messages sent to a starting omp now also wait for herdr's integration when omp loads it
  from the project's `.omp/extensions`, an `-e`/`--extension`/`--hook` file, or the agent directory
  `PI_CODING_AGENT_DIR`, `PI_PROFILE` or `PI_CONFIG_DIR` names. An omp started with
  `--no-extensions` or `--trusted-extension` is sent to at once instead of after 30 seconds, and a
  wait that runs out without a report is now noted in the server log.
  ([#2159](https://github.com/devswha/ovis/pull/2159))
- omp's tool approval ("Allow tool: …") shows as an approval card again, with the call as its body
  and Approve and Deny sent with the keys omp names, instead of a fallback card (omp 18.10 and
  later; 18.13's "approve for this session" and grant rows are offered too). Reported by @Damin-Lee.
  ([#2106](https://github.com/devswha/ovis/pull/2106))
- An OpenCode `@skill` sent from Chat is no longer reported as not attached when the terminal is
  resized while it is accepted, or when a narrow terminal's status row shows only the model.
  ([#2185](https://github.com/devswha/ovis/pull/2185))
- An OpenCode 2 pane started with `--standalone` or `--server` now offers its skills as `@skill`
  before its first session, even when no OpenCode background service has written its service file,
  and a Chat `@skill` send to it shows a state once Chat has listed the pane's commands.
  ([#2315](https://github.com/devswha/ovis/pull/2315))
- A PC whose own Ovis asks for its access token (`OVIS_TOKEN`) now shows the port it really answers
  on and its "Open that PC's Ovis" https link on its card and in the dialog, instead of the
  bridge's registered port and no link, once that Ovis runs this version too.
  ([#2248](https://github.com/devswha/ovis/pull/2248))
- The token another PC's app uses to update this PC's own Ovis now opens only the update status read
  and the install request, each by its own method and with no query string.
  ([#2193](https://github.com/devswha/ovis/pull/2193))
- A pairing link is tried only once per page load, including when the sign-in screen returns.
  If pairing succeeds but the browser does not stay signed in, the screen asks you to check
  cookies instead of reporting that the already-used code is wrong or expired.
  ([#2321](https://github.com/devswha/ovis/pull/2321) by @kilhyeonjun)
- A command sent from Chat to a pi session now shows its result when the session moved to another
  branch and `/tree` came back before the result was written, instead of ending as unknown.
  ([#2146](https://github.com/devswha/ovis/pull/2146))
- A message sent to Pi from Ovis Chat no longer reads as delivered when the same text, typed into
  Pi's terminal before it, reaches Pi's transcript first.
  ([#2323](https://github.com/devswha/ovis/pull/2323))
- Pi sends retry a briefly incomplete conversation record before giving up transcript confirmation,
  including when the writer paused before Ovis started reading the file.
  ([#2231](https://github.com/devswha/ovis/pull/2231) by @philipprass-prog)
- Two plugin starts at the same moment, such as herdr's startup hook and the Start action, no
  longer leave `stop` saying Ovis is not running while a server keeps going: starts and stops take
  turns, one that waits says so in the plugin's log, and a start no longer opens a second server
  while one an earlier start left running (herdr away, say) still runs.
  ([#2166](https://github.com/devswha/ovis/pull/2166))
- An OmO question answered from a Chat card no longer goes to another open question when the
  pane is too small to show the form's title: when the form left in view fits more than one open
  question, the card is refused and nothing is sent.
  ([#2237](https://github.com/devswha/ovis/pull/2237))
- A Claude command sent from Chat beside the fullscreen diff panel no longer takes the question of
  the same command typed in the terminal after an earlier send's echoes were counted without the
  panel.
  ([#2237](https://github.com/devswha/ovis/pull/2237))
- A command sent to an OmO pane with two OmO processes holding sessions keeps its outcome on the
  OmO it was sent to, also when it waited in the queue and herdr listed the other one first by
  then, and never on a later process that got the OmO's process number.
  ([#2237](https://github.com/devswha/ovis/pull/2237))
- When **Turn alerts on again** cannot make a push subscription, the alerts notice and Settings now
  say why: the browser would not make one (in Brave, its push service is off until **Use Google
  services for push messaging** is on), the page's service worker is not running, or the PC did not
  take it. Before, the button only flickered and the notice came back unchanged.
  ([#2145](https://github.com/devswha/ovis/pull/2145) by @mattmarcin)
- The alerts notice can be dismissed. It stays closed on that device for the same problem, and
  shows again for a different one or after alerts work again. Settings still shows the problem.
  ([#2145](https://github.com/devswha/ovis/pull/2145) by @mattmarcin)
- A push endpoint its push service retired stays refused, however long ago that was, until its
  owner's device is revoked or a thousand later retirements push its mark out. Before, after 30 days
  another device that knew the endpoint could register it as its own, and so could another spelling
  of it (a `#fragment`, an uppercase host or `:443`) at any time.
  ([#2140](https://github.com/devswha/ovis/pull/2140))
- A subscription its push service retired is removed even when `push-retired.json` cannot be
  written (a full disk, a read-only state directory). Before, the failed write left it registered
  and the next alert went to the dead endpoint again.
  ([#2140](https://github.com/devswha/ovis/pull/2140))
- When a crash left the saved permission to connect to the PCs saved in herdr unreadable, Settings
  now says to choose Connect on those PCs again, instead of telling you to add them again.
  ([#2192](https://github.com/devswha/ovis/pull/2192))
- A file opened from a Claude Code session's scratch folder is served, described and drawn as a page
  only from the file actually opened inside that folder: a link put in its place after it was found
  no longer serves a file from outside the folder.
  ([#2265](https://github.com/devswha/ovis/pull/2265))
- Read DONE dots no longer come back after herdr restarts on a PC: a late read of the old herdr run
  could make the server drop the new run's read finishes and stop saving new ones.
  ([#2249](https://github.com/devswha/ovis/pull/2249))
- The server no longer keeps or hands out the read finishes of a herdr run it knows has ended, so a
  browser that reconnects stops writing them back into its storage, and the next change drops them
  from `seen.json`. The records of a PC this server has not heard from since it started are kept.
  ([#2197](https://github.com/devswha/ovis/pull/2197))
- On a phone, a jump of several entries back through the browser's history menu from a Settings
  opened again over a preview now goes to the pane it lands on. Settings no longer keeps the mark an
  earlier opening from the command palette left behind, which made the jump count as closing it.
  ([#2182](https://github.com/devswha/ovis/pull/2182))
- Closing a sidebar filter that the command palette opened no longer leaves the focus on nothing when
  what opened it is gone; it goes to a workspace row. Opening or clicking a row's menu no longer closes
  that empty filter, and words typed into it right after it lost the focus are no longer cleared.
  ([#2141](https://github.com/devswha/ovis/pull/2141))
- The session read, the `/ws` snapshot and a PC's relayed or proxied snapshots no longer carry the
  token values herdr's sidebar rows hide, so no browser, watch-only ones included, receives them in
  any snapshot. Another Ovis server reading a PC still gets them, to apply its own rows.
  ([#2171](https://github.com/devswha/ovis/pull/2171))
- The agent rows' machine events and PC roster no longer carry the literal text and numbers of the
  hide rules in herdr's sidebar rows, nor the token values those rules hide, so watch-only browsers
  no longer receive them there, and a hidden value no longer shows for a moment while the page
  loads.
  ([#2139](https://github.com/devswha/ovis/pull/2139))
- A vertical mouse wheel over a tab strip whose tabs do not fit scrolls it sideways, so tabs past
  its end can be reached with a mouse.
  ([#2095](https://github.com/devswha/ovis/pull/2095))
- Korean lines in the terminal no longer nearly touch: Hangul is widened to its two cells
  instead of enlarged, so it keeps its own height, and a row is made tall enough for Hangul and a
  gap below it where the Latin font's line is shorter (Menlo, Consolas), keeping every row where it
  is not.
  ([#2243](https://github.com/devswha/ovis/pull/2243))
- Korean text on a background colour (Claude Code's prompt, a highlighted or inverse line) no longer
  shows a thin light line after each word in the terminal, in Ovis for Mac, Safari and Chrome.
  ([#2263](https://github.com/devswha/ovis/pull/2263))
- Powerline separators in a prompt no longer make the terminal redraw every row when the icon font
  arrives: they are painted as boxes, not drawn from the font. A pane that prints icons still
  redraws once their font arrives, so they are sized from it.
  ([#2158](https://github.com/devswha/ovis/pull/2158))
- Settings → Phone & devices keeps the "This device" badge on one line beside a device's name on a
  phone, moving it whole to the next line when the name fills the row, instead of splitting it.
  ([#2187](https://github.com/devswha/ovis/pull/2187))
- When the agent's next todo update folds the update you were on into a Plan row, the keyboard focus
  stays on that update instead of dropping to the page, and an update opened inside the Plan row
  now shows the input it sent and the output it got back, not only the list again.
  ([#2161](https://github.com/devswha/ovis/pull/2161))
- An Ovis restart while a Sign in again or Add account login is still open in its terminal tab no
  longer lets a second login start in the same credential home: the restarted server finds the tab
  still running and answers that a sign-in is already open, until that login ends.
  ([#2325](https://github.com/devswha/ovis/pull/2325))
- Voice input no longer fails in a pane with many slash commands when the transcription server
  caps a request at 32 fields (codex-lb does): only as many command hints are sent as fit.
  ([#2235](https://github.com/devswha/ovis/pull/2235) by @vuongnmhvn)
- A device paired to watch only can no longer read a pane's command rows (custom commands' first
  lines and file paths) through `/api/pane/commands`, on this PC or another: they are refused as a
  folder's commands already were, and its chat no longer keeps asking for them.
  ([#2246](https://github.com/devswha/ovis/pull/2246))
- A device paired to watch only can no longer list the file paths under a pane's folder through
  `/api/pane/files`, or read a plugin action run's output through `/api/plugin/action`, on this PC
  or another: they are refused as a folder listing already was.
  ([#2252](https://github.com/devswha/ovis/pull/2252))
- A device paired to watch only can no longer list a repository's checkouts (their folders and
  branches, those not open in herdr too) through `/api/worktree/list`, on this PC or another: it is
  refused as a folder listing already was. Its sidebar no longer asks for them and shows no branch
  names.
  ([#2304](https://github.com/devswha/ovis/pull/2304))
- Ovis for Windows' Update for a server under the old id installs the newest release even when
  the PC sets an older `OVIS_REF`, and when the installer or herdr's reinstall fails, the server
  that ran before starts again, with or without herdr running. A running server that reports no
  version and runs without the update supervisor, such as one just started whose supervisor has
  not reported yet, is no longer offered Update, and the
  version check waits once more for a server slow to answer and takes a token set only in the
  environment.
  ([#2113](https://github.com/devswha/ovis/pull/2113))
- Ovis for Windows no longer offers Start for an Ovis server older than the app, or one installed
  under the old `devswha.herdr-web-ui` id: it shows Update, which updates it in place (herdr, Bun,
  settings and token stay), starts it, sets herdr to start at sign-in and ends at the phone's QR
  code. It says so when it cannot read the server's version, and names a herdr that is too old.
  The plugin's `status` now prints the version that runs, which can be newer than herdr's list.
  ([#2091](https://github.com/devswha/ovis/pull/2091))
- Ovis for Windows and install.ps1 now stop an Ovis server from before the rename (0.4.12 and older)
  that kept running after herdr closed, so Update no longer fails with "the file is in use" and then
  keeps showing the same Update screen.
  ([#2275](https://github.com/devswha/ovis/pull/2275))
- Try again after a failed Update in Ovis for Windows reads the PC again instead of running the old
  server's removed files ("Module not found").
  ([#2275](https://github.com/devswha/ovis/pull/2275))
- Ovis for Windows shows the phone QR code for a server that asks for a token, instead of telling a
  PC that already has Tailscale to install it.
  ([#2275](https://github.com/devswha/ovis/pull/2275))
- The log in Ovis for Windows shows the installer's messages as plain lines, not raw PowerShell
  CLIXML.
  ([#2275](https://github.com/devswha/ovis/pull/2275))
- On native Windows without `HOME`, chat transcripts and session lists find each agent's store
  under `USERPROFILE` too, as skill discovery already does.
  ([#2157](https://github.com/devswha/ovis/pull/2157))
- Windows remote PCs wait for Windows sign-in before starting herdr, so Codex can use its
  private-desktop sandbox. Startup options offer an explicit start without sign-in for headless
  PCs, including when Task Scheduler cannot start herdr, with the error and sandbox and desktop-tool
  limitations shown before that one start. Existing herdr servers are reused without restarting
  their panes. Signing out of Windows ends a desktop-started herdr and its panes; lock the PC
  instead. SSH disconnects and bridge updates leave them running.
  ([#2087](https://github.com/devswha/ovis/pull/2087) by @JJLiebig)
- Slow Windows launchers keep their startup options through the launch deadline. Failed startup
  reviews restore saved PCs' reconnection attempts; Task Scheduler failures show their own error
  instead of a sign-in instruction and stop background retries until startup options are reviewed.
  ([#2087](https://github.com/devswha/ovis/pull/2087) by @JJLiebig)
- The terminal no longer shows half of an agent's new screen over half of its old one while the
  agent streams, which happened most often with Korean text: the browser terminal is now xterm.js
  6, which draws a frame only once it is whole (#1617). Trackpad scrolling, Option+arrow word moves
  and Korean typing keep working as before.
  ([#2335](https://github.com/devswha/ovis/pull/2335))

### Maintenance
- Diagrams use updated DOMPurify and KaTeX versions without their published security advisories.
  ([#2290](https://github.com/devswha/ovis/pull/2290) by @DravenDou)
- A stopped server also closes its OpenCode event stream and forgets the OpenCode panes it verified, as
  it already did for Codex's app-server connections. The session list's Resume window and Hermes's
  result readers drop their duplicate code paths.
  ([#2200](https://github.com/devswha/ovis/pull/2200))
- A local browser lane run (no `CHECK_DIR`, no CI) takes the empty evidence folder it hands each
  check as none in every check: the touch-burst and terminal-autoswitch checks no longer write
  their captures into the checkout, and with `BROWSER_PARALLEL=1` the question-wheel, CJK
  punctuation and late-faces checks no longer fail at once creating an empty path (#1554).
  ([#2196](https://github.com/devswha/ovis/pull/2196))
- CI's parallel browser lane stops a script that runs past `BROWSER_SCRIPT_TIMEOUT_SECONDS`
  (600 s by default) with every process it started, and names it with its last log lines, so a
  hang fails fast instead of running into the job's timeout.
  ([#2287](https://github.com/devswha/ovis/pull/2287))
- The xterm source build compiles the exact files its cache key was made from, and the key now
  covers xterm's package manifest, so a source edited mid-build or a changed typings entry can no
  longer reuse an old build. A killed build's leftover staging directory is cleared by the next
  build, and the published build is readable by other users of the checkout.
  ([#2242](https://github.com/devswha/ovis/pull/2242))
- The Windows-native tests wait for the desktop child's whole result file instead of parsing it
  half written, and every Windows-only case has a 30 s budget for busy hosted runners.
  ([#2242](https://github.com/devswha/ovis/pull/2242))
- `bun run check` now ends a failed run with the reasons it failed, such as a source that changed
  while it ran, and the report path, instead of only `ok` steps and an exit code.
  ([#2135](https://github.com/devswha/ovis/pull/2135))
- Self-hosted CI runners keep a git mirror and the default branch's Bun packages on the host, read-only
  to jobs, so a job no longer downloads about 150-200 MB of checkout, tags and packages.
  ([#2215](https://github.com/devswha/ovis/pull/2215))
- The unit test run (`bun run test:unit`, CI's Fast checks) now also runs the component tests
  named `*.test.tsx`, which it had never picked up, and the agent sidebar's test passes when it
  runs on its own.
  ([#2094](https://github.com/devswha/ovis/pull/2094))
- Command discovery keeps following a linked command folder that points outside the project, as
  Command Code's own loader does, so the menu lists the commands Command Code runs; a test now pins
  it and the walker says why.
  ([#2134](https://github.com/devswha/ovis/pull/2134))
- Conversation fallbacks and recoveries now emit sanitized, rate-limited diagnostic episodes,
  including the failed Copilot identity stage without logging session IDs or transcript paths.
  ([#2292](https://github.com/devswha/ovis/pull/2292) by @YuuuXie)
- The file-thread test that holds a thread inside a read can no longer hang the unit run: its
  stand-in thread opens the FIFO it waits on before saying it is reading, and the test releases it
  with a write that never waits, so a thread ended in between no longer blocks the test forever.
  ([#2297](https://github.com/devswha/ovis/pull/2297))
- The sidebar no longer walks every stored read finish on each roster update for a PC that has
  none, and code the finish index kept for no current use is gone.
  ([#2183](https://github.com/devswha/ovis/pull/2183))
- The Copilot switch-back integration test now waits for the resumed transcript itself, not for the
  moment between the log's unregistering and registering lines, when a read rightly fails closed.
  ([#2224](https://github.com/devswha/ovis/pull/2224))
- The integration test that holds a first message once a same-kind agent replaces its own now starts
  the replacement before the first agent ends. Before, the shell alone was in front between the two,
  and a read in that gap rightly found the launched agent gone, which failed the test now and then.
  ([#2222](https://github.com/devswha/ovis/pull/2222))
- The OpenCode Tab agent-switch integration tests now start from a closed autocomplete. The test
  before them left the skill row selected on screen, and a send that read that old screen could not
  tell the agent before Tab, which failed the tests now and then.
  ([#2223](https://github.com/devswha/ovis/pull/2223))
- `scripts/roster-bench.ts` measures what a status burst costs the server and the browser with
  20 to 300 agent panes in an isolated herdr (#772).
  ([#2260](https://github.com/devswha/ovis/pull/2260))
- The Unicode case folding and confusables tables are generated only from source files whose SHA-256
  matches the pinned one (#2233).
  ([#2320](https://github.com/devswha/ovis/pull/2320))
- The browser check that a focused window takes its pane back no longer times out waiting for a
  resize after the first attach: since a new terminal attaches once its font is set, that attach
  already carries the final grid, so the check now waits for the shell to report the grid each
  window last asked for, by attach or by resize.
  ([#2295](https://github.com/devswha/ovis/pull/2295))
- The Release run now refuses while the remote PC bundle it names is only tagged: it waits until
  that bundle's manifest and archives can be downloaded, as remote PCs download them.
  ([#2212](https://github.com/devswha/ovis/pull/2212))
- The self-hosted runner launcher's tests of a hung first cache refresh no longer fail on a loaded
  host: they wait for the refresh to hang through a FIFO the stub writes to (no polling), allow
  30 s for that and for the launcher to end instead of Bun's 5 s test timeout, and let no runner
  start before the refresh has hung; only the stop on SIGTERM keeps a tight bound (4 s) (#2261).
  ([#2267](https://github.com/devswha/ovis/pull/2267))
- The terminal arrows and clicks browser check no longer fails now and then on a busy CI runner.
  It reads each letter before pressing the arrow that follows it, waits for xterm to report the
  mouse before clicking, and proves that nothing arrives by typing a mark instead of waiting a set
  time. A new unit test checks that the server holds an arrow back after the typing before it.
  ([#2219](https://github.com/devswha/ovis/pull/2219))
- The browser lane follows synchronized output (`CSI ? 2026 h` … `l`) from a real pane to the
  rendered rows: the bridge passes herdr's frames intact, herdr holds a pane's frame until it
  closes, and the run counts the renders xterm 5.5 draws from half a frame (#1617).
  ([#2331](https://github.com/devswha/ovis/pull/2331))
- Three tests that failed on busy hosts with nothing wrong in the code now measure what the code
  controls: the browser lane's stubbed runs get a 60 s hang guard, which ends the lane's process
  tree and fails with what it printed, instead of a 5 s limit (#2110); the Codex matcher's
  bounded-time cases compare the CPU time of an input with that of one as long that the code
  reads in one pass, which leaves the work both share out of the ratio while each still fails the
  quadratic scan it guards (#2142); and the OpenCode first-key gap is measured from the last thing that send itself
  waited on (#2143).
  ([#2150](https://github.com/devswha/ovis/pull/2150))
- Native TypeScript checks use less CPU with `GOGC=400` and at most 32 Go scheduler threads,
  retaining GC for concurrent CI runners. Caller `GOGC`, `GOMAXPROCS`, and `GOMEMLIMIT`
  settings are preserved.
  ([#2276](https://github.com/devswha/ovis/pull/2276))
- The Windows plugin test that stops the server's process tree no longer fails now and then on
  CI: it took a process whose recorded parent number Windows had handed on to a server process
  for part of the tree, and waited for unrelated processes, its own test runner among them, to
  exit. It now walks the tree the way `stop` does, skipping a process older than its parent.
  ([#2202](https://github.com/devswha/ovis/pull/2202))
- The native Windows terminal check now tests a pull request's merge with main, as the other CI
  checks do. On a branch cut before the check's script was fixed, it ran that branch's old script
  and timed out after the wheel pan, which made the check look flaky.
  ([#2253](https://github.com/devswha/ovis/pull/2253))
- The native Windows terminal check (a mirrored PowerShell pane's wheel, touch, panning and IME
  input in Chromium) now runs in CI on a Windows runner, `windows-terminal-qa.yml`, for pull
  requests that touch the mirror, the terminal's viewport code or the xterm patch, and weekly. It
  now picks Original width for the pane first: since wide mirrors fold on a phone by default, its
  panning steps could not pass.
  ([#2211](https://github.com/devswha/ovis/pull/2211))
- Builds running at once in one checkout, like the browser lane's parallel workers, no longer fail
  now and then with a missing xterm export: xterm's source is built once into its own cache
  directory and never rewritten while another build reads it.
  ([#2138](https://github.com/devswha/ovis/pull/2138))

## [0.4.19] - 2026-10-28

### Added
- Antigravity (Agy) chat on Windows: the pane's held conversation lock is found through the
  Restart Manager, so Chat reads the native conversation instead of falling back to terminal text.
  A process without a conversation, an unreadable creation time, or an ambiguous hold keeps
  Terminal.
  ([#2016](https://github.com/devswha/ovis/pull/2016) by @kyop21)
- A device whose push alerts stopped is told why: when the push service retired its subscription,
  the server no longer knows it or it was made for another server key, one line over the pane and
  the Test notification row of Settings → Alerts say so and offer Turn alerts on again, which
  subscribes the device anew; a refusal is told and opens Alerts, where Send test answers it. The
  server keeps the outcome of the last push to each subscription (`push-delivery.json`, owner-only,
  bounded like the retired list) and answers `POST /api/push/status` to the subscription's owner
  holding its keys alone. A failure older than the last success, no answer, throttling or a server
  error never raises the line, and no probe push is sent to find out.
  ([#1995](https://github.com/devswha/ovis/pull/1995))
- Settings → Phone & devices lists what protects the server, read-only: whether an access token is
  set, whether the pairing gate is closed, the kind of address it listens on and how this browser
  reached it. Whether it can be reached from the internet stays "Unknown" unless the request came
  through Tailscale Funnel, and no token value is ever shown.
  ([#1975](https://github.com/devswha/ovis/pull/1975))
- Chat shows the pictures in an omp session: one sent with a prompt, a prompt that is only a
  picture (as a turn of its own), and one a tool such as `read` returned. omp keeps their bytes in
  its blob store; Chat reads them from there and serves only bytes that match the name omp gave
  them. A picture omp keeps in its blob store shows when the PC runs Linux; on macOS and Windows
  only pictures omp keeps in the session itself show for now (#2004).
  ([#1998](https://github.com/devswha/ovis/pull/1998))
- Chat shows a picture a Codex tool returned (`view_image`, an image generation, a screenshot a
  command read) in that tool's row, loaded when the row is opened.
  ([#1998](https://github.com/devswha/ovis/pull/1998))
- An OpenCode 2 pane's subagents are background tasks, as a Claude Code pane's are: the message
  box's button and the sidebar badge count those running, the list shows them with the newest ten
  that ended in the last day, a turn that ends while they run reads BG with its finish alerted
  once, and one whose pane no longer runs that session reads as lost. A subagent run in the
  background leaves a card in the chat with its answer, and a foreground one's answer no longer
  shows OpenCode's `<subagent>` tag.
  ([#1987](https://github.com/devswha/ovis/pull/1987))
- Edit queued or held messages back into the composer without replacing its existing draft.
  ([#2041](https://github.com/devswha/ovis/pull/2041) by @odfalik)
- A PC whose own Ovis is older than this app can now be updated from here. When that Ovis can update
  itself, the PC's card offers "Update this PC's Ovis to vX", and with automatic PC bridge updates
  on it runs unasked. The app asks that server over SSH to install the release its own updater offers,
  shows its progress and reconnects once it is back on the new version. When it cannot update itself,
  the card says why and shows where that Ovis answers.
  ([#2048](https://github.com/devswha/ovis/pull/2048))
- **Rename tab** is a command palette action and a shortcut with no default key (bind one in
  Settings → Shortcuts): it opens the inline name field of the open tab, as the tab menu's Rename
  does.
  ([#1981](https://github.com/devswha/ovis/pull/1981))
- Settings → Phone & devices can revoke every paired device at once, the current one included, in
  one durable step that also voids any pairing code or unconfirmed pairing still out; the access
  token, the PC itself and its Tailscale login keep getting in, and the gate stays closed to
  strangers. Every open window is told when a device pairs, with a line that opens Phone & devices,
  and devices with alerts on get a notification of it.
  ([#1977](https://github.com/devswha/ovis/pull/1977))
- Settings → Appearance → **Sidebar filter** turns off the Filter field above the sidebar's lists on
  this device. With it off, **Filter workspaces and agents** in the command palette opens the field,
  focused, for as long as you filter.
  ([#2073](https://github.com/devswha/ovis/pull/2073))
- The terminal's key bar on a phone has a Show keyboard / Hide keyboard key after the Input line
  switch and Paste: it raises the keyboard for the current input mode or puts it away without
  sending a key, changing the mode or resizing the pane, and shows whether the keyboard is really up.
  ([#1973](https://github.com/devswha/ovis/pull/1973))

### Changed
- When the sidebar shows one PC and it is the Host (the only PC, or the others hidden on this
  device), its PC header row is gone and its workspaces start the list. Its state, notices and
  errors still show, and its **+** is a **New workspace** row under the workspaces. A remote PC
  shown alone keeps its header, with its name and its manage menu.
  ([#2073](https://github.com/devswha/ovis/pull/2073))

### Fixed
- Escape on an open agent list in the New session, Earlier sessions and New worktree dialogs closes
  only the list in Safari too, where a list opened with the mouse leaves the focus off its button;
  before, that Escape closed the whole dialog. An overlay opened over the dialog, such as Add PC,
  still takes its own Escape.
  ([#1972](https://github.com/devswha/ovis/pull/1972))
- A message queued in Chat for an agent started through a launcher that stays in front of it (an
  npm `claude` wrapper, a shell script) is held when the agent behind the launcher restarts, as it
  is for an agent started directly, instead of going to the new agent.
  ([#1986](https://github.com/devswha/ovis/pull/1986))
- On macOS, checking which agent a queued or first message goes to no longer stops the server
  while `ps` answers.
  ([#1986](https://github.com/devswha/ovis/pull/1986))
- Antigravity chat on macOS no longer falls back to Terminal for the whole of every turn: the
  catalog snapshot is opened through its real path instead of the `/var` symlink.
  ([#2030](https://github.com/devswha/ovis/pull/2030) by @phlips5437)
- Voice input in the Android and iOS apps can use the microphone: the Android app now asks for it
  instead of refusing it without a prompt, and the iOS app carries the microphone usage text that
  iOS requires before an app records.
  ([#2035](https://github.com/devswha/ovis/pull/2035) by @nahwan-kim)
- Chat keeps a turn's words and tool calls in the order the agent wrote them, as the terminal
  does: text written before a tool call no longer drops below every command of the turn.
  ([#2060](https://github.com/devswha/ovis/pull/2060))
- A Claude Code question asked while the fullscreen layout shows its diff panel beside the session
  now gets its question card instead of the generic input screen.
  ([#1984](https://github.com/devswha/ovis/pull/1984) by @bonecool999)
- Chat greets a Codex started by typing `codex` in a terminal, before its first message, as it
  does one started from the app, instead of saying the conversation is unavailable. It does so only
  when the screen shows Codex's start screen with nothing said, no `resume` or `fork` started
  it, and no conversation of that folder was begun or written since it started.
  ([#1967](https://github.com/devswha/ovis/pull/1967))
- Command Code suggestions show one row per command name, matching what Command Code runs.
  ([#1970](https://github.com/devswha/ovis/pull/1970))
- When a Command Code commands folder is too large to list in full, suggestions no longer offer a
  command Command Code would not run, and skills are offered as `/skill:<name>`.
  ([#1970](https://github.com/devswha/ovis/pull/1970))
- An unreadable Command Code commands folder no longer empties the whole command menu.
  ([#1970](https://github.com/devswha/ovis/pull/1970))
- Command Code completion stays open after `/mode:`.
  ([#1970](https://github.com/devswha/ovis/pull/1970))
- Very large or hostile repositories no longer hide your personal skills.
  ([#1970](https://github.com/devswha/ovis/pull/1970))
- Skill names are recognized in files with BOM-prefixed frontmatter headers.
  ([#1970](https://github.com/devswha/ovis/pull/1970))
- Copilot conversation history stays bound to the same session during a verified foreground
  parent-to-child process handoff, without accepting unrelated processes or stale reports.
  ([#1955](https://github.com/devswha/ovis/pull/1955) by @YuuuXie)
- Copilot Chat keeps conversations readable when recorded tool arguments are strings, including
  non-JSON input, while preserving bounded input display and verified tool output.
  ([#2024](https://github.com/devswha/ovis/pull/2024) by @YuuuXie)
- Copilot Chat can recover after a temporary log read failure or an append during its first read,
  without restarting the bridge or trusting a lost session binding.
  ([#2061](https://github.com/devswha/ovis/pull/2061) by @YuuuXie)
- Copilot Chat retains verified session continuity across safe partial log lines and retries
  concurrent log writes without permanently discarding the last verified checkpoint.
  ([#2025](https://github.com/devswha/ovis/pull/2025) by @YuuuXie)
- Earlier sessions now lists Hermes conversations made by `/branch` or a gateway reset, each
  resumed by its own id; Hermes's delegated runs, tool sessions and compression continuations
  stay hidden.
  ([#2001](https://github.com/devswha/ovis/pull/2001))
- With Settings → Terminal → Use alongside herdr's own window on, a tab you are in now also lets go
  of its pane after 10 seconds without typing, a click or a paste in its terminal. herdr's own window
  then has the pane at its own size again, instead of drawing it cut off with typing and clicks
  landing in the wrong place for as long as the tab stayed open. The next key, click, paste or
  composition in the tab takes the pane back, and what you typed goes in once, the first key
  included. If the pane cannot be taken back within 5 seconds, what you typed waits for you to send
  or discard it. With the setting off nothing changes.
  ([#2002](https://github.com/devswha/ovis/pull/2002))
- On an iPad whose Safari page zoom for Ovis is below 100%, the message box follows the on-screen
  keyboard again: a page zoom is no longer taken for a pinch zoom
  ([#1957](https://github.com/devswha/ovis/pull/1957) by @Noobear).
- Ovis for Mac keeps an unsent draft when the window follows the server to a new port: the chat's
  draft, the terminal's held input and held messages typed on the old port show on the new one,
  still waiting for Send or Discard.
  ([#1996](https://github.com/devswha/ovis/pull/1996))
- A crash or power loss no longer leaves the app unable to start because its saved remote PCs
  cannot be read. The damaged file is kept beside it under a new name, the app starts without
  those PCs, and Settings > Remote PCs names the file so you can add them again. The saved PCs
  and herdr's machine approvals are now written so that a crash cannot leave them unreadable,
  and only when they changed instead of on every refresh.
  ([#2045](https://github.com/devswha/ovis/pull/2045) by @mattmarcin)
- On macOS the server no longer pauses every connection while `ps` tells when an agent's process
  started or which terminal it runs in: it reads both from the kernel instead.
  ([#1980](https://github.com/devswha/ovis/pull/1980))
- Opening a file an agent named without its folder no longer pauses the server while git lists a
  large repository.
  ([#1980](https://github.com/devswha/ovis/pull/1980))
- Muse chat reads a session that `/fork` started in Muse 1.4.13, instead of falling back to
  Terminal.
  ([#2052](https://github.com/devswha/ovis/pull/2052) by @jpcarranza94)
- Muse chat reads the last 16 MiB of a growing session log once per append to check it for a
  rewrite, instead of hashing it twice with SHA-256.
  ([#2027](https://github.com/devswha/ovis/pull/2027) by @jpcarranza94)
- OpenCode: an `@skill` sent from Chat that did attach is no longer reported as not attached when
  the agent row redraws, a bordered line is on screen or the theme has no bold, and the message
  recorded for a send matches what was typed. If OpenCode shows that Tab switched its agent or
  attached another skill, nothing more is typed and the message stays in Chat.
  ([#1991](https://github.com/devswha/ovis/pull/1991))
- OpenCode: sending an `@skill` before the pane's skill list has loaded no longer pauses the server
  to scan the disk; the mention goes as plain text unless the skill is already known.
  ([#1991](https://github.com/devswha/ovis/pull/1991))
- A PC whose own Ovis restarts while this app is connected (its update, a crash, a reboot) now
  shows Reconnecting… and comes back by itself once that Ovis is back, instead of asking for setup
  approval; nothing of this app's is started on that PC in its place.
  ([#2071](https://github.com/devswha/ovis/pull/2071))
- A failed update of a PC's own Ovis now says so on the PC's card, with why, and in the line under
  the header, and one that ends on another version keeps the address to update it on that PC.
  ([#2071](https://github.com/devswha/ovis/pull/2071))
- A draft in the message box no longer stops ⌘⇧↑ / ⌘⇧↓ (Ctrl+Shift on Windows and Linux) from
  moving to the previous or next pane: the box keeps the keys only while they still select text
  that way, and the next press switches panes.
  ([#2034](https://github.com/devswha/ovis/pull/2034) by @jpcarranza94)
- A pane's unsent message, terminal line, held input, held chat messages and lens no longer show
  up in another pane after herdr restarts and gives its pane IDs out again. The earlier text waits
  in **Recover unsent text** in the pane's menu, where it can be put back in a message box (never
  sent), copied or discarded. A server restart alone keeps everything in place. Text kept before
  this update waits there too on the first load, since nothing says which herdr it was written for.
  ([#1997](https://github.com/devswha/ovis/pull/1997))
- A first message held because the agent started for it has ended now says so, apart from a pane
  whose terminal or agent session changed, and both notes read in Korean, Japanese and Chinese
  instead of the bridge's English.
  ([#1969](https://github.com/devswha/ovis/pull/1969))
- A PC whose SSH address is changed in its dialog now moves there only once that setup connects. A
  setup cancelled at its approval, or one that fails, leaves the PC at its own address, so a later
  reconnect or bridge update no longer starts this app's bridge at an address that was never approved.
  Until it connects there, the PC's card keeps its own panes, herdr version and update offer.
  ([#2078](https://github.com/devswha/ovis/pull/2078))
- A PC's own Ovis that updated itself but still answers an older version than this app's keeps its
  address and link on the PC's card, with why it cannot be updated from here.
  ([#2078](https://github.com/devswha/ovis/pull/2078))
- Pi's installed `questionnaire` tool now uses the web prompt card for options, free-text answers,
  and multi-question review, including narrow panes. Answers are bound to the pending tool call
  and checked against the current widget before input is sent; incomplete reviews cannot submit.
  ([#2003](https://github.com/devswha/ovis/pull/2003) by @philipprass-prog)
- Queued-message Edit requires ownership on the bridge and shares its withdrawal outcome with
  other tabs' held-copy resends, so a delivery that already won or could not be confirmed cannot
  also restore the draft. Dismissing uncertain text does not claim it was withdrawn.
  ([#2041](https://github.com/devswha/ovis/pull/2041) by @odfalik)
- Pi transcript confirmation reads bounded history tails and new entries instead of re-reading
  the whole conversation, and tolerates ongoing appends without accepting partial records.
  ([#2041](https://github.com/devswha/ovis/pull/2041) by @odfalik)
- Exact Pi delivery receipts reconcile after browser reconnection or reload on the local machine
  without clearing unrelated messages that happen to have the same text. Remote-machine receipt
  resumption is disabled until relays can identify the originating paired device securely.
  ([#2041](https://github.com/devswha/ovis/pull/2041) by @odfalik)
- Adding a PC whose own Ovis listens on another address than 127.0.0.1 (its HOST set to, say, its
  Tailscale address) connects instead of failing with "ECONNRESET": that Ovis now also answers the
  app's SSH tunnel on the PC's 127.0.0.1. An older Ovis set up that way, or one whose HOST is a host
  name, gets an error saying to update it or set HOST=127.0.0.1 there.
  ([#1983](https://github.com/devswha/ovis/pull/1983))
- A pane that comes back after herdr could not restore it, or whose terminal herdr replaced, shows
  its screen as current again when its attachment recovered meanwhile, instead of keeping its DONE
  dot until new output arrives.
  ([#1990](https://github.com/devswha/ovis/pull/1990))
- Settings opened right after it was closed, or right after the command palette closed on a phone, no
  longer closes by itself on a slow device: the late step back off the closed one's history entry is
  no longer taken for a Back.
  ([#2023](https://github.com/devswha/ovis/pull/2023))
- The terminal draws Korean in a coding face that matches its Latin text, in Ovis for Mac's window
  and in every browser: the app now carries the Hangul of D2Coding, fetched only once a pane prints
  Korean. Before, Korean fell back to the system's proportional font (Apple SD Gothic Neo on a Mac,
  Malgun Gothic on Windows) beside Menlo or Consolas. An installed Korean coding font still comes
  first where the browser can use it.
  ([#2062](https://github.com/devswha/ovis/pull/2062))
- In Safari and Ovis for Mac's window, the terminal measures Nerd Font icons again once their font
  arrives, so a late icon font no longer leaves icons sized for the stand-in font.
  ([#2062](https://github.com/devswha/ovis/pull/2062))
- The terminal sizes icons and Korean from the faces that draw them however their fonts arrive.
  Before, two faces arriving together (both Korean weights from the cache in Ovis for Mac's window,
  or an icon with Korean) could leave icons drawn across the next cell and Korean enlarged past its
  two cells, and one font chunk that failed to load could keep the others at the stand-in's size.
  ([#2074](https://github.com/devswha/ovis/pull/2074))
- The bundled Korean face is no longer fetched when a Korean font installed ahead of it draws the
  text, nor while a terminal font typed in Settings loads, and that font is applied without
  waiting for it.
  ([#2074](https://github.com/devswha/ovis/pull/2074))
- A long IME composition in Direct typing keeps its newest characters in view again: one too long
  for the room right of the cursor moves left, and one wider than the terminal shows its end,
  instead of being cut off at the right edge.
  ([#2031](https://github.com/devswha/ovis/pull/2031) by @yaaayaaa)
- The words the bridge writes on an agent's prompt card itself, such as the /goal card's Close, the
  omp /handoff card's Cancel, a Hermes result's Dismiss, a fallback card's title and its Yes and No,
  and the model pickers' questions, now read in Korean, Japanese and Chinese. What the agent drew
  stays as the agent wrote it.
  ([#1979](https://github.com/devswha/ovis/pull/1979))
- Update and restart keeps the new version when `$HOME`, or the folder Ovis keeps its state in, is
  reached through a symlink (such as `/home/<user>` linked to another volume). Before, the updated
  server went back to the old version after its restart and offered the same update again.
  ([#2070](https://github.com/devswha/ovis/pull/2070))
- Skills and prompts are found on native Windows when `HOME` is unset: discovery falls back to
  `USERPROFILE`, then the user's home as Windows reports it.
  ([#2057](https://github.com/devswha/ovis/pull/2057) by @kyop21)
- Connecting a remote PC from Windows no longer hangs at "Checking the remote environment…": the
  server now runs Git for Windows' OpenSSH, because the one that ships with Windows never exits
  after a remote command prints something when the server starts it. `OVIS_SSH` picks another
  `ssh`. Git's `ssh` does not read Windows' `ssh-agent` service: setup asks for a password or a
  key file's passphrase instead, once, and the app key makes later reconnects unattended.
  ([#1989](https://github.com/devswha/ovis/pull/1989))

### Maintenance
- The check slot tests take their lock ports below 32768, under the ports Linux, macOS and Windows
  hand out on their own by default, so a neighbouring test's server can no longer take a ticket
  port and shift the queue; the ticket desk wait is measured on a clock of the test's own instead
  of the host's speed.
  ([#1978](https://github.com/devswha/ovis/pull/1978))
- The Grok exact store lookup tests wait until their fixture process runs its own script before
  reading its open files, so a loaded CI runner no longer fails them at random.
  ([#2011](https://github.com/devswha/ovis/pull/2011))
- The terminal insert contract test reads its recorder's log again until a deadline instead of
  waiting for a file watch event, which Bun could miss for the last write, and a timeout now names
  what the wait was for and how much text arrived.
  ([#1988](https://github.com/devswha/ovis/pull/1988))
- The Settings pages demo regression waits for a phone's sheets (Settings, the command palette) to
  finish rising before it clicks in them, so a loaded runner no longer clicks beside Settings' close
  button and times out.
  ([#2032](https://github.com/devswha/ovis/pull/2032))
- The status hub's OpenCode subagent tests give their stand-in device store the pairing listener
  the hub now subscribes to, so they run again on main.
  ([#2040](https://github.com/devswha/ovis/pull/2040))
- The Windows plugin tests remove their scratch folder again while Windows still holds a file in
  it for a moment after the processes they started are gone, instead of failing a passed test on
  `EPERM`.
  ([#1982](https://github.com/devswha/ovis/pull/1982))

## [0.4.18] - 2026-10-26

### Added
- Chat reads Muse Code sessions: prompts, answers, reasoning and tool activity, each pane bound to
  its own session by the lock Muse writes for its process.
  ([#1706](https://github.com/devswha/ovis/pull/1706) by @jpcarranza94)

### Changed
- Pictures a tool returned in Claude Code or pi (a Read of a screenshot, a browser screenshot) show
  as small thumbnails at the end of their work line in Chat, folded or open, without opening the
  row: hovering one shows it larger, a click opens the viewer on all of them. A block with many
  keeps the latest four and counts the rest. Codex and OpenCode pictures still load only when
  their row is opened.
  ([#1952](https://github.com/devswha/ovis/pull/1952) by @mattmarcin)

### Fixed
- Copilot chat can open older and recent tool results even after a transcript grows beyond 32 MiB.
  ([#1956](https://github.com/devswha/ovis/pull/1956) by @YuuuXie)
- On a phone, a Windows PC's terminal is no longer cut off on the right: a pane wider than the
  screen is drawn folded to its width, colours and links kept. The pane menu's Original width draws
  it as on the PC again, and Wrap to screen folds it on a desktop too; the choice is kept on that
  device.
  ([#1961](https://github.com/devswha/ovis/pull/1961))
- A chat opened on another PC while it waits to reconnect (a laptop that just woke, its network
  back late) asks that PC to connect now, instead of waiting out a retry delay of up to a minute.
  ([#1959](https://github.com/devswha/ovis/pull/1959))
- On a phone that only watches a pane, a pane another device sized wider than the screen is no
  longer cut off on the right: it is drawn folded to the screen's width, as a Windows PC's pane is,
  and so is a pane drawn at another device's size while the phone's keyboard is up. The pane menu's
  Original width draws it at that device's width again, panned sideways. A phone that types into
  the pane still gets the program redrawn at its own width.
  ([#1963](https://github.com/devswha/ovis/pull/1963))

## [0.4.17] - 2026-10-26

### Added
- In the Android app, a long press on a link in a chat reply or other rendered Markdown opens a
  sheet with Copy link and Open link, and Share link where the phone's WebView can share. A tap
  still opens the link. Browsers and the iOS app keep their own link menu.
  ([#1925](https://github.com/devswha/ovis/pull/1925))
- A picture Claude Code reads (a Read of a screenshot or any PNG, JPEG, GIF or WebP) shows inside
  that tool's row in Chat, loaded only once the row is opened.
  ([#1935](https://github.com/devswha/ovis/pull/1935))
- Installed GitHub Copilot CLI is offered in the agent picker for new workspaces, tabs and worktrees
  ([#1650](https://github.com/devswha/ovis/pull/1650) by @YuuuXie).
- Copilot CLI conversations can show native text, tool activity, recorded model, question choices
  and Autopilot completion summaries in chat on Linux when the foreground session is verified.
  Verified new sessions can show an empty chat before the first message; resumed sessions
  follow process-owned foreground lifecycle records with bounded, revalidated log reads.
  A trusted Herdr report and unique held marker can identify history only without conflicting
  lifecycle evidence. Unverifiable sessions use Terminal; interactive answers stay there too.
  ([#1652](https://github.com/devswha/ovis/pull/1652) by @YuuuXie)
- Grok Chat on macOS follows the session Herdr reported when that Grok process holds its
  events file and the file is newer than every other session it still has open. Windows
  stays on the terminal view.
  ([#1858](https://github.com/devswha/ovis/pull/1858) by @345ml)
- Settings → Remote PCs → Show in sidebar hides a PC on this device: it leaves the sidebar, the
  Agents list and the command palette, stays connected, and a link or an alert still opens its
  panes. The choice stays in this browser, one PC is always shown, and a line under the PCs says
  how many are hidden and brings them back.
  ([#1947](https://github.com/devswha/ovis/pull/1947))
- Settings → Appearance → Typography has an Interface font again: Default, System (this device's
  own interface font, whose kanji match its kana), Noto Sans or a typed list. It applies to menus,
  lists, dialogs and the sidebar, and to the chat until the chat has a font of its own; the terminal
  and code keep theirs.
  ([#1946](https://github.com/devswha/ovis/pull/1946))
- A tab with one pane moves to another workspace: Move to workspace… in its right-click menu
  lists the workspaces, and the palette offers Move tab to {workspace}. The tab keeps its name
  and its pane's running process, and the view follows it, in either half of a split, with what
  was typed into it and not sent.
  ([#1427](https://github.com/devswha/ovis/pull/1427) by @sergiorademacher)
- Dropping a pane's title on another pane's title in the same tab makes the two panes trade places
  (herdr's swap). The title under the pointer is highlighted, and no split view half is offered there.
  ([#1818](https://github.com/devswha/ovis/pull/1818) by @Noobear)
- A picture sent to pi, alone or with words, shows in that message in Chat. A message that is only a
  picture is a turn of its own, so older pages can start at it.
  ([#1945](https://github.com/devswha/ovis/pull/1945))

### Changed
- The Beta page on ovis.sh tells Android testers, in all four of its languages, to sign in to
  Google with the account on their phone before opening the testers group: signed out, Google
  shows only a "no permission" page, and signing in from there opens the Groups home instead of
  the group.
  ([#1933](https://github.com/devswha/ovis/pull/1933))

### Fixed
- Antigravity usage consults the official CLI only when the HTTP quota summary omits Gemini
  limits, keeping complete HTTP readings fast while recovering missing Gemini quotas.
  ([#1678](https://github.com/devswha/ovis/pull/1678) by @Davesaggio)
- An assistant answer no longer disappears inside the collapsed work summary when it is followed by
  a tool call or another answer.
  ([#1780](https://github.com/devswha/ovis/pull/1780) by @odfalik)
- Chat no longer drags a tool you opened up and away while the agent keeps working: opening a tool,
  a folded block or a whole output stops following the end, as scrolling up does, until you go back
  to it. A GJC session that writes its file again with the same turns (when it trims old tool
  outputs) no longer folds what you opened or moves you, and a todo update you opened stays open
  when the next one joins it in a Plan row.
  ([#1937](https://github.com/devswha/ovis/pull/1937))
- A Claude Code message that is only a picture is its own turn in Chat: after a rewind it no longer
  leaves the abandoned turns on screen, and older pages start at it like at any other prompt.
  ([#1935](https://github.com/devswha/ovis/pull/1935))
- Command Code: a permission prompt whose footer wraps or uses the ctrl+e / ctrl+y variants now
  shows its card in Chat, and an ordinary numbered menu (a theme picker) no longer shows as one.
  ([#1934](https://github.com/devswha/ovis/pull/1934))
- Command Code chat, where herdr reports the pane's session, shows the pane's current model right
  after you switch it, not only after the next message.
  ([#1934](https://github.com/devswha/ovis/pull/1934))
- A message sent while Codex works in Fast mode is confirmed as steering again, instead of timing
  out as unconfirmed: the check now accepts the `<model> <effort> fast ·` footer under the composer.
  ([#1923](https://github.com/devswha/ovis/pull/1923) by @bonecool999)
- Codex Chat now opens a session resumed through the `codex resume` picker from another folder on
  Linux and macOS, with Codex's default terminal title. Codex keeps every conversation a TUI shows
  loaded and locked; when nothing of the pane's own folder matches, the chat looks among those and
  shows one while the pane's screen shows one of its longer answers that no other open conversation
  ever said. Only Codex's answers on screen count, never a prompt, an answer to one of its
  questions, a queued message, a tool's output, the status line, the input box or the picker's
  list. It is not remembered: once the screen no longer shows such an answer, the chat says it
  cannot tell, as it does while another open Codex conversation is answering, or was interrupted
  or failed since it was opened. On Windows the `"thread-id"` title item is still needed.
  ([#1941](https://github.com/devswha/ovis/pull/1941))
- Chat recognizes Codex's collapsed question queue again when reasoning effort is Ultra, where Codex
  0.164 draws the main prompt as `»` instead of `›`.
  ([#1930](https://github.com/devswha/ovis/pull/1930) by @bonecool999)
- A command sent from Chat to a pi session larger than 16 MiB shows its result once pi records it,
  instead of staying "Accepted" until "No result seen" while pi kept writing to the session.
  ([#1936](https://github.com/devswha/ovis/pull/1936))
- A command sent from Chat to an OmO pane whose program Chat cannot find (native Windows) keeps its
  row once OmO's session starts, instead of disappearing with it.
  ([#1936](https://github.com/devswha/ovis/pull/1936))
- While a command sent from Chat waits for its result, each Chat refresh asks herdr for the pane's
  processes and sessions once instead of up to four times, and checking a long agent transcript that
  grew since the last refresh takes about a third of the time.
  ([#1936](https://github.com/devswha/ovis/pull/1936))
- The message box is drawn in Settings → Chat → Chat font, as the transcript is, not in the
  interface font.
  ([#1946](https://github.com/devswha/ovis/pull/1946))
- An option picked by typing its number in the message box can now be confirmed from the keyboard:
  in the empty box, the send key is the question card's Confirm (Enter, or Ctrl/⌘+Enter when
  "Enter sends" is off), and Escape its Cancel. Before, only a click on the card's button sent it.
  ([#1919](https://github.com/devswha/ovis/pull/1919) by @phirschybar)
- GJC question cards expose Other as a custom-answer field and verify the same inline editor
  before pasting and submitting a single-line reply, including replies that wrap in a narrow pane.
  Checks use the live screen rather than scrollback; changed or dismissed questions stop delivery.
  ([#1669](https://github.com/devswha/ovis/pull/1669) by @Kinetic27)
- Reopening an image after the file was overwritten shows its latest version, including in
  Firefox, by versioning the preview URL with the file's modification time and size.
  ([#1659](https://github.com/devswha/ovis/pull/1659) by @Kinetic27)
- In Ovis for Mac's window, the terminal no longer draws Korean larger than its cells, or rows over
  each other, on a Mac with fonts such as JetBrains Mono or D2Coding installed: the app's web view
  draws an installed font but cannot measure it, so the terminal now uses the system's fonts there,
  as in Safari.
  ([#1942](https://github.com/devswha/ovis/pull/1942))
- In a split view, an item of the tab menu opened in the inactive half (Rename tab, say) acts
  again: the press on it made the half active, which closed the menu before the item ran.
  ([#1427](https://github.com/devswha/ovis/pull/1427) by @sergiorademacher)
- A PC whose own Ovis is newer than this app no longer says to update that Ovis through its own
  Settings, which it already is: it now says to update this app (Settings → Updates), then
  reconnect. An older one still points to its own Settings.
  ([#1938](https://github.com/devswha/ovis/pull/1938))
- In a pi pane, a picture that is not really a PNG, JPEG, GIF or WebP, or is over 8 MiB, is no longer
  offered as a broken image, and a picture from before a clear can no longer be fetched.
  ([#1945](https://github.com/devswha/ovis/pull/1945))
- Keep messages submitted from Ovis Chat to Pi visible until Pi records the matching user turn, including messages staged during streaming or automatic compaction.
  ([#1795](https://github.com/devswha/ovis/pull/1795) by @odfalik)
- Pi's rpiv ask-user-question questionnaires show their real choices in Chat instead of only
  arrow, Enter and Escape controls. Single choices, typed answers, multiple choices and the final
  review use the widget's cursor and submit keys, with a fresh check before answering. Incomplete
  lists, side-by-side previews and terminal-owned notes or multi-choice custom drafts stay in Terminal.
  ([#1714](https://github.com/devswha/ovis/pull/1714) by @767251930)
- Pi questionnaires retain multi-paragraph question text and accept model footers with thinking
  disabled or model names containing "working". Typed answers reject control characters before
  sending any input, so a newline cannot prematurely submit a question or affect the next screen.
  ([#1714](https://github.com/devswha/ovis/pull/1714) by @767251930)
- Pi's system theme identifies the active tab by neutral text versus dim/green inactive tabs,
  not only a colored background. Reviews use Ovis's existing answer summary; an unanswered
  question stays visible and can be revisited, without falling back to arrow/Enter buttons
  or offering a partial submission.
  ([#1714](https://github.com/devswha/ovis/pull/1714) by @767251930)
- Pi multi-question cards show question chips and Back, including returning from review to edit
  saved choices or custom answers. Switching verifies the native current tab and never submits an
  answer. Unsent web edits must be submitted or cleared before switching, rather than lost.
  ([#1714](https://github.com/devswha/ovis/pull/1714) by @767251930)
- After a Pi questionnaire answer, Chat no longer briefly replaces the closing widget with generic
  arrow/Enter/Escape controls while Herdr's blocked state catches up. Recognized next questions
  still appear immediately, and a persistent unknown blocker remains available after settling.
  ([#1714](https://github.com/devswha/ovis/pull/1714) by @767251930)
- Pi's `/thinking` selector now opens a Chat card for the levels it offers, changing the
  current session without saving a new default.
  ([#1670](https://github.com/devswha/ovis/pull/1670) by @IdrisGit)
- Settings dropdown arrows have a consistent inset instead of sitting against the right border.
  ([#1836](https://github.com/devswha/ovis/pull/1836) by @duarteocarmo)
- Remote PC connections on macOS no longer fail when a long temporary directory makes the SSH
  control socket path exceed the Unix socket limit.
  ([#1756](https://github.com/devswha/ovis/pull/1756) by @mulatta)
- Updates allow more time to prepare and build a release on slow filesystems or busy PCs,
  instead of cancelling healthy Git, dependency installation, or build commands too early.
  ([#1820](https://github.com/devswha/ovis/pull/1820) by @vincrichard)
- A terminal whose attach stream ends while its pane is still live reconnects without showing a
  false terminal-ended screen or dropping held input.
  ([#1783](https://github.com/devswha/ovis/pull/1783) by @odfalik)
- On Linux, a Chinese candidate picked with a number key in the terminal (fcitx4 with Sogou
  Pinyin, and other input methods with no in-app preedit) is typed instead of the number.
  ([#1654](https://github.com/devswha/ovis/pull/1654) by @imurfutur3)
- A Windows PC whose bridge install was interrupted (its dialog closed, the SSH link dropped, the
  app killed) no longer keeps `install.lock` forever: the next setup reclaims it, so
  "Another installation is in progress; retry shortly" no longer survives the failure that left it.
  ([#1759](https://github.com/devswha/ovis/pull/1759) by @CharleoYang)

### Maintenance
- Document the existing launcher for source installs under a service manager, so a restricted
  `PATH` does not hide user-local agents such as Grok from the new-session picker.
  ([#1896](https://github.com/devswha/ovis/pull/1896) by @jimbb)

## [0.4.16] - 2026-10-25

### Changed
- On ovis.sh, the App Store and Google Play icons, and the download button on an iPhone or Android
  phone, open the iPhone or Android part of the Beta page in the visitor's language instead of
  saying "coming soon". The home page says under its download buttons that the phone apps are in
  beta, its FAQ says both are in open beta, and every page's top navigation links to the Beta page.
  ([#1929](https://github.com/devswha/ovis/pull/1929))

### Fixed
- An install made fresh with 0.4.14 or 0.4.15 no longer opens its sign-in gate after an update or a
  restart. Such an install moved to the state folder from before the rename, which held none of its
  paired devices, so any device, and anyone who could reach the address, got in without pairing;
  its shared settings were reset too. Ovis now uses the right folder, and takes the paired devices,
  shared settings and alert subscriptions of the other folder over into it, so devices paired before
  or after the update keep working and a revoked device stays revoked. A device list that cannot be
  read keeps the gate closed.
  ([#1931](https://github.com/devswha/ovis/pull/1931))
- An in-app update from such an install now stays on the new version after it restarts, instead of
  going back to the old one and offering the same update again.
  ([#1931](https://github.com/devswha/ovis/pull/1931))

## [0.4.15] - 2026-10-25

### Added
- Files → Changes compares a branch against a base of your choosing: a **Branch** scope with a
  base picker that lists the repository's local and remote branches (or takes a typed branch or
  commit), and reads what the branch changed since its merge base with that base, untracked files
  included, so what the base went on to change stays out. Each file's patch is read from the
  comparison the list answered with: a base that moves on changes nothing until Refresh, and a
  moved HEAD asks for one. A base that names no commit, a repository with no commit yet and a base
  sharing no history with HEAD are each refused by name, with nothing compared in their place.
  ([#1857](https://github.com/devswha/ovis/pull/1857))
- Mute alerts for one agent from its row's menu in the Agents list (the ⋯, a right-click or the
  context-menu key): the pane then raises no push (a browser's or the phone app's), in-app alert,
  chime or tab notification on any device or browser of the server, while its status is still drawn. The choice is shared with the
  other browsers like the pins, keyed by the PC and pane, and Unmute alerts tells only what
  changes after it. A watching device sees the state and cannot change it.
  ([#1848](https://github.com/devswha/ovis/pull/1848))
- A running Claude Code subagent in the background-task list opens a read-only sheet with the
  prompt it was given, what it has written and the tools it called so far, read from its own
  transcript on request and bounded; Refresh reads it again. A background command, another
  agent's task and a PC with an older bridge say so instead.
  ([#1842](https://github.com/devswha/ovis/pull/1842))
- A filter field above the sidebar's lists narrows the PC, workspace and agent rows to the ones whose
  labels match what is typed (the command palette's fuzzy matcher), in their usual order with their
  pins and folds; the selected pane's row and the rows over it stay, marked **Selected**. The query
  is never saved: it is empty again after a clear, Escape, closing the phone's drawer or a reload.
  ([#1851](https://github.com/devswha/ovis/pull/1851))
- ovis.sh has a Beta page (https://ovis.sh/beta/, in English, Simplified Chinese, Japanese and
  Korean) with two short steps for a tester: install Ovis on the computer, then join the iPhone
  TestFlight beta or the Android Google Play closed test. Every page's footer links to it.
  ([#1910](https://github.com/devswha/ovis/pull/1910))
- On a phone, the terminal's key bar has a Paste key: it reads the clipboard from that tap alone
  and puts the text into the input line at the caret, never into the grid, and drops a read that
  answers after the line, its caret or a composition changed, or the pane, the mode or the
  connection did. Beside Send, the input line has Insert: it types one line into the terminal
  without Enter, so a path or a flag can be put at the prompt and edited there. The line clears
  only once the PC confirms the terminal has the text; a refusal, a dropped connection or an
  older PC keeps it with a note, and nothing is sent again on its own. Several lines are not
  inserted: the line says to send them or insert them one at a time.
  ([#1853](https://github.com/devswha/ovis/pull/1853))

### Changed
- A chat tool card names its files from the pane's folder, as the file browser does: in a pane on
  `/work/app`, `/work/app/src/a.ts` reads `app/src/a.ts`. Its tooltip, the file it opens and a
  copied label keep the whole path, and a file outside the folder still reads as written.
  ([#1837](https://github.com/devswha/ovis/pull/1837))
- Todo updates an agent makes one after another fold into one row in the chat's work block: the
  current list with its progress, how many updates are still pending or failed, and every update
  in order when opened. Narration or any other step between updates keeps them apart.
  ([#1846](https://github.com/devswha/ovis/pull/1846))
- The chat says a plan update succeeded only when the transcript records it: Claude Code's
  results do; Codex and other agents record no outcome, so their latest list carries
  "outcome not recorded" instead of a success claim.
  ([#1846](https://github.com/devswha/ovis/pull/1846))
- Ovis for Mac opens Ovis in its own window, like a native app, as soon as the server runs: no
  more QR code and "Open in browser" first. The setup and the phone's QR code move to Ovis → Phone
  Setup…, and show first only while Ovis is not installed or not running. File → Open in Browser
  stays, links to other sites open in the default browser, and the window comes back to Ovis by
  itself once the server runs again.
  ([#1920](https://github.com/devswha/ovis/pull/1920))
- On a Windows PC, the download button on ovis.sh now downloads `Ovis.exe` instead of copying the
  PowerShell install command.
  ([#1924](https://github.com/devswha/ovis/pull/1924))

### Fixed
- Turning alerts back on no longer lets a pending visibility retry remove this device's push
  subscription.
  ([#1871](https://github.com/devswha/ovis/pull/1871))
- In the Android app with 3-button navigation, the message box and the terminal's key bar no
  longer sit under the navigation buttons at the bottom of the screen (with a floating keyboard,
  on Android System WebView 144 and later).
  ([#1914](https://github.com/devswha/ovis/pull/1914))
- A message sent from Chat while you were reading older turns now takes the chat back to its end
  once the PC accepts it, and the reply is followed there. Scrolling, paging or jumping before the
  message shows keeps the place you chose, and a message that was refused, queued or sent from
  another browser never moves the chat.
  ([#1831](https://github.com/devswha/ovis/pull/1831))
- Chat stops following new output when the reader drags the scrollbar up a little after holding
  it still, instead of only when the drag starts within half a second of the press.
  ([#1902](https://github.com/devswha/ovis/pull/1902))
- A pane running `claude attach` with options before `attach`, the start of the job's id or part
  of its name also shows the background job's conversation, found the way Claude finds the job. A
  job that cannot be told for certain keeps the terminal.
  ([#1897](https://github.com/devswha/ovis/pull/1897))
- Chat's command menu, and the terminal handoff of a command that needs the terminal, come back on
  their own after the pane's command list failed to load (a dropped connection, a restarting
  bridge), instead of staying empty until the pane is opened again.
  ([#1893](https://github.com/devswha/ovis/pull/1893))
- pi: `/name Release 1`, `/model <id>` and pi's other commands given an argument are no longer taken
  for terminal screens.
  ([#1893](https://github.com/devswha/ovis/pull/1893))
- An omo pane is typed into as omo even when an omo-looking helper process is listed before the omo
  that holds the session.
  ([#1893](https://github.com/devswha/ovis/pull/1893))
- OpenCode v2: the builtins both TUIs share are shown as verified on a v2 pane, as on v1.
  ([#1893](https://github.com/devswha/ovis/pull/1893))
- Claude Code: a bundled skill run by its slash command (`/code-review`, `/simplify`...), or a skill
  of your own named like one, shows as skill activity.
  ([#1893](https://github.com/devswha/ovis/pull/1893))
- A connection diagnostics report whose body takes more than 10 seconds to arrive is cut off, so a
  device sending one slowly can no longer hold every report slot and get other reports refused.
  ([#1883](https://github.com/devswha/ovis/pull/1883))
- Pasted and attached files no longer show up in the project's Git status: the default
  `.ovis` folder now ignores itself, and its files still open by the path the prompt
  names. An ignore file already in that folder, or an `OVIS_PASTE_DIR` folder, is left as is.
  ([#1830](https://github.com/devswha/ovis/pull/1830))
- A rendered HTML page, its own pictures, scripts and stylesheets, and the videos it plays from the
  server, are read from the file that was checked, so a folder swapped on the way afterwards can
  no longer put another file in their place. An HTML file that is a symlink takes its pictures,
  scripts and stylesheets from the folder of the file it leads to.
  ([#1892](https://github.com/devswha/ovis/pull/1892))
- With Settings → Terminal → Follow herdr's focus on, a split this device opens itself (Split pane
  right and open it) keeps the keyboard in the new pane and adds a Back entry, even when herdr's
  focus moving there reaches this device before the split's answer. The setting's description now
  says that a PC on Ovis older than 0.4.13 does not report herdr's focus.
  ([#1887](https://github.com/devswha/ovis/pull/1887))
- A message sent from the chat or the terminal's input line can no longer end its own bracketed paste
  early: a paste marker pasted into it is dropped, and the bridge refuses a message whose text and
  typed bytes disagree or that holds terminal control characters, before anything is typed or a
  terminal draft is cleared. The draft stays with the reason.
  ([#1840](https://github.com/devswha/ovis/pull/1840))
- The phone app can recover damaged notification keys without reinstalling. Open each PC in the
  app to refresh its push subscription; until then, its alerts may show only the fallback text.
  ([#1880](https://github.com/devswha/ovis/pull/1880))
- On Linux, a pi pane started with its own `PI_CODING_AGENT_DIR` draws its context ring against
  the windows in that directory's model catalogs, not the ones in the server's. A pane whose
  profile cannot be told (its environment cannot be read, and its session store is shared rather
  than the one inside the server's own agent directory) draws no ring instead of the server's.
  ([#1899](https://github.com/devswha/ovis/pull/1899))
- A release installed in the app from 0.4.13 or older now gets its Rust PTY host too: the updater
  of those versions builds a release without fetching it, so its terminals ran on Node, or were
  mirrored on a PC without Node. The new release's supervisor fetches the host in the background
  and checks it as an update does, and the next terminal runs on it.
  ([#1913](https://github.com/devswha/ovis/pull/1913))
- Dictation into the terminal in Safari (Mac, iPad and iPhone) types the corrected phrase once,
  instead of losing it or typing every draft of it before the final one. A phrase dictated while
  the pane is view-only is not typed later, and one dictated while the pane is not ready waits in
  the held input until you send or discard it.
  ([#1850](https://github.com/devswha/ovis/pull/1850))
- With the key bar's Ctrl held, a Korean syllable still being typed in Safari is typed before the
  chord or key-bar key, instead of being turned into the chord and lost.
  ([#1850](https://github.com/devswha/ovis/pull/1850))
- A touch swipe on a terminal no longer sends a leftover scroll step after a key, a disconnect, a
  pane switch, the observe role or a released attach: each of them ends the swipe. A fast swipe's
  scroll steps are spread over the next few frames, at most six per frame, instead of all at once,
  and every step still arrives.
  ([#1852](https://github.com/devswha/ovis/pull/1852))
- A release's Ovis for Windows attach no longer fails: its swap marker is no longer an empty file, which
  GitHub refuses to upload.
  ([#1912](https://github.com/devswha/ovis/pull/1912))

## [0.4.14] - 2026-10-25

### Added
- The Android app can take the PC's alerts as push notifications through Firebase Cloud
  Messaging, once the app is built with a Firebase project: it registers with the push relay
  per PC, decrypts each alert on the phone (the relay and Google cannot read it) and shows it.
  Without Firebase set up, the app builds and runs as before.
  ([#1744](https://github.com/devswha/ovis/pull/1744))
- The phone app can get the PC's alerts as push notifications. Turning alerts on in the app
  registers the phone with the push relay for that PC, and the PC sends it alerts as it sends them
  to a browser. On iPhone the app decrypts each alert on the phone (the relay and Apple cannot read
  it) and shows the PC's title and text, or "herdr needs you" when it cannot. The Android app does
  the same once it is built with a Firebase project. Alerts reach the app once the relay at
  `push.ovis.sh` is deployed.
  ([#1817](https://github.com/devswha/ovis/pull/1817))
- The diff viewer finds text in the file's loaded patch (Ctrl/Cmd+F or its Find button): added,
  removed and unchanged lines, including context that is folded or scrolled out of view, with a
  count and the match's line; it says that content outside the patch is not searched.
  ([#1849](https://github.com/devswha/ovis/pull/1849))
- Letta Code is offered in the agent picker for new workspaces, tabs and worktrees on a PC where
  `letta` is installed. Its chat shows the terminal's text for now.
  ([#1815](https://github.com/devswha/ovis/pull/1815))
- Ovis for Mac can be downloaded from https://ovis.sh: every release attaches a signed and notarized
  `Ovis.dmg`, so it opens without a Gatekeeper warning.
  ([#1834](https://github.com/devswha/ovis/pull/1834))
- Each release carries the Rust PTY host for Linux (x64, arm64) and macOS (universal) with a
  SHA-256 manifest. Installing the plugin, an update installed from the app and `install.sh` put the
  matching binary in `bin/ovis-pty-sidecar` after checking its checksum and that it runs, and the
  server uses it when `OVIS_PTY_SIDECAR=rust` asks for the Rust host. Remote PC bundles carry it
  too. (Later in this release, #1908 makes the Rust host the default; see Changed.)
  ([#1859](https://github.com/devswha/ovis/pull/1859))
- Ovis for Windows: download `Ovis.exe` from ovis.sh, click Install, and it sets up herdr, Bun and the
  Ovis server for your user, starts herdr when you sign in to Windows, and shows the QR code for the
  phone app, with no PowerShell or terminal. It asks before installing Git for Windows when that is
  missing, and Remove leaves herdr and your agents running. Every release gets `Ovis.exe`, and an
  `Ovis.msix` for the Microsoft Store once its identity is set.
  ([#1873](https://github.com/devswha/ovis/pull/1873))

### Changed
- GJC chat and GJC done alerts read the active session reported by a native extension instead of
  querying the SDK broker. Anyone upgrading must install it with
  `bun scripts/install-gjc-integration.ts` and restart GJC: without it, chat uses Terminal and the
  pane keeps herdr's own status, which may miss a done alert. Command menus use the filesystem
  skill catalog.
  ([#1542](https://github.com/devswha/ovis/pull/1542))
- herdrweb.dev now forwards to https://ovis.sh/, the project's only website. The installers
  (https://herdrweb.dev/install.sh, https://herdrweb.dev/install.ps1) and the demo
  (https://herdrweb.dev/demo/) stay at their addresses.
  ([#1658](https://github.com/devswha/ovis/pull/1658))
- The connect screen warns before opening a plain http address outside a tailnet or home
  network, as the pairing code would cross the internet unencrypted.
  ([#1697](https://github.com/devswha/ovis/pull/1697))
- The Mac app and ovis.sh call the program on your computer Ovis (the Ovis server) instead of herdr
  web UI. ovis.sh no longer links to herdrweb.dev: its links go to the guide and the repository on
  GitHub, and the setup answer shows the Windows command, `irm https://ovis.sh/install.ps1 | iex`.
  ([#1663](https://github.com/devswha/ovis/pull/1663))
- The herdr plugin is now `devswha.ovis`, installed from `devswha/ovis` on GitHub. Running the
  one-line installer again moves an install under `devswha.herdr-web-ui`: it stops the old
  plugin, installs the new one with the old one's settings and token, and removes the old id.
  `herdr plugin update` does not move the id: an install it updates stays under
  `devswha.herdr-web-ui` until the one-line installer runs again.
  ([#1655](https://github.com/devswha/ovis/pull/1655))
- Settings variables are now `OVIS_*` (`OVIS_TOKEN`, `OVIS_STATE_DIR`, ...; `OVIS_REF` for the
  installer's ref). The old `HERDR_WEB_*` names still work, and the `OVIS_*` one wins where both
  are set.
  ([#1648](https://github.com/devswha/ovis/pull/1648))
- The state dir moves from `~/.config/herdr-web-ui` to `~/.config/ovis` the first time the app
  starts, leaving a link at the old path; sign-in cookies, browser storage, the offline cache and
  pasted files (`<pane cwd>/.ovis`) use the Ovis name too. Browsers signed in before keep their
  sign-in, paired devices stay paired, and settings and drafts carry over.
  ([#1648](https://github.com/devswha/ovis/pull/1648))
- ovis.sh's download button follows the visitor's platform: Download for Windows and Download for
  Linux copy that platform's install command, and Get it on Android and Get it on iPhone show their
  mark and say the app is coming soon. On a Mac, an unknown platform or without JavaScript it stays
  Download for Mac. The labels read in every language of the site.
  ([#1742](https://github.com/devswha/ovis/pull/1742))
- The one-line installers and the demo are linked at ovis.sh (`curl -fsSL https://ovis.sh/install.sh | sh`,
  `irm https://ovis.sh/install.ps1 | iex`, https://ovis.sh/demo/), which hands them on from
  herdrweb.dev; the herdrweb.dev addresses keep working.
  ([#1641](https://github.com/devswha/ovis/pull/1641))
- In ovis.sh's day look, the sheep in the logo and the mascot has navy wool, so it stands out from
  its pink face and the cream page. The night look and the app icon are unchanged.
  ([#1742](https://github.com/devswha/ovis/pull/1742))
- ovis.sh says what Ovis is in its title and description ("Ovis: Claude Code, Codex and every
  herdr agent on your phone"), translated into Simplified Chinese, Japanese and Korean, and gives
  search and answer engines structured data for the site, the app and its FAQ, an llms.txt, and
  sitemap language pairs for the privacy and support pages. ovis.pages.dev and its preview
  addresses stay out of search.
  ([#1662](https://github.com/devswha/ovis/pull/1662))
- ovis.sh's day/night button takes the other look's colors: navy with a cream moon by day, cream
  with a navy sun at night, the sun now filled like the moon. The FAQ's + buttons take the same
  colors. The sheep above the closing call to action stands on the page with no tile behind it.
  ([#1752](https://github.com/devswha/ovis/pull/1752))
- The web app's icon, favicon, notification badge and link preview are now the Ovis sheep the
  phone and Mac apps and ovis.sh use. An installed app picks up the new icon with this update.
  ([#1656](https://github.com/devswha/ovis/pull/1656))
- The command palette finds settings by their own names: Interface font size, Enter sends, Send
  queued messages automatically, New tab button, Show above the message box, the OpenAI API key and
  the rest of their groups open Settings on that group, scrolled to it and focused, and Chat or
  Terminal font size finds its page in Japanese and Chinese too.
  ([#1835](https://github.com/devswha/ovis/pull/1835))
- The chat's plan chip now says the step the agent is working on beside its `done/total`, cut
  with an ellipsis where the row has no room for it and whole in the chip's tooltip and accessible
  name, so a phone no longer has to open the plan to see it.
  ([#1828](https://github.com/devswha/ovis/pull/1828))
- Terminals on Linux and macOS run on the Rust PTY host by default, so Node is no longer needed:
  the server checks the release's host once at startup and uses it, and a PC without Node attaches
  its panes on it alone. The Node sidecar remains the fallback for one release, when the host is
  missing or fails its check and the PC has Node 18 or newer; `OVIS_PTY_SIDECAR=node` asks for it.
  The installer and the plugin's build no longer require Node, and `install.sh` installs Node 22
  only when the host cannot be installed and there is no Node.
  ([#1908](https://github.com/devswha/ovis/pull/1908))
- The Rust PTY host can be turned on for real use on Linux and macOS: with `OVIS_PTY_SIDECAR=rust`,
  the server checks the binary once before using it and stays on the Node sidecar when it is
  missing, cannot run or cannot open a terminal, starts an attach on Node when the binary has gone
  since, and uses Node until a restart after the host crashes. `~/` in `OVIS_PTY_SIDECAR_BIN` is
  expanded, so the plugin's `env` file can name the binary. (Later in this release, #1908 makes the
  Rust host the default; see above.)
  ([#1829](https://github.com/devswha/ovis/pull/1829))

### Fixed
- Idle Antigravity conversations remain readable in Chat after the agent checkpoints its database
  and removes the WAL side files, without recreating files in the agent's store.
  ([#1727](https://github.com/devswha/ovis/pull/1727))
- The Antigravity usage meter now appears on Linux when the CLI keeps its sign-in in the desktop
  keyring.
  ([#1776](https://github.com/devswha/ovis/pull/1776))
- The phone app no longer opens a PC in the browser (Firefox, for one) when the address it opens
  answers with a redirect to Ovis elsewhere: http to https, an IP address to the PC's name or
  another port. That address becomes the PC and opens in the app. When the address redirects to
  anything that is not Ovis, such as a sign-in page, the app shows its error page naming it
  instead. Links to other sites still open in the browser.
  ([#1903](https://github.com/devswha/ovis/pull/1903))
- Copying a selection dragged through a code block in a chat reply no longer includes the block's
  language label, its "Show all" toggle or its notes: the selection takes the code alone.
  ([#1801](https://github.com/devswha/ovis/pull/1801))
- Chat no longer types a message into a screen the agent has open in the terminal outside a
  terminal peek (Codex's transcript search, Claude Code's /config): Send keeps it behind "A screen
  is still open in the terminal", with Send anyway, until the agent's input row is back.
  ([#1787](https://github.com/devswha/ovis/pull/1787))
- A chat message is no longer sent to the pane's agent when the device that sent it is revoked, or
  switches to watching, while the message is on its way to herdr; nothing is typed in its place.
  ([#1792](https://github.com/devswha/ovis/pull/1792))
- Chat keeps following new output after downward scrolling or clicking transcript text, while
  upward scrolling and navigation keys stop following even when the transcript has no focused element.
  ([#1734](https://github.com/devswha/ovis/pull/1734))
- A pane running `claude attach <job>` shows the background job's conversation instead of its
  terminal text, and work the job started before the attach is no longer shown as lost.
  ([#1813](https://github.com/devswha/ovis/pull/1813))
- A chat message whose device is revoked, or switches to watching, while Claude Code's restored copy of
  the last message is being cleared now says why it was not sent, instead of a bare "was not sent".
  ([#1798](https://github.com/devswha/ovis/pull/1798))
- Earlier Claude sessions are listed from the store of the pane you open the list from
  (`CLAUDE_CONFIG_DIR`), and Resume starts the session in that same store, so a second account's
  session with the same id is neither listed nor opened by mistake. On Windows the pane's Claude is
  found under its shell. If the new tab's shell picks another store (a startup file that exports
  `CLAUDE_CONFIG_DIR`), the tab is closed and the list says so. When the store cannot be told, or
  a new tab would not start in the same store, Resume is shown as unavailable instead of starting
  the session in the default store. A remote PC shows Resume as unavailable until its bridge is
  updated.
  ([#1598](https://github.com/devswha/ovis/pull/1598))
- A Claude Code pane on macOS that was started as `Claude` (capital C) shows the conversation
  instead of terminal text.
  ([#1521](https://github.com/devswha/ovis/pull/1521) by @jiaoew1991)
- Command Code chat now resolves its reported session in the process's project when the shell
  is in a different directory, including when herdr reports a helper's foreground directory.
  ([#1745](https://github.com/devswha/ovis/pull/1745))
- Native Codex skills on Linux use the first CODEX_HOME or HOME environment value, matching Codex.
  CODEX_HOME must resolve to an existing directory, following symlinks before parent components as
  Codex does. Relative paths use the Codex process's own directory; unresolved paths keep scanned skills.
  ([#1750](https://github.com/devswha/ovis/pull/1750))
- Codex Chat now finds a session resumed through the `codex resume` picker from another folder
  when Codex shows the thread id in its terminal title: add `"thread-id"` to `[tui].terminal_title`
  in `~/.codex/config.toml`. The title only offers that one conversation: the chat opens it once the
  pane's screen shows one of its longer answers (64 or more letters and digits) that no other
  conversation of the pane's folder also gave. An id that the pane's folder, or a stored
  conversation's folder or name as Codex shows them in the title, also contains is not taken. With Codex's default
  title, such a session still shows "Conversation unavailable", since nothing else ties the pane to it.
  ([#1790](https://github.com/devswha/ovis/pull/1790))
- Opening a finished chat now clears its DONE dot after several turns finished while away,
  or when the previous finish was read in Terminal without a saved answer.
  ([#1802](https://github.com/devswha/ovis/pull/1802))
- In Safari with always-visible scrollbars, the message box no longer grows a line too early or
  too late when a draft ends right where a line wraps: the hidden copy that measures it now gets
  the same scrollbar.
  ([#1826](https://github.com/devswha/ovis/pull/1826))
- With Settings → Terminal → Follow herdr's focus on, herdr's focus moving to another pane no
  longer takes this device's view while someone types into it, has a dialog open, or has an unsent
  message on the pane (its chat draft, its terminal input line, or what the terminal held while it
  was disconnected): the keyboard stays up, the dialog stays open and the draft stays in front. A
  window in the background still follows.
  ([#1803](https://github.com/devswha/ovis/pull/1803))
- Chat no longer shows gjc's internal IRC deliveries between panes as notices when an older gjc
  build wrote them without attribution. IRC records credited to the user still show.
  ([#1794](https://github.com/devswha/ovis/pull/1794))
- Grok Chat falls back to the terminal when a held session events file is replaced, rather than
  letting a replacement file's timestamp confirm the wrong conversation.
  ([#1733](https://github.com/devswha/ovis/pull/1733))
- Grok chat falls back to the terminal, instead of showing an older conversation, when Grok holds
  a session's events file under another name: renamed to `old-events.jsonl`, or in a session
  folder renamed to a name the session filter skips.
  ([#1894](https://github.com/devswha/ovis/pull/1894))
- A command repeated from Chat (Hermes `/status`, say) shows its own result again after one send of it was lost on a
  screen of identical result blocks, instead of every later repeat staying "Accepted" until "No result seen".
  ([#1804](https://github.com/devswha/ovis/pull/1804))
- A one-line message of more than 200 characters sent from the terminal's input line reaches the pane's
  agent whole: it goes as the agent's prompt, pasted in the agent's own paste mode, where typing it left
  Claude Code with only its tail. A shorter line, and any line to a pane whose agent is waiting for an
  answer or that runs no agent, is still typed.
  ([#1791](https://github.com/devswha/ovis/pull/1791))
- The one-line installers (`install.sh`, `install.ps1`) work again while the latest release still
  names the plugin `devswha.herdr-web-ui`: they install it under that id instead of failing with
  "herdr does not list the plugin after installing it", and they leave an install under the old id
  in place rather than stopping it for a move that release cannot make. The move to `devswha.ovis`
  happens on the first run after a release that names the new id. Where raw.githubusercontent.com
  is blocked, a release's version tells which id it uses.
  ([#1691](https://github.com/devswha/ovis/pull/1691))
- The iOS app shows which PC it is opening, with Change PC, instead of a blank black screen. A PC
  that does not answer within 20 seconds gets Try again and Change PC there, and for a Tailscale
  address a note that Tailscale may be off on the phone, instead of a wait of a minute or more.
  ([#1860](https://github.com/devswha/ovis/pull/1860))
- When a PC with a Tailscale address cannot be reached, the app's error page also says that
  Tailscale may be off on the phone, next to Try again.
  ([#1860](https://github.com/devswha/ovis/pull/1860))
- On a phone, a key-bar tap (Enter, Esc, Ctrl and the rest) no longer brings the keyboard back up
  after you put it away; only the keyboard key, or a tap on the line or the terminal, raises it.
  ([#1632](https://github.com/devswha/ovis/pull/1632) by @adnankassem)
- A link to the web app previews with the same Ovis sheep card as ovis.sh, and its image
  description names the sheep instead of the old ram artwork.
  ([#1718](https://github.com/devswha/ovis/pull/1718))
- On a phone, a lone pane's banners (such as View only) now start below its menu button instead of
  covering it.
  ([#1784](https://github.com/devswha/ovis/pull/1784))
- Ovis for Mac no longer stays on "Starting herdr…" after installing a release that installs the
  plugin under its old id (0.4.13 and older): it finds that install and shows its status and QR
  code. When the server does not come up within two minutes, it says so instead of waiting on,
  and Try again repeats the step that failed.
  ([#1832](https://github.com/devswha/ovis/pull/1832))
- Restart and Start in Ovis for Mac start the server again instead of leaving it stopped: the
  start no longer runs while the stop is still under way. Remove also waits for the server to stop
  before it removes the plugin.
  ([#1877](https://github.com/devswha/ovis/pull/1877))
- The iOS app no longer keeps every page it left in memory: each Change PC used to leave the old
  web view behind.
  ([#1697](https://github.com/devswha/ovis/pull/1697))
- The iOS app no longer shows a white screen while a page loads with the phone in light mode,
  such as the seconds of a first launch.
  ([#1697](https://github.com/devswha/ovis/pull/1697))
- The Android app's launch screen and system bars are dark like the app instead of white, and
  the bars take the color of the page's top bar, with icons that stand out on it.
  ([#1697](https://github.com/devswha/ovis/pull/1697))
- The app's error page says why a PC could not be opened on Android too, and shows up when a PC
  answers with an HTTP error (such as a 502 while Ovis is stopped there) instead of keeping that
  page and saving the PC. Its buttons also work on older Android WebViews.
  ([#1697](https://github.com/devswha/ovis/pull/1697))
- The Android app leaves its data out of backups and moves to a new phone, so a paired PC's
  sign-in cannot be restored elsewhere.
  ([#1697](https://github.com/devswha/ovis/pull/1697))
- Debug builds of both apps no longer write pairing links to the device log. Release builds
  already had this logging turned off.
  ([#1697](https://github.com/devswha/ovis/pull/1697))
- An omp Ask multiple-choice question keeps its card in Chat in a narrow pane, where omp clips the end of its
  key hint (`⎋ cance…`).
  ([#1814](https://github.com/devswha/ovis/pull/1814))
- An omp Ask question keeps its card in Chat while omp shows its status row under the question panel
  (omp 18.12 with `composer.shape: pi`).
  ([#1812](https://github.com/devswha/ovis/pull/1812))
- An omp pane whose sessions live outside `~/.omp/agent` shows its chat: the bridge finds the store
  the pane's own omp process writes to, from its `--session-dir` or profile and the `HOME`,
  `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR` or XDG data and state
  directories it was started with, never from the bridge's own environment. A session herdr names
  outside that store, a link out of it, another folder's session in a session directory of its own,
  a session version omp does not write, an omp whose environment cannot be read and two omp
  processes using different stores show no chat rather than a guess. Values omp reads from its own
  `.env` files are not seen, and Windows keeps reading `~/.omp` and its profiles only.
  ([#1898](https://github.com/devswha/ovis/pull/1898))
- Queued `/model` commands in omp now open the session-only model picker, as immediate sends do,
  including when an immediate send falls back to terminal input.
  ([#1735](https://github.com/devswha/ovis/pull/1735))
- Chat messages sent to an omp started with `--session-dir` now wait for its installed herdr
  integration to report readiness, up to the startup timeout (30 seconds), before sending.
  ([#1825](https://github.com/devswha/ovis/pull/1825))
- A chat message with an `@skill` for OpenCode whose device is revoked, or switches to watching, before
  anything is typed now says why it was not sent, instead of claiming that part of it was typed.
  ([#1799](https://github.com/devswha/ovis/pull/1799))
- ovis.sh/docs, /guide, /install, /changelog and /faq open the guide, the install steps, the
  changelog and the FAQ instead of a missing page, and ovis.sh/ja/ and /zh/ open the home page in
  Japanese and Chinese, like /ko/.
  ([#1719](https://github.com/devswha/ovis/pull/1719))
- On a phone with the keyboard up, the chat header's menu button no longer shows as six dots: a
  lone pane's own menu button sat under the glass header's and now starts below it.
  ([#1778](https://github.com/devswha/ovis/pull/1778))
- An answer to a pi or OmO confirm or text input asked with a timeout is no longer refused as
  stale when it is tapped after the countdown has ticked.
  ([#1888](https://github.com/devswha/ovis/pull/1888))
- Each plugin start keeps the run before it as `server.log.1` and begins a new `server.log`,
  instead of appending every run to one file that grows forever. While the recorded server is
  still running, the start appends to its log as before.
  ([#1855](https://github.com/devswha/ovis/pull/1855))
- A failed plugin start reads at most the last 64 KiB of what its server wrote to `server.log`
  for the lines it prints, so a large log no longer costs memory. On Windows, the plugin's
  wrapper still shows the last 15 lines of `server.log` itself.
  ([#1855](https://github.com/devswha/ovis/pull/1855))
- A plugin install that stops on a too-old Bun from Homebrew now says to run `brew upgrade bun`
  instead of `bun upgrade`.
  ([#1715](https://github.com/devswha/ovis/pull/1715))
- Limit synchronous macOS process-start probes to one second so a stalled probe cannot block
  conversation and pending-send checks indefinitely.
  ([#1748](https://github.com/devswha/ovis/pull/1748))
- A question card's "Not updated" notice counts failed reads of the screen across a restart of the
  poll: a failed read, a refused answer and one more failed read now show it.
  ([#1856](https://github.com/devswha/ovis/pull/1856))
- An agent's open row menu now closes when its PC disconnects or its row disappears, and stays
  closed if the PC or row returns. A brief reconnect keeps the sheet open with its row's details.
  ([#1751](https://github.com/devswha/ovis/pull/1751))
- Read finishes shared with other browsers now retry network and proxy errors with shared backoff,
  and resume after signing in again through one authentication check for all pending finishes,
  without resending on every sidebar update.
  ([#1747](https://github.com/devswha/ovis/pull/1747))
- A finish read on another device no longer turns unread again in a browser where another tab
  removed its record while no sidebar was open: the read record is written back instead of
  being skipped as already stored.
  ([#1797](https://github.com/devswha/ovis/pull/1797))
- A server run as a service now offers and starts OmO and Gajae Code when they are installed only on
  its user's login-shell PATH (such as `~/.local/bin`), and starts the same executable it offered.
  The login shell runs only when the agent list or a start needs it, at most once a minute, and
  the server logs why when it gives no PATH.
  ([#1597](https://github.com/devswha/ovis/pull/1597))
- Keyboard shortcut changes now reach other already-open tabs of the same browser without a reload.
  ([#1827](https://github.com/devswha/ovis/pull/1827))
- Custom sidebar token rows are kept when herdr's config contains a byte-order mark at the start of
  a later line. Oversized or non-regular config files are ignored without waiting on a pipe.
  ([#1722](https://github.com/devswha/ovis/pull/1722))
- Bound skill and custom-command discovery by directory entries and file reads as well as folder
  visits, so linked folder lattices cannot repeatedly scan and read the same files without limit.
  Claude and Devin now share those limits across all skill and command roots in one discovery.
  Missing optional ignore files do not consume read allowances, and reaching the command read
  limit preserves the completed visible rows.
  ([#1746](https://github.com/devswha/ovis/pull/1746))
- A message sent right after the page connects, before the PC says what it supports, is no longer typed into the
  pane as raw input past the checks a send makes: it stays in the composer, marked not sent, to send again.
  ([#1805](https://github.com/devswha/ovis/pull/1805))
- A message not sent because the PC had not yet said what it supports now says so, instead of saying the
  connection dropped.
  ([#1808](https://github.com/devswha/ovis/pull/1808))
- The desktop terminal follows herdr's `[ui] copy_on_select` on the PC serving Ovis, for local and
  remote panes alike. With it off, letting go of a drag only selects, the selection stays when the
  pointer moves over the terminal, and Ctrl+C or Copy copies it; with it on (herdr's default),
  letting go copies as before. A Ctrl+C or Copy made before herdr has sent the text of a drag
  still copies that whole text, not only the rows on screen.
  ([#1810](https://github.com/devswha/ovis/pull/1810))
- On a phone the terminal input line and the key bar are evenly spaced: the field and its send
  button no longer sit on the key bar's edge, and the keys no longer touch the bottom of the screen;
  every key keeps a 44px touch target.
  ([#1527](https://github.com/devswha/ovis/pull/1527) by @adnankassem)
- The terminal's input line and grid now ask an Android keyboard for no word suggestions: they say
  `autocomplete="off"`, which Chrome turns into the keyboard's no-suggestions flag, and a keyboard
  that honors it hides its suggestion strip there. Gboard 18.4 ignores it and keeps the strip. The
  chat composer keeps its suggestions.
  ([#1530](https://github.com/devswha/ovis/pull/1530) by @adnankassem)
- A long voice-typing or IME composition in Direct typing no longer scrolls the terminal sideways,
  on a phone or a computer: the grid stays in place, and the composition stays inside the visible
  terminal.
  ([#1800](https://github.com/devswha/ovis/pull/1800))
- A line typed from the terminal's input line, or a chat message typed into a pane without an agent,
  is no longer typed or entered when the device that sent it is revoked, or switches to watching, while
  it is on its way to herdr.
  ([#1796](https://github.com/devswha/ovis/pull/1796))
- Updating in the app from 0.4.13 starts the new release's own supervisor instead of falling back to
  0.4.13's with an "updated supervisor failed to start" notice: while the launcher from before the
  rename runs, the state stays in `~/.config/herdr-web-ui`, where that launcher finds the installed
  release, and moves to `~/.config/ovis` once the app starts from an updated checkout or plugin.
  ([#1723](https://github.com/devswha/ovis/pull/1723))
- Starting Ovis on Windows with Bun installed through npm no longer opens its PowerShell shim
  in Notepad and hangs. Plugin commands use a runnable Bun application and report when none is found.
  ([#1721](https://github.com/devswha/ovis/pull/1721))

### Maintenance
- The iOS app is ready for its first App Store submission: it carries a privacy manifest (no
  tracking; the PC's anonymous usage counts declared for analytics), asks for arm64 instead of the long-gone armv7, and
  `app/store/ios.md` lists the App Store Connect steps, listing text, privacy and age answers and
  review notes, with iPhone and iPad screenshots beside it.
  ([#1737](https://github.com/devswha/ovis/pull/1737))
- A self-hosted CI runner host can raise its own herdr-backed slots, integration shards and browser
  and unit workers with `run.sh --env-file` (`CHECK_HOST_*`), so a large host shards wider while
  other hosts keep `ci.yml`'s values.
  ([#1839](https://github.com/devswha/ovis/pull/1839))
- Pushes to main can run their Linux CI jobs on self-hosted runners of their own (`run.sh
  --reserved` and the `CI_MAIN_SELF_HOSTED_LABELS` repository variable), so a merge's CI no longer
  queues behind pull request runs.
  ([#1906](https://github.com/devswha/ovis/pull/1906))
- Remote PC settings recovery logs now distinguish filesystem error codes from invalid JSON
  without exposing settings content or raw error messages.
  ([#1731](https://github.com/devswha/ovis/pull/1731))
- The package, source comments and test fixtures now use the Ovis name; the isolated test herdr
  session is `ovis-test` and the README media session is `ovis-demo`.
  ([#1579](https://github.com/devswha/ovis/pull/1579))
- The Android app's Google Play closed test is ready to set up: `app/store/android.md` holds the
  upload key steps, the release build, the store listing and App content answers and the Play
  Console steps, with the icon, feature graphic and screenshots beside it.
  ([#1736](https://github.com/devswha/ovis/pull/1736))
- The push relay drops an Android phone's endpoints when FCM calls its token invalid, as it already
  did for an iPhone's token Apple calls invalid, and `push-relay/test-push.ts` checks a real push
  through FCM too. The relay's tests run in Fast checks instead of a workflow of their own.
  ([#1816](https://github.com/devswha/ovis/pull/1816))
- The phone app's push relay, a Cloudflare Worker for `push.ovis.sh`, is in `push-relay/` with its
  tests: it forwards the PC's end-to-end encrypted alerts to Apple's push service (iOS) or
  Firebase Cloud Messaging (Android) without being able to read them, pins each endpoint to the
  key of the PC it was registered for, rate-limits every endpoint, every phone and every
  registering address, and deletes endpoints unused for 60 days. It is not deployed yet.
  ([#1695](https://github.com/devswha/ovis/pull/1695))
- CI builds the Rust PTY host and runs its checks and the PTY session checks on it in a job of
  its own.
  ([#1829](https://github.com/devswha/ovis/pull/1829))
- The **Rust PTY host binaries** workflow builds the host for each platform, runs `cargo test`, and
  on Linux runs the PTY session checks on the built binary; Release attaches its output before it
  publishes.
  ([#1859](https://github.com/devswha/ovis/pull/1859))
- An experimental Rust PTY host (`crates/pty-sidecar`) speaks the Node sidecar's protocol; the
  server first ran it in place of the Node sidecar only with `OVIS_PTY_SIDECAR=rust` and a built
  binary; by this release it is the default (see Changed).
  ([#1785](https://github.com/devswha/ovis/pull/1785))

## [0.4.13] - 2026-10-22

### Added
- Claude Code, grok and Antigravity messages in Chat offer Rewind in terminal: it sends nothing,
  preserves your draft and opens the pane's terminal with a hint to run the agent's own `/rewind`.
  Chat follows the native conversation when the agent records its new branch.
  ([#1500](https://github.com/devswha/herdr-web-ui/pull/1500))
- Chat sends wait while Claude Code's rewind dialog is open in the terminal, so a message cannot
  land in the dialog's own text field.
  ([#1500](https://github.com/devswha/herdr-web-ui/pull/1500))
- Sending a bare `/goal` to Claude Code from Chat now shows its goal status (the condition and how
  long it has run, or that no goal is set) in a card with Close, instead of leaving the dialog in
  the terminal.
  ([#1450](https://github.com/devswha/herdr-web-ui/pull/1450))
- Command Code (`cmd`) agent panes now show their conversation in the web UI: transcript
  resolution from `~/.commandcode/projects/`, `/tree` branch projection, model and context
  window from Command Code's catalog, permission prompts, and skill discovery.
  ([#1399](https://github.com/devswha/herdr-web-ui/pull/1399) by @diegolhambi)
- An ordinary command sent from Chat says what became of it under its bubble, from evidence only:
  accepted, waiting for your answer (with a way to the card), done with what showed it, runs in
  the terminal (with Open Terminal), or no result seen. A command the agent keeps no transcript
  turn for still shows its sent row. A terminal screen that
  changed after the send folds under the chip as an unconfirmed preview, never proof that the
  command finished. Terminal-only commands instead leave one quiet row with Ran in terminal and
  Open Terminal, without outcome chips or unconfirmed previews. Hermes informational result cards
  keep showing what the agent printed.
  ([#1450](https://github.com/devswha/herdr-web-ui/pull/1450))
- Settings → Terminal → Follow herdr's focus: when herdr moves to another pane (a click in its
  window, `herdr tab focus`, a script), this device opens that pane too. Off by default, and set per
  device, so a phone open on another pane stays there.
  ([#1432](https://github.com/devswha/herdr-web-ui/pull/1432))
- Hermes `/help`, `/status`, `/version`, `/profile` and `/reload-skills` sent from Chat show what
  Hermes printed in a card closed with Dismiss, which sends nothing to the pane.
  ([#1450](https://github.com/devswha/herdr-web-ui/pull/1450))
- Chat lists the commands and skills an OpenCode v2 pane's own background service reports for its
  folder, refreshed when they change, and settles a command it sent from that session's own events.
  The service is only read, never started, and only when it is the process its service.json names.
  ([#1489](https://github.com/devswha/herdr-web-ui/pull/1489))
- An `@skill` sent from Chat to OpenCode v2, at once or queued, is typed through OpenCode's own
  autocomplete so the skill is attached; when the row does not show, the message says the skill
  went as plain text and points to the terminal.
  ([#1489](https://github.com/devswha/herdr-web-ui/pull/1489))
- An OpenCode 1.x question is a card in Chat with each option and its description, answered from
  the card.
  ([#1489](https://github.com/devswha/herdr-web-ui/pull/1489))
- Chat lists a Codex pane's skills as the running Codex daemon of that pane's own Codex home reports
  them (Codex 0.157 or later; on Linux, or when the server's Codex home is set), and a gjc pane's
  skills as the SDK broker it is bound to reports them, asked through the gjc CLI in the background.
  The daemon and the broker are never started for this; without one, the skills read from disk stay.
  ([#1489](https://github.com/devswha/herdr-web-ui/pull/1489))
- New workspace and New tab start an agent with its model, effort and first message where the
  agent's command line takes them (Claude Code and Codex: `--model` and the effort level; Codex also
  takes the message as its own argument, behind `--` so a message like `logout` is never a command).
  For Claude Code and every other agent the message is queued on the PC as the pane's first pending
  message and sent once when the agent is ready, through the page that started it; it shows as a
  pending message that can be discarded or sent now. If that page disconnects, reloads or leaves the tab
  first, the message is held, never sent on its own, until someone sends it now or discards it. A message the PC
  could not queue, or one an older PC ignores, stays in the new tab's message box and the dialog says
  so. Pending first messages are kept in memory: restarting the web UI's server drops them. A Codex
  message with a tab or a line break is sent as the first message rather than on its command line,
  and the PC refuses launch arguments with control characters, an unknown effort level or a model
  that is not one word. Under the message, the agent's skills in the
  folder are listed before it runs, each a chip that puts the skill as the agent types it into the
  message (`$name`, `/name`, or `@name` for OpenCode 2). A first message to OpenCode attaches its
  `@skill` as any Chat send does; before OpenCode has a session nothing tells its version, so the `@`
  is sent as the plain text it is.
  In a desktop window the chat's composer can show a New tab with an agent… button that opens the
  dialog on the pane's workspace; it is off until turned on in Settings → Chat → Composer (New tab
  button), and the tab menu opens the dialog either way.
  ([#1512](https://github.com/devswha/herdr-web-ui/pull/1512))
- omp's `/handoff` runs from Chat, with or without focus instructions: while omp writes the
  handoff document, Chat shows a card that cancels it, and afterwards Chat stays on the same
  conversation, which omp compacts in place.
  ([#1450](https://github.com/devswha/herdr-web-ui/pull/1450))
- omp's model picker shows in the chat as a card, as Claude Code's, Codex's and OmO's lists do: pick
  a model and it is picked for the session, the model in use named on the card. `/model` sent from
  an omp chat opens it: the chat sends it as `/switch`, because omp's own `/model` opens its role
  hub, whose picks are saved as the default for later sessions.
  ([#1377](https://github.com/devswha/herdr-web-ui/pull/1377) by @evanwy0223)
- OpenCode 2.0 or later: its questions are answered from the chat's prompt card through OpenCode's
  own background service instead of keystrokes, one question at a time with Back to change an earlier
  answer, and sent together after the last. Permissions, OpenCode 1 and other prompts keep the
  existing generic fallback card and Terminal.
  ([#1257](https://github.com/devswha/herdr-web-ui/pull/1257) by @bardiz12)
- HTTP requests and WebSocket handshakes now carry request IDs and write bounded completion
  records in the app's state directory, so the owner can correlate a response with its request.
  ([#1558](https://github.com/devswha/herdr-web-ui/pull/1558))
- A workspace's row menu has Earlier sessions…: the sessions each agent kept for the workspace's
  folder, read from the agent's own store on the PC, newest first with the title, the first prompt
  and the time. Resume starts the agent on that session in a new tab of the workspace; a session a
  pane already shows is opened by selecting that pane instead. Picking `/resume` in the chat's menu
  opens the same list, and the terminal command's row offers it. A PC whose bridge cannot list
  sessions yet has no such item.
  ([#1494](https://github.com/devswha/herdr-web-ui/pull/1494))
- Agent rows show what herdr plugins report on a pane, such as the Quota plugin's usage left or a
  task's progress, in a small dim line under the row. They follow the `$name` tokens of your herdr
  `[ui.sidebar.agents]` rows (every token where none are set), change live, and say a long value
  whole in the tooltip and in a phone's ⋯ sheet. A line a plugin reports for the agent now updates
  as soon as herdr says it.
  ([#1341](https://github.com/devswha/herdr-web-ui/pull/1341))
- `HERDR_WEB_TAILSCALE_HTTPS_PORT` names the HTTPS port the installer publishes the app on with
  `tailscale serve`, so 443 can stay free for something else. Settings → Phone & devices suggests
  that port too. When another service already uses it, the installer stops and says so instead of
  taking another port, which would move the address an installed app opens.
  ([#1433](https://github.com/devswha/herdr-web-ui/pull/1433))

### Changed
- The chat's `/` menu lists the commands that run in the terminal apart, last, under Terminal
  commands, each with a Terminal badge, as the PC's command catalog describes them. Pick or type
  one and send it normally: once accepted, the pane's own terminal opens over the chat, in this
  browser only, while the chat stays where you were reading and the pane stays on Chat. A head
  says what ran, with Back to Chat and Keep Terminal; the header's Chat, Ctrl/Cmd+Shift+J and a
  phone's Back return too, and Escape goes to the agent. On a desktop the message box stays under
  the terminal, dimmed; on a phone the key bar takes its place. Claude Code's panels (`/config`,
  `/permissions`, `/theme` and the like) can bring the chat back by themselves when you close them,
  once Claude records it; other agents' recorded screens do once their input row is back, and the
  rest return by hand. A Ran in terminal row's
  Open Terminal shows the terminal over the chat again. Busy commands stay queued; only an
  explicit Send now opens the terminal, never automatic delivery. Refused sends keep their draft
  and note. Watch-only devices never send or open it, and /resume still opens Earlier sessions.
  Commands the agent's own menu hides are not listed, but still go when typed by hand.
  ([#1441](https://github.com/devswha/herdr-web-ui/pull/1441))
- For an OpenCode pane whose skills are `@` attachments, the `@` menu lists them under Skills
  before the files, and picking one inserts the skill's id.
  ([#1441](https://github.com/devswha/herdr-web-ui/pull/1441))
- Growing OMP and Claude Code tasks now parse appended transcript records incrementally, reducing
  repeated work when long chats refresh while preserving tool results, notices and history resets.
  Live parser state shares Codex's bounded cache; earlier responses stay unchanged as new records arrive.
  ([#1561](https://github.com/devswha/herdr-web-ui/pull/1561) by @Yoonwoo-Ha)
- The app is now called Ovis across the browser, install messages and documentation, matching
  the phone apps. Existing installs, settings, plugin identifiers and update channels stay the same.
  ([#1454](https://github.com/devswha/herdr-web-ui/pull/1454))
- A question card whose screen reads keep failing now says it may be out of date ("Not updated: the
  question on screen may have changed.") until a read answers again. Answering stays safe: the
  server reads the screen again first and refuses a changed question (#1335).
  ([#1360](https://github.com/devswha/herdr-web-ui/pull/1360) by @Noobear)
- The Earlier sessions dialog picks the agent from the same list as the New tab and New worktree
  dialogs, each agent with its icon and the chevron spaced as the app's other controls, instead of
  a plain select whose arrow sat at the far edge.
  ([#1573](https://github.com/devswha/herdr-web-ui/pull/1573))
- A finished agent opened in one browser is read in every browser of the same server: opening it
  on the phone clears its DONE dot on the desktop too, and the other way around.
  ([#1463](https://github.com/devswha/herdr-web-ui/pull/1463))
- Remove PC has a restrained red background and border before and after its confirmation step,
  retaining visible keyboard focus and the explicit second click to remove the registration.
  ([#1394](https://github.com/devswha/herdr-web-ui/pull/1394) by @snowykr)
- After a terminal command sent from Chat, Codex, omp, pi, gjc, OmO, Hermes (classic CLI), Devin,
  agy and Grok bring the chat back by themselves when you close the picker or panel it opened,
  once the agent's own empty input row is back on the screen. Only the commands each agent was
  recorded doing that for count (Codex's `/permissions`, omp's `/settings`, Grok's `/resume` and
  the like); print forms, toggles, editor handoffs, Codex's `/side` and `/btw`, OpenCode and
  anything unrecorded still return by hand.
  ([#1637](https://github.com/devswha/herdr-web-ui/pull/1637))

### Fixed
- The New session and History pickers show Hermes, Grok, Antigravity, Devin and Command Code by
  their own names instead of their lowercase ids.
  ([#1543](https://github.com/devswha/herdr-web-ui/pull/1543))
- The terminal attach process and its Node host no longer inherit the server's `HERDR_WEB_TOKEN`
  environment variable; they keep the socket path and the rest of their environment.
  ([#1562](https://github.com/devswha/herdr-web-ui/pull/1562))
- Choosing Jump to latest remembers bottom-follow before the virtual list scroll completes.
  Switching to Terminal immediately after that choice and returning to Chat no longer restores
  the older reading position. This fixes explicit Jump-to-latest intent, not arbitrary upward
  restoration on long, active or reasoning-heavy tabs.
  ([#1346](https://github.com/devswha/herdr-web-ui/pull/1346) by @Yoonwoo-Ha)
- Remember bottom-follow without measuring rendered rows or looking up a turn anchor; readers away
  from the end retain the existing paragraph-and-offset restoration.
  ([#1346](https://github.com/devswha/herdr-web-ui/pull/1346) by @Yoonwoo-Ha)
- Selecting and copying chat text now preserves the text as shown instead of adding Markdown
  syntax. Rich-text paste and the whole-answer MD and TXT copy actions remain available.
  ([#1409](https://github.com/devswha/herdr-web-ui/pull/1409))
- Chat no longer treats a command that leaves the agent waiting in a screen Chat cannot show as an
  ordinary send. Claude Code's `/usage`, `/cost`, `/status`, `/help`, `/memory`, `/mcp` and
  `/add-dir`, Codex's `/new` and `/fork` in a repository, `/cd`, `/usage`, `/copy` and `/side`,
  and the panels, pickers, confirmations and editors of omp, gjc, OmO, Hermes, Devin,
  Antigravity, OpenCode and Command Code are now Terminal commands: sent, they open Terminal with
  Back to Chat. A value typed with a picker command, such as `/fast off` or `/export notes.md`,
  stays an ordinary send.
  ([#1596](https://github.com/devswha/herdr-web-ui/pull/1596))
- A Claude Code skill or custom command named like a built-in command (`/compact`, say) is listed
  once in the composer's command menu, as the skill Claude runs, instead of beside the built-in.
  ([#1441](https://github.com/devswha/herdr-web-ui/pull/1441))
- Reconnects and unconfirmed sends can leave a bounded browser-side diagnostic trail on this
  server, without recording messages, credentials, addresses or terminal output.
  ([#1357](https://github.com/devswha/herdr-web-ui/pull/1357) by @christi4nity)
- The chat and the session history now apply one rule to Codex rollouts: a subagent's rollout (one
  naming a parent thread or an agent role), an exec run's, or one whose ids are null or contradict
  its file name is no longer read as a pane's conversation or offered to resume, while older
  rollouts without those fields still are. A rollout whose first line is longer than the chat or
  the history reads is left out instead of read unchecked.
  ([#1592](https://github.com/devswha/herdr-web-ui/pull/1592))
- Two Codex panes in one folder whose answers are short each show their own chat again with Codex
  0.163, which starts a thread in the same second as its process; before, both said the
  conversation was unavailable about as often as not.
  ([#1522](https://github.com/devswha/herdr-web-ui/pull/1522) by @jiaoew1991)
- A Codex pane with only short answers still finds its chat after another pane in the same folder
  runs `/new`: a thread that pane shows a long answer of under its first prompt, is bound to, or
  that herdr reports for it no longer leaves this pane unsure.
  ([#1522](https://github.com/devswha/herdr-web-ui/pull/1522) by @jiaoew1991)
- Of two Codex panes in one folder with short answers, the one started first finds its chat too
  once the other shows its own first exchange, where it said the conversation was unavailable.
  ([#1522](https://github.com/devswha/herdr-web-ui/pull/1522) by @jiaoew1991)
- On a phone, a composer notice's actions (such as the `/resume` notice's Earlier sessions, Open
  Terminal and Run in Terminal) wrap onto their own line, and its dismiss button stays visible
  instead of being cut off at the edge.
  ([#1543](https://github.com/devswha/herdr-web-ui/pull/1543))
- Wrapped and multiline message drafts are sized with an out-of-flow measurement field instead of
  collapsing the live input, preserving transcript spacing and the paragraph being read (#1337).
  ([#1347](https://github.com/devswha/herdr-web-ui/pull/1347) by @Yoonwoo-Ha)
- The measurement field shares the live input's Korean, Japanese and Chinese line-breaking rules,
  including Korean placeholder wrapping, so localized drafts keep their natural height.
  ([#1347](https://github.com/devswha/herdr-web-ui/pull/1347) by @Yoonwoo-Ha)
- Local Herdr timeouts, machine connection failures and recoveries, and abnormal WebSocket closes
  now leave timestamped, rate-limited diagnostic records without logging input or credentials.
  ([#1356](https://github.com/devswha/herdr-web-ui/pull/1356) by @christi4nity)
- The browser connection trace no longer re-posts a batch the server refuses with a 4xx status,
  resumes reporting after you sign in again on the same page, and malformed reports can no longer
  use up the server's shared report quota.
  ([#1423](https://github.com/devswha/herdr-web-ui/pull/1423))
- Pairing a device, renaming or revoking one, and the web push key and subscriptions are now
  flushed to disk before they replace the previous file, so a crash or power cut right after the
  change is much less likely to bring back a revoked device or make every phone subscribe to
  alerts again. How much survives a power cut still depends on the disk and filesystem honouring
  the flush; on Windows the folder itself is not flushed.
  ([#1568](https://github.com/devswha/herdr-web-ui/pull/1568))
- File search and path lookup no longer run a repository's fsmonitor hook, follow Git variables
  the server was started with, or wait on a Git listing that never ends: a listing past 16 MiB
  or 3 seconds, or one cut off mid-name, falls back to the folder walk.
  ([#1570](https://github.com/devswha/herdr-web-ui/pull/1570))
- **Files → Changes** no longer runs a program named `false` found on `PATH` with Git 2.35 or
  older, and reads the repository asked about even when the server was started with
  `GIT_COMMON_DIR` set.
  ([#1570](https://github.com/devswha/herdr-web-ui/pull/1570))
- Keep sidebar status updates responsive after many completed turns by caching read finishes and
  bounding their in-memory history instead of repeatedly scanning browser storage.
  ([#1536](https://github.com/devswha/herdr-web-ui/pull/1536))
- A first message from New workspace or New tab no longer waits forever when the agent started for
  it quits before the message goes: it is held for Send now or Discard. The same happens when an
  agent of the same kind that the user starts later comes up instead, and when the page that sent it
  leaves the pane while it is being typed, so the pane's other queued messages are not stuck behind it.
  On native Windows the PC sees only the pane's shell, so it cannot tell that the agent quit: there the
  message keeps waiting until you discard it.
  ([#1532](https://github.com/devswha/herdr-web-ui/pull/1532))
- GJC Chat hides internal agent-to-agent IRC messages and automatic replies, while keeping user
  messages that quote them visible.
  ([#1535](https://github.com/devswha/herdr-web-ui/pull/1535))
- GJC questions using the Nerd Font selection cursor now show their actual choices in chat
  instead of only Up, Down, Enter and Esc controls. Moving the cursor preserves the question's
  identity and uses the current selection when answering.
  ([#1553](https://github.com/devswha/herdr-web-ui/pull/1553) by @Kinetic27)
- GJC chats on a busy machine give cold session lookups up to five seconds per command and
  ten seconds overall instead of timing out after two seconds per command. Session snapshots
  retain the shorter status lookup budget; failed status lookups
  are held for 30 seconds without preventing chat reads from retrying.
  ([#1364](https://github.com/devswha/herdr-web-ui/pull/1364) by @sskys18)
- GJC chat and status reuse their verified session binding when other sessions write heartbeats,
  instead of restarting the SDK lookup for every pane. Session changes still require SDK validation.
  ([#1343](https://github.com/devswha/herdr-web-ui/pull/1343))
- Grok keeps Chat with older sessions open and uses Terminal when the session is uncertain.
  ([#1352](https://github.com/devswha/herdr-web-ui/pull/1352) by @infowolfe)
- One failed health check no longer shows herdr offline or switches a Windows PC's panes to the
  terminal lens: the header says Status unknown with the last herdr it saw, and herdr unavailable only
  after a second failure in a row.
  ([#1581](https://github.com/devswha/herdr-web-ui/pull/1581))
- A malformed, oversized or misaddressed answer from herdr now fails only the request it answers,
  with a clear error, instead of hanging until the timeout, growing the server's memory or being
  taken as another request's answer; event subscriptions report such a frame and close.
  ([#1584](https://github.com/devswha/herdr-web-ui/pull/1584))
- Hermes `/status` sent from Chat now shows its result card on the first send in a new pane too, even
  when the computer is busy. A send whose result was missed no longer leaves every later `/status` in
  that pane without a card for ten minutes. The same holds when another device has the terminal
  scrolled up.
  ([#1543](https://github.com/devswha/herdr-web-ui/pull/1543))
- Sending Hermes `/status` (or another informational command) from Chat again now shows that send's
  own result card each time, instead of "Runs in the terminal" once earlier identical results fill
  the terminal.
  ([#1543](https://github.com/devswha/herdr-web-ui/pull/1543))
- Slow API requests can return their result or timeout error instead of losing the HTTP connection
  while bounded Herdr calls are still running.
  ([#1355](https://github.com/devswha/herdr-web-ui/pull/1355) by @christi4nity)
- The app can be installed behind a reverse proxy that signs in every request (Authelia,
  oauth2-proxy and the like): the browser now sends its cookies with the manifest request.
  ([#1332](https://github.com/devswha/herdr-web-ui/pull/1332) by @ascandroli)
- Mouse wheel and phone swipes scroll terminal history on Windows and other mirrored panes;
  read-only connections still only pan their local grid.
  ([#1446](https://github.com/devswha/herdr-web-ui/pull/1446) by @Davesaggio)
- A Codex started in a terminal shows its model and reasoning level before the first message,
  from Codex's live footer, while the chat shows the terminal output.
  ([#1374](https://github.com/devswha/herdr-web-ui/pull/1374) by @evanwy0223)
- Before the first message, a model switched in the terminal shows in the message box once the
  supported agent draws it. omp still waits for its transcript to record the model; the bridge
  never runs `omp models`, which can refresh the CLI's OAuth credentials.
  ([#1374](https://github.com/devswha/herdr-web-ui/pull/1374) by @evanwy0223)
- A pane that runs OmO is now treated as OmO by the composer even while herdr labels it Claude
  (OmO's Claude child is running): sending a message no longer stops on a Claude input-box draft
  refusal or tries to clear a Claude draft there.
  ([#1441](https://github.com/devswha/herdr-web-ui/pull/1441))
- A multi-line message sent to an OmO pane that herdr has no agent label for is now pasted as one
  bracketed paste instead of line by line, so its first line is no longer sent alone.
  ([#1441](https://github.com/devswha/herdr-web-ui/pull/1441))
- An OmO pick list (an extension's select, such as the init-deep advisor's "Run now / Skip this
  time / Never…") shows in the chat as a card with its own options again, instead of a "Waiting for
  input" card offering only ↑, ↓, Enter and Esc. A pick list that counts down in its title keeps
  the same card while it ticks, so an answer tapped a second later is not refused as stale.
  ([#1495](https://github.com/devswha/herdr-web-ui/pull/1495) by @nahwan-kim)
- An omp pane started with an absolute `--cwd` shows its chat when herdr names no session file
  and the directory herdr reports is not omp's own, such as the shell's or a symlink's real path:
  the session is still looked up in the directory herdr reports first, then under that `--cwd`.
  ([#1594](https://github.com/devswha/herdr-web-ui/pull/1594))
- A message or command sent from the chat to an omp that is still starting no longer stays typed
  in its input box: omp shows the box before it takes an Enter, so the send waits until herdr's omp
  integration reports the session (omp does so once it takes input), for an omp started moments ago.
  ([#1475](https://github.com/devswha/herdr-web-ui/pull/1475))
- A new OpenCode 2 pane offers your project and user skills as `@` attachments before its first
  session starts, using the OpenCode version the PC's install reports, instead of listing them as
  OpenCode 1 `/` commands. Once the pane has a session, that session's version decides as before.
  ([#1543](https://github.com/devswha/herdr-web-ui/pull/1543))
- Native question answers stay bound to the current pane, session and form. Local service discovery
  rejects stale or non-loopback endpoints, bypasses environment proxies, and bounds slow requests.
  ([#1257](https://github.com/devswha/herdr-web-ui/pull/1257) by @bardiz12)
- Polling does not invalidate an unchanged question or turn an acknowledged answer into an error.
  A temporary service outage keeps an already displayed native card and its unsent edits.
  ([#1257](https://github.com/devswha/herdr-web-ui/pull/1257) by @bardiz12)
- Back and question tabs preserve unsent edits, and multiselect submissions include both checks
  and custom text. Abandoned drafts are bounded and expire after 30 minutes.
  ([#1257](https://github.com/devswha/herdr-web-ui/pull/1257) by @bardiz12)
- OpenCode question cards keep edits and allow immediate retries after a failed reply, and optional
  questions can be skipped. Unrelated service metadata no longer resets a form's progress.
  ([#1421](https://github.com/devswha/herdr-web-ui/pull/1421))
- Answers sent from the message box show the translated warning when OpenCode has not confirmed
  delivery. Native service connections accept only the loopback addresses 127.0.0.1 and [::1].
  ([#1421](https://github.com/devswha/herdr-web-ui/pull/1421))
- Subscription usage reads OpenCode 2's own credential store before the `auth.json` OpenCode 1
  wrote. OpenCode 2 keeps its provider sign-ins in `opencode.db` and leaves that file standing with
  the key it has since replaced, so the OpenCode card reported "Sign-in expired" for a CLI that was
  signed in and working. The store's active key answers first, and a store without one (signed out of
  OpenCode 2) shows no card; the file still answers beside OpenCode 1's store, or with none.
  ([#1329](https://github.com/devswha/herdr-web-ui/pull/1329) by @krish-kant)
- `GET /api/pane/read` takes `lines` only as plain decimal digits from 0 to 4294967295 and refuses
  any other value (blank, signed, fractional, exponent or too large) with 400 `invalid_lines`
  instead of passing it to herdr; a blank value is no longer read as zero. Every count herdr
  takes still goes through unchanged.
  ([#1571](https://github.com/devswha/herdr-web-ui/pull/1571))
- A pasted or dropped PNG, JPEG, GIF or WebP image is saved with the extension of what its bytes
  are, not the one its file name suggests, and a file that only claims to be one of those images
  is refused with its reason instead of being saved for the agent to read.
  ([#1599](https://github.com/devswha/herdr-web-ui/pull/1599))
- The phone header's Chat/Terminal switch keeps clear of the bar's top and bottom edges in both
  densities: its options take the density's segmented height, so its track is 34px tall in the 52px bar
  and 32px in the compact density's 46px bar, which it used to nearly touch.
  ([#1519](https://github.com/devswha/herdr-web-ui/pull/1519) by @adnankassem)
- On a phone, the header's Chat/Terminal switch centers its icons and no longer touches the header's
  bottom rule (in compact density it was as tall as the bar). The buttons still take a full
  44 px tap.
  ([#1367](https://github.com/devswha/herdr-web-ui/pull/1367) by @Noobear)
- A pi chat now shows its context ring for models pi lists in its commandcode cache or model
  store, not only for providers defined in `models.json`.
  ([#1391](https://github.com/devswha/herdr-web-ui/pull/1391) by @diegolhambi)
- Model and effort pickers no longer confirm a stale choice when the agent stops waiting for the
  answer during the final screen read.
  ([#1435](https://github.com/devswha/herdr-web-ui/pull/1435))
- A Portal that stops on its own after its address was up is started again once, on the same relay
  and address, and Settings → Phone & devices says Recovering… meanwhile; a second stop shows the
  error with Portal's output instead of leaving the address down without a word or restarting it
  again.
  ([#1587](https://github.com/devswha/herdr-web-ui/pull/1587))
- When the server cannot save a shared setting or pin, Settings now says the change is not on the
  server yet, that reloading or closing the page can undo it, and offers Retry. After three failed
  saves in a row the browser resends less often (after a minute, then up to every five minutes)
  until you press Retry or the connection reopens, and edits made meanwhile are kept. A late resend
  of a refused change no longer overwrites a newer value another device saved meanwhile, while a
  setting you pick again after the refusal still wins. While the connection is lost it waits for it
  to come back instead of resending, and a connection the browser gives up on (for example a proxy
  error while the server restarts) is opened again, so alerts and other devices' changes no longer
  stop arriving until a reload.
  ([#1595](https://github.com/devswha/herdr-web-ui/pull/1595))
- A damaged or unreadable shared preferences or read-finish file is no longer lost to the next
  change. Reading never touches it; the first change moves the damaged file, byte for byte, to
  `preferences.json.bad` or `seen.json.bad` (private to you, the latest damaged copy only), a file
  repaired by hand while the server runs is kept with the change added to it, and a file that
  cannot be read or set aside is not written over, so the change fails instead.
  ([#1564](https://github.com/devswha/herdr-web-ui/pull/1564))
- A server or remote bridge that crashed no longer blocks its restart when its old process number
  now belongs to another program: startup locks and the bridge registry record the owner's start
  identity, and that other program is never signalled.
  ([#1567](https://github.com/devswha/herdr-web-ui/pull/1567))
- Attaching to a terminal once again waits for input to be ready before signalling completion,
  preserving queued keys, clicks and text and the order of Stop followed by a message.
  ([#1342](https://github.com/devswha/herdr-web-ui/pull/1342))
- Opening a finished agent's terminal while its connection to herdr is being restored no longer
  clears its DONE dot from the screen left over from before: it clears once the terminal shows
  current output.
  ([#1472](https://github.com/devswha/herdr-web-ui/pull/1472))
- An oversized or unreadable answer from another PC's bridge is now refused at a fixed size
  instead of being held whole in memory: connecting, refreshing and the PC proxy stop reading it,
  report a short error in the user's language that repeats none of it, and a watching device
  never gets a prompt that could not be redacted.
  ([#1588](https://github.com/devswha/herdr-web-ui/pull/1588))
- Opening a pane in another tab or on a phone, or reconnecting, no longer copies again to the
  clipboard what a program in the pane copied before; its new copies still reach the clipboard.
  ([#1600](https://github.com/devswha/herdr-web-ui/pull/1600))
- Update and restart, and the header's Update, install exactly the release they offered: a release
  published in the meantime installs nothing and is shown to be checked first, and a server whose
  supervisor cannot install by revision asks for a restart instead of installing.
  ([#1590](https://github.com/devswha/herdr-web-ui/pull/1590))
- In macOS Safari, Backspace in a terminal no longer skips a press after deleting the last letter of
  a Korean syllable: 한 then four Backspaces now also deletes the character before it.
  ([#1363](https://github.com/devswha/herdr-web-ui/pull/1363))
- Chat shows only the current agent session's command results: after an agent restarts in the same
  pane, the earlier session's commands no longer appear. A `/clear`, `/new` or resume sent from Chat
  keeps its own row in the conversation it starts, without claiming that it finished. Commands sent
  before an agent's first reply stay with that agent while it keeps running, also through a moment
  in the background (Ctrl+Z on Linux and macOS); once a different agent takes over the pane, they
  are hidden, even if Chat was not open when it happened. A command sent to a restarted agent while
  the pane still shows the previous session stays once the agent's own session appears within a
  minute, unless Chat started another session after it. Within that minute, a session change typed
  in the terminal of an agent that resumed the same session can still keep such a command. Where
  Chat cannot find the agent's program at all (native Windows, or an agent started under another
  program name), such a command stays with the session that the same agent starts in the same
  terminal; a later session, another agent or terminal still hides it. Outside Linux, an agent
  restarted under the same process number cannot be told apart from the one before it.
  ([#1543](https://github.com/devswha/herdr-web-ui/pull/1543))
- SSH PC management controls now stay within narrow sidebars: the rename field and action buttons
  reflow in place, and long labels wrap without clipping.
  ([#1392](https://github.com/devswha/herdr-web-ui/pull/1392) by @snowykr)
- Opening a finished pane clears its DONE dot only after its answer or terminal output is
  actually visible. Covered panes, loading or failed chats, and terminal reconnections keep
  unread finishes marked.
  ([#1342](https://github.com/devswha/herdr-web-ui/pull/1342))
- Reading older chat keeps the finish unread. Jumping to the latest answer clears it only
  after the jump arrives; small scrolls above the end show the way back. Resizing and restoring
  a short chat work without an extra scroll.
  ([#1342](https://github.com/devswha/herdr-web-ui/pull/1342))
- An older answer cannot clear a newer finish. Agents whose chat cannot prove completion keep
  the dot conservatively; opening their Terminal view can acknowledge the output.
  ([#1342](https://github.com/devswha/herdr-web-ui/pull/1342))
- Read finishes stay read across pane switches and browser tabs on the same device. Every
  web-server restart or update brings read DONE dots back; read records are not carried across
  server restarts.
  ([#1342](https://github.com/devswha/herdr-web-ui/pull/1342))
- The sidebar's PC control buttons are the standard control height again, Rename shares the name
  field's row in a wide sidebar, Remove PC dims like its neighbours while a rename or disconnect
  runs, and danger buttons keep their red tint on hover everywhere in the app.
  ([#1422](https://github.com/devswha/herdr-web-ui/pull/1422))
- Documents opened through copied read links keep their own scroll area at desktop widths,
  rather than expanding beyond the window and leaving scrolling to the page.
  ([#1586](https://github.com/devswha/herdr-web-ui/pull/1586) by @Kinetic27)
- A Markdown table whose separator has a one- or two-dash cell (`|---|:-:|`) shows as a table in the
  chat, as on GitHub, instead of as its pipe-separated source.
  ([#1361](https://github.com/devswha/herdr-web-ui/pull/1361) by @Noobear)
- Going back to the chat while a terminal command's screen is still open (Claude Code's `/btw`
  answer, a picker left up) no longer lets the next message from the message box be typed into
  that screen and do nothing, for Claude Code and the agents above (not OpenCode): the composer
  says the command is still open in the terminal, with Show terminal, and Send (or a queued
  message's Send now) keeps the message until the screen closes or you choose Send anyway.
  ([#1637](https://github.com/devswha/herdr-web-ui/pull/1637))
- Opening the app no longer flashes the dark amber default before your saved theme: the saved light,
  dark or single-mode theme (Dracula on the light side stays dark), including System and older saved
  palettes, is drawn from the first frame, and the installed app's title bar color matches it at once.
  ([#1569](https://github.com/devswha/herdr-web-ui/pull/1569))
- Settings → Updates no longer tells you to switch to main when the server was started from an
  installed update's folder instead of its source checkout: it now says to restart the app from
  the source checkout, which is what lets updates run again.
  ([#1417](https://github.com/devswha/herdr-web-ui/pull/1417))
- Typing or composing text in a wide mirrored terminal no longer pulls the view sideways.
  Windows terminal wheel panning stays in place when output arrives, and tapping the terminal
  without scrolling no longer changes shared history.
  ([#1534](https://github.com/devswha/herdr-web-ui/pull/1534))
- Loading the page no longer sends about 33 requests per workspace folder to find its project icon:
  each folder is asked once (`GET /api/fs/favicon`), and a folder without an icon is an answer, not
  a 404. A reverse proxy with a rate limit no longer answers 429 to the burst, and the browser
  console no longer fills with red 404 lines on every load. A 429 is no longer remembered as "no
  icon" either: the folder is asked again when its row next appears.
  ([#1339](https://github.com/devswha/herdr-web-ui/pull/1339))
- A dragged workspace order no longer jumps back while its moves are still landing: a roster read
  before the move, a cached roster or another PC's update cannot undo it, and the first roster
  read after the move (another browser's later order included) replaces it. A remote PC does this
  once its bridge is updated to the next release; until then it keeps the earlier behaviour.
  ([#1593](https://github.com/devswha/herdr-web-ui/pull/1593))

### Maintenance
- Composer geometry regressions freeze the demo conversation while keeping it idle, so turn
  completion cannot change the transcript during measurements on phone and desktop.
  ([#1347](https://github.com/devswha/herdr-web-ui/pull/1347) by @Yoonwoo-Ha)
- Settings and PWA draft checks target the visible input explicitly; locale regressions cover
  native draft and placeholder heights on phone and desktop.
  ([#1347](https://github.com/devswha/herdr-web-ui/pull/1347) by @Yoonwoo-Ha)

## [0.4.12] - 2026-10-18

### Added
- Settings → Integrations → New agents picks the mode Claude Code (permission mode) and Codex
  (sandbox and approvals) start in from New workspace, New tab and New worktree. Agent default,
  the default, adds no flag, so the agent's own configuration still decides. The choice is shared
  by every device.
  ([#1303](https://github.com/devswha/herdr-web-ui/pull/1303))
- Agy panes now offer their commands and user, project, plugin and bundled skills in the slash
  menu, with origin groups, one-line descriptions and skill chips in user messages.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- Codex's command menu now includes shared and ancestor-project skills, system skills and enabled
  plugin skills, grouped by origin. It honors the pane's `CODEX_HOME` and disabled skill paths,
  offers saved prompts as `/prompts:name`, and inserts skills as `$name`.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- A Codex theme, light and dark, matching the Codex desktop app's default look: white or
  #181818 surfaces, Codex ink and its blue accent.
  ([#1267](https://github.com/devswha/herdr-web-ui/pull/1267))
- The message box's suggestions (commands, skills, files) have a close button, so a mouse or a phone
  can put them away as Escape does.
  ([#1312](https://github.com/devswha/herdr-web-ui/pull/1312))
- A question card can be folded to its title to read the conversation under it, and opened again;
  the question keeps waiting for its answer.
  ([#1312](https://github.com/devswha/herdr-web-ui/pull/1312))
- On a desktop with a mouse the selected tab shows its actions button (`⋯`) while the tab strip is
  hovered or the tab has keyboard focus, so Rename tab, Close tab and the open pane's actions are
  no longer only behind a right-click or the menu key.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Devin chat now lists local commands and skills with their source groups, imports enabled
  skills from other agents, and shows skill chips instead of expanded prompts in your messages.
  Cloud-only commands and skills, MCP prompts, and terminal-only pickers are excluded.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- GJC chat now lists its commands, user and project skills, and four bundled workflows with
  origin icons and one-line descriptions. Namespaced commands and skill calls keep their colons,
  and invoked skills appear as chips in user messages. Discovery honors the pane's agent directory
  and skill settings, including disabled user or untrusted project skills.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- A Grok pane's `/` menu now lists Grok's slash commands and the skills Grok loads for that pane:
  yours (`~/.grok/skills`, `~/.claude/skills`, `[skills] paths` in `config.toml`), this
  project's (`.grok/skills` and `.claude/skills` in the folder and the repository root, left out
  when `.gitignore` ignores them) and those of plugins. `$GROK_HOME` is honored, and typed
  `/name` skill names should show as chips in your messages. This is built from Grok's published
  README, not checked against a running Grok, which is not installed where this was written.
  Grok's built-in skills, which live inside its binary, are not listed.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- Dracula, Nord and Vesper are available on either theme side, with readable status and code colors.
  ([#1254](https://github.com/devswha/herdr-web-ui/pull/1254))
- Herdr's seven light/dark theme pairs now have CSS theme rows with readable text, agent
  states and code colors, plus upstream source and license attribution.
  ([#1254](https://github.com/devswha/herdr-web-ui/pull/1254))
- Settings → Appearance picks a dark theme and a light theme from every theme, as herdr does:
  picking one of a pair fills the other side with its sibling until that side is chosen by hand,
  and a dark theme chosen for light mode still draws dark.
  ([#1254](https://github.com/devswha/herdr-web-ui/pull/1254))
- Hermes chat now lists its CLI commands, trusted project and personal skills, installed bundled
  skills, skill bundles and quick commands, with origin groups and one-line descriptions.
  Plugin skills are not listed because their enabled state lives in Hermes' Python plugin manager.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- The hub connection form can show the management key while you type it, so a key typed with
  the wrong keyboard layout is visible before it is saved.
  ([#1264](https://github.com/devswha/herdr-web-ui/pull/1264))
- The installers open the app in your browser after a new install on a PC with a desktop, where
  the address bar's Install adds it. Over SSH they print the `ssh -L` tunnel to run instead, and
  `HERDR_WEB_NO_OPEN=1` turns the opening off.
  ([#1228](https://github.com/devswha/herdr-web-ui/pull/1228))
- herdrweb.dev shows Windows visitors the PowerShell install command and copies it.
  ([#1228](https://github.com/devswha/herdr-web-ui/pull/1228))
- The installed desktop app can fold Chrome's title bar away (the chevron next to the window
  controls): the header takes its place, drags the window and leaves room for the controls.
  ([#1228](https://github.com/devswha/herdr-web-ui/pull/1228))
- OmO's `/model` list shows in the chat as a card, as Claude Code's and Codex's do: pick a model
  and it is picked for the session, the model in use named on the card. It reads the list OmO
  draws, fullscreen or not, on a phone's narrow pane too.
  ([#942](https://github.com/devswha/herdr-web-ui/pull/942) by @Noobear)
- OmO's todo list now appears as plan progress in the sidebar and as steps in the plan panel.
  ([#1277](https://github.com/devswha/herdr-web-ui/pull/1277))
- In an OmO chat, `/` at the start of a message and `$` anywhere in it list OmO's commands and the
  skills it loads, and a skill named in the chat is drawn as a chip.
  ([#1217](https://github.com/devswha/herdr-web-ui/pull/1217))
- omp's chat menu lists its skills from native, plugin and compatible agent providers, with
  profile-aware settings, origin groups and inline `/skill:` completion. File commands and prompt
  templates respect command precedence; recorded skill invocations appear as user chips.
  Invocation-only extension and plugin roots cannot be recovered from on-disk settings.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- OpenCode chat now lists its commands and valid skills from user and project roots, with origin
  groups and one-line descriptions. Pane-specific config directories and external-skill switches
  are honored, and recorded skill expansions show the original invocation as a chip.
  Commands whose recorded screens cannot be represented in chat are omitted.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- The header's More menu opens with **Search panes and actions**, so a phone can reach the
  command palette by touch; on a desktop the item shows its shortcut.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The anonymous usage counts now include one message a day the app is opened in a browser, with
  the kinds of coding agents running in herdr (such as `claude` or `codex`), so the maintainer can
  count daily and monthly active installs. The usage notice is shown once more to explain it.
  ([#1215](https://github.com/devswha/herdr-web-ui/pull/1215))
- Add and manage subscription accounts from one provider picker in Settings, with official
  local CLI sign-in in a new terminal tab and CLIProxyAPI hub sign-in for Claude and Codex.
  All supported providers include installation or app sign-in guidance; single-home providers
  ask before replacing a discovered account.
  ([#1236](https://github.com/devswha/herdr-web-ui/pull/1236))
- Connect a hub to import its Claude and Codex plan limits, edit the connection or remove
  its saved key with confirmation. The management key stays on the server, OAuth tokens
  are never refreshed here, and disabling plan limits stops provider usage requests.
  ([#1236](https://github.com/devswha/herdr-web-ui/pull/1236))
- A web page this PC serves, such as an agent's dev server on localhost, can open in the panel
  beside the pane. Settings → File viewer → Web links chooses a new tab (the default) or the
  panel, and Shift-click opens a link the other way. A localhost address is reached under the
  host the browser used for the app, so it also works from another computer. Other sites keep
  opening in a new tab.
  ([#1302](https://github.com/devswha/herdr-web-ui/pull/1302))

### Changed
- Every agent's `/` menu (and Codex's `$`) now reads the way omo's does: each command's
  description is one short line with the whole text in its tooltip, skills stand under where they
  come from (yours, this project's, built in, from a plugin) with an icon for each, a namespaced
  name such as `/skill:x`, `/plugin:x` or `/prompts:x` keeps the menu open past its `:`, and the
  skill names in your own messages show as chips. A command's description is no longer cut at 120
  characters, and a multi-line one in a skill's frontmatter arrives whole.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- A question an agent asked earlier (omp's `ask`, OmO's `ask_user_question`, Claude Code's
  `AskUserQuestion`) opens in the chat as its questions and the options it offered, the recommended
  one marked, instead of the call's JSON. Found in #1250 by @CharleoYang.
  ([#1291](https://github.com/devswha/herdr-web-ui/pull/1291))
- The chat and the composer say one thing per situation. While the socket is down the composer's
  placeholder is the one word "Connecting…" or "Reconnecting…" and the chat draws no connecting line
  of its own. A file whose path has no room shows a warning glyph on its tile and one status line,
  "20,000-character limit · 41 over", with no second limit line under the card. A slow chat read
  shows a muted "Waiting for the PC…" while the chat retries on its own, and only repeated failure
  shows "The PC isn't responding" with Try again. A failed upload or read names the cause it knows
  ("Couldn't attach · PC disk is full") or offers Try again, with the advice and the server's own
  words behind Details. The held-input notice over the chat's input card is the held text with send
  and discard glyph controls, with no label.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- While an agent writes its answer, the chat follows it every second instead of every two seconds.
  ([#1281](https://github.com/devswha/herdr-web-ui/pull/1281))
- The chat's "Working…" before an agent's first tool runs now looks like the head of the work
  block that follows, drawn where that block opens, so the block takes its place without a jump.
  ([#1322](https://github.com/devswha/herdr-web-ui/pull/1322))
- A message from a Claude agent team's teammate shows in the chat as a card with the teammate's
  name and summary, its report on request, instead of a prompt bubble full of
  `<teammate-message>` tags. Found in #1250 by @CharleoYang.
  ([#1290](https://github.com/devswha/herdr-web-ui/pull/1290))
- The default theme is now Codex, dark and light, instead of Amber. A browser that saved its
  settings before keeps the theme it shows, Amber included; one that never changed a setting moves
  to Codex. Amber stays one pick away in Settings → Appearance. The installed app's title bar and
  splash take Codex's dark colors.
  ([#1318](https://github.com/devswha/herdr-web-ui/pull/1318))
- Codex's built-in commands now match its recorded palette, excluding screens the chat cannot
  represent. Project `.codex/skills` remains excluded because Codex loading it is unconfirmed;
  project skills come from `.agents/skills`.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- The online demo's sidebar is two repositories instead of six workspaces: checkout-api, with
  Claude Code and two worktrees running Codex and Claude Code, and cli-tools, with omp and two
  worktrees running pi and Hermes. The shell that replays `git log` and `bun test` is checkout-api's
  second tab.
  ([#1298](https://github.com/devswha/herdr-web-ui/pull/1298))
- Settings → Devices shows one red warning, not two, while nothing is paired and no token is
  set: the note on what pairing turns on is a plain hint now, and it tells someone whose proxy
  already signs people in to set `HERDR_WEB_TOKEN` and have the proxy send it. The guide's
  **Behind a reverse proxy** shows the Caddy and nginx lines. Who gets in is unchanged.
  ([#1242](https://github.com/devswha/herdr-web-ui/pull/1242))
- A file opened from the chat, terminal or Files list shows in the popup again on a wide window.
  Settings → Chat → File viewer → Open files → Beside the pane brings back the panel beside the
  pane for text and code; the viewer's header button still moves the file open now either way.
  ([#1324](https://github.com/devswha/herdr-web-ui/pull/1324))
- On a window 980px wide or more, text, code, Markdown and HTML opened from the chat, terminal or
  Files list show in a panel beside the pane, so the terminal stays usable. Media, PDFs, binaries
  and folders keep the popup. A header button moves a file between the panel and popup, keeping
  that choice across reload and Forward.
  Drag the panel's left edge to resize it (double-click resets); the width is remembered on this
  device. Phones keep the full-screen viewer.
  ([#1224](https://github.com/devswha/herdr-web-ui/pull/1224))
- Selecting another pane or PC closes a file opened from the previous one, beside the pane or in
  the popup, and Back returns to that pane without the file.
  ([#1224](https://github.com/devswha/herdr-web-ui/pull/1224))
- The header is quieter on a computer: Chat and Terminal are two words with no box around them,
  Files has its own button beside them (it leaves the More menu there), and with one PC its name
  is no longer repeated next to the title. On a phone the header buttons are bigger to tap.
  ([#1220](https://github.com/devswha/herdr-web-ui/pull/1220))
- CONTRIBUTING.md now takes a new theme only when herdr ships it as a built-in, written as a
  CSS theme block with reviewed overrides that pass AA. DESIGN.md and the guide describe the dark
  and light theme pickers.
  ([#1254](https://github.com/devswha/herdr-web-ui/pull/1254))
- The README's plugin-only install now names herdr 0.9.0+, Bun 1.4+ and Node 18+, and the guide's
  checkout install says herdr must be running first. The Windows installer now says to restart
  herdr after updating it.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- An omo pane's `/` and `$` menu shows each command's description as one short line, the whole
  text in its tooltip, and lists your own skills apart from the ones omo ships, each with its
  own icon.
  ([#1221](https://github.com/devswha/herdr-web-ui/pull/1221))
- On a phone the file viewer's header is one row, so the file keeps the screen: the name, Show
  source and Copy, a More menu with Open in a new tab, Open raw file and Download, then Close. The
  size and folder line is left out there unless it warns of a partial view.
  ([#1231](https://github.com/devswha/herdr-web-ui/pull/1231))
- A pi pane's `/` menu now lists the nested skills pi finds below its skills folder and the
  skills listed in its settings, groups them under "Your skills", and, once pi trusts the
  project, adds that project's `.pi/skills`, `.agents/skills` and `.pi/prompts`.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- Pinning a repository workspace now pins only that row. Its unpinned worktrees stay outside
  the pinned card in their original order, fixed in place until the repository is unpinned.
  ([#1243](https://github.com/devswha/herdr-web-ui/pull/1243))
- Pinned workspaces can be reordered within their card by dragging, long-pressing on touch
  screens, or pressing Alt+Up/Down. The shared pin order changes without changing herdr's
  workspace order or moving unpinned repository worktrees outside the card.
  ([#1243](https://github.com/devswha/herdr-web-ui/pull/1243))
- Settings → Phone & devices says less at rest: the Tailscale and paired-device explanations are one
  sentence with a Details fold, Keep screen on names its HTTPS condition only where it applies, and a
  device's Revoke is a neutral trash button until it asks to confirm.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The Add PC host-key question shows the fingerprint to compare and one sentence; ssh's own text
  waits behind Show SSH output, and the status box above it is gone.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- As in herdr's own sidebar, a top-level git workspace now shows its branch on a second line under
  its name, while indented worktrees and folders outside git stay one line. A repository without
  worktrees has its branch read too, so the strip under its message box names it as well.
  ([#1244](https://github.com/devswha/herdr-web-ui/pull/1244))
- A repository's worktrees hang from it on dim tree branches, as herdr draws them.
  ([#1244](https://github.com/devswha/herdr-web-ui/pull/1244))
- The plan meters show what is left of each plan's 5-hour session by default (a choice already
  saved is kept), fill the sidebar footer's row instead of stopping at four, and their tooltip
  names a limit near its end that a chip does not show.
  ([#1301](https://github.com/devswha/herdr-web-ui/pull/1301))
- Settings in the sidebar footer is its gear alone; its name stays in the tooltip and for screen
  readers.
  ([#1301](https://github.com/devswha/herdr-web-ui/pull/1301))
- The Pinned caption sits on the pinned card's top edge instead of above it.
  ([#1301](https://github.com/devswha/herdr-web-ui/pull/1301))
- A workspace row finds its project's icon in more places (`static/`, Next.js `app/icon.*`,
  Electron `build/icon.png`, `logo.svg`, `assets/logo.png` and others), all asked at once. On a
  repository row with worktrees, the folder opens and closes with the group, and a project icon
  turns into that folder under the pointer.
  ([#1301](https://github.com/devswha/herdr-web-ui/pull/1301))
- The sidebar's rows are one line by default (Settings → Appearance → Sidebar rows), and on One
  line an agent row is one line too, its place dim after its title. A browser that already saved
  its settings keeps the rows it had.
  ([#1223](https://github.com/devswha/herdr-web-ui/pull/1223))
- Pinned workspaces and agents no longer carry a pin after their name: the pinned card at the top
  of the list already says they are pinned.
  ([#1218](https://github.com/devswha/herdr-web-ui/pull/1218))
- The sidebar's pinned agents and pinned workspaces now sit under a small pin and "Pinned"
  caption, so the pinned card reads as pinned at a glance.
  ([#1276](https://github.com/devswha/herdr-web-ui/pull/1276))
- A pinned workspace is one line in its card, as an indented worktree is; its branch stays in
  the tooltip and the row menu.
  ([#1276](https://github.com/devswha/herdr-web-ui/pull/1276))
- Each half of a split view now has one row: its tabs, with the half's Chat/Terminal switch and
  close at the far end. The separate bar with the pane's title is gone. The free end of the row,
  past the tabs, drags the half's pane to a half, as the bar did.
  ([#1270](https://github.com/devswha/herdr-web-ui/pull/1270))
- The tab strip's **+** opens a shell tab at once in the workspace's folder, as herdr's own new tab
  does, with no dialog. A tab with an agent comes from the tab's menu (a right-click, or the `⋯` on
  touch screens): **New tab with agent…** opens the New tab dialog.
  ([#1232](https://github.com/devswha/herdr-web-ui/pull/1232))
- The terminal's notices say less. Input held while the connection was down comes back as one row,
  the command and two buttons, Send held input and Discard held input, with no sentence over it.
  View only is a plain pill with an eye glyph. An ended pane says "Terminal ended";
  input held for it stays until it is sent or discarded.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The SSH host-key prompt now says what trusting does before you trust.
  A file that cannot be previewed says to download it, and
  "Opening…" and the same-name file list are announced and translated.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Subscription accounts show their source, plan and sign-in status in provider groups,
  with existing ordering and visibility controls. Short setup copy is available in English,
  Korean, Japanese and Chinese.
  ([#1236](https://github.com/devswha/herdr-web-ui/pull/1236))

### Removed
- The message box no longer has a resize grip on its top edge: its height always follows the
  draft, and a height chosen with the grip before is no longer applied.
  ([#1273](https://github.com/devswha/herdr-web-ui/pull/1273))

### Fixed
- Screen readers now hear "Sending your answer…" when a prompt answer is on its way: the card's
  busy state sits on its options alone, no longer over the status line.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- "Loading PCs…" and "Loading agents…" in the sidebar are announced: each is a status box that
  is in the list before its words arrive.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Six Korean sentences no longer hang a 을(를)/은(는) particle on a name: closing a workspace,
  a PC that needs a bridge update, a file with no room in the message, a file that could not be
  attached, an expired sign-in and a font that is not monospace are worded around the name.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Screen readers now hear the chat's own waits: "Loading conversation…" and "Reconnecting…" at the
  end of the transcript are announced when they appear, as is a PC's state word when its notice or
  bridge update clears.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The terminal no longer shows "Waiting for terminal input…" while no pane is selected.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Screen readers now hear every status line the app can open with: "Connecting…", the header's
  connection word, a PC's state word, "Loading workspaces…" and "Waiting for terminal input…" are in
  the page before their words arrive, as "Sending your answer…" and the loading lines already were.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The chat no longer jumps for a frame when the message box grows a line while you read at the
  end of the conversation. Found, with its fix, in #1205 by @Yoonwoo-Ha.
  ([#1321](https://github.com/devswha/herdr-web-ui/pull/1321))
- The prompt card says "Sending your answer…" while an answer is on its way, and a refused answer
  or a failed chat read is told as a plain sentence with the PC's own words kept beneath it.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Typing `@` when the PC cannot list the folder's files now says "Couldn't load suggestions"
  instead of showing nothing, as if no file matched.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Screen readers hear when an attachment finishes ("photo.png attached") or fails, with the reason;
  the chat log is named by the pane's title instead of its id, and a picture a tool read is named
  by its number and the tool.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A failed attachment's note over the message box says in plain words why it failed, with the PC's
  own words kept beneath it, instead of `/api/pane/image failed (500): ...`.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- With reduced motion, the prompt card's options and question chips change colour without fading.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A long chat history no longer adds a button to the turn rail for every message loaded: once the
  rail is full, one tick stands for each run of turns, so the page stays light.
  ([#1289](https://github.com/devswha/herdr-web-ui/pull/1289))
- A file path in the chat named in Korean or any other non-Latin script opens in the file viewer,
  and so does a path in backticks with spaces in it (`~/My Docs/notes.md`). A particle written
  straight after a path (`docs/a.md를`) stays out of the link.
  ([#1271](https://github.com/devswha/herdr-web-ui/pull/1271))
- Chat now shows "Working…" while Claude Code or Codex works with nothing new in its transcript yet,
  such as the spinner right after a message, instead of staying silent until the first tool runs.
  ([#1307](https://github.com/devswha/herdr-web-ui/pull/1307))
- Korean interface text wraps between words instead of inside them, and Japanese and Chinese text no
  longer starts a line with closing punctuation or a small kana; code, paths and the terminal keep
  their own breaking. A dialog title or the empty chat's greeting that wraps now takes even lines.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A message sent from the chat to Claude Code with an editor connected is no longer refused as if its
  input box held a draft: Claude's `[⧉ … selected]` / `[⧉ In <file>]` pill there is not typed text,
  and Claude's suggested next prompt shows again beside it.
  ([#1285](https://github.com/devswha/herdr-web-ui/pull/1285))
- A Claude Code question that takes several choices offers "Or type your own answer", as
  its terminal does with "Type something": the card, or a message typed in the chat that is not
  option numbers, types it into that row and sends it.
  ([#1239](https://github.com/devswha/herdr-web-ui/pull/1239) by @sergiorademacher)
- Claude's menu follows its personal, ancestor-project, synced and enabled plugin skills,
  with origin groups, name precedence and linked-worktree fallback. Its command list follows
  Claude Code 2.1.301's recorded palette and omits screens the chat cannot represent.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- Explicit Claude skill invocations remain readable as skill chips instead of disappearing.
  Binary-compiled skills, session-only added directories, and skills in subfolders that Claude
  loads only after working there are not listed.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- A Claude Code teammate stopped with TaskStop, and any background command it left running, no
  longer stay listed as running in a pane's background tasks.
  ([#1319](https://github.com/devswha/herdr-web-ui/pull/1319))
- Chat finds short Codex replies when the terminal shows a completed-turn duration and time
  below the answer, including sessions started with profile launchers.
  ([#1248](https://github.com/devswha/herdr-web-ui/pull/1248) by @christso)
- Codex chat no longer shows image envelopes or local file paths beside pasted images.
  ([#1263](https://github.com/devswha/herdr-web-ui/pull/1263) reported by @zerodice0)
- Codex chat can read a short first exchange such as a greeting, including beside another Codex pane
  in the same directory when their visible exchanges identify different conversations.
  ([#1155](https://github.com/devswha/herdr-web-ui/pull/1155) by @christso)
- Threads created during Codex startup are checked against a precise Linux process-start bound;
  older tool-heavy transcripts no longer exhaust the short-conversation message budget.
  ([#1155](https://github.com/devswha/herdr-web-ui/pull/1155) by @christso)
- The header's connection chip, the chat's footer, the terminal's banner and the composer's offline
  sentence say "Connecting" until this page has connected to the PC once, and "Reconnecting" only after
  a connection dropped; before, every wait read as a reconnect, a fresh page's first one included.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The pre-connect shell's "Connecting…" line is translated like every other status line.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A damaged remote PC settings file is reported in the server log.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- A browser that gets in with a token its proxy sends in an `Authorization` header no longer
  offers **Sign out**, which cleared nothing: the proxy sent the token again with the next
  request. `/api/health` marks such a sign-in with `auth.bearer`.
  ([#1242](https://github.com/devswha/herdr-web-ui/pull/1242))
- Attaching a second file with the same name is announced to screen readers again, for a finished
  upload and for a failed one alike.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- When a new workspace opens but its agent does not start, the dialog now says so in the UI
  language and suggests checking the agent is installed, with the PC's own words kept beneath and
  Open still offered.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A chat that takes too long to load now says the PC took too long to answer, instead of
  "Something went wrong".
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A file named without its folders now opens, and shows in the file search, in a folder that
  also holds thousands of files (a downloaded data set): the lookup reads the whole git file list
  first, and the folder walk no longer lets one large folder use up its 5,000 entries.
  ([#1284](https://github.com/devswha/herdr-web-ui/pull/1284))
- A file popup opens with the keyboard focus on the file, not on its first button: Space plays a
  video or sound and scrolls a text, where it used to press **Show beside the pane** and move the
  file to the side panel.
  ([#1313](https://github.com/devswha/herdr-web-ui/pull/1313))
- In the installed app's window, the file viewer offers **Copy link** in place of **Open in a new
  tab** and **Open raw file**, which opened another app window there instead of a browser tab. A
  browser tab keeps both.
  ([#1313](https://github.com/devswha/herdr-web-ui/pull/1313))
- Files opened on one pane follows a switch to another pane while it is open (the Next pane and
  Previous pane shortcuts): it lists the new pane's folder instead of the folder it was opened on.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- A prompt card no longer disappears for two seconds when one read of the pane's prompt fails (a
  network error or a server hiccup): it stays until the next read says the menu is gone.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- A GJC pane's chat and status no longer start the gjc CLI on every refresh: the session found
  for the pane is kept until GJC's session index changes (a `/new` or `/resume` always writes
  it), the pane's gjc process changes, or half a minute passes.
  ([#1299](https://github.com/devswha/herdr-web-ui/pull/1299))
- GJC chat keeps the displayed conversation while a temporary SDK lookup failure is retried,
  instead of briefly replacing it with terminal fallback. Missing or changed sessions still
  undergo the same identity checks
  ([#1295](https://github.com/devswha/herdr-web-ui/pull/1295) by @Kinetic27).
- Grok chat on Linux follows any Grok executable named `grok` or `grok-…`, including builds
  newer than 1.0.50, when that process holds one `events.jsonl` for the session Herdr
  reported. macOS and Windows still show the terminal view.
  ([#1207](https://github.com/devswha/herdr-web-ui/pull/1207) by @infowolfe)
- While the terminal reconnects, the held input's clipped preview (`Input held: “…”`) answers the
  pointer again, so hovering it shows the whole command; before, the pointer fell through to the
  terminal and the preview's title never showed.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- In a narrow split on a desktop, the reconnecting notice with held input stays inside its pane and
  wraps, instead of running out of the pane's left edge with its first words cut off.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- An HTML page previewed from a chat link closes again with X, the scrim and Escape after it
  navigated inside its frame (a click on its table of contents, a script setting `location.hash`
  once it had loaded); until now the preview stayed open and later file links opened nothing.
  ([#1274](https://github.com/devswha/herdr-web-ui/pull/1274))
- Install app no longer shows inside an installed app's window, in any display mode, nor in a
  Chrome or Edge 140+ tab of an address whose app is installed.
  ([#1228](https://github.com/devswha/herdr-web-ui/pull/1228))
- On an iPhone or iPad, holding the keyboard's ⌫ in a terminal keeps deleting, as it does in any
  text field, instead of deleting one character and stopping.
  ([#1325](https://github.com/devswha/herdr-web-ui/pull/1325))
- Moving the cursor before the terminal's kept space on iPhone or iPad no longer drops typed
  Hangul or interferes with composition and held Backspace.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- On an iPhone, Korean typed with the on-screen keyboard in a terminal arrives as whole syllables
  (한글) instead of one jamo at a time (ㅎㅏㄴㄱㅡㄹ).
  ([#1327](https://github.com/devswha/herdr-web-ui/pull/1327))
- The terminal key bar fades the edge that hides more keys, so a phone shows when the row scrolls
  on, and every key with a symbol or abbreviated cap (Esc, ^C, ⌫, |, ~, /, Ctrl, the arrows and
  page keys) has a spoken name for screen readers, in every UI language.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- In Korean, the message box's and the terminal input line's placeholders keep each word whole
  ("넣지 않습니다" is no longer cut into "넣지 않 / 습니다" on a phone); what is typed into them, and
  code, break as before.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A pane opened in a second browser while another one already shows it now gets the whole screen:
  herdr is asked to draw it again, so what a busy program drew only once (btop's boxes, titles
  and column headers) no longer goes missing there.
  ([#1323](https://github.com/devswha/herdr-web-ui/pull/1323))
- ANSI terminal colours are now readable in every light theme, including yellow and bright colours.
  ([#1261](https://github.com/devswha/herdr-web-ui/pull/1261))
- A right-click in the chat composer, the terminal's input line, the find field or a password
  prompt's field opens the browser's own menu (Copy, Paste, spelling suggestions) on that field
  again instead of the pane menu, as does the keyboard's menu key while one of them is focused.
  A right-click on the pane itself still opens the pane menu.
  ([#1268](https://github.com/devswha/herdr-web-ui/pull/1268))
- When the app's server cannot reach herdr, the sidebar's connection error and the header's
  "herdr offline" pill now say what to do: start herdr on this PC, or check HERDR_SOCKET.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- A setting the server cannot save (its state folder is read-only) no longer fails silently:
  Settings shows a plain sentence with the next step, the server's own words behind Details, and
  the change is sent again once the folder can be written.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- OmO's bundled skills now appear in the chat command menu on Windows.
  ([#1229](https://github.com/devswha/herdr-web-ui/pull/1229))
- OmO panes show BG while a detached eval cell is still running or queued after the assistant
  ends its turn, rather than showing DONE before the background work finishes.
  ([#1275](https://github.com/devswha/herdr-web-ui/pull/1275))
- An OmO question asked while background tasks run shows its options card again, not a bare
  Enter and Esc card.
  ([#1226](https://github.com/devswha/herdr-web-ui/pull/1226))
- Mouse wheel and touch scrolling can read terminal history while OmO has a question open.
  ([#1278](https://github.com/devswha/herdr-web-ui/pull/1278))
- OMP question prompts remain available when a narrow terminal clips the navigation hint at the end of the footer.
  ([#1192](https://github.com/devswha/herdr-web-ui/pull/1192) by @christso)
- OMP chat finds the pane's transcript on Linux when Herdr reports its process without command-line
  arguments, including sessions in a named profile. Process-memory reads have a deadline and run
  outside the bridge so a stalled WSL process cannot freeze it.
  ([#1157](https://github.com/devswha/herdr-web-ui/pull/1157) by @christso)
- An Oh My Pi chat keeps showing its model after `/model` switches it, instead of losing the name
  until the next answer. Found in #1250 by @CharleoYang.
  ([#1283](https://github.com/devswha/herdr-web-ui/pull/1283))
- OMP question cards recognize current and clipped key hints, keep wrapped labels and descriptions
  with their choices, and support the final review step after multiple questions.
  ([#1184](https://github.com/devswha/herdr-web-ui/pull/1184) by @christso)
- A rendered HTML page plays its own videos and sounds too large to put into it (over 8 MB, or
  past the page's 32 MB) instead of showing an empty player: each plays from an address only that
  render hands out, for 30 minutes and only to the network address that opened the page.
  `HERDR_WEB_MEDIA_ROOTS` names folders, such as a network share, that a symlink beside the page
  may lead to for such a video
  ([#1188](https://github.com/devswha/herdr-web-ui/pull/1188) by @JensR93).
- A message queued for Claude Code is held for Send now when `/clear` or `/resume` switches that
  Claude to another session, also in a pane without herdr's hook, instead of going into the new
  conversation.
  ([#1310](https://github.com/devswha/herdr-web-ui/pull/1310))
- A held message whose Send now dropped before it left the browser now says it was not sent and
  keeps Send now, instead of "Not confirmed" with only Copy and Discard.
  ([#1308](https://github.com/devswha/herdr-web-ui/pull/1308))
- On a phone, a New worktree made with Shell opens its terminal: closing the sheet no longer sent
  the app back to the pane it was opened on before the new pane was listed.
  ([#1241](https://github.com/devswha/herdr-web-ui/pull/1241))
- On a phone, a downward stroke on an open agent list scrolls the list instead of pulling down the
  dialog under it.
  ([#1241](https://github.com/devswha/herdr-web-ui/pull/1241))
- Show Pi chat from sessions stored in the pane's own profile.
  ([#1194](https://github.com/devswha/herdr-web-ui/pull/1194) by @christso)
- A failure on the sign-in screen, in New workspace, in Find in terminal, in a pane layout change or
  rename, and in a workspace rename or reorder now says what happened and what to do next in the UI
  language, with the server's or browser's own words still shown beneath it to select and copy.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Submitting a pairing code that is not six digits now says so under the field instead of only
  moving focus back to it, and New workspace's Directory field shows an example path.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A `HERDR_SOCKET` set in the plugin's config is now used, so the plugin can show a named herdr
  session instead of always following herdr's own socket.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- Installing the herdr plugin on WSL no longer fails with `scripts/preflight.sh: 7: set: Illegal
  option -` when git there converts line endings (`core.autocrlf=true`): every text file is now
  checked out with LF.
  ([#1293](https://github.com/devswha/herdr-web-ui/pull/1293))
- `status` and `stop` run by hand (without herdr's environment) now find the server herdr started,
  in the plugin state dir herdr keeps (also on Windows), instead of reporting it down because an
  old checkout's stale pid file was looked at first. By @vibewriter-hand.
  ([#1210](https://github.com/devswha/herdr-web-ui/pull/1210))
- The card that asks before Claude Code or omp submits several answers now lists each question
  with its answer in plain text. It used to copy the terminal's lines into a mono box, so a
  question the pane had wrapped was cut mid-sentence.
  ([#1296](https://github.com/devswha/herdr-web-ui/pull/1296))
- The Agents list says "Loading agents…" while the PCs' panes are still coming in, instead of
  "No agents running".
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A link that waits for its PC says "Opening link…" in the header until it opens or says why it
  could not.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A folder listing in the command palette that fails to load now offers **Try again**.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The header's link notes and a failure's detail line are set in the interface face: Korean in the
  mono face had letter-wide spaces and a period set off from its word.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- On a phone, the terminal's reconnecting notice keeps held input on one line, cut with an ellipsis
  (the whole text in its title), instead of breaking a command inside a word; wrapped notice text
  starts at the left.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- On a touch screen the composer's plan chip stays a small pill and takes its 44px hit area through an
  invisible expander, instead of growing into a tinted badge.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- When file suggestions could not load, the composer now says what to do next: keep typing to try
  again.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Every field's placeholder takes the dim text colour (4.5:1 or better); the browser's grey was 3.8:1
  on a dark field.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Starting the server on a port that is taken now prints one plain line naming the address and what
  to do instead of a stack trace, and the log says once at startup when herdr cannot be reached or
  the state folder cannot be written.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))
- Settings switches draw their knob centred in the track, and an on switch takes it all the way to
  the end.
  ([#1282](https://github.com/devswha/herdr-web-ui/pull/1282))
- On a phone, a tab with a short name (such as 탭 1) is now as wide as a fingertip target, so a tap
  beside its name no longer lands on the strip or on its ⋯ button.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Screen readers now hear "Sending your answer…", the file viewer's "Opening…" and the header's
  "Opening link…": each status line is in the page before its words arrive, so the change is read.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The New workspace dialog's Directory field shows the end of a long path, where the folder's name
  is, when the path is set for you or the field is left.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Korean: the sentences for an agent that did not start, a tool's image and a provider's rate limit
  no longer hang a particle on the name ("이(가)").
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- In omp, gjc and Hermes chats, a skill call now shows as the skill's name instead of the
  skill's full instructions pasted into the conversation.
  ([#1245](https://github.com/devswha/herdr-web-ui/pull/1245))
- The empty status boxes that stay in the page for screen readers (the header's note, the
  terminal's wait for input) no longer reach into layout: the note's sentence has its own class, so
  the pane title alone carries the header title's, and the clipped wait region sits at the banner
  column's corner instead of widening the column by a pixel.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- With reduced motion on, Tab from the selected tab now reaches its actions button (`⋯`) on a
  desktop; without the fade's delay the button hid while the keyboard focus crossed to it, and the
  focus fell out of the tab strip.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The terminal's "Terminal ended", "Reconnecting to herdr web ui…", "Input held:" and view-only
  banners are translated into Korean, Japanese and Chinese, and wrap inside a narrow pane (a phone,
  or a split on a desktop) instead of running past its edge.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A two-finger pinch that changes the terminal's text size tells a screen reader the new size once,
  when the fingers lift; a cancelled pinch says nothing.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A failed file paste or prompt answer in the terminal says what went wrong in a plain sentence,
  with the server's or browser's own words after it.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Fullwidth punctuation (，。（）) no longer pushes the rest of its terminal row to the right in
  Chrome, so OmO's side panel stays in one column while the transcript beside it scrolls.
  ([#1300](https://github.com/devswha/herdr-web-ui/pull/1300))
- Dialogs take keyboard focus before their first paint, falling back when the preferred control
  is unavailable, so an immediate Escape closes the dialog instead of reaching the terminal.
  New workspace and New tab reset failed agent launches before reopening their fields.
  ([#1238](https://github.com/devswha/herdr-web-ui/pull/1238))
- A web address clicked in the terminal opens in a new tab again, not in a new browser window.
  ([#1234](https://github.com/devswha/herdr-web-ui/pull/1234))
- Switching panes no longer leaves two window listeners behind for each terminal it closes, so a
  tab kept open through many switches stops growing.
  ([#1288](https://github.com/devswha/herdr-web-ui/pull/1288))
- On a touch screen every control is now at least 44px in both directions: the header's buttons
  and lens switch, tabs, the key bar's keys, sidebar rows and their actions, palette and dialog
  rows, the composer's buttons and a message's copy buttons. With a mouse the chat's copy buttons
  and an attachment's X keep their size but take a 24px hit area.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- A browser connecting through a TLS-terminating Traefik proxy no longer stays on Reconnecting
  because its secure WebSocket upgrade was mistaken for a different origin.
  ([#1206](https://github.com/devswha/herdr-web-ui/pull/1206) by @philipprass-prog)
- A file whose name holds Korean, accented or similar letters stored in another Unicode form (as
  files from a Mac, a zip or a sync tool often are) now opens in the file viewer and shows up in
  file search, instead of failing with "no readable file at that path".
  ([#1219](https://github.com/devswha/herdr-web-ui/pull/1219))
- The updater now removes the temporary `tmp_pack_*` files a failed fetch leaves in the checkout,
  including the ones earlier versions left behind (any untouched for an hour is swept), and no
  longer retries a failed history (unshallow) fetch every 5 minutes. On Linux and macOS a fetch
  that runs out of time is ended with SIGTERM first, so that Git releases its lock files
  ([#1258](https://github.com/devswha/herdr-web-ui/pull/1258) by @mkitaev).
- A damaged or unreadable hub configuration no longer prevents the web UI from starting.
  The hub stays unconfigured, and the server logs the problem without exposing its saved key.
  ([#1236](https://github.com/devswha/herdr-web-ui/pull/1236))
- Failed local sign-in launches release an empty credential home so the same account name can be retried.
  ([#1236](https://github.com/devswha/herdr-web-ui/pull/1236))
- Closing account setup cancels a pending hub sign-in instead of leaving its session active.
  ([#1236](https://github.com/devswha/herdr-web-ui/pull/1236))
- A sign-in that finishes before the server's pane-event connection starts now completes in the UI
  and refreshes the available accounts instead of waiting indefinitely.
  ([#1320](https://github.com/devswha/herdr-web-ui/pull/1320))
- With a repository's main checkout open in more than one workspace, the sidebar now hangs each
  worktree under the nearest of them above it, instead of always under the first.
  ([#1262](https://github.com/devswha/herdr-web-ui/pull/1262))

### Maintenance
- One `useAnnouncedText` hook (`src/lib/`) carries the announced-status pattern that the header note,
  the file viewer and the two sidebars each copied; DESIGN.md names the pattern and where the prompt
  card's `aria-busy` lives.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The split-view, UI and chat browser checks find a pane's conversation inside that pane's frame
  instead of by its spoken name, which now carries the pane's title; the UI check also covers the
  desktop tab actions button appearing on hover and keyboard focus. DESIGN.md's tab strip section
  describes that button and the lone pane's actions in the tab's menu on a desktop.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- The browser checks that read the header's note select it by `.header-note`; `.context-title-text`
  is the pane title alone, which the mobile tabs check measures.
  ([#1246](https://github.com/devswha/herdr-web-ui/pull/1246))
- Theme colors now live only in the theme blocks of `src/styles.css`. `bun run generate:themes`
  writes the terminal colors, DESIGN.md's amber table, the `theme-color` tag and the web manifest
  colors from them, and fast checks fail when a copy is stale. Nothing changes on screen.
  ([#1253](https://github.com/devswha/herdr-web-ui/pull/1253))
- The remote-PC runtime is now version 31: every saved PC asks for **Update bridge…** once.
  ([#1330](https://github.com/devswha/herdr-web-ui/pull/1330))

## [0.4.11] - 2026-10-16

### Fixed
- `/effort` in a Claude Code chat shows its card again with Claude Code 2.1.301, whose slider
  describes the level between the level names and the hint.
  ([#1200](https://github.com/devswha/herdr-web-ui/pull/1200) by @sergiorademacher)
- Claude's plan card finds the session's plan file again, with **View plan**, when recent Claude Code
  versions write large request lines to the transcript after the line that names it.
  ([#1198](https://github.com/devswha/herdr-web-ui/pull/1198) by @sergiorademacher)
- Codex's folder trust prompt gets its card again when its hint ends with `esc quit` instead of
  `esc back`, as it does when Codex starts in a folder it has not seen.
  ([#1195](https://github.com/devswha/herdr-web-ui/pull/1195) by @vibewriter-hand)
- Terminal text a program colors for the other background stays readable: under a light theme,
  Claude Code's white question titles and reply bullets no longer vanish into the background. Other
  colors too faint for the theme are darkened or lightened just enough to read, such as yellow on a
  light palette.
  ([#1171](https://github.com/devswha/herdr-web-ui/pull/1171) by @todor-a)
- A connection that opens and drops again no longer retries every quarter second: retries back off
  until it has stayed open for 10 seconds. Returning to the page still retries immediately.
  ([#1183](https://github.com/devswha/herdr-web-ui/pull/1183) by @philipprass-prog)

### Maintenance
- The remote-PC runtime is now version 30: every saved PC asks for **Update bridge…** once.

## [0.4.10] - 2026-10-16

### Changed
- On a phone or tablet, the chip above the message box that holds the prompt Claude Code suggests
  next is off by default. **Settings → Chat → Composer → Suggestion chip** turns it back on; the
  suggestion still shows grey in the empty message box. With a keyboard, Tab takes it as before.
  ([#1185](https://github.com/devswha/herdr-web-ui/pull/1185))

### Maintenance
- The remote-PC runtime is now version 29: every saved PC asks for **Update bridge…** once.

## [0.4.9] - 2026-10-16

### Added
- Mod+Shift+PageUp/PageDown page the current chat transcript or the terminal's native history, one
  line overlapping between pages. When herdr reports no native history, they send plain page keys to
  the running program, which sets its own page length.
  ([#811](https://github.com/devswha/herdr-web-ui/pull/811) by @kratam)
- **Settings → Phone & devices → Portal** gives this PC a public HTTPS address through
  [Portal](https://github.com/gosuda/portal-tunnel), with no account and no domain of your own.
  With Portal v2.6.1 or later installed, **Start** runs it on a relay you enter, dropping any
  `Tailscale-User-Login` header a visitor sends; it starts only with `HERDR_WEB_TOKEN` set. The
  address and its QR code show on every signed-in device, any device that can type into your
  terminals can stop it, and an address left on comes back when the app restarts.
  ([#746](https://github.com/devswha/herdr-web-ui/pull/746) by @rabbitson87)
- **Two tabs side by side** on a desktop, from different workspaces or PCs: drag a tab down out
  of its strip, or a sidebar row over the pane area, and drop it on the left or right half. A guide
  shows the two halves as soon as the drag starts and keeps its side steady at the centre; Escape
  or a drop elsewhere leaves everything as it was. Each half draws its tab at herdr's own layout,
  with its own tab strip and a bar with its lens and a close, and a tab is never shown in both
  halves. A press in a half makes it the one the header, the palette and the shortcuts act on.
  The split is kept across a reload, and a narrower window shows the active half alone. Drag
  guide by @flam-ing. ([#861](https://github.com/devswha/herdr-web-ui/pull/861) by @Yoonwoo-Ha)
- The file viewer and Markdown reader page offer **Show source**, highlighted source with
  CSS-counter line numbers, and **Copy file**, which selects the source when copying is unavailable.
  **Settings → Chat → File viewer** controls line wrapping and Markdown width; previews inherit
  the chat's font and, in the viewer, the opening pane's chat width.
  ([#429](https://github.com/devswha/herdr-web-ui/pull/429) by @aNNdii)
- A line over the panes says when the server can be reached from the network with no access
  token set and no device paired, and what to do about it. Nothing about who is let in changes:
  pairing a device or setting a token is still the owner's call.
  ([#698](https://github.com/devswha/herdr-web-ui/pull/698) by @pt-act)
- **Shared settings and pins.** The browsers of one server, a PC's and a phone's, keep the same
  pinned agents and the same settings that do not depend on the device: theme and colors, language,
  the sidebar's rows, order, cards and pins, chat and usage-meter choices. A
  change shows on the other open pages at once. Each device keeps its own terminal and chat font
  sizes, key bar, shortcuts, density, alerts, microphone, the lens panes open in and the like. Opening a page never
  overwrites anything: a server that holds no shared settings yet takes them from the first change,
  and the browser that shares first brings its pins along. A page that lost its connection catches up
  when it is back. A watching device follows the shared settings and cannot change them for everyone. ([#854](https://github.com/devswha/herdr-web-ui/pull/854))
- **Settings → Appearance → Agent logos: Color | Mono.** Mono draws the logos without color:
  Claude's in the text color without its orange tile, the other logos with brand colors in grey,
  so a sidebar where nearly every agent is the same one is not a column of colored tiles. Color,
  today's look, stays the default. ([#850](https://github.com/devswha/herdr-web-ui/pull/850) by @phirschybar)
- File paths in a tool call's command and output, and in a code block with no language (a log
  an agent pasted), open in the file viewer like the paths in its prose: a line such as
  `/tmp/shot/t0.png (1600, 1000) -> (1255, 960)` opens the picture, from a phone or another PC
  as well, since the server reads the file. An HTML file now shows as its page, with a switch to
  its source: its own script runs in a sandbox with no origin, storage or network (not the web
  either), and the pictures, stylesheet and script it takes from its own folder are put into it,
  so an agent's report with its screenshots draws whole. Files outside that folder, hidden ones such as `.env`,
  and anything of another kind than the tag asks for are never put in.
  ([#691](https://github.com/devswha/herdr-web-ui/pull/691) by @MovieHolic-Plex)
- PCs saved in herdr appear automatically. Connect once per PC to enable automatic reconnection;
  installing or starting a bridge still needs separate approval. Changing the address, port or
  session clears both permissions and cached panes.
  ([#606](https://github.com/devswha/herdr-web-ui/pull/606) by @sobir-git)
- Typing `/` after whitespace in a chat message offers Claude Code and Codex skills at the caret,
  using `$name` for Codex. Whole-message commands remain at the start; pi skill commands remain
  there because pi only expands them at the start
  ([#982](https://github.com/devswha/herdr-web-ui/pull/982) by @demrom).
- The strip under the message box names the workspace's branch at its right end, beside the
  folder, for a repository that has a worktree open (the branches the sidebar already shows).
  ([#991](https://github.com/devswha/herdr-web-ui/pull/991))
- That strip marks a linked worktree as one, beside its folder's name.
  ([#991](https://github.com/devswha/herdr-web-ui/pull/991))
- A workspace or a worktree is pinned from its row menu (Pin workspace / Unpin workspace): it stands
  first in its PC's list, in a card, with a pin after its name; a pinned repository's workspace brings
  its worktrees. Pins are shared with the other browsers of the server, as the agents' are.
  ([#1137](https://github.com/devswha/herdr-web-ui/pull/1137))
- The in-app alert has a close button, so it can be put away without a flick or a wait.
  ([#1129](https://github.com/devswha/herdr-web-ui/pull/1129))
- Settings -> Appearance -> Status indicators can draw the sidebar's and tabs' agent state marks as
  herdr's TUI does, its Dots or Symbols in its default theme's colors, with ready and unknown drawn
  too. Classic, the marks so far, stays the default.
  ([#1135](https://github.com/devswha/herdr-web-ui/pull/1135))
- New workspace **Browse** has a **New folder** button: name a folder, press Enter, and it is made
  inside the folder shown and opened, so **Start** uses it.
  ([#1169](https://github.com/devswha/herdr-web-ui/pull/1169))
- Mod+Shift+E focuses the selected pane's message box or terminal input, so an iPad with an
  external keyboard needs no tap before typing. It can be reassigned or turned off in
  Settings → Shortcuts ([#822](https://github.com/devswha/herdr-web-ui/pull/822) by @kratam).
- Settings → Shortcuts records chords with their exact modifiers, not only Mod+Shift: `⌘+PageUp`,
  `Ctrl+K` or `⌘+⌥+F` are kept as pressed. Chords the browser, the OS or text editing keep are
  refused; a plain Ctrl or Alt chord, which shells and agents use, is saved only after Save anyway.
  ([#1151](https://github.com/devswha/herdr-web-ui/pull/1151) by @kratam)
- Record also takes Home, End and the punctuation keys. A punctuation key is read by its position,
  so accented letters such as Hungarian É or German Ö can be bound on any keyboard layout. The row's
  list is unchanged.
  ([#1151](https://github.com/devswha/herdr-web-ui/pull/1151) by @kratam)
- **New tab**, **Split pane right** and **Split pane down** can take a Mod+Shift shortcut in
  **Settings → Shortcuts**. They have no default key, and the command palette shows the chosen one.
  ([#940](https://github.com/devswha/herdr-web-ui/pull/940) by @sergiorademacher)
- The chat box says when a draft hits the 20 000-character cap, and how many characters of a paste
  were left out, instead of silently stopping.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The context ring's opened label has a Compact button that sends `/compact` in one tap, shown only
  for agents that list the command.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A **Quote in message** button appears after you select text in the terminal and adds the
  selection to that pane's chat draft, headed by the pane name and line range. It only fills the
  draft; nothing is sent.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Skill names an agent writes in an answer (`/name`, or `$name` for Codex) show as chips, matched
  against the pane's own skill list, and copy as the raw text.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The diff viewer's header gains **Copy path** (the repository-relative path, with no patch
  needed), and the viewer and the Changes list draw placeholder rows while they load so the layout
  holds.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The command palette finds Settings pages and actions by related words (try "theme" or "font"),
  opens the page directly, and lists matches found only through such words after title matches.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- File rows in the Files dialog's Browse and Changes lists and in the folder browser show a glyph
  for the file's kind (code, JSON, config, image, archive, lockfile, ...) and mark a `.git` folder,
  so a list can be scanned at a glance.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- With Theme set to System, **Settings → Appearance** picks separate Light and Dark palettes and
  switches between them with the OS.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- **Settings → Shortcuts** records a binding by pressing it (Escape cancels; reserved, unbindable
  and already-assigned chords are refused on the row), and a search field filters the shortcut
  list.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Long native conversations mount a window of rows while keeping selected and focused
  rows available. Reading position survives older messages and streaming; expanded work
  and fetched full outputs survive scrolling away.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- **Files → Changes** lists what changed in the repository a pane sits in: the working tree, the
  index, or two commits named by hand, one row per file with git's status letter, the path (a
  rename's old path too) and its added and removed lines. A row opens the file's diff from
  `@pierre/diffs` as a bounded window of rows, unified or side by side (Settings → File viewer →
  Diff layout; a phone shows one column and says so), with old and new line numbers, the context
  around each change folded to a line or shown whole, the file itself one tap away on the PC that
  holds it, and the patch copied as git printed it. Binary, too-large, conflicted and vanished
  changes, a folder outside git and a commit that does not exist each say what they are. Back,
  Escape and Close each close the diff alone and return the focus to its row; a remote PC's
  repository reads through its bridge; the demo answers from its fixture.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The file viewer opens a source file whole up to 8 MB and 200 000 lines (a Markdown file keeps
  its 256 KB Preview), and draws a source of more than 2 000 lines as a window of rows from
  `@pierre/diffs`, so a 120 000-line file scrolls with a few hundred rows in the page. Up to
  256 KB and 5 000 lines the rows are colored in the package's own worker; a longer source stays
  plain and says so. A line reference reveals its line against the mounted row, on a phone with
  wrapping too; a cut file says whether its bytes or its lines ended it; and Copy, without a
  clipboard, shows the whole source as a selected text box.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- File links with `:line[:column]` or `#Lline[-Lline]` open the source at the first
  requested line, including Markdown reader tabs. Lines outside the bounded preview
  are explained rather than silently opening at the top.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The command palette browses folders: type a path such as `~/` (or pick **Browse folders**) to walk
  the PC's folders, jump to the folder of a pinned agent or a recent folder, and open the one you
  reach in Files. The Files dialog has a button that opens the palette already browsing its current
  folder.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- In Settings, the Chat font and Terminal font fields can be picked from a searchable, previewed list of
  the fonts installed on this device in Chromium browsers, and the terminal refuses proportional
  fonts.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- **Settings → Appearance → Typography** sets the interface font size on this device, apart from the
  terminal's and the chat's own.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Coming back to a pane's chat puts you on the same turn and offset you left, or at the end if you
  were following it; the place is remembered per pane and PC for the life of the tab.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A conversation of four or more turns shows a rail of short dashes left of the chat, one per
  message you sent with the one in view marked; click a dash, or focus it and press Enter, to jump
  to that turn. It is hidden on a phone and wherever the chat column leaves no margin.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A terminal scrolled up into herdr's history now shows a round "Jump to bottom" button at the
  grid's bottom-right corner. Tapping it returns the pane to the live bottom without taking focus
  from the terminal or its on-screen keyboard.
  ([#1036](https://github.com/devswha/herdr-web-ui/pull/1036) by @m16khb)
- **Remote PCs from a Windows connection server**: the web UI running on Windows x64 now
  connects to other PCs with Windows' own OpenSSH and `ssh-agent`, including the machines saved
  in herdr. A key loaded with `ssh-add` signs without a prompt; otherwise the passphrase or
  password is asked once per connection. An unknown host's fingerprint is shown before anything
  authenticates, and a key path such as `C:\Users\you\.ssh\id_ed25519` is accepted. A host whose
  SSH config adds its own port forwards is refused on Windows, with that reason, and a host that
  asks for a password only through keyboard-interactive needs a key in `ssh-agent` there.
  ([#914](https://github.com/devswha/herdr-web-ui/pull/914) by @Galtozzy)

### Changed
- Install and update counts include app setting values such as theme, text size and notification
  choices, rather than only the names of changed appearance settings. Custom text and account
  identifiers stay out; custom choices use flags or counts. The expanded notice is shown again
  before sending, and existing opt-outs and install/update-only delivery stay unchanged.
  ([#866](https://github.com/devswha/herdr-web-ui/pull/866))
- Markdown file previews are parsed in a worker with a 2 s budget and a 60 000-element limit,
  keeping the existing HTML blocks, images and reader-page navigation. A preview that cannot
  be drawn offers its source. Partial text and preview, highlighting or line-number limits are
  reported beside the file size with a warning icon and tooltip. **Open in a new tab**,
  **Open raw file** and **Download** retain their existing destinations without a duplicate Raw action.
  ([#429](https://github.com/devswha/herdr-web-ui/pull/429) by @aNNdii)
- The sidebar's RUN mark is a working-colored dot that breathes, as T3 Code's does, instead of a
  spinning arc that read as flicker beside the rows: it holds full most of a 2-second cycle and
  dims to half in a few steps, and every running row breathes in step. BG is a still ring in the
  same color, so the two read apart without motion; it breathes under reduced motion too.
  ([#860](https://github.com/devswha/herdr-web-ui/pull/860))
- The agent list in New workspace, New tab and New worktree offers only the agents this app supports
  (the Supported agents table of the guide) and that PC has installed, instead of every agent herdr
  has a manifest for. Any other program still starts from a pane's shell.
  ([#994](https://github.com/devswha/herdr-web-ui/pull/994))
- An agent in the Agents list is pinned from its `⋯` menu or a right-click (Pin agent / Unpin
  agent) instead of a star beside it; pinned agents stand first in a card, each marked with a pin. Pins work
  without a setting, and pins saved before stay.
  ([#1120](https://github.com/devswha/herdr-web-ui/pull/1120))
- The header menu's Alerts row shows a check mark while alerts are on, so it reads as the switch it
  is instead of a link to Settings.
  ([#1000](https://github.com/devswha/herdr-web-ui/pull/1000))
- A file up to 32 MB can be attached in the composer (it was 8 MB).
  ([#1071](https://github.com/devswha/herdr-web-ui/pull/1071))
- The chat message box and a queued message's text now take a phone keyboard's autocorrect,
  suggestions and sentence capitals. The terminal input line keeps them off.
  ([#1111](https://github.com/devswha/herdr-web-ui/pull/1111))
- When a chat message is refused because Claude Code's input box in the terminal may not be empty,
  and no draft can be named, the note shows what the box holds and offers **Send anyway**, which
  sends that message once into the same Claude terminal.
  ([#1066](https://github.com/devswha/herdr-web-ui/pull/1066))
- A Codex pane's row and header show its thread's title alone. Codex adds the project folder
  after it ("Respond to greeting | my-worktree..."), which the row already says underneath.
  Alerts keep the whole title: they are read away from the row.
  ([#989](https://github.com/devswha/herdr-web-ui/pull/989))
- A phone no longer draws the folder and branch strip under the message box, which took room from
  the conversation; a desktop still shows it.
  ([#1127](https://github.com/devswha/herdr-web-ui/pull/1127))
- In a linked worktree the strip under the message box names the repository instead of the
  checkout folder, which only repeated the branch at its other end.
  ([#1033](https://github.com/devswha/herdr-web-ui/pull/1033))
- On a desktop, workspace, worktree and agent rows no longer show a `⋯` button: a right-click or the
  context-menu key opens the row's menu. Touch screens and narrow windows keep the `⋯`.
  ([#1137](https://github.com/devswha/herdr-web-ui/pull/1137))
- On a phone the key bar's keyboard button is now the input line's switch: it is lit while the
  input line is shown and unlit in direct typing (it used to be the other way round), and screen
  readers name it "Input line".
  ([#1175](https://github.com/devswha/herdr-web-ui/pull/1175))
- The app's first script is about 42 KB smaller (gzip): the chat timeline and its list library
  load as their own file beside it, instead of inside it.
  ([#977](https://github.com/devswha/herdr-web-ui/pull/977))
- An OmO pane whose turn ended while background tasks it started still run reads BG instead of
  DONE, as a Claude pane does, for as long as a task runs, and its finish is alerted once that
  work is over.
  ([#1138](https://github.com/devswha/herdr-web-ui/pull/1138))
- On a phone the terminal now starts in direct typing, like a desktop: keys go straight into the
  pane. The key bar's keyboard button, or Settings → Terminal → Terminal input mode, still switches
  to the input line, and that choice is remembered on the device. The setting now offers Direct
  typing and Input line; Automatic, which became the same as Direct typing, is gone.
  ([#1163](https://github.com/devswha/herdr-web-ui/pull/1163))
- On touch screens, Settings → Chat → Composer labels the existing Return choice as "Return inserts a new line" and explains sending with Send or a hardware keyboard. The default still sends with Return.
  ([#986](https://github.com/devswha/herdr-web-ui/pull/986) by @demrom)
- Sign out moved from the header and the command palette to Settings → Devices, and asks once
  before it signs this browser out, since getting back in takes the token or a pairing code.
  ([#1128](https://github.com/devswha/herdr-web-ui/pull/1128))
- The split view's halves are independent: a pick in the sidebar opens in the active half and never
  moves the focus to the other half or trades the halves, and both halves may show the same tab.
  An Agents row, a pane's title and a half's bar can be dragged to a half, as a workspace row or a
  tab already could.
  ([#1176](https://github.com/devswha/herdr-web-ui/pull/1176))
- App, site and demo builds run Vite 8 on Bun rather than the first Node on PATH,
  while type checking uses TypeScript 7. The terminal sidecar still supports Node 18,
  and the client keeps its previous browser syntax targets.
  ([#830](https://github.com/devswha/herdr-web-ui/pull/830) by @todor-a)
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The browser client uses React 19.3, with native inert handling for offline
  workspaces and nullable refs for the settings and tab controls.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Chat turn times now tell yesterday and older turns apart ("yesterday at 04:45 PM", "9/23 02:30
  PM") and show the full date and time on hover or focus.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Chat glides to new output while an agent works and you follow the end, instead of snapping to it;
  reduced motion keeps the instant scroll.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A Markdown image on a line of its own holds a 16:9 slot until it decodes and keeps it with an
  "Image unavailable" note if it cannot, so a document moves at most once per picture; chat
  thumbnails keep their box through loading and failure the same way.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A work block opens and folds at its measured height: the rows slide out from under the header and
  back, a row opened inside it grows it at the same pace, and the reader's scroll position holds
  through both; reduced motion snaps it.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The file browser shows folders relative to the pane's own directory (`herdr/src/components`)
  instead of from `~/`; folders outside it keep the `~/` form.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Keep the selected `/` command or `@` file completion highlighted in the composer when matching
  results refresh for the same query.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The phone keyboard viewport resyncs when the page becomes visible or is restored.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Composer attachments with an empty or generic browser MIME type infer their image preview and
  upload type from a PNG, JPEG, GIF or WebP filename extension.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Under the chat lens, connection and input notices (another app holding the pane, a failed output
  stream, input held for the terminal, a copy note) stand as rows over the input card instead of
  floating top-right, each dismissible with an X; a dismissed notice returns when it changes or
  recurs. A notice holding input typed while disconnected cannot be dismissed, so Send and Discard
  stay reachable.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- **Files → Changes** lists the changed files under their folders: a folder sits where its first
  file was listed with its file count, a lone chain of folders is one row, a tap folds a folder, and
  a button beside Refresh folds or opens them all.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Reopening a diff or a long file is faster: the syntax-highlight workers are shared across the app
  and stay warm for 30 s after the last viewer closes, and a theme switch no longer restarts them.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Workspace rows in the sidebar show the project's own favicon, when its folder has one, instead of
  the plain folder glyph.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Chat images open in a full-screen viewer with the message's other images a step away,
  pointer-anchored zoom and pan, and Copy image and Download actions, instead of a new tab.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Copying a chat selection keeps Markdown lists, code and image links, with sanitized rich HTML for
  pasting into documents; code-only selections stay plain code.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A slim strip tucked under the chat composer's card, as t3code's, can name the pane's working
  folder and branch.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A long user message folds to twelve lines behind **Show full message** (**Show less** folds it
  again), and keeps that choice while the chat scrolls.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A work row now says what the agent said the call is for (OmO's eval summary, the description
  Claude gives a Bash command or a subagent) instead of the tool id or the raw command, which stays
  in the opened row and its tooltip. Opening a tool's whole output keeps its work row in place.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Switching back to one of the last few tabs shows its terminal and chat at once instead of
  rebuilding them: their panes stay mounted while hidden, attached terminals let go of the pty,
  and attach again on return. Mirrored panes and the embedded demo keep their subscriptions.
  ([#1061](https://github.com/devswha/herdr-web-ui/pull/1061))
- A chat opened again draws the conversation it last read straight away and checks for news in
  the background, instead of showing "Loading conversation…" first, and it reads once per
  switch instead of twice.
  ([#1061](https://github.com/devswha/herdr-web-ui/pull/1061))
- Hidden chats, including split siblings on a phone, pause conversation watches and optional
  terminal-output reads until they are shown again.
  ([#1061](https://github.com/devswha/herdr-web-ui/pull/1061))
- Hide the network exposure notice and startup warning when the server binds only to a
  Tailscale address. LAN and wildcard binds still warn; access and authentication stay unchanged.
  ([#1124](https://github.com/devswha/herdr-web-ui/pull/1124))
- Anonymous usage counts now also report the light and dark palettes System mode switches between,
  the interface font size, the diff layout and whether the usage meters' accounts were ever
  reordered (a yes or no, never the accounts), and no longer report the settings removed in this
  release.
  ([#1105](https://github.com/devswha/herdr-web-ui/pull/1105))
- The line about anonymous install and update counts is one short sentence on one row. Its Turn off
  button is gone: What is sent opens Settings → About, where the switch is.
  ([#995](https://github.com/devswha/herdr-web-ui/pull/995))
- The pane header's `⋯` stays visible on touch screens and appears on keyboard focus on desktop;
  tab to it and press Enter, or right-click the pane with a mouse. Shift+F10 in the terminal
  stays with the terminal program.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- The tab's `⋯` on touch screens no longer lists New tab (the strip's `+` sits beside it).
  At widths that show one pane at a time, it omits Split right, Split down and Zoom pane, but
  keeps Unzoom pane so other panes remain reachable. Wider touch screens keep split and zoom.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))

### Removed
- Settings → Appearance no longer has Workspace cards, Pin agents or Quiet opened finishes. The
  Agents list is always flat, and a finished agent keeps herdr's DONE until herdr shows it.
  ([#1120](https://github.com/devswha/herdr-web-ui/pull/1120))
- The Turkish UI language and the Turkish README. A browser set to Turkish now shows English, and
  a device that chose Turkish in Settings goes back to following the browser.
  ([#1081](https://github.com/devswha/herdr-web-ui/pull/1081))
- The terminal no longer draws a history scrollbar beside the grid, on desktop or phone, and the
  grid takes the column it reserved. Wheel, touch drag, Mod+Shift+PageUp/PageDown and Find still
  scroll herdr's history.
  ([#1113](https://github.com/devswha/herdr-web-ui/pull/1113))
- The Dark report, Lilac and Forest color palettes. Settings that chose one of them now open in
  Amber; Amber, Charcoal and Catppuccin remain.
  ([#1078](https://github.com/devswha/herdr-web-ui/pull/1078))
- **Move pane to…** in the header's More menu, and `POST /api/pane/move` behind it. Move a pane
  in herdr's TUI; the app follows the roster as before.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- **Send right-clicks to pane** in the pane menu: a right-click on a pane always opens its menu.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- **New tab** in the header's More menu: the tab strip's `+` and the command palette open one.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- **Command palette** in a phone's More menu and **Browse folders in the palette** in its Files
  dialog. The command palette and its plugin actions are not available in the phone touch UI;
  use a wider screen or an external keyboard's Mod+Shift+K shortcut.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- Four more settings: Page overlap (one line stays between pages), Files at once (one paste, pick
  or drop takes up to 100 files), Highlight code (always on) and PageUp / PageDown scroll chat
  (plain page keys now always scroll the chat transcript, also while typing; in the terminal they
  still go to the running program).
  ([#1104](https://github.com/devswha/herdr-web-ui/pull/1104))
- Five settings, each now fixed at what most devices already used: Show pace for the plan meters
  (off), the Suggestion chip switch (always shown), Fit 80 columns in a split pane (always on), and
  the terminal's Cursor shape and Blinking cursor (a blinking block). A program in a pane can still
  change its cursor.
  ([#1099](https://github.com/devswha/herdr-web-ui/pull/1099))

### Fixed
- Open terminals reconnect automatically after herdr restarts or updates, without switching
  panes or reloading the browser, and clear the stale terminal-ended notice.
- First-device pairing waits for the browser to return its device cookie before restricting
  access. A proxy that drops the cookie no longer locks out an otherwise open installation;
  Settings reports the failed pairing instead. Already restricted installations stay restricted.
  ([#915](https://github.com/devswha/herdr-web-ui/pull/915))
- A message another Claude Code session sends into a pane (its `peer` messages) shows in the chat as
  a folded **Message from another session: {name}** that opens its own turn, instead of being skipped so the work it
  started was appended to the answer before it.
  ([#870](https://github.com/devswha/herdr-web-ui/pull/870) by @Noobear)
- Attached files upload three at a time instead of one after another, and each file's `@path` goes
  to the start of the message in the order the files were picked, once a `/command` being typed or
  an IME composition is finished. It used to go where the caret
  was, so a path that arrived while you typed landed in the middle of your words and moved the caret.
  ([#864](https://github.com/devswha/herdr-web-ui/pull/864) by @demrom)
- A Pi conversation whose session file has grown past 64 MiB reads as a conversation again, where
  the chat fell back to the terminal's text (`branch_unreadable`): the reader no longer refuses a
  long active branch as a whole, and pages it the way it pages a short one, within the same budgets.
  ([#869](https://github.com/devswha/herdr-web-ui/pull/869) by @Noobear)
- One paste, pick or drop attaches up to 100 files instead of silently keeping the first four, and
  the message box says how many it left out.
  ([#863](https://github.com/devswha/herdr-web-ui/pull/863) by @demrom)
- Web UI SSH connections no longer open extra tunnels configured in the account’s SSH config.
  ([#606](https://github.com/devswha/herdr-web-ui/pull/606) by @sobir-git)
- **Send now** on a working Codex pane sends the message at once. Codex kept it until its next
  tool call; once Codex shows that very message waiting, Send now presses Escape, which Codex
  itself offers to interrupt the turn and send it. An ordinary Send and the automatic next-turn
  delivery never interrupt Codex.
  ([#783](https://github.com/devswha/herdr-web-ui/pull/783) by @kilhyeonjun)
- On Windows, a pane that runs a launcher which starts OmO as its child is recognized as OmO. herdr
  names only the launcher there, so the bridge now also looks for OmO below the pane's shell in the
  PC's process table, so its chat and session are found. Only processes below that pane's own
  shell count. ([#886](https://github.com/devswha/herdr-web-ui/pull/886) by @willowite)
- The **agent picker** in the New workspace and New worktree dialogs no longer closes when an
  unrelated element scrolls, such as a text field scrolling its own text. It closes when the
  window resizes or when something that holds it scrolls. Moving through a long list with the
  arrow keys scrolls only the list, so the dialog no longer moves and closes the picker.
  ([#1010](https://github.com/devswha/herdr-web-ui/pull/1010),
  [#889](https://github.com/devswha/herdr-web-ui/pull/889) by @willowite)
- Android Chrome's soft keyboard no longer resizes the shared terminal when it also shrinks the
  layout viewport and the large viewport ruler.
  ([#1087](https://github.com/devswha/herdr-web-ui/pull/1087))
- A pane another web bridge holds no longer unlocks its input for a moment and shows the "held"
  notice twice when a busy herdr writes its refusal a little after the attach's teardown.
  ([#979](https://github.com/devswha/herdr-web-ui/pull/979))
- A terminal whose herdr the server cannot start (not on the server's PATH, or `HERDR_WEB_HERDR_BIN`
  naming no executable) now says so and the server logs it, instead of waiting for input forever.
  ([#1012](https://github.com/devswha/herdr-web-ui/pull/1012))
- With herdr 0.9.4 or later, opening a terminal on a second device no longer types stray
  characters such as `1016;2$y1;2c` into the pane, and a terminal is no longer reported ready
  before its attach has settled: the app answers herdr's attach-time terminal queries itself
  instead of replaying them to every browser.
  ([#1165](https://github.com/devswha/herdr-web-ui/pull/1165))
- A file picked in the browser over the attachment limit is refused with the size message
  before it is uploaded, rather than ending in a blank 413 the browser cannot explain.
  ([#1071](https://github.com/devswha/herdr-web-ui/pull/1071))
- Shared authentication failure bookkeeping stays bounded as forwarded client addresses rotate.
  ([#1059](https://github.com/devswha/herdr-web-ui/pull/1059))
- Chat no longer leaves a growing blank space under the last message, which could stay until the
  chat was reopened: the list's brief end padding was never removed on screens where it fell between
  pixels.
  ([#1030](https://github.com/devswha/herdr-web-ui/pull/1030))
- PageUp in the chat view no longer snaps back to the latest message when it is pressed right
  after the view resized or new output arrived: a follow-the-end scroll still waiting in the
  message list is dropped when the reader pages away.
  ([#985](https://github.com/devswha/herdr-web-ui/pull/985))
- Chat and conversation history reads no longer lose their HTTP connection after ten seconds while the bridge is still waiting for valid herdr replies.
  ([#1023](https://github.com/devswha/herdr-web-ui/pull/1023) by @demrom)
- Selecting text in a chat reply keeps inline file paths on the clipboard, including code links on touch screens.
  ([#1077](https://github.com/devswha/herdr-web-ui/pull/1077) by @demrom)
- Chat Send no longer does nothing when tapped on a phone while the keyboard is still composing
  the last word or syllable (Gboard, Korean, Japanese and Chinese keyboards): the tap finishes the
  word and sends the message, and says "Finish the word, then send." when the keyboard does not
  commit it.
  ([#1142](https://github.com/devswha/herdr-web-ui/pull/1142))
- A chat message sent to an OmO pane while it works is no longer refused as "Claude Code's input box
  is not empty": the input box under OmO's status rule (`── • Running …`) is read again.
  ([#1066](https://github.com/devswha/herdr-web-ui/pull/1066))
- **Send in the chat keeps the keyboard up on a phone.** Pressing it used to take focus from the
  message box, which closed the keyboard and moved the button before the tap landed, so the message
  was not sent. ([#937](https://github.com/devswha/herdr-web-ui/pull/937) by @lunchyfox)
- Keep completed Claude replies in separate chat messages when background notifications or hooks resume the agent without a new user prompt.
  ([#1024](https://github.com/devswha/herdr-web-ui/pull/1024) by @demrom)
- Chat sends to Claude Code started with `NO_COLOR` are no longer refused because its empty-prompt
  tip (`Try "…"`) was read as text typed in the terminal, and "Clear it and send" no longer fails
  on it.
  ([#1014](https://github.com/devswha/herdr-web-ui/pull/1014))
- Claude's plan card shows the whole plan, not only the part that fits the pane: the text comes
  from Claude's plan file (`<config dir>/plans/<slug>.md`), and **View plan** opens that file in the
  file viewer as Markdown. A session without a plan file shows the screen's text, as before.
  ([#855](https://github.com/devswha/herdr-web-ui/pull/855) by @sergiorademacher)
- Chat no longer stays empty after `/resume` of a Claude Code session that runs in the background:
  it follows the job the command names to that job's own transcript.
  ([#1057](https://github.com/devswha/herdr-web-ui/pull/1057))
- Claude's "Review your answers" screen after a multi-question ask gets its Submit/Cancel card again in a
  named session and when the review is taller than the pane, so answers given in the chat can be sent.
  ([#1133](https://github.com/devswha/herdr-web-ui/pull/1133) by @willowite)
- A file link a Claude Code pane names relative to its own scratch folder (`scratchpad/draft.md`)
  now opens: when the pane's folder has no such file, the viewer looks in that Claude session's
  temp folder.
  ([#1134](https://github.com/devswha/herdr-web-ui/pull/1134))
- Chat shows the progress messages a recent Claude Code prints between its tool calls. Claude Code
  records them as thinking, so they were hidden unless Show thinking was on.
  ([#1029](https://github.com/devswha/herdr-web-ui/pull/1029))
- The Close workspace confirmation reads "1 pane closes with it, and the agent in it stops." for a
  workspace with one pane, and counts one worktree workspace in the singular too.
  ([#998](https://github.com/devswha/herdr-web-ui/pull/998))
- A closed workspace leaves the sidebar as soon as herdr closes it, about half a second sooner:
  its panes send no exit, so browsers used to learn of it only after the next roster refresh.
  Removing a worktree does the same. ([#1017](https://github.com/devswha/herdr-web-ui/pull/1017), [#944](https://github.com/devswha/herdr-web-ui/pull/944) by @todor-a)
- Codex Chat recognizes short first answers and prompts preceded by model, command, or
  working-directory notices while retaining exact prompt and conversation ownership checks.
  ([#1075](https://github.com/devswha/herdr-web-ui/pull/1075))
- A file whose `@path` has no room in a message near 20,000 characters says so: its tile reads
  "No room" and the status line says how many characters to remove. Removing that file lets the
  files picked after it in. Within 200 characters of the limit the status line counts what is left.
  ([#872](https://github.com/devswha/herdr-web-ui/pull/872) by @demrom)
- Chat Send now shows a progress ring while the pane acknowledges the message, keeping the draft visible until it is accepted.
  ([#1025](https://github.com/devswha/herdr-web-ui/pull/1025) by @demrom)
- The Send action keeps its accessible name while busy; its description reports that the message is sending.
  ([#1025](https://github.com/devswha/herdr-web-ui/pull/1025) by @demrom)
- Keep a typed chat draft stable when agent prompt suggestions and streaming status metadata update.
  ([#1056](https://github.com/devswha/herdr-web-ui/pull/1056) by @demrom)
- On a desktop, a password prompt in the terminal no longer blocks typing into the grid: the
  password goes straight to the program, as in any terminal, while the masked input stays as an
  option for a phone. Offline, or while input is held for review, a password keystroke is refused
  with a note instead of being kept in a draft.
  ([#1067](https://github.com/devswha/herdr-web-ui/pull/1067))
- On a phone, switching between Chat and Terminal from the header closes the workspace list, so it
  no longer stays open over the view just picked.
  ([#999](https://github.com/devswha/herdr-web-ui/pull/999))
- On a phone, Escape now closes the open workspace list instead of typing `^[` into the terminal
  behind it or doing nothing.
  ([#1013](https://github.com/devswha/herdr-web-ui/pull/1013))
- An agent started from New workspace, New tab or New worktree opens its chat on the greeting over
  the message box. Codex, Claude Code, OpenCode, gjc and Grok write no session before the first
  message, so their chat said "Conversation unavailable" until then. A worktree's agent also opens
  in the same lens a new workspace's does.
  ([#990](https://github.com/devswha/herdr-web-ui/pull/990))
- The message box of a chat not begun names the model, read from the agent's own start screen:
  Claude Code's model, and the model and reasoning effort of Codex and gjc. It was blank until the
  first message wrote a transcript.
  ([#990](https://github.com/devswha/herdr-web-ui/pull/990))
- An agent started from the app reads READY until its first turn. Codex drawing its start screen
  read as working and then DONE, on a pane nobody had asked anything of.
  ([#990](https://github.com/devswha/herdr-web-ui/pull/990))
- Several devices or polls reading one GJC chat at the same moment now share a single lookup
  instead of each starting the GJC CLI (about 0.7 s apiece).
  ([#1058](https://github.com/devswha/herdr-web-ui/pull/1058))
- A Gajae Code pane's status now comes from gjc's own session transcript instead of what herdr
  reports for the pane, which could keep a finished turn at RUN for work a provider child was
  still doing — and a turn gjc ran while the child was quiet never read RUN or sent a done
  alert. A turn that ended in an error or was aborted reads READY rather than DONE, a
  background job's result that wakes the agent reads RUN, and a pane whose transcript cannot
  be told keeps herdr's status.
  ([#928](https://github.com/devswha/herdr-web-ui/pull/928) by @Haeminway1)
- Gajae Code question cards no longer refuse an answer as stale when the transcript or status
  above the question dialog redraws. The dialog's question, details and choices still have to match
  before the answer is confirmed.
  ([#1020](https://github.com/devswha/herdr-web-ui/pull/1020),
  [#997](https://github.com/devswha/herdr-web-ui/pull/997) by @yuseongkim-inbl)
- GJC chat identifies its session through GJC's SDK broker instead of matching terminal
  answers or session titles. Copied output from another session can no longer select that
  session's conversation. This requires GJC 0.18.9 or later for its broker-bound SDK
  session CLI; an older GJC, or an unavailable or ambiguous SDK identity, uses Terminal instead.
  ([#912](https://github.com/devswha/herdr-web-ui/pull/912))
- Input held while the terminal is not ready now follows the Backspace key, so text erased with it
  is not sent, and erasing all of it clears the notice. An Enter between typed text or a multi-line
  paste keeps its text with a space where the line break was, and the held-input notice says the
  break was left out instead of dropping the paste in silence; Send still never presses Enter. A
  paste with other control characters is told as left out, the notice no longer blames length for
  it, and neither an Enter with nothing held nor a Shift+Enter leaves a notice.
  ([#956](https://github.com/devswha/herdr-web-ui/pull/956))
- A chat message to Hermes no longer joins text already typed into Hermes' input in the terminal,
  where the paste and its Enter sent both as one message. As with Claude Code, a send or a held
  message's delivery is refused while that input holds anything but Hermes' own hint, and the chat
  says so ([#1149](https://github.com/devswha/herdr-web-ui/pull/1149),
  [#859](https://github.com/devswha/herdr-web-ui/pull/859) by @RikiSanjayaa).
- **Stop** in a Hermes pane's chat interrupts the running turn: it sends Hermes one Ctrl+C, the key
  Hermes interrupts with, instead of an Escape Hermes ignores. It does so only while Hermes' own input
  row shows a running turn, and once per turn, since Ctrl+C quits an idle Hermes and a second one
  force-quits it ([#856](https://github.com/devswha/herdr-web-ui/issues/856),
  [#859](https://github.com/devswha/herdr-web-ui/pull/859) by @RikiSanjayaa). Text typed into Hermes' input
  that quotes its busy hint is not taken for a running turn.
  ([#1148](https://github.com/devswha/herdr-web-ui/pull/1148), [#1161](https://github.com/devswha/herdr-web-ui/pull/1161))
- The terminal's input line no longer resizes the pane while it grows to more rows, shows a note
  or collapses after Send: it now floats over the terminal's last rows, and so does the masked
  password input, so the pane keeps its size for every device on it. In a short pane both stop at
  the terminal's top and scroll, and switching lenses keeps what was typed in the masked input.
  ([#966](https://github.com/devswha/herdr-web-ui/pull/966))
- A bridge install that was cut off mid-upload no longer blocks later updates with "Another
  installation is in progress": a stale `install.lock` is reclaimed, and the upload is bounded
  ([#895](https://github.com/devswha/herdr-web-ui/pull/895) by @suho-han).
- The Windows installer assigns `gh` to a job before allowing a shim to start a child that keeps
  its output open: the job ends with the call, and its output pipes are closed. If Windows refuses
  job assignment, the existing launcher-based cleanup remains, without guaranteeing orphan cleanup.
  ([#1073](https://github.com/devswha/herdr-web-ui/pull/1073))
- Korean typed on an iPad with a hardware keyboard (Magic Keyboard) reaches the terminal as whole
  syllables again. iPadOS Safari sent each jamo as its own key, so 한 arrived as ㅎㅏㄴ; the
  terminal now lets the iPad compose the syllable and sends it once, before the next key.
  ([#938](https://github.com/devswha/herdr-web-ui/pull/938) by @Noobear)
- The syllable being typed in the terminal is drawn at the size of the ones already typed. On Apple
  devices the terminal enlarges Hangul to fill its two cells, but the box that shows the pending
  syllable kept the plain size, so the last syllable looked smaller until it was committed.
  ([#938](https://github.com/devswha/herdr-web-ui/pull/938) by @Noobear)
- A visible desktop terminal keeps its grid when its window loses focus, so returning to
  Chat on a phone restores the desktop width without requiring another click or refocus.
  ([#1095](https://github.com/devswha/herdr-web-ui/pull/1095))
- On a phone, the key bar no longer goes grey while a word is still being typed in the input line:
  Esc, ^C, the arrows and Ctrl/Alt/Shift work mid-word with Gboard or a Korean or Japanese keyboard.
  Only the switch to direct typing waits until the word is finished.
  ([#962](https://github.com/devswha/herdr-web-ui/pull/962))
- The terminal's key bar no longer sits against the pane's left edge, and on an iPad or phone only
  the bar at the bottom of the screen keeps room for the home indicator: a pane stacked over
  another one no longer has empty space under its keys.
  ([#943](https://github.com/devswha/herdr-web-ui/pull/943) by @Noobear)
- A workspace or tab with two panes opens again on the pane you last looked at in this browser,
  also after the page reloads (a phone that dropped the app in the background, or an update),
  instead of the pane herdr's own window has in front.
  ([#1150](https://github.com/devswha/herdr-web-ui/pull/1150))
- A phone on a weak mobile link that opens a busy pane another tab already shows is no longer cut
  off with "Terminal output stopped because this device could not keep up." while it is still
  receiving the pane's recent output, and it no longer freezes that pane's output in the other tab
  meanwhile. A device is now stopped when it has acknowledged nothing for 2 seconds (longer while
  a large chunk of output is still on its way to it), or has held the pane's output paused for 10
  seconds. A quiet split pane is no longer frozen or cut off because the pane next to it is busy.
  A device joining a busy pane now gets its last 128 KiB of output instead of 256 KiB.
  ([#960](https://github.com/devswha/herdr-web-ui/pull/960))
- Ctrl+Enter in a mirrored terminal (Windows, or a PC without Node for the terminal sidecar)
  reaches Claude Code as its "send now" again instead of a plain Enter, and `bun run test:ui`
  checks it there instead of stopping at that check.
  ([#1064](https://github.com/devswha/herdr-web-ui/pull/1064))
- A password sent to a mirrored terminal is no longer submitted after the sender leaves the pane
  or switches to view-only mode; the typed characters are erased before reporting the refusal.
  ([#1065](https://github.com/devswha/herdr-web-ui/pull/1065))
- Mirrored terminals refuse passwords containing non-ASCII characters before typing anything,
  so cancellation can erase every accepted character on Windows as well. Attached terminals
  continue to accept Unicode passwords.
  ([#1065](https://github.com/devswha/herdr-web-ui/pull/1065))
- New workspace **Start** uses the folder Browse is showing, even when **Use this folder** was
  not pressed.
  ([#1169](https://github.com/devswha/herdr-web-ui/pull/1169), carrying [#1164](https://github.com/devswha/herdr-web-ui/pull/1164) by @aisensiy)
- Dragging down in a chat too short to scroll no longer reloads the app on Android Chrome before
  144; the page itself no longer starts pull-to-refresh.
  ([#953](https://github.com/devswha/herdr-web-ui/pull/953))
- Tapping an alert no longer brings forward a Markdown reader, a raw file tab or another shipped
  file the browser has open: the app window takes the pane, or the app opens on it.
  ([#958](https://github.com/devswha/herdr-web-ui/pull/958))
- An alert, a reload or a new window naming a PC removed since now opens this PC with "That
  link's PC is not set up here" instead of an empty pane. An alert for a PC set up elsewhere since
  the tab last looked waits for a fresh list of PCs instead of being dropped.
  ([#958](https://github.com/devswha/herdr-web-ui/pull/958))
- An alert for a pane that has closed (a terminal ended) opens the workspace it was in and says so
  in the header, as a link to it does, also when the phone delivers the tap twice.
  ([#958](https://github.com/devswha/herdr-web-ui/pull/958))
- An OmO question asked without waiting for its answer shows as its question card in the chat
  again, instead of a "Waiting for input" card with the terminal's text and Enter/Esc. OmO 5.1.30
  draws its running tasks under the input box, and on a narrow pane wraps the question's hint over
  two lines; either made the question unreadable. Waiting forms with tasks under the box are read too.
  ([#883](https://github.com/devswha/herdr-web-ui/pull/883))
- OmO background task counts, task lists and workflow lists now find OmO 5.x records stored
  outside the project, instead of appearing empty. Existing in-project records still work.
  ([#1138](https://github.com/devswha/herdr-web-ui/pull/1138))
- An OmO session started by a launcher that does not look like OmO (its own `OMO_CODING_AGENT_DIR`
  store, an arbitrary command name) now binds its chat only to the native session its live process
  verifiably holds in its own store. A newer file in another pane's store no longer takes its
  place, conflicting holds read as no session instead of guessing, and the chat follows the held
  session through /new and /resume.
  ([#923](https://github.com/devswha/herdr-web-ui/pull/923) by @Haeminway1)
- A terminal opened, reloaded, or reconnected in a background window watches its pane without
  acquiring an attach that could change the pane's size. Returning to the window attaches normally;
  queued messages, mirrored panes, embedded pages, and older bridges keep their existing behavior.
  ([#1130](https://github.com/devswha/herdr-web-ui/pull/1130))
- Sending a held message from two browser tabs no longer submits it twice. Its unconfirmed mark
  survives other tabs refreshing or disconnecting, and unreadable storage refuses a resend.
  After a confirmed no-input refusal, Send now starts a new attempt instead of replaying the refusal.
  ([#1088](https://github.com/devswha/herdr-web-ui/pull/1088))
- A chat message queued for the next turn is no longer delivered after the tab has gone to another
  address: a page the browser kept for Back still held its connection, so the message went out
  while the page shown said it was not confirmed. Leaving a page now ends its connection.
  ([#1005](https://github.com/devswha/herdr-web-ui/pull/1005))
- Queued chat messages are held for review when another agent process replaces their target in
  the same terminal, including agents without a native session reference.
  ([#1069](https://github.com/devswha/herdr-web-ui/pull/1069))
- A phone showing a pane's terminal no longer types into a grid another device sized: a tap into
  the input line, its Send or Enter, and a key-bar tap take the pane back to the phone's size
  before anything is sent, as a tap on the grid already did.
  ([#964](https://github.com/devswha/herdr-web-ui/pull/964))
- On a phone, opening or closing the soft keyboard no longer resizes the shared terminal: the grid
  keeps its size and the view pans so the prompt stays above the keyboard, and every other viewer
  of the pane, herdr's own window included, keeps its layout. A rotation or a pinch still refits.
  ([#1072](https://github.com/devswha/herdr-web-ui/pull/1072))
- The guide's and INSTALL.md's pairing and status commands now find the plugin with herdr 0.9.4
  and later, which moved plugin checkouts.
  ([#1136](https://github.com/devswha/herdr-web-ui/pull/1136))
- A retired push subscription is still refused after the server restarts, so Turn alerts on again
  makes a new one instead of registering the dead endpoint.
  ([#1079](https://github.com/devswha/herdr-web-ui/pull/1079))
- Turn alerts on again now makes a new push subscription when the push service retired the old
  one, instead of registering the dead endpoint again; Settings says the subscription was retired.
  ([#1060](https://github.com/devswha/herdr-web-ui/pull/1060))
- Chat messages queued for the next turn keep their original pane connection across tab and
  workspace switches and deliver once when that pane is ready. Reloads and lost connections still
  require manual recovery.
  ([#987](https://github.com/devswha/herdr-web-ui/pull/987) by @demrom)
- A phone put away while its pane stayed attached (a queued message, a mirrored pane) no longer
  comes back to a dead "Terminal output stopped" notice: when the page is in use again, the pane
  attaches again by itself, once. A stop while the page stays in use still waits for you, and the
  notice's Reconnect button now attaches again in place instead of reloading the page.
  ([#968](https://github.com/devswha/herdr-web-ui/pull/968))
- A pane on another PC no longer stops after a short network stall on a phone: the relay now stops
  output only when 256 KiB stays queued for 2 s, the same rule as this PC, instead of on any queued byte.
  ([#952](https://github.com/devswha/herdr-web-ui/pull/952))
- A terminal returning from a phone's Chat view gives its grid back only to a device still
  showing that terminal, never to a hidden pane or a tab left in the background.
  ([#1085](https://github.com/devswha/herdr-web-ui/pull/1085))
- A phone that goes back from the terminal to Chat no longer leaves a desktop showing the same pane
  at the phone's width: the terminal goes back to the desktop's size at once.
  ([#1068](https://github.com/devswha/herdr-web-ui/pull/1068))
- When the source checkout a managed server runs from is replaced under it (`herdr plugin install`
  run again, or `git pull` and a build), the app now tells you to restart herdr web ui on the PC
  instead of showing "App updated" and **Reload app**, which never went away because a reload
  loaded the same build again. The notice shows on the page's next status read, links to the
  restart commands, and goes away once the server restarts.
  ([#1146](https://github.com/devswha/herdr-web-ui/pull/1146) by @m16khb)
- A render error no longer leaves a blank page: the app shows what happened with Reload app and
  Copy details, which an installed home-screen app needs since it has no reload button. An error in
  the sidebar, a pane or Settings now stays there with its own notice, and the rest keeps working.
  ([#961](https://github.com/devswha/herdr-web-ui/pull/961))
- A long diff drawn without colors (too long to highlight, or highlighting off) no longer redraws
  every one of its lines on each scroll: it builds only the rows in view, as long files already
  do, so each scroll step of a 10 000-line diff blocks the page about half as long.
  ([#974](https://github.com/devswha/herdr-web-ui/pull/974))
- Back no longer reopens a closed Settings when another history entry (a typed `#hash`, another
  script's) was added while it was open: Back steps over the Settings entries left beneath it.
  ([#1015](https://github.com/devswha/herdr-web-ui/pull/1015))
- A reload on a file preview opened over Settings (a link naming both) now closes Settings and
  keeps the file open.
  ([#1015](https://github.com/devswha/herdr-web-ui/pull/1015))
- On a phone, a sheet opened right after another one closed (before the browser had stepped back
  off the closed sheet's history entry) no longer closes at once.
  ([#980](https://github.com/devswha/herdr-web-ui/pull/980))
- Keep the sidebar visible when herdr omits the branch field for a detached worktree.
  ([#1156](https://github.com/devswha/herdr-web-ui/pull/1156) by @christso)
- Moving a worktree or workspace down in the sidebar (drag or Alt+Down) now lands where it was
  dropped instead of doing nothing, and a repository's workspace moves together with its worktrees.
  ([#1125](https://github.com/devswha/herdr-web-ui/pull/1125))
- A click on the top right corner of a lone pane's terminal reaches the program there again, such
  as the close of Claude Code's diff panel: the pane's hidden ellipsis no longer takes it.
  ([#1160](https://github.com/devswha/herdr-web-ui/pull/1160) by @bricks-8)
- A pane dragged from the sidebar onto the pane area opens in a half even when the terminal or
  chat under the pointer redraws just before the drop; Chrome refused that drop before.
  ([#984](https://github.com/devswha/herdr-web-ui/pull/984))
- A tab left open across an update no longer stores the app's page under a script's address:
  a file the server no longer has answers 404, the offline cache is kept per build instead of
  growing with every release (typefaces and icons stay cached across updates, and an update
  keeps the files the new page starts with and the new build's math and diagram files the old
  worker had cached), and math or a diagram that failed to load, including a single diagram
  type, brings up a "Reload app" line at once, in a Markdown file opened in its own tab too.
  ([#957](https://github.com/devswha/herdr-web-ui/pull/957))
- A message sent right after Stop in the chat composer no longer reaches the agent before the
  Stop on a busy PC, and typing in the terminal keeps its order.
  ([#1112](https://github.com/devswha/herdr-web-ui/pull/1112))
- The chat command picker now includes symlinked skills and custom commands, skipping broken links and command directory cycles.
  ([#981](https://github.com/devswha/herdr-web-ui/pull/981) by @demrom)
- The diagram viewer's toolbar keeps clear of a notch or rounded corner on a phone held sideways.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A long Markdown file opens its Preview in parts, so the page no longer stalls for about a second on a slow machine while it draws.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Tailscale login headers forwarded by another local proxy no longer grant owner access unless
  the forwarded address is a single tailnet address. Header-free, serve-only owner access is preserved.
  ([#1062](https://github.com/devswha/herdr-web-ui/pull/1062))
- The terminal input line turns off the phone keyboard's autocorrect and spell-check, as the
  composer does, so a flag, path or branch name is no longer swapped for a dictionary word before
  Send.
  ([#965](https://github.com/devswha/herdr-web-ui/pull/965))
- Holding ⌫, Del, Home, End, PgUp or PgDn in the touch key bar repeats it until release, as a held
  arrow already did, instead of sending one key. Esc, Tab, Enter and ^C still send once.
  ([#965](https://github.com/devswha/herdr-web-ui/pull/965))
- The terminal input line's Send no longer does nothing when tapped while the keyboard is still
  composing the last word (Gboard, Korean, Japanese and Chinese keyboards): the tap finishes the word
  and sends the line, and says "Finish the word, then send." when the keyboard still does not commit it.
  ([#959](https://github.com/devswha/herdr-web-ui/pull/959))
- On Android, dragging a text selection on a pane no longer opens the pane's menu when the finger
  lifts; Copy and the phone's own selection menu stay in front.
  ([#1159](https://github.com/devswha/herdr-web-ui/pull/1159))
- Dragging the terminal on a phone now scrolls by how far the finger travels: a quick swipe goes as
  far as a slow drag over the same distance, one scroll step per three rows of travel, and a short
  flick of at least half a step still scrolls once when the finger lifts.
  ([#963](https://github.com/devswha/herdr-web-ui/pull/963))
- Chat turn times follow the day change: a turn shown as today's time reads "yesterday at …" after
  local midnight without reopening the chat, from one shared timer that re-renders only the times.
  ([#973](https://github.com/devswha/herdr-web-ui/pull/973))
- A terminal pane left open and quiet no longer asks herdr for its scroll position every second:
  the scrollbar's poll backs off to every 15 seconds and speeds up again on output, scrolling,
  resizing or returning to the tab. A view scrolled up into history keeps its 1 second read, since
  herdr holds that view still while new output grows the history below it, and a failed read
  still retries after 1 second. Each drawn frame also no longer measures the page layout unless a search has highlights to place, which saves battery on phones.
  ([#955](https://github.com/devswha/herdr-web-ui/pull/955))
- On Windows, a failed write to a helper process that already closed its input no longer ends the
  server.
  ([#971](https://github.com/devswha/herdr-web-ui/pull/971) by @Noobear)
- On Windows, OmO is offered when creating a workspace or a tab, as gjc already was.
  ([#885](https://github.com/devswha/herdr-web-ui/pull/885) by @willowite)
- Stopping the Windows plugin waits until its original process tree has exited.
  ([#1074](https://github.com/devswha/herdr-web-ui/pull/1074))
- Windows remote PCs now connect to the herdr socket under `XDG_CONFIG_HOME` when set.
  ([#1070](https://github.com/devswha/herdr-web-ui/pull/1070))
- A workspace or tab name can no longer be saved blank or longer than 80 characters: the server
  refuses it, the name fields stop at 80, and clearing a name in the sidebar or the tab strip says
  a name is needed instead of saving nothing or ignoring the Enter.
  ([#1011](https://github.com/devswha/herdr-web-ui/pull/1011))
- A workspace made on a repository's folder offers New worktree and Open worktree… in its row menu
  again. Since 0.4.6 the two showed only once the repository already had a worktree open.
  ([#993](https://github.com/devswha/herdr-web-ui/pull/993))
- New worktree in a repository that has no commit yet says so, instead of showing git's
  `fatal: invalid reference: HEAD`.
  ([#993](https://github.com/devswha/herdr-web-ui/pull/993))
- A connection attempt that hangs (a phone waking on a dead network) is given up after 8 seconds
  and tried again with a longer wait each time (up to 30 seconds), so a slow but working link
  such as a remote PC still connects, instead of leaving the app disconnected until reload.
  ([#954](https://github.com/devswha/herdr-web-ui/pull/954))
- A page coming back to the screen, or a network coming back, with a dead connection reconnects
  at once, even when the browser had not yet reported the connection closed or a retry was
  still waiting out a long deadline.
  ([#954](https://github.com/devswha/herdr-web-ui/pull/954))
- A connection that went dead without closing (a phone moving from Wi-Fi to cellular, or waking
  after its network changed) no longer leaves the terminal frozen while it still shows connected.
  The app checks the connection when the page comes back, the network changes or nothing arrived
  for 20 seconds, and reconnects when two checks a few seconds apart get no answer; a slow link
  gets longer each time it is dropped. Keys typed during the check are kept as held input instead
  of being lost, and a message sent during the check waits for the answer instead of failing. The
  key bar comes back as soon as the answer does, and a PC on an older version is no longer dropped
  after a reconnect.
  ([#967](https://github.com/devswha/herdr-web-ui/pull/967), [#972](https://github.com/devswha/herdr-web-ui/pull/972))
- Once terminal input is held, later typing joins the held input until you send or discard it,
  also after the terminal is ready again: a command is never split between the held text and the
  terminal, and Enter never runs the part that already reached it. Ctrl+Enter, a paste the held
  input cannot take (a tab, for one), the input line's Send and the message box's Send (a queued
  "Send now" too) are refused with a note saying to send or discard the held input first.
  ([#967](https://github.com/devswha/herdr-web-ui/pull/967), [#972](https://github.com/devswha/herdr-web-ui/pull/972))

### Maintenance
- The remote-PC runtime is now version 28: every saved PC asks for **Update bridge…** once.
- The pending-input "turn never starts" test waits for the recorder to log the bridge's Enter
  before comparing the bytes, instead of racing it.
  ([#979](https://github.com/devswha/herdr-web-ui/pull/979))
- Four browser checks no longer fail on a slow run: the terminal input check waits for the
  connection before it asks for a liveness probe, the update line and plan-limit checks count a
  request once it has been answered or by the page that made it, and the phone transcript check
  reads the transcript's style in one step.
  ([#1001](https://github.com/devswha/herdr-web-ui/pull/1001))
- CI's browser lanes run a failed script a second time. One that then passes is reported as flaky
  (a warning on the run, its first log kept) instead of failing the job; one that fails twice
  still fails it.
  ([#1002](https://github.com/devswha/herdr-web-ui/pull/1002))
- The SSH password test pulls its disposable PC's image from a second and a third registry when
  one refuses the runner for its pull limit, instead of failing on a limit that is not the
  test's.
  ([#1016](https://github.com/devswha/herdr-web-ui/pull/1016))
- The prompt dock check waits for the answered question's own card to go, not for any card: the
  demo's approval could take its place at once and the wait then ran out.
  ([#1016](https://github.com/devswha/herdr-web-ui/pull/1016))
- Browser CI reports name the failing assertion and script line, and a read-only CLI ranks
  failures and flakes from recent workflow attempts.
  ([#1009](https://github.com/devswha/herdr-web-ui/pull/1009))
- The self-hosted CI runners of one PC share `bun run check`'s slots: their Integration and
  Browser regression jobs wait for a slot instead of all running at once and failing each other's
  timing-bound tests.
  ([#1086](https://github.com/devswha/herdr-web-ui/pull/1086))
- `bun run dev` no longer answers every state-changing request with 403 `invalid_origin`: Vite's
  `/api` proxy keeps the browser's Host, which the server's same-origin check compares with Origin.
  ([#1003](https://github.com/devswha/herdr-web-ui/pull/1003))
- The user guide covers the image viewer, skill chips, the project favicon, the composer's folder
  strip, Files → Changes, the large-file source view, the
  palette's Settings pages and folder browsing, and the new Appearance settings; the agent guides
  point to their code and to `GET /api/workspace/diff/files` and `/diff/file`.
  ([#975](https://github.com/devswha/herdr-web-ui/pull/975))
- herdr RPCs are typed per method (`HerdrMethods`): server code calls `paneProcessInfo`,
  `agentGet` and the other wrappers in `server/herdr/client.ts`, and `server/conventions.test.ts`
  keeps it off the untyped `herdrRpc`, so asking `pane.process_info` by `target` no longer compiles
  without an explicit result type.
  ([#970](https://github.com/devswha/herdr-web-ui/pull/970))
- The browser scripts and `scripts/check.test.ts` run on a Mac as they are: a script without
  `CHROME_PATH` falls back to the lockfile's Playwright Chromium where Google Chrome's Linux path
  does not exist, the check tests make their scratch directories under `/tmp` so a socket inside
  stays within the path limit, and `scripts/output-browser-qa.ts` opens its page in English
  whatever the PC's language.
  ([#1004](https://github.com/devswha/herdr-web-ui/pull/1004))
- The math browser check answers a conversation request that reaches its server while the browser
  closes, instead of failing after every check has passed.
  ([#1027](https://github.com/devswha/herdr-web-ui/pull/1027))
- The pane paging browser check waits for the demo's opening turn to end before it measures scroll
  positions: that turn ends 4.5 s after load and changes the transcript's height, which broke the
  check on a loaded runner.
  ([#978](https://github.com/devswha/herdr-web-ui/pull/978))
- `scripts/repo-diff-browser-qa.ts` waits for the diff's worker colors before it selects and
  copies rows: the colored redraw dropped a selection made on the plain rows, so the copy came
  back empty.
  ([#980](https://github.com/devswha/herdr-web-ui/pull/980))
- The terminal input check waits for the snapshot before it asks for a liveness probe: on CI the
  snapshot can follow the pane's first frames by a few milliseconds, and a wake before it probes
  nothing.
  ([#1019](https://github.com/devswha/herdr-web-ui/pull/1019))
- The browser run's phone and desktop plan checks no longer lose the plan chip to the roster the
  server pushes over its event stream, and its split-view drag waits for each step the page shows
  before the drop.
  ([#983](https://github.com/devswha/herdr-web-ui/pull/983))
- On Windows, the browser and SSH scripts find the test herdr session: they look under
  `XDG_CONFIG_HOME` first, then `%APPDATA%`, as herdr does.
  ([#884](https://github.com/devswha/herdr-web-ui/pull/884) by @willowite,
  [#1032](https://github.com/devswha/herdr-web-ui/pull/1032))

## [0.4.8] - 2026-10-12

### Added
- **Settings → Composer → Send queued messages automatically** (on by default). Turned off, a
  message sent while the agent works waits under the message box until you press **Send now**,
  instead of going by itself when the turn ends. A PC whose bridge is older than this release
  still sends it at the turn's end. A held message shown in another tab, or after a reload, asks
  to be reviewed before Send now, since the tab that held it may still send it.
  ([#836](https://github.com/devswha/herdr-web-ui/pull/836))

### Changed
- With **Workspace cards** on, a pinned agent stays in its workspace's card, first there, and the
  cards that hold pins come first, instead of the agent leaving its card for the top of the list.
  ([#852](https://github.com/devswha/herdr-web-ui/pull/852))
- **Open in a new tab** on a markdown file opens a page of just the document, with its name, path,
  **Open raw file** and **Download** above it, instead of a second copy of the whole app with the
  file viewer over it. A link in the document to another file opens there, from the document's
  folder, and Back returns. Links made before (`?file=…`) still open the app with the viewer.
  ([#849](https://github.com/devswha/herdr-web-ui/pull/849))
- New workspace's recent folders leave out worktree checkouts (herdr's under `~/.herdr/worktrees`
  and the linked worktrees a PC has open) and temporary folders such as `/tmp`, and offer up to
  eight folders instead of three: a phone swipes them sideways on one row, a wider screen wraps them.
  ([#844](https://github.com/devswha/herdr-web-ui/pull/844), [#848](https://github.com/devswha/herdr-web-ui/pull/848))
- A pane's plan moved from the header into the background-task button by the message box: the
  button starts with **Plan** and how many steps are done (`2/5`), and opens one list with the
  plan's steps first and the background tasks below. The plan's flow of boxes, its dialog and the
  **Plan flow** and **Plan count in the header** settings are gone. ([#846](https://github.com/devswha/herdr-web-ui/pull/846))
- Reuse immutable chat-message revisions across unrelated renders while retaining mutable-caller change detection.
  ([#788](https://github.com/devswha/herdr-web-ui/pull/788) by @kilhyeonjun)
- The reason a chat message did not go (Claude Code's terminal input box holds a draft, the PC
  needs an update, the send was not confirmed) is a band on the message box's top edge, as wide as
  the box, with **Clear it and send** at its end, instead of small red text under the box.
  ([#851](https://github.com/devswha/herdr-web-ui/pull/851))
- Serve built JavaScript and CSS as Brotli or gzip when accepted, preserving original bytes and static cache/CSP policy.
  ([#787](https://github.com/devswha/herdr-web-ui/pull/787) by @kilhyeonjun)

### Fixed
- The file viewer draws the HTML a README is written with (a centered logo, a row of badges and
  links, `<details>`) as markdown instead of showing its tags as text: paragraphs and headings,
  centered where `align="center"` says so, links, images with their width, emphasis and line breaks.
  Other tags are left out with their text kept; comments, scripts and styles are dropped. Images from
  other sites still show their alt text, as before. An agent's chat message keeps HTML as text.
  ([#847](https://github.com/devswha/herdr-web-ui/pull/847))
- On a phone, Back closes every dialog drawn as a sheet the way it closes a ⋯ menu: the plan, the
  command palette, confirmations, the file list, the worktree dialog, Rename pane and the diagram
  lightbox. It used to open the pane before under the dialog, which stayed up. A wider screen keeps
  Back for the panes.
  ([#842](https://github.com/devswha/herdr-web-ui/pull/842))
- A phone brought back from sleep or the background reconnects as soon as the page is shown or the
  network returns, instead of showing "reconnecting" for up to 5 seconds while the retry delay
  grown during sleep ran out.
  ([#843](https://github.com/devswha/herdr-web-ui/pull/843))
- On a phone, the system Back button closes an open ⋯ menu sheet instead of switching to the pane
  opened before, which it did since 0.4.7 made each pane a history entry. A sheet closed by Cancel,
  a swipe or one of its items leaves no extra Back step behind.
  ([#837](https://github.com/devswha/herdr-web-ui/pull/837))
- On a phone or other touch screen, a pane shown alone no longer draws its own ellipsis over the
  chat or terminal, under the header's: its actions (rename, split, zoom, close) are in the tab's
  ellipsis menu, between the tab's panes and the tab's own actions. A split pane on a wide touch
  screen keeps its own menu.
  ([#835](https://github.com/devswha/herdr-web-ui/pull/835))
- On a phone, a long press on the chat selects text and offers copy as the phone does, instead of
  opening the pane's actions menu; on the terminal it opens no menu either. A right-click, or a
  menu asked for from the keyboard, still opens it.
  ([#838](https://github.com/devswha/herdr-web-ui/pull/838))
- With the system's reduce-motion setting on, a running agent's arc in the sidebar stood still,
  so RUN looked like BG (the same arc held still). It now fades in and out instead of turning. ([#841](https://github.com/devswha/herdr-web-ui/pull/841))
- A phone showing one pane of a split tab no longer resizes the tab's other panes to its own
  screen: they stay mounted behind the one shown and now keep the size the pty has, so a PC
  drawing the split keeps its own sizes. A pane shown again on the phone takes its size then.
  ([#840](https://github.com/devswha/herdr-web-ui/pull/840))
- The update line above the pane stays one line on a phone and on a computer: a long sentence ends
  in an ellipsis instead of wrapping its buttons onto a second row, the line after an update closes
  with an × like a PC's line, and an install's step, count and bar share one row. The warning to
  save unsent drafts before a reload is the one line still read in full, so it may wrap.
  ([#845](https://github.com/devswha/herdr-web-ui/pull/845))
- A PC window left in front while you used the terminal on a phone stayed at the phone's size
  when you came back, because it never lost the focus and so never took the pane back. A click
  or a key in its terminal now returns the pane to the PC's size. ([#839](https://github.com/devswha/herdr-web-ui/pull/839))
- A refused answer on a question card (the question changed, or the answer no longer fits it) now
  stays on the card as an error until the card is replaced, instead of a 2-second note that was easy
  to miss, so the button no longer looks dead. `POST /api/pane/prompt/answer` logs each request
  with the pane, whether the prompt id matched, and the outcome; never the answer.
  ([#793](https://github.com/devswha/herdr-web-ui/pull/793))

### Maintenance
- The remote-PC runtime is now version 27: every saved PC asks for **Update bridge…** once, so the
  held messages setting and the precompressed assets reach it.

## [0.4.7] - 2026-10-12

### Added
- **Settings → Subscription usage → Show pace** (off by default) makes the usage meters show each
  limit's pace: a mark on its bar where an even pace would be by now,
  how fast it is being used (`15%/h` for a session, `18%/day` for a week), and **Runs out in 2d 1h**
  when that pace reaches the limit before it resets. A chip whose limit runs out before its reset
  turns its hairline red while its share is still low, and says when in its label; once that
  time has gone by, both stay until the reset as **Runs out before reset**. The pace is
  measured when the numbers were read, and shown only where the provider states the window's
  start or length (Claude, Codex, Grok), from 5% of the window on.
  ([#513](https://github.com/devswha/herdr-web-ui/pull/513) by @kilhyeonjun, [#834](https://github.com/devswha/herdr-web-ui/pull/834))
- Turkish (Türkçe) UI translation: a full `i18n.tr.ts` dictionary, the language in the Settings menu with browser detection, and a Turkish README. ([#815](https://github.com/devswha/herdr-web-ui/pull/815) by @fitzgpt)
- Native conversation transcripts for Hermes Agent: turns, thinking blocks, and tool calls are read directly from its SQLite session store. ([#604](https://github.com/devswha/herdr-web-ui/pull/604) by @RikiSanjayaa)
  A remote PC reads them once its bridge is updated to this release's runtime.
- **Deep links.** The address now says where you are, and opens there: the PC, the workspace (by id and a short slug of its name, so `?ws=w2K-herdr-web-ui&pane=w2K:p1&view=chat` reads like the place), the pane and its lens, an open file, a Settings page and group (`&settings=about&section=updates`), the New workspace dialog with its fields filled (`?new=workspace&cwd=…&name=…&agent=…`; a link never creates anything), and a collapsed sidebar (`&sidebar=hidden`). Opening another pane is a history entry, so Back returns to the last one. A link to a pane that has closed opens its workspace, a link to nothing open says so, and **Copy link** in the header's More menu copies the address on a phone.
  ([#675](https://github.com/devswha/herdr-web-ui/pull/675) by @phirschybar, [#762](https://github.com/devswha/herdr-web-ui/pull/762))

- **Chat: `SendUserFile` calls** show their caption and the files they name as openable links,
  the same way any other tool's file path already opens, instead of the call's raw JSON.
  ([#730](https://github.com/devswha/herdr-web-ui/pull/730) by @bluzername, [#757](https://github.com/devswha/herdr-web-ui/pull/757))
- Settings → Terminal sets the cursor shape (block, bar or underline) and whether it blinks, for
  every terminal pane. A program in the pane that sets its own cursor style (DECSCUSR) can still
  change it, as before this setting existed.
  ([#731](https://github.com/devswha/herdr-web-ui/pull/731) by @bluzername, [#758](https://github.com/devswha/herdr-web-ui/pull/758))
- Holding an arrow in the touch key bar repeats it until release, including held modifiers and
  saved arrow combinations. A tap still sends one key, and swiping sideways scrolls the row
  without sending a key.
  ([#719](https://github.com/devswha/herdr-web-ui/pull/719) by @zerodice0, [#758](https://github.com/devswha/herdr-web-ui/pull/758))
- On a phone, a two-finger pinch on the terminal changes its font size live (10–22 px), with a
  badge showing the size; the shared pty resizes once, when a finger lifts.
  ([#713](https://github.com/devswha/herdr-web-ui/pull/713) by @zerodice0, [#758](https://github.com/devswha/herdr-web-ui/pull/758))
- Grok chat reads native messages and tool activity, respects logical rewinds and
  refreshes expanded tool output. For now it works only with the native Grok build
  `grok-1.0.50-linux-x86_64` on Linux; other builds, macOS and Windows show the terminal view.
  See [setup and limits](docs/grok-chat.md).
  ([#777](https://github.com/devswha/herdr-web-ui/pull/777) by @infowolfe)
- **Experimental Antigravity chat** reads native messages and tool activity, follows the
  running process’s active conversation, and honors saved rewind boundaries. macOS is untested.
  See [compatibility and validation](docs/agy-chat.md).
  ([#789](https://github.com/devswha/herdr-web-ui/pull/789) by @infowolfe)
- Hermes's clarify questions get an answer card, as Claude Code's and Codex's do: one tap per
  choice, a typed answer for its "Other" row and for an open question, and ticks for a question
  that takes several answers. Text already on its answer line is cleared first, so it does not
  join the answer.
  ([#750](https://github.com/devswha/herdr-web-ui/pull/750) by @DarkoKuzmanovic, [#764](https://github.com/devswha/herdr-web-ui/pull/764))
- Settings → Appearance → Colors offers **Forest**, a low-saturation green-grey palette for long
  sessions, in dark and light, with matching terminal and title-bar colors.
  ([#775](https://github.com/devswha/herdr-web-ui/pull/775) by @vibewriter-hand)
- A Claude Code or Codex pane's plan appears as progress in the header and sidebar. Open it
  from the header in Chat or Terminal to see its steps as a flow or a list, with the current
  step and elapsed times. It is read from the agent's transcript. **Settings → Appearance** can
  take the count out of the header (**Plan count in the header**) and open the plan as the
  list alone (**Plan flow**); both are on by default.
  ([#531](https://github.com/devswha/herdr-web-ui/pull/531) by @kilhyeonjun, [#820](https://github.com/devswha/herdr-web-ui/pull/820))
- A `mermaid` code block in the chat is drawn as a diagram, with a full-screen lightbox to zoom and
  pan it, and the file viewer renders markdown files with local images; larger images are offered
  as downloads. ([#616](https://github.com/devswha/herdr-web-ui/pull/616) by @lyonbot)
- **Settings → Appearance → Pin agents** (off by default) shows a star beside each row of the Agents list that pins the agent to the top; pins keep their order across reloads. ([#778](https://github.com/devswha/herdr-web-ui/pull/778) by @vibewriter-hand, [#820](https://github.com/devswha/herdr-web-ui/pull/820))
- An OpenCode pane on a 1.x store (`session`/`message`/`part`) reads as a conversation again, where
  the chat used to keep the terminal's text: prompts with the pictures pasted in them, each answer's
  steps with their tool calls and outputs, and the turns an `/undo` took back.
  ([#690](https://github.com/devswha/herdr-web-ui/pull/690) by @okcedric)

### Changed
- The anonymous install and update counts also name the appearance settings changed from their
  defaults (theme, density, colors, sidebar rows, Agents order, workspace cards, pin agents and the
  two plan settings): the names only, never a value, and never a setting you type. The notice is
  shown once more before anything is sent, and the same switch and environment variables turn it off.
  ([Anonymous usage counts](docs/guide.md#anonymous-usage-counts), [#820](https://github.com/devswha/herdr-web-ui/pull/820))
- A split pane narrower than 80 columns draws its terminal in a smaller font, down to 10px, so
  it still has the 80 columns programs such as btop need; widened or zoomed, it returns to your
  font size. A pane too narrow to reach 80 columns even at 10px keeps your size, as does a pane this
  browser only mirrors or watches. Settings → Terminal → **Fit 80 columns in a split pane** turns
  it off. ([#824](https://github.com/devswha/herdr-web-ui/pull/824))
- On a phone the app moves and responds like an iPhone app rather than a web page. Menus,
  dialogs, the palette and Settings slide up from the bottom, follow your finger when you drag
  them down, and slide away however they close; the workspace drawer follows your finger too.
  Over the chat the header is frosted glass that the conversation scrolls under, and the message
  box floats over the conversation's end. A tapped button dims at once instead of drawing an amber
  box, a list row fills when pressed, a long press on the app's buttons and rows no longer selects
  their text.
  ([#683](https://github.com/devswha/herdr-web-ui/pull/683) by @jiunshinn)

- Chat updates follow native transcript changes pushed through the existing WebSocket.
  Only visible Chat views subscribe; Terminal views and hidden tabs release conversation
  monitoring. Continuous pushes coalesce into at most one newest-page refresh every 2 seconds,
  with a 10-second fallback; without pushes (an older remote PC, or a tab that let go of its pane)
  Chat reads every 2 seconds as before. Initial display, sends, reconnect and returning to the tab refresh
  immediately without overlapping reads or dropping held history. A Chat that shows the
  terminal's text because no native transcript exists yet rereads on the pane's output instead.
  A remote PC gets pushes once its bridge runs a bundle with this change. Approval-card polling
  remains independent.
  ([#689](https://github.com/devswha/herdr-web-ui/pull/689) by @zerodice0, [#757](https://github.com/devswha/herdr-web-ui/pull/757))
- **Settings → Appearance → Workspace cards** (off by default) puts each workspace's agents in
  the sidebar's Agents list in a card under the workspace's name, so agents working in the same
  workspace read as one group. Rows in a card do not repeat the workspace on their second line;
  their tooltips still name it. A list in Activity order draws no cards, since it mixes workspaces.
  ([#673](https://github.com/devswha/herdr-web-ui/pull/673) by @WOULDU-pres, [#820](https://github.com/devswha/herdr-web-ui/pull/820))
- New workspace offers the three most recent folders of the PC as chips on one row, kept after
  workspaces close and the browser reloads. A chip puts its folder in Directory; a successful
  start moves that folder to the front, ahead of folders a shell only passed through.
  ([#652](https://github.com/devswha/herdr-web-ui/pull/652) by @od-studio-webagency, [#829](https://github.com/devswha/herdr-web-ui/pull/829))

### Fixed
- Mod+Shift+↑/↓ switch panes from the chat's empty message box too, as they do from the terminal.
  A box with a draft keeps them for selecting text.
  ([#827](https://github.com/devswha/herdr-web-ui/pull/827) by @sergiorademacher)
- Reloading with Settings open closes Settings whenever the browser gets to its step back; it could
  come back when the app had drawn itself first, as on a slow device. ([#825](https://github.com/devswha/herdr-web-ui/pull/825))
- A phone shows a split tab one pane at a time again, at the screen's whole width, instead of
  every pane squeezed into herdr's grid (since 0.4.6). The tab's menu lists the tab's panes to
  switch between them. Wider screens keep the split, and herdr's own layout is not changed.
  ([#819](https://github.com/devswha/herdr-web-ui/pull/819))
- Markdown files opened in a new tab keep their rendered preview instead of showing source.
  The link stays on the file's PC without requiring its original pane; Open raw file and Download
  still provide the original contents. ([#823](https://github.com/devswha/herdr-web-ui/pull/823))
- Chat hides a rejected conversation immediately, even when reading its terminal fallback
  is slow or fails, so removed history does not remain on screen.
  ([#789](https://github.com/devswha/herdr-web-ui/pull/789) by @infowolfe)
- Grok and Antigravity Chat show native turn activity, open live tool rows even when Herdr reports ready or done, and explain when native chat is unavailable.
  ([#816](https://github.com/devswha/herdr-web-ui/pull/816) by @infowolfe)
- When a chat message is not sent because Claude Code's input box in the terminal is not empty,
  the note now says what the box holds, and a one-line draft there can be cleared from the chat
  with Clear it and send. The chat did not show that text, so Send seemed to do nothing until the
  text was found and deleted in the terminal. The cleared text comes back in the terminal with Ctrl+Y.
  ([#728](https://github.com/devswha/herdr-web-ui/pull/728) by @jiunshinn)
- A Claude Code chat whose session continued in a new transcript file (the old file holds only
  a `continued-in` record) now shows the conversation from the file Claude writes to, instead of
  an empty chat.
  ([#779](https://github.com/devswha/herdr-web-ui/pull/779) by @vibewriter-hand)
- A pane in use keeps the lens it shows: with **Panes open in → Chat**, a shell split beside an
  agent no longer turns into its chat when an agent starts in it, and an agent pane no longer
  turns into its terminal when the agent exits. A lens picked by hand still wins, and a new
  Settings choice applies again to every pane.
  ([#755](https://github.com/devswha/herdr-web-ui/pull/755))
- A Claude pane that used an agent team no longer counts its teammates as running after they
  shut down: a teammate that approved its lead's shutdown request reads as completed, so the
  pane's running count and the agent list show only what still runs.
  ([#744](https://github.com/devswha/herdr-web-ui/pull/744) by @Haeminway1, [#764](https://github.com/devswha/herdr-web-ui/pull/764))
- A Claude Code multiple-choice question stays a multiple choice once a row is ticked in the
  terminal (Claude Code 2.1.296 draws the tick as `[✔]`), its options no longer carry the box, and
  the card stays up with the cursor on its **Submit** row. A pick there used to untick the row
  instead of answering.
  ([#764](https://github.com/devswha/herdr-web-ui/pull/764))
- An agent chat without a structured conversation no longer waits on hidden terminal output. Opening the terminal disclosure reads it independently; chat header/body reads have a 15-second deadline (30 seconds on a remote PC).
  ([#791](https://github.com/devswha/herdr-web-ui/pull/791) by @kilhyeonjun)
- Keep text file previews within their byte budget when a peer ignores Range, reject HTTP error bodies, and cancel stalled or closed previews.
  ([#785](https://github.com/devswha/herdr-web-ui/pull/785) by @kilhyeonjun)
- A Claude `/model` list whose hint a narrow pane wraps inside a word or over more than six lines
  is still recognised, so a pending message waits instead of pressing Enter on it, and the same
  words quoted in Claude's output no longer hold pending messages.
  ([#764](https://github.com/devswha/herdr-web-ui/pull/764))
- Push alerts no longer reach every device while you are using the app: while any window of it
  is visible and focused, on any device, no device gets an alert. Alerts resume once no window
  is in use, and **Send test** still always sends.
  ([#759](https://github.com/devswha/herdr-web-ui/pull/759))
- A click in the terminal while an arrow key is still on its way to herdr reaches the program as
  a click, instead of being typed into it as the raw characters of a mouse report.
  ([#763](https://github.com/devswha/herdr-web-ui/pull/763))
- OmO's side panel no longer draws a dotted line under its file, goal and memory rows in the
  terminal: a link the app cannot open is no longer underlined.
  ([#763](https://github.com/devswha/herdr-web-ui/pull/763))
- The Agents list no longer repeats an agent's kind beside the mark that already shows it, so
  workspace and tab names keep the room on a narrow sidebar. The kind stays in the row's tooltip
  and is still read out by screen readers; an agent without a mark of its own keeps the word.
  ([#761](https://github.com/devswha/herdr-web-ui/pull/761))
- A chat message stopped right after sending, before Claude Code answered, is no longer stuck: the
  message goes back into the message box to edit and send again, as Claude Code puts it back in its
  own input box, instead of staying in the chat as sent and the next send failing with "Claude
  Code's input box in the terminal is not empty". The new send replaces that copy in the terminal
  and stays in the same conversation, and the cancelled message is not shown beside it. A draft you
  typed or changed in the terminal is still never replaced.
  ([#741](https://github.com/devswha/herdr-web-ui/pull/741) by @Haeminway1,
  [#760](https://github.com/devswha/herdr-web-ui/pull/760))
- **Send now** on a Claude Code pane that is working sends the message at once, as Ctrl+Enter in
  the terminal does, instead of leaving it in Claude Code's own queue until the turn ends.
  ([#760](https://github.com/devswha/herdr-web-ui/pull/760))
- A pending chat message is no longer typed, or committed, after its connection lost the right to
  send it while herdr was being reached: refused before the paste it stays unsent, after it the
  message is marked for a check in the terminal. ([#760](https://github.com/devswha/herdr-web-ui/pull/760))
- A folded PC/workspace section no longer leaves a large empty gap below it: a visible Agents list
  takes the unused height, and an empty one follows the folded section directly. The Agents height
  cap, independent scrolling and fixed footer stay unchanged.
  ([#780](https://github.com/devswha/herdr-web-ui/pull/780) by @vibewriter-hand)
- Back and Forward after a pane is moved: the move no longer adds a history entry, and Back to an
  entry from before the move opens the pane under its new id instead of its old workspace. Back to
  an entry for a PC removed since stays on the pane shown and says the PC is not set up here,
  instead of selecting the missing PC and leaving the pane blank. Back or Forward that lands
  elsewhere than its entry named no longer drops the entries after it.
  ([#804](https://github.com/devswha/herdr-web-ui/pull/804) by @phirschybar)
- An agent herdr names with an icon-font glyph (a private-use character) no longer shows that glyph as
  a stray character beside the session's name: its fallback mark takes the first real letter.
  ([#817](https://github.com/devswha/herdr-web-ui/pull/817) by @foxion37)

### Maintenance
- CI runs the browser scripts in parallel and the unit tests in parallel processes, and caches its
  setup. ([#795](https://github.com/devswha/herdr-web-ui/pull/795), [#805](https://github.com/devswha/herdr-web-ui/pull/805))
- Browser checks that failed by timing no longer do: a route's handlers finish before it is
  removed, the pending-input recorder polls its screen, the page clock is paused at a time the
  page has not passed, and the IME check waits for the whole commit.
  ([#756](https://github.com/devswha/herdr-web-ui/pull/756), [#767](https://github.com/devswha/herdr-web-ui/pull/767), [#813](https://github.com/devswha/herdr-web-ui/pull/813), [#831](https://github.com/devswha/herdr-web-ui/pull/831))
- Grok chat reads each transcript with one stat, so an append between two reads cannot split it.
  ([#810](https://github.com/devswha/herdr-web-ui/pull/810))
- The guide names **Settings → Phone & devices** as the app does. Contributing: changes that need
  each other may share a pull request, and a UI change no longer has to attach a screenshot.
  ([#743](https://github.com/devswha/herdr-web-ui/pull/743) by @rabbitson87, [#821](https://github.com/devswha/herdr-web-ui/pull/821), [#826](https://github.com/devswha/herdr-web-ui/pull/826))
- The remote-PC runtime is now version 26: every saved PC asks for **Update bridge…** once.

## [0.4.6] - 2026-10-11

### Added
- Drag tabs to reorder them within their workspace without changing the selected pane. The tab
  menu offers **Move tab left / right**, including on phones; Alt+Shift+Left/Right moves a focused
  tab. The order is saved by herdr and shared with its TUI.
  ([#747](https://github.com/devswha/herdr-web-ui/pull/747))
- Terminal search highlights native matches in the visible grid, and a scrollbar navigates
  herdr's shared history by dragging or keyboard. Search counts and previous/next navigation stay
  available on older bridges; automatic highlighting requires the new range response.
  ([#747](https://github.com/devswha/herdr-web-ui/pull/747))
- The command palette searches panes across all connected PCs, including PC names, workspace
  branches and tab labels. Results and Recent entries retain their owning PC, and selecting one
  switches directly to it. App and plugin actions still target the currently selected PC.
  ([#747](https://github.com/devswha/herdr-web-ui/pull/747))
- Native pane layout operations are available from the web and remote PCs. Pane menus offer
  split, zoom and swap with the focused pane; split boundaries resize herdr's actual layout.
  The command palette also offers split and zoom actions. The bridge exposes pane split, zoom,
  swap, resize and clear endpoints.
  ([#726](https://github.com/devswha/herdr-web-ui/pull/726), [#747](https://github.com/devswha/herdr-web-ui/pull/747))
- Find literal text in a pane's history from **Find in terminal** in More or Mod+Shift+F.
  Previous/next controls show the match count and move herdr's shared viewport, including its TUI.
  ([#729](https://github.com/devswha/herdr-web-ui/pull/729))
- The command palette lists the actions of the herdr plugins installed on the PC under **Plugin
  actions** and runs one against the selected pane, with that pane's workspace and tab as its
  context. The row shows that it is running, a command that fails says why above the list, and a
  pane the action opens and focuses is selected. Settings → About lists the installed plugins and
  their actions, to read only: installing, enabling and removing a plugin stay with herdr.
  ([#720](https://github.com/devswha/herdr-web-ui/pull/720))
- **Settings → Agent integrations** lists herdr's integration for each agent it supports and
  says whether it is installed, older than the running herdr, or missing. Agents found on the PC
  come first. A missing or outdated one shows its `herdr integration install …` command with a
  Copy button; the page only reads herdr's state and never installs or removes anything.
  ([#722](https://github.com/devswha/herdr-web-ui/pull/722))
- **Move pane to…** in the header's More menu moves the
  pane into another tab of its workspace, a new tab there or in another workspace, or a workspace
  of its own, as herdr's `pane move` does; on a phone the places are a bottom sheet. The app stays
  on the moved pane, also under the new id herdr gives a pane that changes workspace, and the lens
  and unsent drafts kept for it follow. `POST /api/pane/move` carries it, on a remote PC too.
  ([#734](https://github.com/devswha/herdr-web-ui/pull/734), [#747](https://github.com/devswha/herdr-web-ui/pull/747))
- The command palette now lists panes the way herdr's Goto picker does: one row per pane under
  its workspace's heading (a linked worktree's branch beside the name), with status chips above
  the list — **All**, **INPUT**, **RUN**, **READY**, **DONE** and **BG**, each with its count — and
  a footer that names where the picked row goes (workspace › tab) and its path. A search also
  matches the tab's label, the workspace's branch and the agent kind, `>` searches the actions
  alone, Left and Right step between workspaces from the edge of the query or from a row, and
  herdr's own keys (`b`, `w`, `i`, `d`, `a` for a filter, `/` for the search) work while the
  focus is on the list or the chips, never while typing.
  ([#721](https://github.com/devswha/herdr-web-ui/pull/721))
- Live agent names set through `herdr agent rename` appear in the Agents list, including changes
  from another client. ([#736](https://github.com/devswha/herdr-web-ui/pull/736), [#747](https://github.com/devswha/herdr-web-ui/pull/747))

### Changed
- The server gzips its JSON and text answers for a browser that accepts it. A conversation page
  of a couple of megabytes, fetched on every session switch and polled while it changes, goes over
  the wire at about a quarter of its size, and the app's script at about a third; over a slow link
  such as a relayed Tailscale connection a switch to a long session is about twice as fast.
  ([#615](https://github.com/devswha/herdr-web-ui/pull/615) by @Haeminway1)
- Agents rows are selection-only: removed their ellipsis menu and name-editing dialog. The list
  keeps its existing names, status, folding and click-to-open behavior.
  ([#747](https://github.com/devswha/herdr-web-ui/pull/747))
- Desktop tabs use a right-click menu in place of inline close and dropdown buttons. Touch and
  narrow layouts offer the same menu through an ellipsis beside the selected tab; keyboard users
  can open it with Shift+F10.
  ([#747](https://github.com/devswha/herdr-web-ui/pull/747))
- Workspace right-click and ⋯ menus share herdr’s workspace/worktree actions. Right-click opens
  at the pointer without changing pane selection or input focus; sidebar layout stays the same.
  Pane renaming stays in the pane menu, and Move pane to… is available through header More.
  ([#747](https://github.com/devswha/herdr-web-ui/pull/747))
- Split tabs now show every pane together in herdr's layout, with focused borders and draggable
  split boundaries. Right-click a pane for herdr's pane menu without changing focus; splits open
  the new pane, Swap with focused pane preserves the original focus, and zoom restores the same
  layout. Tab menus contain tab creation, renaming, reordering and closing, and the strip stays visible
  for a single pane. Each pane retains its own terminal stream, chat lens and unsent draft.
  ([#747](https://github.com/devswha/herdr-web-ui/pull/747))
- Single-pane input, file discovery and image upload lookups ask herdr for that pane instead of
  rebuilding a whole-session snapshot. Layout and transcript peer checks keep their snapshots.
  ([#724](https://github.com/devswha/herdr-web-ui/pull/724))

### Fixed
- A screen reader no longer reads a pane's id out as the terminal's name.
  ([#695](https://github.com/devswha/herdr-web-ui/pull/695) by @pt-act)
- Pending messages remain available for **Send now** after switching tabs, workspaces or PCs.
  Pane attachments share their PC's connection, so leaving a pane stops automatic delivery while
  its server-owned hold receipt still arrives. Real disconnections and reloads never resume a
  queued send. ([#747](https://github.com/devswha/herdr-web-ui/pull/747))
- A phone or tablet that leaves the web UI (another app, the lock screen, another tab) lets go
  of the pane at once and only watches it, so herdr's own window on the PC gets its size back
  instead of keeping the phone's. Coming back to the page attaches again.
  ([#748](https://github.com/devswha/herdr-web-ui/pull/748))
- Codex conversations on Windows resolve the transcript even when the pane's working directory
  uses different letter casing from Codex's stored path. The lookup verifies the directory on
  disk before considering its canonical spelling, so another pane's chat is not substituted.
  ([#740](https://github.com/devswha/herdr-web-ui/pull/740) by @antonydoyle)
- The browser demo keeps each row's own split when resizing a grid and keeps deeply split
  panes visible and resizable. ([#726](https://github.com/devswha/herdr-web-ui/pull/726))
- Workspace and tab changes, pane moves and layout updates made in herdr's terminal UI
  now refresh the web immediately through coalesced lifecycle events instead of waiting
  for the five-second poll. Pane status subscriptions follow moved pane IDs.
  ([#725](https://github.com/devswha/herdr-web-ui/pull/725))
- Typing no longer reaches a pane that another connection is attached to, on a PC where typing
  goes through herdr instead of a terminal. The other path already refused it; this one did not,
  so a second tab or a second bridge could type into a pane someone else was attached to. A pane
  nobody is attached to is unaffected, which is what keeps the key bar and an older bridge's
  composer working.
  ([#732](https://github.com/devswha/herdr-web-ui/pull/732) by @pt-act)
- A numeric custom tab name remains visible when tabs before it close ([#723](https://github.com/devswha/herdr-web-ui/pull/723)).
- A request that carries a session cookie but states no `Origin` is now read as cross-site rather
  than same-origin, so a header that went missing is no longer trusted as though a browser had
  sent it. What genuinely cannot state one keeps working — a same-origin read such as the PC
  event stream, the WebSocket upgrade a browser cannot add the custom header to, signing out, and
  push subscribe — as does any client that proves itself with `x-herdr-machine`. A browser is
  unaffected: it always states an `Origin` on a cross-origin request, and `SameSite=Strict`
  already covered what this closes.
  ([#697](https://github.com/devswha/herdr-web-ui/pull/697) by @pt-act)
- A remote PC that is switched off or asleep while its bridge update runs, or whose update was
  cancelled, now shows **Reconnecting…** instead of asking for a bridge update it cannot run.
  Once the PC answers, the version check runs again and, if the bridge is still out of date, the
  update follows; a cancelled update comes back as the **Update bridge** button only.
  ([#716](https://github.com/devswha/herdr-web-ui/pull/716))
- An OmO pane whose turn ended on a model error (the provider gave up after its retries, or
  timed out) now reads READY instead of DONE, and no "work finished" alert fires for it. A retry
  that answers afterwards still finishes the turn as DONE, with its alert.
  ([#715](https://github.com/devswha/herdr-web-ui/pull/715))
- On Windows, a Codex chat is found when `CODEX_HOME` carries the `\\?\` prefix, or when Codex
  stored the working directory with a drive letter in another case than herdr reports
  (`\\?\d:\work\app` for `D:\work\app`). A Claude pane whose process two stores both claim
  (`~/.claude` and a `~/.claude-*` copy) now says its chat is unavailable instead of showing
  `~/.claude`'s session.
  ([#714](https://github.com/devswha/herdr-web-ui/pull/714))

### Maintenance
- A few herdr-backed check runs can share a PC, one per checkout, so parallel worktrees no longer
  wait on one lock; integration results are counted through bun's colour codes; three more
  entry-point scripts are typechecked.
  ([#738](https://github.com/devswha/herdr-web-ui/pull/738), [#733](https://github.com/devswha/herdr-web-ui/pull/733) by @pt-act, [#696](https://github.com/devswha/herdr-web-ui/pull/696) by @pt-act)
- The remote-PC runtime is now version 25: every saved PC asks for **Update bridge…** once.

## [0.4.5] - 2026-10-09

### Changed
- A desktop tab no longer pauses its terminal a second after you switch to another window, as
  0.4.4 started doing: it keeps updating, as before 0.4.4. If this PC also shows herdr in a
  terminal window, turn on **Settings → Terminal → Use alongside herdr's own window**: a second
  after you leave the tab, it lets go of the pane so herdr's window keeps the pane at its own size,
  and it keeps showing the pane read-only (drawn at herdr's size) until you click it to type again.
  A server older than this one pauses the tab instead.
  ([#699](https://github.com/devswha/herdr-web-ui/pull/699), [#700](https://github.com/devswha/herdr-web-ui/pull/700))
- Remote PCs use runtime bundle v24 for these fixes. Choose **Update bridge…** once on each
  connected PC after updating the app. ([#711](https://github.com/devswha/herdr-web-ui/pull/711))

### Fixed
- Claude background counts reread concurrent transcript appends and replaced transcript files
  instead of keeping a stale count until another write. ([#701](https://github.com/devswha/herdr-web-ui/pull/701))
- Claude process identity lookups recover after transient failures, so tasks left by an earlier
  process stop counting as running when the process boundary becomes available. ([#702](https://github.com/devswha/herdr-web-ui/pull/702))
- Delayed Claude transcript discovery preserves an observed turn's background wait and original
  deadline; a replacement session does not inherit the old session's wait. ([#703](https://github.com/devswha/herdr-web-ui/pull/703))
- Claude background badges expire day-old subagent files even when no transcript changes. ([#706](https://github.com/devswha/herdr-web-ui/pull/706))
- Claude completion cards deduplicate consistently within each chat page, whether its turns
  were read incrementally or loaded from scratch. ([#708](https://github.com/devswha/herdr-web-ui/pull/708))
- Chat code blocks preserve trailing source newlines in manual text selections, with highlighting
  on or off. The Copy code button continues to copy the original source. ([#710](https://github.com/devswha/herdr-web-ui/pull/710))

### Maintenance
- Include TanStack Highlight's MIT license in the notices shipped with the app.
  ([#704](https://github.com/devswha/herdr-web-ui/pull/704))
- Update source-map-js to 1.2.2 for its security fix.
  ([#705](https://github.com/devswha/herdr-web-ui/pull/705))
- Run native Windows and macOS session identity regressions in release validation and order
  the browser readline fixture's input consistently. Use Debian's official ECR mirror for the
  Docker SSH fixture to avoid Docker Hub's anonymous pull limit.
  ([#709](https://github.com/devswha/herdr-web-ui/pull/709), [#701](https://github.com/devswha/herdr-web-ui/pull/701))

## [0.4.4] - 2026-10-09

### Added
- A Claude Code pane's subagents (the `Agent` tool) now show where OmO's background tasks do:
  the status line lists what runs and what ended in the last day, the pane's badge counts the
  running ones, and a subagent that ends leaves a card in the chat with its answer instead of
  being hidden. They are read from the session's own `subagents/` files and its transcript.
  ([#527](https://github.com/devswha/herdr-web-ui/pull/527) by @kilhyeonjun)
- A Claude Code pane's background commands are listed with its subagents and end with their
  notification or a successful `TaskStop`/`KillShell`.
  ([#534](https://github.com/devswha/herdr-web-ui/pull/534) by @kilhyeonjun)
- **Settings → Voice input → Dictation language** picks the language dictation listens for. On Auto,
  a browser whose first language the app is not translated into (Hungarian, German, …) is heard in
  that language rather than in English; every other case listens for the app's language as before.
  ([#612](https://github.com/devswha/herdr-web-ui/pull/612) by @kratam)
- `HERDR_WEB_APP_NAME` names the installed app, so the apps of two PCs on one phone no longer
  both read `herdr`. Unset, nothing changes.
  ([#684](https://github.com/devswha/herdr-web-ui/pull/684) by @sma505)
- Workspaces can be reordered on a phone or tablet: hold a row until it lifts, drag it, and let
  go where the line shows. Before, a long press on iOS showed the system's drag preview but
  dropped nothing. Alt+Up/Down also moves a focused row one step.
  ([#679](https://github.com/devswha/herdr-web-ui/pull/679) by @jiunshinn)
- A task list (`- [x] done`, `- [ ] open`) in the chat shows a checked or empty box in place of
  its bullet, instead of the brackets.
  ([#669](https://github.com/devswha/herdr-web-ui/pull/669) by @aNNdii)
- Code blocks in the chat are highlighted by their language (TanStack Highlight). Anything longer
  than a few lines is highlighted in a worker, so no reply can freeze the page: a block that takes
  longer than 2 s, or is over 100 KB, stays plain and says so. **Settings → Chat → Highlight code**
  turns it off.
  ([#671](https://github.com/devswha/herdr-web-ui/pull/671) by @aNNdii)

### Changed
- Website and installer publishing waits for CI and the site build to pass on the same commit.
  Local checks retain source-bound results and failure evidence, and critical build scripts
  and the demo transport are typechecked alongside the app.
  ([#692](https://github.com/devswha/herdr-web-ui/pull/692))
- The chat's `/` command list also matches a word of a command's name, any part of it, its letters
  in order and its description, so a plugin command is found without typing its prefix. Prefix
  matches still come first.
  ([#617](https://github.com/devswha/herdr-web-ui/pull/617) by @lyonbot)
- A size under 10 MB shows one decimal (`1.3 MB`), in the file viewer, the Files list and a bridge
  update's progress: a 1.3 MB file no longer reads as 1 MB.
  ([#670](https://github.com/devswha/herdr-web-ui/pull/670) by @aNNdii)
- The anonymous install and update counts now keep the country a message came from: two
  letters such as `KR`, worked out by the receiver's host, and nothing finer. No IP address is
  stored and the message itself is unchanged. The notice, Settings → About and the guide say so.
  ([#663](https://github.com/devswha/herdr-web-ui/pull/663))

### Fixed
- The working arc in the sidebar is drawn thirty times a second instead of five, so a working
  agent reads as work in progress and not as a stutter. The arc is the same size and the turn
  still takes 1.6 s; only its eight 45° steps became forty-eight 7.5° ones.
  ([#622](https://github.com/devswha/herdr-web-ui/pull/622) by @iwangjie)
- A Claude turn awaiting background work shows **BG**, even with **Quiet opened finishes** on,
  instead of prematurely alerting "work finished". Automatic resumes share the first rest's
  30-minute limit; a dev server started by the same prompt can hold the finish until that limit.
  Work from an earlier prompt holds nothing, and restarting the bridge does not rehold an old
  finish or send it again.
  ([#534](https://github.com/devswha/herdr-web-ui/pull/534) by @kilhyeonjun)
- A key typed right after a chat completion (Tab or Enter on a `/` command, a suggestion, an
  image's mention) stays where it was typed. The caret was put back on the next frame, so on a
  busy phone the next key could land before the one typed just after the completion
  (`/pr-comments ba` for `ab`), and a select-all made in that time was undone.
  ([#688](https://github.com/devswha/herdr-web-ui/pull/688))
- Enter or Tab pressed right after the keystroke that narrows the `/` or `@` list completes the
  highlighted row. With a row lower in the list chosen before, the key could arrive before the
  list caught up and did nothing at all. ([#688](https://github.com/devswha/herdr-web-ui/pull/688))
- The terminal announces itself: it is a labelled region named after the pane — "Terminal for
  Idempotent payments" — so a screen reader names the pane before its content. The label is
  translated and appears only in the terminal view, not over the chat.
  ([#633](https://github.com/devswha/herdr-web-ui/pull/633) by @radicor)
- Settings keeps a slow browser-history traversal from closing the key bar editor by itself,
  and no longer retries an unanswered traversal every second.
  ([#630](https://github.com/devswha/herdr-web-ui/pull/630))
- A Claude Code approval asked while background agents run shows its card instead of the numbered
  fallback: its hint goes on after `Esc to cancel` with the chord that stops them.
  ([#659](https://github.com/devswha/herdr-web-ui/pull/659) by @Haeminway1)
- Codex Chat can read a new session with one short answer when its complete submitted
  first prompt and answer identify it unambiguously. Older conversations, unreadable
  candidates and competing panes keep the terminal fallback; process age alone never
  selects a conversation. Complete directory-less injected AGENTS.md instructions are
  hidden without hiding user messages that continue after the instructions.
  ([#650](https://github.com/devswha/herdr-web-ui/pull/650) by @od-studio-webagency)
- Terminal cleanup waits for xterm's pending frame and task before disposing its renderer,
  preventing a dimensions console error on development reloads or when switching PCs or
  signing out immediately after a pane reset.
  ([#649](https://github.com/devswha/herdr-web-ui/pull/649) by @od-studio-webagency)
- Immediate chat sends to Claude Code are refused when its input box contains a draft or is in
  bash mode, preserving the existing terminal input.
  ([#677](https://github.com/devswha/herdr-web-ui/pull/677))
- herdr in your terminal shows a pane whole again once you leave the browser tab that had it
  open. herdr holds a pane at the size of a web UI attach until that attach ends, so a desktop
  tab left open on a pane kept it at the browser's size, and herdr drew it cut off at its split's
  edge with the bottom rows out of reach; a phone hid this, since it disconnects in the background
  and its grid is narrow. A tab you are not using now lets go of the pane after a second, says it
  is paused, and takes the pane again when the tab regains focus or receives pointer input.
  Mirrored, embedded, and ended panes are not released. A message it queued is still sent first.
  ([#660](https://github.com/devswha/herdr-web-ui/pull/660) by @jiunshinn)
- **New worktree** and **Open worktree…** work from a workspace that sits on a git worktree herdr
  did not open itself: the request goes to the repository's own workspace when it is open, instead
  of failing with "New and open worktree actions start from the repo parent workspace".
  ([#685](https://github.com/devswha/herdr-web-ui/pull/685))

## [0.4.3] - 2026-10-09

### Fixed
- A web UI tab you are not using no longer resizes the pane you are using elsewhere. A window
  left open behind another app turned visible again when the screen woke, or reconnected,
  reloaded or moved on to the next pane in the background, and fitted the pane to itself: herdr
  in your terminal, or your phone, then showed the pane at that window's size, cut off at its
  edge. The tab takes the pane back once its window has the focus.
  ([#658](https://github.com/devswha/herdr-web-ui/pull/658) by @jiunshinn)
- Open tabs take turns chiming for the same alert. A question or a finish is still heard if
  the tab that claimed it closes or cannot play it, including on plain-HTTP LAN addresses.
  ([#632](https://github.com/devswha/herdr-web-ui/pull/632))
- Plugin installation and Unix launch commands find Bun in common installation locations
  when herdr starts with a bare PATH, such as from a GUI app. An existing install gets this once
  the plugin is installed again through herdr: Settings → Updates does not change the commands
  herdr runs. ([#648](https://github.com/devswha/herdr-web-ui/pull/648) by @od-studio-webagency)
- Chat reads the transcript of an omp started with `--profile <name>`, whose sessions live
  under `~/.omp/profiles/<name>/agent/sessions`; such panes showed only the terminal text.
  ([#618](https://github.com/devswha/herdr-web-ui/pull/618) by @frankjoshua)
- Chat finds an omp pane's transcript when herdr reports no session for it, or a Claude session
  where omp runs: the session file the pane's omp process holds open, or its terminal
  breadcrumb, names it. Long-running omp panes showed only the terminal text.
  ([#618](https://github.com/devswha/herdr-web-ui/pull/618) by @frankjoshua)
- Chat message and code copy buttons work on plain-HTTP LAN addresses using the browser's
  copy command when the Clipboard API is unavailable or refused. If neither method works,
  the chat explains how to copy manually instead of reporting success or throwing an error.
  ([#613](https://github.com/devswha/herdr-web-ui/pull/613) by @Kinetic27)
- Claude Code 2.1.29x approvals and questions keep their card instead of falling back to the
  numbered one: an approval with the cursor on "Yes, and don't ask again" (its hint is
  `Esc to cancel` alone, so picking that row from the card failed with "The interactive prompt
  changed"), an approval whose long command pushed its title off the screen, and a question whose
  typed-answer row already holds a draft.
  ([#614](https://github.com/devswha/herdr-web-ui/pull/614) by @Haeminway1)
- A chat message waiting for Claude Code's next turn is no longer pasted over text you typed in
  the terminal's input box. While that box holds a draft the message stays in the list with the
  reason, and **Send now** delivers it once the draft is sent or cleared.
  ([#628](https://github.com/devswha/herdr-web-ui/pull/628))
- The command palette opens on an empty search every time. It no longer shows the previous
  search's results for a moment, during which a quick Tab could highlight a different row than the
  one it focused. ([#631](https://github.com/devswha/herdr-web-ui/pull/631))
- A chat message that ends with an attached file's `@` mention is sent again. Pasted last, the
  mention left the agent's file suggestions open, and the Enter took a suggestion instead of
  sending, so the message stayed in the terminal's input box.
  ([#635](https://github.com/devswha/herdr-web-ui/pull/635))
- The arrow keys move in `less`, `git log`, `man` and other full-screen programs in the terminal.
  Such a program asks for application cursor keys, which herdr's terminal stream does not pass on
  to the browser, so the arrows arrived in the encoding the program was not reading. They are now
  sent as named keys that herdr encodes for the program in the pane, also from the phone's key bar
  and on a mirrored pane. ([#634](https://github.com/devswha/herdr-web-ui/pull/634))
- A plain left click in the terminal reaches a program that reads the mouse, such as the close
  button of Claude Code's side-by-side diff. On a desktop every left press was taken for the start
  of a selection and never sent. A drag still selects and copies, and so does a click with Shift
  (Option on macOS) held; a click on a link only opens it, a click on selected text works on the
  selection, and a mirrored pane still sends no clicks. ([#634](https://github.com/devswha/herdr-web-ui/pull/634))
- With **Quiet opened finishes** on, a finish you have not opened no longer shows as looked at
  after herdr restarts and keeps its pane ids: once the sidebar sees the restart, that PC's record
  of opened finishes is dropped, instead of keeping the entries that happen to equal the new
  session's counters. ([#623](https://github.com/devswha/herdr-web-ui/pull/623))
- A key, typed text or password sent from a page is no longer typed into the terminal when, in
  the moment before it reached herdr, that page left the pane, switched to watching, or its device
  was revoked. A password is also refused when the pane's terminal was replaced, or the page
  switched to watching and back, while its prompt was being checked.
  ([#624](https://github.com/devswha/herdr-web-ui/pull/624))
- A remote PC lists a pane's new agent at once when herdr names it without a status change (a
  pane created a moment ago, an agent started in an idle shell), instead of up to 5 seconds late.
  A page that opened the pane meanwhile took it for a shell: it opened the terminal and fitted the
  shared terminal to itself. Needs the remote PC's runtime from the next release.
  ([#625](https://github.com/devswha/herdr-web-ui/pull/625))
- Chat reads a Claude pane's conversation on a Mac set to a time format other than US English,
  such as English (UK), German, French, Japanese or Korean, when herdr's Claude integration is not
  installed. Every Claude pane there showed "Conversation unavailable" and only the terminal text.
  ([#646](https://github.com/devswha/herdr-web-ui/pull/646) by @jiunshinn)

## [0.4.2] - 2026-10-09

### Added
- Devin CLI panes with an explicitly identified native session show their active conversation
  branch and tool activity in Chat. Unresolved or unreadable sessions keep the terminal-text
  fallback. ([#438](https://github.com/devswha/herdr-web-ui/pull/438) by @Haeminway1)
- An OpenCode pane reads as a conversation. The chat shows the session herdr's OpenCode
  integration reports, read from OpenCode 2's own database: prompts with their pasted images and
  the skills they mention, each answer's steps folded into one block with their thinking, tool
  calls, outputs and pictures, commands run with `!`, background and subagent results, and
  compactions. Turns an `/undo` took back leave the chat with it. The ring by the message box
  shows the context the last step filled, as OpenCode's own footer counts it. A pane on OpenCode's
  home screen, or on a 1.x store, keeps the terminal's text.
  ([#543](https://github.com/devswha/herdr-web-ui/pull/543) by @Ploppy3)
- The app sends an anonymous count when it is installed and each time it is updated: the version,
  the OS, how it was installed and a random ID, nothing about your terminals or files, and no IP
  address is stored. A line says so the first time you open the app, and
  **Settings → About → Anonymous usage counts** shows what is sent and turns it off;
  `HERDR_WEB_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off on the server.
  ([Anonymous usage counts](docs/guide.md#anonymous-usage-counts),
  [#599](https://github.com/devswha/herdr-web-ui/pull/599))

### Changed
- The default mobile terminal key bar puts Esc, Tab and Ctrl+C first, before the held modifiers
  and arrows. Saved layouts keep their order. ([#607](https://github.com/devswha/herdr-web-ui/pull/607))
- **Settings → Shortcuts** explains which keys control the app and marks known browser/OS
  reservations without changing saved bindings. ([#607](https://github.com/devswha/herdr-web-ui/pull/607))
- **Settings → Terminal → Clipboard from a pane** is on again: vim, tmux and Claude Code copy to
  your clipboard from a pane without a trip to Settings. It is also on for anyone 0.4.1 left off
  without asking (it saved the switch with any other setting). Turn it off if a pane runs output
  you do not trust. ([#598](https://github.com/devswha/herdr-web-ui/pull/598))
- A GitHub release opens with its patch notes, short lines under New features, Improvements and
  Bug fixes as an install shows them, with the full changelog folded underneath.
  ([#598](https://github.com/devswha/herdr-web-ui/pull/598))
- The website moved to <https://herdrweb.dev/>, and the install commands with it:
  `curl -fsSL https://herdrweb.dev/install.sh | sh` and
  `irm https://herdrweb.dev/install.ps1 | iex`. Every address under
  `devswha.github.io/herdr-web-ui/`, the old install commands included, still leads to the same page
  or file there. The website can also be read in Simplified Chinese, at <https://herdrweb.dev/zh/>.
  ([#610](https://github.com/devswha/herdr-web-ui/pull/610))

### Fixed
- Command palette shortcut hints follow changed bindings and disappear for disabled ones.
  App shortcuts also recognize physical letter keys on non-Latin layouts outside IME composition.
  ([#607](https://github.com/devswha/herdr-web-ui/pull/607))
- macOS Safari direct terminal input preserves Korean syllables when the input method
  replaces text without emitting composition events, including after switching from English.
  ([#524](https://github.com/devswha/herdr-web-ui/pull/524) by @suho-han)
- **Quiet opened finishes** starts quiet the first time it is turned on in a browser even when a
  damaged record of opened finishes is left in that browser's storage; before, such a record made
  every finished agent keep its dot. In the demo, an agent started after every workspace was closed
  carries the counter that Activity order and Quiet opened finishes read.
  ([#603](https://github.com/devswha/herdr-web-ui/pull/603) by @phirschybar)
- A message starting with `/` that Claude Code does not know no longer just vanishes from the
  chat: Claude Code's own answer ("Unknown command: /…", and the arguments it dropped) shows as a
  notice, as a usage limit reached or reset does. Claude Code 2.1.29x records these as
  informational entries, which the chat left out.
  ([#600](https://github.com/devswha/herdr-web-ui/pull/600) by @Yoonwoo-Ha)
- A chat message with an invisible character in it (a zero-width space, a joiner, a byte-order
  mark, often in pasted text) no longer seems lost. Claude Code 2.1.294 takes such characters out
  and keeps the message in its input for review instead of sending it, while the chat had already
  cleared its box. The chat now shows a card with the message as Claude holds it: **Send** sends
  it, **Discard** clears Claude's input.
  ([#601](https://github.com/devswha/herdr-web-ui/pull/601) by @Yoonwoo-Ha)
- Clicking an agent's notification opens that pane on its chat, where the answer or the question
  is, also when the pane is kept on the terminal. The pane's own view is not changed: pick the
  pane or a view yourself and it is back. A shell's notification opens its terminal as before.
  ([#605](https://github.com/devswha/herdr-web-ui/pull/605) by @Xianbei233)

## [0.4.1] - 2026-10-08

### Added
- `/effort` sent from a Claude Code chat opens a card with the effort levels, low to max, so the
  level no longer has to be set in the terminal. A pick applies to this session only, as a pick
  from the `/model` card does, and leaves the default for new sessions alone. `/effort` is also in
  the chat's command list now.
  ([#594](https://github.com/devswha/herdr-web-ui/pull/594),
  [#523](https://github.com/devswha/herdr-web-ui/pull/523) by @suho-han)
- Settings → Terminal has a **Clipboard from a pane** switch, off by default: a program running in a
  pane can no longer put text on your clipboard unless you turn it on. Programs that copy this way
  (vim, tmux, Claude Code) copy again once it is on.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- The guide's **Behind a reverse proxy** shows how to give the app a public HTTPS address with
  [Portal](https://github.com/gosuda/portal-tunnel) v2.6.1 or later, behind a long random token
  and with a visitor's `Tailscale-User-Login` header dropped.
  ([#229](https://github.com/devswha/herdr-web-ui/pull/229) by @rabbitson87)
- **Settings → Appearance → Agents order → Activity** keeps a waiting agent on top of the Agents
  list and orders the rest by their latest state change, as herdr's agents panel keeps the latest
  work in view: the agent you just sent a message to stays on top while it runs and after it
  finishes, and a new one starts there. herdr's own order and the workspace rows are unchanged.
  **Workspaces** (herdr's order) remains the default.
  ([#529](https://github.com/devswha/herdr-web-ui/pull/529) by @phirschybar)
- **Settings → Appearance → Quiet opened finishes** (off by default): a finished agent you have
  opened in the web UI loses its dot and reads as ready, as viewing it in herdr would make it.
  herdr's DONE otherwise stands until herdr itself shows the pane. It is remembered per PC in
  this browser. ([#529](https://github.com/devswha/herdr-web-ui/pull/529) by @phirschybar)

### Changed
- A wrong access token is refused with a growing wait after five tries, up to a minute, whether it
  is typed into the sign-in form or sent with a request. Each visitor behind `tailscale serve` has
  their own count, and a browser holding an old token never stops you signing in with the new one.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- The app now sends itself a Content-Security-Policy, so third-party content rendered in a chat —
  math, agent marks — cannot run script in the app.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A web-push subscription must be an https endpoint.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)

### Fixed
- Gajae Code's selection menus show their choices instead of only arrow-key buttons, including
  startup selectors shown before the pane reports that it is waiting. Answers move to the selected
  row and recheck the menu before confirming.
  ([#593](https://github.com/devswha/herdr-web-ui/pull/593))
- Secret input and the Codex follow-up fallback validate the live screen, so a password
  prompt or collapsed question queue in scrollback cannot send input into the current program.
  ([#566](https://github.com/devswha/herdr-web-ui/pull/566))
- The PC's Tailscale login is read from a real Tailscale user id. These ids are too large for a
  JavaScript number, so the owner was not recognised and the owner's own devices had to pair. Two
  logins with neighbouring ids are also no longer taken for one.
  ([#572](https://github.com/devswha/herdr-web-ui/pull/572))
- On Windows, a Claude Code pane started with a second account's `~/.claude-*` directory as its
  `CLAUDE_CONFIG_DIR` shows its chat. Before, the pane fell back to `~/.claude`, so the chat said
  **Conversation unavailable** and only the terminal worked. Windows does not let the server read
  another process's environment, so the store is the one among the server's own
  `CLAUDE_CONFIG_DIR`, `~/.claude` and the `~/.claude-*` directories beside it that holds the
  Claude process's own record, checked against the time the process started. A directory
  elsewhere is not looked in. Claude Code processes reported as `claude.exe` are
  recognized too.
  ([#563](https://github.com/devswha/herdr-web-ui/pull/563) by @David-Sousa-Web)
- A long line of brackets, `\(` or underscores that never close, as an agent prints in a log or a
  minified file, no longer freezes the chat: a megabyte of them took a minute or more to read, and
  now takes milliseconds. What every message shows is unchanged.
  ([#574](https://github.com/devswha/herdr-web-ui/pull/574))
- On a mirrored pane (Windows, where herdr cannot attach a terminal), text typed while a message
  was still being sent no longer reaches the pane once you have left it, or left it and opened it
  again, before the text's turn came.
  ([#576](https://github.com/devswha/herdr-web-ui/pull/576))
- The plugin's `start` keeps the app on its port when the app's own server holds it but cannot
  reach herdr. It used to move the app to another port beside the running one and blame another
  program; now it says that the app runs there without herdr and exits, and the app answers
  again on its port once herdr is back.
  ([#577](https://github.com/devswha/herdr-web-ui/pull/577))
- On Windows, a Codex pane shows its chat when Codex stored its paths with the `\\?\` prefix, as
  it does for a canonical Windows path (`\\?\D:\work` for `D:\work`). Before, the chat said
  **Conversation unavailable**: the session's file seemed to lie outside Codex's store, and none of
  the threads matched the pane's directory as herdr reports it.
  ([#582](https://github.com/devswha/herdr-web-ui/pull/582) by @David-Sousa-Web)
- In a Claude Code pane, the chat shows what a slash command answered, so a `/goal` that Claude
  Code refuses says why in the chat instead of only in the terminal. `/goal` is also among the
  commands the message box suggests.
  ([#583](https://github.com/devswha/herdr-web-ui/pull/583))
- Settings opened over a file preview is visible above it; Escape and Back close Settings
  first, preserving the preview and its history entry until the file itself is closed.
  ([#568](https://github.com/devswha/herdr-web-ui/pull/568))
- Command palette buttons keep their native Enter action; IME commit and cancel keys
  stay with text input, and arrow navigation keeps the selected result visible.
  ([#567](https://github.com/devswha/herdr-web-ui/pull/567))
- Long drafts in the message box wrap and keep a narrow scroll cue in reserved space, so the
  scrollbar no longer covers text at fractional zoom.
  ([#522](https://github.com/devswha/herdr-web-ui/pull/522) by @suho-han)
- A secret sent from a pane you then left and opened again, while another browser kept the pane
  open, is no longer typed into the pane: you send it again from the pane you opened.
  ([#588](https://github.com/devswha/herdr-web-ui/pull/588))
- A Claude Code slash command whose answer holds a long run of broken terminal escape codes no
  longer stalls the server while the chat reads it. Its answer also drops a link cut off before
  its end and a stray `B` after a charset switch, and an answer with both output and errors
  shows both.
  ([#588](https://github.com/devswha/herdr-web-ui/pull/588))
- The command palette opened over Settings and a file preview shows above both, instead of
  taking the keyboard unseen beneath them.
  ([#588](https://github.com/devswha/herdr-web-ui/pull/588))
- The plugin's `start` no longer takes another program on the app's port for the app because
  its answer says `ok`: it treats it as any other program there, moving the app to a free port,
  or saying the port is taken when `PORT` is set.
  ([#588](https://github.com/devswha/herdr-web-ui/pull/588))
- A 500 from the server no longer repeats the system's own error text, which carried absolute paths
  and the herdr socket location; it names a short id you can quote in a bug report instead.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- Settings, the command palette, the file viewer, the file browser and the new-workspace dialog keep
  Tab inside them and give the focus back to whatever opened them.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- The tabs of a workspace name the pane region they govern, so a screen reader announces the tab and
  the pane together.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- Agent headings in a chat no longer pose as the app's own page structure; they sit below the app's
  own headings and look the same as before.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- The "reconnecting" line and the composer's terminal-only hint are announced when they appear.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A chat locked out by the token gate, the "Last checked" line under Settings → About (with its
  date in your language) and a remote PC's state word in the sidebar are translated like the rest of
  the UI.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- The alerts menu item now says the same thing the same way in every state.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- Held terminal input typed while disconnected is forgotten after a day.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A link printed in the terminal opens only if it is an http(s) address, on both link paths.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A second tab open on one pane no longer sends a message the first tab is already sending: it
  sees that send on its way and holds back. Two tabs that press Send at nearly the same moment can still
  both send it.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A row's ⋯ menu is capped to the room its button leaves and scrolls instead of being cut off by the
  viewport, so the pane picker of a tab with many panes keeps every entry reachable with the pointer
  as well as the keyboard. Before, items below the fold were rendered but unreachable.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A row menu open while the window crosses the 640 px breakpoint now switches between bottom sheet and
  popover instead of keeping the form it opened with.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- The workspace drawer a narrow window opened is closed again when the window is widened past 768 px,
  so narrowing it no longer brings back a drawer and its scrim unasked.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- **Add PC**, **Reconnect PC** and **Update remote bridge** open as a bottom sheet on a phone, like
  every other dialog, and keep clear of the on-screen keyboard. Before, the one native dialog stayed
  a centred card on a phone.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- **Remove PC**'s first click is a quiet ghost button that only arms the removal; the second is the
  red one, as revoking a device already was.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A PC's rename, connect and disconnect buttons disable while their request is in flight, so a double
  click no longer sends two overlapping requests.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A failed pane or workspace rename keeps the field open with what you typed, so a network blip no
  longer makes you write the name again.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A workspace reorder that fails no longer undoes a later, successful reorder.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- A tab watching several busy panes gives up its oldest cached conversation answers when they grow
  past a byte budget, not only past sixteen of them.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- The usage meters' note is the same size as every other advisory and empty state.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- The PDF viewer's page colour, the pill radii, the tab dot and the pairing-code size come from
  design tokens now, and the pairing code follows the compact density setting.
  ([#570](https://github.com/devswha/herdr-web-ui/pull/570) by @radicor)
- Updating an already current remote bridge verifies and reuses it without downloading or
  restarting it again, while a bridge from a newer app is left running instead of downgraded.
  A PC that waits on such a conflict says so in the sidebar and under the header, with a
  **Reconnect** button, instead of asking for setup approval.
  ([#519](https://github.com/devswha/herdr-web-ui/pull/519) by @suho-han)
- A wrong access token sent through a proxy on this PC with a made-up `X-Forwarded-For` address
  that itself says " via " now counts against the limit every visitor through that proxy shares,
  like any other wrong token. Before, each such try started a fresh count.
  ([#592](https://github.com/devswha/herdr-web-ui/pull/592))
- A web-push subscription must be an https address, with no exception for this PC, and an alert is
  never sent on where a push service redirects it, so an alert can never be posted to a service
  running on this PC. ([#592](https://github.com/devswha/herdr-web-ui/pull/592))
- In the **Add PC** dialog opened over a file preview, Tab moves through the dialog's own controls
  and Escape closes the dialog alone, leaving the preview beneath it open.
  ([#592](https://github.com/devswha/herdr-web-ui/pull/592))

## [0.4.0] - 2026-10-08

### Added
- An update tells what it brings before it is installed. **Settings → About** shows
  **What's new** under the version on offer: the changelog of every release the update installs,
  newest first, read from the release itself. The line under the header has a **What's new**
  button that opens Settings there. The notes come from the version that is running, so they
  appear from the update after this one.
  ([#535](https://github.com/devswha/herdr-web-ui/pull/535))
- An update also tells what it brought once it is installed. After the reload, the line under
  the header says which version now runs, with **What's new** and **Dismiss**, for a week or
  until it is closed on that device, and **Settings → About** keeps the notes under
  **What the last update brought**. These come from the new version itself, so they appear
  with the first update to a version that has them.
  ([#560](https://github.com/devswha/herdr-web-ui/pull/560))
- A release is told the way a game's patch notes are, before and after its install: a short
  list under **New features**, **Improvements** and **Bug fixes**, in the app's language
  (English, Korean, Japanese or Chinese). The changelog entries are folded under
  **Show every change**. A release that wrote no such list shows its entries as before.
  ([#560](https://github.com/devswha/herdr-web-ui/pull/560))
- The one-line installers can give the GitHub star they mention. On a first install, when the gh
  CLI is signed in and that account has not starred the repository, `install.sh` and `install.ps1`
  ask once at the terminal and star only on `y`. An account that already starred hears nothing.
  Without a terminal, as under a script or in CI, nothing is asked, and a question nobody answers
  goes on by itself after 20 seconds. `install.ps1` did not mention the star before.
  ([#550](https://github.com/devswha/herdr-web-ui/pull/550))
- **Settings → Appearance → Sidebar rows** chooses between **Two lines** and **One line**. On two
  lines, the default, a workspace row shows what its agent is doing, with the workspace and
  folder under it, as the sidebar did before its rows became one line. **One line** keeps the
  workspace's name alone.
  ([#521](https://github.com/devswha/herdr-web-ui/pull/521),
  [#559](https://github.com/devswha/herdr-web-ui/pull/559))
- A right-click on a workspace or pane row in the sidebar opens the row's menu, the one its `⋯`
  button opens. ([#521](https://github.com/devswha/herdr-web-ui/pull/521))
- The sidebar can be resized: drag its right edge, or focus the edge and use the arrow keys.
  A double-click returns to the default width. The width is remembered on each device, and the
  sidebar never takes more than half the window.
  ([#521](https://github.com/devswha/herdr-web-ui/pull/521))
- The mobile terminal key bar has sticky Ctrl, Alt and Shift toggles and an Enter key.
  Herdr encodes held combinations with arrows, special keys and direct typing for
  the pane's keyboard protocol. Modifiers clear when leaving
  the pane or disconnecting. Pasted text and submitted drafts keep their contents.
  Queued terminal chords and text are cancelled when the sender leaves their attachment or
  its terminal is replaced.
  ([#433](https://github.com/devswha/herdr-web-ui/pull/433) by @nickadminroot,
  [#508](https://github.com/devswha/herdr-web-ui/pull/508))
- Settings can add, remove and reorder every mobile terminal key and register custom key
  combinations in a separate key bar editor. Existing extra-key preferences keep their keys and order,
  and Restore defaults returns the original bar. Native clipboard shortcuts on non-Latin keyboards
  and existing Alt combinations remain intact. ([#508](https://github.com/devswha/herdr-web-ui/pull/508))

### Changed
- The terminal's **Input held until the terminal is ready** notice appears only when there is
  text to send or discard, or when text was too long to hold. It no longer counts "special
  keys dropped": the count rose without a key being pressed, with every answer the terminal
  gives a program by itself, and with nothing held the notice had only a dash to show. Text
  past the 1,024 characters it holds is now told as left out, where it only raised that count.
  ([#561](https://github.com/devswha/herdr-web-ui/pull/561))
- Settings shows one page at a time. A list of pages (Appearance, Chat, Terminal, Alerts, Voice
  input, Subscription usage, Shortcuts, Phone & devices, Remote PCs, About) stays beside the open
  page; on a phone the list comes first and a page opens from it. Each page groups its settings
  in cards, one control at the end of each row, and a phone no longer scrolls through every
  setting to reach the last. What moved: the terminal's font, wheel speed, input mode and
  **Key bar** from Appearance to **Terminal**; Composer and Quick replies into **Chat**; Phone,
  Install and Devices into **Phone & devices**; Updates and herdr into **About**. Colors and
  Language are menus now, and Language lists English, 简体中文, 日本語, 한국어 in that order after
  System. Every setting keeps its value. The Back button of a phone or a browser
  steps out of Settings (the key bar editor, the page, then the dialog) instead of leaving the app.
  ([#562](https://github.com/devswha/herdr-web-ui/pull/562))
- The mic button shows in a desktop's chat without being turned on. **Settings → Voice input →
  Microphone button** is now **Auto**, **On** or **Off**. Auto, the default, puts the mic in the
  chat's message box on a desktop, and only where dictation can work: over HTTPS, with an OpenAI
  key or a browser that recognizes speech. A phone and the terminal input line have it when the
  setting is **On**, as before. Nothing is recorded until the mic is pressed. A device that had
  the button on keeps it; one that had it off follows Auto.
  ([#559](https://github.com/devswha/herdr-web-ui/pull/559))
- On a phone, the sidebar's **Agents** list starts folded, leaving the drawer to the workspaces.
  A tap on its heading opens it. ([#559](https://github.com/devswha/herdr-web-ui/pull/559))
- On a touch screen, the chip above the message box that takes Claude Code's suggested next
  prompt is on again unless **Settings → Chat → Suggestion chip** turns it off.
  ([#559](https://github.com/devswha/herdr-web-ui/pull/559))
- Every agent's chat uses one compact Send/Stop button on desktop and phones. Sending during
  work schedules a next-turn message; its explicit ↑ Send now action delivers it immediately,
  or X discards it. The bridge claims each message once and pauses automatic delivery when
  the connection changes, including during delivery and when a request races the end of a turn.
  While a draft shows Send in Stop's place, Escape in the message box stops the agent.
  A remote PC whose bridge is older than this keeps the draft during work and asks for an
  update; its messages held by earlier versions keep their own Send now.
  Chat status words stay hidden, and desktop plan usage shows the five-hour limit first with
  weekly fallback; phones omit the compact quota.
  ([#520](https://github.com/devswha/herdr-web-ui/pull/520))
- The message box follows **Settings → Chat font size**, as the transcript and prompt cards
  already did: with a mouse it is typed at the transcript's size, and on a touch screen it
  grows with a size above 16px (it stays at 16px or more, so iOS still does not zoom).
  ([#515](https://github.com/devswha/herdr-web-ui/pull/515) by @phirschybar)
- Workspace rows no longer reserve a left column for a reorder grip. Rows can still be dragged
  directly or moved with Alt+Up/Down while focused.
  ([#521](https://github.com/devswha/herdr-web-ui/pull/521))
- The sidebar follows herdr's separate workspace and agent lists, drawn on one quiet grid. Every
  row leads with the coding agent that runs in it (its mark, or a terminal for a shell and a
  branch for a worktree without an agent) and ends in one status column, drawn by urgency (a red question mark waits for an answer, a
  green dot has finished and was not looked at yet, a dim arc runs), which stays empty while
  an agent is ready. Agent rows name the agent, then the PC when there are several, the workspace
  and the tab. Sections are parted by space instead of rules, a row's menu button takes no room
  until the row is hovered or selected, and a workspace row starts with a folder: where linked
  worktrees sit under the workspace, the folder folds them, and folded it shows how many it
  holds and the most urgent state among its checkouts. A PC's fold sits beside its `+`. A pane herdr could
  not restore shows a warning glyph,
  and the background-task count sits on agent rows.
  Workspace rows keep their names, and agents open their panes directly. Tab and pane navigation
  stays in the tab strip and palette.
  ([#521](https://github.com/devswha/herdr-web-ui/pull/521))
- The sidebar no longer opens with a **Needs you** list of waiting panes. A pane that waits
  shows its state on its workspace row and its row in **Agents**, and the alerts are unchanged.
  ([#521](https://github.com/devswha/herdr-web-ui/pull/521))
- **Settings → Appearance → Sidebar grouping** is gone, and with it the **By folder** view that
  listed panes under their working directory. The sidebar always lists workspaces, a repository's
  worktrees under it. A device that had chosen **By folder** shows workspaces again; its workspaces
  and panes are untouched.
  ([#556](https://github.com/devswha/herdr-web-ui/pull/556))
- Opened worktree branches appear beneath their repository workspace, using actual branch names
  from herdr's worktree API and keeping custom workspace names beside them. Creating or opening
  a worktree expands its group. The browser demo supports these worktree actions with fictional
  checkouts too. ([#521](https://github.com/devswha/herdr-web-ui/pull/521))
- A linked worktree's row in the sidebar is titled by its workspace name, the one its owner gave it
  or the one herdr made from the branch, instead of the branch; the branch follows in dim text
  where the name does not already say it, and in the row's tooltip and menu. The sidebar's mark
  for an agent waiting for an answer is a red question mark instead of a filled speech bubble;
  a finished one keeps its green dot.
  ([#557](https://github.com/devswha/herdr-web-ui/pull/557))

### Fixed
- A pane whose agent has just started is listed as an agent's pane within a moment, where the
  list on this PC could take up to 5 seconds to say so. A device that opened the pane in that
  time took it for a shell: it opened the terminal instead of the chat, and resized the
  terminal shared with the other devices.
  ([#537](https://github.com/devswha/herdr-web-ui/pull/537))
- A message can no longer freeze or crash the chat by its shape alone. A long run of underscores
  nested emphasis until the page ran out of stack; a URL followed by thousands of closing
  parentheses, a formula opened on many lines and never closed, a long blank line under a table
  header, a list item of thousands of lines, and a heading or list item holding a line-separator
  character after a long run of spaces each took seconds to read; a line of plus signs took half
  a second, and a formula of thousands of nested fractions a second more. Each is read in a few
  milliseconds now. Emphasis stops nesting after sixteen levels, and a formula nested deeper than
  a hundred braces shows as its source.
  ([#547](https://github.com/devswha/herdr-web-ui/pull/547))
- A workspace row's state rolls up as herdr's does: a workspace with one finished agent and one
  still running shows DONE, where it showed RUN.
  ([#521](https://github.com/devswha/herdr-web-ui/pull/521))
- Codex chat hides internal memory citation blocks and pairs the answer with its display record,
  so a reply that uses memory appears once without raw citation markup. Quoted code examples
  keep their text. ([#514](https://github.com/devswha/herdr-web-ui/pull/514) by @JJLiebig)
- An in-app alert and its sound are no longer lost now and then: when the list of panes showed
  a pane waiting or finished a moment before the status change itself arrived, the open app
  took the change for old news and said nothing. A finished turn is also measured from its own
  start in that case, so a short turn is not told as a long one.
  ([#536](https://github.com/devswha/herdr-web-ui/pull/536))
- **Dismiss** on the terminal's notice that input was not sent works: a tap or click on it went
  through to the terminal under it and the notice stayed.
  ([#508](https://github.com/devswha/herdr-web-ui/pull/508))
- The Claude usage meter shows a model's own weekly limit, such as Fable's, which Anthropic
  reports only in its list of limits; the Opus and Sonnet weeks are still read as before.
  ([#532](https://github.com/devswha/herdr-web-ui/pull/532) by @bertkiefer)
- A Claude or Codex question asked right after a message that began with a number ("1. …") shows
  as a question card in the chat again. The sent message, still on screen above the question, was
  read as an option of its own, so the question fell back to a card of arrow keys. Option
  descriptions that wrap over two lines are shown whole, not cut off at the first line.
  ([#517](https://github.com/devswha/herdr-web-ui/pull/517) by @kilhyeonjun)
- With `HERDR_WEB_TAILSCALE_SERVE_ONLY=1`, which declares `tailscale serve` the only way in, your
  own phone lands in the app as soon as it opens the `tailscale serve` address, with no pairing
  code, on a tailnet that one Tailscale login owns and that has no tagged node on it. Before,
  `tailscale serve` states no login for some of those requests, and every request without one was
  taken for a tagged node's and asked to pair. Off by default, such a request still pairs. Another
  Tailscale login is still refused, a tagged node still pairs, Funnel stays closed, a LAN client
  that claims the same headers still gains nothing, and a configured token is still required of
  everything but a paired device.
  ([#525](https://github.com/devswha/herdr-web-ui/pull/525) by @jetmobsol)

## [0.3.52] - 2026-10-06

### Added
- A PC whose connect or reconnect is refused on the bridge version check now offers
  **Update bridge and connect** in its dialog, so a PC that was never registered — no sidebar
  row, no saved key — can be updated and connected in one go, through the same approval list
  a first install shows. ([#506](https://github.com/devswha/herdr-web-ui/pull/506) by @suho-han)
- A lilac palette in Settings → Appearance → Colors: one quiet lavender with indigo ink and accent
  in light, and the same hue at night in dark.
  ([#443](https://github.com/devswha/herdr-web-ui/pull/443) by @WOULDU-pres)
- New workspace's **Browse** filters the loaded folders in the current directory as you type.
  Navigation clears the filter, and a truncated listing says when search covers only the first
  500 folders. ([#430](https://github.com/devswha/herdr-web-ui/pull/430) by @suho-han)
- The usage meters read OpenCode Go's limits too: its rolling session, the week and the month,
  with the key OpenCode keeps in `~/.local/share/opencode/auth.json` (under `XDG_DATA_HOME`
  when it is set) or the `OPENCODE_API_KEY` variable. An OpenCode key without a Go
  subscription shows no meter.
  ([#444](https://github.com/devswha/herdr-web-ui/pull/444) by @diogo7dias)

### Changed
- The README answers common questions about installation, Windows support, phone access,
  privacy and deployment, in English, Korean, Japanese and Chinese.
  ([#495](https://github.com/devswha/herdr-web-ui/pull/495))
- The website says what it is for in its title and description (Claude Code and Codex from your
  phone), answers seven common questions in a new FAQ section, and gives search engines a sitemap
  and structured data for the app and the FAQ.
  ([#497](https://github.com/devswha/herdr-web-ui/pull/497))
- The website's headline is "Run herdr from anywhere.", and the page catches up with the app:
  the Windows install command, pi among the native transcripts, the Alt key and a card for voice
  input. Its figures now show the contributor count and the plugin's place by stars among herdr
  plugin repositories, and the comparison with other phone clients was read again in October 2026.
  ([#494](https://github.com/devswha/herdr-web-ui/pull/494))
- On macOS a Codex pane's chat costs the server about a sixth of what it did on each poll (a
  median of 16 ms instead of 103 ms, measured on two live Codex panes). The store a Codex process
  writes to is remembered for its pid and arguments instead of being read with `ps` every 2 s,
  and the rollout it has open is found with one `lsof` run for the pane's processes (a wrapper
  and the binary are two) that skips the stat calls a name does not need.
  ([#491](https://github.com/devswha/herdr-web-ui/pull/491) by @kilhyeonjun)
- The app's startup script is a fifth smaller (408 kB to 331 kB gzipped, and 48 kB to 39 kB of
  CSS): KaTeX, which draws math in the chat, loads with the first reply that has an expression.
  Until it arrives, that expression shows in its source form, as it did when KaTeX could not read it.
  ([#493](https://github.com/devswha/herdr-web-ui/pull/493) by @kilhyeonjun)

### Fixed
- A Claude Code pane started with its own `CLAUDE_CONFIG_DIR` (a launcher such as cac keeps one
  store per environment) shows its chat. Before, only `~/.claude` was searched, so the chat was
  unavailable and only the terminal worked. The store is read from the pane's Claude process, as
  for Codex's `CODEX_HOME`, else from the server's own `CLAUDE_CONFIG_DIR`, else `~/.claude`.
  On macOS the pane's session is also found from Claude's own process record when herdr's hook
  has not reported one, as it already was on Linux. Node-based Claude processes reported by
  their `argv0` title are recognized too.
  ([#504](https://github.com/devswha/herdr-web-ui/pull/504) by @leo1oel)
- With Language set to **System**, English stays selected when it is the browser's first
  supported language, even if Japanese, Korean or Chinese appears later in its preferences.
  Before, English was skipped in favor of a later supported language.
  ([#496](https://github.com/devswha/herdr-web-ui/pull/496) by @snowykr)
- An OmO pane's chat keeps a background task's title after the newest page moves past the prompt
  that started the task, as 0.3.51 meant to. Before, the title was kept only when a transcript
  deleted earlier had used the same inode (as Linux reuses them) and left its titles behind, and
  such a transcript's titles could name another session's tasks with the same id.
  ([#498](https://github.com/devswha/herdr-web-ui/pull/498) by @kilhyeonjun)
- An OmO pane that asks you a question reads INPUT until you answer. Before, a question OmO
  waits on read RUN, and one it asks without waiting (it keeps working, or ends its turn, with
  the question folded over its input box) read RUN or DONE.
  ([#488](https://github.com/devswha/herdr-web-ui/pull/488))
- A question OmO asks without waiting gets its card in the chat: tap an option, or type a reply
  to answer it. Before, the chat showed no card for it, so an option could only be picked in the
  terminal. ([#488](https://github.com/devswha/herdr-web-ui/pull/488))
- A Claude, omp or pi pane that has just started opens its chat on the greeting ("What should
  Claude do in …?"), as an OmO pane already did. Before, until the first message the chat
  showed the terminal's text or an empty line instead, so a new workspace or worktree never
  greeted you. ([#500](https://github.com/devswha/herdr-web-ui/pull/500))
- `/model` sent from a Claude Code pane's chat shows Claude's model list as a card: tap a model,
  or type its number, and that pane's session switches to it. Before, the chat showed nothing
  while the terminal waited on the list, so a model could only be picked there. The card picks
  for this session only (Claude's `s` key). Saving a model as the default for new sessions stays
  in the terminal, where Enter on the list does it. The card offers the rows Claude draws (ten of
  a longer list, fewer in a short pane) and says how many more the terminal lists.
  ([#501](https://github.com/devswha/herdr-web-ui/pull/501))
- `/model` sent from a Codex pane's chat shows Codex's lists as cards, one after the other: the
  models, then the reasoning levels of the model you pick. The level you pick applies to that
  pane's session only (Codex's `s` key). Saving a default stays in the terminal, where Enter
  does it. Open "More reasoning…" in the terminal; once open, its Max and Ultra options can also
  be picked for this session from the chat. Before, the chat showed nothing while the terminal
  waited on the list.
  ([#503](https://github.com/devswha/herdr-web-ui/pull/503))

### Maintenance
- Browser regressions run on macOS as well as Linux, with portable fixtures and bounded
  readiness checks. ([#499](https://github.com/devswha/herdr-web-ui/pull/499) by @kilhyeonjun)
- Isolated test panes start at a shell prompt even where zsh includes its new-user wizard.
  ([#502](https://github.com/devswha/herdr-web-ui/pull/502))
- The website serves the Google Search Console ownership verification file.
  ([#505](https://github.com/devswha/herdr-web-ui/pull/505))

## [0.3.51] - 2026-10-06

### Added
- **Open here** on a held pane explicitly takes it from another web bridge or standalone
  `herdr terminal attach`. A displaced bridge waits with the same button; it never takes the pane
  back automatically. Available on supporting bridges, for interact connections only.
  ([#368](https://github.com/devswha/herdr-web-ui/pull/368) by @WOULDU-pres)

- The terminal's key bar on a touch screen has an **Alt** key beside Ctrl. Like Ctrl it holds for
  one key: Alt then a letter, Backspace or Enter sends ESC before it, and Alt then an arrow sends
  Alt+arrow. **Settings → Appearance → Key bar** turns Alt off or adds Shift+Tab, Home/End,
  PgUp/PgDn, Ctrl+D, Ctrl+Z, `|`, `~` and `/`, each in a fixed place in the row. Esc, Tab, Ctrl,
  the arrows and Ctrl+C stay as they were. ([#487](https://github.com/devswha/herdr-web-ui/pull/487))

### Fixed
- A tab strip you scrolled yourself to look at other tabs stays where you left it when a
  typeface arrives late and redraws the tabs' names at another width. Before, the strip
  brought the open tab back into view then; it still does so until you have scrolled it.
  ([#479](https://github.com/devswha/herdr-web-ui/pull/479))
- On macOS, a gjc pane's chat finds its session from the terminal breadcrumb gjc leaves. Before,
  the process start time it is matched by was read as UTC, so on any other time zone every fresh
  breadcrumb looked hours old and was passed over. Process start times, which Codex, OmO and gjc
  panes are matched by, are now read on macOS too (they were only read from Linux `/proc`).
  ([#484](https://github.com/devswha/herdr-web-ui/pull/484) by @kilhyeonjun)
- The chat of a Codex pane started with its own `CODEX_HOME` (a launcher that keeps one store
  per profile) shows its conversation. Before, the server looked for every rollout under its own
  `CODEX_HOME` or `~/.codex`, found none for that pane and fell back to the terminal scrollback.
  The store is now read from the pane's Codex process (its environment), for the conversation,
  images, tool output and queued questions; a configured Codex home still wins.
  ([#486](https://github.com/devswha/herdr-web-ui/pull/486) by @kilhyeonjun)
- The chat shows the card for a question Claude Code asks with `AskUserQuestion` in three
  layouts it missed: options that carry a preview (drawn in a box to the right of the options,
  with a notes line and an unnumbered "Chat about this"), a question asked while Claude keeps a
  task list under its panel (`3 tasks (0 done, 3 open)` and a row per task), and a named
  session's rule drawn under the question with no task list. Before, the first showed the
  fallback card and the other two were taken for answered questions, so the chat showed none.
  ([#485](https://github.com/devswha/herdr-web-ui/pull/485) by @kilhyeonjun)
- A table in the chat that is wider than the reply scrolls sideways in its own box. Before, it
  squeezed every column to fit, down to a letter or two, so words and file paths broke after
  any letter. A column is now never narrower than its longest word.
  ([#481](https://github.com/devswha/herdr-web-ui/pull/481) by @aNNdii)
- In the chat of an OmO pane, a background task that ends shows where OmO reported it: a
  card that says how many tasks ended, and for each its summary, whether it finished, failed
  or was cancelled, the agent and model it ran as, how long it took, its turns, tool calls and
  tokens, and its answer on request. Before, the chat showed nothing when a task ended, and
  what the agent did after it ran on in the same block as if nothing had come in. The `task`
  row reads the summary the call gave its task instead of its short description, and opened
  it lists each task it started with its agent and prompt, instead of its raw input or a
  checklist of "task 1", "task 2" nobody ticks.
  ([#477](https://github.com/devswha/herdr-web-ui/pull/477) by @nahwan-kim)
- In the chat of an OmO, omp, gjc or pi pane, an answer stays an answer when the agent wakes
  again after it on its own, for a monitor's event or a background command that ended. Before,
  what it did after the wake-up ran into the same turn, and the answer, a whole review for
  example, was folded away under "Worked for" while the terminal showed it.
  ([#483](https://github.com/devswha/herdr-web-ui/pull/483))

## [0.3.50] - 2026-10-06

### Changed
- The app brings its own typefaces instead of counting on the ones a device has: Pretendard for
  the interface and the chat, and JetBrains Mono for code in the chat and the interface, so a
  phone or a PC without them draws Latin text and Korean in the same letters as one with them.
  Japanese and Chinese are not the same everywhere: Pretendard has kana and only a few hundred
  ideographs, so kanji and Chinese text are still drawn in the device's own font, and a Japanese
  line mixes the two. Nothing is fetched from the internet: the files come from your own PC
  with the app, a page downloads only the pieces of
  Pretendard its text needs (about 90 KB for a chat in English, about 200 KB more once Korean
  is on the page), and each piece is kept for offline use after that. The terminal is untouched: its
  font, its **Terminal font** setting and its grid are as before, and a **Chat font** you chose
  still comes first. In the chat, answers, your own messages and what the agent says while it
  works are a step larger (15px at the default **Chat font size**, which still scales
  everything) on a looser line; bold is a semibold; inline code sits a little under its line and
  code blocks are a step larger with more room; the message box is typed at the same size with
  a mouse and stays 16px on touch; the empty chat's question is a larger line. Tool rows, times
  and other small labels keep their size.
  ([#473](https://github.com/devswha/herdr-web-ui/pull/473))
- In the chat's message box the agent's mark, the model, the reasoning level and the context
  ring sit together in one quiet pill, and the model is shown by its name where the id is a
  regular one: `claude-opus-5-5` reads **Opus 5.5**, `claude-sonnet-5` **Sonnet 5**, `gpt-5.6`
  **GPT-5.6**, `gpt-5.6-sol` **GPT-5.6-Sol**, `glm-5.3` **GLM-5.3**, and the level follows as **High**. No name is ever
  guessed: any other id (a dated snapshot, a suffix such as `gpt-5.6-sol-max`, another provider's
  prefix, another vendor, a spelling that is not the vendor's own such as `claude-sonnet-5-05`) is
  shown exactly as received, in the code font. Behind a name the id
  as received is in the name's tooltip and is read by a screen reader; on a touch screen it is
  not shown yet. A pane that records no reasoning level shows the name alone. The pill only shows the model, it is not a button yet. Where the
  pill does not fit beside Queue (seen on a 390px phone) it steps aside whole while Queue is
  showing, and the context ring stays.
  ([#467](https://github.com/devswha/herdr-web-ui/pull/467))
- In the chat, the line with the model sits inside the message box, as its last row, instead of
  above it, on a phone as on a desktop. It shows the agent's mark, background tasks, the model,
  the reasoning level as one word (`high`) and the context ring. The agent's written name and the
  READY / RUN / INPUT word are no longer drawn there (a screen reader still reads them): the
  header names the pane, and Stop, the working row and the approval card say the state. DONE is
  still drawn, since nothing else in the chat says a turn ended and has not been seen. Where
  the box is narrow, beside the sidebar for one, the background-task chip shows its count
  before the model's name is cut. In dark themes Queue loses its outline.
  ([#456](https://github.com/devswha/herdr-web-ui/pull/456))
- The chat's message box is laid out like a chat app's: a rounder card with the message on top
  at the card's full width, and one row of controls under it. On the left a **+** button
  attaches files (it was a paperclip) and the background-task chip follows it; on the right are
  the model, the reasoning level and the context ring, then one round button. Send is an arrow
  pointing up, and Stop is the same circle in the same place, so only the glyph changes when a
  turn starts and ends. While the agent works, Queue appears once the box holds text or a
  file that is still uploading; with an empty box Stop is the only button, and Queue still holds a message only
  when you press it, after which the keyboard's focus is back in the message box. Where the two
  do not fit side by side (a phone, or a long model name beside the sidebar) the model's name
  steps aside while Queue is showing, so neither is cut; without Queue the reasoning level
  steps aside before the name loses a letter. While reconnecting, "Reconnecting… message held here, never queued" is said once: in
  the empty box, and under the model once there is a draft, on a phone too, where it used to be
  hidden. It is no longer cut with an ellipsis, and neither is "Uploading file…"; Queue is not
  shown while not connected, and a disabled Stop loses its colour. With a mouse, the bar that
  resizes the box shows when the pointer is over the box, while dragging, on keyboard focus
  and while a height is set by hand; on a touch screen it is always shown.
  ([#465](https://github.com/devswha/herdr-web-ui/pull/465))
- The chat is wider on a large screen: the conversation and the message box follow the pane,
  at least 820px and at most 960px wide, 71% of the pane between. A laptop window keeps the
  820px it had and a large monitor grows to 960px. Settings → Chat → **Chat width** chooses
  **Narrow** (820px, as before), **Default**, **Wide** (1152px) or **Full**, the whole pane.
  The held messages, the approval card and the background-task list keep the same column.
  Phones and narrow panes look the same as before.
  ([#463](https://github.com/devswha/herdr-web-ui/pull/463))
- Held messages above the message box are quiet rows instead of a tinted box: one line above
  them, a clock with the sentence the box already showed ("Held until the agent is ready", and
  "· 2 messages" from two), then each message on its own row with **Send now** and **Discard**
  beside it. A message is still edited in place and still goes out only when you press
  **Send now**. The rows are as wide as the message box at every window width, and the list
  scrolls after two and a half rows. When the agent is ready, the clock and **Send now** take
  the accent colour. While an approval card is open, or in a phone window 600px tall or less (an
  Android phone with its keyboard up), the rows fold into that one line; tap it to open them. On
  a phone, **Discard** is an X, and the message box keeps the same side margin as the
  conversation.
  ([#466](https://github.com/devswha/herdr-web-ui/pull/466))
- In the chat, an agent's question, approval or plan no longer sits at the end of the
  conversation: its card is docked directly above the message box, on the same column, so what
  is asked and where you answer are one block and the conversation scrolls freely behind it.
  Held messages stay above it, folded to their one line. The card is plainer: no shadow, its
  title is the one thing in red (the "INPUT NEEDED" badge is still read by a screen reader),
  and the options are flat rows with their number as a key, all of equal weight. A command or
  plan to approve stays in the card's code box and is the only part that shrinks when room is
  short (six lines, down to two); the card itself is at most 60% of the window, or six rows on a
  phone with its keyboard up, and scrolls beyond that with Confirm always in sight. The message
  box says "Type 1–3 to choose…" (or "Type 1–3 or your own reply…") in place of "Answer above:
  type 1–3 to choose…", which was cut on a phone. While the agent waits for you, the open work
  block reads "Needs you" with a still red dot in place of "Working…". Answering works as
  before: a press on an option, a typed number followed by Confirm, or your own reply; Enter in
  an empty box answers nothing. After a press with a mouse or keyboard, focus goes to the
  message box, on a tablet or a touch-screen laptop too; a tap never moves it there. The card keeps following Settings → Chat font size and Chat font, and on a phone
  with its keyboard up a tap on the card's text, or a drag down it, puts the keyboard away as
  on the conversation.
  ([#468](https://github.com/devswha/herdr-web-ui/pull/468),
  [#475](https://github.com/devswha/herdr-web-ui/pull/475))

- In chat, a tool row reads as what the agent did: "Read src/metrics.ts", "Edited
  src/pages/Reports.tsx", "Ran pnpm test", in place of an icon, the tool's id and a slash. The
  rows start on the same left edge as the block's header and the prose. The tool's own id
  (`exec`, `Bash`, `apply_patch`) is the row's tooltip and the first line of the row once
  opened; a tool without a verb keeps its id in the row. While the agent works, what it says
  between tool calls is in the answer's size and colour instead of small and dim.
  ([#457](https://github.com/devswha/herdr-web-ui/pull/457))

- The chat transcript is quieter. A finished turn folds its work under one dim "Worked for" row
  and only the running turn stays open; a block you open, fold or work inside stays as you left
  it, and a turn that ended without an answer keeps its words in view. The line
  above your messages is gone, answers sit closer to their prompt, and your bubble has even
  corners (no edge in the dark amber, report and charcoal palettes). File paths and links are
  underlined quietly and take the accent color on hover or focus. With a mouse, a code block's
  language and copy button appear in its corner on hover, a message's time and copy sit beside
  the bubble, and an answer has one copy button with "Plain text" beside it; touch keeps the
  code strip and the MD and TXT buttons.
  ([#458](https://github.com/devswha/herdr-web-ui/pull/458))

- A chat whose conversation was read and holds no messages yet asks "What should Omo do in
  my-project?" over the message box, with the PC and the full path under it, instead of a dim
  "No conversation yet" line in the middle of an empty pane. In a desktop window the question
  and the message box sit in the middle of the pane until the first message is sent; on a phone
  the box stays at the bottom. The question is not asked while the agent is working or waiting
  for an answer, or while a message is held for it. A pane without an agent, or one whose
  conversation could not be read, looks as before. That still includes a new Claude Code or
  Codex pane: neither writes its conversation before the first message, so the chat shows the
  terminal output until then.
  ([#460](https://github.com/devswha/herdr-web-ui/pull/460))

- The header is one line at every width: the pane's title, then PC › workspace › folder beside
  it. The folder shows as its last name, and only when the title, the PC or the workspace does
  not already say it; where the line has no room for the whole of it, it is left out rather than
  cut. The full path is in the header's tooltip and at the top of the new **⋯** menu.
  ([#461](https://github.com/devswha/herdr-web-ui/pull/461))
- **New tab**, **Browse files** and **Alerts** are the items of one **⋯** menu in the header, in
  place of three buttons; on a phone it also opens the command palette, whose own button left
  the phone header. Keyboard shortcuts are unchanged. The Alerts item says this device's state
  in words (**On in the app**, **On in this tab**, **On, pushed to this device**, **Off on this
  device**), and the **⋯** button carries a dot while alerts are off on this device. This
  reverses the old bell, whose outline lit while alerts were on.
  ([#461](https://github.com/devswha/herdr-web-ui/pull/461))
- The connection chip shows only while the app is reconnecting or disconnected; **live** is no
  longer written out. In a window narrower than 900px the chip is its pulsing dot.
  ([#461](https://github.com/devswha/herdr-web-ui/pull/461))
- From 769px wide the sidebar has its own top row, with its toggle and the search, and the chat
  has no bar above it: the conversation scrolls under a short fade. The header is 46px there in
  the comfortable density too. Phones keep their bar. The update notice and a PC's "update the
  bridge" line are drawn over the pane, not across the window.
  ([#461](https://github.com/devswha/herdr-web-ui/pull/461))

- The sidebar's footer ends at Settings and the plan meters: the "herdr web ui v…" line and the
  herdr version beside it are gone from under them. Both versions are read in Settings, in every
  state: **Updates** always opens with the running app version, and **herdr** shows the running
  herdr version also where herdr cannot be updated from the app, such as on Windows. A tab that
  has not been reloaded since the server updated says which version it still runs.
  ([#462](https://github.com/devswha/herdr-web-ui/pull/462))

### Fixed
- An answer tapped in the chat for a row the cursor is not on looks at the screen again before
  it presses Enter (or the first key that does more than move the cursor). A menu answered in
  the terminal while the answer was moving the cursor could be replaced by another menu, which
  then took the Enter; the answer now stops with "the prompt changed" unless the screen still
  shows the card's menu with the cursor on its row, having pressed only ↑ and ↓. It also stops
  once the agent is back at work under it. And a question asked again with the same text is a
  card of its own where the app can see that the first asking ended (it was answered from the
  app, the agent went back to work, or the prompt left the screen), so a typed pick waiting for
  Confirm, or the card still open on another device, no longer answers the second asking. Not
  covered: the keys after the first one that does more than move (the text and Enter of a typed
  answer, the later ticks of a multiple choice), and a prompt answered in a terminal and asked
  again word for word with nothing the app can see in between. Remote PCs get this with the
  next `remote-vN` runtime.
  ([#470](https://github.com/devswha/herdr-web-ui/pull/470))
- The installed app opens without a network right after an update that renewed its offline
  store, as this one does. The old store used to be emptied the moment the new version took
  over, so until the app had been opened online once more, a reload with no connection showed
  the browser's error page. The old store is now kept until the new one holds the app.
  ([#473](https://github.com/devswha/herdr-web-ui/pull/473))
- Ctrl+Enter typed into the live terminal reaches Claude Code as Ctrl+Enter, so a message typed
  while it works is sent at once instead of waiting in its queue. The terminal sent plain Enter; it
  now sends the key the way the pane's program asked for (modifyOtherKeys), also to a device that
  opens the pane later, and keeps Enter for programs that asked for nothing. A phone's input line
  and a Windows mirror pane send Enter as before.
  ([#471](https://github.com/devswha/herdr-web-ui/pull/471) by @WOULDU-pres)
- A draft in the message box keeps its full height when the window or the pane is resized, or
  the chat width changes: the box used to keep the height of its old line breaks until the next
  key press. ([#463](https://github.com/devswha/herdr-web-ui/pull/463))
- With a browser font size other than 16px (from 11.4px up), the Default chat width is never
  wider than Wide.
  Its widest was a fixed 960px while Wide follows the font size, so at a 13px font Wide (936px)
  made the chat narrower than Default on a large monitor. Default's widest now follows the font
  size too (960px at 16px, 1200px at 20px), and it is never narrower than Narrow's 820px: under
  an 11.4px font that 820px is itself wider than Wide.
  ([#474](https://github.com/devswha/herdr-web-ui/pull/474))
- An update asked for in the first moments after the app starts, or right after another update,
  waits until the start is over. It used to stop the app in the middle of its start-up check,
  and the app then fell back to the source checkout or did not come up.
  ([#455](https://github.com/devswha/herdr-web-ui/pull/455))
- A PDF on a remote PC opens from the file viewer on Android. Chrome there shows it as an
  **Open** button, and opening it answered `invalid_origin` ("Use PC controls from this app")
  instead of the file; a PDF on the app's own PC already opened.
  ([#448](https://github.com/devswha/herdr-web-ui/pull/448) by @nahwan-kim)
- In one tab of the app, the alert sound chimes once for alerts that come together from several
  panes, instead of sounding over itself. A pane that needs input right after one that finished
  still chimes, once the first chime ends. Two open tabs each chime, as before.
  ([#439](https://github.com/devswha/herdr-web-ui/pull/439) by @WOULDU-pres)
- In the terminal on macOS, Cmd+Left and Cmd+Right move to the beginning and end of the
  input line, using the same terminal keys as Ctrl+A and Ctrl+E.
  ([#437](https://github.com/devswha/herdr-web-ui/pull/437) by @WOULDU-pres)
- The DAG viewer pane omo-herdr-dag opens beside an OmO pane no longer appears in the
  sidebar or the tab strip: an OmO workspace with its viewer shows as a single pane, as it does
  without one. The viewer can still be opened from the command palette.
  ([#447](https://github.com/devswha/herdr-web-ui/pull/447) by @nahwan-kim)
- Attaching a file over 8 MB says so at once, with its size and the limit, instead of uploading
  it first and answering `/api/pane/image failed (413)`. Past about 96 MB that message gave no
  reason at all.
  ([#446](https://github.com/devswha/herdr-web-ui/pull/446))
- Switching to another pane no longer shows the previous pane's chat for a moment before the
  new one loads.
  ([#422](https://github.com/devswha/herdr-web-ui/pull/422) by @Haeminway1)
- Remote bridge updates use Windows' native tar even when Git's tar comes first on PATH.
  Independently managed web servers are directed to their own update controls before any
  remote bundle is installed, instead of repeatedly attempting an update that cannot own them.
  ([#424](https://github.com/devswha/herdr-web-ui/pull/424) by @islee23520)
- Chat reads a running GJC session in a pane herdr names no agent for, also when the pane still
  carries an earlier Codex session report. It used to follow that report, ask the wrong agent
  and fail to load.
  ([#423](https://github.com/devswha/herdr-web-ui/pull/423) by @Kinetic27)

## [0.3.49] - 2026-10-04

### Added
- `HERDR_WEB_PASTE_DIR` saves pasted and attached files to one directory instead of
  `.herdr-web-ui/` in each pane's project. It is read by the server, for the panes of its own
  PC; a remote PC keeps the default.
  ([#357](https://github.com/devswha/herdr-web-ui/pull/357) by @hank-warren)
- The Antigravity plan meter appears on Linux, where the CLI has no keychain and keeps its
  sign-in in `~/.gemini/antigravity-cli/antigravity-oauth-token` (or under
  `ANTIGRAVITY_APP_DATA_DIR`). When a keychain item and the file both exist, the later-expiring
  one is used, as the Claude meter already does.
  ([#399](https://github.com/devswha/herdr-web-ui/pull/399) by @diogo7dias)
- **Settings → Appearance → Colors → Catppuccin**: the [Catppuccin](https://catppuccin.com/palette/) palette,
  Mocha in dark and Latte in light, laid out as Catppuccin's Zed theme does. Latte's accent and
  agent-state colors are darkened just enough to stay readable on its light surfaces.
  ([#414](https://github.com/devswha/herdr-web-ui/pull/414) by @aNNdii)
- Settings → Alerts → Sound makes an open tab chime when a pane needs input or finishes. It is
  the page's own audio, so it is heard when a macOS Focus or Do Not Disturb silences system
  notifications. Off until chosen; the tab needs one tap or key before it may play.
  ([#346](https://github.com/devswha/herdr-web-ui/pull/346) by @WOULDU-pres)

### Fixed
- On an Android phone, dragging down at the top of a chat no longer reloads the app. The drag
  was handed on to the page, where Chrome takes it for pull-to-refresh, so reading back
  through a conversation kept ending in a reload.
  ([#413](https://github.com/devswha/herdr-web-ui/pull/413))
- The app starts on a PC where port 7317 cannot be opened. On Windows with Hyper-V, WSL2 or Docker
  that port can sit in a range Windows reserves, and the first install ended in "did not start
  within 25 seconds" with nothing listening. With no `PORT` set, the app now takes the next of
  17317, 27317, 37317 and 47317 that opens, says which, and keeps it for later starts. A `PORT`
  you set is never changed: a start says at once that it cannot be opened, and why.
  ([#415](https://github.com/devswha/herdr-web-ui/pull/415))
- A start that fails says what the server said: the installers and the Windows start showed only
  where the log was. A server that exits is reported at once instead of after 20 seconds.
  ([#415](https://github.com/devswha/herdr-web-ui/pull/415))
- A notice the agent's runtime puts into a chat is titled by what it says. Every one read
  **Background result delivered**, also OmO's model-profile warning and gjc's incoming messages.
  Only a background result keeps that title; any other notice shows its own first line.
  ([#418](https://github.com/devswha/herdr-web-ui/pull/418), [#344](https://github.com/devswha/herdr-web-ui/pull/344) by @Haeminway1)
- The bell says what this device does. It read as off while in-app alerts still dropped in,
  on a browser that had not been asked for notification permission, and it was missing where
  notifications are blocked or unsupported (plain http). It now reads **Alerts on in the app
  only** there, and turns those alerts off and on. The first tap on a device that has not
  answered the permission question still asks it.
  ([#416](https://github.com/devswha/herdr-web-ui/pull/416))

## [0.3.48] - 2026-10-04

### Added
- **New worktree** has an **Agent** picker, as New workspace does: the agent you choose starts in
  the new checkout, and Shell starts none. It opens on the agent you last started. An agent that
  cannot start leaves the worktree there, with the reason and an **Open** button. Remote PCs
  start the agent with their next bridge update; until then they make the worktree with a shell.
  ([#401](https://github.com/devswha/herdr-web-ui/pull/401))

### Changed
- A new release is installed from the line that announces it: **Update** starts the install
  there, in place of **View update** and a second button in Settings. The line then shows the
  install's step and a bar (downloading, installing dependencies, checking, building,
  restarting), as Settings → Updates does, and ends on **Reload app**. An install that fails
  offers **Try again** and **Details**.
  ([#397](https://github.com/devswha/herdr-web-ui/pull/397))
- On a phone the in-app alert is one line, as wide as its text: the pane's name, then what
  happened. It was a two-line card across the screen, over the top of the conversation.
  ([#406](https://github.com/devswha/herdr-web-ui/pull/406))
- A plan meter beside Settings shows the limit you choose, not the one closest to running out:
  **Settings → Subscription usage → Limit shown** is **Weekly** (the default) or **Session**, the
  short limit that is 5 hours on Claude and Codex. Every account shows that limit, so the numbers
  compare; a plan without it shows its nearest limit as before. Accounts you have not arranged
  keep the order the server lists them in instead of moving as their usage does, and **Nearest
  limit first** is gone with that sorting.
  ([#408](https://github.com/devswha/herdr-web-ui/pull/408), [#343](https://github.com/devswha/herdr-web-ui/pull/343) by @Haeminway1)
- The plan meters no longer have a place at the top of the sidebar. **Settings → Subscription
  usage → Where** is gone and the meters stay beside Settings, where a tap still lists every
  limit with its reset time. A device that had chosen the top goes back to the chips.
  ([#407](https://github.com/devswha/herdr-web-ui/pull/407))

### Fixed
- On an iPhone the image viewer's controls and the composer stay inside the usable screen: the
  viewer is bounded by the safe-area insets and the keyboard's height, the keyboard is told from
  the viewport's geometry rather than from focus alone, and in-app alerts stay below the header.
  ([#400](https://github.com/devswha/herdr-web-ui/pull/400) by @Haeminway1)
- A Linux or macOS PC whose herdr was lost to a restart or a kill connects again. herdr leaves
  its socket file behind, the bridge took that file for a running herdr and did not start, and
  **Update** ended in "Bridge did not start" each time. The bridge now starts herdr when nothing
  listens on that socket. PCs get this with their next bridge update.
  ([#405](https://github.com/devswha/herdr-web-ui/pull/405))
- The Windows installer tries herdr's download once more when it fails, and says so when it fails
  again: herdr's installer gives up on a connection that stays under 1 KB/s for 30 seconds, and
  the install ended there with a message about security software.
  ([#403](https://github.com/devswha/herdr-web-ui/pull/403))
- Claude conversations on Linux can be read without the Herdr integration hook when Claude's
  native PID record identifies the live interactive session. Reused PIDs, invalid records and
  multiple Claude processes stay unresolved instead of selecting a same-directory conversation.
  ([#376](https://github.com/devswha/herdr-web-ui/pull/376) by @WOULDU-pres)
- Codex conversations recognize renamed executables and recover missing Linux process arguments,
  preserving resume and process-bound session identity when an answer is no longer on screen.
  ([#376](https://github.com/devswha/herdr-web-ui/pull/376) by @WOULDU-pres)
- Reading a Codex conversation on a phone no longer scrolls the same idle agent's
  terminal on the desktop as the conversation refreshes.
  ([#393](https://github.com/devswha/herdr-web-ui/pull/393) by @JJLiebig)
- A question card is read from the bottom of the pane even when its terminal was scrolled up
  into its history. A scrolled omo or pi pane showed every later question as the last-resort card
  with only Enter and Esc, since the menu drawn at the bottom was out of the scrolled view.
  ([#402](https://github.com/devswha/herdr-web-ui/pull/402) by @nahwan-kim)
- The line saying a PC needs a bridge update (or setup approval) to reconnect can be closed. A PC
  whose bridge could not be updated kept it open on every screen, which on a phone took a row
  for good. The PC's row in the sidebar still says what it needs, and the line returns the next
  time that PC needs something after having connected.
  ([#397](https://github.com/devswha/herdr-web-ui/pull/397))

## [0.3.47] - 2026-10-03

### Added
- A tab is renamed and closed from the tab strip, as herdr's prefix+shift+t and prefix+shift+x.
  With a mouse: an **x** on the open tab and on the one under the pointer, a double-click on the
  name to type a new one, a right-click for a menu with **Rename tab** and **Close tab**. With
  keys on a focused tab: F2 and Delete. On a phone the open tab carries a chevron that opens
  the same menu. A close asks first only when an agent in the tab is still working or the tab
  is the workspace's last one, which closes the workspace with it. Remote PCs get the two with
  their next bridge update.
  ([#391](https://github.com/devswha/herdr-web-ui/pull/391))

### Changed
- **New session** is **New workspace**: the `+` on a PC's header, the button of an empty PC, the
  command palette action and the Settings → Shortcuts row create a herdr workspace, and say so
  now, beside **New tab**. The dialog's buttons are **Start**, **Open** and **Close dialog** in
  both of its forms. The shortcut and saved settings are unchanged.
  ([#389](https://github.com/devswha/herdr-web-ui/pull/389))
- **New worktree** opens with a branch and a name already filled in, as herdr's own form does:
  a `worktree/brave-valley-07f8` style branch, selected so typing replaces it, and a name that
  follows the branch until you change it.
  ([#388](https://github.com/devswha/herdr-web-ui/pull/388))

### Fixed
- In the iPhone home screen app, a dialog with a text field stays above the keyboard: the command
  palette, and the other bottom sheets, ended at the bottom of the screen, behind the keyboard, and
  a palette with few results was hidden whole.
  ([#395](https://github.com/devswha/herdr-web-ui/pull/395))
- On a phone the header shows the pane's title again: the desktop **New tab** button was not
  hidden there, took the title's room, and pushed a narrow phone's page wider than its screen.
  ([#392](https://github.com/devswha/herdr-web-ui/pull/392))
- The tab strip keeps the open tab in view when a pane is opened from the sidebar, the palette
  or an alert, its `+` stays at the end of the strip however many tabs there are, and on a touch
  screen a split tab's pane picker no longer overlaps the tab's name.
  ([#392](https://github.com/devswha/herdr-web-ui/pull/392))
- A tab herdr names by its number reads **Tab n** by its place in the strip: after a tab before
  it closed, it showed as a bare number.
  ([#391](https://github.com/devswha/herdr-web-ui/pull/391))
- Picking a pane that opens in the chat lens, while a pane in the terminal lens is open, no longer
  resizes the terminal other devices share. The chat lens was already leaving the size alone when
  the page opened on the pane; a switch from the sidebar still fitted it to this device once.
  ([#390](https://github.com/devswha/herdr-web-ui/pull/390))

## [0.3.46] - 2026-10-03

### Added
- A workspace row's **⋯** menu has **New worktree** and **Open worktree…**, as herdr's own
  worktree keys do. New worktree checks a branch out as a git worktree under herdr's worktree
  folder and opens it as a workspace next to the repository's; Open worktree… lists the
  repository's other checkouts and opens one, or goes back to the workspace it is already open
  in. Remote PCs get the two with their next bridge update.
  ([#383](https://github.com/devswha/herdr-web-ui/pull/383))
- In the By workspace view a repository's worktree workspaces sit under its row, as herdr's own
  sidebar keeps them. A worktree row's menu ends in **Delete worktree checkout…**, which deletes
  the folder and closes the workspace but keeps the branch; a checkout with unsaved changes is
  refused first, in git's words, with **Delete anyway** as the second step. Closing a repository
  workspace over open worktrees says so and closes them with it.
  ([#384](https://github.com/devswha/herdr-web-ui/pull/384))
- **New tab**, as herdr's prefix+c: a workspace row's **⋯** menu, the header's **New tab** button
  on a desktop, the command palette and the tab strip's `+` open the session dialog as *New tab*,
  with the folder fixed to the workspace's and the agent and an optional tab name to choose. The
  tab opens in the workspace with its agent started the way a new session's is. Remote PCs get
  it with their next bridge update. The server half starts from
  [#362](https://github.com/devswha/herdr-web-ui/pull/362) by @WOULDU-pres.
  ([#386](https://github.com/devswha/herdr-web-ui/pull/386))
- A tab strip over the pane, as herdr's tab row, once a workspace has more than one pane: one
  entry per tab with the agent state as a dot, the open one underlined; a tab herdr still names
  by its number reads **Tab 2**. A tab opens the pane last viewed in it, and a tab split into
  several panes in the TUI has a picker of them beside its name.
  ([#386](https://github.com/devswha/herdr-web-ui/pull/386))

### Changed
- The sidebar lists one row per workspace, as herdr's Spaces sidebar does, instead of a header
  with a row per pane. The row shows the workspace's current pane (the selected one, else the one
  last viewed there, else the one herdr has in front) and the roll-up of its agents' states; its
  other panes are reached from the tab strip, the command palette and **Needs you**. Workspace
  headers, numbers and folds are gone; folder folds stay. **Rename pane** renames the pane the
  row shows, and a close asks first, as before.
  ([#386](https://github.com/devswha/herdr-web-ui/pull/386))

### Fixed
- Settings → Updates no longer leaves **Check for updates** and **Update and restart** disabled
  when the answer to a click arrives while the page is hidden, as when a phone sends the app to
  the background. The status poll pauses with the page; the click's answer now lands anyway.
  ([#381](https://github.com/devswha/herdr-web-ui/pull/381))
- The Windows installer finishes on a PC that has no Bun yet. Bun's own installer left the
  PowerShell session without the system PATH, so the next step stopped with `git` not recognized
  or herdr's `program not found`, and installing Bun by hand first was the only way through.
  ([#385](https://github.com/devswha/herdr-web-ui/pull/385))

## [0.3.45] - 2026-10-03

### Added
- **Settings → herdr → Update herdr** updates herdr itself from the app, on the PC the app runs
  on (Linux and macOS). herdr refuses `herdr update` typed into one of its panes, and every
  terminal in the app is a pane, so the server runs it instead: it installs the newest herdr and
  moves the running panes onto it. Panes and agents keep running, and open terminals reconnect.
  A newer herdr installed from a shell is picked up the same way.
  ([#373](https://github.com/devswha/herdr-web-ui/pull/373))

### Changed
- Each sidebar row has one `⋯` button in place of a hover pencil and a two-click X. Its menu
  renames the workspace or the pane and closes the row: a close that takes the workspace with it
  (a one-pane row, or **Close workspace** on a workspace header) asks first, as herdr's
  `ui.confirm_close` does, and a pane that leaves its workspace standing closes at once. On a
  phone the menu is a bottom sheet.
  ([#379](https://github.com/devswha/herdr-web-ui/pull/379))
- The sidebar has no top bar. A session starts from the `+` on its PC's header, as before, or from
  the **New session** button an empty PC now shows; Mod+Shift+N and the palette still open it on
  the selected PC. **Add PC** moved to Settings → Remote PCs, above the bridge auto-update switch,
  and the command palette has it too.
  ([#378](https://github.com/devswha/herdr-web-ui/pull/378))
- In the sidebar's By workspace view, a workspace with one pane is a single row again, as it was
  before 0.3.44: no numbered header above it, and the row carries the reorder handle and names
  its workspace on its second line. A workspace with several panes keeps its header. A fold made
  on a one-pane workspace in 0.3.44 no longer hides its row.
  ([#371](https://github.com/devswha/herdr-web-ui/pull/371))
- On a desktop the terminal no longer has a bar under it holding one keyboard button. The input
  line or direct typing is still chosen in Settings → Terminal input mode, and a touch screen
  keeps the button in its key bar.
  ([#372](https://github.com/devswha/herdr-web-ui/pull/372))

### Fixed
- An open terminal no longer says "terminal ended" when herdr hands its panes to a new server,
  as `herdr update --handoff` and `herdr server live-handoff` do. The pane is still running, so
  the terminal attaches to it again for everyone viewing it.
  ([#370](https://github.com/devswha/herdr-web-ui/pull/370))
- Cmd+Backspace on macOS sends Ctrl+U in the live terminal, deleting the input back to
  the start of the line instead of a single character. Pending IME text keeps its order.
  ([#347](https://github.com/devswha/herdr-web-ui/pull/347) by @WOULDU-pres)
- Opening a pane in the chat lens leaves its terminal at the size it has. A phone's chat lens, its
  keyboard included, no longer narrows the pane for a desktop showing it; switching to the terminal
  lens still fits the pane to that device. A remote PC gets this with its next bridge update.
  ([#363](https://github.com/devswha/herdr-web-ui/pull/363) by @WOULDU-pres)
- An OmO pane that has not been asked anything yet, or has just run `/new`, shows an empty chat
  instead of "Conversation unavailable". OmO writes its session file only with the first message,
  so the chat found no conversation until then and offered the terminal output instead.
  ([#360](https://github.com/devswha/herdr-web-ui/pull/360) by @nahwan-kim)
- An answer tapped on a prompt card for a screen the app does not know goes through while the
  agent's working line ticks on that screen. The card's id took in the line's spinner, time and
  token count, so a tap after each tick was refused with "the prompt changed" and took several
  tries. Anything else that changes on the screen still refuses the answer.
  ([#377](https://github.com/devswha/herdr-web-ui/pull/377), [#365](https://github.com/devswha/herdr-web-ui/pull/365) by @Haeminway1)

## [0.3.44] - 2026-10-03

### Added
- Native Windows x64 installation through `install.ps1`, with the same herdr plugin startup
  and updates. Windows needs Bun and Git, without Node or WSL, and keeps using the terminal
  screen mirror. ([#330](https://github.com/devswha/herdr-web-ui/pull/330) by @JJLiebig)
- Settings can choose Chat, Terminal, or Auto as the default view for panes. Changing it resets
  remembered pane views on this device. Shell panes still open in Terminal.
  ([#325](https://github.com/devswha/herdr-web-ui/pull/325) by @Haeminway1)
- Choose the terminal input line or direct typing on desktop as well as touch screens, and
  customize or unbind the app's Mod+Shift shortcuts with conflict checks and reset.
  ([#334](https://github.com/devswha/herdr-web-ui/pull/334))

### Changed
- In the sidebar's By workspace view, a workspace with one pane keeps its numbered header and
  can be folded, renamed and reordered from that header, just like a workspace with several panes.
  ([#332](https://github.com/devswha/herdr-web-ui/pull/332) by @beomq)
- The top usage panel shows larger percentages, remaining-capacity colors and compact reset
  countdowns with their local time. Expired reset times stay hidden until fresh usage arrives.
  ([#336](https://github.com/devswha/herdr-web-ui/pull/336) by @Haeminway1)
- Pane titles that contain a directory show its last folder, and matching workspace and folder
  names appear once in the sidebar and command palette, including Windows paths.
  ([#337](https://github.com/devswha/herdr-web-ui/pull/337) by @Haeminway1)
- In the sidebar's By workspace view, a pane row no longer repeats the workspace its header names.
  Its second line shows the folder only when neither the title nor the workspace already says it.
  ([#358](https://github.com/devswha/herdr-web-ui/pull/358))

### Fixed
- GJC conversations are resolved from the foreground process directory when it differs from
  the pane directory. ([#333](https://github.com/devswha/herdr-web-ui/pull/333) by @Kinetic27)
- Direct terminal input preserves rapid IME commits when punctuation arrives before composition
  timers run, with a bounded xterm 5.5 backport and Korean final-consonant regression checks.
  Native Android/Gboard checks also fixed stale editor text after Backspace breaking the next
  Hangul word. Secret entry now refuses a held or unready attachment and failed PTY writes.
  ([#334](https://github.com/devswha/herdr-web-ui/pull/334))
- New session in the browser demo opens the new session instead of leaving a blank page.
  ([#355](https://github.com/devswha/herdr-web-ui/pull/355))
- Terminal input keeps multi-character IME commits and emoji while disconnected, waits for the
  attachment before sending keys, and reports input failures. Unsent input lines survive pane,
  lens and mode changes; late acknowledgements preserve replacement edits. Composition keeps
  its Enter and Send button, and terminal key-bar taps wait until it finishes.
  ([#334](https://github.com/devswha/herdr-web-ui/pull/334))
- The background tasks list stays below the app header on a short screen, such as a phone held
  sideways, and scrolls inside the room above the message box.
  ([#354](https://github.com/devswha/herdr-web-ui/pull/354))
- The mobile message box sits closer to the home indicator while retaining its base spacing.
  ([#335](https://github.com/devswha/herdr-web-ui/pull/335) by @Haeminway1)
- Adding or reconnecting a remote PC says when herdr is not running or not answering there,
  instead of only `Bridge verification failed (500)`.
  ([#353](https://github.com/devswha/herdr-web-ui/pull/353))
- Shift+Enter in the live terminal sends the same newline chord as Alt+Enter, instead of plain
  Enter that submits an agent's message. Pending IME text is sent before the newline chord.
  ([#339](https://github.com/devswha/herdr-web-ui/pull/339) by @WOULDU-pres)
- On Windows, and from an install path with a space or a non-ASCII character, the app page loads
  instead of the "not built yet" notice. The Windows installer replaces a copy from a release
  without Windows support, and says so when a release cannot run there.
  ([#356](https://github.com/devswha/herdr-web-ui/pull/356))
- On an iPhone home screen app, a text field that keeps its focus with the keyboard down no
  longer leaves a status-bar band under the message box.
  ([#349](https://github.com/devswha/herdr-web-ui/pull/349) by @Haeminway1)
- After `/new` in an OmO pane, the chat stops showing the conversation before it: OmO writes the
  new session's file only with its first message, and until then the chat shows what a fresh OmO
  shows. ([#351](https://github.com/devswha/herdr-web-ui/pull/351) by @WOULDU-pres)
- On a Windows PC, an omo pane shows omo's mark instead of Claude's, and its chat finds the
  conversation: process words with `bun.exe`, backslashes and a drive letter read as omo, and the
  session folder is named as omo's engine names a Windows folder.
  ([#342](https://github.com/devswha/herdr-web-ui/pull/342) by @Haeminway1)
- The chat lens finds an omo pane's conversation when its process keeps its sessions outside
  `~/.omo/agent` (`OMO_CODING_AGENT_DIR`, `SENPI_CODING_AGENT_DIR` or `PI_CODING_AGENT_DIR`).
  ([#350](https://github.com/devswha/herdr-web-ui/pull/350) by @Haeminway1)

## [0.3.43] - 2026-10-02

### Changed
- The sidebar's rows are as they were before 0.3.42. Its new tab and split buttons took room from
  every pane's name, also while hidden, so the names were cut shorter. Both buttons are gone, and
  so are `POST /api/tab/create` and `POST /api/pane/split`.
  ([#327](https://github.com/devswha/herdr-web-ui/pull/327))

### Fixed
- The message box stays editable while the app reconnects. On an iPhone, a dictation keyboard such
  as Typeless or Wispr Flow opens its own app and comes back; the connection could drop meanwhile,
  the box was disabled and lost its focus, and the dictated text went nowhere. Sending still waits
  for the connection. ([#318](https://github.com/devswha/herdr-web-ui/pull/318) by @Haeminway1)
- New session starts an agent when another of the same kind is already running. The second
  Claude (or Codex, ...) used to get an empty workspace and `agent name claude is already used`,
  because every agent was named after its kind and herdr wants each name once. Later ones are now
  named `claude-2`, `claude-3` and so on. An agent is also started once the new workspace's shell
  is up, instead of being refused when it was not yet.
  ([#328](https://github.com/devswha/herdr-web-ui/pull/328))

## [0.3.42] - 2026-10-02

### Added
- Voice input in the chat composer and the terminal input line. Hold or tap the mic and speak,
  Korean and English mixed; the text lands in the box at the caret and is never sent by itself.
  It uses your own OpenAI API key, kept on the server (Settings → Voice input), and falls back to
  the browser's speech recognition without one. Off by default. Silence before, between and after
  the words is left out of the recording, so it is neither uploaded nor billed.
  ([#231](https://github.com/devswha/herdr-web-ui/pull/231) by @nahwan-kim)
- While the app is open, an alert drops in from the top edge as a card: an agent that needs input,
  one that finished (by this device's alert choice) or a terminal that ended. A tap opens that
  pane, a flick up puts the card away, and it leaves by itself after a few seconds. No card for
  the pane already open, and none while the bell is off. Settings → Alerts → In the app turns it
  off; it is on by default. Push and tab alerts are unchanged.
  ([#313](https://github.com/devswha/herdr-web-ui/pull/313) by @Haeminway1)
- The sidebar opens a new tab in a workspace (a `+` on the workspace, or on the row when it
  holds a single pane) and splits a pane beside itself, through `POST /api/tab/create` and
  `POST /api/pane/split`. The new pane is selected once herdr reports it.
  ([#307](https://github.com/devswha/herdr-web-ui/pull/307) by @piotrchabros)
- Settings → Appearance lets you group sidebar sessions by folder, combining panes with the
  same full working-directory path within each PC. Grouping by workspace remains the default;
  the selected mode and each mode's collapsed groups are remembered independently.
  ([#299](https://github.com/devswha/herdr-web-ui/pull/299) by @beomq)
- While an OmO pane has background tasks running, the chat's status line says how many, and tapping
  it lists them: what each is doing, its category and model, how long it has run, its turns, tool
  calls and tokens. The newest tasks that ended in the last day (up to ten) are one line under
  them that says how many ended and how many failed, and opens to show whether each finished,
  failed, was cancelled or was lost with OmO's process. A remote PC lists them once it runs a
  bridge that knows this list.
  ([#305](https://github.com/devswha/herdr-web-ui/pull/305), [#310](https://github.com/devswha/herdr-web-ui/pull/310))
- The same list shows the workflows (DAG runs) the OmO session started: each one's name, how many
  steps are done, running or failed, and its steps wave by wave, with why a failed step failed.
  A workflow that ended folds into the same line as the tasks that ended.
  ([#306](https://github.com/devswha/herdr-web-ui/pull/306))
- An OmO turn that set or updated a goal shows it on the turn, beside the skills, also while its work
  is folded: the objective, whether it is in progress, complete, blocked, paused or out of budget, and
  opened, the whole objective, why it is blocked and the time and tokens spent on it so far.
  ([#303](https://github.com/devswha/herdr-web-ui/pull/303))
- Terminal and chat font families in Settings: a comma-separated list, such as
  `D2Coding, "Cascadia Mono"`, tried in order before the built-in fonts, so a font this device
  lacks falls back as before. The chat font applies to message text; code stays monospace.
  Stored per browser, like the other appearance settings.
  ([#308](https://github.com/devswha/herdr-web-ui/pull/308) by @Kuhave)

### Changed
- Remote PCs use the `remote-v11` runtime, which carries the server-side changes since `remote-v10`
  to them: a new tab and a split from the sidebar, an OmO pane's background tasks and workflows,
  and the access token asked before a Tailscale login is trusted. A PC connected with the
  `remote-v10` bridge updates as it did for earlier runtimes.
  ([#322](https://github.com/devswha/herdr-web-ui/pull/322))
- With an access token set (`HERDR_WEB_TOKEN`), your own Tailscale devices are asked for it too:
  once per device, and that browser then stays signed in for a year. A paired device still gets in
  without it, and nothing changes when no token is set. Before, the token was skipped for a request
  that named this PC's Tailscale login, and any other proxy on the same PC (nginx, Caddy, a tunnel)
  passes a visitor's copy of that name on unless it is told to drop it, so the token did not keep
  such a visitor out. ([#309](https://github.com/devswha/herdr-web-ui/pull/309))
- A mirrored terminal (a Windows PC, or one with no Node for the terminal attach) sends the rows
  that changed instead of the whole screen each time, and shows what you type sooner. An agent at
  work repaints a spinner about 12 times a second: measured with gjc, that was 88 KB a second to
  every viewer and is 11 KB now. Typing waited for the mirror's next look at the screen, up to
  0.4 s on an idle pane: on a real Windows PC a key's echo took 159 ms and takes 23 ms.
  ([#292](https://github.com/devswha/herdr-web-ui/pull/292))

### Fixed
- On a phone, picking a pane (from the drawer, the palette or a notification) or switching between
  chat and terminal no longer raises the keyboard over it: you read first, and a tap on the message
  box or the terminal raises it. Turning direct typing on still does. A desktop is unchanged.
  ([#315](https://github.com/devswha/herdr-web-ui/pull/315) by @Haeminway1)
- On a phone the status line above the message box is always one row. With a background-task
  count, a model name and a reasoning level it wrapped to two rows, three with the context text
  open, and took that room from the conversation. On a narrow screen the background-task chip now
  shows its icon and the number (the icon alone while nothing runs), the reasoning chip the level
  alone, and a model name that still does not fit is shortened. ([#312](https://github.com/devswha/herdr-web-ui/pull/312))
- The terminal accepts dropped file paths and uploads dropped or pasted files to
  the pane's working directory before inserting their quoted paths, without submitting them.
  ([#304](https://github.com/devswha/herdr-web-ui/pull/304) by @beomq)
- A message sent to Claude Code while it is working shows in the chat. Claude records such a
  message differently from one sent while it waits, and the chat skipped it, so the agent acted
  on words the chat never showed.
  ([#301](https://github.com/devswha/herdr-web-ui/pull/301))
- In an OmO, omp or pi chat, a message that invoked a skill (`/skill:name`, `$name`, or a keyword
  such as `ulw`) shows what you asked, not the whole SKILL.md the agent put before it: one such message
  filled tens of KB of the chat. The skill shows as a chip under your message, standalone `.md`
  skills included. ([#302](https://github.com/devswha/herdr-web-ui/pull/302))
- A chat message the page cannot draw no longer blanks the whole app. That message says it can't be
  shown and the rest of the conversation stays; if the chat as a whole fails, it says so with Try
  again, and the header, sidebar and terminal keep working.
  ([#300](https://github.com/devswha/herdr-web-ui/pull/300))
- New session has a shortcut that works in a browser tab: Ctrl+Shift+O (Cmd+Shift+O on a Mac).
  Chrome keeps Ctrl+Shift+N for a new incognito window and never passed it to the page, so it
  worked only in the installed app, where it still does.
  ([#298](https://github.com/devswha/herdr-web-ui/pull/298))
- Cmd+Shift+↑ and ↓ select text in the message box on a Mac again (Ctrl+Shift+↑ and ↓ in any text
  field elsewhere). The pane shortcut took them wherever the cursor was, switched panes and left
  the message behind; it now switches panes from the terminal and outside text fields only.
  ([#298](https://github.com/devswha/herdr-web-ui/pull/298))
- Nerd Font icons (a Starship or Powerlevel10k prompt, `lsd`, `eza --icons`, Neovim file
  trees) show in the terminal instead of empty boxes. The terminal's fonts had none of them, and
  Safari never uses a font the user installed, so even a Nerd Font set up for the native
  terminal did not help there. The app now carries Symbols Nerd Font Mono for those characters
  alone; the browser downloads it (1.2 MB) only once a pane prints one, and each icon is drawn to
  its one cell, Powerline's separators at the full height of the row.
  ([#294](https://github.com/devswha/herdr-web-ui/pull/294) by @jmr533)
- An agent's finish is no longer lost when a pane opens or closes somewhere at the same moment.
  The server reopens its status subscription whenever the set of panes changes, and a status
  that changed in between was never sent again: no done alert came, and a browser kept the old
  state until its next refresh. The status is now read back once the new subscription is live
  and told as the event it would have been. Seen as a flaky test first: with panes opening and
  closing beside it, a pane's one status change was lost in 5 of 10 runs, and in none after.
  ([#291](https://github.com/devswha/herdr-web-ui/pull/291))
- Frames and tables an agent draws in the terminal have whole lines. Box-drawing characters came
  from the font, whose glyph is shorter than a row, so an upright line broke at every row and a
  corner did not meet its lines; a phone drew the heavy lines `━ ┃ ╋` almost like the light ones,
  and shades `░▒▓` as a dot pattern. These characters and the block elements (`█ ▄ ▌` and the
  like, as in a progress bar) are now drawn to the cell, edge to edge, on whole screen pixels.
  ([#295](https://github.com/devswha/herdr-web-ui/pull/295))
- Several lines sent to an agent from the terminal's input line, or pasted into the terminal,
  stay in its message box until sent on a Linux or macOS PC that mirrors its terminals too (one
  with no Node for the terminal attach). They went as bare lines there, and the agent sent the
  first line as a message of its own. Measured with gjc on a mirrored Linux pane: two lines
  arrived as two messages, and now arrive as one.
  ([#290](https://github.com/devswha/herdr-web-ui/pull/290))

## [0.3.41] - 2026-10-02

### Added
- An OmO pane shows how many background tasks it still has running, as a small count beside its
  state in the sidebar. A turn can be DONE while tasks it started still work, and they wake the
  session by themselves; the count tells that pane from one with nothing left to do.
  ([#287](https://github.com/devswha/herdr-web-ui/pull/287))
- Settings → Appearance has a wheel scroll speed for the terminal, from 1× (as it was) to 10×.
  xterm sends herdr at most one wheel report per wheel event however far the wheel turned, so a
  long history took a lot of turning; at 3× the same turn scrolls three times as far. A trackpad
  is scaled the same way; a pinch and touch scrolling are unchanged.
  ([#274](https://github.com/devswha/herdr-web-ui/pull/274) by @taehwan08)
- A file path or a `file:///` address in the terminal opens in the file viewer with a click or
  a tap, as one in the chat does. A path counts when it names a folder (`src/App.tsx`,
  `server/index.ts:120`); a bare name such as `README.md` stays text, since a terminal is full
  of those and a tap to focus the pane would open the viewer. In the chat a `file:///` address
  opens too, written plain, as code or as a link, and one that names a folder shows the folder's
  files. `process.env`, `Math.random` and the like no longer read as files in the chat.
  ([#266](https://github.com/devswha/herdr-web-ui/pull/266) by @beomq)
- A pi or omp pane says so when you type `/tree` into the chat. The command runs, in the terminal,
  and opens a tree the chat cannot show — so the composer says that while you are typing it, and
  where to go instead. Wording checked at 390 wide: the lens switch is an icon there (its word is
  hidden below 560px, and a `title` is a tooltip a phone never shows), so the hint names where the
  button is rather than a word no phone displays
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi pane says when the conversation is bigger than what the chat shows. `/tree` moves pi's leaf
  pointer and writes nothing, so the turns a `/tree` left behind simply disappeared from the chat
  with no sign they had been there. The chat now names how many it holds back and across how many
  branches, and where pi summarized the abandoned path — answering `/tree`'s **Summarize branch?**
  — it shows that summary. Going back to those turns still means `/tree` in the terminal: the chat
  reads them but cannot move pi's pointer, and a chat that could would offer to undo a branch by a tap
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi pane is a chat. Its own session file under `~/.pi/agent/sessions` is read through herdr,
  so prompts, thinking, tool calls with their results, the model and the reasoning level show
  the way they do for omp. `/new`, `/resume`, `/fork` and `/clone` move the chat to the session
  that replaced the old one, and after a `/tree` it shows the branch in play: the paths pi
  navigated away from stay in the file, unread, as they do in pi. Where pi folded old context
  into a summary — on `/compact`, or by itself — the chat says so and opens the summary. A pi
  dialog answers from the chat too: an extension's question, a Yes/No, and one that wants text
  typed, though not `/tree` itself, which would move the session's branch. pi calls itself idle
  while it waits on a dialog, never blocked, so the card comes from its screen. A session
  directory chosen with `--session-dir` or the `sessionDir` setting is not found;
  `PI_CODING_AGENT_SESSION_DIR` is.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A picture a pi tool opened shows in the chat. pi keeps the image a `read` returned in the
  session file beside the text it answers with, so a screenshot the agent looked at was in the
  transcript and invisible here; it now shows inside that tool's row, and opens full size on a
  tap. Only the address travels in the conversation, so the bytes arrive when the row is opened
  and not on every poll, and an image left behind by a `/tree` stays out of reach, the way its
  output does.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi pane's context ring shows. What a request filled was already recorded; the window it
  filled was not, so the ring had nothing to divide by and stayed hidden. It now reads the
  window from the same `~/.pi/agent/models.json` pi reads its own providers from, and the
  figure matches what pi's own footer says. A model that file does not state keeps no ring:
  pi answers those from its built-in catalogue or from a running llama.cpp server, neither of
  which a reader of the transcript can ask, and a window invented would show a percentage no
  different from the real one.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi pane's message box lists pi's own slash commands as you type `/`, the way it does for
  Claude Code, Codex and omp: pi's built-ins in pi's words, the templates in `~/.pi/agent/prompts`
  and the skills under `~/.pi/agent/skills` and `~/.agents/skills`. A project's own skills and
  prompt templates stay out of the list, because pi loads those only once you have trusted the
  folder, and a command the agent will not run is worse than one missing from the menu.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- The browser demo runs a pi pane, backfilled into the recorded snapshot when the fixtures
  predate it: `site/demo/fixtures.ts` is the only file a new demo agent needs.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)

### Changed
- Remote PCs use the `remote-v10` runtime, which carries the server-side fixes since `remote-v9`
  to them, Windows PCs included: New session with Gajae Code, the chat of a Gajae Code or omp
  pane, pasted and sent lines that stay in an agent's message box, typing that no longer outlives
  its connection, and OmO detection. A PC connected with the `remote-v9` bridge updates as it did
  for earlier runtimes. ([#282](https://github.com/devswha/herdr-web-ui/pull/282))

### Removed
- `/tree` is no longer suggested in a pi pane's chat. pi offers it, and typing it works, but the
  chat reads the tree browser it opens as nothing at all — no card, and the pane still looks idle
  while the terminal waits for arrow keys — so a reader who picked it from the menu landed in a
  state only the terminal lens can leave. Navigating was never the chat's to do; omp curates its own
  list the same way. What the chat does say is where a `/tree` left the conversation: the marker
  above the turns names how many it holds back and across how many branches
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)

### Fixed
- A Codex pane whose answers are all short shows its chat. The chat finds a Codex conversation by
  an answer it can see on the pane's screen, and only one of 64 letters or more counted, so a
  session of one-line answers stayed empty until a longer answer came. When nothing else tells
  (herdr names no session, Codex was not resumed, and no long answer found the conversation
  before), the newest two or more answers of a conversation, shown one after another on the
  screen, now count together. That is weaker evidence than one long answer, so it is used only
  when exactly one of the folder's conversations shows that way, no other one said those answers
  as far as its text tells, every one of them was read whole (none missing its file, forked from or continuing
  another, or too long to read at once), and the folder has no more than 32. An answer with a
  link in it does not count, since the screen shows a link its own way. It is never
  remembered: once the answers scroll away the chat is empty again until a long one shows. Text
  pasted into the pane or printed by a command can still look like another conversation's
  answers and show that conversation instead.
  ([#284](https://github.com/devswha/herdr-web-ui/pull/284))
- The chat of a Gajae Code pane on a Windows PC follows `/new` and `/resume`. It stayed on the
  previous conversation until an answer of the new one was long enough to recognise, which a
  one-word answer never is. It now goes by the session title gjc shows in its status line: when
  that names one session of the folder, the chat shows that one, and when two sessions share
  the title it shows none rather than the wrong one. A later gjc that Windows gave the same
  process number no longer inherits the old session, and a process list that could not be read
  keeps the chat as it was instead of dropping it.
  ([#285](https://github.com/devswha/herdr-web-ui/pull/285))
- An OmO pane reads RUN while OmO works and DONE when it finishes. herdr reports nothing for such
  a pane (it read READY or DONE whatever OmO did), so a message sent meanwhile was not held, Stop
  was not offered, and no done alert came, in the browser or by web push. The status is now read
  from OmO's own session file, also for a turn a finished background task, a monitor or a goal
  starts by itself. Nothing of OmO's or Claude's is installed or changed for it. A remote PC gets
  this with the next remote bundle.
  ([#287](https://github.com/devswha/herdr-web-ui/pull/287))
- On a PC whose Tailscale node is tagged, your own devices are no longer refused as "another
  Tailscale user". A tagged node has no person's login, and the server took the node's own name
  for one, which no device could match. Such a PC now asks every device to pair, yours included,
  and `HERDR_WEB_TAILSCALE_OWNER` names the login that gets in without pairing.
  ([#280](https://github.com/devswha/herdr-web-ui/pull/280))
- Several lines sent to an agent from the terminal's input line on a phone stay in its message
  box until sent, on a Windows PC too. The mirrored terminal there never learns the agent's paste
  mode, so the lines went as typed and the agent sent the first one alone. They now go as one
  paste, as the same lines pasted into that terminal do since 0.3.40.
  ([#281](https://github.com/devswha/herdr-web-ui/pull/281))
- The chat of an OmO, omp or Gajae Code session shows the reasoning level the session runs at
  now. It read the level from the first 64 KB of the transcript and the newest page, so a level
  changed in between (`/thinking`, or a model switch) was never seen: a session started at
  `high` and switched to `medium` still showed `high`. A model or thinking-level change between
  them now counts, in order, without reading more of the file.
  ([#279](https://github.com/devswha/herdr-web-ui/pull/279) by @ddotz)
- The chat shows the conversation of OmO installed with `bun add -g omo-ai` again, and the
  sidebar marks its pane as OmO. A global bun install puts OmO's engine next to omo-ai rather
  than inside it, so the pane runs `bun …/@code-yeongyu/senpi/dist/bundle/cli.js --extension
  …/omo-ai/plugin`, and 0.3.40 no longer took it for OmO: the chat found no conversation and
  New session did not see OmO start. That engine counts as OmO again when omo-ai's plugin is one
  of its extensions.
  ([#278](https://github.com/devswha/herdr-web-ui/pull/278) by @ddotz)
- Claude usage on a Mac no longer shows `expired` while Claude Code is signed in. Claude Code
  started outside the desktop session (over SSH, or by a background service) cannot write its
  keychain item, so it refreshes only `~/.claude/.credentials.json` and the item keeps a token
  that expired hours ago. The app took the keychain item whenever it could read it; it now
  takes whichever of the two expires later, the way it already does for Cursor. Both are still
  only read.
  ([#277](https://github.com/devswha/herdr-web-ui/pull/277) by @ddotz)
- Claude's subscription usage no longer shows a locked keychain on a Mac whose server was
  started outside the desktop session (over SSH, or by a detached multiplexer), where
  `security` cannot open the login keychain. The item is read through a one-shot launchd job
  in the desktop session instead.
  ([#255](https://github.com/devswha/herdr-web-ui/pull/255) by @ddotz)
- A pi pane no longer shows a context window pi never used, and now shows the one it does. A
  provider that states `contextWindow` beside a model that names none reported that number as the
  model's denominator; pi does not inherit it, and runs the model at its own default instead, so the
  ring is now quiet there rather than showing a figure pi never had. And `modelOverrides` is applied
  the way pi applies it — an override that raises a model to 256k was read at 128k, which drew twice
  the utilisation pi shows. Both checked against pi 0.87.1 by pointing `PI_CODING_AGENT_DIR` at a
  crafted `models.json` and reading `pi --list-models`.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A malformed entry in `~/.pi/agent/models.json` no longer takes the chat down with it. One model
  that was not an object — a stray `null` from a hand edit — threw while the window was being read.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A prompt template reached through a symbolic link is offered again. A `.md` linked from a dotfiles
  repo into the prompt directory was hidden from the menu while pi loaded it and ran it.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A command name longer than the menu no longer runs out from under it, on a phone or a desktop. A
  template is named after its file, and the name kept its full width past the row's edge.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A model list caught mid-redraw is refused instead of offered in part. A screen written while pi is
  still drawing it ends a row inside its provider bracket; the rows above it were kept and offered
  as a catalogue, so counting down walked into models pi had not drawn.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A path abandoned at the very root of a pi session is counted. Navigating pi's tree to its first
  entry clears where the next entry attaches, and starting a second path beside the first was read
  as no navigation at all, hiding what was left behind.
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)
- A pi dialog shows on a phone. A phone leaves pi a pane barely wide enough for its own hint, so
  the hint wraps, and pi keeps its footer underneath: the wrapped hint then sat further from the
  bottom than the window that tells a live dialog from an answered one reached, so no card came up
  at all. `/model` failed twice over — the wrapped hint, and a model's own name wrapping so that
  the provider's bracket, which is what tells a row from pi's notes, fell onto a line of its own
  among them. The wrap is joined back before the screen is read, and a row still missing its
  provider voids the whole reading, because a name cut in half would switch pi to a model that
  does not exist
  ([#262](https://github.com/devswha/herdr-web-ui/pull/262) by @diegolhambi)

## [0.3.40] - 2026-10-01

### Fixed
- Korean, Japanese and Chinese in the terminal no longer look spread apart on an iPhone. iOS has
  no font that draws Hangul as wide as two terminal cells, so every syllable sat at the left of
  its cells with a 4px gap after it. A character narrower than its cells is now drawn larger
  (up to 1.2×) and centered in them. Vietnamese written with separate accent marks, as in a
  file name from a Mac, now shows every mark on iPhone; Safari drew only the first one. The ⏺
  before every Claude Code message is drawn as a symbol in its cell on iPhone, no longer as a
  blue emoji over the next character
  ([#272](https://github.com/devswha/herdr-web-ui/pull/272)).
- Several lines pasted into the terminal of a Windows PC stay in an agent's message box until
  you send them. Gajae Code took the first line break for Enter and sent the first line alone.
  PowerShell and cmd still run a pasted block line by line. Enter, Ctrl+C, Esc, Tab and the
  arrows were checked on a real PC and already worked
  ([#267](https://github.com/devswha/herdr-web-ui/pull/267)).
- A bridge that cannot run the PTY sidecar (no Node, or no `@lydell/node-pty`, as in the Windows
  bundle) keeps mirroring its panes even when herdr reports terminal attach. It used to leave
  the working mirror for an attach it could not start, and the terminal ended at once.
  `/api/health` and the PC list say `terminal_attach: false` and `terminal_mirror: true` there.
  The real terminal on Windows therefore needs a bundle that ships the sidecar, not only a
  herdr that attaches ([#265](https://github.com/devswha/herdr-web-ui/pull/265)).
- A password entered from the secret prompt on a mirrored terminal (a PC whose herdr cannot
  attach, as on Windows) is reported as entered only after herdr took it, and a send herdr
  refused is reported as failed instead of as done. Enter is now pressed as a key after the
  text, not sent as a carriage return inside it
  ([#263](https://github.com/devswha/herdr-web-ui/pull/263)).
- A pane running a command that is only given an omo path (`grep -q …/omo-ai/x`, `cat …/bin/omo`) is
  no longer shown as OmO or counted as a second OmO in its folder. Only the program a pane runs
  counts, or the script that node or bun runs
  ([#249](https://github.com/devswha/herdr-web-ui/pull/249)).
- **New session** with Gajae Code starts on a Windows PC. The command was typed the way a POSIX
  shell wants it and ended with a newline, which PowerShell takes for a line break, so it never
  ran; and herdr names only the pane's shell on Windows, so the start was never seen. The
  command is now written for the pane's shell (PowerShell or cmd), run with the Enter key, and
  found among the shell's child processes. OmO is not offered on a Windows PC for now
  ([#251](https://github.com/devswha/herdr-web-ui/pull/251)).
- A reverse proxy on the same PC that keeps the browser's `Host` but sends no
  `X-Forwarded-For` no longer makes every visitor count as this computer. A request from this
  PC with a `Host` that is not `localhost` or `127.0.0.1`, or with any forwarding header, is
  treated as proxied: once a device is paired, a visitor needs pairing or the token. A proxy
  that also rewrites `Host` and adds nothing, as nginx's plain `proxy_pass` does, still cannot
  be told from this computer, so set a token behind a proxy. The guide has Caddy and nginx
  examples to copy ([#252](https://github.com/devswha/herdr-web-ui/pull/252)).
- The chat lens finds the conversation of a Gajae Code pane and of an omp pane on a Windows PC.
  Both lookups compared paths with `/`, which a Windows path does not have, and Gajae Code was
  looked for only among the processes herdr names, which on Windows is the pane's shell alone.
  Paths are now compared by the PC's own rules, and Gajae Code is found among the shell's child
  processes, then matched by the text on screen. Once matched, the pane keeps its conversation
  while that Gajae Code process runs, so a long list or tool output that pushes every answer off
  the screen no longer drops the chat, and the PC's process list is read once every few seconds
  instead of on every poll. A path that leaves the store through `..` is
  refused on every platform. A Windows PC gets this with the next remote bundle
  ([#264](https://github.com/devswha/herdr-web-ui/pull/264)).
- Emoji in the terminal take as many cells as herdr gives them, so a line with emoji no longer
  shifts: the browser counted most emoji, and the ⚠️ kind with a selector, as one cell, and an
  emoji sequence such as 👨‍👩‍👧 as one cell per emoji. The next letter overlapped the emoji, parts
  of the sequence were overwritten, and stray characters stayed behind. Thai and Indic vowel
  signs and invisible characters such as a zero-width space are counted as herdr counts them too
  ([#273](https://github.com/devswha/herdr-web-ui/pull/273)).

## [0.3.39] - 2026-10-01

### Fixed
- A password or PIN sent right after a reconnect is no longer refused with "Update this PC to
  use masked input". The terminal's output could arrive before the server had said what it
  supports, and a Send in that gap sent nothing
  ([#244](https://github.com/devswha/herdr-web-ui/pull/244)).
- A Stop, an Enter or anything typed right after a message no longer reaches the pane once the
  connection that sent it has closed. It waited behind the message and was sent afterwards, with
  nobody watching. The message itself is still finished for a phone that locks
  ([#235](https://github.com/devswha/herdr-web-ui/pull/235)).
- A terminal whose grid is not the browser's own (a mirrored pane on a PC whose herdr cannot
  attach, or a view-only connection) can be reached past the edge of a small screen: a drag pans
  it on a phone, the wheel or a scrollbar in a small desktop window, and it opens on the rows
  with the prompt instead of the top of the grid
  ([#241](https://github.com/devswha/herdr-web-ui/pull/241)).
- An omo question in the chat gets a real card, not the last-resort one with only Enter and
  Esc. omo asks several questions in one form: the card asks them one at a time, with a chip per
  question that checks off the answered ones, and an option is picked by its number as in omo.
  After the last one the card reviews the answers: Submit, tap an answer to change it, or type a
  comment that goes with them. The card's text comes from the question as omo's session recorded
  it, so a pane too short for the whole form, or one that wraps it, still shows every option word
  for word; without the session it is read off the screen, with wrapped Korean words joined back.
  While an answer is typed in omo's own field, the card offers to save or discard it
  ([#237](https://github.com/devswha/herdr-web-ui/pull/237) by @nahwan-kim).
- A pane that waits for another web bridge to let go of its terminal is no longer shown as
  connected for a moment, and then told again that it is held, when herdr answers a retry slowly.
  The first bytes `herdr terminal attach` writes before herdr has answered no longer count as
  the attach having taken ([#243](https://github.com/devswha/herdr-web-ui/pull/243)).
- A new shell is no longer taken for OmO while its startup files run. A startup command that
  printed a `PATH` containing omo-ai's directory matched the OmO process check, so the pane could
  get the OmO mark for a moment and **New session** could report OmO started before it had
  ([#243](https://github.com/devswha/herdr-web-ui/pull/243)).

## [0.3.38] - 2026-10-01

### Added
- A workspace with several panes gets a chevron in its sidebar header that folds its pane rows
  away. The fold is remembered per PC and workspace, the header keeps its status badge, Needs you
  still lists agents inside it, and opening one of its panes (palette, Needs you, an alert link)
  unfolds it ([#222](https://github.com/devswha/herdr-web-ui/pull/222)).
- **Add PC** connects a Windows PC (x64, OpenSSH Server, herdr 0.9+). Setup asks it in
  PowerShell when `sh` is not there, installs a Bun-only `win32-x64` bundle under
  `%LOCALAPPDATA%\herdr-web-ui`, runs herdr's own installer when the PC has no herdr, registers
  the app key where Windows OpenSSH reads it (an administrator's
  `administrators_authorized_keys`), and starts the bridge and the daemon through WMI so they
  outlive the SSH session and each other. The bridge talks to herdr over its named pipe. herdr
  has no terminal attach on Windows yet ([herdrdev/herdr#4821](https://github.com/herdrdev/herdr/issues/4821)),
  so `/api/health` and the PC list carry `terminal_attach`, and the real terminal turns on by itself
  once herdr reports it. Remote bundle `remote-v9`
  ([#227](https://github.com/devswha/herdr-web-ui/pull/227)).
- A PC whose herdr cannot attach a terminal (a Windows PC for now) has a terminal lens all the
  same. The bridge reads the pane's screen a few times a second and repaints it, so output and
  colours show and typing works. It is a stopgap until herdr can attach there: the cursor is not
  shown, and the grid is the pane's own size on that PC, not the browser's, so a phone shows its
  left part and cannot pan it yet
  ([#230](https://github.com/devswha/herdr-web-ui/issues/230),
  [#228](https://github.com/devswha/herdr-web-ui/pull/228)).

### Fixed
- A gjc chat no longer folds hours of work into one turn. gjc wakes its agent with a
  background job's result in the user's seat; the chat skipped that record, so the answer before
  it sank into the work block and only the last status line showed as the reply. The result now
  ends the turn, as a quiet "Background result delivered" divider with the text on request, like
  a compaction ([#225](https://github.com/devswha/herdr-web-ui/pull/225)).
- **New session** offers **Gajae Code** when `gjc` is on the server's PATH. herdr's `agent.start`
  has no gjc kind, so like omo it is typed into the new pane's shell and the pane counts as
  started once gjc is its foreground process
  ([#220](https://github.com/devswha/herdr-web-ui/pull/220)).
- OmO panes show their agent mark in the sidebar even when herdr reports no agent kind,
  including panes started with OmO in the new-session dialog. Detection uses the pane's
  foreground processes, not its title, so ordinary shells remain shells
  ([#224](https://github.com/devswha/herdr-web-ui/pull/224) by @beomq).
- A bridge that died without withdrawing its registration (a crash or a reboot) no longer
  makes the reconnect verify the dead one before the new bridge has registered
  ([#227](https://github.com/devswha/herdr-web-ui/pull/227)).

## [0.3.37] - 2026-10-01

### Changed
- Settings → Appearance no longer offers Clawd and the Codex app icon in place of the
  provider logos. Claude and Codex panes show their provider logos again, also where one of
  the icons was chosen in 0.3.36. The color palettes stay
  ([#219](https://github.com/devswha/herdr-web-ui/pull/219)).
- The chat's status line no longer has **Report a problem**, and on a phone no **Hide keyboard**
  while typing. A tap on the transcript or a drag down it still puts the keyboard away. Problems
  go to [GitHub issues](https://github.com/devswha/herdr-web-ui/issues/new/choose)
  ([#221](https://github.com/devswha/herdr-web-ui/pull/221)).
- On a touch screen, the chip above the message box that takes Claude Code's suggested next
  prompt is now off until Settings → Composer → **Suggestion chip** turns it on. The suggestion
  still stands as the box's placeholder, and Tab still takes it with a keyboard
  ([#223](https://github.com/devswha/herdr-web-ui/pull/223)).
## [0.3.36] - 2026-10-01

### Added
- On a phone, a swipe in from the left edge opens the workspace list and a swipe to the left
  closes it; a stroke on a text field or one that selects text is left alone. While typing in
  the chat, a tap on the transcript, a drag down it, or the new **Hide keyboard** button puts
  the keyboard away to read, and the draft stays in the composer
  ([#187](https://github.com/devswha/herdr-web-ui/pull/187) by @Haeminway1, [#217](https://github.com/devswha/herdr-web-ui/pull/217)).
- Settings → Appearance → Colors offers two opt-in palettes beside herdr's amber, which stays
  the default: **Dark report** (a near-black blue-grey canvas, hairlines, near-square corners,
  white primary actions, electric blue only on small marks, and amber / red / green agent states)
  and a neutral Ghostty-style **Charcoal**
  ([#188](https://github.com/devswha/herdr-web-ui/pull/188) by @Haeminway1).
- Settings → Appearance can show Clawd, Claude Code's mascot, on Claude panes and the Codex
  logo (a blue cloud with a prompt) on Codex panes instead of the provider logos, which stay the
  default ([#188](https://github.com/devswha/herdr-web-ui/pull/188) by @Haeminway1).
- The chat's message box offers the prompt Claude Code suggests next, the grey text in its
  empty input. It stands as the box's placeholder, and Tab takes it into the box; on a touch
  screen a dashed chip above the box does the same. Nothing is sent until you send it. It is
  read only while Claude waits for a prompt and never holds up the chat for more than 1.5s
  ([#198](https://github.com/devswha/herdr-web-ui/pull/198) by @Yoonwoo-Ha, [#216](https://github.com/devswha/herdr-web-ui/pull/216)).
- Settings → Plan limits → Where puts the plan meters at the top of the sidebar instead of
  beside Settings: a row per account with its plan, the limit closest to running out, a bar
  and when it resets. A tap opens every limit. An account whose numbers are old or missing (a
  sign-in expired, a provider asking to slow down) dims them and says why in its row
  ([#206](https://github.com/devswha/herdr-web-ui/pull/206) by @Haeminway1, [#217](https://github.com/devswha/herdr-web-ui/pull/217)).

### Fixed
- A table an agent indents under a list item shows as a table in that item in the chat. It was
  read as the item's text, so its rows ran together on one line with their pipes. The list goes
  on after it: items numbered `1.` throughout keep counting, and nested items stay nested
  ([#209](https://github.com/devswha/herdr-web-ui/pull/209) by @Yoonwoo-Ha, [#217](https://github.com/devswha/herdr-web-ui/pull/217)).
- `stop` (herdr's Stop action, `bun scripts/plugin.ts stop`) returns once the server is gone.
  It returned at once, while the old supervisor still held the checkout's lock, so a `start`
  right after it found that lock and gave up: nothing ran, and it reported no answer after 20s.
  On Linux, a server that has exited but whose parent has not yet collected it counts as gone
  ([#210](https://github.com/devswha/herdr-web-ui/pull/210) by @Yoonwoo-Ha, [#216](https://github.com/devswha/herdr-web-ui/pull/216)).
- A pane herdr reports waiting for input gets a card in the chat even when no reader knows its
  screen (Codex's collapsed question queue keeps its own handling). A numbered menu whose hint
  (a way to choose, such as "Enter to select") is the screen's last line is offered as its
  options, each answered by typing its number, with wrapped labels in full and Enter and Esc
  after them; anything else, such as a new prompt under
  the hint, shows the screen's last lines with Enter and Esc, plus Yes and No for a `(y/n)` prompt
  and arrows when its hint names them. An answer to a changed screen is refused. Each such
  wait is logged once ([#205](https://github.com/devswha/herdr-web-ui/pull/205) by @Haeminway1, [#216](https://github.com/devswha/herdr-web-ui/pull/216)).
- **Add PC** on a Windows host now says that Windows hosts are not supported yet, instead of
  failing with the host shell's "'sh' is not recognized" ([#208](https://github.com/devswha/herdr-web-ui/pull/208), [#189](https://github.com/devswha/herdr-web-ui/issues/189)).
- A pane waiting for another web bridge no longer frees its input for a moment and reports the
  wait twice when herdr's refusal of a retry arrives slowly (a busy PC). It keeps waiting and
  tries again instead, however late that refusal's exit is
  ([#207](https://github.com/devswha/herdr-web-ui/pull/207) by @Haeminway1, [#216](https://github.com/devswha/herdr-web-ui/pull/216)).
- In the terminal, **Ctrl+Shift+↑/↓** only switches panes. It no longer also types `ESC[1;6A` /
  `ESC[1;6B` into the pane it switched to ([#215](https://github.com/devswha/herdr-web-ui/pull/215)).
- On a wide screen, the quick replies above the message box line up with the box instead of
  starting at the chat pane's left edge ([#212](https://github.com/devswha/herdr-web-ui/pull/212)).
- Queued messages show under the chat lens only. In the terminal lens they stay saved but
  hidden, so their **Send now** can no longer type into a Codex question that only the chat
  lens knows is open ([#213](https://github.com/devswha/herdr-web-ui/pull/213)).

## [0.3.35] - 2026-09-30

### Added
- A Korean README (`README.ko.md`), linked from the English, Simplified Chinese and
  Japanese READMEs.

### Changed
- Remote PCs without their own herdr get herdr 0.9.3 in the bundled runtime (was 0.9.1),
  along with this release's event-stream recovery for the remote bridge. The runtime is
  version 8: a connected PC's bridge asks for **Update bridge…** once, and herdr sessions
  keep running while it updates.

### Fixed
- Claude Code's unnumbered menus, such as the folder-trust check on a folder it has not seen
  ("Enter to confirm · Esc to cancel"), show as a card in the chat and can be answered there.
  herdr reported the pane INPUT, but no card appeared. An answer presses Enter only once the
  cursor is on the row it answers; a menu whose rows cannot be told apart gets no card.
- The iPhone home-screen app starts below the status bar instead of drawing beneath it, so the
  header text is no longer blurred on iOS 27 ([#199](https://github.com/devswha/herdr-web-ui/pull/199) by @Yoonwoo-Ha). iOS reads this when the app is added, so an
  existing install keeps the blur until it is removed from the Home Screen and added again; send
  or copy unsent drafts and queued messages first. See [the testing guide](docs/ios-home-screen-testing.md).
- A Codex pane no longer reads RUN for good after its first turn. herdr reports Codex as
  `unknown` at rest, and that was taken for more work; the agent that worked reading `unknown`
  is now a finish (DONE until seen, with its done alert). Late session snapshots no longer
  end a newer turn, and DONE follows the agent that finished.
- Subscription usage no longer lists Copilot for everyone signed in to the GitHub CLI. GitHub
  gives every account Copilot Free, so a Free plan found only through `gh` is left out; a
  Copilot sign-in in an editor, or a paid plan, still shows.
- A local or remote PC refresh no longer replaces a newer pane status with an older
  snapshot. Status and session changes received during a refresh queue a fresh load.
- The installed iPhone app no longer leaves a band under the composer. The shell keeps its
  full height until a text field takes the keyboard, and the keyboard sizing also follows
  direct terminal typing and pointer changes, and clears when a focused field goes away.
- Tapping an alert opens its PC and pane, also when the tap starts the app or focusing the
  window is refused; the newest tap wins over an older one still opening.
- A pane whose terminal another web bridge on the same herdr has open (two installs side by
  side) now waits for it instead of ending with "Another web bridge is attached": it says so,
  keeps the chat readable, and attaches by itself as soon as the other bridge lets go.

## [0.3.34] - 2026-09-30

### Added
- A pane herdr could not restore after a restart (herdr 0.9.3+, e.g. its folder was
  removed) is marked NOT RESTORED in the sidebar, and selecting it shows herdr's reason
  instead of a terminal that ends at once. The server no longer tries to attach it.
- The new-session dialog offers OmO when `omo` is installed on the PC. herdr cannot start
  omo itself, so the new pane's shell runs `omo` and the dialog waits until it is up.
- Subscription usage beside Settings: the plan limits of Claude, Codex, Cursor, Copilot,
  Grok and Antigravity, read with the sign-in each tool keeps on the server's PC, which is
  never refreshed. Each account shows its limit closest to running out, red from 80%; a
  tap lists every limit with its reset time. Two accounts of one provider (a second
  `~/.codex-*` or `~/.claude-*`, several GitHub CLI or Grok sign-ins) are listed apart,
  named by their email or login. Settings orders the accounts, hides any, and counts what
  is used or what is left. Off until turned on in Settings, since it sends the PC's
  sign-ins to each provider. `GET /api/usage`.
  Sign-in locations and endpoints follow OpenUsage.

### Changed
- Tested against herdr 0.9.3: CI runs the integration and browser suites on it, and the API
  types are generated from its schema. herdr 0.9.0 or newer is still enough.
- The website is redesigned after herdr.dev: ink and paper modes, one large headline with the
  install line, a strip of figures, and five numbered rows for what the app does. It is built
  from the README's own media: its top video, with a tab that swaps it for the demo app, its
  four feature clips, and the installer screenshot.
- The one-line installer installs the latest release instead of `main`, so a new install
  runs the same version as existing ones and never picks up changes merged since.
  `HERDR_WEB_UI_REF` still picks another branch or tag.

### Fixed
- Enforce device permissions and request origins consistently, persist device changes
  before reporting success, and stop alerts after device access is revoked. A device that
  can only watch can no longer read files on a connected PC through a path with an empty
  segment, and an alert subscription made before any pairing stops once pairing closes the
  open network.
- Show remote conversation images and full tool output, including Codex output inherited
  from earlier rollouts.
- Dragging terminal text copies the visible selection immediately, including when an
  installed app's asynchronous clipboard permission is blocked. Scrollback copies
  reserve clipboard access during the release gesture; delayed or empty selection
  responses cannot erase a newer copy.
- Settle sent composer drafts across pane switches and cancel all delayed completion
  alerts when work resumes.
- Closing the selected pane with the sidebar's X no longer puts the keyboard on the pane
  selected in its place. On a phone it came up over the drawer, in the way of closing the
  next pane. A pane or lens the user picks still takes the keyboard.
- Pane statuses and web push recover when herdr drops the app's event stream: herdr 0.9.2
  and newer close a listener that falls behind, and herdr restarts do the same. Every
  stream now reconnects at once, keeps trying while herdr restarts, and reads back what
  it missed from herdr, so a pane created meanwhile is no longer left without status or
  alerts for up to a minute, and an alert for a pane that has since gone quiet is called
  off instead of sent.

## [0.3.33] - 2026-09-29

### Fixed
- The chat finds an omo pane's conversation again with current omo, which no longer keeps
  its session file open. It now reads the session omo records as held by the pane's
  process, so the chat works with several omo panes in one folder, on macOS, and after
  `--continue`, `--resume` or `/new`.
- The installed Android app picks up the auto-rotate fix from 0.3.32 a day sooner. The
  first launch after upgrading from 0.3.31 or older still got the old, rotating web
  manifest from the previous service worker's cache, and Chrome checks the installed app
  against it at most once a day.

## [0.3.32] - 2026-09-29

### Added
- The desktop terminal selects with a plain drag and copies on release, like the herdr
  TUI; Ctrl+C copies a selection instead of interrupting the pane.
- A selecting drag can outlive one screen: the wheel, or dragging past the top or bottom
  edge, scrolls herdr's scrollback, and the copy is herdr's own text for the whole range
  with soft-wrapped lines joined. Plain HTTP, view-only tabs and PCs on an older bridge
  copy the visible selection. Remote PCs use bundle v7.

### Removed
- The todo pill at the top right of the chat is gone, with its lane beside the
  transcript. The chat shows the agent's transcript and nothing pinned over or beside
  it: a todo call stays in its turn's work block, where it reads as the done count or the
  step it took and opens to the whole list.

### Fixed
- A terminal attach whose helper process could not start (for example, `node` missing from
  PATH) no longer leaves the pane half-open. The pane stayed blank for the next device, and
  closing that device crashed the server. The attach now reports the error, the failure is
  written to the server log, and the pane can be opened again ([#155](https://github.com/devswha/herdr-web-ui/pull/155)).
- The installed app on Android follows the phone's auto-rotate setting. With rotation
  locked it no longer turns sideways when the phone is tilted. The service worker no
  longer serves a cached web manifest, so Chrome sees this change and updates the
  installed app; reinstalling applies it at once.

## [0.3.31] - 2026-09-29

### Added
- Recognized password, SSH passphrase and PIN prompts offer a masked input in both
  lenses. Secrets go straight to the attached terminal after a fresh prompt check;
  they are never saved in drafts or the held queue. Remote PCs use bundle v6.
- The herdr plugin's **Phone setup** action opens a pane with the phone address, QR and
  a pairing code. It follows the active app release and shows any needed Tailscale command.
- A **Needs you** group at the top of the sidebar gathers agents waiting for input across
  connected PCs, including collapsed PCs, without changing workspace order.
- Japanese (日本語) and Simplified Chinese (简体中文) join English and Korean in Settings →
  Language. System follows the browser's first translated language, so a Japanese or Chinese
  browser now opens in its own language; dates and times follow it too.
- Settings → Phone offers **Keep screen on**, off by default. Supported browsers keep
  the screen awake while viewing a terminal or chat pane and release it in the background.
- Settings → Alerts can send another test notification to this device, with a result
  and a way to turn alerts on again when its subscription is missing.
- The one-line installer ends a first install with one line asking for a GitHub star, so
  other herdr users can find the app. Reruns, such as the one for the phone address, skip it.

### Changed
- The new-session dialog's agent list shows each agent's mark beside its name, and the plain
  shell entry reads "Shell" in every language (it was "셸만" in Korean). Every agent herdr can
  start now has a mark (Amp, Antigravity, Cline, Devin, Droid, Gemini CLI, GitHub Copilot,
  Grok, Hermes, Kilo, Kimi, Kiro, maki, Muse, pi, Qoder, Qwen) instead of a letter, in the
  sidebar and palette too.
- The agent's todo list no longer sits in the chat. It floats at the top right of the chat
  pane, as a one-line pill (done count and the item in progress) that opens to a card with
  the whole list, like the WORK card in gajae-code-app. A pane wide enough keeps a lane
  for it beside the conversation; a narrower one shows it over the conversation until it
  is closed (Escape closes it too).

### Fixed
- The chat finds a Claude Code pane's conversation when its folder name has a dot, an
  underscore, a space or non-ASCII characters (a Korean folder, `example.com`, `my_project`).
  The project folder is now named the way Claude Code names it, and a session Claude
  started in another folder is found by its id.
- A GJC pane's chat stays on the pane's own session after GJC runs subagents. GJC points its
  terminal breadcrumb at a subagent's transcript while the subagent runs and leaves it
  there, so the chat switched to that subagent's conversation, and its last turn read
  "Working…" for as long as the real session worked. A subagent's file now stands for the
  session it belongs to.
- Image thumbnails in a chat message keep a fixed box, so a lazy image no longer grows the
  message by about 120 px when it loads and pushes the view off the bottom. Non-square
  attachment tiles in the composer are cropped to fill instead of stretched.
- A tap on a touch screen no longer leaves the hover background on the paperclip, the
  search button and other buttons and menu rows; hover styles now apply only where a pointer
  can hover.
- The folder browser shows a loading row until its first listing arrives, instead of an
  empty list. File sizes read in bytes below 1 KB ("179 B", not "1 KB"), and an empty file
  reads "0 B", not "0 MB".
- On a phone, a short text file in the file viewer starts at the top instead of floating in
  the middle of the screen; images, video, audio and PDFs stay centered.
- Escape in a file opened from the Files dialog closes only the viewer, so the folder you
  browsed to stays open; Escape still closes the Files dialog when no file is open.
- The Add PC dialog focuses the SSH field when it opens, not the Close button.
- The Add PC dialog no longer shows a step that has already passed. Approving the changes or
  answering an SSH question moves the step on in the same response, so the question's
  heading does not linger until the next poll. Starting a bridge on a PC that had none is
  labelled by its own step instead of "Restarting the bridge", and a step without byte
  progress, such as registering the app SSH key after the bundle install, shows its own
  text instead of the previous stage's label.
- The chat no longer relabels the previous, finished turn "Working…" for a moment after you
  send a message: the turn that was last when the message went out stays finished until the
  transcript holds the reply to it. When the pane starts or stops working, the chat also reads
  the conversation at once instead of at the next 2 s poll, so DONE and the answer arrive
  together rather than the answer trailing by up to 2 s.
- The Add PC dialog shows what SSH prints while it connects, under the current step, with
  https addresses as links. A message that needs the user but does not end SSH, such as
  Tailscale SSH's browser check URL, no longer looks like a hang. The text is the same as the
  failure message and disappears once the connection is up.
- When a GJC pane is matched to its transcript by the text on screen, the oldest whole
  record in each candidate's 64 KiB tail is read too. A complete record was dropped along
  with the cut first line, or in place of it when the window started exactly on a record.

## [0.3.30] - 2026-09-29

### Added
- A Japanese README (`README.ja.md`), linked from the English and Simplified Chinese
  READMEs' language selectors.

### Fixed
- Prompt cards list each option on its own full-width row, number, label and description
  aligned, instead of wrapping buttons of uneven width. The first option is no longer filled
  as if already chosen, which left its description unreadable in both themes. Checked and
  typed picks share one highlight, a `(Recommended)` option shows a tag, multi-select Submit
  counts the picks, and the custom-answer field is labelled.
- Enter while an IME is composing in the prompt card's custom answer no longer sends the
  half-composed text.
- In Safari and other WebKit browsers, the Enter that commits an IME candidate (Korean,
  Japanese, Chinese) no longer sends the chat message, the prompt card's custom answer or
  the touch terminal's input line. WebKit delivers it after composition ends, as key code 229.
- An image attached after typed text gets its own `@path` token: a space goes in front
  of the mention when the text before the caret does not end in whitespace, so the
  chat shows its thumbnail and the agent reads the path.

## [0.3.29] - 2026-09-28

### Fixed
- Escape closes the command palette even if terminal attachment moves keyboard focus
  outside it, and does not forward that Escape into the terminal.
- Restore GJC chat when its writer closes the transcript between writes. Resolve the
  native terminal-to-session breadcrumb, validate it against the running process and
  session store, or match a unique substantial assistant answer visible in that pane.
  Ambiguous matches never fall back to the newest file in the working directory.
  When native history is unavailable, agent panes show a labeled terminal-output
  disclosure instead of presenting raw terminal UI as assistant messages.
- A latest assistant turn waiting on approval remains in progress instead of reading
  “Worked for …”. The transcript's last-activity timestamp is not a completion signal.
- Suppress native browser tap highlights on buttons and links so mobile approval options
  show only the app's selection and pressed states.

### Documentation
- Clarify that pinned plans require supported todo-tool records. Claude Code sessions
  without TodoWrite do not currently show a pinned plan; TaskCreate/TaskUpdate support
  remains pending.

## [0.3.28] - 2026-09-28

### Fixed
- Problem reports now bound the full encoded GitHub URL, preventing errors with long or Korean
  reports. Large reports can be copied or saved for attachment. The report dialog fits mobile
  screens, its chat entry button has a visible label and a touch-sized target, and manual edits
  survive status updates and inclusion changes until explicitly rebuilt.
- Messages queued while an agent works now form a persistent list per PC and pane instead of
  replacing the previous message. Each item can be edited, discarded, or explicitly sent;
  confirming one send leaves the remaining messages intact. Queue mutations read the latest
  stored list across tabs, and failed persistence is shown before a reload can lose messages.
- On iPhone (iOS 26 and later) the header of the home-screen app was blurred, not in Safari. iOS
  lays its Liquid Glass edge blur over the top of an installed web app unless a fixed or sticky box
  with a background covers that edge; the header is now sticky, so iOS takes its color there.
- Alerts could be turned on but not off: once on, the bell was disabled. It is now a switch for
  this device. Off drops the device's push subscription (the server forgets it) and silences the
  page's own alerts; on subscribes again. The choice is kept per device.
- A video playing next to the app stuttered while an agent worked. The working dot (the RUN badge,
  a live work block, a reconnecting connection) faded in and out smoothly, so the browser drew a
  new frame at every display refresh, 60 or more a second, for as long as the agent ran. It now
  jumps between its two looks: about one frame a second (600 to 13 frames in 10 s in the chat
  view, measured in Chrome).
- Android's system Back button closes a file or video preview and returns to the
  chat instead of leaving the app. Closing with X, Escape or the backdrop also
  consumes the preview's history entry; Forward restores the original file target.
- GJC chat only selects a unique transcript file held open by the pane's process.
  Panes sharing a working directory no longer follow whichever session was modified
  last. When exact file evidence is unavailable (including directory-only descriptors
  and platforms without `/proc`), chat reports unavailable instead of guessing.
- Machine polling no longer overwrites newer streamed pane statuses or machine rosters.
  Superseded HTTP responses and errors are ignored; subsequent polls still catch up.

## [0.3.27] - 2026-09-27

### Fixed
- An omo pane's chat keeps its transcript while a background task runs. omo holds the task's log
  (`.omo/senpi-task/logs/*.jsonl` in the working directory) open, and that file was taken for the
  pane's session, so the chat fell back to terminal text until omo restarted. Only files in omo's
  session store count now.

## [0.3.26] - 2026-09-27

### Changed
- Releases are published only from a `main` commit that passed the full CI run, and pull requests
  must pass the same checks before they merge.

### Fixed
- Foldable and tablet-width screens (481-768px, e.g. a Galaxy Z Fold8 inner screen): the header no
  longer breaks the Korean "채팅"/"터미널" labels one syllable per line, and no longer shows the
  sidebar collapse toggle (a no-op in drawer mode) or sign out beside the drawer button. Up to
  560px the chat/terminal switch shows icons only, so the pane title keeps room.
- The chat's terminal-text fallback, used when an agent's transcript cannot be found, reflows lines
  the terminal soft-wrapped instead of breaking them where the pty's columns ended. A PC whose
  herdr predates unwrapped reads falls back to the old read.
- Korean UI: the new session dialog's Browse, the prompt card's Submit and Send, and the held-input
  and queued-message banners' Send, Discard and Send now are translated.
- Phone-width screens (up to 480px) hide the command palette's keyboard shortcut hints, and the
  key bar puts its direct-typing toggle first, so a narrow cover screen no longer cuts it off.

## [0.3.25] - 2026-09-27

### Added
- Chat Markdown renders inline `\(...\)` and display `\[...\]` equations with KaTeX.
  Code stays literal, and invalid or incomplete formulas preserve the surrounding Markdown.

### Changed
- The installer keeps herdr's plugin install preview (every command of the manifest) to itself and
  prints only herdr's `Installed ...` line; when the install fails, it prints all of herdr's output.
- README: a sample of the installer's output, from a PC that had herdr but no Bun or Node.

### Fixed
- Ctrl+V in the terminal pastes clipboard text instead of sending a control character that
  triggers an agent's image-paste shortcut and reports "No image in clipboard". Korean text,
  multiline paste, Ctrl+Shift+V and other terminal control keys retain their expected behavior.
- Revoking a paired device closes its active terminal connections and roster stream immediately.
  A corrupt or unreadable device registry stays gated and intact, with recovery guidance.
- Token and paired-device sessions show **Sign out** in the header and command palette.
  Closed or obsolete pane selections recover to a live pane without discarding newly created
  panes or selections on disconnected PCs.
- The plugin also reads its settings from `.env` in herdr's plugin config dir, the name herdr's
  plugin docs use; it read only `env`, so a `.env` (say, `HOST=0.0.0.0` for a reverse proxy) was
  silently ignored. `env` is still read; where both set a key to different values, `.env` wins and
  `start` and `status` name the keys (never their values). `status` prints the files it read. The
  plugin checkout runs this, and in-app updates do not replace it: reinstall the plugin to get it.

## [0.3.24] - 2026-09-27

### Changed
- The installer's addresses are links a terminal can open with a click (OSC 8), plain text when
  the output goes to a file or log. It also names this PC's Tailscale IP next to the phone address,
  which stays the MagicDNS name: the HTTPS certificate is for the name, not the IP.

## [0.3.23] - 2026-09-27

### Fixed
- The one-line installer, run where the app is already installed, prints the phone address and its
  QR code from the version that runs. herdr's plugin directory keeps the version first installed
  (in-app updates run from `~/.config/herdr-web-ui/updates`), so it used to find no `phone` step
  there and only said to update. A running version from before 0.3.22 gets the address it already
  knows, as a QR code.

## [0.3.22] - 2026-09-27

### Added
- A one-line installer: `curl -fsSL https://devswha.github.io/herdr-web-ui/install.sh | sh`
  installs what is missing (herdr, Bun, Node 22, for the user only and without sudo), installs the
  herdr plugin and starts it when herdr runs. When Tailscale runs on the PC, it serves the app to
  the tailnet on the first free HTTPS port, says how to undo that, and prints the address a phone
  opens as a QR code. Running it again keeps what is there and prints the address again.
- `bun scripts/plugin.ts phone`, the installer's last step, for a plugin installed without it.

### Changed
- Through a proxy on a PC whose Tailscale login is known, as with `tailscale serve`, a request
  with no login (a tagged device) needs pairing, even before the first device is paired.
- The plugin starts the server with `~/.bun/bin`, `~/.local/bin` and the installer's Node appended
  to herdr's PATH, so a herdr started from a shell without them still runs terminals.

## [0.3.21] - 2026-09-27

### Added
- Codex and Claude skill activity stays visible above folded chat work blocks: the skill name,
  invocation/read status, and expandable evidence or document path. Recorded activity is distinct
  from completing the skill's workflow; English and Korean labels work on desktop and mobile.
- Native Codex image attachments, including image-only prompts, appear in the chat through
  bounded, pane-scoped image reads.

### Fixed
- Native context clears discard old turns, pending calls, loaded pages and stale cursors.
  Late page and tool-output responses cannot restore cleared history or populate another pane.
- omp, omo and gjc transcripts honor hidden messages and normalize string messages, tool field
  aliases and embedded results consistently across rendering, paging and full-output reads.
- omo transcript selection uses process/session evidence and rejects ambiguous same-directory
  candidates. Claude paste wrappers unwrap only when their identifiers match.

### Changed
- Growing Codex tasks parse incrementally while preserving transcript rewrite invalidation,
  reducing repeated parsing of long tool-heavy turns.

## [0.3.20] - 2026-09-27

### Added
- **Report a problem**: a small bug icon at the end of the chat's status line gathers what a chat
  or prompt-card bug is made of (the versions, browser and agent; the latest turns and the prompt
  card as parsed; the terminal screen if chosen) into a report to read and edit. It is then
  copied, saved as a file, or opened as a prefilled GitHub issue; nothing is sent on its own.

### Changed
- The ⚡ button beside the message box is gone: quick replies show above the box only when turned on
  in **Settings → Quick replies** (off by default), so the box looks as it did before them.
- The context left is a small ring beside the model, filled by what is used and red when little is
  left, as Codex's app shows it; hovering or tapping it says "Context 27% left" with the token
  counts. A session whose window the transcript does not name shows no ring.
- The `/ commands  @ files` hint above the message box is gone.
- In the sidebar, the computer the app runs on is marked **Host**, not "This PC", which on a phone
  read as the phone.
- Settings open from the sidebar's Settings button (and ⌘⇧, or the palette): the ⚙ in the header,
  one more way to the same place, is gone. On a phone that is ☰, then Settings.

### Fixed
- Numbered lists in the chat keep their numbers now: items with blank lines between them (as agents
  often write them) each read "1.", a list broken by a code block started over at 1, and one that
  began at 3 read 1. An item's indented lines now read as its own text, and a code block indented
  inside a list reads as code.

## [0.3.19] - 2026-09-27

### Added
- Quick replies: one-tap messages above the chat's message box (`continue`, `yes`, `no`,
  `commit and push`, `retry` to start with). Each is sent as if typed: queued while the agent works,
  taken as the answer when a question is open, and a draft in the box stays. **Settings → Quick
  replies** edits the list on each device; the row is hidden until the ⚡ button beside the paperclip
  shows it.
- The chat's status line says how much context is left: `74% left` from the window Codex records,
  or for Claude once a request has run past 200k (the 1M window); `68k used` where the transcript
  names no window (omp, omo, gjc, and Claude below 200k). It turns red at 20% left. Hovering shows
  the token counts.
- A tool call that failed says so: its row reads "failed" in red, its output is headed Error, and
  the folded "Worked for…" header counts the failures. Claude and omp record the failure; for Codex
  it is read from the output (a command that exited non-zero, a script or patch that failed).
- A file a tool call names (an edit, a read, a patch's files) opens in the viewer on a tap.
- A Codex patch reads as a diff: each file as a header, then its lines in red and green, and the row
  is summed up by the files it touches, also when an `exec` script applies it.
- While reading further up the chat, a ↓ button takes you back to the end, new messages or not.
- Images you sent show above your message: ones pasted into Claude's prompt, fetched only when
  shown, and ones attached here (an `@…png` mention). A tap opens them.
- An edit reads as one diff: unchanged lines once, removed and added lines in place between them,
  instead of the whole old block and then the whole new one. Several edits to one file each get
  theirs.
- Where a compaction folded a Claude conversation, a divider says so, and opens to its summary.
- Headings down to `######` render as headings.
- A tool output cut for the chat (past 4,000 characters) has a "Show the whole output" button that
  fetches the rest, up to 2 MB, into a box of its own.
- The `/` menu lists Claude's skills (yours and the project's) and the skills and commands of the
  plugins turned on in its settings, as `/<plugin>:<name>`. In a Codex pane it lists your saved
  prompts as `/prompts:<name>`, and `$` opens Codex's skills.
- On a phone, the terminal lens has an input line above the key bar. A phone keyboard rewrites
  what it typed (dictation revising a phrase, a Korean syllable being composed, autocorrect), and
  the terminal could not take back keys it had sent, so every revision arrived as more text. The
  line is written with the keyboard's own editing and goes to the pane whole, then Enter (typed
  like the keyboard, into an agent's open menu too); an empty line's button presses Enter alone.
  Tapping the terminal no longer raises the keyboard; the ⌨ key on the key bar switches to typing
  straight into it, remembered per device. Desktops are unchanged.

### Changed
- Remote PCs use the `remote-v5` runtime, which carries this release's server side to them: the
  context left and failed calls in their chats, images and whole tool outputs, skills in the menu,
  questions read in a narrow pane, and the terminal's input line. A connected PC's bridge updates
  itself as for `remote-v3`.
- Alerts wait before they go out, and a change of the pane meanwhile calls them off: a question
  answered at the PC within 10 seconds, or a finish followed by the next prompt within a minute,
  never buzzes the phone. A finish is told only after a turn that worked a minute or more, since a
  quick answer is read where it was asked.
- **Settings → Alerts** chooses, per device, whether a waiting agent alerts, and whether a finish
  does never, after a long turn (the default) or every time (then after 10 seconds). An ended
  terminal follows the finish choice.

### Fixed
- An agent's chat said "No conversation yet" until its first answer arrived, seconds on a remote PC.
  It now says it is loading.
- A Claude question never showed as a card in the chat when its pane was narrow (a phone, a split):
  the hint under the menu wraps (`… Esc to` / `cancel`), and it was looked for on one line. Hints
  are now read across the wrap, in every agent's menus, and so is the check that a menu is still
  open before an answer is typed into it. A single question's card is titled by its header chip.

## [0.3.18] - 2026-09-26

### Changed
- Remote PCs use the `remote-v4` runtime, which carries the fix below to the remote side: an omo
  or gjc pane that finished keeps reading DONE after the bridge restarts. A connected PC's bridge
  updates itself as for `remote-v3`.

### Fixed
- An omo or gjc pane that had finished read READY again after this server restarted (an update
  does): what this server adds to herdr's own `done` lived in memory. It is now kept in
  `completions.json` in the state directory, for the herdr it was seen in; a herdr started anew
  starts it over.

## [0.3.17] - 2026-09-26

### Changed
- Remote PCs use the `remote-v3` runtime, which carries 0.3.16's server fixes to the remote side: a
  finish in the pane herdr has in front reads DONE, and a Codex answer ending with a file link is
  found on screen. With **Update PC bridges automatically** on (the default), a connected PC's
  bridge updates itself once the app has; otherwise it asks for **Update bridge…**. herdr sessions
  are kept either way.

## [0.3.16] - 2026-09-26

### Added
- A pairing code from the PC's terminal, for a headless PC with no browser to open Settings →
  Devices in: `bun scripts/plugin.ts pair` (in the plugin checkout; a terminal command, since herdr
  keeps an action's output in its log) prints the code, the address a phone opens when Tailscale
  serves one, and that address as a QR code. Run by hand, it reads the PORT, HOST and token the
  plugin runs with from the config dir herdr names for it. Settings → Devices also shows the pairing
  link as text, to send to the other device however you like.

### Fixed
- Web addresses in the chat open. An address in backticks (`` `https://…` ``, as agents often write
  them) is a link that still looks like code; `[docs](www.example.com/x)`,
  `[guide](docs.example.com/guide)` and `[here](localhost:7317)` are links, not files; a bare
  `www.example.com/…` links like a full URL does, and `[here](127.0.0.1:8080)` over plain http. A
  file and its line (`[main.ts](main.ts:42)`) still opens the file, never a site of that name. In
  the terminal view, addresses in the output open in a new tab on click.
- A Codex chat whose last answer ends with a file link said "Conversation unavailable" while the
  terminal was open. Codex shows such a link as its label and a path relative to the repo, not
  the absolute path the session file keeps, so that answer was never found on screen. Answers are
  now looked for up to their last link target.
- An agent that finished in the pane herdr's terminal has in front read READY, and sent no alert,
  though nobody was looking: herdr reports a finish there as idle, and working from a browser or
  a phone never moves that focus. A finish now reads DONE and alerts in every pane, until the pane
  works again or focus moves onto it in herdr's terminal.
- A chat link to a local file (`[report](/repo/output/REPORT.md)`, as Codex writes them) showed
  only its label, so a sentence like "results and evidence" ended with nothing after it. The label
  now opens the file in the viewer, and where no viewer is available the path shows after it.

## [0.3.15] - 2026-09-26

### Added
- The app speaks Korean. It follows the browser's language, or **Settings → Appearance → Language**
  picks English or 한국어. Every label, button, hint and status in the client is translated; what
  agents write, terminal output and server messages are not. A test keeps the dictionary complete.

## [0.3.14] - 2026-09-26

### Added
- **Who gets in, without a token.** From anywhere but this PC, a request now gets in as the PC's
  own Tailscale login (which `tailscale serve` states in a header nobody else can set), as a
  paired device, or with the token. **Settings → Devices** pairs a device: a six-digit code that
  lives ten minutes, or the QR code that carries it, entered once on the other device, which then
  keeps its own credential; the list shows every device with its last visit, and **Revoke** ends
  one at its next request. Another Tailscale user's device is refused with a message. Until the
  first device is paired, and with no token set, a LAN or proxied address stays open as before.
  The sign-in screen asks for the code first and keeps the token as the other way.

## [0.3.13] - 2026-09-26

### Fixed
- With two or more Codex panes, one pane's chat could show another pane's conversation. Since
  Codex 0.157 every Codex TUI shares one app-server daemon, and that daemon reports each TUI's
  thread to herdr as the thread of the pane that started it. That report is now only a fallback:
  what the pane shows on screen decides, and a thread another pane shows, is bound to, or was
  resumed on is never taken for it.

## [0.3.12] - 2026-09-26

### Added
- The website has a demo, <https://devswha.github.io/herdr-web-ui/demo/>: the app itself on a
  fictional session, no server. Its five panes, chats and Codex approval are the README media's;
  answering the approval, sending a message and typing into the shell pane all get demo answers.

### Fixed
- Installing no longer compiles a native module. The terminal addon comes prebuilt for Linux x64
  and arm64 and for macOS (`@lydell/node-pty`, node-pty 1.1.0 repackaged), so a PC without Python
  and a C++ toolchain installs, where `herdr plugin install` used to end in a page of node-gyp
  errors and "Plugin was not installed". The first build step now says in one line what is
  missing (`bun`, `node`, or a version too old) instead of failing some steps later.

## [0.3.11] - 2026-09-26

### Added
- **Settings → Phone**: how to get the app onto a phone from this PC. When the page is already on
  an HTTPS address, or Tailscale on the PC already serves the app, it shows that address as a QR
  code. Otherwise it shows the one `tailscale serve` command still to run, on the first free of the
  usual HTTPS ports, with a Copy button and the address it will give, or says that Tailscale is
  not connected or not installed. The server reads `tailscale status` and `tailscale serve status`
  only (`GET /api/access`); it never changes the tailnet.
- **Star on GitHub** in Settings → About, next to a link to the website.
- A website, <https://devswha.github.io/herdr-web-ui/>: the demos, the install command, the phone
  setup and how it compares with other herdr phone clients. GitHub Pages builds it from `site/`
  on every push to `main`; `bun run build:site` builds it locally.

### Fixed
- A link styled as a button (**Reconnect** after a PC drops, **Star on GitHub**) is no longer
  underlined.

## [0.3.10] - 2026-09-26

### Fixed
- A file named without its folders in a chat answer (`demo.mp4` for `docs/screenshots/demo.mp4`)
  opens: the viewer finds it under the pane's folder, ignored files included, and lists the
  files to choose from when several have that name. It used to say "No readable file".

## [0.3.9] - 2026-09-26

### Added
- Open the files your agents write, from any device. A file path in a chat answer
  (`docs/demo.mp4`, `~/out/shot.png`) opens in a viewer: images, video and audio that play and
  seek at once, PDFs, and the start of a text file, each with Open in new tab and Download.
  **Browse files** (in the header, or the command palette on a phone) lists the pane's folder
  and any other. Files stream from disk with ranges, so a large video costs the server no memory;
  HTML and SVG open sandboxed and text as plain text, never as script on the app's origin.

### Changed
- The README's screenshots and demos are sharper and framed: recorded at 2x, in a browser window
  or a phone, with a moving camera and cursor on desktop. The phone demo no longer shows only the
  top left of the screen.

## [0.3.8] - 2026-09-26

### Added
- The chat pins the agent's todo list to its bottom: done count and the item in progress on one
  line, the whole list by phase when opened. It follows Claude Code's `TodoWrite`, Codex's
  `update_plan`, and omp, omo and gjc todo operations, and in the work block a todo call reads as
  one line ("done · Build") that opens to the list as it stood after it.

### Fixed
- A pane's terminal (and the chat over it) no longer shows "terminal ended" when it reconnects
  just after Codex finished an answer, for example on a phone coming back from the background.
  herdr refuses an attach while a read of the same terminal is in progress, and asks for a
  retry. On an idle Codex pane, the transcript match's 400-line read makes herdr scroll the
  history back, which takes about a second or more. The attach is now retried for as long as
  such a read can last, and a refused attach no longer prints herdr's message into the terminal.
  ([#45](https://github.com/devswha/herdr-web-ui/pull/45) by @Yoonwoo-Ha)
- An omo or gjc pane that finishes while you are not looking at it reads **DONE** (and alerts),
  not READY, and reads RUN while it works. herdr recognises these agents from their screen and
  processes; omo's label turns from `pi` to `claude` mid-turn, so herdr reported the whole turn
  as `unknown` and its end as plain `idle`. The server now keeps whether each pane worked and
  reports what herdr does for agents it does not lose: done until the pane is focused in herdr.

## [0.3.7] - 2026-09-25

### Added
- Answer an agent's waiting prompt from the chat's message box: type an option's number or your
  own answer. A pick for an approval, a plan or a menu waits in the prompt card for **Confirm**,
  and the options are numbered to match ([#6](https://github.com/devswha/herdr-web-ui/pull/6) by @Yoonwoo-Ha).
- Codex's queued questions (the collapsed "? N questions" block) show as a card and are answered
  from the chat; the queue closes again afterwards, so messages still reach Codex. Prompts of
  Claude Code 2.1 and Codex 0.156 are recognised ([#6](https://github.com/devswha/herdr-web-ui/pull/6) by @Yoonwoo-Ha).
- **Browse** beside the directory field of a new session: pick the folder from a list instead of
  typing its path. It lists one folder at a time on the PC the session starts on, hidden folders
  on request. A remote PC offers it once its bridge is updated; until then, type the path.

### Fixed
- The header no longer says "reconnecting" after you switch to another pane on the same PC. The
  switch reset the connection badge, and the terminal, still connected, never reported again.

## [0.3.6] - 2026-09-25

### Added
- gjc and omo have their own marks in the sidebar and the chat. An omo pane is named `omo` even
  though herdr labels it `pi` or `claude` as omo works, so its mark no longer changes under you.
- gjc panes open in the chat view with their conversation, model and effort, like omp and omo.
  The chat follows the session the pane's gjc has open.

### Fixed
- A request that failed (an authentication error, an overloaded provider) shows its error in the
  chat of an omp, omo or gjc pane. The prompt used to stand there with no answer at all.

## [0.3.5] - 2026-09-25

### Added
- Web addresses in chat messages are links: a bare `https://…` URL or one in `<…>` opens in a
  new tab, as a `[text](url)` link already did. Punctuation that ends the sentence stays out of
  the link, and so does text written straight after it (e.g. Korean without a space).
- The chat composer attaches any file, not only PNG, JPEG, GIF and WebP images. An icon, a PDF or
  a log is stored beside the pane under its own name and mentioned by path, as images are; SVGs
  get a thumbnail too. Other files used to be dropped without a word.

### Fixed
- Resizing the window no longer lags on a long session. Every frame of the drag resized the pane,
  and each resize made herdr reflow it and the program in it (Claude Code) repaint its whole
  conversation; the terminal now resizes once the drag rests.
- The app does much less work while it sits open. The terminal under the chat view no longer
  draws every output frame, an unchanged chat is no longer re-rendered on every status update,
  and a hidden tab or a phone app in the background stops polling until it is back.
- A chat open on a long session no longer stalls the server every poll while the agent works. The
  server re-read and re-parsed up to 16 MB of the transcript every 2 s; it now reads only what was
  appended and re-parses only the last turn.
- Live status, pane-ended and session-changed updates resume after herdr restarts. One failed
  reconnect used to stop them until the web server itself restarted.
- Long code blocks in a chat answer no longer look cut off. A block was capped at about six lines
  with the rest behind an inner scroll that a phone does not show, so a long answer seemed to stop
  halfway. Blocks now show whole; one longer than 30 lines opens at its first 20 with a
  **Show all N lines** row below it.

## [0.3.4] - 2026-09-25

### Changed
- On a phone or tablet, an agent pane opens in the chat the first time you select it; shells, and
  every pane on a desktop, still open their terminal. The lens you pick is still remembered per
  pane.

### Fixed
- Scrolling the terminal on a phone scrolls herdr's history again when another tab (for example a
  desktop browser) already had that pane open. The phone joined a busy pane without its mouse
  mode, so a drag turned into arrow keys and paged through the agent's prompt history instead.
- Picking a session in the chat view and typing straight away now types into the chat box. The
  keys went to the hidden terminal instead, straight into the agent's own prompt, and a phone
  showed the typed text in the middle of the screen.

## [0.3.3] - 2026-09-25

### Added
- Remote PC bridges update in the background. When an app update needs a newer bridge, PCs that
  connect with their saved key are updated automatically (**Settings → Remote PCs**, on by
  default); with it off, **Update bridge** starts the same update in one tap. A PC that needs a
  password asks through **Sign in and update…**.
- The sidebar and the header show a bridge update's step, bytes and time left, with **Cancel
  update**. Closing the dialog after approval no longer cancels an install.
- The web server keeps downloaded bridge bundles by checksum and downloads each once, so a second
  PC or a retry only sends it to the PC.

### Fixed
- Dragging the terminal on a phone scrolls herdr's history again. The gesture was lost after its
  first move, since the redraw replaced the row it started on, and the browser then scrolled the
  page or the composer instead. The text now also follows the finger (drag down for older lines),
  and each scroll lands at the finger's position.
- Android notifications show the herdr mark instead of Chrome's bell as their small icon.

### Development
- Tests and the browser QA scripts run in a herdr session of their own, `herdr-web-ui-test`, so
  their workspaces and agents never show in the herdr you work in. `HERDR_TEST_LIVE=1` restores
  the old behaviour.

## [0.3.2] - 2026-09-25

### Changed
- A pane opens its terminal the first time you select it, agent panes included, instead of the chat.
  Switch to Chat once and that pane keeps opening in chat.
- `bun run start` now listens on `127.0.0.1` by default, like the plugin, instead of every
  interface. To reach it from your LAN again, set `HOST=0.0.0.0` together with `HERDR_WEB_TOKEN`;
  for a phone, `tailscale serve` or an SSH tunnel to `127.0.0.1` needs no change.
- The README and INSTALL.md say when a token is needed: not on this computer, over an SSH tunnel,
  or through `tailscale serve` on a tailnet of your own devices; needed on a LAN, a shared tailnet
  or a public address.

### Fixed
- A composer message that waited more than 45s behind earlier input is not typed any more; the
  composer keeps it and says nothing was typed. Before, it could reach the pane after the composer
  had given up on it, so sending it again typed it twice.
- Text typed after a message that is still sending keeps its leading spaces, and an edit inside
  the part being sent stays in the box with a note that it was not sent.
- A numbered menu row under Codex's collapsed question queue is no longer mistaken for its main
  prompt.

## [0.3.1] - 2026-09-25

### Changed
- Remote PCs use the `remote-v2` runtime, which carries 0.3.0's server changes (chat pages, the
  Codex conversation fixes, server-side message sending and `304` answers) to the remote side.
  A PC connected with the `remote-v1` bridge needs **Update bridge…** once; its herdr sessions are
  kept.
- A PC that only an update or an approval can reconnect says so: it stops retrying, shows the next
  step under its name with the button that does it (**Update bridge…** or **Set up…**), and a line
  under the header says the same, so it shows on a phone with the drawer closed.

## [0.3.0] - 2026-09-25

### Added
- Chat history pages: a transcript is read one page at a time (at most 16MB and 50 prompts), and
  scrolling up loads earlier turns while keeping your place. A long Codex rollout no longer re-reads
  the whole file on every poll, and a Codex conversation that was backtracked shows the history
  from the rollouts before it.
- **Settings → Chat → Chat font size**, from 11 to 24px. Messages, code and prompt cards scale
  together; the rest of the UI and the composer keep their size.
- The composer is resizable: drag its top edge or use ↑/↓, double-tap or press Home to go back to
  the automatic height. The height is remembered per device and capped at half the visible screen.
- The status line shows the reasoning effort Claude Code records, for example `Reasoning xhigh`.

### Changed
- **New session** is back at the top of the sidebar, opening on the selected PC (the same as
  Mod+Shift+N), with **Add PC** beside it.
- **Install app** shows in the sidebar unless the app is installed. Where the browser offers no
  install prompt (iOS, plain HTTP), it explains the platform's own steps, such as Share → Add to
  Home Screen on iOS. Settings → Install shows the same steps.
- A composer message is now sent on the server: agent panes use herdr's `agent.prompt`, which pastes
  the text and presses Enter separately, and refuses while the agent waits for an answer. Other
  panes get the text, a short gap, then Enter. This fixes messages left unsent in the agent's input
  box on phones, where the text and its Enter used to arrive as one chunk. The composer keeps the
  text until the pane confirms it, and says why when it can't be sent.
- The empty composer is taller (42px on desktop, 48px on touch) and its status line is a size up.
- Unchanged conversations answer `304` with no body, and the chat stops polling while the page is
  hidden, which saves data and battery on phones.
- Each window reopens its own pane on reload; a new window still starts on the last pane used.

### Fixed
- A Codex pane kept its conversation only while an answer was on screen; a long run of tool output
  flipped the chat to "Conversation unavailable". The pane now keeps the rollout it matched, or the
  thread named by `codex resume`, until a newer interactive thread begins in that directory.
- Conversation cursors are tied to the Codex rollout chain, so a changed chain reloads the chat
  instead of showing turns twice or out of order, and a chain whose earlier rollout was archived is
  looked up again instead of falling back to terminal output.
- On an iPhone, a second tap on the token field no longer closes the keyboard, and the empty band
  under the composer is gone.
- On Windows, the terminal measures its cells with a monospace font, so ASCII text is no longer
  spaced apart.

## [0.2.1] - 2026-09-23

### Fixed
- Updates now replace the update supervisor too. `server/managed.ts` became a small launcher that
  runs the active release's supervisor; after an install passes its health check the supervisor
  hands over to the new one (one more brief reconnect), and a new supervisor that cannot start is
  replaced by the previous one, with the failure shown in Settings → Updates.
- Release CI skips the one updater test that needs a live herdr.

## [0.2.0] - 2026-09-23

### Added
- Remote PCs over SSH: **Add PC** walks through the host fingerprint, password or key passphrase and
  an approved install, then groups workspaces by PC. Chat, files, images, terminal input and alerts
  follow the selected PC.
- Remote runtime bundles for linux-x64, linux-arm64, darwin-x64 and darwin-arm64, published as the
  `remote-v1` release and verified by SHA-256.
- Managed app updates: `bun run start` and the herdr plugin run a supervisor that builds each update
  in a private checkout, restarts after a health check, and rolls back a failed start.
- Updates follow release tags, and **Settings → Updates** and the header notice show versions
  (`v0.2.0`) instead of commit ids. The sidebar footer shows the running version.
- herdr plugin installs, which herdr leaves as a shallow detached checkout, can now update in place.
- [INSTALL.md](INSTALL.md), a step-by-step install guide written for coding agents.

### Changed
- Warm terminal redesign: amber on graphite (dark) and ledger paper (light), with agent states in
  their own colors. Sidebar titles use the full width, PC headers fit on one line, user chat turns
  are neutral cards, and the composer placeholder is short.
- The header drops the version pill and the theme toggle. The version is in the connection chip's
  tooltip and the sidebar footer, and theme lives in Settings and the command palette.
- README rewritten around setup, remote PCs, mobile use and updates.

### Fixed
- Codex transcripts resolve on macOS, where `/proc` does not exist.
- Underscores inside identifiers (`MAC_QA_CHAT_OK`) stay literal in rendered Markdown.
- The settings shortcut table no longer splits its row rules.

## [0.1.0] - 2026-09-22

First public version.

- Chat and Terminal lenses on one live herdr pane, with Codex, Claude Code and omp/omo transcripts.
- Composer with `/` commands, `@` file mentions, image paste, per-pane drafts and a queued message.
- Answers to approval, question and plan menus from chat.
- Session management, command palette and keyboard shortcuts.
- Installable PWA, a mobile key bar, web push alerts and optional token auth.
- Distribution as a herdr plugin.

[Unreleased]: https://github.com/devswha/ovis/compare/v0.4.22...HEAD
[0.4.22]: https://github.com/devswha/ovis/compare/v0.4.21...v0.4.22
[0.4.21]: https://github.com/devswha/ovis/compare/v0.4.20...v0.4.21
[0.4.20]: https://github.com/devswha/ovis/compare/v0.4.19...v0.4.20
[0.4.19]: https://github.com/devswha/ovis/compare/v0.4.18...v0.4.19
[0.4.18]: https://github.com/devswha/ovis/compare/v0.4.17...v0.4.18
[0.4.17]: https://github.com/devswha/ovis/compare/v0.4.16...v0.4.17
[0.4.16]: https://github.com/devswha/ovis/compare/v0.4.15...v0.4.16
[0.4.15]: https://github.com/devswha/ovis/compare/v0.4.14...v0.4.15
[0.4.14]: https://github.com/devswha/ovis/compare/v0.4.13...v0.4.14
[0.4.13]: https://github.com/devswha/herdr-web-ui/compare/v0.4.12...v0.4.13
[0.4.12]: https://github.com/devswha/herdr-web-ui/compare/v0.4.11...v0.4.12
[0.4.11]: https://github.com/devswha/herdr-web-ui/compare/v0.4.10...v0.4.11
[0.4.10]: https://github.com/devswha/herdr-web-ui/compare/v0.4.9...v0.4.10
[0.4.9]: https://github.com/devswha/herdr-web-ui/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/devswha/herdr-web-ui/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/devswha/herdr-web-ui/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/devswha/herdr-web-ui/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/devswha/herdr-web-ui/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/devswha/herdr-web-ui/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/devswha/herdr-web-ui/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/devswha/herdr-web-ui/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/devswha/herdr-web-ui/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/devswha/herdr-web-ui/compare/v0.3.52...v0.4.0
[0.3.52]: https://github.com/devswha/herdr-web-ui/compare/v0.3.51...v0.3.52
[0.3.51]: https://github.com/devswha/herdr-web-ui/compare/v0.3.50...v0.3.51
[0.3.50]: https://github.com/devswha/herdr-web-ui/compare/v0.3.49...v0.3.50
[0.3.49]: https://github.com/devswha/herdr-web-ui/compare/v0.3.48...v0.3.49
[0.3.48]: https://github.com/devswha/herdr-web-ui/compare/v0.3.47...v0.3.48
[0.3.47]: https://github.com/devswha/herdr-web-ui/compare/v0.3.46...v0.3.47
[0.3.46]: https://github.com/devswha/herdr-web-ui/compare/v0.3.45...v0.3.46
[0.3.45]: https://github.com/devswha/herdr-web-ui/compare/v0.3.44...v0.3.45
[0.3.44]: https://github.com/devswha/herdr-web-ui/compare/v0.3.43...v0.3.44
[0.3.43]: https://github.com/devswha/herdr-web-ui/compare/v0.3.42...v0.3.43
[0.3.42]: https://github.com/devswha/herdr-web-ui/compare/v0.3.41...v0.3.42
[0.3.41]: https://github.com/devswha/herdr-web-ui/compare/v0.3.40...v0.3.41
[0.3.40]: https://github.com/devswha/herdr-web-ui/compare/v0.3.39...v0.3.40
[0.3.39]: https://github.com/devswha/herdr-web-ui/compare/v0.3.38...v0.3.39
[0.3.38]: https://github.com/devswha/herdr-web-ui/compare/v0.3.37...v0.3.38
[0.3.37]: https://github.com/devswha/herdr-web-ui/compare/v0.3.36...v0.3.37
[0.3.36]: https://github.com/devswha/herdr-web-ui/compare/v0.3.35...v0.3.36
[0.3.35]: https://github.com/devswha/herdr-web-ui/compare/v0.3.34...v0.3.35
[0.3.34]: https://github.com/devswha/herdr-web-ui/compare/v0.3.33...v0.3.34
[0.3.33]: https://github.com/devswha/herdr-web-ui/compare/v0.3.32...v0.3.33
[0.3.32]: https://github.com/devswha/herdr-web-ui/compare/v0.3.31...v0.3.32
[0.3.31]: https://github.com/devswha/herdr-web-ui/compare/v0.3.30...v0.3.31
[0.3.30]: https://github.com/devswha/herdr-web-ui/compare/v0.3.29...v0.3.30
[0.3.29]: https://github.com/devswha/herdr-web-ui/compare/v0.3.28...v0.3.29
[0.3.28]: https://github.com/devswha/herdr-web-ui/compare/v0.3.27...v0.3.28
[0.3.27]: https://github.com/devswha/herdr-web-ui/compare/v0.3.26...v0.3.27
[0.3.26]: https://github.com/devswha/herdr-web-ui/compare/v0.3.25...v0.3.26
[0.3.25]: https://github.com/devswha/herdr-web-ui/compare/v0.3.24...v0.3.25
[0.3.24]: https://github.com/devswha/herdr-web-ui/compare/v0.3.23...v0.3.24
[0.3.23]: https://github.com/devswha/herdr-web-ui/compare/v0.3.22...v0.3.23
[0.3.22]: https://github.com/devswha/herdr-web-ui/compare/v0.3.21...v0.3.22
[0.3.21]: https://github.com/devswha/herdr-web-ui/compare/v0.3.20...v0.3.21
[0.3.20]: https://github.com/devswha/herdr-web-ui/compare/v0.3.19...v0.3.20
[0.3.19]: https://github.com/devswha/herdr-web-ui/compare/v0.3.18...v0.3.19
[0.3.18]: https://github.com/devswha/herdr-web-ui/compare/v0.3.17...v0.3.18
[0.3.17]: https://github.com/devswha/herdr-web-ui/compare/v0.3.16...v0.3.17
[0.3.16]: https://github.com/devswha/herdr-web-ui/compare/v0.3.15...v0.3.16
[0.3.15]: https://github.com/devswha/herdr-web-ui/compare/v0.3.14...v0.3.15
[0.3.14]: https://github.com/devswha/herdr-web-ui/compare/v0.3.13...v0.3.14
[0.3.13]: https://github.com/devswha/herdr-web-ui/compare/v0.3.12...v0.3.13
[0.3.12]: https://github.com/devswha/herdr-web-ui/compare/v0.3.11...v0.3.12
[0.3.11]: https://github.com/devswha/herdr-web-ui/compare/v0.3.10...v0.3.11
[0.3.10]: https://github.com/devswha/herdr-web-ui/compare/v0.3.9...v0.3.10
[0.3.9]: https://github.com/devswha/herdr-web-ui/compare/v0.3.8...v0.3.9
[0.3.8]: https://github.com/devswha/herdr-web-ui/compare/v0.3.7...v0.3.8
[0.3.7]: https://github.com/devswha/herdr-web-ui/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/devswha/herdr-web-ui/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/devswha/herdr-web-ui/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/devswha/herdr-web-ui/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/devswha/herdr-web-ui/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/devswha/herdr-web-ui/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/devswha/herdr-web-ui/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/devswha/herdr-web-ui/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/devswha/herdr-web-ui/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/devswha/herdr-web-ui/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/devswha/herdr-web-ui/releases/tag/v0.1.0
