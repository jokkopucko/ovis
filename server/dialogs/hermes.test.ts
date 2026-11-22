import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerKeys, parseInteractivePrompt } from "../prompt.ts";
import { paneCommands } from "../commands.ts";
import { HERMES_ECHO_RE, hermesEchoOf } from "./hermes.ts";
import { registry } from "./registry.ts";
import { findLastIndex, publicPrompt } from "./shared.ts";

// Hermes 0.21.5 classic CLI, recorded in an isolated HERMES_HOME at 40 and 120 columns. help-*.txt
// are scrollback reads (its output is taller than the pane); help-120-cut.txt is the visible screen
// after /help, its echo scrolled off. reload-skills-failed-120.txt is reload-skills-120.txt with the
// result replaced by the failure line cli_info_mixin.py prints (locales/en.yaml reload_skills.failed).
const fixture = (name: string): string => readFileSync(join(import.meta.dir, "..", "fixtures", "hermes-results", `${name}.txt`), "utf8");
const lines = (screen: string): string[] => screen.replace(/\r\n/g, "\n").split("\n");
const reader = (id: string) => registry.readersFor("hermes").find((candidate) => candidate.id === id)!;
const parse = (id: string, below: string, sent: string) => reader(id).parse(below, { agent: "hermes", omoAsk: null, omoTrusted: false, omoOpen: [], sent, working: false });
const echoOf = (screen: string, command: string): number => findLastIndex(lines(screen), (line) => HERMES_ECHO_RE.exec(line.trimEnd())?.[1] === command);
const below = (screen: string, command: string): string => lines(screen).slice(echoOf(screen, command) + 1).join("\n");

const CASES = [
  { id: "hermes-status", command: "/status", first: /^Hermes CLI Status$/, last: /^Agent Running: / },
  { id: "hermes-version", command: "/version", first: /^Hermes Agent v/, last: /^Update available/ },
  { id: "hermes-profile", command: "/profile", first: /^Profile: /, last: /^Home: / },
  { id: "hermes-reload-skills", command: "/reload-skills", first: /Reloading skills/, last: /skill\(s\) available$/ },
  { id: "hermes-help", command: "/help", first: /^\+---/, last: /^Paste image: / },
] as const;

