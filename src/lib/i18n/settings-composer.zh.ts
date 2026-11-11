/**
 * Chinese for the settings keys of Settings → Chat → Composer's optional buttons and chips (and their one row of chips), of Settings → Agents → Other agents herdr knows, of Settings → Chat → Compaction and failed requests, of Settings → Terminal → Codex panes, of Settings → Appearance → Background workspaces apart, and of Settings → Shortcuts → herdr prefix keys: the rest of the
 * settings part (./settings.zh.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_ZH: Record<string, string> = {
  "Paste and send button": "粘贴并发送按钮",
  "A button in the empty message box sends the text copied on this device as a message.": "空输入框中的按钮会把在此设备上复制的文本作为消息发送。",

  "Background workspaces apart": "单独放置后台工作区",
  "On this device, workspaces a tool tagged role=background (herdr workspace report-metadata --token role=background) stand after the others under a folded Background workspaces heading. The open one, and one whose agent asks a question, stay in sight.": "在此设备上,工具标记了 role=background 的工作区(herdr workspace report-metadata --token role=background)会排在其他工作区之后,放在折叠的“后台工作区”标题下。打开的工作区和代理正在提问的工作区仍然可见。",
  "Go to tab 1-9": "转到第 1-9 个标签页",
  "Prefix": "前缀键",
  "This PC's server does not report herdr's keys yet.": "此 PC 的服务器尚未报告 herdr 的按键。",
  "Use herdr's prefix keys": "使用 herdr 前缀键",
  "herdr prefix keys": "herdr 前缀键",
  "herdr's prefix in its config.toml cannot be used here, so no key is taken.": "config.toml 中的 herdr 前缀键无法在此使用，因此不会占用任何按键。",
  "herdr's prefix, then a key herdr's config.toml on this PC binds, runs that action here: the ones listed below. The prefix no longer reaches the pane: press it twice to send it. Fields, dialogs and IME input keep their keys.": "按下 herdr 前缀键后，再按此 PC 的 herdr config.toml 绑定的键，即可在这里执行下方列出的操作。前缀键将不再发送到窗格：按两次即可发送。输入框、对话框和输入法输入保留其按键。",
  "Codex panes: let Codex select and scroll": "Codex 窗格：由 Codex 选择和滚动",
  "On this device, a drag in a Codex pane goes to Codex, which selects through its whole history and scrolls it while the drag is held past the top or bottom edge. Ctrl+C or Enter copies it, but on herdr that copy does not reach this device's clipboard: Shift+drag (Option+drag on a Mac) still selects, copies and quotes in Ovis, up to the screen's edge.": "在此设备上，Codex 窗格中的拖动交给 Codex，它会在完整历史中选择，并在拖动停在顶部或底部边缘之外时滚动历史。Ctrl+C 或 Enter 复制所选内容，但在 herdr 上该复制不会到达此设备的剪贴板：Shift+拖动（Mac 上为 Option+拖动）仍会在 Ovis 中选择、复制和引用，直到屏幕边缘。",
  "Composer buttons": "输入框按钮",
  "Artifacts (Claude Code)": "工件 (Claude Code)",
  "Suggestion": "建议",
  "Suggestion chip": "建议标签",
  "Artifacts chip": "Artifact 标签",
  "A chip above the message box puts the prompt the agent suggests next (Claude Code, GJC or omp) into the box. With a keyboard, Tab does it.": "输入框上方的标签会把 Agent（Claude Code、GJC、omp）建议的下一条提示填入输入框。使用键盘时按 Tab 即可。",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "在 Claude Code 面板的输入框中显示一个标签，列出该会话用 Artifact 工具发布的页面。",
  "The site in that tab can see and navigate this Ovis tab.": "该标签页中的网站可以查看并跳转这个 Ovis 标签页。",
};
