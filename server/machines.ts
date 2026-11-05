import { authenticatedWebSocket } from "./remote-websocket.ts";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as tcpServer } from "node:net";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { BRIDGE_PROTOCOL, LOCAL_MACHINE, OWN_UPDATE_OFFER, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type RemoteOvis, type Machine, type MachineAction, type MachineEvent, type MachineSettings, type SetupAction, type SetupJob, type SetupProgress, type SetupRequest, type SshTarget } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot, HerdrPane } from "../shared/protocol.ts";
import type { PushService } from "./push.ts";
import { alertStatus } from "../shared/notify-policy.ts";
import type { BridgeDescriptor } from "./bridge.ts";
import { HerdrError, sessionSnapshot } from "./herdr/client.ts";
import { ConnectionDiagnostics, transportFailureCode } from "./connection-diagnostics.ts";
import { FinishEpochLedger } from "./finish-epoch-ledger.ts";
import { labelOmoPanes } from "./conversation.ts";
import type { CompletionTracker } from "./completion.ts";
import { HerdrProfileState, herdrMachineId } from "./herdr-profile-state.ts";
import { sameSshSession, type HerdrMachineProfile } from "./herdr-profiles.ts";
import { validateTarget } from "./machine-security.ts";
import { writePrivateState } from "./private-state.ts";
import { holdsDocument, readStateDocument, setAsideDamaged } from "./state-document.ts";
import { detectHost, HERDR_INSTALL_CMD, installLockOwner, type RemoteHost } from "./remote-host.ts";
import { REVISION, type UpdateStatus } from "../shared/update.ts";
import { discard, readCappedJson, REMOTE_LIMITS } from "./remote-json.ts";
import { SshConnection, sshClient } from "./ssh.ts";
import { WAITING_FOR_WINDOWS_LOGIN } from "./windows-herdr-start.ts";
import { decodeOffer, SERVER_ID_PATTERN, isWssOrigin, type RelayOffer } from "../shared/relay-offer.ts";
import type { RelaySocket } from "../shared/relay-channel.ts";
import { openRelayPcTunnel, RelayPcKey, RelayPcRefused, relayPcLabel, removeRelayPcKey, type RelayPcTunnel } from "./relay-pc.ts";

type StoredMachine = { id: string; name: string; enabled: boolean; snapshot?: SessionSnapshot | null }
  & ({ kind?: "ssh"; target: SshTarget } | { kind: "relay"; relay: NonNullable<Machine["relay"]> });
interface Runtime {
  machine: Machine;
  ssh?: SshConnection;
  /** a PC added through the relay: its connection and loopback forward (server/relay-pc.ts) */
  tunnel?: RelayPcTunnel;
  endpoint?: { url: string; token: string };
  observer?: WebSocket;
  /** set only while the PC waits out its delay before the next try (retryLater) */
  retry?: ReturnType<typeof setTimeout>;
  /** when the last try to connect started, on the manager's monotonic clock */
  triedAt?: number;
  poll?: ReturnType<typeof setInterval>;
  abort?: AbortController;
  attempts: number;
  generation: number;
  refreshing: boolean;
  refreshQueued: boolean;
  snapshotRevision: number;
  terminals: Set<() => void>;
  /** the remote server's order epoch its own /api/health proved over this connection; cleared with the connection */
  acceptedEpoch?: string;
  /** a full snapshot of another epoch than the proven one, held back until health says which server answers */
  candidate?: SessionSnapshot;
  /** the held snapshot's finish epoch as its server read it, before any status was laid over it */
  candidateRun?: string;
  /** this PC's one health call in flight (sourceCheck) */
  verification?: SourceCheck;
  /** the user cancelled this PC's bridge update: it is not started again on its own until the PC connects */
  updateCancelled?: boolean;
  /**
   * The SSH address (destination, port, session) whose socket the PC's own Ovis (an independently managed web
   * server) serves, as that PC last showed it: while none runs there, the PC waits for that server instead of
   * starting this app's bridge (prepare). A server that stops removes its descriptor, so this is all that tells a
   * restarting one from a PC without a bridge. Another address, set up in the PC's dialog, is not told by it.
   */
  ownOvisAt?: SshTarget;
  /**
   * What a setup at another SSH address learns there (its herdr, its first snapshot, whose server it is; null: this
   * app's bridge), kept off the PC until that setup connects there, when the PC takes it with that address (setup).
   * Ends with the connection (disconnect): a cancelled, failed or superseded setup leaves the PC as it was (#2075).
   */
  move?: { herdr?: Machine["herdr"]; snapshot?: SessionSnapshot; snapshotServer?: string; ownOvisAt?: SshTarget | null };
  /** which of the PC's herdr runs this server knows have ended (finishEnded) */
  finishes: FinishEpochLedger;
}
interface JobState {
  update: boolean;
  /** Explicit consent for the next Windows cold-start attempt only. Never persisted. */
  headlessStart?: boolean;
  timedOut?: boolean;
  installationApproved?: boolean;
  /** started by the server for a PC whose bridge is out of date: key-only SSH, approval already given */
  auto: boolean;
  public: SetupJob;
  abort: AbortController;
  pending?: { resolve(value: string): void; reject(error: Error): void };
  ssh?: SshConnection;
  timer: ReturnType<typeof setTimeout>;
  /** the registered PC a bridge update is for, which shows it as `updating` */
  runtime?: Runtime;
  /** the PC's own Ovis updates itself in this job, asked by it (MachineManager.runOwnUpdate) */
  own?: boolean;
  stageStartedAt: number;
  finished: Promise<void>;
}
const DEFAULT_SETTINGS: MachineSettings = { auto_update_bridges: true };
const RELAY_PC_UPDATES = "A PC added through the relay runs its own Ovis: update it on that PC.";
/** the shortest time between the starts of two health calls that prove one PC's server (sourceCheck) */
export const SOURCE_CHECK_INTERVAL_MS = 1000;
/** the shortest time between the starts of two tries to connect that a request cuts short (retryNow) */
export const DEMANDED_RETRY_INTERVAL_MS = 5000;
interface SourceCheck { token: number; promise: Promise<string | null>; abort: AbortController }
/** a verify_source_boot answer: the proved boot id, or why there is none */
export type SourceProof = { boot_id: string } | { refused: "unknown" | "interval" | "unverified" };

/**
 * A full snapshot that may not replace a cached one of the same order epoch: it was read before that
 * one (shared/protocol.ts). Snapshots of different epochs, or without evidence, are not compared.
 */
export function olderOrderRead(cached: SessionSnapshot | null | undefined, incoming: SessionSnapshot): boolean {
  return !!cached && typeof cached.order_epoch === "string" && cached.order_epoch === incoming.order_epoch
    && Number.isSafeInteger(cached.read_seq) && Number.isSafeInteger(incoming.read_seq) && incoming.read_seq! < cached.read_seq!;
}

/** The step a job shows between an approve/answer and the next stage() the setup reaches. */
export function actionStep(action: "approve" | "answer"): string {
  return action === "approve" ? "Installing on this PC…" : "Connecting with SSH keys and ssh-agent…";
}

/**
 * Why a bridge refused verification, read from its error envelope. Only the code is trusted:
 * the bridge's own message carries paths of that PC and is never shown.
 */
function verificationFailure(status: number, body: unknown): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  // a bridge older than `socket_missing` answers a missing socket with 500 internal_error and stat's ENOENT
  if (error?.code === "socket_missing" || error?.code === "internal_error" && typeof error.message === "string" && error.message.startsWith("ENOENT")) return "herdr is not running for this session on the PC (its socket is missing). Start herdr there, then reconnect.";
  if (error?.code === "connect_failed") return "herdr is not answering on the PC (its socket is there, but nothing listens). Restart herdr there, then reconnect.";
  return `Bridge verification failed (${status}). Reconnect after checking the remote bridge.`;
}

/** how long verifying a bridge waits for its answer through the tunnel */
const BRIDGE_ANSWER_MS = 15_000;
/**
 * What the person adding the PC is told when the request through the standing tunnel to its bridge
 * fails (#1960): ssh resets the connection when nothing listens on the PC's 127.0.0.1 at that port,
 * as with an Ovis older than this fix that runs with HOST set to another address.
 */
function bridgeUnreachable(descriptor: BridgeDescriptor, error: unknown): string {
  const at = `127.0.0.1:${descriptor.port}`;
  if (descriptor.managed_remote) return `The bridge on this PC does not answer at ${at} through SSH. Reconnect after checking the remote bridge.`;
  if ((error as Error | null)?.name === "TimeoutError") return `This PC's Ovis did not answer at ${at} through SSH within ${BRIDGE_ANSWER_MS / 1000} seconds. Reconnect after checking that it runs.`;
  return `This PC's Ovis does not answer at ${at} through SSH. If it runs with HOST set to another address, update it or set HOST=127.0.0.1 there, restart it, then add the PC again.`;
}

async function freePort(): Promise<number> {
  const server = tcpServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A bundle newer than this app's: never this app's to replace, whichever app started it. */
function newerBundle(version: unknown): boolean {
  return typeof version === "string" && /^\d+$/.test(version) && Number(version) > Number(REMOTE_BUNDLE_VERSION);
}
/**
 * ssh's refusals: the PC answered, and only a password or a new host key gets past them. The
 * remote denial reads "user@host: Permission denied (publickey,…)."; a local key file ssh cannot
 * read ("Identity file … not accessible: Permission denied.") is only a warning before it connects.
 */
const SSH_REFUSED = /Permission denied \(|Host key verification failed|IDENTIFICATION HAS CHANGED|Too many authentication failures/i;
const newerBridge = (version: string): string => `This PC uses a newer bridge (v${version}); this app requires v${REMOTE_BUNDLE_VERSION}. Update this app, then reconnect. The remote bridge was left running.`;
/**
 * An independently managed web server (Ovis run on that PC, not a bridge this app started) is never
 * this app's to update. Whichever side is behind is the one to update: that server through its own
 * Settings, or this app when that server is the newer one.
 */
const independentBridge = (version: string): string => newerBundle(version)
  ? `This socket uses an independently managed web server of a newer version (v${version}); this app requires v${REMOTE_BUNDLE_VERSION}. Update this app in Settings → Updates, then reconnect; that server was left running.`
  : "This socket uses an independently managed web server. Update it through its own Settings, then reconnect; it was left running.";

/** how long an update of a PC's own Ovis may take until it answers on its new version: its updater downloads, installs dependencies, typechecks and builds */
export const OWN_UPDATE_MS = 15 * 60_000;
/** how often that update looks at the PC while it runs */
const OWN_UPDATE_POLL_MS = 2000;
/** how long a PC's own Ovis may stay idle after it was asked to update before the update counts as never started */
export const OWN_UPDATE_START_MS = 60_000;
/** the steps a PC's own updater names (shared/update.ts UPDATE_STEPS), in the words its progress shows */
const OWN_UPDATE_STEPS: Record<string, string> = { download: "downloading", dependencies: "installing dependencies", typecheck: "type-checking", build: "building", restart: "restarting" };
/** an install of its update runs there; a check for releases (its own, every 5 minutes) is not one */
const ownInstallRunning = (status: Partial<Pick<UpdateStatus, "phase">> | null): boolean => status?.phase === "building" || status?.phase === "restarting";
/** how long a check for releases there is waited out before its status is taken as it stands */
const OWN_CHECK_WAIT_MS = 30_000;
/** a check for releases that outlasts that wait: news soon, so the PC tries again on its own */
const OWN_CHECK_RUNNING = "That PC's Ovis is still checking for updates; this PC tries again shortly.";
/**
 * The PC's own Ovis is not running (it restarts, updates itself, crashed, or its PC rebooted): it comes back by
 * itself, so the PC tries again as one that cannot be reached does (#2047)
 */
const OWN_OVIS_AWAY = "This PC's own Ovis is not running; this PC tries again until it is back. If it stays away, start it on that PC.";
/** the host an SSH destination names, without its user: where that PC's own Ovis is opened */
function sshHost(destination: string): string { return destination.slice(destination.lastIndexOf("@") + 1); }
/** a release version as a PC's updater tells it (`0.4.18`), or null */
const releaseVersion = (value: unknown): string | null => typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value) ? value : null;
/** another PC's own words, kept to one short line */
const remoteWords = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\s+/g, " ").slice(0, 300) : null;
/** An independently managed web server older than this app, which can install its own update: updating this PC asks it to. */
const ownUpdateOffered = (offer: RemoteOvis): string => `${OWN_UPDATE_OFFER}${offer.version ? ` v${offer.version}` : ""}, older than this app. Update it${offer.latest_version ? ` to v${offer.latest_version}` : ""} to reconnect; it updates itself, and herdr sessions keep running.`;
/** One that cannot: today's words, and why not. */
const ownUpdateRefused = (offer: RemoteOvis): string => `${independentBridge(REMOTE_BUNDLE_VERSION)} It cannot be updated from here: ${offer.reason}`;

/** A connection that retrying cannot fix: the PC waits for the user instead of reconnecting. */
export class MachineActionRequired extends Error {
  /** `newerServer`: the server that answered is newer than this app, as its own identity proved (verify) */
  constructor(message: string, readonly action: MachineAction, readonly newerServer = false) { super(message); }
}


