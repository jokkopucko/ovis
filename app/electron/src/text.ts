/**
 * The words the app's main process shows itself (the tray, the menu bar, the notification of a
 * downloaded update and its line on the connection screen), in the languages the
 * Ovis pages have (src/lib/i18n.ts), chosen from the app's locale (`app.getLocale()`, the system's
 * language or `--lang`). English is the key, as in the pages.
 */
const ENGLISH = [
  "Open Ovis",
  "Open in Browser",
  "Keep Computer Awake",
  "While an Agent Is Working",
  "Also on Battery",
  "Restart Ovis Server",
  "Restart to Update",
  "Ovis {version} is ready",
  "Restart to update.",
  "Quit Ovis",
  "Keeping this computer awake: 1 agent working",
  "Keeping this computer awake: {count} agents working",
  "File",
  "View",
  "Reload",
  "Quit",
] as const;

export type TextKey = (typeof ENGLISH)[number];
export type DesktopLocale = "en" | "ko" | "ja" | "zh";

const TRANSLATIONS: Record<Exclude<DesktopLocale, "en">, Record<TextKey, string>> = {
  ko: {
    "Open Ovis": "Ovis 열기",
    "Open in Browser": "브라우저에서 열기",
    "Keep Computer Awake": "컴퓨터 깨어 있게 하기",
    "While an Agent Is Working": "에이전트가 일하는 동안",
    "Also on Battery": "배터리 사용 중에도",
    "Restart Ovis Server": "Ovis 서버 다시 시작",
    "Restart to Update": "다시 시작해서 업데이트",
    "Ovis {version} is ready": "Ovis {version} 업데이트가 준비되었습니다",
    "Restart to update.": "다시 시작하면 업데이트됩니다.",
    "Quit Ovis": "Ovis 종료",
    "Keeping this computer awake: 1 agent working": "컴퓨터를 깨워 두는 중: 에이전트 1개 작업 중",
    "Keeping this computer awake: {count} agents working": "컴퓨터를 깨워 두는 중: 에이전트 {count}개 작업 중",
    "File": "파일",
    "View": "보기",
    "Reload": "새로고침",
    "Quit": "종료",
  },
  ja: {
    "Open Ovis": "Ovis を開く",
    "Open in Browser": "ブラウザで開く",
    "Keep Computer Awake": "スリープさせない",
    "While an Agent Is Working": "エージェントの作業中",
    "Also on Battery": "バッテリー駆動中も",
    "Restart Ovis Server": "Ovis サーバーを再起動",
    "Restart to Update": "再起動してアップデート",
    "Ovis {version} is ready": "Ovis {version} のアップデートの準備ができました",
    "Restart to update.": "再起動するとアップデートされます。",
    "Quit Ovis": "Ovis を終了",
    "Keeping this computer awake: 1 agent working": "スリープを止めています: エージェント 1 個が作業中",
    "Keeping this computer awake: {count} agents working": "スリープを止めています: エージェント {count} 個が作業中",
    "File": "ファイル",
    "View": "表示",
    "Reload": "再読み込み",
    "Quit": "終了",
  },
  zh: {
    "Open Ovis": "打开 Ovis",
    "Open in Browser": "在浏览器中打开",
    "Keep Computer Awake": "保持电脑唤醒",
    "While an Agent Is Working": "智能体工作时",
    "Also on Battery": "使用电池时也保持",
    "Restart Ovis Server": "重启 Ovis 服务器",
    "Restart to Update": "重启以更新",
    "Ovis {version} is ready": "Ovis {version} 更新已就绪",
    "Restart to update.": "重启即可更新。",
    "Quit Ovis": "退出 Ovis",
    "Keeping this computer awake: 1 agent working": "正在保持电脑唤醒: 1 个智能体工作中",
    "Keeping this computer awake: {count} agents working": "正在保持电脑唤醒: {count} 个智能体工作中",
    "File": "文件",
    "View": "视图",
    "Reload": "重新加载",
    "Quit": "退出",
  },
};

export function desktopLocale(locale: string): DesktopLocale {
  const language = locale.toLowerCase().split(/[-_]/)[0];
  return language === "ko" || language === "ja" || language === "zh" ? language : "en";
}

export function desktopText(locale: DesktopLocale): (key: TextKey, values?: Record<string, string | number>) => string {
  const table = locale === "en" ? null : TRANSLATIONS[locale];
  return (key, values = {}) => (table?.[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
}
