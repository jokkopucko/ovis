import { describe, expect, it } from "bun:test";
import type { ConversationTurn } from "./protocol.ts";
import { createCodexTranscriptParser } from "../server/codex.ts";
import { parseHermesRows, type HermesMessageRow } from "../server/hermes.ts";
import { conversationTurnAnchor, matchSnippet, pickAhead, pickedTurn, pickSettled, searchableText, searchedTurnChanged, searchPattern, searchTurns } from "./conversation-search.ts";

const user = (text: string, ts: string | null = "2026-10-01T00:00:00Z"): ConversationTurn => ({ role: "user", ts, parts: [{ kind: "text", text }] });

describe("searchPattern", () => {
  it("matches the words in order across any whitespace, case ignored, every character literal", () => {
    const pattern = searchPattern("  Deploy   script ")!;
    expect(pattern.test("the deploy\n\tSCRIPT failed")).toBe(true);
    expect(pattern.test("the script deploy")).toBe(false);
    expect(searchPattern("a.b (c)? [d] {e} | f\\g /h ^$*+")!.test("x a.b (c)? [d] {e} | f\\g /h ^$*+ y")).toBe(true);
    expect(searchPattern("a.b")!.test("axb")).toBe(false);
    expect(searchPattern("ÉCOLE")!.test("l'école")).toBe(true);
    expect(searchPattern("   ")).toBeNull();
    expect(searchPattern("")).toBeNull();
  });
});

describe("searchableText", () => {
  it("reads the user's words and the agent's answers, never its tools, thinking or progress notes", () => {
    const turn: ConversationTurn = { role: "assistant", ts: null, parts: [
      { kind: "thinking", text: "secret plan" },
      { kind: "text", text: "Looking at the plan.", phase: "commentary" },
      { kind: "tool", name: "Bash", summary: "plan", input: "cat plan", output: "plan output" },
      { kind: "text", text: "The plan is done." },
      { kind: "text", text: "Final word.", phase: "final_answer" },
    ] };
    expect(searchableText(turn)).toBe("The plan is done.\n\nFinal word.");
    expect(searchableText({ role: "user", ts: null, parts: [{ kind: "text", text: "one" }, { kind: "image", media_type: "image/png", ref: "r" }, { kind: "text", text: "two" }] })).toBe("one\n\ntwo");
  });

  it("reads an answer's words as the chat draws them, without its Markdown marks", () => {
    const answer = "## Done\n\n- **`POST /payments`** replays the [stored](https://example.com/a) response.\n2. A `snake_case_name` stays.\n> quoted\n```ts\nconst a = 1;\n```";
    expect(searchableText({ role: "assistant", ts: null, parts: [{ kind: "text", text: answer }] }))
      .toBe("Done\n\nPOST /payments replays the stored response.\nA snake_case_name stays.\nquoted\n\nconst a = 1;\n");
    expect(searchPattern("payments replays the stored")!.test(searchableText({ role: "assistant", ts: null, parts: [{ kind: "text", text: answer }] }))).toBe(true);
  });

  it("reads a link as its label wherever the pattern it replaced did", () => {
    // the pattern as it was written; none of these characters is another mark searchableText drops
    const was = (text: string): string => text.replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
    const marks = ["[", "]", "(", ")", "!", "\n", "a"];
    const differ: string[] = [];
    const check = (text: string): void => { if (searchableText(user(text)) !== was(text)) differ.push(text); };
    // every text of up to six of them
    const every = (text: string): void => {
      check(text);
      if (text.length < 6) for (const mark of marks) every(text + mark);
    };
    every("");
    // and longer ones, where one link follows another: the same 20,000 texts each run
    let seed = 1;
    const next = (below: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return (seed >>> 16) % below;
    };
    for (let count = 0; count < 20_000; count++) check(Array.from({ length: 8 + next(33) }, () => marks[next(marks.length)]).join(""));
    expect(differ).toEqual([]);
    expect(searchableText(user("see ![a [b](c) and [d](e)(f) [g]\n(h) [i](j\n) ![](k)![l](m)"))).toBe("see a [b and d(f) [g]\n(h) [i](j\n) l");
  });

  it("reads a long line of brackets that never close in one pass", () => {
    // read as a pattern, 20,000 such characters took 0.4 s and twice as many four times that: these
    // lines of 200,000 took from 4 to 36 s each, and in one pass they take a few milliseconds.
    // The timeout is the bound: a test that returns after it has failed
    for (const line of ["[".repeat(200_000), `${"[".repeat(200_000)}]`, "![".repeat(100_000), "[a](".repeat(50_000)]) {
      expect(searchableText(user(line)) === line).toBe(true);
      expect(searchTurns([user(`needle ${line}`)], searchPattern("needle")!)).toHaveLength(1);
    }
  }, 5_000);
});

