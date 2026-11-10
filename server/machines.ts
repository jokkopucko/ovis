import { authenticatedWebSocket } from "./remote-websocket.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as tcpServer } from "node:net";
import { hostname } from "node:os";
import { basename, join, posix } from "node:path";
import { BRIDGE_PROTOCOL, LOCAL_MACHINE, OWN_UPDATE_OFFER, REMOTE_BUNDLE_VERSION, type BridgeIdentity, type HerdrIdentity, type RemoteOvis, type Machine, type MachineAction, type MachineEvent, type MachineSettings, type PcInstallJob, type PcInstallRequest, type PcUpdateAll, type PcUpdateOffer, type SetupAction, type SetupJob, type SetupProgress, type SetupRequest, type SshTarget } from "../shared/machines.ts";
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
import { type HerdrMachineProfile, samePort, sameSshSession } from "./herdr-profiles.ts";
import { appBuild } from "./app-revision.ts";
import { shellQuote, validateTarget } from "./machine-security.ts";
import { parseFoundHerdrSessions, validHerdrSocket } from "./herdr-discovery.ts";
import { isCoreAdapterSocket } from "./herdr-core/pipe.ts";
import { writePrivateState } from "./private-state.ts";
import { holdsDocument, readStateDocument, setAsideDamaged } from "./state-document.ts";
import { detectHost, HERDR_INSTALL_CMD, installLockOwner, type RemoteHost } from "./remote-host.ts";
import type { FoundHerdrSession, FoundOvis } from "../shared/machines.ts";
import { DESKTOP_APP_UPDATES, REVISION, type UpdateStatus } from "../shared/update.ts";
import { discard, readCappedJson, REMOTE_LIMITS } from "./remote-json.ts";
import { SshConnection, sshClient } from "./ssh.ts";
import { WAITING_FOR_WINDOWS_LOGIN } from "./windows-herdr-start.ts";
import { decodeOffer, SERVER_ID_PATTERN, isWssOrigin, type RelayOffer } from "../shared/relay-offer.ts";
import { offerFromCode, TypedCodeError } from "../shared/relay-code-offer.ts";
import { TailnetPcError, TailnetPcs, type TailnetPcsOptions } from "./tailnet-pcs.ts";
import { sshCandidates, type SshCandidatesOptions } from "./ssh-candidates.ts";
import { followOwnUpdate, offerFromStatus, readOwnStatus, cancelledWords, cancelOwnUpdate, installIdOf, OwnUpdateCancelled } from "./pc-update.ts";
import { appRelease, INSTALLER, installPlanFor, PcInstaller, registeredIn, samePc, type InstallConnect, type InstallPlan } from "./pc-install.ts";
import { warmSshAddresses } from "./ssh-address.ts";
import { readMoveOffer } from "./remote-move.ts";

import type { RelaySocket } from "../shared/relay-channel.ts";
import { newRouteProbes, openRelayPcTunnel, RelayPcKey, RelayPcRefused, relayPcLabel, removeRelayPcKey, type RelayPcTunnel, type RouteProbes } from "./relay-pc.ts";
import type { HcMachine, MachineBridge } from "./herdr-core/machine-bridge.ts";

/** a PC keeps the six-digit code in its offer for 10 minutes at most (server/devices.ts) */
const RELAY_FOUND_MS = 10 * 60_000;

type StoredMachine = { id: string; name: string; enabled: boolean; snapshot?: SessionSnapshot | null }
  & ({ kind?: "ssh"; target: SshTarget; server_id?: string } | { kind: "relay"; relay: NonNullable<Machine["relay"]> });
interface Runtime {
  machine: Machine;
  ssh?: SshConnection;
  /** a PC added through the relay: its connection and loopback forward (server/relay-pc.ts) */
  tunnel?: RelayPcTunnel;
  /** when its earlier routes were last probed, kept across its tunnels (relay-pc.ts RouteProbes) */
  routeProbes?: RouteProbes;
  /** another machine of this PC's herdr-core (kind "hc"): what the core calls it, and its server once started (herdr-core/machine-bridge.ts) */
  hc?: { id: string; name: string; bridge?: MachineBridge };
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
  /** what the PC's own Ovis offers of its own update while connected (watchOwnOffer); undefined: not read yet */
  ownOffer?: PcUpdateOffer | null;
  /** the release that offer names (its latest_revision): an update asked for installs only that one */
  offerRevision?: string;
  /** the release an SSH PC's own Ovis, older than this app, offered at its last connect (remote_ovis): only that one is installed */
  remoteRevision?: string;
  offerTimer?: ReturnType<typeof setInterval>;
  /** the connection generation whose read of that offer is under way */
  offerReading?: number;
  /** its own Ovis updating itself, asked from here through its connection (updateOwn) */
  ownJob?: { id: string; abort: AbortController; finished?: Promise<void>; /** cancelled by the person (cancelUpdate), not by a disable or removal */ asked?: boolean };
  /**
   * What an install over SSH can put right where its own Ovis refused to update (PcInstaller): replace a server
   * started by hand, or restart one whose supervisor is too old; the process and the address it was seen at.
   */
  installFix?: InstallPlan & { target: SshTarget };
  /** its move badge's next read (watchMove): one read at a time, and `again` when one was asked for meanwhile */
  moveWatch?: { timer?: ReturnType<typeof setTimeout>; reading: boolean; again: boolean };
}
/** An update asked for that the PC cannot take now: answered 409 `update_unavailable` with these words. */
export class PcUpdateRefused extends Error {}
interface JobState {
  /** an own update asked for in this job (runOwnUpdate): asks that PC to stop it, and says what became of it */
  ownCancel?: () => Promise<string>;
  /** cancelled, its connection still closing (after ownCancel): its PC stays busy */
  closing?: boolean;
  /** that request to stop, until it is done: the setup's own ending waits for it before closing the connection */
  cancelling?: Promise<void>;
  update: boolean;
  /** Explicit consent for the next Windows cold-start attempt only. Never persisted. */
  headlessStart?: boolean;
  timedOut?: boolean;
  installationApproved?: boolean;
  /** started by the server for a PC whose bridge is out of date: key-only SSH, approval already given */
  auto: boolean;
  /** the connect an install ends with: it has no dialog to show a choice in */
  fromInstall?: boolean;
  /** the socket chosen in this setup is the default session's own (prepare): the PC is saved with none chosen */
  defaultSocket?: boolean;
  public: SetupJob;
  abort: AbortController;
  pending?: { resolve(value: string): void; reject(error: Error): void };
  ssh?: SshConnection;
  timer: ReturnType<typeof setTimeout>;
  /** the registered PC a bridge update is for, which shows it as `updating` */
  runtime?: Runtime;
  /** the PC's own Ovis updates itself in this job, asked by it (MachineManager.runOwnUpdate) */
  own?: boolean;
  /** the release the person was shown: another one on offer by then is refused, never installed (runOwnUpdate) */
  expectedRevision?: string;
  /** the release the PC's own Ovis offered at this connect (its revision): the one an install's follow-up update installs */
  offeredRevision?: string;
  stageStartedAt: number;
  finished: Promise<void>;
}
const DEFAULT_SETTINGS: MachineSettings = { auto_update_bridges: true };
/** an update asked for one release while the PC offers another by now: nothing of it is installed */
const CHANGED_OFFER = "That PC offers another release now than the one shown. Look at it again, then update.";
/** why Update all leaves out a PC whose update is an install over SSH */
const INSTALL_FROM_CARD = "This PC needs Ovis installed again over SSH, which changes more on it than an update: read what it does first, then start it for this PC alone.";
/** how many PCs' own updates Update all runs at once: each downloads, installs and builds on its PC, and is followed from here */
export const OWN_UPDATES_AT_ONCE = 4;
/** a setup job's phases once it has ended */
const TERMINAL = new Set<SetupJob["phase"]>(["connected", "failed", "cancelled"]);
const RELAY_PC_UPDATES = "A PC added through the relay runs its own Ovis, which updates itself: use Update on its card.";
const JOBS_FULL = "Finish or cancel the current connection jobs first";
/** connection jobs (setups and bridge updates) that may run at once */
const SETUP_JOBS_AT_ONCE = 4;
const DEFAULT_SESSION_ONLY = "Installing from here sets Ovis up for herdr's default session only, and this PC is added with a named session. Install it on that PC, or add it without a session.";
const UNREAD_RELEASE = "That PC's Ovis did not tell which release it would install, so it was not updated from here. Reconnect it, then try again.";
const NEWER_THAN_APP = "That release is newer than this app, which would then refuse to connect to that PC: update this app first, then this PC.";
/** this app's own release (package.json), the newest an SSH PC's own Ovis may be updated to from here */
const APP_VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
const UNKNOWN_RELEASE = "That PC offers a release that does not tell its version, so this app cannot check that it would still connect to that PC: update it on that PC.";
/** a release (`0.5.1`) or a beta of one (`0.6.0-beta.2`, older than `0.6.0`), as numbers to compare in order */
const releaseRank = (version: string): number[] | null => {
  const parts = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-beta\.(\d{1,6}))?$/.exec(version);
  return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3]), parts[4] === undefined ? Infinity : Number(parts[4])] : null;
};
/** the same release however it is written (a v prefix, build metadata): compared by its rank */
function sameRelease(a: string | null | undefined, b: string): boolean {
  const [x, y] = [a ? releaseRank(a.replace(/^v/, "").replace(/\+.*$/, "")) : null, releaseRank(b.replace(/^v/, "").replace(/\+.*$/, ""))];
  return !!x && !!y && x.every((part, i) => part === y[i]);
}
/** a release version newer than this app's; one that cannot be compared counts as newer */
function newerThanThisApp(version: string | null | undefined): boolean {
  if (!version) return false;
  const [a, b] = [releaseRank(version), releaseRank(APP_VERSION)];
  if (!a || !b) return true;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}
/** why an offered own update may not be started from here: a release past this app (which would then refuse that PC), or one it cannot check */
function pastThisApp(offer: { updatable: boolean; latest_version: string | null } | null | undefined): string | null {
  if (!offer?.updatable) return null;
  return !offer.latest_version ? UNKNOWN_RELEASE : newerThanThisApp(offer.latest_version) ? NEWER_THAN_APP : null;
}
const NOT_CONNECT_APPROVED = "Connect this PC first: it was added from herdr, and connecting it here was not approved yet.";
const NOT_BRIDGE_APPROVED = "Review the bridge update in this PC's dialog first: it was added from herdr without approving this app's bridge.";
/**
 * how often a PC's move badge is read again: every minute, and every 5 s while its move waits or runs.
 * Each read has that PC build its whole plan, so not more often.
 */
const MOVE_OFFER_MS = { idle: 60_000, active: 5000 };
/** a PC of herdr-core's machines is the core's: Ovis neither renames, removes nor sets it up */
const HC_MACHINE_MANAGED = "This PC is a machine of herdr-core: add, rename or remove it with `hc machine` or in the Herdr app.";
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
/** a choice offered for a live Ovis of this account's that cannot answer right now: nothing is started in its place */
const OWN_OVIS_UNANSWERED = "Ovis on this PC is running but not answering right now. Try it again in a moment, or start a new herdr here.";
/**
 * The Ovis chosen for this PC is gone (no registration, or its process not running). A reconnect waits for it as for an
 * own Ovis that is away (#2047): after a reboot SSH answers before that Ovis has started. A setup in its dialog asks.
 */
const OWN_OVIS_GONE = "Start Ovis on that PC, or start a new herdr here";
/** the chosen Ovis serves its herdr-core from a socket that is not the SSH account's own (coreSocketConfined): never used */
const OWN_OVIS_SOCKET_REFUSED = "The Ovis chosen on this PC serves herdr-core from a socket that is not this SSH account's own, so it was not used. Choose again, or start a new herdr here.";
/** the host an SSH destination names, without its user: where that PC's own Ovis is opened */
function sshHost(destination: string): string { return destination.slice(destination.lastIndexOf("@") + 1); }
/** a release version as a PC's updater tells it (`0.4.18`, or a beta `0.5.0-beta.2`), or null */
const releaseVersion = (value: unknown): string | null => typeof value === "string" && /^\d{1,6}\.\d{1,6}\.\d{1,6}(-beta\.\d{1,6})?$/.test(value) ? value : null;
/** another PC's own words, kept to one short line */
const remoteWords = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim().replace(/\s+/g, " ").slice(0, 300) : null;
/** An independently managed web server older than this app, which can install its own update: updating this PC asks it to. */
const ownUpdateOffered = (offer: RemoteOvis): string => `${OWN_UPDATE_OFFER}${offer.version ? ` v${offer.version}` : ""}, older than this app. Update it${offer.latest_version ? ` to v${offer.latest_version}` : ""} to reconnect; it updates itself, and herdr sessions keep running.`;
/** One that cannot: today's words, and why not. */
const ownUpdateRefused = (offer: RemoteOvis): string => `${independentBridge(REMOTE_BUNDLE_VERSION)} It cannot be updated from here: ${offer.reason}`;

