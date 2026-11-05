import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { forgetTranscriptState, HistoryChanged, transcriptPage } from "./conversation.ts";
import { grokImage, grokToolOutput, grokProjection, GrokUnavailable, parseGrokTranscript } from "./grok.ts";
import { darwinProcess } from "./claude-store.ts";
import { grokHeldSessionsFromLsof, grokHomeFromEnvironment, grokLsofEvidence, grokPaneProcesses, grokTranscriptPath, isGrokExecutable, resolveGrokStore } from "./grok-store.ts";
import * as herdr from "./herdr/client.ts";
import type { ConversationPart, HerdrPane } from "../shared/protocol.ts";

const session = "fictional-session";
const event = (update: object, extension = false) => JSON.stringify({ timestamp: 1700000000, method: extension ? "_x.ai/session/update" : "session/update", params: { sessionId: session, update } }) + "\n";
const user = (index: number, text = `prompt ${index}`, meta = {}) => event({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { promptIndex: index, modelId: "fictional-model", ...meta } });
const answer = (text = "fictional answer") => event({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const rewind = (target: number) => event({ sessionUpdate: "rewind_marker", target_prompt_index: target }, true);
const tool = (id = "call-1") => event({ sessionUpdate: "tool_call", toolCallId: id, title: "Read file", rawInput: { path: "fiction.txt" }, content: [], status: "pending" });
const update = (output: string, id = "call-1") => event({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: output } }] });
type Tool = Extract<ConversationPart, { kind: "tool" }>;
let root: string, path: string;
beforeEach(() => {
  // canonical, as grokImage requires of a session path (macOS tmpdir() is under the /var link)
  root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-grok-unit-")));
  path = join(root, "sessions", "%2Ffiction", session, "updates.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  forgetTranscriptState();
});
afterEach(() => { forgetTranscriptState(); rmSync(root, { recursive: true, force: true }); });
const page = () => transcriptPage("grok-transcript", path);
const lastTool = () => page().turns.flatMap((t) => t.parts).find((p): p is Tool => p.kind === "tool")!;

describe("Grok native event adapter", () => {
  test("native activity follows thoughts, tools, completion and rewind without pane status", () => {
    const activity = () => grokProjection(path, statSync(path)).activity;
    writeFileSync(path, user(0));
    expect(activity()).toBe("working");
    appendFileSync(path, event({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "fictional thought" } }));
    expect(activity()).toBe("thinking");
    expect(page().turns).toHaveLength(1);
    appendFileSync(path, tool());
    expect(activity()).toBe("working");
    appendFileSync(path, event({ sessionUpdate: "turn_completed" }));
    expect(activity()).toBe("idle");
    appendFileSync(path, update("late background result"));
    expect(activity()).toBe("idle");
    appendFileSync(path, user(1));
    expect(activity()).toBe("working");
    appendFileSync(path, rewind(1));
    expect(activity()).toBe("idle");
  });
  test("replays an isolated native tool call and its two updates", () => {
    writeFileSync(path, readFileSync(new URL("./fixtures/grok/native-tool.jsonl", import.meta.url), "utf8"));
    const part = lastTool();
    expect(part.name).toBe("run_terminal_command");
    expect(JSON.parse(part.input).variant).toBe("Bash");
    expect(part.output).toBe("FICTIONAL_TOOL_OUTPUT\n");
    expect(page().turns.at(-1)!.parts.at(-1)).toEqual({ kind: "text", text: "FICTIONAL_AFTER_TOOL", phase: "final_answer" });
  });
  test("names the pictures a recorded 1.0.67 session sent and read, and reads each back by its digest", async () => {
    const recorded = readFileSync(new URL("./fixtures/grok/pictures-1.0.67.jsonl", import.meta.url), "utf8");
    const red = "grok-image:db47bba5fe6470a832370fa0ca3cbfd9194dd1e36eaa3d67fdd33bea01d4b66a";
    const blue = "grok-image:c75fe07b33afb7b182fa53cd500727a7cfa1699443a17d87d053d6536ad65438";
    const own = join(root, "sessions", "%2Ftmp%2Fgrok-proj", "01a19135-9ed8-7802-9f7f-c2c74a10a956", "updates.jsonl");
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, recorded);
    const turns = transcriptPage("grok-transcript", own).turns;
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(turns[0]!.parts.slice(1)).toEqual([{ kind: "image", media_type: "image/png", ref: red }]);
    expect(turns[1]!.parts.find((part) => part.kind === "tool")).toMatchObject({ name: "read_file", images: [{ media_type: "image/png", ref: blue }] });
    for (const ref of [red, blue]) {
      const image = await grokImage(own, ref);
      expect(image?.mediaType).toBe("image/png");
      expect(new Bun.CryptoHasher("sha256").update(image!.bytes).digest("hex")).toBe(ref.slice("grok-image:".length));
    }
    expect(await grokImage(own, `grok-image:${"0".repeat(64)}`)).toBeNull();
    // escaped JSON names the same picture, and the endpoint finds it as the parser does
    // Grok only appends: a rewrite here starts the reader afresh
    writeFileSync(own, recorded.replace('"content":{"type":"image","data"', '"content":{"type":"im\\u0061ge","data"'));
    forgetTranscriptState();
    expect(transcriptPage("grok-transcript", own).turns[0]!.parts.slice(1)).toEqual([{ kind: "image", media_type: "image/png", ref: red }]);
    expect((await grokImage(own, red))?.mediaType).toBe("image/png");
    writeFileSync(own, recorded);
    forgetTranscriptState();
    // a prompt rewound while the lookup reads is not served
    const rewound = JSON.stringify({ timestamp: 1700000000, method: "_x.ai/session/update", params: { sessionId: "01a19135-9ed8-7802-9f7f-c2c74a10a956", update: { sessionUpdate: "rewind_marker", target_prompt_index: 0 } } }) + "\n";
    const reading = grokImage(own, red);
    appendFileSync(own, rewound);
    expect(await reading).toBeNull();
    writeFileSync(own, recorded);
    forgetTranscriptState();
    // a file moved into the path while the lookup reads is not the one it read: nothing is served
    const swapping = grokImage(own, red);
    writeFileSync(`${own}.next`, recorded.replace(/"type":"image","data":"[^"]*","mimeType":"image\/png"/, '"type":"text","text":"gone"'));
    renameSync(`${own}.next`, own);
    expect(await swapping).toBeNull();
    writeFileSync(own, recorded);
    forgetTranscriptState();
    // a prompt rewound away leaves the active history: its picture is no longer served
    appendFileSync(own, JSON.stringify({ timestamp: 1700000000, method: "_x.ai/session/update", params: { sessionId: "01a19135-9ed8-7802-9f7f-c2c74a10a956", update: { sessionUpdate: "rewind_marker", target_prompt_index: 0 } } }) + "\n");
    expect(await grokImage(own, red)).toBeNull();
  });
  test("serves a real session file's picture but not a symlinked session file's", async () => {
    const recorded = readFileSync(new URL("./fixtures/grok/pictures-1.0.67.jsonl", import.meta.url), "utf8")
      .replaceAll("01a19135-9ed8-7802-9f7f-c2c74a10a956", session);
    const ref = "grok-image:db47bba5fe6470a832370fa0ca3cbfd9194dd1e36eaa3d67fdd33bea01d4b66a";
    const real = join(realpathSync(dirname(path)), "real.jsonl");
    writeFileSync(real, recorded);
    symlinkSync(real, path);
    const image = await grokImage(real, ref);
    expect(image?.mediaType).toBe("image/png");
    expect(new Bun.CryptoHasher("sha256").update(image!.bytes).digest("hex")).toBe(ref.slice("grok-image:".length));
    expect(await grokImage(path, ref)).toBeNull();
  });
  test("text chunks, hidden boundaries and synthetic prompts", () => {
    const turns = parseGrokTranscript(user(0, "hello ") + user(0, "world") + answer("one ") + answer("two") + user(1, "hidden", { hideFromScrollback: true }) + answer("separate answer") + user(2, "visible", { syntheticPrompt: true }));
    expect(turns.map((t) => t.parts)).toEqual([
      [{ kind: "text", text: "hello world" }], [{ kind: "text", text: "one two" }],
      [{ kind: "text", text: "separate answer" }], [{ kind: "text", text: "visible" }],
    ]);
    expect(turns[1]!.end_ts).toBe("2023-11-14T22:13:20.000Z");
  });
  test("omitted tool fields survive, present output replaces, and shrink removes expansion", () => {
    writeFileSync(path, user(0) + tool() + update("x".repeat(6000)));
    const first = lastTool();
    expect(first.output_size).toBe(6000);
    expect(grokToolOutput(path, first.output_ref!)).toBe("x".repeat(6000));
    appendFileSync(path, event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "in_progress" }));
    expect(lastTool().input).toContain("fiction.txt");
    expect(lastTool().output_size).toBe(6000);
    const second = lastTool().output_ref!;
    appendFileSync(path, update("short"));
    expect(lastTool().output).toBe("short");
    expect(lastTool().output_ref).toBeUndefined();
    expect(lastTool().output_size).toBeUndefined();
    expect(grokToolOutput(path, second)).toBeNull();
  });
  test("unknown, cross-prompt, abandoned and mid-turn updates fail instead of disappearing", () => {
    for (const text of [user(0) + update("unknown"), user(0) + tool() + user(1) + update("late"), user(0) + tool() + rewind(0) + user(0) + update("abandoned")]) {
      forgetTranscriptState(); writeFileSync(path, text);
      expect(() => page()).toThrow();
    }
    expect(() => parseGrokTranscript(update("missing seed"))).toThrow(GrokUnavailable);
  });
  test("nullable raw fields preserve the call while an empty content array clears output", () => {
    const turns = parseGrokTranscript(user(0) + tool() + update("old") + event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", name: "read_file" }) + event({ sessionUpdate: "tool_call_update", toolCallId: "call-1", name: null, rawInput: null, content: [] }));
    const part = turns.flatMap((t) => t.parts).find((p): p is Tool => p.kind === "tool")!;
    expect(part.name).toBe("read_file");
    expect(part.input).toContain("fiction.txt");
    expect(part.output).toBe("");
  });
  test("turn completion separates assistant activity without dropping earlier messages", () => {
    const turns = parseGrokTranscript(user(0) + answer("first") + event({ sessionUpdate: "turn_completed" }, true) + answer("later"));
    expect(turns.map((t) => t.parts)).toEqual([[{ kind: "text", text: "prompt 0" }], [{ kind: "text", text: "first", phase: "final_answer" }], [{ kind: "text", text: "later" }]]);
  });
  test("native tool metadata, search variants and historical diffs survive output replacement", () => {
    const native = event({ sessionUpdate: "tool_call", toolCallId: "edit-1", _meta: { "x.ai/tool": { name: "edit_file" } }, content: [{ type: "diff", path: "fiction.txt", oldText: "before", newText: "after" }] });
    writeFileSync(path, user(0) + native + update("completed", "edit-1"));
    const part = lastTool();
    expect(part.name).toBe("edit_file");
    expect(part.output).toBe("--- fiction.txt\nbefore\n+++ fiction.txt\nafter\ncompleted");
    const search = parseGrokTranscript(user(0) + event({ sessionUpdate: "tool_call", toolCallId: "search-1", kind: "search", rawInput: { variant: "XSearch" } }));
    expect((search[1]!.parts[0] as Tool).name).toBe("XSearch");
  });
  test("malformed known history controls and mismatched sessions fail", () => {
    writeFileSync(path, user(0) + event({ sessionUpdate: "rewind_marker" }, true));
    expect(() => page()).toThrow();
    forgetTranscriptState(); writeFileSync(path, user(0).replace(session, "other-session"));
    expect(() => page()).toThrow();
  });
});

