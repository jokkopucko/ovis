import type { AgentRowTokens } from "./pane-tokens.ts";
import type { SharedPreferences } from "./preferences.ts";
import type { HealthAuth, SecuritySummary, ServerMessage, SessionSnapshot } from "./protocol.ts";
import type { MoveStatus, MoveUnavailable } from "./runtime-move.ts";
import type { SeenFinish } from "./seen.ts";

export const LOCAL_MACHINE = "local";
export const BRIDGE_PROTOCOL = 1;
export const REMOTE_BUNDLE_VERSION = "53";
export interface PaneTarget { machine_id: string; pane_id: string }
export type MachineState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
export interface SshTarget {
  destination: string;
  port?: number;
  identity_file?: string;
  session?: string;
  herdr_socket?: string;
  /** Socket identity of this account's own Ovis registration; reverified over SSH on every connection. */
  own_ovis?: string;
  /** Explicitly chosen on this PC; permits starting its configured session when absent. */
  start_new_herdr?: boolean;
}
/** Why POST /api/machines/address added no PC, answered as `address_pc_<failure>`: the app words each one. */
export const ADDRESS_PC_FAILURES = ["address", "target", "code", "wrong_code", "waiting", "unreachable", "not_ovis", "added", "self"] as const;
export type AddressPcFailure = typeof ADDRESS_PC_FAILURES[number];
/** A PC this server is paired with as one of its devices (relay, address): it runs its own Ovis, which it is revoked on. */
export function pairedPc(machine: Pick<Machine, "kind">): boolean { return machine.kind === "relay" || machine.kind === "address"; }
export interface Machine {
  /** Read-only identity inherited from the local herdr catalog. */
  herdr_profile_id?: string;
  id: string;
  name: string;
  /** hc: another machine of this PC's herdr-core (`hc machine add`), reached through that core */
  /** address: another PC's own Ovis added by its https address, paired as a device that drives it */
  kind: "local" | "ssh" | "relay" | "hc" | "address";
  target?: SshTarget;
  /** a PC added through the Ovis relay (no SSH): its relay ID and the relay it is reached through */
  relay?: { server_id: string; relay: string };
  /** an address PC's origin, such as https://desk.example.ts.net */
  address?: string;
  /**
   * How a connected relay PC is reached now: on one of its direct carriers (its own network, or Tailscale), or
   * through the relay. Absent while it is not connected, and for other kinds of PC.
   */
  route?: "relay" | "direct";
  /** a relay PC that admitted this server only to watch (another PC of the account joined through it): reads pass, writes are refused there */
  view_only?: true;
  /**
   * The PC's relay ID (server/relay/identity.ts) as its own server has it: the local PC's own, an SSH PC's
   * from its /api/health. Absent where that server has none, or is older. What a device turns its alerts off by.
   */
  server_id?: string;
  enabled: boolean;
  state: MachineState;
  error: string | null;
  /** Attention needed; windows_login retries, windows_start_failed waits for a startup decision. */
  action_required?: MachineAction | null;
  /** herdr daemons found on the PC before this bridge was started */
  found_herdr_sessions?: FoundHerdrSession[];
  found_ovis?: FoundOvis[];
  /** Runtime proved by the server's HerdrIdentity, absent until it answers. */
  runtime?: "herdr" | "herdr-core";
  /** a bridge update running for this PC right now (in the background, or from its dialog) */
  updating?: MachineUpdate | null;
  /** the PC's latest roster as its server read it, with that read's order_epoch/read_seq copied unchanged */
  snapshot: SessionSnapshot | null;
  herdr?: HerdrIdentity;
  /**
   * The boot id of the server behind this PC, as this manager last proved it: its own for the local
   * PC, a remote one only from that bridge's authenticated /api/health over the current connection.
   * Absent for a restored or not yet verified PC. It is information only: nothing retires a
   * workspace-order epoch on it (only a verify_source_boot answer can, shared/protocol.ts).
   */
  source_boot_id?: string;
  /**
   * The PC's own Ovis (an independently managed web server, not a bridge this app started) when it
   * is older than this app, as its own updater told it over SSH; null or absent otherwise, and from
   * an older server. With `updatable`, `action_required` is "update_bridge" and that update asks it
   * to install its own update; without, it is "setup" and `reason` says why.
   */
  remote_ovis?: RemoteOvis | null;
  /**
   * The update this PC can take from here, told without being asked (the devices list's badge): absent or null
   * when it is up to date or cannot tell yet (not connected, an older server). `POST /api/machines/:id/update`
   * runs it; `updating` shows its steps. Not for this server's own PC (Settings → Updates) or a herdr-core machine.
   */
  ovis_update?: PcUpdateOffer | null;
  /** why this PC's last update from here failed, in plain words; cleared when another one starts or it succeeds */
  update_error?: string | null;
  /**
   * A connected SSH or relay PC's move to herdr-core (docs/runtime-move.md, "On another PC"), as its own
   * GET /api/runtime/move tells it. Null when that PC cannot tell (an older Ovis, or a bridge with no
   * runtime to switch); absent while it is not connected, not read yet, and for this PC and hc machines.
   */
  runtime_move?: PcMoveOffer | null;
}
/**
 * An update a PC can take from here.
 * - `bridge`: this app's bridge on an SSH PC is of another version; the bridge update replaces it (approved setup).
 * - `own`: the PC runs its own Ovis (a relay PC, direct or through the relay, or an SSH PC's own server) and its own
 *   updater offers a newer release, which it installs by revision when asked from here.
 * - `install`: an SSH PC's own Ovis cannot update itself from here (started by hand, or a supervisor too old to
 *   install by revision): this app does it over SSH (PcInstallJob), as `steps` says, then updates it.
 * `updatable` false: `reason` says why in plain words, and asking for it is refused with that reason.
 * Versions are releases without the v (`0.5.1`), null where the PC names none (a bridge).
 */
