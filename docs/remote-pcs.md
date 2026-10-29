# Remote PCs over SSH

Use **Add PC** in Settings → Remote PCs (the command palette has it too) to connect a Linux or macOS computer (x64 or arm64) or a Windows PC (x64) running OpenSSH Server. Enter an SSH alias or `user@hostname`; the name defaults to that address. Advanced settings accept a port, a key path on the **web server**, and a named herdr session. Each registration selects one herdr socket. The sidebar groups PC → workspace → pane, and the header and new-session dialog show the destination PC. **Settings → Remote PCs → Show in sidebar** keeps a PC out of this device's sidebar, Agents list and command palette; it stays connected, and links and alerts still open its panes.

**Machines already saved in herdr appear automatically.** The connection server reads its account's
`herdr machine list --json` at startup and every five seconds after the previous read finishes. Failed reads back off up to five minutes and
log only a changed failure; a successful read resets the delay. It
preserves SSH aliases, explicit URI ports and named sessions (normalizing herdr’s `default` to
the unnamed socket), follows renames and enabled state,
and removes inherited rows when their profiles disappear. A failed catalog read keeps the previous
roster. Exact destinations/sessions already added manually keep their existing web UI registration.

Discovery only reads the local catalog; it does not open SSH connections. Choose **Connect** on
an inherited PC to use the saved address and session. A successful connection remembers permission
to reconnect to that exact destination, explicit port and session. Installation, key registration
and bridge startup still show a separate approval step. Connecting to an already running bridge
does not grant permission to start or update it later. After approving bridge setup, the web UI can
restart that bridge after a reboot and honor the automatic bridge-update setting. A changed
destination, port or session clears both permissions, cached panes and the generated local SSH key;
the new target needs **Connect** again. Rename, disable and remove
inherited PCs in herdr. These rows are derived from herdr rather than copied into `machines.json`;
their stable IDs preserve browser selections and drafts across web UI restarts. Only web-owned
connection permission, setup approval and cached snapshots are stored separately in `herdr-profile-state.json`, written
atomically with mode `0600`. Removing a source profile clears that state and its generated local
key; the remote authorized public-key entry is left for explicit cleanup. Previously configured
inherited PCs without this state need one successful explicit setup to record approval. Unsupported SSH
addresses/sessions appear with an error and do not connect.

The connection server uses its own operating-system account’s OpenSSH configuration and ssh-agent (on Windows, when Git for Windows' OpenSSH runs, only an agent named by `SSH_AUTH_SOCK` in the server's environment; see below). The browser never opens SSH itself. Existing keys are tried first; unknown host fingerprints and password/key-passphrase prompts appear in the setup dialog. Secret entry requires HTTPS or localhost. Verify a new fingerprint against the target PC. A changed host key fails closed; correcting trust is a deliberate administrator action, not an automatic reset.

After inspection, **Install and connect** lists the proposed changes. The installer uses a private runtime bundle containing Bun, Node and native node-pty, plus a pinned herdr fallback. It uses an existing herdr where available, starts a daemon only when its socket is absent, and never stops/replaces a running herdr daemon. Agent CLI installation and login remain the remote account’s responsibility. Cancelling a setup closes its SSH processes; already-created remote work is preserved.

Password or encrypted-key authentication also offers registration of an app-specific ed25519 key for unattended reconnection. The private key stays on the connection server under `<stateDir>/ssh/<machine-id>`, mode `0600`; only its public key is appended to the remote account’s `authorized_keys`. The original SSH keys/configuration are preserved. One-time secrets pass in memory through a private askpass socket (a Unix socket, or a named pipe on Windows) that answers only a helper presenting its connection's random token; they are not stored in jobs or configuration files.

### A Windows connection server

