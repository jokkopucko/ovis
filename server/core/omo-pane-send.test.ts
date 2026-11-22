import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { omoSessionFolder } from "../omo.ts";
import { processStartedAt } from "../process-start.ts";
import { createSubmitText } from "./composer.ts";

let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let panes: Record<string, { agent?: string; process: { pid: number; argv: string[]; cwd: string }[] }>;
let calls: { method: string; params: Record<string, unknown> }[];
let screens: Record<string, string>;
let onProcessInfo: () => void;
const children: ReturnType<typeof Bun.spawn>[] = [];

const paneInfo = (id: string) => ({
  pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0,
  ...(panes[id]?.agent ? { agent: panes[id]!.agent } : {}),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-omo-send-"));
  panes = {};
  calls = [];
  screens = {};
  onProcessInfo = () => {};
  socketBefore = process.env["HERDR_SOCKET"];
  const socket = join(root, "herdr.sock");
  process.env["HERDR_SOCKET"] = socket;
  listener = Bun.listen<{ buffer: string }>({
    unix: socket,
    socket: {
      open(socket) { socket.data = { buffer: "" }; },
      data(socket, chunk) {
        socket.data.buffer += chunk.toString();
        if (!socket.data.buffer.includes("\n")) return;
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: { pane_id?: string; target?: string } };
        calls.push({ method: request.method, params: (request.params ?? {}) as Record<string, unknown> });
        const id = request.params?.pane_id ?? request.params?.target ?? "";
        if (request.method === "pane.process_info") onProcessInfo();
        if (request.method === "agent.prompt" && !panes[id]?.agent) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "agent_not_found", message: "no agent" } })}\n`);
          return;
        }
        const result = request.method === "pane.get" ? { pane: paneInfo(id) }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: panes[id]?.process ?? [] } }
          : request.method === "pane.read" ? { read: { text: screens[id] ?? "" } }
          : request.method === "agent.prompt" || request.method === "pane.send_text" || request.method === "pane.send_keys" ? {}
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    child.kill();
    await child.exited;
  }));
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

async function firstLine(stdout: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the fixture's stdout ended before a full line: ${JSON.stringify(text)}`);
      text += decoder.decode(value, { stream: true });
    }
  } finally { reader.releaseLock(); }
  return text;
}

async function heldOmo(): Promise<{ pid: number; argv: string[]; cwd: string }> {
  const agentDir = join(root, "agent");
  // Keep the process that signals ready: another exec can make /proc/<pid>/environ
  // briefly empty while the composer looks up the store holding this session.
  const child = Bun.spawn(["sh", "-c", "echo ready; read -r stop"], { cwd: root, env: { OMO_CODING_AGENT_DIR: agentDir, PATH: process.env["PATH"] ?? "" }, stdin: "pipe", stdout: "pipe" });
  children.push(child);
  expect(await firstLine(child.stdout)).toBe("ready\n");
  const holders = join(agentDir, "sessions", omoSessionFolder(root), "session-holders", "sess-1");
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, `${child.pid}.json`), JSON.stringify({ pid: child.pid, processStartedAtMs: processStartedAt(child.pid), cwd: root }));
  return { pid: child.pid, argv: ["omo"], cwd: root };
}

const OMO_AI_SCRIPT = { pid: 2147483645, argv: ["bun", "/checkout/omo-ai/scripts/helper.ts"], cwd: "" };

const DRAFT_SCREEN = ["", "\u2500".repeat(60), "\u276f an unsent draft", "\u2500".repeat(60), "  \u23f5\u23f5 auto mode on"].join("\r\n");

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

it("keeps Claude's draft refusal when only a script from an omo-ai checkout runs beside Claude", async () => {
  screens["w:p1"] = DRAFT_SCREEN;
  panes["w:p1"] = { agent: "claude", process: [{ pid: 2147483646, argv: ["/usr/bin/claude"], cwd: root }, { ...OMO_AI_SCRIPT, cwd: root }] };
  const refused = await submitter()("w:p1", "hello", "hello", Date.now()).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HerdrError);
  expect((refused as HerdrError).code).toBe("input_draft");
  expect(calls.some((call) => call.method === "agent.prompt")).toBeFalse();
});

it("neither reads nor types into a Hermes pane once the device loses its access while its processes are looked up", async () => {
  screens["w:p1"] = "";
  panes["w:p1"] = { agent: "hermes", process: [{ pid: 2147483646, argv: ["/usr/bin/hermes"], cwd: root }] };
  let revoked = false;
  onProcessInfo = () => { revoked = true; };
  const authorize = () => { if (revoked) throw new HerdrError("forbidden", "access revoked"); };
  const refused = await submitter()("w:p1", "hello", "hello", Date.now(), false, authorize).catch((error: unknown) => error);
  expect((refused as HerdrError).code).toBe("forbidden");
  expect(calls.some((call) => call.method === "pane.process_info")).toBeTrue();
  expect(calls.some((call) => ["pane.read", "agent.prompt", "pane.send_text", "pane.send_keys"].includes(call.method))).toBeFalse();
});

