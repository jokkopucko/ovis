/**
 * A health read that fails is no proof that herdr stopped: the web server may be restarting, the
 * phone may have dropped a request, herdr may be busy for one poll. So one failed read in a row
 * makes the status unknown (the last answer's details stay named), and a second makes it
 * unavailable. Neither changes the PC's capabilities: those are the last answer the PC gave, and
 * only another answer replaces them, so a Windows herdr's `terminal_attach: false` is never
 * forgotten into the attach-capable default by a failed read.
 */

export type HealthFreshness = "pending" | "fresh" | "unknown" | "unavailable";
export type HealthAnswer<T> = { ok: true; value: T } | { ok: false };

export interface MachineHealth<T> {
  readonly confirmed: T | null;
  readonly failures: number;
  readonly answered: number;
  readonly failed: readonly number[];
}

export type HealthBook<T> = ReadonlyMap<string, MachineHealth<T>>;

export const UNAVAILABLE_AFTER = 2;

const NOTHING_YET: MachineHealth<never> = { confirmed: null, failures: 0, answered: 0, failed: [] };

export function machineHealth<T>(book: HealthBook<T>, machineId: string): MachineHealth<T> {
  return book.get(machineId) ?? NOTHING_YET;
}

export function applyHealthRead<T>(book: HealthBook<T>, machineId: string, read: number, answer: HealthAnswer<T>): HealthBook<T> {
  const current = machineHealth(book, machineId);
  if (read <= current.answered) return book;
  const failed = answer.ok
    ? current.failed.filter((failure) => failure > read)
    : [...current.failed, read].sort((a, b) => a - b).slice(-UNAVAILABLE_AFTER);
  const next = new Map(book);
  next.set(machineId, answer.ok
    ? { confirmed: answer.value, failures: failed.length, answered: read, failed }
    : { confirmed: current.confirmed, failures: failed.length, answered: current.answered, failed });
  return next;
}

export function healthFreshness(health: Pick<MachineHealth<unknown>, "confirmed" | "failures">): HealthFreshness {
  if (health.failures === 0) return health.confirmed === null ? "pending" : "fresh";
  return health.failures < UNAVAILABLE_AFTER ? "unknown" : "unavailable";
}