describe("shared pager projection", () => {
  test("matches the fictional native session/load replay after nested rewinds", () => {
    const fixture = (name: string) => readFileSync(new URL(`./fixtures/grok/${name}.jsonl`, import.meta.url), "utf8");
    writeFileSync(path, fixture("nested-rewind"));
    const visible = (turns: ReturnType<typeof parseGrokTranscript>) => turns.map(({ role, parts }) => ({ role, parts }));
    expect(visible(page().turns)).toEqual(visible(parseGrokTranscript(fixture("native-replay"))));
    expect(page().turns.filter((turn) => turn.role === "user")).toHaveLength(1);
  });
  test("ordinary append keeps identity; marker-only rewind invalidates even a cursor at new EOF", () => {
    const first = user(0) + answer();
    writeFileSync(path, first + user(1) + answer());
    const before = page();
    appendFileSync(path, answer("streamed"));
    expect(page().history_id).toBe(before.history_id);
    appendFileSync(path, rewind(1));
    const after = page();
    expect(after.history_id).not.toBe(before.history_id);
    expect(after.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(() => transcriptPage("grok-transcript", path, { before: `${before.history_id}:${Buffer.byteLength(first)}` })).toThrow(HistoryChanged);
    appendFileSync(path, user(1, "replacement") + answer());
    expect(page().history_id).toBe(after.history_id);
  });
  test("nested 1,1,0 rewinds agree cold, warm and with empty history", () => {
    writeFileSync(path, user(0) + answer() + user(1) + answer()); page();
    appendFileSync(path, rewind(1) + user(1) + answer() + user(2) + answer()); page();
    appendFileSync(path, rewind(1) + user(1) + answer()); page();
    appendFileSync(path, rewind(0));
    expect(page().turns).toEqual([]);
    appendFileSync(path, user(0, "final active prompt") + answer());
    const warm = page();
    forgetTranscriptState();
    expect(page()).toEqual(warm);
    expect(warm.turns).toHaveLength(2);
  });
  test("irrelevant extension records between rewind and replacement do not reconnect discarded bytes", () => {
    writeFileSync(path, user(0) + answer() + user(1) + answer() + rewind(1)
      + event({ sessionUpdate: "background_tasks", tasks: [] }, true) + user(1, "replacement") + answer());
    expect(page().turns.filter((turn) => turn.role === "user").map((turn) => turn.parts)).toEqual([
      [{ kind: "text", text: "prompt 0" }], [{ kind: "text", text: "replacement" }],
    ]);
  });
  test("older pages meet newest page with no duplicate turns, and stale pages cannot survive rewind", () => {
    writeFileSync(path, Array.from({ length: 130 }, (_, i) => user(i) + answer()).join(""));
    const newest = page();
    expect(newest.cursor).not.toBeNull();
    const older = transcriptPage("grok-transcript", path, { before: newest.cursor! });
    const oldest = transcriptPage("grok-transcript", path, { before: older.cursor! });
    const prompts = [...oldest.turns, ...older.turns, ...newest.turns].filter((t) => t.role === "user");
    expect(prompts).toHaveLength(130);
    expect(new Set(prompts.map((t) => JSON.stringify(t.parts))).size).toBe(130);
    appendFileSync(path, rewind(1));
    expect(() => transcriptPage("grok-transcript", path, { before: newest.cursor! })).toThrow(HistoryChanged);
  });
  test("partial UTF-8 writes are invisible until complete; metadata follows active prompts", () => {
    writeFileSync(path, user(0));
    const before = page();
    const bytes = Buffer.from(answer("hello 🌍"));
    const split = bytes.indexOf(Buffer.from("🌍")) + 2;
    appendFileSync(path, bytes.subarray(0, split));
    expect(page().turns).toEqual(before.turns);
    appendFileSync(path, bytes.subarray(split));
    expect(page().turns.at(-1)!.parts).toEqual([{ kind: "text", text: "hello 🌍" }]);
    expect(page().metadata.model).toBe("fictional-model");
  });
  test("truncation resets history and tool refs; refs cannot cross stores", () => {
    writeFileSync(path, user(0) + tool() + update("a".repeat(6000)));
    const first = page(); const ref = lastTool().output_ref!;
    const other = join(root, "other", session, "updates.jsonl");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, user(0) + tool() + update("a".repeat(6000)));
    expect(grokToolOutput(other, ref)).toBeNull();
    writeFileSync(path, user(0));
    expect(page().history_id).not.toBe(first.history_id);
    expect(grokToolOutput(path, ref)).toBeNull();
  });
});