/**
 * Which agent each pane runs, as a status collector heard it, and whether a report of it is news:
 * an agent named anew, or another one. A pane first heard of as a shell is not: the roster's own
 * read of it showed as much. The roster is read on a timer and patched by status frames, which
 * name no agent, so news is the one cue to read it again at once (#537, #555).
 */
export class AgentNews {
  private heard = new Map<string, string | null>();
  hear(panes: readonly Pick<HerdrPane, "pane_id" | "agent">[]): boolean {
    let news = false;
    for (const pane of panes) {
      const agent = pane.agent ?? null;
      const before = this.heard.get(pane.pane_id);
      this.heard.set(pane.pane_id, agent);
      if (before !== agent && !(before === undefined && agent === null)) news = true;
    }
    return news;
  }
  /** a pane that ended: its id used again is a pane heard of for the first time */
  forget(paneId: string): void { this.heard.delete(paneId); }
  /** only the panes a roster still lists */
  keepOnly(panes: readonly Pick<HerdrPane, "pane_id">[]): void {
    const open = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of [...this.heard.keys()]) if (!open.has(paneId)) this.heard.delete(paneId);
  }
}

/**
 * A bridge's part (createServer without `machines`): its connection server reads this PC's roster
 * again on every pane-status, pane-exited and session-changed frame (MachineManager.observe), so an
 * agent named in a status event reaches it with that event's frame. An agent first seen in a
 * snapshot the status collector reconciles from has no frame behind it: `tell` sends one (#555).
 * A reconcile leaves out panes heard of since its snapshot was asked for, so it never prunes.
 */
export function bridgeAgentNews(tell: () => void) {
  const news = new AgentNews();
  return {
    status(panes: readonly Pick<HerdrPane, "pane_id" | "agent">[]): void { news.hear(panes); },
    reconciled(panes: readonly Pick<HerdrPane, "pane_id" | "agent">[]): void { if (news.hear(panes)) tell(); },
    ended(paneId: string): void { news.forget(paneId); },
  };
}

export class MachineManager {
  private machines = new Map<string, Runtime>();
  private jobs = new Map<string, JobState>();
  private listeners = new Set<(event: MachineEvent) => void>();
  private stopped = false;
  private localBusy = false;
  private localRefreshQueued = false;
  private localRevision = 0;
  private localTimeouts = 0;
  /** each local pane's agent as herdr last named it to the status collector */
  private heardAgents = new AgentNews();
  private localTimer: ReturnType<typeof setInterval>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private profileState: HerdrProfileState;
  private statePath: string;
  /** machines.json as this manager last wrote it (persist) */
  private written: string | undefined;
  /** the PCs added through the relay, apart from machines.json (constructor) */
  private relayStatePath: string;
  private relayWritten: string | undefined;
  /** the state files that were not JSON at startup, by the name they were moved to (settings) */
  private setAside: string[] = [];
  private sshDir: string;
  private local: Machine = { id: LOCAL_MACHINE, name: hostname(), kind: "local", enabled: true, state: "connecting", error: null, snapshot: null };
  private localFinishes = new FinishEpochLedger();
  private localDiagnostics = new ConnectionDiagnostics("machine.local");
  private remoteDiagnostics = new ConnectionDiagnostics("machine.remote");
  private discoveryTimer?: ReturnType<typeof setTimeout>;
  private discoveryStarted = false;
  private settingsPath: string;
  private preferences: MachineSettings = { ...DEFAULT_SETTINGS };
  /** automatic bridge updates run one at a time: they share one bundle download */
  private autoChain: Promise<void> = Promise.resolve();
  private autoQueued = new Set<string>();
  private emitTimer?: ReturnType<typeof setTimeout>;
  /** this server's own boot id: the local PC's proof, without asking anyone */
  private bootId?: string;
  /** this server's own finish epoch now (server/finishes.ts), when it reads its own herdr (finishEnded) */
  private localFinishEpoch?: () => string;
  /** a monotonic clock for the health calls' start interval; tests pass their own */
  private now: () => number;
  private sourceToken = 0;
  /** each PC's last health-call start, kept across reconnects for as long as this manager lives */
  private sourceStarts = new Map<string, number>();
  /** runOwnUpdate's poll interval and how long it waits for the install to start; tests shorten them */
  private ownUpdatePollMs: number;
  private ownUpdateStartMs: number;
  private ownUpdateCheckMs: number;
  /** how a relay PC's connection reaches the relay; tests point it at a local one */
  private relaySocket?: (url: string) => RelaySocket;

