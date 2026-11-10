import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubmitText } from "./composer.ts";

// The real RPC client against a unix socket this test owns; only herdr's answers are synthetic.
let root: string;
let listener: ReturnType<typeof Bun.listen>;
let socketBefore: string | undefined;
let homeBefore: string | undefined;
let integration: string;
let agent: string;
/** whether herdr's omp integration has reported the pane's session (omp's session_start) */
let reported: boolean;
let ompPid: number;
let ompArgv: string[];
/** the directory herdr reports the omp process running in */
let ompCwd: string;
/** whether herdr still shows an omp process in the pane */
let ompShown: boolean;
let calls: { method: string; params: Record<string, unknown> }[];
let onPaneGet: (() => void) | undefined;
let refusePrompt: boolean;
/** a process started just now, standing in for an omp that is still starting */
let fresh: ReturnType<typeof Bun.spawn> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ovis-omp-submit-"));
  agent = "omp";
  reported = false;
  ompPid = 1;
  ompArgv = ["omp"];
  ompCwd = root;
  ompShown = true;
  calls = [];
  onPaneGet = undefined;
  refusePrompt = false;
  // the omp stand-ins and this process share a home with herdr's omp integration installed
  homeBefore = process.env["HOME"];
  process.env["HOME"] = root;
  integration = join(root, ".omp", "agent", "extensions", "herdr-omp-agent-state.ts");
  mkdirSync(join(root, ".omp", "agent", "extensions"), { recursive: true });
  writeFileSync(integration, "// installed by herdr\n");
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
        if (request.method === "agent.prompt" && refusePrompt) {
          socket.end(`${JSON.stringify({ id: request.id, error: { code: "agent_not_ready", message: "not ready" } })}\n`);
          return;
        }
        if (request.method === "pane.get") onPaneGet?.();
        const session = reported ? { agent_session: { agent: "omp", kind: "path", source: "herdr:omp", value: join(root, "session.jsonl") } } : {};
        const result = request.method === "pane.get"
          ? { pane: { pane_id: "w:p1", workspace_id: "w", tab_id: "w:t1", terminal_id: "w:p1", cwd: root, focused: false, revision: 0, agent, ...session } }
          : request.method === "pane.process_info" ? { process_info: { foreground_processes: ompShown ? [{ pid: ompPid, argv: ompArgv, cwd: ompCwd }] : [] } }
          : request.method === "agent.prompt" || request.method === "pane.send_keys" || request.method === "pane.send_text" ? {}
          // a chat send to a Codex pane reads its screen last (composer.ts freeCodexInput): nothing of Codex's own is up here
          : request.method === "pane.read" && agent === "codex" ? { read: { text: "" } }
          : null;
        if (result === null) throw new Error(`unexpected RPC ${request.method}`);
        socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      },
    },
  });
});

afterEach(async () => {
  fresh?.kill();
  await fresh?.exited;
  fresh = undefined;
  listener.stop(true);
  if (socketBefore === undefined) delete process.env["HERDR_SOCKET"];
  else process.env["HERDR_SOCKET"] = socketBefore;
  if (homeBefore === undefined) delete process.env["HOME"];
  else process.env["HOME"] = homeBefore;
  rmSync(root, { recursive: true, force: true });
});

