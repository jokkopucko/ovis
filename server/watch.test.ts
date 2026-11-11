import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaneWatch, WatchStreamParser } from "./watch.ts";

function frame(bytes: string | Uint8Array): string {
  // as herdr 0.9.3 writes it: `encoding` names what the bytes are, and `bytes` is base64 of them
  return JSON.stringify({ type: "terminal.frame", seq: 1, width: 80, height: 24, full: true, encoding: "ansi", bytes: Buffer.from(bytes).toString("base64") });
}

function consumer() {
  const frames: string[] = [];
  let ends = 0;
  const parser = new WatchStreamParser({ onFrame: (data) => frames.push(data), onEnd: () => { ends += 1; } });
  return { parser, frames, ends: () => ends };
}

describe("read-only watch stream", () => {
  it("keeps a split NDJSON record until the next chunk", () => {
    const view = consumer();
    const line = frame("\u001b[Hscreen");
    view.parser.push(line.slice(0, 21));
    expect(view.frames).toEqual([]);
    view.parser.push(`${line.slice(21)}\n`);
    expect(view.frames).toEqual(["\u001b[Hscreen"]);
  });

  it("delivers several records in one chunk in order", () => {
    const view = consumer();
    view.parser.push(`${frame("first")}\n${frame("second")}\n${frame("third")}\n`);
    expect(view.frames).toEqual(["first", "second", "third"]);
  });

  it("delivers a trailing record without a newline at EOF", () => {
    const view = consumer();
    view.parser.push(`${frame("first")}\n${frame("last")}`);
    expect(view.frames).toEqual(["first"]);
    view.parser.finish();
    expect(view.frames).toEqual(["first", "last"]);
  });

  it("preserves a multibyte UTF-8 character split across frame bytes", () => {
    const view = consumer();
    const bytes = new TextEncoder().encode("A한B");
    view.parser.push(`${frame(bytes.slice(0, 2))}\n`);
    expect(view.frames.join("")).toBe("A");
    view.parser.push(`${frame(bytes.slice(2))}\n`);
    view.parser.finish();
    expect(view.frames.join("")).toBe("A한B");
  });

  it("ends exactly once on a closed record and ignores later frames", () => {
    const view = consumer();
    view.parser.push(`${frame("before")}\n{"type":"terminal.closed"}\n${frame("after")}\n`);
    view.parser.push('{"type":"terminal.closed"}\n');
    view.parser.finish();
    expect(view.frames).toEqual(["before"]);
    expect(view.ends()).toBe(1);
  });

  it("recognizes a trailing closed record at EOF", () => {
    const view = consumer();
    view.parser.push('{"type":"terminal.closed"}');
    view.parser.finish();
    expect(view.ends()).toBe(1);
  });

  it("ignores unknown records and unsupported frame encodings", () => {
    const view = consumer();
    view.parser.push('{"type":"terminal.ready"}\n{"type":"terminal.frame","encoding":"text","bytes":"ignored"}\n');
    view.parser.push(`${frame("visible")}\n`);
    expect(view.frames).toEqual(["visible"]);
    expect(view.ends()).toBe(0);
  });
});

