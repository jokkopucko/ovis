import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, paneSendText, paneSendKeys } from "./herdr/client.ts";
import { nodeSidecarAvailable } from "./pty/sidecar.ts";
import { OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_STALL_MS } from "./output-window.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import type { ClientMessage, ServerMessage } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-output-contract-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
const workspaces: string[] = [];
const sockets: WebSocket[] = [];
afterAll(async () => {
  for (const socket of sockets) socket.close();
  server.stop();
  for (const workspace of workspaces) await herdrRpc("workspace.close", { workspace_id: workspace });
  rmSync(root, { recursive: true, force: true });
});

async function until(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}

async function pane(): Promise<string> {
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>(
    "workspace.create", { label: "ovis-test-output", cwd: root, focus: false },
  );
  workspaces.push(created.workspace.workspace_id);
  return created.root_pane.pane_id;
}

async function connect(paneId: string, ack = true, observer = false, port = server.port, find = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const state = {
    bytes: 0, frames: 0, ack, code: 0, exits: 0, ready: 0, notReady: 0,
    latest: undefined as Extract<ServerMessage, { type: "pty-data" }> | undefined,
    errors: [] as string[], tail: "",
    /** the first frame's text (a joiner's replay), and whether `find` has arrived since the attach */
    first: undefined as string | undefined, find, found: false,
  };
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const acknowledge = (frame = state.latest) => {
    if (frame?.flow && ws.readyState === WebSocket.OPEN) send({ type: "pty-ack", pane_id: paneId, ...frame.flow });
  };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as ServerMessage;
    if (frame.type === "error") state.errors.push(frame.code);
    if (frame.type === "pty-exit" && frame.pane_id === paneId) state.exits++;
    if (frame.type === "input-ready" && frame.pane_id === paneId) frame.ready === false ? state.notReady++ : state.ready++;
    if (frame.type !== "pty-data" || frame.pane_id !== paneId) return;
    state.bytes += Buffer.byteLength(frame.data);
    state.frames++;
    state.latest = frame;
    state.first ??= frame.data;
    if (state.find && (state.tail.slice(-state.find.length) + frame.data).includes(state.find)) state.found = true;
    state.tail = (state.tail + frame.data).slice(-8192);
    if (state.ack) acknowledge(frame);
  });
  ws.addEventListener("close", (event) => { state.code = event.code; });
  await until(() => ws.readyState === WebSocket.OPEN, "socket open");
  if (observer) send({ type: "role", mode: "observe" });
  send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
  await until(() => state.frames > 0, "initial terminal paint");
  return { ws, state, send, acknowledge };
}

/**
 * Makes the pty spawn fail on both hosts (herdr itself stays found). The Rust host is picked by
 * absolute path, so it is pointed at one that does not exist. The Node sidecar it falls back to finds
 * no Node, so the attach throws before spawning: none on PATH, and an empty HOME hides the one
 * install.sh puts under ~/.local/share. Node's availability is taken first, so a run on the Rust host
 * does not cache it as missing for the tests after this one.
 */
function breakPath(): () => void {
  nodeSidecarAvailable();
  const previous = process.env["PATH"];
  const previousHome = process.env["HOME"];
  const previousHerdr = process.env["OVIS_HERDR_BIN"];
  const previousHost = process.env["OVIS_PTY_SIDECAR_BIN"];
  process.env["OVIS_HERDR_BIN"] = Bun.which(previousHerdr || "herdr", { PATH: previous ?? "" }) ?? previousHerdr ?? "herdr";
  process.env["OVIS_PTY_SIDECAR_BIN"] = "/nonexistent/ovis-pty-sidecar";
  process.env["HOME"] = mkdtempSync(join(root, "home-"));
  process.env["PATH"] = "/nonexistent";
  return () => {
    process.env["PATH"] = previous;
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    if (previousHerdr === undefined) delete process.env["OVIS_HERDR_BIN"];
    else process.env["OVIS_HERDR_BIN"] = previousHerdr;
    if (previousHost === undefined) delete process.env["OVIS_PTY_SIDECAR_BIN"];
    else process.env["OVIS_PTY_SIDECAR_BIN"] = previousHost;
  };
}

const FLOOD = `python3 -u -c 'import sys,time; [(sys.stdout.write("\\033[H"+(str(i%10)*79+"\\n")*23),sys.stdout.flush(),time.sleep(.01)) for i in range(1500)]'`;

