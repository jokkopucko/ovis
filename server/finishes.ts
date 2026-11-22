import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { AgentStatus, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import type { CompletionTracker } from "./completion.ts";
import { herdrSocketPath } from "./herdr/client.ts";
import { isNamedPipe, pipeIdentity } from "./herdr-core/pipe.ts";

/**
 * The same socket identity evidence as CompletionTracker; include creation time against inode
 * reuse. Windows replaces the pid:start marker's contents, not necessarily its file identity.
 * An unreadable file is not proof of a restart. herdr-core's adapter on Windows is a named pipe with
 * no file behind it, and reading one connects to the adapter and waits for an answer it never
 * sends, blocking the server: pipeIdentity stands instead.
 */
export function finishHerdrIdentity(path = herdrSocketPath(), platform = process.platform): string | null {
  try {
    if (platform === "win32" && isNamedPipe(path)) return pipeIdentity(path);
    if (platform === "win32") return readFileSync(path, "utf8").trim() || null;
    const stat = statSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  } catch { return null; }
}

/**
 * A snapshot's `herdr_lifetime`: a digest of the identity above, so a browser can tell a herdr that
 * replaced the last one (and gives its pane IDs out again) without learning the socket's inode or a
 * Windows pid. Unlike the finish epoch it is the same for every server that reads the same herdr.
 */
export function herdrLifetime(identity: string): string {
  return createHash("sha256").update(`herdr-lifetime:${identity}`).digest("hex").slice(0, 32);
}

export class Finishes {
  private generation = crypto.randomUUID();
  private identity: string | null;
  private readonly panes = new Map<string, { status: AgentStatus; id: number }>();
  private readonly movedTo = new Map<string, string>();

  constructor(private readonly herdr: () => string | null = finishHerdrIdentity) {
    this.identity = herdr();
  }

  herdrIdentity(): string | null { return this.herdr(); }

  get epoch(): string {
    const identity = this.herdr();
    if (identity !== null) {
      if (this.identity !== null && identity !== this.identity) {
        this.generation = crypto.randomUUID();
        this.panes.clear();
      }
      this.identity = identity;
    }
    return this.generation;
  }

  status(paneId: string, status: AgentStatus): { finish_epoch: string; finish_id: number } {
    const finish_epoch = this.epoch;
    return { finish_epoch, finish_id: this.observe(paneId, status) };
  }

  private observe(paneId: string, status: AgentStatus): number {
    for (const [from, to] of this.movedTo) if (to === paneId) this.movedTo.delete(from);
    const moved = this.movedTo.get(paneId);
    const target = moved === undefined ? undefined : this.panes.get(moved);
    if (moved !== undefined && target !== undefined && status !== "done") this.panes.set(moved, { ...target, status });
    const before = this.panes.get(paneId);
    const finish_id = (before?.id ?? 0) + (status === "done" && before?.status !== "done" ? 1 : 0);
    this.panes.set(paneId, { status, id: finish_id });
    return finish_id;
  }

  snapshot(snapshot: SessionSnapshot, completions: CompletionTracker): SessionSnapshot {
    const finish_epoch = this.epoch;
    const live = new Set(snapshot.panes.map((pane) => pane.pane_id));
    for (const paneId of this.panes.keys()) {
      if (!live.has(paneId) && completions.current(paneId) === undefined) this.ended(paneId);
    }
    return { ...snapshot, finish_epoch, panes: snapshot.panes.map((pane) => ({
      ...pane, finish_id: this.observe(pane.pane_id, pane.agent_status),
    })) };
  }

  resync(completions: CompletionTracker, panes: readonly HerdrPane[], newer: ReadonlySet<string>): void {
    completions.resync(panes, newer);
    for (const pane of panes) if (!newer.has(pane.pane_id)) {
      this.status(pane.pane_id, completions.current(pane.pane_id) ?? pane.agent_status);
    }
  }

  /**
   * herdr moved the pane under a new ID: its finishes go on counting there, so a finish a browser read
   * under the old ID keeps its number and stays read (#1503).
   */
  moved(from: string, to: string): (id: number) => number {
    const before = this.panes.get(from);
    if (!before || from === to) return (id) => id;
    const after = this.panes.get(to);
    this.ended(from);
    for (const [earlier, next] of this.movedTo) if (next === from) this.movedTo.set(earlier, to);
    this.movedTo.set(from, to);
    if (after === undefined || after.id < before.id) {
      this.panes.set(to, { ...before });
      return (id) => id;
    }
    // herdr reused the new ID within this epoch: its count goes on above every finish read there before, and
    // the moved pane's latest finish takes the next number; a read of it is a read of that number
    const latest = after.id + 1;
    this.panes.set(to, { status: before.status, id: latest });
    return (id) => id >= before.id ? latest : id;
  }

  /** Keep the counter if herdr reuses an ended pane's ID within this epoch. */
  ended(paneId: string): void {
    const before = this.panes.get(paneId);
    if (before) this.panes.set(paneId, { ...before, status: "unknown" });
  }
}
