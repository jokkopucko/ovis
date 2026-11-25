import type { ClientMessage, ClientRole, PendingMessage, ServerFeature, ServerMessage } from "../../shared/protocol.ts";
import { receiptResumeId } from "./receiptResume.ts";
import { ACCOUNT_OPENS_ALL_CAPABILITY, type NoticeAnswer, type NoticeSeen } from "../../shared/account-devices-api.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import { promptSet } from "../../shared/secret-prompt.ts";
import { ConnectionTrace } from "./connectionTrace.ts";
import { abandonNativeReads, getTransport, type Transport, type WebSocketLike } from "./transport.ts";

type Handler = (message: ServerMessage) => void;

export type SubmitDelivery = "immediate" | "queue" | "hold";
export type SubmitResult = { ok: true; pending?: PendingMessage; unconfirmed?: true; replayed?: true; typedNow?: true; sendingAt?: string } | { ok: false; code: string; message: string; draft?: string; box?: string };

const FEATURES_WAIT_MS = 2000;
/**
 * The server types nothing once 45s have passed since the message reached it (queued behind
 * others included) and a send that started in time ends within two more 10s RPCs, so a
 * message the client gave up on is never submitted later.
 */
const SUBMIT_TIMEOUT_MS = 90_000;
/**
 * A connect attempt that has neither opened nor failed by now is given up and retried: a phone
 * that wakes on a dead network (or a tunnel that drops the handshake) can leave a socket in
 * CONNECTING for minutes, and nothing else would ever start a new attempt. Each attempt given up
 * doubles the next one's deadline up to CONNECT_TIMEOUT_MAX_MS, so a slow path that does work (a
 * remote PC, where the server waits up to 15s for the machine relay before it upgrades; a slow
 * cellular or tunnel handshake) still connects; an attempt that opens starts it over.
 */
const CONNECT_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MAX_MS = 30_000;
/** A completed handshake alone is not recovery: short-lived opens must keep the retry backoff. */
const STABLE_CONNECTION_MS = 10_000;
/**
 * Liveness (feature "ping"): a socket can read OPEN while its TCP path is gone (a phone moved from
 * Wi-Fi to cellular, a NAT entry expired while it slept) and no close event comes for minutes. The
 * client pings when the page comes back, the network changes, or nothing arrived for
 * IDLE_PROBE_MS while the page is visible (checked every IDLE_CHECK_MS). Only the pong of a ping in
 * flight answers it: a frame buffered before the sleep proves nothing. With no pong by
 * PROBE_TIMEOUT_MS it pings once more, and drops the socket when that one is not answered either;
 * each probe that ends in a drop doubles the next one's deadline up to PROBE_TIMEOUT_MAX_MS, so a
 * slow link (a relayed tailnet, a remote PC) is not dropped over and over. A deadline that fires
 * PROBE_OVERDUE_MS late was frozen with the page, not waiting: the probe starts over.
 */
const PROBE_TIMEOUT_MS = 3_000;
const PROBE_TIMEOUT_MAX_MS = 12_000;
const PROBE_OVERDUE_MS = 2_000;
const IDLE_PROBE_MS = 20_000;
const IDLE_CHECK_MS = 5_000;
/**
 * How long after a page is shown again a 4008 still counts as the hidden page's. A frozen page
 * reads the close only after it resumes, and the server's 2 s stall clock can still run out while
 * the page works through the output it held back.
 */
const SHOWN_GRACE_MS = 5_000;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;

/**
 * One clock for every key and every connection's link: a key carries the tick it was captured at (markTyped), a
 * connection the tick its link was last confirmed up at (linkUpAt). A key reaches a pane only over a link confirmed
 * before the key was captured and not lost since (HerdrSocket.takesKey).
 */
let keyClock = 0;
const linkWatchers = new Set<HerdrSocket>();

/**
 * The tick of a key captured now: typed into a terminal, or caught for a terminal that does not exist yet. A network
 * the browser reports gone is counted as lost on every connection first, as its `offline` event may come later.
 */
export function markTyped(): number {
  for (const socket of linkWatchers) socket.noteNetwork();
  return ++keyClock;
}

/** A server on this device, reached directly, for this device's own panes: its path never crosses the network. */
function deviceLocal(url: string): boolean {
  if (getTransport().kind !== "native") return false;
  try {
    const target = new URL(url);
    const host = target.hostname;
    return (host === "localhost" || host === "[::1]" || host.startsWith("127.")) && (target.searchParams.get("machine_id") ?? "local") === "local";
  } catch {
    return false;
  }
}
const DISCONNECTED: SubmitResult = { ok: false, code: "disconnected", message: "the connection dropped before the pane confirmed this message" };
const NOT_TRANSMITTED: SubmitResult = { ok: false, code: "not_transmitted", message: "the connection dropped before this message was sent" };
const CAPABILITIES_UNKNOWN: SubmitResult = { ok: false, code: "capabilities_unknown", message: "this PC has not said yet what it supports; nothing was sent" };

/**
 * Reconnect delay for the browser's WebSocket. `step` is `min(5000, 250 * 2 ** retries)`. The first four
 * steps (0.25, 0.5, 1, 2 s) stay fixed: the pane hides a drop for RECONNECT_GRACE_MS (reconnectGrace.ts),
 * sized to them so that a server restart of up to 3.75 s is never shown, and stretching them would show it.
 * From the 4 s step on the delay is `step * (0.5 + random)`: centred on the step, it keeps the number of
 * attempts while spreading them, so tabs no longer retry in lockstep while the server stays down.
 */
export function backoffDelay(retries: number): number {
  const step = Math.min(5000, 250 * 2 ** retries);
  return retries < 4 ? step : step * (0.5 + Math.random());
}

/**
 * Where the connection stands. `connected` and the input checks still read the socket itself:
 * a frozen page's socket can turn CLOSED before any event updates this.
 * - idle: connect() was never called
 * - connecting: an attempt has not opened yet
 * - open: open, and no liveness probe in flight
 * - probing: open, a ping sent and its pong not back yet; terminal input is refused (it goes to the
 *   held draft) and submits, pending actions and secrets wait for the answer before they are sent
 * - waiting: no socket, a reconnect waits out its backoff
 * - stopped: output stopped (4008); only an attach reconnects (PaneTerminal attaches again on its
 *   own once when the stop came while the page was hidden, see stoppedWhileHidden)
 * - closed: close() was called
 */
export type ConnectionState = "idle" | "connecting" | "open" | "probing" | "waiting" | "stopped" | "closed";

interface AttachState {
  cols: number;
  rows: number;
  keepSize: boolean;
  releaseSizeOwed: boolean;
}

function defaultUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Two policies live here:
 * - The connection's role survives reconnects: an observe connection re-sends its
 *   role before the attach replay, so a reconnecting phone still cannot resize or
 *   type into the operator's pty.
 * - Terminal input is NEVER queued while disconnected (a command typed into a dead
 *   socket must not fire later, unannounced); PaneTerminal keeps it as a draft the
 *   user reviews instead. Control frames (attach/resize/role) replay as before.
 */
