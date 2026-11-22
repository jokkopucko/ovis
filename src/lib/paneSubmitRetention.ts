export class PaneSubmitRetention {
  private claims = new Map<string, Set<object>>();
  private ids: readonly string[] = [];
  private listeners = new Set<() => void>();
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly snapshot = (): readonly string[] => this.ids;
  has(paneId: string): boolean { return this.claims.has(paneId); }
  private publish(): void {
    this.ids = [...this.claims.keys()];
    for (const listener of this.listeners) listener();
  }
  retain(paneId: string): () => void {
    const claim = {};
    let owners = this.claims.get(paneId);
    if (!owners) { owners = new Set(); this.claims.set(paneId, owners); }
    owners.add(claim);
    this.publish();
    return () => {
      const current = this.claims.get(paneId);
      if (!current?.delete(claim)) return;
      if (current.size === 0) { this.claims.delete(paneId); this.publish(); }
    };
  }
  reconcile(liveIds: ReadonlySet<string>): void {
    let changed = false;
    for (const id of this.claims.keys()) if (!liveIds.has(id)) { this.claims.delete(id); changed = true; }
    if (changed) this.publish();
  }
}