  constructor(readonly stateDir: string, private push: PushService, private completions: CompletionTracker, private readLocal: () => Promise<SessionSnapshot> = () => this.completions.readSnapshot(sessionSnapshot, labelOmoPanes),
    options: { bootId?: string; localFinishEpoch?: () => string; now?: () => number; ownUpdate?: { pollMs?: number; startMs?: number; checkMs?: number }; relaySocket?: (url: string) => RelaySocket } = {}) {
    this.bootId = options.bootId;
    this.relaySocket = options.relaySocket;
    this.localFinishEpoch = options.localFinishEpoch;
    this.ownUpdatePollMs = options.ownUpdate?.pollMs ?? OWN_UPDATE_POLL_MS;
    this.ownUpdateStartMs = options.ownUpdate?.startMs ?? OWN_UPDATE_START_MS;
    this.ownUpdateCheckMs = options.ownUpdate?.checkMs ?? OWN_CHECK_WAIT_MS;
    this.now = options.now ?? (() => performance.now());
    if (this.bootId) this.local.source_boot_id = this.bootId;
    this.profileState = new HerdrProfileState(stateDir);
    this.statePath = join(stateDir, "machines.json");
    this.relayStatePath = join(stateDir, "relay-pcs.json");
    this.sshDir = join(stateDir, "ssh");
    this.settingsPath = join(stateDir, "machine-settings.json");
    try {
      const saved: unknown = JSON.parse(readFileSync(this.settingsPath, "utf8"));
      if (saved && typeof saved === "object" && typeof (saved as MachineSettings).auto_update_bridges === "boolean") this.preferences.auto_update_bridges = (saved as MachineSettings).auto_update_bridges;
    } catch (error) {
      const cause = error instanceof SyntaxError ? "not valid JSON"
        : error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "read failed";
      if (cause !== "ENOENT") console.error(`Cannot read ${this.settingsPath}; remote PC settings start empty`, cause);
    }
    if (this.profileState.setAside !== null) this.setAside.push(basename(this.profileState.setAside));
    // bytes that are not JSON (a crash can leave the file all NULs) are moved aside and the app starts
    // without saved PCs; JSON that is not a list of PCs still refuses to start, so nothing replaces it
    // PCs added through the relay live in a file of their own: a release from before them reads machines.json and
    // refuses one it does not know, so a rollback would not start (docs/development.md, rollback restores code)
    for (const path of [this.statePath, this.relayStatePath]) {
      const relayPcs = path === this.relayStatePath;
      const read = readStateDocument(path);
      if (read.kind === "malformed") {
        const aside = setAsideDamaged(path);
        this.setAside.push(basename(aside));
        console.error(`${path} is not JSON; it was set aside as ${aside}, and the app starts without the PCs added here`);
      }
      if (read.kind === "json") {
        const saved = read.value;
        if (!Array.isArray(saved)) throw new Error(`Invalid ${basename(path)}; registrations were preserved`);
        for (const item of saved as StoredMachine[]) {
          if (!/^[a-f0-9-]{36}$/.test(item.id) || typeof item.name !== "string" || typeof item.enabled !== "boolean") throw new Error("Invalid machine registration");
          const common = { id: item.id, name: item.name, enabled: item.enabled, state: "disconnected" as const, snapshot: item.snapshot ?? null, error: null };
          let machine: Machine;
          if (relayPcs) {
            if (item.kind !== "relay") throw new Error("Invalid machine registration");
            if (typeof item.relay?.server_id !== "string" || !SERVER_ID_PATTERN.test(item.relay.server_id) || typeof item.relay.relay !== "string" || !isWssOrigin(item.relay.relay)) throw new Error("Invalid machine registration");
            machine = { ...common, kind: "relay", relay: { server_id: item.relay.server_id, relay: item.relay.relay } };
          } else if (item.kind === "relay") throw new Error("Invalid machine registration");
          else machine = { ...common, kind: "ssh", target: validateTarget(item.target) };
          const runtime = this.runtime(machine);
          this.machines.set(item.id, runtime);
          if (item.enabled) queueMicrotask(() => void this.reconnect(runtime));
        }
      }
    }
    void this.refreshLocal();
    this.localTimer = setInterval(() => void this.refreshLocal(), 5000);
    this.localTimer.unref();
  }
  /** Serial polling: a broken catalog preserves the last roster instead of removing PCs. */
  watchHerdrProfiles(read: () => Promise<HerdrMachineProfile[]>, intervalMs = 5000): void {
    if (this.discoveryStarted || this.stopped) return;
    this.discoveryStarted = true;
    let failures = 0, previousError: string | undefined, previousSyncError: string | undefined;
    const poll = async () => {
      let profiles: HerdrMachineProfile[] | undefined;
      try {
        profiles = await read();
        failures = 0; previousError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : "read failed";
        if (!this.stopped && previousError !== message) console.error("Saved herdr machines could not be refreshed:", message);
        previousError = message; failures++;
      }
      if (profiles && !this.stopped) {
        try { this.syncHerdrProfiles(profiles); previousSyncError = undefined; }
        catch (error) {
          const message = error instanceof Error ? error.message : "sync failed";
          if (previousSyncError !== message) console.error("Saved herdr machines could not be reconciled:", message);
          previousSyncError = message;
        }
      }
      const delay = Math.min(300_000, intervalMs * 2 ** Math.min(failures, 10));
      if (!this.stopped) { this.discoveryTimer = setTimeout(poll, delay); this.discoveryTimer.unref(); }
    };
    void poll();
  }
  syncHerdrProfiles(profiles: HerdrMachineProfile[]): void {
    if (this.stopped) return;
    const wanted = new Set<string>();
    let changed = false;
    const errors: unknown[] = [];
    for (const profile of profiles) {
      try {
        const id = herdrMachineId(profile.id);
        this.profileState.reconcile(profile.id, profile.target, () => {
          // Stop old authority before fallible cleanup; no setup or reconnect may reuse its key.
          const runtime = this.machines.get(id);
          if (runtime) {
            runtime.machine.enabled = false; this.disconnect(runtime);
            for (const [jobId, job] of this.jobs) if (job.public.machine_id === id) this.cancelJob(jobId);
            this.machines.delete(id);
            this.emit();
          }
          this.removeKey(id);
        });
        // Manual registrations keep their identity and credentials. Exact matches already have a row.
        if (profile.target && [...this.machines.values()].some(({ machine }) => !machine.herdr_profile_id && machine.target && sameSshSession(profile.target!, machine.target))) continue;
        wanted.add(id);
        let runtime = this.machines.get(id);
        const enabled = profile.enabled && !!profile.target;
        const reconnect = !runtime || runtime.machine.enabled !== enabled;
        if (!runtime) {
          runtime = this.runtime({ id, herdr_profile_id: profile.id, name: profile.label, kind: "ssh", target: profile.target ?? undefined, enabled, state: "disconnected", error: null, snapshot: this.profileState.snapshot(profile.id) });
          this.machines.set(id, runtime);
          changed = true;
        } else if (reconnect) {
          this.disconnect(runtime);
          for (const [jobId, job] of this.jobs) if (job.public.machine_id === id) this.cancelJob(jobId);
          changed = true;
        }
        if (runtime.machine.name !== profile.label) { runtime.machine.name = profile.label; changed = true; }
        runtime.machine.enabled = enabled;
        runtime.machine.target = profile.target ?? undefined;
        if (!enabled) {
          runtime.machine.action_required = null;
          runtime.machine.error = profile.target ? "Disabled in herdr" : "This saved herdr machine uses an unsupported SSH address or session.";
        } else if (!this.mayConnect(runtime)) {
          if (reconnect || (!runtime.machine.action_required && runtime.machine.state !== "error")) {
            runtime.machine.action_required = "connect";
            runtime.machine.error = null;
          }
        } else if (reconnect) void this.reconnect(runtime);
      } catch (error) { errors.push(error); }
    }
    for (const [id, runtime] of this.machines) {
      if (!runtime.machine.herdr_profile_id || wanted.has(id)) continue;
      runtime.machine.enabled = false; this.disconnect(runtime);
      for (const [jobId, job] of this.jobs) if (job.public.machine_id === id) this.cancelJob(jobId);
      this.machines.delete(id);
      changed = true;
    }
    if (changed) this.emit();
    try { this.profileState.prune(new Set(profiles.map((p) => p.id)), (profileId) => this.removeKey(herdrMachineId(profileId))); }
    catch (error) { errors.push(error); }
    this.profileState.flush();
    if (errors.length) throw new AggregateError(errors, "Some saved machine keys could not be removed; cleanup will retry");
  }
  private mayConnect(runtime: Runtime): boolean {
    const machine = runtime.machine;
    return !machine.herdr_profile_id || !!machine.target && this.profileState.connectionApproved(machine.herdr_profile_id, machine.target);
  }
  private mayManageBridge(runtime: Runtime): boolean {
    const machine = runtime.machine;
    return !machine.herdr_profile_id || !!machine.target && this.profileState.approved(machine.herdr_profile_id, machine.target);
  }
  private removeKey(id: string): void {
    for (const suffix of ["", ".pub"]) try { unlinkSync(join(this.sshDir, id + suffix)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private runtime(machine: Machine): Runtime { return { machine, attempts: 0, generation: 0, refreshing: false, refreshQueued: false, snapshotRevision: 0, terminals: new Set(), finishes: new FinishEpochLedger(machine.snapshot) }; }
  list(): Machine[] { return [this.local, ...[...this.machines.values()].map((r) => r.machine)]; }
  /**
   * Whether this server knows a PC's herdr run (finish epoch) has ended (server/seen.ts). This server's own PC is in
   * the run its Finishes names now; every other one, an earlier process's included, is over. A remote PC's ledger
   * says (FinishEpochLedger): the epoch its snapshot names is not enough, as a snapshot restored from machines.json
   * can name a run the PC has since left (#1468), and a late read one this server already saw end (#2206). Either
   * would drop the read finishes of the run the PC is in. A PC this server does not hold has no run known to be over.
   */
  finishEnded(pc: string, epoch: string): boolean {
    if (pc === LOCAL_MACHINE) {
      const current = this.localFinishEpoch?.() ?? this.local.snapshot?.finish_epoch;
      return current !== undefined && current !== epoch;
    }
    return this.machines.get(pc)?.finishes.ended(epoch) ?? false;
  }
  subscribe(listener: (event: MachineEvent) => void): () => void {
    this.listeners.add(listener);
    listener({ type: "machines", machines: this.list() });
    return () => this.listeners.delete(listener);
  }
  private emit(event?: MachineEvent): void {
    if (this.stopped) return;
    for (const listener of this.listeners) listener(event ?? { type: "machines", machines: this.list() });
  }
  localMessage(message: ServerMessage): void {
    // a status of a herdr run already seen to end is older than the read that showed it ended: not told, not kept
    if (message.type === "pane-status" && this.localFinishes.stale(message.finish_epoch)) return;
    // Structural invalidations queue a follow-up below without discarding the
    // active read: continuous layout changes must not starve roster publication.
    // Status/exit patches still outrank any snapshot asked for before them.
    if (["pane-status", "pane-exited"].includes(message.type)) {
      this.localRevision++;
      if (this.localBusy) this.localRefreshQueued = true;
    }
    this.emit({ type: "machine-message", machine_id: LOCAL_MACHINE, message });
    // its id used again is a pane heard of for the first time
    if (message.type === "pane-exited") this.heardAgents.forget(message.pane_id);
    if (message.type === "pane-status" && this.local.snapshot) {
      this.local.snapshot = snapshotAfterStatus(this.local.snapshot, message);
      this.localFinishes.hold(message.finish_epoch, this.bootId);
    }
    if (message.type === "session-changed" || message.type === "pane-exited") void this.refreshLocal();
  }
  /**
   * Which agent local panes run, as the status collector heard it: in an event (that pane), or
   * in the snapshot it reconciles from. The roster is read on a timer and patched by status
   * frames, which name no agent, so an agent herdr names anew would show up to 5 s late. A page
   * that opens the pane meanwhile takes it for a shell: it opens the terminal lens, and attaching
   * there fits the shared grid to that page. Read again now.
   */
  localAgents(panes: readonly Pick<HerdrPane, "pane_id" | "agent">[]): void {
    if (this.heardAgents.hear(panes)) void this.refreshLocal();
  }
  async refreshLocal(): Promise<void> {
    if (this.stopped) return;
    if (this.localBusy) { this.localRefreshQueued = true; return; }
    this.localBusy = true;
    try {
      do {
        this.localRefreshQueued = false;
        const revision = this.localRevision;
        const started = performance.now();
        try {
          const snapshot = await this.readLocal();
          if (this.stopped) break;
          this.localTimeouts = 0;
          // A newer event already patched the roster. Never publish this older load.
          if (revision !== this.localRevision) { this.localRefreshQueued = true; continue; }
          this.localDiagnostics.recovered(LOCAL_MACHINE, { operation: "snapshot", elapsed_ms: performance.now() - started });
          // a read that started before the cached one never replaces it
          // nor does one of a herdr run already seen to end; one that started after every status is newer than them
          if (!olderOrderRead(this.local.snapshot, snapshot) && !this.localFinishes.stale(snapshot.finish_epoch)) {
            this.local.snapshot = snapshot;
            this.localFinishes.settle(snapshot);
          }
          this.local.state = "connected"; this.local.error = null;
          // a pane the roster no longer lists is gone: the same id later is a pane heard of anew
          this.heardAgents.keepOnly(snapshot.panes);
        } catch (e) {
          if (this.stopped) break;
          if (revision !== this.localRevision) { this.localRefreshQueued = true; continue; }
          const code = e instanceof HerdrError ? transportFailureCode(e.code) : null;
          this.localDiagnostics.failed(LOCAL_MACHINE, code ?? "refresh_failed", { operation: "snapshot", elapsed_ms: performance.now() - started });
          this.localTimeouts = e instanceof HerdrError && e.code === "timeout" ? this.localTimeouts + 1 : 0;
          // One slow read is not proof that a previously connected herdr is gone. Keep the
          // last roster for one timeout, but report startup and definite transport failures now.
          if (this.local.state !== "connected" || this.local.snapshot === null || this.localTimeouts !== 1) {
            this.local.state = "error"; this.local.error = String(e instanceof Error ? e.message : e);
          }
        }
        this.emit();
      } while (this.localRefreshQueued && !this.stopped);
    } finally { this.localBusy = false; }
  }
  private saveSoon(): void {
    if (this.saveTimer || this.stopped) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; if (!this.stopped) { try { this.persist(); } catch (e) { console.error("PC state could not be saved:", e instanceof Error ? e.message : "write failed"); } } }, 1000);
    this.saveTimer.unref();
  }
  /**
   * The registrations cannot be recomputed, so they are written durably (writePrivateState): a
   * crash after a plain rename can leave the file its old length in NULs. Every refresh of a remote
   * PC saves soon, mostly with the same snapshot, so only a document that differs from the one on
   * disk pays for the write and its fsync.
   */
  private persist(): void {
    const owned = [...this.machines.values()].filter(({ machine }) => !machine.herdr_profile_id).map(({ machine }) => machine);
    const data: StoredMachine[] = owned.filter((m) => m.kind !== "relay").map((m) => ({ id: m.id, name: m.name, target: m.target!, enabled: m.enabled, snapshot: m.snapshot }));
    const relayPcs: StoredMachine[] = owned.filter((m) => m.kind === "relay").map((m) => ({ id: m.id, name: m.name, kind: "relay", relay: m.relay!, enabled: m.enabled, snapshot: m.snapshot }));
    const relayText = JSON.stringify(relayPcs);
    if (relayText !== this.relayWritten || !holdsDocument(this.relayStatePath, relayText)) {
      // never an empty file where none was: an install without relay PCs keeps none
      if (relayPcs.length > 0 || this.relayWritten !== undefined || existsSync(this.relayStatePath)) writePrivateState(this.relayStatePath, relayPcs);
      this.relayWritten = relayText;
    }
    const text = JSON.stringify(data);
    // the PCs' registrations are written last: a save that fails before them leaves them as they were on disk, so a
    // PC moved to another address (setup) is saved there only when nothing else of its save can still fail (#2075)
    for (const { machine } of this.machines.values()) if (machine.herdr_profile_id) this.profileState.saveSnapshot(machine.herdr_profile_id, machine.snapshot);
    this.profileState.flush();
    // the file on disk may have been deleted or replaced since this manager wrote it
    if (text !== this.written || !holdsDocument(this.statePath, text)) { writePrivateState(this.statePath, data); this.written = text; }
  }
  job(id: string): SetupJob | undefined { return this.jobs.get(id)?.public; }
  settings(): MachineSettings { return { ...this.preferences, ...(this.setAside.length > 0 ? { set_aside: [...this.setAside] } : {}) }; }
  updateSettings(patch: Record<string, unknown>): MachineSettings {
    if (patch["auto_update_bridges"] !== undefined) {
      if (typeof patch["auto_update_bridges"] !== "boolean") throw new Error("auto_update_bridges must be boolean");
      this.preferences.auto_update_bridges = patch["auto_update_bridges"];
    }
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = this.settingsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.preferences), { mode: 0o600 });
    renameSync(tmp, this.settingsPath);
    return this.settings();
  }
  /**
   * Update a PC's bridge now, without a dialog: the tap (or the app update) is the approval,
   * and SSH uses the PC's saved key only. A PC that needs a password fails with the reason,
   * and its dialog stays the way in.
   */
  updateBridge(id: string, scheduled = false): SetupJob {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (runtime.machine.kind === "relay") throw new Error(RELAY_PC_UPDATES);
    if (!this.mayConnect(runtime)) throw new MachineActionRequired("Connect this machine first", "connect");
    // A saved herdr machine connected without bridge approval reviews the update in its dialog;
    // an unattended update would also record that approval for later automatic updates.
    if (!this.mayManageBridge(runtime)) throw new MachineActionRequired("Review the bridge update for this machine", "update_bridge");
    // the user's own Update bridge takes back an earlier Cancel; a scheduled one does not
    if (!scheduled) runtime.updateCancelled = false;
    return this.setup({ ...runtime.machine.target!, machine_id: id, update_remote: true }, { auto: true });
  }
  setup(request: SetupRequest, options: { auto?: boolean } = {}): SetupJob {
    if (this.stopped) throw new Error("Server stopping");
    let target = validateTarget(request);
    const existing = request.machine_id ? this.machines.get(request.machine_id) : undefined;
    // a PC saved in herdr is named by its catalog (any length); a name sent with it is not read
    const name = existing?.machine.herdr_profile_id ? undefined : request.name;
    if (name !== undefined && (typeof name !== "string" || name.length > 100)) throw new Error("PC name must be at most 100 characters");
    const waiting = existing && [...this.jobs.values()].find((j) => j.public.machine_id === existing.machine.id && j.public.phase === "starting" && (j.public.action_required === "windows_login" || j.public.action_required === "windows_start_failed"));
    if (waiting && !request.update_remote && sameSshSession(target, waiting.public.target) && target.identity_file === waiting.public.target.identity_file) return waiting.public;
    if ([...this.jobs.values()].filter((j) => !["connected", "failed", "cancelled"].includes(j.public.phase)).length >= 4) throw new Error("Finish or cancel the current connection jobs first");
    if (request.machine_id && !existing) throw new Error("PC not found");
    if (existing?.machine.kind === "relay") throw new Error(RELAY_PC_UPDATES);
    if (existing && [...this.jobs.values()].some((j) => j.public.machine_id === existing.machine.id && !["connected", "failed", "cancelled"].includes(j.public.phase))) throw new Error("A connection job for this PC is already running");
    const id = randomUUID();
    const machineId = existing?.machine.id ?? randomUUID();
    if (existing?.machine.herdr_profile_id && (!existing.machine.enabled || !existing.machine.target || !sameSshSession(target, existing.machine.target))) throw new Error("This PC is managed by herdr; refresh its saved machine before setup");
    if (existing?.machine.herdr_profile_id) {
      if (target.identity_file) throw new Error("SSH connection details are managed by herdr; use the account's SSH config for keys");
      target = { ...existing.machine.target! };
    }
    const auto = options.auto === true && request.update_remote === true && !!existing;
    // A saved PC set up at another SSH address stays at its own until it connects there: that address is the user's to
    // review in this dialog, and a reconnect or an update that asks nobody goes only where the PC is (#2075)
    const moving = !!existing && !sameSshSession(target, existing.machine.target!);
    const resumeRetry = existing?.machine.state === "reconnecting";
    const job: JobState = { update: request.update_remote === true, auto, public: { id, machine_id: machineId, target, phase: "connecting", step: "Connecting with SSH keys and ssh-agent…", challenge: null, installations: [], error: null, ssh_output: null, progress: null }, abort: new AbortController(), timer: setTimeout(() => this.cancelJob(id, true), 600_000), stageStartedAt: Date.now(), finished: Promise.resolve() };
    if (job.update && existing) job.runtime = existing;
    if (job.update && existing && !auto) existing.updateCancelled = false;
    job.timer.unref();
    this.jobs.set(id, job);
    if (this.jobs.size > 40) for (const [key, j] of this.jobs) if (["connected", "failed", "cancelled"].includes(j.public.phase) && key !== id) { this.jobs.delete(key); break; }
    const runtime = existing ?? this.runtime({ id: machineId, name: name?.trim() || target.destination, kind: "ssh", enabled: true, state: "connecting", target, snapshot: null, error: null });
    this.disconnect(runtime);
    // a setup or bridge update is a try to connect too: a failed one waits its interval (retryNow)
    runtime.triedAt = this.now();
    if (moving) runtime.move = {};
    const ssh = new SshConnection(target, this.sshDir, join(this.sshDir, machineId));
    job.ssh = ssh;
    runtime.ssh = ssh;
    runtime.abort = job.abort;
    const generation = ++runtime.generation;
    this.showUpdate(job);
    // ssh's own words reach the dialog while it waits, not only in the error it ends with
    ssh.onOutput = (text) => { if (job.public.phase === "connecting" || job.public.phase === "authentication") job.public.ssh_output = text || null; };
    let reached = false;
    job.finished = (async () => {
      try {
        // an automatic update never asks: a PC that needs a password says so and waits
        await ssh.start(auto ? undefined : (prompt, host) => {
          job.public.phase = "authentication";
          job.public.challenge = { id: randomUUID(), kind: host ? "host_key" : "secret", prompt };
          job.public.step = host ? "Verify the server fingerprint" : "SSH authentication required";
          return this.wait(job);
        });
        reached = true;
        this.stage(job, "checking", "Checking the remote environment…");
        await this.prepare(runtime, job);
        if (job.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
        runtime.machine.enabled = true;
        this.machines.set(machineId, runtime);
        await this.observe(runtime);
        if (job.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
        // connected there: the PC moves to the address it was set up at, with what this setup learnt there. A move is
        // all or nothing: one that cannot be completed or saved leaves the PC as it was, trying its own address (#2075)
        const move = runtime.move;
        runtime.move = undefined;
        const left = { target: runtime.machine.target, error: runtime.machine.error, herdr: runtime.machine.herdr, snapshot: runtime.machine.snapshot, ownOvisAt: runtime.ownOvisAt, finishes: runtime.finishes.copy() };
        try {
          runtime.machine.target = target;
          if (move) {
            // what went wrong at the address it left is not this one's: a read there clears it as any read does
            runtime.machine.error = null;
            if (move.herdr) runtime.machine.herdr = move.herdr;
            if (move.ownOvisAt === null) delete runtime.ownOvisAt; else if (move.ownOvisAt) runtime.ownOvisAt = move.ownOvisAt;
            // a roster of the address it left is not this one's: until one read here is taken (one held for this
            // server's health is published once that proves it), the PC has none, on its card or on disk (#2080)
            if (move.snapshot) this.publish(runtime, move.snapshot, false, move.snapshotServer); else runtime.machine.snapshot = null;
          }
          if (runtime.machine.herdr_profile_id) {
            this.profileState.allowConnection(runtime.machine.herdr_profile_id, target);
            if (job.installationApproved) this.profileState.approve(runtime.machine.herdr_profile_id, target);
          }
          this.persist();
        } catch (error) {
          if (move) {
            Object.assign(runtime.machine, { target: left.target, error: left.error, herdr: left.herdr, snapshot: left.snapshot });
            if (left.ownOvisAt) runtime.ownOvisAt = left.ownOvisAt; else delete runtime.ownOvisAt;
            runtime.finishes = left.finishes;
          }
          throw error;
        }
        this.stage(job, "connected", "Connected");
        this.emit();
      } catch (e) {
        const ownsRuntime = runtime.generation === generation;
        if (ownsRuntime && !this.stopped && !job.abort.signal.aborted && job.public.phase !== "cancelled") {
          this.remoteDiagnostics.failed(machineId, e instanceof MachineActionRequired ? "action_required" : "connection_lost", { operation: "bridge", machine_id: machineId });
        }
        const error = e instanceof Error ? e.message : String(e);
        // an update of a registered PC that could not reach it (switched off, asleep, off the
        // network, or gone in the middle) learned nothing about its bridge: the PC waits as
        // offline, and the version check runs again once it answers. Read before disconnect
        // closes the connection.
        // A PC whose own Ovis is away, or still checking for releases, waits the same way: both end by themselves.
        const unreachable = ownsRuntime && job.update && !!existing && !(e instanceof MachineActionRequired)
          && (error === OWN_OVIS_AWAY || error === OWN_CHECK_RUNNING || (reached ? !ssh.connected() : !SSH_REFUSED.test(error)));
        if (ownsRuntime) this.disconnect(runtime);
        // An interrupted setup says nothing about the bridge: restore a saved PC's retries.
        // Only explicit cancellation suppresses automatic updates; a deadline is not a refusal.
        // A setup at another SSH address that did not connect there leaves the PC as it was, trying its own address
        // again when it is enabled: what that setup met there is not this PC's, and its dialog says how it ended (#2075).
        if (job.public.phase === "cancelled" || job.timedOut) {
          if (ownsRuntime && !moving && runtime.machine.action_required === "windows_start_failed") { runtime.machine.state = "error"; this.emit(); }
          else if (ownsRuntime && (job.update || moving || resumeRetry || runtime.machine.action_required === "windows_login") && existing && runtime.machine.enabled && !this.stopped) {
            runtime.machine.error = null; runtime.machine.action_required = null;
            if (job.update && !moving && !job.timedOut) runtime.updateCancelled = true;
            this.retryLater(runtime);
          }
          else if (ownsRuntime && runtime.machine.action_required === "windows_login") { runtime.machine.action_required = null; runtime.machine.error = null; this.emit(); }
        } else {
          job.public.phase = "failed"; job.public.step = "Connection failed";
          job.public.error = error;
          if (moving) { if (ownsRuntime && runtime.machine.enabled && !this.stopped) { runtime.machine.error = null; runtime.machine.action_required = null; this.retryLater(runtime); } }
          else if (ownsRuntime && existing && runtime.machine.enabled && !this.stopped && e instanceof MachineActionRequired && e.action === "windows_login") { runtime.machine.error = error; runtime.machine.action_required = e.action; this.retryLater(runtime); }
          else if (ownsRuntime && existing && runtime.machine.enabled && !this.stopped && !(e instanceof MachineActionRequired) && (unreachable || resumeRetry || runtime.machine.action_required === "windows_login")) { runtime.machine.error = error; runtime.machine.action_required = null; this.retryLater(runtime); }
          // a failed bridge update on a PC that answered keeps its button: the bridge is still
          // out of date, and the error says why this attempt failed (a password needed, …)
          else if (ownsRuntime) { runtime.machine.state = "error"; runtime.machine.error = error; runtime.machine.action_required = e instanceof MachineActionRequired ? e.action : job.update && existing ? "update_bridge" : null; }
          // the dialog reads the job, not the PC: a first connect that failed on the version
          // check has no machine to carry action_required, and an interrupted update keeps
          // offering itself even when the PC was never registered
          job.public.action_required = e instanceof MachineActionRequired ? e.action : job.update ? "update_bridge" : null;
          this.emit();
        }
      } finally {
        clearTimeout(job.timer); job.public.challenge = null; job.public.ssh_output = null; job.pending = undefined; job.ssh = undefined;
        if (job.runtime) { job.runtime.machine.updating = null; this.emit(); }
      }
    })();
    return job.public;
  }
  private stage(job: JobState, phase: SetupJob["phase"], step: string): void {
    if (job.abort.signal.aborted) throw new Error("Setup cancelled");
    job.public.phase = phase; job.public.step = step; job.public.challenge = null; job.public.ssh_output = null;
    // approved: from here on the install's own timeouts apply, not the setup's 10 minutes
    if (phase === "installing") clearTimeout(job.timer);
    // byte progress belongs to the stage that reported it: a step without its own bytes (the SSH
    // key registration after a bundle install, a first bridge start) shows its own text instead
    job.public.progress = null;
    this.showUpdate(job);
  }
  /** A stage's bytes so far; a new stage restarts the clock its rate is measured on. */
  private progress(job: JobState, stage: SetupProgress["stage"], done: number, total: number | null): void {
    const now = Date.now();
    if (job.public.progress?.stage !== stage) job.stageStartedAt = now;
    const elapsed = now - job.stageStartedAt;
    job.public.progress = { stage, done, total, rate: elapsed >= 500 && done > 0 ? Math.round(done / (elapsed / 1000)) : null, elapsed_ms: elapsed };
    this.showUpdate(job);
  }
  /** Mirror a bridge update onto its PC, so the sidebar and header show it without the dialog. */
  private showUpdate(job: JobState): void {
    if (!job.runtime) return;
    job.runtime.machine.updating = { job_id: job.public.id, step: job.public.step, progress: job.public.progress ?? null, ...(job.own ? { ovis: true } : {}) };
    // progress arrives per chunk: a few events a second are plenty
    if (!this.emitTimer) { this.emitTimer = setTimeout(() => { this.emitTimer = undefined; this.emit(); }, 250); this.emitTimer.unref(); }
  }
  private wait(job: JobState): Promise<string> {
    if (job.abort.signal.aborted) return Promise.reject(new Error("Setup cancelled"));
    return new Promise((resolve, reject) => { job.pending = { resolve, reject }; });
  }
  action(id: string, action: SetupAction): void {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Setup job not found");
    if (action.action === "cancel") { this.cancelJob(id); return; }
    if (action.action === "start_headless") {
      if (job.abort.signal.aborted || job.public.phase !== "starting" || (job.public.action_required !== "windows_login" && job.public.action_required !== "windows_start_failed")) throw new Error("This PC is not waiting for Windows sign-in");
      job.public.action_required = null;
      job.public.step = "Starting without Windows sign-in…";
      job.headlessStart = true;
      return;
    }
    if (!job.pending) throw new Error("This setup step has already changed");
    if (action.action === "approve") {
      if (job.public.phase !== "approval") throw new Error("No installation is awaiting approval");
    } else if (action.action === "answer") {
      if (!job.public.challenge || action.challenge_id !== job.public.challenge.id) throw new Error("SSH question changed; read it again");
      if (typeof action.answer !== "string" || action.answer.length > 4096 || /[\r\n\0]/.test(action.answer)) throw new Error("Invalid SSH response");
      if (job.public.challenge.kind === "host_key" && !["yes", "no"].includes(action.answer)) throw new Error("Confirm or reject the fingerprint");
    } else throw new Error("Unknown setup action");
    const pending = job.pending;
    job.pending = undefined; job.public.challenge = null;
    // the step moves with the phase right here: the response to this request is serialized
    // before prepare resumes, and must not still carry the question that was just answered
    job.public.phase = action.action === "approve" ? "installing" : "connecting";
    job.public.step = actionStep(action.action);
    pending.resolve(action.action === "answer" ? action.answer : "approved");
  }
  private cancelJob(id: string, timedOut = false): void {
    const job = this.jobs.get(id);
    if (!job || ["connected", "failed", "cancelled"].includes(job.public.phase)) return;
    job.timedOut = timedOut;
    job.public.phase = timedOut ? "failed" : "cancelled"; job.public.step = timedOut ? "Connection timed out" : "Cancelled"; job.public.challenge = null; job.public.ssh_output = null;
    if (timedOut) job.public.error = "Connection timed out";
    job.public.action_required = null; job.headlessStart = false;
    job.abort.abort(); job.pending?.reject(new Error("Setup cancelled")); job.pending = undefined;
    job.ssh?.close(); clearTimeout(job.timer);
  }
  private async prepare(runtime: Runtime, job?: JobState): Promise<void> {
    const generation = runtime.generation;
    const ssh = runtime.ssh!;
    // a setup tries the address its dialog was given, which the PC takes only once it connects there (setup)
    const target = job?.public.target ?? runtime.machine.target!;
    const session = target.session;
    // at an address the PC is not at yet, what this try learns is kept apart (Runtime.move) and its offer goes only
    // to the job its dialog reads: the PC keeps its own until it connects there
    const moving = !!job && !sameSshSession(target, runtime.machine.target!);
    // only this try, at this address, tells whose server the PC runs: a cancelled or superseded one (another
    // connection, or its dialog moving the PC to another address, since it looked) writes nothing
    const learnServer = (seen: Pick<BridgeDescriptor, "managed_remote">, verified = false) => {
      if (runtime.generation !== generation || job?.abort.signal.aborted || this.stopped) return;
      // A descriptor is a hint, not a transfer of an independent server's ownership.
      // Keep that server's retry guard until a managed successor actually answers.
      if (seen.managed_remote && !verified) return;
      const own = seen.managed_remote ? null : { ...target };
      if (moving) runtime.move!.ownOvisAt = own;
      else if (own) runtime.ownOvisAt = own; else delete runtime.ownOvisAt;
    };
    // an own update that ended in a refusal: no update of it is on offer any more, and one is never told beside a
    // setup (shared/machines.ts remote_ovis). A server newer than this app is told as any newer one is: this app is
    // the one to update, and nothing of that server's is offered. One still behind keeps where it answers, for the
    // user to update it there; its versions from before the update do not
    const ownRefused = (offer: RemoteOvis, refusal: MachineActionRequired, update: JobState) => {
      const left: RemoteOvis | null = refusal.newerServer ? null : { ...offer, version: null, latest_version: null, updatable: false, reason: refusal.message };
      update.public.remote_ovis = left;
      if (runtime.generation === generation && !moving) runtime.machine.remote_ovis = left;
    };
    const { host, inspection } = await detectHost(ssh, session);
    if (job && host.kind === "windows") job.public.windows_startup = moving || !this.machines.has(runtime.machine.id);
    const { platform, expectedSocket } = inspection;
    // what the PC's own Ovis said is read anew on every try: it may have been updated or replaced since
    if (!moving) runtime.machine.remote_ovis = null;
    let { herdrPath } = inspection;
    if (herdrPath) {
      const version = await host.herdrVersion(ssh, herdrPath);
      const match = /herdr (\d+)\.(\d+)\.(\d+)/.exec(version);
      if (!match || Number(match[1]) === 0 && Number(match[2]) < 9) throw new Error("The installed herdr is incompatible. Update it explicitly to 0.9+ before connecting; it was left unchanged.");
    }
    const descriptors = inspection.descriptors.filter((d) => d.socket_path === expectedSocket);
    let descriptor = descriptors.find((d) => d.bridge_protocol === BRIDGE_PROTOCOL && d.bundle_version === REMOTE_BUNDLE_VERSION) ?? descriptors[0];
    // a descriptor whose bridge is gone (a crash, a reboot, a Windows kill): the next bridge
    // replaces it, but until then it is still the first one listed
    let stalePid: number | null = null;
    if (descriptor) {
      if (!Number.isInteger(descriptor.pid) || descriptor.pid < 1) throw new Error("Invalid bridge process identity");
      // whose server this socket has, running or not: what the PC waits for while none runs
      learnServer(descriptor);
      if (!(await host.alive(ssh, descriptor.pid))) { stalePid = descriptor.pid; descriptor = undefined; }
    }
    // The PC's own Ovis is away (#2047): the PC waits for it, as for a PC that cannot be reached, and nothing of this
    // app's is installed or started in its place, by a reconnect or by an update that asks nobody. Only a setup the
    // user reviews in its dialog may start this app's bridge there.
    if (!descriptor && runtime.ownOvisAt && sameSshSession(runtime.ownOvisAt, target) && (!job || job.auto)) throw new Error(OWN_OVIS_AWAY);
    // Update is idempotent: another app may have finished it while this dialog was open.
    // Prove the live endpoint is compatible; a descriptor or installed directory alone is not enough.
    let update = job?.update === true;
    let currentBridge: Awaited<ReturnType<MachineManager["verify"]>> | undefined;
    if (descriptor && update && descriptor.bridge_protocol === BRIDGE_PROTOCOL && descriptor.bundle_version === REMOTE_BUNDLE_VERSION) {
      try { currentBridge = await this.verify(ssh, descriptor, expectedSocket); }
      catch (error) {
        if (error instanceof MachineActionRequired && error.action === "update_bridge") {
          throw new MachineActionRequired("The running bridge is incompatible with this app. Another app may have reconnected with a different version. Update or disconnect the other app, then reconnect here. The remote bridge was left running.", "bridge_conflict");
        }
        throw error;
      }
      update = false;
    }
    // Automatic updates can install the bundle before the later stop/replacement
    // verification. A managed descriptor cannot grant those writes over a remembered
    // independent server: verify the live successor first, without discarding its guard.
    if (runtime.ownOvisAt && sameSshSession(runtime.ownOvisAt, target) && descriptor?.managed_remote
      && (update || descriptor.bridge_protocol !== BRIDGE_PROTOCOL || descriptor.bundle_version !== REMOTE_BUNDLE_VERSION)) {
      const owner = await this.verify(ssh, descriptor, expectedSocket, true);
      if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
      if (owner.identity.managed_remote === false) throw new MachineActionRequired(independentBridge(owner.identity.bundle_version), "setup", newerBundle(owner.identity.bundle_version));
      if (owner.identity.managed_remote !== true || owner.identity.pid !== descriptor.pid) throw new Error("Bridge process verification failed; no update was authorized");
      if (newerBundle(owner.identity.bundle_version)) throw new MachineActionRequired(newerBridge(owner.identity.bundle_version), "bridge_conflict", true);
    }
    // an independently managed web server is not this app's to update or to wait for: it keeps
    // its own message below, which names the side that is behind
    if (descriptor && descriptor.managed_remote && newerBundle(descriptor.bundle_version)) throw new MachineActionRequired(newerBridge(descriptor.bundle_version), "bridge_conflict");
    // an older one may update itself: asked through its own updater, never by replacing its files
    let ownUpdate: RemoteOvis | undefined;
    if (descriptor && (update || descriptor.bridge_protocol !== BRIDGE_PROTOCOL || descriptor.bundle_version !== REMOTE_BUNDLE_VERSION)) {
      if (!descriptor.managed_remote) {
        if (newerBundle(descriptor.bundle_version)) throw new MachineActionRequired(independentBridge(descriptor.bundle_version), "setup");
        const offer = await this.ownOffer(ssh, descriptor, target, job?.abort.signal);
        if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
        if (!moving) runtime.machine.remote_ovis = offer;
        if (job) job.public.remote_ovis = offer;
        // a check still running there is no refusal: the PC tries again on its own instead of waiting for a tap
        if (!offer.updatable) throw offer.reason === OWN_CHECK_RUNNING ? new Error(OWN_CHECK_RUNNING) : new MachineActionRequired(ownUpdateRefused(offer), "setup");
        if (!update) throw new MachineActionRequired(ownUpdateOffered(offer), "update_bridge");
        ownUpdate = offer;
        // nothing of this app's is installed or restarted on that PC: its own updater does it
        update = false;
        if (job) job.own = true;
      } else if (!update) throw new MachineActionRequired("This PC runs a bridge from a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    }
    const hasBundle = inspection.bundleReady;
    // a runtime from another bundle version and no bridge running (the PC rebooted since): an update
    if (!descriptor && !hasBundle && inspection.bundleOlder && !job) throw new MachineActionRequired("This PC has the bridge runtime of a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    const installs: string[] = [];
    if (ownUpdate) installs.push(`Ask this PC's own Ovis to install its update${ownUpdate.latest_version ? ` v${ownUpdate.latest_version}` : ""} through its own updater, then reconnect (herdr sessions keep running)`);
    if (update) installs.push("Download and verify the bridge runtime, then restart this bridge (herdr sessions keep running)");
    if (!descriptor && !hasBundle) installs.push(host.bundleDescription);
    if (!descriptor && !herdrPath) installs.push(host.installHerdr ? `herdr 0.9.3 through its own installer (${HERDR_INSTALL_CMD})` : "Bundled herdr 0.9.3 (existing installations are preserved)");
    if (!descriptor && job) installs.push("Start the loopback bridge and, only if absent, the herdr daemon");
    if (ssh.usedSecret) installs.push("Register a dedicated SSH public key for automatic reconnection");
    if (installs.length) {
      if (!job) throw new MachineActionRequired("Remote setup needs approval. Use Reconnect / setup on this PC.", "setup");
      job.public.installations = installs;
      // an automatic bridge update was approved by the app update (or the tap that started it)
      if (!job.auto) {
        this.stage(job, "approval", "Review the changes on this PC");
        await this.wait(job);
      }
      job.installationApproved = update || !descriptor;
      if (update || !descriptor && !hasBundle) { this.stage(job, "installing", `Installing verified ${platform} bundle…`); await host.installBundle(ssh, platform, job.abort.signal, { cacheDir: join(this.stateDir, "bundles"), owner: installLockOwner(this.stateDir, target), onProgress: (stage, done, total) => this.progress(job, stage, done, total) }); }
      if (!descriptor && !herdrPath && host.installHerdr) { this.stage(job, "installing", "Installing herdr with its own installer…"); herdrPath = await host.installHerdr(ssh); }
      if (ssh.usedSecret) {
        this.stage(job, "installing", "Registering the app SSH key…");
        const path = join(this.sshDir, runtime.machine.id);
        if (!existsSync(path)) {
          // Generate privately until the job still owns this destination. A cancelled job
          // must neither publish a late key nor delete a replacement job's credentials.
          const directory = mkdtempSync(join(this.sshDir, "keygen-"));
          const temporary = join(directory, "key");
          try {
            const keygen = Bun.spawn([sshClient().keygen, "-q", "-t", "ed25519", "-N", "", "-C", `ovis:${runtime.machine.id}`, "-f", temporary], { stdout: "ignore", stderr: "pipe" });
            if (await keygen.exited !== 0) throw new Error("Could not generate the dedicated SSH key");
            if (job.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
            renameSync(temporary + ".pub", path + ".pub");
            renameSync(temporary, path);
          } finally { rmSync(directory, { recursive: true, force: true }); }
        }
        chmodSync(path, 0o600);
        const publicKey = readFileSync(path + ".pub", "utf8").trim();
        await host.authorizeKey(ssh, "no-agent-forwarding,no-X11-forwarding,no-pty " + publicKey);
        // A separate master proves the new key actually works without a password.
        const proof = new SshConnection({ ...target, identity_file: path }, this.sshDir, path, true);
        try { await proof.start(); await (host.kind === "windows" ? proof.runPowerShell("Write-Output ok") : proof.run("true")); } finally { proof.close(); }
      }
    }
    if (ownUpdate && job && descriptor) {
      try { descriptor = await this.runOwnUpdate(job, ssh, host, descriptor, expectedSocket, ownUpdate); }
      catch (error) {
        // it updated itself into a refusal: its new bridge registered another version than this app's
        if (error instanceof MachineActionRequired) ownRefused(ownUpdate, error, job);
        throw error;
      }
    }
    if (update && job && descriptor) {
      if (!descriptor.managed_remote) throw new Error("This socket uses an independently managed web server. Update it through its own Settings; it was left running.");
      const verified = await this.verify(ssh, descriptor, expectedSocket, true);
      if (verified.identity.managed_remote !== true || verified.identity.pid !== descriptor.pid) throw new Error("Bridge process verification failed; no process was stopped");
      // the descriptor was checked above; the version the running bridge itself answers decides
      if (newerBundle(verified.identity.bundle_version)) throw new MachineActionRequired(newerBridge(verified.identity.bundle_version), "bridge_conflict");
      if (job.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
      this.stage(job, "starting", "Restarting the verified remote bridge…");
      this.progress(job, "restart", 0, null);
      await host.stop(ssh, descriptor.pid);
      // Wait for this verified process to leave; its descriptor may remain after a crash.
      const deadline = Date.now() + 10_000;
      while (await host.alive(ssh, descriptor.pid)) {
        if (job.abort.signal.aborted || this.stopped) throw new Error("Setup cancelled");
        if (Date.now() >= deadline) throw new Error("The old bridge did not stop; retry the update after checking it on the PC");
        await Bun.sleep(100);
      }
      stalePid = descriptor.pid;
      descriptor = undefined;
    }
    if (!descriptor && !this.mayManageBridge(runtime) && !job) throw new MachineActionRequired("The saved herdr machine needs a web bridge. Set it up here; the SSH address and session are already filled in.", "setup");
    if (!descriptor) {
      if (job?.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
      if (job) this.stage(job, "starting", "Starting the remote bridge…");
      let notice: string | null = null;
      let waitingForLogin = false;
      do {
        if (job?.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
        const headless = job?.headlessStart === true;
        if (job) job.headlessStart = false;
        await host.start(ssh, { session, herdrPath, inspection, ...(headless ? { headless: true } : {}) });
        notice = null;
        // Windows allows 30 seconds for the desktop launcher, then 30 for herdr
        // readiness. Leave a further ten seconds for bridge registration.
        const pollLimit = host.kind === "windows" ? 280 : 40;
        for (let i = 0; i < pollLimit; i++) {
          if (job?.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
          descriptor = (await host.descriptors(ssh)).find((d) => d.socket_path === expectedSocket && d.pid !== stalePid);
          if (descriptor) break;
          if (!headless) notice = await host.startupNotice?.(ssh, session) ?? null;
          if (notice) break;
          await Bun.sleep(250);
        }
        if (!descriptor && !headless && !notice) notice = await host.startupNotice?.(ssh, session) ?? null;
        const startupAction = notice === WAITING_FOR_WINDOWS_LOGIN ? "windows_login" : "windows_start_failed";
        // An unattended update has installed its bundle. Waiting for a person belongs to
        // reconnection, not the global update queue or one of the four setup slots.
        if (notice && job?.auto && job.update) throw new MachineActionRequired(notice, startupAction);
        if (notice && job) {
          if (!waitingForLogin) {
            waitingForLogin = true;
            clearTimeout(job.timer);
            job.timer = setTimeout(() => this.cancelJob(job.public.id, true), 600_000);
            job.timer.unref();
          }
          if (!job.headlessStart) {
            job.public.action_required = startupAction;
            if (!moving) { runtime.machine.action_required = startupAction; runtime.machine.error = notice; }
            this.stage(job, "starting", notice);
          }
          do {
            await this.pause(job.abort.signal);
            if (job.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
            // A scheduler refusal needs a decision, not another automatic launch.
          } while (job.public.action_required === "windows_start_failed");
        }
      } while (!descriptor && notice && job);
      if (!descriptor) {
        if (notice) throw new MachineActionRequired(notice, notice === WAITING_FOR_WINDOWS_LOGIN ? "windows_login" : "windows_start_failed");
        throw new Error(`Bridge did not start. Check ${host.logHint} on the PC.`);
      }
      if (job?.public.action_required === "windows_login" || job?.public.action_required === "windows_start_failed") job.public.action_required = null;
      if (runtime.machine.action_required === "windows_login" || runtime.machine.action_required === "windows_start_failed") runtime.machine.action_required = null;
    }
    learnServer(descriptor);
    let verified: Awaited<ReturnType<MachineManager["verify"]>>;
    try { verified = currentBridge ?? await this.verify(ssh, descriptor, expectedSocket); }
    catch (error) {
      // its own update ended in a refusal of what answers there, which decides over what its descriptor said
      if (ownUpdate && job && error instanceof MachineActionRequired) ownRefused(ownUpdate, error, job);
      throw error;
    }
    if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
    if (verified.identity.pid !== descriptor.pid) throw new Error("Bridge process verification failed; ownership was not changed");
    learnServer(verified.identity, true);
    runtime.endpoint = verified.endpoint;
    if (moving) runtime.move!.herdr = verified.identity.herdr; else runtime.machine.herdr = verified.identity.herdr;
  }
  /** A tunnel to the bridge a descriptor names, on the PC's 127.0.0.1, with that bridge's token. */
  private async tunnel(ssh: SshConnection, descriptor: BridgeDescriptor): Promise<{ url: string; token: string }> {
    if (!Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.token)) throw new Error("Invalid bridge credentials");
    const port = await freePort();
    await ssh.forward(port, descriptor.port);
    return { url: `http://127.0.0.1:${port}`, token: descriptor.token };
  }
  /**
   * What the PC's own Ovis (an independently managed web server older than this app) says of its own
   * update, asked through the tunnel with the token its descriptor holds. A server of this app's
   * version takes that token on its update routes (server/index.ts); an older one without OVIS_TOKEN
   * takes the tunnel's loopback connection as its own PC's. One that wants its OVIS_TOKEN refuses,
   * and that token is never read from its files: it is updated on that PC.
   */
  /** one poll's wait, cut short when `signal` aborts */
  private pause(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, this.ownUpdatePollMs);
      signal?.addEventListener("abort", done, { once: true });
    });
  }
  private async ownOffer(ssh: SshConnection, descriptor: BridgeDescriptor, target: SshTarget, signal?: AbortSignal): Promise<RemoteOvis> {
    const endpoint = await this.tunnel(ssh, descriptor);
    // never followed: a redirect would leave the tunnel for wherever it names, this PC's own loopback included
    const get = (path: string) => fetch(endpoint.url + path, { headers: { authorization: `Bearer ${endpoint.token}` }, redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(BRIDGE_ANSWER_MS)]) : AbortSignal.timeout(BRIDGE_ANSWER_MS) });
    let port = descriptor.port;
    let url: string | null = null;
    const take = (told: { port?: unknown; serving_url?: unknown } | null | undefined) => {
      if (typeof told?.port === "number" && Number.isInteger(told.port) && told.port >= 1 && told.port <= 65535) port = told.port;
      const serving = told?.serving_url;
      if (typeof serving === "string" && serving.length <= 300 && /^https:\/\/[^\s/?#@]+(?:\/[^\s]*)?$/.test(serving)) url = serving;
    };
    // where it answers, as it tells it: a relayed bridge (#1960) registers another port than its own.
    // This app's server tells it with its update status, to this token (#2191); an older one only on
    // GET /api/access, which it opens to the tunnel only without OVIS_TOKEN. One that tells nothing
    // keeps the descriptor's port
    const locate = async (status: Partial<UpdateStatus> | null) => {
      if (typeof status === "object" && status !== null && "port" in status) { take(status); return; }
      try {
        const response = await get("/api/access");
        if (response.ok) {
          const access = await readCappedJson<{ port?: unknown; tailscale?: { serving_url?: unknown } } | null>(response, REMOTE_LIMITS.ownUpdates);
          take({ port: access?.port, serving_url: access?.tailscale?.serving_url });
        } else await discard(response);
      } catch { /* the address stays the descriptor's */ }
    };
    const answer = (status: Partial<UpdateStatus> | null, reason: string | null): RemoteOvis => ({
      version: releaseVersion(status?.current_version), latest_version: releaseVersion(status?.latest_version),
      updatable: reason === null, reason, address: `${sshHost(target.destination)}:${port}`, url,
    });
    const there = "Update it on that PC (Settings → Updates), then reconnect.";
    const read = async (): Promise<{ status: Partial<UpdateStatus> | null } | { refused: string }> => {
      let response: Response;
      try { response = await get("/api/updates"); }
      catch (error) { return { refused: bridgeUnreachable(descriptor, error) }; }
      // an older Ovis takes the tunnel as this PC's own connection only on its loopback and without OVIS_TOKEN (server/access.ts)
      if (response.status === 401 || response.status === 403) { await discard(response); return { refused: `That PC's Ovis refused this app's request: it asks for its own access token (OVIS_TOKEN) or a paired device, and this app has neither. ${there}` }; }
      if (!response.ok) { await discard(response); return { refused: `That PC's Ovis did not tell its update status (${response.status}). ${there}` }; }
      try { return { status: await readCappedJson<Partial<UpdateStatus> | null>(response, REMOTE_LIMITS.ownUpdates) }; }
      catch { return { refused: `That PC's Ovis did not tell its update status. ${there}` }; }
    };
    // a check for releases (its own, every 5 minutes) offers nothing while it runs: its answer is waited for
    let told = await read();
    // the last status that told where it answers: a later read that fails does not take it back
    let located = "status" in told ? told.status : null;
    for (const until = Date.now() + this.ownUpdateCheckMs; "status" in told && told.status?.phase === "checking" && Date.now() < until && !signal?.aborted;) {
      await this.pause(signal);
      told = await read();
      if ("status" in told && typeof told.status === "object" && told.status !== null && "port" in told.status) located = told.status;
    }
    await locate(located);
    if ("refused" in told) return answer(null, told.refused);
    const status = told.status;
    if (status?.managed !== true) return answer(status, `That PC's Ovis does not update itself: ${remoteWords(status?.blocked_reason) ?? "it was not started by its updater."}`);
    const blocked = remoteWords(status.blocked_reason);
    if (blocked) return answer(status, `That PC's Ovis cannot update itself now: ${blocked}`);
    if (status.revision_bound_install !== true) return answer(status, `That PC's Ovis is too old to take an update asked for from another PC. ${there}`);
    if (status.phase === "checking") return answer(status, OWN_CHECK_RUNNING);
    // one already installing is followed, not asked again (runOwnUpdate)
    if (ownInstallRunning(status)) return answer(status, null);
    if (status.available !== true || typeof status.latest_revision !== "string" || !REVISION.test(status.latest_revision)) {
      return answer(status, `That PC's Ovis has no newer release on offer${status.current_version ? ` than v${releaseVersion(status.current_version) ?? "?"}` : ""}, and it is still older than this app. ${there}`);
    }
    return answer(status, null);
  }
  /**
   * Has the PC's own Ovis install the update its updater offers, through its own update route, then
   * waits until it answers on the new version: its new bridge registers anew (another process, another
   * token), which is returned. Nothing of it is stopped or replaced from here, and a cancel ends only
   * the waiting: an install that started there runs to its end.
   */
  private async runOwnUpdate(job: JobState, ssh: SshConnection, host: RemoteHost, descriptor: BridgeDescriptor, expectedSocket: string, offer: RemoteOvis): Promise<BridgeDescriptor> {
    const to = offer.latest_version ? ` to v${offer.latest_version}` : "";
    this.stage(job, "installing", `Asking this PC's own Ovis to update itself${to}…`);
    const endpoint = await this.tunnel(ssh, descriptor);
    const updates = (install?: string) => fetch(`${endpoint.url}/api/updates${install ? "/install" : ""}`, {
      ...(install ? { method: "POST", body: JSON.stringify({ expected_revision: install }) } : {}),
      headers: { authorization: `Bearer ${endpoint.token}`, "x-herdr-update": "1", ...(install ? { "content-type": "application/json" } : {}) },
      // never followed: a redirect would take the install request out of the tunnel, to this PC's own loopback too
      redirect: "manual",
      signal: AbortSignal.any([job.abort.signal, AbortSignal.timeout(BRIDGE_ANSWER_MS)]),
    });
    const read = async (): Promise<Partial<UpdateStatus>> => {
      const response = await updates();
      if (!response.ok) { await discard(response); throw new Error(`That PC's Ovis did not tell its update status (${response.status})`); }
      return await readCappedJson<Partial<UpdateStatus> | null>(response, REMOTE_LIMITS.ownUpdates) ?? {};
    };
    // a check for releases running there is no install, and offers nothing until it ends
    const settled = async (): Promise<Partial<UpdateStatus>> => {
      let status = await read();
      for (const until = Date.now() + this.ownUpdateCheckMs; status.phase === "checking" && Date.now() < until && !job.abort.signal.aborted;) { await this.pause(job.abort.signal); status = await read(); }
      return status;
    };
    let before = await settled();
    // an error an earlier install left: its supervisor tells the bridge over IPC, so a status read
    // right after the 202 may still carry it. Only an error seen once this install ran, or one in
    // other words, is this install's
    const earlierError = before.phase === "error" ? remoteWords(before.error) : null;
    let started = ownInstallRunning(before);
    for (let attempt = 1; !started; attempt++) {
      if (before.phase === "checking") throw new Error(OWN_CHECK_RUNNING);
      const revision = before.latest_revision;
      if (before.available !== true || typeof revision !== "string" || !REVISION.test(revision)) throw new Error("That PC's Ovis has no update on offer any more. Check its Settings → Updates there, then reconnect.");
      const response = await updates(revision);
      if (response.status === 202) { await discard(response); break; }
      const refusal = (await readCappedJson<{ error?: { code?: unknown; message?: unknown } } | null>(response, REMOTE_LIMITS.bridgeError).catch(() => null))?.error;
      // busy: an install of it (its own Settings, another app) runs, and is followed; or a check that
      // started since the status was read, and the install is asked for again once it ends
      if (refusal?.code !== "update_busy" || attempt >= 3) throw new Error(`That PC's Ovis refused to update (${typeof refusal?.code === "string" ? remoteWords(refusal.code) : response.status}): ${remoteWords(refusal?.message) ?? "no reason given"}`);
      before = await settled();
      started = ownInstallRunning(before);
    }
    const deadline = Date.now() + OWN_UPDATE_MS;
    const startBy = Date.now() + this.ownUpdateStartMs;
    for (;;) {
      if (job.abort.signal.aborted || this.stopped) throw new Error("Setup cancelled");
      if (Date.now() >= deadline) throw new Error(`This PC's Ovis did not come back on its new version within ${OWN_UPDATE_MS / 60_000} minutes. Check its Settings → Updates there, then reconnect.`);
      // the new version registers its own bridge: another process than the one asked. Its pid goes
      // into a command on that PC (host.alive), so only a process id is taken
      const next = (await host.descriptors(ssh)).find((d) => d.socket_path === expectedSocket && Number.isSafeInteger(d.pid) && d.pid > 0 && d.pid !== descriptor.pid);
      if (next && await host.alive(ssh, next.pid)) {
        if (next.bundle_version !== REMOTE_BUNDLE_VERSION && !newerBundle(next.bundle_version)) throw new MachineActionRequired(`This PC's Ovis updated itself, but its version still differs from this app's (v${remoteWords(next.bundle_version)}; this app requires v${REMOTE_BUNDLE_VERSION}). Update it on that PC (Settings → Updates), then reconnect; it was left running.`, "setup");
        this.stage(job, "starting", "Connecting to this PC's updated Ovis…");
        return next;
      }
      let status: Partial<UpdateStatus> | null = null;
      // while it restarts nothing answers, until its new bridge registers
      try { status = await read(); } catch { if (job.abort.signal.aborted) throw new Error("Setup cancelled"); }
      if (ownInstallRunning(status)) started = true;
      if (status?.phase === "error" && (started || remoteWords(status.error) !== earlierError)) throw new Error(`That PC's Ovis could not update itself: ${remoteWords(status.error) ?? "no reason given"} Check its Settings → Updates there, then reconnect.`);
      if (status && ownInstallRunning(status)) {
        const step = OWN_UPDATE_STEPS[status.step ?? ""] ?? status.phase;
        const text = `This PC's own Ovis is updating itself${to}: ${step}…`;
        if (job.public.step !== text) { job.public.step = text; this.showUpdate(job); }
      }
      // only an answer that it has not started counts against the limit: one that fails says nothing
      if (!started && status && Date.now() >= startBy) throw new Error(`This PC's Ovis did not start its update within ${Math.max(1, Math.round(this.ownUpdateStartMs / 1000))} seconds of being asked. Check its Settings → Updates there, then reconnect.`);
      // a Cancel ends the wait at once, not after the poll's interval
      await this.pause(job.abort.signal);
    }
  }
  private async verify(ssh: SshConnection, descriptor: BridgeDescriptor, expectedSocket: string, forReplacement = false): Promise<{ endpoint: { url: string; token: string }; identity: BridgeIdentity }> {
    const endpoint = await this.tunnel(ssh, descriptor);
    let response: Response;
    // one deadline for the answer, its body included: a bridge that stops halfway timed out too
    const deadline = AbortSignal.timeout(BRIDGE_ANSWER_MS);
    try { response = await fetch(`${endpoint.url}/api/bridge`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: deadline }); }
    catch (error) { throw new Error(bridgeUnreachable(descriptor, error), { cause: error }); }
    if (!response.ok) throw new Error(verificationFailure(response.status, await readCappedJson(response, REMOTE_LIMITS.bridgeError).catch(() => null)));
    let identity: BridgeIdentity;
    try { identity = await readCappedJson<BridgeIdentity>(response, REMOTE_LIMITS.bridgeIdentity); }
    catch (error) {
      if (deadline.aborted) throw new Error(bridgeUnreachable(descriptor, deadline.reason), { cause: error });
      throw error;
    }
    // An approved replacement only reads this stable identity endpoint. It never uses the
    // old bridge's pane protocol; the new bridge must pass the strict version check below.
    if (!forReplacement && (identity.bridge_protocol !== BRIDGE_PROTOCOL || identity.bundle_version !== REMOTE_BUNDLE_VERSION)) {
      // what runs decides, not its descriptor: a server this app does not manage, or a newer
      // bridge, is not something an update from here can fix
      if (identity.managed_remote === false) throw new MachineActionRequired(independentBridge(identity.bundle_version), "setup", newerBundle(identity.bundle_version));
      if (newerBundle(identity.bundle_version)) throw new MachineActionRequired(newerBridge(identity.bundle_version), "bridge_conflict", true);
      throw new MachineActionRequired("This PC runs a bridge from a different version. Update the bridge to reconnect; herdr sessions keep running.", "update_bridge");
    }
    if (identity.socket_path !== expectedSocket || typeof identity.socket_id !== "string" || !identity.socket_id || !Number.isInteger(identity.herdr?.protocol) || identity.herdr.protocol < 22) throw new Error("Remote bridge/socket is incompatible; update it explicitly");
    return { endpoint, identity };
  }
  endpoint(id: string): { url: string; token: string } | undefined {
    const runtime = this.machines.get(id);
    return runtime?.machine.enabled && runtime.machine.state === "connected" ? runtime.endpoint : undefined;
  }
  trackTerminal(id: string, close: () => void): () => void {
    const runtime = this.machines.get(id);
    runtime?.terminals.add(close);
    return () => runtime?.terminals.delete(close);
  }
  private async refresh(runtime: Runtime): Promise<void> {
    if (!runtime.endpoint || this.stopped) return;
    if (runtime.refreshing) { runtime.refreshQueued = true; return; }
    runtime.refreshing = true;
    const endpoint = runtime.endpoint;
    const generation = runtime.generation;
    try {
      do {
        runtime.refreshQueued = false;
        const revision = runtime.snapshotRevision;
        try {
          const r = await fetch(endpoint.url + "/api/session", { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(15_000) });
          if (!r.ok) { await discard(r); throw new Error(`Remote herdr unavailable (${r.status})`); }
          const { snapshot } = await readCappedJson<{ snapshot: SessionSnapshot }>(r, REMOTE_LIMITS.sessionSnapshot);
          if (generation !== runtime.generation || this.stopped) return;
          if (revision !== runtime.snapshotRevision) { runtime.refreshQueued = true; continue; }
          if (!runtime.move) runtime.machine.error = null;
          // read after every snapshot and status that reached this server before it (the revision did not move)
          if (this.admitRemote(runtime, snapshot)) { this.publish(runtime, snapshot, true); this.emit(); }
        } catch (e) {
          if (generation !== runtime.generation || this.stopped) return;
          if (revision !== runtime.snapshotRevision) { runtime.refreshQueued = true; continue; }
          throw e;
        }
      } while (runtime.refreshQueued && generation === runtime.generation && !this.stopped);
    } finally {
      runtime.refreshing = false;
      // A reconnect can request its first load while the old connection is still
      // finishing. Start that queued load with the new generation's error handler.
      if (runtime.refreshQueued && generation !== runtime.generation && runtime.endpoint && !this.stopped) {
        const nextGeneration = runtime.generation;
        void this.refresh(runtime).catch((e) => this.lost(runtime, nextGeneration, e));
      }
    }
  }
  private async observe(runtime: Runtime): Promise<void> {
    const generation = runtime.generation;
    await this.refresh(runtime);
    if (generation !== runtime.generation || this.stopped) throw new Error("Connection cancelled");
    runtime.machine.state = "connected"; runtime.machine.action_required = null; runtime.machine.remote_ovis = null; runtime.attempts = 0; runtime.updateCancelled = false;
    const endpoint = runtime.endpoint!;
    const ws = authenticatedWebSocket(endpoint.url.replace("http:", "ws:") + "/ws", endpoint.token);
    runtime.observer = ws;
    ws.onopen = () => {
      if (generation !== runtime.generation || this.stopped) return;
      this.remoteDiagnostics.recovered(runtime.machine.id, { operation: "bridge", machine_id: runtime.machine.id });
      ws.send(JSON.stringify({ type: "role", mode: "observe" }));
    };
    ws.onmessage = (event) => {
      if (generation !== runtime.generation || this.stopped) return;
      let message: ServerMessage;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      // a status of a run already seen to end is older than the read that showed it ended: not told, not kept
      if (message.type === "pane-status" && runtime.finishes.stale(message.finish_epoch)) return;
      // session-changed queues one follow-up, but lets the active roster publish.
      if (["snapshot", "pane-status", "pane-exited"].includes(message.type)) runtime.snapshotRevision++;
      // a frame may have been overtaken by an HTTP read: it holds its epoch, it proves no other ended
      if (message.type === "snapshot" && this.admitRemote(runtime, message.snapshot)) { runtime.machine.snapshot = message.snapshot; runtime.finishes.hold(message.snapshot.finish_epoch, message.snapshot.order_epoch); this.push.seed(forAlerts(message.snapshot.panes), runtime.machine.id, runtime.machine.name); this.emit(); }
      // a status names no server: it is the proven one's, or not known while health is asked (the cached roster's
      // order epoch may be another server's)
      if (message.type === "pane-status") {
        if (runtime.machine.snapshot) { runtime.machine.snapshot = snapshotAfterStatus(runtime.machine.snapshot, message); runtime.finishes.hold(message.finish_epoch, runtime.acceptedEpoch); }
        // a snapshot held for health is older than this frame too: published later, it keeps the status
        if (runtime.candidate) runtime.candidate = snapshotAfterStatus(runtime.candidate, message);
        void this.push.onStatus(message.pane_id, alertStatus(message.agent_status, message.background_wait), runtime.machine.id).catch(() => {});
      }
      if (message.type === "pane-exited") void this.push.onEnded(message.pane_id, runtime.machine.id).catch(() => {});
      this.emit({ type: "machine-message", machine_id: runtime.machine.id, message });
      if (["pane-status", "pane-exited", "session-changed"].includes(message.type)) void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e));
    };
    ws.onclose = () => this.lost(runtime, generation, new Error(runtime.tunnel ? "Relay connection to this PC was lost" : "SSH bridge connection interrupted"));
    ws.onerror = () => ws.close();
    if (runtime.ssh) runtime.ssh.onExit = () => this.lost(runtime, generation, new Error("SSH connection ended"));
    runtime.poll = setInterval(() => void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e)), 5000);
    runtime.poll.unref();
  }
  private lost(runtime: Runtime, generation: number, error: unknown): void {
    if (generation !== runtime.generation || !runtime.machine.enabled || this.stopped) return;
    this.remoteDiagnostics.failed(runtime.machine.id, error instanceof MachineActionRequired ? "action_required" : "connection_lost", { operation: "bridge", machine_id: runtime.machine.id });
    this.disconnect(runtime);
    runtime.machine.error = error instanceof Error ? error.message : String(error);
    // the other PC turned this one away for good (revoked it, say): trying again could only fail the same way
    if (error instanceof RelayPcRefused) {
      runtime.machine.state = "error"; runtime.machine.action_required = null;
      this.emit();
      return;
    }
    if (error instanceof MachineActionRequired && error.action !== "windows_login") {
      runtime.machine.state = "error"; runtime.machine.action_required = error.action;
      this.emit();
      // SSH itself just worked without a password, so the update can run unattended
      if (error.action === "update_bridge" && this.preferences.auto_update_bridges && this.mayManageBridge(runtime) && !runtime.updateCancelled) this.queueAutoUpdate(runtime.machine.id);
      return;
    }
    runtime.machine.action_required = error instanceof MachineActionRequired ? error.action : null;
    this.retryLater(runtime);
  }
  /** a disconnected PC tries again on its own, waiting longer after each failed try */
  private retryLater(runtime: Runtime): void {
    runtime.machine.state = "reconnecting";
    const delay = Math.min(60_000, 1000 * 2 ** Math.min(runtime.attempts++, 6));
    runtime.retry = setTimeout(() => { runtime.retry = undefined; void this.reconnect(runtime); }, delay); runtime.retry.unref();
    this.emit();
  }
  /**
   * Someone asked this PC for something while it waits out its delay before the next try: try now.
   * The delay doubles with each failed try, up to a minute, so a laptop that slept through a few
   * (its network still coming back) would otherwise keep its chat waiting that long after it wakes.
   * Only a waiting PC tries, never one with a try under way, and at most once per
   * DEMANDED_RETRY_INTERVAL_MS since the last try started, so a chat polling an unreachable PC
   * does not start an SSH connection on every read.
   */
  retryNow(id: string): void {
    const runtime = this.machines.get(id);
    if (!runtime || runtime.retry === undefined || this.stopped || !runtime.machine.enabled) return;
    if (runtime.triedAt !== undefined && this.now() - runtime.triedAt < DEMANDED_RETRY_INTERVAL_MS) return;
    clearTimeout(runtime.retry); runtime.retry = undefined;
    void this.reconnect(runtime);
  }
  private async reconnect(runtime: Runtime): Promise<void> {
    if (!this.mayConnect(runtime)) return;
    if (this.stopped || !runtime.machine.enabled) return;
    this.disconnect(runtime);
    runtime.triedAt = this.now();
    runtime.machine.state = "reconnecting"; runtime.machine.action_required = null; this.emit();
    const generation = runtime.generation;
    if (runtime.machine.kind === "relay") {
      try {
        let key: RelayPcKey;
        const wanted = () => !this.stopped && runtime.generation === generation && this.machines.get(runtime.machine.id) === runtime;
        try { key = await RelayPcKey.load(this.relayKeyPath(runtime.machine.id), wanted); }
        catch (error) {
          // a key that is gone or damaged cannot come back by retrying; another read error (EIO, EACCES) may
          const lostForGood = (error as NodeJS.ErrnoException).code === "ENOENT" || !("code" in (error as object));
          if (!lostForGood) throw error;
          throw new RelayPcRefused("This PC's relay key could not be read. Remove it and add it again with a new pairing link.", { cause: error });
        }
        if (generation !== runtime.generation || this.stopped) return;
        const tunnel = await openRelayPcTunnel(key.offer, key, { socket: this.relaySocket, onLost: (error) => this.lost(runtime, generation, error) });
        if (generation !== runtime.generation || this.stopped) { tunnel.close(); return; }
        runtime.tunnel = tunnel; runtime.endpoint = tunnel.endpoint;
        await this.observe(runtime); this.emit();
      } catch (e) { this.lost(runtime, generation, e); }
      return;
    }
    runtime.ssh = new SshConnection(runtime.machine.target!, this.sshDir, join(this.sshDir, runtime.machine.id));
    try {
      await runtime.ssh.start(); await this.prepare(runtime);
      if (generation !== runtime.generation || this.stopped) return;
      await this.observe(runtime); this.emit();
    } catch (e) { this.lost(runtime, generation, e); }
  }
  private queueAutoUpdate(id: string): void {
    if (this.autoQueued.has(id)) return;
    this.autoQueued.add(id);
    this.autoChain = this.autoChain.then(async () => {
      const runtime = this.machines.get(id);
      // still wanted: the PC may have been updated by hand, removed, disabled or its update
      // cancelled meanwhile
      if (this.stopped || !runtime?.machine.enabled || runtime.machine.action_required !== "update_bridge" || runtime.updateCancelled || !this.mayManageBridge(runtime) || !this.preferences.auto_update_bridges) return;
      if ([...this.jobs.values()].some((j) => j.public.machine_id === id && !["connected", "failed", "cancelled"].includes(j.public.phase))) return;
      const job = this.updateBridge(id, true);
      await this.jobs.get(job.id)?.finished;
    }).catch((e) => { console.error("Automatic bridge update failed:", e instanceof Error ? e.message : String(e)); })
      .finally(() => { this.autoQueued.delete(id); });
  }
  private disconnect(runtime: Runtime): void {
    runtime.generation++;
    runtime.refreshQueued = false;
    clearTimeout(runtime.retry); runtime.retry = undefined; clearInterval(runtime.poll);
    runtime.abort?.abort(); runtime.abort = undefined;
    runtime.observer?.close(); runtime.observer = undefined;
    for (const close of runtime.terminals) close(); runtime.terminals.clear();
    runtime.ssh?.close(); runtime.ssh = undefined; runtime.endpoint = undefined;
    runtime.tunnel?.close(); runtime.tunnel = undefined;
    // what this connection proved goes with it; the start interval stays (sourceStarts)
    runtime.verification?.abort.abort(); runtime.verification = undefined;
    runtime.acceptedEpoch = undefined; runtime.candidate = undefined; runtime.candidateRun = undefined; delete runtime.machine.source_boot_id;
    runtime.move = undefined;
    runtime.machine.state = "disconnected";
  }
  /**
   * Whether a remote PC's full snapshot may replace its cached one. Pairs are the remote server's own,
   * copied unchanged. Within the epoch its health proved over this connection, a read older than the
   * cached one is dropped; any other epoch, the connection's first included, is held back while the
   * manager asks that PC's /api/health which server answers now (a held one is offered again by the
   * next refresh). A snapshot without evidence (an older bridge) is taken as before. One of a herdr run this
   * server already saw end is old, whatever its pair says (#2206).
   */
  private admitRemote(runtime: Runtime, snapshot: SessionSnapshot): boolean {
    if (runtime.finishes.stale(snapshot.finish_epoch)) return false;
    const epoch = snapshot.order_epoch;
    if (typeof epoch !== "string" || !Number.isSafeInteger(snapshot.read_seq)) return true;
    if (epoch === runtime.acceptedEpoch) return !olderOrderRead(runtime.machine.snapshot, snapshot);
    if (!olderOrderRead(runtime.candidate, snapshot)) { runtime.candidate = snapshot; runtime.candidateRun = snapshot.finish_epoch; }
    this.sourceCheck(runtime);
    return false;
  }
  /**
   * The PC's health call in flight, or a new one: at most one per PC, started at least
   * SOURCE_CHECK_INTERVAL_MS after the last. `fresh` says it started now. Null: the interval refuses one,
   * or the PC has no connection. Its answer is used only while the connection and the call are current.
   */
  private sourceCheck(runtime: Runtime): { call: SourceCheck; fresh: boolean } | null {
    if (runtime.verification) return { call: runtime.verification, fresh: false };
    const endpoint = runtime.endpoint;
    if (!endpoint || this.stopped) return null;
    const id = runtime.machine.id;
    const now = this.now();
    const last = this.sourceStarts.get(id);
    if (last !== undefined && now - last < SOURCE_CHECK_INTERVAL_MS) return null;
    this.sourceStarts.set(id, now);
    const token = ++this.sourceToken;
    const generation = runtime.generation;
    const abort = new AbortController();
    const current = () => !this.stopped && runtime.generation === generation && runtime.endpoint === endpoint && runtime.verification?.token === token;
    const call: SourceCheck = { token, abort, promise: Promise.resolve(null) };
    runtime.verification = call;
    call.promise = (async () => {
      try {
        const response = await fetch(`${endpoint.url}/api/health`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
        if (!current() || !response.ok) { await discard(response); return null; }
        const boot = (await readCappedJson<{ web_ui?: { boot_id?: unknown } } | null>(response, REMOTE_LIMITS.health))?.web_ui?.boot_id;
        if (!current() || typeof boot !== "string" || boot === "") return null;
        this.proved(runtime, boot);
        return boot;
      } catch { return null; }
      finally { if (runtime.verification?.token === token) runtime.verification = undefined; }
    })();
    return { call, fresh: true };
  }
  /**
   * A full snapshot read from the PC's server becomes the PC's, saved and seeded for alerts. One that a setup at another
   * SSH address read waits for that setup to connect there (Runtime.move), and is neither shown nor saved before.
   * `settled`: a read that started after every snapshot and status of the PC that reached this server
   * (FinishEpochLedger.settle). Otherwise `server`: the one known to have named its finish epoch, if any.
   */
  private publish(runtime: Runtime, snapshot: SessionSnapshot, settled = false, server?: string): void {
    if (runtime.move) { runtime.move.snapshot = snapshot; runtime.move.snapshotServer = settled ? snapshot.order_epoch : server; return; }
    runtime.machine.snapshot = snapshot;
    if (settled) runtime.finishes.settle(snapshot); else runtime.finishes.hold(snapshot.finish_epoch, server);
    this.saveSoon();
    this.push.seed(forAlerts(snapshot.panes), runtime.machine.id, runtime.machine.name);
  }
  /** the PC's server proved itself: its epoch is the accepted one, and a held snapshot of it is published */
  private proved(runtime: Runtime, boot: string): void {
    runtime.machine.source_boot_id = boot;
    runtime.acceptedEpoch = boot;
    const candidate = runtime.candidate;
    const run = runtime.candidateRun;
    runtime.candidate = undefined; runtime.candidateRun = undefined;
    // its run is the proven server's own unless a status laid another over it
    if (candidate?.order_epoch === boot && !olderOrderRead(runtime.machine.snapshot, candidate)) this.publish(runtime, candidate, false, candidate.finish_epoch === run ? boot : undefined);
    else if (runtime.machine.snapshot?.order_epoch !== boot) {
      // the cache is of another server: a read of this one replaces it
      const generation = runtime.generation;
      void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e));
    }
    this.emit();
  }
  /**
   * GET /api/machines?verify_source_boot: the boot id of the server behind a PC, proved during this
   * request. A health call that was already running when it came is waited for but proves nothing to
   * it; the caller's abort ends only its own wait.
   */
  async verifySourceBoot(id: string, signal?: AbortSignal): Promise<SourceProof> {
    if (id === LOCAL_MACHINE) return this.bootId ? { boot_id: this.bootId } : { refused: "unverified" };
    const runtime = this.machines.get(id);
    if (!runtime) return { refused: "unknown" };
    if (!runtime.endpoint) return { refused: "unverified" };
    const generation = runtime.generation;
    const check = this.sourceCheck(runtime);
    if (!check) return { refused: "interval" };
    const aborted = signal ? new Promise<null>((resolve) => {
      if (signal.aborted) resolve(null);
      signal.addEventListener("abort", () => resolve(null), { once: true });
    }) : null;
    const boot = await (aborted ? Promise.race([check.call.promise, aborted]) : check.call.promise);
    if (!check.fresh || boot === null || signal?.aborted || this.stopped || runtime.generation !== generation) return { refused: "unverified" };
    return { boot_id: boot };
  }
  /** a proxied move's PC, as it is now: after the move succeeds, that connection reads its roster again */
  refreshAfterMove(id: string): () => void {
    const runtime = this.machines.get(id);
    const generation = runtime?.generation;
    return () => {
      if (!runtime || runtime.generation !== generation || this.stopped) return;
      void this.refresh(runtime).catch((e) => this.lost(runtime, generation!, e));
    };
  }
  patch(id: string, patch: { name?: unknown; enabled?: unknown }): void {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (runtime.machine.herdr_profile_id) throw new Error("Rename or disable this machine in herdr");
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (patch.name !== undefined) { if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 100) throw new Error("Enter a PC name (1–100 characters)"); runtime.machine.name = patch.name.trim(); }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
      runtime.machine.enabled = patch.enabled;
      if (!patch.enabled && runtime.machine.action_required === "windows_login") { runtime.machine.action_required = null; runtime.machine.error = null; }
      this.disconnect(runtime);
      for (const [id, job] of this.jobs) if (job.public.machine_id === runtime.machine.id) this.cancelJob(id);
      if (patch.enabled) void this.reconnect(runtime);
    }
    this.persist(); this.emit();
  }
  remove(id: string): void {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (runtime.machine.herdr_profile_id) throw new Error("Remove this machine in herdr");
    runtime.machine.enabled = false; this.disconnect(runtime);
    for (const [jobId, job] of this.jobs) if (job.public.machine_id === id) this.cancelJob(jobId);
    // the key goes first: a registration saved without the PC must not leave its credential behind
    if (runtime.machine.kind === "relay") removeRelayPcKey(this.relayKeyPath(id));
    this.machines.delete(id); this.persist();
    for (const suffix of ["", ".pub"]) try { unlinkSync(join(this.sshDir, id + suffix)); } catch {}
    this.emit();
  }
  private relayKeyPath(id: string): string { return join(this.stateDir, "relay-pcs", `${id}.json`); }
  /**
   * Settings → Remote PCs → Add a PC through the relay: pairs with the PC whose pairing link (its Settings → Phone &
   * devices → Copy link) this is, as a phone would, and adds it once that PC admitted this one. The link's code is
   * spent here; later connections sign in with the key this pairing made.
   */
  async addRelay(link: unknown, name?: unknown): Promise<Machine> {
    if (this.stopped) throw new Error("Server stopping");
    let offer: RelayOffer | null = null;
    if (typeof link === "string" && link.length <= 4096) try { offer = decodeOffer(link.trim()); } catch { offer = null; }
    if (!offer?.code) throw new Error("That is not a pairing link. On the other PC, turn the relay on in Settings → Phone & devices and copy its link.");
    if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 100)) throw new Error("Enter a PC name (1–100 characters)");
    const serverId = offer.server_id;
    if ([...this.machines.values()].some(({ machine }) => machine.relay?.server_id === serverId)) throw new Error("That PC is already added.");
    const id = randomUUID();
    const keyPath = this.relayKeyPath(id);
    const key = await RelayPcKey.create(keyPath, offer, () => !this.stopped);
    const runtime = this.runtime({
      id, name: (typeof name === "string" ? name.trim() : offer.name?.trim()) || "PC", kind: "relay", relay: { server_id: serverId, relay: offer.relay },
      enabled: true, state: "connecting", error: null, snapshot: null,
    });
    const generation = runtime.generation;
    let tunnel: RelayPcTunnel;
    try { tunnel = await openRelayPcTunnel(offer, key, { socket: this.relaySocket, onLost: (error) => this.lost(runtime, generation, error) }); }
    catch (error) {
      removeRelayPcKey(keyPath);
      throw new Error(error instanceof RelayPcRefused ? error.message : `That PC could not be reached through the relay: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (this.stopped || [...this.machines.values()].some(({ machine }) => machine.relay?.server_id === serverId)) {
      tunnel.close();
      removeRelayPcKey(keyPath);
      throw new Error(this.stopped ? "Server stopping" : "That PC is already added.");
    }
    runtime.tunnel = tunnel; runtime.endpoint = tunnel.endpoint;
    this.machines.set(id, runtime);
    // the PC is added only once its registration is on disk: a save that fails leaves no PC, connection or key behind
    try { this.persist(); } catch (error) {
      this.machines.delete(id);
      runtime.machine.enabled = false; this.disconnect(runtime);
      removeRelayPcKey(keyPath);
      throw new Error(`This PC could not be saved (${error instanceof Error ? error.message : String(error)}). That PC already lists it under Phone & devices as ${relayPcLabel()}: revoke it there.`, { cause: error });
    }
    this.emit();
    try { await this.observe(runtime); this.emit(); } catch (e) { this.lost(runtime, generation, e); }
    return runtime.machine;
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.discoveryTimer); clearInterval(this.localTimer); clearTimeout(this.saveTimer);
    for (const id of this.jobs.keys()) this.cancelJob(id);
    for (const runtime of this.machines.values()) this.disconnect(runtime);
    this.listeners.clear();
  }
}

/**
 * A pane after a status frame: a frame that names background tasks or a plan replaces
 * them; one that names neither leaves them. Every frame says whether the pane waits on its turn's work.
 */
export function paneAfterStatus(p: HerdrPane, message: Extract<ServerMessage, { type: "pane-status" }>): HerdrPane {
  const { background_tasks: before, background_wait: _waited, plan: planBefore, finish_id: _finish, ...pane } = p;
  const tasks = message.background_tasks === undefined ? before : message.background_tasks > 0 ? message.background_tasks : undefined;
  const plan = message.plan === undefined ? planBefore : message.plan ?? undefined;
  return { ...pane, agent_status: message.agent_status, ...(message.finish_id === undefined ? {} : { finish_id: message.finish_id }), ...(tasks === undefined ? {} : { background_tasks: tasks }), ...(message.background_wait ? { background_wait: true } : {}), ...(plan === undefined ? {} : { plan }) };
}

function snapshotAfterStatus(snapshot: SessionSnapshot, message: Extract<ServerMessage, { type: "pane-status" }>): SessionSnapshot {
  return { ...snapshot, finish_epoch: message.finish_epoch, panes: snapshot.panes.map((pane) => {
    if (pane.pane_id === message.pane_id) return paneAfterStatus(pane, message);
    if (snapshot.finish_epoch === message.finish_epoch) return pane;
    const { finish_id: _finish, ...rest } = pane;
    return rest;
  }) };
}

/** A remote PC's panes as its alerts take them: one waiting on its turn's background work is working. */
function forAlerts(panes: readonly HerdrPane[]): HerdrPane[] {
  return panes.map((pane) => pane.background_wait ? { ...pane, agent_status: alertStatus(pane.agent_status, true) } : pane);
}