async function flood(paneId: string, command = FLOOD): Promise<void> {
  // Redraws reach the attach stream; raw shell byte rate alone is not its workload.
  await Bun.sleep(150); // herdr's attach consumes very early keystrokes
  await paneSendText(paneId, command);
  await paneSendKeys(paneId, ["Enter"]);
}

describe("real terminal output flow control", () => {
  it("waits for the old attach to retire when a pane is reopened immediately", async () => {
    const paneId = await pane();
    const client = await connect(paneId);
    try {
      const old = client.state.latest!.flow!;
      client.send({ type: "detach", pane_id: paneId });
      client.send({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" });
      await until(() => !!client.state.latest?.flow && client.state.latest.flow.stream_id !== old.stream_id, "fresh attach after retirement");
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: old.stream_id, offset: Number.MAX_SAFE_INTEGER });
      await Bun.sleep(100);
      expect(client.state.errors).toEqual([]);
      expect(client.state.exits).toBe(0);
      expect(client.state.code).toBe(0);
    } finally { client.ws.close(); }
  }, 20_000);

  it("bounds a stalled observer, releases the operator, and leaves the pane alive", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    const observer = await connect(paneId, false, true);
    try {
      await flood(paneId);
      await until(() => observer.state.bytes >= OUTPUT_HIGH_BYTES, "observer high watermark", 15_000);
      const started = Date.now();
      await until(() => observer.state.code !== 0, "stalled observer closed", OUTPUT_STALL_MS + 3000);
      expect(observer.state.code).toBe(OUTPUT_STALLED_CLOSE_CODE);
      expect(observer.state.bytes).toBeLessThanOrEqual(OUTPUT_HARD_BYTES);
      expect(Date.now() - started).toBeLessThan(OUTPUT_STALL_MS + 2000);
      const received = operator.state.bytes;
      await until(() => operator.state.bytes > received + 4096, "operator output resumes");
      // Ctrl+C takes the actual WS input path while output is running.
      operator.send({ type: "input", pane_id: paneId, text: "\x03" });
      await Bun.sleep(200);
      operator.send({ type: "input", pane_id: paneId, text: "printf 'FLOW_%s\\n' ALIVE\r" });
      await until(() => operator.state.tail.includes("FLOW_ALIVE"), "pane survives observer eviction");
      expect(operator.state.code).toBe(0);
      expect(operator.state.errors).toEqual([]);
    } finally { operator.ws.close(); observer.ws.close(); }
  }, 35_000);

  it("gives a late joiner time to acknowledge its replay without pausing the operator", async () => {
    const paneId = await pane();
    const operator = await connect(paneId);
    let joiner: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await flood(paneId);
      // the replay tail is full: the joiner's first frame is ~128 KiB
      await until(() => operator.state.bytes >= 160 * 1024, "operator fills the replay tail", 15_000);
      // a phone on a slow link: it does not acknowledge its replay for longer than the stall deadline
      joiner = await connect(paneId, false);
      const joined = Date.now();
      expect(joiner.state.bytes).toBeGreaterThan(64 * 1024);
      await Bun.sleep(1000); // fixed wait: the joiner must stay silent past the time its window blocks
      const before = operator.state.bytes;
      await Bun.sleep(OUTPUT_STALL_MS); // fixed wait: proving nothing stalls or closes for a full stall deadline
      // the joiner held only its own window up: the shared pty kept streaming to the operator
      expect(operator.state.bytes - before).toBeGreaterThan(64 * 1024);
      expect(Date.now() - joined).toBeGreaterThan(OUTPUT_STALL_MS);
      expect(joiner.state.code).toBe(0);
      // its ACK arrives inside its budget and it carries on as an ordinary client
      joiner.state.ack = true;
      joiner.acknowledge();
      const caught = joiner.state.bytes;
      await until(() => joiner!.state.bytes > caught + 4096, "joiner keeps receiving");
      expect(joiner.state.code).toBe(0);
      expect(operator.state.code).toBe(0);
      operator.send({ type: "input", pane_id: paneId, text: "\x03" });
    } finally { operator.ws.close(); joiner?.ws.close(); }
  }, 30_000);

  it("repaints what was drawn once for a client joining after the replay tail lost it", async () => {
    // btop's shape: a frame drawn once on the alternate screen, then only changing cells. herdr's
    // attach stream sends differences, so the frame is in the stream once, at its start.
    const MARK = "STATIC_FRAME_TITLE";
    const program = `python3 -u -c 'import sys,time,itertools
sys.stdout.write("\\033[?1049h\\033[2J\\033[1;1H${MARK}\\033[2;1H"+"="*60); sys.stdout.flush()
for i in itertools.count(): sys.stdout.write("".join("\\033[%d;1H%s" % (r, str((i+r)%10)*79) for r in range(5,25))); sys.stdout.flush(); time.sleep(.01)'`;
    const paneId = await pane();
    const operator = await connect(paneId, true, false, server.port, MARK);
    let joiner: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      await flood(paneId, program);
      await until(() => operator.state.found, "the frame is drawn", 15_000);
      const drawn = operator.state.bytes;
      // the updates since the frame overflow the 128 KiB tail a joiner is sent
      await until(() => operator.state.bytes - drawn > 192 * 1024, "the tail fills with updates", 20_000);
      joiner = await connect(paneId, true, false, server.port, MARK);
      // the replay alone has no frame (the bug this guards against): herdr's repaint brings it
      expect(joiner.state.first?.includes(MARK)).toBe(false);
      await until(() => joiner!.state.found, "the frame reaches the joiner", 10_000);
      expect(joiner.state.errors).toEqual([]);
      expect(joiner.state.code).toBe(0);
      expect(operator.state.code).toBe(0);
    } finally {
      operator.send({ type: "input", pane_id: paneId, text: "\x03" });
      operator.ws.close();
      joiner?.ws.close();
    }
  }, 45_000);

  it("resumes on valid ACKs and rejects future credit without accepting stale subscriptions", async () => {
    const paneId = await pane();
    const client = await connect(paneId, false);
    try {
      const initial = client.state.latest!;
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: initial.flow!.stream_id, offset: Number.MAX_SAFE_INTEGER });
      await until(() => client.state.errors.includes("invalid_ack"), "future ACK refused");
      await flood(paneId);
      await until(() => client.state.bytes >= OUTPUT_HIGH_BYTES, "pause at high watermark", 15_000);
      await Bun.sleep(200);
      const paused = client.state.bytes;
      client.send({ type: "pty-ack", pane_id: paneId, stream_id: "previous-subscription", offset: paused });
      await Bun.sleep(200);
      expect(client.state.bytes).toBe(paused);
      client.state.ack = true;
      client.acknowledge();
      await until(() => client.state.bytes > paused + 4096, "valid credit resumes output");
      expect(client.state.code).toBe(0);
      client.send({ type: "input", pane_id: paneId, text: "\x03" });
    } finally { client.ws.close(); }
  }, 30_000);
});

