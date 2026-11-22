import { afterEach, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ConversationTurn } from "../shared/protocol.ts";
import * as cmd from "./cmd.ts";
import { forgetTranscriptState, HistoryChanged, liveTurnCacheUsage, transcriptPage } from "./conversation.ts";

const SOURCES = ["omp-transcript", "omo-transcript", "gjc-transcript", "claude-transcript"] as const;
type Source = typeof SOURCES[number] | "pi-transcript" | "cmd-transcript";
const roots: string[] = [];
const jsonl = (...entries: unknown[]) => entries.map(entry => JSON.stringify(entry) + "\n").join("");
const fixture = (text: string) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-native-incremental-"));
  roots.push(root);
  const path = join(root, "session.jsonl");
  writeFileSync(path, text);
  return path;
};
const message = (source: Source, role: string, content: unknown) => ({ type: source === "claude-transcript" ? role : "message", message: { role, content } });
const prompt = (source: Source, text: string) => message(source, "user", [{ type: "text", text }]);
const answer = (source: Source, text: string) => message(source, "assistant", [{ type: "text", text }]);
const call = (source: Source, id: string) => message(source, "assistant", [source !== "claude-transcript"
  ? { type: "toolCall", id, name: "bash", arguments: { command: "printf synthetic" } }
  : { type: "tool_use", id, name: "Bash", input: { command: "printf synthetic" } }]);
const result = (source: Source, id: string, text: string) => source !== "claude-transcript"
  ? { type: "message", message: { role: "toolResult", toolCallId: id, content: [{ type: "text", text }] } }
  : message(source, "user", [{ type: "tool_result", tool_use_id: id, content: text }]);