/** A connection that retrying cannot fix: the PC waits for the user instead of reconnecting. */
export class MachineActionRequired extends Error {
  /** `newerServer`: the server that answered is newer than this app, as its own identity proved (verify) */
  constructor(message: string, readonly action: MachineAction, readonly newerServer = false, readonly foundHerdrSessions?: FoundHerdrSession[], readonly foundOvis?: FoundOvis[]) { super(message); }
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
  private hcTimer?: ReturnType<typeof setTimeout>;
  private hcStart?: (machine: Pick<HcMachine, "id" | "name">) => Promise<MachineBridge>;
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
  /** how often a connected PC's own Ovis is asked what it offers: its own check for releases runs every 5 minutes */
  private ownOfferMs: number;
  /** connected PCs Update all queued for their own update, in order, while OWN_UPDATES_AT_ONCE run */
  private ownWaiting: { id: string; shown?: string; token: symbol }[] = [];
  /** SSH PCs whose own update Update all runs through their setup, each holding a place among OWN_UPDATES_AT_ONCE */
  private ownViaSetup = new Set<string>();
  /** installs of Ovis over SSH (server/pc-install.ts) */
  private readonly installer: PcInstaller;
  /** PCs Update all queued for a bridge update, waiting for their turn on autoChain */
  /** each PC waiting in Update all's queue, by the token of its one entry there: a stale entry (cancelled, then queued again) is not it */
  private updateQueued = new Map<string, symbol>();
  private moveOfferMs: { idle: number; active: number };
  /** how a relay PC's connection reaches the relay; tests point it at a local one */
  private relaySocket?: (url: string) => RelaySocket;
  /** how a relay PC's connection dials that PC's direct carriers; tests point it at a local one */
  private relayDirectSocket?: (url: string) => RelaySocket;
  /**
   * PCs typed codes found (relayFoundByCode), waiting for the person to match their IDs, by a random ticket only the
   * asking window gets: each offer holds that PC's one-time code, so another client naming the PC's public ID takes none.
   */
  private foundByCode = new Map<string, { offer: RelayOffer; at: number }>();
  /** this server's own relay ID, where it has one: the local PC's `server_id` */
  private serverId?: () => string | undefined;
  /** other PCs of this PC's Tailscale login, added through the relay with one tap (server/tailnet-pcs.ts) */
  private readonly tailnet: TailnetPcs;
  /** where the SSH tab's list is read from (server/ssh-candidates.ts) */
  private readonly sshCandidateOptions: SshCandidatesOptions;

