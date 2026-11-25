import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, appendFileSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { defaultPiSessionDir, piExtensionCommands, piPaneAgentDirs, piTranscriptInStore, piTranscriptPath, piUnwrittenHeaderId, unwrittenSession } from "./pi.ts";
import { piAgentDir } from "./pi-models.ts";
import { transcriptPage, piTranscriptImage } from "./conversation.ts";
import { turnStarts } from "./transcript-turns.ts";
import type { ConversationTurn } from "../shared/protocol.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-pi-store-"));
const store = join(root, "sessions");
const slug = join(store, `--${root.replace(/[\\/:]/g, "-")}--`);
mkdirSync(slug, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const canSymlink = (() => {
  const probe = join(root, "symlink-capability");
  try { symlinkSync(store, probe, "dir"); rmSync(probe); return true; }
  catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
})();

const session = (name: string, body: unknown[] = []) => {
  const path = join(slug, `${name}.jsonl`);
  writeFileSync(path, [
    { type: "session", version: 3, id: name, timestamp: new Date().toISOString(), cwd: root },
    ...body,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
};

describe("pi's session store holds the transcript a pane reads", () => {
  it("accepts a session file inside the store", () => {
    const path = session("inside");
    expect(piTranscriptInStore(path, store)).toBe(path);
  });

  it("refuses paths that leave the store", () => {
    const outside = join(root, "elsewhere.jsonl");
    writeFileSync(outside, "{}\n");
    expect(piTranscriptInStore(outside, store)).toBeNull();
    expect(piTranscriptInStore(join(store, "..", "elsewhere.jsonl"), store)).toBeNull();
    expect(piTranscriptInStore(store, store)).toBeNull();
    expect(piTranscriptInStore(join(root, "missing.jsonl"), store)).toBeNull();
  });

  it.skipIf(!canSymlink)("refuses a link out of the store", () => {
    const outside = join(root, "target.jsonl");
    writeFileSync(outside, "{}\n");
    const link = join(slug, "link.jsonl");
    symlinkSync(outside, link);
    expect(piTranscriptInStore(link, store)).toBeNull();
  });
  it("refuses a directory and a file that is not jsonl", () => {
    mkdirSync(join(slug, "dir.jsonl"), { recursive: true });
    expect(piTranscriptInStore(join(slug, "dir.jsonl"), store)).toBeNull();
    const other = join(slug, "notes.txt");
    writeFileSync(other, "{}\n");
    expect(piTranscriptInStore(other, store)).toBeNull();
  });

  it("names a session pi has not written yet only when its path is in the store", () => {
    expect(unwrittenSession(join(slug, "2026-10-06_fresh.jsonl"), store)).toEqual({ id: "2026-10-06_fresh", path: join(realpathSync(slug), "2026-10-06_fresh.jsonl") });
    expect(unwrittenSession(join(store, "new-cwd", "fresh.jsonl"), store)).toEqual({ id: "fresh", path: join(realpathSync(store), "new-cwd", "fresh.jsonl") });
    expect(unwrittenSession(session("written"), store)).toBeNull();
    expect(unwrittenSession(join(root, "missing.jsonl"), store)).toBeNull();
    expect(unwrittenSession(join(store, "..", "missing.jsonl"), store)).toBeNull();
    expect(unwrittenSession(join(slug, "fresh.txt"), store)).toBeNull();
    expect(unwrittenSession("fresh.jsonl", store)).toBeNull();
    expect(unwrittenSession(join(root, "no-store", "fresh.jsonl"), join(root, "no-store"))).toBeNull();
  });
  it("derives an unwritten Pi header id only from Pi's exact production filename", () => {
    const id = "12345678-1234-4123-8123-123456789abc";
    const unwritten = unwrittenSession(join(slug, `2026-10-12T22-06-12-992Z_${id}.jsonl`), store);
    expect(unwritten).not.toBeNull();
    expect(piUnwrittenHeaderId(unwritten!.path)).toBe(id);
    expect(piUnwrittenHeaderId(join(slug, `${id}.jsonl`))).toBeNull();
  });
  it.skipIf(!canSymlink)("refuses a dangling session link", () => {
    const dangling = join(slug, "dangling.jsonl");
    symlinkSync(join(root, "nowhere.jsonl"), dangling);
    expect(unwrittenSession(dangling, store)).toBeNull();
  });

  it.skipIf(!canSymlink)("resolves the directories around an unwritten session before trusting its place", () => {
    // a link in the store to a directory outside it does not make its children the store's
    mkdirSync(join(root, "outside-dir"), { recursive: true });
    symlinkSync(join(root, "outside-dir"), join(store, "escape"));
    expect(unwrittenSession(join(store, "escape", "fresh.jsonl"), store)).toBeNull();
    symlinkSync(join(root, "nowhere-dir"), join(store, "broken"));
    expect(unwrittenSession(join(store, "broken", "fresh.jsonl"), store)).toBeNull();
    // the store reached through a link is still the store
    const alias = join(root, "store-alias");
    symlinkSync(store, alias);
    expect(unwrittenSession(join(slug, "fresh.jsonl"), alias)).toEqual({ id: "fresh", path: join(realpathSync(slug), "fresh.jsonl") });
    expect(unwrittenSession(join(alias, "fresh.jsonl"), store)).toEqual({ id: "fresh", path: join(realpathSync(store), "fresh.jsonl") });
  });

  it("a file where a directory should be holds no unwritten session", () => {
    writeFileSync(join(slug, "plain"), "");
    expect(unwrittenSession(join(slug, "plain", "fresh.jsonl"), store)).toBeNull();
  });

  it("follows PI_CODING_AGENT_SESSION_DIR the way Codex follows CODEX_HOME", () => {
    const previous = process.env["PI_CODING_AGENT_SESSION_DIR"];
    process.env["PI_CODING_AGENT_SESSION_DIR"] = store;
    try { expect(defaultPiSessionDir()).toBe(store); } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_SESSION_DIR"];
      else process.env["PI_CODING_AGENT_SESSION_DIR"] = previous;
    }
  });

  it("looks under the agent directory PI_CODING_AGENT_DIR names, where pi keeps its sessions", () => {
    const before = { dir: process.env["PI_CODING_AGENT_DIR"], sessions: process.env["PI_CODING_AGENT_SESSION_DIR"] };
    process.env["PI_CODING_AGENT_DIR"] = root;
    delete process.env["PI_CODING_AGENT_SESSION_DIR"];
    try { expect(defaultPiSessionDir()).toBe(store); } finally {
      if (before.dir === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = before.dir;
      if (before.sessions !== undefined) process.env["PI_CODING_AGENT_SESSION_DIR"] = before.sessions;
    }
  });
});

// pi's own record shapes: a system prompt that stays hidden, a prompt, an assistant
// turn whose thinking, prose and calls sit side by side, and results answering by id.
const conversation = [
  { type: "model_change", id: "m1", parentId: null, timestamp: "2026-09-30T00:00:00.000Z", provider: "test", modelId: "qwen-test" },
  { type: "thinking_level_change", id: "t1", parentId: "m1", timestamp: "2026-09-30T00:00:00.000Z", thinkingLevel: "medium" },
  { type: "message", id: "s1", parentId: "t1", timestamp: "2026-09-30T00:00:01.000Z", message: { role: "system", content: "instructions the chat must not show" } },
  { type: "message", id: "u1", parentId: "s1", timestamp: "2026-09-30T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "fix the crash" }] } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:03.000Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse",
    usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, totalTokens: 420 },
    content: [
      { type: "thinking", thinking: "the null check is missing" },
      { type: "text", text: "I'll add the guard." },
      { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/app.ts" } },
    ],
  } },
  { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:04.000Z", message: {
    role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "export const app = null;" }],
  } },
  { type: "message", id: "a2", parentId: "r1", timestamp: "2026-09-30T00:00:05.000Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "stop",
    usage: { input: 150, output: 30, cacheRead: 300, cacheWrite: 0, totalTokens: 480 },
    content: [{ type: "text", text: "Guarded. The crash came from a null export." }],
  } },
];