The web UI can itself run on Windows x64 and connect to other PCs with Git for Windows' OpenSSH (`<Git>\usr\bin\ssh.exe`, with its `sftp` and `ssh-keygen`), which installing Ovis on Windows already requires. Git is looked for only where its installer puts it, never through `PATH` (the ssh runs with the account's keys, and a folder on `PATH` may be writable by anybody): the folder Git for Windows recorded in `HKLM\SOFTWARE\GitForWindows`, then `%ProgramFiles%\Git`, `%ProgramFiles(x86)%\Git`, `%LOCALAPPDATA%\Programs\Git` and a Scoop Git in the account's profile. The OpenSSH that ships with Windows (`C:\Windows\System32\OpenSSH\ssh.exe`) is not used: started by the server, which has no console, it never exits once a remote command printed anything, so connecting hung until its timeout. `OVIS_SSH` names another `ssh` (the `sftp` and `ssh-keygen` beside it are used too), and without Git the `ssh` on `PATH` runs. Windows' OpenSSH has no connection sharing (`ControlMaster` fails with `getsockname failed: Not a socket`), so each remote command, upload and port forward is its own `ssh` or `sftp` process instead of a channel of one master, and a long-lived `ssh -N` stands in for the master's liveness; a `ControlMaster` or `ControlPath` in the account's SSH config is switched off for these connections. Each process authenticates again; measured from a Windows PC, about 0.2–0.8 s each, which adds seconds to a setup or reconnect but nothing once the forward stands.

- **Keys:** a key loaded into an ssh-agent (`ssh-add`) signs every one of those processes, so nothing is asked. Git's `ssh` reads only the agent named by `SSH_AUTH_SOCK` in the server's own environment, not Windows' `ssh-agent` service that Windows' `ssh-add` loads. A key held only there is not offered: setup asks for the password, or for the passphrase of a key file in `~/.ssh`, and the app key it registers makes later reconnects unattended. A refused connection says so in its error, with what to use instead. When the agent cannot sign, the setup dialog asks for the passphrase or password; the answer is kept in memory for that one connection and answered to the same prompt again, never written, and dropped when the connection closes. An answer that did not authenticate is never replayed, and a prompt that first appears after connecting fails instead of asking. The app key registered after such a sign-in makes later reconnects unattended. Keyboard-interactive authentication is switched off: its prompts are the server's own text, and ssh passes a prompt to the `.cmd` helper on a command line that cmd parses. A host that takes a password only that way (some PAM or one-time-code setups) needs a key that signs without a prompt instead: one without a passphrase, or one in an agent named by `SSH_AUTH_SOCK`.
- **Host keys:** the askpass helper is a `.cmd` file, and cmd hands it only the first line of a prompt, so OpenSSH's own fingerprint question never reaches the dialog whole. An unknown host is instead read by a connection that offers no authentication (`PreferredAuthentications=none`); its fingerprint is shown in the dialog, and only a **Trust fingerprint** adds the key to `<stateDir>/known_hosts`. Every authenticating connection checks strictly against it. A changed key still fails closed.
- **Forwards:** each bridge forward is an `ssh -N -L 127.0.0.1:<port>:127.0.0.1:<bridge port>`. `ClearAllForwardings` would drop that `-L` too, so a host whose SSH config adds `LocalForward`, `RemoteForward` or `DynamicForward` is refused with that reason rather than opening them; use an alias without them. A forward that ends counts as the connection ending, and the PC reconnects.

### Windows PCs

Setup first asks the PC in `sh`; one that cannot run it (cmd or PowerShell as the OpenSSH default shell, whichever) is asked again in PowerShell, as a base64 `-EncodedCommand` that both shells pass through untouched. The bundle for `win32-x64` carries Bun only, under `%LOCALAPPDATA%\herdr-web-ui\remote-v<N>` (a junction to a checksum-named release directory). herdr is not bundled: an installed one is used (`%LOCALAPPDATA%\Programs\Herdr\bin\herdr.exe`, the stable alias its installer keeps), and otherwise setup runs herdr's own `install.cmd` from herdr.dev, which the approval list names. The bundle goes over by sftp, since PowerShell owns a redirected stdin. Registrations live in `%USERPROFILE%\.config\herdr-web-ui\bridges\`; the bridge is started through WMI (`Win32_Process.Create`), outside the SSH session's job. A missing herdr daemon is started in the same account's signed-in Windows session through a temporary, ordinary-privilege task; the task is removed after launch and herdr survives bridge updates and SSH disconnects. The app key goes to `%ProgramData%\ssh\administrators_authorized_keys` for an administrator account (what Windows OpenSSH reads for one) and to `.ssh\authorized_keys` otherwise. herdr's socket there is a named pipe; the `herdr.sock` file is a `pid:start` marker.