export interface PcUpdateOffer {
  how: "bridge" | "own" | "install";
  current_version: string | null;
  latest_version: string | null;
  updatable: boolean;
  reason: string | null;
  /**
   * `own`, and an `install` that restarts its Ovis and then updates it: the release on offer (its commit), which an
   * update asked for may name; only that release is installed
   */
  revision?: string | null;
  /** `install` only: what it does on that PC, in plain words, for the person to read before they start it */
  steps?: string[];
}
/**
 * POST /api/machines/install: install Ovis on a PC over SSH with the official installer, pinned to this app's
 * release (docs/remote-pcs.md). `machine_id` names a PC added here whose own Ovis cannot update itself (its offer's
 * `how: "install"`); without one, the PC is added once Ovis answers there.
 */
export type PcInstallRequest = { machine_id: string } | (SshTarget & { name?: string; machine_id?: undefined });
/** why an install over SSH stopped, for the words to show (`error` carries them in English) */
export type PcInstallFailure = "ssh_refused" | "ssh_host_key" | "ssh_unreachable" | "unsupported" | "missing_tool" | "disk" | "permission"
  | "bridge_there" | "ovis_there" | "changed" | "not_stopped" | "installer_failed" | "no_launcher" | "not_started" | "connect_failed";
/**
 * An install over SSH (GET /api/machines/install/:id). `mode`: `install` on a PC without Ovis; `replace` stops the
 * Ovis server started by hand there, then installs; `restart` restarts an Ovis whose supervisor is too old through
 * its own launcher, then updates it. `connect_job`: the setup job (GET /api/machines/setup/:id) that connects the PC.
 * SSH uses keys only (BatchMode): nothing asks for a password.
 */
