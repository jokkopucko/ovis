import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { createSubmitText, InputDraftError } from "./composer.ts";

let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let calls: { method: string; params: Record<string, unknown> }[];
let screen: string;
let paneId: string;
const box = (draft: string) => ["─".repeat(60), `❯ ${draft}`, "─".repeat(60)].join("\r\n");
const writes = () => calls.filter((call) => ["agent.prompt", "pane.send_text", "pane.send_keys"].includes(call.method));
const submit = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-draft-send-"));
  paneId = `${root}:p1`;
  calls = [];
  screen = box("named draft");
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
        const request = JSON.parse(socket.data.buffer) as { id: string; method: string; params?: Record<string, unknown> };
        calls.push({ method: request.method, params: request.params ?? {} });
        if (request.method === "pane.send_keys") screen = box("");
        const result = request.method === "pane.get"
          ? { pane: { pane_id: paneId, workspace_id: "w", tab_id: "w:t1", terminal_id: paneId, cwd: root, focused: false, revision: 0, agent: "claude", agent_status: "idle" } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: 2147483646, argv: ["/usr/bin/claude"], cwd: root }] } }
          : request.method === "pane.read" ? { read: { text: screen } }
          : request.method === "pane.scroll_info" ? { scroll: { offset: 0, max: 0 } }
          : {};
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(() => {
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

async function nameDraft() {
  const error: unknown = await submit()(paneId, "chat message", "chat message", Date.now()).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(InputDraftError);
  if (!(error instanceof InputDraftError)) throw new Error("expected a draft refusal");
  expect(error.draft).toBe("named draft");
  expect(writes()).toEqual([]);
  return { draft: error.draft, identity: { agent: "claude", terminalId: paneId, session: null } };
}

it.each(["", "replacement draft"])("Send it refuses without writes when the named draft became %j", async (current) => {
  const confirmation = await nameDraft();
  screen = box(current);
  const error: unknown = await submit()(paneId, "named draft", "named draft", Date.now(), false, () => {}, "named draft", confirmation)
    .catch((error: unknown) => error);
  expect(writes()).toEqual([]);
  expect(error).toBeInstanceOf(HerdrError);
  if (!(error instanceof HerdrError)) throw new Error("expected a stale draft refusal");
  expect(error.code).toBe(current ? "input_draft" : "agent_not_ready");
});

it("Send it clears the still-present named draft once then prompts once", async () => {
  const confirmation = await nameDraft();
  await submit()(paneId, "named draft", "named draft", Date.now(), false, () => {}, "named draft", confirmation);
  expect(writes()).toEqual([
    { method: "pane.send_keys", params: { pane_id: paneId, keys: ["ctrl+k", "ctrl+u"] } },
    { method: "agent.prompt", params: { target: paneId, text: "named draft" } },
  ]);
});

it("Clear it and send still sends different text when the named draft is already gone", async () => {
  const confirmation = await nameDraft();
  screen = box("");
  await submit()(paneId, "chat message", "chat message", Date.now(), false, () => {}, "named draft", confirmation);
  expect(writes()).toEqual([{ method: "agent.prompt", params: { target: paneId, text: "chat message" } }]);
});
