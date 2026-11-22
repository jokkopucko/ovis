const BACKSTOP_MS = 10_000;

/** Pushes start newest-page reads at least 1s apart: a streaming answer moves every second, and
 * a bridge's transcript reads stay bounded while an agent writes continuously. */
const INVALIDATION_MS = 1000;

const POLL_MS = 2000;

export class ConversationRefresh {
  private read: ((signal: AbortSignal) => Promise<void>) | null = null;
  private scope: AbortController | null = null;
  private pending = false;
  private invalidated = false;
  private running = false;
  private current: AbortController | null = null;
  private timer: number | undefined;
  private newestAt = -Infinity;
  private pushes = false;
  private waiting = false;
  private readonly pages: (() => Promise<void>)[] = [];
  private readonly waiters: (() => void)[] = [];

  setRead(read: (signal: AbortSignal) => Promise<void>): void {
    this.scope?.abort();
    this.scope = new AbortController();
    this.clearTimer();
    this.pending = false;
    this.invalidated = false;
    this.newestAt = -Infinity;
    this.read = read;
    for (const done of this.waiters.splice(0)) done();
  }

  setPushes(available: boolean): void {
    if (this.pushes === available) return;
    this.pushes = available;
    if (this.read !== null && !this.running && !this.invalidated && this.timer !== undefined) {
      this.clearTimer();
      this.timer = window.setTimeout(() => this.refresh(), this.backstop());
    }
  }

  setWaiting(waiting: boolean): void {
    if (this.waiting === waiting) return;
    this.waiting = waiting;
    if (this.read === null || this.running || this.invalidated) return;
    this.clearTimer();
    if (!waiting) this.timer = window.setTimeout(() => this.refresh(), this.backstop());
  }

  get reading(): boolean {
    return this.running;
  }

  refresh(): void {
    if (this.read === null) return;
    this.clearTimer();
    this.pending = true;
    this.invalidated = false;
    void this.drain();
  }

  refreshed(): Promise<void> {
    if (this.read === null) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push(resolve);
    this.refresh();
    return promise;
  }

  /**
   * The connection came back. A newest read sent before it may wait on a connection that died
   * silently until its deadline, holding every push behind it: it is given up and the pane read now.
   */
  restart(): void {
    if (this.read === null) return;
    this.current?.abort(new DOMException("The read was replaced after a reconnect.", "AbortError"));
    this.refresh();
  }

  invalidate(): void {
    if (this.read === null || this.invalidated) return;
    this.invalidated = true;
    this.clearTimer();
    void this.drain();
  }

  page<T>(read: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const signal = this.scope?.signal;
    this.pages.push(async () => {
      try {
        if (signal === undefined || signal.aborted) throw signal?.reason ?? new DOMException("The read was cancelled.", "AbortError");
        resolve(await read(signal));
      }
      catch (cause) { reject(cause); }
    });
    this.clearTimer();
    void this.drain();
    return promise;
  }

  stop(): void {
    this.read = null;
    this.pending = false;
    this.invalidated = false;
    this.clearTimer();
    this.scope?.abort();
    this.scope = null;
    for (const done of this.waiters.splice(0)) done();
  }

  private backstop(): number {
    return this.pushes ? BACKSTOP_MS : POLL_MS;
  }

  private clearTimer(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const page = this.pages.shift();
        if (page !== undefined) {
          void page();
          continue;
        }
        if (this.read === null || (!this.pending && !this.invalidated)) break;
        if (!this.pending && performance.now() < this.newestAt + INVALIDATION_MS) break;
        this.pending = false;
        this.invalidated = false;
        this.newestAt = performance.now();
        const scope = this.scope!.signal;
        const current = new AbortController();
        const end = (): void => current.abort(scope.reason);
        scope.addEventListener("abort", end, { once: true });
        this.current = current;
        const waiters = this.waiters.splice(0);
        try { await this.read(current.signal); }
        finally {
          scope.removeEventListener("abort", end);
          if (this.current === current) this.current = null;
          if (current.signal.aborted && !scope.aborted) this.waiters.unshift(...waiters);
          else for (const done of waiters) done();
        }
      }
    } finally {
      this.running = false;
      if (this.read !== null) {
        this.timer = this.invalidated
          ? window.setTimeout(() => {
            this.timer = undefined;
            void this.drain();
          }, Math.max(0, this.newestAt + INVALIDATION_MS - performance.now()))
          : this.waiting ? undefined : window.setTimeout(() => this.refresh(), this.backstop());
      }
    }
  }
}