describe("exact store lookup", () => {
  test("discovery takes Grok's own executable from the foreground processes", () => {
    expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: ["/usr/local/bin/grok"] }, { pid: 12, argv: ["/bin/sh"] }] }).map((p) => p.pid)).toEqual([11]);
    expect(grokPaneProcesses({})).toEqual([]);
  });
  test("discovery and the exe gate accept the same Grok names without a version pin", () => {
    const accepted = [
      "grok",
      "/usr/local/bin/grok",
      "/usr/local/bin/grok (deleted)",
      "grok.exe",
      "GROK.EXE",
      "C:\\Grok\\grok.exe",
      "grok-1.0.50-linux-x86_64",
      "/home/user/.grok/downloads/grok-1.0.52-linux-x86_64",
      "/home/user/.grok/downloads/grok-1.0.52-linux-x86_64 (deleted)",
      "grok-1.0.52.exe",
      "grok.js",
      "grok.cjs",
      "grok.mjs",
      "grok.js.exe",
      "grok-2.0.0-darwin-arm64",
      "grok-statusline", // Synthetic nonnumeric suffix; not a claim about a shipped build.
    ];
    for (const exe of accepted) {
      expect(isGrokExecutable(exe)).toBe(true);
      expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: [exe] }] })).toHaveLength(1);
    }
    const rejected = ["/bin/sleep", "sleep", "grokker", "notgrok", "grok_cli", "grok.bak", "/opt/grok/bin/sleep", ""];
    for (const exe of rejected) {
      expect(isGrokExecutable(exe)).toBe(false);
      expect(grokPaneProcesses({ foreground_processes: [{ pid: 11, argv: [exe] }] })).toEqual([]);
    }
  });
  // These resolver tests hold real descriptors in a real process: /proc on Linux, lsof and the
  // kernel's environment on macOS. The process's own GROK_HOME names the store.
  for (const scenario of [
    { name: "older files stay open", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: true },
    { name: "/resume writes a newer session", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false },
    { name: "the reported id is held in two directories", otherGroup: "other-group", otherSession: session, otherMtime: 100, binds: false },
    { name: "held sessions have tied write times", otherGroup: "group", otherSession: "tied-session", otherMtime: 200, binds: false },
    { name: "the newest held events file is unlinked", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "unlink" },
    { name: "the newest held events file is renamed", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "rename" },
    { name: "a replacement reported file has a newer timestamp", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, replacement: "current" },
    { name: "a replacement competing file has an older timestamp", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, replacement: "other" },
    // a newer held events file moved to a name or a folder the session filter does not take
    { name: "the newest held events file is renamed without its prefix", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "rename-away" },
    { name: "the newest held session's folder is renamed past the id filter", otherGroup: "group", otherSession: "resumed-session", otherMtime: 300, binds: false, change: "rename-folder" },
    // older write times: these must not bind as merely older held sessions either
    { name: "an older held session's folder is renamed past the id filter", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: false, change: "rename-folder" },
    { name: "an events-named file is held deeper in the store", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: false, nested: true },
    { name: "a held events file is renamed in a folder renamed past the id filter", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: false, change: "rename-both" },
    // another file held in a session folder: its events file beside it says nothing moved away
    { name: "another file is held beside an older session's events file", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: true, heldLock: "beside events.jsonl" },
    { name: "another file is held in a session folder with no events file", otherGroup: "group", otherSession: "older-session", otherMtime: 100, binds: false, heldLock: "alone" },
  ] as { name: string; otherGroup: string; otherSession: string; otherMtime: number; binds: boolean; change?: string; replacement?: string; nested?: boolean; heldLock?: string }[]) {
    test.skipIf(process.platform !== "darwin" && (process.platform !== "linux" || !existsSync("/proc/self/fd")))(`resolves Herdr's session safely when ${scenario.name}`, async () => {
      const home = realpathSync(root);
      const transcript = join(home, "sessions", "%2Ffiction", session, "updates.jsonl");
      const current = join(dirname(transcript), "events.jsonl");
      const other = join(home, "sessions", scenario.otherGroup, scenario.otherSession, "events.jsonl");
      const retained = join(home, "sessions", "group", "retained-session", "events.jsonl");
      const outside = join(home, "events.jsonl");
      mkdirSync(dirname(other), { recursive: true });
      mkdirSync(dirname(retained), { recursive: true });
      writeFileSync(transcript, user(0));
      writeFileSync(current, "");
      writeFileSync(other, "");
      writeFileSync(retained, "");
      writeFileSync(outside, "");
      utimesSync(current, 200, 200);
      utimesSync(other, scenario.otherMtime, scenario.otherMtime);
      utimesSync(retained, 50, 50);
      utimesSync(outside, 400, 400);
      // Only the reported directory has updates.jsonl, including the duplicate-id case.
      const executable = join(home, "grok");
      // Use our runtime, not a sleep executable that may dispatch by its copied name.
      copyFileSync(process.execPath, executable);
      const held = [current, other, retained, outside];
      if (scenario.heldLock !== undefined) {
        const lock = join(home, "sessions", "group", "closed-session", "updates.jsonl.lock");
        mkdirSync(dirname(lock), { recursive: true });
        writeFileSync(lock, "");
        if (scenario.heldLock !== "alone") writeFileSync(join(dirname(lock), "events.jsonl"), "");
        // a file held at the store's root (Grok's session index) is no session's
        const index = join(home, "sessions", "session_search.sqlite");
        writeFileSync(index, "");
        held.push(lock, index);
      }
      if (scenario.nested) {
        const nested = join(home, "sessions", "group", "older-session", "checkpoint", "events.jsonl");
        mkdirSync(dirname(nested), { recursive: true });
        writeFileSync(nested, "");
        utimesSync(nested, 100, 100);
        held.push(nested);
      }
      const fds = held.map((file) => openSync(file, "r"));
      // The child says so once its own script runs: Bun's "spawn" event can come before the exec,
      // while /proc still shows this runtime's executable, environment and descriptors.
      const child = spawn(executable, ["-e", "process.stdout.write('running\\n'); process.stdin.resume()"], {
        stdio: ["pipe", "pipe", "ignore", ...fds], env: { ...process.env, HOME: "/bridge-home", GROK_HOME: home },
      });
      const running = once(child.stdout!, "data", { signal: AbortSignal.timeout(10_000) });
      const pane: HerdrPane = {
        pane_id: "grok-fixture", agent: "grok", agent_status: "ready", focused: false,
        revision: 0, tab_id: "tab-fixture", terminal_id: "terminal-fixture", workspace_id: "workspace-fixture",
        agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value: session },
      };
      const info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({
        pane_id: pane.pane_id, foreground_processes: [{ pid: child.pid!, name: "grok", argv: [executable] }],
      });
      const nativeStat = fs.statSync;
      let replaced = false;
      const stats = spyOn(fs, "statSync").mockImplementation(new Proxy(nativeStat, {
        apply(target, receiver, args) {
          const replacement = "replacement" in scenario ? scenario.replacement : null;
          const file = replacement === "current" ? current : other;
          // Replace after /proc's link or lsof's listing was read, before the path's stat is sampled.
          if (replacement && !replaced && args[0] === file) {
            replaced = true;
            unlinkSync(file);
            writeFileSync(file, "");
            utimesSync(file, replacement === "current" ? 400 : 100, replacement === "current" ? 400 : 100);
          }
          return Reflect.apply(target, receiver, args);
        },
      }));
      try {
        await running;
        if (scenario.change === "unlink") unlinkSync(other);
        else if (scenario.change === "rename") renameSync(other, `${other}.old`);
        else if (scenario.change === "rename-away") renameSync(other, join(dirname(other), "old-events.jsonl"));
        else if (scenario.change === "rename-folder") renameSync(dirname(other), join(dirname(dirname(other)), ".archived-resumed"));
        else if (scenario.change === "rename-both") {
          renameSync(other, join(dirname(other), "old-events.jsonl"));
          renameSync(dirname(other), join(dirname(dirname(other)), ".archived-older"));
        }
        expect(await resolveGrokStore(pane)).toBe(scenario.binds ? transcript : null);
      } finally {
        stats.mockRestore();
        info.mockRestore();
        const exited = once(child, "exit", { signal: AbortSignal.timeout(2000) });
        child.kill();
        await exited;
        for (const fd of fds) closeSync(fd);
      }
    });
  }
  test("discovery checks a script only behind bun or node, never arbitrary arguments", () => {
    const processes = [
      { pid: 11, argv: ["/usr/bin/node", "/opt/grok/grok.js"] },
      { pid: 12, argv: ["bun", "/opt/grok/grok-statusline.mjs"] },
      { pid: 13, argv: ["C:\\bin\\node.exe", "C:\\bin\\grok.cjs"] },
      { pid: 14, argv: ["/bin/sh", "grok"] },
      { pid: 15, argv: ["node", "unrelated.js", "grok"] },
      { pid: 16, argv: ["node"] },
      { pid: 17, argv: null },
    ];
    expect(grokPaneProcesses({ foreground_processes: processes }).map((p) => p.pid)).toEqual([11, 12, 13]);
  });
  test("custom home and hashed cwd names need no newest-file guess", () => {
    const hashed = join(root, "sessions", "long-slug-abc123", session, "updates.jsonl");
    mkdirSync(join(hashed, ".."), { recursive: true }); writeFileSync(hashed, user(0));
    expect(grokTranscriptPath(root, session)).toBe(hashed);
    writeFileSync(path, user(0));
    expect(grokTranscriptPath(root, session)).toBeNull();
    expect(grokTranscriptPath(root, "../escape")).toBeNull();
  });
  test("symlinked sessions are not followed outside the store", () => {
    const external = join(root, "external"); mkdirSync(external); writeFileSync(join(external, "updates.jsonl"), user(0));
    rmSync(join(path, ".."), { recursive: true }); symlinkSync(external, join(path, ".."));
    expect(grokTranscriptPath(root, session)).toBeNull();
  });
  test("pane environment chooses the home and never a relative store", () => {
    expect(grokHomeFromEnvironment("HOME=/user\0GROK_HOME=/custom store\0")).toBe("/custom store");
    expect(grokHomeFromEnvironment("HOME=/user\0")).toBe("/user/.grok");
    expect(grokHomeFromEnvironment("USERPROFILE=/user\0")).toBe("/user/.grok");
    expect(grokHomeFromEnvironment("HOME=/user\0GROK_HOME=relative\0")).toBeNull();
  });
});

