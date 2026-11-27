import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MachineEvent } from "../shared/machines.ts";
import { MAX_SEEN, type SeenFinish } from "../shared/seen.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { handleMachineRequest } from "./machine-api.ts";
import { MachineManager } from "./machines.ts";
import type { PushService } from "./push.ts";
import { handleSeenRequest, SeenStore } from "./seen.ts";

const roots: string[] = [];
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), "herdr-seen-")); roots.push(dir); return dir; };
afterEach(() => {
  mock.restore();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const post = (store: SeenStore, body: string) => handleSeenRequest(new Request("http://x/api/seen", { method: "POST", body }), store);
const finish = (pane: string, id: number, answer?: string): SeenFinish => ({ pc: "local", epoch: "e1", pane, id, ...(answer === undefined ? {} : { answer }) });

describe("read finishes shared by the browsers of a server", () => {
  it("keeps the greatest finish per pane, adds a missing answer, and tells only a change", async () => {
    const dir = root();
    const store = new SeenStore(dir);
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    await store.record(finish("a", 2));
    await store.record(finish("a", 1, "older"));
    await store.record(finish("a", 2));
    await store.record(finish("a", 2, "answer"));
    await store.record(finish("a", 2, "another"));
    await store.record({ ...finish("a", 1), epoch: "e2" });
    expect(told).toEqual([finish("a", 2), finish("a", 2, "answer"), { ...finish("a", 1), epoch: "e2" }]);
    expect(store.list()).toEqual([finish("a", 2, "answer"), { ...finish("a", 1), epoch: "e2" }]);
    expect(new SeenStore(dir).list()).toEqual(store.list());
  });

  it("tells a pane brought into view as presented, even when its finish was already read, and how it was presented", async () => {
    const ended = new Set<string>();
    const store = new SeenStore(root(), (pc, epoch) => ended.has(`${pc}/${epoch}`));
    const changed: [SeenFinish, string | undefined][] = [];
    const presented: SeenFinish[] = [];
    store.subscribe((finish, how) => changed.push([finish, how]));
    store.onPresented((finish) => presented.push(finish));
    const send = async (body: unknown) => (await post(store, JSON.stringify(body))).status;
    expect(await send({ ...finish("a", 1), presented: "held" })).toBe(200);
    expect(await send({ ...finish("a", 1), presented: "new" })).toBe(200);
    expect(await send(finish("a", 1))).toBe(200);
    expect(await send({ ...finish("a", 1), presented: "later" })).toBe(200);
    expect(await send({ ...finish("a", 2), presented: "new" })).toBe(200);
    ended.add("local/e1");
    expect(await send({ ...finish("a", 3), presented: "new" })).toBe(200);
    expect(changed).toEqual([[finish("a", 1), "held"], [finish("a", 2), "new"]]);
    expect(presented).toEqual([finish("a", 1), finish("a", 2)]);
    expect(store.list()).toEqual([]);
  });

  it("drops the oldest records past the limit", async () => {
    // a full store in one write: every record() is a durable write of the whole file, and 500 of them
    // took a minute on a loaded runner's disk
    const dir = root();
    writeFileSync(join(dir, "seen.json"), `${JSON.stringify(Array.from({ length: MAX_SEEN }, (_, pane) => finish(`p${pane}`, 1)))}\n`);
    const store = new SeenStore(dir);
    await store.record(finish(`p${MAX_SEEN}`, 1));
    await store.record(finish("p1", 2));
    const panes = store.list().map((kept) => kept.pane);
    expect(panes).toHaveLength(MAX_SEEN);
    expect(panes).not.toContain("p0");
    expect(panes.at(-1)).toBe("p1");
  });


  it("leaves out and drops the finishes of a PC's herdr run known to have ended, and keeps the others", async () => {
    const dir = root();
    const old = { ...finish("a", 4), epoch: "e0" };
    const remote = { ...finish("a", 2), pc: "remote", epoch: "r0" };
    await new SeenStore(dir).record(old);
    await new SeenStore(dir).record(remote);
    await new SeenStore(dir).record(finish("b", 1));
    const ended = new Set(["local/e0"]);
    const store = new SeenStore(dir, (pc, epoch) => ended.has(`${pc}/${epoch}`));
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    expect(store.list()).toEqual([remote, finish("b", 1)]);
    expect(await (await handleSeenRequest(new Request("http://x/api/seen"), store)).json()).toEqual({ finishes: [remote, finish("b", 1)] });
    expect(await (await post(store, JSON.stringify({ ...old, id: 5 }))).json()).toEqual({ ...old, id: 5 });
    expect(told).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual([old, remote, finish("b", 1)]);
    await store.record(finish("c", 1));
    expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual([remote, finish("b", 1), finish("c", 1)]);
    expect(told).toEqual([finish("c", 1)]);
    ended.add("remote/r0");
    expect(store.list()).toEqual([finish("b", 1), finish("c", 1)]);
  });

  it("keeps and saves the read finishes of a herdr run when a late report names the run it replaced (#2206)", async () => {
    const dir = root();
    const roster = (finish_epoch: string): SessionSnapshot => ({
      protocol: 22, version: "fixture", workspaces: [], tabs: [], layouts: [], agents: [], finish_epoch, order_epoch: "boot", read_seq: 0,
      panes: [{ pane_id: "p1", agent: "codex", agent_status: "done", focused: false, revision: 1, tab_id: "t1", terminal_id: "term", workspace_id: "w", finish_id: 1 }],
    });
    let current = roster("A");
    let finishEpoch = "A";
    const manager = new MachineManager(join(dir, "machines"), { seed() {} } as unknown as PushService, new CompletionTracker(null), async () => current,
      { bootId: "boot", localFinishEpoch: () => finishEpoch });
    const shown = (epoch: string) => new Promise<void>((resolve) => {
      const stop = manager.subscribe((event) => {
        if (event.type === "machines" && event.machines[0]?.snapshot?.finish_epoch === epoch) { queueMicrotask(() => stop()); resolve(); }
      });
    });
    const run = (epoch: string, pane: string): SeenFinish => ({ pc: "local", epoch, pane, id: 1 });
    writeFileSync(join(dir, "seen.json"), JSON.stringify([run("previous-process", "p9")]));
    const store = new SeenStore(dir, (pc, epoch) => manager.finishEnded(pc, epoch));
    const saved = () => JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) as SeenFinish[];
    const told: string[] = [];
    manager.subscribe((event) => { if (event.type === "machine-message" && event.message.type === "pane-status") told.push(event.message.finish_epoch ?? ""); });
    try {
      await shown("A");
      expect(store.list()).toEqual([]);
      expect((await post(store, JSON.stringify(run("A", "p1")))).status).toBe(200);
      expect(saved()).toEqual([run("A", "p1")]);
      finishEpoch = "B";
      current = roster("B");
      const replaced = shown("B");
      void manager.refreshLocal();
      await replaced;
      expect((await post(store, JSON.stringify(run("B", "p1")))).status).toBe(200);
      manager.localMessage({ type: "pane-status", pane_id: "p1", agent_status: "done", finish_id: 2, finish_epoch: "A" });
      expect(manager.list()[0]?.snapshot?.finish_epoch).toBe("B");
      expect(told).toEqual([]);
      const answered = await post(store, JSON.stringify(run("B", "p2")));
      expect([answered.status, await answered.json()]).toEqual([200, run("B", "p2")]);
      expect(saved()).toEqual([run("B", "p1"), run("B", "p2")]);
      expect(store.list()).toEqual(saved());
    } finally {
      manager.stop();
    }
  });

  it("answers GET and POST, and refuses what is not a read finish", async () => {
    const store = new SeenStore(root());
    const answered = await post(store, JSON.stringify(finish("a", 3)));
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual(finish("a", 3));
    expect(await (await post(store, JSON.stringify(finish("a", 1)))).json()).toEqual(finish("a", 3));
    expect(await (await handleSeenRequest(new Request("http://x/api/seen"), store)).json()).toEqual({ finishes: [finish("a", 3)] });
    for (const body of ["nope", "[]", JSON.stringify({ ...finish("a", 1), id: 0 }), JSON.stringify({ ...finish("a", 1), id: 1.5 }),
      JSON.stringify({ ...finish("a", 1), pane: "" }), JSON.stringify({ ...finish("a", 1), answer: 7 }), JSON.stringify({ ...finish("a", 1), answer: "x".repeat(2049) })]) {
      expect([body.slice(0, 40), (await post(store, body)).status]).toEqual([body.slice(0, 40), 400]);
    }
    expect((await post(store, "x".repeat(9000))).status).toBe(413);
    expect((await handleSeenRequest(new Request("http://x/api/seen", { method: "PUT", body: "{}" }), store)).status).toBe(405);
  });

  it("stops reading a body as soon as it passes 8 KB", async () => {
    const store = new SeenStore(root());
    let pulled = 0;
    const twoMiB = new ReadableStream<Uint8Array>({
      pull(controller) { if (++pulled > 512) controller.close(); else controller.enqueue(new Uint8Array(4096)); },
    });
    const response = await handleSeenRequest(new Request("http://x/api/seen", { method: "POST", body: twoMiB, duplex: "half" } as RequestInit), store);
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(store.list()).toEqual([]);
  });

  it("sends every record when a browser connects to the machine events, then each change", async () => {
    const store = new SeenStore(root());
    await store.record(finish("a", 1));
    const manager = { subscribe: () => () => undefined } as unknown as MachineManager;
    const abort = new AbortController();
    const response = await handleMachineRequest(new Request("http://127.0.0.1:7317/api/machines/events", { signal: abort.signal }), manager,
      undefined, undefined, false, undefined, store);
    const reader = response.body!.getReader();
    const events: MachineEvent[] = [];
    let buffer = "";
    const read = async (): Promise<void> => {
      const { value } = await reader.read();
      buffer += new TextDecoder().decode(value);
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith("data: ")) events.push(JSON.parse(frame.slice(6)) as MachineEvent);
      }
    };
    try {
      while (events.length === 0) await read();
      expect(events).toEqual([{ type: "seen", finishes: [finish("a", 1)] }]);
      await store.record(finish("b", 4));
      while (events.length === 1) await read();
      expect(events[1]).toEqual({ type: "seen", finishes: [finish("b", 4)] });
    } finally {
      abort.abort();
      await reader.cancel().catch(() => undefined);
    }
  });
});

