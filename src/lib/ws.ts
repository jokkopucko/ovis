import type { ClientMessage, ClientRole, PendingMessage, ServerFeature, ServerMessage } from "../../shared/protocol.ts";
import { receiptResumeId } from "./receiptResume.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../../shared/terminal-flow.ts";
import { ConnectionTrace } from "./connectionTrace.ts";

type Handler = (message: ServerMessage) => void;

/** A submit was delivered, accepted into the bridge's pending queue, or refused. */
/** `draft`: an input_draft refusal's one-row Claude draft, which a send with clearDraft may clear;
 * `box`: a refusal naming no draft, what the server read in the box, after which a send with sendAnyway may go */
/** immediate: typed now; queue: waits for the next turn; hold: waits for the user's Send now */
export type SubmitDelivery = "immediate" | "queue" | "hold";
/** `unconfirmed`: written to an older bridge that sends no receipt, so nothing says the pane took it */
export type SubmitResult = { ok: true; pending?: PendingMessage; unconfirmed?: true } | { ok: false; code: string; message: string; draft?: string; box?: string };

/** Right after a reconnect what the server supports may still be on its way: its `features` frame, or an older bridge's snapshot. */
const FEATURES_WAIT_MS = 2000;
/**
 * A submit the server never answers: the composer stops waiting and keeps the text. The
 * server types nothing once 45s have passed since the message reached it (queued behind
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
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const DISCONNECTED: SubmitResult = { ok: false, code: "disconnected", message: "the connection dropped before the pane confirmed this message" };
/** The connection dropped before the request's frame left: nothing can have reached the pane. */
const NOT_TRANSMITTED: SubmitResult = { ok: false, code: "not_transmitted", message: "the connection dropped before this message was sent" };
/** The socket is open, but nothing has said yet what the bridge takes (features frame or snapshot): nothing was sent (#1806). */
const CAPABILITIES_UNKNOWN: SubmitResult = { ok: false, code: "capabilities_unknown", message: "this PC has not said yet what it supports; nothing was sent" };

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
  /** Chat or a hidden pane: attaches (a reconnect's too) leave the shared pty's size alone */
  keepSize: boolean;
  /** This connection has sized the terminal since its last grid release. */
  releaseSizeOwed: boolean;
}

function defaultUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Reconnecting client for /ws. Attachments are remembered with their geometry so a
 * dropped connection restores the live terminal at the right size instead of
 * leaving a stale screen behind.
 *
 * Two policies live here:
 * - The connection's role survives reconnects: an observe connection re-sends its
 *   role before the attach replay, so a reconnecting phone still cannot resize or
 *   type into the operator's pty.
 * - Terminal input is NEVER queued while disconnected (a command typed into a dead
 *   socket must not fire later, unannounced); PaneTerminal keeps it as a draft the
 *   user reviews instead. Control frames (attach/resize/role) replay as before.
 */
