import { expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeCopilotForeground } from "./copilot-foreground-prototype.ts";
import * as processOwner from "../server/process-owner.ts";
import { COPILOT_RPC_TIMEOUT_MS, forgetCopilotForeground, readCopilotForeground } from "../server/copilot-foreground.ts";

const first = "12aa83d8-48bc-41f2-a498-7055c5c44a01";
const second = "12aa83d8-48bc-41f2-a498-7055c5c44a02";
const linux = it.skipIf(process.platform !== "linux");

async function fixture(mode = "stable", flags = ["--ui-server"]) {
  const root = mkdtempSync(join(tmpdir(), "copilot-foreground-prototype-"));
  const script = join(root, "copilot.js");
  const control = join(root, "control.json");
  const select = (session = first, nextMode = mode) => writeFileSync(control, JSON.stringify({ session, mode: nextMode }));
  select();
  mkdirSync(join(root, "home"));
  writeFileSync(script, `
    const net = require("node:net"), fs = require("node:fs");
    const control = process.argv[2];
    const first = ${JSON.stringify(first)}, second = ${JSON.stringify(second)};
    const sockets = new Set();
    const frame = (value) => {
      const body = Buffer.from(JSON.stringify(value));
      return Buffer.concat([Buffer.from("Content-Length: " + body.length + "\\r\\n\\r\\n"), body]);
    };
    require("node:readline").createInterface({ input: process.stdin }).on("line", (type) => {
      for (const socket of sockets) {
        if (type === "drop") socket.destroy();
        else socket.write(frame({ jsonrpc: "2.0", method: "session.lifecycle", params: { type, sessionId: first } }));
      }
      console.log("ack");
    });
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      let bytes = Buffer.alloc(0), selections = 0;
      socket.on("error", (error) => { if (error.code !== "ECONNRESET") throw error; });
      const send = (value) => socket.write(frame(value));
      socket.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        for (;;) {
          const end = bytes.indexOf("\\r\\n\\r\\n");
          if (end < 0) return;
          const length = Number(bytes.subarray(0, end).toString().split(":")[1]);
          if (bytes.length < end + 4 + length) return;
          const message = JSON.parse(bytes.subarray(end + 4, end + 4 + length));
          bytes = bytes.subarray(end + 4 + length);
          if (!["connect", "session.getForeground"].includes(message.method)
            || Object.keys(message.params).length !== 0) throw new Error("Unexpected control or credentials");
          const config = JSON.parse(fs.readFileSync(control, "utf8"));
          if (config.mode === "stall") continue;
          if (config.mode === "oversize") { socket.write("Content-Length: 65537\\r\\n\\r\\n"); continue; }
          if (config.mode === "truncated") { socket.end("Content-Length: 100\\r\\n\\r\\n{"); continue; }
          if (config.mode === "protected") { send({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Unauthorized" } }); continue; }
          if (message.method === "connect") {
            send({ jsonrpc: "2.0", id: message.id, result: { ok: true, protocolVersion: config.mode === "version" ? 999 : 3 } });
          } else {
            selections++;
            if (config.mode === "close") { socket.end(); continue; }
            if (config.mode === "event") send({ jsonrpc: "2.0", method: "session.lifecycle", params: { type: "session.foreground", sessionId: second } });
            const sessionId = config.mode === "switch" ? selections === 1 ? first : second
              : config.mode === "malformed" ? "../not-a-session" : config.mode === "empty" ? null : config.session;
            const response = { jsonrpc: "2.0", id: config.mode === "wrong-id" ? "wrong" : message.id, result: { sessionId } };
            if (config.mode === "event-after-final" && selections === 2) {
              socket.write(Buffer.concat([frame(response), frame({ jsonrpc: "2.0", method: "session.lifecycle", params: { type: "session.foreground", sessionId: second } })]));
            } else send(response);
          }
        }
      });
    });
    if (${JSON.stringify(mode)} === "no-listener") { console.log("ready"); setInterval(() => {}, 1000); }
    else server.listen(0, "127.0.0.1", () => {
      if (${JSON.stringify(mode)} !== "ambiguous") console.log("ready");
      else net.createServer().listen(0, "127.0.0.1", () => console.log("ready"));
    });
  `);
  const child = Bun.spawn([process.execPath, script, control, ...flags], {
    env: { ...process.env, HOME: join(root, "home"), COPILOT_CONNECTION_TOKEN: "fixture-not-a-real-secret" },
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });
  const close = async () => {
    forgetCopilotForeground();
    child.kill();
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  };
  // a pipe may split a line across reads: read until the whole word has come (the test's timeout bounds the wait)
  const lineWith = async (word: string) => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
      while (!text.includes(word)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`fixture output ended before "${word}": ${text}`);
        text += decoder.decode(value, { stream: true });
      }
    } finally { reader.releaseLock(); }
  };
  try { await lineWith("ready"); } catch (error) { await close(); throw error; }
  const notify = async (type: string) => {
    child.stdin.write(`${type}\n`);
    await lineWith("ack");
  };
  return { pid: child.pid, select, close, notify };
}

linux("requeries the current foreground across warm switches without a native report or cached ID", async () => {
  const test = await fixture();
  try {
    expect(await observeCopilotForeground(test.pid)).toEqual({ state: "observed", sessionId: first, authorization: "unproven" });
    test.select(second);
    expect(await observeCopilotForeground(test.pid)).toEqual({ state: "observed", sessionId: second, authorization: "unproven" });
    test.select(first);
    expect(await observeCopilotForeground(test.pid)).toEqual({ state: "observed", sessionId: first, authorization: "unproven" });
  } finally { await test.close(); }
});

