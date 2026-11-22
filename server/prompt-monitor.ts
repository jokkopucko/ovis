import { createHash, randomUUID } from "node:crypto";
import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";

const READ_INTERVAL_MS = 500;
const FAILED_READS_END = 10;
const READS_AT_ONCE = 4;

export interface PromptReader {
  snapshot(): Promise<SessionSnapshot>;
  read(pane: HerdrPane, panes: HerdrPane[]): Promise<string | null | undefined>;
}

interface WatchedPrompt { shown?: string; signature?: string; failures: number }

/**
 * One read loop for the server's prompt watches (server/core/prompt-watch.ts): every watched pane is read every
 * 500 ms, however many connections watch it, and the watchers are told when what its prompt says changes. A pane
 * herdr reports blocked is read too: a form of several steps moves to its next one while the pane stays blocked, with
 * no pane-status to say so. A working pane is read: Codex asks the questions in its queue while it works. A snapshot
 * herdr does not answer (a restart) skips the tick and ends no watch; only reads of the pane itself count.
 */
export class PromptMonitor {
  private readonly panes = new Map<string, WatchedPrompt>();
  private readonly salt = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private ticking: Promise<void> | null = null;
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
    this.panes.set(paneId, { failures: 0 });
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

  stop(): void {
    this.stopped = true;
    this.panes.clear();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One read of every watched pane, never two at once: a slow herdr skips ticks rather than piling reads up. */
  tick(): Promise<void> {
    this.ticking ??= this.readAll().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async readAll(): Promise<void> {
    const watched = [...this.panes];
    if (watched.length === 0) return;
    let snapshot: SessionSnapshot;
    try {
      snapshot = await this.reader.snapshot();
    } catch {
      return;
    }
    const queue = [...watched];
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) await this.readOne(next[0], next[1], snapshot);
    };
    await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, queue.length) }, worker));
  }

  private async readOne(paneId: string, state: WatchedPrompt, snapshot: SessionSnapshot): Promise<void> {
    if (this.panes.get(paneId) !== state) return;
    const pane = snapshot.panes.find((candidate) => candidate.pane_id === paneId);
    if (!pane) {
      this.end(paneId);
      return;
    }
    let shown: string | null | undefined;
    try {
      shown = await this.reader.read(pane, snapshot.panes);
    } catch {
      this.failed(paneId, state);
      return;
    }
    if (this.panes.get(paneId) !== state) return;
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