describe("matchSnippet", () => {
  it("keeps the words around the match, cut with an ellipsis, whitespace as single spaces", () => {
    const text = `${"lead ".repeat(40)}the needle\n\nin  the ${"tail ".repeat(60)}`;
    const snippet = matchSnippet(text, searchPattern("needle")!)!;
    expect(snippet.match).toBe("needle");
    expect(snippet.before.startsWith("…")).toBe(true);
    expect(snippet.before.endsWith("the ")).toBe(true);
    expect(snippet.before.length).toBeLessThanOrEqual(33);
    // the word the cut went through goes with it
    expect(snippet.before).toMatch(/^…(?:lead )+the $/);
    expect(snippet.after).toMatch(/^ in the (?:tail )*tail…$/);
    expect(snippet.after.startsWith(" in the tail")).toBe(true);
    expect(snippet.after.endsWith("…")).toBe(true);
    expect(snippet.after.length).toBeLessThanOrEqual(161);
    expect(matchSnippet("needle", searchPattern("needle")!)).toEqual({ before: "", match: "needle", after: "" });
    expect(matchSnippet("hay", searchPattern("needle")!)).toBeNull();
  });

  it("never cuts a character made of two code units in half", () => {
    const emoji = "😀".repeat(100);
    // an odd number of code units before the match puts every margin's edge inside a pair
    for (const text of [`${emoji}needle${emoji}`, `${emoji}a needle${emoji}`, `${emoji}${" ".repeat(200)}a needle ${" ".repeat(400)}${emoji}`]) {
      const snippet = matchSnippet(text, searchPattern("needle")!)!;
      for (const side of [snippet.before, snippet.after]) expect(side.replaceAll("…", "")).toMatch(/^(?:😀| |a)*$/u);
    }
  });
});

describe("searchTurns", () => {
  it("lists each matching turn once, newest first, named as the chat names its rows", () => {
    const turns = [user("fix the build"), { role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [{ kind: "text", text: "The build is fixed. The build passes." }] } satisfies ConversationTurn, user("thanks")];
    expect(searchTurns(turns, searchPattern("build")!)).toEqual([
      { turn: conversationTurnAnchor(turns[1]!), role: "assistant", ts: "2026-10-01T00:00:01Z", text_digest: expect.any(String), before: "The ", match: "build", after: " is fixed. The build passes." },
      { turn: "user|2026-10-01T00:00:00Z|text|fix the build", role: "user", ts: "2026-10-01T00:00:00Z", text_digest: expect.any(String), before: "fix the ", match: "build", after: "" },
    ]);
  });
});

