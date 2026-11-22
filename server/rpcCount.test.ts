import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, herdrRpcCountRequested, herdrRpcCounts, herdrRpcCountingForTests, subscribeEvents } from "./herdr/client.ts";

const dir = mkdtempSync(join(tmpdir(), "herdr-rpc-count-"));
const DEAD_SOCKET = join(dir, "no-such-herdr.sock");
const call = (method: string, socket = DEAD_SOCKET, guard?: () => boolean) => herdrRpc(method, {}, socket, 2000, guard);
const callDead = (method: string) => call(method).catch(() => undefined);

async function loadAlone(env: Record<string, string | undefined>, calls = 1) {
  const script = `const before = process.listenerCount("exit");
const client = await import(${JSON.stringify(join(import.meta.dir, "herdr", "client.ts"))});
const added = process.listenerCount("exit") - before;
for (let i = 0; i < ${calls}; i++) await client.herdrRpc("pane.read", {}, ${JSON.stringify(DEAD_SOCKET)}, 2000).catch(() => undefined);
console.log(JSON.stringify({ added, counts: client.herdrRpcCounts() }));
process.exit(0);`;
  const child = Bun.spawn([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe", timeout: 20_000 });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(0);
  const lines = stderr.split("\n").filter((line) => line.includes("\"herdr.rpc.counts\"")).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { ...(JSON.parse(stdout.trim()) as { added: number; counts: Record<string, number> }), lines };
}
const { HERDR_RPC_COUNT: _callerSetting, ...withoutSetting } = process.env;

afterEach(() => herdrRpcCountingForTests(false));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("herdr rpc counter", () => {
  it.each([
    [undefined, false], ["1", true], ["0", false], ["", false], ["true", false], [" 1", false], ["01", false], ["yes", false],
  ] as const)("HERDR_RPC_COUNT=%p turns it on: %p", (value, on) => {
    expect(herdrRpcCountRequested(value === undefined ? {} : { HERDR_RPC_COUNT: value })).toBe(on);
  });

  it("is off without HERDR_RPC_COUNT, whatever the caller's shell sets: nothing counted, no exit handler, no log line", async () => {
    expect(await loadAlone(withoutSetting)).toEqual({ added: 0, counts: {}, lines: [] });
  });

  it("with HERDR_RPC_COUNT=1, writes the tally as one log line when the process exits", async () => {
    const run = await loadAlone({ ...withoutSetting, HERDR_RPC_COUNT: "1" });
    expect(run.added).toBe(1);
    expect(run.counts).toEqual({ "pane.read": 1 });
    expect(run.lines).toEqual([{ time: expect.any(String), event: "herdr.rpc.counts", counts: { "pane.read": 1 } }]);
  });

  it("with HERDR_RPC_COUNT=1, a process that made no request (the plugin's supervisor) writes no line", async () => {
    expect(await loadAlone({ ...withoutSetting, HERDR_RPC_COUNT: "1" }, 0)).toEqual({ added: 1, counts: {}, lines: [] });
  });

  it("counts events.subscribe, the first subscription and a repeated one, like any other request", async () => {
    const socket = join(dir, "herdr-events.sock");
    const requests: string[] = [];
    const { promise: bothArrived, resolve } = Promise.withResolvers<void>();
    const stub = Bun.listen({ unix: socket, socket: { data(_socket, chunk) {
      requests.push(...chunk.toString().split("\n").filter(Boolean));
      if (requests.length === 2) resolve();
    } } });
    herdrRpcCountingForTests(true);
    const first = subscribeEvents([], { onEvent() {} }, socket);
    const again = subscribeEvents([], { onEvent() {} }, socket);
    try {
      await bothArrived;
      expect(requests.map((request) => (JSON.parse(request) as { method: string }).method)).toEqual(["events.subscribe", "events.subscribe"]);
      expect(herdrRpcCounts()).toEqual({ "events.subscribe": 2 });
    } finally {
      first.close();
      again.close();
      stub.stop(true);
    }
  });

  it("counts attempts, not successes: a call that fails is still tallied", async () => {
    herdrRpcCountingForTests(true);
    await callDead("session.snapshot");
    expect(herdrRpcCounts()).toEqual({ "session.snapshot": 1 });
  });

  it("counts a call refused by the guard before the request is written", async () => {
    const socket = join(dir, "herdr.sock");
    let received = 0;
    const stub = Bun.listen({ unix: socket, socket: { data() { received++; } } });
    try {
      herdrRpcCountingForTests(true);
      let asked = 0;
      await expect(call("pane.read", socket, () => { asked++; return false; })).rejects.toMatchObject({ code: "cancelled" });
      expect(asked).toBe(1);
      expect(received).toBe(0);
      expect(herdrRpcCounts()).toEqual({ "pane.read": 1 });
    } finally {
      stub.stop(true);
    }
  });

  it("tallies a known number of calls per method exactly", async () => {
    herdrRpcCountingForTests(true);
    await callDead("pane.read");
    await callDead("pane.read");
    await callDead("pane.read");
    await callDead("session.snapshot");
    expect(herdrRpcCounts()).toEqual({ "pane.read": 3, "session.snapshot": 1 });
  });

  it("hands back a copy: mutating the result cannot corrupt the tally", async () => {
    herdrRpcCountingForTests(true);
    await callDead("pane.read");
    const first = herdrRpcCounts();
    (first as { "pane.read": number })["pane.read"] = 999;
    expect(herdrRpcCounts()).toEqual({ "pane.read": 1 });
  });

  it("turning it back off discards the tally and stops counting", async () => {
    herdrRpcCountingForTests(true);
    await callDead("pane.read");
    herdrRpcCountingForTests(false);
    expect(herdrRpcCounts()).toEqual({});
    await callDead("pane.read");
    expect(herdrRpcCounts()).toEqual({});
  });
});