type AttachStep = { kind: "eof" | "read-race" | "real"; gate?: string; exitGate?: string; text?: string };

function scriptedAttachHerdr(steps: AttachStep[]): { path: string; attempts: () => number; release: (gate: string) => void; dir: string } {
  const real = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr") || "herdr";
  const dir = mkdtempSync(join(root, "reattach-herdr-"));
  const path = join(dir, "herdr.mjs");
  copyFileSync(join(import.meta.dir, "../scripts/fixtures/attach-sequence.mjs"), path);
  chmodSync(path, 0o700);
  writeFileSync(join(dir, "plan.json"), JSON.stringify({ herdr: real, steps }));
  return {
    path,
    dir,
    attempts: () => existsSync(join(dir, "count")) ? Number(readFileSync(join(dir, "count"), "utf8").trim() || 0) : 0,
    release: (gate) => writeFileSync(join(dir, gate), "go"),
  };
}

async function withAttachHerdr<T>(herdr: { path: string; dir: string }, run: () => Promise<T>): Promise<T> {
  const previous = { binary: process.env["OVIS_HERDR_BIN"], dir: process.env["HERDR_ATTACH_TEST_DIR"] };
  process.env["OVIS_HERDR_BIN"] = herdr.path;
  process.env["HERDR_ATTACH_TEST_DIR"] = herdr.dir;
  try { return await run(); } finally {
    for (const [key, value] of [["OVIS_HERDR_BIN", previous.binary], ["HERDR_ATTACH_TEST_DIR", previous.dir]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
}

describe("same-terminal attach recovery", () => {
  it("reattaches after a transient EOF, becomes ready again and accepts input without ending", async () => {
    const paneId = await pane();
    const herdr = scriptedAttachHerdr([
      { kind: "eof", text: "transient attach EOF\r\n", exitGate: "exit-1" },
      { kind: "real" },
    ]);
    const recovering = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: mkdtempSync(join(root, "same-terminal-ready-")),
      attachRelookupForMs: 500,
    });
    try {
      await withAttachHerdr(herdr, async () => {
        const client = await connect(paneId, true, false, recovering.port);
        try {
          expect(client.state.ready).toBe(1);
          herdr.release("exit-1");
          await until(() => client.state.ready >= 2, "the same terminal becomes input-ready again", 5_000);
          expect(client.state.notReady).toBe(1);
          expect(client.state.exits).toBe(0);
          expect(herdr.attempts()).toBe(2);
          // Past the one recovery window, the stable replacement remains the only attach.
          await Bun.sleep(650); // fixed wait: proves no third attach appears after the recovery settles
          expect(herdr.attempts()).toBe(2);
          expect(client.state.ready).toBe(2);
          client.send({ type: "input", pane_id: paneId, text: "printf 'same_id_input_%s\\n' 42\r" });
          await until(() => client.state.tail.includes("same_id_input_42"), "input reaches the recovered attach", 5_000);
          expect(client.state.errors).toEqual([]);
          expect(client.state.exits).toBe(0);
        } finally { client.ws.close(); }
      });
    } finally { recovering.stop(); }
  }, 20_000);

  it("bounds repeated ready-then-EOF replacements under one recovery deadline", async () => {
    const paneId = await pane();
    const herdr = scriptedAttachHerdr([{ kind: "eof", text: "flapping attach\r\n", exitGate: "exit-{attempt}" }]);
    const impatient = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: mkdtempSync(join(root, "same-terminal-flap-")),
      attachHoldMs: 20, attachRelookupForMs: 500,
    });
    try {
      await withAttachHerdr(herdr, async () => {
        const client = await connect(paneId, true, false, impatient.port);
        try {
          let released = 0;
          const ended = () => client.state.exits === 1;
          while (!ended() && released < 20) {
            await until(() => ended() || client.state.ready > released, "the next replacement is ready", 4_000);
            if (ended()) break;
            released += 1;
            herdr.release(`exit-${released}`);
          }
          await until(() => client.state.exits === 1, "one bounded terminal exit", 4_000);
          const attempts = herdr.attempts();
          expect(attempts).toBeGreaterThan(1);
          expect(attempts).toBeLessThan(10);
          await Bun.sleep(700); // fixed wait: proves neither another attach nor another exit appears
          expect(herdr.attempts()).toBe(attempts);
          expect(client.state.exits).toBe(1);
          expect(client.state.notReady).toBeGreaterThan(0);
        } finally { client.ws.close(); }
      });
    } finally { impatient.stop(); }
  }, 15_000);

  it("bounds read-race retries by the EOF recovery deadline", async () => {
    const paneId = await pane();
    const herdr = scriptedAttachHerdr([
      { kind: "eof", text: "initial attach\r\n", exitGate: "initial-eof" },
      { kind: "read-race" },
    ]);
    const impatient = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: mkdtempSync(join(root, "same-terminal-read-race-")),
      attachHoldMs: 20, attachRetryForMs: 5_000, attachRelookupForMs: 500,
    });
    try {
      await withAttachHerdr(herdr, async () => {
        const client = await connect(paneId, true, false, impatient.port);
        try {
          expect(client.state.ready).toBe(1);
          herdr.release("initial-eof");
          await until(() => client.state.exits === 1, "read-race recovery reaches its terminal exit", 4_000);
          const attempts = herdr.attempts();
          expect(attempts).toBeGreaterThan(1);
          expect(attempts).toBeLessThan(10);
          expect(client.state.ready).toBe(1);
          expect(client.state.notReady).toBe(1);
          await Bun.sleep(700); // fixed wait: proves no retry runs after the shared recovery deadline
          expect(herdr.attempts()).toBe(attempts);
          expect(client.state.exits).toBe(1);
        } finally { client.ws.close(); }
      });
    } finally { impatient.stop(); }
  }, 15_000);
});