describe("Hermes result readers", () => {
  it("registers one result reader per informational command, named by its command's form", () => {
    const results = registry.readersFor("hermes").filter((candidate) => candidate.kind === "result").map((candidate) => candidate.id);
    expect(results.sort()).toEqual(CASES.map(({ id }) => id).sort());
    const rows = paneCommands("hermes", null, "/nonexistent-home");
    for (const { id, command } of CASES) expect(rows.find((row) => `/${row.name}` === command)?.forms).toEqual([{ match: "bare", interaction: "dialog", dialog: id }]);
  });

  for (const width of [40, 120]) {
    for (const { id, command, first, last } of CASES) {
      it(`reads ${command} at ${width} columns whole, as printed, closed with a Dismiss that sends nothing`, () => {
        const screen = fixture(`${command.slice(1)}-${width}`);
        const suffix = below(screen, command);
        const parsed = parse(id, suffix, command)!;
        expect(parsed).not.toBeNull();
        const text = parsed.resultText!;
        expect(suffix.includes(text)).toBeTrue();
        const shown = text.split("\n").map((line) => line.trim());
        expect(first.test(shown[0]!) || shown.some((line) => first.test(line))).toBeTrue();
        expect(last.test(shown.at(-1)!)).toBeTrue();
        expect(parsed.options.map((option) => option.label)).toEqual(["Dismiss"]);
        expect(answerKeys(publicPrompt(parsed), { option_index: 0 })).toEqual([]);
        expect(parse(id, suffix, "/something-else")).toBeNull();
        expect(parse(id, screen, command)).toBeNull();
        expect(parseInteractivePrompt("hermes", screen, null, true, [], command)).toBeNull();
      });
    }
  }

  it("recognizes Hermes's own echo of a command line for the outcome's echo order and boundaries", () => {
    for (const reader of registry.readersFor("hermes").filter((candidate) => candidate.kind === "result")) expect(reader.echoOf).toBe(hermesEchoOf);
    for (const width of [40, 120]) {
      for (const { command } of CASES) {
        const screen = lines(fixture(`${command.slice(1)}-${width}`)).map((line) => line.trimEnd());
        const echoes = screen.filter((line) => hermesEchoOf(line, command));
        expect(echoes.length).toBeGreaterThanOrEqual(1);
        for (const line of screen.filter((candidate) => !candidate.startsWith("⚙"))) {
          const word = /[/$@]\S.*$/u.exec(line)?.[0];
          if (word !== undefined) expect(hermesEchoOf(line, word)).toBeFalse();
        }
      }
    }
    expect(hermesEchoOf("⚙️  /help skills", "/help skills")).toBeTrue();
    expect(hermesEchoOf("⚙️  /status", "/statusbar")).toBeFalse();
    expect(hermesEchoOf("❯ /status", "/status")).toBeFalse();
  });

  it("marks every successful reload as a catalog change and a failed one as none", () => {
    for (const name of ["reload-skills-40", "reload-skills-120", "reload-skills-added-120", "reload-skills-removed-120"]) {
      expect(parse("hermes-reload-skills", below(fixture(name), "/reload-skills"), "/reload-skills")?.catalogChanged).toBeTrue();
    }
    const failed = parse("hermes-reload-skills", below(fixture("reload-skills-failed-120"), "/reload-skills"), "/reload-skills");
    expect(failed?.resultText).toBeDefined();
    expect(failed?.catalogChanged).toBeUndefined();
  });

  it("accepts an idle /version whose update check printed nothing (T24-AV-2)", () => {
    const screen = lines(fixture("version-120")).filter((line) => !line.startsWith("Update available")).join("\n");
    expect(parse("hermes-version", below(screen, "/version"), "/version")?.resultText?.split("\n").at(-1)).toStartWith("OpenAI SDK: ");
    const busy = screen.replace(/^❯ /m, "⠋ ");
    expect(parse("hermes-version", below(busy, "/version"), "/version")).toBeNull();
  });

  it("requires the whole recorded reload layout, not its count alone (T24-AV-3)", () => {
    const all = lines(fixture("reload-skills-120"));
    const echo = echoOf(fixture("reload-skills-120"), "/reload-skills");
    const count = all.findIndex((line, index) => index > echo && line.includes("skill(s) available"));
    const cases = [
      [...all.slice(0, echo + 1), all[count]!, ...all.slice(count + 1)],
      [...all.slice(0, echo + 2), all[count]!, ...all.slice(count + 1)],
      [...all.slice(0, echo + 1), ...all.slice(echo + 2)],
      [...all.slice(0, echo + 2), "  ➕ Added Skills:", all[count]!, ...all.slice(count + 1)],
    ];
    for (const screen of cases.map((case_) => case_.join("\n"))) {
      expect(parse("hermes-reload-skills", below(screen, "/reload-skills"), "/reload-skills")).toBeNull();
    }
  });

  it("requires every findings section to hold its skills, in the recorded order (T24-A2-4)", () => {
    const screen = fixture("reload-skills-added-120");
    const all = lines(screen);
    const echo = echoOf(screen, "/reload-skills");
    const item = all.findIndex((line, index) => index > echo && line.trim().startsWith("- "));
    const variants = [
      [...all.slice(0, item + 1), "  ➖ Removed Skills:", ...all.slice(item + 1)],
      [...all.slice(0, item - 1), "  ➖ Removed Skills:", "      - gone: Removed.", ...all.slice(item - 1)],
      [...all.slice(0, item + 1), "  ➕ Added Skills:", "      - again: Twice.", ...all.slice(item + 1)],
      [...all.slice(0, item + 1), "  something else", ...all.slice(item + 1)],
    ];
    for (const variant of variants.map((lines_) => lines_.join("\n"))) {
      expect(parse("hermes-reload-skills", below(variant, "/reload-skills"), "/reload-skills")).toBeNull();
    }
    const both = [...all.slice(0, item + 1), "  ➖ Removed Skills:", "      - gone: Removed.", ...all.slice(item + 1)].join("\n");
    expect(parse("hermes-reload-skills", below(both, "/reload-skills"), "/reload-skills")?.catalogChanged).toBeTrue();
  });

  it("declines a block that only ends where the text ends, without the idle prompt or a later echo (T24-A3-2)", () => {
    const shown = lines(fixture("version-120"));
    const sdk = shown.findIndex((line) => line.startsWith("OpenAI SDK: "));
    const truncated = shown.slice(echoOf(fixture("version-120"), "/version") + 1, sdk + 1).join("\n");
    expect(parse("hermes-version", truncated, "/version")).toBeNull();
    expect(parse("hermes-version", `${truncated}\n\n⚙️  /profile`, "/version")?.resultText?.split("\n").at(-1)).toStartWith("OpenAI SDK: ");
  });

  it("reads nothing from a result whose start or end is not on screen", () => {
    expect(parse("hermes-help", below(fixture("help-120-cut"), "/help"), "/help")).toBeNull();
    const status = lines(fixture("status-120"));
    const last = findLastIndex(status, (line) => line.startsWith("Agent Running: "));
    const cut = [...status.slice(0, last), ...status.slice(last + 1)].join("\n");
    expect(parse("hermes-status", below(cut, "/status"), "/status")).toBeNull();
    const busy = status.map((line) => line.replace(/^❯ /, "⠋ ")).join("\n");
    expect(parse("hermes-status", below(busy, "/status"), "/status")).toBeNull();
    const renamed = status.map((line) => line === "Hermes CLI Status" ? "Hermes Status" : line).join("\n");
    expect(parse("hermes-status", below(renamed, "/status"), "/status")).toBeNull();
  });
});
