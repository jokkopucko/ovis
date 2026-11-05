import { describe, expect, test } from "bun:test";

import type { CommandOutcome, ConversationTurn } from "../../shared/protocol.ts";
import { translate } from "./i18n.ts";
import { afterMove, moveCommand, noteCatalogChanges, outcomeChip, outcomeCommand, outcomeLabel, outcomeNote, outcomeResultText, outcomeRows } from "./outcomeChip.ts";

const en = (key: string, vars?: Record<string, string | number>): string => translate("en", key, vars);

const STATES: CommandOutcome["state"][] = ["accepted", "interaction-required", "result-observed", "terminal-required", "unknown"];
const EVIDENCE: CommandOutcome["evidence"][number]["kind"][] = ["transcript", "dialog", "recognized-result", "native", "side-store"];

function outcome(over: Partial<CommandOutcome> & { text: string; created_at: string }): CommandOutcome {
  return { id: `o-${over.text}-${over.created_at}`, pane_id: "w1:p1", state: "accepted", evidence: [], updated_at: over.created_at, ...over };
}

function user(text: string, ts: string | null): ConversationTurn {
  return { role: "user", ts, parts: [{ kind: "text", text }] };
}

function assistant(text: string, ts: string | null): ConversationTurn {
  return { role: "assistant", ts, parts: [{ kind: "text", text }] };
}

describe("outcomeNote", () => {
  test("names the skills the agent did not attach, and nothing for any other outcome", () => {
    const sent = outcome({ text: "@effect @review go", created_at: "2026-10-20T10:00:00Z", state: "terminal-required", unattached_skills: ["effect", "review"] });
    expect(outcomeNote(en, sent)).toBe("Not attached, sent as plain text: @effect, @review");
    expect(outcomeNote(en, { ...sent, unattached_skills: ["effect"] })).toBe("Not attached, sent as plain text: @effect");
    expect(outcomeNote(en, outcome({ text: "/btw hi", created_at: "2026-10-20T10:00:00Z", state: "terminal-required" }))).toBeNull();
  });
});

describe("outcomeChip", () => {
  test("maps every state to its own chip, with a result's latest evidence and the one action the state offers", () => {
    const chips = STATES.map((state) => outcomeChip(outcome({ text: "/context", created_at: "2026-10-20T10:00:00.000Z", state, evidence: state === "result-observed" ? [{ kind: "native", at: "2026-10-20T10:00:01.000Z" }, { kind: "transcript", at: "2026-10-20T10:00:02.000Z" }] : [] })));
    expect(chips.map((chip) => chip.state)).toEqual(STATES);
    expect(chips.map((chip) => chip.evidence)).toEqual([null, null, "transcript", null, null]);
    expect(chips.map((chip) => chip.action)).toEqual([null, "answer", null, "terminal", null]);
    const labels = new Set(chips.map((chip) => outcomeLabel(en, chip)));
    expect(labels.size).toBe(STATES.length);
    for (const kind of EVIDENCE) {
      const chip = outcomeChip(outcome({ text: "/context", created_at: "2026-10-20T10:00:00.000Z", state: "result-observed", evidence: [{ kind, at: "2026-10-20T10:00:01.000Z" }] }));
      expect(chip.evidence).toBe(kind);
      expect(outcomeLabel(en, chip)).not.toBe(outcomeLabel(en, { state: "result-observed", evidence: null, action: null }));
    }
  });

  test("a preview never reads as done: the state alone names the chip", () => {
    const done = outcomeChip(outcome({ text: "/cost", created_at: "2026-10-20T10:00:00.000Z", state: "result-observed", evidence: [{ kind: "transcript", at: "2026-10-20T10:00:01.000Z" }] }));
    for (const state of STATES.filter((candidate) => candidate !== "result-observed")) {
      const chip = outcomeChip(outcome({ text: "/cost", created_at: "2026-10-20T10:00:00.000Z", state, preview: "Total cost: $0.42\nTotal duration: 2m" }));
      expect(chip.state).toBe(state);
      expect(chip.evidence).toBeNull();
      expect(outcomeLabel(en, chip)).not.toBe(outcomeLabel(en, done));
    }
  });

  test("names the command a text invoked for the preview's summary", () => {
    expect(outcomeCommand("/btw is this safe?")).toBe("/btw");
    expect(outcomeCommand("Please use $review now")).toBe("$review");
    expect(outcomeCommand("a plain message\nsecond line")).toBe("a plain message");
    expect(outcomeCommand("x".repeat(60))).toBe(`${"x".repeat(39)}…`);
  });
});

