# Contributing

Thanks for helping. Bugs and ideas go in an [issue](https://github.com/devswha/ovis/issues/new/choose);
security problems never do: see [SECURITY.md](SECURITY.md). For a larger change, open an issue first so
the approach can be agreed before you build it. Small fixes can go straight to a PR.

**Features.** Open a [feature request](https://github.com/devswha/ovis/issues/new?template=feature_request.yml)
and wait for a maintainer's yes before you write code; a feature PR without one may be closed, however
well it is built. The app is a bridge to herdr, so a feature should either mirror something herdr's
own TUI does, or meet a need that widely used coding-agent apps already meet (the Codex and Claude
apps, Paseo, T3 Code and the like). A convenience none of them offers, or one that adds a new setting
or UI concept for a narrow case, is likely to be declined: every one stays for good, to be maintained
and tested on every release.

Everything a PR is checked against is in this repository: this file, the
[review rules](.github/REVIEW.md), the [development guide](docs/development.md),
[DESIGN.md](DESIGN.md) and the `AGENTS.md` files ([root](AGENTS.md), [server](server/AGENTS.md),
[src](src/AGENTS.md)), which hold the invariants that people and coding agents both follow.
Contributions are licensed under the repository's [MIT license](LICENSE). Say in the PR when code is
adapted from another project, with its license. Before your first PR is merged, sign the
[Contributor License Agreement](CLA.md): the CLA Assistant bot asks on the PR, and you sign once by
commenting the sentence it gives.

## Set up

- Linux (x64, arm64), macOS or Windows x64. Windows uses the screen mirror and needs no terminal addon; Alpine and 32-bit ARM have no addon build.
- Bun 1.4 or newer, and herdr 0.9.0 or newer for the integration tests. Terminals in a checkout run on
  the Rust PTY host (`cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml`, or
  `bun scripts/pty-sidecar.ts install` on a release tag); Node 18 or newer is the fallback, and the PTY
  tests run on both. CI runs Bun 1.4.2, Node 22 and herdr 0.9.3, all pinned in
  [.github/actions/setup-ci/action.yml](.github/actions/setup-ci/action.yml).

```bash
bun install
bun run server   # API + WebSocket on :7317
bun run dev      # Vite on :5173, proxies /api and /ws
```

Neither command updates itself; only `bun run start` and the plugin run the updater.

## Branches and pull requests

- Fork, branch from `main` (`feat/…`, `fix/…`, `chore/…`, `docs/…`) and open the PR against `main`.
  There is no `develop` branch; releases are `vX.Y.Z` tags on `main`.
- Independent changes should use independent PRs from `main`. The only exception is a stack explicitly
  managed by a maintainer for a genuine code dependency; code conflicts and approval gates are
  scheduling constraints, not reasons to stack. See the [coordinated-work procedure](docs/development.md#coordinated-work).
  Contributors must not assume elevated permissions or that a stack has been authorized.
- One change per PR. Changes that cannot stand apart, because one needs another's code, may share
  a PR: keep each as its own commit, in the order they depend on each other, and say in the
  description what needs what. PRs are squash merged, so the PR title becomes the commit:
  `type(scope): summary`, for example `fix(chat): keep the finished turn finished after Send`.
  The merge adds `(#N)`. The PR title check (`.github/workflows/pr-title.yml`) checks the title
  again whenever it is edited.
- Fill in the [PR template](.github/pull_request_template.md): what changed and how you checked it.
- CI on a fork's PR waits until a maintainer approves the run. That approval is not a review.

## Checks

`bun run check fast` runs the **Fast checks** CI job, and `bun run check full` adds the
**Integration and browser** job, on a herdr of its own apart from the one you work in
([docs/development.md](docs/development.md#checks)).

**Fast checks** is these, one by one; none needs herdr:

```bash
bun run generate:types --check   # herdr's and hc's generated types match scripts/*-schema.json
bun run generate:themes --check  # theme copies match the theme blocks of src/styles.css
bun run typecheck
bun run build
bun run test:unit
```

**Integration and browser** needs herdr on `PATH` (or `OVIS_HERDR_BIN`) and Chrome
(`CHROME_PATH`, default `/opt/google/chrome/chrome`):

```bash
bun run test:integration   # runs the files 4 at a time on `ovis-test-1` to `-4`, which it
                           # stops itself; HERDR_TEST_SHARDS=1 runs them one by one on `-1`
bun run test:ui            # builds, then browser regression on `ovis-test`; stop it with
                           # herdr --session ovis-test server stop
```

`bun test` runs the unit and integration suites together. Remote-PC changes also have
`bun run test:ssh`. Tests and screenshots use panes and state they create themselves, never your
running terminals: see [development](docs/development.md#checks).

## Terminology

herdr, the browser and the agents use some of the same words. This index lists the five that matter
for Ovis's code, with a link to the place that defines each one.

| Term | What it is | Defined in |
| --- | --- | --- |
| **Pane** | A herdr terminal and the process in it. herdr owns its pty, scrollback and agent state; Ovis attaches to it, or mirrors it where there is no attach. | [AGENTS.md](AGENTS.md), [How it works](docs/guide.md#how-it-works) |
| **Tab** | A herdr tab: one or more panes split inside one workspace, as herdr's prefix+c makes. Not a browser tab. | [Quick start](docs/guide.md#quick-start), [Features](docs/guide.md#features) |
| **Workspace** | A herdr workspace: a project's group of tabs and their panes, one sidebar row each. | [Quick start](docs/guide.md#quick-start) |
| **PC** | This computer or a remote one reached over SSH, each through its own herdr socket. The sidebar groups PC → workspace → pane, and drafts, held messages, recent panes and notifications name the PC together with the pane. | [Remote PCs](docs/remote-pcs.md), [Disconnects and updates](docs/remote-pcs.md#disconnects-and-updates) |
| **Agent session** | An agent's own conversation: its ID and history in that agent's store. A resumable session-history row can reopen it; not every row carries resume data. Not a pane, a workspace or a herdr session. | `SessionHistoryRow` in [shared/session-history.ts](shared/session-history.ts), [How it works](docs/guide.md#how-it-works) |

A **browser tab** is the browser tab showing Ovis; it shows herdr tabs but is not one. A
**herdr session** is a running herdr server, picked by its socket
([`HERDR_SOCKET`](docs/guide.md#configuration)), whose workspaces Ovis shows; it is not an agent
session. The code and the docs call both a herdr session (the server's herdr instance) and an
agent session (a coding agent's conversation history) a session, so say which one you mean when
the context does not make it clear. The dialog that makes a workspace is
**New workspace** (the UI wording test in [src/conventions.test.ts](src/conventions.test.ts)).

## What a change needs

- **HTTP or WebSocket contract:** change both sides through `shared/protocol.ts` and cover it with a
  contract test (`server/api.contract.test.ts` for endpoints). A test that needs a live herdr is named
  `*.contract.test.ts`.
- **Stored formats:** a change to the structure of a stored browser record or state-directory
  file follows the [stored-format rules](docs/development.md#stored-format-changes).
- **herdr wire types:** never edit `shared/herdr-api.generated.ts` or
  `server/herdr-core/hc-api.generated.ts`; run `bun run generate:types`.
- **Theme colors:** edit them only in the theme blocks of `src/styles.css`. Never edit
  `src/lib/themes.generated.ts` or the generated copies in DESIGN.md, `index.html` and
  `public/manifest.webmanifest`; run `bun run generate:themes`.
- **UI text:** every new `t("…")` string needs a Korean, Japanese and Simplified Chinese entry with
  the same placeholders. A string that only one feature's files use goes in that feature's files in
  `src/lib/i18n/` when it has them (`settings.ko.ts`, `settings.ja.ts` and `settings.zh.ts` for the
  Settings dialog, with its Access rows in `settings-access.*.ts` and the composer's optional
  buttons and chips in `settings-composer.*.ts`; each file's header lists its
  feature's files). Any other string goes in
  `src/lib/i18n.ko.ts`, `i18n.ja.ts` and `i18n.zh.ts`, and so does a feature's string once another
  feature uses it too. `bun run test:unit` fails on a missing, unused or untranslated entry, and on one
  kept in the wrong file or in different files across the three languages.
- **UI languages:** the app keeps English, Korean, Japanese and Simplified Chinese and does not take
  new ones. Every language has to translate each later string, so a PR that adds a language is
  closed.
- **UI:** component CSS uses the tokens in `src/styles.css` (see [DESIGN.md](DESIGN.md)).
- **Themes:** besides the app's own Amber, Charcoal, Codex, Catppuccin and Black, a theme is added only when
  herdr ships it as a built-in; a PR with any other theme is closed. Any other theme is a
  [theme file](docs/themes.md) its users import, published from its author's own repository. Each
  built-in theme is a complete block
  in `src/styles.css`, the one place its colors are written. Start from
  `bun scripts/herdr-theme-proposal.ts`, write the block by hand, and record every role whose value
  differs from the raw herdr mapping (`mapTheme`) in `scripts/herdr-theme-overrides.ts` with its dE
  and a reason, including repairs the proposal tool already applied. Every
  entry has to pass the AA contrast test on the committed hex. Then run `bun run generate:themes`;
  never edit `src/lib/themes.generated.ts` or the other generated copies.
- **The browser demo:** the [demo](https://ovis.sh/demo/) redeploys on every
  merge to `main`. A feature meant to show there needs an answer in `site/demo/transport.ts`; anything
  else gets its 404.
- **Changelog:** a change users notice gets a small file in [changelog.d/](changelog.d/README.md)
  with its `### Added`, `### Changed` or `### Fixed` lines; do not edit CHANGELOG.md, and do not
  bump versions. The link to your PR and your name are added at release, so you can leave them out.

## Releases

Maintainers only: see [development](docs/development.md#releasing). App releases are cut by the
Release workflow; never push a `vX.Y.Z` tag by hand, since installed updaters act on tags alone.
Remote-PC runtime bundles are published with a `remote-vN` tag, and an app release requires the matching one.
