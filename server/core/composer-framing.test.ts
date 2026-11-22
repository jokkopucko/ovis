import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "../herdr/client.ts";
import { PendingInputError } from "../pending-input.ts";
import { closeBackslash, createSubmitText, pendingFault, pendingText, submitFraming } from "./composer.ts";

let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let calls: { method: string; params: Record<string, unknown> }[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "herdr-web-ui-submit-framing-"));
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
        if (request.method === "agent.prompt") {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "agent_not_found", message: "no agent" } })}\n`);
          return;
        }
        const result = request.method === "pane.get" ? { pane: { pane_id: "w:p1", workspace_id: "w", tab_id: "w:t1", terminal_id: "w:p1", cwd: root, focused: false, revision: 0 } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: [] } }
          : request.method === "pane.send_text" || request.method === "pane.send_keys" ? {}
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

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});
const START = "\u001b[200~";
const END = "\u001b[201~";
const writes = () => calls.filter((call) => call.method === "pane.send_text" || call.method === "pane.send_keys" || call.method === "agent.prompt");
const refusal = async (send: Promise<void>): Promise<string> => {
  const error = await send.then(() => null, (error: unknown) => error);
  expect(error).toBeInstanceOf(HerdrError);
  return (error as HerdrError).code;
};

describe("an immediate submit's paste framing", () => {
  it("accepts bare and exactly once wrapped canonical submits", async () => {
    const text = "첫 줄\tcolumn\r\nsecond ✓\rthird 🙂\n\n";
    const body = "첫 줄\tcolumn\rsecond ✓\rthird 🙂";
    for (const typed of [true, false]) for (const payload of [body, START + body + END]) {
      calls.length = 0;
      await submitter()("w:p1", text, payload, Date.now(), typed);
      expect(calls.find((call) => call.method === "pane.send_text")?.params.text, `typed ${typed}`).toBe(payload);
      expect(calls.filter((call) => call.method === "pane.send_keys").map((call) => call.params.keys), "one Enter of its own").toEqual([["Enter"]]);
    }
    for (const [typed, payload] of [[true, ""], [false, START + END]] as const) {
      calls.length = 0;
      await submitter()("w:p1", "", payload, Date.now(), typed);
      expect(calls.find((call) => call.method === "pane.send_text")?.params.text).toBe(payload);
      expect(calls.filter((call) => call.method === "pane.send_keys")).toHaveLength(1);
    }
  });

  it("refuses forged framing before any text key or draft-clear write", async () => {
    const forged: Array<[string, string, string]> = [
      ["an embedded end marker, then a command", "ok\u001b[201~\rtouch /tmp/pwned", `${START}ok${END}\rtouch /tmp/pwned${END}`],
      ["an embedded start marker", `a${START}b`, `${START}a${START}b${END}`],
      ["a payload that disagrees with its text", "ls", "rm -rf ~"],
      ["a hidden trailing CR (an extra Enter)", "ls", "ls\r"],
      ["a CR hidden inside the paste", "ls", `${START}ls\r${END}`],
      ["LF where the payload needs CR", "a\nb", "a\nb"],
      ["a lone start marker", "ls", `${START}ls`],
      ["a lone end marker", "ls", `ls${END}`],
      ["repeated markers", "ls", `${START}${START}ls${END}${END}`],
      ["reversed markers", "ls", `${END}ls${START}`],
      ["a control character", "a\u0003b", "a\u0003b"],
      ["a C1 control", "a\u009b31mb", "a\u009b31mb"],
      ["an escape sequence", "\u001b[31mred", "\u001b[31mred"],
    ];
    for (const typed of [true, false]) for (const [what, text, payload] of forged) {
      calls.length = 0;
      expect(await refusal(submitter()("w:p1", text, payload, Date.now(), typed)), `${what}, typed ${typed}`).toBe("invalid_submit_text");
      expect(calls, `${what}, typed ${typed}: herdr is not even asked`).toEqual([]);
    }
    calls.length = 0;
    const confirmation = { draft: "old draft", identity: { agent: "claude", terminalId: "w:p1", session: null } };
    expect(await refusal(submitter()("w:p1", "ls", "ls\r", Date.now(), false, () => {}, "old draft", confirmation))).toBe("invalid_submit_text");
    expect(writes()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("caps a chat message at 20000 characters and a typed line at 32768, refusing more before any input", async () => {
    const accepted: Array<[boolean, number]> = [[false, 20_000], [true, 20_001], [true, 32_768]];
    for (const [typed, length] of accepted) {
      calls.length = 0;
      const text = "x".repeat(length);
      await submitter()("w:p1", text, text, Date.now(), typed);
      expect(calls.find((call) => call.method === "pane.send_text")?.params.text, `${length}, typed ${typed}`).toBe(text);
    }
    for (const [typed, length] of [[false, 20_001], [true, 32_769]] as const) {
      calls.length = 0;
      const text = "x".repeat(length);
      expect(await refusal(submitter()("w:p1", text, text, Date.now(), typed)), `${length}, typed ${typed}`).toBe("invalid_submit_text");
      expect(calls).toEqual([]);
    }
  });
});

it("reads a message of line breaks that do not end it in one pass, before it refuses it", () => {
  // `/[\r\n]+$/` starts over at every line break of a run that does not end the text: 40,000 took 1.4 s and twice as
  // many four times that, on the server's only thread, for a frame any connection that may type can send. With the
  // pattern these take seconds each and the test times out; in one pass they take under a millisecond
  const breaks = `${"\n".repeat(60_000)}a`;
  for (const typed of [false, true]) expect(() => submitFraming(breaks, breaks.replace(/\n/g, "\r"), typed)).toThrow("at most");
  expect(() => pendingText(breaks)).toThrow("at most");
  expect(() => pendingText(`${"\r\n".repeat(30_000)}a`)).toThrow("at most");
  expect(submitFraming(`hi${"\r\n".repeat(50_000)}`, "hi", false)).toEqual({ text: "hi", payload: "hi" });
  expect(pendingText(`a\r\nb${"\n".repeat(50_000)}`)).toBe("a\nb");
}, 5_000);

it("refuses a message of more than twice its limit, and takes one of up to twice its limit that is short enough once read", () => {
  for (const [typed, limit] of [[false, 20_000], [true, 32_768]] as const) {
    const most = `${"\r\n".repeat(limit - 1)}a`;
    expect(submitFraming(most, `\u001b[200~${"\r".repeat(limit - 1)}a\u001b[201~`, typed).text, `${limit}`).toBe(`${"\n".repeat(limit - 1)}a`);
    expect(() => submitFraming(`${most}\r\nb`, `\u001b[200~${"\r".repeat(limit)}b\u001b[201~`, typed), `${limit}`).toThrow(`at most ${limit}`);
    expect(() => submitFraming(`${"\n".repeat(2 * limit)}a`, `${"\r".repeat(2 * limit)}a`, typed), `${limit}`).toThrow(`at most ${limit}`);
  }
  expect(pendingText(`${"\r\n".repeat(19_999)}a`)).toBe(`${"\n".repeat(19_999)}a`);
  expect(() => pendingText(`${"\r\n".repeat(20_000)}a`)).toThrow("at most 20000");
  expect(() => pendingText(`${"\n".repeat(40_000)}a`)).toThrow("at most 20000");
});

describe("a pending row's fault", () => {
  it("is the view's words for a failed herdr call, and the error's own without one", () => {
    const view = () => ({ code: "worded", message: "the view's words" });
    const failed = () => new HerdrError("connect_failed", "herdr's own words", false, true);
    expect([pendingFault(failed(), view), pendingFault(failed(), undefined)]).toEqual([view(), { code: "connect_failed", message: "herdr's own words" }]);
    expect(pendingFault(new HerdrError("agent_blocked", "the bridge's words"), view)).toEqual({ code: "agent_blocked", message: "the bridge's words" });
    expect(pendingFault(new PendingInputError("pending_wait", "the bridge's words"), view)).toEqual({ code: "pending_wait", message: "the bridge's words" });
    expect([pendingFault(new TypeError("other"), view), pendingFault(new TypeError("other"), undefined)])
      .toEqual([{ code: "submit_failed", message: view().message }, { code: "submit_failed", message: "other" }]);
  });
});

describe("closeBackslash", () => {
  // Pi's editor (pi-tui 1.5.2) reads `\` + Enter as a new line too: the message stayed in its box, and its later
  // record (without the backslash) never matched the chat's receipt, which then waited for its transcript forever
  it("gives a Pi message that ends in a backslash a space, so its Enter sends", () => {
    expect(closeBackslash("pi", "under requisiciones? \\")).toBe("under requisiciones? \\ ");
    expect(closeBackslash("pi", "\u001b[200~see C:\\temp\\\u001b[201~")).toBe("\u001b[200~see C:\\temp\\ \u001b[201~");
    expect(closeBackslash("pi", "see C:\\temp\\x")).toBe("see C:\\temp\\x");
  });
});
