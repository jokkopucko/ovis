import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as conversation from "./conversation.ts";
import { gjcAskPrompt, withGjcFallback } from "./gjc-ask.ts";
import { gjcCustomEditorMatches, parseFallbackPrompt } from "./dialogs/fallback.ts";
import { parsedByPublicPrompt } from "./dialogs/shared.ts";
import * as herdr from "./herdr/client.ts";
import { OmoAskReader, ompAsksAfter, type OmoAsks } from "./omo-ask.ts";
import { answerKeys, handlePromptRequest } from "./prompt.ts";

/**
 * gjc 0.22.0 in Ovis (200 columns): the screen recorded while its ask selector was open, and the session's call for
 * it, reduced from the recorded session file to the user message and the assistant message that holds the call
 * (server/fixtures/gjc-ask-0.22.0-*).
 */
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/gjc-ask-0.22.0-${name}`, import.meta.url));
const SCREEN = readFileSync(fixture("single.txt"), "utf8");
const open = (): OmoAsks => new OmoAskReader(ompAsksAfter).read(fixture("open.jsonl"));
const card = (screen = SCREEN) => parseFallbackPrompt("gjc", screen);

type Asked = { questions: { id?: string; question: string; options: { label: string }[]; recommended?: number; multi?: boolean }[] };
const withArgs = (asks: OmoAsks, change: (args: Asked) => void): OmoAsks => asks.map((call) => {
  const args = structuredClone(call.args) as Asked;
  change(args);
  return { ...call, args };
});
const QUESTION = (open()[0]!.args as Asked).questions[0]!.question;
const FIRST_ROW = "Fixture capture for the GJC ask card. This first paragraph mentions inline code and bold words.";
const LAST_ROW = "Which option looks right? (캡처용, 15초 두고 아무거나 골라줘)";

describe("gjc ask cards in the agent's own Markdown", () => {
  it("reads the recorded selector as the generic card does: the title's last row and a body", () => {
    const read = card();
    expect(read.question).toBe(LAST_ROW);
    expect(read.body).toBe(`${FIRST_ROW}\nA second line in the same paragraph.\nA second paragraph with a list:\n- first item\n- second item`);
    expect(read.text_format).toBeUndefined();
  });

  it("gives the open call's whole question and labels to the selector it draws, keeping its id and keys", () => {
    const read = card();
    const rich = gjcAskPrompt(read, open(), "/sess/one.jsonl");
    expect(rich).toMatchObject({
      id: read.id, kind: "menu", question: QUESTION, body: null, text_format: "markdown", custom_option_index: 3, multi_select: false,
      options: [
        { label: "Keep `local` socket", description: null, recommended: true },
        { label: "Remote relay", description: null },
        { label: "Neither", description: null },
        { label: "Other (type your own)", description: null },
        { label: "Esc", description: null },
      ],
    });
    expect(parsedByPublicPrompt.get(rich)?.gjcCall).toBeTruthy();
    const otherCall = open().map((call) => ({ ...call, id: "call_replacement" }));
    const richOther = gjcAskPrompt(read, otherCall, "/sess/one.jsonl");
    expect(parsedByPublicPrompt.get(richOther)?.gjcCall).not.toBe(parsedByPublicPrompt.get(rich)?.gjcCall);
    for (const option_index of [0, 1, 2, 4]) expect(answerKeys(rich, { option_index })).toEqual(answerKeys(read, { option_index }));
    expect(answerKeys(rich, { custom_text: "mine" })).toEqual(answerKeys(read, { custom_text: "mine" }));
  });

  it("keeps the selector's custom-editor identity, so a typed answer is still checked against its editor", () => {
    const read = card();
    const rich = gjcAskPrompt(read, open());
    const editor = SCREEN.replace(/│❯ Keep/u, "│  Keep").replace("│  Other (type your own)", "│❯ Other (type your own)")
      .replace(/ ↑\/↓ select .*\n/u, " > mine\n\n enter submit  esc back to options  ctrl+g external editor  PgUp/PgDn: question · Wheel: transcript\n");
    expect(gjcCustomEditorMatches(editor, parsedByPublicPrompt.get(read)!, "mine")).toBe(true);
    expect(gjcCustomEditorMatches(editor, parsedByPublicPrompt.get(rich)!, "mine")).toBe(true);
  });

  it("reads a question gjc wrapped at a narrow pane, including mid-word CJK wraps", () => {
    const narrow = SCREEN.replace(` ${FIRST_ROW}`, " Fixture capture for the GJC ask card. This first\n paragraph mentions inline code and bold words.");
    expect(gjcAskPrompt(card(narrow), open()).question).toBe(QUESTION);

    const cjkQuestion = "**接続方法をどれにするか教えてください？**";
    const cjkScreen = [
      "─".repeat(25),
      "",
      " 接続方法をどれにするか",
      " 教えてください？",
      "",
      "─".repeat(25),
      "│❯ Keep (Recommended)   │",
      "│  Remote relay         │",
      "│  Neither              │",
      "│  Other (type your own)│",
      "─".repeat(25),
      "",
      " up/down navigate",
      " enter select esc cancel",
      "",
      "─".repeat(25),
    ].join("\n");
    const cjkCalls = withArgs(open(), (args) => {
      args.questions[0]!.question = cjkQuestion;
      args.questions[0]!.options[0]!.label = "Keep";
    });
    expect(gjcAskPrompt(card(cjkScreen), cjkCalls)).toMatchObject({ question: cjkQuestion, body: null, text_format: "markdown" });

    // A short line break in a wide pane must never merge two words without a space
    const shortLineBreak = SCREEN.replace(` ${FIRST_ROW}`, " Fixture capture for the GJC\n ask card. This first paragraph mentions inline code and bold words.");
    const mergedCalls = withArgs(open(), (args) => {
      args.questions[0]!.question = QUESTION.replace("GJC ask", "GJCask");
    });
    expect(gjcAskPrompt(card(shortLineBreak), mergedCalls).text_format).toBeUndefined();

    // Six ZWJ emoji clusters occupy 12 cells, not 24 code-point cells: in a 25-column frame they must not tight-join the next row
    const emojiRow = "👩‍💻".repeat(6);
    const emojiScreen = cjkScreen.replace(" 接続方法をどれにするか", ` ${emojiRow}`).replace(" 教えてください？", " 続ける？");
    const tightEmojiCalls = withArgs(open(), (args) => {
      args.questions[0]!.question = `${emojiRow}続ける？`;
      args.questions[0]!.options[0]!.label = "Keep";
    });
    expect(gjcAskPrompt(card(emojiScreen), tightEmojiCalls).text_format).toBeUndefined();
    const spacedEmojiCalls = withArgs(open(), (args) => {
      args.questions[0]!.question = `${emojiRow} 続ける？`;
      args.questions[0]!.options[0]!.label = "Keep";
    });
    expect(gjcAskPrompt(card(emojiScreen), spacedEmojiCalls).text_format).toBe("markdown");

    // Keycap emoji clusters (2 cells each) wrap cleanly in a 25-column frame too
    const keycapRow = "1️⃣".repeat(11);
    const keycapScreen = cjkScreen.replace(" 接続方法をどれにするか", ` ${keycapRow}`).replace(" 教えてください？", " 次？");
    const keycapCalls = withArgs(open(), (args) => {
      args.questions[0]!.question = `${keycapRow}次？`;
      args.questions[0]!.options[0]!.label = "Keep";
    });
    expect(gjcAskPrompt(card(keycapScreen), keycapCalls).text_format).toBe("markdown");
  });

  it("does not bind a truncated title (▼ more or ▲ more), since another call can share its visible prefix", () => {
    const rows = SCREEN.split("\n");
    const top = rows.indexOf(` ${FIRST_ROW}`);
    const last = rows.indexOf(` ${LAST_ROW}`);
    const cut = [...rows.slice(0, top + 2), " ▼ more", ...rows.slice(last + 1)].join("\n");
    expect(gjcAskPrompt(card(cut), open()).text_format).toBeUndefined();
    const scrolled = [...rows.slice(0, top), " ▲ more", ...rows.slice(top + 3, last + 1), ...rows.slice(last + 1)].join("\n");
    expect(gjcAskPrompt(card(scrolled), open()).text_format).toBeUndefined();
  });

  it("preserves a non-recommended option's literal (Recommended) suffix without marking it recommended", () => {
    const literalScreen = SCREEN
      .replace("│❯ Keep local socket (Recommended)", "│❯ Keep local socket (Recommended)")
      .replace("│  Remote relay", "│  Remote relay (Recommended)");
    const calls = withArgs(open(), (args) => {
      args.questions[0]!.options[0]!.label = "Keep `local` socket (Recommended)";
      args.questions[0]!.recommended = 1;
    });
    const rich = gjcAskPrompt(card(literalScreen), calls);
    expect(rich.text_format).toBe("markdown");
    expect(rich.options[0]).toEqual({ label: "Keep `local` socket (Recommended)", description: null });
    expect(rich.options[1]).toEqual({ label: "Remote relay", description: null, recommended: true });
  });

  it("reads one of a call's several questions by its (n/m) and the strip's keys", () => {
    const second = SCREEN.replace(LAST_ROW, `${LAST_ROW} (2/2)`).replace("↑/↓ select  enter  esc", "↑/↓ select  enter  ←/→ question  esc");
    const two = withArgs(open(), (args) => {
      args.questions.unshift({ id: "first", question: "Which region?", options: [{ label: "Seoul" }, { label: "Tokyo" }] });
    });
    expect(gjcAskPrompt(card(second), two).question).toBe(`${QUESTION} (2/2)`);
    expect(gjcAskPrompt(card(SCREEN), two).text_format).toBeUndefined();
  });

  it("leaves the card as read when no single open call provably draws the selector", () => {
    const read = card();
    const unproved: [string, OmoAsks][] = [
      ["no call", []],
      ["two calls", [...open(), { ...open()[0]!, id: "other" }]],
      ["a letter apart", withArgs(open(), (args) => { args.questions[0]!.question = QUESTION.replace("bold", "bald"); })],
      ["a mark apart", withArgs(open(), (args) => { args.questions[0]!.question = QUESTION.replace("**bold**", "**bold**!"); })],
      ["another label", withArgs(open(), (args) => { args.questions[0]!.options[1]!.label = "Remote relays"; })],
      ["another order", withArgs(open(), (args) => { args.questions[0]!.options.reverse(); })],
      ["one more option", withArgs(open(), (args) => { args.questions[0]!.options.push({ label: "Later" }); })],
      ["another recommendation", withArgs(open(), (args) => { args.questions[0]!.recommended = 1; })],
      ["no recommendation", withArgs(open(), (args) => { delete args.questions[0]!.recommended; })],
      ["multiple choice", withArgs(open(), (args) => { args.questions[0]!.multi = true; })],
      ["a numbered progress it does not draw", withArgs(open(), (args) => { args.questions.push({ question: "Next?", options: [{ label: "Yes" }] }); })],
    ];
    for (const [name, calls] of unproved) expect(gjcAskPrompt(read, calls), name).toBe(read);
  });

  it("draws no recommendation on a question of one option, as gjc does not", () => {
    const one = SCREEN.replace("│❯ Keep local socket (Recommended)", "│❯ Keep local socket").replace(/│  Remote relay.*\n│  Neither.*\n/u, "");
    const calls = withArgs(open(), (args) => { args.questions[0]!.options = [{ label: "Keep `local` socket" }]; });
    expect(card(one).options.map((option) => option.label)).toEqual(["Keep local socket", "Other (type your own)", "Esc"]);
    expect(gjcAskPrompt(card(one), calls).options[0]!.label).toBe("Keep `local` socket");
    expect(gjcAskPrompt(card(one.replace("│❯ Keep local socket", "│❯ Keep local socket (Recommended)")), calls).text_format).toBeUndefined();
  });

  it("leaves the card as read for labels the card would show alike", () => {
    const twins = SCREEN.replace("│  Remote relay", "│  Keep local socket").replace("│❯ Keep local socket (Recommended)", "│❯ Keep local socket");
    const calls = withArgs(open(), (args) => {
      args.questions[0]!.options[0]!.label = "Keep `local` socket";
      args.questions[0]!.options[1]!.label = "Keep *local* socket";
      delete args.questions[0]!.recommended;
    });
    const read = card(twins);
    expect(read.options.map((option) => option.label).slice(0, 2)).toEqual(["Keep local socket", "Keep local socket"]);
    expect(gjcAskPrompt(read, calls)).toBe(read);
  });

  it("leaves the card as read when a recommended option collides on screen with a literal (Recommended) option", () => {
    const ambiguous = SCREEN
      .replace("│❯ Keep local socket (Recommended)", "│❯ Deploy (Recommended)")
      .replace("│  Remote relay", "│  Deploy (Recommended)");
    const calls = withArgs(open(), (args) => {
      args.questions[0]!.options[0]!.label = "Deploy";
      args.questions[0]!.options[1]!.label = "Deploy (Recommended)";
      args.questions[0]!.recommended = 0;
    });
    const read = card(ambiguous);
    expect(gjcAskPrompt(read, calls)).toBe(read);
  });

  describe("transcript resolution and stale-call protection", () => {
    const cleanupDirs: string[] = [];
    const spies: { mockRestore(): void }[] = [];

    afterEach(() => {
      while (spies.length > 0) spies.pop()!.mockRestore();
      while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
    });

    it("resolves paneTranscript once per gjc fallback read and skips ask Markdown when enrich is false while keeping record binding", async () => {
      const lookup = spyOn(conversation, "paneTranscript").mockResolvedValue({
        source: "gjc-transcript",
        path: fixture("open.jsonl"),
      });
      spies.push(lookup);

      const base = card();
      const plain = await withGjcFallback("w1:p-gjc-1", base, SCREEN, false);
      expect(plain).toBe(base);
      expect(lookup).toHaveBeenCalledTimes(1);

      lookup.mockClear();
      const enriched = await withGjcFallback("w1:p-gjc-1", base, SCREEN, true);
      expect(enriched?.text_format).toBe("markdown");
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("refuses to answer a replacement gjc ask call that draws the same screen, while allowing the original call with one transcript lookup", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gjc-ask-answer-"));
      cleanupDirs.push(dir);
      const sessionPath = join(dir, "session.jsonl");
      const openText = readFileSync(fixture("open.jsonl"), "utf8");
      writeFileSync(sessionPath, openText);

      const paneId = "w1:p-gjc-stale";
      const sentKeys: string[][] = [];
      spies.push(spyOn(herdr, "sessionSnapshot").mockResolvedValue({
        panes: [{ pane_id: paneId, agent: "gjc", agent_status: "blocked", cwd: dir }],
        workspaces: [],
        tabs: [],
      } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>));
      spies.push(spyOn(herdr, "paneRead").mockResolvedValue({ text: SCREEN } as Awaited<ReturnType<typeof herdr.paneRead>>));
      spies.push(spyOn(herdr, "paneSendKeys").mockImplementation(async (_id, keys) => { sentKeys.push([...keys]); }));
      const lookup = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "gjc-transcript", path: sessionPath });
      spies.push(lookup);

      const getRes = await handlePromptRequest(new Request(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`), new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
      expect(getRes?.status).toBe(200);
      const body = await getRes!.json() as { prompt: { id: string; text_format?: string } };
      expect(body.prompt.text_format).toBe("markdown");
      expect(lookup).toHaveBeenCalledTimes(1);

      // Close the original ask call and append a replacement ask call in the session log that draws the identical screen
      const originalId = open()[0]!.id;
      const lines = openText.trimEnd().split("\n");
      const toolCallLine = lines.at(-1)!;
      const closeLine = JSON.stringify({
        type: "message",
        id: "m_close",
        timestamp: "2026-11-25T00:00:02.000Z",
        message: { role: "toolResult", toolCallId: originalId, toolName: "ask", content: [{ type: "text", text: "ok" }] },
      });
      const replacementLine = toolCallLine.replaceAll(originalId, `${originalId}_replacement`);
      writeFileSync(sessionPath, `${openText.trimEnd()}\n${closeLine}\n${replacementLine}\n`);

      const staleRes = await handlePromptRequest(new Request("http://127.0.0.1/api/pane/prompt/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane_id: paneId, prompt_id: body.prompt.id, option_index: 0 }),
      }), new URL("http://127.0.0.1/api/pane/prompt/answer"));
      expect(staleRes?.status).toBe(409);
      expect(sentKeys).toEqual([]);

      // Fetch the replacement call's card, then answer it while unchanged: succeeds and uses single transcript lookups
      lookup.mockClear();
      const getRes2 = await handlePromptRequest(new Request(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`), new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
      expect(getRes2?.status).toBe(200);
      const body2 = await getRes2!.json() as { prompt: { id: string } };
      expect(body2.prompt.id).not.toBe(body.prompt.id);
      expect(lookup).toHaveBeenCalledTimes(1);

      lookup.mockClear();
      const okRes = await handlePromptRequest(new Request("http://127.0.0.1/api/pane/prompt/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane_id: paneId, prompt_id: body2.prompt.id, option_index: 0 }),
      }), new URL("http://127.0.0.1/api/pane/prompt/answer"));
      expect(okRes?.status).toBe(200);
      expect(sentKeys).toEqual([["enter"]]);
      // POST answer reads prompt once (readPrompt -> 1) and verifies once before commit (verifyThenSend -> 1) = 2 total, never 4
      expect(lookup.mock.calls.length).toBeLessThanOrEqual(2);
    });

    it("refuses a bound gjc card when paneTranscript fails during POST instead of falling back to an unbound screen match", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gjc-ask-unbound-"));
      cleanupDirs.push(dir);
      const sessionPath = join(dir, "session.jsonl");
      writeFileSync(sessionPath, readFileSync(fixture("open.jsonl"), "utf8"));

      const paneId = "w1:p-gjc-unbound";
      const sentKeys: string[][] = [];
      spies.push(spyOn(herdr, "sessionSnapshot").mockResolvedValue({
        panes: [{ pane_id: paneId, agent: "gjc", agent_status: "blocked", cwd: dir }],
        workspaces: [],
        tabs: [],
      } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>));
      spies.push(spyOn(herdr, "paneRead").mockResolvedValue({ text: SCREEN } as Awaited<ReturnType<typeof herdr.paneRead>>));
      spies.push(spyOn(herdr, "paneSendKeys").mockImplementation(async (_id, keys) => { sentKeys.push([...keys]); }));
      const lookup = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "gjc-transcript", path: sessionPath });
      spies.push(lookup);

      const getRes = await handlePromptRequest(new Request(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`), new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
      const body = await getRes!.json() as { prompt: { id: string; text_format?: string } };
      expect(body.prompt.text_format).toBe("markdown");

      lookup.mockRejectedValue(new conversation.ConversationUnavailable("no_session_path"));
      const postRes = await handlePromptRequest(new Request("http://127.0.0.1/api/pane/prompt/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane_id: paneId, prompt_id: body.prompt.id, option_index: 0 }),
      }), new URL("http://127.0.0.1/api/pane/prompt/answer"));
      expect(postRes?.status).toBe(409);
      expect(sentKeys).toEqual([]);
    });

    it("refuses to paste custom text into a replacement gjc ask editor and refuses final Enter if the editor closed while checking the call", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gjc-ask-custom-"));
      cleanupDirs.push(dir);
      const sessionPath = join(dir, "session.jsonl");
      const openText = readFileSync(fixture("open.jsonl"), "utf8");
      const originalId = open()[0]!.id;
      const otherSelected = SCREEN.replace(/│❯ Keep/u, "│  Keep").replace("│  Other (type your own)", "│❯ Other (type your own)");
      const emptyEditor = otherSelected.replace(/ ↑\/↓ select .*\n/u, " > \n\n enter submit  esc back to options  ctrl+g external editor  PgUp/PgDn: question · Wheel: transcript\n");
      const typedEditor = otherSelected.replace(/ ↑\/↓ select .*\n/u, " > mine\n\n enter submit  esc back to options  ctrl+g external editor  PgUp/PgDn: question · Wheel: transcript\n");

      // Case A: replacement ask arrives right after Enter opens Other — must not paste custom text
      writeFileSync(sessionPath, openText);
      let screen = otherSelected;
      const paneIdA = "w1:p-gjc-custom-replace";
      const sentTextsA: string[] = [];
      spies.push(spyOn(herdr, "sessionSnapshot").mockResolvedValue({
        panes: [{ pane_id: paneIdA, agent: "gjc", agent_status: "blocked", cwd: dir }],
        workspaces: [],
        tabs: [],
      } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>));
      spies.push(spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: screen } as Awaited<ReturnType<typeof herdr.paneRead>>)));
      spies.push(spyOn(herdr, "paneSendKeys").mockImplementation(async (_id, keys) => {
        if (keys.includes("enter")) {
          screen = emptyEditor;
          const toolCallLine = openText.trimEnd().split("\n").at(-1)!;
          const closeLine = JSON.stringify({
            type: "message",
            id: "m_close_custom",
            timestamp: "2026-11-25T00:00:02.000Z",
            message: { role: "toolResult", toolCallId: originalId, toolName: "ask", content: [{ type: "text", text: "ok" }] },
          });
          const replacementLine = toolCallLine.replaceAll(originalId, `${originalId}_replacement`);
          writeFileSync(sessionPath, `${openText.trimEnd()}\n${closeLine}\n${replacementLine}\n`);
        }
      }));
      spies.push(spyOn(herdr, "paneSendText").mockImplementation(async (_id, text) => { sentTextsA.push(text); }));
      const lookupA = spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "gjc-transcript", path: sessionPath });
      spies.push(lookupA);

      const getA = await handlePromptRequest(new Request(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneIdA)}`), new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneIdA)}`));
      const bodyA = await getA!.json() as { prompt: { id: string } };
      const postA = await handlePromptRequest(new Request("http://127.0.0.1/api/pane/prompt/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane_id: paneIdA, prompt_id: bodyA.prompt.id, custom_text: "mine" }),
      }), new URL("http://127.0.0.1/api/pane/prompt/answer"));
      expect(postA?.status).toBe(409);
      expect(sentTextsA).toEqual([]);

      // Case B: editor returns to options while final gjcCallStillOpen is pending — must not send final Enter
      while (spies.length > 0) spies.pop()!.mockRestore();
      const sessionPathB = join(dir, "session-b.jsonl");
      writeFileSync(sessionPathB, openText);
      const paneIdB = "w1:p-gjc-custom-closed";
      let screenB = otherSelected;
      const sentKeysB: string[][] = [];
      let pastedB = false;
      spies.push(spyOn(herdr, "sessionSnapshot").mockResolvedValue({
        panes: [{ pane_id: paneIdB, agent: "gjc", agent_status: "blocked", cwd: dir }],
        workspaces: [],
        tabs: [],
      } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>));
      spies.push(spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: screenB } as Awaited<ReturnType<typeof herdr.paneRead>>)));
      spies.push(spyOn(herdr, "paneSendKeys").mockImplementation(async (_id, keys) => {
        sentKeysB.push([...keys]);
        if (keys.includes("enter") && !pastedB) screenB = emptyEditor;
      }));
      spies.push(spyOn(herdr, "paneSendText").mockImplementation(async () => {
        pastedB = true;
        screenB = typedEditor;
      }));
      spies.push(spyOn(conversation, "paneTranscript").mockImplementation(async () => {
        // When verifying final submit after paste, simulate the user pressing Esc back to options during the lookup
        if (pastedB) screenB = otherSelected;
        return { source: "gjc-transcript", path: sessionPathB };
      }));

      const getB = await handlePromptRequest(new Request(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneIdB)}`), new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneIdB)}`));
      const bodyB = await getB!.json() as { prompt: { id: string } };
      const postB = await handlePromptRequest(new Request("http://127.0.0.1/api/pane/prompt/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane_id: paneIdB, prompt_id: bodyB.prompt.id, custom_text: "mine" }),
      }), new URL("http://127.0.0.1/api/pane/prompt/answer"));
      expect(postB?.status).toBe(409);
      // Only the first Enter (to open Other) was sent; final Enter was refused because the editor closed
      expect(sentKeysB).toEqual([["enter"]]);
    });

    it("keeps record binding on cursor-move rereads so a record-backed gjc shell approval can move to Deny", async () => {
      const dir = mkdtempSync(join(tmpdir(), "gjc-record-move-"));
      cleanupDirs.push(dir);
      const sessionPath = join(dir, "session.jsonl");
      writeFileSync(sessionPath, `${JSON.stringify({
        type: "message",
        id: "m_bash",
        timestamp: "2026-11-25T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_bash_1", name: "bash", arguments: { command: "touch am-short.flag" } }],
        },
      })}\n`);
      const paneId = "w1:p-gjc-record-move";
      const approvalAllow = [
        "─".repeat(40),
        "",
        " Approve the shell command",
        " touch am-short.flag",
        " Allow this command?",
        "",
        "─".repeat(40),
        "│❯ Allow once                          │",
        "│  Deny                                │",
        "─".repeat(40),
        "",
        " up/down navigate",
        " enter select esc cancel",
        "",
        "─".repeat(40),
      ].join("\n");
      const approvalDeny = approvalAllow
        .replace("│❯ Allow once", "│  Allow once")
        .replace("│  Deny", "│❯ Deny");
      let currentScreen = approvalAllow;
      const sentKeys: string[][] = [];
      spies.push(spyOn(herdr, "sessionSnapshot").mockResolvedValue({
        panes: [{ pane_id: paneId, agent: "gjc", agent_status: "blocked", cwd: dir }],
        workspaces: [],
        tabs: [],
      } as unknown as Awaited<ReturnType<typeof herdr.sessionSnapshot>>));
      spies.push(spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: currentScreen } as Awaited<ReturnType<typeof herdr.paneRead>>)));
      spies.push(spyOn(herdr, "paneSendKeys").mockImplementation(async (_id, keys) => {
        sentKeys.push([...keys]);
        if (keys.includes("down")) currentScreen = approvalDeny;
        else if (keys.includes("enter")) currentScreen = " $ ";
      }));
      spies.push(spyOn(conversation, "paneTranscript").mockResolvedValue({ source: "gjc-transcript", path: sessionPath }));

      const getRes = await handlePromptRequest(new Request(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`), new URL(`http://127.0.0.1/api/pane/prompt?pane_id=${encodeURIComponent(paneId)}`));
      expect(getRes?.status).toBe(200);
      const body = await getRes!.json() as { prompt: { id: string; body?: string | null; options: { label: string }[] } };
      expect(body.prompt.body).toContain("touch am-short.flag");
      expect(body.prompt.options.map((o) => o.label)).toEqual(["Allow once", "Deny", "Esc"]);

      const postRes = await handlePromptRequest(new Request("http://127.0.0.1/api/pane/prompt/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane_id: paneId, prompt_id: body.prompt.id, option_index: 1 }),
      }), new URL("http://127.0.0.1/api/pane/prompt/answer"));
      expect(postRes?.status).toBe(200);
      expect(sentKeys).toEqual([["down"], ["enter"]]);
    });
  });
});
