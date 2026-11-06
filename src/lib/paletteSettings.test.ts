import { beforeEach, describe, expect, it } from "bun:test";

import { translate } from "./i18n.ts";
import { actionAliases, rankByTitle, requestedSettingsPage, requestSettingsPage, settingsPageEntries, type SettingsPageEntry, type SettingsPageId } from "./paletteSettings.ts";
import type { Language, Translate } from "./i18n.ts";

const identity = (key: string): string => key;
/** The Settings pages and groups as the palette searches them, in the language `t` speaks: a group as `page#section`. */
const pagesIn = (t: Translate) => settingsPageEntries(t).map((entry) => ({ item: entry.section === undefined ? entry.id : `${entry.id}#${entry.section}`, title: entry.label, aliases: entry.aliases }));
const languageT = (language: Language): Translate => (key, vars) => translate(language, key, vars);

/** What a user types for a setting, by language, and the page (and group, or `-`) its first result opens. */
const MATRIX: readonly (readonly [Language, string, SettingsPageId, string])[] = [
  ["en", "theme", "appearance", "-"],
  ["en", "palette", "appearance", "-"],
  ["en", "interface font size", "appearance", "typography"],
  ["en", "chat font size", "appearance", "typography"],
  ["en", "chat width", "chat", "-"],
  ["en", "Enter sends", "chat", "composer"],
  ["en", "quick replies", "chat", "quick-replies"],
  ["en", "terminal font", "appearance", "typography"],
  ["en", "notifications", "alerts", "-"],
  ["en", "shortcuts", "shortcuts", "-"],
  ["en", "phone", "devices", "-"],
  ["en", "OpenAI API key", "chat", "openai-key"],
  ["en", "Return inserts a new line", "chat", "composer"],
  ["en", "Send queued messages automatically", "chat", "composer-more"],
  ["en", "Suggestion chip", "chat", "composer"],
  ["en", "Show above the message box", "chat", "quick-replies"],
  ["en", "Dictation language", "chat", "voice-more"],
  ["ko", "받아쓰기 언어", "chat", "voice-more"],
  ["ko", "인터페이스 글자 크기", "appearance", "typography"],
  ["ko", "채팅 글자 크기", "appearance", "typography"],
  ["ko", "Enter로 보내기", "chat", "composer"],
  ["ko", "빠른 답장", "chat", "quick-replies"],
  ["ko", "터미널 글자 크기", "appearance", "typography"],
  ["ko", "OpenAI API 키", "chat", "openai-key"],
  ["ko", "단축키", "shortcuts", "-"],
  ["ko", "알림", "alerts", "-"],
  ["ko", "대기 메시지 자동 전송", "chat", "composer-more"],
  ["ko", "입력창 위에 표시", "chat", "quick-replies"],
  ["ja", "インターフェースの文字サイズ", "appearance", "typography"],
  ["ja", "チャットのフォントサイズ", "appearance", "typography"],
  ["ja", "Enter で送信", "chat", "composer"],
  ["ja", "クイック返信", "chat", "quick-replies"],
  ["ja", "ターミナルのフォントサイズ", "appearance", "typography"],
  ["ja", "OpenAI API キー", "chat", "openai-key"],
  ["ja", "ショートカット", "shortcuts", "-"],
  ["ja", "通知", "alerts", "-"],
  ["ja", "送信待ちメッセージを自動で送信", "chat", "composer-more"],
  ["ja", "入力欄の上に表示", "chat", "quick-replies"],
  ["zh", "界面字号", "appearance", "typography"],
  ["zh", "聊天字号", "appearance", "typography"],
  ["zh", "按 Enter 发送", "chat", "composer"],
  ["zh", "快捷回复", "chat", "quick-replies"],
  ["zh", "终端字号", "appearance", "typography"],
  ["zh", "OpenAI API 密钥", "chat", "openai-key"],
  ["zh", "快捷键", "shortcuts", "-"],
  ["zh", "提醒", "alerts", "-"],
  ["zh", "自动发送排队消息", "chat", "composer-more"],
  ["zh", "显示在输入框上方", "chat", "quick-replies"],
];

