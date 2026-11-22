import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeKiroTranscript, isKiroChatProcess, kiroConversation, kiroSessionsDirectory, kiroToolOutput, projectKiro, resolveKiroTranscript } from "./kiro.ts";
import { ConversationUnavailable, HistoryChanged } from "./conversation-shared.ts";
import { forgetPaneTranscriptState, forgetTranscriptState } from "./conversation.ts";
import * as herdr from "./herdr/client.ts";
import * as processProbe from "./omp-process.ts";
import { processStartedAt } from "./process-start.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import type { SessionSnapshot } from "../shared/protocol.ts";

const fixture = (name: string) => readFile(join(import.meta.dir, "fixtures", "kiro", name), "utf8");
const linuxTest = process.platform === "linux" ? test : test.skip;
const ID = "4c5c1f62-4983-42f5-8f58-229583334dbd";
const OTHER = "e4636ff3-c205-49a9-aa56-a5d6e97a6b6e";
/** What herdr reports in front of a Kiro CLI 2.35.2 chat (pane.process_info). */
const TUI_ARGV = ["/home/user/.local/share/kiro-cli/bun", "--no-env-file", "--config=/home/user/.local/share/kiro-cli/bunfig.toml", "/home/user/.local/share/kiro-cli/tui.js", "chat"];

let home: string;
let sessions: string;
let memory: ReturnType<typeof spyOn<typeof processProbe, "ompProcessMemory">>;
const standIns: number[] = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "ovis-kiro-home-"));
  sessions = join(home, ".kiro", "sessions", "cli");
  await mkdir(sessions, { recursive: true });
  memory = spyOn(processProbe, "ompProcessMemory").mockResolvedValue({ argv: [], environ: [`HOME=${home}`] });
});
afterEach(async () => {
  memory.mockRestore();
  for (const pid of standIns.splice(0)) try { process.kill(pid, "SIGKILL"); } catch {}
  await rm(home, { recursive: true, force: true });
});

/**
 * A TUI stand-in running as `kiro-cli-chat chat`, whose child runs as `kiro-cli-chat acp`, as Kiro's session
 * process does.
 */
