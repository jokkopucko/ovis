<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>Your coding agents, on desktop, phone and browser.</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/ovis/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/ovis?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/devswha/ovis/stargazers"><img src="https://img.shields.io/github/stars/devswha/ovis?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
  <br>
  <a href="https://ovis.sh/">website</a> ·
  <a href="#install">install</a> ·
  <a href="https://ovis.sh/demo/">try the demo</a> ·
  <a href="docs/guide.md#quick-start">quick start</a> ·
  <a href="docs/guide.md#faq">faq</a> ·
  <a href="#docs">docs</a>
</p>

Chat with the coding agents on your computer from a desktop app, your phone or any browser, and answer their prompts with a tap. A client for [herdr](https://github.com/herdrdev/herdr) and the [Herdr desktop app's terminals](docs/guide.md#herdr-app-terminals).

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="Screen recording of Ovis on the demo: in a desktop browser, a follow-up is sent to Claude Code and its turn streams in step by step; then the desktop and a phone side by side, where Codex asks Allow command? for git push origin feat/export-guard, Yes is tapped on the phone and the card closes on both screens; then a click on the release tab opens a shell pane as a live terminal running git log and bun test."></a>
  <br>
  <sub>Recorded on the <a href="https://ovis.sh/demo/">demo</a>, which runs in your browser.</sub>
</p>

## install

**On your computer**

- **Mac:** the desktop app for [Apple silicon](https://ovis.sh/Ovis-mac-arm64.dmg) or [Intel](https://ovis.sh/Ovis-mac-x64.dmg); drag it to **Applications**.
- **Windows:** the desktop app, [Ovis-win-x64.exe](https://ovis.sh/Ovis-win-x64.exe); run it. If Windows shows **Windows protected your PC**, choose **More info** → **Run anyway**.
- **Linux:** the desktop app for Debian or Ubuntu, [x64](https://ovis.sh/Ovis-linux-x64.deb) or [arm64](https://ovis.sh/Ovis-linux-arm64.deb) (`sudo apt install ./Ovis-linux-*.deb`); elsewhere the AppImage, [x64](https://ovis.sh/Ovis-linux-x64.AppImage) or [arm64](https://ovis.sh/Ovis-linux-arm64.AppImage) (`chmod +x Ovis-linux-*.AppImage`).

The desktop app needs nothing else and runs its own terminals. To use your herdr sessions instead, on Linux or macOS:

```bash
curl -fsSL https://ovis.sh/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://ovis.sh/install.ps1 | iex
```

Other ways, step by step: [INSTALL.md](INSTALL.md).

**On your phone**

- **iPhone:** the TestFlight beta, from [ovis.sh/beta](https://ovis.sh/beta/).
- **Android:** the Google Play beta, from [ovis.sh/beta](https://ovis.sh/beta/).
- **Browser:** no app needed; add the page to the home screen.

To connect a phone, turn on the end-to-end encrypted **Ovis relay** in **Settings → Phone & devices** and scan its QR code. [How it works →](docs/guide.md#through-the-ovis-relay)

## what you get

- **Agents as a chat.** Claude Code, Codex, OpenCode and more. [Supported agents →](docs/guide.md#supported-agents)
- **Prompts and approvals as cards.** Answer with a tap.
- **Push alerts.** Even with the app closed.
- **The live terminal, one click away.** With a key bar on phones.
- **Every workspace in one list.** Other PCs over SSH too.

[All features →](docs/guide.md#features)

**Limits:** your computer has to be on and reachable (the Ovis relay, Tailscale, a VPN or an SSH tunnel). On Windows, Ovis shows herdr's terminals until you switch to the Herdr desktop app's in Settings.

**Privacy:** sessions stay on your computer, with no account. The optional relay can't read what is sent ([trust model](docs/relay.md#trust-model)). Anonymous usage counts are on by default; **Settings → About** or `OVIS_TELEMETRY=0` turns them off ([what is sent](docs/guide.md#anonymous-usage-counts)).

## docs

- **[User guide](docs/guide.md):** [quick start](docs/guide.md#quick-start) · [supported agents](docs/guide.md#supported-agents) · [features](docs/guide.md#features) · [phone](docs/guide.md#on-your-phone) · [remote PCs](docs/remote-pcs.md) · [Ovis relay](docs/relay.md) · [access and safety](docs/guide.md#access-and-safety) · [configuration](docs/guide.md#configuration) · [keyboard shortcuts](docs/guide.md#keyboard-shortcuts)
- **[FAQ](docs/guide.md#faq):** herdr's own TUI, Tailscale, what leaves your machine, and how Ovis compares with collie, Happy, Paseo and others.
- **[INSTALL.md](INSTALL.md):** every way to install, step by step, and what to do when a step fails.
- **[Demo](https://ovis.sh/demo/):** the real app on a made-up session, in your browser.
- **[Changelog](CHANGELOG.md)**

## thanks

Built on [herdr](https://github.com/herdrdev/herdr), with inspiration from [chatmux](https://github.com/devswha/chatmux), and powered by [xterm.js](https://xtermjs.org), [React](https://react.dev), [Bun](https://bun.sh) and [Lucide](https://lucide.dev).

Thanks to everyone who has contributed, including [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha), and to [@sanguneo](https://github.com/sanguneo), who helped design the icon and the website.

## agent instructions

Helping someone install the app? Follow [INSTALL.md](INSTALL.md). For repository changes, follow [CONTRIBUTING.md](CONTRIBUTING.md), the [review rules](.github/REVIEW.md) and [AGENTS.md](AGENTS.md).

## development

```bash
git clone https://github.com/devswha/ovis.git
cd ovis
bun install

bun run server      # API + WebSocket on :7317
bun run dev         # Vite on :5173; run in a second terminal
```

See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, [development](docs/development.md) for tests, media and releases, and [DESIGN.md](DESIGN.md) for UI conventions. Report security problems privately: [SECURITY.md](SECURITY.md).

## license

[MIT](LICENSE). Copyright © 2026 devswha.