const textParts = (turns: ConversationTurn[]) => turns.flatMap(turn => turn.parts.flatMap(part => part.kind === "text" ? [part.text] : []));
const toolParts = (turns: ConversationTurn[]) => turns.flatMap(turn => turn.parts).filter(part => part.kind === "tool");
afterEach(() => {
  forgetTranscriptState();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

for (const source of SOURCES) {
  test(`${source}: a torn UTF-8 result previews without consuming the pending call or mutating earlier responses`, () => {
    const path = fixture(jsonl(prompt(source, "Read the result"), call(source, "read")));
    const initial = transcriptPage(source, path);
    const line = Buffer.from(JSON.stringify(result(source, "read", "한글 " + "x".repeat(9000))));
    const split = line.indexOf(Buffer.from("한")) + 1;
    appendFileSync(path, line.subarray(0, split));
    expect(toolParts(transcriptPage(source, path).turns)[0]?.output).toBe("");
    appendFileSync(path, line.subarray(split));
    const preview = transcriptPage(source, path);
    expect(toolParts(preview.turns)[0]).toMatchObject({ output_ref: "read", output_size: 9003 });
    expect(toolParts(preview.turns)[0]?.output.startsWith("한글 ")).toBe(true);
    expect(toolParts(initial.turns)[0]?.output).toBe("");
    appendFileSync(path, "\n" + jsonl(answer(source, "The result arrived")));
    const completed = transcriptPage(source, path);
    expect(toolParts(completed.turns)).toHaveLength(1);
    expect(textParts(completed.turns)).toEqual(["Read the result", "The result arrived"]);
    expect(textParts(preview.turns)).toEqual(["Read the result"]);
    forgetTranscriptState();
    expect(transcriptPage(source, path).turns).toEqual(completed.turns);
  });

  test(`${source}: same-size rewrites, replacement and truncation discard live parser state`, () => {
    const history = Array.from({ length: 55 }, (_, i) => prompt(source, `prompt ${i}`));
    const old = jsonl(...history, call(source, "old"), result(source, "old", "OLD"), answer(source, "OLD"));
    const path = fixture(old);
    utimesSync(path, 1_700_000_000, 1_700_000_000);
    const initial = transcriptPage(source, path);
    expect(initial.cursor).toBeString();
    writeFileSync(path, old.replaceAll("OLD", "NEW"));
    utimesSync(path, 1_700_000_001, 1_700_000_001);
    const rewritten = transcriptPage(source, path);
    expect(rewritten.history_id).not.toBe(initial.history_id);
    expect(textParts(rewritten.turns).at(-1)).toBe("NEW");
    expect(toolParts(rewritten.turns)[0]?.output).toBe("NEW");
    expect(textParts(initial.turns).at(-1)).toBe("OLD");
    expect(() => transcriptPage(source, path, { from: initial.cursor! })).toThrow(HistoryChanged);
    const replacement = `${path}.replacement`;
    writeFileSync(replacement, jsonl(prompt(source, "replacement"), answer(source, "replacement answer")));
    renameSync(replacement, path);
    const replaced = transcriptPage(source, path);
    expect(replaced.history_id).not.toBe(rewritten.history_id);
    expect(textParts(replaced.turns)).toEqual(["replacement", "replacement answer"]);
    expect(toolParts(replaced.turns)).toEqual([]);
    writeFileSync(path, jsonl(prompt(source, "short")));
    expect(textParts(transcriptPage(source, path).turns)).toEqual(["short"]);
  });

  test(`${source}: a growing rewrite behind an unchanged trailing boundary is reread`, () => {
    const padding = "Unchanged trailing record ".repeat(20);
    const old = jsonl(prompt(source, "start"), answer(source, "before"), answer(source, padding));
    const path = fixture(old);
    const initial = transcriptPage(source, path);
    writeFileSync(path, old.replace("before", "after!") + jsonl(answer(source, "new suffix")));
    const rewritten = transcriptPage(source, path);
    expect(textParts(rewritten.turns)).toEqual(["start", "after!", padding, "new suffix"]);
    expect(textParts(initial.turns)).toEqual(["start", "before", padding]);
    forgetTranscriptState();
    expect(transcriptPage(source, path).turns).toEqual(rewritten.turns);
  });

  test(`${source}: an evicted session reconnects delayed results without borrowing another session's state`, () => {
    const first = fixture(jsonl(prompt(source, "first"), call(source, "shared-id")));
    const original = transcriptPage(source, first);
    for (let i = 0; i < 20; i++) {
      const otherSource = SOURCES[i % SOURCES.length]!;
      const other = fixture(jsonl(prompt(otherSource, `other ${i}`), call(otherSource, "shared-id"), result(otherSource, "shared-id", `other result ${i}`)));
      expect(toolParts(transcriptPage(otherSource, other).turns)[0]?.output).toBe(`other result ${i}`);
    }
    expect(liveTurnCacheUsage().paths).not.toContain(first);
    appendFileSync(first, jsonl(result(source, "shared-id", "first result")));
    expect(toolParts(transcriptPage(source, first).turns)[0]?.output).toBe("first result");
    expect(toolParts(original.turns)[0]?.output).toBe("");
  });
}

for (const source of ["omo-transcript", "gjc-transcript"] as const) {
  test(`${source}: speculative settings never replace committed metadata and clear resets the old context`, () => {
    const path = fixture(jsonl(
      { type: "model_change", modelId: "initial-model" },
      { type: "thinking_level_change", thinkingLevel: "high" },
      prompt(source, "Initial question"),
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Initial answer" }], usage: { input: 100, cacheRead: 20, cacheWrite: 5 } } },
    ));
    const initial = transcriptPage(source, path);
    expect(initial.metadata).toEqual({ model: "initial-model", reasoning_effort: "high", context: { used: 125, window: null } });
    appendFileSync(path, JSON.stringify({ type: "model_change", modelId: "preview-model" }));
    const preview = transcriptPage(source, path);
    expect(preview.metadata.model).toBe("preview-model");
    appendFileSync(path, " discarded\n" + jsonl({ type: "thinking_level_change", thinkingLevel: "low" }));
    const committed = transcriptPage(source, path);
    expect(committed.metadata).toEqual({ model: "initial-model", reasoning_effort: "low", context: { used: 125, window: null } });
    expect(initial.metadata.reasoning_effort).toBe("high");
    expect(preview.metadata.model).toBe("preview-model");
    appendFileSync(path, jsonl({ type: "custom", customType: "context_clear" }, prompt(source, "New context")));
    const cleared = transcriptPage(source, path);
    expect(cleared.metadata).toEqual({ model: null, reasoning_effort: null });
    expect(textParts(cleared.turns)).toEqual(["New context"]);
    forgetTranscriptState();
    const cold = transcriptPage(source, path);
    expect(cold.turns).toEqual(cleared.turns);
    expect(cold.metadata).toEqual(cleared.metadata);
  });
}

for (const source of ["omp-transcript", "omo-transcript", "gjc-transcript"] as const) {
  test(`${source}: a read after an append parses the appended record, not the whole live task again`, () => {
    const work = Array.from({ length: 50 }, (_, i) => [call(source, `call-${i}`), result(source, `call-${i}`, `output ${i}`)]).flat();
    const path = fixture(jsonl(prompt(source, "Run every check"), ...work));
    transcriptPage(source, path);
    appendFileSync(path, jsonl(answer(source, "All checks passed")));
    const parse = spyOn(JSON, "parse");
    try {
      const grown = transcriptPage(source, path);
      expect(textParts(grown.turns)).toEqual(["Run every check", "All checks passed"]);
      expect(toolParts(grown.turns)).toHaveLength(50);
      expect(parse.mock.calls.length).toBeLessThan(20);
    } finally {
      parse.mockRestore();
    }
  });
}

// pi and Command Code keep a tree: a record names its parent, and the chat reads the branch ending
// at the last record written
const tree = () => {
  let parent: string | null = null;
  let next = 0;
  return (entry: object, parentId: string | null = parent) => {
    parent = `e${next++}`;
    return JSON.stringify({ id: parent, parentId, ...entry }) + "\n";
  };
};

for (const source of ["pi-transcript", "cmd-transcript"] as const) {
  test(`${source}: a read after an append parses the appended record, not the whole live task again`, () => {
    const record = tree();
    const work = Array.from({ length: 50 }, (_, i) => [call(source, `call-${i}`), result(source, `call-${i}`, `output ${i}`)]).flat();
    const path = fixture([prompt(source, "Run every check"), ...work].map(entry => record(entry)).join(""));
    transcriptPage(source, path);
    appendFileSync(path, record(answer(source, "All checks passed")));
    const parse = spyOn(JSON, "parse");
    try {
      const grown = transcriptPage(source, path);
      expect(textParts(grown.turns)).toEqual(["Run every check", "All checks passed"]);
      expect(toolParts(grown.turns)).toHaveLength(50);
      expect(parse.mock.calls.length).toBeLessThan(20);
    } finally {
      parse.mockRestore();
    }
    forgetTranscriptState();
    expect(textParts(transcriptPage(source, path).turns)).toEqual(["Run every check", "All checks passed"]);
  });

  test(`${source}: a branch move inside the live task drops what the old branch answered`, () => {
    const record = tree();
    const path = fixture(record(prompt(source, "Start")) + record(call(source, "one")) + record(result(source, "one", "first try")));
    transcriptPage(source, path);
    appendFileSync(path, record(answer(source, "abandoned answer")));
    expect(textParts(transcriptPage(source, path).turns)).toEqual(["Start", "abandoned answer"]);
    appendFileSync(path, record(answer(source, "branch answer"), "e2"));
    const moved = transcriptPage(source, path);
    expect(textParts(moved.turns)).toEqual(["Start", "branch answer"]);
    forgetTranscriptState();
    expect(transcriptPage(source, path).turns).toEqual(moved.turns);
  });
}

test("pi-transcript: a live task's context window follows the agent dir it is read with", () => {
  const dirs = [100_000, 200_000].map((window) => {
    const dir = mkdtempSync(join(tmpdir(), "herdr-native-incremental-agent-"));
    roots.push(dir);
    writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: window }] } } }));
    return dir;
  });
  const record = tree();
  const used = { type: "message", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { totalTokens: 50_000 }, content: [{ type: "text", text: "Working" }] } };
  const path = fixture(record(prompt("pi-transcript", "Start")) + record(used));
  const read = (dir: string) => transcriptPage("pi-transcript", path, {}, undefined, dir).metadata.context;
  expect(read(dirs[0]!)).toEqual({ used: 50_000, window: 100_000 });
  expect(read(dirs[1]!)).toEqual({ used: 50_000, window: 200_000 });
  appendFileSync(path, record(answer("pi-transcript", "Done")));
  expect(read(dirs[1]!)).toEqual({ used: 50_000, window: 200_000 });
  expect(read(dirs[0]!)).toEqual({ used: 50_000, window: 100_000 });
});

