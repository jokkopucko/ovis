<p align="center">
  <img src="public/icons/icon-192.png" alt="Ovis" width="100">
</p>

<h1 align="center">Ovis</h1>

<p align="center">
  <strong>Herdr を、スマートフォンとブラウザーで。</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-666666?labelColor=333333" alt="MIT license"></a>
  <a href="https://github.com/devswha/ovis/releases/latest"><img src="https://img.shields.io/github/v/release/devswha/ovis?label=release&labelColor=333333&color=666666" alt="Latest release"></a>
  <a href="https://github.com/devswha/ovis/stargazers"><img src="https://img.shields.io/github/stars/devswha/ovis?labelColor=333333&color=666666&logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/herdrdev/herdr"><img src="https://img.shields.io/badge/herdr-0.9.0%2B-666666?labelColor=333333" alt="herdr 0.9.0+"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <strong>日本語</strong> · <a href="README.ko.md">한국어</a>
  <br>
  <a href="https://ovis.sh/">公式サイト</a> ·
  <a href="#install">インストール</a> ·
  <a href="https://ovis.sh/demo/">デモを試す</a> ·
  <a href="docs/guide.md#quick-start">クイックスタート</a> ·
  <a href="docs/guide.md#faq">よくある質問</a> ·
  <a href="#docs">ドキュメント</a>
</p>