describe("a terminal attach that cannot spawn (#154)", () => {
  it("reports the failure and leaves the pane attachable, never a record without a pty", async () => {
    const paneId = await pane();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const errors: string[] = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type === "error") errors.push(frame.code);
    });
    await until(() => ws.readyState === WebSocket.OPEN, "socket open");
    const restore = breakPath();
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" } satisfies ClientMessage));
      await until(() => errors.includes("command_failed"), "the failed spawn is reported");
    } finally { restore(); }
    // the next attach spawns its own pty instead of joining a dead record
    const second = await connect(paneId);
    second.ws.close();
    await until(() => second.state.code !== 0, "second client closed");
    // closing it tore the attachment down cleanly: the server still attaches the pane
    const third = await connect(paneId);
    try {
      expect(third.state.errors).toEqual([]);
      expect(third.state.exits).toBe(0);
    } finally { third.ws.close(); ws.close(); }
  }, 30_000);
});

describe("a herdr the server cannot start (#925)", () => {
  it("tells the attaching client and logs it, instead of a terminal that waits in silence", async () => {
    const paneId = await pane();
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    sockets.push(ws);
    const errors: string[] = [];
    const errorPanes: (string | undefined)[] = [];
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as ServerMessage;
      if (frame.type === "error") { errors.push(frame.code); errorPanes.push(frame.pane_id); }
    });
    await until(() => ws.readyState === WebSocket.OPEN, "socket open");
    const missing = join(root, "missing-herdr");
    const logged: string[] = [];
    const log = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
    const previous = process.env["OVIS_HERDR_BIN"];
    process.env["OVIS_HERDR_BIN"] = missing;
    try {
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30, flow_control: "ack" } satisfies ClientMessage));
      await until(() => errors.includes("attach_failed"), "the missing herdr is reported", 3_000);
    } finally {
      console.error = log;
      if (previous === undefined) delete process.env["OVIS_HERDR_BIN"];
      else process.env["OVIS_HERDR_BIN"] = previous;
    }
    expect(errors).toEqual(["attach_failed"]);
    // the panes of a PC share one connection: the failure names its pane, so only that terminal ends
    expect(errorPanes).toEqual([paneId]);
    expect(logged.filter((line) => line.includes(paneId) && line.includes(missing))).toHaveLength(1);
    // nothing was left behind: with herdr back, the pane attaches for real
    const client = await connect(paneId);
    try {
      expect(client.state.errors).toEqual([]);
    } finally { client.ws.close(); ws.close(); }
  }, 30_000);
});

