import type { AgentRowTokens } from "./pane-tokens.ts";
import type { SharedPreferences } from "./preferences.ts";
import type { HealthAuth, SecuritySummary, ServerMessage, SessionSnapshot } from "./protocol.ts";
import type { SeenFinish } from "./seen.ts";

export const LOCAL_MACHINE = "local";
export const BRIDGE_PROTOCOL = 1;
export const REMOTE_BUNDLE_VERSION = "41";
export interface PaneTarget { machine_id: string; pane_id: string }
export type MachineState = "connecting" | "connected" | "reconnecting" | "disconnected" | "error";
export interface SshTarget {
  destination: string;
  port?: number;
  identity_file?: string;
  session?: string;
}
export interface Machine {
  /** Read-only identity inherited from the local herdr catalog. */
  herdr_profile_id?: string;
  id: string;
  name: string;
  kind: "local" | "ssh" | "relay";
  target?: SshTarget;
  /** a PC added through the Ovis relay (no SSH): its relay ID and the relay it is reached through */
  relay?: { server_id: string; relay: string };
  enabled: boolean;
  state: MachineState;
  error: string | null;
  /** Attention needed; windows_login retries, windows_start_failed waits for a startup decision. */
  action_required?: MachineAction | null;
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
/**
 * How a PC's error starts while its own Ovis is offered an update it can run (server/machines.ts ownUpdateOffered).
 * Any other error beside that offer says why its last update failed, and the card shows it.
 */
export const OWN_UPDATE_OFFER = "This PC runs its own Ovis";
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
   * workspaces, tabs or splits of its own: reordering, zoom, swap, resize and worktrees are never
   * offered there, and the rest only as `layout` says. Absent: herdr's TUI server.
   */
  runtime?: "herdr-core";
  /** herdr-core only: which layout calls it answers (HerdrCoreLayout); absent, none */
  layout?: HerdrCoreLayout;
}

/**
 * What a herdr-core PC lets Ovis do with its workspaces, tabs and splits. On a core no Herdr app
 * arranges (its `herdr-app` document was never written, as on the desktop app's own core) Ovis keeps
 * them in terminal labels: it renames workspaces and tabs and moves a one-pane tab to another
 * workspace. It splits no pane yet (`split` stays false). Where the Herdr app arranges them, they are
 * the app's, and none is offered.
 */
export interface HerdrCoreLayout {
  rename: boolean;
  split: boolean;
  move: boolean;
}
/** where this server's runtime came from: OVIS_RUNTIME, the choice saved from Settings, or what the PC has */
export type RuntimeSource = "env" | "saved" | "detected";
/** why Settings cannot switch the runtime: OVIS_RUNTIME decides, the server was not started by Ovis's launcher, or herdr-core is not served on this OS */
export type RuntimeLock = "env" | "unmanaged" | "platform";
/**
 * Which runtime this server serves and what Settings may switch it to (GET /api/health, a driving
 * owner only). `switch_to`: the other runtime when this PC has it and nothing locks the choice.
 * `fallback`: the saved choice was herdr-core, but no herdr-core answered, so herdr is served.
 */
export interface HerdrRuntimeFacts {
  serving: "herdr" | "herdr-core";
  source: RuntimeSource;
  tui: { installed: boolean; running: boolean };
  app_installed: boolean;
  switch_to: "herdr" | "herdr-core" | null;
  locked: RuntimeLock | null;
  fallback?: "no_herdr_core";
}
/**
 * What this PC has of herdr-core, the Herdr app's runtime, whichever runtime the server serves
 * (GET /api/health, authenticated only). `version`: the hc the server found and would run
 * (server/herdr-core/discovery.ts), null when none answers as hc. `running`: the core's socket file
 * is there for `session`; nothing connects to it, since any hc command but `--version` starts a core.
 * `session` is null when HC_SESSION is not a plain name (hc refuses such names), so no path is told.
 */
export interface HerdrCoreFacts {
  version: string | null;
  session: string | null;
  running: boolean;
}
export type MachineAction = "connect" | "update_bridge" | "setup" | "bridge_conflict" | "windows_login" | "windows_start_failed";
/** `ovis`: the PC's own Ovis updates itself (Machine.remote_ovis); absent for a bridge this app installs */
export interface MachineUpdate { job_id: string; step: string; progress: SetupProgress | null; ovis?: boolean }
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
export interface SetupRequest extends SshTarget { name?: string; machine_id?: string; update_remote?: boolean }
export type SetupPhase = "connecting" | "authentication" | "checking" | "approval" | "installing" | "starting" | "connected" | "failed" | "cancelled";
export interface SetupChallenge { id: string; kind: "host_key" | "secret"; prompt: string }
export interface SetupJob {
  id: string;
  machine_id: string;
  phase: SetupPhase;
  step: string;
  challenge: SetupChallenge | null;
  installations: string[];
  error: string | null;
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
}
export type SetupAction = { action: "answer"; challenge_id: string; answer: string } | { action: "approve" } | { action: "cancel" } | { action: "start_headless" };
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
}
/** `preferences`: what every browser of this server shares changed (shared/preferences.ts) */
export type MachineEvent = { type: "machines"; machines: Machine[] } | { type: "machine-message"; machine_id: string; message: ServerMessage }
  | { type: "preferences"; preferences: SharedPreferences }
  /** the `$name` tokens herdr's `[ui.sidebar.agents]` rows draw on this server's PC, for every PC's agent rows (server/herdr-sidebar.ts) */
  | { type: "herdr-sidebar"; agents: AgentRowTokens | null }
  /** finishes a browser of this server presented (shared/seen.ts): every record when the stream opens, then each change */
  | { type: "seen"; finishes: SeenFinish[] }
  | DevicePairedEvent;
/** `security`: authenticated requests only, absent from an older server (shared/protocol.ts SecuritySummary) */
/**
 * `web_ui.boot_id`: this server lifetime's id, as in the full health answer. `runtime`: the runtime it
 * serves. `accepted`: its launcher took it as its own past the startup check (absent when no launcher
 * runs it). All three absent from older servers.
 */
export interface BridgeHealth { ok: true; auth: HealthAuth; bridge_protocol: number; security?: SecuritySummary; web_ui?: { boot_id: string }; runtime?: "herdr" | "herdr-core"; accepted?: boolean; /** a driving owner only, as on the whole answer */ herdr_runtime?: HerdrRuntimeFacts }
export interface BridgeIdentity {
  pid: number;
  managed_remote: boolean;
  bridge_protocol: number;
  bundle_version: string;
  socket_path: string;
  socket_id: string;
  herdr: HerdrIdentity;
}

/** Local storage keeps its historical keys; remote IDs occupy a separate namespace. */
export function paneStorageId(machineId: string, paneId: string): string {
  return machineId === LOCAL_MACHINE ? paneId : `remote:${encodeURIComponent(machineId)}:${encodeURIComponent(paneId)}`;
}
export function machinePath(machineId: string, path: string): string {
  return machineId === LOCAL_MACHINE ? `/api/${path}` : `/api/machines/${encodeURIComponent(machineId)}/${path}`;
}
