import { afterAll, afterEach, expect, it, spyOn } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationSearchResponse } from "../shared/conversation-search.ts";
import { conversationTurnAnchor, searchPattern } from "../shared/conversation-search.ts";
import * as conversation from "./conversation.ts";
import { forgetTranscriptState, HistoryChanged, MAX_PAGE_PROMPTS, transcriptPage, type ConversationPage, type RecognizedConversation } from "./conversation.ts";
import { SEARCH_MATCHES, SEARCH_PAGES, searchConversationPages } from "./conversation-search.ts";
import { handlePaneRequest } from "./pane-routes.ts";

const dir = mkdtempSync(join(tmpdir(), "conversation-search-"));
afterAll(() => { forgetTranscriptState(); rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { spyOn(conversation, "paneConversation").mockRestore(); });

function claudeSession(name: string, prompts: number, text: (n: number) => { prompt: string; thinking: string; output: string; answer: string }): string {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, "");
  let ts = Date.parse("2026-10-01T00:00:00Z");
  const at = () => new Date(ts += 1000).toISOString();
  for (let n = 0; n < prompts; n++) {
    const { prompt, thinking, output, answer } = text(n);
    appendFileSync(path, [
      { type: "user", timestamp: at(), uuid: `u${n}`, message: { role: "user", content: prompt } },
      { type: "assistant", timestamp: at(), uuid: `t${n}`, message: { role: "assistant", content: [{ type: "thinking", thinking }] } },
      { type: "assistant", timestamp: at(), uuid: `c${n}`, message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${n}`, name: "Bash", input: { command: "make" } }] } },
      { type: "user", timestamp: at(), uuid: `r${n}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${n}`, content: output }] } },
      { type: "assistant", timestamp: at(), uuid: `a${n}`, message: { role: "assistant", content: [{ type: "text", text: answer }] } },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  return path;
}

const reader = (path: string) => (page: ConversationPage) => Promise.resolve(transcriptPage("claude-transcript", path, page));

it("finds the user's words and the agent's answers on every page, never a tool's output or thinking", async () => {
  const path = claudeSession("pages", 120, (n) => ({
    prompt: n === 3 ? "Why does the  Deploy\nscript fail?" : `prompt ${n}`,
    thinking: "the deploy script, thought about",
    output: "deploy script printed this",
    answer: n === 100 ? "The deploy script needs its token. It was rotated last week, so the old one in the environment is refused." : `answer ${n}`,
  }));
  const pattern = searchPattern("deploy script")!;
  const found: ConversationSearchResponse["matches"] = [];
  let answer = await searchConversationPages(reader(path), pattern, {});
  found.push(...answer.matches);
  for (let asked = 1; answer.cursor !== null; asked++) {
    expect(asked).toBeLessThan(10);
    answer = await searchConversationPages(reader(path), pattern, { before: answer.cursor, historyId: answer.history_id });
    found.push(...answer.matches);
  }
  expect(found.map(({ role, before, match, after }) => ({ role, before, match, after }))).toEqual([
    { role: "assistant", before: "The ", match: "deploy script", after: " needs its token. It was rotated last week, so the old one in the environment is refused." },
    { role: "user", before: "Why does the ", match: "Deploy script", after: " fail?" },
  ]);
  const chatPages = [transcriptPage("claude-transcript", path, { prompts: 10 })];
  while (chatPages.at(-1)!.cursor !== null) chatPages.push(transcriptPage("claude-transcript", path, { before: chatPages.at(-1)!.cursor!, prompts: 10 }));
  const anchors = chatPages.flatMap((page) => page.turns.map(conversationTurnAnchor));
  expect(found.map((match) => anchors.filter((anchor) => anchor === match.turn).length)).toEqual([1, 1]);
});

it("stops an answer at its page budget and goes on from where it stopped", async () => {
  const pages: string[] = [];
  const read = (page: ConversationPage): Promise<RecognizedConversation> => {
    pages.push(page.before ?? "newest");
    expect(page.prompts).toBe(MAX_PAGE_PROMPTS);
    const at = page.before === undefined ? 1000 : Number(page.before);
    return Promise.resolve({ source: "claude-transcript", turns: [{ role: "user", ts: String(at), parts: [{ kind: "text", text: `note ${at}` }] }], metadata: { model: null, reasoning_effort: null }, cursor: at > 1 ? String(at - 1) : null, history_id: "h", version: "v" });
  };
  const answer = await searchConversationPages(read, searchPattern("note")!, {});
  expect(pages.length).toBe(SEARCH_PAGES);
  expect(answer.matches.length).toBe(SEARCH_PAGES);
  expect(answer.cursor).toBe(String(1000 - SEARCH_PAGES));
  expect(answer.history_id).toBe("h");
  let clock = 0;
  const many = (page: ConversationPage): Promise<RecognizedConversation> => read(page).then((answer) => ({ ...answer, turns: Array.from({ length: SEARCH_MATCHES }, (_, n) => ({ ...answer.turns[0]!, ts: `${answer.turns[0]!.ts}.${n}` })) }));
  expect((await searchConversationPages(many, searchPattern("note")!, {})).matches.length).toBe(SEARCH_MATCHES);
  const slow = (page: ConversationPage): Promise<RecognizedConversation> => { clock += 600; return read(page); };
  expect((await searchConversationPages(slow, searchPattern("note")!, {}, () => clock)).matches.length).toBe(2);
});

it("refuses a page from another history than the one it began on", async () => {
  const read = (): Promise<RecognizedConversation> => Promise.resolve({ source: "claude-transcript", turns: [], metadata: { model: null, reasoning_effort: null }, cursor: "1", history_id: "new", version: "v" });
  await expect(searchConversationPages(read, searchPattern("x")!, { before: "5", historyId: "old" })).rejects.toBeInstanceOf(HistoryChanged);
});

it("refuses a conversation gone after a page of it was searched, and says a pane with none has none", async () => {
  const page: RecognizedConversation = { source: "claude-transcript", turns: [{ role: "user", ts: "1", parts: [{ kind: "text", text: "x" }] }], metadata: { model: null, reasoning_effort: null }, cursor: "1", history_id: "h", version: "v" };
  let reads = 0;
  const gone = (): Promise<RecognizedConversation> => reads++ === 0 ? Promise.resolve(page) : Promise.reject(new conversation.ConversationUnavailable("no_session_path"));
  await expect(searchConversationPages(gone, searchPattern("x")!, {})).rejects.toBeInstanceOf(HistoryChanged);
  const none = (): Promise<RecognizedConversation> => Promise.reject(new conversation.ConversationUnavailable("no_session_path"));
  await expect(searchConversationPages(none, searchPattern("x")!, {})).rejects.toBeInstanceOf(conversation.ConversationUnavailable);
});

const ask = (query: string) => {
  const url = new URL(`http://x/api/pane/conversation/search?pane_id=w1:p1&${query}`);
  return handlePaneRequest(new Request(url), url, "/api/pane/conversation/search", {});
};

it("answers the route from the pane's pages, and refuses a query it cannot search", async () => {
  const read = spyOn(conversation, "paneConversation").mockResolvedValue({
    source: "codex-transcript", turns: [
      { role: "user", ts: "2026-10-01T00:00:00Z", parts: [{ kind: "text", text: "rename the flag" }] },
      { role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [{ kind: "text", text: "Renaming the flag now.", phase: "commentary" }, { kind: "text", text: "The flag is renamed.", phase: "final_answer" }] },
    ], metadata: { model: null, reasoning_effort: null }, cursor: null, history_id: "h1", version: "v",
  });
  const response = (await ask("q=flag"))!;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as ConversationSearchResponse;
  expect(body).toEqual({ history_id: "h1", cursor: null, matches: [
    { turn: "assistant|2026-10-01T00:00:01Z|text|Renaming the flag now.", role: "assistant", ts: "2026-10-01T00:00:01Z", text_digest: expect.any(String), before: "The ", match: "flag", after: " is renamed." },
    { turn: "user|2026-10-01T00:00:00Z|text|rename the flag", role: "user", ts: "2026-10-01T00:00:00Z", text_digest: expect.any(String), before: "rename the ", match: "flag", after: "" },
  ] });
  expect(read.mock.calls[0]?.[0]).toBe("w1:p1");
  expect(read.mock.calls[0]?.[2]).toEqual({ prompts: MAX_PAGE_PROMPTS });
  for (const query of ["q=", "q=%20%20", `q=${"x".repeat(201)}`, "other=1"]) expect((await ask(query))!.status).toBe(400);
});

it("answers a changed history 409, a pane with no store no matches, and a pending read 503", async () => {
  const read = spyOn(conversation, "paneConversation").mockRejectedValueOnce(new conversation.HistoryChanged());
  expect((await ask("q=flag&before=c1&history_id=h1"))!.status).toBe(409);
  expect(read.mock.calls[0]?.[2]).toEqual({ before: "c1", prompts: MAX_PAGE_PROMPTS });
  read.mockRejectedValueOnce(new conversation.ConversationUnavailable("no_session_path"));
  const none = (await ask("q=flag"))!;
  expect(none.status).toBe(200);
  expect(await none.json()).toEqual({ matches: [], cursor: null });
  read.mockRejectedValueOnce(new conversation.ConversationReadPending());
  expect((await ask("q=flag"))!.status).toBe(503);
});

it("answers 409 when a search's next page finds no conversation to read any more", async () => {
  spyOn(conversation, "paneConversation").mockRejectedValueOnce(new conversation.ConversationUnavailable("no_session_path"));
  const gone = (await ask("q=flag&before=c1&history_id=h1"))!;
  expect(gone.status).toBe(409);
  expect((await gone.json() as { error: { code: string } }).error.code).toBe("history_changed");
});