test("pi-transcript: a live task's context window follows an edited catalog and a provider named before the append", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-native-incremental-agent-"));
  roots.push(dir);
  const catalog = (window: number) => writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: window }] } } }));
  catalog(100_000);
  const record = tree();
  const path = fixture(record({ type: "model_change", provider: "lwsa", modelId: "qwen-test" }) + record(prompt("pi-transcript", "Start")));
  const read = () => transcriptPage("pi-transcript", path, {}, undefined, dir).metadata.context;
  read();
  const unnamed = (used: number) => record({ type: "message", message: { role: "assistant", model: "qwen-test", usage: { totalTokens: used }, content: [{ type: "text", text: "Working" }] } });
  appendFileSync(path, unnamed(40_000));
  expect(read()).toEqual({ used: 40_000, window: 100_000 });
  appendFileSync(path, unnamed(50_000));
  expect(read()).toEqual({ used: 50_000, window: 100_000 });
  catalog(1_000_000);
  appendFileSync(path, record(answer("pi-transcript", "Still working")));
  const warm = read();
  expect(warm).toEqual({ used: 50_000, window: 1_000_000 });
  forgetTranscriptState();
  expect(read()).toEqual(warm);
});

test("cmd-transcript: a live task's context window follows an edited Command Code catalog, and an unchanged one keeps the live parse", () => {
  const home = mkdtempSync(join(tmpdir(), "herdr-native-incremental-home-"));
  roots.push(home);
  const catalogPath = join(home, "commandcode-models.json");
  const located = spyOn(cmd, "cmdModelCatalogPath").mockReturnValue(catalogPath);
  try {
    const catalog = (window: number, at: number) => {
      writeFileSync(catalogPath, JSON.stringify({ version: 2, models: [{ id: "cat-jam", contextWindow: window }] }));
      utimesSync(catalogPath, at, at);
    };
    catalog(100_000, 1_700_000_000);
    const record = tree();
    // a live task long enough that a full reparse could not stay under the parse bound below
    const work = Array.from({ length: 30 }, (_, i) => [call("cmd-transcript", `work-${i}`), result("cmd-transcript", `work-${i}`, `output ${i}`)]).flat();
    const path = fixture([prompt("cmd-transcript", "Start"), ...work].map(entry => record(entry)).join("")
      + record({ type: "message", message: { role: "assistant", model: "cat-jam", usage: { totalTokens: 50_000 }, content: [{ type: "text", text: "Working" }] } }));
    expect(transcriptPage("cmd-transcript", path).metadata.context).toEqual({ used: 50_000, window: 100_000 });
    appendFileSync(path, record(call("cmd-transcript", "one")));
    expect(parses(() => expect(transcriptPage("cmd-transcript", path).metadata.context).toEqual({ used: 50_000, window: 100_000 }))).toBeLessThan(10);
    catalog(200_000, 1_700_000_100);
    appendFileSync(path, record(result("cmd-transcript", "one", "done")));
    const warm = transcriptPage("cmd-transcript", path);
    expect(warm.metadata.context).toEqual({ used: 50_000, window: 200_000 });
    forgetTranscriptState();
    expect(transcriptPage("cmd-transcript", path).metadata).toEqual(warm.metadata);
  } finally {
    located.mockRestore();
  }
});

