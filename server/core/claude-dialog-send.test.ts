import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";

/**
 * A Chat send to a Claude Code pane whose terminal shows a dialog no reader makes out, in its input box's place: herdr
 * still reports the agent idle. Claude's own PID record says what it waits on (2.1.330 writes `status` and
 * `waitingFor` there, as `claude agents --json` reads them).
 */
const linux = process.platform === "linux";
let root: string;
let store: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let calls: { method: string; params: Record<string, unknown> }[];
let screen: string;
let processInfoFails: boolean;
let argv: string[];
let claude: ReturnType<typeof Bun.spawn>;

/** The PID record Claude Code 2.1.330 keeps for its process, with what it says it waits on. */
function record(status: string, waitingFor?: string): void {
  const stat = readFileSync(`/proc/${claude.pid}/stat`, "utf8");
  const procStart = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
  writeFileSync(join(store, "sessions", `${claude.pid}.json`), JSON.stringify({
    pid: claude.pid, sessionId: "00000000-0000-4000-8000-000000000003", cwd: root, procStart, version: "2.1.330", kind: "interactive",
    status, ...(waitingFor === undefined ? {} : { waitingFor }),
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-claude-dialog-"));
  store = join(root, "claude-config");
  mkdirSync(join(store, "sessions"), { recursive: true });
  // a background session's own Claude: its argv can name `attach` behind options, and it is no attach client
  claude = Bun.spawn(["sleep", "30"], { env: { ...process.env, CLAUDE_CONFIG_DIR: store, CLAUDE_CODE_SESSION_KIND: "bg" }, stdin: "ignore" });
  argv = ["/usr/bin/claude"];
  calls = [];
  processInfoFails = false;
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
        if (request.method === "pane.process_info" && processInfoFails) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "internal_error", message: "timed out" } })}\n`);
          return;
        }
        const result = request.method === "pane.get"
          ? { pane: { pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0, agent: "claude", agent_status: "idle" } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: claude.pid, argv, cwd: root }] } }
          : request.method === "pane.read" ? { read: { text: screen } }
          : request.method === "pane.scroll_info" ? { scroll: { offset: 0, max: 0 } }
          : {};
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(async () => {
  listener.stop(true);
  claude.kill();
  await claude.exited;
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  rmSync(root, { recursive: true, force: true });
});

const submit = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});
const typed = () => calls.filter((call) => ["agent.prompt", "pane.send_text", "pane.send_keys"].includes(call.method));
/** `/add-dir`'s confirmation in the box's place: no rule, no `❯` input, and no hint a reader takes for a menu */
const DIALOG = ["● Reading the project", "", " Add /work/other to this session's folders?", "", "   1. Yes, for this session", "   2. No"].join("\n");
const RULE = "─".repeat(40);

it.skipIf(!linux)("refuses a Chat send while Claude's PID record says it waits on a dialog drawn in its box's place, typing nothing", async () => {
  screen = DIALOG;
  for (const [waitingFor, named] of [["dialog open", "claude"], ["permission prompt", "claude"], ["input needed", "claude"], ["dialog open", "claude --model sonnet attach 7c5dcf5d"]] as const) {
    argv = named.split(" ");
    record("waiting", waitingFor);
    calls = [];
    const refused = await submit()("w:p1", "hello from chat", "hello from chat", Date.now()).catch((error: unknown) => error);
    expect(refused, waitingFor).toBeInstanceOf(HerdrError);
    expect((refused as HerdrError).code, waitingFor).toBe("agent_blocked");
    expect(typed(), waitingFor).toEqual([]);
  }
});

it.skipIf(!linux)("sends as before when the pane's processes cannot be read", async () => {
  screen = DIALOG;
  record("waiting", "dialog open");
  processInfoFails = true;
  await submit()("w:p1", "hello from chat", "hello from chat", Date.now());
  expect(typed().some((call) => call.method === "agent.prompt" && call.params["text"] === "hello from chat")).toBeTrue();
});

it.skipIf(!linux)("sends once the record says Claude rests, and over a box the screen shows whatever the record says", async () => {
  screen = DIALOG;
  record("idle");
  await submit()("w:p1", "hello from chat", "hello from chat", Date.now());
  expect(typed().some((call) => call.method === "agent.prompt" && call.params["text"] === "hello from chat")).toBeTrue();
  // a record that has not caught up yet with a dialog closed: the box drawn again is what is typed into
  screen = ["● Done", "", RULE, "❯ ", RULE, "  ? for shortcuts"].join("\n");
  record("waiting", "dialog open");
  calls = [];
  await submit()("w:p1", "again from chat", "again from chat", Date.now());
  expect(typed().some((call) => call.method === "agent.prompt" && call.params["text"] === "again from chat")).toBeTrue();
});
