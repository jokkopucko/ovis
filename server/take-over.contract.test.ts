import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, sessionSnapshot } from "./herdr/client.ts";
import { PtySession } from "./pty/session.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const realHerdr = process.env.OVIS_HERDR_BIN || Bun.which("herdr")!;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function until(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

type Step = { kind: "held" | "read-race" | "real" | "failed" | "taken"; gate?: string };
type Event = { type: string; attempt: number; pid: number; host: number; args: string[] };

/** A real server/socket/sidecar with file gates at the attach CLI boundary. */
async function fixture(steps: Step[], attachHoldMs?: number) {
  const root = mkdtempSync(join(tmpdir(), "herdr-takeover-race-"));
  const executable = join(root, "herdr.mjs");
  copyFileSync(join(import.meta.dir, "../scripts/fixtures/attach-sequence.mjs"), executable);
  chmodSync(executable, 0o700);
  writeFileSync(join(root, "plan.json"), JSON.stringify({ herdr: realHerdr, steps }));
  const events = (): Event[] => existsSync(join(root, "events.jsonl"))
    ? readFileSync(join(root, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const previous = { binary: process.env.OVIS_HERDR_BIN, dir: process.env.HERDR_ATTACH_TEST_DIR };
  process.env.OVIS_HERDR_BIN = executable;
  process.env.HERDR_ATTACH_TEST_DIR = root;
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "ovis-test-takeover-race", cwd: root, focus: false },
  );
  const paneId = created.root_pane.pane_id;
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), attachHeldRetryMs: 80, attachRelookupForMs: 400, attachHoldMs });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  const frames: ServerMessage[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  cleanups.push(async () => {
    ws.close(); server.stop();
    // A failing pre-fix test can orphan an attach: clean up every PID this fixture recorded.
    const pids = events().filter((e) => e.type === "start" || e.type === "child").map((e) => e.pid);
    for (const pid of pids) if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    await until(() => pids.every((pid) => !alive(pid)), "owned attach processes stopped");
    await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id });
    for (const [key, value] of [["OVIS_HERDR_BIN", previous.binary], ["HERDR_ATTACH_TEST_DIR", previous.dir]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  await until(() => ws.readyState === WebSocket.OPEN, "socket open");
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const barrier = async () => {
    const count = frames.filter((m) => m.type === "role-ack").length;
    send({ type: "role", mode: "interact" });
    await until(() => frames.filter((m) => m.type === "role-ack").length > count, "preceding socket requests handled");
  };
  send({ type: "attach", pane_id: paneId, cols: 100, rows: 30 });
  return { root, paneId, server, ws, frames, events, send, barrier,
    release: (gate: string) => writeFileSync(join(root, gate), "go"),
    starts: () => events().filter((e) => e.type === "start"),
  };
}

describe("explicit take-over intent", () => {
  it("consumes a click when the running ordinary retry succeeds, before later displacement", async () => {
    // displaced, the attach prints herdr's "taken over" and then exits: a hold far longer than that
    // exit keeps a busy runner from passing the line on before the exit comes
    const f = await fixture([{ kind: "held" }, { kind: "real", gate: "attach" }, { kind: "held" }], 2_000);
    await until(() => f.starts().length === 2, "ordinary retry held at its gate");
    f.send({ type: "take-over", pane_id: f.paneId });
    await f.barrier();
    f.release("attach");
    await until(() => f.frames.some((m) => m.type === "attach-resumed"), "ordinary retry succeeds");
    const snapshot = await sessionSnapshot();
    const terminalId = snapshot.panes.find((p) => p.pane_id === f.paneId)!.terminal_id;
    const other = new PtySession({ command: realHerdr, args: ["terminal", "attach", terminalId, "--takeover"],
      cols: 100, rows: 30, env: { HERDR_SOCKET_PATH: process.env.HERDR_SOCKET! }, onData() {}, onExit() {} });
    cleanups.push(async () => { other.kill(); await other.exited; });
    await until(() => f.starts().length >= 3, "displaced bridge retries");
    expect(f.frames.filter((m) => m.type === "pty-data").map((m) => m.data).join("")).not.toContain("terminal attach taken over");
    expect(f.starts().slice(2).map((e) => e.args.includes("--takeover"))).toEqual([false]);
  }, 20_000);

  it("drops a click when the attempt it waited on attaches and is displaced before it settles", async () => {
    // a hold far longer than the fixture's exit: the attach is displaced before it settles, every run
    const f = await fixture([{ kind: "held" }, { kind: "taken", gate: "attach" }, { kind: "real" }], 5_000);
    await until(() => f.starts().length === 2, "ordinary retry held at its gate");
    f.send({ type: "take-over", pane_id: f.paneId });
    await f.barrier();
    f.release("attach");
    await until(() => f.starts().length === 3, "displaced bridge tries again");
    expect(f.frames.some((m) => m.type === "attach-resumed")).toBe(false);
    expect(f.starts()[2]!.args).not.toContain("--takeover");
  }, 20_000);

  it("keeps another client's click when the clicker of a running takeover turns to observe", async () => {
    const f = await fixture([{ kind: "held" }, { kind: "held", gate: "retry" }, { kind: "read-race", gate: "read" }, { kind: "real" }]);
    await until(() => f.starts().length === 2, "ordinary retry held at its gate");
    const other = new WebSocket(`ws://127.0.0.1:${f.server.port}/ws`);
    const seen: ServerMessage[] = [];
    other.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
    cleanups.push(() => other.close());
    await until(() => other.readyState === WebSocket.OPEN, "second client open");
    other.send(JSON.stringify({ type: "attach", pane_id: f.paneId, cols: 100, rows: 30 }));
    other.send(JSON.stringify({ type: "role", mode: "interact" }));
    await until(() => seen.some((m) => m.type === "role-ack"), "second client attached");
    f.send({ type: "take-over", pane_id: f.paneId });
    await f.barrier();
    f.release("retry");
    await until(() => f.starts().length === 3, "the first client's takeover attempt");
    expect(f.starts()[2]!.args).toContain("--takeover");
    other.send(JSON.stringify({ type: "take-over", pane_id: f.paneId }));
    other.send(JSON.stringify({ type: "role", mode: "interact" }));
    await until(() => seen.filter((m) => m.type === "role-ack").length === 2, "second client clicked");
    f.send({ type: "role", mode: "observe" });
    await until(() => f.frames.some((m) => m.type === "role-ack" && m.mode === "observe"), "first client observes");
    f.release("read");
    await until(() => f.starts().length === 4, "attempt after the read race");
    expect(f.starts()[3]!.args).toContain("--takeover");
  }, 20_000);

  it("drops a click whose clicker turns to observe before the deferred attempt", async () => {
    const f = await fixture([{ kind: "held" }, { kind: "held", gate: "retry" }, { kind: "real" }]);
    await until(() => f.starts().length === 2, "ordinary retry held at its gate");
    f.send({ type: "take-over", pane_id: f.paneId });
    f.send({ type: "role", mode: "observe" });
    await until(() => f.frames.some((m) => m.type === "role-ack" && m.mode === "observe"), "clicker observes");
    f.release("retry");
    await until(() => f.starts().length === 3, "next attempt");
    expect(f.starts()[2]!.args).not.toContain("--takeover");
  }, 20_000);

  it("drops a click whose clicker leaves while another client still watches", async () => {
    const f = await fixture([{ kind: "held" }, { kind: "held", gate: "retry" }, { kind: "real" }]);
    await until(() => f.starts().length === 2, "ordinary retry held at its gate");
    const watcher = new WebSocket(`ws://127.0.0.1:${f.server.port}/ws`);
    const seen: ServerMessage[] = [];
    watcher.addEventListener("message", (e) => seen.push(JSON.parse(String(e.data))));
    cleanups.push(() => watcher.close());
    await until(() => watcher.readyState === WebSocket.OPEN, "watcher open");
    watcher.send(JSON.stringify({ type: "role", mode: "observe" }));
    watcher.send(JSON.stringify({ type: "attach", pane_id: f.paneId, cols: 100, rows: 30 }));
    watcher.send(JSON.stringify({ type: "role", mode: "observe" }));
    await until(() => seen.filter((m) => m.type === "role-ack").length === 2, "watcher attached");
    f.send({ type: "take-over", pane_id: f.paneId });
    f.send({ type: "detach", pane_id: f.paneId });
    await f.barrier();
    f.release("retry");
    await until(() => f.starts().length === 3, "the watcher's next attempt");
    expect(f.starts()[2]!.args).not.toContain("--takeover");
  }, 20_000);

  it("cancels a read-race backoff before a click starts the next attach", async () => {
    const f = await fixture([{ kind: "held" }, ...Array.from({ length: 4 }, () => ({ kind: "read-race" as const })), { kind: "real" }]);
    await until(() => {
      const last = f.starts()[4];
      return !!last && !alive(last.host);
    }, "fourth read-race sidecar exited, leaving its backoff");
    await f.barrier();
    f.send({ type: "take-over", pane_id: f.paneId });
    await until(() => f.frames.some((m) => m.type === "attach-resumed"), "clicked attach succeeds");
    const deadline = Date.now() + 700;
    await until(() => {
      expect(f.starts()).toHaveLength(6);
      return Date.now() >= deadline;
    }, "the cancelled backoff never starts another attach");
    expect(f.starts()[5]!.args).toContain("--takeover");
    f.send({ type: "detach", pane_id: f.paneId });
    await until(() => f.events().filter((e) => e.type === "child").every((e) => !alive(e.pid)), "last detach releases its attach");
  }, 20_000);

  it("keeps an explicit request through a read race and coalesces repeated clicks", async () => {
    const f = await fixture([{ kind: "held" }, { kind: "read-race", gate: "read" }, { kind: "real" }]);
    await until(() => f.starts().length === 2, "retry running");
    for (let click = 0; click < 3; click++) f.send({ type: "take-over", pane_id: f.paneId });
    await f.barrier();
    f.release("read");
    await until(() => f.frames.some((m) => m.type === "attach-resumed"), "explicit request survives the read race");
    expect(f.starts()).toHaveLength(3);
    expect(f.starts()[2]!.args).toContain("--takeover");
    f.send({ type: "detach", pane_id: f.paneId });
    await until(() => f.events().filter((e) => e.type === "child").every((e) => !alive(e.pid)), "detach cleans up the only attach");
  }, 20_000);

  it("cancels a requested takeover when its last client detaches during an attempt", async () => {
    const f = await fixture([{ kind: "held" }, { kind: "real", gate: "attach" }]);
    await until(() => f.starts().length === 2, "retry running");
    f.send({ type: "take-over", pane_id: f.paneId });
    f.send({ type: "detach", pane_id: f.paneId });
    await f.barrier();
    await until(() => !alive(f.starts()[1]!.host), "pending sidecar cancelled");
    f.release("attach");
    const deadline = Date.now() + 250;
    await until(() => {
      expect(f.starts()).toHaveLength(2);
      expect(f.events().some((e) => e.type === "child")).toBe(false);
      return Date.now() >= deadline;
    }, "no late takeover after detach");
  }, 20_000);

  it("recovers an ordinary failure without turning a click during its terminal lookup into takeover", async () => {
    // a hold far longer than the fixture's exit: a busy runner must not take the failing attempt's
    // last line for an attach before its exit comes (the recovered attach waits it out as well)
    const f = await fixture([{ kind: "held" }, { kind: "failed", gate: "fail" }, { kind: "real" }], 2_000);
    await until(() => f.starts().length === 2, "retry running");
    f.send({ type: "take-over", pane_id: f.paneId });
    await f.barrier();
    f.release("fail");
    await until(() => !alive(f.starts()[1]!.host), "failed sidecar exited");
    await f.barrier();
    f.send({ type: "take-over", pane_id: f.paneId });
    await until(() => f.frames.some((m) => m.type === "attach-resumed"), "ordinary recovery attaches again");
    expect(f.starts()).toHaveLength(3);
    expect(f.starts()[2]!.args).not.toContain("--takeover");
    expect(f.frames.some((m) => m.type === "pty-exit")).toBe(false);
    expect(f.frames.filter((m) => m.type === "pty-data").map((m) => m.data).join("")).toContain("terminal attach taken over");
    f.send({ type: "detach", pane_id: f.paneId });
    await until(() => f.events().filter((e) => e.type === "child").every((e) => !alive(e.pid)), "detach releases recovered attach");
  }, 20_000);
});
