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
    ...grab("../shared/portal.ts", "PORTAL_AUTH_PROBLEMS", value),
    ...grab("components/SettingsDialog.tsx", "THEME_NAMES", /^\s+"?[\w-]+"?: "([^"]*)",?$/gm),
    ...grab("components/SettingsDialog.tsx", "HERDR_ACTION_LABELS", value),
    ...grab("lib/herdrWindow.ts", "HERDR_WINDOW_CHOICES", /descriptionKey: "([^"]+)"/g),
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

// a Ready PC is one the directory lists, not one anything is linked to: its state word claims no connection
describe.each([["Korean", KO, /연결|접속/], ["Japanese", JA, /接続/], ["Chinese", ZH, /连接/]] as const)("%s Ready wording", (_name, dictionary, connected) => {
  it.each(["Ready", "Ready · not in the account yet"])("does not say connected in %p", (key) => {
    expect(dictionary[key]).toBeString();
    expect(dictionary[key]).not.toMatch(connected);
  });
});

/**
 * One word per state: a composed state label reuses the standalone word verbatim, so the strip, the
 * filter, the attention list, the map legend and a row never name one state two ways.
 */
describe.each(Object.entries(DICTIONARIES))("%s state words", (_name, dictionary) => {
  it.each([
    ["Ready", "Ready · not in the account yet"],
    ["Offline", "Offline · {when}"],
    ["Offline", "{name} is offline"],
    ["Not checked", "Paired · not checked"],
  ])("reuses the %p word inside %p", (word, composed) => {
    expect(dictionary[composed]).toBeString();
    expect(dictionary[composed]).toContain(dictionary[word]!);
  });
});

/**
 * One update word for the whole update journey: the state words, the relay failure title and every
 * step of updating a PC use the word `Needs update` uses, never its synonym.
 */
describe.each([["Korean", KO, ["업데이트", "갱신"]], ["Japanese", JA, ["アップデート", "更新"]], ["Chinese", ZH, ["更新", "升级"]]] as const)("%s update journey", (_name, dictionary, synonyms) => {
  it("names the update with one word", () => {
    const term = synonyms.find((word) => dictionary["Needs update"]?.includes(word));
    expect(term).toBeString();
    const journey = [
      "Updating",
      "Update needed",
      "Update Ovis on {name}",
      "Update it from here: the PC installs the latest release and restarts Ovis, then this app reconnects.",
      "Update now",
      "Its Ovis does not update itself. On the PC, run the installer:",
      "Asking the PC to update…",
      "The update did not finish.",
      "{name} and this app speak different versions of the relay protocol. Update Ovis on the PC, then try again.",
    ];
    const mixed = journey.filter((key) => !dictionary[key]?.includes(term!) || synonyms.some((word) => word !== term && dictionary[key]!.includes(word)));
    expect(mixed).toEqual([]);
  });
});

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
    const sameOnPurpose = new Set(["PC {name}", "CPU", "CPU {value}", "Control C", "Control D", "Control Z", "Shift Tab", "Enter", "Shell", "Agent", "Ultracode", ...themeNames]);
    const same = Object.entries(dictionary).filter(([en, text]) => en === text && /[a-z]{3}/i.test(en) && !sameOnPurpose.has(en));
    expect(same.map(([en]) => en)).toEqual([]);
  });
});

