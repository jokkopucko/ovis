import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerKeys, parseFallbackPrompt, parseInteractivePrompt } from "../prompt.ts";
import { registry } from "./registry.ts";

// Hermes 0.21.5's classic CLI asking to run `rm -rf ./scratch` (and longer commands), read off isolated herdr panes
// in an isolated HERMES_HOME: once-120 and once-38 on panes 120 and 38 columns wide; long-38 a command over 70 characters,
// which adds Show full command, and long-cursor-38 the same with the cursor moved down a row; cut-38 a command
// too long for the panel, and expanded-38 the same once Show full command was chosen; compact-15-rows a pane 15 rows
// high, which drops the blank rows, and compact-14-rows one row less, which drops the description too; tall-41 a
// pane a phone attached to, taller than Hermes needs, with the rows to spare blank under the panel.
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", "hermes-approval", `${name}.txt`), "utf8");
const card = (screen: string) => parseInteractivePrompt("hermes", screen);
const ALL = ["Allow once", "Allow for this session", "Add to permanent allowlist", "Deny"];
const rowOf = (screen: string, label: string): string => screen.split("\n").find((line) => line.includes(`. ${label} `))!;
const swapRow = (screen: string, from: string, to: string): string => screen.split("\n").map((line) => {
  if (!line.startsWith("│ ") || !line.includes(from)) return line;
  const inner = [...line].length - 4;
  return `│ ${line.slice(2, -2).trimEnd().replace(from, to).padEnd(inner)} │`;
}).join("\n");