describe("pi transcripts render as chat", () => {
  it("reads prompts, thinking, tool results and recorded settings", () => {
    const page = transcriptPage("pi-transcript", session("readable", conversation));
    expect(page.source).toBe("pi-transcript");
    // the window pi itself states for the answer, and its totalTokens: the figure pi's own
    // footer divides by a window, so the two views of one session cannot disagree
    expect(page.metadata).toEqual({ model: "qwen-test", reasoning_effort: "medium", context: { used: 480, window: null }, provider: "test" });
    expect(page.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);

    const [prompt, answer] = page.turns as [ConversationTurn, ConversationTurn];
    expect(prompt.parts).toEqual([{ kind: "text", text: "fix the crash" }]);
    expect(answer.parts.map((part) => part.kind)).toEqual(["thinking", "text", "tool", "text"]);
    const tool = answer.parts.find((part) => part.kind === "tool");
    if (tool?.kind !== "tool") throw new Error("expected a tool part");
    expect([tool.name, tool.summary, tool.output]).toEqual(["read", "src/app.ts", "export const app = null;"]);
    // the system prompt is hidden context, never an assistant message
    expect(JSON.stringify(page.turns)).not.toContain("instructions the chat must not show");
  });

  it("reads the window from the agent dir it is given, and answers anew when that dir changes", () => {
    const dirs = ["agent-a", "agent-b"].map((name, index) => {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { lwsa: { models: [{ id: "qwen-test", contextWindow: (index + 1) * 100_000 }] } } }));
      return dir;
    });
    const path = session("two-dirs", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: "first" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:02.000Z", message: { role: "assistant", model: "qwen-test", provider: "lwsa", usage: { totalTokens: 50_000 }, content: [{ type: "text", text: "answer" }] } },
      { type: "message", id: "u2", parentId: "a1", timestamp: "2026-09-30T00:00:03.000Z", message: { role: "user", content: "second" } },
    ]);
    const first = transcriptPage("pi-transcript", path, {}, undefined, dirs[0]);
    const second = transcriptPage("pi-transcript", path, {}, undefined, dirs[1]);
    expect(first.metadata.context).toEqual({ used: 50_000, window: 100_000 });
    expect(second.metadata.context).toEqual({ used: 50_000, window: 200_000 });
    expect(second.version).not.toBe(first.version);
    expect(transcriptPage("pi-transcript", path, {}, undefined, dirs[0]).metadata.context).toEqual({ used: 50_000, window: 100_000 });
  });

  it("shows a failed request instead of a prompt with no answer", () => {
    const page = transcriptPage("pi-transcript", session("failed", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:02.000Z", message: { role: "user", content: "hello" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:03.000Z", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "401 unauthorized" } },
    ]));
    expect(page.turns[1]!.parts).toEqual([{ kind: "text", text: "Error: 401 unauthorized", failed: true }]);
  });

  it("starts a fresh history when /new or /resume moves the pane to another file", () => {
    // pi writes no marker for these: a new session is a new file, and herdr re-reports it.
    const before = transcriptPage("pi-transcript", session("first", conversation));
    const after = transcriptPage("pi-transcript", session("second", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:10:00.000Z", message: { role: "user", content: "new topic" } },
    ]));
    expect(after.history_id).not.toBe(before.history_id);
    expect(after.turns).toHaveLength(1);
    // a cursor into the abandoned file cannot page the new one
    expect(() => transcriptPage("pi-transcript", join(slug, "second.jsonl"), { before: before.cursor! })).toThrow();
  });

  // pi folds old context into a summary of its own accord and on /compact. The entry is a
  // tree entry rather than a message, so without a branch of its own it showed as nothing:
  // the chat ran from a prompt straight to an answer with the middle quietly gone.
  it("marks where /compact folded the conversation, with its summary", () => {
    const path = session("compacted", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: "the first question" } },
      { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-09-30T00:00:02.000Z", summary: "## Session Goal\n- fold the older turns", firstKeptEntryId: "u1", tokensBefore: 178366 },
      { type: "message", id: "u2", parentId: "c1", timestamp: "2026-09-30T00:00:03.000Z", message: { role: "user", content: "and now the next one" } },
    ]);
    const page = transcriptPage("pi-transcript", path);
    expect(page.turns.map((turn) => turn.parts.map((part) => part.kind)))
      .toEqual([["text"], ["compact"], ["text"]]);
    const card = page.turns[1]!.parts[0]!;
    expect(card).toEqual({ kind: "compact", text: "## Session Goal\n- fold the older turns", tokens_before: 178366 });
    expect(page.turns[1]!.role).toBe("user");
  });

  it("keeps a compaction a /tree navigated away from out of the chat", () => {
    const body = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: "the first question" } },
      { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-09-30T00:00:02.000Z", summary: "the fold on the branch left behind" },
      { type: "message", id: "u2", parentId: "c1", timestamp: "2026-09-30T00:00:03.000Z", message: { role: "user", content: "a turn on that branch" } },
    ];
    const path = session("compacted-then-navigated", body);
    expect(transcriptPage("pi-transcript", path).turns.filter((turn) => turn.parts.some((part) => part.kind === "compact"))).toHaveLength(1);
    appendFileSync(path, JSON.stringify({
      type: "message", id: "a2", parentId: "u1", timestamp: "2026-09-30T00:10:00.000Z",
      message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "the answer in play" }] },
    }) + "\n");
    const page = transcriptPage("pi-transcript", path);
    expect(page.turns.map((turn) => turn.parts.map((part) => part.kind))).toEqual([["text"], ["text"]]);
  });

  it("shows nothing for a compaction whose summary was never written", () => {
    const path = session("compaction-empty", [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: "hello" } },
      { type: "compaction", id: "c1", parentId: "u1", timestamp: "2026-09-30T00:00:02.000Z", summary: "", firstKeptEntryId: "u1" },
    ]);
    expect(transcriptPage("pi-transcript", path).turns).toHaveLength(1);
  });
});

