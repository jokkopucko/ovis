import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirrorFrame } from "../mirror.ts";
import { connectionData, type Client } from "./connections.ts";
import { createTerminalRegistry } from "./terminals.ts";

type Frame = Record<string, unknown> & { type: string };

let root: string;
let previousSocket: string | undefined;
let listener: ReturnType<typeof Bun.listen<{ buffer: string }>>;
let reads: AsyncIterator<(text: string) => void>;
const nextRead = async () => (await reads.next()).value as (text: string) => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-terminal-mirror-"));
  previousSocket = process.env.HERDR_SOCKET;
  process.env.HERDR_SOCKET = join(root, "herdr.sock");
  const queued: ((text: string) => void)[] = [];
  let waiting: ((answer: (text: string) => void) => void) | null = null;
  reads = {
    next: () => new Promise((resolve) => {
      const done = (value: (text: string) => void) => resolve({ value, done: false });
      const ready = queued.shift();
      if (ready) done(ready);
      else waiting = done;
    }),
  };
  listener = Bun.listen<{ buffer: string }>({
    unix: process.env.HERDR_SOCKET,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, data) {
        socket.data.buffer += data.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer);
        const answer = (result: unknown) => socket.end(JSON.stringify({ id: request.id, result }) + "\n");
        if (request.method === "session.snapshot") {
          answer({ snapshot: {
            panes: [{ pane_id: "p", terminal_id: "t" }],
            layouts: [{ panes: [{ pane_id: "p", rect: { width: 80, height: 24 } }] }],
          } });
        } else if (request.method === "pane.read") {
          const reply = (text: string) => answer({ read: { text } });
          if (waiting) { const take = waiting; waiting = null; take(reply); }
          else queued.push(reply);
        } else throw new Error(`unexpected RPC ${request.method}`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (previousSocket === undefined) delete process.env.HERDR_SOCKET;
  else process.env.HERDR_SOCKET = previousSocket;
  rmSync(root, { recursive: true, force: true });
});

function recorder(onMessage?: (frame: Frame) => void, readOnly = false) {
  const frames: Frame[] = [];
  const grids: Frame[] = [];
  const waiters: { count: number; done: () => void }[] = [];
  const client = {
    data: connectionData({ deviceId: undefined, readOnly }),
    readyState: WebSocket.OPEN,
    getBufferedAmount: () => 0,
    send(raw: string) {
      const frame = JSON.parse(raw) as Frame;
      onMessage?.(frame);
      if (frame.type === "pane-geometry") grids.push(frame);
      if (frame.type === "pty-data") frames.push(frame);
      for (const waiter of waiters.filter((entry) => frames.length >= entry.count)) waiter.done();
      return raw.length;
    },
    close() {},
  };
  const until = (count: number): Promise<Frame[]> => {
    if (frames.length >= count) return Promise.resolve(frames);
    const arrived = Promise.withResolvers<Frame[]>();
    const timer = setTimeout(() => arrived.reject(new Error(`pty-data frame ${count} did not arrive`)), 5000);
    waiters.push({ count, done: () => { clearTimeout(timer); arrived.resolve(frames); } });
    return arrived.promise;
  };
  return { client, frames, grids, until };
}

function registryFor(clients: Client[], nativeControl?: (socket: string) => Promise<string | null>, holdPending = (_client: Client, _pane?: string) => {}, retryFor = 0) {
  return createTerminalRegistry({
    options: {}, clients: new Set(clients), stopped: () => false,
    terminalAttach: async () => false, nativeControl,
    holdFor: 0, heldRetry: 0, retryFor, relookupFor: 0,
    holdPending, holdPendingPane() {}, attached() {}, inputReady() {}, end() {},
  });
}

const attach = { type: "attach", pane_id: "p", cols: 80, rows: 24, flow_control: "ack" } as const;