async function kiroPane(): Promise<{ tui: number; acp: number }> {
  const dir = await mkdtemp(join(home, "pane-"));
  await writeFile(join(dir, "acp"), "ready\n");
  await writeFile(join(dir, "chat"), "(exec -a kiro-cli-chat tail acp -f) & wait\n");
  const tui = Bun.spawn(["bash", "chat"], { argv0: "kiro-cli-chat", cwd: dir, stdout: "pipe", stderr: "ignore" });
  standIns.push(tui.pid);
  const reader = tui.stdout.getReader();
  let seen = "";
  while (!seen.includes("ready")) {
    const { value, done } = await reader.read();
    if (done) throw new Error("the stand-in exited");
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  const [acp] = (await readFile(`/proc/${tui.pid}/task/${tui.pid}/children`, "utf8")).trim().split(" ").map(Number);
  standIns.push(acp!);
  return { tui: tui.pid, acp: acp! };
}
const foreground = (pid: number, argv = TUI_ARGV) => ({ foreground_processes: [{ pid, argv }] });
/** Kiro opens its session seconds after its process starts (initializing): a lock dated a second on is like that. */
const lock = (id: string, pid: number, startedAt = new Date(Date.now() + 1000)) => writeFile(join(sessions, `${id}.lock`), JSON.stringify({ pid, started_at: startedAt.toISOString() }));

describe("Kiro session binding", () => {
  linuxTest("binds the session the pane's own Kiro process holds locked", async () => {
    const pane = await kiroPane();
    await writeFile(join(sessions, `${ID}.jsonl`), await fixture("interactive-2.35.1.jsonl"));
    await lock(ID, pane.acp);
    expect((await resolveKiroTranscript(foreground(pane.tui))).session).toBe(ID);
  });

  linuxTest("two Kiro panes in one folder each read their own session", async () => {
    const first = await kiroPane();
    const second = await kiroPane();
    await writeFile(join(sessions, `${ID}.jsonl`), "");
    await writeFile(join(sessions, `${OTHER}.jsonl`), "");
    await lock(ID, first.acp);
    await lock(OTHER, second.acp);
    expect((await resolveKiroTranscript(foreground(first.tui))).session).toBe(ID);
    expect((await resolveKiroTranscript(foreground(second.tui))).session).toBe(OTHER);
  });

  linuxTest("a Kiro that holds no session yet, and one that was quit, stay on the terminal", async () => {
    const pane = await kiroPane();
    await writeFile(join(sessions, `${OTHER}.jsonl`), await fixture("interactive-2.35.1.jsonl"));
    await expect(resolveKiroTranscript(foreground(pane.tui))).rejects.toBeInstanceOf(ConversationUnavailable);
  });

  linuxTest("follows the lock when Kiro switches sessions in its TUI", async () => {
    const pane = await kiroPane();
    await writeFile(join(sessions, `${ID}.jsonl`), "");
    await writeFile(join(sessions, `${OTHER}.jsonl`), "");
    await lock(ID, pane.acp);
    expect((await resolveKiroTranscript(foreground(pane.tui))).session).toBe(ID);
    // `/chat new` and `/chat <id>` move the lock to the session now open
    await rm(join(sessions, `${ID}.lock`));
    await lock(OTHER, pane.acp);
    expect((await resolveKiroTranscript(foreground(pane.tui))).session).toBe(OTHER);
  });

  linuxTest("never binds a stale lock, two locks, or a log outside the store", async () => {
    const pane = await kiroPane();
    await writeFile(join(sessions, `${ID}.jsonl`), "");
    await lock(ID, pane.acp, new Date(Date.now() - 600_000));
    await expect(resolveKiroTranscript(foreground(pane.tui))).rejects.toBeInstanceOf(ConversationUnavailable);
    await lock(ID, pane.acp);
    await writeFile(join(sessions, `${OTHER}.jsonl`), "");
    await lock(OTHER, pane.acp);
    await expect(resolveKiroTranscript(foreground(pane.tui))).rejects.toBeInstanceOf(ConversationUnavailable);
    await rm(join(sessions, `${OTHER}.lock`));
    await rm(join(sessions, `${ID}.jsonl`));
    await writeFile(join(home, "elsewhere.jsonl"), "");
    await symlink(join(home, "elsewhere.jsonl"), join(sessions, `${ID}.jsonl`));
    await expect(resolveKiroTranscript(foreground(pane.tui))).rejects.toBeInstanceOf(ConversationUnavailable);
  });

  linuxTest("a lock no later than the process's start is never its own", async () => {
    const pane = await kiroPane();
    await writeFile(join(sessions, `${ID}.jsonl`), "");
    // the start read from boot time can be up to a second early: a lock that old may be an earlier process's
    await lock(ID, pane.acp, new Date(processStartedAt(pane.acp)!));
    await expect(resolveKiroTranscript(foreground(pane.tui))).rejects.toBeInstanceOf(ConversationUnavailable);
  });

  linuxTest("a session log linked to another session, or a lock that is a link, binds nothing", async () => {
    const pane = await kiroPane();
    await writeFile(join(sessions, `${OTHER}.jsonl`), await fixture("interactive-2.35.1.jsonl"));
    await symlink(join(sessions, `${OTHER}.jsonl`), join(sessions, `${ID}.jsonl`));
    await lock(ID, pane.acp);
    await expect(resolveKiroTranscript(foreground(pane.tui))).rejects.toBeInstanceOf(ConversationUnavailable);
    await rm(join(sessions, `${ID}.jsonl`));
    await writeFile(join(sessions, `${ID}.jsonl`), "");
    await writeFile(join(home, "elsewhere.lock"), JSON.stringify({ pid: pane.acp, started_at: new Date(Date.now() + 1000).toISOString() }));
    await rm(join(sessions, `${ID}.lock`));
    await symlink(join(home, "elsewhere.lock"), join(sessions, `${ID}.lock`));
    await expect(resolveKiroTranscript(foreground(pane.tui))).rejects.toBeInstanceOf(ConversationUnavailable);
    await rm(join(sessions, `${ID}.lock`));
    expect(spawnSync("mkfifo", [join(sessions, `${ID}.lock`)]).status).toBe(0);
    await expect(resolveKiroTranscript(foreground(pane.tui))).rejects.toBeInstanceOf(ConversationUnavailable);
  });

  linuxTest("another program in front binds nothing, even with a Kiro child", async () => {
    const pane = await kiroPane();
    await writeFile(join(sessions, `${ID}.jsonl`), "");
    await lock(ID, pane.acp);
    await expect(resolveKiroTranscript(foreground(pane.tui, ["bash"]))).rejects.toBeInstanceOf(ConversationUnavailable);
  });

  test("recognizes Kiro's chat processes only", () => {
    expect(isKiroChatProcess(["kiro-cli", "chat"])).toBe(true);
    expect(isKiroChatProcess(["kiro-cli-chat", "chat"])).toBe(true);
    expect(isKiroChatProcess(TUI_ARGV)).toBe(true);
    expect(isKiroChatProcess(["kiro-cli", "login"])).toBe(false);
    expect(isKiroChatProcess(["kiro-cli-chat", "acp"])).toBe(false);
    expect(isKiroChatProcess(["node", "/tmp/tui.js", "chat"])).toBe(false);
  });

  test("finds the store from KIRO_HOME, else HOME", () => {
    expect(kiroSessionsDirectory(["HOME=/home/user"])).toBe("/home/user/.kiro/sessions/cli");
    expect(kiroSessionsDirectory(["HOME=/home/user", "KIRO_HOME=/opt/kiro"])).toBe("/opt/kiro/sessions/cli");
    expect(kiroSessionsDirectory(["HOME=/home/user", "KIRO_HOME=relative"])).toBeNull();
    expect(kiroSessionsDirectory([])).toBeNull();
  });
});

describe("Kiro conversation", () => {
  async function bound(text: string) {
    const path = join(sessions, `${ID}.jsonl`);
    await writeFile(path, text);
    const binding = await authorizeKiroTranscript(path, sessions);
    if (binding === null) throw new Error("fixture not authorized");
    return binding;
  }

  test("shows prompts, answers and tool calls with their results", async () => {
    const { turns } = projectKiro(await fixture("tools-resumed-2.35.1.jsonl"), "inode", ID);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(turns[0]!.parts).toEqual([{ kind: "text", text: "what is in the README?" }]);
    expect(turns[1]!.parts).toMatchObject([
      { kind: "text", text: "Let me read the README." },
      { kind: "tool", name: "read", summary: "Read the project README", state: "ok", output: "# Demo\n\nHello from the demo project." },
      { kind: "text", text: "The README says **Hello from the demo project.**", phase: "final_answer" },
    ]);
    expect(turns[3]!.parts).toMatchObject([
      { kind: "tool", name: "shell", summary: "List the project files", input: '{"command":"ls -1"}', state: "ok", output: "README.md\n" },
      { kind: "tool", name: "read", state: "error", error: true },
      { kind: "text", phase: "final_answer" },
    ]);
  });

  test("marks /clear, a cancelled tool and /compact as Kiro recorded them", async () => {
    const { turns } = projectKiro(await fixture("clear-cancel-compact-2.35.2.jsonl"), "inode", ID);
    expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind)])).toEqual([
      ["user", ["text"]],
      ["assistant", ["text"]],
      ["user", ["notice"]],
      ["user", ["text"]],
      ["assistant", ["text", "tool", "text"]],
      ["user", ["compact"]],
    ]);
    expect(turns[2]!.parts[0]).toEqual({ kind: "notice", text: "Conversation cleared", source: "clear" });
    expect(turns[4]!.parts[1]).toMatchObject({ state: "error", output: "Tool use was cancelled by the user" });
    expect(turns[4]!.parts[2]).toMatchObject({ kind: "text", phase: "final_answer" });
    expect(turns[5]!.parts[0]).toEqual({ kind: "compact", text: "After slow." });
  });

  test("a reply carries its prompt's time, so each finish is told apart", async () => {
    const { turns } = projectKiro(await fixture("tools-resumed-2.35.1.jsonl"), "inode", ID);
    expect(turns.map((turn) => turn.ts)).toEqual(["2026-10-29T06:46:03.000Z", "2026-10-29T06:46:03.000Z", "2026-10-29T06:46:40.000Z", "2026-10-29T06:46:40.000Z"]);
  });

  test("a command that exited non-zero shows as failed, as Kiro 2.35.2 records it", () => {
    // Kiro writes `status: "success"` for it; only `exit_status` tells
    const result = { version: "v1", kind: "ToolResults", data: { content: [{ kind: "toolResult", data: { toolUseId: "tooluse_fail", content: [{ kind: "json", data: { exit_status: "exit status: 3", stdout: "out\n", stderr: "err\n" } }], status: "success" } }] } };
    const rows = [JSON.parse(TOOL_TURN.split("\n")[0]!), { version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { toolUseId: "tooluse_fail", name: "shell", input: { command: "exit 3" } } }] } }, result];
    const { turns } = projectKiro(rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "inode", ID);
    expect(turns[1]!.parts[0]).toMatchObject({ kind: "tool", state: "error", error: true, output: "out\n\nerr\n" });
  });

  test("a turn still running a tool has no final answer yet", () => {
    const { turns } = projectKiro(`${TOOL_TURN.split("\n").slice(0, 2).join("\n")}\n`, "inode", ID);
    expect(turns[1]!.parts).toMatchObject([{ kind: "text" }, { kind: "tool", state: "pending" }]);
    expect(turns[1]!.parts.some((part) => part.kind === "text" && part.phase === "final_answer")).toBe(false);
  });

  test("records it cannot read keep the terminal", () => {
    for (const row of [
      { version: "v1", kind: "ResetTo", data: {} },
      { version: "v1", kind: "CancelledPrompt", data: {} },
      { version: "v2", kind: "Prompt", data: { content: [] } },
      { version: "v1", kind: "ToolResults", data: { content: [{ kind: "toolResult", data: { toolUseId: "unknown", content: [] } }] } },
      { version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "video" }] } },
      { version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "describe this" }, { kind: "image", data: {} }] } },
    ]) expect(() => projectKiro(`${JSON.stringify(row)}\n`, "inode", ID)).toThrow(ConversationUnavailable);
    expect(() => projectKiro("{not json\n", "inode", ID)).toThrow(ConversationUnavailable);
  });

  test("waits for an unfinished last line", async () => {
    const text = await fixture("interactive-2.35.1.jsonl");
    const binding = await bound(text.slice(0, -20));
    expect((await kiroConversation(binding)).turns).toHaveLength(1);
  });

  test("pages history and notices an earlier message changing", async () => {
    const prompts = Array.from({ length: 60 }, (_, i) => JSON.stringify({ version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: String(i) }], meta: { timestamp: 1793256363 + i } } }));
    const binding = await bound(`${prompts.join("\n")}\n`);
    const page = await kiroConversation(binding);
    expect(page.source).toBe("kiro-transcript");
    expect(page.turns).toHaveLength(50);
    expect((await kiroConversation(binding, { before: page.cursor! })).turns).toHaveLength(10);
    expect((await kiroConversation(binding, { prompts: 10 })).turns).toHaveLength(10);
    prompts[0] = prompts[0]!.replace('"data":"0"', '"data":"changed"');
    await writeFile(binding.path, `${prompts.join("\n")}\n`);
    await expect(kiroConversation(binding, { before: page.cursor! })).rejects.toBeInstanceOf(HistoryChanged);
  });

  test("a long tool output is cut in the page and fetched whole", async () => {
    const long = "x".repeat(10_000);
    const binding = await bound(TOOL_TURN.replace("short output", long));
    const tool = (await kiroConversation(binding)).turns[1]!.parts[1]!;
    if (tool.kind !== "tool") throw new Error("expected a tool");
    expect(tool.output.length).toBeLessThan(long.length);
    expect(await kiroToolOutput(binding, tool.output_ref!)).toBe(long);
  });
});

