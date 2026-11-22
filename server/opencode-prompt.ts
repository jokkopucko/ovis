import type { HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
import { sessionSnapshot } from "./herdr/client.ts";
import { opencodeSessionId } from "./opencode.ts";
import type { OpenCodePromptEntry } from "./dialogs/shared.ts";

export class OpenCodePromptState {
  readonly entries = new Map<string, OpenCodePromptEntry>();
  private snapshotIssued = 0;
  private snapshotApplied = 0;
  private latestSnapshot: SessionSnapshot | null = null;
  constructor(readonly now: () => number = Date.now) {}

  checkpoint(): Map<string, { entry: OpenCodePromptEntry; revision: number }> {
    return new Map([...this.entries].map(([id, entry]) => [id, { entry, revision: entry.revision }]));
  }

  async snapshot(timeoutMs?: number): Promise<SessionSnapshot> {
    const issued = ++this.snapshotIssued;
    const snapshot = await sessionSnapshot(undefined, timeoutMs);
    if (issued > this.snapshotApplied) {
      this.snapshotApplied = issued;
      this.latestSnapshot = snapshot;
    }
    if (!this.latestSnapshot || issued === this.snapshotApplied) return snapshot;
    const nativeIds = new Set([...snapshot.panes, ...this.latestSnapshot.panes]
      .filter((pane) => pane.agent === "opencode").map((pane) => pane.pane_id));
    return { ...snapshot, panes: [
      ...snapshot.panes.filter((pane) => !nativeIds.has(pane.pane_id)),
      ...this.latestSnapshot.panes.filter((pane) => nativeIds.has(pane.pane_id)),
    ] };
  }

  prune(): void {
    for (const [id, entry] of this.entries) if (this.now() - entry.updatedAt >= 30 * 60_000) this.entries.delete(id);
  }

  reconcile(panes: readonly HerdrPane[], before = this.checkpoint()): void {
    this.prune();
    for (const [id, entry] of this.entries) {
      const observed = before.get(id);
      if (observed?.entry !== entry || observed.revision !== entry.revision) continue;
      const pane = panes.find((pane) => pane.pane_id === id);
      if (!pane || opencodeSessionId(pane) !== entry.sessionID || pane.agent !== "opencode") this.entries.delete(id);
    }
  }

  begin(paneId: string, sessionID: string): OpenCodePromptEntry {
    this.prune();
    let entry = this.entries.get(paneId);
    if (!entry || entry.sessionID !== sessionID) {
      entry = { sessionID, form: null, listed: null, available: false, revision: 0, issued: 0, applied: 0, updatedAt: this.now() };
      this.entries.delete(paneId);
      this.entries.set(paneId, entry);
      if (this.entries.size > 64) this.entries.delete(this.entries.keys().next().value!);
    }
    return entry;
  }

  forget(paneId: string): void { this.entries.delete(paneId); }
  clear(): void { this.entries.clear(); }
}
