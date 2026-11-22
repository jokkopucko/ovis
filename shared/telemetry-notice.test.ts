import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { TELEMETRY_ACTION_SOURCES, TELEMETRY_ACTIONS, TELEMETRY_COUNTERS, TELEMETRY_SHOWN } from "./telemetry.ts";
import { COUNTS_ON, NOTICE_VERSION } from "./telemetry-notice.ts";

const root = join(import.meta.dir, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
const html = (source: string) => source.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script>/gi, "");
const guideSection = (source: string) => {
  const start = source.indexOf("\n## Anonymous usage counts\n");
  if (start < 0) return "";
  const end = source.indexOf("\n## ", start + 1);
  return html(source.slice(start, end < 0 ? undefined : end));
};
const controls = withoutComments(read("src/components/TelemetryControls.tsx"));
const row = (source: string, start: string) => html(source).split("\n").find((line) => line.startsWith(start)) ?? "";

// The button counts may be on only in a tree whose every disclosure says they are sent: the notice line the app
// shows, the Settings description of the switch, the guide's section, both privacy pages and both store forms. A build that turns
// them on without those words fails here, and so does one that says so while they are off.
describe("button counts and the words that disclose them", () => {
  test("COUNTS_ON only where the notice, Settings, the guide, both privacy pages and both store forms say buttons are counted", () => {
    // each says, beside the buttons, the two other things the message holds: for a few actions which way (button, menu,
    // shortcut, palette) they were done, and which controls were shown that day
    const has = (text: string, ...phrases: string[]) => phrases.every((phrase) => text.includes(phrase));
    const clause = (text: string, from: string, to: string) => {
      const start = text.indexOf(from);
      const end = start < 0 ? -1 : text.indexOf(to, start);
      return end < 0 ? "" : text.slice(start, end + to.length);
    };
    const settingsRow = /:\s*<SettingsRow label=\{t\("Send anonymous usage counts"\)\}[^\n]*description=\{t\("([^"]*)"\)/.exec(controls)?.[1] ?? "";
    const translation = (language: string) => read(`src/lib/i18n/settings.${language}.ts`).split("\n").find((line) => line.startsWith(`  ${JSON.stringify(settingsRow)}: "`))?.slice(settingsRow.length + 6) ?? "";
    const iosRow = row(read("app/store/ios.md"), "| Usage Data > Product Interaction");
    const androidRow = row(read("app/store/android.md"), "| App activity > App interactions");
    const said = {
      notice: /:\s*t\("Button use and other anonymous usage counts are sent to improve Ovis\."\)/.test(controls),
      settings: has(clause(settingsRow, "After each day, how often the app's buttons were used that day", "controls were shown"), "a button", "a menu", "a shortcut", "command palette"),
      settingsKo: has(clause(translation("ko"), "그날 앱의 버튼을", "화면에 나왔는지"), "버튼·", "메뉴", "단축키", "명령 팔레트"),
      settingsJa: has(clause(translation("ja"), "アプリのボタンを", "表示された"), "ボタン・", "メニュー", "ショートカット", "コマンドパレット"),
      settingsZh: has(clause(translation("zh"), "应用各按钮", "曾显示"), "通过按钮", "菜单", "快捷键", "命令面板"),
      guide: guideSection(read("docs/guide.md")).includes("a counts message goes out once for that day"),
      privacy: has(html(read("ovis-site/privacy/index.html")), "how often the app's buttons were used that day", "a keyboard shortcut or the command palette was used", "which of these controls were shown that day"),
      privacyKo: has(html(read("ovis-site/ko/privacy/index.html")), "그날 앱의 버튼을 얼마나 썼는지", "버튼·메뉴·단축키·명령 팔레트 중 무엇으로 했는지", "무엇이 그날 화면에 나왔는지"),
      storeIos: has(iosRow, "how often its buttons are used", "whether by button, menu, shortcut or palette", "which of them were shown"),
      storeAndroid: has(androidRow, "how often the app's buttons were used", "whether by button, menu, shortcut or palette", "which of these controls were shown"),
    };
    const all = (value: boolean) => ({ notice: value, settings: value, settingsKo: value, settingsJa: value, settingsZh: value, guide: value, privacy: value, privacyKo: value, storeIos: value, storeAndroid: value });
    expect(said).toEqual(all(COUNTS_ON));
  });

  test("the names counted are the ones the disclosures were last read against", () => {
    const names = JSON.stringify([TELEMETRY_COUNTERS, TELEMETRY_ACTIONS, TELEMETRY_ACTION_SOURCES, TELEMETRY_SHOWN]);
    const disclosed = { notice: NOTICE_VERSION, names: createHash("sha256").update(names).digest("hex").slice(0, 16) };
    expect(disclosed, "A counted name changed: read the notice, Settings, the guide, both privacy pages and both store forms against it again, then update this line. A new kind of data needs a new NOTICE_VERSION and the owner's word.").toEqual({ notice: 6, names: "7cbe7c28d10e0d94" });
  });
});