it.skipIf(process.platform === "win32")("recovers Windows fit after more than two history read refusals", async () => {
  const command = join(root, "busy-control");
  writeFileSync(command, `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const log = import.meta.path + ".attempts";
const count = existsSync(log) ? readFileSync(log, "utf8").length : 0;
appendFileSync(log, ".");
if (count < 3) {
  console.log(JSON.stringify({type:"terminal.closed",reason:"terminal attach failed: terminal t has a read in progress; retry"}));
  process.exit(0);
}
console.log(JSON.stringify({type:"terminal.frame",full:true,width:80,height:24,encoding:"ansi",bytes:"QQ=="}));
for await (const _ of console) {}
`, { mode: 0o700 });
  const result = Promise.withResolvers<Frame>();
  const owner = recorder(frame => {
    if (frame.code === "input_not_ready" || (frame.type === "input-ready" && frame.ready !== false)) result.resolve(frame);
  });
  const registry = registryFor([owner.client], async () => command, undefined, 2_000);
  try {
    await registry.terminalFrames.attach(owner.client, { ...attach, windows_fit: true });
    expect((await result.promise).type).toBe("input-ready");
    expect(registry.sight(owner.client, "p").facts().ready).toBe(true);
    expect(readFileSync(`${command}.attempts`, "utf8")).toBe("....");
  } finally { registry.closeAttachments(); }
});

it.skipIf(process.platform === "win32")("delivers accepted fit input before an explicit detach gives up the slot", async () => {
  const command = join(root, "draining-control");
  writeFileSync(command, `#!${process.execPath}
import { appendFileSync } from "node:fs";
console.log(JSON.stringify({type:"terminal.frame",full:true,width:80,height:24,encoding:"ansi",bytes:"QQ=="}));
if (process.argv.includes("80")) {
  const input = [];
  for await (const line of console) {
    const frame = JSON.parse(line);
    if (frame.type === "terminal.input") input.push(frame.text);
    if (frame.type === "terminal.release") {
      appendFileSync(import.meta.path + ".typed", input.join(""));
      process.exit(0);
    }
  }
} else for await (const _ of console) {}
`, { mode: 0o700 });
  const owner = recorder(), waiting = recorder();
  const registry = registryFor([owner.client, waiting.client], async () => command);
  const frames = registry.terminalFrames;
  try {
    await frames.attach(owner.client, { ...attach, windows_fit: true });
    await owner.until(1);
    await frames.attach(waiting.client, { ...attach, cols: 65, windows_fit: true });
    expect(registry.sight(owner.client, "p").write("accepted")).toBe(true);
    frames.detach(owner.client, { type: "detach", pane_id: "p" });
    await waiting.until(2);
    expect(readFileSync(`${command}.typed`, "utf8")).toBe("accepted");
  } finally { registry.closeAttachments(); }
});

it.skipIf(process.platform === "win32")("explains why a fixed-size viewer cannot type after an uncertain controller exit", async () => {
  const command = join(root, "lost-control");
  writeFileSync(command, `#!${process.execPath}
console.log(JSON.stringify({type:"terminal.frame",full:true,width:80,height:24,encoding:"ansi",bytes:"QQ=="}));
for await (const _ of console) process.exit(1);
`, { mode: 0o700 });
  const notices: Frame[] = [];
  const owner = recorder(), fixed = recorder(frame => { if (frame.type === "error") notices.push(frame); });
  let leaving = false;
  const registry = registryFor([owner.client, fixed.client], async () => command, client => {
    if (client !== owner.client || !leaving) return;
    leaving = false;
    queueMicrotask(() => registry.terminalFrames.detach(owner.client, { type: "detach", pane_id: "p" }));
  });
  try {
    await registry.terminalFrames.attach(owner.client, { ...attach, windows_fit: true });
    await owner.until(1);
    (await nextRead())("retired screen");
    await registry.terminalFrames.attach(fixed.client, { ...attach, keep_size: true });
    await fixed.until(1);
    leaving = true;
    expect(registry.sight(owner.client, "p").write("end control")).toBe(true);
    (await nextRead())("fixed mirror still live");
    expect((await fixed.until(2))[1]?.data).toContain("fixed mirror still live");
    expect(registry.sight(fixed.client, "p").write("not safe to send")).toBe(false);
    expect(notices).toEqual([expect.objectContaining({ code: "input_not_ready", pane_id: "p" })]);
  } finally { registry.closeAttachment("p"); }
});

