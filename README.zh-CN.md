<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>在手机和浏览器中使用 Herdr。</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/ovis/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/ovis?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/devswha/ovis/stargazers"><img src="https://img.shields.io/github/stars/devswha/ovis?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
  <br>
  <a href="https://ovis.sh/">官网</a> ·
  <a href="#install">安装</a> ·
  <a href="https://ovis.sh/demo/">体验演示</a> ·
  <a href="docs/guide.md#quick-start">快速入门</a> ·
  <a href="docs/guide.md#faq">常见问题</a> ·
  <a href="#docs">文档</a>
</p>

Ovis 把你电脑上的编程智能体带到手机、任意浏览器和 Mac 应用上：大多数智能体都是一段点击或轻点即可回答的聊天，支持的请求和审批以卡片呈现，打开通知后，有智能体需要你时会收到推送通知。它是 [herdr](https://github.com/herdrdev/herdr) 和 [Herdr 桌面应用终端](docs/guide.md#herdr-app-terminals) 的客户端，原名 herdr web UI。

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="在演示中录制的 Ovis 画面：在桌面浏览器中向 Claude Code 发送后续消息后，它的这一轮逐步展开；接着桌面和手机并排出现，Codex 通过 Allow command? 卡片询问是否运行 git push origin feat/export-guard，在手机上点按 Yes 后两个屏幕上的卡片同时关闭；最后点击 release 标签页，一个 shell 窗格作为运行 git log 和 bun test 的真正终端打开。"></a>
  <br>
  <sub>录制自可在浏览器中运行的<a href="https://ovis.sh/demo/">演示</a>。</sub>
</p>

<a id="install"></a>

## 安装

**在电脑上**

- **Mac：** 下载 [Ovis.dmg](https://ovis.sh/Ovis.dmg)，打开后点击 **Install**。
- **Windows：** 下载 [Ovis.exe](https://ovis.sh/Ovis.exe)，运行后点击 **Install**。
- **Linux：** 在终端中运行：
  ```bash
  curl -fsSL https://ovis.sh/install.sh | sh
  ```

三种方式都会在缺少时一并安装 herdr 和 Bun，无需 Node。其他安装方式和分步说明：见 [INSTALL.md](INSTALL.md)。

**在手机上**

- **iPhone：** TestFlight 公测版，见 [ovis.sh/zh/beta](https://ovis.sh/zh/beta/)。
- **Android：** Google Play 公测版，见 [ovis.sh/zh/beta](https://ovis.sh/zh/beta/)。
- **浏览器：** 无需应用，把页面添加到主屏幕即可。

要连接，在 **Settings → Phone & devices** 中打开端到端加密的 **Ovis 中继**，用 Ovis 应用扫描它的二维码，或用手机相机扫描，在手机浏览器中打开 Ovis：在任何地方都能用，手机上无需任何设置。[工作原理 →](docs/guide.md#through-the-ovis-relay) 如果你在用 Tailscale，也可以在电脑和手机上都开启 Tailscale，然后扫描电脑上显示的二维码。

## 能做什么

- **智能体变成聊天。** Claude Code、Codex、OpenCode、pi、omp、Gajae Code、Hermes、Grok 等，大多以聊天形式显示，在电脑前或手机上都能用。[支持的智能体 →](docs/guide.md#supported-agents)
- **请求和审批变成卡片。** 支持的请求点击或轻点即可回答，发送前会先确认请求仍然有效。
- **推送通知。** 智能体提问或完成任务时提醒你，即使应用已关闭。
- **真正的终端，一键即达。** 就是 herdr 显示的那个窗格，手机上还有按键栏。
- **所有工作区，一个列表。** 标签页、分屏和通过 SSH 添加的其他电脑，等你处理的会做标记。
- **免费，MIT 许可。** 运行在你自己的电脑上，无需注册账号。

[全部功能 →](docs/guide.md#features)

**限制：** Ovis 需要 [herdr](https://github.com/herdrdev/herdr) 和你自己开着的电脑，手机也要能访问这台电脑（Ovis 中继、Tailscale、VPN 或 SSH 隧道）。Herdr 桌面应用的终端仅支持 Linux 和 macOS。

**隐私：** 会话保留在运行各个智能体的电脑上，Ovis 没有账号。可选的 Ovis 中继默认关闭；开启后，它能看到哪部手机从哪个地址连接哪台电脑、何时传输、传了多少，但无法读取内容（[信任模型](docs/relay.md#trust-model)）。匿名使用计数默认启用，可在 **Settings → About → Anonymous usage counts** 中查看发送内容并关闭，也可设置 `OVIS_TELEMETRY=0` 关闭。[发送哪些内容 →](docs/guide.md#anonymous-usage-counts)

<a id="docs"></a>

## 文档

- **[用户指南](docs/guide.md)：** [快速入门](docs/guide.md#quick-start) · [支持的智能体](docs/guide.md#supported-agents) · [功能](docs/guide.md#features) · [手机](docs/guide.md#on-your-phone) · [远程电脑](docs/remote-pcs.md) · [访问与安全](docs/guide.md#access-and-safety) · [配置](docs/guide.md#configuration) · [键盘快捷键](docs/guide.md#keyboard-shortcuts)
- **[常见问题](docs/guide.md#faq)：** herdr 自带的 TUI、Tailscale、哪些内容会离开你的电脑，以及与 collie、Happy、Paseo 等的区别。
- **[INSTALL.md](INSTALL.md)：** 所有安装方式的分步说明，以及某一步失败时怎么办。
- **[演示](https://ovis.sh/demo/)：** 在浏览器中用虚构会话运行的真实应用。
- **[更新日志](CHANGELOG.md)**

## 致谢

本项目基于 [herdr](https://github.com/herdrdev/herdr) 构建，灵感来自 [chatmux](https://github.com/devswha/chatmux)，并使用了 [xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh) 和 [Lucide](https://lucide.dev)。

感谢所有贡献者，包括 [@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha)，也感谢帮助设计图标和网站的 [@sanguneo](https://github.com/sanguneo)。

## 智能体操作指南

正在协助他人安装应用？请遵循 [INSTALL.md](INSTALL.md)。修改仓库时，请遵循 [CONTRIBUTING.md](CONTRIBUTING.md)、[审查规则](.github/REVIEW.md)和 [AGENTS.md](AGENTS.md)。

## 开发

```bash
git clone https://github.com/devswha/ovis.git
cd ovis
bun install

bun run server      # API + WebSocket on :7317
bun run dev         # Vite on :5173; run in a second terminal
```

提交改动请参阅 [CONTRIBUTING.md](CONTRIBUTING.md)，测试、媒体素材和发布流程请参阅[开发文档](docs/development.md)，界面规范请参阅 [DESIGN.md](DESIGN.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

[MIT](LICENSE)。Copyright © 2026 devswha.
