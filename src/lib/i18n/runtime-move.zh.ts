/**
 * Simplified Chinese for the keys only the move to herdr-core uses:
 * components/RuntimeMove.tsx, components/RuntimeMoveViews.tsx, lib/runtimeMove.ts.
 * Register and fixed terms follow ../i18n.zh.ts; a key another feature also uses goes there.
 */
export const RUNTIME_MOVE_ZH: Record<string, string> = {
  "Move everything to herdr-core": "全部迁移到 herdr-core",
  "Every workspace, tab and agent reopens on herdr-core, all at once.": "所有工作区、标签页和 Agent 一次性在 herdr-core 上重新打开。",
  "Move…": "迁移…",
  "Waiting…": "等待中…",
  "Moving…": "迁移中…",

  "Continues the same conversation": "继续同一对话",
  "Starts new (no conversation found)": "重新开始（无对话信息）",
  "New shell in the same folder": "在同一文件夹新开 Shell",
  "End it yourself": "请手动退出",
  "Answering": "回答中",
  "Waiting for an answer": "等待回答",
  "A command is running": "命令运行中",
  "{command} running": "{command} 运行中",
  "Scrollback and programs running in shells do not come along. herdr itself stays as it is.": "历史输出（回滚缓冲）和 Shell 中运行的程序不会迁移。herdr 本身保持不变。",
  "Move everything": "全部迁移",
  "Move everything once all work is done": "等所有工作完成后一次性迁移",

  "One pane is at work. Everything moves at once when it is done.": "1 个面板正在工作。完成后一次性迁移。",
  "{n} panes are at work. Everything moves at once when they are done.": "{n} 个面板正在工作。全部完成后一次性迁移。",
  "End a program in a shell (Ctrl+C) or an agent marked above yourself; the move then goes on by itself.": "请手动结束 Shell 中的程序（Ctrl+C）或上面标出的 Agent，之后迁移会自动继续。",
  "Waiting for work to finish…": "正在等待工作完成…",

  "Ending the agents in herdr": "正在退出 herdr 中的 Agent",
  "Rebuilding the workspaces, tabs and splits on herdr-core": "正在 herdr-core 上重建工作区、标签页和分屏",
  "Reopening the agents on herdr-core": "正在 herdr-core 上重新打开 Agent",
  "Switching Ovis to herdr-core": "正在把 Ovis 切换到 herdr-core",

  "Now running on herdr-core. To go back to herdr, switch the runtime again.": "现在运行在 herdr-core 上。要回到 herdr，再次切换运行时即可。",
  "Could not move. Ovis put back what it could; anything it could not is listed below.": "迁移失败。能恢复的已恢复，未能恢复的列在下方。",
  "Not reopened in herdr:": "未能在 herdr 中重新打开：",

  "A server stopped partway; nothing was put back. Check the agents listed below.": "服务器中途停止，未做任何恢复。请检查下方列出的代理。",
  "An agent started working again.": "有代理重新开始工作。",
  "Text was left in an agent's input box.": "有代理的输入框里留有未发送的文字。",
  "An agent did not end in time.": "有代理未能及时结束。",
  "The panes changed since you looked: look again.": "查看后面板已变化，请重新查看。",
  "The Herdr app arranges herdr-core on this PC.": "此电脑上的 herdr-core 由 Herdr 应用管理。",
  "The switch to herdr-core was refused.": "切换到 herdr-core 被拒绝。",
  "The switch to herdr-core did not come up; the agents run there. Switch again in Settings.": "未能切换到 herdr-core，代理正在 herdr-core 上运行。请在设置中再次切换。",
  "Something failed: {detail}": "出现问题：{detail}",
  "It is running again.": "它又在运行了。",
  "Its pane is gone.": "它的面板已不存在。",
  "Its conversation is open in another pane.": "同一对话已在另一个面板中打开。",
  "What was started on herdr-core could not be ended.": "未能结束在 herdr-core 上启动的内容。",
  "It could not start: {detail}": "无法启动：{detail}",
  "Ended when the server stopped.": "服务器停止时已结束。",
  "Running on herdr-core.": "正在 herdr-core 上运行。",
  "The server was switching its runtime.": "服务器正在切换运行时。",
  "An agent did not reopen its conversation on herdr-core.": "有代理未能在 herdr-core 上重新打开同一对话。",
};
