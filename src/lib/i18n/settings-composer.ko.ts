/**
 * Korean for the settings keys of Settings → Chat → Composer's optional buttons and chips (and their one row of chips), of Settings → Agents → Other agents herdr knows, of Settings → Chat → Compaction and failed requests, of Settings → Terminal → Codex panes, of Settings → Appearance → Background workspaces apart, and of Settings → Shortcuts → herdr prefix keys: the rest of the
 * settings part (./settings.ko.ts), kept apart so each file stays short. Both files are the one settings part,
 * so a key lives in only one of them; its header lists the settings files and the register.
 */
export const SETTINGS_COMPOSER_KO: Record<string, string> = {
  "Paste and send button": "붙여넣고 보내기 버튼",
  "A button in the empty message box sends the text copied on this device as a message.": "빈 입력창의 버튼으로 이 기기에서 복사한 글을 메시지로 보냅니다.",

  "Background workspaces apart": "백그라운드 워크스페이스 따로 두기",
  "Go to tab 1-9": "1~9번 탭으로 이동",
  "Prefix": "접두키",
  "This PC's server does not report herdr's keys yet.": "이 PC의 서버가 아직 herdr 키를 알려 주지 않습니다.",
  "Use herdr's prefix keys": "herdr 접두키 사용",
  "herdr prefix keys": "herdr 접두키",
  "herdr's prefix in its config.toml cannot be used here, so no key is taken.": "config.toml의 herdr 접두키를 여기서 쓸 수 없어 어떤 키도 가로채지 않습니다.",
  "herdr's prefix, then a key that herdr's config.toml on this PC binds, runs that action here; the actions are listed below. The prefix then no longer reaches the pane (press it twice to send it), while fields, dialogs and IME input keep their keys.": "herdr 접두키에 이어 이 PC의 herdr config.toml이 지정한 키를 누르면 아래 동작이 여기서 실행됩니다. 접두키는 더 이상 패널로 가지 않으며(보내려면 두 번 누르세요), 입력칸·대화상자·IME 입력은 키를 그대로 받습니다.",
  "Codex panes: let Codex select and scroll": "Codex에서 드래그로 기록 선택",
  "Composer buttons": "입력칸 버튼",
  "Artifacts (Claude Code)": "생성한 페이지 목록 (Claude Code)",
  "Suggestion": "제안",
  "Suggestion chip": "제안 칩",
  "Artifacts chip": "아티팩트 칩",
  "A chip above the message box puts the prompt the agent suggests next (Claude Code, GJC or omp) into the box. With a keyboard, Tab does it.": "입력창 위의 칩을 누르면 에이전트(Claude Code, GJC, omp)가 제안한 다음 프롬프트가 입력창에 들어갑니다. 키보드에서는 Tab으로 넣습니다.",
  "A chip in a Claude Code pane's message box lists the pages its session published with the Artifact tool.": "Claude Code 패널의 입력창에 세션이 Artifact 도구로 게시한 페이지 목록을 여는 칩을 표시합니다.",
  "The site in that tab can see and navigate this Ovis tab.": "그 탭의 사이트가 이 Ovis 탭을 보고 이동시킬 수 있습니다.",
  "Close tab button": "탭 닫기 버튼",
  "A button beside Attach files asks the agent to run this skill, for example close-tab. The agent checks for open work first and then closes its tab. Empty: no button. On this device only.": "'파일 첨부' 옆의 버튼이 에이전트에게 이 스킬(예: close-tab)을 실행하게 합니다. 에이전트는 먼저 남은 작업을 확인한 다음 탭을 닫습니다. 비워 두면 버튼이 없습니다. 이 기기에만 적용됩니다.",
};
