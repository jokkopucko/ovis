import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { HerdrError } from "../herdr/client.ts";
import { createSubmitText } from "./composer.ts";

const FIXTURES = join(import.meta.dir, "../../src/lib/fixtures-input-rows");
const recorded = (path: string): string => readFileSync(join(FIXTURES, path), "utf8");

let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let pane: { agent: string; argv: string[] };
let screens: { visible: string; live?: string };
let next: typeof screens | undefined;
let reads: number;
let calls: { method: string; params: Record<string, unknown> }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-agent-input-"));
  calls = [];
  screens = { visible: "" };
  next = undefined;
  reads = 0;
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
        const result = request.method === "pane.get" ? { pane: {
          pane_id: "w:p1", workspace_id: "w", tab_id: "w:t1", terminal_id: "t1", cwd: root, focused: false, revision: 0,
          agent: pane.agent, agent_status: "idle",
        } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [{ pid: 2147483646, argv: pane.argv, cwd: root }] } }
          : request.method === "pane.read" ? { read: { text: shownBy(request.params?.["source"]) } }
          : request.method === "agent.prompt" ? {}
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
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

function shownBy(source: unknown): string {
  const shown = reads++ > 0 && next ? next : screens;
  return source === "visible" ? shown.visible : shown.live ?? stripVTControlCharacters(shown.visible);
}

const submit = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
})("w:p1", "hello", "hello", Date.now());

const prompted = (): boolean => calls.some((call) => call.method === "agent.prompt");

async function refused(): Promise<HerdrError> {
  const error = await submit().catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HerdrError);
  return error as HerdrError;
}

it.each([
  ["pi", ["pi"], "pi/draft-typed-119.ansi"],
  ["codex", ["codex"], "codex-0.167.0/composer-ultra-draft-100.ansi"],
  ["codex", ["codex"], "codex/mention-closed-120.ansi"],
  ...["gjc", "muse", "qwen", "cline", "dsh-tui", "letta", "maki", "kimi", "gemini", "kilo", "omp"].map((agent): [string, string[], string] => [agent, [agent], `${agent}/draft-typed-119.ansi`]),
  ["omp", ["omp"], "omp/draft-lines-119.ansi"],
  ["omp", ["omp"], "omp/draft-slash-119.ansi"],
])("refuses an immediate send to %s over text typed in its input box (%s), typing nothing", async (agent, argv, screen) => {
  pane = { agent, argv };
  screens.visible = recorded(screen);
  expect((await refused()).code).toBe("input_draft");
  expect(prompted()).toBeFalse();
});

it.each([
  ["pi", ["pi"], "pi/draft-empty-119.ansi"],
  // pi's autocomplete pushes its box up past the footer: the box is not made out, so the send goes as before
  ["pi", ["pi"], "pi/draft-slash-119.ansi"],
  ["codex", ["codex"], "codex-0.167.0/composer-ultra-empty-100.ansi"],
  ...["gjc", "muse", "qwen", "cline", "dsh-tui", "letta", "maki", "kimi", "gemini", "kilo", "omp"].map((agent): [string, string[], string] => [agent, [agent], `${agent}/draft-empty-119.ansi`]),
  // omp 18.8.7's framed editor was recorded only empty: its box reports no typed cells, so it is sent to as before
  ["omp", ["omp"], "omp/settings-idle-119.ansi"],
  ["an-unrecorded-agent", ["an-unrecorded-agent"], "pi/draft-typed-119.ansi"],
])("sends to %s when its box shows no typed text (%s)", async (agent, argv, screen) => {
  pane = { agent, argv };
  screens.visible = recorded(screen);
  await submit();
  expect(prompted()).toBeTrue();
  if (agent === "an-unrecorded-agent") expect(calls.some((call) => call.method === "pane.read" && call.params["source"] === "visible")).toBeFalse();
});

it("judges Codex's own screens and its composer on the same last read: a dialog that opens after the first read is refused", async () => {
  pane = { agent: "codex", argv: ["codex"] };
  screens.visible = recorded("codex-0.167.0/composer-ultra-empty-100.ansi");
  const effort = readFileSync(join(FIXTURES, "codex-0.167.0/model-effort-40.txt"), "utf8");
  next = { visible: effort, live: effort };
  expect((await refused()).code).toBe("agent_blocked");
  expect(prompted()).toBeFalse();
});

it("takes no colours from a viewport that is not the live screen: a draft shown there, over an empty live composer, is no draft", async () => {
  pane = { agent: "codex", argv: ["codex"] };
  screens.visible = recorded("codex-0.167.0/composer-ultra-draft-100.ansi");
  screens.live = readFileSync(join(FIXTURES, "codex-0.167.0/composer-empty-100.txt"), "utf8");
  await submit();
  expect(prompted()).toBeTrue();
  expect(new Set(calls.filter((call) => call.method === "pane.read").map((call) => call.params["source"]))).toEqual(new Set(["visible", "detection"]));
});

it("reads again when text is typed between the viewport's read and the live one, and refuses over it", async () => {
  pane = { agent: "pi", argv: ["pi"] };
  screens.visible = recorded("pi/draft-empty-119.ansi");
  const typedScreen = recorded("pi/draft-typed-119.ansi");
  next = { visible: typedScreen };
  expect((await refused()).code).toBe("input_draft");
  expect(prompted()).toBeFalse();
});

it("takes the viewport for the live screen when the live read only holds a row more above it, as Gemini's does", async () => {
  pane = { agent: "gemini", argv: ["gemini"] };
  screens.visible = recorded("gemini/draft-typed-119.ansi");
  screens.live = `a row above the viewport\n${stripVTControlCharacters(screens.visible)}`;
  expect((await refused()).code).toBe("input_draft");
  expect(prompted()).toBeFalse();
});

it("takes nothing from a read without colour, where a placeholder looks typed", async () => {
  pane = { agent: "pi", argv: ["pi"] };
  screens.visible = stripVTControlCharacters(recorded("pi/draft-typed-119.ansi"));
  await submit();
  expect(prompted()).toBeTrue();
});
