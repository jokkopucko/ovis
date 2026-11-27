/**
 * Ovis's client of one ACP keeper (crates/acp-keeper): it reads the keeper's numbered log on `<root>/acp.sock` and keeps
 * what Ovis needs of it (the session, the permission requests nobody answered yet, the turn), and sends requests and
 * answers. The keeper is the agent's only ACP client and every client of the keeper sees every row, so this client
 * rebuilds its state from the log alone: a first attach replays it from the start, a reconnect from the row after the
 * last one it read. Its answer to a permission request is one of many a keeper may get: the keeper's `_keeper/resolved`
 * note names the client whose answer went to the agent.
 */
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import { keeperRunning } from "./keeper-process.ts";
import { AcpHistory } from "./history.ts";
import { KeeperRequests } from "./requests.ts";
import { KeeperAnswers, type AnswerOutcome } from "./answers.ts";
import { KeeperQuestions } from "./questions.ts";

import { KeeperDisconnected, approval, parseLine, record, text, type AcpApproval, type AcpTurn, type AnnouncedToolCall, type Message, type Row } from "./messages.ts";

/** the latest tool calls a permission request may refer to; older ones are forgotten */
const TOOL_CALLS_KEPT = 256;

export { KeeperDisconnected, KeeperRequestError } from "./messages.ts";
export type { AcpApproval, AcpOption, AcpTurn } from "./messages.ts";
export type { AnswerOutcome } from "./answers.ts";

export interface KeeperClientOptions {
  questionHarness?: string;
  /** how the socket is opened (default node:net) */
  connect?: (path: string) => Socket;
}

const BACKOFF_MS = [100, 250, 500, 1_000, 2_000, 5_000] as const;


export class KeeperClient {
  readonly history: AcpHistory;
  session: string | null = null;
  holdGeneration: number | null = null;
  sessionError: { code: number; message: string } | null = null;
  turnSequence = 0;
  usage: { tokens?: number; cost?: { amount: number; currency: string } } | null = null;
  model: string | null = null;
  sessionMode: string | null = null;
  allowAll: boolean | null = null;
  /** The keeper logs the opening selection before publishing the session, including on replay. */
  private openedIn: { readonly mode: string | null; readonly allowAll: boolean | null } | null = null;
  get initialPermissions() { return this.openedIn; }
  private opening: unknown;
  turn: AcpTurn | null = null;
  agentGone = false;
  malformedRows = 0;
  private mode: "acp" | "terminal" | "switching" = "acp";

  get terminalReady(): boolean { return this.connected && this.mode === "terminal"; }

  get status(): "working" | "blocked" | "idle" | "done" | "unknown" {
    if (!this.connected || this.agentGone || this.mode !== "acp" || !this.session) return "unknown";
    const question = this.questions.current;
    return this.approvals.size || question && !question.parent ? "blocked" : question || this.turn?.running ? "working" : this.turn?.stopReason ? "done" : "idle";
  }
  /** the keeper ended and no connection could be made again */
  keeperGone = false;
  private lastSeq = 0;
  private client: number | null = null;
  private socket: Socket | null = null;
  private buffer = "";
  private closed = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private readonly approvals = new Map<string, AcpApproval>();
  private readonly toolCalls = new Map<string, AnnouncedToolCall>();
  private readonly answers = new KeeperAnswers();
  readonly questions = new KeeperQuestions(() => this.changed(), (id, result, expectedMode) => {
    if (this.client === null || this.status === "unknown") return Promise.resolve("gone");
    return this.answers.reserve({ id, optionId: null }, send => this.onChange(send), reservation => {
      reservation.by = `client-${this.client}`;
      this.write({ jsonrpc: "2.0", id, result, ...(expectedMode !== undefined ? { expectedMode } : {}) });
    });
  });
  private readonly requests = new KeeperRequests(message => this.write(message));
  /** the keeper's ids of the `session/prompt` requests the agent has not answered yet */
  private readonly prompts = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly waiting = new Set<() => void>();
  private readonly connectTo: (path: string) => Socket;

