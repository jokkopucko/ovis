/**
 * Chinese for the settings keys of Settings → Appearance's agent rows: the rest of the settings part
 * (./settings.zh.ts), kept apart so each file stays short. All these files are the one settings
 * part, so a key lives in only one of them; ./settings.zh.ts's header lists the settings files and the register.
 */
export const SETTINGS_AGENTS_ZH: Record<string, string> = {
  "OpenCode: subagent ends from their session": "OpenCode：从父会话读取子代理结束",
  "An OpenCode subagent counts as running, and holds its turn's BG wait, until the session that started it is told it ended, not as soon as the subagent goes idle. Its own background work may still run then. When off, the subagent's own rows tell.": "OpenCode 子 Agent 不会在其空闲时立即视为结束，而是一直计为运行中，并保持该轮的 BG 等待，直到启动它的会话被告知它已结束。此时子 Agent 自己的后台任务可能仍在运行。关闭时，按子 Agent 自己的记录判断。",
};