export interface PcInstallJob {
  id: string;
  machine_id: string | null;
  target: SshTarget;
  mode: "install" | "replace" | "restart";
  phase: "connecting" | "checking" | "stopping" | "installing" | "starting" | "connecting_pc" | "connected" | "failed" | "cancelled";
  step: string;
  error: string | null;
  error_code: PcInstallFailure | null;
  connect_job: string | null;
}
/**
 * POST /api/machines/:id/update, with an optional JSON body: `revision`, the offer's as shown. When the offer this
 * server holds names another release, nothing is installed: 409 `update_unavailable`. When the PC itself offers
 * another one by the time it is asked, the 202 update ends with `update_error` saying so, and nothing is installed.
 */
export interface PcUpdateRequest { revision?: string }
/**
 * POST /api/machines/:id/update: the update started; its steps show on the PC's `updating`. This and update-all are
 * this PC's owner's only (403 `forbidden` otherwise), and need the `X-Herdr-Update: 1` header.
 */
export interface PcUpdateStarted { job_id: string }
/**
 * POST /api/machines/update-all: every PC with an update it can take. `started`: running now (own updates run side
 * by side); `queued`: bridge updates, which run one after another (they share one bundle download) and show
 * `updating.queued` until their turn; `skipped`: an update is offered but cannot run, with why. Up-to-date PCs are
 * not listed.
 */
export interface PcUpdateAll {
  started: { machine_id: string; job_id: string }[];
  queued: string[];
  skipped: { machine_id: string; reason: string }[];
}
/**
 * Where another PC stands on the move to herdr-core. `serving: "herdr"` with `offered` is the "not moved
 * yet" badge. `offered`: the move can start there, or herdr-core can be installed there first (`reason`
 * is then "no_herdr_core"); otherwise `reason` says why not. `status` is the progress of its move.
 */
export interface PcMoveOffer {
  serving: "herdr" | "herdr-core";
  offered: boolean;
  reason: MoveUnavailable | null;
  status: PcMoveStatus;
}
/**
 * A PC's move status as every roster (a watching device's too) may carry it: where it is and how far,
 * and how many agents a move that could not finish left. Its reasons name folders and agents' words, so
 * they stay in the plan answer (GET /api/machines/:id/runtime/move), which only a driving device reads.
 */
export type PcMoveStatus =
  | { state: "idle" | "waiting" | "done" }
  | Extract<MoveStatus, { state: "moving" }>
  | { state: "rolled_back" | "interrupted"; left: number };
/** POST /api/machines/runtime/move-all: the revision of each PC's plan as the person previewed it. */
export interface MoveAllRequest {
  plans: { machine_id: string; revision: string }[];
}
/**
 * Its 202 answer: the PCs whose move started (each waits for its own busy panes), why the others did not,
 * and those whose answer never came: the start may have reached them, so their move status says.
 */
export interface MoveAllResponse {
  started: string[];
  refused: { machine_id: string; code: string; message: string }[];
  unknown: { machine_id: string; message: string }[];
}
/**
 * What a PC's own Ovis says of its own update (GET /api/updates there, read through the SSH tunnel).
 * Every field is that server's word, shown as text, apart from `url`, an https address only.
 */
export interface RemoteOvis {
  /** its running version and the release its updater offers, without the v; null when it names none */
  version: string | null;
  latest_version: string | null;
  /** it can install its offered update itself, asked by this app */
  updatable: boolean;
  /** why it cannot, in that server's words or this app's; null when it can */
  reason: string | null;
  /** where it answers: the SSH host and its own port, to open on that PC or through its own tailnet address */
  address: string;
  /** the HTTPS address it says Tailscale already serves it at, when it says so */
  url: string | null;
}
export const OWN_UPDATE_OFFER = "This PC runs its own Ovis";
/** A setup failure the app words in its own language from a code and its parameters (versions without the v). */
export type SetupErrorCode = { code: "own_ovis_older"; version: string | null; target: string | null };
/** A setup step the app words in its own language from a code and its parameters (versions without the v; stage as that PC's Ovis names it). */
export type SetupStepCode =
  | { code: "connecting" | "fingerprint" | "authentication" | "checking" | "review" | "installing" | "install_herdr" | "register_key" | "restart_bridge" | "start_bridge" | "own_update_connect" | "headless" | "connected" | "failed" | "timed_out" | "cancelled" }
  | { code: "install_bundle"; platform: string }
  | { code: "own_update_ask"; target: string | null }
  | { code: "own_update_running"; target: string | null; stage: string };
