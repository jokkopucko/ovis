import type { PendingMessage, PendingRemoval, ServerMessage } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { afterSend, afterSettled, greetingMemory, rememberGreeting } from "./greeting.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { pendingMessages, type PendingMessageStore } from "./pendingMessages.ts";
import { rememberWaitingSend, waitingBaseline, waitingKey, type WaitingBaseline } from "./sentWaiting.ts";
import { watchPageInUse } from "./presence.ts";
import { currentSurface } from "./telemetrySurface.ts";
import { HerdrSocket } from "./ws.ts";

type Handler = (message: ServerMessage, sent: boolean) => void;
type RoleAck = Extract<ServerMessage, { type: "role-ack" }>;
export interface MachineSessionOptions {
  socket?: HerdrSocket;
  pendingStore?: PendingMessageStore;
}
let nextSession = 1;

/** A PC's connection outlives its pane views. Detaching a view releases its input lease,
 * while this connection still receives the bridge's held state and delivery receipts. */
export class MachineSession {
  readonly socket: HerdrSocket;
  private readonly store: PendingMessageStore;
  private readonly identity = nextSession++;
  private currentScope: string | null = null;
  private currentConnection: string | null = null;
  private currentEpoch = 0;
  private announcedLifetime: string | undefined;
  private resumedReceipts: Array<{ paneId: string; lifetime: string; removal: PendingRemoval }> = [];
  /** rows seen going out (`sending`), each with when and what its pane's chat held then (lib/sentWaiting.ts); a row
   * back as queued or held leaves it, so the next attempt (Send now) is timed from itself */
  private readonly going = new Map<string, { at: number; after: WaitingBaseline | null }>();
  private role: RoleAck | null = null;
  private readonly handlers = new Set<Handler>();
  private readonly offMessage: () => void;
  private readonly offDisconnect: () => void;
  private readonly offPresence: () => void;
  private closed = false;