  constructor(readonly stateDir: string, private push: PushService, private completions: CompletionTracker, private readLocal: () => Promise<SessionSnapshot> = () => this.completions.readSnapshot(sessionSnapshot, labelOmoPanes),
    options: { /** Settings -> Experimental -> PCs: start a replaced server again (PcInstaller) */ restoreReplaced?: () => boolean; bootId?: string; localFinishEpoch?: () => string; now?: () => number; ownUpdate?: { pollMs?: number; startMs?: number; checkMs?: number; offerMs?: number }; moveOfferMs?: { idle: number; active: number }; relaySocket?: (url: string) => RelaySocket; relayDirectSocket?: (url: string) => RelaySocket; serverId?: () => string | undefined; tailnet?: TailnetPcsOptions; sshCandidates?: SshCandidatesOptions } = {}) {
    this.bootId = options.bootId;
    this.tailnet = new TailnetPcs(options.tailnet);
    this.sshCandidateOptions = options.sshCandidates ?? (options.tailnet?.readStatus === undefined ? {} : { readStatus: options.tailnet.readStatus });
    this.serverId = options.serverId;
    this.relaySocket = options.relaySocket;
    this.relayDirectSocket = options.relayDirectSocket;
    this.localFinishEpoch = options.localFinishEpoch;
    this.ownUpdatePollMs = options.ownUpdate?.pollMs ?? OWN_UPDATE_POLL_MS;
    this.ownUpdateStartMs = options.ownUpdate?.startMs ?? OWN_UPDATE_START_MS;
    this.ownUpdateCheckMs = options.ownUpdate?.checkMs ?? OWN_CHECK_WAIT_MS;
    this.ownOfferMs = options.ownUpdate?.offerMs ?? 5 * 60_000;
    this.moveOfferMs = options.moveOfferMs ?? MOVE_OFFER_MS;
    this.now = options.now ?? (() => performance.now());
    if (this.bootId) this.local.source_boot_id = this.bootId;
    this.profileState = new HerdrProfileState(stateDir);
    this.statePath = join(stateDir, "machines.json");
    this.relayStatePath = join(stateDir, "relay-pcs.json");
    this.sshDir = join(stateDir, "ssh");
    this.installer = new PcInstaller({ sshDir: this.sshDir, connect: (request) => this.installConnect(request), onChange: (job) => this.showInstall(job), restore: () => options.restoreReplaced?.() === true });
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
          // its relay ID as its health last said it, so its alerts are known by it before it answers again
          else machine = { ...common, kind: "ssh", target: validateTarget(item.target), ...(typeof item.server_id === "string" && SERVER_ID_PATTERN.test(item.server_id) ? { server_id: item.server_id } : {}) };
          const runtime = this.runtime(machine);
          this.machines.set(item.id, runtime);
          if (item.enabled) queueMicrotask(() => void this.reconnect(runtime));
        }
      }
    }
    // the saved PCs' addresses, resolved in the background now they are loaded, for the checks that keep one job per PC
    void warmSshAddresses([...this.machines.values()].flatMap((runtime) => runtime.machine.kind === "ssh" && runtime.machine.target ? [runtime.machine.target] : []));
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
            this.dropUpdate(runtime);
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
          this.dropUpdate(runtime);
          changed = true;
        }
        if (runtime.machine.name !== profile.label) { runtime.machine.name = profile.label; changed = true; }
        runtime.machine.enabled = enabled;
        runtime.machine.target = profile.target ? this.profileState.target(profile.id, profile.target) : undefined;
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
      this.dropUpdate(runtime);
      this.machines.delete(id);
      changed = true;
    }
    if (changed) this.emit();
    try { this.profileState.prune(new Set(profiles.map((p) => p.id)), (profileId) => this.removeKey(herdrMachineId(profileId))); }
    catch (error) { errors.push(error); }
    this.profileState.flush();
    if (errors.length) throw new AggregateError(errors, "Some saved machine keys could not be removed; cleanup will retry");
  }
  /**
   * On herdr-core, the core's other machines (`hc machine add`) as PCs, read every few seconds: each one's
   * server starts as it connects (`start`, herdr-core/machine-bridge.ts) and reaches its terminals through
   * this PC's core. A broken read keeps the PCs as they were.
   */
  watchHcMachines(read: () => Promise<HcMachine[]>, start: (machine: Pick<HcMachine, "id" | "name">) => Promise<MachineBridge>, intervalMs = 5000): void {
    if (this.hcStart || this.stopped) return;
    this.hcStart = start;
    let failures = 0, previousError: string | undefined;
    const poll = async () => {
      try {
        this.syncHcMachines(await read());
        failures = 0; previousError = undefined;
      } catch (error) {
        const message = error instanceof Error ? error.message : "read failed";
        if (!this.stopped && previousError !== message) console.error("herdr-core's machines could not be read:", message);
        previousError = message; failures++;
      }
      if (!this.stopped) { this.hcTimer = setTimeout(poll, Math.min(60_000, intervalMs * 2 ** Math.min(failures, 4))); this.hcTimer.unref(); }
    };
    void poll();
  }
  syncHcMachines(list: readonly HcMachine[]): void {
    if (this.stopped) return;
    const wanted = new Set<string>();
    let changed = false;
    for (const hc of list) {
      const id = `hc-${hc.id}`;
      wanted.add(id);
      let runtime = this.machines.get(id);
      if (!runtime) {
        runtime = this.runtime({ id, name: hc.name, kind: "hc", enabled: true, state: "disconnected", error: null, snapshot: null });
        runtime.hc = { id: hc.id, name: hc.name };
        this.machines.set(id, runtime);
        changed = true;
      }
      // its terminals are known by its name (`lab/t3`): renamed, its server starts again under the new one
      if (runtime.hc!.name !== hc.name) {
        this.disconnect(runtime);
        runtime.hc = { id: hc.id, name: hc.name };
        runtime.machine.name = hc.name;
        changed = true;
      }
      if (!hc.connected) {
        const error = `herdr-core cannot reach this machine (${hc.why ?? "not connected"})`;
        if (runtime.machine.state !== "disconnected" || runtime.machine.error !== error) { this.disconnect(runtime); runtime.machine.error = error; changed = true; }
      } else if (runtime.machine.state === "disconnected") {
        runtime.machine.error = null;
        void this.reconnect(runtime);
      }
    }
    for (const [id, runtime] of this.machines) {
      if (runtime.machine.kind !== "hc" || wanted.has(id)) continue;
      runtime.machine.enabled = false; this.disconnect(runtime);
      this.machines.delete(id);
      changed = true;
    }
    if (changed) this.emit();
  }
  private mayConnect(runtime: Runtime): boolean {
    const machine = runtime.machine;
    return !machine.herdr_profile_id || !!machine.target && this.profileState.connectionApproved(machine.herdr_profile_id, machine.target);
  }
  private setupOwns(runtime: Runtime): boolean {
    return [...this.jobs.values()].some((job) => job.public.machine_id === runtime.machine.id && (!TERMINAL.has(job.public.phase) || job.closing));
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
  list(): Machine[] {
    const own = this.serverId?.();
    // ovis_update is derived from the PC's state at each read; the roster hands out its live PCs
    for (const runtime of this.machines.values()) {
      // told for the connection it was proven on: a PC away may run another one by the time it is back
      runtime.machine.runtime = runtime.machine.state === "connected" && runtime.machine.herdr ? runtime.machine.herdr.runtime ?? "herdr" : undefined;
      if (runtime.machine.kind !== "hc") runtime.machine.ovis_update = this.updateOffer(runtime);
    }
    return [own ? { ...this.local, server_id: own } : this.local, ...[...this.machines.values()].map((r) => r.machine)];
  }
  /**
   * The update a PC can take from here (Machine.ovis_update): a connected PC's own Ovis's offer, else what its last
   * try to connect was refused for (a bridge of another version, or an own Ovis older than this app).
   */
  private updateOffer(runtime: Runtime): PcUpdateOffer | null {
    const machine = runtime.machine;
    // a disabled PC is not this app's to touch: updating it would connect it again (setup enables what it connects)
    if (machine.kind === "hc" || !machine.enabled) return null;
    if (machine.state === "connected") {
      if (!runtime.ownOffer) return null;
      const offer = { ...runtime.ownOffer, revision: runtime.offerRevision ?? null };
      // an SSH PC on a release newer than this app is refused by it (a newer bridge): updating it would cut it off from here
      const past = machine.kind === "ssh" ? pastThisApp(offer) : null;
      return past ? { ...offer, updatable: false, reason: past } : offer;
    }
    const own = machine.remote_ovis;
    const fix = runtime.installFix;
    if (machine.kind === "ssh" && own && !own.updatable && fix && machine.target && sameSshSession(fix.target, machine.target)) {
      const release = appRelease();
      // it ends with this app's setup there, which needs the same approvals as an update
      // a restart then updates it to the release its own Ovis offers: never one newer than this app
      const unapproved = (machine.target.session ? DEFAULT_SESSION_ONLY : null) ?? (fix.mode === "restart" ? pastThisApp({ updatable: true, latest_version: own.latest_version }) : null) ?? (!this.mayConnect(runtime) ? NOT_CONNECT_APPROVED : !this.mayManageBridge(runtime) ? NOT_BRIDGE_APPROVED : null);
      return { how: "install", current_version: own.version, latest_version: fix.mode === "replace" ? release.slice(1) : own.latest_version, updatable: !unapproved, reason: unapproved,
        ...(fix.mode === "restart" ? { revision: runtime.remoteRevision ?? null } : {}),
        steps: fix.mode === "replace"
          ? [`Stop the Ovis server started by hand on that PC (process ${fix.pid}); its settings and data stay.`, `Install Ovis ${release} there with its official installer (install.sh at ${release}, as ${INSTALLER} gives it), as a herdr plugin that updates itself; an Ovis already installed there is started and updated instead.`, "As when it is run by hand, the installer adds what is missing for this account only (herdr, Bun 1.4 or newer, which may add itself to the shell's startup file), and serves Ovis to the tailnet when Tailscale runs there.", "Start it and connect to it. herdr and its sessions keep running."]
          : [`Restart that PC's Ovis (process ${fix.pid}) through its own launcher (its herdr plugin or user service), so it runs the supervisor that installs updates.`, `Then have it install its update${own.latest_version ? ` v${own.latest_version}` : ""}. herdr and its sessions keep running.`] };
    }
    if (machine.kind === "ssh" && own) {
      // its own update runs through this app's setup there, which needs the same approvals as a bridge update
      const unapproved = !own.updatable ? null : pastThisApp(own) ?? (!this.mayConnect(runtime) ? NOT_CONNECT_APPROVED : !this.mayManageBridge(runtime) ? NOT_BRIDGE_APPROVED : null);
      return { how: "own", current_version: own.version, latest_version: own.latest_version, updatable: own.updatable && !unapproved, reason: unapproved ?? own.reason, revision: runtime.remoteRevision ?? null };
    }
    if (machine.kind === "ssh" && machine.action_required === "update_bridge") {
      if (!this.mayConnect(runtime)) return { how: "bridge", current_version: null, latest_version: null, updatable: false, reason: NOT_CONNECT_APPROVED };
      const approved = this.mayManageBridge(runtime);
      return { how: "bridge", current_version: null, latest_version: null, updatable: approved, reason: approved ? null : NOT_BRIDGE_APPROVED };
    }
    return null;
  }
  /**
   * A connected PC's own Ovis (a relay PC's, or an SSH PC's own server), asked what it offers now and every few
   * minutes while connected. A bridge this app installed never updates itself, so it is not asked.
   */
  private watchOwnOffer(runtime: Runtime, generation: number): void {
    const target = runtime.machine.target;
    const own = runtime.machine.kind === "relay" || runtime.machine.kind === "ssh" && !!target && !!runtime.ownOvisAt && sameSshSession(runtime.ownOvisAt, target);
    if (!own) return;
    const read = async () => {
      const endpoint = runtime.endpoint;
      // one read per connection at a time; a read of an earlier connection does not hold this one's back
      if (runtime.offerReading === generation || !endpoint || generation !== runtime.generation || this.stopped) return;
      runtime.offerReading = generation;
      let offer: PcUpdateOffer | null = null;
      let revision: string | undefined;
      // a server too old to answer the bridge token here offers nothing
      try {
        const status = await readOwnStatus(endpoint);
        offer = offerFromStatus(status);
        if (offer && typeof status?.latest_revision === "string") revision = status.latest_revision;
      } catch { /* none known until the next read */ }
      finally { if (runtime.offerReading === generation) runtime.offerReading = undefined; }
      if (generation !== runtime.generation || this.stopped) return;
      runtime.offerRevision = revision;
      if (JSON.stringify(offer) !== JSON.stringify(runtime.ownOffer ?? null)) { runtime.ownOffer = offer; this.emit(); }
    };
    void read();
    runtime.offerTimer = setInterval(() => void read(), this.ownOfferMs);
    runtime.offerTimer.unref();
  }
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
   * disk pays for the write and its fsync. `relayLast` is for the save that adds a relay PC
   * (addRelay): relay-pcs.json, its registration, goes last instead, so a save that fails before it
   * leaves the PC off disk, as it leaves no key (#2833).
   */
  private persist(relayLast = false): void {
    if (!relayLast) this.persistRelayPcs();
    // herdr's saved machines and herdr-core's are their catalogs': read again, never saved here
    const owned = [...this.machines.values()].filter(({ machine }) => !machine.herdr_profile_id && machine.kind !== "hc").map(({ machine }) => machine);
    const data: StoredMachine[] = owned.filter((m) => m.kind !== "relay").map((m) => ({ id: m.id, name: m.name, target: m.target!, ...(m.server_id ? { server_id: m.server_id } : {}), enabled: m.enabled, snapshot: m.snapshot }));
    const text = JSON.stringify(data);
    // the PCs' registrations are written last: a save that fails before them leaves them as they were on disk, so a
    // PC moved to another address (setup) is saved there only when nothing else of its save can still fail (#2075)
    for (const { machine } of this.machines.values()) if (machine.herdr_profile_id) this.profileState.saveSnapshot(machine.herdr_profile_id, machine.snapshot);
    this.profileState.flush();
    // the file on disk may have been deleted or replaced since this manager wrote it
    if (text !== this.written || !holdsDocument(this.statePath, text)) { writePrivateState(this.statePath, data); this.written = text; }
    if (relayLast) this.persistRelayPcs();
  }
  private persistRelayPcs(): void {
    const relayPcs: StoredMachine[] = [...this.machines.values()].map(({ machine }) => machine).filter((m) => !m.herdr_profile_id && m.kind === "relay")
      .map((m) => ({ id: m.id, name: m.name, kind: "relay", relay: m.relay!, enabled: m.enabled, snapshot: m.snapshot }));
    const relayText = JSON.stringify(relayPcs);
    if (relayText !== this.relayWritten || !holdsDocument(this.relayStatePath, relayText)) {
      // never an empty file where none was: an install without relay PCs keeps none
      if (relayPcs.length > 0 || this.relayWritten !== undefined || existsSync(this.relayStatePath)) writePrivateState(this.relayStatePath, relayPcs);
      this.relayWritten = relayText;
    }
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
  updateBridge(id: string, scheduled = false, expectedRevision?: string): SetupJob {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (runtime.machine.kind === "relay") throw new Error(RELAY_PC_UPDATES);
    if (runtime.machine.kind === "hc") throw new Error(HC_MACHINE_MANAGED);
    // its own Ovis updating itself: a bridge update would disconnect it and take over its progress
    if (runtime.ownJob) throw new PcUpdateRefused("This PC is already updating.");
    if (!this.mayConnect(runtime)) throw new MachineActionRequired("Connect this machine first", "connect");
    // A saved herdr machine connected without bridge approval reviews the update in its dialog;
    // an unattended update would also record that approval for later automatic updates.
    if (!this.mayManageBridge(runtime)) throw new MachineActionRequired("Review the bridge update for this machine", "update_bridge");
    // the user's own Update bridge takes back an earlier Cancel; a scheduled one does not
    if (!scheduled) runtime.updateCancelled = false;
    // its own Ovis on a release newer than this app would be refused by it afterwards, cut off from here (updateOffer)
    const past = pastThisApp(runtime.machine.remote_ovis);
    if (past) throw new PcUpdateRefused(past);
    // the release its card shows (the offer its last connect read), when the caller names none
    const revision = expectedRevision ?? runtime.remoteRevision;
    return this.setup({ ...runtime.machine.target!, machine_id: id, update_remote: true }, { auto: true, ...(revision ? { expectedRevision: revision } : {}) });
  }
  /**
   * Updates a PC from here, whichever way it is reached (POST /api/machines/:id/update): a connected PC's own Ovis
   * installs its offered release (updateOwn), anything else goes through the bridge update (updateBridge), which
   * also asks an own Ovis older than this app. Throws PcUpdateRefused, in plain words, when there is none to take.
   */
  update(id: string, shown?: string): { job_id: string } {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (this.updateRunning(runtime)) throw new PcUpdateRefused("This PC is already updating.");
    const offer = this.updateOffer(runtime);
    if (!offer) throw new PcUpdateRefused(runtime.machine.state === "connected" ? "This PC's Ovis is up to date." : "This PC is not connected; its update is offered once it is.");
    if (!offer.updatable) throw new PcUpdateRefused(offer.reason ?? "This PC cannot take its update from here.");
    // the release the person saw: one the PC offers instead since is shown first, never installed unseen
    if (shown !== undefined && typeof offer.revision === "string" && shown !== offer.revision) throw new PcUpdateRefused("That PC offers another release now than the one shown. Look at it again, then update.");
    if (offer.how === "install") return { job_id: this.install({ machine_id: id }, shown ?? offer.revision ?? undefined).id };
    if (runtime.machine.state === "connected") return { job_id: this.updateOwn(runtime, shown ?? offer.revision ?? undefined) };
    return { job_id: this.updateBridge(id, false, shown ?? offer.revision ?? undefined).id };
  }
  /**
   * Installs Ovis over SSH (POST /api/machines/install): on a PC not added here, which is added once it answers; or
   * on a PC added here whose own Ovis cannot update itself, as its offer's steps say. Throws PcUpdateRefused.
   */
  install(request: PcInstallRequest, shown?: string): PcInstallJob {
    if (this.stopped) throw new Error("Server stopping");
    const name = "name" in request ? request.name : undefined;
    if (name !== undefined && (typeof name !== "string" || name.length > 100)) throw new Error("PC name must be at most 100 characters");
    if (request.machine_id !== undefined) {
      const runtime = this.machines.get(request.machine_id);
      if (!runtime) throw new Error("PC not found");
      const fix = runtime.installFix;
      if (runtime.machine.kind !== "ssh" || !fix || !runtime.machine.target || !sameSshSession(fix.target, runtime.machine.target)) throw new PcUpdateRefused("Nothing on that PC needs installing from here; update it with Update.");
      if (this.updateRunning(runtime)) throw new PcUpdateRefused("This PC is already updating.");
      // another PC saved at the same address may be installing or connecting there right now
      const at = runtime.machine.target;
      if (this.installer.runningAt(at) || [...this.jobs.values()].some((job) => (!TERMINAL.has(job.public.phase) || job.closing) && samePc(job.public.target, at))) throw new PcUpdateRefused("That PC is being installed or connected already; wait for it to finish.");
      // only as its card offers it: an enabled PC this app may connect to and manage, never past this app's release
      const offer = this.updateOffer(runtime);
      if (offer?.how !== "install" || !offer.updatable) throw new PcUpdateRefused(offer?.reason ?? "Nothing on that PC needs installing from here; update it with Update.");
      runtime.machine.update_error = null;
      // a restart's update installs the release its card showed, or none
      const revision = fix.mode === "restart" ? shown ?? offer.revision ?? undefined : undefined;
      if (fix.mode === "restart" && !revision) throw new PcUpdateRefused(UNREAD_RELEASE);
      return this.installer.start({ target: runtime.machine.target, machine_id: runtime.machine.id, plan: { mode: fix.mode, pid: fix.pid, ...(fix.token ? { token: fix.token } : {}), ...(fix.socket ? { socket: fix.socket } : {}) }, ...(revision ? { revision } : {}) });
    }
    const target = validateTarget(request);
    // the same PC as ssh resolves it (an alias, or its default port given), added for herdr's default session
    if ([...this.machines.values()].some((runtime) => runtime.machine.target && !runtime.machine.target.session && samePc(runtime.machine.target, target, false))) throw new PcUpdateRefused("That PC is already added here; update it from its card.");
    if (this.installer.runningAt(target) || [...this.jobs.values()].some((job) => (!TERMINAL.has(job.public.phase) || job.closing) && samePc(job.public.target, target))) throw new PcUpdateRefused("That PC is being installed or connected already; wait for it to finish.");
    return this.installer.start({ target, ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}) });
  }
  installJob(id: string): PcInstallJob | undefined { return this.installer.job(id); }
  cancelInstall(id: string): void { this.installer.cancel(id); }
  /**
   * Resolves (ssh -G, in the background, 3 s at most each) the address a setup or install names and those of the jobs and
   * PCs it is checked against, so its one-job-per-PC and already-added checks compare what ssh resolves, a dotted alias
   * or an IP for a host name included. One that fails stays compared as written (a bare alias as possibly any PC).
   */
  async resolveFor(body: unknown): Promise<void> {
    const request = (typeof body === "object" && body !== null ? body : {}) as { destination?: unknown; port?: unknown; machine_id?: unknown };
    const targets: SshTarget[] = [];
    // only an address the setup would take: never anything ssh could read as an option
    if (typeof request.destination === "string") { try { targets.push(validateTarget({ destination: request.destination, ...(typeof request.port === "number" ? { port: request.port } : {}) })); } catch { /* refused by the setup itself */ } }
    const saved = typeof request.machine_id === "string" ? this.machines.get(request.machine_id)?.machine.target : undefined;
    if (saved) targets.push(saved);
    for (const job of this.jobs.values()) if (!TERMINAL.has(job.public.phase) || job.closing) targets.push(job.public.target);
    for (const job of this.installer.running()) targets.push(job.target);
    for (const runtime of this.machines.values()) if (runtime.machine.kind === "ssh" && runtime.machine.target) targets.push(runtime.machine.target);
    await warmSshAddresses(targets);
  }
  /** the connect an install ends with: the usual setup, with the update asked for when the install restarted it */
  private installConnect: InstallConnect = (request) => {
    // keys only, as the install itself: a PC that asks for a password or a new host key by now fails with why
    const start = (update: boolean, revision?: string) => this.setup({ ...request.target, ...(request.name ? { name: request.name } : {}), ...(request.machine_id ? { machine_id: request.machine_id } : {}), ...(update ? { update_remote: true } : {}) },
      { ...(update ? { auto: true } : {}), ...(revision ? { expectedRevision: revision } : {}), keysOnly: true, fromInstall: true });
    const ended = async (job: SetupJob) => { await this.jobs.get(job.id)?.finished; return this.jobs.get(job.id)?.public ?? job; };
    let current = start(false);
    let cancelled = false;
    // the update ran in a follow-up connect
    let followed = false;
    // the PC's own update this install started after a restart, ended by its cancel too
    let own: Runtime["ownJob"];
    const finished = (async () => {
      let result = await ended(current);
      // still older than this app (a restarted supervisor, or an install kept as it was, on a PC added here or not yet): its
      // own update now, as its steps said
      if (request.update && result.phase === "failed" && result.action_required === "update_bridge") {
        // a cancel that came while the first connect ended: nothing more is started
        if (cancelled) return "Cancelled";
        // its update, as update-bridge asks it: never to a release newer than this app (which would then refuse it), and
        // only the release checked here: the one its card showed for a restart, else the one this connect read. Another
        // one on offer by then is refused, never installed (runOwnUpdate)
        const past = pastThisApp(result.remote_ovis ? { updatable: true, latest_version: result.remote_ovis.latest_version } : null);
        if (past) return past;
        // without a card's revision (a replacement, or a fresh install that found an older Ovis there), the release shown was
        // this app's own: its update installs that release only, never another one the PC offers by now
        if (!request.revision && !sameRelease(result.remote_ovis?.latest_version, APP_VERSION)) return `That PC offers another release now (${result.remote_ovis?.latest_version ? `v${result.remote_ovis.latest_version}` : "none it names"}) than the one shown (v${APP_VERSION}). Look at it again, then update.`;
        // the build shown is this app's own (its revision): another build of that version the PC offers is never adopted
        const offered = this.jobs.get(current.id)?.offeredRevision;
        if (!offered) return UNREAD_RELEASE;
        // this app's own build in every runtime (the desktop app's server too, which no supervisor runs: #3400)
        const revision = request.revision ?? appBuild.revision();
        if (!revision) return "This app is not a release build, so it cannot tell which build of its release it showed; update that PC from its own Settings → Updates.";
        if (!request.revision && offered !== revision) return `That PC offers another build of v${APP_VERSION} than this app's, the one shown. Look at it again, then update.`;
        current = start(true, revision); request.onJob?.(current.id); result = await ended(current);
        followed = true;
      }
      // a restarted PC whose bridge was already this app's connects with no update asked: its own update of the release
      // its card showed follows, as its steps said, shown on its card as any update is
      const runtime = request.machine_id ? this.machines.get(request.machine_id) : undefined;
      if (result.phase === "connected" && request.update && request.revision && !followed && !cancelled && runtime?.machine.state === "connected" && !runtime.ownJob) {
        // the install ends with it: connected once that update has installed, or failed with its words
        this.updateOwn(runtime, request.revision);
        // updateOwn set it: read again past the check above
        own = (runtime as Pick<Runtime, "ownJob">).ownJob;
        await own?.finished;
        if (cancelled) return "Cancelled";
        if (runtime.machine.update_error) return runtime.machine.update_error;
      }
      return result.phase === "connected" ? null : result.error ?? `The connection to that PC ended: ${result.step}`;
    })();
    // the person's cancel of the install: its follow-up update there is asked to stop as well
    return { job_id: current.id, cancel: () => { cancelled = true; this.cancelJob(current.id, false, true); if (own) own.asked = true; own?.abort.abort(); }, finished };
  };
  /** an install for a PC added here shows on its card as its update does */
  private showInstall(job: PcInstallJob): void {
    const runtime = job.machine_id ? this.machines.get(job.machine_id) : undefined;
    if (!runtime) return;
    const ended = job.phase === "connected" || job.phase === "failed" || job.phase === "cancelled";
    if (!ended && job.phase !== "connecting_pc") runtime.machine.updating = { job_id: job.id, step: job.step, progress: null, ovis: true };
    if (ended && runtime.machine.updating?.job_id === job.id) runtime.machine.updating = null;
    if (job.phase === "failed") runtime.machine.update_error = job.error;
    this.emit();
    // one of Update all's own updates or installs ended: the next waiting one starts
    if (ended) queueMicrotask(() => this.nextOwn());
  }
  /** Update all (POST /api/machines/update-all): every PC with an update on offer, each as `update` would. */
  updateAll(): PcUpdateAll {
    const result: PcUpdateAll = { started: [], queued: [], skipped: [] };
    for (const runtime of this.machines.values()) {
      const id = runtime.machine.id;
      const offer = this.updateOffer(runtime);
      if (!offer) continue;
      if (this.updateRunning(runtime)) { result.skipped.push({ machine_id: id, reason: "This PC is already updating." }); continue; }
      if (!offer.updatable) { result.skipped.push({ machine_id: id, reason: offer.reason ?? "This PC cannot take its update from here." }); continue; }
      // an install over SSH changes more on that PC than an update (its steps say what): its card starts it, once read
      if (offer.how === "install") { result.skipped.push({ machine_id: id, reason: INSTALL_FROM_CARD }); continue; }
      // every own update counts against one limit, a connected PC's and an SSH PC's asked through its setup alike
      const own = runtime.machine.state === "connected" || offer.how === "own";
      const shown = offer.revision ?? undefined;
      // one PC whose update cannot start (no setup slot free, say) is told under skipped; the others go on
      try {
        if (own && this.mayStartOwn(runtime)) { result.started.push({ machine_id: id, job_id: this.startOwn(runtime, shown) }); continue; }
        if (own) this.queueOwn(runtime, shown); else this.queueUpdate(runtime);
        result.queued.push(id);
      } catch (error) { result.skipped.push({ machine_id: id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    this.emit();
    return result;
  }
  /** Ends the wait of this PC's update, or takes it out of Update all's queue; an install already running there runs on. */
  cancelUpdate(id: string): boolean {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (runtime.ownJob) { runtime.ownJob.asked = true; runtime.ownJob.abort.abort(); return true; }
    const install = this.installer.runningFor(id);
    if (install) { this.installer.cancel(install.id); return true; }
    if (this.updateQueued.delete(id)) { runtime.machine.updating = null; this.emit(); return true; }
    // a bridge update running now, an automatic one too (it stays in autoQueued until it ends)
    const job = [...this.jobs.values()].find((j) => j.runtime === runtime && j.update && !TERMINAL.has(j.public.phase));
    if (job) { this.cancelJob(job.public.id, false, true); return true; }
    // an automatic bridge update waiting its turn: it is not started, as after a Cancel of a running one
    if (this.autoQueued.has(id)) { runtime.updateCancelled = true; return true; }
    return false;
  }
  /** a PC disabled or removed: no update of it is waited for any more */
  private dropUpdate(runtime: Runtime): void {
    runtime.ownJob?.abort.abort();
    const install = this.installer.runningFor(runtime.machine.id);
    if (install) this.installer.cancel(install.id);
    if (this.updateQueued.delete(runtime.machine.id)) runtime.machine.updating = null;
  }
  private updateRunning(runtime: Runtime): boolean {
    // an automatic bridge update already waiting for this PC counts too: Update all would only repeat it
    return !!runtime.ownJob || this.updateQueued.has(runtime.machine.id) || this.autoQueued.has(runtime.machine.id) || !!this.installer.runningFor(runtime.machine.id) || [...this.jobs.values()].some((j) => j.public.machine_id === runtime.machine.id && !TERMINAL.has(j.public.phase));
  }
  /** room for one more own update: four at once, and those through setup leave one setup slot of the four free */
  private mayStartOwn(runtime: Runtime): boolean {
    return this.ownRunning() < OWN_UPDATES_AT_ONCE && (runtime.machine.state === "connected" || this.ownViaSetup.size < SETUP_JOBS_AT_ONCE - 1);
  }
  private ownRunning(): number { let running = this.ownViaSetup.size; for (const runtime of this.machines.values()) if (runtime.ownJob || this.installer.runningFor(runtime.machine.id)) running++; return running; }
  /**
   * One own update of Update all: a connected PC's through its connection, an SSH PC's own Ovis older than this app
   * through its setup, holding a place among OWN_UPDATES_AT_ONCE until that ends.
   */
  private startOwn(runtime: Runtime, shown?: string): string {
    if (runtime.machine.state === "connected") return this.updateOwn(runtime, shown);
    const id = runtime.machine.id;
    this.ownViaSetup.add(id);
    const release = () => { this.ownViaSetup.delete(id); this.nextOwn(); };
    try {
      const job = this.updateBridge(id, false, shown);
      void (this.jobs.get(job.id)?.finished ?? Promise.resolve()).finally(release);
      return job.id;
    } catch (error) { release(); throw error; }
  }
  /** an own update of Update all past the ones running at once: started as one of them ends (nextOwn) */
  private queueOwn(runtime: Runtime, shown?: string): void {
    const token = Symbol(runtime.machine.id);
    this.updateQueued.set(runtime.machine.id, token);
    this.ownWaiting.push({ id: runtime.machine.id, shown, token });
    runtime.machine.updating = { job_id: "", step: "Waiting for the PCs before it to finish updating…", progress: null, queued: true };
  }
  private nextOwn(): void {
    for (let i = 0; !this.stopped && this.ownRunning() < OWN_UPDATES_AT_ONCE && i < this.ownWaiting.length;) {
      const { id, shown, token } = this.ownWaiting[i]!;
      const runtime = this.machines.get(id);
      // one through setup waits while the setup slots it may take are held; one after it may go meanwhile
      if (runtime && this.updateQueued.get(id) === token && !this.mayStartOwn(runtime)) { i++; continue; }
      this.ownWaiting.splice(i, 1);
      // cancelled, disabled or removed meanwhile, or queued again since (that later entry is the one that runs)
      if (this.updateQueued.get(id) !== token || !runtime) continue;
      this.updateQueued.delete(id);
      runtime.machine.updating = null;
      // still offered, and still connected: an update before its turn may have done it, or the PC went away
      const offer = this.updateOffer(runtime);
      if (!offer?.updatable || this.updateRunning(runtime) || offer.how === "install" || !(runtime.machine.state === "connected" || offer.how === "own")) continue;
      // the release it was queued for: another one on offer by its turn is told, never installed unseen
      if (shown !== undefined && typeof offer.revision === "string" && offer.revision !== shown) { runtime.machine.update_error = CHANGED_OFFER; continue; }
      try { this.startOwn(runtime, shown); } catch (error) { runtime.machine.update_error = error instanceof Error ? error.message : String(error); }
    }
    this.emit();
  }
  /** a bridge update of Update all, after the ones before it: they share one bundle download */
  private queueUpdate(runtime: Runtime): void {
    const id = runtime.machine.id;
    const shown = this.updateOffer(runtime)?.revision ?? undefined;
    const token = Symbol(id);
    this.updateQueued.set(id, token);
    runtime.machine.updating = { job_id: "", step: "Waiting for the PCs before it to finish updating…", progress: null, queued: true };
    this.autoChain = this.autoChain.then(async () => {
      // cancelled, removed or stopped meanwhile, or queued again since (that later entry is the one that runs)
      if (this.updateQueued.get(id) !== token || this.stopped || this.machines.get(id) !== runtime) return;
      this.updateQueued.delete(id);
      runtime.machine.updating = null;
      // still needed: an update before its turn (an automatic one, or one asked for by hand) may have done it
      const offer = this.updateOffer(runtime);
      if (!offer?.updatable || runtime.machine.state === "connected" || this.updateRunning(runtime)) { this.emit(); return; }
      if (shown !== undefined && typeof offer.revision === "string" && offer.revision !== shown) { runtime.machine.update_error = CHANGED_OFFER; this.emit(); return; }
      try { const job = this.updateBridge(id, false, shown); await this.jobs.get(job.id)?.finished; }
      catch (error) { runtime.machine.update_error = error instanceof Error ? error.message : String(error); this.emit(); }
    });
  }
  /**
   * A connected PC's own Ovis installs the release it offers, asked through its connection (server/pc-update.ts),
   * and is followed through its restart until it answers on that release. Its steps show on `updating`, a failure on
   * `update_error`.
   */
  private updateOwn(runtime: Runtime, shown?: string): string {
    const id = randomUUID();
    const abort = new AbortController();
    runtime.ownJob = { id, abort };
    runtime.machine.update_error = null;
    // only this PC, at the address it had when asked: a PC removed, replaced or moved meanwhile is not asked
    const target = runtime.machine.target;
    const same = () => this.machines.get(runtime.machine.id) === runtime && (!target || !!runtime.machine.target && sameSshSession(target, runtime.machine.target));
    const revision = shown ?? runtime.offerRevision;
    const show = (step: string) => {
      if (runtime.ownJob?.id !== id) return;
      runtime.machine.updating = { job_id: id, step, progress: null, ovis: true };
      this.emit();
    };
    show("Asking this PC's own Ovis to update itself…");
    const finished = followOwnUpdate({
      cancelled: () => !this.stopped && runtime.ownJob?.asked === true,
      endpoint: () => same() && runtime.machine.enabled && runtime.machine.state === "connected" ? runtime.endpoint : undefined,
      revision,
      // it came back on a version this app refuses, or was turned away: it no longer reconnects by itself
      refused: () => !same() ? "This PC was removed or moved to another address, so its update is no longer followed." : runtime.machine.state === "error" ? runtime.machine.error ?? "This PC stopped reconnecting." : null,
      signal: abort.signal, onStep: show,
      pollMs: this.ownUpdatePollMs, startMs: this.ownUpdateStartMs, checkMs: this.ownUpdateCheckMs,
    }).then(() => {
      // the release it now runs is no longer on offer; a newer one a read since has found stays
      if (runtime.offerRevision === revision) { runtime.ownOffer = null; runtime.offerRevision = undefined; }
    }, (error: unknown) => {
      // a cancel's own words are kept when the update may go on there
      // a cancel's outcome there (stopped, or may still finish) is told as well
      if (!this.stopped && (!abort.signal.aborted || (error instanceof OwnUpdateCancelled && error.there !== "none"))) runtime.machine.update_error = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      if (runtime.ownJob?.id !== id) return;
      runtime.ownJob = undefined;
      runtime.machine.updating = null;
      this.emit();
      this.nextOwn();
    });
    runtime.ownJob.finished = finished;
    return id;
  }
  setup(request: SetupRequest, options: { auto?: boolean; expectedRevision?: string; keysOnly?: boolean; fromInstall?: boolean } = {}): SetupJob {
    if (this.stopped) throw new Error("Server stopping");
    let target = validateTarget(request);
    // an install over SSH stops and starts that PC's Ovis: nothing else connects there until it hands over
    if (!options.fromInstall && (this.installer.runningAt(target) || request.machine_id && this.installer.runningFor(request.machine_id))) throw new Error("Ovis is being installed on this PC; wait for it to finish, or cancel it.")
    const existing = request.machine_id ? this.machines.get(request.machine_id) : undefined;
    // a PC saved in herdr is named by its catalog (any length); a name sent with it is not read
    const name = existing?.machine.herdr_profile_id ? undefined : request.name;
    if (name !== undefined && (typeof name !== "string" || name.length > 100)) throw new Error("PC name must be at most 100 characters");
    const waiting = existing && [...this.jobs.values()].find((j) => j.public.machine_id === existing.machine.id && j.public.phase === "starting" && (j.public.action_required === "windows_login" || j.public.action_required === "windows_start_failed"));
    if (waiting && !request.update_remote && sameSshSession(target, waiting.public.target) && target.identity_file === waiting.public.target.identity_file) return waiting.public;
    // an update that asks for a setup slot when none is free cannot run now: told as any update that cannot (409)
    if ([...this.jobs.values()].filter((j) => !["connected", "failed", "cancelled"].includes(j.public.phase)).length >= SETUP_JOBS_AT_ONCE) throw (request.update_remote ? new PcUpdateRefused(JOBS_FULL) : new Error(JOBS_FULL));
    if (request.machine_id && !existing) throw new Error("PC not found");
    if (existing?.machine.kind === "relay") throw new Error(RELAY_PC_UPDATES);
    if (existing?.machine.kind === "hc") throw new Error(HC_MACHINE_MANAGED);
    if (existing && [...this.jobs.values()].some((j) => j.public.machine_id === existing.machine.id && !["connected", "failed", "cancelled"].includes(j.public.phase))) throw new Error("A connection job for this PC is already running");
    // and one per PC as ssh resolves it, for another saved PC or a new one too, whatever herdr session each names
    if ([...this.jobs.values()].some((job) => (!TERMINAL.has(job.public.phase) || job.closing) && samePc(job.public.target, target))) throw new Error("This app is already connecting to this PC; wait for that to finish, or cancel it.");
    const id = randomUUID();
    const machineId = existing?.machine.id ?? randomUUID();
    if (existing?.machine.herdr_profile_id && (!existing.machine.enabled || !existing.machine.target || !sameSshSession(target, existing.machine.target))) throw new Error("This PC is managed by herdr; refresh its saved machine before setup");
    if (existing?.machine.herdr_profile_id) {
      if (target.identity_file) throw new Error("SSH connection details are managed by herdr; use the account's SSH config for keys");
      // SSH identity stays catalog-owned; the socket/new-start choice belongs to this web client.
      target = { ...existing.machine.target!, herdr_socket: target.herdr_socket, start_new_herdr: target.start_new_herdr, own_ovis: target.own_ovis };
    }
    // the install that asks it (fromInstall) was the approval of a PC not added here yet too
    const auto = options.auto === true && request.update_remote === true && (!!existing || options.fromInstall === true);
    // A saved PC set up at another SSH address stays at its own until it connects there: that address is the user's to
    // review in this dialog, and a reconnect or an update that asks nobody goes only where the PC is (#2075)
    const moving = !!existing && (!sameSshSession(target, existing.machine.target!) || target.herdr_socket !== existing.machine.target!.herdr_socket || target.own_ovis !== existing.machine.target!.own_ovis);
    // A session switch gets a separate connection. Keep the saved PC serving its old workspaces until commit.
    const switchingSession = !!existing && moving && target.destination === existing.machine.target!.destination && samePort(target.port, existing.machine.target!.port);
    if (switchingSession) { clearTimeout(existing.retry); existing.retry = undefined; }
    const resumeRetry = existing?.machine.state === "reconnecting";
    const job: JobState = { update: request.update_remote === true, auto, public: { id, machine_id: machineId, target, phase: "connecting", step: "Connecting with SSH keys and ssh-agent…", challenge: null, installations: [], error: null, ssh_output: null, progress: null }, abort: new AbortController(), timer: setTimeout(() => this.cancelJob(id, true), 600_000), stageStartedAt: Date.now(), finished: Promise.resolve() };
    if (options.expectedRevision) job.expectedRevision = options.expectedRevision;
    if (options.fromInstall) job.fromInstall = true;
    if (job.update && existing) { job.runtime = existing; existing.machine.update_error = null; }
    if (job.update && existing && !auto) existing.updateCancelled = false;
    job.timer.unref();
    this.jobs.set(id, job);
    if (this.jobs.size > 40) for (const [key, j] of this.jobs) if (["connected", "failed", "cancelled"].includes(j.public.phase) && key !== id) { this.jobs.delete(key); break; }
    const runtime = switchingSession ? this.runtime({ ...existing!.machine }) : existing ?? this.runtime({ id: machineId, name: name?.trim() || target.destination, kind: "ssh", enabled: true, state: "connecting", target, snapshot: null, error: null });
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
        await ssh.start(auto || options.keysOnly ? undefined : (prompt, host) => {
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
        if (!switchingSession) this.machines.set(machineId, runtime);
        await this.observe(runtime);
        if (job.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
        if (switchingSession && this.machines.get(machineId) !== existing) throw new Error("Setup cancelled");
        // connected there: the PC moves to the address it was set up at, with what this setup learnt there. A move is
        // all or nothing: one that cannot be completed or saved leaves the PC as it was, trying its own address (#2075)
        const move = runtime.move;
        runtime.move = undefined;
        const left = { target: runtime.machine.target, error: runtime.machine.error, herdr: runtime.machine.herdr, snapshot: runtime.machine.snapshot, ownOvisAt: runtime.ownOvisAt, finishes: runtime.finishes.copy() };
        try {
          // The default session chosen by its socket is saved as no choice: a PC pinned to that socket would stop at
          // "no longer running" after its reboot, where one saved without it starts herdr by itself
          let saved = target;
          if (job.defaultSocket) { saved = { ...target }; delete saved.herdr_socket; }
          runtime.machine.target = saved;
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
          if (switchingSession) this.machines.set(machineId, runtime);
          this.persist();
        } catch (error) {
          if (switchingSession) this.machines.set(machineId, existing!);
          if (move) {
            Object.assign(runtime.machine, { target: left.target, error: left.error, herdr: left.herdr, snapshot: left.snapshot });
            if (left.ownOvisAt) runtime.ownOvisAt = left.ownOvisAt; else delete runtime.ownOvisAt;
            runtime.finishes = left.finishes;
          }
          throw error;
        }
        if (switchingSession) this.disconnect(existing!);
        // what runs at the address it moved to is known only now: whether its own Ovis is asked what it offers
        if (move) { clearInterval(runtime.offerTimer); this.watchOwnOffer(runtime, runtime.generation); }
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
          && (error === OWN_OVIS_AWAY || error === OWN_OVIS_GONE || error === OWN_OVIS_UNANSWERED || error === OWN_CHECK_RUNNING || (reached ? !ssh.connected() : !SSH_REFUSED.test(error)));
        // a cancel asking that PC to stop its update goes over this connection: it is closed only once that is done
        if (job.cancelling) await job.cancelling;
        if (ownsRuntime) this.disconnect(runtime);
        // An interrupted setup says nothing about the bridge: restore a saved PC's retries.
        // Only explicit cancellation suppresses automatic updates; a deadline is not a refusal.
        // A setup at another SSH address that did not connect there leaves the PC as it was, trying its own address
        // again when it is enabled: what that setup met there is not this PC's, and its dialog says how it ended (#2075).
        if (job.public.phase === "cancelled" || job.timedOut) {
          if (ownsRuntime && !moving && runtime.machine.action_required === "windows_start_failed") { runtime.machine.state = "error"; this.emit(); }
          else if (ownsRuntime && !switchingSession && (job.update || moving || resumeRetry || runtime.machine.action_required === "windows_login") && existing && runtime.machine.enabled && !this.stopped) {
            runtime.machine.error = null; runtime.machine.action_required = null;
            if (job.update && !moving && !job.timedOut) runtime.updateCancelled = true;
            this.retryLater(runtime);
          }
          else if (ownsRuntime && runtime.machine.action_required === "windows_login") { runtime.machine.action_required = null; runtime.machine.error = null; this.emit(); }
        } else {
          job.public.phase = "failed"; job.public.step = "Connection failed";
          job.public.error = error;
          if (moving) { if (!switchingSession && ownsRuntime && runtime.machine.enabled && !this.stopped) { runtime.machine.error = null; runtime.machine.action_required = null; this.retryLater(runtime); } }
          else if (ownsRuntime && existing && runtime.machine.enabled && !this.stopped && e instanceof MachineActionRequired && e.action === "windows_login") { runtime.machine.error = error; runtime.machine.action_required = e.action; this.retryLater(runtime); }
          else if (ownsRuntime && existing && runtime.machine.enabled && !this.stopped && !(e instanceof MachineActionRequired) && (unreachable || resumeRetry || runtime.machine.action_required === "windows_login")) { runtime.machine.error = error; runtime.machine.action_required = null; this.retryLater(runtime); }
          // a failed bridge update on a PC that answered keeps its button: the bridge is still
          // out of date, and the error says why this attempt failed (a password needed, …)
          else if (ownsRuntime) { runtime.machine.state = "error"; runtime.machine.error = error; runtime.machine.action_required = e instanceof MachineActionRequired ? e.action : job.update && existing ? "update_bridge" : null; runtime.machine.found_herdr_sessions = e instanceof MachineActionRequired ? e.foundHerdrSessions : undefined; runtime.machine.found_ovis = e instanceof MachineActionRequired ? e.foundOvis : undefined; }
          // the dialog reads the job, not the PC: a first connect that failed on the version
          // check has no machine to carry action_required, and an interrupted update keeps
          // offering itself even when the PC was never registered
          job.public.action_required = e instanceof MachineActionRequired ? e.action : job.update ? "update_bridge" : null;
          job.public.found_herdr_sessions = e instanceof MachineActionRequired ? e.foundHerdrSessions : undefined;
          job.public.found_ovis = e instanceof MachineActionRequired ? e.foundOvis : undefined;
          // the devices list says why this PC's update failed, whichever way it was started
          if (ownsRuntime && job.runtime) job.runtime.machine.update_error = error;
          this.emit();
        }
      } finally {
        clearTimeout(job.timer); job.public.challenge = null; job.public.ssh_output = null; job.pending = undefined; job.ssh = undefined;
        // A failed switch leaves the saved PC in place, including a link lost while its retries were paused.
        if (switchingSession && this.machines.get(machineId) === existing && existing.machine.enabled && !this.stopped && existing.machine.state === "reconnecting" && existing.retry === undefined) this.retryLater(existing);
        // a PC still waiting in Update all's queue keeps showing that it waits
        if (job.runtime && !this.updateQueued.has(job.runtime.machine.id)) { job.runtime.machine.updating = null; this.emit(); }
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
    if (action.action === "cancel") { this.cancelJob(id, false, true); return; }
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
  /** `asked`: the person cancelled it here (its Cancel, or the PC's cancel of its update): only then is that PC asked to stop its own update */
  private cancelJob(id: string, timedOut = false, asked = false): void {
    // an own update asked for in this job: that PC is asked to stop it first, over this job's connection, then it closes
    // only a cancel asked for here does: this server stopping (its own restart, say) only ends the waiting
    const ownCancel = this.stopped || !asked ? undefined : this.jobs.get(id)?.ownCancel;
    const job = this.jobs.get(id);
    if (!job || ["connected", "failed", "cancelled"].includes(job.public.phase)) return;
    job.timedOut = timedOut;
    job.public.phase = timedOut ? "failed" : "cancelled"; job.public.step = timedOut ? "Connection timed out" : "Cancelled"; job.public.challenge = null; job.public.ssh_output = null;
    if (timedOut) job.public.error = "Connection timed out";
    job.public.action_required = null; job.headlessStart = false;
    job.abort.abort(); job.pending?.reject(new Error("Setup cancelled")); job.pending = undefined;
    clearTimeout(job.timer);
    // its PC stays busy until that connection has closed
    if (ownCancel) { job.closing = true; job.cancelling = ownCancel().then((words) => { job.public.error = words; this.emit(); }).finally(() => { job.ssh?.close(); job.closing = false; }); }
    else job.ssh?.close();
  }
  private async prepare(runtime: Runtime, job?: JobState): Promise<void> {
    const generation = runtime.generation;
    const ssh = runtime.ssh!;
    // a setup tries the address its dialog was given, which the PC takes only once it connects there (setup)
    const target = job?.public.target ?? runtime.machine.target!;
    const session = target.session;
    // at an address the PC is not at yet, what this try learns is kept apart (Runtime.move) and its offer goes only
    // to the job its dialog reads: the PC keeps its own until it connects there
    const moving = !!job && (!sameSshSession(target, runtime.machine.target!) || target.herdr_socket !== runtime.machine.target!.herdr_socket || target.own_ovis !== runtime.machine.target!.own_ovis);
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
    const { host, inspection } = await detectHost(ssh, session, target.herdr_socket);
    if (job) job.defaultSocket = !session && !!target.herdr_socket && inspection.expectedSocket === inspection.defaultSocket;
    // the account's herdr sessions by the confined rule (server/herdr-discovery.ts), for when no Ovis there lists them
    const localSessions = async () => {
      let sessions: FoundHerdrSession[] = [];
      try { sessions = await host.discoverSessions?.(ssh, inspection) ?? []; }
      catch (error) {
        // the SSH connection itself failed: said as that, never as a PC with no sessions
        if (!(error instanceof Error) || !ssh.connected()) throw error;
        // A bundle that cannot run discovery, or an answer that does not parse, leaves no verified choices, but still
        // requires the owner.
        sessions = [];
      }
      if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
      return sessions;
    };
    const coreUnavailable = async () => new MachineActionRequired(OWN_OVIS_GONE, "choose_herdr", false, await localSessions());
    // the chosen Ovis is gone: a reconnect (or an update that asks nobody) waits for it, starting nothing in its place; a
    // setup the user started in its dialog gets the choice at once
    const ownOvisGone = async () => !job || job.auto ? new Error(OWN_OVIS_GONE) : await coreUnavailable();
    // the chosen Ovis, proven this account's and live, did not prove what it is (no answer, an HTTP error): it still runs,
    // and stays the choice it was. A reconnect (or an update that asks nobody) waits for it, starting nothing: right after a
    // reboot it may answer before its core adapter is ready. A setup the user started gets the choice at once
    const chosenOvisFailed = async () => !job || job.auto ? new Error(OWN_OVIS_UNANSWERED)
      : new MachineActionRequired(OWN_OVIS_UNANSWERED, "choose_herdr", false, await localSessions(), [{ socket_path: target.own_ovis!, runtime: "herdr-core" }]);
    if (job && host.kind === "windows") job.public.windows_startup = moving || !this.machines.has(runtime.machine.id);
    const { platform } = inspection;
    let expectedSocket = inspection.expectedSocket;
    // a setup or a saved PC that asks for its own Ovis where SSH cannot reach one: the user must choose again, not a retry
    if (target.own_ovis && host.kind !== "posix") throw new MachineActionRequired("Choosing this PC's Ovis server over SSH requires Linux or macOS", "setup");
    // the own Ovis an unasked search could offer: a server of this account's at another socket than the expected one
    const candidates = inspection.descriptors.filter((d) => d?.managed_remote === false && typeof d.socket_path === "string" && d.socket_path !== expectedSocket);
    // what already serves the expected socket (a live bridge registered for it, or herdr answering there) is connected as
    // before: a saved PC that reconnects to it is never stopped by a choice nobody asked for. Asked only when there is a
    // choice to offer, the live registration first: the socket's probe (a command on that PC) only when none is live
    const servedAlready = async () => {
      for (const d of inspection.descriptors) if (d.socket_path === expectedSocket && Number.isSafeInteger(d.pid) && d.pid > 0 && await host.alive(ssh, d.pid)) return true;
      const status = await host.chosenSocketStatus?.(ssh, inspection, expectedSocket);
      if (status !== null && status !== undefined) return status === "usable";
      // the bundle there is too old (or missing) to apply the rule: a socket of this account's at herdr's own path is
      // taken as served, so the PC connects as before this choice existed (its bridge, once started, checks herdr itself)
      return (await ssh.run(`s=${shellQuote(expectedSocket)}; test ! -L "$s" && test -S "$s" && test "$(stat -c %u "$s" 2>/dev/null || stat -f %u "$s")" = "$(id -u)" && echo served || true`)).trim() === "served";
    };
    // The core adapter is not a TUI socket. Discover the account's own registered Ovis and prove
    // its loopback endpoint before offering it; an explicit selection is checked anew on each try.
    // Unasked, it is offered only in a setup the user started: a reconnect (or an update that asks nobody) of a PC saved
    // without an Ovis chosen connects as before, whatever runs beside it (its herdr may answer with no bridge in front yet)
    const asked = !!job && !job.auto;
    // A PC being added has no connection to keep: its setup offers the PC's own Ovis beside a herdr that already runs
    // there too, so a PC that runs both is not taken for a herdr PC without a word. A saved PC connects as before
    // An install's own connect is not asked either: its job has no card to show the choice on
    const adding = asked && !job.fromInstall && !this.machines.has(runtime.machine.id);
    if (host.kind === "posix" && !target.herdr_socket && !target.start_new_herdr && (target.own_ovis || asked && candidates.length > 0 && (adding || !await servedAlready()))) {
      const found: FoundOvis[] = [];
      const sessions = new Map<string, FoundHerdrSession>();
      // answered: one of them proved itself through the tunnel; unlisted: one did not list the account's herdr sessions
      // (an older server, or one not answering), so they are found on the PC itself before the choice is offered
      let answered = false, unlisted = false;
      if (target.own_ovis) {
        const chosen = inspection.descriptors.find((d) => d?.managed_remote === false && d.socket_path === target.own_ovis);
        if (!chosen || !Number.isSafeInteger(chosen.pid) || chosen.pid <= 0 || !await host.alive(ssh, chosen.pid)) throw await ownOvisGone();
      }
      for (const candidate of inspection.descriptors) {
        if (candidate?.managed_remote !== false || typeof candidate.socket_path !== "string") continue;
        if (target.own_ovis && candidate.socket_path !== target.own_ovis) continue;
        if (!target.own_ovis && candidate.socket_path === expectedSocket) continue;
        let owned = false;
        try {
          owned = await this.ownedRegistration(ssh, candidate);
          if (!owned) continue;
          const proved = await this.verify(ssh, candidate, candidate.socket_path, true, true);
          if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
          if (proved.identity.pid !== candidate.pid || proved.identity.managed_remote !== false || proved.identity.herdr.runtime !== "herdr-core") continue;
          found.push({ socket_path: candidate.socket_path, runtime: "herdr-core" });
          answered = true;
          const listed = proved.identity.found_herdr_sessions;
          if (listed === undefined) unlisted = true;
          else if (listed.length) for (const row of parseFoundHerdrSessions(listed)) sessions.set(row.socket_path, row);
        } catch (error) {
          if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw error;
          // A stale or inaccessible registration grants no connection and no permission to start anything. A live one of
          // this account's whose identity could not be established right now (no answer, an HTTP error) stays a choice: it
          // is neither dropped nor replaced by a new herdr. Only one proven not owned or not live is dropped (above).
          // Unasked, its runtime is told by its socket: a TUI herdr's ends in /herdr.sock, the core adapter's never does.
          // Only the core adapter's own name (isCoreAdapterSocket) is one: any other could never be connected to
          if (owned && !validHerdrSocket(candidate.socket_path) && isCoreAdapterSocket(candidate.socket_path)) { found.push({ socket_path: candidate.socket_path, runtime: "herdr-core" }); unlisted = true; }
        }
      }
      if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
      const offer = async (message: string) => {
        if (unlisted) for (const row of await localSessions()) sessions.set(row.socket_path, row);
        return new MachineActionRequired(message, "choose_herdr", false, [...sessions.values()], found);
      };
      if (target.own_ovis) {
        if (!found.length) throw await coreUnavailable();
        if (!answered) throw !job || job.auto ? new Error(OWN_OVIS_UNANSWERED) : await offer(OWN_OVIS_UNANSWERED);
        expectedSocket = target.own_ovis;
      } else if (found.length) {
        // beside a herdr that already runs there, the choice is offered only with that herdr among its sessions: without
        // it the card could not choose what the PC would connect to unasked, so it connects to it as before
        if (adding && await servedAlready()) {
          if (unlisted) { for (const row of await localSessions()) sessions.set(row.socket_path, row); unlisted = false; }
          if (sessions.has(expectedSocket)) throw await offer(answered ? "Choose this PC's Ovis server or a running herdr session." : OWN_OVIS_UNANSWERED);
        } else throw await offer(answered ? "Choose this PC's Ovis server or a running herdr session." : OWN_OVIS_UNANSWERED);
      }
    }
    // what the PC's own Ovis said is read anew on every try: it may have been updated or replaced since
    // kept while its own Ovis is away (below): an install that stopped it and then failed is tried again from its card
    const offered = { remote_ovis: runtime.machine.remote_ovis, installFix: runtime.installFix, remoteRevision: runtime.remoteRevision };
    if (!moving) { runtime.machine.remote_ovis = null; runtime.remoteRevision = undefined; runtime.installFix = undefined; }
    let { herdrPath } = inspection;
    if (herdrPath && !target.own_ovis) {
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
    // a live bridge for a chosen socket is reused only once the PC verifies that socket by the rule its bridge applies
    // (this account's, a socket and no link, inside its herdr dirs, answering). Otherwise it is never taken: the bridge
    // started below checks the socket again and says why
    if (descriptor && target.herdr_socket && host.kind !== "windows" && await host.chosenSocketStatus?.(ssh, inspection, target.herdr_socket) !== "usable") {
      stalePid = descriptor.pid;
      descriptor = undefined;
    }
    if (target.own_ovis && !descriptor) throw await ownOvisGone();
    // The PC's own Ovis is away (#2047): the PC waits for it, as for a PC that cannot be reached, and nothing of this
    // app's is installed or started in its place, by a reconnect or by an update that asks nobody. Only a setup the
    // user reviews in its dialog may start this app's bridge there.
    if (!descriptor && runtime.ownOvisAt && sameSshSession(runtime.ownOvisAt, target) && (!job || job.auto)) {
      if (!moving && offered.installFix) { runtime.machine.remote_ovis = offered.remote_ovis ?? null; runtime.installFix = offered.installFix; runtime.remoteRevision = offered.remoteRevision; }
      throw new Error(OWN_OVIS_AWAY);
    }
    // Update is idempotent: another app may have finished it while this dialog was open.
    // Prove the live endpoint is compatible; a descriptor or installed directory alone is not enough.
    let update = job?.update === true;
    let currentBridge: Awaited<ReturnType<MachineManager["verify"]>> | undefined;
    if (descriptor && update && descriptor.bridge_protocol === BRIDGE_PROTOCOL && descriptor.bundle_version === REMOTE_BUNDLE_VERSION) {
      try { currentBridge = await this.verify(ssh, descriptor, expectedSocket); }
      catch (error) {
        // the chosen Ovis answered with what it is (another version, say): that decision is told in its own words below
        if (target.own_ovis && !(error instanceof MachineActionRequired)) throw await chosenOvisFailed();
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
        const { revision: offeredRevision, fix, ...offer } = await this.ownOffer(ssh, descriptor, target, job?.abort.signal);
        if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
        if (!moving) { runtime.machine.remote_ovis = offer; runtime.remoteRevision = offeredRevision; runtime.installFix = installPlanFor(fix, host.kind, descriptor.pid, target, descriptor.token, descriptor.socket_path); }
        if (job) { job.public.remote_ovis = offer; job.offeredRevision = offeredRevision; }
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
        await host.start(ssh, { session, herdrPath, inspection, ...(headless ? { headless: true } : {}), ...(target.herdr_socket ? { herdr_socket: target.herdr_socket } : {}), ...(target.start_new_herdr ? { start_new_herdr: true } : {}) });
        notice = null;
        // Windows allows 30 seconds for the desktop launcher, then 30 for herdr
        // readiness. Leave a further ten seconds for bridge registration.
        const pollLimit = host.kind === "windows" ? 280 : 40;
        for (let i = 0; i < pollLimit; i++) {
          if (job?.abort.signal.aborted || runtime.generation !== generation || this.stopped) throw new Error("Setup cancelled");
          descriptor = (await host.descriptors(ssh)).find((d) => d.socket_path === expectedSocket && d.pid !== stalePid);
          if (descriptor) break;
          const found = await host.foundSessions?.(ssh, inspection);
          if (found?.gone) throw new MachineActionRequired("The herdr session chosen for this PC is no longer running. Start it on that PC and reconnect, or choose again.", "choose_herdr", false, found.sessions);
          if (found?.sessions.length) throw new MachineActionRequired("A herdr session is already running on this PC. Choose it, or start a new one.", "choose_herdr", false, found.sessions);
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
      if (target.own_ovis && !(error instanceof MachineActionRequired)) throw await chosenOvisFailed();
      throw error;
    }
    if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
    if (target.own_ovis) {
      try {
        if (verified.identity.pid !== descriptor.pid || verified.identity.managed_remote !== false || verified.identity.herdr.runtime !== "herdr-core" || !await this.ownedRegistration(ssh, descriptor)) throw await coreUnavailable();
      } catch (error) {
        if (error instanceof MachineActionRequired) throw error;
        throw await coreUnavailable();
      }
      // right before it is used, on every path here (a fresh try, a live server reused, a retry): the very socket it
      // reported is this account's own, in its own herdr-core folder. This app starts nothing for a chosen Ovis: that
      // server reaches its socket by this path itself, and since only the account (or root) can change a folder on it,
      // the socket checked here (its device and inode, as the server reported them just before) stays the one it uses
      if (!await this.coreSocketConfined(ssh, target.own_ovis, verified.identity.socket_id)) throw new MachineActionRequired(OWN_OVIS_SOCKET_REFUSED, "choose_herdr", false, await localSessions());
      if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
    }
    if (verified.identity.pid !== descriptor.pid) throw new Error("Bridge process verification failed; ownership was not changed");
    if (runtime.generation !== generation || this.stopped || job?.abort.signal.aborted) throw new Error("Setup cancelled");
    learnServer(verified.identity, true);
    runtime.endpoint = verified.endpoint;
    if (moving) runtime.move!.herdr = verified.identity.herdr; else runtime.machine.herdr = verified.identity.herdr;
    if (job) job.public.runtime = verified.identity.herdr.runtime ?? "herdr";
  }
  /**
   * The registry file and live process must belong to the SSH uid, not merely be readable by it. The process is the one
   * registered by its recorded birth, or (an older registration, none recorded) by having started before its file was
   * written; the authenticated request through the tunnel (verify) proves the rest. The token is never in a command
   * here: another account on that PC can read a process's arguments.
   */
  private async ownedRegistration(ssh: SshConnection, descriptor: BridgeDescriptor): Promise<boolean> {
    if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0 || typeof descriptor.socket_path !== "string" || !descriptor.socket_path.startsWith("/") || descriptor.socket_path.length > 4096
      || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.token !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.token)) return false;
    const name = createHash("sha256").update(descriptor.socket_path).digest("hex") + ".json";
    const text = await ssh.run(`f="$HOME/.config/herdr-web-ui/bridges/${name}"; uid=$(id -u); test ! -L "$f" && test -f "$f" && test "$(stat -c %u "$f" 2>/dev/null || stat -f %u "$f")" = "$uid" && test "$(ps -o uid= -p ${descriptor.pid} | tr -d ' ')" = "$uid" && kill -0 ${descriptor.pid} 2>/dev/null && ${registeredIn(descriptor.pid, descriptor.birth)} && head -c 16384 "$f" || true`);
    try {
      const current: unknown = JSON.parse(text);
      return !!current && typeof current === "object" && "pid" in current && current.pid === descriptor.pid && "token" in current && current.token === descriptor.token
        && "socket_path" in current && current.socket_path === descriptor.socket_path && "port" in current && current.port === descriptor.port && "managed_remote" in current && current.managed_remote === false;
    } catch { return false; }
  }
  /**
   * Whether a chosen Ovis's herdr-core adapter socket is the SSH account's own, read on that PC: `herdr-core.sock`
   * (server/herdr-core/pipe.ts adapterAddress) in a folder of the SSH uid's that no other account may enter (startRuntime
   * makes it 0700) and that no link leads to, the socket itself a socket of that uid's and no link; and the very socket the
   * server reported (bridge.ts socket_id, its device and inode).
   * That folder sits under a root of the account's (its home, or /run/user/<uid>: an XDG_RUNTIME_DIR anywhere else is no
   * root), and every folder from it up to `/`, those roots included, is the account's or root's and writable by no one
   * else (a sticky shared folder such as /tmp included), as sshd's StrictModes asks: no other account can rename or swap
   * any of them for a folder holding another socket between this check and the server's use of that path.
   */
  private async coreSocketConfined(ssh: SshConnection, socket: string, socketId: string): Promise<boolean> {
    if (!socket.startsWith("/") || socket.length > 4096 || /[\0\r\n]/.test(socket) || posix.normalize(socket) !== socket || !isCoreAdapterSocket(socket)) return false;
    const found = await ssh.run([
      `s=${shellQuote(socket)}; d=${shellQuote(posix.dirname(socket))}; uid=$(id -u)`,
      `owner() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1"; }`,
      `mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }`,
      `confined() {`,
      `  test ! -L "$d" && test -d "$d" && test "$(cd -P "$d" 2>/dev/null && pwd -P)" = "$d" || return 1`,
      `  test "$(owner "$d")" = "$uid" && m=$(mode "$d") && test $((0$m & 077)) -eq 0 || return 1`,
      `  root=`,
      `  for r in "$HOME" "/run/user/$uid"; do`,
      `    test -n "$r" && test -d "$r" || continue`,
      `    p=$(cd -P "$r" 2>/dev/null && pwd -P) || continue`,
      `    case "$d" in "$p"/*) root=$p; break ;; esac`,
      `  done`,
      `  test -n "$root" && test "$root" != / || return 1`,
      `  a=$d`,
      `  while :; do`,
      `    o=$(owner "$a") && m=$(mode "$a") || return 1`,
      `    { test "$o" = "$uid" || test "$o" = 0; } && test $((0$m & 022)) -eq 0 || return 1`,
      `    test "$a" = / && return 0`,
      `    a=\${a%/*}`,
      `    test -n "$a" || a=/`,
      `  done`,
      `}`,
      `confined && test ! -L "$s" && test -S "$s" && test "$(owner "$s")" = "$uid" && { stat -c %d:%i "$s" 2>/dev/null || stat -f %d:%i "$s"; } || true`,
    ].join("\n"));
    return /^\d+:\d+$/.test(found.trim()) && found.trim() === socketId;
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
  private async ownOffer(ssh: SshConnection, descriptor: BridgeDescriptor, target: SshTarget, signal?: AbortSignal): Promise<RemoteOvis & { revision?: string; fix?: InstallPlan["mode"] }> {
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
    const answer = (status: Partial<UpdateStatus> | null, reason: string | null): RemoteOvis & { revision?: string } => ({
      version: releaseVersion(status?.current_version), latest_version: releaseVersion(status?.latest_version),
      updatable: reason === null, reason, address: `${sshHost(target.destination)}:${port}`, url,
      ...(reason === null && typeof status?.latest_revision === "string" && REVISION.test(status.latest_revision) ? { revision: status.latest_revision } : {}),
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
    // and so is a first one not begun yet: an updater just started (after its restart) has not checked, and offers nothing so far
    // (one whose check failed has no check time either, and is not waited for: it may never reach its releases)
    const unchecked = (status: Partial<UpdateStatus> | null | undefined) => status?.phase === "checking" || (status?.managed === true && !status.checked_at && status.available !== true && status.phase !== "error");
    for (const until = Date.now() + this.ownUpdateCheckMs; "status" in told && unchecked(told.status) && Date.now() < until && !signal?.aborted;) {
      await this.pause(signal);
      told = await read();
      if ("status" in told && typeof told.status === "object" && told.status !== null && "port" in told.status) located = told.status;
    }
    await locate(located);
    if ("refused" in told) return answer(null, told.refused);
    const status = told.status;
    // started by hand: an install over SSH can put it under its updater; the desktop app's server updates with the app
    if (status?.managed !== true) return { ...answer(status, `That PC's Ovis does not update itself: ${remoteWords(status?.blocked_reason) ?? "it was not started by its updater."}`), ...(status && status.blocked_reason !== DESKTOP_APP_UPDATES ? { fix: "replace" as const } : {}) };
    const blocked = remoteWords(status.blocked_reason);
    if (blocked) return answer(status, `That PC's Ovis cannot update itself now: ${blocked}`);
    // its supervisor predates the bridge: a restart through its own launcher runs the one that installs by revision
    // restarted, it would install the release its updater offers: only worth it when there is one
    const offered = status.available === true && typeof status.latest_revision === "string" && REVISION.test(status.latest_revision);
    if (status.revision_bound_install !== true) // the release it offers is the one a restart's update installs: kept, so its card and that update name it
    return { ...answer(status, `That PC's Ovis is too old to take an update asked for from another PC. ${there}`), ...(offered ? { fix: "restart" as const, revision: status.latest_revision as string } : {}) };
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
    // the last status read there, which a cancel's request to stop it goes by
    let seen: Partial<UpdateStatus> | null = null;
    const read = async (): Promise<Partial<UpdateStatus>> => {
      const response = await updates();
      if (!response.ok) { await discard(response); throw new Error(`That PC's Ovis did not tell its update status (${response.status})`); }
      seen = await readCappedJson<Partial<UpdateStatus> | null>(response, REMOTE_LIMITS.ownUpdates) ?? {};
      return seen;
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
    // one already running there of another release than the one shown is not this update's to follow
    const foreign = () => started && !!job.expectedRevision && typeof before.latest_revision === "string" && before.latest_revision !== job.expectedRevision;
    if (foreign()) throw new Error(CHANGED_OFFER);
    for (let attempt = 1; !started; attempt++) {
      if (before.phase === "checking") throw new Error(OWN_CHECK_RUNNING);
      const revision = before.latest_revision;
      if (before.available !== true || typeof revision !== "string" || !REVISION.test(revision)) throw new Error("That PC's Ovis has no update on offer any more. Check its Settings → Updates there, then reconnect.");
      if (job.expectedRevision && revision !== job.expectedRevision) throw new Error(CHANGED_OFFER);
      // from its 202 (or an answer the cancel cut off) a cancel asks that PC to stop it, over this job's connection, before
      // that closes (cancelJob); never an install its own Settings started, which a refusal says
      // armed before it is asked (a cancel while its answer is on its way may follow an install already accepted);
      // disarmed by a refusal: an install the PC's own Settings started (update_busy) is never this one to stop
      // the id its 202 gives: a cancel names it, so only this install is stopped there (none when the answer was cut off)
      let installId: string | null = null;
      job.ownCancel = async () => cancelledWords(await cancelOwnUpdate(endpoint, seen, installId));
      const response = await updates(revision);
      if (response.status === 202) { installId = await installIdOf(response); break; }
      job.ownCancel = undefined;
      const refusal = (await readCappedJson<{ error?: { code?: unknown; message?: unknown } } | null>(response, REMOTE_LIMITS.bridgeError).catch(() => null))?.error;
      // busy: an install of it (its own Settings, another app) runs, and is followed; or a check that
      // started since the status was read, and the install is asked for again once it ends
      if (refusal?.code !== "update_busy" || attempt >= 3) throw new Error(`That PC's Ovis refused to update (${typeof refusal?.code === "string" ? remoteWords(refusal.code) : response.status}): ${remoteWords(refusal?.message) ?? "no reason given"}`);
      before = await settled();
      started = ownInstallRunning(before);
      if (foreign()) throw new Error(CHANGED_OFFER);
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
        // its update is done: a cancel from here on has nothing to stop there
        job.ownCancel = undefined;
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
  private async verify(ssh: SshConnection, descriptor: BridgeDescriptor, expectedSocket: string, forReplacement = false, discover = false): Promise<{ endpoint: { url: string; token: string }; identity: BridgeIdentity }> {
    const endpoint = await this.tunnel(ssh, descriptor);
    let response: Response;
    // one deadline for the answer, its body included: a bridge that stops halfway timed out too
    const deadline = AbortSignal.timeout(BRIDGE_ANSWER_MS);
    try { response = await fetch(`${endpoint.url}/api/bridge${discover ? "?discover=herdr" : ""}`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: deadline, redirect: "manual" }); }
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
  /** What runs a relay PC's terminals, from its /api/health; left unknown while it does not say. */
  private async readRelayHerdr(runtime: Runtime, endpoint: { url: string; token: string }, generation: number): Promise<void> {
    try {
      const r = await fetch(endpoint.url + "/api/health", { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) { await discard(r); return; }
      const { herdr } = await readCappedJson<{ herdr?: HerdrIdentity }>(r, REMOTE_LIMITS.health);
      if (generation !== runtime.generation || this.stopped) return;
      if (typeof herdr?.version === "string" && Number.isInteger(herdr.protocol)) runtime.machine.herdr = herdr;
    } catch { /* unknown until a later read; the roster read that follows says whether the PC answers */ }
  }
  private async refresh(runtime: Runtime): Promise<void> {
    if (!runtime.endpoint || this.stopped) return;
    if (runtime.refreshing) { runtime.refreshQueued = true; return; }
    runtime.refreshing = true;
    const endpoint = runtime.endpoint;
    const generation = runtime.generation;
    try {
      // a PC added through the relay has no bridge identity: its own health says what runs its terminals
      if ((runtime.tunnel || runtime.hc) && !runtime.machine.herdr) {
        await this.readRelayHerdr(runtime, endpoint, generation);
        // a reconnect while it was read: its queued load runs from the finally below, on the new endpoint
        if (generation !== runtime.generation || this.stopped) return;
      }
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
    runtime.machine.state = "connected"; runtime.machine.action_required = null; runtime.machine.found_herdr_sessions = undefined; runtime.machine.found_ovis = undefined; runtime.machine.remote_ovis = null; runtime.remoteRevision = undefined; runtime.installFix = undefined; runtime.attempts = 0; runtime.updateCancelled = false;
    // told only for a connected PC (shared/machines.ts)
    if (runtime.tunnel) runtime.machine.route = runtime.tunnel.route;
    this.openObserver(runtime, generation);
    this.watchOwnOffer(runtime, generation);
    if (runtime.ssh) runtime.ssh.onExit = () => this.lost(runtime, generation, new Error("SSH connection ended"));
    runtime.poll = setInterval(() => void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e)), 5000);
    runtime.poll.unref();
    // an SSH or relay PC may still serve herdr's TUI; an hc machine is herdr-core's own
    if (runtime.ssh || runtime.tunnel) this.watchMove(runtime, generation);
  }
  /**
   * Reads a connected PC's move badge (Machine.runtime_move) now, then again after a while; a read that
   * fails keeps the last badge. Never two reads of one PC at once: one asked for meanwhile follows it.
   */
  private watchMove(runtime: Runtime, generation: number): void {
    const watch = runtime.moveWatch ??= { reading: false, again: false };
    if (watch.reading) { watch.again = true; return; }
    clearTimeout(watch.timer);
    watch.reading = true;
    void readMoveOffer(runtime.endpoint!).catch(() => undefined).then((offer) => {
      watch.reading = false;
      if (generation !== runtime.generation || this.stopped) return;
      if (offer !== undefined && JSON.stringify(offer) !== JSON.stringify(runtime.machine.runtime_move)) { runtime.machine.runtime_move = offer; this.emit(); }
      const state = runtime.machine.runtime_move?.status.state;
      const delay = watch.again ? 0 : state === "waiting" || state === "moving" ? this.moveOfferMs.active : this.moveOfferMs.idle;
      watch.again = false;
      watch.timer = setTimeout(() => this.watchMove(runtime, generation), delay);
      watch.timer.unref();
    });
  }
  /** A move was started, cancelled or stopped on that PC: its badge is read again now. */
  moveOfferSoon(id: string): void {
    const runtime = this.machines.get(id);
    if (runtime?.moveWatch && runtime.machine.state === "connected" && !this.stopped) this.watchMove(runtime, runtime.generation);
  }
  /** The PC's status-only socket, through its endpoint: its end is the connection's loss. */
  private openObserver(runtime: Runtime, generation: number): void {
    // one status socket per PC: one left open would handle every frame twice and outlive disconnect()
    const previous = runtime.observer;
    if (previous) { previous.onclose = null; previous.onerror = null; previous.onmessage = null; previous.close(); }
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
      if (message.type === "snapshot" && this.admitRemote(runtime, message.snapshot)) { runtime.machine.snapshot = message.snapshot; runtime.finishes.hold(message.snapshot.finish_epoch, message.snapshot.order_epoch); this.push.seed(forAlerts(message.snapshot.panes), runtime.machine.id, runtime.machine.name, pcServerId(runtime.machine)); this.emit(); }
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
    ws.onclose = () => this.lost(runtime, generation, new Error(runtime.tunnel ? "Relay connection to this PC was lost" : runtime.hc ? "This machine's server connection was lost" : "SSH bridge connection interrupted"));
    ws.onerror = () => ws.close();
  }
  /** How a relay PC's connection reaches it, and what this manager hears back from it. */
  private tunnelOptions(runtime: Runtime, generation: number): Parameters<typeof openRelayPcTunnel>[2] {
    return {
      ...(this.relaySocket ? { socket: this.relaySocket } : {}), ...(this.relayDirectSocket ? { directSocket: this.relayDirectSocket } : {}),
      onLost: (error) => this.lost(runtime, generation, error),
      onMoved: () => this.moved(runtime, generation),
      probes: runtime.routeProbes ??= newRouteProbes(),
    };
  }
  /**
   * A relay PC's connection moved to a better route (server/relay-pc.ts): the streams of the old one end, so the
   * status socket opens again on the new one. Open terminals end with their stream as on any reconnect (their clients
   * come back by themselves, and nothing typed is sent again); requests waiting for the move go on the new route, so
   * nothing tracked here is ended. The PC stays connected throughout: nothing was lost.
   */
  private moved(runtime: Runtime, generation: number): void {
    // before the first roster read finished, observe() has yet to open the status socket and tell the route: it will
    if (generation !== runtime.generation || this.stopped || !runtime.tunnel || runtime.machine.state !== "connected") return;
    this.openObserver(runtime, generation);
    runtime.machine.route = runtime.tunnel.route;
    // what changed while the status socket was away
    void this.refresh(runtime).catch((e) => this.lost(runtime, generation, e));
    this.emit();
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
      runtime.machine.found_herdr_sessions = error.foundHerdrSessions;
      runtime.machine.found_ovis = error.foundOvis;
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
    // Keep the waiting state (including Windows sign-in), but let setup own the next connection.
    runtime.retry = setTimeout(() => { runtime.retry = undefined; if (!this.setupOwns(runtime)) void this.reconnect(runtime); }, delay); runtime.retry.unref();
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
    if (this.setupOwns(runtime)) return;
    if (!this.mayConnect(runtime)) return;
    if (this.stopped || !runtime.machine.enabled) return;
    this.disconnect(runtime);
    runtime.triedAt = this.now();
    runtime.machine.state = "reconnecting"; runtime.machine.action_required = null; this.emit();
    const generation = runtime.generation;
    if (runtime.hc) {
      const hc = runtime.hc;
      try {
        // the PC's herdr-core version and layout come from its own server's health once it answers
        delete runtime.machine.herdr;
        const bridge = await this.hcStart!(hc);
        if (generation !== runtime.generation || this.stopped || runtime.hc !== hc) { bridge.stop(); return; }
        hc.bridge = bridge; runtime.endpoint = bridge.endpoint;
        void bridge.exited.then(() => this.lost(runtime, generation, new Error("This machine's server stopped")));
        await this.observe(runtime); this.emit();
      } catch (e) { this.lost(runtime, generation, e); }
      return;
    }
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
        // the PC may run another version or runtime since the last connection: read again once connected
        delete runtime.machine.herdr;
        const tunnel = await openRelayPcTunnel(key.offer, key, this.tunnelOptions(runtime, generation));
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
    clearInterval(runtime.offerTimer); runtime.offerTimer = undefined; runtime.ownOffer = undefined; runtime.offerRevision = undefined;
    runtime.abort?.abort(); runtime.abort = undefined;
    runtime.observer?.close(); runtime.observer = undefined;
    for (const close of runtime.terminals) close(); runtime.terminals.clear();
    runtime.ssh?.close(); runtime.ssh = undefined; runtime.endpoint = undefined;
    runtime.tunnel?.close(); runtime.tunnel = undefined; delete runtime.machine.route;
    if (runtime.hc?.bridge) { runtime.hc.bridge.stop(); runtime.hc.bridge = undefined; }
    // what this connection proved goes with it; the start interval stays (sourceStarts)
    runtime.verification?.abort.abort(); runtime.verification = undefined;
    runtime.acceptedEpoch = undefined; runtime.candidate = undefined; runtime.candidateRun = undefined; delete runtime.machine.source_boot_id;
    runtime.move = undefined;
    clearTimeout(runtime.moveWatch?.timer); runtime.moveWatch = undefined; delete runtime.machine.runtime_move;
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
        const webUi = (await readCappedJson<{ web_ui?: { boot_id?: unknown; server_id?: unknown } } | null>(response, REMOTE_LIMITS.health))?.web_ui;
        const boot = webUi?.boot_id;
        if (!current() || typeof boot !== "string" || boot === "") return null;
        // its relay ID, which a device turns its alerts off by (shared/machines.ts pcAlertKey)
        if (typeof webUi?.server_id === "string" && SERVER_ID_PATTERN.test(webUi.server_id) && runtime.machine.server_id !== webUi.server_id) { runtime.machine.server_id = webUi.server_id; this.saveSoon(); }
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
    this.push.seed(forAlerts(snapshot.panes), runtime.machine.id, runtime.machine.name, pcServerId(runtime.machine));
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
    if (runtime.machine.kind === "hc") throw new Error(HC_MACHINE_MANAGED);
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
    if (patch.name !== undefined) { if (typeof patch.name !== "string" || !patch.name.trim() || patch.name.length > 100) throw new Error("Enter a PC name (1–100 characters)"); runtime.machine.name = patch.name.trim(); }
    if (patch.enabled !== undefined) {
      if (typeof patch.enabled !== "boolean") throw new Error("enabled must be boolean");
      runtime.machine.enabled = patch.enabled;
      if (!patch.enabled && runtime.machine.action_required === "windows_login") { runtime.machine.action_required = null; runtime.machine.error = null; }
      this.disconnect(runtime);
      for (const [id, job] of this.jobs) if (job.public.machine_id === runtime.machine.id) this.cancelJob(id);
      if (!patch.enabled) this.dropUpdate(runtime);
      if (patch.enabled) void this.reconnect(runtime);
    }
    this.persist(); this.emit();
  }
  remove(id: string): void {
    const runtime = this.machines.get(id);
    if (!runtime) throw new Error("PC not found");
    if (runtime.machine.herdr_profile_id) throw new Error("Remove this machine in herdr");
    if (runtime.machine.kind === "hc") throw new Error(HC_MACHINE_MANAGED);
    runtime.machine.enabled = false; this.disconnect(runtime);
    for (const [jobId, job] of this.jobs) if (job.public.machine_id === id) this.cancelJob(jobId);
    this.dropUpdate(runtime);
    // the key goes first: a registration saved without the PC must not leave its credential behind
    if (runtime.machine.kind === "relay") removeRelayPcKey(this.relayKeyPath(id));
    this.machines.delete(id); this.persist();
    for (const suffix of ["", ".pub"]) try { unlinkSync(join(this.sshDir, id + suffix)); } catch {}
    this.emit();
  }
  private relayKeyPath(id: string): string { return join(this.stateDir, "relay-pcs", `${id}.json`); }
  /**
   * Settings → Remote PCs, with the code another PC shows (its Settings → Phone & devices → Show a code to type):
   * finds that PC as a phone does (shared/relay-code-offer.ts) and holds its offer here, the one-time code in it
   * included, while the person compares the ID with the one that PC shows; addRelay with `found` then pairs with
   * it. One exchange per call; throws TypedCodeError.
   */
  async relayFoundByCode(code: unknown, signal?: AbortSignal): Promise<{ ticket: string; server_id: string; name: string | null }> {
    if (this.stopped) throw new Error("Server stopping");
    if (typeof code !== "string" || code.length > 64) throw new TypedCodeError("not-a-code");
    const offer = await offerFromCode(code, { ...(this.relaySocket ? { connect: this.relaySocket } : {}), ...(signal ? { signal } : {}) });
    if (this.stopped) throw new Error("Server stopping");
    const now = this.now();
    for (const [ticket, held] of this.foundByCode) if (now - held.at > RELAY_FOUND_MS) this.foundByCode.delete(ticket);
    // a few windows at once at most; the oldest gives way
    if (this.foundByCode.size >= 8) this.foundByCode.delete(this.foundByCode.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url");
    this.foundByCode.set(ticket, { offer, at: now });
    return { ticket, server_id: offer.server_id, name: offer.name ?? null };
  }

  /** the relay IDs of the PCs added through the relay */
  private relayServerIds(): Set<string> {
    return new Set([...this.machines.values()].flatMap(({ machine }) => machine.relay ? [machine.relay.server_id] : []));
  }

  /** Settings → Add a connection → SSH: the ssh config's hosts and this login's Tailscale PCs, to add over SSH. */
  listSshCandidates() {
    return sshCandidates(this.sshCandidateOptions);
  }

  /** Settings → Connect a device → PCs on your Tailscale: those not added yet (server/tailnet-pcs.ts). */
  listTailnet() {
    return this.tailnet.list(this.relayServerIds());
  }

  /**
   * Settings → Connect a device → PCs on your Tailscale → Add: asks that PC for its code over the tailnet and adds it
   * as a typed code would. The ID the relay found must be the one that PC named, which the person compares for a
   * code typed by hand. A code left unspent ends at its own expiry: cancelling it could end a newer one that PC shows.
   */
  async addTailnet(url: unknown): Promise<Machine> {
    const name = this.tailnet.foundAt(url);
    if (name === null) throw new TailnetPcError("not_found", "That PC is not among those found on Tailscale. Look again.");
    const asked = await this.tailnet.code(url as string, this.relayServerIds());
    const found = await this.relayFoundByCode(asked.code);
    if (found.server_id !== asked.server_id) {
      this.foundByCode.delete(found.ticket);
      throw new TailnetPcError("mismatch", "The relay found a different PC than the one asked. Nothing was added.");
    }
    return this.addRelay(undefined, name, found.ticket);
  }

  /**
   * Settings → Remote PCs → Add a PC through the relay: pairs with the PC whose pairing link (its Settings → Phone &
   * devices → Copy link) this is, as a phone would, and adds it once that PC admitted this one. The link's code is
   * spent here; later connections sign in with the key this pairing made.
   * `found` instead of `link`: the ticket relayFoundByCode gave for the PC it found, once the person matched its ID.
   */
  async addRelay(link: unknown, name?: unknown, found?: unknown): Promise<Machine> {
    if (this.stopped) throw new Error("Server stopping");
    let offer: RelayOffer | null = null;
    if (found !== undefined) {
      const held = typeof found === "string" ? this.foundByCode.get(found) : undefined;
      if (held === undefined || this.now() - held.at > RELAY_FOUND_MS) throw new Error("That PC is no longer waiting. Show a new code on it and type that.");
      this.foundByCode.delete(found as string);
      offer = held.offer;
    } else if (typeof link === "string" && link.length <= 4096) try { offer = decodeOffer(link.trim()); } catch { offer = null; }
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
    try { tunnel = await openRelayPcTunnel(offer, key, this.tunnelOptions(runtime, generation)); }
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
    try { this.persist(true); } catch (error) {
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
    this.stopped = true; clearTimeout(this.discoveryTimer); clearTimeout(this.hcTimer); clearInterval(this.localTimer); clearTimeout(this.saveTimer);
    for (const id of this.jobs.keys()) this.cancelJob(id);
    this.installer.stop();
    for (const runtime of this.machines.values()) { runtime.ownJob?.abort.abort(); this.disconnect(runtime); }
    this.listeners.clear();
  }
}

/**
 * A pane after a status frame: a frame that names background tasks, a plan or a context replaces
 * them; one that names none leaves them. Every frame says whether the pane waits on its turn's work.
 */
export function paneAfterStatus(p: HerdrPane, message: Extract<ServerMessage, { type: "pane-status" }>): HerdrPane {
  const { background_tasks: before, background_wait: _waited, plan: planBefore, context: contextBefore, finish_id: _finish, ...pane } = p;
  const tasks = message.background_tasks === undefined ? before : message.background_tasks > 0 ? message.background_tasks : undefined;
  const plan = message.plan === undefined ? planBefore : message.plan ?? undefined;
  const context = message.context === undefined ? contextBefore : message.context ?? undefined;
  return { ...pane, agent_status: message.agent_status, ...(message.finish_id === undefined ? {} : { finish_id: message.finish_id }), ...(tasks === undefined ? {} : { background_tasks: tasks }), ...(message.background_wait ? { background_wait: true } : {}), ...(plan === undefined ? {} : { plan }), ...(context === undefined ? {} : { context }) };
}

function snapshotAfterStatus(snapshot: SessionSnapshot, message: Extract<ServerMessage, { type: "pane-status" }>): SessionSnapshot {
  return { ...snapshot, finish_epoch: message.finish_epoch, panes: snapshot.panes.map((pane) => {
    if (pane.pane_id === message.pane_id) return paneAfterStatus(pane, message);
    if (snapshot.finish_epoch === message.finish_epoch) return pane;
    const { finish_id: _finish, ...rest } = pane;
    return rest;
  }) };
}

/** the relay ID a PC's alerts are turned off by (shared/machines.ts pcAlertKey), where it has one */
function pcServerId(machine: Machine): string | undefined {
  return machine.relay?.server_id ?? machine.server_id;
}

/** A remote PC's panes as its alerts take them: one waiting on its turn's background work is working. */
function forAlerts(panes: readonly HerdrPane[]): HerdrPane[] {
  return panes.map((pane) => pane.background_wait ? { ...pane, agent_status: alertStatus(pane.agent_status, true) } : pane);
}
