# User guide

[← README](../README.md) · [Quick start](#quick-start) · [Supported agents](#supported-agents) · [Features](#features) · [Phone](#on-your-phone) · [Remote PCs](#remote-pcs-over-ssh) · [Access and safety](#access-and-safety) · [Configuration](#configuration) · [Updates](#updates) · [Keyboard shortcuts](#keyboard-shortcuts) · [How it works](#how-it-works) · [FAQ](#faq)

Install, connect and use Ovis on your desktop and phone.

## A look around

<table>
  <tr>
    <td colspan="2"><img src="media/look-chat.png" alt="Chat view of a Claude Code pane: its &quot;Worked for 2m 36s&quot; block opened into Grep, Read, Edit, Write and Bash rows, above a Markdown answer with a code block and a link."></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><b>Chat</b>: the agent's own transcript, each turn's work folded into one line you can open</td>
  </tr>
  <tr>
    <td width="50%"><img src="media/look-prompt.png" alt="A Codex pane waiting for input: an &quot;Allow command?&quot; card for git push with its three options, answered from the chat."></td>
    <td width="50%"><img src="media/look-terminal.png" alt="Terminal view of a shell pane: git history and a passing bun test run in the live herdr terminal."></td>
  </tr>
  <tr>
    <td align="center"><b>Answer prompts</b>: approvals and questions become cards, answered from the chat</td>
    <td align="center"><b>Terminal</b>: the same pane, live, through<br><code>herdr terminal attach</code></td>
  </tr>
</table>

<p align="center">
  <img src="screenshots/demo-mobile.gif" width="219" alt="Phone demo: scrolling a chat, opening the session list, approving a Codex command, the terminal with its key bar, and typing a message.">
  <img src="screenshots/mobile-chat.png" width="200" alt="Phone chat view of a Claude Code pane.">
  <img src="screenshots/mobile-terminal.png" width="200" alt="Phone terminal view with the Esc, Tab, Ctrl, arrow and Ctrl+C key bar.">
  <img src="screenshots/mobile-sessions.png" width="200" alt="Phone session list with Claude Code, Codex, gjc, omo and shell panes and their live status.">
</p>

<details>
<summary><b>▶ Watch the demos in HD</b> (desktop 1920×1200, phone 1080×1920)</summary>

https://github.com/user-attachments/assets/4ca73671-ebfc-4c18-b8f2-99331abf9fa7

https://github.com/user-attachments/assets/2f030569-1004-425e-835d-9e775ec6e4c8

</details>

## Quick start

> **Want a look first?** [Try it in your browser](https://ovis.sh/demo/): the app on a fictional session, nothing to install. Nothing in it is live.

> **Setting it up with a coding agent?** Point it at [INSTALL.md](../INSTALL.md), a step-by-step guide written for agents.

**1. Install it** with one line, on Linux (x64, arm64) or macOS:

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

It does, in order, only what is not done yet:

- **What it runs on.** [herdr](https://github.com/herdrdev/herdr) 0.9.0+, [Bun](https://bun.sh) 1.4+. A missing one is installed for your user only, without sudo, by its own installer, into `~/.local/bin` and `~/.bun`. Node is not needed: on Linux and macOS, terminals run on the Rust PTY host each release ships (`bin/ovis-pty-sidecar`), checked against the release's SHA-256 and once more when the server starts. A Node 18+ already on the PC is only its fallback, and the installer adds Node 22 from nodejs.org (checked against its published SHA-256, into `~/.local/share/ovis/node`) only when the host cannot be installed and there is no Node. Nothing is compiled.
- **The app**, as a herdr plugin at the latest release (set `OVIS_REF` to install another branch or tag): herdr builds it and starts it along with itself, on `127.0.0.1:7317`, following the socket of the current herdr session. When herdr is already running, the app starts now.
- **The phone address.** When Tailscale runs on this PC, it serves the app to your tailnet (`tailscale serve`, see [On your phone](#on-your-phone)), tells you the command that undoes it, and prints the address as a QR code. Without Tailscale, it says what to set up.

- **The app in your browser.** On a new install, on a PC with a desktop, it opens `http://127.0.0.1:7317` in your browser and says so: click **Install** in the address bar to add the app. It doesn't open anything in CI, over SSH, or when `OVIS_NO_OPEN=1` is set; then it prints the address instead. Over SSH it prints the tunnel to run from your own computer, `ssh -L 7317:127.0.0.1:7317 <this-pc>`, after which `http://127.0.0.1:7317` there opens the app and its **Install** button.

Run it again at any time, for example after setting up Tailscale: it keeps what is there and prints the address and QR code again.

On a first install it mentions a GitHub star, once, unless the account the [gh CLI](https://cli.github.com) is signed in to has starred the repository already. When gh is signed in and that account has not, it also asks at the terminal whether to star it, and does so only if you answer `y`. It never stars by itself. Without a terminal, as when a script runs it, it does not ask, and a question nobody answers goes on after 20 seconds.

<p align="center">
  <img src="screenshots/install.png" alt="The installer's output on a PC that had herdr but no Bun or Node: Bun and Node installed, the herdr plugin installed, the app served to the tailnet with the command that undoes it, the phone address, the PC's Tailscale IP, and a QR code that opens the app on the phone" width="760">
</p>

<sub>A PC named fresh-pc on a sample tailnet (alice@example.com): the names and the QR code are placeholders.</sub>

<details>
<summary>Other ways to install</summary>

**The plugin alone**, when herdr, Bun and Node are there already. After installing, choose
the plugin's **Phone setup** action inside herdr to see the address, QR and a pairing code.

```bash
herdr plugin install devswha/ovis
```

**From a checkout:**

```bash
git clone https://github.com/devswha/ovis.git
cd ovis
bun install
bun run start
```

You need herdr 0.9.0+ and Bun 1.4+, and for attached terminals either the Rust PTY host (`cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml`, or `bun scripts/pty-sidecar.ts install` on a release tag) or Node 18+; with neither, panes are mirrored. herdr must be installed and running first: start it with `herdr`. `start` builds the client and runs the server under the update supervisor. It talks to `~/.config/herdr/herdr.sock` unless `HERDR_SOCKET` says otherwise. If herdr isn't running there, the app still opens, but its header shows **Status unknown** after the first failed health check and **herdr unavailable** after the second, and the page says it cannot reach herdr at that socket.

</details>

**2. Open it** at **http://127.0.0.1:7317**, the address the installer opened. On a slow link, such as a phone on mobile data, a spinner shows while the app downloads. The installed app belongs to that exact address: `localhost:7317` is another address to the browser, so a tab there is not the installed app, and Settings → Phone & devices → Install there still offers to install it (an **Install app** button when the browser can, its steps otherwise). Every workspace of your herdr session is a row in the sidebar, as in herdr's own, led by its project's icon when its folder keeps one (a favicon in the folder, `public/` or `static/`; else an app icon such as Next.js's `app/icon.*` or Electron's `build/icon.png`; else a logo such as `logo.svg` or `assets/logo.png`; the folder is the worktree checkout, or else the pane's working folder, so a pane that has `cd`'d into `src/` looks there) and a folder glyph otherwise (a repository row with worktrees under it is also its fold button: the folder opens and closes with it, and an icon turns into that folder under the pointer; the worktree rows nested under it have no mark); its tabs are always shown in a strip, and the active tab shows all its split panes together. Pick one, start a new agent with **New workspace**, or add a tab to a workspace with **New tab** (the strip's `+`, a tab's right-click menu, or the command palette on a wider screen or with a keyboard). Right-click a tab to rename or close it; on a phone, tap the selected tab’s **⋯** for a trimmed menu with pane actions, Rename tab and Close tab. A focused tab also opens its menu with Shift+F10, and double-click still renames it.

Drag a tab to change its order within the workspace, or choose **Move tab left / right** from
its menu (also on a phone). Alt+Shift+Left/Right moves a focused tab. Reordering keeps the
selected pane and saves the order in herdr.

Right-click a pane to rename it, split right or down, zoom it, or close it. Right-clicking another
pane keeps the current focus, so **Swap with focused pane** exchanges the two. Drag a boundary
to resize it. On a touch screen, the pane header's **⋯** opens the same menu; on a phone the tab's **⋯** carries
the open pane's Rename and Close, while split and zoom stay with a screen that shows panes side by
side. **Unzoom pane** stays in the phone's tab menu when the tab is zoomed, so its other panes
remain reachable. **Zoom pane** makes a small pane fill the screen, and **Unzoom pane** restores the split. A split opens the new pane.
Each pane keeps its own Chat/Terminal view and unsent draft.

To see two panes side by side, drag a workspace row, an **Agents** row, a tab, a pane's title or
a half's bar onto the left or right half of the pane area. A pick in the sidebar or the **Agents**
list then opens in the active half only, and the focus stays there. Both halves can show the same
tab, and you type in whichever half is active; the other half shows that tab at the active half's size.
To rearrange a split tab instead, drop a pane's title on another pane's title in the same tab: the
two panes trade places. Drop it on another pane's body to move it beside that pane, on the side
nearest the pointer; the highlighted half shows where it goes. Within its own tab a title only
arranges the tab: to open it in a half, drop it on the other half while that half shows another tab.

To see more than two panes at once, drop a pane on the edge of another pane in the split to open it beside, above or below that
pane, up to four at once, or on its middle to open it in that pane's place. Drag the line between
two panes, or focus it and use the arrow keys, to resize them.

A tool that starts background workers or subagents can keep them out of the way: tag each such
pane with `herdr pane report-metadata <pane_id> --source <id> --token role=background`. The
**Agents** list then shows those panes, and the helpers they start, after the others under
**Background agents**, folded at first with their count. A background agent that asks a question
moves up with the others until it is answered, and a pinned one stays in the pinned card. Panes
without the tag stay where they are.

Workspaces can be set apart the same way: tag each one a tool opens for its workers with
`herdr workspace report-metadata <workspace_id> --source <id> --token role=background`, and turn on
**Settings > Appearance > Background workspaces apart** (off by default). The sidebar then lists those
workspaces after the others, under **Background workspaces**, folded at first with their count. The
workspace you have open, and one whose agent asks a question, stay in sight, and a pinned one stays in
the pinned card.


**3. Take it with you.** Scan the installer's QR code with a phone signed in to the same Tailscale account, then install the app from the browser. No Tailscale? Turn on the [Ovis relay](#through-the-ovis-relay) and scan its QR code instead. See [On your phone](#on-your-phone).

### In a terminal

**The phone address, again:** run the one-line installer again. On a PC where the app is installed it installs nothing and prints the address and its QR code, serving the app to your tailnet first if nothing does yet. It finds the version that actually runs: herdr's plugin directory keeps the version first installed, and **Settings → Updates** runs newer ones from `~/.config/ovis/updates`, each checkout and port in a folder of its own. From a checkout, `bun scripts/plugin.ts phone` does the same.

**The `ovis` command:** the installer puts it in `~/.local/bin`. It runs the installed Ovis's own command line (`scripts/plugin.ts`), which it finds each time it runs, so it keeps working after an update or a reinstall:

```bash
ovis add       # add this PC to your Ovis account
ovis pair      # a pairing code
ovis status    # whether the app runs, and where
```

An `ovis` of your own that is already in `~/.local/bin` is left as it is, and the installer says so. So is another `ovis` elsewhere on your PATH: where `~/.local/bin` comes before it, the installer writes no command, since that would take its name; where it comes first, the installer writes the command and says to call it by its path. That other `ovis` keeps the name only until `~/.local/bin` comes before it on your PATH (a shell profile that puts `~/.local/bin` first does that at the next login), and from then on `ovis` is the installer's command. Without the command (an install from before it, until the installer is run again; Windows; a checkout), run the script itself, `bun scripts/plugin.ts <command>`, in the folder that holds Ovis: a checkout, or the plugin's own folder:

```bash
root=$(herdr plugin list --json | bun -e 'const d = JSON.parse(await Bun.stdin.text()); console.log(d.result.plugins.find((p) => p.plugin_id === "devswha.ovis")?.plugin_root ?? "")')
bun "$root/scripts/plugin.ts" status
```

**A pairing code, on a PC with no browser of its own:**

```bash
ovis pair
```

`pair` prints the code, the address the phone opens when Tailscale serves one, and that address as a QR code. Neither is a herdr action: herdr keeps an action's output in its log, and a pairing code belongs on the screen. While the [Ovis relay](#through-the-ovis-relay) is online, `pair` also prints the relay's pairing link and its QR code; while it's off, it says where to turn it on.

**Adding the PC to your account, from its terminal:**

```bash
ovis add
```

To install and add in one line, give the installer `--add`: `curl -fsSL https://ovis.sh/install.sh | sh -s -- --add` (or set `OVIS_ADD=1`). It ends the install with `ovis add`, at a terminal you can answer at and while the app runs; anywhere else (a script, a background job, a PC whose herdr is not started yet) it prints the command to run. On a PC other people log in to, set `OVIS_TOKEN` first ([Who counts as this PC](relay.md#a-pc-with-no-screen)).

`add` (also `login` and `link`: one command) signs the PC in to your Ovis account with a code you enter on any device, lists it there, and asks in the terminal about the device of your account that adds it: it shows that device's six digits, and typing them (or their last three) approves it, while anything else, a bare Enter or `y` included, declines. It ends once the PC is in the account you signed in to, and stops by itself after 30 minutes of waiting. `link --code` shows a code to type and the relay QR code instead, or the QR code alone when the relay mints no code ([A PC with no screen](relay.md#a-pc-with-no-screen)). In-app updates do not replace the plugin's checkout, so `ovis add` runs the release that runs: with a checkout from before `link`, it works once **Settings → Updates** has installed a release that has it. Without the `ovis` command, such a checkout needs a plugin reinstall first; one from before `add` and `login` still has `link`.

The actions start, stop and report on the server:

```bash
herdr plugin action invoke devswha.ovis.start    # leaves a running server alone
herdr plugin action invoke devswha.ovis.status
herdr plugin action invoke devswha.ovis.phone    # visible phone setup pane
herdr plugin action invoke devswha.ovis.stop
```

Its PID and log live under `HERDR_PLUGIN_STATE_DIR`. For persistent settings (see [Configuration](#configuration)), add `KEY=value` lines to the `env` file (no dot) in the directory that `herdr plugin config-dir devswha.ovis` prints. A plugin checkout from 0.3.25 on also reads `.env` there, which wins where both set a key; an older one needs a plugin reinstall first, since in-app updates do not replace the checkout. The plugin's `status` prints the files it read. Protect that file if it holds a token.

### Uninstall

```bash
# an install from before the rename runs, or is registered, under its old id until the installer moves it
herdr plugin action invoke devswha.ovis.stop || herdr plugin action invoke devswha.herdr-web-ui.stop
herdr plugin uninstall devswha.ovis || herdr plugin uninstall devswha.herdr-web-ui
tailscale serve --https=<port> off    # the port the installer printed, if it served the app
# the installer's ovis command, and only that: an ovis of your own there stays
[ ! -L ~/.local/bin/ovis ] && [ "$(sed -n 2p ~/.local/bin/ovis 2>/dev/null)" = "# ovis launcher, written by install.sh" ] && rm -f ~/.local/bin/ovis
```

The installer's herdr, Bun and Node stay, since other tools may use them: `~/.local/bin/herdr`, `~/.bun`, and `~/.local/share/ovis/node` (`~/.local/share/herdr-web-ui/node` for an install from before the rename); an older installer also linked it as `~/.local/bin/node`. Running the installer again removes that link once the installed release finds its Node itself; a release from before that still needs the link, so it stays until the installer runs again after Ovis is updated. Push keys, paired devices and the identity file that owns the app's Portal address are in `~/.config/ovis`.

## Supported agents

Every agent herdr runs shows up with its live status, terminal and alerts. The chat view reads the agent's own session files wherever it knows where they are:

| Agent | Chat | Answer prompts from chat |
| --- | --- | --- |
| **Claude Code** | Native transcript, resolved through herdr | ✓ approvals, questions, plan and menu picks, the `/model` list, and the `/effort` levels with Ultracode's switch (each picked for the session) |
| **Codex** | Native rollout, with tool results and commentary/final phases | ✓ approvals and questions, including queued ones, and the `/model` lists (picked for the session) |
| **omp** | Native session file, in the store the pane's omp process writes to: `~/.omp/agent`, a profile's, or where its `--session-dir`, or the `PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR` or XDG data and state directories it was started with, put it (absolute paths only, not values from omp's `.env` files; on Windows only `~/.omp` and its profiles) | ✓ approvals, questions, and the model picker of `/model` and `/switch` (picked for the session: the chat sends `/model` as `/switch`, since omp's own `/model` opens its role hub) |
| **omo** | Native session file, found through the pane's process tree | ✓ the `/model` list (picked for the session); other menus — use Terminal |
| **gjc** | Native session file reported by the web UI's GJC extension, verified against the pane's process | — use Terminal |
| **pi** | Native session file, resolved through herdr; after `/tree`, the branch in play | ✓ its dialogs: a question, a confirmation, an answer typed in |
| **Command Code** (`cmd`) | Native session file under `~/.commandcode/projects/`, named by the session herdr reports for the pane (see below); after `/tree`, the branch in play | ✓ its permission prompts: Yes / Yes, don't ask again / No |
| **OpenCode** | Native session in OpenCode 2's own database, resolved through herdr: `~/.local/share/opencode/opencode.db` (`%USERPROFILE%\.local\share\opencode\opencode.db` on Windows), or where the server's `XDG_DATA_HOME` or `OPENCODE_DB` puts it | ✓ its questions on OpenCode 2.0 or later, answered through its background service (`~/.local/state/opencode/service.json`, or under the server's `XDG_STATE_HOME`) one question at a time, with Back to change an earlier one; other prompts, and OpenCode 1 — use Terminal |
| **Devin CLI** | Native SQLite session, showing the active branch when herdr or the live process explicitly identifies the session; otherwise terminal text | — use Terminal |
| **Grok** | Native update log on Linux and macOS. Any Grok executable named `grok` or `grok-…` that holds the `events.jsonl` for the session Herdr reported in exactly one directory, with a newer write time than every other held session. Linux reads `/proc`; macOS reads that process's held files through `lsof` and its environment through `sysctl KERN_PROCARGS2`, not the bridge's home. It verifies the kernel's microsecond process start time through `sysctl kern.proc.pid` around those reads and a fresh pane foreground lookup. Older open files do not hide it; ambiguous IDs, tied times, and a held file that may be a renamed events file use Terminal. After a `/resume` Herdr does not hear about, Chat can keep showing the previous conversation until the resumed session writes; it then uses Terminal until Herdr names that session. Windows uses Terminal. See [Grok setup and limits](grok-chat.md). | — use Terminal |
| **Hermes** | Native SQLite session store | — use Terminal |
| **Muse Code** | **Linux untested with real Muse.** Native session log, bound to the pane by the session lock Muse writes for its process; panes in one folder each show their own session. macOS and Linux; Windows uses Terminal. See [Muse chat](muse-chat.md). | — use Terminal |
| **Antigravity (agy)** | **Experimental; macOS untested.** Native ledger, selected by the running process’s held conversation lock. Linux native-tested; Windows uses terminal text. See [Agy behavior and limits](agy-chat.md). | — use Terminal |
| **Letta Code** | **Experimental; Linux and macOS.** Read-only native transcript, once herdr's Letta integration is installed (`herdr integration install letta`, experimental). A turn shows when it ends; meanwhile Chat says **Working…**. Windows uses Terminal. See [Letta Code](#letta-code) below. | ✓ the `/model` list (the rows its picker shows, its other tabs and its search) and the reasoning level it then shows; other levels — use Terminal |
| **DeepSeek Harness** (`dsh-tui`) | **Linux.** Native session log of the pane's dsh process, bound by the session lock it holds; dsh-tui panes, and dsh-tui-pi's (`dsh --profile tui`) found by their process. Install it from **Settings → Agents** or the setup guide (`npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui`; its first start needs pnpm), and start it from **New workspace**, **New tab with agent…** or **New worktree**, which run `dsh-tui` in the pane's shell. macOS uses Terminal; Windows is not offered. See [DeepSeek Harness](dsh.md). | — use Terminal |
| **GitHub Copilot CLI** | Linux native transcript when the foreground session is verified. See [Copilot setup and limits](copilot-chat.md). | — recorded choices are read-only; answer questions and approvals in Terminal |
| **Kimi Code** | **Experimental; tested on Linux, expected on macOS.** Native wire log of the pane's own Kimi process, bound by the session lock the CLI writes for that process (`~/.kimi-code/locks/sessions/`) or, on Linux, by the main log it holds open; two panes in one folder each show their own session, and an idle Kimi keeps showing its last session while the same process runs in the pane. A Kimi that has not written its session yet uses Terminal, never another session of the folder. Records before a context compaction stay in the log and are shown. Windows uses Terminal. | — use Terminal |
| **Anything else** | The terminal's text | — use Terminal |

GJC chat and GJC done alerts use a native extension rather than SDK session queries. From
this checkout on each PC that runs GJC, explicitly install the extension:

```sh
bun scripts/install-gjc-integration.ts
```

Restart existing GJC sessions to load it. The installer writes only the web UI's extension;
it does not replace GJC settings or other extensions. To remove it, run the same command
with `--remove` and restart GJC again. No running session is modified by the installer.
A remote PC with only the runtime bundle has no checkout: run the installer with the bundle's
own Bun from its folder, `cd ~/.local/share/herdr-web-ui/remote-vN && bin/bun
scripts/install-gjc-integration.ts` (on Windows, `bin\bun.exe` in
`%LOCALAPPDATA%\herdr-web-ui\remote-vN`), where `N` is the bundle version.

The extension reports its current session ID and exact file path on session changes and
refreshes a short-lived process binding. The bridge checks the process identity and native
transcript header instead of invoking `gjc sdk` or Git. The default
`~/.gjc/agent/sessions/` store is supported; custom stores are not inferred.
Missing, expired, ambiguous or unreadable bindings use Terminal. Existing sessions without
the extension also use Terminal; there is no SDK fallback. The extension API was probed
with GJC 0.18.12. Terminal input and prompt handling are unchanged.

Status tracking reads the same binding. Without it, a GJC pane keeps herdr's own status,
which follows GJC's provider child: a finished turn can stay on working, so no done alert
comes and no INPUT shows for an open question. Install the extension and restart GJC to
get both chat and done alerts back.

The `ask_user` form of the [`@eko24ive/pi-ask`](https://www.npmjs.com/package/@eko24ive/pi-ask)
pi package draws its own widget, which the chat cannot read off the screen, and pi-ask answers
only through its own events inside the pi process, never typed keys. To answer it from the chat,
explicitly install the web UI's pi extension on each PC that runs pi, from this checkout:

```sh
bun scripts/install-pi-integration.ts
```

Nothing installs it for you: the web UI never adds or changes pi's settings, hooks or extensions
on its own. Restart running pi sessions to load it. The installer writes only its own file,
`~/.pi/agent/extensions/herdr-web-ui.js` (or under `PI_CODING_AGENT_DIR`), and refuses to replace
a file it did not write; it does not replace pi settings or other extensions, and no running
session is modified by it. To remove it, run the same command with `--remove` and restart pi.
Without the extension the form stays in Terminal, exactly as before. On a remote PC with only the
runtime bundle, run it with the bundle's Bun as for GJC above. The extension listens on a socket
only your user can open, `herdr-web-ui-ask/<pid>.sock` in the same directory, and relays the
card's answer to pi-ask as its submit event: the form then shows as a card with one question per
step, its options and **Type your own answer**. The card shows only when the pane's pi process
answers on that socket, writes the session herdr reports for the pane (on herdr-core, the one
it names there itself), has one form open and
that form's `ask_user` call is still unanswered on pi's current branch (after a `/tree` move
too); anything else, a form opened by `/answer` or `/ask:replay`, Windows, and pi without the
extension use Terminal. pi-ask is never answered with typed keys: a pi pane never gets the
generic card of guessed keys that other agents get for a prompt no reader knows, and where the
extension serves the pane's pi, pi's own dialogs (select, confirm, input) show no card either, since
a pi-ask form can open there at any moment. The terminal answers those; without the extension,
pi's own dialogs keep their cards as before. Notes and
**Elaborate** stay in Terminal. Checked with pi 1.4.0 and pi-ask 1.2.0.

The same extension lets Chat suggest the slash commands that pi's extensions and installed packages
register (such as `/team` or `/ponytail`), which no file can tell: it passes on the running pi's own
list (`pi.getCommands()`, pi 1.3.0 or later), and a command named after a pi builtin is left out as
pi's own menu does. An extension installed before this, pi without it, two pi processes in one pane,
and Windows suggest only the builtins, prompts and skills; typing such a command in full still sends
it. Run the installer again and restart pi to update an installed extension.

Command Code chat needs the session herdr reports for the pane. Command Code sends that report
and herdr keeps only the sessions of the agents it knows natively, so no released herdr accepts
it yet: the pane's status, title and model arrive, its conversation does not. Without it the
bridge cannot tell which file under `~/.commandcode/projects/` a pane is showing, and two `cmd`
panes in one folder are indistinguishable, so Command Code opens in Terminal. Its permission
prompt cards are read off the screen, not from the session file, so they answer from the chat
either way.

Devin sessions are never selected by directory or recency alone. A plain `devin` shows the
terminal text, since herdr does not report its session without its Devin integration; a session
started with `devin --resume <id>` (or `-r <id>`, as Devin suggests when it exits) is a chat.
Missing, ambiguous or
unreadable history uses the terminal-text fallback, including histories beyond the reader's
5,000-node or 8 MiB bounds. Long tool output is shortened with a truncation marker; use
Terminal for the rest. The database is opened read-only, though SQLite may create its
WAL coordination files beside it.

When the last visible line is a familiar password, SSH passphrase or PIN request, both
views show a **Password or PIN** field. It hides what you type and sends it directly
to the terminal with Enter. The value is cleared on send, cancel, disconnect, pane
change or when the page goes into the background. It never enters the message queue,
draft storage or chat history. A changed prompt or busy pane refuses the send; check
the terminal before entering it again. **Cancel** sends Ctrl+C. Remote PCs need bridge
bundle v6. Detection covers a narrow list of English prompts, not every program or language.

A ring by the message box shows how much of the model's context the last request filled, and
its exact token counts on a tap. A pi pane shows it once `~/.pi/agent/models.json` states that
model's window, which is the file pi reads its own providers from; a model it states no window
for shows no ring rather than a guessed one, because pi answers those from a catalogue or a
running llama.cpp server that this app cannot ask. The model and reasoning effort come from what the session recorded, never from answer text. A todo list shows where the agent recorded it, in the turn's work block: Claude Code's `TodoWrite`, Codex's `update_plan`, or omp, omo and gjc todo calls. Plain-text plans are not reconstructed, and Claude Code `TaskCreate` / `TaskUpdate` calls are not drawn in the work block: the task list they build is the pane's plan, below. Details and verification are in the [chat-mode audit](chat-mode-audit.md).

Background tasks have a button by the message box, with a count while some run: an OmO pane's `task` children, a Claude Code pane's subagents (the `Agent` tool), read from the session's own files, and an OpenCode 2 pane's subagents, the child sessions OpenCode keeps of the session in its store (one whose OpenCode service went away mid-run, without ending it, reads as lost once another service starts or the pane leaves that session; on Windows, where a service's start cannot be read, only once the pane leaves that session). A Claude Code pane's background commands (`run_in_background`, Ctrl+B, or one moved there by its timeout), its `Monitor`s and background `Workflow`s, and a `/loop` wakeup it set are listed with them. It lists what runs and the newest ten that ended in the last day, and the sidebar badge shows the running count. A Claude Code or OpenCode turn that ends while work it started still runs reads **BG**, not DONE: that work's notice starts the next turn by itself, and the finish is alerted once, when that turn ends (each rest is held at most 30 minutes). A subagent that ends leaves a card in the chat with its answer (for OpenCode, one run in the background; a foreground one's answer is its call's output), and a Claude Code or OpenCode subagent whose pane no longer runs that session reads as lost.

An agy pane's background tasks (a command past its `WaitMsBeforeAsync`) and `schedule` timers, and a grok pane's background tasks, are read from their session files (agy's `transcript_full.jsonl`, grok's `updates.jsonl`) and counted and held the same way: a turn that ends on one reads **BG**, and an agy timer due within a day is held until it is due rather than 30 minutes, while its agy process lasts.

A pane's plan is the task list a Claude Code agent keeps (`TaskCreate` / `TaskUpdate`) or the checklist Codex keeps (`update_plan`), read back from the session's transcript. While there is one, the background-task button by the message box starts with **Plan** and how many of its steps are done (`2/5`); the same button opens one list with the plan's steps first and the background tasks below. Steps are listed so a step comes after the steps it waits on (Claude Code's `blockedBy`; a Codex step waits on the one before it). The running step says what it does now, and each step shows how long it took. The sidebar row carries the same count. Claude Code empties its task list once every task is done, and so does this: the first task after that starts a new plan. A teammate of an agent team that changes a task writes that in its own transcript, which is not read.

### Letta Code

Letta Code's chat reads the transcript the pane's own `letta` process keeps
(`~/.letta/transcripts`, or its `LETTA_CONFIG_DIR` / `LETTA_TRANSCRIPT_ROOT`), when three facts
agree: herdr's Letta integration (`herdr integration install letta`, experimental; start `letta`
once before installing it, since it needs `~/.letta`) names a
conversation for the pane; Letta's own record in the project folder (`.letta/settings.local.json`)
names the same one, was last written more than two seconds before that `letta` process started and
is writable by it; and `letta` is still
in the folder it started in (for a local-backend conversation, Letta's local store must also name
that agent for it). That holds when `letta` resumes the conversation it last had in that folder
(`letta`, or `letta --conversation <id>` on that one). After `/new` or `/resume`, a start on another
conversation (`--new` included), once `letta` has moved to another folder (its SetWorkingDirectory
or EnterWorktree tools), or another `letta` writing that record, Chat uses the terminal's text
until `letta` starts again on that conversation. In the home folder it always does. It also does
while another pane runs `letta` in the same folder or reports the same conversation, and until the conversation's
first turn on this PC has ended; Chat comes back by itself once that is no longer so.

With Letta's local backend, the composer shows the model and reasoning effort the conversation
runs with, read from Letta's local store (`lc-local-backend`): the conversation's own `/model`
choice, else its agent's. A cloud conversation keeps those on Letta's server, so its composer shows
none.

Letta writes a turn only when it ends, so a turn appears once it is done, and a cancelled one
never does. While it runs, Chat shows the turns written so far and **Working…**, and a message you
sent stays a faded bubble for a minute at most; the Terminal shows the turn as it happens. Only
turns Letta Code wrote on this PC show. Choose **Letta Code** in **New workspace**, **New tab with
agent…** or **New worktree** where `letta` is installed, or run `letta` in a herdr pane's
**Terminal**.

Known limits ([#2314](https://github.com/devswha/ovis/issues/2314)): nothing herdr or Letta
reports says which conversation a running `letta` is on now (herdr 0.9.5 keeps the first report of
a `letta` process, and Letta records its conversation per folder, not per process), so the binding
rests on the checks above. Each of three rare cases needs a folder move by Letta's own tools plus
a `/new` or `/resume` Ovis did not see, and then Chat can show the conversation the pane left: a
`letta` whose `PWD` names another folder (one started with `env -C`, say) that later moves into
exactly that folder before Ovis first looks at it; a `letta` that leaves its start folder,
switches conversation there and comes back before Ovis looks again; and that same round trip
across an Ovis restart, which forgets where it saw each `letta` before. Check the Terminal when Chat looks behind.

## Features

| | |
| --- | --- |
| **Read the conversation** | Prompts and Markdown answers (links, code blocks, tables). Each turn's commands, edits and progress are folded into one "Worked for …" block. Copy an answer as Markdown or plain text. A Claude Code bash-mode command (`!`) shows as one card: the command, then what it printed, with what it wrote to stderr in red. In a pi, omp, Claude Code or Codex pane, a picture the agent's own tool opened shows inside that tool's row. A picture opens in a full-screen viewer: zoom at the pointer, pan, step through the message's other pictures, **Copy image** and **Download**. Skill names an answer writes (`/name`, or `$name` for Codex) show as chips when the pane's own command list names that skill. Once you have sent four or more messages, a rail of dashes at the left, one per message you sent, jumps between them (not on a phone, or when the chat column leaves less than 32 px of margin at each side). |
| **Follow the plan** | A supported todo-tool call folds into the turn's work block like any tool: it reads as the done count or the step it took, and opened, as the whole list by phase. |
| **Drop into the real terminal** | xterm.js 6 on the live pane: full-screen TUIs, raw keys and herdr's scrollback, shared with your own herdr TUI. When a program marks its redraws as synchronized output, as herdr does, xterm.js 6 waits for the whole frame (up to a second) before drawing it, so a fast-redrawing agent does not show half of its new screen over its old one. In a program that reads the mouse, hold Alt to scroll it faster with a trackpad. Drag to select and it is copied on release, unless herdr's `[ui] copy_on_select` is off on the PC serving Ovis: then it is only selected, and stays selected under the pointer until Ctrl+C or Copy copies it. The wheel or the screen's edge scrolls further back while you drag. In an OpenCode pane a drag goes to OpenCode, which selects inside its own panel and copies it itself, as in a native terminal; hold Shift (Option on a Mac) to select and copy in Ovis instead, which is also the way when OpenCode's own copy does not reach this device's clipboard. In a Codex pane a drag stays Ovis's and stops at the screen's edge, since herdr keeps no history for a program on the alternate screen. **Settings > Terminal > Experimental > Codex panes: let Codex select and scroll** hands it to Codex on this device: Codex selects through its whole history, scrolls it while the drag is held past the top or bottom edge, and copies it on Ctrl+C or Enter. On herdr that copy does not reach this device's clipboard (herdr does not pass it on), and Ovis cannot quote Codex's selection, so a note after the drag says Shift+drag (Option+drag on a Mac) still selects, copies and quotes in Ovis. Ctrl+C copies a selection instead of interrupting. **Quote in message**, shown while text is selected, adds the selection to that pane's chat draft in a code block headed by the pane name, and its line numbers when herdr reports them; nothing is sent. |
| **Search the conversation** | **Search conversation**, from the pane's menu (right-click on a desktop, the tab's ⋯ on a phone) or the command palette, finds a word in what you wrote and in the agent's answers, earlier pages included; tool output, thinking and progress notes are left out. Matches list newest first as snippets; picking one opens the chat at that message, loading the earlier messages up to it. Nothing in the chat is highlighted, and the phone's screen gains no button. A remote PC offers it once its bridge is updated to one that searches. |
| **Find in terminal** | **More → Find in terminal** or Mod+Shift+F searches literal text in herdr's history, with a match count, previous/next navigation and visible match highlights. Search jumps and scrolling move the same viewport in every attached client, including the TUI. Older bridges retain search navigation without automatic highlights. |
| **Jump across PCs** | The command palette (Mod+Shift+K) searches all connected PCs at once by PC, workspace, branch, tab, pane title or agent kind. PC names distinguish results, and Recent remembers each pane's PC. Picking a result opens that PC and pane directly. Disconnected PCs are omitted; app and plugin actions remain on the currently selected PC. It also finds Settings pages and actions by related words (try `theme` or `font`), and browses folders: type a path such as `~/`, or pick **Browse folders**, and the folder you reach opens in Files. |
| **See each PC's load** | On by default once two or more PCs are connected; turn it on or off for this device in **Settings → Remote PCs → PC load in the sidebar**. Under a PC's name in the sidebar: CPU, memory (without the file cache) and the fullest disk as three small meters, red from 85%. Tap them for memory used and total, load average, uptime and every disk. A PC is read only while its group is open, the sidebar is shown and the page is visible. A remote PC shows nothing until its bridge is updated to this version, and a herdr-core machine shows none. Linux reads `/proc`; elsewhere CPU, load and disks come from the OS, Windows adds memory, and macOS reads memory from `vm_stat` as Activity Monitor's Memory Used. |
| **Answer prompts** | Approval, question and plan menus become cards. Tap an option, or type its number in the composer. The server checks that the menu is still current before answering. |
| **Compose** | `/` commands and `@` file mentions, any file or image up to 32 MB attached by path, and a draft per pane. Send during work schedules a next-turn message; use its ↑ Send now action to send it now. A strip under the input card names the pane's working folder (the whole path on hover) and, for a workspace of a repository with a worktree open, its branch at the other end; a phone leaves it out. Pick or type a terminal-only command and send normally: after acceptance, the pane's terminal opens over the chat, in this browser only, with **Back to Chat** and **Keep Terminal**; the chat stays where you were reading. For Claude Code's panels (`/config`, `/permissions`, `/theme` and the like) the chat may come back by itself when you close the panel, once Claude records the close; for Codex, omp, pi, gjc, OmO, Hermes (classic CLI), Devin, agy and Grok it comes back after their recorded pickers and panels, once the agent's empty input row is back on the screen; otherwise use **Back to Chat**, the header's Chat, or Back on a phone. If you go back to the same pane's chat while the command's screen is still open, the composer says so (Claude Code and every agent above, not OpenCode) and holds Send, quick replies and a queued message's Send now until the screen closes (**Send anyway** sends the message once); **Show terminal** opens it again. Messages the PC sends by itself at the end of a turn are not held. Automatic queued delivery never changes your view. Chat keeps one quiet **Ran in terminal** row with **Open Terminal**, which shows the terminal over the chat again; ordinary commands keep their outcome chips, and Hermes keeps its informational result cards. `/resume` opens **Earlier sessions…**. [Agent commands in Chat](agent-commands.md) explains where each agent's commands come from and what counts as a result. |
| **Follow every agent** | Live RUN / INPUT / DONE / READY status for all panes, and alerts when an agent needs input, finishes or its terminal ends. |
| **Open what agents make** | A file path in an answer opens in a viewer (images, video, audio, PDF, text), or find it with **Browse files**, and download it to your phone. A source file opens whole up to 8 MB and 200,000 lines; past 2,000 lines it scrolls as a window of rows, colored up to 256 KB and 5,000 lines and plain beyond. A link with `:line` or `#L12` opens at that line. |
| **Edit a text file** | Off by default: turn on **Settings → Chat → File viewer → Edit text files** on this device. A text file under the pane's folder, up to 1 MB, then shows **Edit file** in the viewer: change it in a plain text box and press **Save** twice (the second press confirms). If the file changed on the PC since you opened it, nothing is written: your text stays in the box to copy, and **Reload file** shows the file as it is now. Only a device that drives the PC can edit (not a watching device, a Portal visitor or an open LAN window), and only a UTF-8 file with one kind of line ending that is yours, not read-only and not hard-linked; a file outside the pane's folder, or in `.git`, never opens for editing. The file is replaced in one step with its permissions and line endings kept. Saving works on Linux and macOS PCs; a Windows PC says it can't save yet. A remote PC's file is edited and checked on that PC. |
| **Keep a file per tab** | Off by default: turn on **Settings → Chat → Reopen files on return** on this device. A file left open when you switch to another tab shows again when you come back to that tab, from the tab strip, the sidebar, a shortcut or Back. Close the file on its tab and it stays closed. |
| **See what changed** | **Browse files → Changes** lists what changed in the git repository the pane sits in: the **Working tree**, what is **Staged**, or two **Commits** you name, as a folder tree with git's status letter and the added and removed lines. A row opens its diff, **Unified** or **Split** (the switch in the diff's header; a phone shows one column), with **Copy path**, **Copy patch** and **Open file**. The files a turn's edit tools changed, listed in its work block, open the same diff. It only reads; a remote PC's repository is read on that PC. |
| **Manage sessions** | Start an agent in a folder you type or pick with **Browse**. In New workspace, Browse filters the currently loaded folders as you type (case-insensitive); opening a folder updates Directory, so **Start** uses that path even without **Use this folder** (which closes Browse), and a folder under home stays written as `~/…`. **New folder** (the folder-plus button in Browse's bar) makes a folder inside the one shown and opens it. It does not search subfolders or folders beyond the displayed 500. Add a tab to a workspace (as herdr's prefix+c), switch tabs from the strip over the pane, rename workspaces from their ⋯/right-click menu and panes from their own menu, reorder workspaces (drag a row, or on a phone long-press it and drag; Alt+Up/Down moves a focused row one step), and jump anywhere from the command palette. For Claude Code, New workspace and New tab have an **Ultracode** switch under Model and Effort, which asks Claude Code to start the session with Ultracode on at the chosen effort level. It needs Claude Code 2.1.284 or later, a model with xhigh and dynamic workflows on; otherwise Claude Code ignores it without a word (see [Starting an agent with a first message](agent-commands.md#starting-an-agent-with-a-first-message)). |
| **Speak instead of typing** | A mic beside Attach in the composer and beside Send in the terminal input line. Tap to start and again to finish, or hold it while you talk (not on a touch screen without an API key); the words land at the caret and are never sent by themselves. See [Voice input](#voice-input). |
| **Watch your plan limits** | Beside the Settings gear, how much of each AI subscription signed in on the PC is left, or used: the session's or the week's limit per account, and every limit with its reset time on a tap. See [Subscription usage](#subscription-usage). |
| **Make it yours** | English, Korean, Japanese or Simplified Chinese, following the browser or chosen in Settings. Dark, light or system mode, with a dark theme and a light theme picked from Amber, Charcoal, Catppuccin and herdr's built-in themes, or imported from a [theme file](themes.md) of colors (a Base16 scheme works as it is), compact density, interface font and size, terminal and chat fonts and sizes (Chromium lists the installed fonts to pick from), a resizable composer, Enter behavior and thinking visibility. |

In a chat read from the agent's own session, a message you send shows at once as your own bubble, faded, until the agent writes it as a turn,
so the chat is never blank between Send and the agent's turn. A small clock joins it when that turn
has not been written after 5 seconds (the agent may well be working on it already), and a bubble whose turn has not come within a minute goes. A
command (`/cost`, `! ls`) gets no bubble, since it never comes back as that message.

Every agent has the same chat controls on desktop and phones: Stop while it works with an empty
draft, Send when you type, and Send at rest. With a draft in the box, Escape stops the agent. Sending during work adds a message bubble above the
input card. It waits for the current response, then goes to the agent's next turn. Use a pending message's
**↑ Send now** action to send it now. The bridge immediately delivers it; when the agent reads
it is controlled by that agent, so this does not promise instant interruption. The small X discards it.
The bridge claims the same message ID for Send now and an automatic send, so they cannot both
deliver it. Older bridges keep the draft and ask for an update instead of changing queueing into
an immediate send. Connection loss pauses automatic delivery; uncertain text can be copied or
discarded after checking the terminal. Previously held browser messages still need **Send now**
or **Discard**. A message is never pasted over text typed in Claude Code's own input box: while
that box holds a draft the message stays in the list with the reason, and **Send now** delivers it
once the draft is sent or cleared in the terminal.

## Subscription usage

On a local desktop pane, the composer shows a compact read-only limit for the agent's provider:
its plan-wide five-hour session first, or its week when no session is reported. It uses the first
visible account in Settings order; it does not identify the pane's active sign-in. Its hover text
names that account and the reset times. Details stay in the strip beside Settings. Phones and
remote panes do not show this compact reference; failed or unavailable limits are omitted.


The strip beside the **Settings** gear shows the plan limits of the AI tools signed in on the PC the app's server runs on: for each account its provider's logo and one limit, what is left of its 5-hour session by default, or its week, or the share used, as chosen in Settings (red from 80% used). As many accounts show as the row has room for, the rest as `+N`; hovering the strip also names a limit near its end that a chip does not show. A plan with neither shows its limit closest to running out. Tap it for every limit (5-hour session, week, month, per model where a plan has them) and when each starts over. It is off until you turn it on in **Settings → Agents → Plan limits**: turning it on sends the sign-ins on the server's PC to each provider's usage endpoint.

| Provider | Sign-in it reads |
| --- | --- |
| Claude | Claude Code: the macOS keychain item `Claude Code-credentials`, else `~/.claude/.credentials.json`; the same for each config directory in `CLAUDE_CONFIG_DIR` or `~/.claude-*`. The email from its `.claude.json` |
| Codex | `auth.json` in `CODEX_HOME`, `~/.config/codex`, `~/.codex` and each `~/.codex-*`, else the macOS keychain item `Codex Auth`. The email in its token |
| Cursor | The Cursor app's `state.vscdb` and the `cursor-agent` CLI's macOS keychain item, once when both are one account. Its monthly share, and within it Cursor's own models and the rest |
| Copilot | `~/.config/github-copilot/apps.json` or `hosts.json`, then every account the GitHub CLI holds (`gh auth status`): per GitHub login, the first token that finds a plan |
| Grok | Every account in `~/.grok/auth.json` |
| Antigravity | The macOS keychain item Antigravity signs in with (Gemini and other-model quota) |
| OpenCode | OpenCode Go: the active `opencode-go` key, else the active `opencode` key, in the `credential` table of `opencode.db` (`~/.local/share/opencode/opencode.db`, or where `XDG_DATA_HOME` and `OPENCODE_DB` put it); with no OpenCode 2 store there, the `opencode-go` key, else the `opencode` key, in `~/.local/share/opencode/auth.json` (`opencode/auth.json` under `XDG_DATA_HOME` when it is set), else `OPENCODE_API_KEY`. Its rolling, weekly and monthly limits; a key without a Go subscription is left out |

Only providers with a sign-in are shown; a GitHub account without Copilot is left out. One PC signed in to two accounts of a provider shows both, each named by its email (a login for Copilot) and told apart by its account id, so the same account found in two places counts once. A credential file, a command's output or a provider's answer over 1 MiB is treated as unreadable. Where each sign-in lives and which endpoint states its limits follows [OpenUsage](https://github.com/robinebers/openusage).

- **Read only.** The server never refreshes a token: Claude, Codex, Cursor and Grok rotate refresh tokens, and a refresh the tool did not make would sign it out. An expired or refused sign-in says so; using the tool once may renew it, and otherwise sign in again. An expired Claude or Codex account (not a hub's) also has **Sign in again**, in Settings and in the usage popover: it opens the official sign-in in a terminal tab for that same account, replacing its expired sign-in instead of adding a new account.
- **Asked only while someone looks.** Nothing runs in the background. The server asks a provider at most every five minutes, a refresh from the popover at most every 30 seconds, and a provider that answered 429 not before it said to.
- **Yours to arrange.** **Settings → Agents** lists each coding agent on the PC as one row: its version, whether it is signed in (as far as these accounts show; an agent whose sign-in Ovis cannot read says only that it is installed), and, opened, its accounts with their limit and herdr's session resume for it. **New agents** below sets how New workspace starts Claude Code and Codex. Accounts no agent on the PC signs in to (Cursor, or an agent not installed there) are under **Other accounts**, with the hub; a remote PC shown there keeps every account under Other accounts, since they are read on the server's PC. Within each provider you order the accounts and hide any (from the strip and its popover alike); **Plan limits** at the bottom picks the limit the strip shows (**Weekly** or **Session**) and switches the meters between what is used and what is left. Each account shows whether it comes from **This PC** or **Hub**.
- **Add an account.** **Other accounts → Add account** lists Claude, Codex, Cursor, GitHub Copilot, Grok, Antigravity and OpenCode, then Hub. Installed CLIs sign in in a new terminal tab; missing ones show an installation hint. Claude Code and Codex are followed in the browser: a dialog shows the sign-in page to open (only on the provider's own address), Codex's one-time code to enter there, and a box for the code Claude's page shows, which Ovis types into the login and keeps nowhere; it then says whether a new account signed in. **Open terminal** in the dialog shows the login's tab instead. **Sign in** on an agent's row with no account, and **Sign in to …** in the setup guide, sign in to the agent's own home (`~/.claude`, `~/.codex`), the one its plain command uses; Add account makes a separate home. Only Claude and Codex offer hub sign-in and a separate `~/.claude-<name>` or `~/.codex-<name>` credential home. Other providers keep their existing home and require **Continue** before replacing a discovered sign-in. Account names use lowercase letters, numbers and hyphens. Codex and Grok use a device code only if their installed help lists it; Cursor prints its URL without opening a server browser. Claude may need a localhost callback. Antigravity gives interactive sign-in guidance rather than guessing a login command. OpenCode plan limits require OpenCode Go/Zen, not an arbitrary provider selected in its CLI. Hub sign-in provides a waiting state and a redirect-paste field. An agent's own **Add account**, or **Sign in** on an agent row with no account, starts at its provider's choices.
- **Connect a hub.** Choose **Hub** (**Import accounts from CLIProxyAPI**) in the same picker to enter its URL and server-saved management key. The connected hub appears as one compact row under Other accounts, with **Edit** and **Remove**. Account rows show their source, plan and sign-in status inline.
- **The server's PC only.** Remote PCs are not included.
- **Claude's limits from its own status line.** Where Anthropic's usage endpoint is refused (it
  answers 403 from some networks, which shows as a sign-in that expired when it has not), Claude Code's
  status line is still handed the five-hour and weekly limits. Turn on **Read Claude's limits from its
  status line** in Settings → Agents → Plan limits, or **Read from Claude's status line instead** under
  such a refused Claude account in the usage popover; nothing turns it on for you. The server's PC then
  adds only `herdr-statusline/` in Claude's config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`)
  and points `statusLine` in that directory's `settings.json` at a wrapper there (creating the file
  when Claude has none yet). The wrapper runs your status line command unchanged (none where none was
  set). It also stores each session’s model and context limit under `~/.herdr/statusline-context/`,
  using a profile hash prefix so Claude config directories do not share session files. Context capture
  requires a real directory owned by your uid without group/other permissions; it never changes that
  directory’s permissions. Chat requires the installer’s mark, matching profile, session and model,
  and a capture no more than six hours old, read through a bounded, no-follow file descriptor.
  This needs no subscription usage data. New session captures inspect at most 128 directory entries
  for expired captures of their own profile; cleanup is best-effort, not a total file-count bound.
  Context replacement and removal first quarantine an entry, then verify it through a descriptor.
  Unrecognized entries are restored without overwriting a newcomer, or kept as visible
  `statusline-context-recovery-*` entries if restoration is blocked. Publication uses a hard link
  and never overwrites an existing target. These pathname-only POSIX operations cannot prevent a
  concurrent process running as your uid from replacing a parent directory between operations.
  A concurrent same-user process replacing the quarantine name or directory itself during the few microseconds of an operation is also outside what pathname APIs can exclude.
  The wrapper keeps only the two windows and the account in `~/.herdr/statusline-last.json`, readable only
  by you. A reading counts only for the account that drew it and only until its window resets, and an
  answer from the endpoint newer than it wins. Turning it off puts `settings.json` back as it was and
  deletes its marked files; context removal checks the profile too and removes the context directory
  only when empty. Unmarked files are left alone under normal, nonconcurrent use. If you have
  since changed the status line yourself and it still runs the wrapper, turning it off changes nothing
  and says so: set the status line yourself first. A watching device sees the switch and cannot turn it. It is not available on
  Windows.
- On macOS, a server started outside the logged-in desktop session (over SSH, or by a multiplexer started there) reads the keychain item through a one-shot job in that desktop session. A keychain that still cannot be opened shows as such instead of the numbers.

## Voice input

Turn it on in **Settings → Voice input**, then tap the mic beside Attach (chat) or Send (the terminal input line), speak, and tap it again to finish; with a mouse, or with an OpenAI API key, you can also hold it while you speak. A pill above the box shows that it is recording, with a timer (and, when the server transcribes, the level of your voice); Esc or ✕ cancels. On a desktop, hold Ctrl+Shift+Space (Cmd+Shift+Space on a Mac). The text goes in at the caret and is never sent by itself, so you can read it first.

- **With an OpenAI API key** (recommended for Korean, Japanese and Chinese mixed with code terms): paste it under **OpenAI API key** in the same section, or set `OVIS_OPENAI_API_KEY` for the server. The server sends each recording to `gpt-transcribe` with the dictation language and English, and the pane's slash commands as hints. In chat, a second call tidies the text (fillers, spacing) and leaves code, paths and flags as you said them; the terminal keeps the words as transcribed unless you turn tidying on there.
- **In an iPhone home-screen app**, turning Voice input on does not ask for the microphone; the first tap of the mic does.
- **Dictation language** (same section) is the language you speak. Auto listens for the app's language. While the app's language follows the browser and the browser's first language is one the app is not translated into (Hungarian, German, …), Auto listens for that one instead, so you are not heard as English. Pick another from the list when you dictate in a language your browser does not put first.
  Auto uses browser language tags with a two-letter primary code, which both recognition paths accept. Other tags use the app's language, shown in the Auto label.
- **Without a key**, the browser recognizes the speech itself. Chrome and Edge send the audio to Google or Microsoft for that; Safari uses Apple's. On a touch screen it starts and finishes with a tap, never a hold: an iPhone starts the browser's recognition only from a tap. When the device's own recognition is off (on an iPhone, Siri & Dictation), the mic says so.
- **The key stays on the server.** It is kept in `voice.json` under `OVIS_STATE_DIR` (readable by your user only) and never sent to a browser. Every device that can type into your terminals (your own Tailscale login, a paired device, the token) dictates with it, and the use is billed to that key. A device paired to watch only can neither dictate nor change the key.
- **Silence is mostly not sent.** Where the browser lets the recorder pause, it runs only while it hears speech, so the pauses before, between and after your words are neither uploaded nor billed (keeping about a third of a second on either side of each word), and a recording with no speech is not sent at all. A browser that cannot sends the whole recording.
- Recording needs HTTPS (or `localhost`): the mic is turned off on a plain `http://` LAN address. To use another OpenAI-compatible server, set `OVIS_OPENAI_BASE_URL`; a key from `OVIS_OPENAI_API_KEY` is only ever sent there or to OpenAI.

## On your phone

A phone reaches the app on this PC in one of two ways. The **Ovis relay** needs nothing set up on the phone or your network: turn it on and scan a QR code. **Tailscale** keeps everything inside your own network, with an HTTPS address for this PC. Either way the app installs on the phone's home screen and gets push alerts. With the relay on, the iPhone and Android apps also connect straight to this PC on the same Wi-Fi or over Tailscale, and use the relay only when neither answers ([Which way the app connects](#which-way-the-app-connects)).

On an iPhone or iPad the app needs iOS 16 or later (Safari 16 or later on a Mac), and push alerts need iOS 16.4 or later.

### Through the Ovis relay

The Ovis relay lets your phone reach this PC from anywhere, with no Tailscale, no account and nothing to set up on the phone. It's off until you turn it on. While it's on, the PC and the phone each connect out to a relay that Ovis runs at `relay.ovis.sh`, which passes their traffic between them. Everything they send is end-to-end encrypted between the phone and the PC, so the relay can't read it. To turn it on, open **Settings → Phone & devices** on the PC, switch on **Ovis relay**, then point the phone's camera at the QR code that shows up. On a fresh install, the setup guide's **Connect your phone** offers it first: choose **Turn on the Ovis relay** and its QR code shows right there. **Use Tailscale or Wi-Fi instead**, under it, shows this page's own address and pairing QR code, or sends you to **Settings → Phone & devices** when the page is open on the PC itself.

Step by step:

1. On the PC, open **Settings → Devices and PCs**, choose **Connect** next to **Connect a device**, and turn on the **Ovis relay** switch. Once it is online, a QR code shows with a code to type beside it. Both work for ten minutes, and **Refresh** makes new ones. Signed in to your Ovis account, the dialog asks the new device to sign in instead, and you approve it once on a device already in the account; **Connect with a code (no sign-in)** still shows the QR code. The relay's switch and **Reset relay identity** are also under **More settings** on that page.
2. Scan the QR code with the phone's camera. Ovis opens in the phone's browser at `app.ovis.sh` and asks whether to pair with this PC: tap **Pair**.
3. Install it: in Safari, choose **Share → Add to Home Screen**; in Chrome, choose **Install app** or **Add to Home screen** from its menu. Then open the **⋯** menu at the top right and tap **Alerts** to get alerts on this phone. iPhone needs iOS 16.4+ and the home-screen app.

If the relay cannot start before its link exists, the switch stays off and shows
**The relay did not start: …** with the reason. Fix the cause, then press **Try again**.
A link that already exists stays on while retrying a connection error.

The phone pairs once. It makes a key of its own for this PC, which never leaves the phone, and proves itself with it on every connection, so there's no token or password to type. The PC lists the phone under **Devices and PCs → My devices**, marked **via relay**, and **Revoke** there removes it and closes its connections at once. Opened again later, the app connects by itself. Each PC is an app of its own: pair another PC from its own QR code, and `app.ovis.sh` lists every PC the phone is paired with.

**On an iPhone or iPad, add it to the Home Screen to stay paired.** In a Safari tab, the phone's key for a PC can be cleared after a week without a visit, and the phone then has to pair again. The home-screen app keeps it, and the app reminds you of this in Safari.

**What the relay sees.** It sees which PC a phone connects to, from which address, when and for how long, and how much goes each way, down to the timing of the keys you type in a terminal. What you type, what the PC shows and your files stay hidden from it, and it can't change any of them. The app at `app.ovis.sh` is the part you have to trust: it's the code that runs on your phone and holds its key. [The relay's trust model](relay.md#trust-model) has the details.

**Limits.** In a browser, the app's service worker streams files through the relay, so pictures, PDFs and videos load as they arrive and a video can skip ahead. The worker opens each file with its scripts turned off, so a file from one PC can't reach the app or your other PCs. Without that service worker, text, source and Markdown files still show in the file viewer as usual. For other files, only pictures, videos, sounds and PDFs open in the app; any other file, SVG pictures included, downloads instead. Such a file loads whole before it shows, and only up to 64 MiB: for a larger one the file viewer says it's too large to open on the phone, so download it on the PC. Rendered HTML pages open with their scripts running, but their own large videos and sounds don't play ([how files load](relay.md#files)). Up to 8 open apps or tabs can use the relay to one PC at a time.

**It's a best effort.** The maintainer runs `relay.ovis.sh` with no promise that it's always up. A relay update drops every connection for a moment; the PC and the app reconnect by themselves, and nothing you typed is sent again: it waits as a draft, as after any disconnect. When that matters, [run your own relay](#running-your-own-relay).

Good to know:

- Relay controls require drive access and a direct connection to this PC. A visitor signed in
  through Portal can read the state in Connect a device, with an explanation, but gets no relay
  switch, no QR code and no identity reset. Relay changes answer `403 read_only` for the default watch visitor;
  even a saved drive invitation gets `403 owner_only`, because the watch guard runs first
  ([`server/dispatch.ts:223-243`](../server/dispatch.ts#L223-L243)).
  Open Ovis on the PC or at its direct address, using the owner's access token or a paired
  device with drive access instead.
  The hosted shell offers no relay at all; changes over the relay answer `403 local_required`.
- `OVIS_TAILSCALE_SERVE_ONLY=1` keeps the relay off: that setting says `tailscale serve` is the only way into this PC, and the relay would be another.
- Turning the relay on closes the device gate when no device has paired yet and no token is set. From then on a new browser needs a pairing code or the token ([Access and safety](#access-and-safety)).
- Only a phone paired through the relay gets in through it. The token and device cookies don't work there.
- Turning the relay off closes every connection through it, and the PC then makes no connection to the relay at all.
- **Reset relay identity**, below the switch, gives this PC a new identity on the relay and removes every phone paired through it; each then needs a new QR code. Use it when a QR code or pairing link may have been seen by someone else.
- On a PC with no browser of its own, `pair` in a terminal also prints the relay's QR code while the relay is online ([In a terminal](#in-a-terminal)).

#### Which way the app connects

While the relay is on, this PC also takes connections straight from the iPhone and Android apps: on its home network addresses and, when Tailscale runs on it, on its Tailscale address. Each time the app opens the PC, it has three ways in:

- **Same Wi-Fi**: the PC's home network address.
- **Tailscale**: the PC's Tailscale address, when the phone has Tailscale on.
- **The relay**, which always works.

It does not wait for one to fail before trying the next: it tries both direct ways at once, opens the relay too when neither is up within 300 ms, and keeps whichever connects first (a firewall that blocks the PC's direct port leaves it on the relay). So a phone at home connects straight, and a phone away from home is not held up by an address that leads nowhere. While the relay carries it, the app checks the direct addresses again now and then (after it connects, at most every five minutes, when the phone is back online and when the app comes back to the front) and moves back to one once nothing is under way. The PC tells the app these addresses inside the encrypted connection, so they follow the PC to another network. A browser, including the home-screen app from `app.ovis.sh`, always uses the relay.

Nothing new is trusted. Only a device already paired through the relay can sign in on those addresses, with the same key and the same end-to-end encryption, and nothing pairs there. **Settings → Devices and PCs → My devices** shows **Same Wi-Fi direct connection on** (and says when it is on Tailscale too), with one switch that turns both off. On an iPhone the app asks for Local Network access once; declining it keeps the app on the relay. On Windows the PC shows Windows' firewall prompt the first time; declining it leaves the relay as the only way in. [Direct on the same network](relay.md#direct-on-the-same-network) has the details.

**How each device is connected.** **Settings → Devices and PCs → My devices** says how a device paired through the relay reaches this PC right now while it is connected: **Same Wi-Fi, direct**, **Tailscale, direct**, **Seoul relay** or **Through the relay**, with its round trip in milliseconds once one was measured. A device that is not connected shows when it was last seen (with a short reason once it has been gone a while). **Check now** measures them all again. On the phone, **Your PCs** shows the same line for each saved PC (the way it answers on and how fast, or why it is offline), with **Check now** above the list, and the header of the app always says how this device reaches Ovis.

#### Running your own relay

The relay is part of this repository ([`relay/`](../relay/README.md)) and runs anywhere Bun does. From a checkout:

```bash
bun relay/bun.ts --port 8787 --hostname 127.0.0.1
```

It listens on plain HTTP, so put it behind a TLS proxy (Caddy, nginx, `tailscale serve`): the PC and phones connect to it only over `wss://`. Then set `OVIS_RELAY_URL` on the PC to its `wss://` address (see [Configuration](#configuration)) and restart Ovis. Out of the box it takes 120 new connections a minute from one address and 600 in all; behind a proxy every connection comes from the proxy's address, so raise those limits for it ([the relay's limits](relay.md#operations)). The app at `app.ovis.sh` works with it as is, since it connects to whichever relay the QR code names. A phone keeps the relay it paired through, so on a phone paired before the change, choose **Forget this PC** in the app's Settings and scan a new QR code, then revoke its old entry under **Phone & devices** on the PC. [relay/README.md](../relay/README.md#running-your-own) also covers running the relay as a Cloudflare Worker on your own account.

The Bun relay also caps open sockets at 64 per address, including sockets waiting, connected or
still upgrading. Set `--max-sockets-per-address` or `RELAY_MAX_SOCKETS_PER_ADDRESS` to size that
cap for your deployment; behind a local TLS proxy all users share it. A new socket past the cap
gets `429` and `Retry-After: 60`, without closing sockets already open.

To stop trusting `app.ovis.sh` too, host the app yourself. `bun run build:shell` builds it into `dist-shell/`. Serve that folder over HTTPS from a host that follows its `_redirects` and `_headers` files, as Cloudflare Pages does (another host needs the same rewrites and headers), and set `OVIS_RELAY_APP_URL` on the PC to its address: the PC's QR codes then open your copy. Build it from the same release as the PC's Ovis.

### Through an account

Signing in links your devices once instead of pairing each phone with each PC. It's optional: a QR code and a pairing code work as before, with or without an account.

1. Sign in with **Continue with GitHub** or **Continue with Google** where the app offers it: in the desktop app, or on a PC's own page (**Settings → Devices and PCs → Account**). The public `app.ovis.sh` shows no sign-in at the moment; a phone pairs there with a QR code, and a hosted app built with `OVIS_ACCOUNT_SERVICE_URL` offers it. **Your PCs** lists the PCs of your account and the ones this phone is already paired with.
2. A phone already paired by QR code needs nothing more: the next time it opens each PC, it moves that pairing into the account by itself. Until then the PC's row says **Ready · not in the account yet**, since removing the phone through the account would not reach it.
3. A PC marked **Needs approval** has not let this device in yet. Tap it: this device and the PC show the same six digits, as with a link without a code. The first device of an account is approved on the PC itself. After that, any device already in the account can approve: it asks whether to add the new device and shows three numbers, and you pick the one the new device shows. One approval adds the device to every PC of the account: the approving device signs a record that adds it to each PC, and a PC that was off picks that record up when it comes back.

**Signing in a PC.** The desktop app signs in through your browser. A PC's own page (a browser at the PC's address) and a PC with no screen (`link`, see [A PC with no screen](relay.md#a-pc-with-no-screen)) show one code instead, with a QR code that fills it in: open `account.ovis.sh/link` on any device, check the code, choose **Continue with GitHub** or **Continue with Google**, sign in and confirm. The page says which PC asked, its system and roughly where from ("Asked by Desk (Linux), near Seoul, South Korea"): continue only if you started it on your own PC just now. Signing in only lists the PC in your account: on a device already in the account, tap the PC's card, type the six digits the PC shows, and approve on the PC (`link` shows the digits in its terminal and asks you to type them, or their last three, to approve).

**Approving a device.** The approval card on your other devices says what is asking: the system it runs and roughly where its request came from (country and city, as Cloudflare saw it, never the address), or **Location unknown**. Approve only if you started it yourself just now; if you didn't, deny it.

**Ways to sign in.** **Settings → Devices and PCs → Account** lists your account's sign-in methods. In the desktop app, **Add Google** (or **Add GitHub**) adds one on purpose, and **Remove** takes one away, except the one this device signed in with. An account is never joined to another because their email addresses match.

Who gets into a PC is still decided by that PC alone, in **Settings → Devices and PCs**, where **Revoke** always works. The account service at `account.ovis.sh` lists your PCs and carries signed messages between your devices; it can't read your sessions or add a device by itself ([how it works](account.md)). It keeps no email, name or username. [The privacy policy](https://ovis.sh/privacy/) says what it stores and for how long.

### Through Tailscale

Serve the app over **HTTPS** to install it and receive push alerts. The simplest way is Tailscale: keep the server on `127.0.0.1` and let Tailscale add the HTTPS address.

```bash
tailscale serve --bg --https=443 http://127.0.0.1:7317
```

The one-line installer runs this for you when Tailscale runs on the PC and does not serve the app yet, on the first free port of 443, 8443, 7317 and 17317, and prints the command that undoes it. To keep 443 for something else, name the port in `OVIS_TAILSCALE_HTTPS_PORT` (see [Configuration](#configuration)), or set it for the installer's run alone: `curl -fsSL https://ovis.sh/install.sh | OVIS_TAILSCALE_HTTPS_PORT=9443 sh`. On Linux, `tailscale serve` needs root or `sudo tailscale set --operator=$USER` once; the installer says so when Tailscale refuses.

An address that already serves the app is kept as it is. To move it to another port, turn the old one off (`tailscale serve --https=443 off`), then run the installer again. The installed app on a phone stays on the address it was installed from, so install it again from the new one.

Only devices in your tailnet can open that address. Your own devices get in without a code as it is: `tailscale serve` states your login. If your own phone is asked to pair anyway, `OVIS_TAILSCALE_SERVE_ONLY=1` lets it in without a code on a tailnet one login owns, and only when nothing else, such as a public reverse proxy or tunnel, reaches this port (see [Access and safety](#access-and-safety)). Devices that belong to someone else pair with a six-digit code.

**Settings → Phone & devices** in the app does this step for you as far as it can: it shows the address Tailscale already serves for this PC as a QR code, or the exact command still to run, and the address it will give.

1. Open the address.
2. Install the app: in Safari, choose **Share → Add to Home Screen**; in Chrome, open **Settings → Phone & devices** and choose **Install app**; when it shows steps instead of the button, follow them (Chrome's menu has **Install app** or **Add to Home screen**). Each PC installs as an app of its own: set `OVIS_APP_NAME` on each to tell them apart (see [Configuration](#configuration)).
3. Open the **⋯** menu at the top right and tap **Alerts** to turn on alerts for that device. iPhone needs iOS 16.4+ and the home-screen app.

To check alerts later, choose **Settings → Alerts → Send test**. The result tells you
whether the test was sent or failed; a missing subscription offers **Turn alerts on again**.

While the app is in front on any device, its window visible and focused, no alert goes to any
device: you are already looking at the change. Alerts resume once no window of the app is in use.
The test push is always sent.

Each pane keeps one alert: a new one replaces its last. iOS lets an alert be removed only
30 seconds after it arrived, so a quicker repeat stays until the pane's next alert.

An alert for an approval or a question with two short options (**Allow** / **Deny**, **Yes** /
**No**) carries them as buttons on desktop browsers and Android, under the question and what it is
about (the command or the file): a tap answers it without opening the app, and the card closes
everywhere. If the question changed or was answered on another device meanwhile, nothing is sent
and a new alert says so; tap it to open the pane. Questions with more or longer options, a command
too long to show whole, typed answers and forms of several questions open the pane, as do alerts
on iOS, in the relay app, and on a device paired to watch only.

To get the same alerts in a chat app, choose a destination under **Settings → Alerts → Also send
to**: an ntfy topic, a Slack or Discord webhook, a Telegram bot (its token and a chat id), or
plain JSON to any URL. It has its own choice of alerts, waits and holds back like a device does,
and is saved on this PC, owner-only, and shown masked afterwards. A message names the PC, the pane
and what happened, with a link to the pane, never what the agent asked or said; the pane goes by its
terminal title, which an agent may take from your task. **Send a test**
checks it; a destination that fails shows its last error and is retried a few times, with at most
one alert waiting.

### Using the app

On a phone:
- Agent panes open in the chat.
- The terminal gets a key bar above the keyboard (Esc, Tab, Ctrl+C, Ctrl, Alt, Shift, Enter, arrows).
  Ctrl, Alt and Shift stay held until tapped again and combine with each other.
  The terminal starts in direct typing, where they combine with letters and symbols; the
  keyboard button switches to an input line you edit before sending. Herdr encodes each chord
  for the program's keyboard protocol; legacy protocols cannot distinguish every chord (for example Ctrl+I and Tab).
  Draft text in the input line is sent unchanged. Modifiers clear
  when leaving the pane or terminal view, or when the connection drops.
  **Settings → Terminal → Key bar → Edit key bar** opens a separate screen to add, remove and
  reorder every key, including modifier
  buttons. Register a custom combination such as Ctrl+W, choose editing keys or F1–F12, or restore
  the default row. Saved combinations use exactly their selected modifiers; ordinary keys use
  the currently held modifiers. Removing a held modifier button clears it.
- Dragging the terminal scrolls the real herdr pane.
- **Settings → Phone & devices → Keep screen on** keeps the screen awake while a terminal or chat
  pane is open. It is off by default, releases when the app is hidden, and resumes when
  you return. It needs HTTPS or localhost and browser support; power-saving mode may refuse it.
- A font named in **Settings → Terminal → Terminal font**, **Chat → Chat font** or the custom
  interface font only draws where it is installed, and a phone has none of your PC's fonts. To
  use one there, copy its files into `fonts/` under `OVIS_STATE_DIR` (default
  `~/.config/ovis/fonts/`) on the PC. The PC serves them to its signed-in devices only.
  Each file's name is its family, with an optional `-Regular`, `-Bold`, `-Italic` or `-BoldItalic`
  (`D2Coding-Bold.ttf` is D2Coding in bold), and `.woff2`, `.woff`, `.ttf` and `.otf` files of up to
  32 MB are served, at most 64 of them in file name order. A device downloads only the families its
  Settings name, and keeps the files where the browser allows it. Reload the app after adding a file.

On an iPad with a hardware keyboard (a Magic Keyboard, say), the small bar that rises from the
bottom when a field gets the focus (language, arrows, dictation) is iPadOS's shortcuts bar for
hardware keyboards. It covers the composer, and iPadOS then scrolls the whole page to reveal the
field on every tap and keystroke. Turn it off with **Settings → General → Keyboard → Shortcuts**;
the keyboard's globe key still switches languages.

On a computer, install the app from `http://127.0.0.1:7317`. When the app runs on a PC you reach over SSH, tunnel to it first with `ssh -L 7317:127.0.0.1:7317 <this-pc>` and open that address on your own computer; the installer prints this line when you install over SSH.

A plain HTTP LAN address also works in the browser, but it can't install the app or receive push.

The running server sends the alerts. Keep it running, and keep `OVIS_STATE_DIR` across restarts, since it holds the push key and device subscriptions.

## Remote PCs over SSH

A workspace row's **⋯** menu offers **New worktree** and **Open worktree…**, as herdr's own worktree keys do: the first checks a branch out as a git worktree under herdr's worktree folder and opens it as a workspace next to the repository's, the second lists the repository's other checkouts and opens one. New worktree opens with a branch (`worktree/brave-valley-07f8` style) and a name already filled in, as herdr's own form does; type over either. **Agent** picks what starts in the new checkout, as New workspace does: the agent you last started, or Shell for none. In the By workspace view a worktree workspace sits under its repository's row. Its menu ends in **Delete worktree checkout…**, which deletes the folder and closes the workspace but keeps the branch; a checkout with unsaved changes is refused first, in git's words, with **Delete anyway** as the second step. Closing the repository's workspace closes its open worktree workspaces with it and leaves their checkouts on disk.

Open Settings → Remote PCs and choose **Add PC** (the command palette has it too), then enter an SSH alias or `user@host` for a Linux or macOS computer. The setup dialog walks you through the host fingerprint, the password or key passphrase, and an explicit install approval. The PC's workspaces then join the sidebar, and chat, files, terminal input and alerts all follow the PC you pick.

**Settings → Devices and PCs → Add a connection** opens on its **SSH** tab, which lists the PCs saved in herdr, the hosts of this PC's ssh config and the other PCs of your own Tailscale login; **Add** opens the same setup dialog with the address filled in ([Remote PCs over SSH](remote-pcs.md)). A Tailscale PC is reached over SSH, never through the relay. The **Phones and devices** tab holds what a phone or browser opens this PC with (its Tailscale address, a pairing code, Portal), and the **Ovis relay** tab signs in to the Ovis account, through which the relay is used: its **Sign in to Ovis** opens the Ovis sign-in page (`account.ovis.sh/link`) in a new tab with the code filled in (the desktop app opens it in your browser), and the tab shows you signed in once you confirm there. When the browser blocks the new tab, the page's link and code show in the tab instead. PCs added through the relay before keep working ([Through the relay](remote-pcs.md#through-the-relay)).

- **SSH runs on the server**, as the web server's account, with its OpenSSH configuration and agent. The browser never opens SSH itself.
- **The remote side gets a private runtime bundle** and a loopback-only bridge, reached through an SSH forward.
- **A herdr already running there** is never stopped or replaced.
- **Bridge updates:** when an app update needs a newer bridge, PCs that connect with their saved key are updated in the background.

More in [remote PCs](remote-pcs.md).

### One always-on PC for all your PCs

With several PCs, you don't need Ovis on each of them. Install it on one PC that stays on, such as a desktop or a home server, and add the others to it as remote PCs. That one app reaches them over SSH and sets up its own bridge on each, so the other PCs need only an SSH server (setup brings herdr where it is missing).

1. **Install Ovis on the always-on PC** as in [Quick start](#quick-start), with its [phone address](#on-your-phone).
2. **On each other PC, stop its own Ovis** if it has one, and keep herdr from starting it again:

   ```sh
   # an install from before the rename has the old id
   herdr plugin action invoke devswha.ovis.stop || herdr plugin action invoke devswha.herdr-web-ui.stop
   herdr plugin disable devswha.ovis || herdr plugin disable devswha.herdr-web-ui
   ```

   On Windows:

   ```powershell
   herdr plugin action invoke devswha.ovis.stop-windows
   herdr plugin disable devswha.ovis
   # an install from before the rename: devswha.herdr-web-ui.stop-windows, then disable devswha.herdr-web-ui
   ```

   From a checkout, stop `bun run start` instead, and whatever starts it again.

   An Ovis left running there still works with the always-on app, but it stays a second app: it sends its own alerts and updates only through its own updater, which the always-on app can at most ask to run. Once it is stopped, the always-on app runs its own bridge there and keeps that bridge on its own version.
3. **Add each PC in the always-on app:** Settings → Remote PCs → **Add PC**, then approve the install once. A PC already saved in herdr (`herdr machine`) is listed there already: choose **Connect**. The always-on PC must reach it over SSH as the account Ovis runs under, so try `ssh <pc>` there first. A PC the app already had, connected while that PC's own Ovis ran, keeps waiting for that Ovis to come back: open its **Manage PC** menu in the sidebar, choose **Reconnect / setup** and approve the install.
4. **Open the always-on PC's address everywhere**, in the other PCs' browsers and on your phone, install the app from there, and turn on **Alerts** in it on each device. Pairings and alerts set up with a PC's own Ovis stay with that Ovis, so pair a device again if the new address asks.

Then there is one app to update: each release is downloaded and built once, the bridges on the other PCs follow it in the background (when SSH gets in with the saved key, without a password; otherwise the PC's card offers the update), push alerts come from one place, and no versions have to be kept in step.

- **While the always-on PC is off or asleep**, the other PCs have no Ovis. herdr keeps running on each of them, and its own terminal app works as before.
- **A laptop's sessions go through the always-on PC**, so a laptop that cannot reach it, offline for example, has no Ovis for them.
- **With no PC that stays on**, install Ovis on each PC and keep them on the same version. An app that finds an older Ovis on a PC it adds offers to update it when that Ovis can update itself, and otherwise says why not ([Disconnects and updates](remote-pcs.md#disconnects-and-updates)).

## Access and safety

Anyone who can reach the server can type into your terminals, so what matters is who gets in. It listens on `127.0.0.1` by default, which means only this computer. From anywhere else, a request gets in in one of four ways:

- **It is you, says Tailscale.** `tailscale serve` states the requesting device's Tailscale login in a header it strips from anything incoming. A login that matches this PC's own gets in; another login is refused, and a tagged device (one with no person's login) needs pairing. If you set `OVIS_TAILSCALE_SERVE_ONLY=1` to say `tailscale serve` is the only way in, and `tailscale status` on this PC lists one login on every node it sees and no tagged node, a serve request that states no login is the owner as well: no one else is among those nodes to be mistaken for (a node an ACL hides from this PC is not seen, and cannot reach serve either), so your own phone opens the address and lands in the app with no code. Nothing to set up, unless this PC's own Tailscale node is tagged: it then has no login of its own, so every device pairs, yours included, or you name your login in `OVIS_TAILSCALE_OWNER`.
- **It is a paired device.** **Settings → Phone & devices**, on the PC (or on a device already paired), shows a six-digit code that lives ten minutes and a QR code that carries it. On a headless PC, the `pair` command prints the same in its terminal (see [In a terminal](#in-a-terminal)); Devices also shows the pairing link as text, to send to the other device. The other device enters it once and keeps its own credential in an HttpOnly cookie; the list shows it, and **Revoke** immediately closes its terminal connections and roster stream and refuses subsequent requests. A script or CLI pairs with `POST /api/devices/pair` and `{"code": "<code>", "label": "<name>"}` (with `X-Herdr-Machine: 1` and `Content-Type: application/json`), sending `Accept: application/json` to get its credential back as `{"token": "..."}`. It then sends `Authorization: Device <token>` with every request instead of a cookie, under the same role, last-seen time and **Revoke** as any paired device. Unlike the shared token, each such script can be revoked by itself.
- **It holds the token.** `OVIS_TOKEN`, for scripts and proxies, as a cookie after sign-in or as `Authorization: Bearer <token>`. When a token is set, everything else needs it, this computer and your own Tailscale login included: enter it once on each device, and that browser stays signed in for a year. A paired device, or a visitor Portal's own sign-in let in, still gets in without it.
- **It passed Portal's own sign-in.** Only where the app started its own Portal with one (a private link, an Ethereum wallet or an OIDC account: [Who may open the address](#who-may-open-the-address)). Portal tells the app who signed in, and that visitor may watch by default, like a paired watch device, but cannot type, read files, pair or revoke devices, subscribe to push alerts or control Portal. The same headers from anything else are ignored.
- **It comes through the Ovis relay from a phone paired there.** The relay is off by default ([Through the Ovis relay](#through-the-ovis-relay)). A phone pairs once by scanning the relay's QR code under **Settings → Phone & devices**, which gives it a key of its own for this PC, and proves itself with that key on every connection. Through the relay only that key counts, never the token, a device cookie or a Tailscale login. **Revoke** closes its connections at once, as for any paired device.

| How you reach it | What gets you in |
| --- | --- |
| This computer only (default) | Nothing needed. With a token set, the token |
| SSH tunnel (`ssh -L 7317:127.0.0.1:7317 host`) | Nothing needed. With a token set, the token |
| `tailscale serve`, your own devices | Nothing needed: your login. With `OVIS_TAILSCALE_SERVE_ONLY=1` on a one-login tailnet, the owner's phone needs nothing either. With a token set, the token, once per device |
| `tailscale serve` on a tailnet you share with others | Your devices: your login (with a token set, the token once). Theirs: refused unless you pair them |
| Your LAN (`HOST=0.0.0.0` or a LAN address) | Pair each device, or set a token |
| Your LAN over HTTPS (`OVIS_LAN_HTTPS_PORT`, see [On your LAN over HTTPS](#on-your-lan-over-https)) | Pair each device, or the token. Never open, even before the first pairing |
| A public domain, reverse proxy or Portal | Set a token, with HTTPS, and set the proxy up as in [Behind a reverse proxy](#behind-a-reverse-proxy). Never `tailscale funnel` it. Portal can also ask [its own sign-in](#who-may-open-the-address) first |
| The Ovis relay | Paired devices only: pair each phone once by scanning the relay's QR code. No token needed, see below |

The relay needs no token where a public proxy does, because it has no open address. A proxy puts the app itself on the internet: anyone who finds the address reaches it, and until a device pairs, an install with no token lets them in. Through the relay, a request reaches this PC only inside an encrypted connection that a phone opens with the PC's public key from the QR code, and the PC then admits it only with a valid pairing code or the key of a phone it paired before. Turning the relay on also closes the device gate when it was still open.

Until the first device is paired, and with no token set, a LAN or proxied address is open to anyone who reaches it, as it always was: the server warns on startup. The exception is a proxy on this PC while its Tailscale login is known, as with `tailscale serve`: a request that carries no login there needs pairing from the start, unless `OVIS_TAILSCALE_SERVE_ONLY=1` is set and that tailnet has one login and no tagged node, where such a request is the owner's own device. With that setting off, which is the default, every such request pairs. The first pairing closes access only after the browser returns its new device cookie. If the cookie is blocked or the pairing response is lost, the unconfirmed pairing does not restrict access; retry after checking browser and proxy cookie settings. A script that pairs for its token in JSON closes access at once, since it may store the token and use it later. Once confirmed, the gate stays closed: revoking every device does not reopen it. This app-level restriction also applies behind a proxy with its own authentication; other browsers need their own pairing or the app's token. Without a token, this computer itself stays in whatever happens, so you can never lock yourself out: revoke everything and pair again from `http://localhost:7317`. With a token set, this computer signs in with the token.

A token is a credential on the wire as much as a cookie is: on plain `http://`, anyone on the network path reads it, and then every keystroke after it. Reach this PC over Tailscale, put it behind a TLS-terminating proxy, or keep it on loopback and tunnel in; the server says so on startup when it is bound to another address over http.

The pairing code is a one-time secret: five wrong tries spend it.

### On your LAN over HTTPS

A phone on the same network as the PC can reach Ovis directly over HTTPS, beside the address it uses today (a tunnel, `tailscale serve`, loopback). It is off unless you set `OVIS_LAN_HTTPS_PORT` (for example `7318`) where Ovis starts, as with `HOST` and `PORT` ([Configuration](#configuration)).

- **Where it listens.** On that port of each private IPv4 address the PC has (`10.x`, `172.16-31.x`, `192.168.x`, `169.254.x`), never on every address. `OVIS_LAN_HTTPS_HOST=<address>` binds one address instead (`0.0.0.0` only when you write it). The main listener stays as it is. The addresses are read when Ovis starts: restart it after the PC joins another network.
- **Who gets in.** Only clients on a private IPv4 network, and only with the token or a paired device: never "this computer", a Tailscale login, the bridge token or an open install, even before the first device is paired. Pair a device with a code shown on the PC (Settings → Phone & devices): a code started through the relay is not taken here. A code has five tries of its own here, so wrong tries here never spend it for a phone pairing another way. Twenty wrong codes within ten minutes pause pairing here for ten minutes, and wrong tokens from every address here share one budget.
- **Its certificate.** Unless you give one, Ovis makes a self-signed certificate on first start and keeps it in the state folder (`lan-https/`, the key readable only by you). It names the PC's addresses, and a new one is made when they change or it runs out (after 825 days). Startup prints each address with the certificate's SHA-256 fingerprint.
- **Your own certificate.** Set `OVIS_LAN_HTTPS_CERT` and `OVIS_LAN_HTTPS_KEY` to PEM files, for example from a local CA made with [mkcert](https://github.com/FiloSottile/mkcert) (`mkcert -install`, then `mkcert 192.168.1.20` with the PC's address).

A bad value, a busy port or a certificate that does not load turns only this listener off, with a message at startup.

**Trust the certificate before you sign in through it.** A browser warns about a certificate it does not know, and clicking through that warning without checking it is how someone else on the network would collect your token or pairing code. Either:

- **Compare the fingerprint** the browser shows (the padlock or the warning's details) with the one Ovis printed, and continue only when they match. That is enough for a browser tab, but browsers turn off service workers on such a page, so the installed app, alerts and the microphone need the next way.
- **Trust a local CA on the phone.** Use the mkcert way above and copy mkcert's `rootCA.pem` (`mkcert -CAROOT` says where it is) to the phone. The self-signed certificate Ovis makes is not a CA, so phones do not offer to trust it this way: for it, compare the fingerprint.
  - iPhone and iPad: open the file (AirDrop or Files), install the profile in Settings → General → VPN & Device Management, then turn it on under Settings → General → About → Certificate Trust Settings.
  - Android: Settings → Security → Encryption & credentials → Install a certificate → CA certificate (the menu names differ between makers).

Keep the main listener off the same LAN address over plain http (`HOST` set to that address) while you use this: the browser keeps one cookie per address, so signing in over HTTPS signs that http tab out.

### Behind a reverse proxy

**Set a token first** (`OVIS_TOKEN`). A proxy on this PC connects from this PC, so the server knows a proxied request only by what the proxy sends: an `X-Forwarded-For` header (or another forwarding header), or a `Host` that is not `localhost` or `127.0.0.1`. A proxy that sends neither makes every visitor count as this computer: they get in with nothing, and pairing a device does not close it. nginx's plain `proxy_pass` is such a proxy. With a token set, every visitor needs the token whatever the proxy sends.

The proxy has to do four things:

- keep the browser's `Host`, so the app's own requests are not refused as coming from another site (`invalid_origin`);
- send `X-Forwarded-For`, so a visitor is not taken for this computer;
- send `X-Forwarded-Proto: https` when it serves HTTPS, so cookies are marked Secure and the app's own requests are accepted;
- pass the WebSocket upgrade for `/ws`, which carries the terminal.

Caddy does all four by default, and gets the certificate itself:

```caddyfile
herdr.example.com {
	reverse_proxy 127.0.0.1:7317 {
		header_up -Tailscale-User-Login
	}
}
```

nginx does none of them by default:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name herdr.example.com;
    ssl_certificate     /etc/letsencrypt/live/herdr.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/herdr.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7317;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Tailscale-User-Login "";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;
        proxy_buffering off;
    }
}
```

The `map` block goes in the `http` section. `proxy_read_timeout` keeps an idle terminal connected, and `proxy_buffering off` lets the PC list update live.

Both examples drop a `Tailscale-User-Login` header a visitor sends. That header is how `tailscale serve` names your own login, and on a PC that runs Tailscale the server trusts it from any proxy on this PC, so a public proxy must not pass a visitor's copy on. With a token set the server asks for the token whatever that header says, so a proxy that does pass it on gives a visitor nothing.

**If the proxy already signs people in** (basic auth, Authelia, oauth2-proxy and the like), let it hand the app the token, so nobody signs in twice and Settings stops warning that this address is open. Set `OVIS_TOKEN`, then have the proxy send it on every request it lets through, the terminal's `/ws` connection included. In Caddy, inside `reverse_proxy`:

```caddyfile
		header_up Authorization "Bearer {env.OVIS_TOKEN}"
```

In nginx, inside `location /`:

```nginx
        proxy_set_header Authorization "Bearer <your token>";
```

The proxy's own sign-in is then the only one: anyone it lets through gets in, and nobody needs to pair a device. Settings then offers no **Sign out**: the proxy would send the token again with the next request, so signing out is done at the proxy. Keep the app's port closed to everything but the proxy, as `HOST=127.0.0.1` does.

To check the app's gate, request its `/api/session` directly without a token: it must answer 401.
If the proxy signs people in, also check that a signed-out visitor cannot reach the app through
the public address.

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/) gives this PC a public HTTPS address on a domain in your Cloudflare account, with no port open on this PC. `cloudflared` does all four things with no settings: Cloudflare keeps the public `Host`, sends `X-Forwarded-For` and `X-Forwarded-Proto: https`, and passes the `/ws` upgrade. Keep `HOST=127.0.0.1` and set `OVIS_TOKEN` first, then [create the tunnel and route its hostname](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/) (`cloudflared tunnel login`, `cloudflared tunnel create ovis`, `cloudflared tunnel route dns ovis herdr.example.com`) and point that hostname at the app in `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel ID>
credentials-file: /home/<you>/.cloudflared/<tunnel ID>.json
ingress:
  - hostname: herdr.example.com
    service: http://127.0.0.1:7317
  - service: http_status:404
```

`cloudflared tunnel run ovis` then starts it. A tunnel made in the Cloudflare dashboard ignores this file: set its public hostname's service to `http://127.0.0.1:7317` there.

To try it without an account, `cloudflared tunnel --url http://127.0.0.1:7317` prints a random `https://<words>.trycloudflare.com` address. It changes on every run, and cookies and the installed app are tied to the address, so it suits a test, not a phone you keep using. A quick tunnel also carries no [Server-Sent Events](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/), which the sidebar and the PC list update by, so the terminal works through it but those may not update by themselves.

Unlike the Caddy and nginx examples, Cloudflare passes on a `Tailscale-User-Login` header a visitor sends. On a PC that runs Tailscale, the server still does not take it for your login, because Cloudflare adds the visitor's own address to `X-Forwarded-For`, but do not rely on that: with a token set the header gives a visitor nothing. To drop it as well, add a [Request Header Transform Rule](https://developers.cloudflare.com/rules/transform/request-header-modification/) for that hostname that removes it. Do not set `OVIS_TAILSCALE_SERVE_ONLY=1` on a PC a tunnel reaches.

Cloudflare Access can put its sign-in in front of that hostname, but it cannot hand the app the token as Caddy or nginx can: Access adds no `Authorization` header to the requests it lets through. Keep the app's own gate on behind it. Each device signs in to Access, then enters the token once or is paired from **Settings → Phone & devices**, and stays signed in to the app; Access still asks it to sign in again when its own session runs out. A script reaches the app through Access with an Access [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), allowed by a **Service Auth** policy on that application, in its `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers, plus `Authorization: Bearer <your token>` for the app. The Android app cannot get past the Access sign-in yet ([#2008](https://github.com/devswha/ovis/issues/2008)): open the address in the phone's browser instead.

[Portal](https://github.com/gosuda/portal-tunnel) gives this PC a public HTTPS address with no account and no domain of your own. From v2.6.1, its `--http-route` does all four things and can drop a header a visitor sends; the plain `portal expose 7317` sends no `X-Forwarded-Proto`, so the app's own requests are refused (`invalid_origin`).

**On a PC that runs Tailscale, keep `--strip-request-header Tailscale-User-Login` in the command.** Without it Portal passes on a visitor's copy of that header, and with no token set the server trusts it, so a visitor who sends your Tailscale login gets in. Do not set `OVIS_TAILSCALE_SERVE_ONLY=1` while Portal runs either: it says `tailscale serve` is the only way into this port, and Portal is another (see [Configuration](#configuration)). `tailscale serve` is the simpler route on such a PC.

Set `OVIS_TOKEN` to a long random value first (for example from `openssl rand -hex 32`; [In a terminal](#in-a-terminal) says where settings go), then start Portal:

```bash
portal expose --http-route /=7317 \
  --strip-request-header Tailscale-User-Login \
  --name herdr-$(openssl rand -hex 8) \
  --identity-path ~/.config/portal/herdr.json \
  --relays <relay> --discovery=false --hide
```

Take `<relay>` from `portal list`; it has to run v2.6.1 or later. A `portal` process on this PC ends the HTTPS connection; a relay running Portal's code only reads the address to route by and passes the encrypted bytes on, so it sees connection addresses, timing and volume, not the traffic ([Portal's security model](https://gosuda.github.io/portal-tunnel/security-model)). It does hold the certificate for its domain, so a relay set up to intercept could read the traffic; that is why the relay must be one you trust. One relay with `--discovery=false` keeps one address, which cookies, the installed app and alerts are tied to. `--hide` keeps the address off the relay's public list, and the random name keeps its short form hard to guess. The first run saves that name in the identity file, and later runs reuse it, so the address does not change on each start.

Portal prints `service ready at https://<name>-<address>.<relay>:443`, where `<address>` is the identity file's 40-character address; with or without `:443` it is the same address. That address belongs to the identity, so nobody else can take it, even while Portal is stopped; keep the identity file private and keep using it, since a new identity gives a new address. Check it as above: `https://<name>-<address>.<relay>/api/session`, opened from another device without signing in, must answer 401. Then open it on the phone and sign in with the token, or pair the phone from **Settings → Phone & devices → Pair a device** on the PC. Use that address, not the shorter `https://<name>.<relay>`, which another identity can claim while Portal is stopped.

**Settings → Phone & devices → Portal** runs that command for you once Portal v2.6.1 or later is installed on this PC ([Portal's install script](https://github.com/gosuda/portal-tunnel#quick-start) puts `portal` in `~/.local/bin`): enter a relay and press **Start**, after choosing [who may open the address](#who-may-open-the-address). It starts only with `OVIS_TOKEN` set and `OVIS_TAILSCALE_SERVE_ONLY` off, and asks the relay for its version first. The address and its QR code show on every signed-in device, any device that can type into your terminals can stop it, and one left on comes back when the app restarts. If Portal stops on its own after its address was up, the app starts it once more on the same relay and identity, and the panel says **Recovering…** meanwhile. If it stops again, or the restart may not go ahead (the token or serve-only setting no longer allows it, or its saved state or identity file changed), the panel shows the error with Portal's output; **Stop** and then **Start** begin again. The app keeps an identity file of its own in `OVIS_STATE_DIR`, so its address stays the same from one start to the next and differs from the one a `portal` you run yourself has.

At startup, the app waits for any recorded Portal process to stop before answering requests. If `portal/state.json` under `OVIS_STATE_DIR` is damaged, or the recorded process cannot be identified or stopped, requests fail closed rather than risk exposing a server restarted without a token. Check the server log. After confirming that this app's Portal process has stopped, repair or remove only `portal/state.json` and restart the app. Keep `portal/identity.json` to preserve the address; never discard the state record while its tunnel may still be running. Servers on different ports need separate state directories to control their own Portal addresses.

**Sign out** in Settings → Devices clears, after asking once, this browser's token and device cookies; terminal sessions and agents keep running. If Portal's sign-in remains after those cookies are cleared, the same click also ends the Portal session and reloads. A browser signed in only through Portal ends that session directly. This does **not** sign out of Google or your company identity provider: Portal asks the provider without `prompt` or `max_age`, so an existing provider session can sign you straight back in. Sign out of that account at the provider too if you want the next visit to ask for credentials. Sign out is not offered when a proxy sends the token in the `Authorization` header (sign out at the proxy), or for automatic local or Tailscale access.

If `devices.json` under `OVIS_STATE_DIR` (default `~/.config/ovis`) is corrupt or unreadable, the server keeps unrecognized external clients out and preserves the file. Local access and the owner's trusted Tailscale login without a configured token, and a valid token, still work. Settings → Phone & devices and the server log explain the error. Restore a valid registry from backup or fix its permissions, then restart; pairing and device changes remain disabled until it is repaired.

Nothing is typed without you:
- Input typed while disconnected waits as a draft for you to send or discard.
- On a current bridge, a message sent while the agent works goes to its next turn on its own, but only while the connection that sent it stays open and still holds the pane. Switching tabs or workspaces on the same PC keeps that pane attached until its automatic queue settles. Losing the connection or lease cancels delivery, even if the connection rejoins later. A reload or reconnect never resumes that: the saved copy of such a message comes back marked not confirmed, to copy or discard after checking the terminal. Other held messages stay with their PC and pane until you choose **Send now** or **Discard**. If the browser cannot save the queue, it says so: keep the tab open or copy the messages before reloading.
- A typed answer that picks an option of an approval, plan or menu waits for **Confirm**.

Attaches and reconnects wait when another client holds the terminal. **Open here** on the waiting
notice explicitly takes that pane with `--takeover`: the other web bridge waits in turn, while a
standalone `herdr terminal attach` exits. The herdr TUI stays connected (verified on herdr 0.9.3).
Observe connections cannot take a pane, and a displaced bridge never takes it back automatically.

#### Who may open the address

By default the app's own token or a paired device lets a visitor in, as above. **Settings → Phone & devices → Portal** also offers to put Portal's own sign-in in front of the whole address, so a visitor must pass it before the app is reached at all:

- **Token or paired device only** is the default, and starts Portal exactly as before.
- **Private link** (`--auth credential`) lets in only people you send a link to. While Portal runs, **Invite someone** takes a name and 1, 7, 30 or 90 days (30 by default) and shows the link once. It is a bearer secret: whoever holds it gets in until it expires, so send it only to its person; the app keeps no copy, and the link works only for that Portal address. Add link names to the list to accept only links issued to those names; **with none, every unexpired link you issue works**. A browser that is in through Portal's own sign-in cannot issue links, or a link's holder could issue a new one before theirs expires.
- **Ethereum wallet** (`--auth siwe`) lets in only the wallets you list, each proving itself with a signature. At least one is required here: with none, Portal would let any wallet in.
- **Google or company login** (`--auth oidc`) lets in only the verified emails, `@domain`s (the exact domain) and `sub:<id>` accounts you list, signed in at an OpenID Connect provider: Google, or any https issuer. Register **both redirect URIs** shown by the running panel: `https://<name>-<address>.<relay>/_portal/auth/callback` for the address-bound host (`service ready at`), and `https://<name>.<relay>/_portal/auth/callback` for the short `--name` host (`short URL`). Portal builds the callback from the host the visitor opens, and Google matches redirect URIs exactly; registering only one leaves the other host with `redirect_uri_mismatch`. The panel reads these from `url` and `short_url` and shows them once Portal has started. Put the provider's client secret in `OVIS_PORTAL_OIDC_CLIENT_SECRET` in the server's environment: the app hands it to Portal's environment and nowhere else, so it is never typed in the panel, put in an argument (`ps` shows those), saved in `portal/state.json` or sent in an answer, and the panel says when it is not set. OIDC also needs a Portal build that lists its own flags.

Whoever passes Portal's sign-in may **watch by default**, with no app token asked. The server applies the same restrictions as a paired watch device: no terminal input or resize, file reads, workspace changes, pairing or device changes, or Portal Start, Stop and **Invite someone**. Even a Portal invitation with a saved drive role cannot redeem a pairing code, manage devices, use push subscription or status routes, or control Portal; alerts stay in the open tab. The owner's app token that started Portal still gives drive access, and an existing paired device keeps its assigned role. These app credentials take precedence over Portal's identity; no link name, wallet or OIDC account is guessed to be the owner.

Each invitation stores its name and `watch` role in `portal/state.json`, never its bearer link. Issuing another link for the same name sets it to watch again; a request cannot choose a drive role. Missing invite records and missing roles default to watch, including links issued before this change. The server reads stored roles on start or resume. Earlier builds of this Portal sign-in feature ignore these records and grant Portal visitors drive access: **stop Portal before rolling back to one of those builds** if visitors must remain watch-only. Released builds without Portal sign-in require the app token or a paired device instead. Giving someone the app token or a driving device still gives them a shell as your user on this PC.

Portal checks its sign-in on every request, and the app closes such a browser's open terminal connection and live updates every 5 minutes so they too come back through Portal: a link that expires, a name taken off the list or a sign-out ends a page left open within 5 minutes. Link names, wallet addresses and OIDC entries are checked as Portal checks them (names and ids in ASCII only, since a name reaches the app in an HTTP header). The sign-in choice is saved with the rest of Portal's state and changed only while Portal is stopped: an app restart brings the address back with the same sign-in, and a relaunch after Portal ended on its own goes ahead only while the saved settings are the ones it served with. **Settings → Devices** says who signed in through Portal.

A sign-in needs a Portal that can prove who signed in. The panel decides by the flags the installed `portal` lists in `portal expose --help`: it offers a sign-in only when `--auth`, `--auth-allow`, `--auth-identity-headers` and `--auth-identity-proof` are all there (OIDC adds its own), and says "This Portal does not support it yet" when they are not. A Portal that signs visitors in but cannot send the proof would leave the app to believe a header anyone can type, so it gets no sign-in at all. Portal v2.7.0 is the first release that lists `--auth-identity-proof`, and it lists the OIDC flags too. A sign-in also needs **Portal v2.7.3 or later on this PC**: older ones let a session cookie from the short address pass for whoever takes the same name once Portal registers again, so the panel offers no sign-in on an older Portal ("This Portal does not support it yet"), and **Start** with a sign-in refuses one, says which version this PC has, and asks you to update Portal or start without a sign-in. A version that is not a whole semver version (such as `v2.07.3` or `v2.7.3.4`) counts as older, and when `portal version` gives no version at all, Start says it could not read the Portal version (so does the restart after an app update, and the relaunch after Portal ended on its own). Without a sign-in, v2.6.1 is still enough. With v2.7.3, visitors on the short address sign in again after Portal restarts or registers again (Portal's own behaviour); the address that holds the identity, and invite links, keep working.

Portal tells the app who signed in with `X-Portal-User` and `X-Portal-Auth` (`--auth-identity-headers`) and, beside them, `X-Portal-Proof`: a secret the app makes at each launch of that Portal, hands over in its environment (`AUTH_IDENTITY_PROOF`, never an argument, since `ps` shows those) and keeps in memory. Portal drops a visitor's own copy of all three. The app believes the identity only on a request whose proof matches (compared in constant time) and whose values are shaped as Portal makes them. Without the proof, or with a wrong one, the headers are ignored and the request meets the token rules like any other, so another proxy on this PC (`tailscale serve`, nginx, Caddy), a local process or any other way to the app's port gets nothing by typing them. The proof is not saved, logged or sent in any answer, and it goes with the Portal that had it: when that Portal stops, ends or is launched again, the old proof counts for nothing. It is as private as `OVIS_TOKEN`: whoever can read the server's or Portal's environment can read both. Without a sign-in no proof is made, and the command drops a visitor's copies (`--strip-request-header X-Portal-User --strip-request-header X-Portal-Auth`). A `portal expose` you run by hand with `--auth` is just a proxy to the app, which still asks for its token.

## Herdr app terminals

The [Herdr desktop app](https://herdr.dev/download/) runs its terminals on herdr-core (`hc`), a
runtime apart from herdr's TUI server. Ovis can show those terminals instead of the TUI's: this
PC's panes are then the app's. One server serves one runtime, chosen as it starts:

1. `OVIS_RUNTIME` (`herdr` or `herdr-core`) in the server's environment, when it is set;
2. else the choice made in **Settings → About → Terminals** (saved as `runtime-<port>.json` in the state folder);
3. else what the PC has. Any trace of herdr's TUI (a `herdr` on the `PATH` or in `~/.local/bin`,
   `~/.config/herdr/config.toml`, or its socket) keeps herdr, and nothing is run to decide it.
   Only a PC with none looks for herdr-core, and picks it when an `hc` answers `--version` and the
   Herdr app is installed or its core runs.

Ovis needs an `hc` speaking
protocol generation 1 (checked with 0.1.14 and 0.1.17), and looks for it in `OVIS_HC_BIN`, then
the usual install places (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, mise, Nix and
cargo), then the `PATH`, then your login shell's `PATH`, taking `herdr-core` before `hc` in each.
On Linux and macOS a candidate found there is run only when it and every folder on the way to it
belong to you or root and nobody else can write them; a path you set in `OVIS_HC_BIN` is run as
you named it. Two exceptions: a folder further up may be writable by anyone when it is sticky
(like `/tmp`), since nobody can then rename or replace what is yours in it; and on macOS, folders
under Homebrew's `/opt/homebrew` and `/usr/local` may be writable by the `admin` group, as
Homebrew leaves them, so another administrator of that Mac could change an `hc` found there.
Group write by your own private group counts as yours only when `/etc/nsswitch.conf` takes
accounts from local files alone. On a PC whose accounts also come from a directory service (sss, as on
Fedora and RHEL by default), an installer-made `~/.local/bin` with umask 002 is group-writable and
so is passed over: run `chmod g-w ~/.local/bin`, or set `OVIS_HC_BIN` to the `hc` you trust. When
nothing is found, the error names each `hc` passed over and the rule it failed. A candidate counts only when `--version` says `hc …`, since some window
managers ship an unrelated `hc`. Looking runs nothing but `--version`: every other hc command
starts a core when none runs. When no candidate answers, Ovis does not start and says where it
looked, rather than run an `hc` that may not be herdr-core's.

**Settings → About → Terminals** says which runtime this PC serves and, when the PC has the
other one too, offers to switch: **Switch** asks first, saves the choice and restarts Ovis on it,
on the same port and state folder, and Settings shows the new runtime once the restarted server
answers. Text left unsent in one runtime's panes waits in **Recover unsent text** once the other's
are shown; pins and muted alerts are kept for the panes shown, so the other runtime's may be cleared.
A start that fails on the chosen runtime goes back to the previous one, and a saved Herdr app
whose core is gone starts herdr instead and says so there. Only a device that drives this PC can
switch, never a watching one or a stranger on an open install, and the switch needs Ovis's own
launcher (the herdr plugin or `bun run start`), which restarts the server. When `OVIS_RUNTIME`
is set in the environment, it decides, and Settings says to change it there. On a server
started directly (`bun server/index.ts`), Settings says how to switch by hand: set
`OVIS_RUNTIME=herdr-core` and restart Ovis (for herdr's plugin, in the `.env` file in the folder
`herdr plugin config-dir devswha.ovis` prints). The look for hc behind these facts skips the
login shell, whose profile could run any command, so it never starts a core on a PC that did not
choose herdr-core; the start on herdr-core looks there too, and so does finding hc again after an
update moved it, each candidate asked `--version` afresh. While Ovis serves herdr-core, herdr's
own version and **Update herdr** are not shown: herdr-core's version is on the Terminals line.
Whether the core runs is read from its socket file (`HC_SOCKET`, `socket` in hc's
`config.toml`, else `<session>.sock` under `$XDG_RUNTIME_DIR/herdr-core/`; `HC_SESSION` names the
session, `default` otherwise); nothing connects to it.

On Windows the automatic choice stays on herdr: Ovis serves herdr-core when it is chosen in
Settings, or when `OVIS_RUNTIME=herdr-core` is set, as the desktop app sets it. Settings and
`/api/health` find herdr there in `%LOCALAPPDATA%\Programs\Herdr\bin` and `%APPDATA%\herdr`.

**Moving everything to herdr-core.** On a Linux or macOS PC where Ovis serves herdr's TUI through
its own launcher and no Herdr app is installed, **Settings → About → Terminals** offers **Move
everything to herdr-core**. It shows its plan first, then moves the whole session together:
every workspace, tab, split and pane name is rebuilt on herdr-core, agents reopen on their own
conversation (or start new in the same folder when it cannot be told), and shells start again in
the same folder (your home folder when that folder is gone). Ovis ends an idle Claude Code itself; other agents wait for you to end them, so
nothing typed in their input line is sent. Nothing moves while an agent works or a shell runs a
command: the move waits for them and goes by itself once they are done. Scrollback and programs
running in a shell do not move. If a step fails before the switch, Ovis ends what it built on
herdr-core, restarts in herdr the agents it ended, and lists any it could not; herdr itself is
never closed. On such a PC without herdr-core, the row
reads **Install herdr-core and move everything**: it installs herdr-core 0.1.17 into
`~/.local/bin` (checked against a pinned checksum, no sudo, herdr untouched), then shows the same
plan. [Moving herdr's session to herdr-core](runtime-move.md) has the details.

On a Linux or macOS PC with herdr-core and no herdr, the one-line installer
(`curl -fsSL https://ovis.sh/install.sh | sh`) sets this up by itself: no herdr and no plugin, Ovis
in `~/.local/share/ovis/app`, `OVIS_RUNTIME=herdr-core` in `~/.config/ovis/env`, and a user service
that starts it at login (`systemctl --user status ovis` on Linux, the `sh.ovis.server` LaunchAgent on
macOS). See [INSTALL.md](../INSTALL.md#2-choose-the-install-method).

- **Sidebar:** each of the app's spaces is a workspace and each of its tabs a tab, in the app's
  order and names; every terminal block in a tab is a pane. A terminal no tab holds that another
  one started (a helper an agent started with `hc run`) has a tab of its own right after the tab
  of the terminal that started it, and its row in **Agents** is one line indented under that
  agent's, its place in the row's tooltip (closing that workspace ends it too, as ending the agent would). Any other terminal no tab
  holds has a tab of its own under **Other terminals**.
- **New and Close:** **New workspace**, **New tab**, a new terminal and **New tab with agent**
  start a shell that herdr-core keeps, labeled so the Herdr app takes it into that space and tab;
  it shows there even before the app does. Ovis never writes the app's own names, so a name you
  type is kept on the terminal and shown while the app has no name of its own for that space or
  tab. **Close** ends every terminal of the pane, tab or workspace, and the app drops them. Terminals under **Other terminals** are closed one by one.
- **Starting an agent:** the agent's command is typed into the pane's shell, so it starts only
  in a pane that runs a plain shell of its own (sh, bash, dash, zsh, ksh, mksh, ash or fish), and
  only while nothing else runs in front of it. A pane the app started with a program directly
  cannot take one. On Windows that shell is PowerShell (herdr-core's own, or one started with
  interactive switches only) or cmd (without `/c`, `/k`, `/r` or `/v`). A POSIX shell cannot take
  one there: Git Bash rewrites an argument that looks like a path on its way to the agent, and this
  PC's process table does not show what runs in WSL. herdr-core names only the shell in front of a
  Windows pane, so that table says the rest: the pane is busy while any program runs below its
  shell, console hosts aside, or the table cannot be read, and the agent has started once a
  program named for it runs there. A command PowerShell runs in itself (`Read-Host`) shows no
  program there and takes the line as its input, and text left at a Windows prompt runs with the
  line, as no key clears it in every editing mode. An argument the shell would change is refused
  before anything is typed: in Windows PowerShell one whose whitespace all follows an odd number of
  `"` (`"fix the bug"`, `x="a b"`); in PowerShell 7 an empty one, one holding a `"`, or one holding
  whitespace and ending in a backslash; in cmd one holding a `"` or a `%`. In PowerShell one
  holding `%` or `^` is refused too, and one holding `&`, `|`, `<` or `>` unless it also holds a
  space and no `!`, and no argument of the line holds a `"`: an agent PowerShell starts through a
  `.cmd` file alone (an npm install also has a `.ps1`, which PowerShell prefers) has its arguments
  read by cmd as well, where an `&` outside cmd's quotes would end the agent's line and run the
  rest. PowerShell quotes an argument only for its whitespace, a `"` in any argument moves cmd's
  quotes, cmd expands `%NAME%` (and `!NAME!` with delayed expansion) inside quotes too, a shim's
  `call` doubles a `^`, and which file the agent's name finds is not known before. Where the execution policy blocks scripts (`Restricted`, the Windows
  default), PowerShell refuses that `.ps1` and does not fall back to the `.cmd`: the start fails,
  and the pane says why. cmd looks in the pane's folder before the `PATH`, as it does for what you
  type. Command Code is not offered on Windows, where its command `cmd` is cmd.exe, and a Windows
  PC offers no agent on another machine of its core, whose shells its process table does not show.
- **Status and alerts:** an agent's status is what it reports to herdr-core (OSC 7501), so an
  agent that reports none shows no status. A turn is done only when the program itself reports
  its turn finished (`done`, or `working` then `idle`); `error` shows no status. When a blocked
  agent says why (a permission, a question or a sign-in), its row in **Agents** says so in a few
  words after its name, and the row's and the state's tooltips give its message in its own words;
  a progress it reports (0 to 100) while it works or waits is a percent after the name. Nothing
  is shown that it did not report.
- **Pinned agents:** an agent pinned in Ovis is pinned in the Herdr app, and one pinned or
  unpinned in the app is pinned or unpinned in Ovis, through herdr-core's `herdr.pinned`
  terminal label; a pin made in the app joins the end of the pinned list. When the two first
  meet, a pin on either side is kept; after that, a pin or unpin made on one side while Ovis was
  stopped or herdr-core away is kept too. Pinned workspaces stay Ovis's own. A pin made in the app
  joins Ovis only while its list has room (500 pins); until then it stays the app's alone.
- **Read finishes:** Ovis and the Herdr app agree on which finishes someone has looked at,
  through herdr-core's `herdr.seen` terminal label. A finish you read in Ovis is no longer
  **done** in the Herdr app, and one you looked at in the app is no longer **done** in Ovis; one
  marked unread elsewhere is **done** again (Ovis does not read it for you again while it stays on
  your screen; coming back to it later does). A terminal no client has labeled yet shows a turn that ended since Ovis started as
  **done**, until someone reads it. A remote PC's finishes are not shared this way.
- **Terminal:** the live view streams over the server's own connection to herdr-core, input and
  the key bar work as on herdr, and the terminal takes the size of the viewer that last typed in
  it or resized it: the app's window, or your phone once you type or open it there. herdr-core
  keeps no view of its own to scroll, so the browser keeps the scrollback, as a desktop terminal
  does: each attach starts with the terminal's last 2,000 lines of history, and the wheel, a
  swipe or the scrollbar scrolls back through them while the program does not read the mouse. A
  full-screen program (an editor, `htop`) has no history; its wheel goes to the program as on
  herdr.
- **Tabs out of use:** herdr-core draws no read-only view at another size, so a tab you leave is
  not kept current behind your back. A recent tab you switch away from keeps its last screen until
  you are back, **Use alongside herdr's own window** lets go of a pane only when you leave the
  window, and after a reconnect a tab attaches again at once.
- **Chat:** while a line the terminal wrapped is on screen, its colors cannot be matched to the
  screen's text, so a grey suggestion Claude Code or Hermes leaves in an empty input box then reads
  as typed text, and a send waits for you to confirm it.
- **Layout:** on a herdr-core no Herdr app arranges (the desktop app's own core, or one where the
  app never ran), Ovis keeps the layout itself: renaming, reordering and moving workspaces and
  tabs, and splitting, resizing, swapping, zooming and naming panes work as on herdr. Names and
  places are terminal labels and the order and splits one document of Ovis's own
  ([its format](herdr-core-layout.md)). Where the Herdr app arranges the core, the layout is the
  app's window's: Ovis shows it and hides those actions. A Herdr app started later on a core
  Ovis arranged takes in its terminals, grouped and named as they were, but not their split
  ratios or order; from then on the app arranges them.
- **Agents' sessions:** herdr-core keeps no session reports, which herdr's own agent integrations
  send to herdr's TUI server only, so a chat that needs one has none there. pi's chat comes from
  the session the pane's pi names itself through the web UI's pi extension (see
  [Supported agents](#supported-agents): `bun scripts/install-pi-integration.ts`, then restart
  pi); without the extension a pi pane uses Terminal. Other agents whose chat reads only that
  report, OpenCode for example, use Terminal on herdr-core.
- **Not on herdr-core:** search in a pane, scrolling or selecting the history through the
  scroll buttons beside it, plugins and worktrees.
- **Other machines:** each machine the core reaches (`hc machine add vps`, or added in the Herdr
  app) is a PC of its own in the sidebar, beside this one: its workspaces and tabs as its own
  `herdr-app` document lays them out, its live terminals, input, status and alerts, and new
  workspaces and tabs started there. Ovis reaches it through this PC's core: nothing of Ovis is
  installed on it, and it is added, renamed or removed with `hc machine` or in the Herdr app.
  Ovis starts one more server of its own for each (on loopback, with an empty home folder of its
  own), so its agents' chat history is not read here: their transcripts are on that machine.
  Its files are not reachable from Ovis yet: file previews, the Files view, diffs, pasted images
  and the folder picker are refused for it. A folder typed for a new workspace there is passed to
  that machine as written (empty: its home). Pins and "seen" are not shared with the Herdr app
  there. Temporary machines (`hc machine add --temp`) are not shown, and
  PCs added over SSH or through the relay keep working beside them.

## Configuration

Each `OVIS_*` variable was called `HERDR_WEB_*` before Ovis took its name (`OVIS_REF` was `HERDR_WEB_UI_REF`). The old names still work; where both are set, the `OVIS_*` one wins. The state dir moved from `~/.config/herdr-web-ui` to `~/.config/ovis` the first time the new version ran, leaving a link at the old path.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` or a LAN address only with `OVIS_TOKEN` set or once a device is paired: until then that address is open to anyone who reaches it (see [Access and safety](#access-and-safety)). |
| `PORT` | `7317` | HTTP and WebSocket port. Left unset, the plugin takes the next of 17317, 27317, 37317 and 47317 when 7317 cannot be opened (another program has it, or Windows reserves it for Hyper-V, WSL2 or Docker), keeps that port for later starts, and the installer and the **Ovis status** action print the address. A port set here is never changed |
| `HERDR_SOCKET` | `~/.config/herdr/herdr.sock` | herdr socket for API calls and terminal attach. For a named session, use `~/.config/herdr/sessions/<name>/herdr.sock`. A plugin install follows the socket of the herdr session that starts it; set `HERDR_SOCKET` in the plugin's config to pin another one, and that setting wins. |
| `OVIS_TOKEN` | unset | Shared token for scripts and proxies. Once set, every client that is not a paired device needs it, this computer and your own Tailscale login included |
| `OVIS_LAN_HTTPS_PORT` | unset (off) | Opens an HTTPS listener on this port for devices on the same network, beside the main one; only the token or a paired device gets in there (see [On your LAN over HTTPS](#on-your-lan-over-https)) |
| `OVIS_LAN_HTTPS_HOST` | unset (every private IPv4 address) | The one IPv4 address that listener binds instead; `0.0.0.0` only when written |
| `OVIS_LAN_HTTPS_CERT`, `OVIS_LAN_HTTPS_KEY` | unset (self-signed, kept in the state dir) | PEM files of your own certificate and key for that listener, for example from a local CA; set both or neither |
| `OVIS_CSP` | unset (enforced) | `report-only` sends the policy as `Content-Security-Policy-Report-Only`: the browser reports what it would block and the app keeps working. Used to measure the policy after a change |
| `OVIS_TAILSCALE_OWNER` | this PC's Tailscale login | The Tailscale login that gets in through `tailscale serve` without pairing. Set it on a PC whose Tailscale node is tagged, which has no login of its own |
| `OVIS_TAILSCALE_SERVE_ONLY` | unset (off) | `1` declares `tailscale serve` the only way anything reaches this port. Then the owner's own device gets in through serve without a code, on a tailnet one login owns with no tagged node. Enable it only when no public reverse proxy, tunnel or other forwarding server exposes this port: a visitor through one would otherwise get the owner's access. It also keeps the [Ovis relay](#through-the-ovis-relay) off |
| `OVIS_TAILSCALE_HTTPS_PORT` | unset (first free of 443, 8443, 7317, 17317) | The HTTPS port the installer publishes the app on with `tailscale serve`, and the one **Settings → Phone & devices** suggests. When another service already uses it, the installer stops and says so instead of taking another port, since an app installed on a phone stays on the address it came from. An address that already serves the app is kept |
| `OVIS_RELAY_URL` | `wss://relay.ovis.sh` | The [Ovis relay](#through-the-ovis-relay) this PC connects to while the relay is on: a `wss://` address with no path, such as [your own](#running-your-own-relay). Unset, the PC uses `relay.ovis.sh` and, when a [regional relay](relay.md#regional-relays) answers much faster, that one too. Read when the server starts; a value that is not such an address keeps the server from starting |
| `OVIS_RELAY_APP_URL` | `https://app.ovis.sh` | The address the relay's QR codes open on a phone: an `https://` address with no path. Set it when you [host the app yourself](#running-your-own-relay). A value that is not such an address keeps the server from starting |
| `OVIS_STATE_DIR` | `~/.config/ovis` | Push keys, device subscriptions, PC registrations, update builds, the app's Portal and relay identities, and the Portal sign-in you chose |
| `OVIS_PORTAL_OIDC_CLIENT_SECRET` | unset | The OIDC client secret for **Google or company login** in Portal's panel ([Who may open the address](#who-may-open-the-address)). Read at each start into Portal's environment only; set here, it cannot be changed from the app |
| `OVIS_OPENAI_API_KEY` | unset | OpenAI API key for [voice input](#voice-input). Set here, it cannot be changed from the app |
| `OVIS_OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API root for voice input |
| `OVIS_AUTO_UPDATE` | `0` | `1` installs new releases without asking |
| `OVIS_UPDATE_CHANNEL` | unset (`stable`) | `beta` also offers the [beta builds](#beta-builds) made from main; `stable` turns them off whatever the state dir's `update-channel` file says |
| `OVIS_TELEMETRY` | unset (on) | `0` sends no [anonymous usage counts](#anonymous-usage-counts), whatever the switch in Settings says. `DO_NOT_TRACK=1` does the same |
| `OVIS_PUSH_SUBJECT` | this repository's URL | VAPID contact URL or `mailto:` address |
| `OVIS_BUNDLE_MANIFEST` | unset | Remote-PC bundle manifest (path or URL) that overrides local and published bundles |
| `OVIS_HERDR_BIN` | `herdr` | herdr executable used for terminal attach |
| `OVIS_RUNTIME` | chosen | `herdr-core` shows the terminals of [herdr-core](https://herdr.dev/core) (`hc`), the core the Herdr desktop app runs on, instead of herdr's TUI server. Unset, the runtime chosen in Settings, else what the PC has, decides; set, it wins and Settings cannot switch: see [Herdr app terminals](#herdr-app-terminals) |
| `OVIS_HC_BIN` | found | hc executable used with `OVIS_RUNTIME=herdr-core`, looked at first: the server runs it as its one `hc connect`, which also carries the live terminals. One whose `--version` does not say `hc …` is passed over for the next one found (see [Herdr app terminals](#herdr-app-terminals)). `HC_SESSION` and `HC_SOCKET` pick the core as for any hc command |
| `OVIS_SSH` | `ssh` (Git for Windows' on Windows) | OpenSSH client for [remote PCs](#remote-pcs-over-ssh); the `sftp` and `ssh-keygen` beside it are used too |
| `OVIS_APP_NAME` | unset (`Ovis`) | The name the installed app has on a phone or computer, for example the PC's name. Each PC installs as an app of its own, and without it they are all called `Ovis`. An app already installed takes the new name when the browser next updates it, usually within a day or two, without a reinstall. Keep it short: a home screen cuts a long label |
| `OVIS_PASTE_DIR` | `<pane cwd>/.ovis` | Where pasted and attached files are saved: an absolute path or `~/…`. Set it to keep them out of your projects; an agent may then ask before reading one. It covers the panes of this server's PC; a remote PC keeps the default |
| `OVIS_MEDIA_ROOTS` | unset | Folders besides its own that a rendered HTML page may play a video or sound from, through a symlink beside it or a `../` link: absolute paths separated by `:` (`;` on Windows), for example a network share where recordings are kept. Any page can then find out which files exist there. Unset, a page plays its large videos only from its own folder, so a page that came with its own symlinks cannot find out which of this PC's files exist. A large video plays from an address made for that render: it works only from the device's network address that opened the page, for 30 minutes (reload the page after that), and stops when that device is revoked or signs out. The page's own script can read that address and share it, so for those 30 minutes anyone behind the same network address can play that file too. On a Mac, every folder from the one named here down to the file must belong to the user Ovis runs as and be writable by no group or other user, or nothing in it plays |
| `CODEX_HOME` | `~/.codex` | Where Codex sessions are read |

## Updates

`bun run start` and the plugin look for a newer **release** 10 seconds after start and then every 5 minutes. A release is a `vX.Y.Z` tag ([changelog](../CHANGELOG.md)); commits between releases never reach installs. When a new version is out, a line under the header names it, and its **Update** button installs it and shows the install's steps; **Settings → Updates** has the same controls and the full error when an install fails. The release's notes are there too, under **What's new**: every release the update installs, newest first, as a short list of what is new, improved and fixed in the app's language, with **Show every change** opening that release's changelog, and the line's **What's new** button opens Settings on them. After the update and the reload, the line says which version now runs, with the same **What's new** button, until you close it; **Settings → Updates** keeps the notes under **What the last update brought**. To install releases without asking, set `OVIS_AUTO_UPDATE=1`.

An update is built and typechecked in a private checkout while the current server keeps serving. The new server must pass a health check, or the previous build comes back. herdr and your agents keep running, and a **Reload app** notice lets you save drafts before the new frontend loads.

After a herdr plugin reinstall, or a `git pull` and a build, in the checkout the app runs from, reloading the page cannot bring the update in: the server keeps running its old code. The page says so on its next status read, in place of the **Reload app** notice, and asks you to restart Ovis on the PC. The notice goes away once it restarts:

```sh
herdr plugin action invoke devswha.ovis.stop    # plugin install
herdr plugin action invoke devswha.ovis.start
herdr plugin action invoke devswha.ovis.stop-windows    # on Windows
herdr plugin action invoke devswha.ovis.start-windows
```

From a checkout, stop `bun run start` and run it again.

Updates need a clean checkout: `main` for a source install, or herdr's plugin checkout. Local changes block an update, and they are never overwritten. More in [app updates](app-updates.md).

### Beta builds

A PC can also take the beta builds made from `main`: each commit whose checks pass is tagged
`beta/vX.Y.Z-beta.N`, where X.Y.Z is the next release. They are off unless you opt in, and a PC that
did not is never offered one. To opt in, write `beta` to the `update-channel` file in the state dir
(`~/.config/ovis/update-channel`, or `OVIS_STATE_DIR`'s), or set `OVIS_UPDATE_CHANNEL=beta`. The
next check, within 5 minutes, offers the newest beta, and it installs like a release. To leave,
remove the file or write `stable`: nothing is downgraded, and the PC waits for the next release.

The desktop app reads the same setting from its own state dir (`server/update-channel` in the app's
data folder) when it starts, and then updates from the beta builds of the app.

### Updating herdr

herdr itself is updated from **Settings → About → Update herdr**. herdr refuses `herdr update` typed into one of its panes ("run `herdr update` outside herdr"), and every terminal in the app is a pane, so the server runs it instead, for the herdr on the PC the app runs on:

- It installs the newest herdr and moves the running panes onto it with a live handoff. Panes and agents keep running, and open terminals reconnect.
- If a newer herdr was already installed from a shell, the running server is still the old one: Settings says so, and the button only moves the panes.
- What herdr printed is shown under the button. A herdr installed with Homebrew, mise or Nix is updated with that tool, and herdr's message names the command.

This is for Linux and macOS. On Windows, and for a remote PC, update herdr on that PC.

## Anonymous usage counts

The app tells its maintainer how many installs there are, which versions they run, which countries the messages come from and which app settings people choose. It sends one message when it is first installed and one each time it runs a new version, plus a daily active message described below. The first time you open the app, a line under the header says so. Tapping its text opens **Settings → About → Anonymous usage counts** with its switch, and **Turn off** on the line turns the counts off in one tap. Nothing is sent before that line has been shown, and the first message waits ten minutes after it, so turning the switch off there stops it. An install that saw an older notice sees the expanded notice (version 5, which adds the day's usage to the daily active message) once more, and sends nothing until then. An existing choice to turn counts off stays off.

A message holds the event (`install` or `update`), a random ID made on this PC, the app's version and the version an update replaced, the OS and CPU architecture, how the app was installed (herdr plugin, `bun run start`, or `bun run server`), the terminal runtime its server serves (`herdr` or `herdr-core`), and an allowlisted `settings` snapshot. The snapshot contains actual choices for appearance, terminal and chat behavior, notifications, language, voice controls, usage-meter display and the file viewer, including defaults. Custom fonts, shortcuts, key-bar layouts, quick replies and the usage meters' account order are represented by customization flags, not their text, key combinations or account names; quick replies and hidden usage accounts also have counts. Account identifiers and the order itself, paths, addresses, credentials, commands, terminal content, conversations and files are not collected.

The daily active message goes out at most once per UTC day on which the app is opened in a browser. It's dated with that day even when it goes out later (for example after the ten-minute wait), and it's sent again the same day only if a new kind of coding agent shows up (with the usage already sent), or, at most once an hour and only when the app is opened, when the day's usage below changed (a day's last usage goes out with the next day's message). The usage is counted only once the version 5 notice has been shown: nothing of it from before then is kept or sent. It holds the event (`active`), the day, the random ID, the app's version, the OS and CPU architecture, how the app was installed, the terminal runtime, `harnesses`: the kinds of coding agents running in herdr panes, taken from a fixed list (such as `claude` or `codex`), with any other agent counted as `other`, and `usage`: the kinds of screen the app was opened on that day (the iOS, Android or Mac app, an installed web app or a browser tab, each on a phone or a computer), how those screens reached this PC (from this PC itself, the local network, Tailscale, Funnel or another proxy), and three counts: prompt answers sent from the app, pane alerts that reached a device, and pane alerts tapped. A count made on a day the app is not opened is never sent. Pane names, pane counts, paths, terminal content, which pane or agent an answer or alert was for, and the time of day are never part of it, and a remote PC's panes aren't included.

The snapshot is the last one a browser reported to this server, not a list of devices or a complete picture of a person. Changing a setting updates that local snapshot but does not send another telemetry event. Before a browser reports, `settings` is `null`. The receiver ([`telemetry/`](../telemetry/README.md)) keeps the event fields, the day and the country the message came from (two letters, such as `KR`, worked out by its host from the connection), and never stores your IP address or anything finer than the country. The random install ID and settings can link events from an installation; they do not guarantee anonymity.

**Settings → About → Anonymous usage counts** shows the next message exactly as it would be sent under **What is sent**, which links back to this section, and its switch turns the counts off for this PC. `OVIS_TELEMETRY=0` or `DO_NOT_TRACK=1` in the server's environment turns them off whatever the switch says, and they are always off in CI. A remote PC's bridge sends nothing.

## Keyboard shortcuts

`Mod` is **⌘** on Apple platforms and **Ctrl** elsewhere. Global app shortcuts add Shift, so the terminal keeps its own Ctrl keys. These are the defaults:

| Shortcut | Action |
| --- | --- |
| `Mod+Shift+K` | Command palette |
| `Mod+Shift+J` | Switch Chat / Terminal |
| `Mod+Shift+E` | Focus the current pane's message box, terminal input line or terminal |
| `Mod+Shift+PageUp` / `PageDown` | Scroll the current pane up / down, retaining one line |
| `Mod+Shift+B` | Toggle sidebar |
| `Mod+Shift+O` | New workspace (`Mod+Shift+N` too, in the installed app: a Chrome tab keeps `Ctrl+Shift+N` for an incognito window) |
| `Mod+Shift+↑` / `↓` | Previous / next pane |
| `Mod+Shift+,` | Settings |

Selecting a pane or opening chat focuses its message box on desktop, while touch screens keep
focus where it was. **Mod+Shift+E** focuses the selected pane's input in any mode, including the
terminal's input line and direct input; it prefers masked input while a secret prompt is open. The
shortcut can be reassigned or disabled in Settings → Shortcuts.

**New tab**, **Rename tab**, **Split pane right** and **Split pane down** have no default key:
pick one in **Settings → Shortcuts**, and the command palette shows it beside the action.

**Settings → Shortcuts** changes each app binding or turns it off: press **Record** on a row,
then the new chord (Escape cancels). A Mod+Shift chord is always safe for the terminal. Other
chords are kept exactly as pressed, such as `⌘+PageUp` or `Ctrl+K`, and need Ctrl, Alt or (on a
Mac) ⌘. Letters, digits, the punctuation keys, arrows, PageUp/PageDown and Home/End can be bound. A
punctuation key is read by where it sits, so on a Hungarian keyboard É is the key US labels `;`, and
the binding works on any layout; the row shows your keyboard's own character where the browser says it. A chord the browser, the OS or text editing keeps (`Mod+W`/`T`/`N`, `⌘+Q`, `Mod+C`/`V`/`X`/`A`/`Z`,
`Ctrl+PageUp`/`PageDown`, macOS `Ctrl+arrows`), an unbindable key or an already-assigned chord is
refused on the row. Plain Ctrl or Alt chords are shells', editors' and agents' keys (`Ctrl+R`,
`Ctrl+A`/`E`, Alt word moves): the row says so and saves one only after **Save anyway**, and from
then on that key no longer reaches the pane. A ⌘ chord the browser commonly uses (such as `⌘+S`,
`⌘+L` or `⌘+⌥+I`) asks the same way. The row's list still picks a Mod+Shift letter, digit,
arrow or PageUp/PageDown without a keyboard; Home, End and the punctuation keys are bound with Record. A search field filters the list. Settings
are saved in this browser, not on the remote PC. The command palette shows the current bindings
and omits disabled ones. Reset shortcuts restores the defaults. Hold-to-dictate
(`Mod+Shift+Space`) remains fixed.

Known browser/OS reservations are marked, but other combinations can also be intercepted by
your browser, OS or extensions. Installed-app mode may behave differently. While an IME is
composing, keys stay with it. In a text field with text, a binding on an arrow, Home or End keeps
its text-selection behavior; from an empty one, such as the chat's empty message box, they switch panes.
List and tab controls also have focus-local keys; those do not become global terminal shortcuts.
On a focused tab, Alt+Shift+Left/Right reorders it and Shift+F10 opens its menu. For the pane menu
on desktop, tab to the pane header's **⋯** (it appears on keyboard focus) and press Enter.
Shift+F10 inside the terminal stays with the terminal program.

**Settings → Shortcuts → Use herdr's prefix keys** (off by default) brings herdr's own prefix
keys to the app. It reads `[keys]` in herdr's `config.toml` on the PC serving the page (read only,
herdr's defaults when there is none): herdr's prefix (`ctrl+b` unless the config sets another; any
of them when `prefix` or `extra_prefixes` lists several), then a key herdr binds runs the same
action here. These actions are taken: `new_tab` (a terminal
tab, at once), `split_vertical` / `split_horizontal`, `zoom`, `previous_tab` / `next_tab`,
`switch_tab` (`1..9`), `rename_tab`, `previous_workspace` / `next_workspace`, `new_workspace`,
`toggle_sidebar`, `settings`, and `help` / `goto` / `workspace_picker` (the command palette).
Bindings resolve as herdr resolves them: one key or a list per action, and a key the config gives any
other action or custom command is no longer the default's. The Settings row lists what it read. Every
other action, a direct (non-prefix) binding and `[[keys.command]]` stay herdr's. The header says when the prefix waits for its key; Escape, a click
or leaving the window cancels it, and a key with no action behind it (the prefix again too) goes to
the pane as typed, so the prefix pressed twice sends it. Text fields, dialogs, menus, IME
composition and the app's own shortcuts keep their keys.

On a phone, use the header, the tab's ⋯ and the More menu for app actions. The command palette
and its plugin actions are not available in the phone touch UI. Use a wider screen or an external
keyboard's `Mod+Shift+K` shortcut (or your configured binding).
The terminal key bar is configured separately under **Settings → Terminal**.
An external keyboard uses the same app bindings as a desktop.

Plain PageUp/PageDown scroll the chat transcript, even while its message box is focused;
the draft, caret, selection and focus stay intact. Modified page keys, composition,
other editable controls and modal input retain their own behavior. Plain terminal page keys
continue to belong to the running program.

Paging shortcuts work while the message box is focused, preserving the draft, caret and selection.
Chat scrolls its transcript immediately; Terminal scrolls herdr's shared history, so other
clients see the same terminal position. When herdr explicitly reports zero native history,
the shortcut instead sends plain PageUp/PageDown to the running application through its live
input lease. That application owns its page length.
Unavailable or invalid history data never causes application input, and no key is queued
while disconnected.
One line stays visible between pages. Chat uses the displayed text's line height, and Terminal
uses native rows. A page still advances by at least one pixel in chat or one terminal row.
For an iPad with an external keyboard that lacks PageUp/PageDown, assign letters such as
U and D to **Scroll pane up** and **Scroll pane down** in Settings → Shortcuts (Mod+Shift+U/D,
or record a chord such as `⌘+U`). This lets you read history without leaving the message box or reaching for
the screen. Shift+PageUp/PageDown alone retains the focused control's own behavior.

On a desktop, Enter sends and Shift+Enter adds a line. On a touch screen, Return adds a line and the Send button sends the message, unless you turn off Settings → Chat → Composer → Return inserts a new line, which makes Return send. While the agent works, Ctrl+Enter sends the message now, as the queued row's ↑ Send now would, the same key Claude Code uses for this in its own input. On a desktop, turning off Enter sends switches sending to Mod+Enter. On a touch screen with a hardware keyboard, Mod+Enter sends while Return inserts a new line is on. This choice is saved per device.

## How it works

```mermaid
flowchart LR
  subgraph devices [Your devices]
    B[Browser / phone app]
  end
  subgraph pc [This PC]
    S[Ovis<br/>Bun server]
    H[(herdr server)]
    A[Agents in herdr panes<br/>Claude Code, Codex, …]
    T[(Agent session files)]
  end
  subgraph remote [Other PCs]
    R[Private bridge + herdr]
  end
  B <-- HTTP / WebSocket --> S
  S <-- socket API and terminal attach --> H
  H --- A
  A -. writes .-> T
  S -. reads .-> T
  S <-- SSH forward --> R
```

A React client talks to a Bun HTTP/WebSocket server.

- **Status:** the server reads workspaces and agent status from herdr's Unix socket.
- **Terminal:** it streams the real `herdr terminal attach` output through a PTY host: the Rust one (`crates/pty-sidecar`) on Linux and macOS, or the Node sidecar where that cannot run (`OVIS_PTY_SIDECAR=node` asks for it). Browsers watching one pane share one attach, with a bounded replay and backpressure ([terminal flow control](terminal-flow-control.md)).
- **Chat:** it reads the agents' own session files, and sending types into the same live pane.
- **Relay (optional):** while it's on, the server also keeps a WebSocket open to the [Ovis relay](relay.md), and a paired phone's requests come in through it, end-to-end encrypted, to the same handlers as a browser's.

herdr owns the processes and the scrollback.

With `OVIS_RUNTIME=herdr-core`, the server answers herdr's socket API itself from herdr-core
(`server/herdr-core/`), through one `hc connect`, and streams the live terminals over that same
connection.

## FAQ

<details>
<summary><b>Does it replace herdr's own TUI?</b></summary>

No. Both attach to the same terminals at the same time. Use the TUI at your desk and the web app anywhere else. Nothing needs to be stopped or handed over.
</details>

<details>
<summary><b>Do I need Tailscale?</b></summary>

No, but a phone needs two things Tailscale gives at once: a way to reach the PC from outside your network, and HTTPS, which installing the app and push alerts both require. Without it:

- **The Ovis relay**, built in and off by default: turn it on under **Settings → Phone & devices** and scan its QR code. The phone needs nothing else, and what passes through the relay is end-to-end encrypted ([Through the Ovis relay](#through-the-ovis-relay)).
- **An SSH tunnel from the phone** (Termux, Blink): `ssh -L 7317:127.0.0.1:7317 <pc>`, then open `http://localhost:7317` on the phone. Browsers treat localhost as secure, so installing and alerts should work while the tunnel is up (not verified on iOS yet). The phone still has to reach the PC over SSH.
- **A VPN into your home** (WireGuard, ZeroTier, a router VPN): the LAN address works in the browser, but a plain `http://` address can neither install the app nor receive alerts.
- **A reverse proxy with a real certificate** on a domain you own, with a token set and the proxy sending `X-Forwarded-For`: [Behind a reverse proxy](#behind-a-reverse-proxy) has Caddy, nginx and Cloudflare Tunnel examples to copy. This exposes the server to the internet, so read [Access and safety](#access-and-safety) first.
- **A public address with Portal**, a tunnel with no account and no domain of your own, with a long random token set: [Behind a reverse proxy](#behind-a-reverse-proxy) has the command, and **Settings → Phone & devices → Portal** runs it for you. This exposes the server to the internet too.
</details>

<details>
<summary><b>Does my code or conversation leave my machine?</b></summary>

Session files stay on the PC running each agent, and their contents are sent to browsers connected to the app. Signing in to the account service is optional (see [Through an account](#through-an-account)), and the relay is off unless you turn it on. The agents' own connections to model providers depend on their configuration.

Optional features can send data off the PC:
- [Voice input](#voice-input) sends recordings to the configured transcription provider; polishing also sends the transcribed text. Without a configured API key, browser speech recognition may use the browser vendor's service.
- [Subscription usage](#subscription-usage), when enabled, sends each provider's credentials to that provider's usage endpoint.
- Updates and remote-PC setup fetch releases or configured runtime bundles over the network; remote panes are reached over SSH.
- Enabled push alerts go through the browser vendor's push service as encrypted notifications.
- A destination under **Settings → Alerts → Also send to** gets each alert it chose in plain text: the PC's and the pane's names (a pane's is its terminal title, which an agent may take from your task), what happened and a link to the pane.
- [Portal](#behind-a-reverse-proxy), while it runs, carries every connection to the app through the relay you chose: the relay sees connection addresses, timing and volume, and holds the certificate for the address.
- The [Ovis relay](#through-the-ovis-relay), while it's on, carries everything between a paired phone and this PC through `relay.ovis.sh`, end-to-end encrypted: the relay sees connection addresses, timing and sizes, down to the timing of keystrokes, but none of the content. The app on the phone comes from `app.ovis.sh`, which itself sees only requests for the app's files, whose path names the PC. You have to trust whoever serves that app, since it's the code that holds the phone's key and shows you the PC ([trust model](relay.md#trust-model)).

See [Access and safety](#access-and-safety) for who can connect to the app.
</details>

<details>
<summary><b>An agent is missing from the chat, or shows only terminal text.</b></summary>

The chat needs the agent's own session file. Check that the agent runs in a herdr pane on this PC (or on an added PC) and has already written its first message. Agents without a native reader always get the terminal-text view, and the Terminal view always works.
</details>

<details>
<summary><b>The colors look too dark, or the light theme looks dark, in Samsung Internet.</b></summary>

Samsung Internet has a forced dark mode that repaints every page, including one that brings its own light and dark themes, as this app does. A light theme comes out dark, and a dark one is darkened a second time: similar shades run together, and the bars of the plan meters can look empty. Turn off **Force dark mode for web content** (**웹 콘텐츠에 어두운 화면 모드 강제 적용**) in Samsung Internet's settings, or open the app in Chrome. Reported on a Galaxy Tab S7+ ([#451](https://github.com/devswha/ovis/issues/451)).
</details>

<details>
<summary><b>How is this different from collie, roamgate or herdr-remote?</b></summary>

All three are in the herdr plugin marketplace too, and each does something this app does not. [collie](https://github.com/AltanS/collie) is a mobile terminal for herdr, tmux and zellij, with a status dashboard, a key pad, quick replies and voice input, served over Tailscale by its own bridge. [roamgate](https://github.com/powerfooI/roamgate) is a browser client for herdr with a file explorer and diff annotations, installed by its own script. [herdr-remote](https://github.com/dcolinmorgan/herdr-remote) is a macOS menu-bar app with a phone dashboard and a Telegram bot behind a relay and a free tunnel.

Ovis reads the agent's own transcript, so Claude Code, Codex, omp, omo, gjc, pi, OpenCode and identifiable Devin CLI panes are a chat with the work folded per turn. Supported prompt cards are checked against the live menu before an answer is typed; Devin prompts use Terminal. The terminal is the same live pane as your TUI, other PCs join over SSH from the sidebar, and it installs and updates as a herdr plugin, with no account of its own. You reach it over Tailscale, SSH, your own HTTPS proxy, or the Ovis relay, which is end-to-end encrypted and off until you turn it on. If you want tmux or zellij, diffs or to answer agents from Telegram, one of the others is the better fit.
</details>

<details>
<summary><b>How is this different from Happy, Paseo or CloudCLI UI?</b></summary>

Those projects start and manage agents through their own wrapper, daemon or server, and bring their own apps. Ovis adds nothing between you and the agent. It is a window onto the herdr sessions you already run, so the same pane is live in your terminal, your browser and your phone at once. If you don't use herdr, one of those is the better fit.
</details>