describe("noteCatalogChanges", () => {
  test("invalidates once per outcome that changed the catalog, and never for one that did not", () => {
    let calls = 0;
    const noted = new Set<string>();
    const changed = outcome({ id: "a", text: "/plugin install x", created_at: "2026-10-20T10:00:00.000Z", state: "result-observed", catalog_changed: true });
    const plain = outcome({ id: "b", text: "/context", created_at: "2026-10-20T10:00:05.000Z" });
    noteCatalogChanges([changed, plain], noted, () => { calls += 1; });
    expect(calls).toBe(1);
    noteCatalogChanges([changed, plain], noted, () => { calls += 1; });
    expect(calls).toBe(1);
    noteCatalogChanges([plain], noted, () => { calls += 1; });
    expect(calls).toBe(1);
    noteCatalogChanges([{ ...changed, id: "c" }], noted, () => { calls += 1; });
    expect(calls).toBe(2);
  });
});

describe("afterMove", () => {
  const sent = (id: string, text: string, second: number) => outcome({ id, text, created_at: `2026-10-20T10:00:${String(second).padStart(2, "0")}.000Z` });
  const compact = sent("compact", "/compact", 1), clear = sent("clear", "/clear", 3), after = sent("after", "/context", 4);
  const ids = (outcomes: readonly CommandOutcome[]) => outcomes.map((shown) => shown.id);
  /** what ChatView shows for each list polled after the move: the first send found to make it is kept */
  const shown = (lists: readonly (readonly CommandOutcome[])[], held: readonly CommandOutcome[], options: { entered?: string[]; turns?: ConversationTurn[]; seenAt?: string } = {}) => {
    const move = { held, entered: new Set(options.entered ?? []), seenAt: Date.parse(options.seenAt ?? "2026-10-20T10:00:05.000Z") };
    let made: CommandOutcome | null = null;
    return [held, ...lists].map((outcomes) => {
      made ??= moveCommand(outcomes, move);
      return ids(afterMove(outcomes, move, made, options.turns ?? []));
    });
  };

  test("in the list held at the move, leaves out the sends before its newest /clear, /new or /resume, and all of them with none", () => {
    expect(shown([], [after, clear, compact])).toEqual([["after", "clear"]]);
    expect(shown([], [compact, sent("new", "/new", 2), clear])).toEqual([["clear"]]);
    // /clearly is another command
    expect(shown([], [compact, sent("clearly", "/clearly", 2)])).toEqual([[]]);
  });

  test("in a later list, leaves out the sends before the move also when that list brings them first", () => {
    // a /resume sent after the move did not move the chat: the sends before it stay
    expect(shown([[compact, clear], [clear, after, sent("resume", "/resume", 6)]], [])).toEqual([[], ["clear"], ["clear", "after", "resume"]]);
  });

  test("takes the move from a later list that lists it, not from an earlier poll's list without it", () => {
    const done = { ...compact, state: "result-observed" as const };
    expect(shown([[done], [done, clear]], [compact]).at(-1)).toEqual(["clear"]);
  });

  test("does not take a session change sent after the chat saw the move for the move", () => {
    // a /clear typed in the terminal, then /btw and a /resume (its picker cancelled) sent from Chat
    const btw = sent("btw", "/btw hello", 6), resume = sent("resume", "/resume", 8);
    expect(shown([[btw], [btw, resume]], [after])).toEqual([[], ["btw"], ["btw", "resume"]]);
  });

  test("with no move listed (a /clear typed in the terminal), keeps a later list whole: a send to the new conversation shows", () => {
    const later = [{ ...after, state: "result-observed" as const }];
    expect(shown([later], [after])).toEqual([[], ["after"]]);
  });

  test("does not take the session change that brought the chat to the conversation it left for the move out of it", () => {
    expect(shown([], [clear, after], { entered: ["clear"] })).toEqual([[]]);
  });

  test("after a /resume back, keeps the earlier sends whose turns are in the conversation it returned to", () => {
    const context = sent("context", "/context", 1), resume = sent("resume", "/resume", 20);
    const turns = [user("/context", "2026-10-20T10:00:01.000Z")];
    // the /clear that brought the chat to B is the move it already made
    expect(shown([[context, resume]], [clear], { turns, entered: ["clear"], seenAt: "2026-10-20T10:00:21.000Z" }).at(-1)).toEqual(["context", "resume"]);
    // also when the chat held both at the move
    expect(shown([], [context, resume], { turns })).toEqual([["context", "resume"]]);
    // a send to the conversation left, listed first after the move, has no turn here
    expect(shown([[compact, clear]], [], { turns: [] }).at(-1)).toEqual(["clear"]);
  });

  test("after a /clear, a later identical command typed in the new conversation does not take an old send's chip", () => {
    const typed = [user("/compact", "2026-10-20T10:00:05.000Z")];
    expect(shown([[compact, clear]], [], { turns: typed }).at(-1)).toEqual(["clear"]);
  });
});