describe("a damaged read-finish file", () => {
  const file = (dir: string) => join(dir, "seen.json");
  const bad = (dir: string) => `${file(dir)}.bad`;
  const files = (dir: string) => readdirSync(dir).sort();
  const quiet = () => spyOn(console, "error").mockImplementation(() => undefined);
  const expectPrivate = (path: string) => { if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600); };

  it("preserves malformed bytes only on first effective write", async () => {
    const logged = quiet();
    const dir = root();
    const first = Buffer.from('[{"pc":"local","epoch":"e1","pane":"a","id":4}');
    writeFileSync(file(dir), first);
    const store = new SeenStore(dir);
    expect(await (await handleSeenRequest(new Request("http://x/api/seen"), store)).json()).toEqual({ finishes: [] });
    expect(readFileSync(file(dir))).toEqual(first);
    expect(files(dir)).toEqual(["seen.json"]);
    expect(logged.mock.calls.flat().join("\n")).toContain("not JSON");
    expect(logged.mock.calls.flat().join("\n")).not.toContain('"pane"');
    const current = Buffer.from("{not json");
    writeFileSync(file(dir), current);
    expect((await post(store, JSON.stringify(finish("a", 1)))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(current);
    expectPrivate(bad(dir));
    expect(new SeenStore(dir).list()).toEqual([finish("a", 1)]);
    await store.record(finish("b", 2));
    expect(readFileSync(bad(dir))).toEqual(current);
    expect(files(dir)).toEqual(["seen.json", "seen.json.bad"]);
    const again = Buffer.from("]]");
    writeFileSync(file(dir), again);
    await new SeenStore(dir).record(finish("c", 3));
    expect(readFileSync(bad(dir))).toEqual(again);
    expect(files(dir)).toEqual(["seen.json", "seen.json.bad"]);
  });

  it("preserves wrong-shaped documents privately: not a list", async () => {
    quiet();
    const dir = root();
    const bytes = Buffer.from('{"finishes":[{"pc":"local","epoch":"e1","pane":"a","id":1}]}');
    writeFileSync(file(dir), bytes, { mode: 0o644 });
    const store = new SeenStore(dir);
    expect(store.list()).toEqual([]);
    expect(readFileSync(file(dir))).toEqual(bytes);
    expect(files(dir)).toEqual(["seen.json"]);
    await store.record(finish("b", 1));
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expectPrivate(bad(dir));
    expect(files(dir)).toEqual(["seen.json", "seen.json.bad"]);
    expect(new SeenStore(dir).list()).toEqual([finish("b", 1)]);
  });

  it("preserves wrong-shaped documents privately: rows that are not finishes", async () => {
    const logged = quiet();
    const dir = root();
    const bytes = Buffer.from(JSON.stringify([finish("a", 2), { pc: "local", epoch: "e1", pane: "b", id: 0 }]));
    writeFileSync(file(dir), bytes, { mode: 0o644 });
    const store = new SeenStore(dir);
    expect(store.list()).toEqual([finish("a", 2)]);
    expect(readFileSync(file(dir))).toEqual(bytes);
    expect(files(dir)).toEqual(["seen.json"]);
    expect(logged.mock.calls.flat().join("\n")).toContain("not a list of read finishes");
    await store.record(finish("c", 1));
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expectPrivate(bad(dir));
    expect(new SeenStore(dir).list()).toEqual([finish("a", 2), finish("c", 1)]);
  });

  it("keeps a manual repair rather than quarantining it", async () => {
    quiet();
    const dir = root();
    writeFileSync(file(dir), "not json");
    const store = new SeenStore(dir);
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    writeFileSync(file(dir), JSON.stringify([finish("b", 2)]));
    expect(await store.record(finish("a", 1))).toEqual(finish("a", 1));
    expect(store.list()).toEqual([finish("b", 2), finish("a", 1)]);
    expect(told).toEqual([finish("a", 1)]);
    expect(files(dir)).toEqual(["seen.json"]);
    expect(new SeenStore(dir).list()).toEqual([finish("b", 2), finish("a", 1)]);
    expect(await store.record(finish("b", 1))).toEqual(finish("b", 2));
    expect(told).toHaveLength(1);
  });

  it("refuses to write over a file it cannot read", async () => {
    quiet();
    const dir = root();
    mkdirSync(file(dir));
    writeFileSync(join(file(dir), "keep"), "kept");
    const store = new SeenStore(dir);
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    const failed = await post(store, JSON.stringify(finish("a", 1)));
    expect(failed.status).toBe(500);
    expect(((await failed.json()) as { error: { code: string } }).error.code).toBe("seen_unwritable");
    expect(readFileSync(join(file(dir), "keep"), "utf8")).toBe("kept");
    expect(files(dir)).toEqual(["seen.json"]);
    expect(told).toEqual([]);
  });

  it("refuses overwrite when preservation fails", async () => {
    quiet();
    const dir = root();
    const bytes = Buffer.from('{"not":"a list"}');
    writeFileSync(file(dir), bytes);
    mkdirSync(bad(dir));
    writeFileSync(join(bad(dir), "older"), "older");
    const store = new SeenStore(dir);
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    const failed = await post(store, JSON.stringify(finish("a", 1)));
    expect(failed.status).toBe(500);
    const { error } = (await failed.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("seen_unwritable");
    expect(error.message).toContain("seen.json.bad");
    expect(readFileSync(file(dir))).toEqual(bytes);
    expect(readFileSync(join(bad(dir), "older"), "utf8")).toBe("older");
    expect(files(dir)).toEqual(["seen.json", "seen.json.bad"]);
    expect(store.list()).toEqual([]);
    expect(told).toEqual([]);
    rmSync(bad(dir), { recursive: true });
    expect((await post(store, JSON.stringify(finish("a", 1)))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(told).toEqual([finish("a", 1)]);
  });

  it("retains one bad generation across replacement failure", async () => {
    quiet();
    const dir = root();
    const bytes = Buffer.from("{damaged");
    writeFileSync(file(dir), bytes);
    writeFileSync(bad(dir), "an older damaged generation");
    const store = new SeenStore(dir);
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    const rename = fs.rename;
    const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).endsWith(".tmp")) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
      await rename(from, to);
    });
    expect((await post(store, JSON.stringify(finish("a", 1)))).status).toBe(500);
    spy.mockRestore();
    expect(readFileSync(file(dir))).toEqual(bytes);
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(files(dir).filter((name) => name.endsWith(".bad"))).toEqual(["seen.json.bad"]);
    expect(store.list()).toEqual([]);
    expect(told).toEqual([]);
    expect((await post(store, JSON.stringify(finish("a", 1)))).status).toBe(200);
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expect(files(dir)).toEqual(["seen.json", "seen.json.bad"]);
    expect(told).toEqual([finish("a", 1)]);
    expect(new SeenStore(dir).list()).toEqual([finish("a", 1)]);
  });

  it("preserves a file damaged after a valid start on the first write", async () => {
    quiet();
    const dir = root();
    writeFileSync(file(dir), JSON.stringify([finish("a", 1)]));
    const store = new SeenStore(dir);
    expect(store.list()).toEqual([finish("a", 1)]);
    const bytes = Buffer.from("{damaged after the start");
    writeFileSync(file(dir), bytes);
    await store.record(finish("b", 1));
    expect(readFileSync(bad(dir))).toEqual(bytes);
    expectPrivate(bad(dir));
    expect(files(dir)).toEqual(["seen.json", "seen.json.bad"]);
    expect(new SeenStore(dir).list()).toEqual([finish("b", 1)]);
  });

  it("holds nothing of a repair whose replacement failed, and checks the file again on retry", async () => {
    quiet();
    const dir = root();
    writeFileSync(file(dir), "{damaged");
    const store = new SeenStore(dir);
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    writeFileSync(file(dir), JSON.stringify([finish("r", 3)]));
    const rename = fs.rename;
    const spy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from).endsWith(".tmp")) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
      await rename(from, to);
    });
    await expect(store.record(finish("a", 1))).rejects.toThrow("EIO");
    spy.mockRestore();
    expect(store.list()).toEqual([]);
    expect(told).toEqual([]);
    expect(files(dir).some((name) => name.endsWith(".bad"))).toBe(false);
    const changed = Buffer.from("{damaged before the retry");
    writeFileSync(file(dir), changed);
    expect(await store.record(finish("a", 1))).toEqual(finish("a", 1));
    expect(readFileSync(bad(dir))).toEqual(changed);
    expectPrivate(bad(dir));
    expect(files(dir)).toEqual(["seen.json", "seen.json.bad"]);
    expect(told).toEqual([finish("a", 1)]);
    expect(new SeenStore(dir).list()).toEqual([finish("a", 1)]);
  });
});

describe("a pane moved under a new ID (#1503)", () => {
  it("reads under the new ID what was read under the old one, renumbered, on its own PC only, and tells every browser", async () => {
    const store = new SeenStore(root());
    await store.record(finish("w1:p1", 3, "answer"));
    await store.record({ ...finish("w1:p1", 2), pc: "other" });
    const told: SeenFinish[] = [];
    store.subscribe((changed) => told.push(changed));
    await store.moved("local", "w1:p1", "w2:p1", (id) => id + 4);
    expect(told).toEqual([finish("w2:p1", 7, "answer")]);
    expect(store.list()).toContainEqual(finish("w2:p1", 7, "answer"));
    expect(store.list()).toContainEqual({ ...finish("w1:p1", 2), pc: "other" });
    expect(store.list().some((kept) => kept.pc === "other" && kept.pane === "w2:p1")).toBe(false);
  });
});
