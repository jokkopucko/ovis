import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSeenRequest, SeenStore } from "./seen.ts";
import { writeStateDocument } from "./state-document.ts";

it("serializes commits, publishes only durable state, and drains on close", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    writes++;
    if (writes === 1) { entered.resolve(); await release.promise; }
    writeStateDocument(path, text, damaged);
  });
  const finish = (id: number) => ({ pc: "local", epoch: "e", pane: "p", id });
  const told: number[] = [];
  store.subscribe((value) => told.push(value.id));
  try {
    const first = store.record(finish(2));
    const older = store.record(finish(1));
    const newer = store.record(finish(3));
    await entered.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(store.list()).toEqual([]);
    expect(told).toEqual([]);
    expect(writes).toBe(1);
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    expect(await first).toEqual(finish(2));
    expect(await older).toEqual(finish(2));
    await newer;
    await closing;
    expect(told).toEqual([2, 3]);
    expect(writes).toBe(2);
    expect(new SeenStore(dir).list()).toEqual([finish(3)]);
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual([finish(3)]);
    await expect(store.record(finish(4))).rejects.toThrow("closed");
  } finally { release.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("bounds accepted work and recovers after a failed commit without publishing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    if (++calls === 1) { entered.resolve(); await release.promise; throw new Error("fixture disk failure"); }
    writeStateDocument(path, text, damaged);
  });
  const finish = (id: number) => ({ pc: "local", epoch: "e", pane: "p", id });
  const told: number[] = [];
  store.subscribe((value) => told.push(value.id));
  try {
    const first = store.record(finish(99)).catch((error: Error) => error.message);
    await entered.promise;
    const rest = Array.from({ length: 499 }, () => store.record(finish(2)));
    await expect(store.record(finish(3))).rejects.toThrow("queue is full");
    expect(told).toEqual([]);
    release.resolve();
    expect(await first).toBe("fixture disk failure");
    await Promise.all(rest);
    expect(calls).toBe(2);
    expect(told).toEqual([2]);
    await store.record(finish(3));
    expect(new SeenStore(dir).list()).toEqual([finish(3)]);
  } finally { release.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("queues pane moves behind accepted records and ahead of subsequent records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const store = new SeenStore(dir);
  const finish = { pc: "local", epoch: "e", pane: "old", id: 2 };
  try {
    const record = store.record(finish);
    const move = store.moved("local", "old", "new", (id) => id + 2);
    const later = store.record({ ...finish, pane: "new", id: 3 });
    await Promise.all([record, move, later]);
    expect(await later).toEqual({ ...finish, pane: "new", id: 4 });
    expect(new SeenStore(dir).list()).toEqual(store.list());
  } finally { await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("carries a pane's read receipt even when the acknowledgement queue is full", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    entered.resolve();
    await release.promise;
    writeStateDocument(path, text, damaged);
  });
  const finish = { pc: "local", epoch: "e", pane: "old", id: 2 };
  try {
    const records = Promise.all(Array.from({ length: 500 }, () => store.record(finish)));
    await entered.promise;
    const moved = store.moved("local", "old", "new");
    release.resolve();
    await Promise.all([records, moved]);
    expect(new SeenStore(dir).list()).toContainEqual({ ...finish, pane: "new" });
  } finally {
    release.resolve();
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("persists the last destination when more than 500 pane moves are pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const store = new SeenStore(dir);
  const finish = { pc: "local", epoch: "e", pane: "a", id: 1 };
  try {
    await store.record(finish);
    const moves = Array.from({ length: 500 }, (_, index) => index % 2 === 0
      ? store.moved("local", "a", "b")
      : store.moved("local", "b", "a"));
    moves.push(store.moved("local", "a", "final"));
    const results = await Promise.allSettled(moves);
    await store.close();
    expect(new SeenStore(dir).list()).toContainEqual({ ...finish, pane: "final" });
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("saves every receipt that waits behind a slow write in one more write, so a shutdown drain fits its time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    writeStateDocument(path, text, damaged);
  });
  const finish = (pane: string) => ({ pc: "local", epoch: "e", pane, id: 1 });
  try {
    const first = store.record(finish("first"));
    await entered.promise;
    const waiting = Array.from({ length: 50 }, (_, index) => store.record(finish(`p${index}`)));
    const closing = store.close();
    release.resolve();
    await Promise.all([first, ...waiting, closing]);
    expect(writes).toBe(2);
    expect(new SeenStore(dir).list()).toHaveLength(51);
  } finally { release.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("answers a full acknowledgement queue with 503, which the browser retries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    entered.resolve();
    await release.promise;
    writeStateDocument(path, text, damaged);
  });
  const finish = (id: number) => ({ pc: "local", epoch: "e", pane: "p", id });
  try {
    const waiting = Array.from({ length: 500 }, (_, index) => store.record(finish(index + 1)));
    await entered.promise;
    const response = await handleSeenRequest(new Request("http://localhost/api/seen", { method: "POST", body: JSON.stringify(finish(501)) }), store);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("seen_busy");
    release.resolve();
    await Promise.all(waiting);
  } finally { release.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("closes only after the work its listeners started for saved receipts (herdr.seen) is done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const store = new SeenStore(dir);
  const labelled = Promise.withResolvers<void>();
  const presented = Promise.withResolvers<void>();
  store.subscribe(() => labelled.promise);
  store.onPresented(() => presented.promise);
  try {
    await store.record({ pc: "local", epoch: "e", pane: "p", id: 1 }, "new");
    let closed = false;
    const closing = store.close().then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    labelled.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    presented.resolve();
    await closing;
    expect(closed).toBe(true);
  } finally { labelled.resolve(); presented.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("merges each waiting receipt with what the ones before it left, as one write each would", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const row = (pane: string, id: number) => ({ pc: "local", epoch: "e", pane, id });
  writeFileSync(join(dir, "seen.json"), JSON.stringify(Array.from({ length: 500 }, (_, index) => row(`p${index}`, 100))));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    writeStateDocument(path, text, damaged);
  });
  try {
    const first = store.record(row("p499", 101));
    await entered.promise;
    // the new pane pushes the oldest, p0, out: the p0 that follows starts afresh
    const added = store.record(row("x", 1));
    const again = store.record(row("p0", 1));
    release.resolve();
    await Promise.all([first, added]);
    expect(await again).toEqual(row("p0", 1));
    await store.close();
    expect(new SeenStore(dir).list()).toContainEqual(row("p0", 1));
  } finally { release.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("tries a failed write of many again one by one, so one failure costs no unrelated receipt or move", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let writes = 0;
  const store = new SeenStore(dir, undefined, async (path, text, damaged) => {
    writes++;
    if (writes === 2) { entered.resolve(); await release.promise; }
    if (writes === 3) throw Object.assign(new Error("fixture EIO"), { code: "EIO" });
    writeStateDocument(path, text, damaged);
  });
  const row = (pane: string, id: number) => ({ pc: "local", epoch: "e", pane, id });
  const presented: string[] = [];
  store.onPresented((finish) => { presented.push(finish.pane); });
  try {
    await store.record(row("old", 1));
    const held = store.record(row("held", 1));
    await entered.promise;
    const other = store.record(row("other", 1));
    const shown = store.record(row("old", 1), "new");
    const moved = store.moved("local", "old", "new");
    release.resolve();
    await Promise.all([held, other, shown, moved]);
    expect(presented).toEqual(["old"]);
    await store.close();
    expect(new SeenStore(dir).list()).toEqual(expect.arrayContaining([row("other", 1), row("new", 1)]));
  } finally { release.resolve(); await store.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("keeps writing after a listener throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "seen-writer-"));
  const store = new SeenStore(dir);
  const error = console.error;
  console.error = () => {};
  store.subscribe(() => { throw new Error("fixture listener"); });
  try {
    await store.record({ pc: "local", epoch: "e", pane: "a", id: 1 });
    await store.record({ pc: "local", epoch: "e", pane: "b", id: 1 });
    await store.close();
    expect(new SeenStore(dir).list()).toHaveLength(2);
  } finally { console.error = error; await store.close(); rmSync(dir, { recursive: true, force: true }); }
});