describe("outcomeRows", () => {
  const earlier = [user("hello", "2026-10-20T09:00:00.000Z"), assistant("hi", "2026-10-20T09:00:05.000Z")];

  test("an outcome without a transcript turn yields one provisional row after the turns before its send", () => {
    const sent = outcome({ text: "/btw is this safe?", created_at: "2026-10-20T10:00:00.000Z", state: "terminal-required" });
    const rows = outcomeRows(earlier, [sent]);
    expect(rows).toEqual([
      { kind: "turn", index: 0, outcome: null },
      { kind: "turn", index: 1, outcome: null },
      { kind: "sent", outcome: sent },
    ]);
    expect(rows.filter((row) => row.outcome === sent)).toHaveLength(1);
  });

  test("a later matching user turn takes the chip and the provisional row goes: never two rows", () => {
    const sent = outcome({ text: "/context", created_at: "2026-10-20T10:00:00.000Z" });
    const before = outcomeRows(earlier, [sent]);
    expect(before.filter((row) => row.kind === "sent")).toHaveLength(1);
    const turns = [...earlier, user("/context", "2026-10-20T10:00:01.000Z"), assistant("Context: 42% used", "2026-10-20T10:00:03.000Z")];
    const after = outcomeRows(turns, [sent]);
    expect(after).toEqual([
      { kind: "turn", index: 0, outcome: null },
      { kind: "turn", index: 1, outcome: null },
      { kind: "turn", index: 2, outcome: sent },
      { kind: "turn", index: 3, outcome: null },
    ]);
    expect(after.filter((row) => row.outcome === sent)).toHaveLength(1);
  });

  test("only a turn after the send time matches, wrapped the same text is the same, and each turn takes one outcome", () => {
    const first = outcome({ id: "first", text: "/compact", created_at: "2026-10-20T10:00:00.000Z" });
    const second = outcome({ id: "second", text: "/compact", created_at: "2026-10-20T10:00:10.000Z" });
    const turns = [
      user("/compact", "2026-10-20T09:59:00.000Z"),
      user("/ compact", "2026-10-20T10:00:01.000Z"),
      user("/compact", "2026-10-20T10:00:11.000Z"),
    ];
    const rows = outcomeRows(turns, [second, first]);
    expect(rows).toEqual([
      { kind: "turn", index: 0, outcome: null },
      { kind: "turn", index: 1, outcome: first },
      { kind: "turn", index: 2, outcome: second },
    ]);
  });

  test("a provisional row sits before the first turn that came after its send, and a turn without a time counts unless a timed turn below it is before the send", () => {
    const sent = outcome({ text: "/btw hi", created_at: "2026-10-20T10:00:00.000Z", state: "terminal-required" });
    const late = outcome({ text: "/model opus", created_at: "2026-10-20T10:00:20.000Z" });
    const turns = [...earlier, user("next question", "2026-10-20T10:00:10.000Z"), user("/model opus", null)];
    expect(outcomeRows(turns, [sent, late])).toEqual([
      { kind: "turn", index: 0, outcome: null },
      { kind: "turn", index: 1, outcome: null },
      { kind: "sent", outcome: sent },
      { kind: "turn", index: 2, outcome: null },
      { kind: "turn", index: 3, outcome: late },
    ]);
  });

  test("a cancelled send the agent put back gets no row, and an outcome older than the loaded page waits for its page", () => {
    const restored = outcome({ text: "/btw hi", created_at: "2026-10-20T10:00:00.000Z" });
    expect(outcomeRows(earlier, [restored], { restored: "/btw hi" })).toEqual([
      { kind: "turn", index: 0, outcome: null },
      { kind: "turn", index: 1, outcome: null },
    ]);
    // only the send put back is cancelled: the latest one; an earlier identical send keeps its receipt
    const done = outcome({ id: "done", text: "/compact", created_at: "2026-10-20T10:00:00.000Z", state: "result-observed", evidence: [{ kind: "transcript", at: "2026-10-20T10:00:03.000Z" }] });
    const cancelled = outcome({ id: "cancelled", text: "/compact", created_at: "2026-10-20T10:05:00.000Z" });
    const turns = [...earlier, user("/compact", "2026-10-20T10:00:01.000Z"), assistant("Compacted.", "2026-10-20T10:00:03.000Z")];
    expect(outcomeRows(turns, [cancelled, done], { restored: "/compact" })).toEqual([
      { kind: "turn", index: 0, outcome: null },
      { kind: "turn", index: 1, outcome: null },
      { kind: "turn", index: 2, outcome: done },
      { kind: "turn", index: 3, outcome: null },
    ]);
    const alone = outcome({ id: "alone", text: "/btw solo", created_at: "2026-10-20T10:06:00.000Z", state: "terminal-required" });
    expect(outcomeRows(turns, [done, cancelled, alone], { restored: "/compact" }).filter((row) => row.outcome !== null).map((row) => row.outcome?.id)).toEqual(["done", "alone"]);
    const old = outcome({ text: "/btw earlier", created_at: "2026-10-20T08:00:00.000Z", state: "terminal-required" });
    expect(outcomeRows(earlier, [old]).filter((row) => row.kind === "sent")).toHaveLength(0);
    expect(outcomeRows(earlier, [old], { beginningLoaded: true })).toEqual([
      { kind: "sent", outcome: old },
      { kind: "turn", index: 0, outcome: null },
      { kind: "turn", index: 1, outcome: null },
    ]);
    expect(outcomeRows([], [old])).toEqual([{ kind: "sent", outcome: old }]);
  });

  test("a bash-mode command sent as `!` takes its chip from the shell turn that records it", () => {
    const sent = outcome({ text: '! echo "Hello"', created_at: "2026-10-20T10:00:00.000Z" });
    const shell: ConversationTurn = { role: "user", ts: "2026-10-20T10:00:01.000Z", parts: [{ kind: "shell", command: 'echo "Hello"', stdout: "Hello", stderr: "" }] };
    expect(outcomeRows([...earlier, shell], [sent]).filter((row) => row.outcome === sent)).toEqual([{ kind: "turn", index: 2, outcome: sent }]);
  });
});