test.skipIf(process.platform === "win32")("pi-transcript: a catalog that is a link loop counts as absent, and the others still answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-native-incremental-agent-"));
  roots.push(dir);
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: 100_000 }] } } }));
  symlinkSync(join(dir, "models-store.json"), join(dir, "models-store.json"));
  const record = tree();
  const path = fixture(record(prompt("pi-transcript", "Start")) + record({ type: "message", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { totalTokens: 50_000 }, content: [{ type: "text", text: "Working" }] } }));
  expect(transcriptPage("pi-transcript", path, {}, undefined, dir).metadata.context).toEqual({ used: 50_000, window: 100_000 });
});

const parses = (read: () => unknown) => {
  const parse = spyOn(JSON, "parse");
  try {
    read();
    return parse.mock.calls.length;
  } finally {
    parse.mockRestore();
  }
};
const busyTask = (source: Source) => jsonl(prompt(source, "Run every check"), ...Array.from({ length: 50 }, (_, i) => [call(source, `call-${i}`), result(source, `call-${i}`, `output ${i}`)]).flat());

test("OMO and GJC chats never take the live cache entries of OMP and Claude chats read in turn", () => {
  const chats = Array.from({ length: 10 }, (_, i) => ({ source: (i < 8 ? SOURCES[i % 2 ? 3 : 0] : SOURCES[i - 7])!, path: "" }));
  for (const chat of chats) chat.path = fixture(busyTask(chat.source));
  for (const { source, path } of chats) transcriptPage(source, path);
  for (let round = 0; round < 2; round++) {
    for (const { source, path } of chats) {
      appendFileSync(path, jsonl(answer(source, `round ${round}`)));
      expect(parses(() => expect(textParts(transcriptPage(source, path).turns).at(-1)).toBe(`round ${round}`))).toBeLessThan(20);
    }
  }
  expect(liveTurnCacheUsage()).toEqual({ paths: chats.map(chat => chat.path), withinBudget: true });
});

