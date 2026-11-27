import { createHash, randomUUID } from "node:crypto";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

const READ_INTERVAL_MS = 500;
const FAILED_READS_END = 10;
const READS_AT_ONCE = 4;

export interface PromptReader {
  snapshot(): Promise<SessionSnapshot>;
  read(pane: HerdrPane, panes: HerdrPane[]): Promise<string | null | undefined>;
}

interface WatchedPrompt { shown?: string; signature?: string; failures: number; wakes: number }

/**
 * One read loop for the server's prompt watches (server/core/prompt-watch.ts): every watched pane is read every
 * 500 ms, however many connections watch it, and the watchers are told when what its prompt says changes. A pane
 * herdr reports blocked is read too: a form of several steps moves to its next one while the pane stays blocked, with
 * no pane-status to say so. A working pane is read: Codex asks the questions in its queue while it works. A snapshot
 * herdr does not answer (a restart) skips the tick and ends no watch; only reads of the pane itself count. A pane whose
 * agent says its prompt changed (`wake`) is read at once, without waiting for the next tick.
 */
export class PromptMonitor {
  private readonly panes = new Map<string, WatchedPrompt>();
  private readonly woken = new Set<string>();
  private readonly salt = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private ticking: Promise<void> | null = null;
  private tickingOnly = false;
  private stopped = false;

  constructor(
    private readonly reader: PromptReader,
    private readonly changed: (paneId: string, signature: string) => void,
    private readonly ended: (paneId: string) => void,
    private readonly intervalMs = READ_INTERVAL_MS,
  ) {}

  get size(): number { return this.panes.size; }

  current(paneId: string): string | undefined {
    const state = this.panes.get(paneId);
    return state?.shown === undefined ? undefined : state.signature;
  }

  watch(paneId: string): void {
    if (this.stopped || this.panes.has(paneId)) return;
    this.panes.set(paneId, { failures: 0, wakes: 0 });
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.intervalMs);
      this.timer.unref();
    }
    void this.tick();
  }

  unwatch(paneId: string): void {
    this.panes.delete(paneId);
    if (this.panes.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Reads a watched pane now. A tick under way may have read it before the change, so a wake during one reads the
   * pane again once it ends, and what that older read found is not told; reads of one pane still never run at once.
   * A woken read that fails counts toward no end of the watch: only the ticks', a half second apart, do.
   */
  wake(paneId: string): void {
    const state = this.panes.get(paneId);
    if (!state) return;
    state.wakes += 1;
    this.woken.add(paneId);
    if (!this.ticking) void this.tick(this.takeWoken());
  }

  stop(): void {
    this.stopped = true;
    this.panes.clear();
    this.woken.clear();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One read of every watched pane, never two at once: a slow herdr skips ticks rather than piling reads up. */
  tick(only?: ReadonlySet<string>): Promise<void> {
    // a woken pane's read under way stands for no other pane: the full read it was asked for follows it
    if (this.ticking && !only && this.tickingOnly) return this.ticking.then(() => this.tick());
    if (this.ticking) return this.ticking;
    this.tickingOnly = only !== undefined;
    this.ticking = this.readAll(only).finally(() => {
      this.ticking = null;
      if (this.woken.size > 0) void this.tick(this.takeWoken());
    });
    return this.ticking;
  }

  private takeWoken(): Set<string> {
    const woken = new Set(this.woken);
    this.woken.clear();
    return woken;
  }

  private async readAll(only?: ReadonlySet<string>): Promise<void> {
    const watched = [...this.panes].filter(([paneId]) => !only || only.has(paneId));
    if (watched.length === 0) return;
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.reader.snapshot();
    } catch {
      return;
    }
    const queue = [...watched];
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) await this.readOne(next[0], next[1], snapshot, only === undefined);
    };
    await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, queue.length) }, worker));
  }

  private async readOne(paneId: string, state: WatchedPrompt, snapshot: SessionSnapshot, counted: boolean): Promise<void> {
    if (this.panes.get(paneId) !== state) return;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) {
      this.end(paneId);
      return;
    }
    const wakes = state.wakes;
    let shown: string | null | undefined;
    try {
      shown = await this.reader.read(pane, snapshot.panes);
    } catch {
      if (counted) this.failed(paneId, state);
      return;
    }
    if (this.panes.get(paneId) !== state || state.wakes !== wakes) return;
    state.failures = 0;
    if (shown !== undefined) this.publish(paneId, state, shown ?? "");
  }

  private publish(paneId: string, state: WatchedPrompt, shown: string): void {
    if (shown === state.shown) return;
    state.shown = shown;
    state.signature = createHash("sha256").update(`${this.salt}\0${paneId}\0${shown}`).digest("base64url").slice(0, 22);
    this.changed(paneId, state.signature);
  }

  private failed(paneId: string, state: WatchedPrompt): void {
    if (this.panes.get(paneId) !== state) return;
    state.failures += 1;
    if (state.failures >= FAILED_READS_END) this.end(paneId);
  }

  private end(paneId: string): void {
    this.unwatch(paneId);
    this.ended(paneId);
  }
}