describe("an attach herdr refuses over a read in progress", () => {
  /**
   * A herdr that refuses the first `refusals` attaches as herdr 0.9 refuses one racing a
   * pane read of the same terminal, then attaches for real.
   */
  function refusingHerdr(refusals: number): { path: string; attempts: () => number } {
    const real = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr") || "herdr";
    const dir = mkdtempSync(join(root, "refusing-herdr-"));
    const count = join(dir, "count");
    const path = join(dir, "herdr");
    writeFileSync(path, [
      "#!/bin/sh",
      `n=$(cat '${count}' 2>/dev/null || echo 0)`,
      `echo $((n + 1)) > '${count}'`,
      `if [ "$n" -lt ${refusals} ]; then printf 'herdr: server shut down: terminal attach failed: terminal term_0 has a read in progress; retry\\r\\n'; exit 1; fi`,
      `exec '${real}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    return { path, attempts: () => existsSync(count) ? Number(readFileSync(count, "utf8").trim() || 0) : 0 };
  }

  async function withHerdr<T>(path: string, run: () => Promise<T>): Promise<T> {
    const previous = process.env["OVIS_HERDR_BIN"];
    process.env["OVIS_HERDR_BIN"] = path;
    try { return await run(); } finally {
      if (previous === undefined) delete process.env["OVIS_HERDR_BIN"];
      else process.env["OVIS_HERDR_BIN"] = previous;
    }
  }

  it("attaches again for the same client instead of ending its terminal", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(2);
    await withHerdr(herdr.path, async () => {
      const client = await connect(paneId);
      try {
        // the refusals are retried; the third attach is real and paints the pane
        await until(() => herdr.attempts() === 3 && client.state.tail.includes("\x1b[?1049h"), "the third attach paints");
        await Bun.sleep(300); // herdr's attach consumes very early keystrokes
        client.send({ type: "input", pane_id: paneId, text: "echo attach-$((6*7))\r" });
        await until(() => client.state.tail.includes("attach-42"), "the retried attach streams the pane");
        expect(herdr.attempts()).toBe(3);
        expect(client.state.exits).toBe(0);
        expect(client.state.errors).toEqual([]);
        // a refused attach's setup, teardown and message never reached the terminal
        expect(client.state.tail).not.toContain("read in progress");
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("ends the terminal, not the server, when a retried attach cannot spawn", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(1);
    await withHerdr(herdr.path, async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
      sockets.push(ws);
      const errors: string[] = [];
      let exits = 0;
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(String(event.data)) as ServerMessage;
        if (frame.type === "error") errors.push(frame.code);
        if (frame.type === "pty-exit" && frame.pane_id === paneId) exits++;
      });
      await until(() => ws.readyState === WebSocket.OPEN, "socket open");
      ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 } satisfies ClientMessage));
      // the refusal is running: the retry that follows its exit spawns without node
      await until(() => herdr.attempts() === 1, "the refused attach started");
      const restore = breakPath();
      try {
        await until(() => exits === 1, "pty-exit for the retry that failed to spawn");
      } finally { restore(); }
      expect(errors).toEqual(["command_failed"]);
      expect(herdr.attempts()).toBe(1);
      ws.close();
      // the server survived and the pane attaches again for real
      const client = await connect(paneId);
      try {
        expect(client.state.errors).toEqual([]);
        expect(herdr.attempts()).toBe(2);
      } finally { client.ws.close(); }
    });
  }, 30_000);

  it("still ends the terminal when herdr keeps refusing past the longest such read", async () => {
    const paneId = await pane();
    const herdr = refusingHerdr(1000);
    const impatient = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: mkdtempSync(join(root, "impatient-")), attachRetryForMs: 800 });
    try {
      await withHerdr(herdr.path, async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${impatient.port}/ws`);
        sockets.push(ws);
        let exits = 0; let tail = "";
        ws.addEventListener("message", (event) => {
          const frame = JSON.parse(String(event.data)) as ServerMessage;
          if (frame.type === "pty-exit" && frame.pane_id === paneId) exits++;
          if (frame.type === "pty-data" && frame.pane_id === paneId) tail += frame.data;
        });
        await until(() => ws.readyState === WebSocket.OPEN, "socket open");
        ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 } satisfies ClientMessage));
        await until(() => exits === 1, "pty-exit once the retries run out");
        expect(herdr.attempts()).toBeGreaterThan(2);
        // the last refusal is shown: it says why the terminal ended
        expect(tail).toContain("read in progress");
        ws.close();
      });
    } finally { impatient.stop(); }
  }, 30_000);
});

