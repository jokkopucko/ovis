/** The pane owns this gate, so a tools effect restart cannot forget an outstanding native write. */
export class ViewportIntentGate {
  private writes = new Set<Promise<unknown>>();
  private search: object | null = null;
  private cancelPendingScroll: (() => void) | null = null;
  private listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly isSearching = (): boolean => this.search !== null;
  private publish(): void { for (const listener of this.listeners) listener(); }

  registerScrollCancellation(cancel: () => void): () => void {
    this.cancelPendingScroll = cancel;
    return () => { if (this.cancelPendingScroll === cancel) this.cancelPendingScroll = null; };
  }

  scroll<T>(send: () => Promise<T>): Promise<T> | null {
    if (this.search !== null || this.writes.size > 0) return null;
    const request = send();
    this.writes.add(request);
    void request.then(() => this.writes.delete(request), () => this.writes.delete(request));
    return request;
  }

  async beginSearch(): Promise<(() => void) | null> {
    if (this.search !== null) return null;
    const owner = {};
    this.search = owner;
    this.cancelPendingScroll?.();
    this.publish();
    await Promise.allSettled([...this.writes]);
    return () => {
      if (this.search !== owner) return;
      this.search = null;
      this.publish();
    };
  }
}
