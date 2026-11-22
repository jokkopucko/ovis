/**
 * A `get` nobody follows with a `hold` (a render React threw away) arms the same idle disposal, so
 * it cannot leak.
 */

export interface IdleLeaseTimers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface IdleLease<T> {
  get: () => T;
  hold: () => () => void;
  current: () => T | undefined;
}

const DEFAULT_TIMERS: IdleLeaseTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Entry<T> { value: T; holders: number; idle: unknown }

export function createIdleLease<T>(
  create: () => T,
  dispose: (value: T) => void,
  idleMs: number,
  timers: IdleLeaseTimers = DEFAULT_TIMERS,
): IdleLease<T> {
  let entry: Entry<T> | undefined;

  const armIdle = (held: Entry<T>): void => {
    if (held.idle !== undefined) timers.clear(held.idle);
    held.idle = timers.set(() => {
      held.idle = undefined;
      if (held.holders > 0) return;
      if (entry === held) entry = undefined;
      dispose(held.value);
    }, idleMs);
  };

  const ensure = (): Entry<T> => {
    if (entry !== undefined) return entry;
    const made: Entry<T> = { value: create(), holders: 0, idle: undefined };
    entry = made;
    armIdle(made);
    return made;
  };

  return {
    get: () => ensure().value,
    hold() {
      const held = ensure();
      if (held.idle !== undefined) { timers.clear(held.idle); held.idle = undefined; }
      held.holders += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.holders -= 1;
        if (held.holders === 0) armIdle(held);
      };
    },
    current: () => entry?.value,
  };
}
