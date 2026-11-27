import { describe, expect, it } from "bun:test";
import { agySteeringPending, codexSteeringPending, interruptCodexSteering, type CodexSteeringContext } from "./codex-steering.ts";

const hint = "Messages to be submitted after next tool call (press esc to interrupt and send immediately)";
const frame = (header = hint, composer = "› Ask Codex to do anything") => `› earlier input\n• Working (2s • esc to interrupt)\n• ${header}\n  ↳ send this now\n${composer}\n  gpt-6.1 default · /workspace\n`;
const working: CodexSteeringContext = { agent: "codex", working: true, screen: "• Working (2s • esc to interrupt)\n› send this now\n" };
const pending = { ...working, screen: frame() };

describe("Codex's live steering buffer", () => {
  it("recognizes the native pending-steering panel beside an empty composer", () => {
    expect(codexSteeringPending(frame(), "send this now")).toBe(true);
    expect(codexSteeringPending(frame(hint, "›"), "send this now")).toBe(true);
  });

  it("recognizes a narrow pane's wrapped native hint", () => {
    expect(codexSteeringPending(frame("Messages to be submitted after next tool\ncall (press esc to interrupt and send\nimmediately)"), "send this now")).toBe(true);
  });

  for (const elapsed of ["1m 12s", "1h 2m 3s", "2m"]) it(`recognizes a working turn lasting ${elapsed}`, () => {
    expect(codexSteeringPending(frame().replace("2s • esc", `${elapsed} • esc`), "send this now")).toBe(true);
  });

  for (const [name, screen] of [
    ["quoted hint", `› explain this\n${hint}\n• Working (2s • esc to interrupt)\n› Ask Codex to do anything\n`],
    ["old panel above a newer turn", `${frame()}\n• Working (3s • esc to interrupt)\n› Ask Codex to do anything\n`],
    ["native next-turn queue", frame("Queued follow-up inputs")],
    ["nonempty composer", frame(hint, "› unsent user draft")],
    ["missing pending message", frame().replace("  ↳ send this now\n", "")],
    ["no native working status", frame().replace("• Working (2s • esc to interrupt)\n", "")],
    ["another open UI after the composer", `${frame()}Select Model and Effort\nenter select · esc back\n`],
  ]) it(`does not authorize Escape from ${name}`, () => {
    expect(codexSteeringPending(screen!, "send this now")).toBe(false);
  });
  // Codex 0.162.1, read from a live pane: the shortcuts hint under the composer, a wrapped entry,
  // a multi-line one, and a long one cut with a "…" row
  const live = (entries: string) => `› first task\n• Working (13s • esc to interrupt)\n• ${hint}\n${entries}› Ask Codex to do anything\n  gpt-5.1 default · /tmp/work · ⠇\n  ← for agents · ? for shortcuts                                    ⚠ 1 warning · f2 to view\n`;
  const long = `LLLL ${Array.from({ length: 120 }, (_, i) => `w${i}`).join(" ")}`;

  it("recognizes Codex 0.162's panel above its shortcuts hint", () => {
    expect(codexSteeringPending(live("  ↳ send this now\n"), "send this now")).toBe(true);
  });

  it("recognizes the panel above Codex 0.164's Fast-mode footer", () => {
    const fast = live("  ↳ send this now\n").replace("  gpt-5.1 default · /tmp/work · ⠇", "  gpt-6.1 high fast · ~/work · Fix the flaky test · Main [default]");
    expect(codexSteeringPending(fast, "send this now")).toBe(true);
    expect(codexSteeringPending(fast.replace("high fast ·", "high faster ·"), "send this now")).toBe(false);
  });

  it("matches the submitted message however Codex wrapped or cut it", () => {
    expect(codexSteeringPending(live("  ↳ older entry\n  ↳ second message that wraps around\n    the narrow pane\n"), "second message that wraps around the narrow pane")).toBe(true);
    expect(codexSteeringPending(live("  ↳ line one\n    line two\n"), "line one\nline two")).toBe(true);
    expect(codexSteeringPending(live(`  ↳ LLLL w0 w1 w2\n    w3 w4 w5\n    …\n`), long)).toBe(true);
  });

  it("reads a message whose own second line starts with the arrow", () => {
    // Codex indents continuation rows two deeper than the entry's arrow; an arrow there is text
    expect(codexSteeringPending(live("  ↳ explain\n    ↳ send this now\n"), "explain\n↳ send this now")).toBe(true);
    expect(codexSteeringPending(live("  ↳ explain\n    ↳ send this now\n"), "send this now")).toBe(false);
  });

  it("compares only the steering section's last entry, not a later section's", () => {
    const sections = "  ↳ older steer\n• Messages to be submitted at end of turn\n  ↳ send this now\n";
    expect(codexSteeringPending(live(sections), "send this now")).toBe(false);
    expect(codexSteeringPending(live("  ↳ send this now\n• Messages to be submitted at end of turn\n  ↳ queued for later\n"), "send this now")).toBe(true);
  });

  it("takes a trailing ellipsis for a cut only on its own row", () => {
    expect(codexSteeringPending(live("  ↳ wait…\n"), "wait for tests")).toBe(false);
    expect(codexSteeringPending(live("  ↳ wait…\n"), "wait…")).toBe(true);
    expect(codexSteeringPending(live("  ↳ …\n"), "anything")).toBe(false);
  });

  for (const [name, entries, text] of [
    ["an entry that was already waiting", "  ↳ older entry\n", "send this now"],
    ["an older entry above the newest one", "  ↳ send this now\n  ↳ typed in the terminal\n", "send this now"],
    ["a cut entry of another message", "  ↳ LLLL w0 w1 w9\n    …\n", long],
    ["an empty message", "  ↳ older entry\n", " "],
  ]) it(`does not take ${name} for the submitted message`, () => {
    expect(codexSteeringPending(live(entries!), text!)).toBe(false);
    // and without the shortcuts hint, as Codex 0.161 drew it
    expect(codexSteeringPending(live(entries!).replace(/\n.*for shortcuts.*\n$/, "\n"), text!)).toBe(false);
  });
});