// pi reads a picture into the tool result as base64 beside the text it returns, so a
// screenshot a `read` opened was in the file and invisible. The page carries only the
// address; the bytes are fetched with the row. `mimeType` and `data` are pi's own spellings.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const withImage = (toolCallId: string, extra: unknown[] = []) => ({
  type: "message", id: `r-${toolCallId}`, parentId: "a1", timestamp: "2026-09-30T00:00:04.000Z",
  message: { role: "toolResult", toolCallId, toolName: "read", content: [
    { type: "text", text: "read 1 image" },
    { type: "image", mimeType: "image/png", data: PNG.toString("base64") },
    ...extra,
  ] },
});
const callingRead = (id: string) => ({
  type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:03.000Z", message: {
    role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse", usage: { input: 10, output: 1 },
    content: [{ type: "toolCall", id, name: "read", arguments: { path: "shot.png" } }],
  }
});
const asked = { type: "message", id: "u1", parentId: null, timestamp: "2026-09-30T00:00:02.000Z", message: { role: "user", content: "what is in this screenshot?" } };

describe("a pi tool result's images reach the chat", () => {
  const imageOf = (part: unknown) => (part as Extract<ConversationTurn["parts"][number], { kind: "tool" }>).images;

  it("addresses the image a call returned, and decodes it on request", () => {
    const path = session("image-result", [asked, callingRead("c1"), withImage("c1")]);
    const tool = transcriptPage("pi-transcript", path).turns[1]!.parts[0]!;
    expect(imageOf(tool)).toEqual([{ media_type: "image/png", ref: "pi:c1:0" }]);
    expect((tool as Extract<typeof tool, { kind: "tool" }>).output).toBe("read 1 image");
    const image = piTranscriptImage(path, "pi:c1:0");
    expect(image?.mediaType).toBe("image/png");
    expect(Buffer.from(image!.bytes).equals(PNG)).toBe(true);
  });

  it("numbers several images of one result, and skips types a chat cannot show", () => {
    const path = session("image-many", [asked, callingRead("c1"), withImage("c1", [
      { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" },
      { type: "image", mimeType: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
    ])]);
    expect(imageOf(transcriptPage("pi-transcript", path).turns[1]!.parts[0]!)).toEqual([
      { media_type: "image/png", ref: "pi:c1:0" },
      // the svg took no number: a ref counts the images shown, so it can never point aside
      { media_type: "image/jpeg", ref: "pi:c1:1" },
    ]);
    expect(piTranscriptImage(path, "pi:c1:2")).toBeNull();
    expect(piTranscriptImage(path, "pi:c1:9")).toBeNull();
    expect(piTranscriptImage(path, "c1:0")).toBeNull();
    expect(piTranscriptImage(path, "pi:c9:0")).toBeNull();
    expect(piTranscriptImage(join(root, "nowhere.jsonl"), "pi:c1:0")).toBeNull();
  });

  it("finds an image on a result the assistant record carried itself", () => {
    // a provider may answer beside its call; the entry then holds several results, and an
    // entry id could not say which one an image belonged to
    const path = session("image-nested", [{ ...asked, parentId: null }, {
      type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:03.000Z", message: {
        role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse", usage: { input: 10, output: 1 },
        content: [
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
          { type: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }] },
        ],
      } },
    ]);
    const tool = transcriptPage("pi-transcript", path).turns[1]!.parts[0]!;
    expect(imageOf(tool)).toEqual([{ media_type: "image/png", ref: "pi:c1:0" }]);
    expect(Buffer.from(piTranscriptImage(path, "pi:c1:0")!.bytes).equals(PNG)).toBe(true);
  });

  it("keeps an image a /tree navigated away from out of the chat and out of reach", () => {
    const path = session("image-off-branch", [asked, callingRead("c1"), withImage("c1")]);
    expect(imageOf(transcriptPage("pi-transcript", path).turns[1]!.parts[0]!)).toHaveLength(1);
    appendFileSync(path, JSON.stringify({
      type: "message", id: "a9", parentId: "u1", timestamp: "2026-09-30T00:20:00.000Z",
      message: { role: "assistant", model: "qwen-test", provider: "test", stopReason: "stop", usage: { input: 5, output: 1 }, content: [{ type: "text", text: "another answer entirely" }] },
    }) + "\n");
    const page = transcriptPage("pi-transcript", path);
    expect(page.turns.flatMap((turn) => turn.parts).some((part) => part.kind === "tool" && imageOf(part) !== undefined)).toBe(false);
    expect(piTranscriptImage(path, "pi:c1:0")).toBeNull();
  });

  it("offers no image to a pane whose store is not pi's", () => {
    // a claude ref is a uuid and index; a pi ref names a tool call. Neither reads the other's file.
    expect(piTranscriptImage(session("claude-shaped", [asked]), "pi:c1:0")).toBeNull();
  });

  it("names only pictures whose bytes are a raster the chat shows", () => {
    // declared a PNG, but the bytes are an svg: the page names nothing the endpoint would refuse
    const path = session("image-not-raster", [asked, callingRead("c1"), { ...withImage("c1"), message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: "PHN2Zz4=" }] } }]);
    expect(imageOf(transcriptPage("pi-transcript", path).turns[1]!.parts[0]!)).toBeUndefined();
    expect(piTranscriptImage(path, "pi:c1:0")).toBeNull();
  });

  it("serves a tool's picture only from the result the page draws: the first one answering its call", () => {
    const GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    const again = { type: "message", id: "r2", parentId: "r-c1", timestamp: "2026-09-30T00:00:05.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "context_clear" }, { type: "image", mimeType: "image/gif", data: GIF }] } };
    const path = session("image-answered-twice", [asked, callingRead("c1"), withImage("c1"), again]);
    expect(imageOf(transcriptPage("pi-transcript", path).turns[1]!.parts[0]!)).toEqual([{ media_type: "image/png", ref: "pi:c1:0" }]);
    expect(piTranscriptImage(path, "pi:c1:0")?.mediaType).toBe("image/png");
    // a first result with no picture the chat shows names none, and the later one does not stand in
    const none = { ...withImage("c1"), message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: "PHN2Zz4=" }] } };
    const pathNone = session("image-answered-twice-none", [asked, callingRead("c1"), none, again]);
    expect(imageOf(transcriptPage("pi-transcript", pathNone).turns[1]!.parts[0]!)).toBeUndefined();
    expect(piTranscriptImage(pathNone, "pi:c1:0")).toBeNull();
    const pathNested = session("image-nested-twice", [{ ...asked, parentId: null }, {
      type: "message", id: "a1", parentId: "u1", timestamp: "2026-09-30T00:00:03.000Z", message: {
        role: "assistant", model: "qwen-test", provider: "test", stopReason: "toolUse", usage: { input: 10, output: 1 },
        content: [
          { type: "toolCall", id: "c1", name: "read", arguments: {} },
          { type: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", mimeType: "image/png", data: PNG.toString("base64") }] },
          { type: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "image", mimeType: "image/gif", data: GIF }] },
        ],
      } },
    ]);
    expect(imageOf(transcriptPage("pi-transcript", pathNested).turns[1]!.parts[0]!)).toEqual([{ media_type: "image/png", ref: "pi:c1:0" }]);
    expect(piTranscriptImage(pathNested, "pi:c1:0")?.mediaType).toBe("image/png");
    expect(piTranscriptImage(pathNested, "pi:c1:1")).toBeNull();
    const callAgain = { ...callingRead("c1"), id: "a2", parentId: "r1" };
    const textOnly = { type: "message", id: "r1", parentId: "a1", timestamp: "2026-09-30T00:00:04.000Z", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "nothing to read" }] } };
    const pathAgain = session("image-called-again", [asked, callingRead("c1"), textOnly, callAgain, { ...withImage("c1"), id: "r2", parentId: "a2" }]);
    expect(transcriptPage("pi-transcript", pathAgain).turns.flatMap((turn) => turn.parts).flatMap((part) => part.kind === "tool" ? imageOf(part) ?? [] : [])).toEqual([{ media_type: "image/png", ref: "pi:c1:0" }]);
    expect(piTranscriptImage(pathAgain, "pi:c1:0")?.mediaType).toBe("image/png");
    // a result answering no call the page draws: its picture is named nowhere
    const pathOrphan = session("image-orphan", [asked, callingRead("c1"), { ...withImage("c2"), id: "r-c2", parentId: "a1" }]);
    expect(transcriptPage("pi-transcript", pathOrphan).turns.flatMap((turn) => turn.parts).some((part) => part.kind === "tool" && imageOf(part) !== undefined)).toBe(false);
    expect(piTranscriptImage(pathOrphan, "pi:c2:0")).toBeNull();
  });

  it("puts a tool's picture from before a clear out of reach, as the page does", () => {
    const path = session("image-cleared", [asked, callingRead("c1"), withImage("c1"),
      { type: "custom", customType: "context_clear", id: "x1", parentId: "r-c1", timestamp: "2026-09-30T00:00:05.000Z" }]);
    expect(transcriptPage("pi-transcript", path).turns).toEqual([]);
    expect(piTranscriptImage(path, "pi:c1:0")).toBeNull();
  });
});

