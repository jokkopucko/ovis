/**
 * Reads of one thing where only the one asked for last may apply (a creation dialog's agent list: the
 * read as it opens, and the one after Add another agent… installed one). Each read takes a ticket;
 * the ticket says whether no later read was asked for since.
 */
export function latestRead(): () => () => boolean {
  let last = 0;
  return () => {
    const mine = ++last;
    return () => last === mine;
  };
}

/** After an install: read again every 10 s, seven reads in all: about a minute, at most 70 s when every read stalls. */
export const READ_AGAIN_MS = 10_000;
export const READ_AGAIN_TIMES = 7;

/** What one read came to, as the helper accepted it: its answer, its failure, or no answer by its deadline. */
export type ReadOutcome<T> = { kind: "answer"; value: T } | { kind: "failed"; reason: unknown } | { kind: "timeout" };

/**
 * Reads at once, then again `every` ms after each read started, up to `times` reads (a PC may list an agent only once
 * its installer has finished with the shell profile). Each read's outcome is accepted once: its
 * answer, its failure, or a timeout when it has not answered within `every` ms; whatever it says
 * after that is ignored. `apply` gets each accepted outcome, `last` when no read follows, and returns
 * true to end it. `later` runs one after `every` ms and returns its cancel; the returned function stops it.
 */
export function readAgainUntil<T>(read: () => Promise<T>, options: { every: number; times: number; later: (run: () => void, ms: number) => () => void; apply: (outcome: ReadOutcome<T>, last: boolean) => boolean; now?: () => number }): () => void {
  let left = options.times;
  let stopped = false;
  let cancel: () => void = () => undefined;
  let cancelDeadline: () => void = () => undefined;
  const now = options.now ?? Date.now;
  const once = (): void => {
    left -= 1;
    const last = left <= 0;
    const started = now();
    let settled = false;
    const settle = (outcome: ReadOutcome<T>): void => {
      if (settled || stopped) return;
      settled = true;
      cancelDeadline();
      if (options.apply(outcome, last) || last) return;
      // the next read starts `every` after this one started, whenever it answered (a timeout: now), so
      // the reads end within times × every however slow they are
      const wait = Math.max(0, started + options.every - now());
      if (wait === 0) once();
      else cancel = options.later(once, wait);
    };
    cancelDeadline = options.later(() => settle({ kind: "timeout" }), options.every);
    read().then((value) => settle({ kind: "answer", value }), (reason: unknown) => settle({ kind: "failed", reason }));
  };
  once();
  return () => { stopped = true; cancel(); cancelDeadline(); };
}
