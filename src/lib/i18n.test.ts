import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JA, JA_PARTS } from "./i18n.ja.ts";
import { KO, KO_PARTS } from "./i18n.ko.ts";
import { ZH, ZH_PARTS } from "./i18n.zh.ts";
import { resolveLanguage, translate } from "./i18n.ts";

const root = join(import.meta.dir, "..");

/**
 * Every string literal in the first argument of a `t(…)` / `tt(…)` call in the client, ternaries
 * included (`t(open ? "Hide" : "Show")`). A key built any other way is not allowed: label maps
 * are listed below instead.
 */
function keysInCode(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root })) {
    // the dictionaries: i18n.ko.ts and the like, and the parts in lib/i18n/
    if (file.endsWith(".test.ts") || /i18n\.\w+\.ts$/.test(file) || /^lib[\\/]i18n[\\/]/.test(file)) continue;
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(/(?<![\w.])(?:t|tt)\(/g)) {
      const firstArg = firstArgument(text, match.index + match[0].length);
      for (const literal of firstArg.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        // a literal a condition compares against (`kind === "here" ? …`) is not shown to anyone
        if (/[=!]==?\s*$/.test(firstArg.slice(0, literal.index))) continue;
        const key = literal[1]!.replace(/\\"/g, '"').replace(/\\'/g, "'");
        found.set(key, [...(found.get(key) ?? []), file]);
      }
    }
  }
  return found;
}

/** The text of a call's first argument: up to the first comma or the closing paren at depth zero, strings and nesting respected. */
function firstArgument(text: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) return text.slice(from, i); depth -= 1; }
    else if (ch === "," && depth === 0) return text.slice(from, i);
  }
  return text.slice(from);
}

/** Label maps the UI translates at the display site (`t(MAP[x])`): their values are keys too, used in the map's file. */
function labelMapUses(): [key: string, file: string][] {
  const grab = (file: string, name: string, valuePattern: RegExp): [string, string][] => {
    const text = readFileSync(join(root, file), "utf8");
    const start = text.indexOf(`const ${name}`);
    if (start < 0) throw new Error(`${name} not found in ${file}`);
    const end = Math.min(...["\n};", "\n];", "\n] as const;"].map((closer) => text.indexOf(closer, start)).filter((at) => at > 0));
    return [...text.slice(start, end).matchAll(valuePattern)].flatMap((m) => m.slice(1).filter((v): v is string => v !== undefined).map((key): [string, string] => [key, file]));
  };
  const value = /^\s+\w+: "([^"]*)",?$/gm;
  return [
    ...grab("lib/status.ts", "STATUS_WORD", value),
    ...grab("components/MachineSidebar.tsx", "STATE_WORD", value),
    ...grab("components/Composer.tsx", "SOURCE_LABEL", value),
    ...grab("components/DevicesPanel.tsx", "VIA", value),
    ...grab("components/SettingsDialog.tsx", "THEME_NAMES", /^\s+"?[\w-]+"?: "([^"]*)",?$/gm),
    ...grab("components/KeyBar.tsx", "ARROWS", /label: "([^"]+)"/g),
    ...grab("components/KeyBar.tsx", "KEY_SPOKEN_NAMES", /label: "([^"]+)"/g),
    ...grab("lib/shortcuts.ts", "SHORTCUTS", /label: "([^"]+)"/g),
    ...grab("lib/bridgeProgress.ts", "STAGES", /label: "([^"]+)"/g),
    ...grab("lib/updateProgress.ts", "STEPS", /label: "([^"]+)"/g),
    ...grab("lib/workBlocks.ts", "CATEGORY_LABEL", /\["([^"]+)", "([^"]+)"\]/g),
    ...grab("lib/usage.ts", "WINDOW_LABEL", value),
    ...grab("lib/toolVerbs.ts", "VERB_LABEL", value),
    // the card text the bridge writes itself, which PromptCard shows by its key (lib/promptText.ts)
    ...grab("../shared/card-text.ts", "CARD_TEXT", /^\s+"([^"]+)",$/gm).map(([key, file]): [string, string] => [key.replaceAll("\\n", "\n"), file]),
  ];
}

const DICTIONARIES = { Korean: KO, Japanese: JA, Chinese: ZH };