// A picture pi was sent: pi keeps it in the prompt beside the words, or alone. Only the address
// reaches the page; the bytes are fetched when the prompt is shown.
describe("the pictures sent to pi reach the chat", () => {
  const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const picture = (bytes: Buffer, mimeType = "image/png") => ({ type: "image", mimeType, data: bytes.toString("base64") });
  const prompt = (id: string, parentId: string | null, content: unknown[]) => ({ type: "message", id, parentId, timestamp: "2026-09-30T00:00:02.000Z", message: { role: "user", content } });
  const answer = (id: string, parentId: string, text: string) => ({ type: "message", id, parentId, timestamp: "2026-09-30T00:00:03.000Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
  const parts = (path: string) => transcriptPage("pi-transcript", path).turns.map((turn) => turn.parts.map((part) => part.kind === "text" ? part.text : part.kind === "image" ? `${part.media_type} ${part.ref}` : part.kind));

  it("shows a prompt that is only a picture, and one with words, each picture by its prompt and place", () => {
    const path = session("prompt-pictures", [
      prompt("u1", null, [picture(PNG)]), answer("a1", "u1", "a pixel"),
      // an svg, and bytes that are no picture under a picture's type, take no place
      prompt("u2", "a1", [{ type: "text", text: "and these?" }, picture(Buffer.from("<svg/>"), "image/svg+xml"), picture(Buffer.from("not a picture")), picture(GIF, "image/gif")]), answer("a2", "u2", "a gif"),
    ]);
    expect(parts(path)).toEqual([["image/png pi-prompt:u1:0"], ["a pixel"], ["image/gif pi-prompt:u2:0", "and these?"], ["a gif"]]);
    expect(JSON.stringify(transcriptPage("pi-transcript", path).turns)).not.toContain(PNG.toString("base64"));
    expect(Buffer.from(piTranscriptImage(path, "pi-prompt:u1:0")!.bytes).equals(PNG)).toBe(true);
    expect(piTranscriptImage(path, "pi-prompt:u2:0")?.mediaType).toBe("image/gif");
    for (const ref of ["pi-prompt:u2:1", "pi-prompt:a1:0", "pi-prompt:u1", "pi-prompt:../u1:0"]) expect(piTranscriptImage(path, ref)).toBeNull();
  });

  it("opens a page's turn at a prompt that is only a picture, as at one with words", () => {
    const rows = [prompt("u1", null, [{ type: "text", text: "first" }]), answer("a1", "u1", "one"), prompt("u2", "a1", [picture(PNG)]), answer("a2", "u2", "two")].map((row) => JSON.stringify(row));
    const bytes = Buffer.from(rows.join("\n"));
    const second = rows[0]!.length + rows[1]!.length + 2;
    expect(turnStarts(bytes, "pi-transcript")).toEqual([0, second]);
    // omp draws its prompt pictures as pi does, so it opens a turn there too
    expect(turnStarts(bytes, "omp-transcript")).toEqual([0, second]);
  });

  it("keeps a picture a /tree or a clear left behind out of the chat and out of reach", () => {
    const path = session("prompt-picture-left", [prompt("u1", null, [picture(PNG)]), answer("a1", "u1", "a pixel")]);
    expect(parts(path)).toEqual([["image/png pi-prompt:u1:0"], ["a pixel"]]);
    appendFileSync(path, JSON.stringify(prompt("u9", null, [{ type: "text", text: "start over" }])) + "\n");
    expect(parts(path)).toEqual([["start over"]]);
    expect(piTranscriptImage(path, "pi-prompt:u1:0")).toBeNull();
    const cleared = session("prompt-picture-cleared", [prompt("u1", null, [picture(PNG)]), answer("a1", "u1", "a pixel"),
      { type: "custom", customType: "context_clear", id: "x1", parentId: "a1", timestamp: "2026-09-30T00:00:04.000Z" }]);
    expect(parts(cleared)).toEqual([]);
    expect(piTranscriptImage(cleared, "pi-prompt:u1:0")).toBeNull();
  });

  it("reads a clear and an entry id however JSON writes them, as the parser does", () => {
    const respell = (path: string, from: string, to: string) => {
      const text = readFileSync(path, "utf8");
      expect(text).toContain(from);
      writeFileSync(path, text.replace(from, to));
      return path;
    };
    // a clear whose type is written with an escape is still a clear
    const cleared = respell(session("prompt-picture-escaped-clear", [prompt("u1", null, [picture(PNG)]), answer("a1", "u1", "a pixel"),
      { type: "custom", customType: "context_clear", id: "x1", parentId: "a1", timestamp: "2026-09-30T00:00:04.000Z" }]), '"customType":"context_clear"', '"customType":"context\\u005fclear"');
    expect(parts(cleared)).toEqual([]);
    expect(piTranscriptImage(cleared, "pi-prompt:u1:0")).toBeNull();
    // a prompt whose id is written with an escape is still the prompt the page names
    const escaped = respell(session("prompt-picture-escaped-id", [prompt("u1", null, [picture(PNG)]), answer("a1", "u1", "a pixel")]), '"id":"u1"', '"id":"\\u00751"');
    expect(parts(escaped)).toEqual([["image/png pi-prompt:u1:0"], ["a pixel"]]);
    expect(Buffer.from(piTranscriptImage(escaped, "pi-prompt:u1:0")!.bytes).equals(PNG)).toBe(true);
  });
});

// The bridge must resolve a Pi profile from the process running in this pane; its own
// environment belongs to the bridge and may name a different profile.
it("reads a resumed transcript from this pane's Pi profile store", async () => {
  const profile = join(root, "compound-profile");
  const profileSessions = join(profile, "sessions");
  mkdirSync(profileSessions, { recursive: true });
  const customTranscript = join(profileSessions, "resumed-profile.jsonl");
  writeFileSync(customTranscript, "{\"type\":\"session\"}\n");
  const old = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = join(root, "bridge-default");
  try {
    const result = await piTranscriptPath("pi-profile-pane", undefined, {
      agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: customTranscript } } as never,
      processes: [{ pid: 777, argv: ["/usr/bin/pi"] }],
      environOf: () => [`PI_CODING_AGENT_DIR=${profile}`],
      home: root,
    });
    // the model catalogs are the pane's too, not those of the bridge's own PI_CODING_AGENT_DIR
    expect(result).toEqual({ path: customTranscript, agentDir: profile, identity: expect.any(String) });
  } finally {
    if (old === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = old;
    rmSync(profile, { recursive: true, force: true });
    rmSync(join(root, "bridge-default"), { recursive: true, force: true });
  }
});

it("resolves profile and session-directory overrides from each pane's Pi process", async () => {
  for (const name of ["profile-a", "profile-b"]) {
    const profile = join(root, name);
    const profileStore = join(profile, "sessions");
    mkdirSync(profileStore, { recursive: true });
    const target = join(profileStore, `${name}.jsonl`);
    writeFileSync(target, "{\"type\":\"session\"}\n");
    const agent = { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: target } } as never;
    expect(await piTranscriptPath("pane", join(root, "bridge-default"), {
      agent,
      processes: [{ pid: name === "profile-a" ? 790 : 791, argv: [name === "profile-a" ? "pi.exe" : "bun", ...(name === "profile-a" ? [] : ["/opt/pi.cjs"])] }],
      environOf: () => [`PI_CODING_AGENT_DIR=${profile}`],
      home: root,
    })).toEqual({ path: target, agentDir: profile, identity: expect.any(String) });
  }
  const sessionDir = join(root, "direct-session-dir");
  mkdirSync(sessionDir, { recursive: true });
  const target = join(sessionDir, "explicit.jsonl");
  writeFileSync(target, "{\"type\":\"session\"}\n");
  expect(await piTranscriptPath("pane", join(root, "bridge-default"), {
    agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: target } } as never,
    processes: [{ pid: 792, argv: ["/usr/bin/pi"] }],
    environOf: () => [`PI_CODING_AGENT_SESSION_DIR=${sessionDir}`],
    home: root,
  })).toEqual({ path: target, agentDir: join(root, ".pi", "agent"), identity: expect.any(String) });
});