export function pcAlertKey(machine: Pick<Machine, "name" | "relay" | "server_id">): string {
  return machine.relay?.server_id ?? machine.server_id ?? machine.name;
}

/** GET /api/machines: with ?verify_source_boot=<id>, also that PC's freshly proved boot id */
export interface MachineRoster { machines: Machine[]; verified_source_boot?: { machine_id: string; boot_id: string } }
/**
 * The herdr behind a PC, as its bridge can serve it. terminal_attach is false on a Windows
 * host: herdr has no `terminal attach` there yet (herdrdev/herdr#4821), and it is false on
 * any bridge whose runtime cannot run the PTY sidecar (the win32 bundle ships none). Such a
 * PC's panes have the chat lens and a mirrored terminal (terminal_mirror). Absent on older
 * bridges, which are never Windows.
 */
export interface HerdrIdentity {
  version: string;
  protocol: number;
  terminal_attach?: boolean;
  /** without attach, the terminal lens shows the pane's screen repainted a few times a second (server/mirror.ts) */
  terminal_mirror?: boolean;
  /**
   * `herdr-core`: the PC's terminals are herdr-core's (OVIS_RUNTIME=herdr-core), which has no
   * workspaces, tabs or splits of its own: the layout calls and the worktree actions are offered
   * only as `layout` says. Absent: herdr's TUI server.
   */
  runtime?: "herdr-core";
  /** herdr-core only: which layout calls it answers (HerdrCoreLayout); absent, none */
  layout?: HerdrCoreLayout;
}

/**
 * What a herdr-core PC lets Ovis do with its workspaces, tabs and splits. On a core no Herdr app
 * arranges (its `herdr-app` document was never written, as on the desktop app's own core) Ovis keeps
 * names and places in terminal labels (`rename`, `move` a one-pane tab to another workspace) and
 * splits, ratios, zoom, swap and order in its own `ovis-layout` document (`split`, `arrange`: only
 * where the core writes documents). `worktrees`: Ovis runs git's worktree commands itself and opens
 * a checkout as a workspace it places. Where the Herdr app arranges them, they are the app's, and
 * none is offered.
 */
export interface HerdrCoreLayout {
  rename: boolean;
  split: boolean;
  move: boolean;
  arrange: boolean;
  worktrees: boolean;
}
export const HC_OTHER_WORKSPACE_ID = "hc-other";
/**
 * A runtime a server can be asked to serve: herdr's TUI server, herdr-core (the Herdr app's core), or
 * `alt-runtime`. `alt-runtime` is never picked from what the PC has, only by OVIS_RUNTIME or a choice
 * saved from Settings, and a saved choice of it that cannot start falls back to herdr.
 */
export type RuntimeName = "herdr" | "herdr-core" | "alt-runtime";
/** where this server's runtime came from: OVIS_RUNTIME, the choice saved from Settings, or what the PC has */
export type RuntimeSource = "env" | "saved" | "detected";
/** why Settings cannot switch the runtime: OVIS_RUNTIME decides, the server was not started by Ovis's launcher, or herdr-core is not served on this OS */
export type RuntimeLock = "env" | "unmanaged" | "platform";
/**
 * Which runtime this server serves and what Settings may switch it to (GET /api/health, a driving
 * owner only). `switch_to`: the other runtime when this PC has it and nothing locks the choice.
 * `fallback`: the saved choice was herdr-core, but no herdr-core answered (`no_herdr_core`), or it was
 * alt-runtime, which could not start (`no_alt_runtime`), so herdr is served.
 */
