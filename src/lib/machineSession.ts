import type { PendingMessage, ServerMessage } from "../../shared/protocol.ts";
import { paneStorageId } from "../../shared/machines.ts";
import { afterSend, afterSettled, greetingMemory, rememberGreeting } from "./greeting.ts";
import { paneLifetimes } from "./paneLifetime.ts";
import { setPasteFolder } from "./pasteFolders.ts";
import { frameRemovals, pendingMessages, type PendingMessageStore, type Removal } from "./pendingMessages.ts";
import { rememberWaitingSend, stampedBaseline, waitingBaseline, waitingKey, type WaitingBaseline } from "./sentWaiting.ts";
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
  private offset: number | undefined;
  private noteClock(serverTime: unknown): void {
    if (typeof serverTime !== "number" || !Number.isFinite(serverTime)) return;
    const seen = Date.now() - serverTime;
    this.offset = this.offset === undefined ? seen : Math.min(this.offset, seen);
  }
  private resumedReceipts: Array<{ paneId: string; lifetime: string; removal: Removal }> = [];
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
    this.offMessage = this.socket.on((message) => {
      if (this.closed) return;
      if (message.type === "features") {
        this.announcedLifetime = message.herdr_lifetime; setPasteFolder(this.machineId, message.paste_dir);
        this.offset = undefined;
        this.noteClock(message.server_time);
      }
      if (message.type === "pending-messages") this.noteClock(message.server_time);
      if (message.type === "snapshot") paneLifetimes.observe([{ id: this.machineId, snapshot: message.snapshot }]);
      const told = message.type === "snapshot" || (message.type === "features" && this.knownHerdr(message.herdr_lifetime));
      if (told && this.currentScope === null) this.currentScope = `${this.identity}:${this.currentEpoch}`;
      if (told && message.connection !== undefined) this.currentConnection = message.connection;
      if (message.type === "pending-messages" && this.currentScope === null && this.announcedLifetime !== undefined) {
        for (const removal of frameRemovals(message, this.offset)) if (removal.resumed === true) {
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
        for (const item of message.messages) {
          if (item.state === "sending" && !this.going.has(item.id)) {
            // that frame can come after the row's Enter (replayed after a reconnect, or handled late): the
            // PC's clock now would bound it too tightly, but the PC stamped the row before typing it, which
            // bounds it though the chat never read the pane. An older bridge does not: only the turns' times do then
            const after = waitingBaseline(key);
            this.going.set(item.id, { at: Date.now(), after: stampedBaseline(after !== null ? { ...after, pcFloor: null } : null, item.sending_at) });
          }
          else if (item.state === "queued" || item.state === "held") this.going.delete(item.id);
        }
        const typed = message.removed?.filter((item) => item.outcome === "sent" && this.store.isOwned(owner, item.id, scope)) ?? [];
        sent = typed.length > 0;
        const rows = this.store.read(owner);
        this.store.publish(owner, message.messages, frameRemovals(message, this.offset), scope);
        if (sent) {
          const memory = greetingMemory(owner);
          rememberGreeting(owner, afterSettled(afterSend(memory), true, memory.history));
        }
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

  private knownHerdr(lifetime: string | undefined): boolean {
    return lifetime !== undefined && paneLifetimes.generation(this.machineId) === lifetime;
  }

  get scope(): string | null { return this.currentScope; }
  get connection(): string | null { return this.currentConnection; }
  get epoch(): number { return this.currentEpoch; }

  private disconnected(): void {
    if (this.currentScope !== null) this.store.suspendScope(this.currentScope);
    this.currentScope = null;
    this.announcedLifetime = undefined;
    setPasteFolder(this.machineId, undefined);
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

  acceptPending(paneId: string, message: PendingMessage, capturedEpoch: number, replayed = false): void {
    const scope = !replayed && !this.closed && this.socket.connected && this.currentEpoch === capturedEpoch ? this.currentScope : null;
    const owner = paneStorageId(this.machineId, paneId);
    if (replayed && this.store.read(owner).some((row) => row.id === message.id)) return;
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

export class MachineSessionRegistry {
  private readonly sessions = new Map<string, MachineSession>();
  constructor(private readonly makeSession: (machineId: string) => MachineSession = (machineId) => new MachineSession(machineId)) {}

  get(machineId: string): MachineSession {
    let session = this.sessions.get(machineId);
    if (!session) { session = this.makeSession(machineId); this.sessions.set(machineId, session); }
    return session;
  }

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
