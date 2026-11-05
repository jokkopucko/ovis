<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>휴대폰과 브라우저에서 쓰는 Herdr.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/ovis/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/ovis?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/devswha/ovis/stargazers"><img src="https://img.shields.io/github/stars/devswha/ovis?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <strong>한국어</strong>
  <br>
  <a href="https://ovis.sh/">웹사이트</a> ·
  <a href="#install">설치</a> ·
  <a href="https://ovis.sh/demo/">데모 체험</a> ·
  <a href="docs/guide.md#quick-start">빠른 시작</a> ·
  <a href="docs/guide.md#faq">자주 묻는 질문</a> ·
  <a href="#docs">문서</a>
</p>

Ovis는 내 컴퓨터의 코딩 에이전트를 폰, 아무 브라우저, Mac 앱으로 가져옵니다. 대부분의 에이전트는 탭이나 클릭으로 답하는 채팅이 되고, 지원하는 요청과 승인은 카드로 오며, 알림을 켜 두면 에이전트가 나를 기다릴 때 푸시 알림이 옵니다. [herdr](https://github.com/herdrdev/herdr)와 [Herdr 데스크톱 앱의 터미널](docs/guide.md#herdr-app-terminals)을 위한 클라이언트이며, 이전 이름은 herdr web UI입니다.

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="데모에서 녹화한 Ovis 화면: 데스크톱 브라우저에서 Claude Code에 후속 메시지를 보내자 턴이 단계별로 진행되고, 이어서 데스크톱과 폰이 나란히 나와 git push origin feat/export-guard 실행을 묻는 Codex의 Allow command? 카드에서 폰으로 Yes를 누르면 두 화면에서 함께 카드가 닫히고, 마지막으로 release 탭을 누르면 셸 pane이 git log와 bun test를 실행하는 실제 터미널로 열립니다."></a>
  <br>
  <sub>브라우저에서 바로 열리는 <a href="https://ovis.sh/demo/">데모</a>로 녹화했습니다.</sub>
</p>

<a id="install"></a>

## 설치

**컴퓨터에서**

- **Mac:** [Ovis.dmg](https://ovis.sh/Ovis.dmg)를 내려받아 열고 **설치**(Install)를 누릅니다.
- **Windows:** [Ovis.exe](https://ovis.sh/Ovis.exe)를 내려받아 실행하고 **설치**(Install)를 누릅니다.
- **Linux:** 터미널에서 실행합니다.
  ```bash
  curl -fsSL https://ovis.sh/install.sh | sh
  ```

어느 쪽이든 herdr와 Bun이 없으면 함께 설치하며, Node는 필요 없습니다. 다른 설치 방법과 단계별 안내: [INSTALL.md](INSTALL.md).

**폰에서**

- **iPhone:** TestFlight 베타, [ovis.sh/ko/beta](https://ovis.sh/ko/beta/)에서.
- **Android:** Google Play 베타, [ovis.sh/ko/beta](https://ovis.sh/ko/beta/)에서.
- **브라우저:** 앱 없이, 페이지를 홈 화면에 추가합니다.

연결하려면 **Settings → Phone & devices**에서 종단 간 암호화되는 **Ovis 릴레이**를 켜고, 그 QR 코드를 Ovis 앱으로 스캔하거나, 폰 카메라로 스캔해 폰 브라우저에서 Ovis를 여세요. 어디서든 되고, 폰에서 따로 설정할 것이 없습니다. [작동 방식 →](docs/guide.md#through-the-ovis-relay) Tailscale을 쓴다면 컴퓨터와 폰 모두 Tailscale을 켜고, 컴퓨터에 뜬 QR 코드를 스캔해도 됩니다.

## 할 수 있는 일

- **에이전트를 채팅으로.** Claude Code, Codex, OpenCode, pi, omp, Gajae Code, Hermes, Grok 등, 대부분 채팅으로 책상에서도 폰에서도. [지원 에이전트 →](docs/guide.md#supported-agents)
- **요청과 승인은 카드로.** 지원하는 요청은 탭이나 클릭으로 답하고, 보내기 전에 그 요청이 아직 유효한지 확인합니다.
- **푸시 알림.** 에이전트가 질문하거나 일을 끝내면, 앱이 닫혀 있어도 옵니다.
- **실제 터미널이 클릭 한 번 거리에.** herdr가 보여 주는 그 pane 그대로이고, 폰에는 키 바가 붙습니다.
- **모든 워크스페이스를 한 목록에.** 탭, 분할 pane, SSH로 붙인 다른 PC까지 보이고, 나를 기다리는 것은 표시됩니다.
- **무료, MIT.** 내 컴퓨터에서 돌아가고, 가입할 계정이 없습니다.

[전체 기능 →](docs/guide.md#features)

**한계:** Ovis는 [herdr](https://github.com/herdrdev/herdr)와 켜져 있는 내 컴퓨터가 필요하고, 폰에서 그 컴퓨터에 닿아야 합니다(Ovis 릴레이, Tailscale, VPN, SSH 터널). Herdr 데스크톱 앱의 터미널은 Linux와 macOS에서만 됩니다.

**개인정보:** 세션은 각 에이전트를 실행하는 컴퓨터에 남고, Ovis에는 계정이 없습니다. 직접 켜기 전까지 꺼져 있는 Ovis 릴레이는 어느 폰이 어느 PC에 어떤 주소에서 언제, 얼마나 주고받는지는 볼 수 있지만 내용은 읽지 못합니다([신뢰 모델](docs/relay.md#trust-model)). 익명 사용 집계는 기본적으로 켜져 있으며, **Settings → About → Anonymous usage counts**에서 보내는 내용을 확인하고 끌 수 있습니다. `OVIS_TELEMETRY=0`으로도 끌 수 있습니다. [보내는 내용 →](docs/guide.md#anonymous-usage-counts)

<a id="docs"></a>

## 문서

- **[사용자 가이드](docs/guide.md):** [빠른 시작](docs/guide.md#quick-start) · [지원 에이전트](docs/guide.md#supported-agents) · [기능](docs/guide.md#features) · [폰](docs/guide.md#on-your-phone) · [원격 PC](docs/remote-pcs.md) · [접근과 보안](docs/guide.md#access-and-safety) · [설정](docs/guide.md#configuration) · [키보드 단축키](docs/guide.md#keyboard-shortcuts)
- **[자주 묻는 질문](docs/guide.md#faq):** herdr 자체 TUI, Tailscale, 내 컴퓨터 밖으로 나가는 것, collie·Happy·Paseo 등과의 차이.
- **[INSTALL.md](INSTALL.md):** 모든 설치 방법을 단계별로, 그리고 단계가 실패했을 때 할 일.
- **[데모](https://ovis.sh/demo/):** 가상의 세션으로 돌아가는 실제 앱을 브라우저에서.
- **[변경 기록](CHANGELOG.md)**

문서는 영어로 쓰여 있습니다.

<a id="thanks"></a>

## 감사

[herdr](https://github.com/herdrdev/herdr) 위에서 만들었고, [chatmux](https://github.com/devswha/chatmux)에서 영감을 받았으며, [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh), [Lucide](https://lucide.dev)를 사용합니다.

기여해 주신 모든 분께 감사드립니다. 특히 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)님께 감사드립니다. 아이콘과 홈페이지 디자인을 도와주신 [@sanguneo](https://github.com/sanguneo)님께도 감사드립니다.

<a id="agent-instructions"></a>

## 에이전트용 안내

누군가의 설치를 돕고 있다면 [INSTALL.md](INSTALL.md)를 따르세요. 저장소를 바꿀 때는 [CONTRIBUTING.md](CONTRIBUTING.md), [리뷰 규칙](.github/REVIEW.md), [AGENTS.md](AGENTS.md)를 따르세요.

<a id="development"></a>

## 개발

```bash
git clone https://github.com/devswha/ovis.git
cd ovis
bun install

bun run server      # API + WebSocket, :7317
bun run dev         # Vite, :5173 (다른 터미널에서 실행)
```

변경을 보내려면 [CONTRIBUTING.md](CONTRIBUTING.md)를, 테스트·미디어·릴리스는 [개발 문서](docs/development.md)를, UI 규칙은 [DESIGN.md](DESIGN.md)를 보세요. 보안 문제는 [SECURITY.md](SECURITY.md)에 따라 비공개로 알려 주세요.

<a id="license"></a>

## 라이선스

[MIT](LICENSE). Copyright © 2026 devswha.
