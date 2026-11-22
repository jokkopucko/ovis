import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { ConversationNotStarted, ConversationUnavailable, paneTranscript, type NativeTranscript } from "./conversation.ts";
import { agyDatabasePath } from "./agy.ts";
import { sessionSnapshot } from "./herdr/client.ts";

const STAT_INTERVAL_MS = 250;
const RESOLVE_INTERVAL_MS = 5000;
const MISSING_RESOLVE_INTERVAL_MS = 2000;

interface WatchedConversation {
  transcript: NativeTranscript | null;
  observed?: string;
  nextResolve: number;
  resolving: boolean;
}

function fileIdentity(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { return "missing"; }
}

export class ConversationMonitor {
  private readonly panes = new Map<string, WatchedConversation>();
  private readonly salt = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private snapshot: Promise<SessionSnapshot> | null = null;
  private stopped = false;

  constructor(
    private readonly changed: (paneId: string, signature: string) => void,
    private readonly codexHome?: string,
    private readonly devinDbPath?: string,
    private readonly opencodeDb?: string,
    private readonly hermesHome?: string,
    private readonly grokHome?: string,
    private readonly museData?: string,
  ) {}

  get size(): number { return this.panes.size; }

  watch(paneId: string): void {
    if (this.stopped || this.panes.has(paneId)) return;
    this.panes.set(paneId, { transcript: null, nextResolve: 0, resolving: false });
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), STAT_INTERVAL_MS);
      this.timer.unref();
    }
    this.poll();
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

  private publish(paneId: string, state: WatchedConversation, observed: string): void {
    if (this.panes.get(paneId) !== state || observed === state.observed) return;
    state.observed = observed;
    const signature = createHash("sha256").update(`${this.salt}\0${paneId}\0${observed}`).digest("base64url").slice(0, 22);
    this.changed(paneId, signature);
  }

  private read(paneId: string, state: WatchedConversation): boolean {
    const transcript = state.transcript;
    if (!transcript) return false;
    const identity = fileIdentity(transcript.path);
    const database = transcript.source === "devin-transcript" || transcript.source === "opencode-transcript" || transcript.source === "hermes-transcript";
    const wal = database ? fileIdentity(`${transcript.path}-wal`) : "";
    const session = transcript.source === "hermes-transcript" ? transcript.sessionId : database ? transcript.session : "";
    const cwd = transcript.source === "devin-transcript" ? transcript.cwd : "";
    const catalog = transcript.source === "agy-transcript" ? agyDatabasePath(transcript.path) : null;
    const catalogIdentity = catalog === null ? "" : `${fileIdentity(catalog)}:${fileIdentity(`${catalog}-wal`)}`;
    const observed = `${transcript.source}\0${transcript.path}\0${session}\0${cwd}\0${identity}\0${wal}\0${catalogIdentity}`;
    if (identity === "missing" && observed !== state.observed) state.nextResolve = 0;
    this.publish(paneId, state, observed);
    return identity !== "missing";
  }

  private poll(): void {
    const now = Date.now();
    for (const [paneId, state] of this.panes) {
      this.read(paneId, state);
      if (!state.resolving && state.nextResolve <= now) void this.resolve(paneId, state);
    }
  }

  private async resolve(paneId: string, state: WatchedConversation): Promise<void> {
    state.resolving = true;
    let present = false;
    try {
      this.snapshot ??= sessionSnapshot().finally(() => { this.snapshot = null; });
      const snapshot = await this.snapshot;
      if (this.panes.get(paneId) !== state) return;
      const transcript = await paneTranscript(paneId, this.codexHome, snapshot, this.devinDbPath, this.opencodeDb, this.hermesHome, this.grokHome, this.museData);
      if (this.panes.get(paneId) !== state) return;
      state.transcript = transcript;
      present = this.read(paneId, state);
    } catch (error) {
      if (this.panes.get(paneId) !== state) return;
      if (error instanceof ConversationUnavailable) {
        state.transcript = null;
        const pending = error instanceof ConversationNotStarted ? `:${error.sessionId}` : "";
        this.publish(paneId, state, `unavailable:${error.message}${pending}`);
      } else {
        // A transient herdr failure must not replace a known native file with scrollback.
        present = state.transcript !== null;
      }
    } finally {
      state.resolving = false;
      state.nextResolve = Date.now() + (present ? RESOLVE_INTERVAL_MS : MISSING_RESOLVE_INTERVAL_MS);
    }
  }
}