it("recognizes Pi's official npm bundle entry and renamed runtime argv", async () => {
  const profile = join(root, "npm-profile");
  const profileStore = join(profile, "sessions");
  mkdirSync(profileStore, { recursive: true });
  const target = join(profileStore, "npm.jsonl");
  writeFileSync(target, "{\"type\":\"session\"}\n");
  const agent = { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: target } } as never;
  const officialEntry = "/home/test/.local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
  expect(await piTranscriptPath("pane", undefined, {
    agent, processes: [{ pid: 810, argv: ["/usr/bin/node", officialEntry] }],
    environOf: () => [`PI_CODING_AGENT_DIR=${profile}`], home: root,
  })).toEqual({ path: target, agentDir: profile, identity: expect.any(String) });
  expect(await piTranscriptPath("pane", undefined, {
    agent, processes: [{ pid: 811, argv: ["pi", "--offline"] }],
    environOf: () => [`PI_CODING_AGENT_DIR=${profile}`], home: root,
  })).toEqual({ path: target, agentDir: profile, identity: expect.any(String) });
  expect(await piTranscriptPath("pane", undefined, {
    agent, processes: [{ pid: 812, argv: ["/usr/bin/pi"] }],
    environOf: () => [`USERPROFILE=${root}`, "PI_CODING_AGENT_DIR=~/npm-profile"], home: join(root, "bridge-home"),
  })).toEqual({ path: target, agentDir: profile, identity: expect.any(String) });
});

