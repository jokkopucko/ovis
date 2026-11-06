/**
 * Korean for the settings keys of Settings → Chat → Composer's optional buttons and chips (and their one row of chips), of Settings → Agents → Other agents herdr knows, of Settings → Chat → Compaction and failed requests, of Settings → Terminal → Codex panes, of Settings → Appearance → Background workspaces apart, and of Settings → Shortcuts → herdr prefix keys: the rest of the
 * settings part (./settings.ko.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_KO: Record<string, string> = {
  "Paste and send button": "붙여넣고 보내기 버튼",
  "A button in the empty message box sends the text copied on this device as a message.": "빈 입력창의 버튼으로 이 기기에서 복사한 글을 메시지로 보냅니다.",

  "Background workspaces apart": "백그라운드 워크스페이스 따로 두기",
  "On this device, workspaces a tool tagged role=background (herdr workspace report-metadata --token role=background) stand after the others under a folded Background workspaces heading. The open one, and one whose agent asks a question, stay in sight.": "이 기기에서, 도구가 role=background 태그를 단 워크스페이스(herdr workspace report-metadata --token role=background)를 다른 워크스페이스 뒤의 접힌 백그라운드 워크스페이스 머리글 아래에 둡니다. 열려 있는 워크스페이스와 에이전트가 질문 중인 워크스페이스는 계속 보입니다.",
  "Go to tab 1-9": "1~9번 탭으로 이동",
  "Prefix": "접두키",
  "This PC's server does not report herdr's keys yet.": "이 PC의 서버가 아직 herdr 키를 알려 주지 않습니다.",
  "Use herdr's prefix keys": "herdr 접두키 사용",
  "herdr prefix keys": "herdr 접두키",
  "herdr's prefix in its config.toml cannot be used here, so no key is taken.": "config.toml의 herdr 접두키를 여기서 쓸 수 없어 어떤 키도 가로채지 않습니다.",
  "herdr's prefix, then a key herdr's config.toml on this PC binds, runs that action here: the ones listed below. The prefix no longer reaches the pane: press it twice to send it. Fields, dialogs and IME input keep their keys.": "herdr 접두키에 이어 이 PC의 herdr config.toml이 지정한 키를 누르면 아래 동작이 여기서 실행됩니다. 접두키는 더 이상 패널로 가지 않으니, 보내려면 두 번 누르세요. 입력칸·대화상자·IME 입력은 키를 그대로 받습니다.",
  "Codex panes: let Codex select and scroll": "Codex 창의 드래그는 Codex에 넘기기",
  "On this device, a drag in a Codex pane goes to Codex, which selects through its whole history and scrolls it while the drag is held past the top or bottom edge. Ctrl+C or Enter copies it, but on herdr that copy does not reach this device's clipboard: Shift+drag (Option+drag on a Mac) still selects, copies and quotes in Ovis, up to the screen's edge.": "이 기기에서 Codex 패널을 끌면 Codex가 받아 전체 기록에서 선택하고, 위나 아래 가장자리 너머로 끈 채 있으면 기록을 스크롤합니다. Ctrl+C나 Enter로 복사하지만, herdr에서는 그 복사가 이 기기의 클립보드에 닿지 않습니다. Shift+끌기(Mac은 Option+끌기)는 여전히 Ovis에서 화면 가장자리까지 선택하고 복사하고 인용합니다.",
  "Composer buttons": "입력칸 버튼",
  "Artifacts (Claude Code)": "아티팩트 (Claude Code)",
  "Suggestion (Claude Code)": "제안 (Claude Code)",
  "Suggestion chip": "제안 칩",
  "Artifacts chip": "아티팩트 칩",
  "A chip above the message box puts the prompt Claude Code suggests next into the box. With a keyboard, Tab does it.": "입력창 위의 칩을 누르면 Claude Code가 제안한 다음 프롬프트가 입력창에 들어갑니다. 키보드에서는 Tab으로 넣습니다.",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "Claude Code 패널의 입력창에 세션이 Artifact 도구로 게시한 페이지 목록을 여는 칩을 표시합니다.",
  "The site in that tab can see and navigate this Ovis tab.": "그 탭의 사이트가 이 Ovis 탭을 보고 이동시킬 수 있습니다.",
};