export class HerdrSocket {
  private socket: WebSocket | null = null;
  private readonly url: string;
  private readonly handlers = new Set<Handler>();
  private readonly disconnectHandlers = new Set<() => void>();
  private readonly beforeReplayHandlers = new Set<() => void>();
  private featuresKnown = false;
  private readonly outputSeen = new Set<string>();
  private readonly inputReady = new Set<string>();
  /** each pane's changes of input on this connection (readiness given, lost or given again, attach, detach); see inputLease */
  private readonly leaseChanges = new Map<string, number>();
  /** role changes on this connection, asked for or forced by the server */
  private roleChanges = 0;
  private readonly attached = new Map<string, AttachState>();
  /** panes this tab views read-only while out of use (feature "watch"), at the grid it asked for; replayed after each snapshot */
  private readonly watched = new Map<string, { cols: number; rows: number }>();
  /** Panes whose mounted, visible chat asks for transcript invalidations. The server drops interest
   * with the attachment, so each attach of a pane listed here (a reconnect's, or a tab back in use
   * after letting go of it) asks again; only the chat taking its interest back removes it. */
  private readonly conversationWanted = new Set<string>();
  private retries = 0;
  /** When this connection opened; a brief open must not restart a flapping connection's retries. */
  private openedAt: number | null = null;
  private reconnectTimer: number | null = null;
  /** the deadline of the attempt still in CONNECTING */
  private connectTimer: number | null = null;
  /** attempts given up at their deadline since the last one that opened */
  private connectTimeouts = 0;
  /** sockets wake() or a probe ended before their close event ran: that event can still say the output stopped */
  private endedEarly = new WeakSet<WebSocket>();
  private disposed = false;
  private wakeListening = false;
  private connectionState: ConnectionState = "idle";
  /** when the current socket last opened or delivered a frame (Date.now()) */
  private lastFrameAt = 0;
  /** the deadline of the ping in flight; null while no probe waits */
  private probeTimer: number | null = null;
  /**
   * a probe the page hid before its pong: its deadline is stopped (it must not run out while the
   * page is frozen), but it is not answered, so input stays refused and submits keep waiting; the
   * page coming back pings again
   */
  private probePaused = false;
  /** the ids of the probe's pings: only their pong ends it */
  private readonly probeIds = new Set<number>();
  /** settles when the probe in flight ends (answered, given up, or the connection ended) */
  private probeDone: Promise<void> = Promise.resolve();
  private markProbeDone: () => void = () => {};
  /** probes since the last pong that ended in a drop: each doubles the next deadline */
  private probeDrops = 0;
  /** whether the last snapshot listed "ping": kept across reconnects, so a socket whose snapshot never comes is probed too */
  private pingKnown = false;
  /** the periodic check that pings a connection silent for IDLE_PROBE_MS */
  private idleTimer: number | null = null;
  private nextPing = 1;
  /** a page shown again or a network back: a reconnect waiting out its backoff runs now */
  private readonly onWake = (event?: Event): void => {
    if (event?.type === "pageshow") { this.left = false; this.trace.record("pageshow"); }
    if (event?.type === "online") this.trace.record("online");
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
  /** whether the page is in use (`presence`), as last told; null until the page says */
  private presence: boolean | null = null;
  private stopped = false;
  /** the output stopped while the page was hidden, or just after it was shown again */
  private stoppedHidden = false;
  /** the page went hidden and has not been shown since */
  private pageHidden = false;
  /** between pagehide and the pageshow that brings the page back */
  private left = false;
  /** when the page was last shown after being hidden (Date.now()); 0 once an attach after a stop used it */
  private shownAt = 0;
  /** what the connected server listed in its features frame (an older bridge: its snapshot): empty until it arrives, and on older bridges */
  private features = new Set<ServerFeature>();
  /** settles when this connection's features are known (or the connection ends) */
  private featuresSeen: Promise<void> = Promise.resolve();
  private markFeatures: () => void = () => {};
  /** whether a `features` frame may say what this connection's bridge takes before its snapshot; see trustFeatures */
  private featuresTrusted: (frame: Extract<ServerMessage, { type: "features" }>) => boolean = () => false;
  private nextSubmit = 1;
  /** submits waiting for their submit-result, by id */
  private readonly submits = new Map<number, (result: SubmitResult) => void>();
  /** Receipts match the operation and captured target on this connection, never an ID alone. */
  private readonly requests = new Map<number, { type: "submit" | "pending-action" | "secret" | "insert"; paneId: string; queued?: boolean; pendingId?: string }>();

  private readonly trace: ConnectionTrace;
  private connectionEpoch = 0;
  private probeRefusalRecorded = false;

  constructor(url: string = defaultUrl()) {
    this.url = url;
    this.trace = new ConnectionTrace(url, () => ({
      connection: this.connectionEpoch, socket_state: this.socket?.readyState ?? null,
      visibility: typeof document === "undefined" ? "unknown" : document.visibilityState === "hidden" ? "hidden" : "visible",
      online: typeof navigator === "undefined" || typeof navigator.onLine !== "boolean" ? null : navigator.onLine,
    }));
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
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

  /** The server closed this connection with 4008: nothing reconnects until an attach. */
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
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
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
    const socket = new WebSocket(this.url);
    const epoch = ++this.connectionEpoch;
    const started = Date.now();
    this.socket = socket;
    this.connectionState = "connecting";
    this.trace.record("connect", { attempt: this.retries });
    this.features = new Set();
    this.inputReady.clear();
    this.outputSeen.clear();
    this.featuresKnown = false;
    this.featuresSeen = new Promise((resolve) => { this.markFeatures = resolve; });
    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (this.socket !== socket || socket.readyState !== WebSocket.CONNECTING) return;
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
      this.lastFrameAt = this.openedAt;
      this.watchIdle(socket);
      // always send the role, never only when non-default: a user can flip the role
      // while disconnected (setMode stores it without sending), so without this frame
      // the reconnect would leave the server on the stale role and no ack would ever
      // arrive - the UI would stay stuck in the old role while the header pill lies
      this.rawSend({ type: "role", mode: this.mode });
      // a new connection is a new client to the server: it has to hear again whether the page is in use
      if (this.presence !== null) this.rawSend({ type: "presence", active: this.presence });
      // Mounted panes decide whether a new connection may acquire an attach before any replay.
      for (const handler of this.beforeReplayHandlers) handler();
      for (const [paneId, state] of this.attached) {
        state.releaseSizeOwed = !state.keepSize;
        this.rawSend({ type: "attach", pane_id: paneId, cols: state.cols, rows: state.rows, flow_control: "ack", receipt_resume_id: receiptResumeId(), ...(state.keepSize ? { keep_size: true } : {}) });
      }
    });

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
        /* ignore malformed frame */
        return;
      }
      // ended before the handlers run, so the input checks they make already read true; the pong
      // goes on to them, so a view that read input as refused during the probe reads it again
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
      // a server without the read-only view (an older bridge after a reconnect) ends this tab's watches
      let unwatched: string[] = [];
      // A server lists its features in a first frame of their own, before the snapshot, which can wait
      // seconds on herdr; an older bridge lists them in its snapshot only. Each list is the bridge's
      // latest word, but what it restores is asked for once per connection, by the first of them. A features
      // frame counts only when trusted (trustFeatures); otherwise its snapshot says, as an older bridge's does.
      if ((message.type === "features" && this.featuresTrusted(message)) || message.type === "snapshot") {
        const first = !this.featuresKnown;
        this.features = new Set(message.features ?? []);
        this.featuresKnown = true;
        this.pingKnown = this.features.has("ping");
        // a probe sent before these features (running or paused), on ping support remembered from an
        // earlier connection: this bridge does not answer pings (an older one after a reconnect), so
        // its connection is trusted as before rather than dropped at the deadline or left paused
        if (!this.pingKnown && this.probing) this.endProbe();
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
      if (message.type === "watch-end") this.watched.delete(message.pane_id);
      if (message.type === "pty-data") this.outputSeen.add(message.pane_id);
      if ((message.type === "input-ready" && message.ready !== false) || (message.type === "pty-data" && this.featuresKnown && !this.features.has("input-ready"))) {
        if (this.attached.has(message.pane_id)) this.inputReady.add(message.pane_id);
      }
      if ((message.type === "input-ready" && message.ready === false) || message.type === "pty-exit" || (message.type === "error" && message.pane_id && ["attach_held", "input_not_ready"].includes(message.code))) this.inputReady.delete(message.pane_id!);
      // every readiness the bridge states is a lease of its own, a ready after a ready included
      if (readyPane !== null && (message.type === "input-ready" || wasReady !== this.inputReady.has(readyPane))) this.changeLease(readyPane);
      if (message.type === "submit-result" && this.matchesRequest(message.id, "submit", message.pane_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true, ...(message.pending ? { pending: message.pending } : {}) }
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
      if (message.type === "insert-result" && this.matchesRequest(message.id, "insert", message.pane_id)) {
        this.resolveRequest(message.id, message.ok ? { ok: true } : { ok: false, code: message.code ?? "insert_failed", message: message.message ?? "the pane did not take the text" });
      }
      // A terminal/parser failure is not malformed JSON and must not disappear.
      this.emit(message);
      for (const paneId of unwatched) this.emit({ type: "watch-end", pane_id: paneId });
    });

    socket.addEventListener("close", (event) => {
      this.trace.record("close", { code: event.code, pending: this.submits.size, connection: epoch, socket_state: socket.readyState }, event.code !== 1000 && event.code !== 1001);
      if (this.endedEarly.has(socket)) {
        this.endedEarly.delete(socket);
        // the server's own close still decides whether output stopped, even after a replacement started
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

  /** The end of this connection, from its close event or a connect deadline; a stale socket's is ignored. */
  private closed(socket: WebSocket, code: number): void {
    if (this.socket !== socket) return;
    this.endConnection();
    if (code === OUTPUT_STALLED_CLOSE_CODE) {
      this.stopOutput();
      return;
    }
    this.scheduleReconnect();
  }

  /** Drops the current connection: its submits settle as disconnected and the disconnect handlers run. */
  private endConnection(): void {
    if (this.submits.size > 0) this.trace.record("submit_disconnect", { pending: this.submits.size }, true);
    if (this.openedAt !== null && Date.now() - this.openedAt >= STABLE_CONNECTION_MS) this.retries = 0;
    this.openedAt = null;
    this.socket = null;
    this.clearConnectTimer();
    this.clearLiveness();
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
    if (!socket || socket.readyState !== WebSocket.OPEN || !this.pingKnown || this.probeTimer !== null) return;
    this.connectionState = "probing";
    this.probeRefusalRecorded = false;
    // a paused probe goes on with a fresh ping: whoever waits on it keeps waiting
    if (this.probePaused) this.probePaused = false;
    else this.probeDone = new Promise((resolve) => { this.markProbeDone = resolve; });
    this.ping(socket, 1);
  }

  /** Stops a probe's deadline while the page is hidden, without answering it (see probePaused). */
  private pauseProbe(): void {
    if (this.probeTimer === null) return;
    window.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.probeIds.clear();
    this.probePaused = true;
  }

  /** A probe waits for its pong: running, or paused while the page is hidden. */
  private get probing(): boolean {
    return this.probeTimer !== null || this.probePaused;
  }

  /** Sends one of the probe's pings and arms its deadline; `attempt` 2 is the last before a drop. */
  private ping(socket: WebSocket, attempt: 1 | 2): void {
    const deadline = Math.min(PROBE_TIMEOUT_MAX_MS, PROBE_TIMEOUT_MS * 2 ** this.probeDrops);
    const armedAt = Date.now();
    this.probeTimer = window.setTimeout(() => {
      this.probeTimer = null;
      if (this.socket !== socket) return;
      // the server is closing it: its close event decides, so a 4008 still stops output (see wake())
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
    // a send that throws leaves the deadline to drop the socket
    try { this.rawSend({ type: "ping", id }); } catch { /* see above */ }
  }

  private endProbe(): void {
    if (this.probeTimer !== null) window.clearTimeout(this.probeTimer);
    this.probeTimer = null;
    this.probePaused = false;
    this.probeIds.clear();
    this.markProbeDone();
    if (this.connectionState === "probing") this.connectionState = "open";
  }

  /** Waits out a probe in flight on `socket`; true when it is still this connection afterwards. */
  private async probeSettled(socket: WebSocket): Promise<boolean> {
    while (this.probing && this.socket === socket) await this.probeDone;
    return this.connected && this.socket === socket;
  }

  /**
   * Ends a connection that did not answer its probe without waiting for a close event, which a
   * half-open socket may not deliver for minutes: its submits settle, the disconnect handlers run,
   * and a new socket connects now and replays the role and attaches. The old socket's late events
   * are ignored (it is no longer this.socket).
   */
  private drop(socket: WebSocket): void {
    this.trace.record("probe_drop", { pending: this.submits.size }, true);
    this.probeDrops += 1;
    this.endConnection();
    // a server close (4008) that comes after this still stops output
    this.endedEarly.add(socket);
    socket.close();
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retries = 0;
    this.connect();
  }

  private watchIdle(socket: WebSocket): void {
    if (this.idleTimer !== null) window.clearInterval(this.idleTimer);
    this.idleTimer = window.setInterval(() => {
      if (this.socket !== socket) return;
      if (socket.readyState === SOCKET_CLOSING) this.trace.record("closing_wait", { elapsed_ms: Date.now() - this.lastFrameAt, pending: this.submits.size }, true);
      // a hidden page is probed when it comes back (wake)
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
    window.addEventListener("pageshow", this.onWake);
    window.addEventListener("pagehide", this.onLeave);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onWake);
      // a page loaded behind another app counts as put away until it is first shown
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
    if (socket?.readyState === WebSocket.OPEN) {
      this.probe();
      return;
    }
    if (socket?.readyState === SOCKET_CLOSING) {
      this.retries = 0;
      return;
    }
    if (socket?.readyState === WebSocket.CONNECTING && this.connectTimeouts > 0) {
      // never opened, so its close event can carry no output-stalled code: end it like its deadline would
      socket.close();
      this.closed(socket, 1006);
    } else if (socket?.readyState === SOCKET_CLOSED) {
      // ended now so its submits and listeners settle; its close event, when it runs, can still stop output
      this.closed(socket, 1006);
      this.endedEarly.add(socket);
    }
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.retries = 0;
    this.connectTimeouts = 0;
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== null) return;
    const delay = Math.min(5000, 250 * 2 ** this.retries);
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
      // the time the page was shown is used up: a stop on this new connection while in use is final
      this.shownAt = 0;
      this.connect();
    }
  }

  /** Retained control state, not queued input: kept across detach, asked again by the next attach. */
  watchConversation(paneId: string, enabled: boolean): void {
    if (this.conversationWanted.has(paneId) === enabled) return;
    if (enabled) this.conversationWanted.add(paneId);
    else this.conversationWanted.delete(paneId);
    // a detached pane has no interest on the server: its next attach asks
    if (this.attached.has(paneId) && this.features.has("conversation-watch")) {
      this.send({ type: "conversation-watch", pane_id: paneId, enabled });
    }
  }

  /** Whether this connection's bridge pushes transcript changes to a watching chat. */
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

  /** Whether this tab holds an attach for the pane (attached and not let go of). */
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
    this.watched.set(paneId, { cols, rows });
    // before the features are known, the handler that learns them sends it
    if (this.connected && this.featuresKnown) this.rawSend({ type: "watch", pane_id: paneId, cols, rows });
    return true;
  }

  /** Before the features are known, a watch waits for capability discovery rather than acquiring an attach. */
  canWatch(): boolean {
    return !this.featuresKnown || this.features.has("watch");
  }

  unwatch(paneId: string): void {
    if (this.watched.delete(paneId) && this.connected && this.features.has("watch")) this.rawSend({ type: "unwatch", pane_id: paneId });
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

  /** Keep the pane's size on reconnect; release its grid only when the terminal stops showing. */
  keepSize(paneId: string, releaseGrid = true): void {
    if (releaseGrid) this.releaseSize(paneId);
    else {
      const state = this.attached.get(paneId);
      if (state) state.keepSize = true;
    }
  }

  /**
   * A terminal this tab sized is no longer showing: the server hands the pty to a
   * terminal still showing on another device (#472). Not replayed: a reconnect attaches with keep_size.
   */
  releaseSize(paneId: string): void {
    const state = this.attached.get(paneId);
    if (!state) return;
    const drove = state.releaseSizeOwed;
    state.keepSize = true;
    state.releaseSizeOwed = false;
    if (drove && this.mode === "interact") this.send({ type: "release-size", pane_id: paneId });
  }

  /** Whether the page is in use (visible and focused): the server holds web push while one is. Replays on reconnect. */
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

  /** False while a liveness probe waits: typing goes to the held draft until the connection answers its ping. */
  canInput(paneId: string): boolean {
    return this.connected && !this.probing && this.mode === "interact" && this.inputReady.has(paneId);
  }

  /** Whether this connection can accept and manage pending messages on the bridge. */
  canQueueMessages(): boolean {
    return this.connected && this.mode === "interact" && this.features.has("submit") && this.features.has("pending-input");
  }

  /** Whether the bridge can keep a pending message for Send now alone (`delivery: "hold"`). */
  canHoldMessages(): boolean {
    return this.canQueueMessages() && this.features.has("pending-hold");
  }

  /** `stop`: the composer's Stop, a lone ESC the bridge keeps ahead of the next message. */
  sendInput(paneId: string, text: string, stop = false): boolean {
    if (!this.canInput(paneId)) { this.traceProbeRefusal(); return false; }
    try { this.rawSend(stop ? { type: "input", pane_id: paneId, text, stop: true } : { type: "input", pane_id: paneId, text }); return true; } catch { return false; }
  }

  /**
   * Types a composer message and submits it, straight to the socket: a Ctrl armed on the
   * terminal key bar must not turn a one-letter message into a control key. A server
   * listing "submit" sends Enter itself, after a gap, and says how it went; an older
   * bridge gets the payload and its Enter in one frame, as before. Queue delivery
   * requires "pending-input": it never falls back to an immediate send. `text` is the message
   * as written, `payload` the same shaped for the pane's paste mode. null, sending
   * nothing, when offline.
   */
  /** `typed`: from the terminal's input line, typed into the pane like the keyboard (see ClientMessage).
   * `clearDraft`: an immediate send over the draft an input_draft refusal named (ClientMessage `clear_draft`)
   * `sendAnyway`: an immediate send after a refusal that showed the box (ClientMessage `send_anyway`) */
  submit(paneId: string, text: string, payload: string, typed = false, delivery: SubmitDelivery = "immediate", clearDraft?: string, sendAnyway = false, resendId?: string, generation?: number, agentOnly = false): Promise<SubmitResult> | null {
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
      // hold is decided once the bridge said what it supports: one too old to hold queues it as before
      if (delivery === "hold" && !this.canHoldMessages()) delivery = "queue";
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

  /** Whether this connection's bridge types the terminal's input line without Enter (feature "terminal-insert"). */
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
      // the wait ended before the bridge said what it takes: "Update this PC" would be wrong advice
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
    try { this.rawSend(message); this.trace.record("submit_sent", { request_id: id }); }
    catch {
      this.submits.get(id)?.(NOT_TRANSMITTED);
      this.submits.delete(id);
      this.requests.delete(id);
    }
    return result;
  }

  /** Send once on this connection. Only a result callback is retained, never the value. */
  sendSecret(paneId: string, prompt: string, secret: string): Promise<SubmitResult> | null {
    const socket = this.socket;
    if (!this.connected || socket === null || this.mode === "observe") return null;
    return (async (): Promise<SubmitResult> => {
      // right after a reconnect the terminal's output can arrive before the frame that says
      // whether the server takes masked input: wait for it, as a submit does
      await Promise.race([this.featuresSeen, new Promise((resolve) => window.setTimeout(resolve, FEATURES_WAIT_MS))]);
      if (!(await this.probeSettled(socket))) { secret = ""; return DISCONNECTED; }
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

  sendKeys(paneId: string, keys: string[]): boolean {
    if (!this.canInput(paneId)) { this.traceProbeRefusal(); return false; }
    try { this.rawSend({ type: "keys", pane_id: paneId, keys }); return true; } catch { return false; }
  }

  close(): void {
    this.trace.close();
    this.disposed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearConnectTimer();
    this.clearLiveness();
    this.connectionState = "closed";
    this.endedEarly = new WeakSet();
    if (this.wakeListening) {
      window.removeEventListener("online", this.onWake);
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
