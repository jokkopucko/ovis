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

export type ReadOutcome<T> = { kind: "answer"; value: T } | { kind: "failed"; reason: unknown } | { kind: "timeout" };

/**
 * Reads at once, then again `every` ms after each read started, up to `times` reads (a PC may list an agent only once
 * its installer has finished with the shell profile).
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