describe("searchedTurnChanged", () => {
  const line = (timestamp: string, type: string, payload: Record<string, unknown>): string => `${JSON.stringify({ timestamp, type, payload })}\n`;
  const started = line("2026-10-01T00:00:00Z", "event_msg", { type: "task_started", turn_id: "t1" });
  const asked = line("2026-10-01T00:00:00Z", "event_msg", { type: "user_message", message: "check the deploy" });
  const found = (turns: readonly ConversationTurn[], query: string) => searchTurns(turns, searchPattern(query)!).find((match) => match.role === "assistant")!;

  it("finds a tool-first answer whose output arrived after it was searched, which no longer has its name", () => {
    const parser = createCodexTranscriptParser();
    parser.write(started + asked
      + line("2026-10-01T00:00:01Z", "response_item", { type: "function_call", name: "exec", arguments: "", call_id: "c1" })
      + line("2026-10-01T00:00:02Z", "event_msg", { type: "agent_message", message: "The deploy script is ready." }));
    const match = found(parser.snapshot(), "deploy script");
    parser.write(line("2026-10-01T00:00:03Z", "response_item", { type: "function_call_output", call_id: "c1", output: "deploy.sh" }));
    const turns = parser.snapshot();
    expect(turns.some((turn) => conversationTurnAnchor(turn) === match.turn)).toBe(false);
    expect(turns.filter((turn) => searchedTurnChanged(turn, match))).toEqual([turns[1]!]);
  });

  it("finds an answer that went on after it was searched, its first words grown", () => {
    const answer = (text: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [{ kind: "text", text }] });
    const match = found([user("go"), answer("The deploy script")], "deploy script");
    const grown = answer("The deploy script is ready, and it ran on both hosts without a single error.");
    expect(conversationTurnAnchor(grown)).not.toBe(match.turn);
    expect(searchedTurnChanged(grown, match)).toBe(true);
    // a link that streamed in closes, and its mark leaves the words before the match
    const linked = found([user("go"), answer("Result: [deploy")], "deploy");
    expect(linked.before).toBe("Result: [");
    expect(searchedTurnChanged(answer("Result: [deploy](https://example.com) is up."), linked)).toBe(true);
    const linkAfter = found([user("go"), answer("deploy [docs")], "deploy");
    expect(searchedTurnChanged(answer("deploy [docs](https://example.com) are ready"), linkAfter)).toBe(true);
  });

  it("tells apart two answers of one time that the user steered between, and takes none whose words before the match changed", () => {
    const parser = createCodexTranscriptParser();
    parser.write(started + asked
      + line("2026-10-01T00:00:01Z", "event_msg", { type: "agent_message", message: "First: the deploy script fails." })
      + line("2026-10-01T00:00:02Z", "event_msg", { type: "user_message", message: "try again" })
      + line("2026-10-01T00:00:03Z", "event_msg", { type: "agent_message", message: "Second: the deploy script passes." }));
    const turns = parser.snapshot();
    // Codex dates both answers by the task's start
    expect(turns[1]!.ts).toBe(turns[3]!.ts);
    const [second, first] = searchTurns(turns, searchPattern("deploy script")!).filter((match) => match.role === "assistant");
    expect(turns.filter((turn) => searchedTurnChanged(turn, first!))).toEqual([turns[1]!]);
    expect(turns.filter((turn) => searchedTurnChanged(turn, second!))).toEqual([turns[3]!]);
    const rewritten: ConversationTurn = { ...turns[1]!, parts: [{ kind: "text", text: "Now: the deploy script fails." }] };
    expect(searchedTurnChanged(rewritten, first!)).toBe(false);
    expect(searchedTurnChanged({ ...turns[1]!, ts: "2026-10-01T00:00:09Z" }, first!)).toBe(false);
    expect(searchedTurnChanged({ ...turns[1]!, role: "user" }, first!)).toBe(false);
  });
});