it.skipIf(process.platform !== "linux")("recovers Pi argv and process HOME from a live PID when Herdr omits argv", async () => {
  const processHome = join(root, "pane-home");
  const profile = join(processHome, "custom-agent");
  const profileStore = join(profile, "sessions");
  mkdirSync(profileStore, { recursive: true });
  const target = join(profileStore, "pid-profile.jsonl");
  writeFileSync(target, "{\"type\":\"session\"}\n");
  const bridgeHome = join(root, "bridge-home");
  const child = Bun.spawn(["/bin/bash", "-c", "exec -a pi /bin/sleep 30"], {
    cwd: root,
    env: { HOME: processHome, PATH: "/usr/bin:/bin", PI_CODING_AGENT_DIR: "~/custom-agent" },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    for (const deadline = Date.now() + 2_000;;) {
      try {
        if (readFileSync(`/proc/${child.pid}/cmdline`, "utf8").startsWith(`pi\0`)) break;
      } catch { }
      if (Date.now() > deadline) throw new Error("isolated Pi-shaped process did not exec");
      await Bun.sleep(10);
    }
    const result = await piTranscriptPath("pane", join(bridgeHome, ".pi", "agent", "sessions"), {
      agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: target } } as never,
      processes: [{ pid: child.pid, name: "pi", cwd: root }],
      home: bridgeHome,
    });
    expect(result).toEqual({ path: target, agentDir: profile, identity: expect.any(String) });
  } finally {
    child.kill();
    await child.exited;
  }
});

it("keeps a custom Pi profile scoped to its current process and canonical store", async () => {
  const profile = join(root, "profile-identity");
  const profileStore = join(profile, "sessions");
  mkdirSync(profileStore, { recursive: true });
  const target = join(profileStore, "active.jsonl");
  writeFileSync(target, "{\"type\":\"session\"}\n");
  const agent = { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: target } } as never;
  const processes = [{ pid: 781, argv: ["pi"] }];
  const environOf = () => [`PI_CODING_AGENT_DIR=${profile}`];
  try {
    const defaultSession = session("default-profile");
    const defaultAgent = { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: defaultSession } } as never;
    // an environment that cannot be read names no profile: the bridge's store here is not its agent dir's own
    expect(await piTranscriptPath("pane", store, { agent: defaultAgent, processes, environOf: () => null, home: root })).toEqual({ path: defaultSession, agentDir: null, identity: expect.any(String) });
    expect(await piTranscriptPath("pane", undefined, { agent, processes, environOf, home: root })).toEqual({ path: target, agentDir: profile, identity: expect.any(String) });
    const ompAgent = { agent: "pi", agent_session: { agent: "omp", source: "herdr:omp", kind: "path", value: target } } as never;
    expect(await piTranscriptPath("pane", undefined, { agent: ompAgent, processes, environOf, home: root })).toBeNull();
    expect(await piTranscriptPath("pane", undefined, { agent, processes: [{ pid: 782, argv: ["shell"] }], environOf, home: root })).toBeNull();
    // If process environment cannot be read, the reported custom path does not match the default store.
    expect(await piTranscriptPath("pane", join(root, "default-sessions"), { agent, processes, environOf: () => null, home: root })).toBeNull();
    const otherProfile = join(root, "other-profile");
    mkdirSync(join(otherProfile, "sessions"), { recursive: true });
    expect(await piTranscriptPath("pane", undefined, {
      agent,
      processes: [{ pid: 781, argv: ["pi"] }, { pid: 783, argv: ["pi"] }],
      environOf: (pid) => [`PI_CODING_AGENT_DIR=${pid === 781 ? profile : otherProfile}`],
      home: root,
    })).toBeNull();
    // one store named by both, but two agent directories: neither one's catalogs are the pane's
    expect(await piTranscriptPath("pane", undefined, {
      agent,
      processes: [{ pid: 781, argv: ["pi"] }, { pid: 783, argv: ["pi"] }],
      environOf: (pid) => [`PI_CODING_AGENT_SESSION_DIR=${profileStore}`, `PI_CODING_AGENT_DIR=${pid === 781 ? profile : otherProfile}`],
      home: root,
    })).toEqual({ path: target, agentDir: null, identity: expect.any(String) });
    // pi decodes a file: URL, and one directory named through a link is still one directory
    expect(await piTranscriptPath("pane", undefined, {
      agent, processes, environOf: () => [`PI_CODING_AGENT_DIR=${pathToFileURL(profile).href}`], home: root,
    })).toEqual({ path: target, agentDir: profile, identity: expect.any(String) });
    if (canSymlink) {
      const alias = join(root, "profile-alias");
      symlinkSync(profile, alias, "dir");
      try {
        expect(await piTranscriptPath("pane", undefined, {
          agent,
          processes: [{ pid: 781, argv: ["pi"] }, { pid: 783, argv: ["pi"] }],
          environOf: (pid) => [`PI_CODING_AGENT_DIR=${pid === 781 ? profile : alias}`],
          home: root,
        })).toEqual({ path: target, agentDir: profile, identity: expect.any(String) });
      } finally { rmSync(alias, { force: true }); }
    }
    if (canSymlink) {
      const escaped = join(root, "escaped.jsonl");
      writeFileSync(escaped, "{\"type\":\"session\"}\n");
      const link = join(profileStore, "escape.jsonl");
      symlinkSync(escaped, link);
      const escapedAgent = { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: link } } as never;
      expect(await piTranscriptPath("pane", undefined, { agent: escapedAgent, processes, environOf, home: root })).toBeNull();
    }
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