it.skipIf(process.platform === "win32")("keeps a legacy observer's screen ready when a Windows controller joins", async () => {
  const command = join(root, "observe-control");
  writeFileSync(command, `#!${process.execPath}
console.log(JSON.stringify({type:"terminal.frame",full:true,width:80,height:24,encoding:"ansi",bytes:"Y29udHJvbGxlZCBzY3JlZW4="}));
for await (const _ of console) {}
`, { mode: 0o700 });
  const readiness: Frame[] = [];
  const viewer = recorder(frame => { if (frame.type === "input-ready") readiness.push(frame); }, true);
  const ownerOrder: string[] = [];
  const owner = recorder(frame => {
    if (frame.type === "input-ready") ownerOrder.push(frame.ready === false ? "pending" : "ready");
    if (frame.type === "pane-geometry" && frame.fixed === false) ownerOrder.push("grid");
    if (frame.type === "pty-data") ownerOrder.push("screen");
  });
  const registry = registryFor([viewer.client, owner.client], async () => command);
  try {
    await registry.terminalFrames.attach(viewer.client, attach);
    (await nextRead())("fixed screen");
    await viewer.until(1);
    await registry.terminalFrames.attach(owner.client, { ...attach, windows_fit: true });
    expect((await viewer.until(2))[1]?.data).toBe("controlled screen");
    expect(readiness).toEqual([{ type: "input-ready", pane_id: "p" }]);
    expect(ownerOrder).toEqual(["pending", "grid", "ready", "screen"]);
    expect(registry.sight(viewer.client, "p").write("observer input")).toBe(false);
  } finally { registry.closeAttachment("p"); }
});

it.skipIf(process.platform === "win32")("claims Windows fit after an external holder leaves without another action or takeover", async () => {
  const command = join(root, "external-control");
  writeFileSync(command, `#!${process.execPath}
import { existsSync, writeFileSync } from "node:fs";
const attempted = import.meta.path + ".attempted";
if (process.argv.includes("--takeover")) process.exit(2);
if (!existsSync(attempted)) {
  writeFileSync(attempted, "");
  console.log(JSON.stringify({type:"terminal.closed",reason:"already has an attached client"}));
  process.exit(0);
}
console.log(JSON.stringify({type:"terminal.frame",full:true,width:80,height:24,encoding:"ansi",bytes:"QQ=="}));
for await (const _ of console) {}
`, { mode: 0o700 });
  const status: string[] = [];
  const viewer = recorder(frame => {
    if (frame.code === "attach_held") status.push("held");
    if (frame.type === "attach-resumed") status.push("resumed");
  });
  const registry = registryFor([viewer.client], async () => command);
  try {
    await registry.terminalFrames.attach(viewer.client, { ...attach, windows_fit: true });
    await viewer.until(1);
    expect(viewer.grids.at(-1)).toMatchObject({ fixed: false, windows_fit: true });
    expect(status).toEqual(["held", "resumed"]);
  } finally { registry.closeAttachment("p"); }
});

it.skipIf(process.platform === "win32")("gives a late passive viewer a full fixed mirror when the controller's replay lost the screen", async () => {
  const command = join(root, "large-control");
  writeFileSync(command, `#!${process.execPath}
console.log(JSON.stringify({type:"terminal.frame",full:true,width:80,height:24,encoding:"ansi",bytes:Buffer.from("A".repeat(160000)).toString("base64")}));
for await (const _ of console) {}
`, { mode: 0o700 });
  const owner = recorder(), watcher = recorder();
  const registry = registryFor([owner.client, watcher.client], async () => command);
  try {
    await registry.terminalFrames.attach(owner.client, { ...attach, windows_fit: true });
    await owner.until(1);
    // Discard the mirror read the controller's initial grant superseded.
    (await nextRead())("retired screen");
    await registry.terminalFrames.attach(watcher.client, { ...attach, keep_size: true });
    expect(watcher.frames).toEqual([]);
    (await nextRead())("complete passive screen");
    const passive = await watcher.until(1);
    expect(passive[0]?.data).toContain("complete passive screen");
    expect(owner.frames).toHaveLength(1);
  } finally { registry.closeAttachment("p"); }
});