export interface HerdrRuntimeFacts {
  serving: RuntimeName;
  source: RuntimeSource;
  tui: { installed: boolean; running: boolean };
  app_installed: boolean;
  switch_to: RuntimeName | null;
  locked: RuntimeLock | null;
  fallback?: "no_herdr_core" | "no_alt_runtime";
}
/**
 * What this PC has of herdr-core, the Herdr app's runtime, whichever runtime the server serves
 * (GET /api/health, authenticated only). `version`: the hc the server found and would run
 * (server/herdr-core/discovery.ts), null when none answers as hc. `running`: the core's socket file
 * is there for `session`; nothing connects to it, since any hc command but `--version` starts a core.
 * `session` is null when HC_SESSION is not a plain name (hc refuses such names), so no path is told.
 * `bundled_unused`: the desktop app's own hc did not answer, and `version` is another hc's found in its place.
 */
export interface HerdrCoreFacts {
  version: string | null;
  session: string | null;
  running: boolean;
  bundled_unused?: true;
}
export interface FoundHerdrSession { socket_path: string; session?: string; label: string }
export interface FoundOvis { socket_path: string; runtime: "herdr-core" }
/** `install_ovis`: an account add over SSH found no Ovis of that PC's own there; installing Ovis there (PcInstallJob) is the way on */
export type MachineAction = "connect" | "update_bridge" | "setup" | "bridge_conflict" | "windows_login" | "windows_start_failed" | "choose_herdr" | "install_ovis";
/** `ovis`: the PC's own Ovis updates itself (Machine.remote_ovis); absent for a bridge this app installs */
export interface MachineUpdate {
  /** what cancels it: DELETE /api/machines/:id/update (any update), or a setup job's cancel; empty while `queued` */
  job_id: string;
  step: string;
  progress: SetupProgress | null;
  ovis?: boolean;
  /** waiting for the bridge updates of Update all before it to finish */
  queued?: boolean;
}
/**
 * Where a bridge install is. download (the web server fetching the bundle) and upload (the
 * bundle going to the PC over SSH) count bytes; install and restart have no size.
 * rate is bytes per second over the stage so far; elapsed_ms is how long the stage has run.
 */
export interface SetupProgress { stage: "download" | "upload" | "install" | "restart"; done: number; total: number | null; rate: number | null; elapsed_ms: number }
/** Server-side PC preferences (machine-settings.json in the state directory). */
export interface MachineSettings {
  auto_update_bridges: boolean;
  /**
   * The Host's saved-PC files (machines.json, herdr-profile-state.json) that were not JSON when
   * this server started, by the name each was moved to beside them; absent when none was. Read
   * only: a PATCH ignores it.
   */
  set_aside?: string[];
}
/**
 * `account_add`: the setup also adds that PC to this PC's account (docs/account.md, "Adding a PC over SSH"): public-key SSH
 * only, a host key known or confirmed here, and that PC's own Ovis only, never a bridge this app starts.
 */
export interface SetupRequest extends SshTarget { name?: string; machine_id?: string; update_remote?: boolean; start_new_herdr?: boolean; account_add?: boolean }
/** What a PC's own Ovis told an account add over SSH of itself: its public relay fields, and the account it is in. */
export interface AccountAddTarget { server_id: string; public_key: string; relay: string; label: string; account: string | null }
/**
 * That PC's relay when it answered the take of an account add over SSH: it turns the relay on and waits a while for it to
 * come online (docs/account.md, "Adding a PC over SSH"). `blocked`: why it may not run there.
 */
export interface AccountAddRelay { phase: "off" | "connecting" | "online" | "error"; blocked: "serve_only" | "identity_unreadable" | null }
/**
 * POST /api/account/ssh-add's answer: that PC is in `account`; `relay` is null where its Ovis did not say (one from before
 * this), or where the take's answer was lost and a second inspect found that PC in the account (`unanswered`).
 * `list_joined`: the account keeps a signed list, and that PC joined it by this add (not one the list held already).
 */
export interface AccountAddTaken { account: string; server_id: string; relay: AccountAddRelay | null; unanswered?: true; list_joined?: true }