for (const [label, agent, argv, source] of [
  ["serves herdr's kiro label as Kiro's own chat, fresh after each append", "kiro", TUI_ARGV, "kiro-transcript"],
  ["reads a Kiro pane herdr has not labeled yet from its TUI in front", undefined, ["kiro-cli-chat", "chat"], "kiro-transcript"],
  ["keeps a kiro-labeled pane whose TUI is gone on the terminal", "kiro", ["bash"], "scrollback"],
] as const) linuxTest(label, async () => {
  const kiro = await kiroPane();
  const path = join(sessions, `${ID}.jsonl`);
  await writeFile(path, await fixture("interactive-2.35.1.jsonl"));
  await lock(ID, kiro.acp);
  const pane = { pane_id: `kiro-http-${label.length}`, agent_status: "idle", cwd: home, ...(agent ? { agent } : {}) };
  const info = { foreground_processes: [{ pid: kiro.tui, argv }] };
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ panes: [pane], agents: [] } as unknown as SessionSnapshot);
  const processInfo = spyOn(herdr, "paneProcessInfo").mockResolvedValue(info as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  const rpc = spyOn(herdr, "herdrRpc").mockImplementation((async (method: string) => {
    if (method === "pane.process_info") return { process_info: info };
    throw new Error(`unexpected herdr RPC ${method}`);
  }) as typeof herdr.herdrRpc);
  const url = new URL(`http://x/api/pane/conversation?pane_id=${pane.pane_id}`);
  const ask = async (etag?: string) => (await handlePaneRequest(new Request(url, { headers: etag ? { "if-none-match": etag } : {} }), url, url.pathname, {}))!;
  try {
    const first = await ask();
    const body = await first.json();
    expect(body.source).toBe(source);
    if (source === "scrollback") return;
    expect(body.turns.map((turn: { role: string }) => turn.role)).toEqual(["user", "assistant"]);
    const etag = first.headers.get("etag")!;
    expect((await ask(etag)).status).toBe(304);
    await writeFile(path, `${await fixture("interactive-2.35.1.jsonl")}${await fixture("interactive-2.35.1.jsonl")}`);
    const appended = await ask(etag);
    expect(appended.status).toBe(200);
    expect((await appended.json()).turns).toHaveLength(4);
  } finally {
    rpc.mockRestore();
    processInfo.mockRestore();
    snapshot.mockRestore();
    forgetPaneTranscriptState(pane.pane_id);
    forgetTranscriptState();
  }
});

const TOOL_TURN = [
  { version: "v1", kind: "Prompt", data: { content: [{ kind: "text", data: "run it" }], meta: { timestamp: 1793256363 } } },
  { version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "text", data: "Running." }, { kind: "toolUse", data: { toolUseId: "t1", name: "shell", input: { command: "true" } } }] } },
  { version: "v1", kind: "ToolResults", data: { content: [{ kind: "toolResult", data: { toolUseId: "t1", content: [{ kind: "text", data: "short output" }], status: "success" } }] } },
  { version: "v1", kind: "AssistantMessage", data: { content: [{ kind: "text", data: "Done." }] } },
].map((row) => JSON.stringify(row)).join("\n") + "\n";
