export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface OffThreadRequest<Q> { id: number; request: Q }
export interface OffThreadAnswer<R> { id: number; result: R | null }

export interface OffThreadJob<R> {
  promise: Promise<R | null>;
  cancel(): boolean;
}

interface Entry<Q, R> {
  id: number;
  request: Q;
  transfer: Transferable[];
  resolve: (result: R | null) => void;
}

/**
 * A job gets `budgetMs` from its start: past it the worker is ended (a tokenizer stuck in a quadratic
 * input cannot be interrupted any other way), the job gives `null`, and the next job starts a new
 * worker.
 */
export function createOffThreadQueue<Q, R>(spawn: () => WorkerLike, budgetMs: number): (request: Q, transfer?: Transferable[]) => OffThreadJob<R> {
  let worker: WorkerLike | null = null;
  let running: (Entry<Q, R> & { timer: ReturnType<typeof setTimeout> }) | null = null;
  const waiting: Entry<Q, R>[] = [];
  let nextId = 1;

  const finish = (result: R | null, stop: boolean): void => {
    if (running === null) return;
    clearTimeout(running.timer);
    const { resolve } = running;
    running = null;
    if (stop && worker !== null) {
      worker.terminate();
      worker = null;
    }
    resolve(result);
    pump();
  };

  const pump = (): void => {
    if (running !== null) return;
    const next = waiting.shift();
    if (next === undefined) return;
    if (worker === null) {
      try {
        worker = spawn();
      } catch {
        next.resolve(null);
        pump();
        return;
      }
      worker.onmessage = (event: MessageEvent) => {
        const answer = event.data as OffThreadAnswer<R>;
        if (running !== null && answer.id === running.id) finish(answer.result, false);
      };
      worker.onerror = () => finish(null, true);
    }
    running = { ...next, timer: setTimeout(() => finish(null, true), budgetMs) };
    worker.postMessage({ id: next.id, request: next.request } satisfies OffThreadRequest<Q>, next.transfer);
  };

  return (request, transfer = []) => {
    let entry!: Entry<Q, R>;
    const promise = new Promise<R | null>((resolve) => {
      entry = { id: nextId++, request, transfer, resolve };
    });
    waiting.push(entry);
    pump();
    return {
      promise,
      cancel: () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return false;
        waiting.splice(index, 1);
        entry.resolve(null);
        return true;
      },
    };
  };
}

export function serveOffThread<Q, R>(handle: (request: Q) => { result: R; transfer?: Transferable[] }): void {
  const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: unknown, transfer?: Transferable[]) => void };
  scope.onmessage = (event: MessageEvent) => {
    const { id, request } = event.data as OffThreadRequest<Q>;
    let answer: { result: R | null; transfer?: Transferable[] };
    try {
      answer = handle(request);
    } catch {
      answer = { result: null };
    }
    scope.postMessage({ id, result: answer.result } satisfies OffThreadAnswer<R>, answer.transfer ?? []);
  };
}