describe.each(Object.entries(DICTIONARIES))("%s dictionary", (_name, dictionary) => {
  const inCode = keysInCode();
  const keys = new Set([...inCode.keys(), ...labelMapUses().map(([key]) => key)]);

  it("has every string the code asks for", () => {
    const missing = [...keys].filter((key) => !(key in dictionary)).sort();
    expect(missing).toEqual([]);
  });

  it("keeps no entry the code no longer uses", () => {
    const stale = Object.keys(dictionary).filter((key) => !keys.has(key)).sort();
    expect(stale).toEqual([]);
  });

  it("keeps every placeholder of the English in the translation", () => {
    const broken = Object.entries(dictionary).filter(([en, text]) => {
      const want = [...en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const have = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      return want.join() !== have.join();
    }).map(([en]) => en);
    expect(broken).toEqual([]);
  });

  it("is not just the English repeated", () => {
    // names and key caps read the same in every language; Chinese UIs leave "Shell" and "Agent" in English;
    // theme brand names stay as their projects write them (the color words Amber and Charcoal are translated),
    // and so does Claude Code's own term Ultracode
    const themeNames = ["Codex", "Catppuccin", "Catppuccin Latte", "Tokyo Night", "Tokyo Night Day", "Gruvbox", "Gruvbox Light", "One Dark", "One Light", "Solarized", "Solarized Light", "Kanagawa", "Kanagawa Lotus", "Rosé Pine", "Rosé Pine Dawn", "Dracula", "Nord", "Vesper"];
    const sameOnPurpose = new Set(["PC {name}", "Control C", "Control D", "Control Z", "Shift Tab", "Enter", "Shell", "Agent", "Ultracode", ...themeNames]);
    const same = Object.entries(dictionary).filter(([en, text]) => en === text && /[a-z]{3}/i.test(en) && !sameOnPurpose.has(en));
    expect(same.map(([en]) => en)).toEqual([]);
  });
});

/** Each part's files: a part holds the keys that only its files use (CONTRIBUTING.md, UI text). */
const PART_FILES: Record<string, string[]> = {
  settings: ["components/SettingsDialog.tsx", "components/KeyBarSettings.tsx", "lib/paletteSettings.ts", "components/TelemetryControls.tsx", "components/SettingsControls.tsx"],
  terminal: ["components/PaneTerminal.tsx", "lib/useTerminalMount.ts", "lib/useComposerSends.ts", "lib/usePeekReturn.ts", "lib/useTypedKeys.ts", "components/PaneCanvas.tsx", "components/KeyBar.tsx", "components/FindBar.tsx", "components/TerminalViewportTools.tsx", "components/SplitDropPreview.tsx", "components/TabStrip.tsx", "lib/terminalLabel.ts", "lib/tabName.ts"],
  composer: ["components/Composer.tsx", "components/ReplyComments.tsx", "components/ComposerNotices.tsx", "components/VoiceInput.tsx", "components/SecretInput.tsx", "components/TerminalInput.tsx", "components/PendingMessages.tsx", "lib/compose.ts", "components/PromptCard.tsx", "lib/promptAnswer.ts", "../shared/card-text.ts"],
  chat: ["components/ChatView.tsx", "components/Markdown.tsx", "components/MermaidLightbox.tsx", "components/ChatMinimap.tsx", "components/ImageLightbox.tsx", "components/BackgroundTasks.tsx", "components/BackgroundAgentDetail.tsx", "components/MarkdownLinkMenu.tsx", "lib/workBlocks.ts", "lib/toolVerbs.ts", "lib/outcomeChip.ts", "lib/chatTimestamp.ts", "lib/chatReadDeadline.ts"],
  sidebar: ["components/Sidebar.tsx", "components/AgentSidebar.tsx", "components/SidebarResizer.tsx"],
  machines: ["components/MachineSidebar.tsx", "components/MachineDialog.tsx", "lib/bridgeProgress.ts"],
  workspace: ["components/NewSessionDialog.tsx", "components/WorktreeDialog.tsx", "components/DirectoryBrowser.tsx", "components/RecentFolderChips.tsx", "components/SessionHistory.tsx", "lib/sessionHistory.ts", "lib/useAgentSkills.ts"],
  files: ["components/FileViewer.tsx", "components/FilesDialog.tsx", "components/FileReader.tsx", "components/TextFileView.tsx", "components/FilePathLink.tsx", "components/FilePanelResizer.tsx", "components/HighlightedCode.tsx", "components/RepoDiffViewer.tsx", "components/RepoChanges.tsx", "components/RepoDiff.tsx", "lib/repoDiff.ts", "components/WebPanel.tsx"],
  devices: ["components/DevicesPanel.tsx", "components/PhonePanel.tsx", "components/PortalPanel.tsx", "components/PushTestControls.tsx", "components/AccessGate.tsx", "components/LanExposureNotice.tsx", "components/DevicePairedNotice.tsx", "lib/install.ts"],
  usage: ["components/UsageSettings.tsx", "components/UsageAccountDialog.tsx", "components/UsageLocalLogin.tsx", "components/UsageHubConnect.tsx", "components/CLIProxyLogin.tsx", "components/UsageMeters.tsx", "lib/usage.ts"],
  updates: ["components/UpdateControls.tsx", "lib/updateProgress.ts"],
  palette: ["components/CommandPalette.tsx"],
};

/** Parts in src/lib/i18n/ hold the keys only one feature uses; the base dictionary holds the rest. */
const PARTS = { Korean: [KO, KO_PARTS], Japanese: [JA, JA_PARTS], Chinese: [ZH, ZH_PARTS] } as const;

describe("dictionary parts", () => {
  it.each(Object.entries(PARTS))("%s keeps each key in one part", (_name, [dictionary, parts]) => {
    // the dictionary is the parts spread together, and a spread keeps only the last copy of a key
    const seen = new Map<string, string>();
    const twice = Object.entries(parts).flatMap(([part, entries]) => Object.keys(entries).flatMap((key) => {
      const first = seen.get(key);
      seen.set(key, part);
      return first === undefined ? [] : [`${key} (${first}, ${part})`];
    }));
    expect(twice).toEqual([]);
    expect(Object.keys(dictionary).length).toBe(seen.size);
  });

  it("puts each key in the same part in every language", () => {
    const placement = (parts: Record<string, Record<string, string>>) => Object.fromEntries(Object.entries(parts).map(([part, entries]) => [part, Object.keys(entries).sort()]));
    expect(placement(JA_PARTS)).toEqual(placement(KO_PARTS));
    expect(placement(ZH_PARTS)).toEqual(placement(KO_PARTS));
  });

  it("keeps a key in a part when only that part's files use it, and in the base otherwise", () => {
    const uses = new Map<string, Set<string>>();
    const use = (key: string, file: string) => uses.set(key, new Set([...(uses.get(key) ?? []), file.replaceAll("\\", "/")]));
    for (const [key, files] of keysInCode()) for (const file of files) use(key, file);
    for (const [key, file] of labelMapUses()) use(key, file);
    const owner = (key: string) => Object.entries(PART_FILES).find(([, own]) => [...uses.get(key)!].every((file) => own.includes(file)))?.[0] ?? "base";
    const misplaced = Object.entries(KO_PARTS).flatMap(([part, entries]) => Object.keys(entries).filter((key) => owner(key) !== part).map((key) => `${key} (in ${part}, belongs in ${owner(key)})`));
    expect(misplaced).toEqual([]);
    expect(Object.keys(KO_PARTS).filter((part) => part !== "base" && !(part in PART_FILES))).toEqual([]);
  });

  it("keeps each part file at 400 lines or fewer", () => {
    const long = [...new Bun.Glob("lib/i18n/*.ts").scanSync({ cwd: root })].filter((file) => readFileSync(join(root, file), "utf8").split("\n").length > 400);
    expect(long).toEqual([]);
  });
});

describe("translate", () => {
  it("fills placeholders, falls back to English, and leaves unknown placeholders alone", () => {
    expect(translate("en", "Worked for {duration}", { duration: "7s" })).toBe("Worked for 7s");
    expect(translate("ko", "Worked for {duration}", { duration: "7초" })).toBe(KO["Worked for {duration}"]!.replace("{duration}", "7초"));
    expect(translate("ko", "not a key", { x: 1 })).toBe("not a key");
    expect(translate("ja", "Settings")).toBe(JA["Settings"]!);
    expect(translate("zh", "Settings")).toBe(ZH["Settings"]!);
    expect(translate("en", "{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });

  it("follows the browser only when asked to", () => {
    expect(resolveLanguage("system", ["ko-KR", "en-US"])).toBe("ko");
    expect(resolveLanguage("system", ["en-US", "ko"])).toBe("en");
    expect(resolveLanguage("system", ["en-US"])).toBe("en");
    expect(resolveLanguage("system", [])).toBe("en");
    expect(resolveLanguage("en", ["ko-KR"])).toBe("en");
    expect(resolveLanguage("ko", ["en-US"])).toBe("ko");
    expect(resolveLanguage("system", ["ja-JP"])).toBe("ja");
    expect(resolveLanguage("system", ["en-US", "zh-CN", "ko"])).toBe("en");
    expect(resolveLanguage("system", ["zh-TW"])).toBe("zh");
    expect(resolveLanguage("ja", ["zh-CN"])).toBe("ja");
  });

  it("respects English priority regardless of region or later preferences", () => {
    expect(resolveLanguage("system", ["en-US", "ja-JP"])).toBe("en");
    expect(resolveLanguage("system", ["en-JP", "ja-JP"])).toBe("en");
    expect(resolveLanguage("system", ["EN", "ja-JP"])).toBe("en");
    expect(resolveLanguage("system", ["ja-JP", "en-US"])).toBe("ja");
    expect(resolveLanguage("system", ["zh-TW", "en-US"])).toBe("zh");
  });

  it("skips unsupported languages and falls back to English when none match", () => {
    expect(resolveLanguage("system", ["fr-FR", "en-US", "ja-JP"])).toBe("en");
    expect(resolveLanguage("system", ["fr-FR", "ja-JP", "en-US"])).toBe("ja");
    expect(resolveLanguage("system", ["fr-FR", "de-DE"])).toBe("en");
    expect(resolveLanguage("system", ["tr-TR", "en-US"])).toBe("en");
    expect(resolveLanguage("system", ["tr-TR"])).toBe("en");
  });
});
