import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { HerdrError } from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";

/**
 * A Chat send to a Codex pane with one of Codex's own screens up (recorded: src/lib/fixtures-input-rows/codex,
 * Codex 0.163.0, and ./fixtures-codex-screens, 0.167.0): herdr still reports the agent idle, so agent.prompt
 * would paste the message into the list and send the Enter that takes the row under the cursor.
 * The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
 */
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let calls: { method: string; params: Record<string, unknown> }[];
let screen: string;
let agent: string;

/** a screen recorded as `herdr pane read --format ansi` gave it (0.163), as the text the bridge reads */
const recorded = (name: string): string => stripVTControlCharacters(readFileSync(new URL(`../../src/lib/fixtures-input-rows/codex/${name}.ansi`, import.meta.url), "utf8"));
/** a screen of Codex 0.167 as the bridge's own read gave it */
const recorded167 = (name: string): string => readFileSync(new URL(`../../src/lib/fixtures-input-rows/codex-0.167.0/${name}.txt`, import.meta.url), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-codex-screen-send-"));
  calls = [];
  agent = "codex";
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
          ? { pane: { pane_id: id, workspace_id: "w", tab_id: "w:t1", terminal_id: id, cwd: root, focused: false, revision: 0, agent, agent_status: "idle" } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: 2147483646, argv: [`/usr/bin/${agent}`], cwd: root }] } }
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
const send = (fromTerminal = false) => submit()("w:p1", "hello from chat", "hello from chat", Date.now(), fromTerminal).catch((error: unknown) => error);

it("refuses a Chat send while one of Codex's own screens is open, typing nothing", async () => {
  for (const shown of ["permissions-open-120", "permissions-open-40", "theme-open-120", "theme-open-40", "statusline-open-120", "statusline-open-40",
    "rename-open-120", "rename-open-40", "diff-open-120", "diff-open-40", "cd-untrusted-repo-open-120", "cd-untrusted-repo-open-40"]) {
    screen = recorded(shown);
    calls = [];
    const refused = await send();
    expect(refused, shown).toBeInstanceOf(HerdrError);
    expect((refused as HerdrError).code, shown).toBe("agent_blocked");
    expect(typed(), shown).toEqual([]);
  }
  // Codex 0.167: /model's lists (Enter under `enter default` saves the row for every new session), /permissions (its Enter
  // changed the permission mode), the folder question (its Enter answered it), and the screens 0.163 did not have
  for (const shown of ["model-list-100", "model-effort-40", "model-advanced-100", "permissions-100", "permissions-40", "trust-100", "trust-40", "review-40", "resume-100", "resume-40",
    "experimental-40", "statusline-40", "agents-100", "agents-help-40", "keymap-100", "find-40", "history-search-100", "diff-40", "rename-100", "theme-40"]) {
    screen = recorded167(shown);
    calls = [];
    const refused = await send();
    expect(refused, shown).toBeInstanceOf(HerdrError);
    expect((refused as HerdrError).code, shown).toBe("agent_blocked");
    expect(typed(), shown).toEqual([]);
  }
});

it("sends into Codex's composer: at rest, after a screen closed, and with a draft in it", async () => {
  for (const shown of ["permissions-idle-120", "permissions-idle-40", "permissions-closed-120", "permissions-closed-40", "rename-closed-40",
    "diff-closed-q-120", "diff-closed-q-40", "cd-untrusted-repo-closed-120", "mention-closed-120"]) {
    screen = recorded(shown);
    calls = [];
    expect(await send(), shown).toBeUndefined();
    expect(typed().map((call) => [call.method, call.params["text"]]), shown).toEqual([["agent.prompt", "hello from chat"]]);
  }
  // Codex 0.167, also with its shortcuts shown, the slash commands' popup over a draft, and at Ultra reasoning effort
  for (const shown of ["composer-empty-100", "composer-empty-40", "composer-draft-100", "composer-shortcuts-100", "composer-shortcuts-40", "slash-popup-100",
    "composer-ultra-empty-100", "composer-ultra-empty-40", "composer-ultra-draft-100", "composer-ultra-shortcuts-40", "composer-ultra-banner-100"]) {
    screen = recorded167(shown);
    calls = [];
    expect(await send(), shown).toBeUndefined();
    expect(typed().map((call) => [call.method, call.params["text"]]), shown).toEqual([["agent.prompt", "hello from chat"]]);
  }
});

it("leaves the terminal's own input line and other agents alone: neither is read for Codex's screens", async () => {
  screen = recorded("permissions-open-120");
  // the input line stands in for the keyboard: what it types is an answer to the list
  expect(await send(true)).toBeUndefined();
  expect(typed().length).toBeGreaterThan(0);
  expect(calls.some((call) => call.method === "pane.read")).toBeFalse();
  // the same rows on another agent's screen are not Codex's
  agent = "pi";
  calls = [];
  expect(await send()).toBeUndefined();
  expect(typed().map((call) => call.method)).toEqual(["agent.prompt"]);
});
