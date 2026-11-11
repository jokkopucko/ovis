# Remote PCs over SSH

Use **Settings → Devices and PCs → Add a connection → SSH** (the command palette has **Add PC** too) to connect a Linux or macOS computer (x64 or arm64) or a Windows PC (x64) running OpenSSH Server. Enter an SSH alias or `user@hostname`; the name defaults to that address. Advanced settings accept a port, a key path on the **web server**, and a named herdr session. Each registration selects one herdr socket. The sidebar groups PC → workspace → pane, and the header and new-session dialog show the destination PC. **Settings → Remote PCs → Show in sidebar** keeps a PC out of this device's sidebar, Agents list and command palette; it stays connected, and links and alerts still open its panes. The sidebar's PCs head counts the PCs hidden there; its menu shows each one again.

The **SSH** tab lists the PCs it can find, each with **Add**, which opens the setup dialog with that address filled in: the PCs saved in herdr that wait for **Connect**, the hosts of the connection server's own ssh config (`~/.ssh/config` and the files its `Include` lines name, a wildcard `Include`'s folders listed through their open handle on Linux with glibc, what they match opened through it too, and by path elsewhere, where a listing gives names only (a folder swapped after its check can redirect it, so a name from outside home can be listed and a file can be missed): any host those files name or set an option for, and any host after that `Include`, is listed but never claims a Tailscale PC; on Linux the folders are read synchronously, so a home on a stalled network mount can freeze the server while the list is built; hosts named only by a pattern and everything under `Match` are left out), and the other online, untagged PCs of its own Tailscale login, by their MagicDNS name. The list stops at 200 rows, and each Tailscale PC it lists keeps its row within them (the first 32 of the login, as for the other Tailscale lists): config hosts fill only the rows left. A Tailscale PC is reached over SSH like any other address, never through the relay, and a PC a config host already names (by alias or HostName) is listed once. A PC already added shows **Added**. Below the list, type any other SSH address. The list is read from `GET /api/machines/ssh-candidates`, which reads both sources and connects to nothing; a watching device, an open LAN window, a Portal visitor and a device on the relay are refused (`read_only`, `owner_only`), and then see only the field; a window refused as `owner_only` that shows the tab (an open LAN window; the relay shell and a Portal visitor show no SSH tab) is told in one line above the field where the list can be seen: on the PC itself, or from a device paired with it directly.

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
## Through the relay

Add a connection no longer offers adding a PC through the relay: the relay is used through the Ovis
account ([relay.md](relay.md)), and a PC on your Tailscale is added over SSH (above). A PC added through
the relay before keeps working as described here. Such a PC was added with no SSH and no open port: both PCs only connect out to the [Ovis relay](relay.md). On the other PC, open
**Settings → Devices and PCs → Connect** (with the relay on) and type the ten-character code it shows
beside its QR code here (an older Ovis names it **Show a code to type**; its pairing link works too):
this PC's server finds that PC through the relay as a phone does ([Pairing with a typed code](relay.md)),
keeps what it found, and shows that PC's ID. Choose **It matches** only if every group matches the ID
at the top of **My devices** on that PC's screen (under the code on an older Ovis). This PC's server then pairs with that one exactly as a phone does: the same one-time code, the same
end-to-end encryption and the same device key, kept on this server in
`<stateDir>/relay-pcs/<pc id>.json` (mode `0600`). The other PC lists it under Devices as
`Ovis on <this PC's name>`, with the access any paired device has. The PC itself is saved in
`<stateDir>/relay-pcs.json`, apart from `machines.json`, so going back to an older release still starts.

**PCs on your Tailscale**, in the dialog of an older Ovis, saved typing the code: it lists
the other PCs of this PC's own Tailscale login whose Ovis already lets this PC in as you (served by
`tailscale serve`, no token), and **Add PC** adds one through the relay in one tap. This PC reads
`tailscale status`, asks only online, untagged peers of its own login that do not report iOS or
Android (the first 32 of them in that list; type a code for one past that), asks the
chosen PC for its code over Tailscale, and checks that the relay found the same PC (`server_id`)
before it pairs; on a mismatch nothing is added. A PC whose relay is off shows **Turn the relay on
on that PC first**. PCs of another login, tagged nodes and iOS or Android devices are never asked, and Tailscale
alone never adds a PC to your account (`GET` and `POST /api/machines/tailnet`; the `POST` takes only
an address the latest look found in the last 10 minutes, including a PC it left off the list because
it was already added).

