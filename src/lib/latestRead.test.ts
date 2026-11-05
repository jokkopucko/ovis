import { describe, expect, it } from "bun:test";
import { latestRead, READ_AGAIN_MS, READ_AGAIN_TIMES, readAgainUntil, type ReadOutcome } from "./latestRead.ts";

// A creation dialog reads the PC's agents when it opens and again after Add another agent… installs
// one: whichever answer comes last, only the read asked for last may set the list.
describe("latestRead", () => {
  it("lets only the read asked for last apply, whatever order the answers come in", () => {
    const reads = latestRead();
    const opening = reads();
    const afterInstall = reads();
    expect(afterInstall()).toBe(true);
    expect(opening()).toBe(false);
  });

  it("lets a read apply while no later one was asked for", () => {
    const reads = latestRead();
    const only = reads();
    expect(only()).toBe(true);
    expect(only()).toBe(true);
  });
});

// After Add another agent… installs one, the PC may list it only once its installer has finished
// with the shell profile: the dialog reads again for a while, not just once.
describe("readAgainUntil", () => {
  /** a `later` whose runs the test fires itself; each entry says when it is cancelled */
  function laterQueue() {
    const all: { run: () => void; at: number; cancelled: boolean; gone: ReturnType<typeof Promise.withResolvers<void>> }[] = [];
    const queued: typeof all = [];
    let wake = Promise.withResolvers<void>();
    // a virtual clock: firing a run moves it to the time that run was scheduled for
    let clock = 0;
    return {
      now: () => clock,
      later: (run: () => void, ms: number) => {
        const entry = { run, at: clock + ms, cancelled: false, gone: Promise.withResolvers<void>() };
        all.push(entry);
        queued.push(entry);
        wake.resolve();
        return () => { entry.cancelled = true; entry.gone.resolve(); };
      },
      /** waits for the next run still wanted to be scheduled, then fires it */
      next: async () => {
        for (;;) {
          const entry = queued.shift();
          if (entry === undefined) { await wake.promise; wake = Promise.withResolvers<void>(); continue; }
          if (!entry.cancelled) { clock = Math.max(clock, entry.at); entry.run(); return; }
        }
      },
      /** the last run scheduled: a read's deadline, cancelled once that read's answer is taken */
      last: () => all[all.length - 1]!,
      pending: () => queued.filter((entry) => !entry.cancelled).length,
    };
  }

  type Seen = { kind: string; value?: unknown; last: boolean };
  /** records each outcome the helper accepts; `found` ends it on an answer it says yes to */
  const recorder = (found: (value: unknown) => boolean) => {
    const seen: Seen[] = [];
    let wake = Promise.withResolvers<void>();
    return {
      seen,
      apply: (outcome: ReadOutcome<unknown>, last: boolean): boolean => {
        seen.push({ kind: outcome.kind, ...(outcome.kind === "answer" ? { value: outcome.value } : {}), last });
        wake.resolve();
        return outcome.kind === "answer" && found(outcome.value);
      },
      /** waits until `n` outcomes were accepted */
      until: async (n: number) => { while (seen.length < n) { await wake.promise; wake = Promise.withResolvers<void>(); } },
    };
  };

  it("reads again every `every` ms until an answer ends it, and stops there", async () => {
    const q = laterQueue();
    const r = recorder((value) => value === 3);
    let reads = 0;
    readAgainUntil(async () => { reads += 1; return reads; }, { every: 10_000, times: 6, later: q.later, now: q.now, apply: r.apply });
    await r.until(1);
    await q.next();
    await r.until(2);
    await q.next();
    await r.until(3);
    expect(r.seen.map((outcome) => outcome.value)).toEqual([1, 2, 3]);
    expect(q.pending()).toBe(0);
  });

  it("tells the last outcome it is the last, and schedules nothing once stopped", async () => {
    const q = laterQueue();
    const r = recorder(() => false);
    readAgainUntil(async () => "missing", { every: 10_000, times: 3, later: q.later, now: q.now, apply: r.apply });
    await r.until(1);
    await q.next();
    await r.until(2);
    await q.next();
    await r.until(3);
    expect(r.seen.map((outcome) => outcome.last)).toEqual([false, false, true]);
    expect(q.pending()).toBe(0);
    const stopped = laterQueue();
    let more = 0;
    const stop = readAgainUntil(async () => { more += 1; return null; }, { every: 10_000, times: 5, later: stopped.later, now: stopped.now, apply: () => false });
    stop();
    expect(more).toBe(1);
    expect(stopped.pending()).toBe(0);
  });

  it("takes a read that does not answer by its deadline as a timeout, the last one too, and ignores its late answer", async () => {
    const q = laterQueue();
    const r = recorder(() => true);
    const late = Promise.withResolvers<string>();
    // neither read answers in time; the first one answers after its deadline
    let reads = 0;
    readAgainUntil(() => { reads += 1; return reads === 1 ? late.promise : new Promise<string>(() => undefined); }, { every: 10_000, times: 2, later: q.later, now: q.now, apply: r.apply });
    // the first deadline: a timeout, and the second read starts at once
    await q.next();
    await r.until(1);
    late.resolve("found, too late");
    await q.next();
    await r.until(2);
    expect(r.seen).toEqual([{ kind: "timeout", last: false }, { kind: "timeout", last: true }]);
    expect(q.pending()).toBe(0);
  });

  it("releases a dialog whose every read stalls within READ_AGAIN_TIMES deadlines: the next read starts as one times out", async () => {
    // a virtual clock: each run fires at the time it was scheduled for
    let clock = 0;
    const timers: { at: number; run: () => void; cancelled: boolean }[] = [];
    const later = (run: () => void, ms: number) => { const timer = { at: clock + ms, run, cancelled: false }; timers.push(timer); return () => { timer.cancelled = true; }; };
    // set in apply, which TypeScript cannot see run
    let ended = null as number | null;
    readAgainUntil(() => new Promise<string>(() => undefined), { every: READ_AGAIN_MS, times: READ_AGAIN_TIMES, later, now: () => clock, apply: (_outcome, last) => { if (last) ended = clock; return false; } });
    while (ended === null) {
      const due = timers.filter((timer) => !timer.cancelled).sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      clock = due.at;
      due.run();
      await Promise.resolve();
    }
    expect(ended).toBe(READ_AGAIN_MS * READ_AGAIN_TIMES);
  });

  it("schedules each read from the start of the one before, so slow misses also end within READ_AGAIN_TIMES × READ_AGAIN_MS", async () => {
    let clock = 0;
    const timers: { at: number; run: () => void; cancelled: boolean; answer: boolean }[] = [];
    const schedule = (run: () => void, ms: number, answer: boolean) => { const timer = { at: clock + ms, run, cancelled: false, answer }; timers.push(timer); return () => { timer.cancelled = true; }; };
    let ended = null as number | null;
    let accepted = Promise.withResolvers<void>();
    // each read answers a miss 9 s after it starts, just inside its deadline
    readAgainUntil(() => new Promise<string>((resolve) => { schedule(() => resolve("missing"), 9_000, true); }), {
      every: READ_AGAIN_MS, times: READ_AGAIN_TIMES, now: () => clock, later: (run, ms) => schedule(run, ms, false),
      apply: (_outcome, last) => { if (last) ended = clock; accepted.resolve(); return false; },
    });
    while (ended === null) {
      const due = timers.filter((timer) => !timer.cancelled).sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      clock = due.at;
      due.run();
      // an answer is taken a promise turn later: wait for the helper to accept it
      if (due.answer) { await accepted.promise; accepted = Promise.withResolvers<void>(); }
    }
    expect(ended).toBe(READ_AGAIN_MS * (READ_AGAIN_TIMES - 1) + 9_000);
  });
});