const RELAY_PHASES: readonly unknown[] = ["off", "connecting", "online", "error"];
const RELAY_BLOCKS: readonly unknown[] = ["serve_only", "identity_unreadable", null];

/** A relay word as an account add's take passes it on, or null for anything else. */
export function accountAddRelay(value: unknown): AccountAddRelay | null {
  if (value === null || typeof value !== "object") return null;
  const { phase, blocked } = value as Record<string, unknown>;
  return RELAY_PHASES.includes(phase) && RELAY_BLOCKS.includes(blocked) ? { phase, blocked } as AccountAddRelay : null;
}
export type SetupPhase = "connecting" | "authentication" | "checking" | "approval" | "installing" | "starting" | "connected" | "failed" | "cancelled";
export interface SetupChallenge { id: string; kind: "host_key" | "secret"; prompt: string }
export interface SetupJob {
  found_herdr_sessions?: FoundHerdrSession[];
  found_ovis?: FoundOvis[];
  runtime?: "herdr" | "herdr-core";
  id: string;
  machine_id: string;
  phase: SetupPhase;
  step: string;
  /** step's code and parameters where the app words it itself; step keeps the server's English. Null for a PC's own notice */
  step_code?: SetupStepCode | null;
  challenge: SetupChallenge | null;
  installations: string[];
  error: string | null;
  /** error's code and parameters where the app words it itself; error keeps the server's English */
  error_code?: SetupErrorCode | null;
  /** An unsaved Windows destination may wait for login; its setup must stay in the current dialog. */
  windows_startup?: boolean;
  /**
   * set on a failed job when retrying as-is cannot connect: the user has to update the
   * bridge or approve setup. The dialog turns "update_bridge" into its update-and-connect
   * button, which a PC that was never registered cannot get from the sidebar.
   */
  action_required?: MachineAction | null;
  /**
   * ssh's latest stderr lines while the connection is being made, null otherwise. Some of them
   * ask the user to act while ssh keeps waiting (Tailscale SSH's browser check URL).
   */
  ssh_output: string | null;
  target: SshTarget;
  progress?: SetupProgress | null;
  /** the PC's own Ovis, when it is older than this app (Machine.remote_ovis): a first connect has no PC to carry it */
  remote_ovis?: RemoteOvis | null;
  /** an account add's connected job: the PC it reached, for the window to list and admit (POST /api/account/ssh-add next) */
  account_add?: AccountAddTarget;
}
export type SetupAction = { action: "answer"; challenge_id: string; answer: string } | { action: "approve" } | { action: "cancel" } | { action: "start_headless" };
/**
 * A device lost its access (docs/account.md, "On the PC"): revoked on this PC (`by` "pc", or the device that
 * revoked it), or removed by an account record (`by` the member that signed it). Told to driving streams only.
 */
export interface DeviceRemovedEvent {
  type: "device-removed";
  event_id: string;
  device_id: string;
  label: string;
  removed_at: string;
  by?: { device_id: string; label: string } | "pc";
}
/**
 * A device was durably enrolled (server/devices.ts): its registry write succeeded, whether at a
 * gated pairing or when a first-pair cookie came back. Never for an unconfirmed credential, a
 * last-seen write or a failed write. Sent to every stream of this server but the new device's
 * own; `event_id` is what a browser deduplicates by. Carries nothing a credential could be
 * made from: the label is the normalized one (at most 48 characters), the id the public one.
 */
export interface DevicePairedEvent {
  type: "device-paired";
  event_id: string;
  device_id: string;
  label: string;
  enrolled_at: string;
  /** the account member that approved it from another device (docs/account.md, "Who may admit a device"); absent when approved on this PC or by a code */
  approved_by?: { device_id: string; label: string };
}
/**
 * A join is told to every window of this PC that opens until one window marks it seen (POST /api/devices/joins/seen):
 * then every window drops it.
 */