const submitter = () => createSubmitText({
  options: { submitDelayMs: 0, ompReportPollMs: 5 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
  SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
});
const count = (method: string): number => calls.filter((call) => call.method === method).length;
const startedNow = async (environment: Record<string, string> = {}): Promise<number> => {
  // A pid alone can still expose the parent's pre-exec HOME through /proc, where the fixture's
  // integration is not installed. Wait for the child itself before publishing its process.
  const child = Bun.spawn([process.execPath, "-e", 'process.stdout.write("READY\\n"); process.stdin.resume()'], {
    env: {
      ...environment, HOME: root, PATH: process.env["PATH"] ?? "", TMPDIR: process.env["TMPDIR"],
      NODE_COMPILE_CACHE: process.env["NODE_COMPILE_CACHE"], BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"],
    }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  fresh = child;
  expect(await firstLine(child.stdout)).toBe("READY\n");
  return child.pid;
};
/** The first line a fixture prints: stdout can arrive in more than one chunk, so read up to the newline. */
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
async function until(what: string, done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}
const posix = process.platform !== "win32";

describe("a message sent to omp", () => {
  it.each([
    { target: "omp", text: "/model", expected: "/switch" },
    { target: "codex", text: "/model", expected: "/model" },
    { target: "omp", text: "/model x", expected: "/model x" },
  ])("sends $expected when $target receives $text", async ({ target, text, expected }) => {
    // Given an agent ready to receive a chat command.
    agent = target;
    reported = target === "omp";
    // When the chat command is sent immediately.
    await submitter()("w:p1", text, text, Date.now());
    // Then only omp's bare model command opens its session picker.
    expect(calls.find((call) => call.method === "agent.prompt")?.params["text"]).toBe(expected);
  });

  it.each([
    { target: "omp", text: "/model", expected: "/switch" },
    { target: "codex", text: "/model", expected: "/model" },
    { target: "omp", text: "/model x", expected: "/model x" },
  ])("types $expected when $target refuses $text", async ({ target, text, expected }) => {
    // Given an agent whose prompt RPC refuses immediate delivery.
    agent = target;
    reported = target === "omp";
    refusePrompt = true;
    // When the send falls back to terminal input.
    await submitter()("w:p1", text, text, Date.now());
    // Then the fallback preserves the immediate path's command choice.
    expect(calls.find((call) => call.method === "pane.send_text")?.params["text"]).toBe(expected);
    expect(calls.find((call) => call.method === "pane.send_keys")?.params["keys"]).toEqual(["Enter"]);
  });

  it("is sent at once to an omp whose integration has reported its session", async () => {
    reported = true;
    ompPid = posix ? await startedNow() : 1;
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    // no startup wait reads omp's process: the one read is the outcome's process binding, alongside delivery
    expect(count("pane.process_info")).toBe(1);
  });

  it.skipIf(!posix)("waits while an omp started moments ago has not reported, then sends once and presses nothing", async () => {
    ompPid = await startedNow();
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now());
    await until("a few looks at the starting omp", () => count("pane.get") >= 3);
    expect(count("agent.prompt"), "nothing is sent before omp takes input").toBe(0);
    reported = true;
    await sent;
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.send_keys")).toBe(0);
  });

  it.skipIf(!posix)("sends at once to a starting omp without herdr's integration, which nothing would report", async () => {
    rmSync(integration);
    ompPid = await startedNow();
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.get")).toBe(1);
  });

  for (const equals of [false, true]) it.skipIf(!posix)(`waits for the integration report with --session-dir${equals ? "=" : " "}X`, async () => {
    // Given: sessions moved, but herdr's integration remains in the normal agent directory.
    ompPid = await startedNow();
    const sessions = join(root, "sessions");
    ompArgv = ["omp", ...(equals ? [`--session-dir=${sessions}`] : ["--session-dir", sessions])];
    onPaneGet = () => {
      if (count("pane.get") !== 2) return;
      expect(count("agent.prompt"), "nothing is sent before the integration reports").toBe(0);
      reported = true;
    };
    // When: a chat message arrives before the integration reports.
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    // Then: delivery follows the report, once, without extra keys.
    expect(reported).toBe(true);
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.send_keys")).toBe(0);
  });

  // omp 18.8.7 loads the integration from where these put it, so each waits for the report
  for (const { name, place, environ } of [
    { name: "in the project's .omp/extensions", place: () => { ompCwd = join(root, "project"); return join(ompCwd, ".omp", "extensions"); } },
    { name: "named by -e", place: () => { const dir = join(root, "elsewhere"); ompArgv = ["omp", "-e", join(dir, "herdr-omp-agent-state.ts")]; return dir; } },
    { name: "named by --hook under --no-extensions", place: () => { const dir = join(root, "elsewhere"); ompArgv = ["omp", "--no-extensions", "--hook", join(dir, "herdr-omp-agent-state.ts")]; return dir; } },
    // only Linux shows the server another process's environment
    { name: "in the agent directory PI_CODING_AGENT_DIR names", place: () => join(root, "custom-agent", "extensions"), environ: true },
  ]) it.skipIf(!posix || environ === true && process.platform !== "linux")(`waits for the report of an integration ${name}`, async () => {
    // Given: the integration is not in the default agent directory, but where this omp loads it.
    rmSync(integration);
    const dir = place();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "herdr-omp-agent-state.ts"), "// installed by herdr\n");
    ompPid = await startedNow({ PI_CODING_AGENT_DIR: join(root, "custom-agent") });
    onPaneGet = () => {
      if (count("pane.get") !== 2) return;
      expect(count("agent.prompt"), "nothing is sent before the integration reports").toBe(0);
      reported = true;
    };
    // When: a chat message arrives before the integration reports.
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    // Then: delivery follows the report, once.
    expect(reported).toBe(true);
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.send_keys")).toBe(0);
  });

  for (const argv of [["omp", "--no-extensions"], ["omp", "--trusted-extension", "/opt/other.ts"]]) it.skipIf(!posix)(`sends at once to a starting \`${argv.join(" ")}\`, which loads no installed integration`, async () => {
    ompArgv = argv;
    ompPid = await startedNow();
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.get")).toBe(1);
  });

  it.skipIf(!posix)("sends once the report came even when herdr no longer shows the omp process", async () => {
    // a lookup that finds no omp proves nothing about a replacement: the pane's agent is still omp
    ompPid = await startedNow();
    onPaneGet = () => {
      if (count("pane.get") !== 2) return;
      reported = true;
      ompShown = false;
    };
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.send_keys")).toBe(0);
  });

  it.skipIf(!posix)("says in the server log when an omp never reported before the wait ran out, then sends once", async () => {
    ompPid = await startedNow();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      await createSubmitText({
        // past processStartedAt's up to one second of boot-time rounding, so the wait really runs
        options: { submitDelayMs: 0, ompReportPollMs: 5, ompStartupMs: 2_500 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
        SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
      })("w:p1", "/effort", "/effort", Date.now());
      expect(warn.mock.calls.filter(([line]) => String(line).startsWith("[omp] w:p1:"))).toHaveLength(1);
      expect(count("agent.prompt")).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("sends at once to an omp that has run for long, which may have no integration", async () => {
    ompPid = 1;
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.get")).toBe(1);
  });

  it.skipIf(!posix)("stops waiting once the sender may no longer send, and sends nothing", async () => {
    ompPid = await startedNow();
    let permitted = true;
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now(), false, () => { if (!permitted) throw new Error("revoked"); });
    await until("a look at the starting omp", () => count("pane.get") >= 2);
    permitted = false;
    await expect(sent).rejects.toThrow("revoked");
    expect(count("agent.prompt")).toBe(0);
  });

  it.skipIf(!posix)("sends nothing when the sender lost access while the last look was answered", async () => {
    ompPid = await startedNow();
    let permitted = true;
    onPaneGet = () => {
      if (count("pane.get") < 3) return;
      reported = true;
      permitted = false;
    };
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now(), false, () => { if (!permitted) throw new Error("revoked"); });
    await expect(sent).rejects.toThrow("revoked");
    expect(count("agent.prompt")).toBe(0);
  });

  it.skipIf(!posix)("sends nothing when the pane is restarted into another omp while it is waited for", async () => {
    ompPid = await startedNow();
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now());
    await until("a look at the starting omp", () => count("pane.get") >= 2);
    const replacement = Bun.spawn(["sleep", "60"], { env: { ...process.env, HOME: root } });
    try {
      ompPid = replacement.pid;
      reported = true;
      await expect(sent).rejects.toThrow("was replaced");
      expect(count("agent.prompt")).toBe(0);
    } finally {
      replacement.kill();
    }
  });

  it.skipIf(!posix)("sends nothing when the wait runs out on another omp the pane was restarted into", async () => {
    ompPid = await startedNow();
    const replacement = Bun.spawn(["sleep", "60"], { env: { ...process.env, HOME: root } });
    try {
      const sent = createSubmitText({
        // past processStartedAt's up to one second of boot-time rounding, so the wait really runs
        options: { submitDelayMs: 0, ompReportPollMs: 5, ompStartupMs: 2_500 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => false,
        SUBMIT_DEADLINE_MS: 20_000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
      })("w:p1", "/effort", "/effort", Date.now());
      await until("a look at the starting omp", () => count("pane.get") >= 2);
      ompPid = replacement.pid;
      await expect(sent).rejects.toThrow("was replaced");
      expect(count("agent.prompt")).toBe(0);
    } finally {
      replacement.kill();
    }
  });

  it.skipIf(!posix)("sends nothing when omp stops while it is waited for", async () => {
    ompPid = await startedNow();
    onPaneGet = () => {
      if (count("pane.get") === 2) agent = "";
    };
    const sent = submitter()("w:p1", "/effort", "/effort", Date.now());
    await expect(sent).rejects.toThrow("stopped while it started");
    expect(count("pane.get")).toBe(2);
    expect(count("agent.prompt") + count("pane.send_text") + count("pane.send_keys")).toBe(0);
  });

  it.skipIf(!posix)("does not wait for another agent", async () => {
    agent = "codex";
    ompPid = await startedNow();
    await submitter()("w:p1", "/effort", "/effort", Date.now());
    expect(count("agent.prompt")).toBe(1);
    expect(count("pane.get"), "no look at a starting omp").toBe(1);
  });
});