test("large OMO and GJC live tasks make room among themselves, never by evicting OMP's", () => {
  const output = "x".repeat(1024 * 1024);
  const large = (source: Source) => ({ source, path: fixture(jsonl(prompt(source, "Read the logs"), ...Array.from({ length: 11 }, (_, i) => [call(source, `log-${i}`), result(source, `log-${i}`, output)]).flat())) });
  const chats = (["omp-transcript", "omp-transcript", "omo-transcript", "gjc-transcript"] as const).map(large);
  for (const { source, path } of chats) transcriptPage(source, path);
  for (let round = 0; round < 2; round++) {
    for (const { source, path } of chats) {
      appendFileSync(path, jsonl(answer(source, `round ${round}`)));
      expect(parses(() => expect(toolParts(transcriptPage(source, path).turns)).toHaveLength(11))).toBeLessThan(20);
    }
  }
  appendFileSync(chats[2]!.path, jsonl(answer("omo-transcript", "once more")));
  transcriptPage(chats[2]!.source, chats[2]!.path);
  const third = large("omo-transcript");
  transcriptPage(third.source, third.path);
  expect(liveTurnCacheUsage()).toEqual({ paths: [chats[0]!, chats[1]!, chats[2]!, third].map(chat => chat.path), withinBudget: true });
});