export interface DevicePairedSeenEvent {
  type: "device-paired-seen";
  event_id: string;
}
/** What a comparison asks for (docs/account.md, "Negotiation"): pairing this PC only, or joining the account. */
export type PairingIntent = "pc" | "account";
/**
 * Where an add of this PC to an account that keeps a signed list stands (GET /api/account/list/add, this PC's own
 * window and CLI alone; server/account/list-add.ts `AddState` answers it). `number`: `digits` are on this PC's
 * screen until `until`, and the person says here whether the device adding the PC shows the same
 * (POST /api/account/list/add/confirm `{ digits, run }`, or `/cancel` `{ run }`).
 */
export type ListAddState =
  | { readonly state: "none" | "replaced" }
  | { readonly state: "no_list"; readonly account: string }
  | { readonly state: "waiting" | "confirmed"; readonly run: string; readonly account: string; readonly list: string; readonly until: string }
  | { readonly state: "number"; readonly run: string; readonly account: string; readonly list: string; readonly digits: string; readonly until: string }
  | { readonly state: "added"; readonly run: string; readonly account: string; readonly list: string }
  | { readonly state: "ended"; readonly run: string; readonly account: string; readonly why: string };

/**
 * An account join taken outside the pairing window, as this PC's own window lists it (GET /api/relay/joins): never its
 * digits, which the owner types from the new device's screen (POST /api/relay/join). `digits`: a first join, asked while
 * the PC had no member to approve it, which the owner compares and allows or declines by a tap there.
 */
export interface OwnJoinRequest {
  id: string;
  label: string;
  asked_at: string;
  left_ms: number;
  digits?: string;
  /** The join is let in by the account's signed list: an approval here is received at once, and the device is in only once its entry is in the list. */
  list?: true;
  /**
   * A join into the account on a PC pinned to its list, from an app that knows no join into a list (an Ovis older than
   * 0.5.10): this PC lets it in by nothing, so nothing is approved for it here; that app is updated, and asks again.
   */
  list_unknown?: true;
}
/**
 * A phone asking to pair through the relay by comparing digits (docs/relay.md): the six digits its
 * screen shows too, waiting for the owner to approve it until `expires_at`.
 */
export interface RelayPairingRequest {
  id: string;
  label: string;
  digits: string;
  expires_at: string;
  /** absent from an older server: `pc` */
  intent?: PairingIntent;
  /**
   * Asked while this PC waited to be added to an account (docs/account.md, "Adding a PC"): the device
   * added from shows no digits, its person types this PC's there. It follows the PC's window, so a
   * device that came by an ordinary link meanwhile has it too and shows digits to compare.
   * Absent from an older server, or when false.
   */
  local_only?: boolean;
  /**
   * How long the request still waits, counted by the PC when it told this list: a window counts down
   * from when it heard, since its own clock need not match the PC's `expires_at`. Absent from an older server.
   */
  left_ms?: number;
}
/**
 * The same request as an account member connected through the relay sees it: three candidates
 * instead of the digits, one of them the new device's, which the approver must pick
 * (`POST /api/relay/pairing` with `digits`).
 */
export interface RemotePairingRequest {
  id: string;
  label: string;
  intent: PairingIntent;
  choices: [] | [string, string, string];
  expires_at: string;
  /** the new device's key (P-256 SPKI, base64url) from PAIR_REQUEST, bound by its commitment and the digits: what the approver signs an `add` for */
  key: string;
  /**
   * Another PC of the account vouched for by an admission (`pair-intent-pc-vouched`, docs/account.md "Adding a PC of
   * your account"): its intent stays `pc`, so nothing is signed for it, and the approver shows who is asking and checks
   * the admission as for an account join. Absent from an older server, or when false.
   */
  vouched?: true;
  /** Derived by the receiving PC only after the joining server answered its channel-bound challenge. */
  proven_server_id?: string;
  /**
   * The join brought the new device's card for the account's signed list: the PC lets it in by an entry of the list,
   * which its approver signs and places, never by the approval alone. Absent from an older server, or when false.
   */
  list?: true;
  /**
   * The new device's person said the digits match (its PAIR_CONFIRM reached the PC). For a join into the list the
   * approver signs the device's entry only once this is true, so a device that gives up before it is nobody's
   * member. Absent from an older server, or while it has not confirmed.
   */
  confirmed?: true;
  /**
   * A join this PC cannot let in: it lets devices in by its account's signed list, and the app that asks knows no join
   * into a list (an Ovis older than 0.5.10). No approval decides it (409 `list_unknown`); a decline ends it. Absent from
   * an older server, or when false.
   */
  list_unknown?: true;
}