it("keeps a fresh unmessaged session inside the pane's custom profile", async () => {
  const profileStore = join(root, "fresh-profile", "sessions");
  mkdirSync(profileStore, { recursive: true });
  const reported = join(profileStore, "--fresh-project--", "fresh.jsonl");
  const result = await piTranscriptPath("fresh-pi-pane", join(root, "bridge-default", "sessions"), {
    agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: reported } } as never,
    processes: [{ pid: 799, argv: ["/usr/bin/pi"] }],
    environOf: () => [`PI_CODING_AGENT_DIR=${dirname(profileStore)}`],
    home: root,
  });
  expect(result).toEqual({ unwritten: { id: "fresh", path: join(realpathSync(profileStore), "--fresh-project--", "fresh.jsonl") } });
});

it("does not fall back to the bridge default when the pane names a custom Pi profile", async () => {
  const defaultStore = join(root, "stale-default", "sessions");
  mkdirSync(defaultStore, { recursive: true });
  const stale = join(defaultStore, "stale.jsonl");
  writeFileSync(stale, "{\"type\":\"session\"}\n");
  const result = await piTranscriptPath("pane", defaultStore, {
    agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: stale } } as never,
    processes: [{ pid: 800, argv: ["/usr/bin/pi"] }],
    environOf: () => [`PI_CODING_AGENT_DIR=${join(root, "different-profile")}`],
    home: root,
  });
  expect(result).toBeNull();
});

it("keeps native default-store reports when process argv is unavailable", async () => {
  const target = session("unverified-process");
  const customStore = join(root, "unverified-profile", "sessions");
  mkdirSync(customStore, { recursive: true });
  const customTarget = join(customStore, "custom.jsonl");
  writeFileSync(customTarget, "{\"type\":\"session\"}\n");
  const processInfo = [{ pid: 802, name: "pi" }];
  const reported = (value: string) => ({ agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value } }) as never;
  const options = { processes: processInfo, argvOf: () => null, environOf: () => null, home: root };
  // the store is shared (PI_CODING_AGENT_SESSION_DIR), not the one inside the bridge's agent dir: no catalog is the pane's
  expect(await piTranscriptPath("pane", store, {
    ...options, agent: reported(target),
  })).toEqual({ path: target, agentDir: null, identity: expect.any(String) });
  expect(await piTranscriptPath("pane", store, {
    ...options, agent: reported(customTarget),
  })).toBeNull();
  const old = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = root;
  try {
    expect(await piTranscriptPath("pane", store, { ...options, agent: reported(target) })).toEqual({ path: target, agentDir: piAgentDir(), identity: expect.any(String) });
    expect(await piTranscriptPath("pane", store, { ...options, processes: [], agent: reported(target) })).toEqual({ path: target, agentDir: root, identity: expect.any(String) });
  } finally {
    if (old === undefined) delete process.env["PI_CODING_AGENT_DIR"]; else process.env["PI_CODING_AGENT_DIR"] = old;
  }
});

it("rejects Pi session-dir command-line overrides it cannot verify", async () => {
  const target = session("cli-session-dir");
  expect(await piTranscriptPath("pane", store, {
    agent: { agent: "pi", agent_session: { agent: "pi", source: "herdr:pi", kind: "path", value: target } } as never,
    processes: [{ pid: 801, argv: ["/usr/bin/pi", "--session-dir", join(root, "other") ] }],
    environOf: () => [],
    home: root,
  })).toBeNull();
});