for (const source of ["omo-transcript", "gjc-transcript"] as const) {
  test(`${source}: a turn reads the same live and once settled, with pictures only for omo and call ids only for gjc`, () => {
    const png = { type: "image", mimeType: "image/png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") };
    const path = fixture(jsonl(
      { ...message(source, "user", [{ type: "text", text: "Look at this" }, png]), id: "look" },
      call(source, "shot"),
      { type: "message", message: { role: "toolResult", toolCallId: "shot", content: [{ type: "text", text: "shot" }, png] } },
      { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Seen it" }] } },
    ));
    const live = transcriptPage(source, path).turns;
    appendFileSync(path, jsonl(prompt(source, "Next")));
    const settled = transcriptPage(source, path).turns;
    expect(settled.slice(0, live.length)).toEqual(live);
    const pictured = source === "omo-transcript";
    for (const turns of [live, settled]) {
      expect(turns.flatMap(turn => turn.parts).filter(part => part.kind === "image")).toEqual(pictured ? [{ kind: "image", media_type: "image/png", ref: "pi-prompt:look:0" }] : []);
      expect(toolParts(turns)[0]).toMatchObject({ output: "shot" });
      expect(toolParts(turns)[0]?.images).toEqual(pictured ? [{ media_type: "image/png", ref: "pi:shot:0" }] : undefined);
      expect(toolParts(turns)[0]?.call_id).toBe(source === "gjc-transcript" ? "shot" : undefined);
    }
  });
}

test("OMO: a growing rewrite of the live task forgets a task title only the old bytes gave", () => {
  const source = "omo-transcript";
  const spawn = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn", name: "task", arguments: {} }] } };
  const started = (details: Record<string, unknown>) => ({ type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "spawn", content: "Started", details } });
  const head = jsonl(prompt(source, "first"), answer(source, "done"), prompt(source, "second"), spawn);
  const path = fixture(head + jsonl(started({ task_id: "x", task_summary: "Old title" })));
  transcriptPage(source, path);
  const wake = { type: "custom_message", customType: "omo-senpi:wake", display: false,
    details: [{ customType: "senpi-task.completion", details: [{ task_id: "x", status: "completed", agent_type: "explorer", final_response: "Nothing left" }] }] };
  writeFileSync(path, head + jsonl(started({ task_id: "x", note: "no title this time, and longer" }), wake));
  const warm = transcriptPage(source, path);
  expect(warm.turns.at(-1)?.parts[0]).toMatchObject({ kind: "task_result", tasks: [{ id: "x", title: "explorer" }] });
  forgetTranscriptState();
  expect(transcriptPage(source, path).turns).toEqual(warm.turns);
});