export type MachineEvent = { type: "machines"; machines: Machine[] } | { type: "machine-message"; machine_id: string; message: ServerMessage }
  /** `preferences`: what every browser of this server shares changed (shared/preferences.ts) */
  | { type: "preferences"; preferences: SharedPreferences }
  /** the `$name` tokens herdr's `[ui.sidebar.agents]` rows draw on this server's PC, for every PC's agent rows (server/herdr-sidebar.ts) */
  | { type: "herdr-sidebar"; agents: AgentRowTokens | null }
  /** finishes a browser of this server presented (shared/seen.ts): every record when the stream opens, then each change */
  | { type: "seen"; finishes: SeenFinish[] }
  | DevicePairedEvent
  | DevicePairedSeenEvent
  | DeviceRemovedEvent
  | RelayPairingsEvent
  | RemotePairingsEvent
  | PendingRedemptionsEvent;
/**
 * A device that redeemed a code and proved its key, waiting for this PC's screen to approve that key (device table S31,
 * T71). `label` is what the device says about itself; `fingerprint` is what its own screen shows for the same key.
 */
export interface PendingKey {
  id: string;
  label: string;
  fingerprint: string;
  via: "relay" | "address";
  redeemed_at: string;
  slots: { used: number; of: number };
}
/** every device waiting for this PC's screen, after each change; to streams that may drive (approving stays on the screen) */
export interface PendingRedemptionsEvent { type: "pending-redemptions"; pending: PendingKey[] }
/** every relay pairing waiting for approval, after each change; only to the PC's own windows that may approve one */
export interface RelayPairingsEvent { type: "relay-pairings"; pairings: RelayPairingRequest[] }
/** every relay pairing waiting for approval, after each change; only to drive account members connected through the relay */
export interface RemotePairingsEvent { type: "remote-pairings"; pairings: RemotePairingRequest[] }
/**
 * `security`: authenticated requests only, absent from an older server (shared/protocol.ts SecuritySummary).
 * `web_ui.boot_id`: this server lifetime's id, as in the full health answer. `runtime`: the runtime it
 * serves. `accepted`: its launcher took it as its own past the startup check (absent when no launcher
 * runs it). All three absent from older servers.
 */
/**
 * `own_window`: this request came from this PC's own window (its screen, loopback and not forwarded), with the port this
 * server listens on; absent for every other window and from older servers.
 */
export interface BridgeHealth { ok: true; auth: HealthAuth; bridge_protocol: number; own_window?: { port: number }; security?: SecuritySummary; web_ui?: { boot_id: string }; runtime?: RuntimeName; accepted?: boolean; /** a driving owner only, as on the whole answer */ herdr_runtime?: HerdrRuntimeFacts }
export interface BridgeIdentity {
  /** Only on an authenticated /api/bridge?discover=herdr request. */
  found_herdr_sessions?: FoundHerdrSession[];
  pid: number;
  managed_remote: boolean;
  bridge_protocol: number;
  bundle_version: string;
  socket_path: string;
  socket_id: string;
  herdr: HerdrIdentity;
}

export function paneStorageId(machineId: string, paneId: string): string {
  return machineId === LOCAL_MACHINE ? paneId : `remote:${encodeURIComponent(machineId)}:${encodeURIComponent(paneId)}`;
}
export function machinePath(machineId: string, path: string): string {
  return machineId === LOCAL_MACHINE ? `/api/${path}` : `/api/machines/${encodeURIComponent(machineId)}/${path}`;
}
