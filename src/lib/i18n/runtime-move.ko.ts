/**
 * Korean for the keys only the move to herdr-core uses:
 * components/RuntimeMove.tsx, components/RuntimeMoveViews.tsx, lib/runtimeMove.ts.
 * Register and fixed terms follow ../i18n.ko.ts; a key another feature also uses goes there.
 */
export const RUNTIME_MOVE_KO: Record<string, string> = {
  "Move everything to herdr-core": "herdr-core로 전부 옮기기",
  "Every workspace, tab and agent reopens on herdr-core, all at once.": "모든 워크스페이스·탭·에이전트를 한꺼번에 herdr-core에서 다시 엽니다.",
  "Move…": "옮기기…",
  "Waiting…": "기다리는 중…",
  "Moving…": "옮기는 중…",

  "Continues the same conversation": "같은 대화로 이어서",
  "Starts new (no conversation found)": "새로 시작 (대화 정보 없음)",
  "New shell in the same folder": "같은 폴더에 새 셸",
  "End it yourself": "직접 종료해 주세요",
  "Answering": "답하는 중",
  "Waiting for an answer": "답을 기다리는 중",
  "A command is running": "명령 실행 중",
  "{command} running": "{command} 실행 중",
  "Scrollback and programs running in shells do not come along. herdr itself stays as it is.": "이전 출력(스크롤백)과 셸에서 돌던 프로그램은 옮겨지지 않습니다. herdr 자체는 그대로 둡니다.",
  "Move everything": "전부 옮기기",
  "Move everything once all work is done": "작업이 모두 끝나면 한꺼번에 옮기기",

  "One pane is at work. Everything moves at once when it is done.": "패널 1개가 작업 중입니다. 끝나면 한꺼번에 옮깁니다.",
  "{n} panes are at work. Everything moves at once when they are done.": "패널 {n}개가 작업 중입니다. 모두 끝나면 한꺼번에 옮깁니다.",
  "End a program in a shell (Ctrl+C) or an agent marked above yourself; the move then goes on by itself.": "셸에서 도는 프로그램(Ctrl+C)이나 위에 표시된 에이전트는 직접 끝내 주세요. 끝나면 자동으로 진행합니다.",
  "Waiting for work to finish…": "작업이 끝나기를 기다리는 중…",

  "Ending the agents in herdr": "herdr의 에이전트 종료 중",
  "Rebuilding the workspaces, tabs and splits on herdr-core": "herdr-core에 워크스페이스·탭·나눔 다시 만드는 중",
  "Reopening the agents on herdr-core": "herdr-core에서 에이전트 다시 여는 중",
  "Switching Ovis to herdr-core": "Ovis를 herdr-core로 전환하는 중",

  "Now running on herdr-core. To go back to herdr, switch the runtime again.": "이제 herdr-core에서 돌고 있습니다. herdr로 돌아가려면 런타임을 다시 바꾸면 됩니다.",
  "Could not move. Ovis put back what it could; anything it could not is listed below.": "옮기지 못했습니다. 되돌릴 수 있는 것은 되돌렸고, 못 한 것은 아래에 있습니다.",
  "Not reopened in herdr:": "herdr에서 다시 열지 못한 것:",

  "A server stopped partway; nothing was put back. Check the agents listed below.": "서버가 도중에 멈춰 아무것도 되돌리지 않았습니다. 아래 에이전트를 확인해 주세요.",
  "An agent started working again.": "에이전트가 다시 작업을 시작했습니다.",
  "Text was left in an agent's input box.": "에이전트 입력칸에 쓰다 만 글이 있었습니다.",
  "An agent did not end in time.": "에이전트가 제때 끝나지 않았습니다.",
  "The panes changed since you looked: look again.": "확인한 뒤 패널이 바뀌었습니다. 다시 확인해 주세요.",
  "The Herdr app arranges herdr-core on this PC.": "이 PC에서는 Herdr 앱이 herdr-core를 관리합니다.",
  "The switch to herdr-core was refused.": "herdr-core로 전환이 거부되었습니다.",
  "The switch to herdr-core did not come up; the agents run there. Switch again in Settings.": "herdr-core 전환이 끝나지 않았습니다. 에이전트는 herdr-core에서 돌고 있으니 설정에서 다시 전환해 주세요.",
  "Something failed: {detail}": "문제가 생겼습니다: {detail}",
  "It is running again.": "다시 실행 중입니다.",
  "Its pane is gone.": "패널이 없어졌습니다.",
  "Its conversation is open in another pane.": "같은 대화가 다른 패널에서 이미 열려 있습니다.",
  "What was started on herdr-core could not be ended.": "herdr-core에 만든 것을 끝내지 못했습니다.",
  "It could not start: {detail}": "시작하지 못했습니다: {detail}",
  "Ended when the server stopped.": "서버가 멈출 때 끝난 상태입니다.",
  "Running on herdr-core.": "herdr-core에서 돌고 있습니다.",
  "The server was switching its runtime.": "서버가 런타임을 전환하는 중이었습니다.",
  "An agent did not reopen its conversation on herdr-core.": "에이전트가 herdr-core에서 같은 대화를 다시 열지 못했습니다.",
};