  constructor(readonly machineId: string, options: MachineSessionOptions = {}) {
    this.socket = options.socket ?? new HerdrSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?machine_id=${encodeURIComponent(machineId)}&surface=${currentSurface()}`);
    this.store = options.pendingStore ?? pendingMessages;
    // A features frame says what the bridge takes before the snapshot only for the herdr this page already
    // proved: the herdr-lifetime fence (paneLifetimes.observe) runs on the snapshot, and a send or receipt made
    // before it for a replaced herdr's reused pane IDs would be retired as unsent text while it is live (#2257)
    this.socket.trustFeatures((frame) => this.knownHerdr(frame.herdr_lifetime));
    // Installed before view subscribers, and kept even while this PC has no mounted pane.
    this.offMessage = this.socket.on((message) => {
      if (this.closed) return;
      if (message.type === "features") this.announcedLifetime = message.herdr_lifetime;
      // a connection that came back to a replaced herdr, or to one it cannot prove, can say so before
      // the roster does: the earlier herdr's drafts and lenses leave the reused pane IDs before any
      // pane hears of it
      if (message.type === "snapshot") paneLifetimes.observe([{ id: this.machineId, snapshot: message.snapshot }]);
      // the connection's first trusted word from the server (a features frame naming the known herdr, else the
      // snapshot) opens its scope: a send can leave once the features are known, and its receipt is this connection's own
      const told = message.type === "snapshot" || (message.type === "features" && this.knownHerdr(message.herdr_lifetime));
      if (told && this.currentScope === null) this.currentScope = `${this.identity}:${this.currentEpoch}`;
      if (told && message.connection !== undefined) this.currentConnection = message.connection;
      if (message.type === "pending-messages" && this.currentScope === null && this.announcedLifetime !== undefined) {
        // Open replays attaches before the first snapshot. Keep only exact resumed receipts,
        // tagged with this connection's announced herdr, never its live queue or ordinary removals.
        for (const removal of message.removed ?? []) if (removal.resumed === true) {
          this.resumedReceipts.push({ paneId: message.pane_id, lifetime: this.announcedLifetime, removal });
          if (this.resumedReceipts.length > 128) this.resumedReceipts.shift();
        }
      }
      if (message.type === "snapshot" && this.currentScope !== null) {
        for (const receipt of this.resumedReceipts) {
          if (receipt.lifetime === message.snapshot.herdr_lifetime && this.knownHerdr(receipt.lifetime)) {
            this.store.publish(paneStorageId(this.machineId, receipt.paneId), [], [receipt.removal], this.currentScope);
          }
        }
        this.resumedReceipts = [];
      }
      if (message.type === "role-ack") this.role = message;
      let sent = false;
      if (message.type === "pending-messages" && this.currentScope !== null) {
        const owner = paneStorageId(this.machineId, message.pane_id);
        const scope = this.currentScope;
        const key = waitingKey(this.machineId, message.pane_id);
        // taken before the row's Enter, as a composer send's are before it is submitted. A row back in
        // the queue or held was not typed: its next try takes its own
        for (const item of message.messages) {
          if (item.state === "sending" && !this.going.has(item.id)) this.going.set(item.id, { at: Date.now(), after: waitingBaseline(key) });
          else if (item.state === "queued" || item.state === "held") this.going.delete(item.id);
        }
        const typed = message.removed?.filter((item) => item.outcome === "sent" && this.store.isOwned(owner, item.id, scope)) ?? [];
        sent = typed.length > 0;
        // the rows' words, read before the publish lets them go
        const rows = this.store.read(owner);
        this.store.publish(owner, message.messages, message.removed ?? [], scope);
        if (sent) {
          const memory = greetingMemory(owner);
          rememberGreeting(owner, afterSettled(afterSend(memory), true, memory.history));
        }
        // a typed row stays in the chat as the user's waiting message until its turn is read, as a
        // composer send does (#2258): the turn end's drain and Send now leave no gap between the two.
        // Only a row this connection saw going out: one sent through another, its turn perhaps read
        // already, has no time before its Enter that the turn could settle
        for (const item of typed) {
          const text = rows.find((row) => row.id === item.id)?.text, went = this.going.get(item.id);
          if (text !== undefined && went !== undefined) rememberWaitingSend(key, text, went.at, went.after);
        }
        for (const item of message.removed ?? []) this.going.delete(item.id);
      }
      for (const handler of this.handlers) handler(message, sent);
    });
    this.offDisconnect = this.socket.onDisconnect(() => this.disconnected());
    this.offPresence = watchPageInUse((active) => this.socket.setPresence(active));
  }

  /** a herdr this page proved from an earlier snapshot of this PC, still the one it knows */
  private knownHerdr(lifetime: string | undefined): boolean {
    return lifetime !== undefined && paneLifetimes.generation(this.machineId) === lifetime;
  }

  get scope(): string | null { return this.currentScope; }
  /** the PC's id for this open connection (its features frame or first snapshot), for a create request's `first_message_connection`; null while closed or from an older bridge */
  get connection(): string | null { return this.currentConnection; }
  get epoch(): number { return this.currentEpoch; }

  private disconnected(): void {
    if (this.currentScope !== null) this.store.suspendScope(this.currentScope);
    this.currentScope = null;
    this.announcedLifetime = undefined;
    this.resumedReceipts = [];
    this.going.clear();
    this.currentConnection = null;
    this.currentEpoch++;
    this.role = null;
  }

  on(handler: Handler): () => void {
    if (this.closed) return () => {};
    this.handlers.add(handler);
    // A pane mounted on an existing connection must honor an enforced observe role.
    // Snapshots and terminal bytes are never replayed from a browser-owned cache.
    if (this.role !== null) handler(this.role, false);
    return () => { this.handlers.delete(handler); };
  }

  onDisconnect(handler: () => void): () => void { return this.socket.onDisconnect(handler); }
  connect(): void { if (!this.closed) this.socket.connect(); }

  /** A receipt belongs to the captured connection, whether its pane is still mounted or not. */
  acceptPending(paneId: string, message: PendingMessage, capturedEpoch: number): void {
    const scope = !this.closed && this.socket.connected && this.currentEpoch === capturedEpoch ? this.currentScope : null;
    const owner = paneStorageId(this.machineId, paneId);
    // The live stream may already have advanced this item to held, sending or uncertain
    // before a submit promise consumer runs. Its receipt only fills a missing record.
    if (this.store.isOwned(owner, message.id, scope)) return;
    this.store.accept(owner, message, scope);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnected();
    this.offMessage();
    this.offDisconnect();
    this.offPresence();
    this.handlers.clear();
    this.socket.close();
  }
}

/** Owned by the unlocked app, outside its PC-keyed canvas. Clearing it is reusable for
 * React's effect restart; selecting another PC does not close any existing connection. */
export class MachineSessionRegistry {
  private readonly sessions = new Map<string, MachineSession>();
  constructor(private readonly makeSession: (machineId: string) => MachineSession = (machineId) => new MachineSession(machineId)) {}

  get(machineId: string): MachineSession {
    let session = this.sessions.get(machineId);
    if (!session) { session = this.makeSession(machineId); this.sessions.set(machineId, session); }
    return session;
  }

  /** the PC's open session, if one exists: nothing is made or connected for asking */
  peek(machineId: string): MachineSession | undefined { return this.sessions.get(machineId); }

  retainMachines(machineIds: ReadonlySet<string>): void {
    for (const [machineId, session] of this.sessions) {
      if (machineIds.has(machineId)) continue;
      this.sessions.delete(machineId);
      session.close();
    }
  }

  closeAll(): void {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) session.close();
  }
}
