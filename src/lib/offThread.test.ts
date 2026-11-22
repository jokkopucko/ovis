import { describe, expect, it } from "bun:test";

import { HIGHLIGHT_BUDGET_MS, highlightKnown, highlightOffThread, LinesCache } from "./highlightOffThread.ts";
import { normalizeCode, type Lines } from "./highlight.ts";
import { createOffThreadQueue, type OffThreadAnswer, type OffThreadRequest, type WorkerLike } from "./offThread.ts";

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  sent: OffThreadRequest<string>[] = [];
  terminated = false;
  postMessage(message: unknown): void { this.sent.push(message as OffThreadRequest<string>); }
  terminate(): void { this.terminated = true; }
  answer(id: number, result: string | null): void {
    this.onmessage?.({ data: { id, result } satisfies OffThreadAnswer<string> } as MessageEvent);
  }
}

function fakeQueue(budgetMs = 1_000) {
  const workers: FakeWorker[] = [];
  const run = createOffThreadQueue<string, string>(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  }, budgetMs);
  return { run, workers };
}

describe("createOffThreadQueue", () => {
  it("starts no worker before the first job, and runs one job at a time", async () => {
    const { run, workers } = fakeQueue();
    expect(workers).toHaveLength(0);
    const a = run("a");
    const b = run("b");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.sent.map((m) => m.request)).toEqual(["a"]);
    workers[0]!.answer(workers[0]!.sent[0]!.id, "A");
    expect(await a.promise).toBe("A");
    expect(workers[0]!.sent.map((m) => m.request)).toEqual(["a", "b"]);
    workers[0]!.answer(workers[0]!.sent[1]!.id, "B");
    expect(await b.promise).toBe("B");
  });

  it("ends a worker that runs over its budget and starts a new one for the next job", async () => {
    const { run, workers } = fakeQueue(10);
    const slow = run("slow");
    const next = run("next");
    expect(await slow.promise).toBeNull();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1]!.sent.map((m) => m.request)).toEqual(["next"]);
    workers[0]!.answer(workers[0]!.sent[0]!.id, "late");
    workers[1]!.answer(workers[1]!.sent[0]!.id, "NEXT");
    expect(await next.promise).toBe("NEXT");
  });

  it("drops a cancelled job that has not started, and lets a running one finish", async () => {
    const { run, workers } = fakeQueue();
    const running = run("running");
    const waiting = run("waiting");
    const after = run("after");
    expect(waiting.cancel()).toBe(true);
    expect(running.cancel()).toBe(false);
    expect(await waiting.promise).toBeNull();
    workers[0]!.answer(workers[0]!.sent[0]!.id, "RUNNING");
    expect(await running.promise).toBe("RUNNING");
    expect(workers[0]!.sent.map((m) => m.request)).toEqual(["running", "after"]);
    workers[0]!.answer(workers[0]!.sent[1]!.id, "AFTER");
    expect(await after.promise).toBe("AFTER");
  });

  it("gives null for a worker that fails, and replaces it", async () => {
    const { run, workers } = fakeQueue();
    const failing = run("x");
    workers[0]!.onerror?.(new Event("error"));
    expect(await failing.promise).toBeNull();
    expect(workers[0]!.terminated).toBe(true);
    const next = run("y");
    expect(workers).toHaveLength(2);
    workers[1]!.answer(workers[1]!.sent[0]!.id, "Y");
    expect(await next.promise).toBe("Y");
  });

  it("gives null when no worker can be started", async () => {
    const run = createOffThreadQueue<string, string>(() => { throw new Error("no workers here"); }, 1_000);
    expect(await run("x").promise).toBeNull();
  });
});

describe("LinesCache", () => {
  const lines = (text: string): Lines => [[{ text, role: null }]];
  it("keeps texts up to its size in characters, dropping the least recently used", () => {
    const cache = new LinesCache(6);
    cache.set("aaa", "ts", lines("a"));
    cache.set("bbb", "ts", lines("b"));
    expect(cache.get("aaa", "ts")).toEqual(lines("a"));
    cache.set("ccc", "ts", lines("c"));
    expect(cache.get("bbb", "ts")).toBeUndefined();
    expect(cache.get("aaa", "ts")).toEqual(lines("a"));
    expect(cache.get("ccc", "ts")).toEqual(lines("c"));
  });
  it("tells a text by its language too, and remembers one given up on", () => {
    const cache = new LinesCache(100);
    cache.set("x", "ts", null);
    expect(cache.get("x", "ts")).toBeNull();
    expect(cache.get("x", "js")).toBeUndefined();
  });
  it("keeps nothing larger than itself", () => {
    const cache = new LinesCache(2);
    cache.set("abc", "ts", lines("abc"));
    expect(cache.get("abc", "ts")).toBeUndefined();
  });
});

describe("highlightKnown", () => {
  it("highlights short code at once, and asks for the worker past the limit until it answered", () => {
    expect(highlightKnown("const a = 1;", "ts")?.lines[0]![0]).toEqual({ text: "const", role: "keyword" });
    expect(highlightKnown(normalizeCode("const b = 2;\n".repeat(400)), "ts")).toBeNull();
  });
});

describe("highlightOffThread", () => {
  it("highlights in a real worker and keeps the result", async () => {
    const source = normalizeCode("const a = 1;\n// done\n".repeat(400));
    const lines = await highlightOffThread(source, "ts").promise;
    expect(lines).not.toBeNull();
    expect(lines![0]![0]).toEqual({ text: "const", role: "keyword" });
    expect(lines!.length).toBe(801);
    expect(lines!.map((line) => line.map((token) => token.text).join("")).join("\n")).toBe("const a = 1;\n// done\n".repeat(400));
    expect(highlightKnown(source, "ts")).toEqual({ lines: lines!, tooLong: false });
    expect(highlightKnown(source, "ts")!.lines).toBe(lines!);
  });
  it("gives up past its budget without holding the page", async () => {
    // a line of dashes in YAML: quadratic for the tokenizer, about half a minute at this size
    const source = "-".repeat(200_000);
    const start = performance.now();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 50);
    const lines = await highlightOffThread(source, "yaml").promise;
    clearInterval(timer);
    expect(lines).toBeNull();
    expect(performance.now() - start).toBeLessThan(HIGHLIGHT_BUDGET_MS + 1_000);
    expect(ticks).toBeGreaterThan(HIGHLIGHT_BUDGET_MS / 50 / 2);
    expect(highlightKnown(source, "yaml")?.tooLong).toBe(true);
  }, HIGHLIGHT_BUDGET_MS + 5_000);
  it("remembers giving up on a text whose view left while it ran", async () => {
    // a view that unmounts (or a StrictMode remount) cancels the running job: it still ran, so the
    // next view of the text must not spend another budget on it
    const source = "-".repeat(200_001);
    const job = highlightOffThread(source, "yaml");
    expect(job.cancel()).toBe(false);
    expect(await job.promise).toBeNull();
    expect(highlightKnown(source, "yaml")?.tooLong).toBe(true);
  }, HIGHLIGHT_BUDGET_MS + 5_000);
  it("forgets nothing for a text whose job was dropped before it ran", async () => {
    const first = highlightOffThread(normalizeCode("let x = 1;\n".repeat(300)), "ts");
    const source = normalizeCode("let y = 2;\n".repeat(300));
    const dropped = highlightOffThread(source, "ts");
    expect(dropped.cancel()).toBe(true);
    expect(await dropped.promise).toBeNull();
    expect(highlightKnown(source, "ts")).toBeNull();
    await first.promise;
  });
});