describe("Hermes's dangerous-command approval", () => {
  it.each(["once-120", "once-38", "compact-15-rows", "tall-41"])("reads %s as the panel draws it, answered with its own arrows and Enter", (name) => {
    const prompt = card(fixture(name))!;
    expect(prompt).not.toBeNull();
    expect(prompt.kind).toBe("approval");
    expect(prompt.fallback).toBeUndefined();
    expect(prompt.title).toBe("Dangerous Command");
    expect(prompt.question).toBe("recursive delete");
    expect(prompt.body).toBe("rm -rf ./scratch");
    expect(prompt.options.map((option) => option.label)).toEqual(ALL);
    expect(prompt.custom_option_index).toBeNull();
    // never a digit, which picks and confirms at once
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
  });

  it("still reads the panel while Hermes hides its rules and status bar for a moment after a resize", () => {
    const shown = fixture("once-120").split("\n").filter((line) => !/^─{8,}$/u.test(line) && !line.startsWith(" ☤ ")).join("\n");
    expect(card(shown)?.body).toBe("rm -rf ./scratch");
  });

  it("keeps a long command's lines as they wrap, and leaves Show full command off the card", () => {
    const prompt = card(fixture("long-38"))!;
    expect(prompt.body).toBe("rm -rf ./scratch/build-\nartifacts-from-the-previous-\nrelease ./scratch/nightly-cache");
    expect(prompt.options.map((option) => option.label)).toEqual(ALL);
    const moved = card(fixture("long-cursor-38"))!;
    expect(moved.id).toBe(prompt.id);
    expect(answerKeys(moved, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    expect(answerKeys(moved, { option_index: 1 })).toEqual([{ keys: ["enter"] }]);
  });

  it("reads the whole command once Show full command has drawn it, the cursor left on Deny", () => {
    const prompt = card(fixture("expanded-38"))!;
    expect(prompt.body!.split("\n")).toHaveLength(6);
    expect(prompt.body!.endsWith("output ./scratch/sixth")).toBe(true);
    expect(prompt.options.map((option) => option.label)).toEqual(ALL);
    expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["enter"] }]);
    expect(answerKeys(prompt, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["up"] }, { keys: ["up"] }, { keys: ["enter"] }]);
  });

  it("reads the shorter menus Hermes offers, in its own order", () => {
    // cli_modal_mixin.py _approval_choices: no permanent allowlist, or (a Smart DENY overridden, a gate that asks
    // every time) once and deny alone; derived from once-120 by taking rows out and numbering the rest
    const screen = fixture("once-120");
    const without = (labels: string[]) => labels.reduce((shown, label) => shown.replace(`${rowOf(shown, label)}\n`, ""), screen)
      .replace("  3. Deny", "  2. Deny").replace("  4. Deny", "  3. Deny");
    expect(card(without(["Add to permanent allowlist"]))?.options.map((option) => option.label)).toEqual(["Allow once", "Allow for this session", "Deny"]);
    const two = without(["Add to permanent allowlist", "Allow for this session"]).replace("  3. Deny", "  2. Deny");
    expect(card(two)?.options.map((option) => option.label)).toEqual(["Allow once", "Deny"]);
    expect(card(without(["Allow once"]).replace("│   2. Allow for", "│ ❯ 1. Allow for").replace("  3. Add", "  2. Add"))).toBeNull();
  });

  it("leaves a panel that cuts or drops what it shows to the terminal, with no card at all", () => {
    const screen = fixture("once-120");
    const words: [string, string][] = [["Dangerous Command", "Comando peligroso"], ["Allow once", "Permitir una vez"],
      ["Allow for this session", "Permitir durante esta sesión"], ["Add to permanent allowlist", "Permitir siempre (lista permanente)"], ["Deny", "Denegar"]];
    const spanish = words.reduce((shown, [from, to]) => swapRow(shown, from, to), screen)
      .replace(/^ {2}↑\/↓ to select, Enter to confirm.*$/mu, "  ↑/↓ para seleccionar, Enter para confirmar  (3593s)");
    const cases: [string, string][] = [
      ["cut-38", fixture("cut-38")],
      ["command truncated", swapRow(screen, "rm -rf ./scratch", "… (command truncated — use /logs or")],
      ["description truncated", swapRow(screen, "recursive delete", "… (description truncated)")],
      ["compact-14-rows", fixture("compact-14-rows")],
      ["no description", screen.replace(/│ +│\n│ recursive delete +│\n/u, "")],
      // Hermes in another language (locales/es.yaml), and a pane too narrow for the hint
      ["Spanish", spanish],
      ["hint cut", screen.replace(/^ {2}↑\/↓ to select, Enter to confirm.*$/mu, "  ↑/↓ to select, Enter to con")],
    ];
    for (const [name, shown] of cases) {
      expect([name, card(shown)]).toEqual([name, null]);
      // nor the generic card, whose Enter would take the row under the cursor
      expect([name, registry.waits("hermes", shown)]).toEqual([name, true]);
    }
  });

  it("reads nothing from a box out of line, a clipped panel or a menu it does not know", () => {
    const screen = fixture("once-120");
    const lines = screen.split("\n");
    const top = lines.findIndex((line) => line.startsWith("╭"));
    const variants: [string, string][] = [
      // a row one column short: a command with a newline or a tab breaks the box
      ["row out of line", screen.replace("│ rm -rf ./scratch                               │", "│ rm -rf ./scratch                              │")],
      ["top border clipped", [...lines.slice(0, top), ...lines.slice(top + 1)].join("\n")],
      ["two cursors", screen.replace("│   2. Allow for this session", "│ ❯ 2. Allow for this session")],
      ["no cursor", screen.replace("│ ❯ 1. Allow once", "│   1. Allow once")],
      ["another language", swapRow(screen, "Allow once", "Permitir una vez")],
      ["another title", swapRow(screen, "Dangerous Command", "Dangerous Commands")],
      ["a numbering gap", screen.replace("  3. Add to", "  5. Add to")],
    ];
    for (const [name, shown] of variants) expect([name, card(shown)]).toEqual([name, null]);
  });

  it("reads the panel only while it holds Hermes's input, with only Hermes's own lines under it", () => {
    const screen = fixture("once-120");
    const variants: [string, string][] = [
      ["answered", screen.replace(/^⚠ ❯$/mu, "❯ ")],
      ["text typed into the input", screen.replace(/^⚠ ❯$/mu, "⚠ ❯ hello")],
      ["no hint", screen.replace(/^ {2}↑\/↓ to select, Enter to confirm.*$/mu, "  something else")],
      ["a line under the hint", screen.replace(/^( ☤ fixture-model)/mu, "  ▸ subagent: tidy\n$1")],
      ["lines over the hint", screen.replace(/^( {2}💻 rm -rf)/mu, "  one\n  two\n  three\n$1")],
      ["a forged spinner", screen.replace(/^ {2}💻 rm -rf \.\/scratch {2}\(.*\)$/mu, "  X forged output  (1)")],
      ["one line under the panel", (() => {
        const lines = screen.split("\n");
        let bottom = lines.length - 1;
        while (bottom >= 0 && !/^╰─+╯$/u.test(lines[bottom]!)) bottom -= 1;
        return [...lines.slice(0, bottom + 1), "ATTACKER OUTPUT", ...lines.slice(bottom + 1)].join("\n");
      })()],
      ["output under the input", `${screen.trimEnd()}\n$ `],
    ];
    for (const [name, shown] of variants) expect([name, card(shown)]).toEqual([name, null]);
    expect(registry.waits("hermes", variants[0]![1])).toBe(false);
    // a draft in the input: the arrows may move through it instead, so no card, and no generic one either
    expect(registry.waits("hermes", variants[1]![1])).toBe(true);
    expect(registry.waits("hermes", screen.replace(/^⚠ ❯$/mu, "⚠ draft"))).toBe(true);
    expect(parseInteractivePrompt("codex", screen)).toBeNull();
    expect(registry.waits("codex", screen)).toBe(false);
  });

  // Hermes 0.23.0, recorded the same way: its default "modern" layout draws the same panel, but under it the hint, the
  // rule over the input with the spinner, the tool and the user's last prompt in it, the input, then the status bar last
  // (modern-*); its classic layout keeps 0.21.5's order (classic-0.23-once-120). Paths in them are scrubbed.
  describe("in Hermes 0.23's default modern layout", () => {
    it.each(["modern-once-120", "modern-once-38", "modern-once-41", "modern-compact-15-rows", "classic-0.23-once-120"])("reads %s as the panel draws it", (name) => {
      const prompt = card(fixture(name))!;
      expect(prompt?.kind).toBe("approval");
      expect(prompt.fallback).toBeUndefined();
      expect([prompt.title, prompt.question, prompt.body]).toEqual(["Dangerous Command", "recursive delete", "rm -rf ./scratch"]);
      expect(prompt.options.map((option) => option.label)).toEqual(ALL);
      expect(answerKeys(prompt, { option_index: 3 })).toEqual([{ keys: ["down"] }, { keys: ["down"] }, { keys: ["down"] }, { keys: ["enter"] }]);
    });

    it("keeps one card while the countdown, spinner and timers tick and the cursor moves", () => {
      const prompt = card(fixture("modern-once-120"))!;
      expect(card(fixture("modern-once-120-tick"))!.id).toBe(prompt.id);
      const moved = card(fixture("modern-cursor-120"))!;
      expect(moved.id).toBe(prompt.id);
      expect(answerKeys(moved, { option_index: 0 })).toEqual([{ keys: ["up"] }, { keys: ["enter"] }]);
    });

    it("keeps a wrapped command's lines, reads the expanded one, and the once-and-deny menu", () => {
      expect(card(fixture("modern-long-38"))!.body).toBe("rm -rf ./scratch/build-\nartifacts-from-the-previous-\nrelease ./scratch/nightly-cache");
      expect(card(fixture("modern-long-cursor-38"))!.id).toBe(card(fixture("modern-long-38"))!.id);
      const expanded = card(fixture("modern-expanded-38"))!;
      expect(expanded.body).toBe(["first", "second", "third", "fourth", "fifth", "sixth"]
        .map((nth, index) => `${index === 0 ? "rm -rf" : "output"} ./scratch/${nth}-build-`).join("\n") + "\noutput");
      expect(answerKeys(expanded, { option_index: 3 })).toEqual([{ keys: ["enter"] }]);
      expect(card(fixture("modern-once-deny-120"))!.options.map((option) => option.label)).toEqual(["Allow once", "Deny"]);
    });

    it("leaves a cut panel to the terminal with no card at all, and an answered one alone", () => {
      for (const name of ["modern-cut-38", "modern-compact-14-rows"]) {
        expect([name, card(fixture(name))]).toEqual([name, null]);
        expect([name, registry.waits("hermes", fixture(name))]).toEqual([name, true]);
      }
      expect(card(fixture("modern-after-deny-120"))).toBeNull();
      expect(registry.waits("hermes", fixture("modern-after-deny-120"))).toBe(false);
    });

    it("reads nothing with anything but Hermes's own lines under the panel", () => {
      const screen = fixture("modern-once-120");
      const variants: [string, string][] = [
        ["a line between the hint and the rule", screen.replace(/^(── [\u2800-\u28FF] )/mu, "  ▸ subagent: tidy\n$1")],
        ["a plain line for the spinner rule", screen.replace(/^── [\u2800-\u28FF] .*$/mu, "  something else")],
        ["output under the status bar", `${screen.trimEnd()}\n$ `],
        ["text typed into the input", screen.replace(/^⚠ ❯$/mu, "⚠ ❯ hello")],
      ];
      for (const [name, shown] of variants) expect([name, card(shown)]).toEqual([name, null]);
      expect(registry.waits("hermes", variants[3]![1])).toBe(true);
    });

    it("reads no menu from a command whose wrapped rows look like choices", () => {
      // a command padded so it wraps into rows that read "1. Allow once" / "❯ 2. Deny": taken as the menu, a card's Deny
      // would press Enter on Hermes's own cursor, on Allow once
      const screen = fixture("modern-compact-15-rows");
      const forged = screen.replace(/^│ rm -rf \.\/scratch( +)│$/mu, (_row, pad: string) => {
        const width = "rm -rf ./scratch".length + pad.length;
        return ["rm -rf ./x", "  1. Allow once", "❯ 2. Deny"].map((text) => `│ ${text.padEnd(width)}│`).join("\n");
      });
      expect(forged).not.toBe(screen);
      expect(card(forged)).toBeNull();
      expect(registry.waits("hermes", forged)).toBe(true);
    });

    it("keeps the generic card away while a draft typed into the held input wraps onto more lines", () => {
      const screen = fixture("modern-once-38");
      const wrapped = screen.replace(/^⚠$/mu, "⚠ a draft long enough to wrap onto\nanother line of the input");
      expect(wrapped).not.toBe(screen);
      expect(card(wrapped)).toBeNull();
      expect(registry.waits("hermes", wrapped)).toBe(true);
      const long = screen.replace(/^⚠$/mu, ["⚠ a long draft", ...Array.from({ length: 14 }, (_, row) => `row ${row}`), "", "the last row"].join("\n"));
      expect(registry.waits("hermes", long)).toBe(true);
    });

  });

  it("is what the generic card would have offered as raw keys before (#857)", () => {
    expect(parseFallbackPrompt("hermes", fixture("once-120")).options.map((option) => option.label)).toEqual(["↑", "↓", "Enter", "Esc"]);
    expect(card(fixture("once-120"))?.fallback).toBeUndefined();
  });
});