/** Each part's files: a part holds the keys that only its files use (CONTRIBUTING.md, UI text). */
const PART_FILES: Record<string, string[]> = {
  settings: ["components/SettingsDialog.tsx", "lib/herdrWindow.ts", "components/SignOutRow.tsx", "components/KeyBarSettings.tsx", "lib/paletteSettings.ts", "components/TelemetryControls.tsx", "components/SettingsControls.tsx", "components/AlertWebhookGroup.tsx"],
  terminal: ["components/PaneTerminal.tsx", "lib/useTerminalMount.ts", "lib/useComposerSends.ts", "lib/usePeekReturn.ts", "lib/useTypedKeys.ts", "components/PaneCanvas.tsx", "components/KeyBar.tsx", "components/FindBar.tsx", "components/TerminalViewportTools.tsx", "components/SplitDropPreview.tsx", "components/TabStrip.tsx", "lib/terminalLabel.ts", "lib/tabName.ts"],
  composer: ["components/Composer.tsx", "components/ReplyComments.tsx", "components/ComposerNotices.tsx", "components/VoiceInput.tsx", "components/SecretInput.tsx", "components/TerminalInput.tsx", "components/PendingMessages.tsx", "lib/compose.ts", "components/PromptCard.tsx", "lib/promptAnswer.ts", "../shared/card-text.ts"],
  chat: ["components/ChatView.tsx", "lib/chatImages.ts", "components/SentWaiting.tsx", "components/Markdown.tsx", "components/MermaidLightbox.tsx", "components/ChatMinimap.tsx", "components/ImageLightbox.tsx", "components/BackgroundTasks.tsx", "components/BackgroundAgentDetail.tsx", "components/Artifacts.tsx", "components/OmpBtw.tsx", "components/MarkdownLinkMenu.tsx", "lib/workBlocks.ts", "lib/toolVerbs.ts", "lib/outcomeChip.ts", "lib/chatTimestamp.ts", "lib/chatReadDeadline.ts", "components/ConversationSearch.tsx"],
  sidebar: ["components/Sidebar.tsx", "components/AgentSidebar.tsx", "components/SidebarResizer.tsx", "components/SidebarSplit.tsx", "components/FoldHelpersRow.tsx"],
  machines: ["components/MachineSidebar.tsx", "components/MachineDialog.tsx", "components/FoundHerdrChoices.tsx", "lib/bridgeProgress.ts", "components/MachineStats.tsx", "lib/systemReport.ts"],
  workspace: ["components/NewSessionDialog.tsx", "components/WorktreeDialog.tsx", "components/DirectoryBrowser.tsx", "components/RecentFolderChips.tsx", "components/SessionHistory.tsx", "lib/sessionHistory.ts", "lib/useAgentSkills.ts"],
  files: ["lib/fileFailure.ts", "components/FileViewer.tsx", "components/RelayRenderedPage.tsx", "components/FilesDialog.tsx", "components/FileReader.tsx", "components/TextFileView.tsx", "components/TextFileEditor.tsx", "components/FilePathLink.tsx", "components/FilePanelResizer.tsx", "components/HighlightedCode.tsx", "components/RepoDiffViewer.tsx", "components/RepoChanges.tsx", "components/RepoDiff.tsx", "lib/repoDiff.ts", "lib/diffLineNotes.ts", "components/WebPanel.tsx", "components/PullRequestPanel.tsx", "lib/pullRequest.ts", "components/FileTextSizeRow.tsx", "components/FilesPanelRow.tsx", "components/MarkdownDocuments.tsx", "components/MarkdownOutline.tsx"],
  devices: ["components/DevicesPanel.tsx", "components/ConnectPhoneDialog.tsx", "components/RelaySignIn.tsx", "components/CompactPair.tsx", "components/PhonePanel.tsx", "components/PortalPanel.tsx", "components/RelayPanel.tsx", "components/RelayNotice.tsx", "components/PortalAuth.tsx", "components/PortalInvite.tsx", "components/PushTestControls.tsx", "components/AccessGate.tsx", "components/LanExposureNotice.tsx", "components/DevicePairedNotice.tsx", "components/InstallHint.tsx", "lib/install.ts", "lib/installHint.ts", "lib/portalAuth.ts", "../shared/portal.ts"],
  usage: ["components/UsageAccountDialog.tsx", "components/UsageSignInDialog.tsx", "components/UsageLocalLogin.tsx", "components/UsageHubConnect.tsx", "components/CLIProxyLogin.tsx", "components/UsageMeters.tsx", "components/UsageRemoveAccount.tsx", "lib/usage.ts"],
  updates: ["components/UpdateControls.tsx", "lib/updateProgress.ts"],
  palette: ["components/CommandPalette.tsx"],
  setup: ["components/AgentSetupCard.tsx", "components/AddAgentPanel.tsx", "components/AgentTile.tsx", "components/AgentsSettings.tsx"],
  guide: ["components/SetupGuide.tsx"],
  relay: ["components/RelayShell.tsx", "components/RelayShellScreens.tsx", "components/AccountPcs.tsx", "lib/relay/shell.tsx", "lib/relay/accountController.ts", "components/relayFailureText.ts"],
  dashboard: ["components/AddPcSheet.tsx", "components/RelayDashboard.tsx", "components/RelayMap.tsx", "components/RelayPcTable.tsx", "components/RelayPcDetails.tsx", "components/RelayOverview.tsx", "components/relayMapLayout.ts", "components/relayPcState.tsx"],
  "runtime-move": ["components/RuntimeMove.tsx", "components/RuntimeMoveViews.tsx", "lib/runtimeMove.ts"],
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

  it("writes Korean particles per word, never as a dual-particle template", () => {
    // a PC name arrives as a placeholder, so its final consonant is unknown: `{name}을(를)` and the
    // like read as mail-merge text in a heading. The relay/dashboard files are this todo's scope.
    // the pairing prompts belong to the same relay journey but keep their keys in the base catalog
    const relayFiles = [...(PART_FILES.relay ?? []), ...(PART_FILES.dashboard ?? []), "components/RelayPairingPrompt.tsx", "components/AccountApprovalPrompt.tsx"];
    const templated = [...keysInCode()]
      .filter(([, files]) => files.every((file) => relayFiles.includes(file)))
      .map(([key]) => key)
      .filter((key) => /\((?:를|을|가|이|와|과|은|는)\)/.test(KO[key] ?? ""))
      .sort();
    expect(templated).toEqual([]);
  });

  it("keeps each part file at 400 lines or fewer", () => {
    const long = [...new Bun.Glob("lib/i18n/*.ts").scanSync({ cwd: root })].filter((file) => readFileSync(join(root, file), "utf8").split("\n").length > 400);
    expect(long).toEqual([]);
  });
});