Ovis は、自分のコンピューターで動くコーディングエージェントをスマートフォン、ブラウザー、Mac アプリに届けます。ほとんどのエージェントはタップやクリックで答えるチャットになり、対応する確認や質問はカードで届き、通知をオンにしておけば、あなたを待っているときにプッシュ通知で知らせます。[herdr](https://github.com/herdrdev/herdr) と [Herdr デスクトップアプリのターミナル](docs/guide.md#herdr-app-terminals) のクライアントで、旧称は herdr web UI です。

<p align="center">
  <a href="https://ovis.sh/demo/"><img src="docs/media/readme/hero.webp" alt="デモで収録した Ovis の画面：デスクトップのブラウザーで Claude Code に続きのメッセージを送るとターンが一歩ずつ進み、次にデスクトップとスマートフォンが並び、git push origin feat/export-guard を確認する Codex の Allow command? カードでスマートフォンから Yes をタップすると両方の画面でカードが閉じ、最後に release タブをクリックするとシェルのペインが git log と bun test を実行する本物のターミナルとして開きます。"></a>
  <br>
  <sub>ブラウザーで動く<a href="https://ovis.sh/demo/">デモ</a>で収録しました。</sub>
</p>

<a id="install"></a>

## インストール

**コンピューターに**

- **Mac:** [Ovis.dmg](https://ovis.sh/Ovis.dmg) をダウンロードして開き、**Install** をクリックします。
- **Windows:** [Ovis.exe](https://ovis.sh/Ovis.exe) をダウンロードして実行し、**Install** をクリックします。
- **Linux:** ターミナルで次を実行します。
  ```bash
  curl -fsSL https://ovis.sh/install.sh | sh
  ```

どれも herdr と Bun がなければ一緒にインストールし、Node は不要です。ほかのインストール方法と手順：[INSTALL.md](INSTALL.md)。

**スマートフォンに**

- **iPhone:** TestFlight のベータ版、[ovis.sh/ja/beta](https://ovis.sh/ja/beta/) から。
- **Android:** Google Play のベータ版、[ovis.sh/ja/beta](https://ovis.sh/ja/beta/) から。
- **ブラウザー:** アプリなしで、ページをホーム画面に追加します。

接続するには、**Settings → Phone & devices** でエンドツーエンド暗号化の **Ovis リレー**をオンにし、その QR コードを Ovis アプリで読み取るか、スマートフォンのカメラで読み取ってブラウザーで Ovis を開きます。どこからでも使え、スマートフォン側の設定は不要です。[仕組み →](docs/guide.md#through-the-ovis-relay) Tailscale を使っている場合は、両方で Tailscale をオンにして、コンピューターに表示された QR コードを読み取ることもできます。

## できること

- **エージェントをチャットで。** Claude Code、Codex、OpenCode、pi、omp、Gajae Code、Hermes、Grok など、ほとんどはチャットで、デスクでもスマートフォンでも。[対応エージェント →](docs/guide.md#supported-agents)
- **確認や質問はカードで。** 対応する確認にはタップやクリックで答え、送る前にその確認がまだ有効かを確かめます。
- **プッシュ通知。** エージェントが質問したり作業を終えたりすると、アプリを閉じていても届きます。
- **本物のターミナルをワンクリックで。** herdr が表示しているのと同じペインが開き、スマートフォンではキーバーが付きます。
- **すべてのワークスペースをひとつのリストに。** タブ、分割ペイン、SSH でつないだ別の PC まで。あなたを待っているものには印が付きます。
- **無料、MIT ライセンス。** 自分のコンピューターで動き、登録するアカウントはありません。

[すべての機能 →](docs/guide.md#features)

**制約：** Ovis には [herdr](https://github.com/herdrdev/herdr) と電源の入った自分のコンピューターが必要で、スマートフォンからそのコンピューターに届く必要があります（Ovis リレー、Tailscale、VPN、SSH トンネル）。Herdr デスクトップアプリのターミナルは Linux と macOS のみ対応です。

**プライバシー：** セッションは各エージェントを動かすコンピューターに残り、Ovis にアカウントはありません。自分でオンにするまで動かない Ovis リレーは、どのスマートフォンがどの PC に、どのアドレスから、いつどれだけ送ったかは分かりますが、内容は読めません（[信頼モデル](docs/relay.md#trust-model)）。匿名の使用状況の集計はデフォルトで有効で、**Settings → About → Anonymous usage counts** で送信内容を確認してオフにできます。`OVIS_TELEMETRY=0` でもオフになります。[送信される内容 →](docs/guide.md#anonymous-usage-counts)

<a id="docs"></a>

## ドキュメント

- **[ユーザーガイド](docs/guide.md)：** [クイックスタート](docs/guide.md#quick-start) · [対応エージェント](docs/guide.md#supported-agents) · [機能](docs/guide.md#features) · [スマートフォン](docs/guide.md#on-your-phone) · [リモート PC](docs/remote-pcs.md) · [アクセスと安全性](docs/guide.md#access-and-safety) · [設定](docs/guide.md#configuration) · [キーボードショートカット](docs/guide.md#keyboard-shortcuts)
- **[よくある質問](docs/guide.md#faq)：** herdr 自身の TUI、Tailscale、コンピューターの外に出るもの、collie・Happy・Paseo などとの違い。
- **[INSTALL.md](INSTALL.md)：** すべてのインストール方法の手順と、うまくいかないときの対処。
- **[デモ](https://ovis.sh/demo/)：** 架空のセッションで動く本物のアプリを、ブラウザーで。
- **[変更履歴](CHANGELOG.md)**

<a id="thanks"></a>

## 謝辞

[herdr](https://github.com/herdrdev/herdr) を基盤とし、[chatmux](https://github.com/devswha/chatmux) から着想を得て、[xterm.js](https://xtermjs.org)、[React](https://react.dev)、[Bun](https://bun.sh)、[Lucide](https://lucide.dev) を使用しています。

[@Yoonwoo-Ha](https://github.com/Yoonwoo-Ha) をはじめ、貢献してくださったすべての方に感謝します。アイコンとウェブサイトのデザインを手伝ってくださった [@sanguneo](https://github.com/sanguneo) にも感謝します。

<a id="agent-instructions"></a>

## エージェント向けの手順

アプリのインストールを支援する場合は、[INSTALL.md](INSTALL.md) に従ってください。リポジトリを変更する場合は、[CONTRIBUTING.md](CONTRIBUTING.md)、[レビュールール](.github/REVIEW.md)、[AGENTS.md](AGENTS.md) に従ってください。

<a id="development"></a>

## 開発

```bash
git clone https://github.com/devswha/ovis.git
cd ovis
bun install

bun run server      # API + WebSocket on :7317
bun run dev         # Vite on :5173; run in a second terminal
```

変更の送り方は [CONTRIBUTING.md](CONTRIBUTING.md)、テスト、メディア素材、リリースについては[開発ドキュメント](docs/development.md)、UI の規約については [DESIGN.md](DESIGN.md) を参照してください。セキュリティの問題は [SECURITY.md](SECURITY.md) の手順で非公開で報告してください。

<a id="license"></a>

## ライセンス

[MIT](LICENSE)。Copyright © 2026 devswha.