herdr has no `terminal attach` on Windows yet ([herdrdev/herdr#4821](https://github.com/herdrdev/herdr/issues/4821)), so a Windows PC reports `terminal_attach: false` and `terminal_mirror: true`. The chat lens works as on any PC (transcripts, status, prompts, files and input). The terminal lens is a stopgap: the bridge reads the pane's visible screen a few times a second (`pane.read`, ansi) and repaints it in the browser, so output and colours show and typing works, sent through `pane.send_text`. What a repaint cannot give: the cursor is not shown, output that comes and goes between two reads is not seen, and the grid is the pane's own size on that PC (`pane-geometry` with `fixed: true`), never the browser's. A phone narrower than that grid draws it folded to its width; the pane menu's Original width draws it as it is, panned sideways, and Wrap to screen folds it on a desktop too. The real terminal does not turn on by itself: it also needs the PTY sidecar (Node and `@lydell/node-pty`), which the `win32-x64` bundle does not ship, so a bridge without it keeps mirroring whatever herdr reports. It takes over once herdr attaches on Windows and a bundle ships the sidecar. WSL gives a Linux herdr, not the native Windows session.

### Windows sign-in and headless startup

After a reboot, an approved Windows PC keeps reconnecting until the SSH account signs in to Windows.
A locked desktop still counts as signed in. Ovis starts herdr only for a pending connection; it adds
no permanent logon task, stores no Windows password and does not request administrator privileges.
Signing out of Windows ends a desktop-started herdr, its panes and the agents running in them.
Lock the PC instead to keep that work running. SSH disconnects and bridge updates do not end it.

If the PC must run without a desktop login, choose **Review startup options** and then
**Start without Windows sign-in**. The warning applies to that one start: Codex commands that need
its private-desktop sandbox can fail in this headless Windows session, and desktop-control tools may
be unavailable. Ovis does not disable an agent's sandbox. A later cold start waits for sign-in again.
If Windows Task Scheduler cannot start herdr, **Windows desktop startup failed** shows its error
and offers the same one-time headless choice through **Review startup options**. Background retries
stop for that failure; signing in alone does not fix it.

An existing herdr server is always reused. Signing in later does not move an already-running
headless server into the desktop session, and Ovis never restarts it or its panes automatically.
An initial connection can be cancelled while waiting; already-started work stays running.
## Runtime and endpoints

```
Browser → connection server → OpenSSH local forward → remote loopback bridge → herdr Unix socket
```

The bridge reuses this backend, so conversations, file searches, directory validation and pasted images run on the selected PC. Only a loopback bridge port is opened on that PC. OpenSSH forwards it over the authenticated connection; see [ssh(1)](https://man.openbsd.org/ssh.1) and [ssh_config(5)](https://man.openbsd.org/ssh_config.5).

The current server keeps one status-only WebSocket per remote PC without attaching to a terminal. SSE carries the combined roster and status events to the browser. Selected terminals use a separate WebSocket bound to one machine for its entire lifetime. Roles and output ACKs pass through unchanged: the browser acknowledges only after xterm parses output. The relay also enforces a 1 MiB transport budget and a 2-second stalled-consumer close (`4008`).

| Route | Contract |
|---|---|
| `GET /api/health?scope=bridge` | App/auth liveness independent of local herdr |
| `GET /api/bridge` | Authenticated protocol, runtime version, PID and socket identity |
| `GET /api/machines` | PC state plus cached snapshots; each snapshot keeps its server's `order_epoch`/`read_seq`, and `source_boot_id` is the boot id the manager last proved for that PC (its own for the local PC) |
| `GET /api/machines?verify_source_boot=:id` | The roster plus `verified_source_boot: { machine_id, boot_id }`, the boot id of the server behind that PC asked for during this request (a remote one by the manager's authenticated `GET /api/health` over its connection, never a cached answer). 400 for an empty or repeated query, 404 for an unknown PC, 503 `source_unverified` when no fresh proof came, and 503 with `Retry-After: 1` when that PC's last health call started under a second ago: the browser asks again at its next poll, reconnect or roster from another server lifetime. The manager runs at most one such call per PC and starts them at least 1000 ms apart; that bound, not the browser's coalescing or the 15 s deadline, is what limits the load on a remote PC. It adds no access beyond the authenticated reads the proxy already makes |
| `GET /api/machines/events` | SSE roster and machine-scoped status events |
| `POST /api/machines/setup` | Create an interactive setup job |
| `GET/POST/DELETE /api/machines/setup/:id` | Inspect, answer/approve, cancel |
| `PATCH /api/machines/:id` | Rename or change `enabled` |
| `DELETE /api/machines/:id` | Forget the PC and remove its local private key |
| `/api/machines/:id/{session,agents,pane/*,workspace/*}` | Allowlisted target API routes |
| `/ws?machine_id=…` | Immutable terminal destination |

Legacy HTTP paths, `/ws` without a machine, and old stored preferences/notification links mean **local**. Machine mutations require `X-Herdr-Machine: 1`, the existing token gate and same-origin browser requests. The proxy passes a bridge credential read through SSH; browser cookies, bearer tokens, forwarded headers and remote cookies are not forwarded. Authentication, push devices, VAPID keys and app updates belong to the current connection server.

Remote credentials are registered in `~/.config/herdr-web-ui/bridges/` on that PC (mode `0600`). A compatible bridge for the same socket is reused, including a normally started server from this version. A server started with `HOST` set to an IP address other than `127.0.0.1` or a wildcard also opens a relay on `127.0.0.1` and registers that port, since the forward only ever reaches the PC's loopback. A host name in `HOST` gets no relay, since it could resolve to another machine by the next connection; adding that PC says to set `HOST=127.0.0.1`. Independently managed bridges are never stopped by remote setup. Older unregistered bridges can still hold an exclusive terminal attach; release their browser attachment or restart them with registration support. Automatic attaches and reconnects never use `--takeover`. With a bridge that advertises support,
**Open here** on a pane's waiting notice explicitly takes its terminal. The displaced web bridge
waits; a standalone `herdr terminal attach` exits. The herdr TUI stays connected (verified on
herdr 0.9.3). Older bridge bundles keep waiting until updated, and observe connections cannot take a pane.

## Disconnects and updates

**Update bridge** also reuses a bridge whose live identity verifies as current; it does not
download, install or restart the same version again.

**Multiple apps connecting to one PC.** Keep those apps on the same version, or run one app on a
PC that stays on and add the others to it as remote PCs
([One always-on PC for all your PCs](guide.md#one-always-on-pc-for-all-your-pcs)). An older app
with this protection refuses to downgrade a newer bridge and asks you to update the app itself.
Apps from before this version can still replace a newer bridge. If another app
starts an incompatible bridge during an update, setup reports a **Bridge connection conflict**
instead of offering an automatic update loop. Update or disconnect the other app before retrying.
The update path never takes over a terminal or stops herdr sessions.

PC registrations and last snapshots persist in `<stateDir>/machines.json`; `OVIS_STATE_DIR` chooses the state directory. A disconnected PC retains its last roster with controls disabled. Retries back off from 1 second to 60 seconds. Other PCs keep working. Reconnection never changes a non-empty selection or sends held input. Composer drafts, held messages, terminal drafts, lenses, recent panes and notification identities include both machine and pane. Held messages have an explicit **Send now** action.

`machines.json` and `herdr-profile-state.json` are replaced durably (a private temporary file,
flushed, then renamed), and only when what they hold changed. If a crash still leaves one that is
not JSON (an unclean shutdown can leave it all NUL bytes), the app does not refuse to start: it
moves that file aside, bytes untouched and mode `0600`, to `<name>.corrupt-<time>` in the same
folder, logs why, and starts without what it held. Every copy keeps its own name, so a later one
never replaces an earlier one; delete them once you no longer need them. Until the next restart,
**Settings > Remote PCs** names the copies: after `machines.json`, add the missing PCs again; after
`herdr-profile-state.json`, choose **Connect** again on the PCs saved in herdr. A file that is JSON
of another shape (perhaps from a newer version) still stops the start and is left as it is.

A PC set up at another SSH address (destination, port or session) in its dialog moves there only once
that setup connects. Until then, and after a setup there that is cancelled or fails, the PC keeps the
address it had: `machines.json`, its reconnects and its updates that ask nobody use only that one, and
it tries it again. Its card keeps its own panes, herdr version and update offer; what the setup finds
at the new address is shown in its dialog only. Nothing of this app's is installed or started at the
new address unless that setup's own approval allowed it.

SSH commands ignore configured `LocalForward`, `RemoteForward` and `DynamicForward`
tunnels. The app adds only its own loopback forward through the existing control socket, without
rereading host config for that forwarding request. A Windows connection server has no control
socket and refuses such a host instead ([above](#a-windows-connection-server)).

**Disconnect** closes that PC’s observer, forwards and terminal attachments, preserving remote processes. **Remove PC** additionally forgets its local registration/key; the public key line on the remote account remains visible for manual removal (`ovis:<machine-id>`). No unrelated authorized keys are removed.

**Updating a bridge.** A bridge from another bundle version is refused, and the PC waits instead of retrying. With **Settings → Remote PCs → Update PC bridges automatically** on (the default), the connection server then updates it in the background: installing the app update was the approval, and SSH uses the PC's saved key only (`BatchMode`). A PC that needs a password or passphrase fails with the reason and waits; its **Sign in and update…** button opens the dialog. An update that cannot reach the PC (switched off, asleep, off the network, or gone in the middle) says nothing about its bridge: the PC shows **Reconnecting…** and keeps retrying, and the version check, with its update, runs again once the PC answers. An explicitly cancelled update (**Cancel update**, or closing a dialog that still needs an answer) also sends the PC back to reconnecting; if the bridge is still out of date when the PC answers, it shows the **Update bridge** button and does not start the cancelled update again by itself until the PC has connected. Reaching the setup's time limit instead reports a timeout and resumes reconnection without suppressing automatic bridge updates. With the setting off, the PC's **Update bridge** button starts the same background update, and the tap is the approval. A first install still asks for approval in the dialog.

The dialog offers the update itself: a connect or reconnect that is refused on the version check turns its **Retry connection** into **Update bridge and connect**, which re-runs the setup with the bridge update included — through the same approval list a first install shows, so a PC that was never registered (and has no sidebar row) can be updated and connected in one go.

The update runs on the server, not in a dialog: closing the dialog after approval, or never opening one, does not stop it, and **Cancel update** does. The sidebar and the header show the step (download, upload to the PC, verify and install, restart), the bytes, and roughly how long is left. The connection server keeps the verified bundle under `<stateDir>/bundles/<sha256>.tgz` (the newest four), downloads each checksum once even for PCs updating together, and streams the file to the PC instead of holding it in memory.

A verified runtime is installed into a checksum-addressed directory before the selected managed bridge is restarted. Existing runtime directories remain available to other running bridges. The updater authenticates the old bridge and checks its socket, managed ownership and PID before stopping it. An approved replacement may have a different bridge protocol, but the new bridge must match the current protocol and bundle version before connecting; herdr itself is left running. A separately managed server must use its own update controls. The connection server's own app update (Settings → Updates) is separate from these bridge updates.

An independently managed server is detected before downloading or installing a remote bundle, and
nothing of this app's is ever installed over it or restarted in its place. When it is older than
this app, the connection server asks it through the SSH tunnel how it updates (its own
`GET /api/updates`, with the token its bridge descriptor holds; the answer to that token also says
the port it listens on and the HTTPS address Tailscale serves it at, for the card's address and
link). If it updates itself (a managed
install, not blocked, with a newer release on offer that it installs by revision), the PC's card
offers **Update this PC's Ovis to vX**, and with **Update PC bridges automatically** on it runs
unasked. That update asks the server to install the exact release its own updater offers
(`POST /api/updates/install`; a check for releases running there is waited out first, and no
redirect is followed), shows its steps, waits up to 15 minutes for the new version's bridge to
register, and then reconnects. An install that has not started within a minute fails with that
reason. An update that fails is offered again, and the PC's card and the line under the header say
that it failed, the card with why. One that ends on another version than this app's keeps where that
server answers, with why it cannot be updated from here. A server older than this change takes
these requests only as its own PC's: when it listens on that PC's loopback and has no `OVIS_TOKEN`.
A server that cannot update itself (not started by
its updater, a changed source checkout, an `OVIS_TOKEN` or paired-device gate this app cannot pass,
a supervisor too old to install by revision, no newer release) keeps the message to update it through its own Settings, with the reason and where it
answers: the HTTPS address it says Tailscale serves it at, or else its host and port to copy and open
on that PC or through its own tailnet address. A server newer than this app is told to the user as
an app update to install here, and it is not asked about its updates.

While such a server is away (it restarts, updates itself, crashed, or its PC rebooted; a server that
stops removes its bridge descriptor), the PC shows **Reconnecting…** with that reason and keeps
retrying, as a PC that cannot be reached does, and reconnects once that server registers again. The
connection server remembers, for the SSH address (destination, port and session) it learned it at,
that a PC runs its own server, and while that server is away neither a reconnect nor an update that
asks nobody installs or starts this app's bridge in its place; only a setup reviewed in its dialog
may. A PC set up at another address in its dialog is not told by what the old one ran. An own
update that ends on a version newer than this app's is told as an update of this app, as for any
newer server. A remembered server that never comes
back (a PC whose own Ovis was removed) is set up the same way, through **Reconnect / setup**.

On Windows, extraction always uses `%SystemRoot%\System32\tar.exe`, so Git
or MSYS tools earlier on PATH cannot reinterpret the archive's drive-letter path.

## Building and distributing runtimes

`bun run build:remote` builds for the host OS and CPU after `bun run build`. Linux and macOS bundles use checksum-pinned Node 22.23.2. Linux bundles copy the installed Bun, so they must be built on the target OS/CPU. macOS bundles use checksum-pinned Bun 1.4.2 plus that platform's prebuilt PTY package (`@lydell/node-pty-<platform>`, fetched checksum-pinned from the npm registry when it is not the host's); they can also be assembled on Linux. The Windows bundle (`win32-x64`) is checksum-pinned Bun 1.4.2 alone, with no Node, PTY package or herdr, and is assembled on any OS:

```sh
bun run build:remote darwin-arm64  # Apple Silicon
bun run build:remote win32-x64     # Windows
bun run build:remote darwin-x64    # Intel Mac
```

The builder verifies herdr 0.9.3, all downloaded runtime checksums, macOS executable architectures and PTY helper permissions. Native builds run an actual PTY smoke test. Cross-platform assembly records `native_smoke_tested: false`; the destination runs bundled Bun/herdr and a Node PTY smoke test **before activating** the installed runtime. macOS runtime execution still needs native CI or a real Mac to verify it. No build tools are required on the remote PC.

The connection server first honors an explicit `OVIS_BUNDLE_MANIFEST`, then automatically uses `remote-bundles/manifest-<target OS>-<target CPU>.json` beside the server checkout, and otherwise downloads the versioned release. Local discovery follows the **remote** architecture, independently of the server OS and launch directory. Invalid local/configured manifests fail closed; they do not fall back to a different runtime.

`.github/workflows/remote-bundles.yml` builds and smoke-tests Linux/macOS × x64/arm64 and Windows x64 (assembled on Linux, started on a Windows runner against herdr's own installer), plus a real SSH password-authentication job on Linux. `scripts/windows-host-qa.ts` runs the whole Add PC flow against a real Windows PC (`WINDOWS_QA_HOST`, `WINDOWS_QA_PASSWORD`). Dispatching the workflow produces artifacts; pushing a `remote-vN` tag, where N is `REMOTE_BUNDLE_VERSION` in `shared/machines.ts`, publishes all five archives and the combined `manifest.json` after the checks pass. Raising `REMOTE_BUNDLE_VERSION` makes every connected PC's bridge incompatible until it is updated (**Update bridge…**), so publish the `remote-vN` release before the app release that carries the new number. Locally built bundles and manifests under `remote-bundles/` must be rebuilt too, since an older manifest there fails closed.

The default manifest is `https://github.com/devswha/ovis/releases/download/remote-v<REMOTE_BUNDLE_VERSION>/manifest.json`, with the version from `shared/machines.ts`. Version and SHA-256 checks run on the connection server and SHA-256 is checked again on the remote PC before extraction. Each runtime contains its own version metadata. A malformed/incompatible manifest stops installation before a running bridge is stopped.

## Verification

- `bun test`, `bun run typecheck`, `bun run build`: contracts and existing behavior.
- `bun run build:remote && bun scripts/remote-bundle-smoke.ts`: packaged startup, private daemon/socket, authenticated handshake.
- `bun run test:ssh`: actual isolated sshd, fingerprint approval, encrypted-key askpass, app-key registration, first install, two independent herdr daemons with equal pane IDs, HTTP/WS routing, roles, ACK overload, reconnect/restart, cancellation, failed installation, explicit bridge update and host-key-change rejection. Tests write only to their own panes.
- `SSH_TEST_PASSWORD=1 bun run test:ssh`: the same flow with an ephemeral system account and real password login; requires noninteractive sudo, as configured in CI.
- `SSH_TEST_KEEP=1 bun run test:ssh`: keeps the fixture until SIGTERM and prints its JSON path. `bun scripts/machines-browser-qa.ts <fixture.json>` checks PC switching, late real upload responses, drafts/held input, destination labels, and desktop/mobile screenshots under `evidence/machines/`.
- `bun scripts/ssh-password-docker.ts`: real password login to a disposable Debian PC with no Bun/Node/build tools, followed by bundled herdr startup and app-key reconnection; requires Docker and changes no host accounts.
- `bun run test:ui`: existing composer/session/mobile browser regressions.

macOS Codex discovery uses `lsof` for open rollout files instead of `/proc`; canonical-store validation and the unambiguous transcript matching rules are unchanged. Platform jobs must run on their corresponding runners before all-platform release readiness can be claimed. The Docker password test can run locally without sudo; macOS/arm64 binaries still require their corresponding runners.

### Saved-machine SSH lifecycle fixture

The saved-machine desktop/phone regression runs in the regular browser CI lane. To run it
alone, use `bun run check run --build bun scripts/herdr-profiles-browser-qa.ts` with
`CHROME_PATH` pointing to an installed Chromium. Set `EVIDENCE_DIR` to save roster and
installation-approval screenshots for both viewports.

Build `docker build -t herdr-profile-ssh-qa scripts/fixtures/herdr-ssh`, then run
`HERDR_SSH_QA_BUNDLE=/path/to/verified/linux-bundle.tgz bun scripts/herdr-profiles-ssh-qa.ts`.
The Docker host and bundle architecture must match. The fixture uses a temporary container,
a loopback-only SSH port, disposable password/key credentials and temporary manager state.
It exercises discovery without SSH, connection consent, installation approval, reuse of an existing default Herdr session,
terminal attach/input/resize, manager and bridge restart, source disable/re-enable, named-session
retargeting and removal cleanup. It never changes the user's SSH config or Herdr catalog.
