import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { promptTailIsActive } from "./live.ts";
import { registry } from "./registry.ts";
import { KEY, parsedByPublicPrompt } from "./shared.ts";

// Screens of omp 18.8.7's /handoff, recorded in an isolated omp home at 119 and 60 columns.
const screen = (step: string, width: "wide" | "narrow") =>
  readFileSync(new URL(`../fixtures/omp-handoff-18.8.7-${step}-${width}.txt`, import.meta.url), "utf8");
const widths = ["wide", "narrow"] as const;

// omp 18.12.6 with `composer.shape: pi`, recorded at 120 and 60 columns in an isolated omp home with a fake model provider:
// omp's status row sits right under the Ask panel's bottom border while the question waits (#1644)
const ask = (name: string) =>
  readFileSync(new URL(`../fixtures/omp-ask-18.12.6-${name}.txt`, import.meta.url), "utf8");
const STATUS_ROW_RE = /\n ?(?:[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \S+|π) · ⬢ [^\n]*/u;
const card = (screen: string) => {
  const prompt = parseInteractivePrompt("omp", screen);
  return prompt && { kind: prompt.kind, title: prompt.title, question: prompt.question, options: prompt.options, multi_select: prompt.multi_select };
};

describe("omp Ask under omp's status row (#1644)", () => {
  it("keeps the card while the question waits above the status row", () => {
    for (const name of ["single-120", "single-60", "multi-120", "submit-60"]) {
      const shown = ask(name);
      expect(shown, name).toMatch(STATUS_ROW_RE);
      expect(card(shown), name).not.toBeNull();
      expect(card(shown), name).toEqual(card(shown.replace(STATUS_ROW_RE, "")));
    }
    expect(card(ask("single-120"))?.question).toBe("Which route should carry the fictional session?");
    expect(card(ask("multi-120"))).toMatchObject({ question: "Which synthetic targets should be checked?", multi_select: true });
  });

  it("reads a multi-select question whose hint a narrow pane clips inside the cancel label", () => {
    // at 60 columns omp 18.12.6 ends the multi-select hint `⎋ cance…`
    const shown = ask("multi-60");
    expect(shown).toContain("␣ toggle · ⏎ next · ↑/↓ move · ⇥/←/→ question · ⎋ cance…");
    expect(card(shown)).toMatchObject({ question: "Which synthetic targets should be checked?", multi_select: true,
      options: [{ label: "Desktop" }, { label: "Phone" }, { label: "Tablet" }] });
    expect(card(shown)).toEqual(card(shown.replace(STATUS_ROW_RE, "")));
  });

  it("shows no card for an old Ask panel with another, empty box between it and the status row", () => {
    // an answered question can leave its panel on screen while omp draws another box under it
    const box = "\n\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256e\n\u2502        \u2502\n\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f";
    for (const name of ["single-120", "submit-60"]) {
      const shown = ask(name);
      const row = shown.match(STATUS_ROW_RE)![0];
      const old = shown.replace(STATUS_ROW_RE, "").replace(/\n+$/, "") + box;
      expect(parseInteractivePrompt("omp", `${old}${row}\n`), name).toBeNull();
      expect(parseInteractivePrompt("omp", `${old}\n \u03c0 \u00b7 \u2b22 Ask fixture \u00b7 \ud83d\uddd1 \u2026/home/fixture \u00b7 \u25eb 5.7%/131K \u27f2\n`), `${name} at rest`).toBeNull();
    }
  });

  it("shows no card once the panel was answered and later output came above the status row", () => {
    expect(parseInteractivePrompt("omp", ask("settled-60"))).toBeNull();
  });

  it("lets a status row pass only right under the panel's bottom border", () => {
    const shown = ask("single-120");
    const moved = shown.replace(STATUS_ROW_RE, "\n Fixture output after the panel.$&");
    expect(moved).not.toBe(shown);
    expect(parseInteractivePrompt("omp", moved)).toBeNull();
    const unbordered = shown.replace(/\n\u2570\u2500+\u256f(?=\n ?(?:[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f] |\u03c0 ))/u, "");
    expect(unbordered).not.toBe(shown);
    expect(parseInteractivePrompt("omp", unbordered)).toBeNull();
  });
});

// omp 18.14.0's Ask over two questions (multi-select, single-select) and its review, recorded at 119 columns in the isolated
// herdr test session with a fake model provider, in the unicode and the Nerd Font symbol presets (`symbolPreset: nerd`). The
// nerd preset draws the footer's keys and the option markers as Nerd Font icons: `󱁐 toggle · 󰌑 next` (#3282).
const preset = (name: string) =>
  readFileSync(new URL(`../fixtures/omp-ask-18.14.0-${name}.txt`, import.meta.url), "utf8");

describe("omp Ask in the Nerd Font symbol preset (#3282)", () => {
  it("reads each state as the unicode preset's, and answers it with the same keys", () => {
    for (const state of ["multi", "single", "review"]) {
      const nerd = parseInteractivePrompt("omp", preset(`nerd-${state}`));
      const unicode = parseInteractivePrompt("omp", preset(`unicode-${state}`));
      expect(unicode, state).not.toBeNull();
      expect(card(preset(`nerd-${state}`)), state).toEqual(card(preset(`unicode-${state}`)));
      const parsed = parsedByPublicPrompt.get(nerd!)!;
      expect(promptTailIsActive(parsed, preset(`nerd-${state}`)), state).toBe(true);
      expect(promptTailIsActive(parsed, `${preset(`nerd-${state}`).trimEnd()}\n Fixture output after the panel.\n`), state).toBe(false);
    }
    const multi = (name: string) => answerKeys(parseInteractivePrompt("omp", preset(name))!, { option_indices: [0, 2] });
    expect(multi("nerd-multi")).toEqual(multi("unicode-multi"));
    const single = (name: string) => answerKeys(parseInteractivePrompt("omp", preset(name))!, { option_index: 1 });
    expect(single("nerd-single")).toEqual(single("unicode-single"));
    const submit = (name: string) => answerKeys(parseInteractivePrompt("omp", preset(name))!, { option_index: 0 });
    expect(submit("nerd-review")).toEqual(submit("unicode-review"));
    expect(card(preset("nerd-multi"))).toMatchObject({ question: "Which synthetic targets should be checked?", multi_select: true,
      options: [{ label: "Desktop" }, { label: "Phone" }, { label: "Tablet" }] });
  });
});

// omp's tool approval, recorded in an isolated omp home with a fake model provider that runs `bash ls -la`
// (`write` under --approval-mode=always-ask-cached for the grants), at 119 and 57 columns, in each symbol
// preset; the recording's temporary path is replaced by one as long (#2059)
const approval = (name: string) =>
  readFileSync(new URL(`../fixtures/omp-approval-${name}.txt`, import.meta.url), "utf8");
const labels = (prompt: ReturnType<typeof parseInteractivePrompt>) => prompt?.options.map((option) => option.label);
const steps = (prompt: ReturnType<typeof parseInteractivePrompt>, index: number) => answerKeys(prompt!, { option_index: index });
const redraw = (shown: string, match: string, text: string) => shown.split("\n").map((line) => {
  if (!line.includes(match)) return line;
  const drawn = `${line[0]} ${text}`;
  return drawn + " ".repeat(Math.max(1, [...line].length - 1 - [...drawn].length)) + line.at(-1);
}).join("\n");
const hintOf = (shown: string) => shown.split("\n").find((line) => / approve \u00b7 /.test(line))!.slice(2).trim().replace(/[\u2502|]$/, "").trim();

describe("omp tool approval (#2059)", () => {
  it("reads 18.10's panel, whose only keys are in its hint, as Approve and Deny on those keys", () => {
    for (const name of ["18.10.4-unicode-wide", "18.10.4-nerd-wide", "18.10.4-ascii-wide", "18.10.4-unicode-narrow"]) {
      const prompt = parseInteractivePrompt("omp", approval(name));
      expect(prompt, name).toMatchObject({
        kind: "approval", title: "Allow tool: bash", question: "Allow tool: bash", body: "Command: ls -la",
        options: [{ label: "Approve", description: null }, { label: "Deny", description: null }], multi_select: false,
      });
      expect(prompt!.own_text?.labels, name).toEqual({ 0: { key: "Approve" }, 1: { key: "Deny" } });
      // Ctrl+Q over Ctrl+Enter, which a terminal without extended keys cannot send
      expect(steps(prompt, 0), name).toEqual([{ keys: ["ctrl+q"] }]);
      expect(steps(prompt, 1), name).toEqual([{ keys: [KEY.escape] }]);
    }
  });

  it("reads 18.13's menu, with Approve and Deny on their keys and the session row by moving to it", () => {
    for (const name of ["18.13.2-unicode-wide", "18.13.2-nerd-wide", "18.13.2-ascii-wide"]) {
      const prompt = parseInteractivePrompt("omp", approval(name));
      expect(prompt, name).toMatchObject({
        kind: "approval", title: "Allow tool: bash", body: "Command: ls -la",
        options: [{ label: "Approve" }, { label: "Approve bash for this session" }, { label: "Deny" }],
      });
      expect(steps(prompt, 0), name).toEqual([{ keys: ["ctrl+q"] }]);
      expect(steps(prompt, 1), name).toEqual([{ keys: [KEY.down] }, { keys: [KEY.enter] }]);
      expect(steps(prompt, 2), name).toEqual([{ keys: [KEY.escape] }]);
    }
  });

  it("offers 18.13's grants, but not the toggle over them, which answers nothing", () => {
    const shown = approval("18.13.2-unicode-wide-grants");
    // the recording summarizes the written content (`Content: fictional \u2026`): no card, as for any call shown in part
    expect(shown).toContain("\u2502 Path: notes/fixture.txt \u00b7 Content: fictional \u2026 ");
    expect(parseInteractivePrompt("omp", shown)).toBeNull();
    const prompt = parseInteractivePrompt("omp", redraw(shown, "\u2502 Path: notes/fixture.txt ", "Path: notes/fixture.txt"));
    expect(prompt).toMatchObject({ title: "Allow tool: write" });
    expect(prompt!.body!.split("\n")).toEqual([
      "Reason: target not yet approved", "Path: notes/fixture.txt", expect.stringMatching(/^Folder: \/fixture\/.*\/cwd\/notes$/),
    ]);
    expect(labels(prompt)).toEqual([expect.stringMatching(/^Approve Directory: \/fixture\/.*\/notes$/), "Approve File", "Approve Once", "Deny"]);
    expect(steps(prompt, 0)).toEqual([{ keys: [KEY.up] }, { keys: [KEY.up] }, { keys: [KEY.enter] }]);
    expect(steps(prompt, 1)).toEqual([{ keys: [KEY.up] }, { keys: [KEY.enter] }]);
    expect(steps(prompt, 2)).toEqual([{ keys: ["ctrl+q"] }]);
    expect(steps(prompt, 3)).toEqual([{ keys: [KEY.escape] }]);
    // ticked, the toggle keeps a grant across sessions: no card, whatever the grant rows read
    const whole = redraw(shown, "\u2502 Path: notes/fixture.txt ", "Path: notes/fixture.txt");
    for (const box of ["\u2611", "\uf14a"]) {
      const ticked = redraw(whole, "Remember across sessions", `  ${box} Remember across sessions`);
      expect(ticked, box).not.toBe(whole);
      expect(parseInteractivePrompt("omp", ticked), box).toBeNull();
    }
  });

  it("answers Deny by moving to it when a narrow pane cuts 18.13's hint after the approve keys, while the details cannot be scrolling", () => {
    const shown = approval("18.13.2-unicode-narrow");
    expect(shown).toContain("\u2502 \u2191/\u2193 choose \u00b7 \u23ce select \u00b7 Ctrl+\u23ce/Ctrl+Q approve \u00b7 \u238b de\u2026 \u2502");
    const prompt = parseInteractivePrompt("omp", shown);
    expect(labels(prompt)).toEqual(["Approve", "Approve bash for this session", "Deny"]);
    expect(steps(prompt, 0)).toEqual([{ keys: ["ctrl+q"] }]);
    expect(steps(prompt, 1)).toEqual([{ keys: [KEY.down] }, { keys: [KEY.enter] }]);
    expect(steps(prompt, 2)).toEqual([{ keys: [KEY.down] }, { keys: [KEY.down] }, { keys: [KEY.enter] }]);
    // omp takes the approve keys before selecting: unseen, or bound to the select key, a move to Deny could approve
    for (const drawn of ["\u2191/\u2193 choose \u00b7 \u23ce select \u00b7 Ctrl+\u23ce/Ctr\u2026", "\u2191/\u2193 choose \u00b7 \u23ce select \u00b7 \u23ce approve \u00b7 \u238b de\u2026"]) {
      expect(parseInteractivePrompt("omp", redraw(shown, hintOf(shown), drawn)), drawn).toBeNull();
    }
    const command = shown.split("\n").find((line) => line.includes("Command: ls -la"))!;
    const tall = shown.replace(command, Array.from({ length: 8 }, () => command).join("\n"));
    expect(parseInteractivePrompt("omp", tall)).toBeNull();
    expect(parseInteractivePrompt("omp", shown.replace(command, Array.from({ length: 7 }, () => command).join("\n")))).not.toBeNull();
  });

  it("reads the keys as omp draws them on macOS, in keycaps or Nerd Font icons, and a binding of the user's own", () => {
    const shown = approval("18.10.4-nerd-wide");
    const hint = hintOf(shown);
    // the issue's screen (omp 18.10.4 on macOS, Nerd Font preset): \u2303 is \u{f0634}, \u23ce \u{f0311}, \u238b \u{f12b7}, joined by a space
    for (const [drawn, approve, deny] of [
      ["\u{f0634} \u{f0311}/\u{f0634} Q approve \u00b7 \u{f12b7} deny", "ctrl+q", KEY.escape],
      ["\u2303\u23ce/\u2303Q approve \u00b7 \u238b deny", "ctrl+q", KEY.escape],
      ["Ctrl+A approve \u00b7 Ctrl+C deny", "ctrl+a", "ctrl+c"],
    ] as const) {
      const prompt = parseInteractivePrompt("omp", redraw(shown, hint, drawn));
      expect(steps(prompt, 0), drawn).toEqual([{ keys: [approve] }]);
      expect(steps(prompt, 1), drawn).toEqual([{ keys: [deny] }]);
    }
    // 18.10 has no rows to move to: a key a legacy terminal can deliver as another (Ctrl+J/M, Ctrl+\u23ce and \u21e7\u23ce as
    // Enter) answers nothing, or the wrong way when Enter approves; a chord like \u2325\u21e7A may not arrive as drawn
    for (const drawn of [
      "Ctrl+\u23ce approve \u00b7 \u238b deny", "\u2325\u21e7A approve \u00b7 Ctrl+C deny",
      "\u23ce approve \u00b7 Ctrl+J deny", "Ctrl+Q/\u23ce approve \u00b7 Ctrl+M deny",
      "Ctrl+Q approve \u00b7 Ctrl+\u23ce deny", "Ctrl+Q approve \u00b7 \u21e7\u23ce deny", "Ctrl+Q approve \u00b7 Ctrl+I deny",
    ]) {
      expect(parseInteractivePrompt("omp", redraw(shown, hint, drawn)), drawn).toBeNull();
    }
  });

  it("reads 18.13's hint as omp draws it on macOS in Nerd Font icons, and answers Approve by its row without a Ctrl+letter", () => {
    const shown = approval("18.13.2-nerd-wide");
    // \u2303 is \u{f0634} followed by a space, \u23ce \u{f0311}, \u238b \u{f12b7}: Ctrl+O reads `\u{f0634} O`
    const mac = parseInteractivePrompt("omp", redraw(shown, hintOf(shown),
      "\u2191/\u2193 choose \u00b7 \u{f0311} select \u00b7 \u{f0634} \u{f0311}/\u{f0634} Q approve \u00b7 \u{f12b7} deny \u00b7 \u{f0634} O details \u00b7 type to deny and steer"));
    expect(labels(mac)).toEqual(["Approve", "Approve bash for this session", "Deny"]);
    expect(steps(mac, 0)).toEqual([{ keys: ["ctrl+q"] }]);
    expect(steps(mac, 1)).toEqual([{ keys: [KEY.down] }, { keys: [KEY.enter] }]);
    expect(steps(mac, 2)).toEqual([{ keys: [KEY.escape] }]);
    // Ctrl+Enter, or Ctrl+M that a terminal sends as Enter, could take the row under the cursor: Approve is moved to instead
    for (const approve of ["Ctrl+\u23ce", "Ctrl+M"]) {
      const own = parseInteractivePrompt("omp", redraw(approval("18.13.2-unicode-wide"), hintOf(approval("18.13.2-unicode-wide")),
        `\u2191/\u2193 choose \u00b7 \u23ce select \u00b7 ${approve} approve \u00b7 \u238b deny \u00b7 Ctrl+O details \u00b7 type to deny and steer`));
      expect(steps(own, 0), approve).toEqual([{ keys: [KEY.enter] }]);
      expect(steps(own, 2), approve).toEqual([{ keys: [KEY.escape] }]);
    }
    // so is a Deny a legacy terminal delivers as Enter, which would take the highlighted Approve, or as Tab or Backspace
    for (const deny of ["Ctrl+M", "Ctrl+J", "Ctrl+\u23ce", "\u21e7\u23ce", "Ctrl+I", "Ctrl+H"]) {
      const own = parseInteractivePrompt("omp", redraw(approval("18.13.2-unicode-wide"), hintOf(approval("18.13.2-unicode-wide")),
        `\u2191/\u2193 choose \u00b7 \u23ce select \u00b7 Ctrl+Q approve \u00b7 ${deny} deny \u00b7 Ctrl+O details \u00b7 type to deny and steer`));
      expect(steps(own, 0), deny).toEqual([{ keys: ["ctrl+q"] }]);
      expect(steps(own, 2), deny).toEqual([{ keys: [KEY.down] }, { keys: [KEY.down] }, { keys: [KEY.enter] }]);
    }
  });

  it("leaves to the terminal a panel it cannot read in full or a key it cannot send", () => {
    const old = approval("18.10.4-unicode-wide");
    const current = approval("18.13.2-unicode-wide");
    for (const [shown, drawn] of [
      [old, "\u2318\u23ce approve \u00b7 \u238b deny"],
      [old, "Ctrl+PgDn approve \u00b7 \u238b deny"],
      [old, "Ctrl+\u23ce/Ctrl+Q approve \u00b7 \u238b deny \u00b7 \u2191/\u2193 scroll"],
      [old, "Ctrl+\u23ce/Ctrl+Q approve \u00b7 \u238b d\u2026"],
      [old, "Ctrl+Q approve \u00b7 Ctrl+Q deny"],
      [current, "\u23ce deny and send \u00b7 Ctrl+\u23ce/Ctrl+Q approve \u00b7 \u238b deny \u00b7 Ctrl+O details"],
      [current, "\u2191/\u2193 choose \u00b7 \u23ce select \u00b7 Ctrl+\u23ce/Ctrl+Q approve \u00b7 \u238b deny \u00b7 Ctrl+O details \u00b7 PgUp/PgDn scroll \u00b7 type to deny and steer"],
      [current, "j/k choose \u00b7 \u23ce select \u00b7 Ctrl+\u23ce/Ctrl+Q approve \u00b7 \u238b deny"],
      // a move key bound to approve or deny would answer while moving to a row
      [current, "\u2191/\u2193 choose \u00b7 \u23ce select \u00b7 \u23ce approve \u00b7 \u238b deny"],
      [current, "\u2191/\u2193 choose \u00b7 \u23ce select \u00b7 Ctrl+Q approve \u00b7 \u2193 deny"],
      // a select key a legacy terminal delivers as another would answer nothing, or as Enter
      [current, "\u2191/\u2193 choose \u00b7 Ctrl+M select \u00b7 Ctrl+Q approve \u00b7 \u238b deny"],
    ] as const) {
      expect(parseInteractivePrompt("omp", redraw(shown, hintOf(shown), drawn)), drawn).toBeNull();
    }
    expect(parseInteractivePrompt("omp", redraw(current, "\u2502   Deny ", "  Reject"))).toBeNull();
    expect(parseInteractivePrompt("omp", redraw(current, "\u2502 \u276f Approve ", "  Approve"))).toBeNull();
    for (const later of [" Fixture output after the panel.", "\u03c0 Fixture output after the panel.", "x 1s unrelated output"]) {
      expect(parseInteractivePrompt("omp", `${old.trimEnd()}\n${later}\n`), later).toBeNull();
      expect(parseInteractivePrompt("omp", `${current.trimEnd()}\n${later}\n`), later).toBeNull();
    }
  });

  it("shows no card for a call omp cuts or summarizes, which another call could draw the same", () => {
    for (const name of ["18.10.4-unicode-wide", "18.13.2-unicode-wide"]) {
      const shown = approval(name);
      for (const detail of [
        "Command: echo harmless \u2026", "Command: echo harmless \u2026 +1 line in the tool call", "Content: 40 lines in the tool call",
        "Command: echo [\u2026120ch elided\u2026]", `Command: ${"x".repeat(60)}\u2026`,
        // ast_edit names its first rewrite only: 18.13's one row, and 18.10's row of its own
        "Pattern: foo() \u00b7 Replacement: bar() \u00b7 +1 more op \u00b7 Paths: src/app.ts", "+2 more ops",
      ]) {
        expect(parseInteractivePrompt("omp", redraw(shown, "\u2502 Command: ls -la ", detail)), `${name} ${detail}`).toBeNull();
      }
      const other = parseInteractivePrompt("omp", redraw(shown, "\u2502 Command: ls -la ", "Command: rm -r notes"));
      expect(other?.body, name).toBe("Command: rm -r notes");
      expect(other?.id, name).not.toBe(parseInteractivePrompt("omp", shown)?.id);
    }
  });

  it("keeps one card while omp redraws the transcript above the panel", () => {
    // 18.13's bash box ticks its elapsed time on its border while the call waits for approval
    const shown = approval("18.13.2-unicode-wide");
    const box = shown.split("\n").find((line) => /^\u2570\u2500+\u256f$/.test(line))!;
    const ticked = shown.replace(box, `\u2570\u2500\u2500\u2500 elapsed 3.0s ${"\u2500".repeat([...box].length - 19)}\u256f`);
    expect(ticked).not.toBe(shown);
    const id = parseInteractivePrompt("omp", shown)?.id;
    expect(id).toEqual(expect.any(String));
    expect(parseInteractivePrompt("omp", ticked)?.id).toBe(id);
  });

  it("keeps one card while the countdown in the title ticks", () => {
    const shown = approval("18.10.4-unicode-wide");
    const ticked = (seconds: number) => shown.replace(/Allow tool: bash \u2500{7}/, `Allow tool: bash (${seconds}s) \u2500`);
    expect(ticked(29)).not.toBe(shown);
    expect(parseInteractivePrompt("omp", ticked(29))).toMatchObject({ title: "Allow tool: bash" });
    expect(parseInteractivePrompt("omp", ticked(28))?.id).toBe(parseInteractivePrompt("omp", ticked(29))?.id);
  });

  it("keeps the card live while the panel ends the screen, and not once output follows it", () => {
    for (const name of ["18.10.4-unicode-wide", "18.13.2-unicode-wide", "18.13.2-ascii-wide", "18.13.2-unicode-narrow"]) {
      const shown = approval(name);
      const parsed = parsedByPublicPrompt.get(parseInteractivePrompt("omp", shown)!)!;
      expect(promptTailIsActive(parsed, shown), name).toBe(true);
      expect(promptTailIsActive(parsed, `${shown.trimEnd()}\n Fixture output after the panel.\n`), name).toBe(false);
    }
  });
});

// omp 18.13.2 under --approval-mode=always-ask with each built-in `composer.shape` (band is the default, recorded above),
// recorded at 119 columns like the approval screens above; `-minimal` with `statusLine.preset: minimal`, `-ascii` with the
// ascii status line and symbol presets, which draw the frame in `+-|`; `box-narrow` at 59 columns. `box-live` is
// the screen omp drew with a user's own config (`composer.shape: box`), where the card did not show (#2106).
const SHAPES = ["box", "claude", "pi", "borderless", "rule", "field", "rail"] as const;
const shaped = (name: string) => approval(`18.13.2-shape-${name}`);

describe("omp tool approval over each composer shape", () => {
  it("reads the panel over the composer omp mounts under it, in every built-in shape and status-line preset", () => {
    for (const name of [...SHAPES, "band-minimal", "box-minimal", "box-ascii", "claude-ascii", "box-narrow"]) {
      const shown = shaped(name);
      const prompt = parseInteractivePrompt("omp", shown);
      expect(prompt, name).toMatchObject({
        kind: "approval", title: "Allow tool: bash", body: "Command: ls -la",
        options: [{ label: "Approve" }, { label: "Approve bash for this session" }, { label: "Deny" }],
      });
      expect(steps(prompt, 0), name).toEqual([{ keys: ["ctrl+q"] }]);
      expect(steps(prompt, 1), name).toEqual([{ keys: [KEY.down] }, { keys: [KEY.enter] }]);
      expect(steps(prompt, 2), name).toEqual(name === "box-narrow" ? [{ keys: [KEY.down] }, { keys: [KEY.down] }, { keys: [KEY.enter] }] : [{ keys: [KEY.escape] }]);
      const parsed = parsedByPublicPrompt.get(prompt!)!;
      expect(promptTailIsActive(parsed, shown), name).toBe(true);
      expect(promptTailIsActive(parsed, `${shown.trimEnd()}\n Fixture output after the panel.\n`), name).toBe(false);
    }
  });

  it("reads the box and field composers as omp draws them with IME-safe cursor layout", () => {
    // pi-tui editor.ts `#imeSafeCursorLayout`: the box's prompt row stands alone over a whole bottom border, and the
    // field's drops its right cap (omp's source; the recordings' terminal does not ask for it)
    const box = shaped("box");
    const row = box.split("\n").find((line) => /^\u2570\u2500 +\u2500\u256f$/u.test(line))!;
    const imeBox = box.replace(row, `\u2502\n\u2570${"\u2500".repeat([...row].length - 2)}\u256f`);
    const field = shaped("field");
    const cap = field.split("\n").find((line) => /^\u2590 +\u258c$/u.test(line))!;
    const imeField = field.replace(cap, "\u2590");
    for (const [name, shown] of [["box", imeBox], ["field", imeField]] as const) {
      expect(shown, name).not.toBe(shaped(name));
      expect(labels(parseInteractivePrompt("omp", shown)), name).toEqual(["Approve", "Approve bash for this session", "Deny"]);
    }
  });

  it("reads the empty prompt with omp's own cursor in it, and the composer with no status segments", () => {
    // `showHardwareCursor: false`: omp draws `\u258f` (ascii `|`) in the empty prompt (pi-tui editor.ts)
    const cursor: readonly [string, RegExp, string][] = [
      ["band-minimal", /\n\u2570\u2500(\n?)$/u, "\n\u2570\u2500 \u258f$1"], ["box", /\n\u2570\u2500   /u, "\n\u2570\u2500 \u258f "], ["box-ascii", /\n\+-   /u, "\n+- | "],
      ["claude", /\n\u276f\n/u, "\n\u276f \u258f\n"], ["claude-ascii", /\n\u276f\n/u, "\n\u276f |\n"], ["rule", /\n\u276f\n/u, "\n\u276f \u258f\n"],
      ["borderless", /\n\u276f\n/u, "\n\u276f \u258f\n"], ["pi", /(\n\u2500+)\n\n(\u2500+\n)/u, "$1\n \u258f\n$2"], ["field", /\n\u2590  /u, "\n\u2590 \u258f"],
      ["rail", /\n\u258e\n/u, "\n\u258e \u258f\n"],
    ];
    for (const [name, empty, drawn] of cursor) {
      const shown = shaped(name).replace(empty, drawn);
      expect(shown, name).not.toBe(shaped(name));
      expect(labels(parseInteractivePrompt("omp", shown)), name).toEqual(["Approve", "Approve bash for this session", "Deny"]);
    }
    // a custom status line with no segments: omp leaves out the status row and the gap over it, and the band keeps its
    // row empty; a bare `\u276f` (borderless) is also a shell's prompt, so it is left to the terminal
    const statusless = (name: string) => shaped(name).trimEnd().replace(/\n\n?[^\n]*$/u, "\n");
    for (const name of ["claude", "rule", "pi", "field", "rail"]) {
      expect(labels(parseInteractivePrompt("omp", statusless(name))), name).toEqual(["Approve", "Approve bash for this session", "Deny"]);
    }
    expect(labels(parseInteractivePrompt("omp", shaped("band-minimal").replace(/\n[^\n]*(\n\u2570\u2500\n?)$/u, "\n$1")))).toEqual(["Approve", "Approve bash for this session", "Deny"]);
    expect(parseInteractivePrompt("omp", statusless("borderless"))).toBeNull();
    // the band with only a right status group: its gauge rule runs from the left edge to the group's cap
    for (const row of [`${"\u2500".repeat(100)}\u25c0 \u2b22 Shape fixture`, `${"-".repeat(100)}< [M] Shape fixture`]) {
      const shown = shaped("band-minimal").replace(/\n[^\n]*(\n\u2570\u2500\n?)$/u, `\n${row}$1`);
      expect(labels(parseInteractivePrompt("omp", shown)), row).toEqual(["Approve", "Approve bash for this session", "Deny"]);
    }
  });

  it("reads the boxed composer with a user's own status line", () => {
    const shown = approval("18.13.2-box-live");
    expect(shown).toMatch(/\n\u256d\u2500\u2500 .* \u2500\u2500\u256e\n\u2570\u2500 +\u2500\u256f\n/u);
    expect(parseInteractivePrompt("omp", shown)).toMatchObject({
      kind: "approval", title: "Allow tool: bash", body: "Command: ls -la .",
      options: [{ label: "Approve" }, { label: "Approve bash for this session" }, { label: "Deny" }],
    });
  });

  it("leaves to the terminal a draft in the composer, output under it, and a composer omp does not ship", () => {
    const box = shaped("box");
    const prompt = box.split("\n").find((line) => /^\u2570\u2500 +\u2500\u256f$/u.test(line))!;
    // a draft turns the panel's Enter into "deny and send"; omp redraws the hint too, but the composer alone says so
    expect(parseInteractivePrompt("omp", box.replace(prompt, `\u2570\u2500 ls${prompt.slice(5)}`))).toBeNull();
    expect(parseInteractivePrompt("omp", box.replace(prompt, `\u2502  first line${" ".repeat([...prompt].length - 14)}\u2502\n${prompt}`))).toBeNull();
    for (const [name, empty, draft] of [
      ["band-minimal", /\n\u2570\u2500\n?$/u, "\n\u2570\u2500 ls\n"], ["claude", /\n\u276f\n/u, "\n\u276f ls\n"], ["rule", /\n\u276f\n/u, "\n\u276f ls\n"],
      ["borderless", /\n\u276f\n/u, "\n\u276f ls\n"], ["pi", /(\n\u2500+)\n\n(\u2500+\n)/u, "$1\n ls\n$2"], ["field", /\n\u2590( +)\u258c\n/u, "\n\u2590 ls$1\u258c\n"],
      ["rail", /\n\u258e\n/u, "\n\u258e ls\n"],
    ] as const) {
      const shown = shaped(name);
      const drafted = shown.replace(empty, draft);
      expect(drafted, name).not.toBe(shown);
      expect(parseInteractivePrompt("omp", drafted), name).toBeNull();
    }
    for (const name of [...SHAPES, "band-minimal"]) {
      expect(parseInteractivePrompt("omp", `${shaped(name).trimEnd()}\n Fixture output after the composer.\n`), name).toBeNull();
    }
    for (const rows of ["\u2503 \u2b22 Shape fixture\n\u2503", "\u256dcustom-extension\u256e\n\u2570\u2500   \u2500\u256f", "+not a frame\u256e\n\u2570\u2500   \u2500\u256f"]) {
      const other = box.replace(/\n\u256d.*\u256e\n\u2570\u2500 +\u2500\u256f/u, `\n${rows}`);
      expect(other, rows).not.toBe(box);
      expect(parseInteractivePrompt("omp", other), rows).toBeNull();
    }
    // a panel left on screen over another program's lines, shaped like a composer: omp pads its status row's groups,
    // where output starts at the line's first character (`ls -l` there starts with the ascii gauge's `-`)
    const panel = box.trimEnd().split("\n").slice(0, -2).join("\n");
    for (const tail of ["\u276f\nThis is later command output", "fixture@host:~/repo\n\u2570\u2500", "-rw-r--r-- 1 fixture fixture 0 notes\n\u2570\u2500",
      "-rw-r--r--\n\u276f", "-\n\u276f\n-", "-\n\n-"]) {
      expect(parseInteractivePrompt("omp", `${panel}\n${tail}\n`), tail).toBeNull();
    }
  });
});

// omp 18.13.2's Ask with the shapes that keep an empty row over their status bar (pi-tui `bottomBarGap`), at 119 columns
const gapAsk = (shape: string) => readFileSync(new URL(`../fixtures/omp-ask-18.13.2-shape-${shape}.txt`, import.meta.url), "utf8");

describe("omp Ask over a status bar with a gap (#1644)", () => {
  it("keeps the card while the question waits above the gap and the status row", () => {
    for (const shape of ["rule", "field", "rail"]) {
      const shown = gapAsk(shape);
      expect(shown, shape).toMatch(/\u256f\n\n ?(?:[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f] \S+|\u03c0) \u00b7 /u);
      expect(card(shown), shape).toMatchObject({ question: "Which route should carry the fictional session?", options: [{ label: "Local socket" }, { label: "Remote relay" }] });
    }
  });

  it("shows no card once output came between the panel and the status row", () => {
    for (const shape of ["rule", "field", "rail"]) {
      const shown = gapAsk(shape);
      const at = shown.lastIndexOf("\u256f\n\n") + 2;
      const gapped = (rows: string) => shown.slice(0, at) + rows + shown.slice(at + 1);
      expect(gapped("\n"), shape).toBe(shown);
      expect(parseInteractivePrompt("omp", gapped(" Fixture output after the panel.\n")), shape).toBeNull();
      expect(parseInteractivePrompt("omp", gapped("\n\n")), shape).toBeNull();
    }
  });
});

describe("omp /handoff", () => {
  it("reads the generating status, with and without focus instructions, as a card that cancels with Esc", () => {
    for (const width of widths) {
      for (const step of ["generating", "generating-args"]) {
        const prompt = parseInteractivePrompt("omp", screen(step, width));
        expect(prompt, `${step} ${width}`).toMatchObject({
          agent: "omp", kind: "menu", question: "Generating handoff…", options: [{ label: "Cancel", description: null }],
          multi_select: false, custom_option_index: null,
        });
        expect(prompt!.own_text).toEqual({ title: { key: "Handoff" }, labels: { 0: { key: "Cancel" } } });
        expect(answerKeys(prompt!, { option_index: 0 })).toEqual([{ keys: [KEY.escape] }]);
      }
    }
  });

  it("is answered by the omp-handoff reader, which reads the screen again before Esc", () => {
    const reader = registry.readerFor("omp-handoff");
    expect(reader?.reread).toBe("before-commit");
    expect(reader?.parse(screen("generating", "wide"), { agent: "omp", omoAsk: null, omoTrusted: true, omoOpen: [], sent: null, working: false })?.responder).toBe("omp-handoff");
  });

  it("keeps one card while the spinner turns", () => {
    const shown = screen("generating", "wide");
    const turned = shown.replace("⠙ Generating", "⠹ Generating");
    expect(turned).not.toBe(shown);
    expect(parseInteractivePrompt("omp", turned)).not.toBeNull();
    expect(parseInteractivePrompt("omp", turned)?.id).toBe(parseInteractivePrompt("omp", shown)?.id);
  });

  it("shows no card before, after or without a handoff being written", () => {
    for (const width of widths) {
      for (const step of ["empty", "cancelled", "done"]) expect(parseInteractivePrompt("omp", screen(step, width)), `${step} ${width}`).toBeNull();
    }
  });

  it("ignores the status line once anything but omp's status bar and editor follows it", () => {
    const shown = screen("generating", "wide");
    const moved = shown.replace(/(Generating handoff… \(⎋ to cancel\)\n)/, "$1 Fixture answer for the handoff recording.\n");
    expect(moved).not.toBe(shown);
    expect(parseInteractivePrompt("omp", moved)).toBeNull();
  });
});