linux("never retains the last ID after a failed observation or protected-endpoint refusal", async () => {
  const test = await fixture();
  try {
    expect((await observeCopilotForeground(test.pid)).state).toBe("observed");
    test.select(second, "protected");
    expect(await observeCopilotForeground(test.pid)).toEqual({ state: "unavailable", diagnostic: "rpc_rejected" });
    test.select(second);
    expect(await observeCopilotForeground(test.pid)).toMatchObject({ state: "observed", sessionId: second });
  } finally { await test.close(); }
});

linux("keeps a binding while unchanged but invalidates it after an unqueried switch-away-and-back", async () => {
  const test = await fixture();
  try {
    const original = await readCopilotForeground(test.pid);
    expect(original.state).toBe("selected");
    expect(await readCopilotForeground(test.pid)).toEqual(original);
    await test.notify("session.background");
    await test.notify("session.foreground");
    const returned = await readCopilotForeground(test.pid);
    expect(returned).toMatchObject({ state: "selected", sessionId: first });
    expect(returned).not.toEqual(original);
    expect(await readCopilotForeground(test.pid)).toEqual(returned);
    await test.notify("session.updated");
    expect(await readCopilotForeground(test.pid)).toEqual(returned);
    await test.notify("session.future-selection-event");
    expect(await readCopilotForeground(test.pid)).not.toEqual(returned);
  } finally { await test.close(); }
});

linux("never reuses a binding after a transport gap or explicit reader cleanup", async () => {
  const test = await fixture();
  try {
    const original = await readCopilotForeground(test.pid);
    await test.notify("drop");
    let returned = await readCopilotForeground(test.pid);
    if (returned.state === "unavailable") returned = await readCopilotForeground(test.pid);
    expect(returned).toMatchObject({ state: "selected", sessionId: first });
    expect(returned).not.toEqual(original);
    forgetCopilotForeground();
    expect(await readCopilotForeground(test.pid)).not.toEqual(returned);
  } finally { await test.close(); }
});

// The fake Copilot is another process: on a starved runner its answer can come after the product's
// 2 s RPC deadline, and the product then rightly says rpc_timeout. Unless the fault under test is that
// stall, a timeout only means the fixture was late, so observe again (the timeout closed the
// connection, so each attempt starts afresh) a bounded number of times. Only an rpc_timeout is asked
// again, so no answer on the way can be a foreground ID, and the last answer must be the fault's own.
// One attempt can wait on three of the product's 2 s deadlines in turn: the connection with its
// `connect` RPC, then each of the two `session.getForeground` requests a read makes.
const attempts = 3;
const attemptBudget = 3 * COPILOT_RPC_TIMEOUT_MS;
const fixtureStart = 5_000;
for (const mode of ["switch", "event", "event-after-final", "malformed", "wrong-id", "empty", "oversize", "truncated", "close", "version", "stall"]) {
  linux(`rejects ${mode} instead of returning a stale foreground ID`, async () => {
    const test = await fixture(mode);
    const diagnostic = mode === "switch" || mode === "event" || mode === "event-after-final" ? "foreground_changed"
      : mode === "empty" ? "no_foreground" : mode === "version" ? "unsupported_protocol"
      : mode === "stall" ? "rpc_timeout" : mode === "close" || mode === "truncated" ? "rpc_failed" : "malformed_rpc";
    try {
      let result = await observeCopilotForeground(test.pid);
      for (let attempt = 1; attempt < attempts && diagnostic !== "rpc_timeout"
        && result.state === "unavailable" && result.diagnostic === "rpc_timeout"; attempt++) {
        result = await observeCopilotForeground(test.pid);
      }
      expect(result).toEqual({ state: "unavailable", diagnostic });
    }
    finally { await test.close(); }
  }, attempts * attemptBudget + fixtureStart);
}

for (const [mode, flags, diagnostic] of [
  ["stable", [], "not_opted_in"],
  ["stable", ["--", "--ui-server"], "not_opted_in"],
  ["no-listener", ["--ui-server"], "endpoint_unproved"],
  ["ambiguous", ["--ui-server"], "endpoint_unproved"],
] as const) {
  linux(`does not guess an endpoint for ${mode}/${flags.join(" ")}`, async () => {
    const test = await fixture(mode, [...flags]);
    try { expect(await observeCopilotForeground(test.pid)).toEqual({ state: "unavailable", diagnostic }); }
    finally { await test.close(); }
  });
}

linux("rejects a changed process generation before sending RPC", async () => {
  const test = await fixture();
  const original = processOwner.readProcessBirth(test.pid);
  if (original.state !== "identified") { await test.close(); throw new Error("Fixture birth unavailable"); }
  const real = processOwner.readProcessBirth;
  let reads = 0;
  const birth = spyOn(processOwner, "readProcessBirth").mockImplementation((pid) =>
    pid !== test.pid ? real(pid) : ++reads === 1 ? original
      : { state: "identified", birth: { platform: "linux", value: original.birth.value + "0" } });
  try { expect(await observeCopilotForeground(test.pid)).toEqual({ state: "unavailable", diagnostic: "process_changed" }); }
  finally { birth.mockRestore(); await test.close(); }
});

linux("prints metadata only and never mistakes an observation for authorization", async () => {
  const test = await fixture();
  try {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "copilot-foreground-prototype.ts"), String(test.pid)], {
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({ state: "observed", foreground_present: true, authorization: "unproven" });
    expect(stdout).not.toContain(first);
    expect(stdout).not.toContain("fixture-not-a-real-secret");
  } finally { await test.close(); }
});