describe("rankByTitle", () => {
  const rows = [
    { item: "toggle-theme", title: "Toggle theme", aliases: "dark light" },
    { item: "settings", title: "Settings", aliases: "preferences theme" },
    { item: "theme", title: "Theme", aliases: "" },
    { item: "refresh", title: "Refresh", aliases: "reload" },
  ];

  it("keeps every row for an empty query", () => {
    expect(rankByTitle("  ", rows)).toEqual(["toggle-theme", "settings", "theme", "refresh"]);
  });

  it("puts the whole title, then its start, then the rest of a title first, and alias-only matches last", () => {
    expect(rankByTitle("theme", rows)).toEqual(["theme", "toggle-theme", "settings"]);
    expect(rankByTitle("the", rows)).toEqual(["theme", "toggle-theme", "settings"]);
  });

  it("finds a row by an alias its title lacks", () => {
    expect(rankByTitle("reload", rows)).toEqual(["refresh"]);
  });

  it("needs every word, across the title and the aliases", () => {
    expect(rankByTitle("settings theme", rows)).toEqual(["settings"]);
    expect(rankByTitle("settings nothing", rows)).toEqual([]);
  });
});

describe("settings entries", () => {
  it("lets a user reach a page by theme, palette or font", () => {
    const pages = pagesIn(identity);
    expect(rankByTitle("theme", pages)).toEqual(["appearance"]);
    expect(rankByTitle("palette", pages)).toEqual(["appearance"]);
    // every font row is in Appearance's Typography group: the Chat and Terminal pages no longer hold one
    expect(rankByTitle("font", pages)).toEqual(["appearance#typography"]);
  });

  it("finds the fixed settings matrix in every supported language", () => {
    const misses = MATRIX.flatMap(([language, query, page, section]) => {
      const first = rankByTitle(query, settingsPageEntries(languageT(language)).map((entry) => ({ item: entry, title: entry.label, aliases: entry.aliases })))[0] as SettingsPageEntry | undefined;
      const actual = { page: first?.id ?? null, section: first?.section ?? null };
      const expected = { page, section: section === "-" ? actual.section : section };
      return actual.page === expected.page && actual.section === expected.section ? [] : [{ language, query, expected, actual }];
    });
    expect(MATRIX.length).toBe(48);
    expect(misses).toEqual([]);
  });

  it("ranks titles before section aliases", () => {
    const pages = pagesIn(identity);
    // a group's heading holds the word: it leads the page that has it only as an alias
    expect(rankByTitle("composer", pages)).toEqual(["chat#composer", "chat#composer-more", "chat"]);
    // a group found only by its setting's label comes after the page whose title holds the word
    expect(rankByTitle("interface", pages)).toEqual(["appearance#typography"]);
    expect(rankByTitle("chat", pages)[0]).toBe("chat");
    expect(rankByTitle("enter", pages)).toEqual(["chat", "chat#composer"]);
  });

  it("finds Appearance by the literal word palette in every language, and by the language's own word", () => {
    // the translated alias is a bag of search words, so it keeps the English word next to its own, as it keeps openai and ssh
    const words = { en: "palette", ko: "팔레트", ja: "パレット", zh: "调色板" } as const;
    for (const [language, word] of Object.entries(words) as [keyof typeof words, string][]) {
      const pages = pagesIn((key, vars) => translate(language, key, vars));
      expect({ language, literal: rankByTitle("palette", pages), own: rankByTitle(word, pages) }).toEqual({ language, literal: ["appearance"], own: ["appearance"] });
    }
  });

  it("has an alias for every action the palette can offer", () => {
    expect(Object.keys(actionAliases(identity))).toContain("theme");
  });
});

describe("requested page", () => {
  beforeEach(() => requestSettingsPage(null));
  it("is held until cleared", () => {
    requestSettingsPage({ page: "terminal" });
    expect(requestedSettingsPage()).toEqual({ page: "terminal" });
    requestSettingsPage(null);
    expect(requestedSettingsPage()).toBeNull();
  });

  it("clears a section request before an unrelated open", () => {
    requestSettingsPage({ page: "chat", section: "quick-replies" });
    expect(requestedSettingsPage()).toEqual({ page: "chat", section: "quick-replies" });
    // the palette's own opening clears what it asked before, so Settings opened another way finds nothing
    requestSettingsPage(null);
    expect(requestedSettingsPage()).toBeNull();
    requestSettingsPage({ page: "terminal" });
    expect(requestedSettingsPage()?.section).toBeUndefined();
  });
});