it.skipIf(process.platform === "win32")("invalidates deferred input across a Windows fit grant, release and new owner; resize alone cannot obtain a grant", async () => {
  const command = join(root, "control");
  writeFileSync(command, `#!${process.execPath}
if (process.argv.includes("--takeover")) process.exit(1);
const size = (flag) => Number(process.argv[process.argv.indexOf(flag) + 1]);
console.log(JSON.stringify({type:"terminal.frame",full:true,width:size("--cols"),height:size("--rows"),encoding:"ansi",bytes:"QQ=="}));
for await (const _ of console) {}
`, { mode: 0o700 });
  const resumedMirror = Promise.withResolvers<void>();
  const a = recorder(), b = recorder(frame => {
    if (frame.type === "input-ready" && frame.ready !== false && registry.sight(b.client, "p").facts().mirror) resumedMirror.resolve();
  });
  const registry = registryFor([a.client, b.client], async () => command);
  const f = registry.terminalFrames;
  const claim = { ...attach, windows_fit: true };
  try {
    await f.attach(a.client, { ...claim, keep_size: true });
    const idle = registry.sight(a.client, "p");
    await f.resize(a.client, { type: "resize", pane_id: "p", cols: 42, rows: 14 });
    expect(registry.sight(a.client, "p").facts().mirror).toBe(true);
    await f.attach(a.client, claim);
    await a.until(1);
    const owned = registry.sight(a.client, "p");
    expect(owned.facts().ready).toBe(true);
    a.grids.length = 0;
    await f.attach(a.client, claim);
    expect(a.grids).toContainEqual({ type: "pane-geometry", pane_id: "p", cols: 80, rows: 24, fixed: false, windows_fit: true });
    expect(idle.facts().samePty).toBe(false);
    expect(idle.write("stale mirror")).toBe(false);
    await f.attach(b.client, claim);
    expect(registry.sight(b.client, "p").facts().currentHeld).toBe(true);
    await f.resize(b.client, { type: "resize", pane_id: "p", cols: 44, rows: 15 });
    expect(a.grids.at(-1)).toMatchObject({ cols: 80, rows: 24, fixed: false });
    f["take-over"](b.client, { type: "take-over", pane_id: "p" });
    await b.until(2);
    expect(b.grids.at(-1)).toMatchObject({ cols: 44, rows: 15, fixed: false });
    expect(owned.facts().samePty).toBe(false);
    expect(owned.write("retired")).toBe(false);
    const second = registry.sight(b.client, "p");
    expect(second.facts().ready).toBe(true);
    f.detach(a.client, { type: "detach", pane_id: "p" });
    registry.releaseFit(b.client);
    expect(second.write("demoted")).toBe(false);
    await resumedMirror.promise;
    await f.resize(b.client, { type: "resize", pane_id: "p", cols: 42, rows: 14 });
    expect(registry.sight(b.client, "p").facts()).toMatchObject({ mirror: true, ready: true });
  } finally { registry.closeAttachment("p"); }
});