describe("outcomeResultText", () => {
  const at = "2026-10-20T10:00:00.000Z";
  const printed = "Hermes CLI Status\n\nSession ID: fixture\nAgent Running: No";
  const recognized = outcome({ text: "/status", created_at: at, state: "result-observed", evidence: [{ kind: "recognized-result", at }], result_text: printed });

  test("shows a recognized result's text verbatim, line breaks kept, until it is dismissed here", () => {
    expect(outcomeResultText(recognized, false)).toBe(printed);
    expect(outcomeResultText(recognized, true)).toBeNull();
    // dismissing only flips this view's flag: the outcome itself is untouched, so nothing is sent or changed
    expect(recognized.result_text).toBe(printed);
    expect(outcomeChip(recognized)).toEqual({ state: "result-observed", evidence: "recognized-result", action: null });
  });

  test("shows no card without a recognized result, whatever text came along", () => {
    expect(outcomeResultText({ ...recognized, evidence: [{ kind: "transcript", at }] }, false)).toBeNull();
    expect(outcomeResultText({ ...recognized, state: "accepted", evidence: [] }, false)).toBeNull();
    expect(outcomeResultText({ ...recognized, result_text: undefined }, false)).toBeNull();
    expect(outcomeResultText({ ...recognized, result_text: "" }, false)).toBeNull();
  });
});