test("OMO task completions ignore a discarded title preview and retain the committed title after a wake", () => {
  const source = "omo-transcript";
  const path = fixture(jsonl(prompt(source, "Review the parser"), {
    type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "spawn", name: "task", arguments: { task_summary: "Review the parser" } }] },
  }));
  const initial = transcriptPage(source, path);
  const title = (id: string, summary: string) => ({
    type: "message", message: { role: "toolResult", toolName: "task", toolCallId: "spawn", content: "Started", details: { task_id: id, task_summary: summary } },
  });
  appendFileSync(path, JSON.stringify(title("preview", "Discarded title")));
  const preview = transcriptPage(source, path);
  expect(toolParts(preview.turns)[0]?.output).toBe("Started");
  appendFileSync(path, " discarded\n" + jsonl(title("review", "Committed review")));
  const started = transcriptPage(source, path);
  expect(toolParts(started.turns)[0]?.output).toBe("Started");
  const completed = { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Waiting for the review" }] } };
  appendFileSync(path, jsonl(completed, {
    type: "custom_message", customType: "omo-senpi:wake", display: false,
    details: [{ customType: "senpi-task.completion", details: [
      { task_id: "review", status: "completed", agent_type: "reviewer", final_response: "No regression found" },
      { task_id: "preview", status: "completed", agent_type: "explorer", final_response: "Nothing left" },
    ] }],
  }));
  const woken = transcriptPage(source, path);
  const task = woken.turns.at(-1)?.parts[0];
  expect(task).toMatchObject({ kind: "task_result", tasks: [
    { id: "review", title: "Committed review", status: "completed", result: "No regression found" },
    { id: "preview", title: "explorer", status: "completed", result: "Nothing left" },
  ] });
  appendFileSync(path, jsonl(answer(source, "Review applied")));
  const finished = transcriptPage(source, path);
  expect(finished.turns.map(turn => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(finished.turns[1]?.parts.at(-1)).toEqual({ kind: "text", text: "Waiting for the review", phase: "final_answer" });
  expect(toolParts(initial.turns)[0]?.output).toBe("");
  expect(woken.turns.map(turn => turn.role)).toEqual(["user", "assistant", "user"]);
  forgetTranscriptState();
  expect(transcriptPage(source, path).turns).toEqual(finished.turns);
});

test("GJC background deliveries keep final answers separate and internal IRC stays hidden across refreshes", () => {
  const source = "gjc-transcript";
  const path = fixture(jsonl(prompt(source, "Run the build"), {
    type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Build started" }] },
  }));
  const initial = transcriptPage(source, path);
  for (const customType of ["irc:incoming", "irc:autoreply", "irc:relay"]) {
    appendFileSync(path, jsonl({ type: "custom_message", customType, attribution: "agent", display: true, content: "Internal delivery" }));
    expect(transcriptPage(source, path).turns).toEqual(initial.turns);
  }
  appendFileSync(path, jsonl({ type: "custom_message", customType: "async-result", display: true, content: "<system-notice>Build passed</system-notice>" }));
  const delivered = transcriptPage(source, path);
  expect(delivered.turns.at(-1)?.parts).toEqual([{ kind: "notice", source: "async-result", text: "Build passed" }]);
  appendFileSync(path, jsonl(call(source, "read"), result(source, "read", "Build receipt"), {
    type: "custom_message", customType: "async-result", display: false, content: "Hidden runtime notice",
  }, answer(source, "Checked the receipt")));
  const finished = transcriptPage(source, path);
  expect(finished.turns.map(turn => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(finished.turns[1]?.parts).toEqual([{ kind: "text", text: "Build started", phase: "final_answer" }]);
  expect(toolParts(finished.turns)[0]).toMatchObject({ output: "Build receipt", call_id: "read" });
  expect(textParts(finished.turns)).toEqual(["Run the build", "Build started", "Checked the receipt"]);
  expect(delivered.turns.at(-1)?.parts).toEqual([{ kind: "notice", source: "async-result", text: "Build passed" }]);
  forgetTranscriptState();
  expect(transcriptPage(source, path).turns).toEqual(finished.turns);
});

test("Claude live completion cards adopt late meta files without changing earlier snapshots", () => {
  const source = "claude-transcript";
  const content = '<task-notification><task-id>review</task-id><tool-use-id>agent-call</tool-use-id><status>completed</status><summary>Agent "Fallback" finished</summary><result>Checked the result.</result></task-notification>';
  const path = fixture(jsonl(prompt(source, "Review it"), call(source, "work"), { type: "queue-operation", operation: "enqueue", content }));
  const cards = (turns: ConversationTurn[]) => turns.flatMap(turn => turn.parts.flatMap(part => part.kind === "task_result" ? part.tasks : []));
  const initial = transcriptPage(source, path);
  expect(cards(initial.turns)[0]).toMatchObject({ title: "Fallback", agent: null });
  const directory = join(dirname(path), "session", "subagents");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "agent-review.meta.json"), JSON.stringify({ description: "Review parser state", agentType: "reviewer" }));
  appendFileSync(path, jsonl(answer(source, "Finished reviewing")));
  const updated = transcriptPage(source, path);
  expect(cards(updated.turns)[0]).toMatchObject({ title: "Review parser state", agent: "reviewer", result: "Checked the result." });
  expect(cards(initial.turns)[0]).toMatchObject({ title: "Fallback", agent: null });
  forgetTranscriptState();
  expect(transcriptPage(source, path).turns).toEqual(updated.turns);
});