describe("translate", () => {
  it.each(["ko", "ja", "zh"] as const)("uses the same %s agent state in groups, rows and alert filters", (language) => {
    for (const [group, row] of [["Idle", "READY"], ["Working", "RUN"], ["Needs input", "INPUT"], ["Finished", "DONE"]] as const) {
      // the Korean sidebar group keeps the owner's word 대기 for Idle (design-pass ruling B5)
      if (language === "ko" && group === "Idle") continue;
      expect(translate(language, group)).toBe(translate(language, row));
    }
  });


  it("fills placeholders, falls back to English, and leaves unknown placeholders alone", () => {
    expect(translate("en", "Worked for {duration}", { duration: "7s" })).toBe("Worked for 7s");
    expect(translate("ko", "Worked for {duration}", { duration: "7초" })).toBe(KO["Worked for {duration}"]!.replace("{duration}", "7초"));
    expect(translate("ko", "not a key", { x: 1 })).toBe("not a key");
    expect(translate("ja", "Settings")).toBe(JA["Settings"]!);
    expect(translate("zh", "Settings")).toBe(ZH["Settings"]!);
    expect(translate("en", "{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });

  it("looks a key with a |context up as it is, and shows English or a missing entry as the part before the |", () => {
    expect(translate("en", "Ovis relay|relay switch")).toBe("Ovis relay");
    expect(translate("ko", "Ovis relay|relay switch")).toBe(KO["Ovis relay|relay switch"]!);
    expect(KO["Ovis relay|relay switch"]).not.toBe(KO["Ovis relay"]);
    expect(translate("ko", "not a key|somewhere")).toBe("not a key");
    expect(translate("en", "Remove {name}|somewhere", { name: "GitHub" })).toBe("Remove GitHub");
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