describe.skipIf(process.platform !== "linux")("omo panes", () => {
it("sends into a Claude-labelled omo pane without Claude's draft refusal, and still refuses a real Claude pane", async () => {
  screens["w:p1"] = DRAFT_SCREEN;
  screens["w:p2"] = DRAFT_SCREEN;
  // omo's claude-sdk child runs, so herdr labels the pane claude; the pane runs omo
  panes["w:p1"] = { agent: "claude", process: [await heldOmo()] };
  panes["w:p2"] = { agent: "claude", process: [{ pid: 2147483646, argv: ["/usr/bin/claude"], cwd: root }] };
  await submitter()("w:p1", "hello", "hello", Date.now());
  expect(calls.some((call) => call.method === "agent.prompt" && call.params.text === "hello")).toBeTrue();
  expect(calls.filter((call) => call.method === "pane.read").map((call) => [call.params.source, call.params.format])).toEqual([["visible", "ansi"], ["detection", "text"]]);
  calls.length = 0;
  const refused = await submitter()("w:p2", "hello", "hello", Date.now()).catch((error: unknown) => error);
  expect(refused).toBeInstanceOf(HerdrError);
  expect((refused as HerdrError).code).toBe("input_draft");
  expect(calls.some((call) => call.method === "agent.prompt")).toBeFalse();
});

it("refuses a send to a Claude-labelled omo pane over text typed in OmO's box, typing nothing", async () => {
  screens["w:p1"] = readFileSync(join(import.meta.dir, "../../src/lib/fixtures-input-rows/omo/draft-typed-119.ansi"), "utf8");
  panes["w:p1"] = { agent: "claude", process: [await heldOmo()] };
  const refused = await submitter()("w:p1", "hello", "hello", Date.now()).catch((error: unknown) => error);
  expect((refused as HerdrError).code).toBe("input_draft");
  expect(calls.some((call) => call.method === "agent.prompt")).toBeFalse();
});

it("refuses a send to a pi-labelled omo pane over text typed in OmO's box, typing nothing, and sends over its empty box", async () => {
  const recorded = (file: string): string => readFileSync(join(import.meta.dir, "../../src/lib/fixtures-input-rows/omo", file), "utf8");
  screens["w:p1"] = recorded("draft-typed-119.ansi");
  panes["w:p1"] = { agent: "pi", process: [await heldOmo()] };
  const refused = await submitter()("w:p1", "hello", "hello", Date.now()).catch((error: unknown) => error);
  expect((refused as HerdrError).code).toBe("input_draft");
  expect(calls.some((call) => call.method === "agent.prompt")).toBeFalse();
  screens["w:p1"] = recorded("draft-empty-119.ansi");
  await submitter()("w:p1", "hello", "hello", Date.now());
  expect(calls.some((call) => call.method === "agent.prompt" && call.params.text === "hello")).toBeTrue();
});

it("pastes a multiline message into an unlabelled omo pane as one bracketed paste, and leaves another shell's bare", async () => {
  panes["w:p1"] = { process: [await heldOmo()] };
  panes["w:p2"] = { process: [{ pid: 2147483646, argv: ["/bin/bash"], cwd: root }] };
  panes["w:p3"] = { process: [{ pid: 2147483646, argv: ["/bin/bash"], cwd: root }, { ...OMO_AI_SCRIPT, cwd: root }] };
  const sent = async (paneId: string) => {
    calls.length = 0;
    await submitter()(paneId, "a\nb", "a\rb", Date.now());
    return calls.find((call) => call.method === "pane.send_text")?.params.text;
  };
  expect(await sent("w:p1")).toBe("\u001b[200~a\rb\u001b[201~");
  expect(await sent("w:p2")).toBe("a\rb");
  expect(await sent("w:p3"), "a script from an omo-ai checkout gets no omo paste markers").toBe("a\rb");
});

it("sends nothing when the device loses its access while the pane's processes are looked up", async () => {
  panes["w:p1"] = { agent: "claude", process: [await heldOmo()] };
  let revoked = false;
  onProcessInfo = () => { revoked = true; };
  const authorize = () => { if (revoked) throw new HerdrError("forbidden", "access revoked"); };
  const refused = await submitter()("w:p1", "hello", "hello", Date.now(), false, authorize).catch((error: unknown) => error);
  expect((refused as HerdrError).code).toBe("forbidden");
  expect(calls.some((call) => call.method === "agent.prompt" || call.method === "pane.send_text")).toBeFalse();
});
});