Its workspaces then join the sidebar as an SSH PC's do. Nothing is installed on that PC: it runs
its own Ovis, which updates itself, so it has no bridge controls; its update can still be started
from here ([Updating PCs from here](#updating-pcs-from-here)). Its connection carries the PC's
status, its API routes and its terminals as streams of one relay session, which holds at most 8
WebSockets, so about 7 of its terminals can be open at once. A dropped connection comes back with
the same backoff as an SSH PC's and signs in with the saved key; nothing typed is sent again.

The connection takes the best route it can, as the phone apps do ([Direct on the same
network](relay.md#direct-on-the-same-network)): that PC's direct carriers first (addresses on its own
network before Tailscale ones), then the relay. The carriers come from that PC inside the encrypted
channel on each sign-in (this server always offers `direct-tailnet`, so a Tailscale address is named
too) and are kept with the key, so they follow it to another network. This server dials only those on
a private network or Tailscale's, on the direct listener's port 7319: never link-local or another port,
whatever that PC names (a PC whose listener had to take another port is reached through the relay). A sign-in
tries them within 1.5 s, then the relay. A try through the relay that found none answering, at a sign-in or a
check, holds the next one back for that PC across reconnects until the check is due again (5 minutes,
longer after a carrier that answered but could not carry a session), unless this PC is on another
network or slept meanwhile. A route that works (Tailscale, say, while the PC's own network does not
answer from here) is always tried first. While a later route carries it, this server checks the
earlier ones (a Noise handshake to the pinned key, no session) after each sign-in, then at most every
5 minutes, and at once when its own addresses change or a read comes a minute or more late (it slept);
it reads its addresses every 30 s and sends nothing for that. Once one proves to be that PC and no request or terminal input
is under way for 3 s, it signs in there first and only then closes the old session: requests that
start meanwhile wait for it and go on the new route, and input on an open terminal in that window
keeps the old session for a later try. The PC stays connected (unless that PC already holds as many
sessions of this key as it allows, when letting the new one in can end the old one first and the PC
shows `reconnecting` for a moment), its status socket reopens on the new route, and open terminals
reconnect as after any drop. `GET /api/machines` names the route of a connected relay PC as `route`:
`direct` or `relay`.

**Revoke** under Phone & devices on the other PC ends this PC's access: the PC turns to an error
that says so and is not tried again. **Remove PC** here forgets the PC and its key; revoke it on
the other PC as well to remove it there. To add it again, paste a new link or type a new code.

`POST /api/machines/relay` with `{ "link": "<pairing link>", "name"?: "<PC name>" }` adds one
(201 `{ machine }`, with `kind: "relay"`), under the same guards as every PC change. With a typed
code, `POST /api/machines/relay/code` with `{ "code": "<code>" }` runs one exchange and answers
`{ ticket, server_id, name }` (the one-time pairing code it found stays on this server for up to
10 minutes, under that random ticket), or `typed_code_<failure>` (`not-a-code`, `no-pc`, `wrong`, `expired`, `busy`,
`unreachable`, `forged`); then `POST /api/machines/relay` with `{ "found": "<ticket>" }` adds
that PC, once.

## Updating PCs from here

Every PC added here, through the relay (direct or relayed) or over SSH, is updated from the PC in
use, without going to it. Each PC in `GET /api/machines` (and the machine events) carries
`ovis_update` when it has an update it can take from here, unasked:

- `how: "own"`: the PC runs its own Ovis (a relay PC, or an SSH PC's own server) and its updater
  offers a newer release. A connected PC is asked through its connection (`GET /api/updates`
  there) when it connects and every 5 minutes; an SSH PC whose own Ovis is older than this app
  says so on its connect.
- `how: "bridge"`: an SSH PC's bridge from this app is of another version.
- `updatable: false` with `reason`, in plain words, when an update is on offer but cannot run from
  here (not started by its updater, blocked there, too old to install by revision, a saved herdr
  machine whose bridge was never approved). An SSH PC's own Ovis is never updated from here to a
  release newer than this app, beta builds included (`0.6.0-beta.2` is newer than `0.5.1` and older
  than `0.6.0`), nor to one whose version it does not tell: this app would then refuse to connect
  to it. Absent or null: up to date, or not known yet.

`POST /api/machines/:id/update` starts that update (202 `{ job_id }`), whichever way the PC is
reached, and refuses one that cannot run with 409 `update_unavailable` and the same words. A
PC's own offer names its release as `revision` (a connected PC's, or the one an SSH PC's own
Ovis older than this app told at its last connect); a body `{ "revision": … }` with the one shown
makes sure only that release is installed: one the PC offers instead by then is refused, never installed
unseen. Update all installs each PC's release as this server last read it when it was asked, also for
a PC that waits its turn. The 409 comes from the offer this server holds; when the PC itself offers
another release by the time it is asked (or already installs one), the 202 job ends with
`update_error` saying so, and nothing is installed. A
connected PC's own Ovis is asked to install the release it offers, by revision, through its
connection (no redirect is followed); its connection drops while it restarts, the PC reconnects as
any PC does, and the update ends once it answers on that release (at most 15 minutes, or a minute
for the install to start). Anything else runs the bridge update above. While it runs, the PC's
`updating` shows its steps; a failed one leaves `update_error`, in plain words, until the next try
starts or one succeeds. `DELETE /api/machines/:id/update` ends the wait (an install already running
there runs on).

`POST /api/machines/update-all` starts every PC's update at once: 202 `{ started, queued, skipped }`.
Own updates run side by side; bridge updates run one after another, sharing one bundle download,
and show `updating.queued` until their turn; a PC with an update it cannot take is `skipped` with
why (a PC whose update is an install over SSH is always skipped: it is started for that PC alone,
once its `steps` are read). Up-to-date PCs are not listed. At most four PCs' own updates run at once; the others show
`updating.queued` and start as one ends.

### Who may change PCs from here

One rule covers every change to this PC's PCs: every `POST`, `PATCH` and `DELETE` under
`/api/machines/` except a PC's own routes (its panes, workspaces and files, which are driven as this
PC's are). That covers adding a PC (SSH setup, relay, Tailscale), answering, approving or cancelling a
setup, its settings, renaming, turning on or off and removing a PC, and every update
(`/:id/update`, `update-all`, `/:id/update-bridge`, which takes `{ "revision" }` and otherwise uses
the release its card shows). The same rule covers installing an update on this PC itself:
`POST /api/updates/install` and `POST /api/herdr/update`. The one exception is the connection
server's bridge token, which asks for its own install by revision.

| May | Who |
|---|---|
| Yes | a driving sign-in on this PC, its token, its Tailscale login |
| Yes | a driving device paired with this install, directly or over the relay (the owner's phone, his other PCs) |
| No | a visitor of an open install, with nothing paired |
| No | a Portal visitor, whatever role Portal gives |
| No | any device that only watches |

The request must also come from this app's own page: the `X-Herdr-Update: 1` header, same origin,
no query. Anything else gets 403 `forbidden`. The app sends the header on every PC request.

### Installing Ovis on a PC over SSH

Where a PC's own Ovis cannot update itself, or a PC has none yet, Ovis is installed there from
here over SSH with the official installer (the `install.sh` the [guide](guide.md) pipes from
`https://ovis.sh/install.sh`), taken from this app's own release tag on GitHub and run with
`OVIS_REF=v<version>`, so the script and what it installs are that release's and both ends run one
version. SSH uses keys only (`BatchMode`): a PC that wants a password, or whose host key is not
known here yet, is refused with what to do (add its key with `ssh-copy-id`, or add it once with
**Add PC**, which checks the fingerprint and can register a key). Linux and macOS PCs (x64 or arm64)
and herdr's default session only.

- An SSH PC whose own Ovis was started by hand (`bun run server`, not its updater) offers
  `ovis_update.how: "install"`: its `steps` name the process it stops; Ovis is installed as a herdr
  plugin that updates itself (`OVIS_RUNTIME=herdr`), started (herdr is started headless when it is
  not running, which starts the plugin), and the PC connected again. As when it is run by hand, the
  installer adds what is missing for that account (herdr, Bun, which may add itself to the shell's
  startup file) and serves Ovis to the tailnet when Tailscale runs there; the steps say so first. An
  Ovis already installed there (a herdr plugin or its user service) is started that way instead, since
  the installer would keep its release. When its bridge is older than this app's, the install updates
  it before it ends; otherwise it connects as it is, and its own update is offered on its card, never
  installed unseen. Its settings and data stay; herdr and its sessions
  keep running. The desktop app's own server is never replaced: it updates with the app.
- One whose supervisor is too old to install an update by revision is restarted through its own
  launcher (the herdr plugin's stop and start actions, or the `ovis` user service of Ovis on
  herdr-core), then asked to install the release its card showed. The install ends once that update has
  installed, or fails with its words. Without a launcher nothing is stopped (`no_launcher`). A release before 0.4.13 cannot be updated from here this way.
  When the launcher stopped it but failed to start it again, Update asks the launcher once more.
- The installer sets Ovis up for herdr's default session only: a PC added with a named session is
  offered no install (`updatable: false`, with why).
- `POST /api/machines/:id/update` runs that install as any update; `POST /api/machines/install`
  with `{ "machine_id": … }` does the same, and with an SSH address (`destination`, `port`,
  `identity_file`, `name`) installs on a PC not added here and adds it once Ovis answers there
  (refused when Ovis or this app's bridge already runs there).
- The job (`GET /api/machines/install/:id`, `DELETE` to cancel) goes `connecting`, `checking`,
  `stopping`, `installing`, `starting`, `connecting_pc`, then `connected`, `failed` or `cancelled`.
  A failure carries `error_code` and words: `ssh_refused`, `ssh_host_key`, `ssh_unreachable`,
  `unsupported`, `missing_tool` (no curl, git or tar), `disk` (under 1 GB free in the home folder),
  `permission`, `bridge_there`, `ovis_there`, `changed` (the process to stop is no longer the one
  shown, or its pid now runs another program: nothing is stopped), `not_stopped`, `installer_failed` (with the installer's last words),
  `no_launcher`, `not_started`, `connect_failed`. Experimental, off by default (Settings → Experimental → PCs → Start a replaced server again): when it is off, a failed or cancelled replacement leaves the server started by hand stopped, as before, and nothing of it is copied. When it is on and the install fails or is cancelled after the server started by
  hand was stopped, before anything was installed or launched in its place (the installer could not be
  downloaded, or never ran), that server is started again as it was. Just before it is stopped, its program, arguments,
  environment (its `OVIS_TOKEN` with the rest) and folder are copied from `/proc` into a folder only
  that account can read. The stop goes ahead only while that pid is still the very server its bridge
  registration recorded (its birth: this boot's id and start ticks on Linux, `ps`'s start time on macOS),
  so another Ovis that took the pid after it ended is never stopped (`changed`), whether or not the
  restore is on. A registration that recorded no birth (every 0.5.x server's) is stopped only if its
  process started no later than its registration file was written (2 s of slack): one that took the
  pid later is refused in plain words. The copy and the stop each go ahead only while that pid is still the process
  shown (on Linux its start in clock ticks since boot from `/proc/<pid>/stat` and its owner; on macOS `ps`'s start time to the second and owner, where a pid reused within that second stays a residual; checked in the same command): one that took
  its pid since is never copied or signalled (`changed`). A copy cut short removes itself. Nothing is stopped when copying fails this time (try again). When no faithful
  copy can be made (its environment unreadable, its program or folder deleted since it started, as after
  a Bun upgrade, or a byte that would not survive being started again, not UTF-8), it is replaced as on macOS:
  without a copy, and the job says it stays stopped if the install then fails.
  To start it again, its own Bun first binds the server's own address (`HOST`, `PORT`): one already
  taken means a live server is there, its replacement among them, and nothing is started beside it; so does any live Ovis registered for that herdr session, managed or not, on any port. It
  then reads the copy and starts the program with exactly that environment,
  given to the process directly (never on a command line another account could read), in its own
  session, its output in `~/.local/state/ovis/restored-server.log` (opened without following a link, this
  account's own file, made readable by this account alone). A new SSH
  connection does it, tried twice, after waiting for a server that is still stopping, and the PC stays
  busy until then. Once something was installed or launched in its place, it is not started again (a
  start of their own may still be on its way, and would come up beside it): the copy is then only
  removed, and the words say what may be running. The copy is removed once read, once the new Ovis
  answers, or after two hours whatever becomes of the job (`systemd-run` where it can, so it outlives the
  SSH session; each later capture also sweeps older ones). Where there is no `/proc` (macOS) nothing is
  copied, and the server is never started again with a guessed environment; the job then says it stays
  stopped. The words say which happened. These routes are this PC's owner's only, with the
  `X-Herdr-Update: 1` header on a change, as updates are ([Updating PCs from here](#updating-pcs-from-here)). Only the process named is ever stopped, only after
  it is checked to be that PC's own Ovis server. While an install or setup runs, no other setup or
  install connects to that PC from here: the same PC as ssh resolves it (`ssh -G`: an alias, or its
  default port given, is the same one), for any herdr session there or another PC saved at that
  address. The install's final connect uses keys only too. A cancelled install keeps the PC busy until its own run
  has ended. Stopping an installer already running there is best effort: beside it, a watcher writes
  an empty line to the SSH connection every two seconds, and once nobody reads there (the connection
  was closed) it stops the installer's whole process group, and the command writes once more right
  before the installer starts. The PC's SSH server can take a moment to notice a closed connection,
  longer when the network between is cut, so an installer may still start or finish its changes there
  after the job says `cancelled`.

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
| `POST/DELETE /api/machines/:id/update` | Start or stop waiting for the PC's update ([Updating PCs from here](#updating-pcs-from-here)) |
| `POST /api/machines/update-all` | Start every PC's update |
| `POST /api/machines/install`, `GET/DELETE /api/machines/install/:id` | Install Ovis on a PC over SSH ([Installing Ovis on a PC over SSH](#installing-ovis-on-a-pc-over-ssh)) |
| `PATCH /api/machines/:id` | Rename or change `enabled` |
| `DELETE /api/machines/:id` | Forget the PC and remove its local private key |
| `/api/machines/:id/{session,agents,pane/*,workspace/*}` | Allowlisted target API routes |
| `GET/POST/DELETE /api/machines/:id/runtime/move`, `POST .../runtime/move/{stop,stop-all,install}` | That PC's move to herdr-core, for the owner only: this PC, the token, a Tailscale login, a paired or relay device that drives; never an open LAN visitor, a Portal visitor or a device that watches ([runtime-move.md](runtime-move.md#on-another-pc)); 409 `pc_update_required` from an Ovis too old for it |
| `POST /api/machines/runtime/move-all` | Starts every previewed PC's move at once, for the owner only (as above): 202 `{ started, refused, unknown }` |
| `/ws?machine_id=…` | Immutable terminal destination |

Legacy HTTP paths, `/ws` without a machine, and old stored preferences/notification links mean **local**. Machine mutations require `X-Herdr-Machine: 1`, the existing token gate and same-origin browser requests. The proxy passes a bridge credential read through SSH; browser cookies, bearer tokens, forwarded headers and remote cookies are not forwarded. Authentication, push devices, VAPID keys and app updates belong to the current connection server.

Remote credentials are registered in `~/.config/herdr-web-ui/bridges/` on that PC (mode `0600`). A compatible bridge for the same socket is reused, including a normally started server from this version. A server started with `HOST` set to an IP address other than `127.0.0.1` or a wildcard also opens a relay on `127.0.0.1` and registers that port, since the forward only ever reaches the PC's loopback. A host name in `HOST` gets no relay, since it could resolve to another machine by the next connection; adding that PC says to set `HOST=127.0.0.1`. Independently managed bridges are never stopped by remote setup. Older unregistered bridges can still hold an exclusive terminal attach; release their browser attachment or restart them with registration support. Automatic attaches and reconnects never use `--takeover`. With a bridge that advertises support,
**Open here** on a pane's waiting notice explicitly takes its terminal. The displaced web bridge
waits; a standalone `herdr terminal attach` exits. The herdr TUI stays connected (verified on
herdr 0.9.3). Older bridge bundles keep waiting until updated, and observe connections cannot take a pane.

## Disconnects and updates

When the connection server and remote bridge support receipt recovery, a returning browser can
recover the exact outcome of a sent or discarded follow-up without typing it again. The connection
server scopes the receipt identity to that server, PC, authenticated device (or Portal user or
Tailscale login) and browser; watch-only connections cannot recover it. Receipts last at most ten
minutes, with at most 1024 outcomes retained.
A missing receipt or a restart of either server leaves the saved copy **Not confirmed**.

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
