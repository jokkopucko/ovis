import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { OPENCODE_SKILL_ACCEPT_KEY, OPENCODE_SKILL_ACCEPT_WAIT_MS, OPENCODE_SKILL_ROW_WAIT_MS, skillAccepted, skillRowSelected, skillTokens, typeWithSkills, type SkillAttachIo } from "./opencode-skill-attach.ts";

const fixture = (width: "narrow" | "wide") => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-skill-${width}.txt`), "utf8");
/** OpenCode 2.0.32 recorded with its colours: three rows (@effect, @effect-two, effect.ts) with one selected, then accepted or closed */
const ansi = (name: "first-selected" | "second-selected" | "third-selected" | "accepted" | "closed") => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-ansi-${name}.ansi`), "utf8");
const narrow = (name: "first-selected" | "accepted") => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-ansi-narrow-${name}.ansi`), "utf8");
const withoutDropdown = (screen: string) => screen.split("\n").filter((line) => !/^ *┃ .* ┃$/u.test(line.replace(/\u001b\[[0-9;:]*m/gu, "").trimEnd())).join("\n");
const AGENT = "                      ┃  Build · MiniMax M3.1 Flash Free OpenCode";
const samePadding = (screen: string) => screen.replaceAll("\u001b[38;2;238;238;238m", "\u001b[38;2;255;255;255m");
const MODEL_ONLY = " \u2503 MiniMax M3.1 Flash Free";
const acceptedTwo = () => ansi("accepted").replace("@effect", "@effect-two");
const typedTwo = (screen: string) => screen.split("\n").map((line) => /┃ {2}@effect$/u.test(line.replace(/\u001b\[[0-9;:]*m/gu, "").trimEnd()) ? line.replace("@effect", "@effect-two") : line).join("\n");
const acceptedVariation = (kind: string) => {
  const screen = ansi("accepted");
  if (kind === "redrawn agent") return screen.replace("Build", " Build ").replace("MiniMax M3.1 Flash Free", "another model");
  if (kind === "bordered content") return `┃ unrelated content ┃\n${screen}`;
  return screen.replace(/\u001b\[1m/gu, "");
};
function reads(screens: (read: number, writes: string[]) => string): SkillAttachIo & { writes: string[] } {
  let read = 0;
  return pane((writes) => screens(read++, writes));
}

function pane(screens: (writes: string[]) => string): SkillAttachIo & { writes: string[] } {
  const writes: string[] = [];
  let clock = 0;
  return {
    writes,
    sendText: async (text) => { writes.push(`text:${text}`); },
    sendKeys: async (keys) => { writes.push(`keys:${keys.join(",")}`); },
    screen: async () => screens(writes),
    wait: async (ms) => { clock += ms; },
    now: () => clock,
  };
}

function simulatedInput(screen: (now: number) => string, afterTab: string, before = ansi("first-selected")): SkillAttachIo & { writes: string[]; input: () => string; entered: () => boolean } {
  let input = "";
  let entered = false;
  const io: SkillAttachIo & { writes: string[] } = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? screen(io.now()) : before);
  return {
    ...io,
    input: () => input,
    entered: () => entered,
    sendText: async (text, guard) => {
      await io.sendText(text, guard);
      input += text.replace(/^\u001b\[200~/u, "").replace(/\u001b\[201~$/u, "");
    },
    sendKeys: async (keys, guard) => {
      await io.sendKeys(keys, guard);
      if (keys.includes(OPENCODE_SKILL_ACCEPT_KEY)) input = afterTab;
      if (keys.includes("Enter")) entered = true;
    },
  };
}

describe("skillRowSelected", () => {
  it.each(["narrow", "wide"] as const)("finds no selection in the recorded %s box of three rows without its colours", (width) => {
    // the first row is not assumed selected: the selection is drawn only in colour
    expect(skillRowSelected(fixture(width), "effect")).toBe(false);
  });

  it("reads the selected row from the recorded screen's colours", () => {
    expect([skillRowSelected(ansi("first-selected"), "effect"), skillRowSelected(ansi("first-selected"), "effect-two")]).toEqual([true, false]);
    expect([skillRowSelected(ansi("second-selected"), "effect"), skillRowSelected(typedTwo(ansi("second-selected")), "effect-two")]).toEqual([false, true]);
    expect([skillRowSelected(ansi("third-selected"), "effect"), skillRowSelected(typedTwo(ansi("third-selected")), "effect-two")]).toEqual([false, false]);
    expect(skillRowSelected(ansi("closed"), "effect")).toBe(false);
  });

  it("reads the selection and the accept the same way in the narrow (40x24) recording", () => {
    const narrow = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `opencode-autocomplete-2.0.32-ansi-narrow-${name}.ansi`), "utf8");
    expect([skillRowSelected(narrow("first-selected"), "effect"), skillRowSelected(narrow("second-selected"), "effect"), skillRowSelected(narrow("third-selected"), "effect")]).toEqual([true, false, false]);
    expect(skillAccepted(narrow("accepted"), "effect", " ┃ MiniMax M3.1 Flash Free")).toBe(true);
    expect(skillAccepted(narrow("closed"), "effect", " ┃ MiniMax M3.1 Flash Free")).toBe(false);
  });

  it("takes a box of a single skill row as selected, with or without colours", () => {
    const single = ansi("first-selected").split("\n").filter((line) => !/@effect-two|effect\.ts/u.test(line.replace(/\u001b\[[0-9;:]*m/gu, ""))).join("\n");
    expect(skillRowSelected(single, "effect")).toBe(true);
    expect(skillRowSelected(single.replace(/\u001b\[[0-9;:]*m/gu, ""), "effect")).toBe(true);
  });

  it.each(["narrow", "wide"] as const)("refuses another id, a prefix, and a box whose first row is another option (%s)", (width) => {
    const screen = fixture(width);
    expect(skillRowSelected(screen, "eff")).toBe(false);
    expect(skillRowSelected(screen, "later")).toBe(false);
    const lines = screen.split("\n");
    const first = lines.findIndex((line) => line.includes("┃ @effect "));
    const second = lines[first + 1]!;
    const swapped = [...lines.slice(0, first), second, lines[first]!, ...lines.slice(first + 2)].join("\n");
    expect(skillRowSelected(swapped, "effect")).toBe(false);
  });

  const mutate = (width: "narrow" | "wide", edit: (lines: string[], row: number) => void): string => {
    const lines = fixture(width).split("\n");
    const row = lines.findIndex((line) => line.includes("┃ @effect "));
    edit(lines, row);
    return lines.join("\n");
  };

  it.each(["narrow", "wide"] as const)("refuses a row of another kind with the same @id (%s)", (width) => {
    // the recorded row ends in the kind label "skill"; a file or agent row names no such kind
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row] = lines[row]!.replace(/skill ┃/u, " file ┃"); }), "effect")).toBe(false);
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row] = lines[row]!.replace(/@effect .* ┃$/u, (match) => `${"@effect file".padEnd(match.length - 2)} ┃`); }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses a box whose rows do not share its right border (%s)", (width) => {
    expect(skillRowSelected(mutate(width, (lines, row) => { lines[row + 1] = `${lines[row + 1]!.trimEnd().slice(0, -1).trimEnd()} ┃`; }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses the box without the recorded input area under it (%s)", (width) => {
    expect(skillRowSelected(mutate(width, (lines, row) => { lines.splice(row + 3, 1); }), "effect")).toBe(false);
    expect(skillRowSelected(mutate(width, (lines) => { for (const [index, line] of lines.entries()) if (line.includes("╹")) lines[index] = ""; }), "effect")).toBe(false);
  });

  it.each(["narrow", "wide"] as const)("refuses a prompt bottom that is not the recorded full-width border (%s)", (width) => {
    expect(skillRowSelected(mutate(width, (lines) => {
      const at = lines.findIndex((line) => line.includes("╹▀"));
      lines[at] = `${lines[at]!.slice(0, lines[at]!.indexOf("╹"))}╹▀`;
    }), "effect")).toBe(false);
  });

  it("refuses a two-line layout that only looks like a box and an input row", () => {
    expect(skillRowSelected("┃ @effect Apply  skill ┃\n┃ @effect", "effect")).toBe(false);
    expect(skillRowSelected("┃ @effect file ┃\n┃\n┃ @effect\n┃\n┃ x\n╹▀▀▀▀", "effect")).toBe(false);
  });

  it("refuses the screen once the box has closed", () => {
    const closed = fixture("wide").split("\n").filter((line) => !/┃.*┃$/u.test(line.trimEnd())).join("\n");
    expect(skillRowSelected(closed, "effect")).toBe(false);
  });
});

describe("skillAccepted", () => {
  it("rejects ordinary input colour after the recorded dropdown closes", () => {
    expect(skillAccepted(withoutDropdown(ansi("first-selected")), "effect", AGENT)).toBe(false);
  });

  it("accepts a styled token after a model-only status row changes", () => {
    const screen = narrow("accepted").replace("MiniMax M3.1 Flash Free", "Another Model");
    expect(skillAccepted(screen, "effect", " ┃ MiniMax M3.1 Flash Free")).toBe(true);
  });

  it("accepts a styled token across a resize during Tab, whichever row names no agent", () => {
    expect(skillAccepted(narrow("accepted"), "effect", AGENT)).toBe(true);
    expect(skillAccepted(ansi("accepted"), "effect", MODEL_ONLY)).toBe(true);
    expect(skillAccepted(ansi("accepted").replace("Build", "Plan "), "effect", AGENT)).toBe(false);
  });

  it.each(["redrawn agent", "bordered content", "no bold"])("recognizes an attached token with %s", (kind) => {
    expect(skillAccepted(acceptedVariation(kind), "effect", AGENT)).toBe(true);
  });

  it("does not accept plain text without bold or token colour", () => {
    expect(skillAccepted(ansi("accepted").replace(/\u001b\[[0-9;:]*m/gu, ""), "effect", AGENT)).toBe(false);
    expect(skillAccepted(ansi("closed").replace(/\u001b\[1m/gu, ""), "effect", AGENT)).toBe(false);
  });
  it("sees an attached skill only as the recorded accept draws it", () => {
    expect(skillAccepted(ansi("accepted"), "effect", AGENT)).toBe(true);
    expect(skillAccepted(ansi("closed"), "effect", AGENT)).toBe(false);
    expect(skillAccepted(ansi("first-selected"), "effect", AGENT)).toBe(false);
    expect(skillAccepted(ansi("accepted").replace("Build", "Plan "), "effect", AGENT)).toBe(false);
  });

  it("finds the attached token after an emoji, which is one cell but two UTF-16 units", () => {
    const bold = "\u001b[1m\u001b[38;2;157;124;216m\u001b[48;2;30;30;30m@effect";
    expect(ansi("accepted").includes(bold)).toBe(true);
    expect(skillAccepted(ansi("accepted").replace(bold, `😀 ${bold}`), "effect", AGENT)).toBe(true);
  });
});

describe("skillTokens", () => {
  it("keeps only known skill ids, in order and once", () => {
    expect(skillTokens("@effect apply it @other and @effect again, mail@effect", ["effect", "review"])).toEqual(["effect"]);
    expect(skillTokens("@review then @effect", ["effect", "review"])).toEqual(["review", "effect"]);
  });
});

describe("typeWithSkills", () => {
  it("refuses another accepted skill when the token wraps after the typed prefix", async () => {
    const before = ansi("first-selected").split("\n").map((line) => /┃ {2}@effect$/u.test(line.replace(/\u001b\[[0-9;:]*m/gu, "").trimEnd()) ? line.replace("@effect", "hello @effect") : line).join("\n");
    const after = acceptedTwo().split("\n").flatMap((line) => /┃ {2}@effect-two$/u.test(line.replace(/\u001b\[[0-9;:]*m/gu, "").trimEnd())
      ? [line.replace(/@effect-two.*$/u, "hello\u001b[0m"), line] : [line]).join("\n");
    const io = simulatedInput(() => after, "hello @effect-two ", before);
    let recorded: Awaited<ReturnType<typeof typeWithSkills>> | undefined;
    const delivery = typeWithSkills("hello @effect go", ["effect"], () => true, io, async () => {}).then(async (result) => {
      recorded = result;
      await io.sendKeys(["Enter"], () => true);
    });
    await expect(delivery).rejects.toMatchObject({ code: "submit_changed" });
    expect(io.input()).toBe("hello @effect-two ");
    expect(recorded).toBeUndefined();
    expect(io.entered()).toBe(false);
  });

  it("refuses another accepted skill whose own name wraps across rows, without bold", async () => {
    const tab = "@effect\u001b[0m\u001b[38;2;238;238;238m\u001b[48;2;30;30;30m \u001b[0m";
    const after = ansi("accepted").replace(/\u001b\[1m/gu, "").split("\n").flatMap((line) => line.includes(tab)
      ? [line.replace(tab, "@effect\u001b[0m\u001b[38;2;255;255;255m\u001b[48;2;30;30;30m \u001b[0m"), line.replace("@effect", "-two")] : [line]).join("\n");
    const io = simulatedInput(() => after, "@effect-two ");
    let recorded: Awaited<ReturnType<typeof typeWithSkills>> | undefined;
    const delivery = typeWithSkills("@effect go", ["effect"], () => true, io, async () => {}).then(async (result) => {
      recorded = result;
      await io.sendKeys(["Enter"], () => true);
    });
    await expect(delivery).rejects.toMatchObject({ code: "submit_changed" });
    expect(io.input()).toBe("@effect-two ");
    expect(recorded).toBeUndefined();
    expect(io.entered()).toBe(false);
  });

  it("ignores an earlier token's space during a partial redraw with input-record parity", async () => {
    const before = ansi("first-selected").split("\n").map((line) => /┃ {2}@effect$/u.test(line.replace(/\u001b\[[0-9;:]*m/gu, "").trimEnd()) ? line.replace("@effect", "@a.ts @effect") : line).join("\n");
    const earlier = ansi("accepted").replace(/\u001b\[1m/gu, "").replace("157;124;216", "238;238;238").replace("@effect", "@a.ts");
    const io = simulatedInput((now) => now === 0 ? earlier : withoutDropdown(before), "@a.ts @effect", before);
    const result = await typeWithSkills("@a.ts @effect go", ["effect"], () => true, io, async () => {});
    expect(result.missed).toEqual(["effect"]);
    expect(io.input()).toBe("@a.ts @effect go");
    expect(result.prompt.map((piece) => "typed" in piece ? piece.typed : piece.pasted).join("")).toBe(io.input());
  });

  it.each(["bold", "no bold"])("refuses a confirmed agent switch with %s styling when input and padding colours match", async (style) => {
    const before = ansi("first-selected").replaceAll("\u001b[38;2;238;238;238m", "\u001b[38;2;255;255;255m");
    const after = ansi("accepted").replaceAll("\u001b[38;2;238;238;238m", "\u001b[38;2;255;255;255m").replace("Build", "Plan ");
    const io = simulatedInput(() => style === "bold" ? after : after.replace(/\u001b\[1m/gu, ""), "@effect ", before);
    let recorded: Awaited<ReturnType<typeof typeWithSkills>> | undefined;
    const delivery = typeWithSkills("@effect go", ["effect"], () => true, io, async () => {}).then(async (result) => {
      recorded = result;
      await io.sendKeys(["Enter"], () => true);
    });
    await expect(delivery).rejects.toMatchObject({ code: "submit_changed" });
    expect(io.input()).toBe("@effect ");
    expect(recorded).toBeUndefined();
    expect(io.entered()).toBe(false);
  });

  it("refuses another accepted skill before recording the prompt or sending the rest and Enter", async () => {
    const io = simulatedInput(() => acceptedTwo(), "@effect-two ");
    let recorded: Awaited<ReturnType<typeof typeWithSkills>> | undefined;
    const delivery = typeWithSkills("@effect go", ["effect"], () => true, io, async () => {}).then(async (result) => {
      recorded = result;
      await io.sendKeys(["Enter"], () => true);
    });
    await expect(delivery).rejects.toMatchObject({ code: "submit_changed" });
    expect(io.input()).toBe("@effect-two ");
    expect(recorded).toBeUndefined();
    expect(io.entered()).toBe(false);
  });

  it("keeps input and record equal when an unconfirmed separator redraw is delayed", async () => {
    const early = withoutDropdown(ansi("first-selected"));
    const settled = ansi("accepted").replace(/\u001b\[1m/gu, "").replace("157;124;216", "238;238;238");
    const io = simulatedInput((now) => now < 200 ? early : settled, "@effect ");
    const result = await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {});
    expect(result.missed).toEqual(["effect"]);
    expect(io.input()).toBe("@effect go");
    expect(result.prompt.map((piece) => "typed" in piece ? piece.typed : piece.pasted).join("")).toBe(io.input());
  });

  it("keeps observed separator evidence through a partial redraw with input-record parity", async () => {
    const spaced = ansi("accepted").replace(/\u001b\[1m/gu, "").replace("157;124;216", "238;238;238");
    const partial = withoutDropdown(ansi("first-selected"));
    const io = simulatedInput((now) => now === 0 ? spaced : partial, "@effect ");
    const result = await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {});
    expect(result.missed).toEqual(["effect"]);
    expect(io.input()).toBe("@effect go");
    expect(result.prompt.map((piece) => "typed" in piece ? piece.typed : piece.pasted).join("")).toBe(io.input());
  });

  it.each(["bold", "no bold"])("records Tab's space with %s skill styling when input and padding colours match", async (style) => {
    const before = ansi("first-selected").replaceAll("\u001b[38;2;238;238;238m", "\u001b[38;2;255;255;255m");
    const after = ansi("accepted").replaceAll("\u001b[38;2;238;238;238m", "\u001b[38;2;255;255;255m");
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? style === "bold" ? after : after.replace(/\u001b\[1m/gu, "") : before);
    expect(await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {})).toEqual({
      attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }, { pasted: "go" }],
    });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`, "text:\u001b[200~go\u001b[201~"]);
  });

  it("ignores a transient agent row that settles back after Tab", async () => {
    const screens = [ansi("accepted").replace("Build", "Plan "), ansi("accepted")];
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? screens.shift() ?? ansi("accepted") : ansi("first-selected"));
    expect(await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {})).toEqual({ attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }, { pasted: "go" }] });
  });

  it.each(["shows first on the deadline read", "shows on a first read that used the whole budget"])("refuses an agent switch that %s, with no remainder or Enter", async (timing) => {
    const plain = withoutDropdown(ansi("first-selected"));
    const switched = plain.replace("Build", "Plan ");
    const io = simulatedInput((now) => now >= OPENCODE_SKILL_ACCEPT_WAIT_MS ? switched : plain, "@effect");
    if (timing !== "shows first on the deadline read") {
      const read = io.screen;
      let spent = false;
      io.screen = async () => {
        if (io.writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) && !spent) { spent = true; await io.wait(OPENCODE_SKILL_ACCEPT_WAIT_MS); }
        return read();
      };
    }
    const delivery = typeWithSkills("@effect go", ["effect"], () => true, io, async () => {}).then(async () => { await io.sendKeys(["Enter"], () => true); });
    await expect(delivery).rejects.toMatchObject({ code: "submit_changed", message: expect.stringContaining(JSON.stringify("Plan")) });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`]);
    expect(io.entered()).toBe(false);
  });

  it("stops at the first confirmed agent change before typing later skill tokens", async () => {
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? ansi("accepted").replace("Build", "Plan ") : ansi("first-selected"));
    await expect(typeWithSkills("@effect @effect-two go", ["effect", "effect-two"], () => true, io, async () => {})).rejects.toMatchObject({ code: "submit_changed" });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`]);
  });

  it("refuses a confirmed agent switch when the token stayed plain", async () => {
    const after = withoutDropdown(ansi("first-selected")).replace("Build", "Plan ");
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? after : ansi("first-selected"));
    await expect(typeWithSkills("@effect go", ["effect"], () => true, io, async () => {})).rejects.toMatchObject({ code: "submit_changed" });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`]);
  });

  it.each([["wide", "narrow"], ["narrow", "wide"]] as const)("records a skill attached when the pane resizes from %s to %s during Tab", async (from, to) => {
    const before = from === "wide" ? ansi("first-selected") : narrow("first-selected");
    const after = to === "wide" ? ansi("accepted") : narrow("accepted");
    const io = simulatedInput(() => after, "@effect ", before);
    const result = await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {});
    expect(result).toEqual({ attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }, { pasted: "go" }] });
    expect(io.input()).toBe("@effect go");
  });

  it.each(["settles on the other agent", "stays model-only until the deadline"])("refuses a switch seen after Tab that a model-only redraw hides and then %s", async (kind) => {
    const switched = ansi("accepted").replace("Build", "Plan ");
    const io = simulatedInput((now) => now === 0 || kind === "settles on the other agent" && now >= 100 ? switched : narrow("accepted"), "@effect ");
    const delivery = typeWithSkills("@effect go", ["effect"], () => true, io, async () => {}).then(async () => { await io.sendKeys(["Enter"], () => true); });
    await expect(delivery).rejects.toMatchObject({ code: "submit_changed", message: expect.stringContaining(JSON.stringify("Plan")) });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`]);
    expect(io.entered()).toBe(false);
  });

  it("refuses a switch that shows only after a first model-only read", async () => {
    const io = simulatedInput((now) => now === 0 ? narrow("accepted") : ansi("accepted").replace("Build", "Plan "), "@effect ");
    const delivery = typeWithSkills("@effect go", ["effect"], () => true, io, async () => {}).then(async () => { await io.sendKeys(["Enter"], () => true); });
    await expect(delivery).rejects.toMatchObject({ code: "submit_changed", message: expect.stringContaining(JSON.stringify("Plan")) });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`]);
    expect(io.entered()).toBe(false);
  });

  it("accepts after a transient other agent is named back before a model-only redraw", async () => {
    const screens = [ansi("accepted").replace("Build", "Plan "), withoutDropdown(ansi("first-selected")), narrow("accepted")];
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? screens.shift() ?? narrow("accepted") : ansi("first-selected"));
    expect(await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {})).toEqual({ attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }, { pasted: "go" }] });
  });

  it("keeps input and record equal when a narrow redraw drops the agent and input matches the padding colour", async () => {
    const io = simulatedInput(() => samePadding(narrow("accepted")), "@effect ", samePadding(ansi("first-selected")));
    const result = await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {});
    expect(result.attached).toEqual(["effect"]);
    expect(io.input()).toBe("@effect go");
    expect(result.prompt.map((piece) => "typed" in piece ? piece.typed : piece.pasted).join("")).toBe(io.input());
  });

  it("types Tab's padding-coloured space once when a model-only wait ends on a blank redraw", async () => {
    const io = simulatedInput((now) => now >= OPENCODE_SKILL_ACCEPT_WAIT_MS ? "" : samePadding(narrow("accepted")), "@effect ", samePadding(ansi("first-selected")));
    const result = await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {});
    expect(io.input()).toBe("@effect go");
    expect(result.prompt.map((piece) => "typed" in piece ? piece.typed : piece.pasted).join("")).toBe(io.input());
  });

  it("does not record a model-only redraw as an agent switch after attachment", async () => {
    const after = narrow("accepted").replace("MiniMax M3.1 Flash Free", "Another Model");
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? after : narrow("first-selected"));
    const result = await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {});
    expect(result).toEqual({ attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }, { pasted: "go" }] });
  });

  it.each(["blank redraw", "open dropdown", "plain token", "input space"])("delivers the rest as plain text after an unconfirmed Tab with %s", async (kind) => {
    const screen = kind === "blank redraw" ? "" : kind === "open dropdown" ? ansi("first-selected")
      : kind === "plain token" ? withoutDropdown(ansi("first-selected"))
      : ansi("accepted").replace(/\u001b\[1m/gu, "").replace("157;124;216", "238;238;238");
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? screen : ansi("first-selected"));
    const result = await typeWithSkills("@effect go", ["effect"], () => true, io, async () => {});
    const inserted = kind === "input space";
    expect(result).toEqual({ attached: [], missed: ["effect"], prompt: [{ typed: inserted ? "@effect " : "@effect" }, { pasted: inserted ? "go" : " go" }] });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`, `text:\u001b[200~${inserted ? "" : " "}go\u001b[201~`]);
  });

  it.each(["redrawn agent", "bordered content", "no bold"])("records the inserted space exactly once with %s", async (kind) => {
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? acceptedVariation(kind) : ansi("first-selected"));
    const result = await typeWithSkills("@effect", ["effect"], () => true, io, async () => {});
    expect(result).toMatchObject({ attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }] });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`]);
  });

  it("refuses a confirmed agent switch even with a styled token and visible separator", async () => {
    const io = pane((writes) => writes.includes(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`) ? ansi("accepted").replace("Build", "Plan ") : ansi("first-selected"));
    await expect(typeWithSkills("@effect go", ["effect"], () => true, io, async () => {})).rejects.toMatchObject({ code: "submit_changed" });
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`]);
  });
  it("types the token, accepts its recognized row with the recorded key, then types the rest once", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? ansi("first-selected") : writes.at(-1) === `keys:${OPENCODE_SKILL_ACCEPT_KEY}` ? ansi("accepted") : "");
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toEqual({ attached: ["effect"], missed: [], prompt: [{ typed: "@effect " }, { pasted: "apply it" }] });
    // the accepted row inserts its own space
    expect(io.writes).toEqual(["text:@effect", `keys:${OPENCODE_SKILL_ACCEPT_KEY}`, "text:\u001b[200~apply it\u001b[201~"]);
  });

  it("leaves an unrecognized token as plain text after the wait, closing the box with the text's own space", async () => {
    const io = pane(() => "");
    expect(await typeWithSkills("please @effect apply it", ["effect"], () => true, io, async () => {})).toEqual({ attached: [], missed: ["effect"], prompt: [{ pasted: "please " }, { typed: "@effect" }, { pasted: " apply it" }] });
    expect(io.writes).toEqual(["text:\u001b[200~please \u001b[201~", "text:@effect", "text:\u001b[200~ apply it\u001b[201~"]);
    expect(io.now()).toBeGreaterThanOrEqual(OPENCODE_SKILL_ROW_WAIT_MS);
  });

  it("closes a trailing @file mention after an attached skill with a space, as the paste path does", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? ansi("first-selected") : writes.at(-1) === `keys:${OPENCODE_SKILL_ACCEPT_KEY}` ? ansi("accepted") : "");
    const { prompt } = await typeWithSkills("@effect see @src/app.ts", ["effect"], () => true, io, async () => {});
    expect(io.writes.at(-1)).toBe("text:\u001b[200~see @src/app.ts \u001b[201~");
    expect(prompt.at(-1)).toEqual({ pasted: "see @src/app.ts " });
  });

  it("adds a space after a trailing unrecognized token, so Enter cannot take the box", async () => {
    const io = pane(() => "");
    await typeWithSkills("run @effect", ["effect"], () => true, io, async () => {});
    expect(io.writes.at(-1)).toBe("text: ");
  });

  it("sends no key when the box closed between recognising the row and the key, and the skill goes as plain text", async () => {
    const io = reads((read) => read === 0 ? ansi("first-selected") : ansi("closed"));
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toMatchObject({ attached: [], missed: ["effect"] });
    expect(io.writes).not.toContain(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`);
  });

  it("sends no key when another row became selected before the key", async () => {
    const io = reads((read) => read === 0 ? ansi("first-selected") : ansi("second-selected"));
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toMatchObject({ attached: [], missed: ["effect"] });
    expect(io.writes).not.toContain(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`);
  });

  it("accepts a selected skill row that is not the first, and records it from the screen after the key", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect-two" ? typedTwo(ansi("second-selected")) : writes.at(-1) === `keys:${OPENCODE_SKILL_ACCEPT_KEY}` ? acceptedTwo() : "");
    expect(await typeWithSkills("@effect-two go", ["effect-two"], () => true, io, async () => {})).toMatchObject({ attached: ["effect-two"], missed: [] });
    expect(io.writes).toContain(`keys:${OPENCODE_SKILL_ACCEPT_KEY}`);
  });

  it("records a skill as not attached when the screen after the key does not show it attached", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? ansi("first-selected") : writes.at(-1) === `keys:${OPENCODE_SKILL_ACCEPT_KEY}` ? withoutDropdown(ansi("first-selected")) : "");
    expect(await typeWithSkills("@effect apply it", ["effect"], () => true, io, async () => {})).toMatchObject({ attached: [], missed: ["effect"] });
  });

  it("re-checks before every write, and stops typing at the first refused check", async () => {
    const io = pane((writes) => writes.at(-1) === "text:@effect" ? ansi("first-selected") : "");
    let checks = 0;
    const revalidate = async () => { if (++checks === 2) throw Object.assign(new Error("changed"), { code: "pending_target_changed" }); };
    await expect(typeWithSkills("@effect apply it", ["effect"], () => true, io, revalidate)).rejects.toMatchObject({ code: "pending_target_changed" });
    expect(io.writes).toEqual(["text:@effect"]);
  });

  it("types nothing when the first check refuses", async () => {
    const io = pane(() => fixture("wide"));
    await expect(typeWithSkills("please @effect", ["effect"], () => true, io, async () => { throw new Error("session changed"); })).rejects.toThrow("session changed");
    expect(io.writes).toEqual([]);
  });

  it("writes nothing once the sender may no longer type", async () => {
    const io = pane(() => fixture("wide"));
    await expect(typeWithSkills("@effect apply it", ["effect"], () => false, io, async () => {})).rejects.toMatchObject({ code: "cancelled" });
    expect(io.writes).toEqual([]);
  });
});