it.skipIf(process.platform === "win32")("retries an unconfirmed failure and hands a released lease to a waiting viewer without takeover", async () => {
  const command = join(root, "flaky-control");
  writeFileSync(command, `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
const log = import.meta.path + ".attempts", first = !existsSync(log);
appendFileSync(log, process.argv.includes("--takeover") ? "takeover\\n" : "ordinary\\n");
if (first) process.exit(1);
if (process.argv.includes("51")) {
  console.log(JSON.stringify({type:"terminal.closed",reason:"already has an attached client"}));
  process.exit(0);
}
console.log(JSON.stringify({type:"terminal.frame",full:true,width:80,height:24,encoding:"ansi",bytes:"QQ=="}));
for await (const _ of console) process.exit(1);
`, { mode: 0o700 });
  const resumed = Promise.withResolvers<void>();
  const a = recorder(), b = recorder(frame => { if (frame.type === "attach-resumed") resumed.resolve(); });
  let refusals = 0;
  const externalHeld = Promise.withResolvers<void>();
  const c = recorder(frame => {
    if (frame.code === "attach_held" && ++refusals === 2) externalHeld.resolve();
  });
  let leaveDuringRetirement = false;
  const registry = registryFor([a.client, b.client, c.client], async () => command, client => {
    if (client === a.client && leaveDuringRetirement) {
      leaveDuringRetirement = false;
      queueMicrotask(() => registry.terminalFrames.detach(a.client, { type: "detach", pane_id: "p" }));
    }
  });
  const claim = { ...attach, windows_fit: true };
  try {
    await registry.terminalFrames.attach(a.client, claim);
    await a.until(1);
    expect(registry.sight(a.client, "p").facts().ready).toBe(true);
    expect(registry.sight(a.client, "p").write("end recovered session")).toBe(true);
    await a.until(2);
    await registry.terminalFrames.attach(b.client, claim);
    expect(registry.sight(b.client, "p").write("held")).toBe(false);
    leaveDuringRetirement = true;
    expect(registry.sight(a.client, "p").write("end before owner leaves")).toBe(true);
    await resumed.promise;
    expect(registry.sight(b.client, "p").facts()).toMatchObject({ ready: true, currentHeld: false, mirror: false });
    await registry.terminalFrames.attach(c.client, { ...claim, cols: 51 });
    registry.terminalFrames.detach(b.client, { type: "detach", pane_id: "p" });
    await externalHeld.promise;
    expect(registry.sight(c.client, "p").write("external holder")).toBe(false);
    expect(readFileSync(`${command}.attempts`, "utf8").trim().split("\n")).toEqual(Array(5).fill("ordinary"));
  } finally { registry.closeAttachment("p"); }
});

it("marks a mirror's first screen as replay for a client that attached before it was read", async () => {
  const first = recorder(), joiner = recorder();
  const registry = registryFor([first.client, joiner.client]);
  try {
    await registry.terminalFrames.attach(first.client, attach);
    const answerFirst = await nextRead();
    expect(first.frames).toEqual([]);
    answerFirst("retained screen");
    const [initial] = await first.until(1);
    expect(initial!.data).toBe(mirrorFrame("retained screen", 24));
    expect(initial!.replay).toBe(true);
    expect((initial!.flow as { offset: number }).offset).toBe(Buffer.byteLength(String(initial!.data)));

    await registry.terminalFrames.attach(joiner.client, attach);
    const [joined] = await joiner.until(1);
    expect(joined!.data).toBe(initial!.data);
    expect(joined!.replay).toBe(true);

    (await nextRead())("live screen");
    const [, live] = await first.until(2);
    const [, liveJoined] = await joiner.until(2);
    for (const [frame, before] of [[live!, initial!], [liveJoined!, joined!]] as const) {
      expect(frame.replay).toBeUndefined();
      expect((frame.flow as { offset: number }).offset)
        .toBe(Buffer.byteLength(String(before.data)) + Buffer.byteLength(String(frame.data)));
    }
  } finally {
    registry.closeAttachment("p");
    registry.conversations.stop();
  }
});

it("does not carry a pending first-screen mark into a later attach of a client that left", async () => {
  const leaver = recorder(), stayer = recorder();
  const registry = registryFor([leaver.client, stayer.client]);
  try {
    await registry.terminalFrames.attach(leaver.client, attach);
    await registry.terminalFrames.attach(stayer.client, attach);
    const answerFirst = await nextRead();
    registry.terminalFrames.detach(leaver.client, { type: "detach", pane_id: "p" });
    answerFirst("retained screen");
    const [initial] = await stayer.until(1);
    expect(initial!.replay).toBe(true);
    expect(leaver.frames).toEqual([]);

    await registry.terminalFrames.attach(leaver.client, attach);
    (await nextRead())("live screen");
    const [replayed, live] = await leaver.until(2);
    expect(replayed!.replay).toBe(true);
    expect(live!.replay).toBeUndefined();
  } finally {
    registry.closeAttachment("p");
    registry.conversations.stop();
  }
});