describe("herdr's attach-time terminal queries", () => {
  it("answers them in the bridge and keeps them out of every client's terminal", async () => {
    const real = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr") || "herdr";
    const dir = mkdtempSync(join(root, "probing-herdr-"));
    const replies = join(dir, "replies");
    const path = join(dir, "herdr");
    // herdr 0.9.4+ asks its terminal these before it attaches; the herdr CI pins does not, so a shim asks
    writeFileSync(path, [
      "#!/bin/sh",
      "saved=$(stty -g)",
      "stty raw -echo",
      "printf '\\033[?1016$p\\033[c'",
      // --foreground: a background process group could not read the terminal
      `timeout --foreground 5 head -c 18 > '${replies}'`,
      'stty "$saved"',
      `exec '${real}' "$@"`,
      "",
    ].join("\n"));
    chmodSync(path, 0o755);
    const previous = process.env["OVIS_HERDR_BIN"];
    process.env["OVIS_HERDR_BIN"] = path;
    try {
      const paneId = await pane();
      const first = await connect(paneId);
      try {
        await until(() => first.state.tail.includes("\x1b[?1049h"), "the attach behind the queries paints");
        await until(() => existsSync(replies) && readFileSync(replies, "utf8").length === 18, "the bridge answered");
        expect(readFileSync(replies, "utf8")).toBe("\x1b[?1016;4$y\x1b[?1;2c");
        // a browser joining later gets the replay: the queries are not in it to be answered again
        const second = await connect(paneId);
        try {
          for (const client of [first, second]) {
            expect(client.state.tail).not.toContain("1016$p");
            expect(client.state.tail).not.toContain("\x1b[c");
            expect(client.state.errors).toEqual([]);
          }
        } finally { second.ws.close(); }
      } finally { first.ws.close(); }
    } finally {
      if (previous === undefined) delete process.env["OVIS_HERDR_BIN"];
      else process.env["OVIS_HERDR_BIN"] = previous;
    }
  }, 30_000);
});