function fixture(contexts: CodexSteeringContext[] = [pending]) {
  let now = 0; let reads = 0;
  const effects: string[] = [];
  const io = {
    read: async () => contexts[Math.min(reads++, contexts.length - 1)]!,
    press: async (key: string, fresh: () => boolean) => { effects.push(fresh() ? key : `${key} withheld`); },
    restarting: () => { effects.push("restart gate"); },
    now: () => now,
    wait: async (ms: number) => { now += ms; },
  };
  return { io, effects, elapsed: () => now, reads: () => reads, advance: (ms: number) => { now += ms; } };
}

describe("explicit Codex Send now", () => {
  it("arms the restart gate before one Escape on a freshly checked native panel", async () => {
    const f = fixture();
    expect(await interruptCodexSteering(true, "send this now", working, f.io)).toBe("unconfirmed");
    expect(f.effects).toEqual(["restart gate", "Escape"]);
    expect(f.reads()).toBe(1);
  });

  it("interrupts Ultra's pending panel with either empty composer form", async () => {
    for (const composer of ["»", "» Ask Codex to do anything"]) {
      const ultra = { ...working, screen: frame(hint, composer).replace("default ·", "ultra ·") };
      const f = fixture([ultra]);
      expect(await interruptCodexSteering(true, "send this now", working, f.io)).toBe("unconfirmed");
      expect(f.effects).toEqual(["restart gate", "Escape"]);
      expect(f.reads()).toBe(1);
    }
  });

  it("does not infer delivery from a panel under the background-terminal status", async () => {
    const background = { ...working, screen: frame().replace(
      "• Working (2s • esc to interrupt)",
      "Working (2s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close",
    ) };
    const f = fixture([background]);
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);

    const unrelated = fixture([{ ...background, screen: background.screen.replace("↳ send this now", "↳ something else") }]);
    await expect(interruptCodexSteering(true, "send this now", working, unrelated.io)).rejects.toThrow("not confirmed");
    expect(unrelated.effects).toEqual([]);
  });

  const liveStatus = "Working (5s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close";
  it.each([liveStatus, "• Working (2s • esc to interrupt)"])("never interrupts an older identical entry under %s", async (status) => {
    const queued = { ...working, screen: frame().replace("• Working (2s • esc to interrupt)", status) };
    const submitted = { ...queued, screen: queued.screen.replace("› Ask Codex to do anything", "› send this now") };
    const f = fixture([queued]);
    await expect(interruptCodexSteering(true, "send this now", submitted, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);
  });
  const liveComposer = "› Ask Codex to do anything\n  GPT-6.2-Sol default · /workspace\n  ← for agents · ? for shortcuts";
  const live = (history: string, composer = liveComposer): CodexSteeringContext => ({
    agent: "codex", working: true, screen: `\n${history}\n\n${liveStatus}\n\n${composer}\n`,
  });

  it("cannot confirm an active-turn message from terminal scrollback alone", async () => {
    const submitted = live("› earlier input", liveComposer.replace("Ask Codex to do anything", "send this now"));
    const f = fixture([live("› earlier input\n\n› send this now")]);
    await expect(interruptCodexSteering(true, "send this now", submitted, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);
  });

  it("does not credit an earlier terminal submission drawn after Chat pressed Enter", async () => {
    const terminalQueue = "• Messages to be submitted at end of turn\n  ↳ repeat\n";
    const submitted = live("› earlier input", terminalQueue + liveComposer.replace("Ask Codex to do anything", "repeat"));
    const f = fixture([live("› earlier input\n\n› repeat", terminalQueue + liveComposer)]);
    await expect(interruptCodexSteering(true, "repeat", submitted, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);
  });

  it("does not confirm the draft or an unchanged earlier occurrence of the same message", async () => {
    const submitted = live("› send this now", liveComposer.replace("Ask Codex to do anything", "send this now"));
    const otherDraft = liveComposer.replace("Ask Codex to do anything", "another draft");
    for (const current of [
      submitted,
      live("› send this now"),
      live("› send this now\n\n  › send this now"),
      live("› send this now\n\n› send this now", otherDraft),
      live("› send this now\n\n› send this now\n\n› send this now"),
    ]) {
      const f = fixture([current]);
      await expect(interruptCodexSteering(true, "send this now", submitted, f.io)).rejects.toThrow("not confirmed");
      expect(f.effects).toEqual([]);
    }
  });

  for (const [name, explicit, context] of [
    ["ordinary Send racing with work", false, working],
    ["another working agent", true, { ...working, agent: "claude" }],
  ] as const) it(`never interrupts ${name}`, async () => {
    const f = fixture(); await interruptCodexSteering(explicit, "send this now", context, f.io);
    expect(f.effects).toEqual([]); expect(f.reads()).toBe(0);
  });

  it("checks after Enter when Codex was idle before it, without interrupting a newly visible turn", async () => {
    const idle = { ...working, working: false };
    const turned = fixture([pending]);
    expect(await interruptCodexSteering(true, "send this now", idle, turned.io)).toBe("unconfirmed");
    expect(turned.effects).toEqual([]);
    expect(turned.reads()).toBe(1);
    const stillIdle = fixture([idle]);
    expect(await interruptCodexSteering(true, "send this now", idle, stillIdle.io)).toBeUndefined();
    expect(stillIdle.effects).toEqual([]);
    expect(stillIdle.reads()).toBe(1);
  });

  it("waits for the native panel instead of appending Escape blindly", async () => {
    const f = fixture([working, pending]);
    expect(await interruptCodexSteering(true, "send this now", working, f.io)).toBe("unconfirmed");
    expect(f.reads()).toBe(2); expect(f.elapsed()).toBeGreaterThan(0);
    expect(f.effects).toEqual(["restart gate", "Escape"]);
  });

  it("does not interrupt a turn that already finished after Enter", async () => {
    const f = fixture([{ ...working, working: false }]);
    expect(await interruptCodexSteering(true, "send this now", working, f.io)).toBe("unconfirmed");
    expect(f.effects).toEqual([]);
    expect(f.reads()).toBe(1);
    expect(f.elapsed()).toBe(0);
  });

  for (const cause of ["disconnected", "read_only", "agent_blocked", "pending_target_changed", "input_not_ready"]) it(`keeps additional input cancelled after ${cause}`, async () => {
    const f = fixture(); f.io.read = async () => { throw new Error(cause); };
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow(cause);
    expect(f.effects).toEqual([]);
  });

  it("does not claim success for working Codex without a recognized pending panel", async () => {
    const f = fixture([{ ...working, screen: frame("Queued follow-up inputs") }]);
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]); expect(f.elapsed()).toBeLessThanOrEqual(1500);
  });

  it("hands the key write a freshness check that fails once the deadline has passed", async () => {
    const f = fixture(); f.io.press = async (key, fresh) => { f.advance(1600); f.effects.push(fresh() ? key : `${key} withheld`); };
    await interruptCodexSteering(true, "send this now", working, f.io);
    expect(f.effects).toEqual(["restart gate", "Escape withheld"]);
  });

  it("checks the deadline again after a slow screen read before sending Escape", async () => {
    const f = fixture(); f.io.read = async () => { f.advance(1501); return working; };
    await expect(interruptCodexSteering(true, "send this now", working, f.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);
  });
});

// agy 1.x as drawn on a 52-column pane: a queued message is cut to one row, the hint on the last one only
const BAR = "─".repeat(52);
const agy = (queued: string[]) => `● Running (sleep 15; echo two) (ctrl+o to expand)\n⣷  Running command...\n${queued.join("\n")}\n${BAR}\n>\n${BAR}\n  Press up to edit queued messages\n`;
const agyWorking: CodexSteeringContext = { agent: "agy", working: true, screen: agy(["▸ send this now (alt+m to send immediately)"]) };

describe("agy's queued messages", () => {
  it("recognizes the message just queued, whole or cut, as the last row above the input box", () => {
    expect(agySteeringPending(agyWorking.screen, "send this now")).toBe(true);
    expect(agySteeringPending(agy(["▸ Now run `sleep 40; echo five` as one tool call,...", "▸ LONGSTEER this is a... (alt+m to send immediately)"]),
      "LONGSTEER this is a deliberately long queued message")).toBe(true);
    // a message that is an ellipsis itself, shown whole
    expect(agySteeringPending(agy(["▸ ... (alt+m to send immediately)"]), "...")).toBe(true);
  });

  for (const [name, screen] of [
    ["another message", agy(["▸ something else (alt+m to send immediately)"])],
    ["an earlier message under this one", agy(["▸ send this now", "▸ something else (alt+m to send immediately)"])],
    ["a hint quoted in the transcript", `▸ send this now (alt+m to send immediately)\nmore output\n${BAR}\n>\n${BAR}\n`],
    ["no queue", agy(["▸ Thought for 8s, 146 tokens"])],
    // cut to nothing on a narrow pane: it could be any message, an earlier one too
    ["a row cut to its dots alone", agy(["▸ ... (alt+m to send immediately)"])],
    ["a row cut to its ellipsis alone", agy(["▸ … (alt+m to send immediately)"])],
    // alt+m is agy's "send with the opposite Queued Messages setting": it would send a draft in the box at once too
    ["a draft in the input box", agy(["▸ send this now (alt+m to send immediately)"]).replace("\n>\n", "\n> half a thought\n")],
    ["a draft over two rows", agy(["▸ send this now (alt+m to send immediately)"]).replace("\n>\n", "\n> half\n  a thought\n")],
    ["a picker's row in place of the input box", agy(["▸ send this now (alt+m to send immediately)"]).replace("\n>\n", "\n> Yes, I trust this folder\n")],
  ] as const) it(`ignores ${name}`, () => expect(agySteeringPending(screen, "send this now")).toBe(false));

  it("sends it now with alt+m, joining the turn at work rather than restarting it", async () => {
    const f = fixture([agyWorking]); await interruptCodexSteering(true, "send this now", agyWorking, f.io);
    expect(f.effects).toEqual(["alt+m"]);
  });

  it("confirms a message agy took straight away, with no queued row, without a key", async () => {
    const f = fixture([{ ...agyWorking, screen: agy(["● Thought for 2s"]) }]);
    await interruptCodexSteering(true, "send this now", agyWorking, f.io);
    expect(f.effects).toEqual([]); expect(f.elapsed()).toBeGreaterThanOrEqual(1500);
  });

  it("never presses alt+m for an ordinary Send or one Codex's panel would take", async () => {
    const f = fixture([agyWorking]); await interruptCodexSteering(false, "send this now", agyWorking, f.io);
    const codex = fixture([agyWorking]);
    await expect(interruptCodexSteering(true, "send this now", working, codex.io)).rejects.toThrow("not confirmed");
    expect(f.effects).toEqual([]);
    expect(codex.effects).toEqual([]);
  });

  // an agent's name is whatever its pane reports (agent-identity.ts reportedAgent): one that names an Object property is no agent here
  for (const agent of ["constructor", "toString", "__proto__"]) it(`presses nothing, and fails nothing, for an agent named ${agent}`, async () => {
    const f = fixture([{ ...agyWorking, agent }]);
    await interruptCodexSteering(true, "send this now", { ...agyWorking, agent }, f.io);
    expect(f.effects).toEqual([]);
  });
});