describe("an observe process asked to end", () => {
  // stand-ins for herdr's binary, started as `<stand-in> terminal session observe …`: no herdr runs
  let root: string | undefined;
  const binBefore = process.env["OVIS_HERDR_BIN"];
  afterEach(() => {
    if (binBefore === undefined) delete process.env["OVIS_HERDR_BIN"]; else process.env["OVIS_HERDR_BIN"] = binBefore;
    // whatever a stand-in left running: itself when it would not end, and the child it started
    for (const name of ["pid", "child"]) {
      try { process.kill(Number(readFileSync(join(root!, name), "utf8")), "SIGKILL"); } catch { /* ended, or never started */ }
    }
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });
  /** A watch on a stand-in whose shell script is `body`, once the stand-in runs (it has written its pid). */
  async function watching(body: string, killGraceMs?: number): Promise<{ watch: PaneWatch; ends: () => number }> {
    root = mkdtempSync(join(tmpdir(), "ovis-watch-kill-"));
    const bin = join(root, "herdr");
    // `ROOT_DIR` in `body`: this test's own folder
    writeFileSync(bin, `#!/bin/sh\necho $$ > 'ROOT_DIR/pid'\n${body}\n`.replaceAll("ROOT_DIR", root));
    chmodSync(bin, 0o755);
    process.env["OVIS_HERDR_BIN"] = bin;
    let ends = 0;
    const watch = new PaneWatch({ paneId: "w1:p1", cols: 80, rows: 24, socketPath: join(root, "herdr.sock"), onFrame() {}, onEnd: () => { ends += 1; }, ...(killGraceMs === undefined ? {} : { killGraceMs }) });
    const deadline = Date.now() + 5_000;
    while (!existsSync(join(root, "ready"))) {
      if (Date.now() > deadline) throw new Error("the stand-in did not start");
      await Bun.sleep(5);
    }
    return { watch, ends: () => ends };
  }
  /** Whether the watch's process is reported gone within `ms`. */
  const exitedWithin = (watch: PaneWatch, ms: number): Promise<boolean> => Promise.race([watch.exited.then(() => true), Bun.sleep(ms).then(() => false)]);
  const posix = process.platform !== "win32";

  it.skipIf(!posix)("has exited once its process has, though a child of that process keeps its output open", async () => {
    // a launcher that does not `exec` its program: the signal ends the launcher, and its child holds the pipes
    const { watch, ends } = await watching(`sleep 30 &\necho $! > 'ROOT_DIR/child'\ntouch 'ROOT_DIR/ready'\nwait`);
    watch.kill();
    expect(await exitedWithin(watch, 3_000), "what waits for its exit (the pane's next view, its place among 64) would wait for the child").toBe(true);
    // asked to end, it tells no end of its own
    expect(ends()).toBe(0);
  }, 15_000);

  it.skipIf(!posix)("is killed outright when it does not end in time", async () => {
    const { watch } = await watching(`trap '' TERM\ntouch 'ROOT_DIR/ready'\nwhile :; do sleep 0.05; done`, 100);
    watch.kill();
    expect(await exitedWithin(watch, 3_000), "a process that ignores the request would hold its pane's view for good").toBe(true);
  }, 15_000);

  it.skipIf(!posix)("is killed outright too when its pane closed and it stays: the view that ended by itself still frees its place", async () => {
    // herdr says the terminal closed, and the process is asked to end as a pane's watch is; this one stays
    const closed = JSON.stringify({ type: "terminal.closed" });
    const { watch, ends } = await watching(`trap '' TERM\necho '${closed}'\ntouch 'ROOT_DIR/ready'\nwhile :; do sleep 0.05; done`, 100);
    expect(await exitedWithin(watch, 3_000)).toBe(true);
    expect(ends()).toBe(1);
  }, 15_000);

  it.skipIf(!posix)("still reads all a process wrote before it reports one that ended by itself", async () => {
    const data = JSON.stringify({ type: "terminal.frame", encoding: "ansi", bytes: Buffer.from("last words").toString("base64") });
    const frames: string[] = [];
    root = mkdtempSync(join(tmpdir(), "ovis-watch-kill-"));
    const bin = join(root, "herdr");
    writeFileSync(bin, `#!/bin/sh\necho '${data}'\nexit 3\n`);
    chmodSync(bin, 0o755);
    process.env["OVIS_HERDR_BIN"] = bin;
    let ends = 0;
    const watch = new PaneWatch({ paneId: "w1:p1", cols: 80, rows: 24, socketPath: join(root, "herdr.sock"), onFrame: (frame) => { frames.push(frame); }, onEnd: () => { ends += 1; } });
    expect(await exitedWithin(watch, 5_000)).toBe(true);
    expect([frames, ends]).toEqual([["last words"], 1]);
  }, 15_000);
});