describe("pickedTurn", () => {
  const answer = (text: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [{ kind: "text", text }] });
  const match = searchTurns([answer("The deploy script")], searchPattern("deploy script")!)[0]!;

  it("opens the one turn that is the match, by its name or changed since, past rows that are no turn", () => {
    expect(pickedTurn([user("go"), null, answer("The deploy script")], match)).toBe(2);
    expect(pickedTurn([user("go"), answer("The deploy script is ready."), user("thanks")], match)).toBe(1);
    expect(pickedTurn([user("go"), answer("Another deploy script")], match)).toBe("none");
    // an answer that begins with the match: an answer of its time with words before it is another one
    const opening = searchTurns([answer("deploy script")], searchPattern("deploy script")!)[0]!;
    expect(pickedTurn([answer("deploy script"), user("again"), answer("Meanwhile deploy script fails")], opening)).toBe(0);
    // a long answer's snippet is cut: a closed link moves the cut, and the words still end alike
    const long = `${"word ".repeat(20)}see [deploy`;
    const cut = searchTurns([answer(long)], searchPattern("deploy")!)[0]!;
    expect(cut.before.startsWith("…")).toBe(true);
    expect(pickedTurn([answer(`${long}](https://example.com) now`)], cut)).toBe(0);
  });

  it("opens each of two answers of one time that begin with the match, by its name", () => {
    const turns = [answer("Deploy script fails."), user("again"), answer("Deploy script passes.")];
    const [passes, fails] = searchTurns(turns, searchPattern("deploy script")!);
    expect(pickedTurn(turns, fails!)).toBe(0);
    expect(pickedTurn(turns, passes!)).toBe(2);
    // one that went on is still found
    expect(pickedTurn([answer("Deploy script fails. Rerunning it."), user("again"), answer("Deploy script passes.")], fails!)).toBe(0);
  });

  it("opens an answer by its name when a later answer of its time begins with it", () => {
    const parser = createCodexTranscriptParser();
    const line = (timestamp: string, payload: Record<string, unknown>): string => `${JSON.stringify({ timestamp, type: "event_msg", payload })}\n`;
    parser.write(line("2026-10-01T00:00:00Z", { type: "task_started", turn_id: "t1" }) + line("2026-10-01T00:00:00Z", { type: "user_message", message: "fix the build" })
      + line("2026-10-01T00:00:01Z", { type: "agent_message", message: "Done." }) + line("2026-10-01T00:00:02Z", { type: "user_message", message: "also the lint" })
      + line("2026-10-01T00:00:03Z", { type: "agent_message", message: "Done. The lint passes too." }));
    const turns = parser.snapshot();
    const [later, first] = searchTurns(turns, searchPattern("done")!);
    expect(pickedTurn(turns, first!)).toBe(1);
    expect(pickedTurn(turns, later!)).toBe(3);
    // steered twice: answers after the named one never stop it
    const thrice = [answer("Done."), user("lint"), answer("Done. Lint passes."), user("tests"), answer("Done. Tests pass.")];
    expect(pickedTurn(thrice, searchTurns([answer("Done.")], searchPattern("done")!)[0]!)).toBe(0);
    // turns without a time: by name only
    const untimed = [user("fix it now", null), answer("ok"), user("fix it", null)];
    expect(pickedTurn(untimed, searchTurns(untimed, searchPattern("fix it")!)[0]!)).toBe(2);
    const prompts = [user("run tests", null), answer("ok"), user("run tests now", null)];
    expect(pickedTurn(prompts, searchTurns(prompts, searchPattern("run tests")!)[1]!)).toBe(0);
  });

  it("tells apart prompts without a time that begin alike by their whole words (Kimi)", () => {
    const lead = "y".repeat(90);
    const older = user(`${lead} the first way`, null), later = user(`${lead} the second way`, null);
    expect(conversationTurnAnchor(older)).toBe(conversationTurnAnchor(later));
    const turns = [older, answer("ok"), later, answer("ok")];
    const [laterMatch, olderMatch] = searchTurns(turns, searchPattern("way")!);
    expect(pickedTurn(turns, olderMatch!)).toBe(0);
    expect(pickedTurn(turns, laterMatch!)).toBe(2);
    // only the later one loaded: it is not the older one, so the pick reads on
    expect(pickSettled(turns.slice(2), olderMatch!)).toBe(false);
    expect(pickedTurn(turns.slice(2), olderMatch!)).toBe("none");
    expect(pickSettled(turns, olderMatch!)).toBe(true);
    // Markdown marks the search does not read still tell two prompts apart
    const marked = [user(`${lead} **deploy**`, null), answer("ok"), user(`${lead} deploy`, null)];
    expect(pickedTurn(marked, searchTurns(marked, searchPattern("deploy")!)[0]!)).toBe(2);
    // an older server's match has no digest: by name, as before
    const { text_digest: _, ...old } = laterMatch!;
    expect(pickedTurn(turns, old)).toBe(0);
  });

  it("opens the first of turns that share the match's name, as without a changed one", () => {
    const turns = [user("continue", null), answer("ok one"), user("continue", null), answer("ok two")];
    for (const match of searchTurns(turns, searchPattern("continue")!)) expect(pickedTurn(turns, match)).toBe(0);
  });

  it("tells apart prompts of the same words by their pictures, but for Codex's, whose ref changes when paired", () => {
    const pictured = (ref: string): ConversationTurn => ({ role: "user", ts: null, parts: [{ kind: "image", media_type: "image/png", ref }, { kind: "text", text: "what color is this" }] });
    const turns = [pictured("claude:u1:0"), answer("red"), pictured("claude:u2:0"), answer("blue")];
    expect(searchTurns(turns, searchPattern("color")!).map((match) => pickedTurn(turns, match))).toEqual([2, 0]);
    expect(conversationTurnAnchor(pictured("codex-inline"))).toBe(conversationTurnAnchor(pictured("codex-file")));
  });

  it("takes no answer of the same opening whose words after the match went another way", () => {
    const tooled = (output: string, text: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [
      { kind: "tool", name: "exec", summary: "exec", input: "", output }, { kind: "text", text }] });
    const searched = searchTurns([tooled("ok", "deploy succeeded")], searchPattern("deploy")!)[0]!;
    expect(pickedTurn([tooled("fail", "deploy failed")], searched)).toBe("none");
    expect(pickedTurn([tooled("ok, all of it", "deploy succeeded on both hosts")], searched)).toBe(0);
  });

  it("opens none when the answer grew and a later answer of its time took its old name", () => {
    expect(pickedTurn([answer("The deploy script is ready."), user("again"), answer("The deploy script")], match)).toBe("several");
    expect(pickedTurn([answer("The deploy script is ready."), user("again"), answer("The deploy script passes.")], match)).toBe("several");
  });

  it("opens the one of answers of its time sharing their first words whose text still holds the match, or none", () => {
    // both begin with the same 80 characters (or the same tool call), so they share a name
    const lead = "x".repeat(90);
    const apples = answer(`${lead} APPLES`), bananas = answer(`${lead} BANANAS`);
    expect(conversationTurnAnchor(apples)).toBe(conversationTurnAnchor(bananas));
    const picked = searchTurns([bananas], searchPattern("bananas")!)[0]!;
    expect(pickedTurn([apples, user("again"), bananas], picked)).toBe(2);
    expect(pickedTurn([bananas], picked)).toBe(0);
    const tooled = (text: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [
      { kind: "tool", name: "exec_command", summary: "git status", input: '{"cmd":"git status"}', output: "clean" }, { kind: "text", text }] });
    const apple = searchTurns([tooled("APPLE result")], searchPattern("apple")!)[0]!;
    expect(pickedTurn([tooled("APPLE result"), user("again"), tooled("BANANA result")], apple)).toBe(0);
    // the searched answer's words became a progress note (Codex pairs its event later): it still holds
    // them, so neither opens
    const noted: ConversationTurn = { ...bananas, parts: [{ kind: "text", text: `${lead} BANANAS`, phase: "commentary" }] };
    expect(pickedTurn([noted, user("again"), bananas], picked)).toBe("several");
    // a link that closed since still holds the words
    const link = searchTurns([answer(`${lead} deploy [docs`)], searchPattern("deploy")!)[0]!;
    expect(pickedTurn([answer(`${lead} deploy [docs](https://example.com) are up.`), user("again"), answer(`${lead} deploy [docs`)], link)).toBe("several");
    const both = searchTurns([answer(`${lead} fruit`)], searchPattern("fruit")!)[0]!;
    expect(pickedTurn([answer(`${lead} fruit`), user("again"), answer(`${lead} fruit`)], both)).toBe("several");
  });

  it("opens the one of answers of its time sharing their name and the matched words that says what was searched", () => {
    // Codex dates both answers by the task's start: one name, and both hold the matched words
    const lead = "x".repeat(90);
    const turns = [answer(`${lead} first way`), user("again"), answer(`${lead} second way`)];
    const [second, first] = searchTurns(turns, searchPattern("way")!);
    expect(pickedTurn(turns, first!)).toBe(0);
    expect(pickedTurn(turns, second!)).toBe(2);
    // the first went on from the second's words since: either could be the searched one
    expect(pickedTurn([answer(`${lead} second way and more`), user("again"), answer(`${lead} second way`)], second!)).toBe("several");
    // the searched answer's words became a progress note, after another note with them: either may be it
    const noted = (last: "commentary" | undefined): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [
      { kind: "text", text: lead }, { kind: "text", text: "needle progress", phase: "commentary" }, { kind: "text", text: "needle target", ...(last === undefined ? {} : { phase: last }) }] });
    const target = searchTurns([noted(undefined)], searchPattern("needle")!)[0]!;
    expect(pickedTurn([noted("commentary"), user("again"), noted(undefined)], target)).toBe("several");
    // nor when the searched answer's first tool got its output since, so its name changed too
    const tooled = (text: string, output: string): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [
      { kind: "tool", name: "exec", summary: "exec", input: "", output }, { kind: "text", text }] });
    const pending = searchTurns([tooled("needle target", "")], searchPattern("needle")!)[0]!;
    expect(pickedTurn([tooled("needle target", ""), user("a"), tooled("needle other", ""), user("b"), tooled("needle target", "ok")], pending)).toBe("several");
    // nor when its tool's output came and its words became a note, so it left both the name and the search
    const paired: ConversationTurn = { ...tooled("needle target", "ok"), parts: [tooled("", "ok").parts[0]!, { kind: "text", text: "needle target", phase: "commentary" }] };
    expect(pickedTurn([paired, user("a"), tooled("needle other", ""), user("b"), tooled("needle target", "")], pending)).toBe("several");
    // nor when the words ran from a part now a note into an answer
    const spans = (note: boolean): ConversationTurn => ({ role: "assistant", ts: "2026-10-01T00:00:01Z", parts: [
      { kind: "text", text: lead }, { kind: "text", text: "needle", ...(note ? { phase: "commentary" as const } : {}) }, { kind: "text", text: "target" }] });
    const spanned = searchTurns([spans(false)], searchPattern("needle target")!)[0]!;
    expect(pickedTurn([spans(true), user("again"), spans(false)], spanned)).toBe("several");
    // an older server's match has no digest: none is opened, as before
    const { text_digest: _, ...old } = second!;
    expect(pickedTurn(turns, old)).toBe("several");
  });

  it("opens a Hermes answer by the store row its words are in, wherever a page split it", () => {
    const row = (id: number, role: "user" | "assistant", content: string): HermesMessageRow =>
      ({ id, role, content, tool_call_id: null, tool_calls: null, tool_name: null, reasoning: null, timestamp: 1_700_000_000 + id });
    const rows = [row(100, "user", "deploy it"), row(101, "assistant", "Checking the deploy."), row(102, "assistant", "The deploy script is ready."), row(103, "user", "thanks")];
    // the chat's newest page began at row 101; a row came since, so the search's began at row 102
    const shown = parseHermesRows(rows.slice(1));
    const match = searchTurns(parseHermesRows(rows.slice(2)), searchPattern("deploy script")!)[0]!;
    expect(pickSettled(shown, match)).toBe(true);
    expect(pickedTurn(shown, match)).toBe(0);
    expect(pickedTurn(parseHermesRows(rows), match)).toBe(1);
    // the search read a row the chat has not yet (the answer went on): no page before holds it, and
    // no turn read is it, though one says the same (the chat reads its newest page again first)
    const growing = [row(100, "user", "deploy it"), row(101, "assistant", "The deploy script is ready."), row(102, "assistant", "Running the deploy script now.")];
    const ahead = searchTurns(parseHermesRows(growing.slice(2)), searchPattern("deploy script")!)[0]!;
    const behind = parseHermesRows([growing[0]!, { ...growing[2]!, id: 101 }]);
    expect(pickAhead(behind, ahead)).toBe(true);
    expect(pickSettled(behind, ahead)).toBe(true);
    expect(pickedTurn(behind, ahead)).toBe("none");
    expect(pickAhead(parseHermesRows(growing), ahead)).toBe(false);
    expect(pickedTurn(parseHermesRows(growing), ahead)).toBe(1);
    // nor an older prompt of its time and words: the chat read rows 1 to 4, the search found row 5
    const again = (id: number, role: "user" | "assistant", content: string): HermesMessageRow => ({ ...row(id, role, content), timestamp: 1_700_000_003 });
    const retried = [row(1, "user", "earlier"), row(2, "assistant", "ok"), again(3, "user", "retry"), again(4, "assistant", "ok"), again(5, "user", "retry")];
    const unread = searchTurns(parseHermesRows(retried), searchPattern("retry")!)[0]!;
    expect(unread.row).toBe(5);
    expect(pickAhead(parseHermesRows(retried.slice(0, 4)), unread)).toBe(true);
    expect(pickSettled(parseHermesRows(retried.slice(0, 4)), unread)).toBe(true);
    expect(pickedTurn(parseHermesRows(retried.slice(0, 4)), unread)).toBe("none");
    expect(pickedTurn(parseHermesRows(retried), unread)).toBe(4);
    // a newest page of tool calls alone names no row: it neither settles the pick nor says it is ahead,
    // until an earlier page's rows do (the chat then reads its newest page again)
    const run = parseHermesRows([{ ...row(6, "assistant", ""), content: null, tool_calls: JSON.stringify([{ id: "c0", function: { name: "bash", arguments: "{}" } }]) }]);
    expect(pickAhead(run, { ...unread, row: 7 })).toBe(false);
    expect(pickSettled(run, { ...unread, row: 7 })).toBe(false);
    expect(pickAhead([...parseHermesRows(retried), ...run], { ...unread, row: 7 })).toBe(true);
    // a page that does not hold the row reads on, and opens none
    expect(pickSettled(shown.slice(1), match)).toBe(false);
    expect(pickedTurn(shown.slice(1), match)).toBe("none");
    // the answer split the other way: the part with the words is opened
    const whole = searchTurns(parseHermesRows(rows), searchPattern("deploy script")!)[0]!;
    const split = [...parseHermesRows(rows.slice(0, 2)), ...parseHermesRows(rows.slice(2))];
    expect(pickSettled(split.slice(2), whole)).toBe(true);
    expect(pickedTurn(split, whole)).toBe(2);
    // the words a part before the searched rows also has are not the match
    const said = [row(100, "assistant", "needle earlier"), row(101, "assistant", "filler"), row(102, "assistant", "more filler"), row(103, "assistant", "needle target")];
    const target = searchTurns(parseHermesRows(said.slice(2)), searchPattern("needle")!)[0]!;
    expect(pickedTurn([...parseHermesRows(said.slice(0, 3)), ...parseHermesRows(said.slice(3))], target)).toBe(1);
    // words found across two rows open the part they begin in
    const across = [row(101, "assistant", "deploy"), row(102, "assistant", "script")];
    const spanned = searchTurns(parseHermesRows(across), searchPattern("deploy script")!)[0]!;
    expect(pickedTurn([...parseHermesRows(across.slice(0, 1)), ...parseHermesRows(across.slice(1))], spanned)).toBe(0);
    // a row gone since joins the turns around it: the row a match was in is in neither
    const prompt = searchTurns(parseHermesRows(rows), searchPattern("deploy it")!)[0]!;
    const joined = parseHermesRows([row(99, "assistant", "deploy it, you said"), row(101, "assistant", "Checking.")]);
    expect(pickSettled(joined, prompt)).toBe(true);
    expect(pickedTurn(joined, prompt)).toBe("none");
    // a turn of a tool alone is no older server's: a row gone since opens none, not another call of its name
    const call = JSON.stringify([{ id: "c1", function: { name: "bash", arguments: "{}" } }]);
    const called = searchTurns(parseHermesRows([row(9, "user", "go"), { ...row(10, "assistant", "needle"), tool_calls: call }]), searchPattern("needle")!)[0]!;
    const recalled = parseHermesRows([row(9, "user", "go"), { ...row(11, "assistant", ""), content: null, tool_calls: call, timestamp: 1_700_000_010 }, row(12, "user", "next")]);
    expect(pickSettled(recalled, called)).toBe(true);
    expect(pickedTurn(recalled, called)).toBe("none");
    // turns a page from an older server brought, without rows, go by name
    const older = parseHermesRows(rows).map(({ text_rows: _, ...turn }) => turn);
    expect(pickSettled(older, whole)).toBe(true);
    expect(pickedTurn(older, whole)).toBe(1);
  });

  it("opens the Hermes answer searched though an earlier answer's tool result came after it", () => {
    const at = (id: number, fields: Partial<HermesMessageRow>): HermesMessageRow =>
      ({ id, role: "assistant", content: null, tool_call_id: null, tool_calls: null, tool_name: null, reasoning: null, timestamp: 1_700_000_000 + id, ...fields });
    const rows = [at(51, { content: "needle old", tool_calls: JSON.stringify([{ id: "c1", function: { name: "bash", arguments: "{}" } }]) }),
      at(52, { role: "user", content: "again" }), at(53, { content: "needle target" }), at(54, { role: "tool", content: "done", tool_call_id: "c1", tool_name: "bash" })];
    const match = searchTurns(parseHermesRows(rows.slice(2)), searchPattern("needle")!)[0]!;
    expect(pickedTurn(parseHermesRows(rows), match)).toBe(2);
  });
});