  constructor(readonly root: string, private readonly options: KeeperClientOptions = {}) {
    this.history = new AcpHistory(root);
    this.connectTo = options.connect ?? ((path) => createConnection(path));
    this.open();
  }

  /** Whether the replay is through and live rows follow. */
  get connected(): boolean {
    return this.client !== null;
  }

  /** Resolves once the log is replayed (the keeper's watermark came); rejects once the client is closed or the keeper is gone. */
  ready(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new KeeperDisconnected());
    if (this.connected) return Promise.resolve();
    if (this.closed || this.keeperGone) return Promise.reject(new KeeperDisconnected());
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const abort = () => { this.waiting.delete(check); reject(new KeeperDisconnected()); };
    const check = () => {
      if (this.connected) resolve();
      else if (this.closed || this.keeperGone) reject(new KeeperDisconnected());
      else return;
      this.waiting.delete(check);
      signal?.removeEventListener("abort", abort);
    };
    this.waiting.add(check);
    signal?.addEventListener("abort", abort, { once: true });
    return promise;
  }

  /** Called after each batch of rows that may have changed the session, the requests or the turn. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** The permission requests nobody answered yet, oldest first. */
  pending(): AcpApproval[] {
    return [...this.approvals.values()].sort((a, b) => a.seq - b.seq);
  }

  /** A request to the agent through the keeper. Rejects on an error answer, and when the connection ends first. */
  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.ready(signal);
    if (!this.connected) throw new KeeperDisconnected();
    return this.requests.request(method, params, signal);
  }

  async submit(text: string, expectedMode?: string): Promise<void> {
    if (!this.session || (this.status !== "idle" && this.status !== "done")) throw new KeeperDisconnected();
    await this.requests.submit(this.session, text, expectedMode);
  }

  async hold(sessionId: string): Promise<number> {
    const generation = record(await this.request("_keeper/hold", { sessionId }))?.generation;
    if (typeof generation !== "number" || !Number.isSafeInteger(generation)) throw new KeeperDisconnected();
    return generation;
  }

  /** A notification to the agent through the keeper (`session/cancel`). Dropped when no connection is up. */
  notify(method: string, params: unknown): void {
    if (this.connected) this.write({ jsonrpc: "2.0", method, params });
  }

  /**
   * Answers the permission request `keeperId` with `optionId`, one of its options. The keeper's note on it decides: this
   * client's answer went to the agent (won), another client's did (lost), or the agent can no longer take one (gone).
   */
  answer(keeperId: string, optionId: string): Promise<AnswerOutcome> {
    if (this.closed || this.keeperGone) return Promise.resolve("gone");
    return this.answers.answer({ id: keeperId, optionId, asked: this.approvals.get(keeperId) }, (send) => this.onChange(send), (asked, reservation) => {
      if (this.client === null) return;
      if (this.approvals.get(keeperId) !== asked) return this.answers.settle(keeperId, "gone");
      reservation.by = `client-${this.client}`;
      this.write({ jsonrpc: "2.0", id: keeperId, result: { outcome: { outcome: "selected", optionId } } });
    });
  }

  /** Ends the connection for good: requests in flight are refused, answers waiting count as gone. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retry !== null) clearTimeout(this.retry);
    // ended, not destroyed: a last notification (a stop's session/cancel) still goes out
    this.socket?.end();
    this.dropped();
    this.answers.close();
    this.questions.clear();
    this.changed();
  }

  private write(message: unknown): void {
    this.socket?.write(`${JSON.stringify(message)}\n`);
  }

  private open(): void {
    const socket = this.connectTo(join(this.root, "acp.sock"));
    this.socket = socket;
    this.buffer = "";
    socket.setEncoding("utf8");
    let connected = false;
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify({ replay: this.lastSeq + 1 })}\n`);
    });
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.dropped();
      if (!this.closed) { this.changed(); this.reconnect(connected); }
    });
  }

  /** The connection ended: this connection's requests get no answer now (the keeper answers the connection that sent them). */
  private dropped(): void {
    this.client = null;
    this.requests.dropped();
  }

  private reconnect(wasConnected: boolean): void {
    if (!wasConnected && !keeperRunning(this.root)) {
      this.keeperGone = true;
      this.approvals.clear();
      this.toolCalls.clear();
      this.questions.clear();
      this.answers.close();
      this.changed();
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.closed) this.open();
    }, delay);
  }

  private receive(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    let changed = false;
    for (let end = this.buffer.indexOf("\n"); end >= 0 && !this.closed; end = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      changed = this.line(line) || changed;
    }
    if (changed) this.changed();
  }

  private changed(): void {
    for (const check of [...this.waiting]) check();
    for (const listener of [...this.listeners]) listener();
  }

  /** One line of the stream: a row, or the watermark. Whether it changed what this client keeps. */
  private line(line: string): boolean {
    const entry = parseLine(line);
    if (!entry) return false;
    if ("client" in entry) {
      this.client = entry.client;
      this.attempt = 0;
      return true;
    }
    if (entry.row.seq <= this.lastSeq) return false;
    this.lastSeq = entry.row.seq;
    const previousStatus = this.status;
    const previousPlan = this.history.plan;
    const previousSession = this.history.session;
    this.history.observe(entry, Buffer.byteLength(line) + 1);
    if (previousSession !== this.history.session) {
      this.approvals.clear();
      this.toolCalls.clear();
      this.questions.clear();
      this.answers.close();
      this.prompts.clear();
      this.turn = null;
    }
    if (entry.message === null) { this.malformedRows++; return false; }
    const changed = this.row(entry.row, entry.message) || this.history.plan !== previousPlan;
    // A short prompt and its stopReason can share one socket read: the queue needs both edges.
    if (this.status !== previousStatus) this.changed();
    return changed;
  }

  private row(row: Row, message: Message): boolean {
    const method = text(message.method);
    const params = record(message.params) ?? {};
    if ((method === "session/update" || method === "session/request_permission" || method === "session/prompt" || method === "elicitation/create")
      && (!this.history.session || params.sessionId !== this.history.session)) return false;
    switch (row.dir) {
      case "to-client":
        if (row.client === this.client && this.client !== null && method === null) this.requests.answered(message);
        return false;
      case "to-agent":
        if (method === "initialize" || method === "session/new" || method === "session/load") {
          this.opening = message.id;
          this.sessionError = null;
        }
        if (method === "session/prompt" && typeof message.id === "string") {
          this.turnSequence = row.seq;
          this.usage = null;
          this.prompts.add(message.id);
          this.turn = { running: true, stopReason: null, text: "", error: null };
          return true;
        }
        return false;
      case "from-agent":
        return this.fromAgent(row, message, method, params);
      case "keeper":
        return this.note(method, params);
      default:
        return false;
    }
  }


  private announce(id: string, update: Record<string, unknown>): void {
    const known = this.toolCalls.get(id);
    this.toolCalls.delete(id);
    this.toolCalls.set(id, { kind: update["kind"] ?? known?.kind ?? null, rawInput: update["rawInput"] ?? known?.rawInput ?? null, content: update["content"] ?? known?.content ?? null });
    if (this.toolCalls.size > TOOL_CALLS_KEPT) this.toolCalls.delete(this.toolCalls.keys().next().value!);
  }

  private fromAgent(row: Row, message: Message, method: string | null, params: Record<string, unknown>): boolean {
    if (method === null && typeof message.id === "string" && message.id === this.opening) {
      this.opening = undefined;
      if (message.error) this.sessionError = { code: typeof message.error.code === "number" ? message.error.code : 0, message: text(message.error.message) ?? "error" };
      this.model = text(record(message.result?.models)?.currentModelId) ?? this.model;
      this.sessionMode = text(record(message.result?.modes)?.currentModeId) ?? this.sessionMode;
      return true;
    }
    if (method === "session/request_permission" && typeof message.id === "string") {
      const id = text(record(params["toolCall"])?.["toolCallId"]);
      this.approvals.set(message.id, approval(row, message.id, params, id === null ? undefined : this.toolCalls.get(id)));
      return true;
    }
    if (method === "elicitation/create" && typeof message.id === "string" && this.options.questionHarness) {
      this.questions.add(this.options.questionHarness, row, message.id, params, this.connected && this.turn?.running === true && this.holdGeneration === null);
      return true;
    }
    if (method === "session/update") {
      const update = record(params["update"]);
      if ((update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") && typeof update.toolCallId === "string") this.announce(update.toolCallId, update);
      if (update?.sessionUpdate === "usage_update" && this.turn?.running) {
        const tokens = update.used;
        const cost = record(update.cost);
        this.usage = { ...(typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens >= 0 ? { tokens } : {}),
          ...(typeof cost?.amount === "number" && Number.isFinite(cost.amount) && cost.amount >= 0 && typeof cost.currency === "string" && /^[A-Z]{3}$/.test(cost.currency) ? { cost: { amount: cost.amount, currency: cost.currency } } : {}) };
        return true;
      }
      if (update?.sessionUpdate === "current_mode_update" && typeof update.currentModeId === "string") {
        this.sessionMode = update.currentModeId;
        return true;
      }
      const chunk = text(record(update?.["content"])?.["text"]);
      if (update?.["sessionUpdate"] !== "agent_message_chunk" || chunk === null || this.turn === null || !this.turn.running) return false;
      this.turn = { ...this.turn, text: this.turn.text + chunk };
      return true;
    }
    if (method !== null || typeof message.id !== "string" || !this.prompts.delete(message.id)) return false;
    const error = record(message.error);
    const stopReason = text(record(message.result)?.["stopReason"]);
    const total = record(message.result?.usage)?.totalTokens;
    if (typeof total === "number" && Number.isSafeInteger(total) && total >= 0) this.usage = { ...this.usage, tokens: total };
    this.turn = { running: this.prompts.size > 0, stopReason, text: this.turn?.text ?? "", error: error === null ? null : text(error["message"]) ?? "error" };
    return true;
  }

  private note(method: string | null, params: Record<string, unknown>): boolean {
    const id = text(params["id"]);
    switch (method) {
      case "_keeper/selections":
        this.model = text(params.model);
        this.sessionMode = text(params.mode);
        this.allowAll = typeof params.allowAll === "boolean" ? params.allowAll : null;
        return true;
      case "_keeper/hold_changed":
        this.holdGeneration = typeof params.generation === "number" ? params.generation : null;
        return true;
      case "_keeper/delivered":
        if (this.client !== null && params.client === this.client) this.requests.delivered(params.id);
        return false;
      case "_keeper/mode":
        this.mode = params.phase !== "ready" ? "switching" : params.mode === "terminal" ? "terminal" : params.mode === "acp" ? "acp" : "switching";
        return true;
      case "_keeper/session": {
        const session = text(params["sessionId"]) || null;
        if (session !== this.session) this.openedIn = session ? { mode: this.sessionMode, allowAll: this.allowAll } : null;
        this.session = session;
        this.agentGone = false;
        return true;
      }
      case "_keeper/ready":
      case "_keeper/agent_exit":
        this.agentGone = method === "_keeper/agent_exit";
        this.prompts.clear();
        if (this.turn?.running) this.turn = { ...this.turn, running: false };
        return true;
      case "_keeper/resolved": {
        if (id === null) return false;
        this.approvals.delete(id);
        this.questions.remove(id);
        this.answers.acknowledge(id, text(params["by"]), text(params["optionId"]));
        return true;
      }
      case "_keeper/dropped":
        if (id !== null) this.answers.dropped(id, text(params["by"]), params["answering"] === true);
        return false;
      case "_keeper/expired":
      case "_keeper/auto_answered":
        if (id === null) return false;
        this.approvals.delete(id);
        this.questions.remove(id);
        this.answers.settle(id, "gone");
        return true;
      default:
        return false;
    }
  }

}
