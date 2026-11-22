import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";
import { handlePaneRequest } from "../pane-routes.ts";

/**
 * A Chat send to a Claude Code pane whose rewind dialog is open (recorded, 2.1.304, 40 columns): herdr
 * still reports the agent idle, and the dialog shows no input box. On a Summarize row the confirm step
 * is an add-context field: a message typed there, and its Enter, would start "Summarize from here".
 */
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let calls: { method: string; params: Record<string, unknown> }[];
let screen: string;

const recorded = (name: string): string => readFileSync(new URL(`../fixtures/claude-rewind-2.1.304-${name}-40.txt`, import.meta.url), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-rewind-send-"));
  calls = [];
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
        const id = String(request.params?.["pane_id"] ?? request.params?.["target"] ?? "");
        const result = request.method === "pane.get"
          ? { pane: { pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0, agent: "claude", agent_status: "idle" } }
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

const submit = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});
const typed = () => calls.filter((call) => ["agent.prompt", "pane.send_text", "pane.send_keys"].includes(call.method));

it("refuses a Chat send while Claude Code's rewind dialog is open, from its message list to the add-context field, typing nothing", async () => {
  for (const shown of ["select-banana", "confirm-apple-summarize-from", "confirm-apple-summarize-up-to", "confirm-apple-restore", "confirm-apple-never-mind", "confirm-apple-restore-esc"]) {
    screen = recorded(shown);
    calls = [];
    const refused = await submit()("w:p1", "hello from chat", "hello from chat", Date.now()).catch((error: unknown) => error);
    expect(refused, shown).toBeInstanceOf(HerdrError);
    expect((refused as HerdrError).code, shown).toBe("rewind_dialog_open");
    expect(typed(), shown).toEqual([]);
  }
});

it("sends once the rewind dialog is closed", async () => {
  screen = recorded("confirm-apple-esc-esc");
  await submit()("w:p1", "hello from chat", "hello from chat", Date.now());
  expect(typed().some((call) => call.method === "agent.prompt" && call.params["text"] === "hello from chat")).toBeTrue();
});

it("refuses text sent over HTTP to a Claude Code pane while its rewind dialog is open; keys still reach it", async () => {
  screen = recorded("confirm-apple-summarize-from");
  const post = async (path: string, body: unknown) => {
    const url = new URL(`http://localhost${path}`);
    const response = (await handlePaneRequest(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), url, path, {}))!;
    return [response.status, await response.json()] as const;
  };
  expect(await post("/api/pane/input", { pane_id: "w:p1", text: "hello from chat\r" })).toEqual([409, { error: expect.objectContaining({ code: "rewind_dialog_open" }) }]);
  expect(typed()).toEqual([]);
  expect((await post("/api/pane/keys", { pane_id: "w:p1", keys: ["esc"] }))[0]).toBe(200);
  expect(typed().map((call) => call.method)).toEqual(["pane.send_keys"]);
});