describe("pickSettled", () => {
  const said = (text: string, ts: string): ConversationTurn => ({ role: "assistant", ts, parts: [{ kind: "text", text }] });

  it("reads on past a later answer that took a grown answer's name until the grown one is read", () => {
    // the answer was searched while it said only its first words, then went on; the user steered and
    // the next answer, dated by the task's start (Codex) as well, began with those words
    const task = "2026-10-01T00:01:00Z";
    const match = searchTurns([user("check the deploy", task), said("The deploy script", task)], searchPattern("deploy script")!)[0]!;
    const turns = [user("list the files", "2026-10-01T00:00:00Z"), said("Done.", "2026-10-01T00:00:00Z"),
      user("check the deploy", task), said("The deploy script is ready.", task), user("run it again", "2026-10-01T00:01:03Z"), said("The deploy script", task)];
    // pages read newest first: the steer and the later answer, the grown answer and its prompt, then the earlier task
    expect(pickSettled(turns.slice(4), match)).toBe(false);
    expect(pickSettled(turns.slice(2), match)).toBe(false);
    expect(pickSettled(turns, match)).toBe(true);
    expect(pickedTurn(turns, match)).toBe("several");
  });

  it("reads on when the named answer no longer says what was searched, as after a clock went back (Hermes)", () => {
    // the searched answer grew; the clock went back for the next prompt, and the later answer began
    // with the searched answer's old words, more than a name holds
    const lead = "x".repeat(90);
    const match = searchTurns([said(`${lead} deploy script`, "2026-10-01T10:00:10Z")], searchPattern("deploy script")!)[0]!;
    const turns = [said(`${lead} deploy script is ready.`, "2026-10-01T10:00:10Z"), user("again", "2026-10-01T10:00:09Z"), said(`${lead} deploy script passes.`, "2026-10-01T10:00:10Z")];
    expect(conversationTurnAnchor(turns[2]!)).toBe(match.turn);
    expect(pickSettled(turns.slice(1), match)).toBe(false);
    expect(pickedTurn(turns, match)).toBe("several");
    // nor when the later answer reads the same once its Markdown marks are gone
    const bold = searchTurns([said(`${lead} **deploy**`, "2026-10-01T10:00:10Z")], searchPattern("deploy")!)[0]!;
    expect(pickSettled([user("again", "2026-10-01T10:00:09Z"), said(`${lead} deploy`, "2026-10-01T10:00:10Z")], bold)).toBe(false);
  });

  it("settles on the named turn once a turn before it is of an earlier time, or the match has no time", () => {
    const at = (text: string, ts: string | null): ConversationTurn => ({ role: "assistant", ts, parts: [{ kind: "text", text }] });
    const match = searchTurns([at("The deploy script", "2026-10-01T00:00:01Z")], searchPattern("deploy script")!)[0]!;
    expect(pickSettled([user("go"), at("The deploy script", "2026-10-01T00:00:01Z")], match)).toBe(true);
    expect(pickSettled([at("The deploy script", "2026-10-01T00:00:01Z")], match)).toBe(false);
    expect(pickSettled([user("go"), at("Another answer", "2026-10-01T00:00:01Z")], match)).toBe(false);
    // a time that cannot be read tells nothing
    expect(pickSettled([user("go", "yesterday"), at("The deploy script", "2026-10-01T00:00:01Z")], match)).toBe(false);
    const untimed = searchTurns([at("The deploy script", null)], searchPattern("deploy script")!)[0]!;
    expect(pickSettled([at("The deploy script", null)], untimed)).toBe(true);
  });
});