it.skipIf(process.platform === "win32")("offers the commands pi's extensions registered, as the pane's one pi names them through the web UI's extension (#1448)", async () => {
  // short: a unix socket path must fit in about 100 bytes, and macOS's temp dir is long
  const profile = mkdtempSync(join(tmpdir(), "pic-"));
  const sockets = join(profile, "herdr-web-ui-ask");
  mkdirSync(sockets, { recursive: true, mode: 0o700 });
  let status = 200;
  let answer: unknown = { version: 1, pid: 840, commands: [
    { name: "team", description: "Start specialist agents", scope: "user", origin: "top-level" },
    { name: "ponytail", scope: "user", origin: "package" },
    { name: "deploy", description: "Deploy", scope: "project", origin: "top-level" },
    // pi's own command wins when typed, and its menu leaves it out; a name only like one stays
    { name: "model", scope: "user", origin: "top-level" },
    { name: "model:2", scope: "user", origin: "top-level" },
    { name: "", scope: "user", origin: "top-level" },
    { name: "two words", scope: "user", origin: "top-level" },
  ] };
  const server = Bun.serve({ unix: join(sockets, "840.sock"), fetch: (request) => new URL(request.url).pathname === "/v1/commands" ? Response.json(answer, { status }) : new Response(null, { status: 404 }) });
  const processes = [{ pid: 840, argv: ["/usr/bin/pi"] }];
  const options = { processes, processesAfter: async () => processes, environOf: () => [`PI_CODING_AGENT_DIR=${profile}`], home: root };
  try {
    expect(await piExtensionCommands("pane", undefined, options)).toEqual([
      { name: "team", description: "Start specialist agents", source: "user" },
      { name: "ponytail", description: "", source: "plugin" },
      { name: "deploy", description: "Deploy", source: "project" },
      { name: "model:2", description: "", source: "user" },
    ]);
    // a pi that left the front while its extension answered no longer speaks for the pane
    expect(await piExtensionCommands("pane", undefined, { ...options, processesAfter: async () => [{ pid: 843, argv: ["bash"] }] })).toBeNull();
    // or another pi joined it in front
    expect(await piExtensionCommands("pane", undefined, { ...options, processesAfter: async () => [...processes, { pid: 844, argv: ["/usr/bin/pi"] }] })).toBeNull();
    // pi could not say, or the socket answers for another pid
    answer = { version: 1, pid: 840, commands: null };
    expect(await piExtensionCommands("pane", undefined, options)).toBeNull();
    answer = { version: 1, pid: 841, commands: [] };
    expect(await piExtensionCommands("pane", undefined, options)).toBeNull();
    // an extension installed before #1448 has no such route
    status = 404;
    expect(await piExtensionCommands("pane", undefined, options)).toBeNull();
    status = 200;
    answer = { version: 1, pid: 840, commands: [] };
    expect(await piExtensionCommands("pane", undefined, options)).toEqual([]);
    // a process in front that is not pi, and a second pi beside it, are not asked
    expect(await piExtensionCommands("pane", undefined, { ...options, processes: [{ pid: 840, argv: ["bash"] }] })).toBeNull();
    expect(await piExtensionCommands("pane", undefined, { ...options, processes: [{ pid: 840, argv: ["/usr/bin/pi"] }, { pid: 842, argv: ["/usr/bin/pi"] }] })).toBeNull();
  } finally {
    await server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
});

it("names the agent directory of a pane's pi whatever its session store, for the web UI's extension", async () => {
  const profile = join(root, "custom-pi-profile");
  // a --session-dir the bridge cannot follow says nothing about where pi runs its extensions
  for (const argv of [["/usr/bin/pi", "--session-dir", "/elsewhere"], ["/usr/bin/pi", "--session-dir=/elsewhere"], ["/usr/bin/pi"]]) {
    const found = await piPaneAgentDirs("pane", { processes: [{ pid: 901, argv }], environOf: () => [`PI_CODING_AGENT_DIR=${profile}`], home: root });
    expect(found.pids).toEqual([901]);
    expect(found.agentDirs).toContain(profile);
    expect(found.agentDirs).toContain(piAgentDir());
  }
});

it.skipIf(process.platform === "win32")("reads the session the pane's pi names through the web UI's extension when herdr reports none", async () => {
  // herdr-core runs no herdr pi integration, so agent.get names the agent and no session (#2935)
  const profile = join(root, "core-profile");
  const sessions = join(profile, "sessions", "--core-project--");
  mkdirSync(sessions, { recursive: true });
  const written = join(sessions, "2026-11-05T09-00-00-000Z_0b0e7f1c-3c62-4a51-9b5e-5d1f2a3b4c5d.jsonl");
  writeFileSync(written, "{\"type\":\"session\"}\n");
  const sockets = join(profile, "herdr-web-ui-ask");
  mkdirSync(sockets, { mode: 0o700 });
  let state: { pid: number; sessionFile: string | null } = { pid: 830, sessionFile: written };
  const server = Bun.serve({ unix: join(sockets, "830.sock"), fetch: () => Response.json({ version: 1, flows: [], openCalls: [], ...state }) });
  const agent = { agent: "pi", agent_status: "idle" } as never;
  const processes = [{ pid: 830, argv: ["/usr/bin/pi"] }];
  const options = { agent, processes, processesAfter: async () => processes, environOf: () => [`PI_CODING_AGENT_DIR=${profile}`], home: root };
  try {
    expect(await piTranscriptPath("core-pane", undefined, options)).toEqual({ path: written, agentDir: profile, identity: expect.any(String) });
    // a session pi has named and not written yet
    const fresh = join(sessions, "2026-11-05T09-01-00-000Z_1b0e7f1c-3c62-4a51-9b5e-5d1f2a3b4c5d.jsonl");
    state = { pid: 830, sessionFile: fresh };
    expect(await piTranscriptPath("core-pane", undefined, options)).toEqual({ unwritten: { id: basename(fresh, ".jsonl"), path: join(realpathSync(sessions), basename(fresh)) } });
    // a file outside pi's store, a socket that answers for another pid, or pi without a session: Terminal
    const outside = join(root, "outside-store.jsonl");
    writeFileSync(outside, "{}\n");
    state = { pid: 830, sessionFile: outside };
    expect(await piTranscriptPath("core-pane", undefined, options)).toBeNull();
    state = { pid: 831, sessionFile: written };
    expect(await piTranscriptPath("core-pane", undefined, options)).toBeNull();
    state = { pid: 830, sessionFile: null };
    expect(await piTranscriptPath("core-pane", undefined, options)).toBeNull();
    // a pi that left the front while its extension answered no longer speaks for the pane
    state = { pid: 830, sessionFile: written };
    expect(await piTranscriptPath("core-pane", undefined, { ...options, processesAfter: async () => [{ pid: 833, argv: ["bash"] }] })).toBeNull();
    expect(await piTranscriptPath("core-pane", undefined, { ...options, processesAfter: async () => null })).toBeNull();
    const switched = join(dirname(written), "2026-11-17T14-06-52-131Z_01a1e9d4-fce1-73a2-82b6-11a1ac60faa9.jsonl");
    writeFileSync(switched, "{\"type\":\"session\"}\n");
    expect(await piTranscriptPath("core-pane", undefined, {
      ...options, confirmExtensionSession: true,
      processesAfter: async () => {
        state = { pid: 830, sessionFile: switched };
        return options.processes;
      },
    })).toBeNull();
    // a process in front that is not pi, and a second pi beside it, are not asked
    expect(await piTranscriptPath("core-pane", undefined, { ...options, processes: [{ pid: 830, argv: ["bash"] }] })).toBeNull();
    expect(await piTranscriptPath("core-pane", undefined, { ...options, processes: [{ pid: 830, argv: ["/usr/bin/pi"] }, { pid: 832, argv: ["/usr/bin/pi"] }] })).toBeNull();
  } finally {
    await server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("reads the pi a pane herdr labels gentle-shell runs, from gentle-shell's own home (#4198)", async () => {
  // herdr 0.9.5's answers for a gentle-shell pane: its own agent name, no session (herdr drops a custom source's)
  const recorded = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "herdr-0.9.5-gentle-shell-pane.json"), "utf8"));
  const agent = recorded["agent.get"].agent;
  const processes = recorded["pane.process_info"].process_info.foreground_processes;
  const pid: number = processes[0].pid;
  const profile = join(root, "gentle-shell-home");
  const sessions = join(profile, "sessions", "--home-user-project--");
  mkdirSync(sessions, { recursive: true });
  const written = join(sessions, "2026-11-17T14-06-52-131Z_01a1e9d4-fce1-73a2-82b6-11a1ac60faa8.jsonl");
  writeFileSync(written, "{\"type\":\"session\"}\n");
  const sockets = join(profile, "herdr-web-ui-ask");
  mkdirSync(sockets, { mode: 0o700 });
  const server = Bun.serve({ unix: join(sockets, `${pid}.sock`), fetch: () => Response.json({ version: 1, flows: [], openCalls: [], pid, sessionFile: written }) });
  const options = { agent, processes, processesAfter: async () => processes, environOf: () => [`PI_CODING_AGENT_DIR=${profile}`], home: root };
  try {
    expect(await piTranscriptPath(agent.pane_id, undefined, options)).toEqual({ path: written, agentDir: profile, identity: expect.any(String) });
    // the name alone is no pi: a process in front that is not pi keeps the terminal
    expect(await piTranscriptPath(agent.pane_id, undefined, { ...options, processes: [{ pid, argv: ["node", "/home/user/server.js"] }] })).toBeNull();
  } finally {
    await server.stop(true);
    rmSync(profile, { recursive: true, force: true });
  }
});