export class HerdrSocket {
  private socket: WebSocketLike | null = null;
  private readonly url: string;
  private readonly handlers = new Set<Handler>();
  private readonly disconnectHandlers = new Set<() => void>();
  private readonly beforeReplayHandlers = new Set<() => void>();
  private featuresKnown = false;
  /** what the last feature list said of the account release, kept across reconnects (accountReleaseWithdrawn) */
  private accountOpensAllSaid: boolean | null = null;
  /** `terminal-history` from this connection's latest features frame (trusted or not) or snapshot: it says how to draw, not what to send */
  private terminalHistory = false;
  private machineEventsOffered: boolean | null = null;
  private readonly outputSeen = new Set<string>();
  private readonly inputReady = new Set<string>();
  private readonly leaseChanges = new Map<string, number>();
  private roleChanges = 0;
  private readonly attached = new Map<string, AttachState>();
  private readonly watched = new Map<string, { cols: number; rows: number }>();
  /**
   * Per pane, the server views this connection ended or replaced (an unwatch, a watch over a running
   * one) whose own end can still be on its way: each may have ended before the server read the
   * frame. `fence` is a ping sent after the last of them: its pong (or a later one) proves every such
   * end has arrived, and any end after it is the current view's own.
   */
  private readonly superseded = new Map<string, { ends: number; fence: number | null }>();
  /**
   * Per pane, typing sent on this connection that no pong has confirmed yet, in the order sent (see
   * awaitReceipt): `fence` is the id of the first ping sent after it, whose pong (or a later one) proves
   * the server read it. `id`: sent with its input to a bridge listing "input-receipt", whose input-result
   * alone confirms it (a pong only proves the bridge read it, not that the pane took it).
   */
  private readonly unconfirmed = new Map<string, { text: string; fence: number; id?: number }[]>();
  /** per pane, keys sent as a password and not confirmed yet, nothing of them kept: as `unconfirmed`, an `id` waits for its input-result, a `fence` alone for a pong */
  private readonly unconfirmedSecrets = new Map<string, { fence: number; id?: number }[]>();
  /** per pane, how many of those connections ended with, until the pane's terminal says one may not have arrived, with the herdr that pane belonged to (as lostInput) */
  private readonly lostSecrets = new Map<string, { lifetime: string | undefined | null; count: number }>();
  private nextInput = 1;
  private inputFence: number | null = null;
  /**
   * per pane, the typing connections ended with unconfirmed, until the pane's terminal takes it, with the herdr
   * that pane belonged to (`lifetime`, null when unproven): pane IDs are given out again by a replaced herdr
   */
  private readonly lostInput = new Map<string, { lifetime: string | undefined | null; typed: string[] }>();
  /** the herdr this connection proved by a trusted features frame or its snapshot (`herdr_lifetime`); null until then */
  private lifetime: string | undefined | null = null;
  private readonly conversationWanted = new Set<string>();
  private retries = 0;
  /** When this connection opened; a brief open must not restart a flapping connection's retries. */
  private openedAt: number | null = null;
  private lostAt: number | null = null;
  private reconnectTimer: number | null = null;
  private connectTimer: number | null = null;
  private connectTimeouts = 0;
  private routeWatch: { readonly transport: Transport; readonly stop: () => void } | null = null;
  private endedEarly = new WeakSet<WebSocketLike>();
  private disposed = false;
  private wakeListening = false;
  private connectionState: ConnectionState = "idle";
  private lastFrameAt = 0;
  private probeTimer: number | null = null;
  /**
   * a probe the page hid before its pong: its deadline is stopped (it must not run out while the
   * page is frozen), but it is not answered, so input stays refused and submits keep waiting; the
   * page coming back pings again
   */
  private probePaused = false;
  private readonly probeIds = new Set<number>();
  private probeDone: Promise<void> = Promise.resolve();
  private markProbeDone: () => void = () => {};
  /** the key clock's tick when this connection's link was last confirmed up; null while it is not (see markTyped) */
  private linkUpAt: number | null = null;
  /** the current network loss was noted (noteNetwork); the network coming back or the link confirmed opens the next */
  private lossNoted = false;
  /** keys queued before the network went (an attach's resume, a new tab's catch) are held even when none is typed during it */
  private readonly onOffline = (): void => { this.noteNetwork(); };
  private probeDrops = 0;
  private pathLost = false;
  private pingKnown = false;
  private idleTimer: number | null = null;
  private nextPing = 1;
  private readonly onWake = (event?: Event): void => {
    if (event?.type === "pageshow") { this.left = false; this.trace.record("pageshow"); }
    if (event?.type === "online") { this.trace.record("online"); this.lossNoted = false; }
    if (event?.type === "visibilitychange") this.trace.record(document.visibilityState === "hidden" ? "hidden" : "visible");
    // a page on its way into the back/forward cache connects again only when it is shown
    if (this.left) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      this.pageHidden = true;
      // a deadline must not run out while the page is frozen, and a probe cut short is not an
      // answer: it pauses, and the page coming back asks again
      this.pauseProbe();
      return;
    }
    if (this.pageHidden) {
      this.pageHidden = false;
      this.shownAt = Date.now();
    }
    this.wake();
  };
  /**
   * A page navigated away from can be kept whole in the browser's back/forward cache, its socket
   * still open: the server would go on delivering this connection's queued messages into a page
   * nobody sees, while the page that replaced it shows them as not confirmed. Leaving ends the
   * connection for real, so the disconnect handlers run and the server drops its pending input.
   * No retry is armed and nothing connects until the page comes back (pageshow), not an `online`
   * event nor a pane's attach in the moment before the page freezes. The page counts as put away,
   * so an output stop (4008) that arrives late is attached again once it is back in use.
   */
  private readonly onLeave = (): void => {
    if (this.disposed) return;
    this.trace.record("pagehide", { pending: this.submits.size }, true);
    this.left = true;
    this.pageHidden = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    if (!socket) return;
    this.endConnection();
    // its close event must not schedule a reconnect behind the page; a late 4008 still stops output
    this.endedEarly.add(socket);
    socket.close();
    this.connectionState = "waiting";
  };
  private mode: ClientRole = "interact";
  private presence: boolean | null = null;
  private stopped = false;
  private stoppedHidden = false;
  private pageHidden = false;
  private left = false;
  private shownAt = 0;
  private features = new Set<ServerFeature>();
  private featuresSeen: Promise<void> = Promise.resolve();
  private markFeatures: () => void = () => {};
  /** whether a `features` frame may say what this connection's bridge takes before its snapshot; see trustFeatures */
  private featuresTrusted: (frame: Extract<ServerMessage, { type: "features" }>) => boolean = () => false;
  private nextSubmit = 1;
  private readonly submits = new Map<number, (result: SubmitResult) => void>();
  /** Receipts match the operation and captured target on this connection, never an ID alone. */
  private readonly requests = new Map<number, { type: "submit" | "pending-action" | "secret" | "insert"; paneId: string; queued?: boolean; pendingId?: string }>();

  private readonly trace: ConnectionTrace;
  private connectionEpoch = 0;
  private probeRefusalRecorded = false;

  constructor(url: string = defaultUrl()) {
    this.url = url;
    linkWatchers.add(this);
    this.trace = new ConnectionTrace(url, () => ({
      connection: this.connectionEpoch, socket_state: this.socket?.readyState ?? null,
      visibility: typeof document === "undefined" ? "unknown" : document.visibilityState === "hidden" ? "hidden" : "visible",
      online: typeof navigator === "undefined" || typeof navigator.onLine !== "boolean" ? null : navigator.onLine,
    }));
  }

  get lostSince(): number | null {
    return this.lostAt;
  }

  get connected(): boolean {
    return this.socket?.readyState === SOCKET_OPEN;
  }

  /**
   * What a wait on the pane's input saw: this connection, its role and the pane's readiness, each
   * counted at every change. Something that waited (a clipboard read) compares it before it writes:
   * a readiness or a role that went and came back meanwhile, or a reconnect, is another lease.
   */
  inputLease(paneId: string): string {
    return `${this.connectionEpoch}:${this.roleChanges}:${this.leaseChanges.get(paneId) ?? 0}`;
  }

  private changeLease(paneId: string): void {
    this.leaseChanges.set(paneId, (this.leaseChanges.get(paneId) ?? 0) + 1);
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get outputStopped(): boolean {
    return this.stopped;
  }

  /**
   * The output stopped while the page was hidden or within SHOWN_GRACE_MS of being shown again: a
   * frozen page sent no ACKs, so the device was put away rather than too slow. The page attaches
   * again once when it is back in use; a stop while it stays in use is final (no reconnect loop).
   */
  get stoppedWhileHidden(): boolean {
    return this.stopped && this.stoppedHidden;
  }

  connect(): void {
    if (this.disposed || this.left) return;
    this.listenForWake();
    if (this.socket && (this.socket.readyState === SOCKET_OPEN || this.socket.readyState === SOCKET_CONNECTING)) {
      return;
    }
    // A socket still CLOSING (or CLOSED before its close event ran) is replaced: end it first, so its
    // probe, its waiting submits and the disconnect handlers settle now rather than never (its
    // close event would find it replaced). A late 4008 from it still stops output.
    const previous = this.socket;
    if (previous) {
      this.endConnection();
      this.endedEarly.add(previous);
    }
    // a backoff retry still waiting would only open a second attempt later, past whatever ends this one
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const transport = getTransport();
    this.watchRoute(transport);
    const target = new URL(this.url);
    target.searchParams.set("receipt_resume_id", receiptResumeId());
    const socket = transport.openSocket(target.href);
    const epoch = ++this.connectionEpoch;
    const started = Date.now();
    this.socket = socket;
    this.connectionState = "connecting";
    this.trace.record("connect", { attempt: this.retries });
    this.features = new Set();
    this.inputReady.clear();
    this.outputSeen.clear();
    this.featuresKnown = false;
    this.lifetime = null;
    this.terminalHistory = false;
    this.machineEventsOffered = null;
    this.featuresSeen = new Promise((resolve) => { this.markFeatures = resolve; });
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (this.socket !== socket || socket.readyState !== SOCKET_CONNECTING) return;
      this.trace.record("connect_timeout", { elapsed_ms: Date.now() - started, attempt: this.connectTimeouts }, true);
      this.connectTimeouts += 1;
      socket.close();
      // the close event of an attempt that never opened may come late or not at all: end it here
      this.closed(socket, 1006);
    }, Math.min(CONNECT_TIMEOUT_MAX_MS, CONNECT_TIMEOUT_MS * 2 ** this.connectTimeouts));

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.clearConnectTimer();
      this.connectTimeouts = 0;
      this.connectionState = "open";
      this.trace.record("open", { elapsed_ms: Date.now() - started });
      this.openedAt = Date.now();
      this.lostAt = null;
      this.lastFrameAt = this.openedAt;
      this.watchIdle(socket);
      this.confirmLink();
      // the path is back: reads sent on the lost one would hold the browser's connections to the server
      if (this.pathLost) {
        this.pathLost = false;
        abandonNativeReads(new URL(this.url, "http://localhost").searchParams.get("machine_id") ?? "local");
      }
      // always send the role, never only when non-default: a user can flip the role
      // while disconnected (setMode stores it without sending), so without this frame
      // the reconnect would leave the server on the stale role and no ack would ever
      // arrive - the UI would stay stuck in the old role while the header pill lies
      this.rawSend({ type: "role", mode: this.mode });
      this.superseded.clear();
      if (this.presence !== null) this.rawSend({ type: "presence", active: this.presence });
      for (const handler of this.beforeReplayHandlers) handler();
      for (const [paneId, state] of this.attached) {
        state.releaseSizeOwed = !state.keepSize;
        this.rawSend({ type: "attach", pane_id: paneId, cols: state.cols, rows: state.rows, flow_control: "ack", receipt_resume_id: receiptResumeId(), ...(state.keepSize ? { keep_size: true } : {}) });
      }
    });

    let earlyNoticeOffer = false;
    const pendingNotices: Extract<ServerMessage, { type: "device-notice-replay" | "device-notice" }>[] = [];
    socket.addEventListener("message", (event) => {
      if (this.socket !== socket) return;
      this.trace.flush();
      // any frame postpones the idle probe; only the pong of a ping in flight ends a probe (a frame
      // the browser had buffered before a sleep does not prove the path is still there)
      this.lastFrameAt = Date.now();
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (message.type === "pong") {
        for (const [paneId, stale] of this.superseded) if (stale.fence !== null && message.id >= stale.fence) this.superseded.delete(paneId);
        this.confirmInput(message.id);
      }
      if (message.type === "pong" && this.probeIds.has(message.id)) {
        this.trace.record("pong");
        this.probeDrops = 0;
        this.endProbe();
      }
      // The server can force this connection to observe. Apply its authority before
      // waking pending submits or notifying UI handlers about the acknowledged role.
      if (message.type === "role-ack") { this.mode = message.mode; this.roleChanges += 1; }
      const readyPane = "pane_id" in message && typeof message.pane_id === "string" ? message.pane_id : null;
      const wasReady = readyPane !== null && this.inputReady.has(readyPane);
      let unwatched: string[] = [];
      // A server lists its features in a first frame of their own, before the snapshot, which can wait
      // seconds on herdr; an older bridge lists them in its snapshot only. Each list is the bridge's
      // latest word, but what it restores is asked for once per connection, by the first of them. A features
      // frame counts only when trusted (trustFeatures); otherwise its snapshot says, as an older bridge's does.
      // an untrusted features frame still says how its attach replays draw: history it lists ahead of the
      // snapshot would be cut by a scrollback lowered until the snapshot came
      if (message.type === "features" || message.type === "snapshot") {
        this.terminalHistory = (message.features ?? []).includes("terminal-history");
        this.machineEventsOffered = message.features?.includes("machine-events") ?? false;
      }
      if ((message.type === "features" && this.featuresTrusted(message)) || message.type === "snapshot") {
        const first = !this.featuresKnown;
        this.features = new Set(message.features ?? []);
        this.featuresKnown = true;
        this.accountOpensAllSaid = this.features.has(ACCOUNT_OPENS_ALL_CAPABILITY);
        // typing lost on another herdr, or on one never proven, is not this herdr's pane's, whatever its ID
        this.lifetime = message.type === "snapshot" ? message.snapshot.herdr_lifetime : message.herdr_lifetime;
        for (const [paneId, lost] of this.lostInput) if (lost.lifetime !== this.lifetime) this.lostInput.delete(paneId);
        for (const [paneId, lost] of this.lostSecrets) if (lost.lifetime !== this.lifetime) this.lostSecrets.delete(paneId);
        this.pingKnown = this.features.has("ping");
        // a probe sent before these features (running or paused), on ping support remembered from an
        // earlier connection: this bridge does not answer pings (an older one after a reconnect), so
        // its connection is trusted as before rather than dropped at the deadline or left paused
        if (!this.pingKnown && this.probing) this.endProbe();
        if (!this.features.has("input-receipt")) for (const typed of [...this.unconfirmed.values(), ...this.unconfirmedSecrets.values()]) for (const entry of typed) if (entry.id !== undefined) { delete entry.id; entry.fence = this.nextPing; }
        if (this.features.has("ping")) this.fenceInput();
        else { this.unconfirmed.clear(); this.unconfirmedSecrets.clear(); this.inputFence = null; }
        if (!this.features.has("input-ready")) for (const pane of this.outputSeen) if (this.attached.has(pane)) this.inputReady.add(pane);
        // Capabilities arrive after open's role/attach replay. Restore only current interest,
        // never send an unknown frame to an older bridge or replay a hidden/detached chat.
        if (first && this.features.has("conversation-watch")) {
          for (const paneId of this.attached.keys()) {
            if (this.conversationWanted.has(paneId)) this.rawSend({ type: "conversation-watch", pane_id: paneId, enabled: true });
          }
        }
        if (this.features.has("watch")) {
          if (first) for (const [paneId, grid] of this.watched) this.rawSend({ type: "watch", pane_id: paneId, cols: grid.cols, rows: grid.rows });
        } else {
          unwatched = [...this.watched.keys()];
          this.watched.clear();
        }
        this.markFeatures();
      }
      if (message.type === "error" && message.code === "attach_held") this.trace.record("input_held", {}, true);
      if (message.type === "watch-end") {
        // Before the fence's pong, the end may be a superseded view's, sent before the server read the
        // frame that ended it: it names no view. Start the current view again rather than drop it, so
        // the next unwatch still reaches the server; once every superseded view could have ended, an
        // end is this view's own. Each superseded view skips one end, and the re-send adds none: a
        // view the server cannot start ends again at once, and that end reaches the page.
        const grid = this.watched.get(message.pane_id);
        const stale = this.superseded.get(message.pane_id);
        if (stale) {
          stale.ends -= 1;
          if (stale.ends <= 0) this.superseded.delete(message.pane_id);
        }
        if (stale && grid) {
          this.rawSend({ type: "watch", pane_id: message.pane_id, cols: grid.cols, rows: grid.rows });
          return;
        }
        this.watched.delete(message.pane_id);
      }
      if (message.type === "pty-data") this.outputSeen.add(message.pane_id);
      if ((message.type === "input-ready" && message.ready !== false) || (message.type === "pty-data" && this.featuresKnown && !this.features.has("input-ready"))) {
        if (this.attached.has(message.pane_id)) this.inputReady.add(message.pane_id);
      }
      if ((message.type === "input-ready" && message.ready === false) || message.type === "pty-exit" || (message.type === "error" && message.pane_id && ["attach_held", "input_not_ready"].includes(message.code))) this.inputReady.delete(message.pane_id!);
      if (readyPane !== null && (message.type === "input-ready" || wasReady !== this.inputReady.has(readyPane))) this.changeLease(readyPane);
      if (message.type === "submit-result" && this.matchesRequest(message.id, "submit", message.pane_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true, ...(message.pending ? { pending: message.pending } : {}), ...(message.replayed === true ? { replayed: true as const } : {}), ...(message.typed_now === true ? { typedNow: true as const } : {}), ...(typeof message.sending_at === "string" ? { sendingAt: message.sending_at } : {}) }
          : { ok: false, code: message.code ?? "submit_failed", message: message.message ?? "the pane did not take the message", ...(message.draft ? { draft: message.draft } : {}),
            ...(!message.draft && typeof message.box === "string" ? { box: message.box } : {}) });
      }
      if (message.type === "pending-messages") {
        // The owner-only live queue is also an acceptance receipt if its submit ACK
        // was lost. A reconnect's empty list never implies that an old item was sent.
        for (const pending of message.messages) {
          const request = this.requests.get(pending.request_id);
          if (request?.type !== "submit" || !request.queued || request.paneId !== message.pane_id) continue;
          this.resolveRequest(pending.request_id, { ok: true, pending });
        }
      }
      if (message.type === "pending-result" && this.matchesRequest(message.id, "pending-action", message.pane_id, message.pending_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true } : { ok: false, code: message.code ?? "pending_failed", message: message.message ?? "the pending message was not changed" });
      }
      if (message.type === "secret-result" && this.matchesRequest(message.id, "secret", message.pane_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true } : { ok: false, code: message.code ?? "secret_failed", message: "Secret was not sent. Check the prompt and enter it again." });
      }
      if (message.type === "input-result") {
        const typed = this.unconfirmed.get(message.pane_id);
        const left = typed?.filter((entry) => entry.id !== message.id);
        if (left && left.length > 0) this.unconfirmed.set(message.pane_id, left);
        else this.unconfirmed.delete(message.pane_id);
        const secrets = this.unconfirmedSecrets.get(message.pane_id)?.filter((entry) => entry.id !== message.id);
        if (secrets && secrets.length > 0) this.unconfirmedSecrets.set(message.pane_id, secrets);
        else this.unconfirmedSecrets.delete(message.pane_id);
      }
      if (message.type === "insert-result" && this.matchesRequest(message.id, "insert", message.pane_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true } : { ok: false, code: message.code ?? "insert_failed", message: message.message ?? "the pane did not take the text" });
      }
      // A terminal/parser failure is not malformed JSON and must not disappear.
      if (message.type === "features" && !this.featuresKnown) {
        earlyNoticeOffer = message.features?.includes(ACCOUNT_OPENS_ALL_CAPABILITY) === true;
        if (!earlyNoticeOffer) pendingNotices.length = 0;
      }
      if ((message.type === "device-notice" || message.type === "device-notice-replay") && !this.accountOpensAll()) {
        // A first-connect offer can precede its trusted snapshot; retain frames only after that offer.
        if (earlyNoticeOffer && !this.featuresKnown) pendingNotices.push(message);
        return;
      }
      this.emit(message);
      if (this.featuresKnown && pendingNotices.length > 0) {
        const confirmed = pendingNotices.splice(0);
        if (this.accountOpensAll()) for (const notice of confirmed) this.emit(notice);
      }
      for (const paneId of unwatched) this.emit({ type: "watch-end", pane_id: paneId });
    });

    socket.addEventListener("close", (event) => {
      this.trace.record("close", { code: event.code, pending: this.submits.size, connection: epoch, socket_state: socket.readyState }, event.code !== 1000 && event.code !== 1001);
      if (this.endedEarly.has(socket)) {
        this.endedEarly.delete(socket);
        if (event.code === OUTPUT_STALLED_CLOSE_CODE && !this.disposed) {
          if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
          const replacement = this.socket;
          if (replacement) {
            this.endConnection();
            replacement.close();
          }
          this.stopOutput();
        }
        return;
      }
      this.closed(socket, event.code);
    });

    socket.addEventListener("error", () => {
      this.trace.record("socket_error", { connection: epoch, socket_state: socket.readyState }, true);
      socket.close();
    });
  }

  private closed(socket: WebSocketLike, code: number): void {
    if (this.socket !== socket) return;
    this.endConnection();
    if (code === OUTPUT_STALLED_CLOSE_CODE) {
      this.stopOutput();
      return;
    }
    this.scheduleReconnect();
  }

  private endConnection(): void {
    this.machineEventsOffered = null;
    if (this.submits.size > 0) this.trace.record("submit_disconnect", { pending: this.submits.size }, true);
    if (this.openedAt !== null && Date.now() - this.openedAt >= STABLE_CONNECTION_MS) this.retries = 0;
    if (this.openedAt !== null) this.lostAt = Date.now();
    this.openedAt = null;
    this.socket = null;
    this.clearConnectTimer();
    this.clearLiveness();
    this.linkUpAt = null;
    // typing no pong confirmed may never have reached the server: the panes' terminals hold it for review
    for (const [paneId, typed] of this.unconfirmed) {
      const earlier = this.lostInput.get(paneId);
      const kept = earlier !== undefined && earlier.lifetime === this.lifetime ? earlier.typed : [];
      this.lostInput.set(paneId, { lifetime: this.lifetime, typed: [...kept, ...typed.map((entry) => entry.text)] });
    }
    this.unconfirmed.clear();
    for (const [paneId, fences] of this.unconfirmedSecrets) {
      const earlier = this.lostSecrets.get(paneId);
      const kept = earlier !== undefined && earlier.lifetime === this.lifetime ? earlier.count : 0;
      this.lostSecrets.set(paneId, { lifetime: this.lifetime, count: kept + fences.length });
    }
    this.unconfirmedSecrets.clear();
    this.inputFence = null;
    for (const handler of this.disconnectHandlers) handler();
    this.markFeatures();
    this.settleSubmits(DISCONNECTED);
  }

  private stopOutput(): void {
    this.stopped = true;
    this.stoppedHidden = (typeof document !== "undefined" && document.visibilityState === "hidden")
      || this.pageHidden || (this.shownAt > 0 && Date.now() - this.shownAt <= SHOWN_GRACE_MS);
    this.connectionState = "stopped";
    // stopped output stays stopped until an attach: no retry left armed may reconnect behind it
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.emit({ type: "error", code: "output_stalled", message: "Terminal output stopped because this device could not keep up." });
  }

  /**
   * Pings an open connection whose bridge listed "ping" in its last snapshot (an older one is
   * never asked, and its connection is trusted as before). Until the pong comes back, terminal
   * input is refused, so typing goes to the held draft rather than into a socket that may be
   * dead, and submits wait (see probeSettled()); with no pong after two pings (see
   * PROBE_TIMEOUT_MS) the socket is dropped and a new one connects at once.
   */
  private probe(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN || !this.pingKnown || this.probeTimer !== null) return;
    this.connectionState = "probing";
    this.probeRefusalRecorded = false;
    if (this.probePaused) this.probePaused = false;
    else this.probeDone = new Promise((resolve) => { this.markProbeDone = resolve; });
    this.ping(socket, 1);
  }

  private pauseProbe(): void {
    if (this.probeTimer === null) return;
    window.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.probeIds.clear();
    this.probePaused = true;
  }

  private get probing(): boolean {
    return this.probeTimer !== null || this.probePaused;
  }

  private ping(socket: WebSocketLike, attempt: 1 | 2): void {
    const deadline = Math.min(PROBE_TIMEOUT_MAX_MS, PROBE_TIMEOUT_MS * 2 ** this.probeDrops);
    const armedAt = Date.now();
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null;
      if (this.socket !== socket) return;
      if (socket.readyState === SOCKET_CLOSING) {
        this.endProbe();
        return;
      }
      // the page was frozen past the deadline: no pong could have been read meanwhile, so ask again,
      // and a pong to a ping sent before the freeze no longer counts
      if (Date.now() - armedAt > deadline + PROBE_OVERDUE_MS) {
        this.trace.record("probe_overdue", { elapsed_ms: Date.now() - armedAt, attempt }, true);
        this.probeIds.clear();
        this.ping(socket, 1);
      }
      else if (attempt === 1) this.ping(socket, 2);
      else this.drop(socket);
    }, deadline);
    this.trace.record(attempt === 1 ? "probe" : "probe_retry", { attempt }, attempt === 2);
    const id = this.nextPing++;
    this.probeIds.add(id);
    try { this.rawSend({ type: "ping", id }); } catch { /* see above */ }
  }

  private endProbe(): void {
    if (this.probeTimer !== null) window.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.probePaused = false;
    this.probeIds.clear();
    this.markProbeDone();
    if (this.connectionState === "probing") this.connectionState = "open";
    this.confirmLink();
  }

  /**
   * The browser says its network is gone while the socket may still read OPEN: what it takes now would wait in the
   * browser or the network and reach the pane after the network is back, typed by nobody. Unless the server is on
   * this device, the link counts as lost at once, and the connection is probed so a dead socket is dropped. A probe
   * already in flight pinged while the network was there, so it asks again: an earlier ping's pong proves nothing.
   * Each loss counts once (lossNoted), so a second loss before the first probe's pong invalidates that probe too.
   */
  noteNetwork(): void {
    if (this.lossNoted || typeof navigator === "undefined" || navigator.onLine !== false || deviceLocal(this.url)) return;
    this.lossNoted = true;
    this.linkUpAt = null;
    const socket = this.socket;
    if (this.probeTimer !== null && socket !== null) {
      window.clearTimeout(this.probeTimer);
      this.probeIds.clear();
      this.ping(socket, 1);
    } else this.probe();
  }

  /**
   * The link is up again once its connection opened or answered a probe (or, on a bridge without "ping", the network
   * came back), and the browser reports a network or the server is on this device.
   */
  private confirmLink(): void {
    if (this.linkUpAt !== null || !this.connected || this.probing) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false && !deviceLocal(this.url)) return;
    this.linkUpAt = ++keyClock;
    this.lossNoted = false;
  }

  private async probeSettled(socket: WebSocketLike): Promise<boolean> {
    while (this.probing && this.socket === socket) await this.probeDone;
    return this.connected && this.socket === socket;
  }

  /**
   * Ends a connection that did not answer its probe without waiting for a close event, which a
   * half-open socket may not deliver for minutes: its submits settle, the disconnect handlers run,
   * and a new socket connects now and replays the role and attaches.
   */
  private drop(socket: WebSocketLike): void {
    this.trace.record("probe_drop", { pending: this.submits.size }, true);
    this.probeDrops += 1;
    this.pathLost = true;
    this.endConnection();
    this.endedEarly.add(socket);
    socket.close();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retries = 0;
    this.connect();
  }

  private watchIdle(socket: WebSocketLike): void {
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.idleTimer = window.setInterval(() => {
      if (this.socket !== socket) return;
      if (socket.readyState === SOCKET_CLOSING) this.trace.record("closing_wait", { elapsed_ms: Date.now() - this.lastFrameAt, pending: this.submits.size }, true);
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (Date.now() - this.lastFrameAt >= IDLE_PROBE_MS) this.probe();
    }, IDLE_CHECK_MS);
  }

  private clearLiveness(): void {
    this.endProbe();
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  private clearConnectTimer(): void {
    if (this.connectTimer === null) return;
    window.clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private listenForWake(): void {
    if (this.wakeListening || typeof window.addEventListener !== "function") return;
    this.wakeListening = true;
    window.addEventListener("online", this.onWake);
    window.addEventListener("offline", this.onOffline);
    window.addEventListener("pageshow", this.onWake);
    window.addEventListener("pagehide", this.onLeave);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onWake);
      if (document.visibilityState === "hidden") this.pageHidden = true;
    }
  }

  /**
   * A phone that slept or went to the background comes back with its socket closed and a
   * reconnect timer that may have backed off to its 5s cap, or with a socket already CLOSED whose
   * close event has not run yet (so no timer at all). Waking skips the wait and starts again from
   * the shortest delay. An open connection may be half-open, so it is probed (see probe()); a
   * first attempt still connecting is left to its deadline. An attempt still connecting after
   * earlier ones hit their deadline has a deadline grown up to 30s, likely started on the network
   * that just came back or changed: it is given up now and a fresh attempt starts with the
   * shortest deadline. A socket in CLOSING is left to its close event: a
   * submit-result can still arrive during that handshake, and the server's close code decides whether output stopped (the
   * reconnect it schedules starts from the shortest delay). A stopped output stays stopped: only
   * an attach resumes it.
   */
  wake(): void {
    if (this.disposed || this.stopped) return;
    const socket = this.socket;
    // an open socket may be half-open after a sleep or a network change: ask it (a bridge without "ping" is trusted)
    if (socket?.readyState === SOCKET_OPEN) {
      this.probe();
      // a bridge without "ping" is trusted here, and its link confirmed (when the browser reports a network);
      // one with it is confirmed by the pong of the probe just sent
      this.confirmLink();
      return;
    }
    if (socket?.readyState === SOCKET_CLOSING) {
      this.retries = 0;
      return;
    }
    if (socket?.readyState === SOCKET_CONNECTING && this.connectTimeouts > 0) {
      socket.close();
      this.closed(socket, 1006);
    } else if (socket?.readyState === SOCKET_CLOSED) {
      this.closed(socket, 1006);
      this.endedEarly.add(socket);
    }
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retries = 0;
    this.connectTimeouts = 0;
    this.connect();
  }

  /** A relay carrier back up reopens this stream at once, rather than when its backoff runs out. */
  private watchRoute(transport: Transport): void {
    if (this.routeWatch?.transport === transport) return;
    this.routeWatch?.stop();
    this.routeWatch = transport.onRouteChange ? {
      transport,
      stop: transport.onRouteChange(() => {
        if (transport.route !== undefined && !this.left && this.socket?.readyState !== SOCKET_OPEN) this.wake();
      }),
    } : null;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = backoffDelay(this.retries);
    this.retries += 1;
    this.connectionState = "waiting";
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.outputStopped || this.disposed) return;
      this.connect();
    }, delay);
  }

  private rawSend(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private send(message: ClientMessage): void {
    if (this.connected) this.rawSend(message);
    // Role/attach/geometry already live in state. Replaying both that state and
    // a queue used to attach twice and duplicate the initial terminal replay.
  }

  private emit(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  /** Transport capability only; it grants no input authority or herdr lifetime trust. */
  get machineEventsAvailable(): boolean | null { return this.machineEventsOffered; }

  setMachineEvents(enabled: boolean): void {
    if (this.machineEventsOffered) this.send({ type: "machine-events", enabled, compact_agents: true });
  }

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.add(handler);
    return () => { this.disconnectHandlers.delete(handler); };
  }

  onBeforeReplay(handler: () => void): () => void {
    this.beforeReplayHandlers.add(handler);
    return () => { this.beforeReplayHandlers.delete(handler); };
  }

  /**
   * Which `features` frames say what the bridge takes before the snapshot does. None by default: a send
   * then waits for the snapshot, as on an older bridge. MachineSession trusts one that names the herdr the
   * page already proved, so a send never leaves for a pane ID a replaced herdr gave out again.
   */
  trustFeatures(check: (frame: Extract<ServerMessage, { type: "features" }>) => boolean): void {
    this.featuresTrusted = check;
  }

  attach(paneId: string, cols: number, rows: number, keepSize = false): void {
    this.outputSeen.delete(paneId);
    this.inputReady.delete(paneId);
    this.changeLease(paneId);
    this.attached.set(paneId, { cols, rows, keepSize, releaseSizeOwed: !keepSize });
    this.send({ type: "attach", pane_id: paneId, cols, rows, flow_control: "ack", receipt_resume_id: receiptResumeId(), ...(keepSize ? { keep_size: true } : {}) });
    if (this.conversationWanted.has(paneId) && this.features.has("conversation-watch")) {
      this.send({ type: "conversation-watch", pane_id: paneId, enabled: true });
    }
    if (this.stopped) {
      this.stopped = false;
      this.stoppedHidden = false;
      this.shownAt = 0;
      this.connect();
    }
  }

  watchConversation(paneId: string, enabled: boolean): void {
    if (this.conversationWanted.has(paneId) === enabled) return;
    if (enabled) this.conversationWanted.add(paneId);
    else this.conversationWanted.delete(paneId);
    if (this.attached.has(paneId) && this.features.has("conversation-watch")) {
      this.send({ type: "conversation-watch", pane_id: paneId, enabled });
    }
  }

  conversationPushes(): boolean {
    return this.connected && this.features.has("conversation-watch");
  }

  /** Capture connection AND subscription before xterm's asynchronous write. Never queue ACKs. */
  outputAcknowledgement(message: Extract<ServerMessage, { type: "pty-data" }>): (() => void) | undefined {
    const flow = message.flow;
    if (!flow) return undefined;
    const connection = this.socket;
    const subscription = this.attached.get(message.pane_id);
    return () => {
      if (!connection || this.socket !== connection || !this.connected || !subscription
        || this.attached.get(message.pane_id) !== subscription) return;
      this.rawSend({ type: "pty-ack", pane_id: message.pane_id, stream_id: flow.stream_id, offset: flow.offset });
    };
  }

  isAttached(paneId: string): boolean {
    return this.attached.has(paneId);
  }

  detach(paneId: string): void {
    this.outputSeen.delete(paneId);
    this.inputReady.delete(paneId);
    this.changeLease(paneId);
    this.attached.delete(paneId);
    this.send({ type: "detach", pane_id: paneId });
  }

  /**
   * Views the pane read-only at this grid, leaving its size to herdr's own window; replayed after
   * a reconnect's snapshot. False when the server cannot (no "watch" in its snapshot): the tab stays paused.
   */
  watch(paneId: string, cols: number, rows: number): boolean {
    if (!this.canWatch()) return false;
    const running = this.watched.has(paneId);
    this.watched.set(paneId, { cols, rows });
    if (this.connected && this.featuresKnown) {
      this.rawSend({ type: "watch", pane_id: paneId, cols, rows });
      if (running) this.supersede(paneId);
    }
    return true;
  }

  /** Before the features are known, a watch waits for capability discovery rather than acquiring an attach. */
  canWatch(): boolean {
    return !this.featuresKnown || this.features.has("watch");
  }

  featuresListed(): boolean {
    return this.featuresKnown;
  }

  /** Device table G5: this PC opens to the account's sign-in (ACCOUNT_OPENS_ALL_CAPABILITY), as its trusted features say; never offline. */
  accountOpensAll(): boolean {
    return this.connected && this.features.has(ACCOUNT_OPENS_ALL_CAPABILITY);
  }

  /**
   * This PC's last feature list lacked the account release (S32-1): an explicit withdrawal, which holds through a
   * disconnect and a reconnect that has listed nothing yet, until a list offers it again. False before any list.
   */
  accountReleaseWithdrawn(): boolean {
    return this.accountOpensAllSaid === false;
  }

  /** Device table T57: says what was seen, or answers one notice; only to a PC that offers it. True when sent. */
  sendNotice(message: NoticeSeen | NoticeAnswer): boolean {
    if (!this.accountOpensAll()) return false;
    this.rawSend(message);
    return true;
  }

  hasTerminalHistory(): boolean {
    return this.terminalHistory;
  }

  /**
   * Whether a plain arrow is typed as xterm encodes it (`terminal-modes`: the attach carries the program's modes),
   * rather than named for the runtime to encode; false until the features come, and on herdr.
   */
  typesArrows(): boolean {
    return this.features.has("terminal-modes");
  }

  unwatch(paneId: string): void {
    if (this.watched.delete(paneId) && this.connected && this.features.has("watch")) {
      this.rawSend({ type: "unwatch", pane_id: paneId });
      this.supersede(paneId);
    }
  }

  private supersede(paneId: string): void {
    if (!this.features.has("ping")) return;
    const stale = this.superseded.get(paneId) ?? { ends: 0, fence: null };
    stale.ends += 1;
    stale.fence = this.nextPing++;
    this.rawSend({ type: "ping", id: stale.fence });
    this.superseded.set(paneId, stale);
  }

  resize(paneId: string, cols: number, rows: number, force = false): void {
    const state = this.attached.get(paneId);
    // a pane this tab let go of (PaneTerminal's release) is sized by whoever holds it: the server
    // would apply the resize to their attach
    if (!state) return;
    // skip only redundant resizes of OUR OWN geometry: a force resize re-asserts
    // it after another client resized the shared pty (see PaneTerminal refit)
    if (!force && !state.keepSize && state.cols === cols && state.rows === rows) return;
    state.cols = cols;
    state.rows = rows;
    state.keepSize = false;
    state.releaseSizeOwed = true;
    this.send({ type: "resize", pane_id: paneId, cols, rows });
  }

  canSearchConversation(): boolean {
    return this.features.has("conversation-search");
  }

  /** Whether this connection may take a held pane from another web bridge: a server that knows how, and not observing. */
  canTakeOver(): boolean {
    return this.connected && this.mode === "interact" && this.features.has("take-over");
  }

  /** Explicitly takes the pane's attach slot; never queued or replayed on reconnect. */
  takeOver(paneId: string): boolean {
    if (!this.canTakeOver() || !this.attached.has(paneId)) return false;
    this.rawSend({ type: "take-over", pane_id: paneId });
    return true;
  }

  keepSize(paneId: string, releaseGrid = true): void {
    if (releaseGrid) this.releaseSize(paneId);
    else {
      const state = this.attached.get(paneId);
      if (state) state.keepSize = true;
    }
  }

  releaseSize(paneId: string): void {
    const state = this.attached.get(paneId);
    if (!state) return;
    const drove = state.releaseSizeOwed;
    state.keepSize = true;
    state.releaseSizeOwed = false;
    if (drove && this.mode === "interact") this.send({ type: "release-size", pane_id: paneId });
  }

  holdsSize(paneId: string): boolean {
    const state = this.attached.get(paneId);
    return state !== undefined && !state.keepSize;
  }

  /** Attached without sizing the pty: its grid is another device's, or the pane's own. */
  keepsSize(paneId: string): boolean {
    return this.attached.get(paneId)?.keepSize === true;
  }

  setPresence(active: boolean): void {
    if (this.presence === active) return;
    this.presence = active;
    if (this.connected) this.rawSend({ type: "presence", active });
  }

  /** Sets the connection's role. Not queued: the role replays before the attaches on reconnect. */
  setMode(mode: ClientRole): void {
    this.mode = mode;
    this.roleChanges += 1;
    if (this.connected) this.rawSend({ type: "role", mode });
  }

  canInput(paneId: string): boolean {
    return this.takesKey(paneId);
  }

  /**
   * The one gate every key to a pane passes (canInput, sendInput, sendKeys). A key captured at `typedAt` (markTyped;
   * now when absent) goes only over a link confirmed up before it was captured and not lost since: nothing typed while
   * the link was down, or queued before it went down, reaches the pane by itself once it is back. It is held instead.
   * "Down" is what this connection knows: a stall it has no sign of yet (the browser reports a network, the socket
   * reads OPEN) is found only by the liveness probe: keys typed before the probe starts go as usual, and keys typed
   * while it waits for its pong are held.
   */
  /** whether this connection's link has been up since `typedAt` (markTyped) without a loss: a key captured then may go */
  linkedSince(typedAt: number): boolean {
    this.noteNetwork();
    return this.linkUpAt !== null && typedAt > this.linkUpAt;
  }

  private takesKey(paneId: string, typedAt?: number): boolean {
    this.noteNetwork();
    return this.linkUpAt !== null && (typedAt === undefined || typedAt > this.linkUpAt)
      && this.connected && !this.probing && this.mode === "interact" && this.inputReady.has(paneId);
  }

  canQueueMessages(): boolean {
    return this.connected && this.mode === "interact" && this.features.has("submit") && this.features.has("pending-input");
  }

  canHoldMessages(): boolean {
    return this.canQueueMessages() && this.features.has("pending-hold");
  }

  /** `stop`: the composer's Stop, a lone ESC the bridge keeps ahead of the next message. `automatic`: xterm's own reply, nobody typed it.
   * `secret`: typed at a masked prompt. Neither is kept to be held when its connection ends unconfirmed.
   * `typedAt`: when it was captured (markTyped), for typing that waited; see takesKey */
  sendInput(paneId: string, text: string, stop = false, automatic = false, secret = false, typedAt?: number): boolean {
    if (!this.takesKey(paneId, typedAt)) { this.traceProbeRefusal(); return false; }
    // a password's too: its input-result proves the pane took it, where a pong proves only that the bridge read it
    const id = !automatic && (!this.featuresKnown || this.features.has("input-receipt")) ? this.nextInput++ : undefined;
    try { this.rawSend({ type: "input", pane_id: paneId, text, ...(stop ? { stop: true } : {}), ...(automatic ? { automatic: true } : {}), ...(id !== undefined ? { id } : {}) }); } catch { return false; }
    if (!secret && !automatic) this.awaitReceipt(paneId, text, id);
    if (secret && !automatic) this.awaitSecretReceipt(paneId, id);
    return true;
  }

  /**
   * Typing the socket took has not yet reached the server: a relay carrier can stop before its mux
   * writes the frame, and a socket can go half-open just after a send (#2587).
   */
  private awaitReceipt(paneId: string, text: string, id?: number): void {
    if (id === undefined && this.featuresKnown && !this.features.has("ping")) return;
    const typed = this.unconfirmed.get(paneId) ?? [];
    typed.push({ text, fence: this.nextPing, ...(id !== undefined ? { id } : {}) });
    this.unconfirmed.set(paneId, typed);
    if (this.featuresKnown) this.fenceInput();
  }

  /** A key sent as a password is fenced as typing is, but only counted: a connection that ends first makes its terminal say a key may not have arrived (takeUnconfirmedSecrets). */
  private awaitSecretReceipt(paneId: string, id?: number): void {
    if (id === undefined && this.featuresKnown && !this.features.has("ping")) return;
    this.unconfirmedSecrets.set(paneId, [...(this.unconfirmedSecrets.get(paneId) ?? []), { fence: this.nextPing, ...(id !== undefined ? { id } : {}) }]);
    if (this.featuresKnown) this.fenceInput();
  }

  private needsFence(): boolean {
    for (const typed of [...this.unconfirmed.values(), ...this.unconfirmedSecrets.values()]) if (typed.some((entry) => entry.id === undefined)) return true;
    return false;
  }

  private fenceInput(): void {
    if (this.inputFence !== null || !this.needsFence()) return;
    this.inputFence = this.nextPing++;
    try { this.rawSend({ type: "ping", id: this.inputFence }); } catch { /* see above */ }
  }

  private confirmInput(pong: number): void {
    for (const [paneId, typed] of this.unconfirmed) {
      const left = typed.filter((entry) => entry.id !== undefined || entry.fence > pong);
      if (left.length === 0) this.unconfirmed.delete(paneId);
      else this.unconfirmed.set(paneId, left);
    }
    for (const [paneId, fences] of this.unconfirmedSecrets) {
      const left = fences.filter((entry) => entry.id !== undefined || entry.fence > pong);
      if (left.length === 0) this.unconfirmedSecrets.delete(paneId);
      else this.unconfirmedSecrets.set(paneId, left);
    }
    if (this.inputFence !== null && pong >= this.inputFence) {
      this.inputFence = null;
      this.fenceInput();
    }
  }

  /** How many keys sent to this pane as a password the last connections ended with before the server confirmed them; given once. */
  takeUnconfirmedSecrets(paneId: string): number {
    // as takeUnconfirmedInput: a new connection that has not proved its herdr yet may be another herdr's
    if (this.socket !== null && this.lifetime === null) return 0;
    const lost = this.lostSecrets.get(paneId);
    this.lostSecrets.delete(paneId);
    return lost?.count ?? 0;
  }

  takeUnconfirmedInput(paneId: string): string[] {
    // a new connection that has not proved its herdr yet may be another herdr's: it waits for that proof
    if (this.socket !== null && this.lifetime === null) return [];
    const lost = this.lostInput.get(paneId);
    this.lostInput.delete(paneId);
    return lost?.typed ?? [];
  }

  /**
   * Types a composer message and submits it, straight to the socket: a Ctrl armed on the
   * terminal key bar must not turn a one-letter message into a control key. Queue delivery
   * requires "pending-input": it never falls back to an immediate send.
   */
  /** `typed`: from the terminal's input line, typed into the pane like the keyboard (see ClientMessage).
   * `clearDraft`: an immediate send over the draft an input_draft refusal named (ClientMessage `clear_draft`)
   * `sendAnyway`: an immediate send after a refusal that showed the box (ClientMessage `send_anyway`)
   * `holdOnly`: a hold that must never go on its own (the composer's Alt+Enter): refused, not queued, where the bridge cannot hold */
  submit(paneId: string, text: string, payload: string, typed = false, delivery: SubmitDelivery = "immediate", clearDraft?: string, sendAnyway = false, resendId?: string, generation?: number, agentOnly = false, holdOnly = false, commandKey?: string): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    if (resendId !== undefined && sendAnyway) return Promise.resolve({ ok: false, code: "invalid_delivery", message: "Use a held-copy resend id only for an immediate chat message" });
    return (async (): Promise<SubmitResult> => {
      await Promise.race([this.featuresSeen, new Promise((resolve) => window.setTimeout(resolve, FEATURES_WAIT_MS))]);
      // a liveness probe in flight is waited out: nothing is sent on a socket that may be dead
      if (!(await this.probeSettled(socket))) return NOT_TRANSMITTED;
      if (this.mode === "observe") return { ok: false, code: "read_only", message: "Observe connections cannot submit messages." };
      // the wait ended before the bridge said what it takes: one that takes `submit` would get the
      // message as raw typed input, past every check it makes before typing (#1591), so nothing is sent
      if (!this.featuresKnown) return CAPABILITIES_UNKNOWN;
      if (delivery === "hold" && !this.canHoldMessages()) {
        if (holdOnly) return { ok: false, code: "pending_hold_unsupported", message: "Update this PC to hold messages. Nothing was sent." };
        delivery = "queue";
      }
      if (delivery === "queue" && !this.canQueueMessages()) return { ok: false, code: "pending_input_unsupported", message: "Update this PC to queue messages." };
      // an older bridge ignores agent_only and would type the message into whatever is in front, a shell too
      if (agentOnly && !this.features.has("agent-only")) return { ok: false, code: "agent_only_unsupported", message: "Update this PC to send comments on a reply. Nothing was sent." };
      if (!this.features.has("submit")) {
        if (clearDraft !== undefined || sendAnyway) return { ok: false, code: "unsupported", message: "Update this PC to clear a terminal draft before sending. Nothing was sent." };
        this.rawSend({ type: "input", pane_id: paneId, text: `${payload}\r` });
        return { ok: true, unconfirmed: true };
      }
      const id = this.nextSubmit++;
      return this.submitRequest({ type: "submit", id, pane_id: paneId, text, payload, ...(typed ? { typed: true } : {}), ...(delivery !== "immediate" ? { delivery } : {}),
        ...(commandKey !== undefined ? { command_key: commandKey } : {}),
        ...(clearDraft !== undefined ? { clear_draft: clearDraft } : {}), ...(sendAnyway ? { send_anyway: true as const } : {}), ...(resendId !== undefined ? { resend_id: resendId, resend_generation: generation ?? 0 } : {}), ...(agentOnly ? { agent_only: true as const } : {}) });
    })();
  }

  /** Explicitly steer or discard one server-owned pending item. Never queued or replayed. */
  pendingAction(paneId: string, pendingId: string, action: "steer" | "discard", generation?: number, withdrawalOnly = false): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    return (async (): Promise<SubmitResult> => {
      await Promise.race([this.featuresSeen, new Promise((resolve) => window.setTimeout(resolve, FEATURES_WAIT_MS))]);
      if (!(await this.probeSettled(socket))) return NOT_TRANSMITTED;
      if (this.mode === "observe") return { ok: false, code: "read_only", message: "Observe connections cannot change pending messages." };
      if (!this.canQueueMessages()) return { ok: false, code: "pending_input_unsupported", message: "Update this PC to manage pending messages." };
      return this.submitRequest({ type: "pending-action", id: this.nextSubmit++, pane_id: paneId, pending_id: pendingId, action,
        ...(generation !== undefined ? { resend_generation: generation } : {}), launch_ended: true, ...(withdrawalOnly ? { withdrawal_only: true as const } : {}) });
    })();
  }

  canInsert(): boolean {
    return this.connected && this.mode === "interact" && this.features.has("terminal-insert");
  }

  /**
   * Types the terminal's input line into the pane without Enter, straight to the socket, and
   * settles once the bridge says herdr has the bytes (insert-result): never on the frame leaving.
   * `text` is one line of the draft, as written (shared/terminal-insert.ts). A bridge without
   * "terminal-insert" gets nothing at all: no input or submit stands in for it. null when offline
   * or observing; a connection that drops settles it as not confirmed, and nothing is tried again.
   */
  insert(paneId: string, text: string): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    // the pane's input as it was when the user tapped Insert: a detach and reattach (or a role change and
    // back) during the waits below would carry this draft into an attachment it was not meant for
    const lease = this.inputLease(paneId);
    return (async (): Promise<SubmitResult> => {
      await Promise.race([this.featuresSeen, new Promise((resolve) => window.setTimeout(resolve, FEATURES_WAIT_MS))]);
      if (!(await this.probeSettled(socket))) return NOT_TRANSMITTED;
      if (this.mode === "observe") return { ok: false, code: "read_only", message: "Observe connections cannot type into the pane." };
      if (this.inputLease(paneId) !== lease) return { ok: false, code: "input_not_ready", message: "Terminal input changed before the text left. Nothing was sent." };
      if (!this.featuresKnown) return CAPABILITIES_UNKNOWN;
      if (!this.features.has("terminal-insert")) return { ok: false, code: "unsupported", message: "Update this PC to insert text without Enter. Nothing was sent." };
      if (!this.inputReady.has(paneId)) return { ok: false, code: "input_not_ready", message: "Terminal input is not ready. Nothing was sent." };
      return this.submitRequest({ type: "insert", id: this.nextSubmit++, pane_id: paneId, text });
    })();
  }

  /** Only an acknowledgement callback is retained, never a frame to resend. */
  private submitRequest(message: Extract<ClientMessage, { type: "submit" | "pending-action" | "insert" }>): Promise<SubmitResult> {
    const id = message.id;
    this.requests.set(id, { type: message.type, paneId: message.pane_id, ...(message.type === "submit" ? { queued: message.delivery === "queue" || message.delivery === "hold" } : message.type === "pending-action" ? { pendingId: message.pending_id } : {}) });
    const result = new Promise<SubmitResult>((resolve) => {
      this.submits.set(id, resolve);
      window.setTimeout(() => {
        if (!this.submits.delete(id)) return;
        this.requests.delete(id);
        this.trace.record("submit_timeout", { request_id: id }, true);
        resolve({ ok: false, code: "timeout", message: "the pane did not confirm this request in time" });
      }, SUBMIT_TIMEOUT_MS);
    });
    try {
      this.rawSend(message);
      this.trace.record("submit_sent", { request_id: id });
      // a socket silent since the request left may be half-open (a network that dropped without a
      // close): ask it now rather than at the idle check, up to IDLE_PROBE_MS away
      const socket = this.socket;
      const sentAt = Date.now();
      window.setTimeout(() => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        if (this.submits.has(id) && this.socket === socket && this.lastFrameAt <= sentAt) this.probe();
      }, PROBE_TIMEOUT_MS);
    } catch {
      this.submits.get(id)?.(NOT_TRANSMITTED);
      this.submits.delete(id);
      this.requests.delete(id);
    }
    return result;
  }

  /**
   * Whether a secret for `prompt` is typed to this bridge instead of sent as a `secret` (sendSecret): the bridge has
   * said what it takes, and it does not take that prompt. Nothing on such a bridge checks that the prompt is still there.
   */
  typesSecret(prompt: string): boolean {
    // not a bridge from before `submit`, which is told to update instead (sendSecret)
    return this.featuresKnown && this.features.has("submit") && !this.takesPrompt(prompt);
  }

  /**
   * Whether this bridge takes a `secret` at `prompt`: one every bridge with masked input reads, or one of a set of
   * prompts it lists. `secret-prompts-2` is #3566's set, `secret-prompts-3` everything shared/secret-prompt.ts reads now.
   */
  private takesPrompt(prompt: string): boolean {
    const set = promptSet(prompt);
    return set === 1 || this.features.has("secret-prompts-3") || (set === 2 && this.features.has("secret-prompts-2"));
  }

  /**
   * Send once on this connection. Only a result callback is retained, never the value. A prompt this bridge does
   * not take a `secret` at (takesPrompt) goes to it as typing at a masked prompt does:
   * the value, then Enter, as `input`, never kept. That bridge would answer `invalid_secret`, and the masked field has
   * taken the input line's place, so nothing else could answer the prompt. No bridge checks its screen for typing, so
   * it goes only into the attachment the field was sent for, behind no send of this connection that the pane has yet to
   * answer (the bridge would type that into the prompt first), and only while the page still shows the prompt: `shown`,
   * asked last. What stays open against such a bridge is what the page cannot see: a prompt that left on the PC while
   * its output or these frames were on their way, and another connection's send queued for the pane.
   */
  sendSecret(paneId: string, prompt: string, secret: string, shown: () => boolean): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    // the pane's input as it was when the field was sent, as insert reads it
    const lease = this.inputLease(paneId);
    return (async (): Promise<SubmitResult> => {
      // right after a reconnect the terminal's output can arrive before the frame that says
      // whether the server takes masked input: wait for it, as a submit does
      await Promise.race([this.featuresSeen, new Promise((resolve) => window.setTimeout(resolve, FEATURES_WAIT_MS))]);
      if (!(await this.probeSettled(socket))) { secret = ""; return DISCONNECTED; }
      if (promptSet(prompt) !== 1) {
        // the wait ended before the bridge said what it takes: one that takes the prompt checks its own screen, so
        // nothing is typed past it
        if (!this.featuresKnown) { secret = ""; return CAPABILITIES_UNKNOWN; }
        if (!this.takesPrompt(prompt)) {
          // a bridge from before `submit`: a message sent to it leaves no request here (submit answers unconfirmed), so
          // the check below would not see one still on its way to the pane
          if (!this.features.has("submit")) { secret = ""; return { ok: false, code: "unsupported", message: "Update this PC to use masked input." }; }
          if ([...this.requests.values()].some((request) => request.paneId === paneId)) { secret = ""; return { ok: false, code: "pane_busy", message: "Check the terminal before trying again." }; }
          if (this.inputLease(paneId) !== lease || !shown()) { secret = ""; return { ok: false, code: "prompt_changed", message: "Check the terminal before trying again." }; }
          // Enter in a frame of its own, as the input line's Enter is sent: a mirrored pane's shell may not take a `\r`
          // inside the text for it. No passphrase (validSecret) is Enter alone
          const typed = (secret === "" || this.sendInput(paneId, secret, false, false, true)) && this.sendInput(paneId, "\r", false, false, true);
          secret = "";
          return typed ? { ok: true } : { ok: false, code: "input_unavailable", message: "Check the terminal before trying again." };
        }
      }
      if (!this.features.has("secret-input")) { secret = ""; return { ok: false, code: "unsupported", message: "Update this PC to use masked input." }; }
      const id = this.nextSubmit++;
      this.requests.set(id, { type: "secret", paneId });
      const result = new Promise<SubmitResult>((resolve) => {
        this.submits.set(id, resolve);
        window.setTimeout(() => {
          if (this.submits.delete(id)) { this.requests.delete(id); resolve({ ok: false, code: "timeout", message: "Check the terminal before trying again." }); }
        }, 15_000);
      });
      try { this.rawSend({ type: "secret", id, pane_id: paneId, prompt, secret }); }
      catch {
        this.submits.get(id)?.(DISCONNECTED);
        this.submits.delete(id);
        this.requests.delete(id);
      } finally { secret = ""; }
      return result;
    })();
  }

  private matchesRequest(id: number, type: "submit" | "pending-action" | "secret" | "insert", paneId: string, pendingId?: string): boolean {
    const request = this.requests.get(id);
    return request?.type === type && request.paneId === paneId && (type !== "pending-action" || request.pendingId === pendingId);
  }

  private resolveRequest(id: number, result: SubmitResult): void {
    if (this.requests.get(id)?.type !== "secret") this.trace.record("submit_result", { request_id: id, result: result.ok ? "ok" : "refused" });
    const settle = this.submits.get(id);
    this.submits.delete(id);
    this.requests.delete(id);
    settle?.(result);
  }

  private settleSubmits(result: SubmitResult): void {
    for (const settle of this.submits.values()) settle(result);
    this.submits.clear();
    this.requests.clear();
  }

  private traceProbeRefusal(): void {
    if (!this.probing || this.probeRefusalRecorded) return;
    this.probeRefusalRecorded = true;
    this.trace.record("probe_input_blocked", {}, true);
  }

  /** `typedAt`: when the keys were captured (markTyped), for keys that waited; see takesKey */
  sendKeys(paneId: string, keys: string[], typedAt?: number): boolean {
    if (!this.takesKey(paneId, typedAt)) { this.traceProbeRefusal(); return false; }
    try { this.rawSend({ type: "keys", pane_id: paneId, keys }); return true; } catch { return false; }
  }

  close(): void {
    this.trace.close();
    this.disposed = true;
    linkWatchers.delete(this);
    this.routeWatch?.stop();
    this.routeWatch = null;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearConnectTimer();
    this.clearLiveness();
    this.connectionState = "closed";
    this.endedEarly = new WeakSet();
    if (this.wakeListening) {
      window.removeEventListener("online", this.onWake);
      window.removeEventListener("offline", this.onOffline);
      window.removeEventListener("pageshow", this.onWake);
      window.removeEventListener("pagehide", this.onLeave);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onWake);
      this.wakeListening = false;
    }
    this.socket?.close();
    this.socket = null;
    this.settleSubmits(DISCONNECTED);
    this.handlers.clear();
    this.disconnectHandlers.clear();
    this.beforeReplayHandlers.clear();
  }
}