describe("macOS held-file evidence", () => {
  const exe = "/usr/local/bin/grok-macos-aarch64";
  const pane = (value = session): HerdrPane => ({
    pane_id: "grok-fixture", agent: "grok", agent_status: "ready", focused: false,
    revision: 0, tab_id: "tab-fixture", terminal_id: "terminal-fixture", workspace_id: "workspace-fixture",
    agent_session: { agent: "grok", kind: "id", source: "herdr:grok", value },
  });
  const identity = (file: string) => {
    const stat = statSync(file);
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  };
  const record = (fd: string, file: string, id: { dev: number; ino: number } | null = null) => {
    const lines = [`f${fd}`];
    if (id) lines.push(`D0x${id.dev.toString(16)}`, `i${id.ino}`);
    lines.push(`n${file}`);
    return lines;
  };
  const listing = (extra: string[] = [], executable = exe) =>
    ["p4242", ...record("txt", executable), ...record("txt", "/usr/lib/dyld"), ...extra].join("\n") + "\n";

  test("lsof keeps the first txt executable and only numeric descriptors", () => {
    const text = [
      "p4242",
      "ftxt", "n/opt/grok-macos-aarch64 -> /usr/local/bin/grok-macos-aarch64",
      "ftxt", "n/usr/lib/dyld",
      "ftxt", "n/System/Library/Frameworks/SecErrorMessages.loctable",
      "fcwd", "D0xfe20", "i1", "n/tmp/cwd-events.jsonl",
      "frtd", "n/",
      "fmem", "n/usr/lib/dyld",
      "f4", "D0xfe20", "i65056", "n/tmp/sessions/group/sid/events.jsonl",
      "f5u", "n/tmp/no-device",
    ].join("\n") + "\n";
    const evidence = grokLsofEvidence(text);
    expect(evidence?.executable).toBe("/opt/grok-macos-aarch64 -> /usr/local/bin/grok-macos-aarch64");
    expect(evidence?.files).toEqual([
      { path: "/tmp/sessions/group/sid/events.jsonl", dev: 0xfe20, ino: 65056 },
      { path: "/tmp/no-device", dev: null, ino: null },
    ]);
    expect(grokLsofEvidence("n/tmp/orphan")).toBeNull();
    expect(grokLsofEvidence("f4\nn/a\nn/b")).toBeNull();
    const many = (count: number) => Array.from({ length: count }, () => "f1\nn/tmp/x\n").join("");
    expect(grokLsofEvidence(`ftxt\nn/bin/grok\n${many(4095)}`)).not.toBeNull();
    expect(grokLsofEvidence(`ftxt\nn/bin/grok\n${many(4096)}`)).toBeNull();
  });

  test("a held events file must be the named inode", () => {
    const home = realpathSync(root);
    const current = join(home, "sessions", "%2Ffiction", session, "events.jsonl");
    writeFileSync(join(current, "..", "updates.jsonl"), user(0));
    writeFileSync(current, "");
    const stat = identity(current);
    expect(grokHeldSessionsFromLsof([{ path: current, dev: stat.dev, ino: stat.ino }], home)?.get(dirname(current))).toBe(stat.mtimeMs);
    expect(grokHeldSessionsFromLsof([{ path: current, dev: stat.dev + 1, ino: stat.ino }], home)).toBeNull();
    expect(grokHeldSessionsFromLsof([{ path: current, dev: stat.dev, ino: stat.ino + 1 }], home)).toBeNull();
    expect(grokHeldSessionsFromLsof([{ path: current, dev: null, ino: stat.ino }], home)).toBeNull();
    expect(grokHeldSessionsFromLsof([{ path: `${current} (deleted)`, dev: stat.dev, ino: stat.ino }], home)).toBeNull();
    expect(grokHeldSessionsFromLsof([{ path: `${current}.old`, dev: stat.dev, ino: stat.ino }], home)).toBeNull();
    const external = join(home, "external-events.jsonl");
    writeFileSync(external, "");
    unlinkSync(current);
    symlinkSync(external, current);
    const link = identity(external);
    expect(grokHeldSessionsFromLsof([{ path: current, dev: link.dev, ino: link.ino }], home)).toBeNull();
  });

  const place = (otherMtime: number, otherSession = "older-session", otherGroup = "group") => {
    const home = realpathSync(root);
    const transcript = join(home, "sessions", "%2Ffiction", session, "updates.jsonl");
    const current = join(dirname(transcript), "events.jsonl");
    const other = join(home, "sessions", otherGroup, otherSession, "events.jsonl");
    const retained = join(home, "sessions", "group", "retained-session", "events.jsonl");
    const outside = join(home, "events.jsonl");
    mkdirSync(dirname(other), { recursive: true });
    mkdirSync(dirname(retained), { recursive: true });
    writeFileSync(transcript, user(0));
    writeFileSync(current, "");
    writeFileSync(other, "");
    writeFileSync(retained, "");
    writeFileSync(outside, "");
    utimesSync(current, 200, 200);
    utimesSync(other, otherMtime, otherMtime);
    utimesSync(retained, 50, 50);
    utimesSync(outside, 400, 400);
    const files = [current, other, retained, outside].map((file) => {
      const stat = identity(file);
      return record(String(10 + file.length), file, stat);
    });
    return { home, transcript, current, other, listing: listing([...record("cwd", other, identity(other)), ...record("mem", "/usr/lib/dyld"), ...files.flat()]) };
  };

  async function darwin(store: { home: string; listing: string }, options: {
    configured?: string; environment?: string | null; lsofExit?: number; stdout?: string;
    processes?: { pid: number; argv?: string[] | null }[]; platform?: string;
    sessionPane?: HerdrPane; throwOnSpawn?: boolean; executable?: string;
    microStarts?: (bigint | null)[];
    recheckedProcesses?: { pid: number; argv?: string[] | null }[];
  } = {}) {
    const calls: string[][] = [];
    const timeouts: (number | undefined)[] = [];
    const microStarts = [...(options.microStarts ?? [1792929600000001n, 1792929600000001n, 1792929600000001n])];
    const startTime = spyOn(darwinProcess, "startTime").mockImplementation(() => microStarts.shift() ?? null);
    const info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({
      pane_id: "grok-fixture", foreground_processes: (options.processes ?? [{ pid: 4242, argv: [exe] }]).map((process) => ({ name: "grok", ...process })),
    });
    if (options.recheckedProcesses) {
      info.mockResolvedValueOnce({
        pane_id: "grok-fixture", foreground_processes: [{ pid: 4242, name: "grok", argv: [exe] }],
      }).mockResolvedValue({
        pane_id: "grok-fixture", foreground_processes: options.recheckedProcesses.map((process) => ({ name: "grok", ...process })),
      });
    }
    const environments: number[] = [];
    const environment = spyOn(darwinProcess, "environment").mockImplementation((pid) => {
      environments.push(pid);
      return options.environment === undefined ? `HOME=/bridge-home\0GROK_HOME=${store.home}\0` : options.environment;
    });
    const spawned = spyOn(Bun, "spawn").mockImplementation(((argv: string[], spawnOptions: { timeout?: number }) => {
      calls.push(argv);
      timeouts.push(spawnOptions.timeout);
      if (options.throwOnSpawn) throw new Error("host failed");
      const text = options.stdout ?? (options.executable ? store.listing.replace(`n${exe}\n`, `n${options.executable}\n`) : store.listing);
      return { stdout: new Response(text).body, exited: Promise.resolve(options.lsofExit ?? 0), kill: () => {} };
    }) as unknown as typeof Bun.spawn);
    try {
      const result = await resolveGrokStore(options.sessionPane ?? pane(), options.configured, options.platform ?? "darwin");
      return { result, calls, timeouts, environments, askedProcessInfo: info.mock.calls.length > 0 };
    } finally { spawned.mockRestore(); environment.mockRestore(); info.mockRestore(); startTime.mockRestore(); }
  }

  test("binds Herdr's session when its held events file is strictly newest", async () => {
    const store = place(100);
    const previousHome = process.env.HOME;
    const previousGrok = process.env.GROK_HOME;
    process.env.HOME = "/bridge-home";
    process.env.GROK_HOME = "/bridge-grok";
    try {
      const { result, calls, timeouts, environments } = await darwin(store);
      expect(result).toBe(store.transcript);
      expect(calls).toEqual([["/usr/sbin/lsof", "-nPbw", "-a", "-p", "4242", "-FfDin"]]);
      expect(timeouts).toEqual([3000]);
      expect(environments).toEqual([4242]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      if (previousGrok === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = previousGrok;
    }
  });

  test("uses HOME/.grok from the process and a configured home skips its environment", async () => {
    const userHome = join(realpathSync(root), "macos-user");
    const home = join(userHome, ".grok");
    const transcript = join(home, "sessions", "group", session, "updates.jsonl");
    const current = join(dirname(transcript), "events.jsonl");
    mkdirSync(dirname(transcript), { recursive: true });
    writeFileSync(transcript, user(0));
    writeFileSync(current, "");
    const stat = identity(current);
    const store = { home, listing: listing(record("4", current, stat)) };
    expect((await darwin(store, { environment: `HOME=${userHome}\0` })).result).toBe(transcript);
    // a NOTE holding "GROK_HOME=" is NOTE's value, not a home
    expect((await darwin(store, { environment: `NOTE=x GROK_HOME=/wrong\0HOME=${userHome}\0` })).result).toBe(transcript);
    // an empty GROK_HOME falls back to HOME; a relative one does not
    expect((await darwin(store, { environment: `GROK_HOME=\0HOME=${userHome}\0` })).result).toBe(transcript);
    expect((await darwin(store, { environment: `GROK_HOME=relative\0HOME=${userHome}\0` })).result).toBeNull();
    // a home the held file does not live in does not bind
    expect((await darwin(store, { environment: `GROK_HOME=${join(userHome, "other")}\0` })).result).toBeNull();
    const configured = await darwin(store, { configured: home, environment: "GROK_HOME=/wrong\0" });
    expect(configured.result).toBe(transcript);
    expect(configured.environments).toEqual([]);
  });

  for (const scenario of [
    { name: "another held session is newer", otherMtime: 300 },
    { name: "held write times tie", otherMtime: 200 },
    { name: "the reported id is held twice", otherMtime: 100, otherSession: session, otherGroup: "other-group" },
  ]) {
    test(`stays on the terminal when ${scenario.name}`, async () => {
      const store = place(scenario.otherMtime, scenario.otherSession, scenario.otherGroup);
      expect((await darwin(store)).result).toBeNull();
    });
  }

  test("does not select a different session from held files", async () => {
    // the other held session is older, so each null below has its own reason
    const store = place(100, "resumed-session");
    expect((await darwin(store)).result).toBe(store.transcript);
    const withoutReported = store.listing.split("\n").filter((line) => !line.endsWith(`${session}/events.jsonl`)).join("\n");
    expect((await darwin({ ...store, listing: withoutReported })).result).toBeNull();
    const second = join(store.home, "sessions", "other-group", session, "updates.jsonl");
    mkdirSync(dirname(second), { recursive: true });
    writeFileSync(second, user(0));
    expect((await darwin(store)).result).toBeNull();
  });

  test("the held directory must be the one with the transcript", async () => {
    const store = place(100);
    const elsewhere = join(store.home, "sessions", "other-group", session, "events.jsonl");
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, "");
    utimesSync(elsewhere, 200, 200);
    const fd = String(10 + store.current.length);
    const movedHold = store.listing.replace(record(fd, store.current, identity(store.current)).join("\n"), record(fd, elsewhere, identity(elsewhere)).join("\n"));
    expect(movedHold).not.toBe(store.listing);
    expect((await darwin({ ...store, listing: movedHold })).result).toBeNull();
    unlinkSync(store.transcript);
    expect((await darwin(store)).result).toBeNull();
  });

  test("deleted, renamed, and replaced held files stay on the terminal", async () => {
    const store = place(100);
    for (const file of [store.current, store.other]) {
      const deleted = store.listing.replaceAll(`n${file}\n`, `n${file} (deleted)\n`);
      expect(deleted).not.toBe(store.listing);
      expect((await darwin({ ...store, listing: deleted })).result).toBeNull();
      const renamed = store.listing.replaceAll(`n${file}\n`, `n${file}.old\n`);
      expect((await darwin({ ...store, listing: renamed })).result).toBeNull();
      const stat = identity(file);
      const marker = `D0x${stat.dev.toString(16)}\ni${stat.ino}\nn${file}\n`;
      const replaced = store.listing.replaceAll(marker, `D0x${stat.dev.toString(16)}\ni${stat.ino + 1}\nn${file}\n`);
      expect(replaced).not.toBe(store.listing);
      expect((await darwin({ ...store, listing: replaced })).result).toBeNull();
      const noDevice = store.listing.replaceAll(marker, `i${stat.ino}\nn${file}\n`);
      expect((await darwin({ ...store, listing: noDevice })).result).toBeNull();
      const noInode = store.listing.replaceAll(marker, `D0x${stat.dev.toString(16)}\nn${file}\n`);
      expect((await darwin({ ...store, listing: noInode })).result).toBeNull();
    }
    // lsof keeps naming an unlinked file by its old path
    unlinkSync(store.other);
    expect((await darwin(store)).result).toBeNull();
  });

  test("a mapped file listed as txt is not the executable", async () => {
    const store = place(100);
    expect((await darwin(store, { executable: "/usr/lib/dyld" })).result).toBeNull();
    expect((await darwin(store, { executable: "/usr/local/bin/grok (deleted)" })).result).toBe(store.transcript);
  });

  test("an incomplete competing descriptor never leaves a shorter binding list", async () => {
    const store = place(100);
    for (const incomplete of ["f99\n", "f99\nD0xfe20\ni42\n", "f99\nD0xfe20\ni42\nftxt\nn/usr/lib/dyld\n"]) {
      expect((await darwin({ ...store, listing: store.listing + incomplete })).result).toBeNull();
    }
  });

  test("a competing name cut mid-record never binds the reported session", async () => {
    const store = place(100);
    expect((await darwin({ ...store, listing: store.listing + "f99\nD0xfe20\ni42\nn/fixture" })).result).toBeNull();
  });

  test("a reused or unreadable process start never binds evidence to the pane", async () => {
    const store = place(100);
    for (const microStarts of [
      [1792929600000001n, 1792929601000001n],
      [null],
      [1792929600000001n, null],
    ]) {
      expect((await darwin(store, { microStarts })).result).toBeNull();
    }
  });

  test("a replacement before the first start sample must still belong to this pane", async () => {
    const store = place(100);
    for (const recheckedProcesses of [[], [{ pid: 4243, argv: [exe] }], [{ pid: 4242, argv: ["/bin/sh"] }]]) {
      expect((await darwin(store, { recheckedProcesses })).result).toBeNull();
    }
  });

  test("PID reuse between evidence reads within the same second never binds", async () => {
    const store = place(100);
    expect((await darwin(store, { microStarts: [1792929600000001n, 1792929600000002n] })).result).toBeNull();
  });

  test("PID reuse during the final foreground lookup never binds", async () => {
    const store = place(100);
    expect((await darwin(store, { microStarts: [1792929600000001n, 1792929600000001n, 1792929600000002n] })).result).toBeNull();
  });

  test("a failed, oversized or unreadable read is no listing", async () => {
    const store = place(100);
    expect((await darwin(store, { lsofExit: 1 })).result).toBeNull();
    expect((await darwin(store, { throwOnSpawn: true })).result).toBeNull();
    expect((await darwin(store, { environment: null })).result).toBeNull();
    expect((await darwin(store, { environment: "HOME=/does-not-exist\0GROK_HOME=relative\0" })).result).toBeNull();
    // the cap counts bytes: 2-byte characters past half a MiB are over it
    const padding = `ftxt\nn/usr/lib/${"é".repeat(512 * 1024)}\n`;
    expect(new TextEncoder().encode(store.listing + padding).byteLength).toBeGreaterThan(1024 * 1024);
    expect((store.listing + padding).length).toBeLessThan(1024 * 1024);
    expect((await darwin(store, { stdout: store.listing + padding })).result).toBeNull();
  });

  test("a timed-out lsof is no listing", async () => {
    const store = place(100);
    const native = Bun.spawn;
    const info = spyOn(herdr, "paneProcessInfo").mockResolvedValue({ pane_id: "grok-fixture", foreground_processes: [{ pid: 4242, name: "grok", argv: [exe] }] });
    const startTime = spyOn(darwinProcess, "startTime").mockReturnValue(1792929600000001n);
    // the real kill at the timeout, shortened from 3 s
    const timeouts: (number | undefined)[] = [];
    const spawned = spyOn(Bun, "spawn").mockImplementation(((argv: string[], options: { timeout?: number }) => {
      timeouts.push(options.timeout);
      return native(["/bin/sleep", "5"], { stdout: "pipe", stderr: "ignore", timeout: 50 });
    }) as unknown as typeof Bun.spawn);
    try {
      expect(await resolveGrokStore(pane(), store.home, "darwin")).toBeNull();
      expect(timeouts).toEqual([3000]);
    } finally { spawned.mockRestore(); info.mockRestore(); startTime.mockRestore(); }
  });

  test("an inode lsof prints past 2^53 is not a match", () => {
    expect(grokLsofEvidence("f4\nD0x1000012\ni1152921500312571448\nn/tmp/events.jsonl\n")?.files).toEqual([
      { path: "/tmp/events.jsonl", dev: 0x1000012, ino: null },
    ]);
  });

  test("windows, the wrong session source, and anything but one Grok process do not spawn", async () => {
    const store = place(100);
    const silent = async (platform: string, processes?: { pid: number; argv?: string[] | null }[], sessionPane = pane()) => {
      const found = await darwin(store, { platform, processes, sessionPane });
      expect(found.result).toBeNull();
      expect(found.calls).toEqual([]);
      if (platform !== "linux" && platform !== "darwin") expect(found.askedProcessInfo).toBe(false);
      return found;
    };
    await silent("win32");
    const wrong = pane();
    wrong.agent_session = { agent: "grok", kind: "id", source: "user", value: session };
    await silent("darwin", undefined, wrong);
    await silent("darwin", []);
    await silent("darwin", [{ pid: 4, argv: [exe] }, { pid: 5, argv: ["grok"] }]);
    await silent("darwin", [{ pid: 0, argv: [exe] }]);
    await silent("darwin", [{ pid: 1.5, argv: [exe] }]);
    const linux = await silent("linux", [{ pid: process.pid, argv: ["grok"] }]);
    expect(linux.askedProcessInfo).toBe(true);
  });
});
