# Ovis Design System

Extracted from the shipped client (`src/styles.css`, `src/components/*`), not invented. The machine
copy of every token is the `:root` block in `src/styles.css`; every table below mirrors it value for
value. When a component needs a value that is not here, add it to both first.

## 1. Atmosphere & Identity

The herdr look (amber) is a warm terminal: an amber-phosphor console on lamp-lit graphite (dark) or ledger paper (light),
with chat-app clarity. Tonal surfaces and hairlines keep the chrome out of the way. There is ONE
chrome color, amber: focus, the chosen lens, the terminal cursor and the user's own action (Send, primary
buttons). Agent states carry the remaining saturated colors and none of them is amber. The user's
chat turns are neutral raised cards, so a long thread never turns into a wall of color. Dark is the
default, light follows the same hierarchy, and comfortable or compact density changes scale without
changing information architecture. A new browser starts on the Codex theme (dark and light), which
draws this hierarchy in Codex's neutral surfaces and blue accent; amber, charcoal, Catppuccin and
herdr's built-in themes are picked in Settings → Appearance → Dark theme and Light theme. Amber
stays the base every theme block overrides and the look a browser keeps when it saved a theme
while amber was the default; the saved theme, not amber, is the page's first frame (see Rules). Settings are saved on a user's first
change, so a browser that never changed one moves to Codex with everyone new.

The sidebar is one grid: a leading cell that says who or what a row is (the coding agent's brand
mark, else the place's own glyph), a title, and a trailing cell that says how it is. Workspaces
and Agents are independent lists, as in herdr's Spaces and Agents panels; tab and pane navigation
stays over the terminal and in the palette. Sections are parted by space and a dim head, never by
a rule; the Agents list's workspace cards are an edge around rows, not a line between sections.
Hover and selection are one neutral fill at two strengths. Brand marks are the only color
there that is not a state, and a ready row draws no state at all. Amber connects focus, the chosen
lens glyph and the terminal cursor.

Messages say only what the person needs now, not everything the app knows:
- Something to do: one sentence and the control that does it ("Couldn't attach [Try again]").
- Only waiting: one muted phrase, in one place ("Connecting…"); never the same state twice on screen.
- Causes, internals and conditions stay folded away (a Details toggle) or appear only when they
  apply. A known cause is the sentence ("PC disk is full"); a generic fallback never pushes it aside.
- Another PC's answer the server will not hold (past its size ceiling, or unreadable where a
  watcher's prompt must be redacted, `server/remote-json.ts`) is said in one of two fixed sentences
  in the user's language, never with any of the answer, its address or its size. They sit where
  each surface already puts the server's words: a PC's state line, its setup dialog's error
  (`machineErrorText`), and the Details of any request the PC proxy refused (`errorFrom` in
  `lib/api.ts`, by the 502 code). Nothing new is drawn. None of the reference apps (the Codex and
  Claude apps, Paseo, T3 Code) relays a second PC's bridge, so there is no app precedent to follow;
  this applies the known-cause rule above.
- One situation, one message, one place.
- The resting screen is calm: a destructive control looks neutral until it asks to confirm;
  danger color is for the moment of risk. PC removal is the exception: its red tint and border
  stay visible before and after the first click arms the second, so the destructive consequence is
  clear before confirmation. T3 Code's [outlined destructive button](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/ui/button.tsx)
  is a reference for restrained destructive treatment and focus feedback; this uses herdr's
  existing danger tokens and borrows no code. A hovered danger button keeps its tint and border
  everywhere in the app, never the neutral hover fill, and draws that border twice as thick, so the
  pointer still shows. A pending PC removal keeps its full strength so its warning text and border
  stay readable in every theme; disabled because another action of the panel is running, Remove PC
  dims like its neighbours.

## 2. Color

### Palette

Only tokens overridden by `[data-theme="light"]` have a light value. Both columns are literal CSS.

<!-- BEGIN GENERATED THEMES -->
| Role | Token | Dark | Light |
|------|-------|------|-------|
| Surface/base | `--bg` | `#12100e` | `#eeeae2` |
| Surface/panel | `--bg-panel` | `#181613` | `#faf8f3` |
| Surface/elevated | `--bg-elevated` | `#211e1a` | `#f2eee6` |
| Surface/hover | `--bg-hover` | `#2a2621` | `#e8e2d6` |
| Surface/input | `--bg-input` | `#1c1916` | `#fffdf9` |
| Border | `--border` | `#2d2924` | `#dcd4c6` |
| Border/strong | `--border-strong` | `#3e3830` | `#c5baa8` |
| Chat bubble edge | `--bubble-border` | `transparent` | `var(--border)` |
| Text/primary | `--text` | `#d8d0c3` | `#2a251f` |
| Text/dim | `--text-dim` | `#9b9183` | `#685e52` |
| Text/strong | `--text-strong` | `#f2ebdf` | `#16120d` |
| Accent | `--accent` | `#f0a830` | `#8c5000` |
| Accent/tint | `--accent-tint` | `rgba(240, 168, 48, 0.13)` | `rgba(140, 80, 0, 0.1)` |
| Primary | `--primary` | `#f0a830` | `#c57d12` |
| Primary/hover | `--primary-hover` | `#f6bb55` | `#d48c1f` |
| Primary/text | `--primary-text` | `#1b1407` | `#1b1407` |
| Primary/tint | `--primary-tint` | `rgba(240, 168, 48, 0.16)` | `rgba(197, 125, 18, 0.14)` |
| Status/idle | `--status-idle` | `#9b9183` | `#685e52` |
| Status/working | `--status-working` | `#6cb8d6` | `#155a72` |
| Status/blocked | `--status-blocked` | `#ff7b70` | `#a82323` |
| Status/done | `--status-done` | `#93c36b` | `#2f6317` |
| Working/tint | `--status-working-tint` | `rgba(108, 184, 214, 0.14)` | `rgba(21, 90, 114, 0.12)` |
| Blocked/tint | `--status-blocked-tint` | `rgba(255, 123, 112, 0.14)` | `rgba(168, 35, 35, 0.12)` |
| Done/tint | `--status-done-tint` | `rgba(147, 195, 107, 0.14)` | `rgba(47, 99, 23, 0.12)` |
| Indicator/working | `--indicator-working` | `#f9e2af` | `#df8e1d` |
| Indicator/blocked | `--indicator-blocked` | `#f38ba8` | `#d20f39` |
| Indicator/done | `--indicator-done` | `#94e2d5` | `#179299` |
| Indicator/idle | `--indicator-idle` | `#a6e3a1` | `#40a02b` |
| Indicator/unknown | `--indicator-unknown` | `#6c7086` | `#9ca0b0` |
| Danger/tint | `--danger-tint` | `rgba(255, 123, 112, 0.12)` | `rgba(168, 35, 35, 0.1)` |
| Danger/text | `--danger-text` | `#ffd9d4` | `#8f1d1d` |
| Notice | `--notice` | `#e8c55c` | `#7a5a00` |
| Overlay/scrim | `--scrim` | `rgba(8, 6, 4, 0.55)` | `rgba(40, 32, 22, 0.35)` |
| Drawer shadow | `--shadow-drawer` | `0 0 40px rgba(0, 0, 0, 0.6)` | `0 0 40px rgba(40, 32, 22, 0.22)` |
| Popover shadow | `--shadow-pop` | `0 16px 48px rgba(0, 0, 0, 0.55), 0 0 0 1px var(--border)` | `0 16px 48px rgba(40, 32, 22, 0.16), 0 0 0 1px var(--border)` |
| Card shadow | `--shadow-card` | `0 4px 16px rgba(0, 0, 0, 0.35)` | `0 4px 16px rgba(40, 32, 22, 0.07)` |
| Document surface | `--pdf-page` | `#ffffff` | `#ffffff` |
| Terminal/background | `--term-bg` | `#181613` | `#faf8f3` |
| Terminal/foreground | `--term-fg` | `#d8d0c3` | `#2a251f` |
| Terminal/cursor | `--term-cursor` | `#f0a830` | `#8c5000` |
| Terminal/selection | `--term-selection` | `#4a3d26` | `#f0d9ae` |
| Syntax/keyword | `--syntax-keyword` | `#e8875f` | `#a33a17` |
| Syntax/string | `--syntax-string` | `#a8c17c` | `#4b6b18` |
| Syntax/number | `--syntax-number` | `#d6a0c9` | `#8a3f7a` |
| Syntax/type | `--syntax-type` | `#6cb8d6` | `#155a72` |
| Syntax/variable | `--syntax-variable` | `#e0c08f` | `#7a5418` |
| Syntax/meta | `--syntax-meta` | `#b49dd6` | `#5d4791` |
| Alert/background | `--droplet-bg` | `#000` | `#000` |
| Alert/text | `--droplet-text` | `#f5f5f7` | `#f5f5f7` |
| Alert/dim text | `--droplet-text-dim` | `rgba(245, 245, 247, 0.62)` | `rgba(245, 245, 247, 0.62)` |
| Alert/blocked | `--droplet-blocked` | `#ff8a80` | `#ff8a80` |
| Alert/done | `--droplet-done` | `#9fd47a` | `#9fd47a` |
| Alert/mark background | `--droplet-mark-bg` | `rgba(255, 255, 255, 0.1)` | `rgba(255, 255, 255, 0.1)` |
| Alert/ring | `--droplet-ring` | `rgba(255, 255, 255, 0.1)` | `rgba(255, 255, 255, 0.1)` |
| Alert/shadow | `--droplet-shadow` | `rgba(0, 0, 0, 0.35)` | `rgba(0, 0, 0, 0.35)` |

### Light terminal ANSI colours

Each colour is at least 4.5:1 on its row's `--term-bg`. Dark rows use xterm's defaults.
Normal and bright slots may share a colour to preserve the palette while keeping both readable.

| ANSI | xterm key | amber | charcoal | codex | catppuccin | catppuccin-latte | tokyo-night-day | gruvbox-light | one-light | solarized-light | kanagawa-lotus | rose-pine-dawn |
|------|-----------|-------|-------|-------|-------|-------|-------|-------|-------|-------|-------|-------|
| 0 | `black` | `#2a251f` | `#242424` | `#1a1c1f` | `#4c4f69` | `#4c4f69` | `#3760bf` | `#3c3836` | `#383a42` | `#556a72` | `#545464` | `#464261` |
| 1 | `red` | `#a82323` | `#b3261e` | `#b3261e` | `#ac0c2f` | `#ac0c2f` | `#90001b` | `#9d0006` | `#a51110` | `#b60006` | `#95002b` | `#873a52` |
| 2 | `green` | `#2f6317` | `#22743a` | `#22743a` | `#28651b` | `#28651b` | `#405b1f` | `#676200` | `#287c2a` | `#5d6e00` | `#4a6228` | `#286983` |
| 3 | `yellow` | `#8c5000` | `#8a5300` | `#8a5300` | `#8a5710` | `#8a5710` | `#6c4d1f` | `#8e5100` | `#995f00` | `#8a5f00` | `#625b2a` | `#9e5600` |
| 4 | `blue` | `#155a72` | `#0b6e8a` | `#0b6e8a` | `#1750bf` | `#1750bf` | `#004db6` | `#076678` | `#2f64dd` | `#006baf` | `#4d699b` | `#286983` |
| 5 | `magenta` | `#8a3f7a` | `#6f42c1` | `#6f42c1` | `#712fc6` | `#712fc6` | `#7847bd` | `#8f3f71` | `#a626a4` | `#c12073` | `#624c83` | `#755f8d` |
| 6 | `cyan` | `#0f6b6f` | `#0f6f74` | `#0f6f74` | `#0e6b70` | `#0e6b70` | `#005f4a` | `#316b48` | `#0072a9` | `#00746d` | `#216276` | `#33717c` |
| 7 | `white` | `#685e52` | `#5f5b56` | `#5f5b56` | `#5c5f77` | `#5c5f77` | `#41508a` | `#504945` | `#686b77` | `#5a6a6c` | `#43436c` | `#605b78` |
| 8 | `brightBlack` | `#5a5045` | `#4e4b47` | `#4e4b47` | `#64677d` | `#64677d` | `#41508a` | `#504945` | `#686b77` | `#586e75` | `#43436c` | `#605b78` |
| 9 | `brightRed` | `#c42b2b` | `#c92d24` | `#c92d24` | `#c41545` | `#c41545` | `#90001b` | `#9d0006` | `#a51110` | `#b60006` | `#95002b` | `#873a52` |
| 10 | `brightGreen` | `#3b741c` | `#277d3f` | `#277d3f` | `#2f7620` | `#2f7620` | `#405b1f` | `#676200` | `#287c2a` | `#5d6e00` | `#4a6228` | `#286983` |
| 11 | `brightYellow` | `#9d5a00` | `#9f6100` | `#9f6100` | `#905c13` | `#905c13` | `#6c4d1f` | `#8e5100` | `#995f00` | `#8a5f00` | `#625b2a` | `#9e5600` |
| 12 | `brightBlue` | `#1d6f8c` | `#1a7391` | `#1a7391` | `#0b59f4` | `#0b59f4` | `#004db6` | `#076678` | `#2f64dd` | `#006baf` | `#4d699b` | `#286983` |
| 13 | `brightMagenta` | `#a24b90` | `#7f52d1` | `#7f52d1` | `#8839ef` | `#8839ef` | `#7847bd` | `#8f3f71` | `#a626a4` | `#c12073` | `#624c83` | `#755f8d` |
| 14 | `brightCyan` | `#117676` | `#13767e` | `#13767e` | `#13737a` | `#13737a` | `#005f4a` | `#316b48` | `#0072a9` | `#00746d` | `#216276` | `#33717c` |
| 15 | `brightWhite` | `#16120d` | `#111111` | `#0d0d0d` | `#4c4f69` | `#4c4f69` | `#3760bf` | `#3c3836` | `#383a42` | `#556a72` | `#545464` | `#464261` |
<!-- END GENERATED THEMES -->

The glass tokens are expressions over the palette above, not colors of their own:

| Role | Token | Dark | Light |
|------|-------|------|-------|
| Glass bar | `--bar-bg` | `color-mix(in srgb, var(--bg-panel) 72%, transparent)` | same expression |
| Glass card | `--card-glass` | `color-mix(in srgb, var(--bg-elevated) 80%, transparent)` | same expression |
| Glass blur | `--glass-blur` | `saturate(180%) blur(20px)` | same |

`--pdf-page` is the one color with the same value in both columns, on purpose: a PDF page is
paper, not UI, and the viewer (`.file-viewer-pdf`) must not tint it for the theme. It is named in
`src/styles.css` under the same note and no theme or palette block overrides it.

### Themes

`settings.darkTheme` and `settings.lightTheme` (both `codex` by default) name the theme each mode
draws. The resolved entry is written as `data-theme` (its mode) and `data-palette` (its id). Any
theme can be picked on either side. Picking one half of a herdr pair also sets the other side to
its sibling, but only while that side still holds `codex` (the default, even if picked by hand),
`amber` (the default before it) or the sibling of the previous pick; any other value is kept. A
dark theme picked for light mode still draws dark.
The themes are amber, charcoal, codex, catppuccin and black plus herdr's built-ins; herdr's `terminal` theme is
not offered. The tables above are amber, the base blocks; every other theme overrides them in a
`[data-theme][data-palette]` block of `src/styles.css`.

The theme blocks of `src/styles.css` are the theme table and the one place a theme color is
edited: `:root` is dark amber, `[data-theme="light"]` is light amber and
`[data-theme="<mode>"][data-palette="<id>"]` is every other entry. `bun run generate:themes`
(`scripts/generate-themes.ts`) reads them and writes the copies: `src/lib/themes.generated.ts`
(the supported entries with their roles, xterm colors, panel color and page surface `bg`), the amber table above
between its `GENERATED THEMES` markers, the `theme-color` tag in `index.html` and the manifest's
`theme_color` and `background_color`. Never edit those copies by hand; `--check` fails when one
is stale. The tables list amber's UI roles and every light row's terminal ANSI colours; read
another theme's UI values in its block. A herdr theme
starts from `bun scripts/herdr-theme-proposal.ts`. Every role whose value differs from the raw
herdr mapping (`mapTheme`), including repairs the proposal tool already made, is listed in
`scripts/herdr-theme-overrides.ts` with its dE and reason; every entry passes AA on its
committed hex.

`--bubble-border` is the edge of the chat's user bubble. It is `transparent` where `--bg-elevated`
alone parts the bubble from `--bg`: dark amber and dark charcoal. It is `var(--border)`
where the two surfaces sit close: every light theme (the `[data-theme="light"]` block sets it for
all palettes) and dark Catppuccin, whose elevated surface is darker than its canvas.

- **Charcoal** is a neutral Ghostty-style dark: near-black canvas, a slightly lighter panel and
  terminal, a near-white accent and primary, and muted agent states. It keeps amber's rounded
  corners and card shadow. In light it's plain paper with an ink accent and cursor.
- **Codex** copies the Codex desktop app's default theme export: surface `#ffffff` / `#181818`,
  ink `#1a1c1f` / `#ffffff` and accent `#3a83f7`. The chrome sits one quiet step off the surface,
  the primary control is ink as Codex's send button, and agent states and code take Codex's
  diff and skill colors, moved in lightness only as far as AA needs.
- **Catppuccin** follows [catppuccin.com/palette](https://catppuccin.com/palette/), its style guide
  and its Zed port: Mocha in dark, Latte in light. In both the content (chat canvas `--bg`,
  terminal) is Base, the chrome (`--bg-panel`: sidebar, the header over it and on a phone, tabs) and elevated surfaces Mantle,
  dimmed text Subtext1, cursor Rosewater, selection Overlay2 at 25% over Base. Dark uses palette
  colors, with only the primary hover (Mauve lightened) and the tints derived; its states are
  Blue / Maroon / Green (Maroon, not Red, keeps input AA on a hovered row). Light keeps Latte's
  surfaces and text, with Crust as the hover, the darkest surface Subtext1 stays AA on. Latte's
  accents are under 4.5:1 on these surfaces, so each keeps its hue and is darkened until it passes
  AA. It keeps amber's rounded corners.

- **Black** uses Tokyo Night colors on a pure-black canvas, panel, inputs and terminal.
  Raised surfaces are near-black.
  It has no light sibling.

### Herdr theme pair notes

Theme colors remain authored only in `src/styles.css`; the notes here describe deviations, not
another color table. Catppuccin Latte is a second selector on the existing legacy light block.
Its proposal is deliberately not applied: the permanent legacy oracle takes precedence over the
herdr mapping, including existing surface, accent, cursor, status and syntax choices.

- **tokyo-night**: `--border` moves dE 12.89; herdr surface1 replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible.
- **tokyo-night**: `--border-strong` moves dE 8.72; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.
- **tokyo-night-day**: `--text` moves dE 6.18; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--text-dim` moves dE 11.81; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--text-strong` moves dE 6.18; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--status-working` moves dE 18.99; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--status-blocked` moves dE 23.41; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--status-done` moves dE 12.85; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--status-working-tint` moves dE 18.99; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--status-blocked-tint` moves dE 23.41; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--status-done-tint` moves dE 12.85; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--danger-tint` moves dE 23.41; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--danger-text` moves dE 23.41; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--scrim` moves dE 6.18; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--line-number` moves dE 11.81; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--syntax-function` moves dE 14.94; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--syntax-keyword` moves dE 5.15; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--syntax-string` moves dE 8.95; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--syntax-number` moves dE 11.25; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--syntax-type` moves dE 10.85; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--syntax-variable` moves dE 6.18; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--syntax-meta` moves dE 14.24; its lightness changes to keep serialized text readable at the 4.6 target.
- **tokyo-night-day**: `--shadow-drawer` moves dE 6.18; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--shadow-pop` moves dE 6.18; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--shadow-card` moves dE 6.18; it follows the repaired foreground so its derived color stays consistent.
- **tokyo-night-day**: `--border` moves dE 8.13; herdr surface1 replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible.
- **tokyo-night-day**: `--border-strong` moves dE 9.61; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.

- **gruvbox**: `--status-working` moves dE 9.80; its lightness changes to keep serialized text readable at the 4.6 target.
- **gruvbox**: `--status-blocked` moves dE 18.18; its lightness changes to keep serialized text readable at the 4.6 target.
- **gruvbox**: `--status-working-tint` moves dE 9.80; it follows the repaired foreground so its derived color stays consistent.
- **gruvbox**: `--status-blocked-tint` moves dE 18.18; it follows the repaired foreground so its derived color stays consistent.
- **gruvbox**: `--danger-tint` moves dE 18.18; it follows the repaired foreground so its derived color stays consistent.
- **gruvbox**: `--danger-text` moves dE 18.18; it follows the repaired foreground so its derived color stays consistent.
- **gruvbox**: `--border` moves dE 6.71; herdr surface1 replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible.
- **gruvbox**: `--border-strong` moves dE 20.90; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.
- **gruvbox-light**: `--status-done` moves dE 9.96; its lightness changes to keep serialized text readable at the 4.6 target.
- **gruvbox-light**: `--status-done-tint` moves dE 9.96; it follows the repaired foreground so its derived color stays consistent.
- **gruvbox-light**: `--syntax-string` moves dE 6.17; its lightness changes to keep serialized text readable at the 4.6 target.
- **gruvbox-light**: `--syntax-type` moves dE 12.38; its lightness changes to keep serialized text readable at the 4.6 target.
- **gruvbox-light**: `--syntax-meta` moves dE 5.51; its lightness changes to keep serialized text readable at the 4.6 target.
- **gruvbox-light**: `--border` moves dE 6.90; herdr surface1 replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible.
- **gruvbox-light**: `--border-strong` moves dE 20.78; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.

- **one-dark**: `--status-blocked` moves dE 12.35; its lightness changes to keep serialized text readable at the 4.6 target.
- **one-dark**: `--status-blocked-tint` moves dE 12.35; it follows the repaired foreground so its derived color stays consistent.
- **one-dark**: `--danger-tint` moves dE 12.35; it follows the repaired foreground so its derived color stays consistent.
- **one-dark**: `--danger-text` moves dE 12.35; it follows the repaired foreground so its derived color stays consistent.
- **one-dark**: `--border` moves dE 7.45; herdr surface1 replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible.
- **one-dark**: `--border-strong` moves dE 11.20; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.
- **one-light**: `--status-working` moves dE 14.64; its lightness changes to keep serialized text readable at the 4.6 target.
- **one-light**: `--status-blocked` moves dE 17.89; its lightness changes to keep serialized text readable at the 4.6 target.
- **one-light**: `--status-done` moves dE 20.75; its lightness changes to keep serialized text readable at the 4.6 target.
- **one-light**: `--status-working-tint` moves dE 14.64; it follows the repaired foreground so its derived color stays consistent.
- **one-light**: `--status-blocked-tint` moves dE 17.89; it follows the repaired foreground so its derived color stays consistent.
- **one-light**: `--status-done-tint` moves dE 20.75; it follows the repaired foreground so its derived color stays consistent.
- **one-light**: `--danger-tint` moves dE 17.89; it follows the repaired foreground so its derived color stays consistent.
- **one-light**: `--danger-text` moves dE 17.89; it follows the repaired foreground so its derived color stays consistent.
- **one-light**: `--syntax-function` moves dE 6.19; its lightness changes to keep serialized text readable at the 4.6 target.
- **one-light**: `--syntax-string` moves dE 12.04; its lightness changes to keep serialized text readable at the 4.6 target.
- **one-light**: `--syntax-type` moves dE 12.40; its lightness changes to keep serialized text readable at the 4.6 target.
- **one-light**: `--syntax-meta` moves dE 5.55; its lightness changes to keep serialized text readable at the 4.6 target.
- **one-light**: `--border-strong` moves dE 21.23; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.

- **solarized**: `--text` moves dE 6.75; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized**: `--text-dim` moves dE 11.25; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized**: `--text-strong` moves dE 6.75; it follows the repaired foreground so its derived color stays consistent.
- **solarized**: `--status-working` moves dE 24.14; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized**: `--status-blocked` moves dE 29.43; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized**: `--status-done` moves dE 19.69; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized**: `--status-working-tint` moves dE 24.14; it follows the repaired foreground so its derived color stays consistent.
- **solarized**: `--status-blocked-tint` moves dE 29.43; it follows the repaired foreground so its derived color stays consistent.
- **solarized**: `--status-done-tint` moves dE 19.69; it follows the repaired foreground so its derived color stays consistent.
- **solarized**: `--danger-tint` moves dE 29.43; it follows the repaired foreground so its derived color stays consistent.
- **solarized**: `--danger-text` moves dE 29.43; it follows the repaired foreground so its derived color stays consistent.
- **solarized**: `--line-number` moves dE 11.25; it follows the repaired foreground so its derived color stays consistent.
- **solarized**: `--syntax-function` moves dE 6.94; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized**: `--syntax-keyword` moves dE 11.95; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized**: `--syntax-number` moves dE 12.29; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized**: `--border` moves dE 7.51; herdr active_row_bg replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible; surface1 is already `--border-strong`.
- **solarized-light**: `--text` moves dE 5.80; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--text-dim` moves dE 14.20; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--text-strong` moves dE 26.00; herdr solarized surface0 (base02) replaces the repaired `--text`, which sits 1.01:1 from `--text-dim` while `--bg-hover` equals `--bg-elevated`, so strong text and the chosen segment part from quiet text.
- **solarized-light**: `--status-working` moves dE 14.20; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--status-blocked` moves dE 9.89; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--status-done` moves dE 17.94; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--status-working-tint` moves dE 14.20; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--status-blocked-tint` moves dE 9.89; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--status-done-tint` moves dE 17.94; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--danger-tint` moves dE 9.89; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--danger-text` moves dE 9.89; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--scrim` moves dE 5.80; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--line-number` moves dE 14.20; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--syntax-function` moves dE 10.19; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--syntax-keyword` moves dE 5.11; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--syntax-string` moves dE 14.18; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--syntax-type` moves dE 13.99; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--syntax-variable` moves dE 5.80; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--syntax-meta` moves dE 14.09; its lightness changes to keep serialized text readable at the 4.6 target.
- **solarized-light**: `--shadow-drawer` moves dE 5.80; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--shadow-pop` moves dE 5.80; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--shadow-card` moves dE 5.80; it follows the repaired foreground so its derived color stays consistent.
- **solarized-light**: `--border` moves dE 6.34; herdr selection_bg replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible; surface1 is already `--border-strong`.

- **kanagawa**: `--status-working` moves dE 9.73; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa**: `--status-blocked` moves dE 24.67; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa**: `--status-done` moves dE 14.97; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa**: `--status-working-tint` moves dE 9.73; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa**: `--status-blocked-tint` moves dE 24.67; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa**: `--status-done-tint` moves dE 14.97; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa**: `--danger-tint` moves dE 24.67; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa**: `--danger-text` moves dE 24.67; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa**: `--border-strong` moves dE 21.13; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.
- **kanagawa-lotus**: `--status-working` moves dE 10.49; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa-lotus**: `--status-blocked` moves dE 14.57; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa-lotus**: `--status-done` moves dE 18.90; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa-lotus**: `--status-working-tint` moves dE 10.49; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa-lotus**: `--status-blocked-tint` moves dE 14.57; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa-lotus**: `--status-done-tint` moves dE 18.90; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa-lotus**: `--danger-tint` moves dE 14.57; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa-lotus**: `--danger-text` moves dE 14.57; it follows the repaired foreground so its derived color stays consistent.
- **kanagawa-lotus**: `--syntax-function` moves dE 5.18; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa-lotus**: `--syntax-string` moves dE 13.23; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa-lotus**: `--syntax-number` moves dE 15.26; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa-lotus**: `--syntax-type` moves dE 7.57; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa-lotus**: `--syntax-meta` moves dE 14.27; its lightness changes to keep serialized text readable at the 4.6 target.
- **kanagawa-lotus**: `--border` moves dE 6.84; herdr surface1 replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible.
- **kanagawa-lotus**: `--border-strong` moves dE 14.20; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.

- **rose-pine**: `--status-working` moves dE 17.40; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine**: `--status-done` moves dE 17.40; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine**: `--status-working-tint` moves dE 17.40; it follows the repaired foreground so its derived color stays consistent.
- **rose-pine**: `--status-done-tint` moves dE 17.40; it follows the repaired foreground so its derived color stays consistent.
- **rose-pine**: `--syntax-function` moves dE 9.27; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine**: `--syntax-string` moves dE 9.27; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine**: `--border` moves dE 10.15; herdr selection_bg replaces surface0, which equals `--bg-elevated` and `--bg-input`, so control edges stay visible; surface1 would be 1.09:1 against the elevated card.
- **rose-pine**: `--border-strong` moves dE 26.75; herdr overlay0 replaces surface1, so it stays one step above the moved `--border`.
- **rose-pine-dawn**: `--text-dim` moves dE 8.98; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine-dawn**: `--status-working` moves dE 5.18; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine-dawn**: `--status-blocked` moves dE 14.03; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine-dawn**: `--status-done` moves dE 5.18; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine-dawn**: `--status-working-tint` moves dE 5.18; it follows the repaired foreground so its derived color stays consistent.
- **rose-pine-dawn**: `--status-blocked-tint` moves dE 14.03; it follows the repaired foreground so its derived color stays consistent.
- **rose-pine-dawn**: `--status-done-tint` moves dE 5.18; it follows the repaired foreground so its derived color stays consistent.
- **rose-pine-dawn**: `--danger-tint` moves dE 14.03; it follows the repaired foreground so its derived color stays consistent.
- **rose-pine-dawn**: `--danger-text` moves dE 14.03; it follows the repaired foreground so its derived color stays consistent.
- **rose-pine-dawn**: `--line-number` moves dE 8.98; it follows the repaired foreground so its derived color stays consistent.
- **rose-pine-dawn**: `--syntax-keyword` moves dE 9.20; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine-dawn**: `--syntax-number` moves dE 16.36; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine-dawn**: `--syntax-type` moves dE 23.03; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine-dawn**: `--syntax-meta` moves dE 11.64; its lightness changes to keep serialized text readable at the 4.6 target.
- **rose-pine-dawn**: `--border-strong` moves dE 31.57; herdr overlay0 replaces surface1, which is lighter than the panel, so it stays one step above the moved `--border`.

### Herdr dark-only theme notes

Dracula, Nord and Vesper keep their single dark row on either settings side, with no sibling
pre-fill. The CSS blocks remain the color source; explicit repairs are recorded in the override list.

- **dracula**: `--border` moves dE 16.44; reviewed herdr overlay/surface border keeps outlines distinct from elevated and input surfaces.
- **dracula**: `--border-strong` moves dE 8.91; herdr overlay1 keeps it one step above `--border`, since surface1 and overlay0 are the same color as `--border`.
- **dracula**: `--status-blocked` moves dE 24.57; reviewed explicit lightening and chroma relaxation beyond the proposal bound; serialized foreground reaches 4.6 and dependent defaults follow.
- **dracula**: `--syntax-keyword` moves dE 6.69; reviewed explicit lightening and chroma relaxation beyond the proposal bound; serialized foreground reaches 4.6 and dependent defaults follow.
- **dracula**: `--danger-text` moves dE 24.57; reviewed explicit lightening and chroma relaxation beyond the proposal bound; serialized foreground reaches 4.6 and dependent defaults follow.
- **dracula**: `--status-blocked-tint` moves dE 24.57; reviewed explicit lightening and chroma relaxation beyond the proposal bound; serialized foreground reaches 4.6 and dependent defaults follow.
- **dracula**: `--danger-tint` moves dE 24.57; reviewed explicit lightening and chroma relaxation beyond the proposal bound; serialized foreground reaches 4.6 and dependent defaults follow.
- **nord**: `--border` moves dE 7.34; reviewed herdr overlay/surface border keeps outlines distinct from elevated and input surfaces.
- **nord**: `--border-strong` moves dE 12.14; herdr overlay1 keeps it one step above `--border`, since overlay0 is already `--border`.
- **nord**: `--status-working` moves dE 19.85; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--status-blocked` moves dE 30.16; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--status-done` moves dE 11.92; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--syntax-keyword` moves dE 7.04; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--syntax-number` moves dE 7.32; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--syntax-function` moves dE 5.70; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--danger-text` moves dE 30.16; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--status-working-tint` moves dE 19.85; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--status-blocked-tint` moves dE 30.16; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--status-done-tint` moves dE 11.92; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **nord**: `--danger-tint` moves dE 30.16; AA lightness repair on serialized hex (target 4.6); dependent defaults follow repaired foreground.
- **vesper**: `--border` moves dE 21.86; reviewed herdr overlay/surface border keeps outlines distinct from elevated and input surfaces.
- **vesper**: `--border-strong` moves dE 31.63; herdr overlay1 keeps it one step above `--border`, since overlay0 is already `--border`.

### Terminal theme

xterm.js reads a JavaScript theme, not CSS, so `bun run generate:themes` copies these four tokens
of every supported entry into `src/lib/themes.generated.ts`, and `terminalTheme()` hands them to
xterm (`settings.test.ts` checks the match).

The amber dark and light values are generated in the Terminal rows of the table above.

The xterm keys are `background` for `--term-bg`, `foreground` for `--term-fg`, `cursor` for
`--term-cursor` and `selectionBackground` for `--term-selection`.

Programs pick their own colors for one background, so xterm keeps a cell's text at 4.5:1 or more
against the cell's background (`minimumContrastRatio`, WCAG AA): a foreground below it moves toward
black or white. Dim text needs half that ratio, and box-drawing, block and powerline glyphs keep the
program's color so borders and bars still meet the background. Claude Code's default dark theme draws its question titles in `#ffffff`,
which a light palette's terminal shows at 1.04 to 1.13:1.

### Syntax highlighting

Code in the chat and in the file viewer is colored by `--syntax-*` tokens. Four follow the
palette: `--syntax-comment` is `--text-dim`, `--syntax-function` is `--accent`,
`--syntax-inserted` is `--status-done` and `--syntax-deleted` is `--status-blocked`. The other six are literals per block
(each at least 4.5:1 on `--bg-panel` and `--bg-elevated`). Catppuccin follows Catppuccin's own mapping: keywords are mauve, so `--syntax-function` is
blue there instead of `--accent`, and Latte's colors are darkened to stay readable.

The amber values of `--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-type`,
`--syntax-variable` and `--syntax-meta` are generated in the Syntax rows of the table above.

Charcoal and Catppuccin set their own six (and Catppuccin its `--syntax-function`) in their
blocks of `src/styles.css`.

### File viewer

- `--notice` colors a note that the view is partial (a file cut short, code too long to color): the
  size in the header's meta line becomes `256 KB of 1.3 MB`, always beside a warning icon so the
  color is not the only sign. It is a warning yellow, at least 4.5:1 on
  `--bg`, `--bg-panel` and `--bg-elevated` (see `--notice` in the generated table). Charcoal and Catppuccin
  (its yellow) set theirs in their blocks of `src/styles.css`.
- The header's meta line (size, folder) is `--fs-xs`. A file that cannot be previewed says so in
  one sentence ("This file can't be previewed here. Download it to open it.") over its type and
  size as a dim mono `--fs-xs` line; "Opening…" is a `role="status"` note that is in the document from
  the viewer's first render, clipped and empty (`.visually-hidden`, never `display: none`), and gets its
  words a frame later: a live region that appears together with its content is not announced.
- A rendered page (Page) looks as before; what changed is where its files come from. The pictures,
  scripts and stylesheets it takes from its folder, and the videos it plays from this server, are
  read only from a descriptor whose opened file was shown to lie in the page's folder (or a folder
  in `OVIS_MEDIA_ROOTS`) with no hidden name on the way (`openAuthorized` in
  `server/file-view.ts`). The page's path is resolved once, before the page is opened (a page that
  is itself a link, to the file it leads to), and that file is opened and proven from its descriptor,
  never by a second lookup of a path: on Linux the kernel's path of the descriptor must be that path;
  elsewhere that path must be a file with the descriptor's device and inode that still resolves to
  itself (a sample). After the open the asked path must still resolve to that file, so a folder that
  was a link only while the path was looked up is refused too. The page's files come from that file's
  folder, so a linked page takes them from
  the folder it leads to. A folder swapped for a link at any point serves no other folder's page or
  files, but someone allowed to
  rename folders in its parent could move another real folder into its place while the page's
  files are looked up. Each file's path is resolved and checked again after the open and must still
  name the opened file, but a sample of a path is not a proof, so each platform adds its own:
  Linux checks the kernel's path of the opened file (`/proc/self/fd`), and refuses one it cannot
  read or that was deleted; macOS requires every folder from that root down to the file's own to
  be a real folder owned by this server's user with no group or world write bit (`mode & 0o022`
  is 0), which leaves a race only to this user's own processes, already able to read anything a
  swap could expose (it is not protection against the same user); Windows keeps the second
  resolution and the device and inode check only, and does not read access lists, so someone
  allowed to write a folder on the way could still race it, outside the one-user model this
  server serves. Other platforms authorize nothing. A video's address replays these checks on
  every request and plays only while the file has the identity, size and modification time its
  render saw; it is sent from its descriptor a chunk at a time, Range included, and a size or time
  change ends it. A write in place that keeps both, and bytes already sent, are not caught. No
  new UI follows from this, so it names no app precedent.
- `--line-number` colors the line numbers beside code: tertiary text, quieter than the code. It is
  `--text-dim`, except in Catppuccin, whose `--text-dim` (subtext1) is nearly `--text`: Mocha uses
  overlay2 and Latte subtext0 darkened to stay AA on `--bg`, as set in its blocks of
  `src/styles.css`.

### Rules
- Amber is the one chrome color. Accent (selected, focused, informational) and primary (the user's
  action: Send, primary buttons) are both amber; in light, accent is the darker text-safe ochre and
  primary the brighter fill carrying ink text. Agent states never use amber.
- Agent state has a written label as well as color. The sidebar's compact glyphs keep their labels
  in tooltips and screen-reader text; other surfaces draw the words. In the sidebar ready and
  unknown draw no glyph and keep their label for assistive tech; elsewhere unknown uses dim text
  and a dashed badge edge.
- Tints are named tokens; components do not introduce ad hoc translucent state colors.
- `theme: "system"` follows `prefers-color-scheme`; `src/lib/settings.ts` writes the resolved
  `data-theme`, `color-scheme`, and matching PWA `<meta name="theme-color">`.
- The saved theme is drawn from the page's first frame. `src/theme-bootstrap.ts`, a same-origin
  classic script in `<head>` ahead of the stylesheet and the app (`assets/theme-bootstrap-<hash>.js`,
  placed by `scripts/theme-bootstrap-build.ts`; never inline, the policy is `script-src 'self'`),
  reads both stored records through `src/lib/themeBoot.ts`, the reading `loadSettings` uses, and
  writes the row's `data-theme`, `data-palette`, `color-scheme`, `theme-color` and its `--bg` as the
  root background, which covers a frame painted before the stylesheet. `applyToDocument` removes that
  background, so the theme blocks own it from then on. This is a boot-correctness fix and follows no
  other app's behavior: the appearance is the one documented above (Codex by default), now shown from
  the first frame instead of after amber until the app starts.

## 3. Typography

### Scale

The values are the ones in `src/styles.css`. Every token but `--fs-input` is `calc(<size> * var(--ui-scale))`:
`--ui-scale` is the interface size factor, which Settings → Appearance → Interface font size writes on
`<html>` (the chosen body size over the density's, `1` until chosen), so the whole scale follows it, while
`--fs-input` stays the floor under which iOS Safari zooms a focused field.

| Level | Token | Comfortable | Compact | Typical use |
|-------|-------|-------------|---------|-------------|
| Micro | `--fs-2xs` | `calc(11px * var(--ui-scale))` | `calc(10px * var(--ui-scale))` | Badges, hints, kbd |
| Meta | `--fs-xs` | `calc(12px * var(--ui-scale))` | `calc(11px * var(--ui-scale))` | Subtitles, field labels |
| Small | `--fs-sm` | `calc(13px * var(--ui-scale))` | `calc(12px * var(--ui-scale))` | Controls, row titles |
| Body | `--fs-md` | `calc(14px * var(--ui-scale))` | `calc(13px * var(--ui-scale))` | Body and dialog copy |
| Reading | `--fs-chat` | `calc(15px * var(--ui-scale))` | `calc(14px * var(--ui-scale))` | Chat prose, the user's bubble, live narration; the message box with a mouse |
| Large | `--fs-lg` | `calc(16px * var(--ui-scale))` | `calc(15px * var(--ui-scale))` | Header title, modal title |
| Title | `--fs-xl` | `calc(18px * var(--ui-scale))` | `calc(17px * var(--ui-scale))` | Markdown h1 |
| Display | `--fs-display` | `calc(22px * var(--ui-scale))` | `calc(21px * var(--ui-scale))` | The empty chat's greeting |
| Input | `--fs-input` | `16px` | `16px` | Mobile-safe text input |
| Pairing | `--fs-pairing` | `calc(32px * var(--ui-scale))` | `calc(26px * var(--ui-scale))` | The pairing code in Settings → Devices |

| Token | Value | Usage |
|-------|-------|-------|
| `--ui-scale` | `1`; Settings → Appearance → Interface font size over the density's body size, written on `<html>` | Multiplies every `--fs-*` token but `--fs-input` |
| `--font-ui` | `"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans KR", "Malgun Gothic", sans-serif`; Settings → Appearance → Interface font writes the token on `<html>`: a typed list in front of this stack, a preset as a whole stack (`src/lib/typography.ts` keeps this one verbatim) | Chrome and chat prose |
| `--font-mono` | `"Symbols Nerd Font Mono", "JetBrains Mono Web", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, "D2Coding", monospace` | Code, paths, keys, terminal-adjacent metadata |
| `--lh-tight` | `1.2` | Titles |
| `--lh-base` | `1.5` comfortable / `1.45` compact | Body copy |
| `--lh-code` | `1.6` | Code blocks; the message box with a mouse |
| `--lh-prose` | `1.65` | Chat prose and the user's bubble |
| `--fw-regular` | `400` | Body |
| `--fw-medium` | `500` | Controls |
| `--fw-semibold` | `600` | Labels and titles |
| `--fw-bold` | `700` | Brand |
| `--tracking-tight` | `-0.01em` | Brand and primary titles |
| `--tracking-display` | `-0.02em` | The display line |
| `--tracking-caps` | `0.06em` | Uppercase operational labels |

### Faces
- The app ships its typefaces (`src/fonts/`, licenses in `THIRD_PARTY_NOTICES.md`) and loads
  nothing from another host: it is served from the user's PC, often with no internet route.
  Both are `font-display: swap`.
- Pretendard Variable, the first name in `--font-ui`, is upstream's dynamic subset: 92 chunks
  split by `unicode-range`, so the browser fetches only those whose characters a page draws
  (measured on the demo's chat: three chunks, 90 KB, in English; eight more, 200 KB, with the
  interface and an answer in Korean). The service worker precaches none and keeps each one once
  fetched.
- What the chunks cover (their `unicode-range`s): Latin, all 11,172 Hangul syllables, hiragana
  and katakana, and 435 CJK ideographs. The type is therefore the same on every device for
  Latin and Korean only. Kanji and Chinese text fall through `--font-ui` to the device's sans-serif,
  so a Japanese line is kana in Pretendard beside kanji in the device's face, and Chinese is
  the device's face almost throughout. The app ships no Japanese or Chinese face.
- JetBrains Mono (regular and bold) is the code face of the terminal, the chat and the chrome,
  loaded under the family name `"JetBrains Mono Web"` from the bundled files only. It is the
  terminal's first text font on every device (`src/lib/fontFamily.ts`). Measured at 13px, Chrome,
  Safari and Ovis for Mac on a Mac and Chrome on Linux draw the same 7.8px cell and 17px row:
  before, each device's own font sized it (Menlo, Noto Sans Mono CJK KR), and an installed
  JetBrains Mono drew in Chrome while Safari and Ovis for Mac's canvas could not see it, so the
  same Mac showed 17px rows in Chrome and 16.5px in the app. It is never a `local()` copy,
  which the app's canvas cannot measure either. A font typed in Settings still goes ahead of it. The
  terminal opens without it until it has loaded and the font effect then sets it, as for a typed
  font: xterm measures a cell once, when the family is set. A new terminal's pane is attached only
  once that first font is set (within the font effect's 3 s wait), so its pty is sized for the
  face's grid, not for a fallback's and then again. Zed likewise draws its terminal in a
  face it ships (`.ZedMono`) rather than the system's.
- Ovis Hangul Mono is the terminal's Hangul: the syllables and compatibility jamo of D2Coding
  1.3.2, renamed because its license reserves the name, 265 KB regular and 277 KB bold, each
  fetched only once a pane prints Korean that reaches it (`unicode-range`, `PaneTerminal.css`): a
  Korean font installed ahead of it that draws the syllable leaves it unfetched, and a font typed in
  Settings is applied without waiting for it. It holds no Latin, so it never sizes a cell. In the terminal's stack it follows the Korean coding fonts a
  device may have (D2Coding, Noto Sans Mono CJK KR) and comes before the generic monospace: Hangul
  beside Menlo, Consolas or a phone's monospace is a coding face on every device, not the
  system's proportional Apple SD Gothic Neo or Malgun Gothic. When it arrives the terminal
  measures again and redraws every row (`lib/terminalGlyphs.ts`), as for the icon font, from
  each face's own load promise: WebKit fires no `loadingdone` for a face a stylesheet loads. Faces
  that arrive before the next frame (both weights from the cache, or an icon with Korean) are
  measured for once, and one face that fails holds back none of the others. It is
  `font-display: block`, since WebKit reports a swap face failed while it still loads.
- A wide glyph that fills less than 90% of its two cells (a 1em syllable beside Menlo's 0.6em
  cell) is widened to fill them, not enlarged (`glyphFit`, `lib/terminalGlyphs.ts`): a horizontal
  stretch of up to 1.1x, as Korean typesetting's horizontal scaling (jangpyeong) does, and a larger
  font size only past that. The row is as tall as the Latin font's line, and a syllable enlarged
  1.084x to fill two Menlo cells grew to 13.5px of a 15px row, so Korean lines nearly touched. Widened,
  it keeps the height D2Coding draws it at, the same gap between lines as a terminal set in D2Coding,
  with no row given up. Terminal.app and iTerm2 draw a fallback syllable at its own size and leave
  the gap beside it; this keeps its height and closes the gap.
- A row is as tall as Hangul's ink and a gap of 0.35em below it, and never shorter than the
  Latin font's line (xterm's `lineHeight`, from `terminalLineHeight` in
  `lib/terminalLineHeight.ts`, set again after every change of the font's family or size).
  Hangul fills the height of its line where Latin's lowercase does not, and even at D2Coding's own
  height Korean lines read crowded in Menlo's 15px row (2.5px between them at 13px). The row is
  computed rather than a fixed factor because Latin lines differ: Menlo and Consolas give 15px at
  13px and get 16.5px rows on a 2x screen (16px on 1x), about a tenth of the rows; Noto Sans Mono
  CJK KR's 19px line (Linux) and JetBrains Mono's 17px already leave Hangul 5-6px and keep every
  row, where a fixed 1.1 took a tenth of them for nothing. The row is counted in whole device pixels as xterm counts
  it. Zed's terminal also draws taller rows than its font's line ("comfortable", 1.618, by
  default), and Warp defaults to 1.2.
- Except in Ovis for Mac's window: WebKit there draws a font the user installed, but its canvas,
  which xterm and the glyph fit measure with, sees only the system's fonts. The terminal leaves
  such a font out of its stack (`measurableFontStack`) and draws what Safari draws, Menlo with
  Hangul in Ovis Hangul Mono, rather than a grid measured in one font and drawn in another. It follows
  Zed and Warp, whose terminals size a cell with the font that draws it. VS Code's xterm.js
  terminal, the nearest web one, never meets the case: in Electron the canvas and the page see
  the same installed fonts. A WKWebView's canvas cannot, so here the font is dropped rather than
  measured.
- Chat reading scale: prose, the user's bubble and live narration are `--fs-chat` on
  `--lh-prose`; `strong` is `--fw-semibold` in `--text-strong`; inline code and code file chips
  are `0.87em` of their line; a code block is `--fs-sm` on `--lh-code`; headings are h1 `--fs-xl`,
  h2 `--fs-lg`, h3 to h6 `--fs-chat`. Work heads, tool rows, settled narration, a compaction's summary and
  meta keep their sizes. The chat scales all of them by `--chat-scale` (`--chat-fs-body` is the scaled
  `--fs-chat`), so the Chat font size setting names the body size and the prose is one step above it.
  `--chat-scale` is the chat's size over the interface's: unchosen, the chat follows the interface size;
  chosen, it is drawn as itself whatever the interface size.

### Line breaking
- The UI language is `<html lang>` (`lib/settings.ts`), and `src/styles.css` keys the breaking
  on it, on `body` alone, so every text inherits it once and no descendant sets it again. Korean
  (`html:lang(ko)`) is `word-break: keep-all`: a word moves to the next line whole, at a space or
  punctuation, never as "시도하 / 세요.". Japanese and Chinese (`html:is(:lang(ja), :lang(zh))`)
  are `line-break: strict`: no line starts with closing punctuation or a small kana (。」ょ).
  English keeps the browser's defaults. Chat prose in another language follows the UI language.
- `pre`, `code`, `kbd`, `samp`, the terminal (`.xterm`) and the text boxes (`.composer-text`,
  `.composer-measure`, `.terminal-input-text`) reset to `word-break: normal; line-break: auto`, and
  their children inherit that: a path, a command or a terminal cell is not a word. `overflow-wrap`
  is no part of the rule; the chat's and the composer's own rules keep it. The file viewer's
  virtualized source rows live in `@pierre/diffs`' shadow root, which document CSS does not reach:
  they inherit `body`'s value.
  The hidden measuring copy (`.composer-measure`) also takes the live textarea's
  `::-webkit-scrollbar` rules, so both reserve the same scrollbar width. Design precedent: none in
  the UI; the hidden measuring copy now matches the live textarea, with no visible change.
- `text-wrap: balance` on `.modal-title`, `.composer-greeting-title` and a Settings group's
  caption (`.settings-section h3`): a title that wraps takes even lines, never a full line over a
  one-word stub.

### Settings
- `theme`: `dark`, `light`, or `system`; default `dark`.
- `palette`: the legacy mirror of the drawn side's theme for older app versions; default `codex`.
  A record with no palette (saved before palettes) or a removed one (`report`, `lilac`, `forest`)
  loads as `amber`.
- `density`: `comfortable` or `compact`; default `comfortable`.
- `sidebarRows`: `one` or `two`; default `one`.
- Terminal font size is independent: default `13px`, clamped to `10–22px`.
  During a two-finger pinch the font follows the fingers live and a badge above the grid shows the
  size in pixels; the grid refits locally and the shared pty resizes once when a finger lifts.
  Cancellation restores the starting size. The badge is hidden from assistive tech; a polite live
  region says "Terminal text size {px} px" once, when a pinch ends at a new size, and says nothing
  for a cancelled pinch.
- A split pane that would have fewer than 80 columns at that size draws in the largest smaller
  whole-pixel size that gives it 80, never below `10px`. A pane alone in its tab or zoomed, a pane that `10px` cannot bring
  to 80 columns, and a pane this browser only watches or mirrors keep the user's size. The saved
  size never changes for this; in such a pane a pinch still saves the size it shows, and the pane
  draws it once it has the room.
- Interface font size (`uiFontSize`): the body size (`--fs-md`) in px, `11–20px`, `null` follows the
  density (`14px` comfortable, `13px` compact); it reaches CSS as `--ui-scale` (above). The chat follows
  it until it has a size of its own; the terminal keeps its own size.
- Interface font (`uiFontFamily`, kept in its own `ovis:ui-font` key so an older tab's save of
  `ovis:settings` cannot erase it): Default (the built-in `--font-ui`), System, Noto Sans or Custom.
  It is written as `--font-ui` on `<html>`, so everything set in it follows, the chat's prose too
  until the chat has a font of its own. A preset is a whole stack with no Pretendard behind it, since
  a browser takes each character from the first family that has it and Pretendard has kana but few
  kanji: System is `system-ui, sans-serif`, so kana and kanji come from the device's own fonts;
  Noto Sans is followed by its CJK families, the UI language's first. A typed list goes in front of
  the built-in stack. As Zed's `ui_font_family`, it is apart from the code and terminal fonts, which
  keep `--font-mono` and the terminal's own stack.
- Terminal and chat font families are comma-separated lists, default empty. They go in front of the
  built-in fonts, never in place of them: the terminal's (after the bundled Symbols Nerd Font Mono,
  which only draws icons) and `--font-ui` in the chat's prose (as `--font-chat`). Code keeps
  `--font-mono`. A file
  viewer's Markdown preview takes the chat font size and family too.
  At most 200 characters, with `;`, `{`, `}`, `<`,
  `>`, `\` and control characters stripped and names with spaces quoted.
- Composer Enter behavior and folded thinking visibility are preferences, not typography tokens.
- File viewer: `wrapCode` (wrap long lines instead of scrolling sideways; default off),
  `markdownWidth`: `readable` (the chat lane, `--chat-w`, centered; default) or `full`, and
  `diffStyle`: `unified` (default) or `split` for a repository diff (a phone draws one column
  whatever it says, and the viewer says so).
  These layout choices stay on this device, like chat width.
- New agents (Settings → Integrations): `claudeLaunchMode` (`--permission-mode`: `acceptEdits`,
  `auto`, `plan`, `dontAsk`, `bypassPermissions`) and `codexLaunchMode` (`readOnly`, `auto`,
  `fullAccess`, each a `--sandbox` and `--ask-for-approval` pair) become the `agent.args` the new
  workspace, tab and worktree dialogs send (src/lib/agentLaunchMode.ts). `default` (the default)
  adds nothing, so the agent's own configuration decides. Both are shared across devices.
  The viewer loads a Markdown file's first 256 KB through one bounded streaming reader, with abort
  on close or navigation and a 5 s deadline; any other text that fits 256 KB reads whole under the
  same budget, and a larger one reads up to 8 MB and 200 000 lines with a 30 s deadline
  (`readBudget`, src/lib/sourcePreview.ts). Partial text ends at the last whole line when one
  exists; the response's Content-Range supplies the total, and an empty 416 opens empty. A cut is
  told in the header: by size (`8 MB of 9 MB`) when the bytes ended it, by lines when the cap did.
  A cut prefix is shown to its last complete line (the reader's line count): the row after its
  final newline is not drawn, and a reference to the line just past the cap is explained as unseen,
  never marked. A complete file keeps the empty row after its final newline, its last line.
  A Markdown file its Preview cannot be parsed for within 2 s, or whose Preview would draw over
  60 000 elements, opens as its source with a notice. A source of up to 2 000 lines is an element
  per line, colored on the page or in the app's worker (code a worker cannot highlight within 2 s
  stays plain with a notice). A longer source is a window of rows from `@pierre/diffs`
  (`VirtualSource`): the DOM holds a few hundred rows whatever the length, every row is numbered,
  and the rows take the viewer's tokens inside the package's shadow root (`--bg`, `--text`,
  `--line-number`, `--accent-tint` and `--accent` for the marked line, `--font-mono` at `--fs-xs` /
  `--lh-base`), never the package's own code background. Up to 256 KB and 5 000 lines it is
  colored in the package's worker by a CSS-variable theme mapped to the same `--syntax-*`
  tokens as small sources and chat; palette changes reach the tokens inside the shadow root.
  Past that the rows are plain with the
  "Too long to highlight" notice, since the whole-file highlight measured 55 s and 192 MB for
  8 MB of JavaScript. The wrap setting applies to the rows; a wrap toggle or a width change keeps
  the marked line in place when it is in view, else the top line.
  File links keep `:line[:column]` and `#Lline[-Lline]` references. A reference opens the source,
  marks and centers its first line with `--accent-tint` and an `--accent` gutter number; columns
  and range ends do not move the caret. A line past the loaded part or past the end gets an
  explicit header notice, never a misleading jump. Markdown reader tabs retain the requested line.
  Copy file copies the loaded text; when the clipboard is out of reach it selects the source
  `<pre>`, or shows a virtualized source as one readonly text box, selected.
- Mod+Shift+E focuses the selected pane's existing composer, terminal input line or xterm input,
  preferring a mounted secret-input field. The callback is synchronous with the hardware key
  event, scoped to the active, presented pane and its PC; a modal or observe mode blocks it.
  It sends no text or keys and never takes an attach. The binding follows the existing shortcut
  customization and Mod+Shift policy.
- Settings share one sanitized `localStorage["ovis:settings"]` record, except the interface font,
  which is kept in `localStorage["ovis:ui-font"]` so an older tab's whole-record save cannot erase it.

## 4. Spacing & Layout

### Base unit

All spacing derives from a 4px base.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | `4px` | Tight icon and control gaps |
| `--space-2` | `8px` | Row and menu gaps |
| `--space-3` | `12px` | Control padding |
| `--space-4` | `16px` | Section and modal padding |
| `--space-5` | `20px` | Wide modal padding |
| `--space-6` | `24px` | Card breathing room |
| `--space-8` | `32px` | Large separation |

### Radii

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `6px` | Chips and inner controls |
| `--radius-md` | `8px` | Buttons, inputs, selected rows |
| `--radius-lg` | `12px` | Menus and chat surfaces |
| `--radius-xl` | `16px` | Modals and bottom sheets |
| `--radius-2xl` | `24px` | The composer's input card |
| `--radius-pill` | `999px` | Pills and dots |

### Sizes

Comfortable values are `:root`; the final column is the complete compact override set.

| Token | Comfortable | Compact | Usage |
|-------|-------------|---------|-------|
| `--header-h` | `52px` | `46px` | App header below `769px` |
| `--header-h-wide` | `46px` | — | App header from `769px`, in either density (`--header-h` takes this value there) |
| `--sidebar-w` | `320px` | `300px` | Sidebar/drawer; the default while the user has not dragged the sidebar's edge |
| `--control-h` | `34px` | `32px` | Buttons and fields |
| `--segmented-inset` | `6px` | — | What the segmented track takes from `--control-h` above and below an option (its `2px` padding and the hairline, both sides): an option is `--control-h` less this, and its touch expander grows from that height to `--touch-target` |
| `--touch-target` | `44px` | — | Coarse-pointer minimum: every control a finger can reach is at least this in both dimensions |
| `--pointer-target` | `24px` | — | Fine-pointer minimum hit area: a glyph button under `--control-h` (the chat's copy and format buttons, an attachment tile's X) keeps its look and reaches it through an invisible `::before` expander |
| `--touch-target-header` | `44px` | — | The phone header's controls (`<=768px`) |
| `--keybar-h` | `48px` | — | Terminal key bar |
| `--row-h` | `56px` | `44px` | Palette, worktree, device and background-task list rows; chat and composer list height caps |
| `--chip-h` | `20px` | `18px` | Badge/pill height |
| `--icon-size` | `18px` | — | Standard icon |
| `--mark-size` | `22px` | — | Brand mark |
| `--avatar-size` | `32px` | `26px` | Command-palette mark box |
| `--dot-size` | `7px` | — | Connection dot |
| `--rail-w` | `3px` | — | Device and quoted-content rails |
| `--hairline` | `1px` | — | Borders |
| `--content-w` | `820px` | — | Settings and dialog content |
| `--pending-max-h` | `min(20dvh, 12rem)` | — | Pending-message stack ceiling |
| `--chat-w` | `--content-w`, then the pane's lane as one length | — | Chat lane: transcript, composer column, held list. Settings → Chat width: Narrow `--content-w`; Default follows the pane (min 820px, max `60rem` = 960px, 71% of the pane between; the px floor wins where 60rem is under it); Wide `72rem` (1152px); Full `100%` |
| `--chat-fold-lines` | `12` | — | Lines of prose a long user message shows before it folds behind Show full message (Chat turn); `lib/userMessageFold.ts` folds a message past the same count |
| `--palette-w` | `640px` | — | Command palette |
| `--palette-top` | `12vh` | — | Palette top offset |
| `--context-line` | `calc(var(--fs-lg) * var(--lh-base))` = `24px` | `21.75px`, through the scale | The selected pane's crumb row, min and max height. Scoped to `.context`, not `:root`, so it follows `--fs-lg`/`--lh-base` in either density |

### Focus and layers

| Token | Value | Usage |
|-------|-------|-------|
| `--ring` | `2px solid var(--accent)` | Global `:focus-visible` outline |
| `--ring-offset` | `2px` | Outline offset |
| `--z-header` | `4` | A phone's glass header, over the transcript that scrolls under it |
| `--z-banner` | `5` | Terminal banners |
| `--z-popover` | `10` | Composer completions |
| `--z-scrim` | `15` | Mobile drawer scrim |
| `--z-drawer` | `20` | Mobile drawer |
| `--z-modal` | `30` | Dialog scrims |
| `--z-palette` | `35` | Command palette scrim, over every scrim dialog (a `showModal()` dialog sits in the top layer above it) |
| `--z-droplet` | `40` | In-app alert, over dialogs |

### In-app alert

One set for both themes: the card is island black wherever it shows. Values are generated in the
Alert rows of the table above from the `--droplet-*` roles in `src/styles.css`.

| Token | Usage |
|-------|-------|
| `--droplet-bg` | Drop, anchor and card |
| `--droplet-text` | Pane name |
| `--droplet-text-dim` | Ended detail, blank mark |
| `--droplet-blocked` | Needs-input detail and dot |
| `--droplet-done` | Finished detail and dot |
| `--droplet-mark-bg` | Agent mark disc |
| `--droplet-ring` | Card hairline |
| `--droplet-shadow` | Drop shadow under the liquid |

### Shell
- `.app` is a full-viewport column: `.app-header` over `.app-body`; the body is sidebar plus
  `.terminal-host`. While a phone's soft keyboard is up (`data-keyboard`), `--app-height` follows
  `visualViewport` so the keyboard does not cover input; otherwise the shell is `100dvh`, because an
  iPhone home screen app reports a visual viewport shorter than the screen without a keyboard.
- The header is one line at every width. Anatomy, left to right: mobile drawer toggle / desktop
  sidebar toggle and the command palette (`.header-side`); the flexible context, agent mark and
  title then the PC › workspace › folder crumb; segmented Chat/Terminal switch; from `769px` a
  hairline and the Files button (`.header-files-button`); the connection
  chip while the bridge is not live (herdr version in its tooltip), the offline pill, sign out and
  the More menu (`⋯`). Theme lives in Settings and the palette; the herdr version is also read
  in Settings.
- From `769px` the header is two zones. Over the sidebar, `.header-side` is the sidebar's own top
  row (toggle at its start, palette at its end) on `--bg-panel`, as wide as `--sidebar-w`, and the
  sidebar's seam runs to the top of the window. Over the pane, the header takes the pane's
  surface: under the chat lens `--bg` with no bottom rule, the transcript scrolling under a
  `--space-5` fade from `--bg`; under the terminal lens, with no pane, or with a pane herdr could
  not restore, `--term-bg` and the rule. A tab strip takes the same surface as the header over
  it from `769px` (`--strip-bg`: `--bg` under the chat lens, `--term-bg` otherwise, `--bg-panel`
  below `769px`) and keeps its hairline, under the chat the one line over the transcript (no
  fade under it). The update notice, the alerts health notice, a PC's action banner and the pairing line (below) are drawn in
  the pane column, over the tab strip, never across the window: the sidebar and its top row stay
  one piece. A device pairing with this server while a window is open (`device-paired` on the
  machines event stream) is one `.update-notice.is-paired` line there: a `--accent` phone glyph
  (`--icon-size`), one sentence naming the device and the time with the warning in words ("If that
  was not you, revoke it."), a neutral **Phone & devices** button that opens Settings there and
  takes the line down, and an X (**Dismiss**). It has no tint of its own, since the usual case is
  the owner's own phone: the words carry the other case, so no colour has to. Up to three lines
  wait, the oldest giving way, until read; on a phone the two controls sit together on a row
  under the sentence. The device that paired never sees it, not even a browser that paired itself
  with its window already open, in any tab, nor is it pushed to that browser (its stream keys,
  shared/protocol.ts "Browser stream keys"); nor does anyone see a pairing whose write failed. The
  line follows this app's own update and LAN-exposure notice lines, which it sits beside, so a new
  device reads as one more thing to look at; the Codex and Claude apps have no verified device
  alert to follow. A layout
  call the palette made that a PC's bridge from before the route answered 404 to reads there too,
  for a moment, as a `.pane-notice` line of `--status-blocked` `--fs-xs` text under a hairline
  ("This PC's bridge does not offer this yet"); the tab's menu says the same at the strip's end. With the
  sidebar collapsed the toggle and the palette sit in the one bar. Below `769px` the header is the `--bg-panel` bar with
  its rule: the installed app's `theme-color` matches it. Over the chat, when the transcript is right
  under it (no tab strip or notice between), that bar is glass, as an iPhone's is: `--bar-bg` behind
  `--glass-blur` at `--z-header`, pulled over the pane by its own height (`--header-over`), so the
  transcript scrolls on under it while its first line, the banners and anything else at the pane's
  top start below it. The xterm mount is not fitted under the chat, so this resizes no pty.
- From `769px` the sidebar's right edge is a grip (`.sidebar-resizer`, `role="separator"`): drag
  it to resize the sidebar between `240px` and `520px`, never past half the window; the arrow
  keys move the focused edge `16px`, Home and End go to the limits, and a double-click returns to
  `--sidebar-w`. The seam shows `--border-strong` under a pointer and `--accent` while held or
  focused. The chosen width is kept per device (`ovis:sidebar-width`) and written as
  `--sidebar-user-w` on `.app`; the sidebar and its top row in the header both read
  `--sidebar-shown-w`. A phone's drawer keeps `--sidebar-w`.
- The sidebar keeps its width on desktop until its edge is dragged, and is a `<=768px` drawer. The desktop collapse removes its
  column; the drawer uses a scrim and keeps safe-area insets. On touch, a mostly horizontal swipe in
  from the left `24px` edge opens the drawer and a swipe to the left closes it. While the finger is
  down the drawer is under it and the scrim darkens with it; let go, it stays open when more than half
  shows or a flick (`0.35` px/ms, not after a `100ms` rest) went that way, and slides the rest from there.
- The terminal stack contains a positioned terminal surface, then composer or key bar. The xterm
  mount stays alive under the chat lens; changing views never creates a second connection.
- At `<=480px` the brand name, the offline pill and desktop-only control labels go, and the
  palette's button gives its room to the title (the More menu's first item and a hardware
  keyboard still open it).
  Icons and selected context remain.

## 5. Components

### Button (`.btn`, `.icon-button`)
- `.btn` is a medium text control. Variants: neutral, `.btn-primary`, `.btn-danger`, `.btn-ghost`.
  Primary uses `--primary`; danger uses danger tint plus blocked border; ghost removes fill/edge.
  A destructive action that asks twice (Settings → Phone & devices, Revoke) is a neutral
  `.icon-button` (the trash glyph, named "Revoke {name}") at rest and becomes `.btn-danger` with
  its "Revoke?" label only while it asks to confirm; the same element through both steps, so focus
  stays on it. A trust decision (the SSH host key) shows the fingerprint to compare
  (`.machine-fingerprint`: `--font-mono`, `--fs-md`, `--text-strong`, under a dim "Fingerprint of
  {host}" label) over one sentence, "Trust it only if it matches the fingerprint shown on the PC.";
  ssh's own words wait behind a Show SSH output fold, and no status box sits above the question.
- `.icon-button` is a square unlabeled visual control with mandatory `aria-label`; `.is-outlined`
  adds the border. Both families use `--control-h`, `--radius-md`, focus ring, hover and disabled.
- Coarse pointers grow controls to `--touch-target`.

### Segmented control (`.segmented`)
- One `aria-pressed="true"` option receives hover fill and strong text; the group itself is an
  elevated, bordered `--radius-md` track.
- Used for Chat/Terminal, theme and density. It is not a generic tab list.
- An option is `--control-h` less `--segmented-inset` tall, so the track is `--control-h`. On a coarse
  pointer the track keeps its height; each option is at least `--touch-target` wide, so neighbours
  never share a tap, and reaches `--touch-target` tall through an invisible `::before` expander sized
  from that same difference, as the palette's filter chips do.
- The header's Chat/Terminal switch from `769px` drops the track and the glyphs: two words, the
  chosen one on the hover fill. At `<=768px` it keeps the track; at `<=560px` it is glyphs only.
  On a phone (`<=768px`) its options draw at the density's option height (`--control-h` less
  `--segmented-inset`: `28px` in a `34px` track, `26px` in a `32px` track when compact), so the
  track stands at least `6px` clear of the bar above and below in either density (the compact bar
  is `46px`), and reach `--touch-target-header` through the same invisible `::before` expander; a
  glyph sits in the middle of its `--touch-target-header`-wide option. This follows iOS's segmented control in a navigation bar (UIKit draws it about `32pt`
  in a `44pt` bar and takes taps beyond its drawn edge); the Codex and Claude phone apps have no
  view switch in their bar to follow.

### Keyboard hint (`.kbd`)
- An inline mono keycap: `18px` high, strong bottom edge, `--radius-sm`, `--fs-2xs`.
- `Mod` resolves to `⌘` on Apple platforms and `Ctrl` elsewhere.

### Modal (`.modal*`)
- `.modal-scrim` centers an `aria-modal` dialog at `--z-modal`; `.modal` is a capped scrollable
  column with header, body and footer and `--shadow-pop`.
- At `<=640px`, it becomes a bottom sheet with top `--radius-xl` corners and safe-area padding.
  Every surface on a `.modal-scrim` (dialogs, the palette, the row sheet) rises from the bottom
  edge as an iPhone's sheet does (`--dur-sheet` on `--ease-spring`, the scrim darkening with it),
  follows a finger dragged down from its head or from a list at its top, and drops
  (`--dur-sheet-out`) however it closes. Let go past `30%` of its height, or flicked down, it
  closes through the same close as its scrim; short of that it springs back. A busy dialog
  (a deed pending) does not follow the finger. A stroke on a sheet or its scrim pans nothing
  behind it (`touch-action: none`); the sheet's own lists still scroll and keep their overscroll.
  A closed sheet's drop is drawn in a closed shadow root, so no query of the page sees it.
  lib/sheets.ts.
- While a phone's keyboard is up (`data-keyboard`), the scrim is `--app-height` tall instead of the
  whole screen, so a sheet and its text field sit above the keyboard, and the sheet drops its
  safe-area padding.
- Escape, explicit close and scrim click close dialogs; first meaningful control receives focus.
  Initial focus is placed in the opening commit, before paint, so a menu restoring the terminal
  cannot leave the first Escape or typed key going to the pane beneath the dialog. A terminal
  command's peek over the chat is no dialog: its Escape is the agent's, in the grid (see the
  composer's terminal commands).
- A confirm (`.confirm-dialog`, `alertdialog`, 420px) asks before something that cannot be undone:
  Cancel has the focus, Tab stays between the two buttons, the danger action sits at the right,
  and a failure shows inside it. A no gives the focus back to what opened it. A refusal the owner
  named (git refusing a dirty checkout) turns the action into its escalation (**Delete anyway**),
  with the refusal's words above it. Closing a repository workspace over open worktrees says so
  and closes the group, as herdr's `--group` does.
- Revoking every paired device (Settings → Phone & devices, **Revoke every device**) is one Settings
  row under the pairing controls, parted from them by a hairline: the label, one sentence that says
  the caller's own pairing goes too and what does not (the access token, this PC, its Tailscale
  login), and a neutral `.btn` **Revoke all** at the line's end. It opens the confirm above, whose
  body says the same in two sentences (each device needs a new code to get back in) and whose danger
  action is **Revoke all**; a refused write stays in it as a sentence that says nothing was revoked
  and to try again, naming the server's log reference (never a file name). A device that only
  watches reads a sentence that says who can do it, with no button (a disabled one would only be a
  fainter dead control); an empty list has no row. After a yes the
  list and the row are gone and one `role="status"` line says every device went and what still
  gets in. No keep-this-device choice: the one action the owner needs when a credential is lost
  is the one that ends them all. The design follows this app's own paired-device model (the
  single Revoke above, the Sign out row's confirm): the Codex and Claude apps have no verified
  device-management surface to follow.

### Field (`.field`, `.input`, `.select`)
- Stacked uppercase label, optional hint and `--bg-input` field. Desktop fields use `--fs-sm`;
  small-screen fields retain `--fs-input` to avoid focus zoom.
- Focus names the edge with accent; errors use blocked/danger tokens and `role="alert"`. A failure
  leads with a plain sentence (`lib/userError.ts`); what the PC or the browser said follows on a
  second line in the interface face, selectable, never in the mono stack (which has no Hangul and
  would set Korean with letter-wide spaces).
- Every placeholder is `--text-dim` at full opacity (at least 4.5:1 on every field of every
  palette), never the browser's own grey (3.8:1 on a dark field).

### Menu / popover (`.menu*`)
- Bordered `--radius-lg` surface with `--shadow-pop`; rows use `--control-h`, `--radius-md`, icon,
  ellipsized main label and optional hint.
- Hover or `aria-selected` uses `--bg-hover`. Headings are dim uppercase micro labels.
- The sidebar's row menu (`.row-menu`) is a `.menu` drawn through a portal at fixed coordinates,
  under its `⋯` with right edges aligned, above it when the screen ends first, and over the drawer.
  Both the button and right-click offer the same native workspace actions: Rename workspace,
  Close workspace/group, New/Open worktree for repository roots, Delete worktree checkout for
  linked worktrees, and Expand/Collapse for a group. Pane renaming stays in the pane menu. The
  danger item takes `--status-blocked`. The popover is as tall as its items, up to the room on
  its side of the button (it scrolls only on a screen too short for it). At `<=640px` it is a `.modal` bottom sheet (`.row-sheet`):
  a grip, the row's name and place, 48px rows and a Cancel button; Tab stays among them. The
  rows scroll between the head and Cancel (`.row-sheet-items`), which stay put, when the sheet's
  92% of the screen cannot hold them. Escape, a press outside and
  focus leaving it close it (on a desktop a scroll or a resize too), and focus returns to the
  `⋯`. Arrow keys move between items. A row that leaves the roster takes its open menu with it.
  A workspace right-click opens at the pointer and leaves pane selection and keyboard focus
  unchanged. It follows herdr's workspace scope: Rename, Close workspace/group, repository
  worktree actions, and Expand/Collapse for a group. Dismissal restores the prior focus. The
  explicit `⋯` uses those same actions at its button. An edited name keeps the browser's paste menu;
  touch long press still reorders. Agents and PC headers keep the browser's context menu.
  An agent row selects its pane. Its `⋯` (drawn as a workspace row's is) opens its menu with
  Pin agent or Unpin agent and Mute alerts or Unmute alerts; a right-click opens the same menu at
  the pointer and leaves the focus where it was.
  Mute alerts is one switch for every alert channel (web push, the in-app alert, the chime and
  the tab notification) and every browser and device of the server: the list of muted panes is
  shared with the pins (`muted_panes` in shared/preferences.ts), keyed by the PC and the pane as
  the alerts key them, so the same pane id on another PC is not muted with it. The item is a
  checkbox item (`role="menuitemcheckbox"`, the sheet's `aria-pressed`) that says the action,
  Mute alerts or Unmute alerts, with the check mark while muted; a muted row draws a crossed bell
  beside its state (`.agent-muted`, `--text-dim`, `--space-3`; `--text` in the half-faded row of a
  PC that is away, so it keeps 3:1 there), named Alerts muted for a screen reader and the tooltip, so the state is never told by colour alone. A pane's status is tracked
  while it is muted, and Unmute alerts tells only what changes after it. A watching device sees
  the state in the menu, in `--text-dim` and `aria-disabled` (`.is-disabled`, not faded, so it keeps AA contrast), and
  cannot change it; a server too old to keep the list offers no item. This follows Slack's and
  Discord's per-channel mute, a checkbox item in the row's own menu, not a per-channel switch
  (Codex's and Claude's apps have no mute of their own); agent-of-empires has a per-channel
  override, which the shared, PC-keyed list replaces.
  A desktop (`pointer: fine` wider than 768px, the tab strip's rule) draws no row `⋯`: a
  right-click or the context-menu key opens the menu, at the pointer or at the row, and dismissal
  returns the focus where it was.

- Close follows herdr's `ui.confirm_close`: a workspace close, or a pane close that takes its
  workspace with it, asks in a confirm first. A busy pane also asks before it stops. After a
  confirmed close, focus lands on the header's workspace-list toggle.
- Tab and pane menus follow herdr's target scopes. A tab's menu contains New tab with agent…, Rename
  tab and Close tab, plus Move tab left/right when a neighbouring position exists and no move is pending.
  A tab with one pane also offers Move to workspace…, when its PC has another workspace: the same
  menu then lists those workspaces by name, at the same place, as Chrome's Move tab to another
  window lists windows. herdr moves tabs only within a workspace, so the tab goes as its pane
  (`pane.move` into a new tab at the end of the chosen workspace), its name and process kept; a
  split tab is not offered it. The view follows the pane there, in whichever half of a split shows
  it, and this browser's unsent draft for it goes along (herdr gives the pane a new ID). The
  palette has the same move as one Move tab to {workspace} row per workspace, found by a query
  only, as Settings pages are. Rename tab is also a palette action and a rebindable shortcut with
  no default key, as herdr's own `rename_tab` binding: it opens the same name field on the selected
  pane's tab, and is not offered where the strip is left out (a lone tab on a cramped screen).
  The `⋯` beside the selected tab holds the same tab actions (the strip's `+` opens a shell tab, so
  New tab with agent… stays here) and also carries the open pane's actions, less Split and Zoom where a phone shows one pane at a time.
  Touch and narrow layouts keep that `⋯` in view; a desktop with a mouse (`hover: hover`,
  `pointer: fine`, wider than 768px) draws it on the selected tab only, in its place at rest but
  hidden (`opacity` 0, `visibility` hidden, so the strip never reflows), and fades it in
  (`--dur-fast`, none under reduced motion) while the strip is hovered, while the tab or the `⋯`
  itself has keyboard focus, or while its menu is open; it is named "Actions for {tab}" with
  `aria-haspopup="menu"`. Right-click and the context-menu key open the full tab menu as before.
  A lone pane beside such a `⋯` draws no second ellipsis (its actions are in the tab's menu), on a
  desktop as on touch. The pane's own context menu carries pane actions; it opens at the pointer
  without changing which pane is focused. The pane header's ellipsis opens the same menu on touch.
  A lone tab with no row (a phone's screen made short by its keyboard) keeps that ellipsis at the
  pane's top right, below a glass header and never under the header's own `⋯`, as an iPhone
  navigation bar (and the Claude iOS app) keeps one overflow button in the bar and the content's
  controls below it. Wherever that ellipsis shows to a finger, the pane's banners (View only and the
  rest) start below it, so none covers it.

### Badge (`.badge`)
- Agent states read **READY**, **RUN**, **INPUT**, **DONE**; unknown reads **—**. **BG** is a pane
  whose turn ended while work it started still runs in the background (`background_wait`): it
  stands in for DONE or READY until that work's turn ends.
- Idle is elevated/dim; working, blocked and done use their own tint and text. RUN carries a small
  breathing dot before the word; the word itself never fades. BG takes the working tint and text,
  holding still; a tab's dot for it is a working-coloured ring.
- The written label and unknown dashed edge keep color from being the only signal.
- The sidebar's compact variant weights each state by how much it asks of the user. Waiting for
  an answer is the one filled glyph, a filled message circle in `--status-blocked`; finished and
  not yet looked at is an 8px dot in `--status-done`, as an unread mark is; working is the same
  dot in `--status-working` that breathes (`--dur-breathe`); BG is an 8px ring in
  `--status-working` held still, since nothing about it moves until its work ends; ready and
  unknown draw nothing. A pane herdr could not restore
  draws a warning triangle in `--status-blocked`. The element, its label and its tooltip are there
  for every state, and each drawn state has its own glyph as well as its color. Background tasks
  are a quiet count beside it (`.background-count`), not a badge.
- Settings → Status indicators can trade that default (Classic) for herdr's TUI marks, as its
  `[ui] status_indicators` draws them, for every state in mono text. Dots: `●` for working,
  blocked and done, `○` for ready, `·` for unknown. Symbols: `◐` working, `×` blocked, `✓` done,
  `○` ready, `·` unknown. Their colors are herdr's default theme's, the `--indicator-*` tokens
  (Catppuccin Mocha, Latte in light): working yellow, blocked red, done teal, ready green, unknown
  grey. Working breathes as the dot does; BG, which herdr does not have, holds working's glyph still.
  A tab's mark follows the same choice, held still.

### Pill (`.pill`)
- Mono metadata at `--chip-h`. Offline is the one header pill that stays, and uses danger tokens. A deep link waiting for its PC's roster says **Opening link…** in the same `.header-note` pill (`role="status"`) until it lands or its failure note replaces it. That status stays in the document while there is no note, clipped and empty (`.visually-hidden`, never `display: none`, as `.conn-live`), and the words of a page that opens with a link land a frame after it: a live region that appears together with its content is not announced. The `.header-note` pill carries a sentence, so it is set in the interface face (`--font-ui`), not the mono one. A deep link that could not open what it named, and Copy link, say so in a plain `.header-note` pill for a moment (8 s, 1.6 s for Link copied). The note takes the flexible context's place and ellipsizes when narrow, keeping the lens and More controls in view.
- This PC's herdr status follows its health reads, and one failed read is no outage: it says **Status unknown** in a
  plain `.pill-stale` (the neutral pill, no danger tokens), its tooltip naming the last herdr that answered. A second
  failed read in a row says **herdr unavailable** in the offline pill's danger style; neither claims herdr stopped, since
  a failed read is not proof of that. An answer ends the failed reads before it; one that lands late keeps those after
  it. Another PC's **herdr offline** still comes from its bridge.
  What a PC's herdr can do (terminal attach, the mirror, a pane's default lens) is its last answer and never changes on a
  failed read, so a Windows PC keeps its chat lens. The pills follow the app's own connection chip and header pills
  rather than another app's policy; at `<=480px` both go with the other header pills.

### Sidebar roster row and footer
- No top bar. The sidebar opens with the plan panel (when Settings puts it there), the PC workspace groups and a separate **Agents** list spanning the connected PCs. A workspace starts from the `+` on its PC's header (the lone Host's **New workspace** row, below), or from the **New workspace**
  button in the dashed **No workspaces yet** box of an empty PC. **Add PC** lives in Settings →
  Remote PCs and in the command palette. Search, as in finding anything and acting on it (panes by
  status, path or folder, actions, plugins), lives in the command palette, as the Codex and Claude
  apps keep it; the roster has only the label filter below, which the maintainer approved in #1043
  and which differs from the palette-only design on purpose: it narrows the lists in place, by the
  words the rows show, and holds no state.
- **Filter workspaces and agents** (`.sidebar-filter`, MachineSidebar.tsx) is its word, **Filter**
  (`.sidebar-filter-label`, in `--text-dim` at the size of the field's text, in view whatever is typed), then one
  `.input` the height of a row (`--side-row`, so a finger's `--touch-target` on a phone) in the rows'
  gutter above the lists, its placeholder naming the scope (**Workspaces and agents**) and its
  suggestions the names the rows show (a `<datalist>`, rebuilt from the roster, nothing typed kept),
  with its clear (`.sidebar-filter-clear`, the same square, inside the field's trailing
  cell) only while there is text; the browser's own search cancel glyph is off, so there is one. The
  query lives in the component's state alone: never in storage, the address, a request or a frame,
  and it is empty again after a reload, an unmount, a clear, Escape in the field, or the phone's
  drawer closing. Escape in a field with words clears them and leaves the drawer open; the empty
  field's Escape is the drawer's. Nothing focuses the field by itself, and nothing typed elsewhere reaches it, so a
  terminal keeps every keystroke; the command palette's **Filter workspaces and agents** opens the drawer or the
  sidebar and focuses it. Settings → Appearance → **Sidebar filter** (on by default, this device's choice, kept in its own
  `ovis:sidebar-filter` key as the PC fold is) leaves the row out, so the lists start at the top, as the Codex and
  Claude apps keep search in the palette alone; that palette entry then draws the row, focused, for the filter's time.
  It stays while it holds words, and goes on its **Close filter** (its X while it is empty), Escape in it empty (that
  Escape goes no further), leaving the sidebar while it is empty: a press outside it, or the keyboard's focus going
  out from the field or any row (a press inside keeps it, also when the row it picks moves the focus to its pane, so
  the rows never move under the pointer), or the drawer closing. Going while it holds the focus, it gives the focus back to what had it when it
  came, else to the list's first row, never to the page, as `useFocusReturn` does for a closing dialog. Turning the
  setting off while the field holds words keeps it, as one the palette opened. The matcher is the command palette's fuzzy one
  (`matchesQuery`, lib/paletteSearch.ts), its membership alone, never its rank: rows keep herdr's
  order, their PC, their group, their card and their pins (lib/sidebarFilter.ts). It reads only what
  a row shows: the PC's name, a workspace's name and the branch under it, an agent row's title, its
  agent's kind and name and the tab name on its context line; never a working directory, a
  transcript, an environment, a token value or an id. A match keeps its worktrees and its agent
  rows; a match keeps its repository head and its PC; a PC without one is hidden, its roster still
  mounted (a folded PC's too, hidden, while the filter lasts), so the branches it reads stay findable;
  a PC whose roster has not come (connecting, unreachable) stays as context with its state words. The
  selected pane's agent row, its workspace, that one's head and its PC stay whatever the query,
  drawn as context (`.is-filter-context`: the words in `--text-dim`) and never counted; the selected
  row says **Selected** in a `.sidebar-filter-note` tag beside its name, so colour never carries it
  alone. A folded PC, worktree group or Agents list with a match or the selection in it (a
  matching parent's worktrees are matches) stands open for the filter's time; their carets fold and
  open what is drawn for that time only, and no fold is written. Reordering (drag, a finger's lift, Alt+↑/↓) waits until the filter is
  cleared, so herdr never learns an order with rows missing. When nothing matches, a `.tree-state`
  line at the top of the list says **No workspaces or agents match** and, on its own line, **Try
  other words, or clear the filter.** (`role="status"`, through `useAnnouncedText`), naming **the
  PCs that answered** while a PC's roster has not come, beside
  whatever the selection keeps. Adapted in idea from agent-of-empires'
  sidebar filter (THIRD_PARTY_NOTICES.md): a row survives when it, a header over it or a row under
  it matches; its substring matcher, facets and sunk/trash semantics are not taken over.
- Every row sits on one grid, built from existing tokens as `--side-*` aliases on `.sidebar-shell`:
  a `--control-h` leading cell, the title, and a `--control-h` trailing status cell, the same two
  columns as the header zone's buttons above the list. One-line rows and section heads are
  `--control-h` tall, two-line agent rows `--control-h` + `--space-3`; fills use `--radius-md`.
  Hover is `color-mix(in srgb, var(--bg-hover) 50%, var(--bg-panel))`, only where a pointer hovers;
  selection is `--bg-hover`; keyboard focus draws the ring inside the row and no fill. No rule
  separates sections: `--space-4` and a dim `--fs-sm` head do.
- The PC/workspace list and the lower Agents list scroll independently above the fixed footer.
  Agents takes the height of its rows, at most half the sidebar, docked above the footer; the
  workspace list has the rest. The Agents heading stays outside its scroll area and shows its
  count only while folded. A list that is cut fades out at its lower edge. An empty or folded
  Agents list gives its space back; PC and workspace folds do not hide agent rows. In the drawer
  (`max-width: 768px`) the list starts folded. Until the PCs are in and every connected PC's
  panes have come, an empty list says **Loading agents…**, never "No agents running".
- A PC's header is the head of its workspaces, and the caret beside its `+` is the one fold over
  them. The roster has no label or fold of its own.
- When the sidebar shows one PC and it is the Host (the only PC, or the others hidden on this device), its group
  has no header: there is no other PC to tell it from, and the workspaces start the list, as the Claude app lists its
  sessions with no heading for the computer they run on. Nothing the header held is lost. The state words, the notice
  and the error are lines of their own and stay; the group is never folded (a fold stored before is ignored, since no
  caret could open it); its `+` is a **New workspace** row (`.machine-new-row`) after the workspaces, on the rows'
  grid with the `+` in the folders' cell and its words in `--text-dim`, left out while a filter is on, while the PC is
  offline and while the empty box offers the same, and there while the PC's first roster loads; the group keeps the PC's name as its accessible name, and the
  filter neither searches nor suggests a name no row shows. The Claude and Codex apps put their New button at the top;
  here it closes the list, so the workspaces come first. A Host has no manage panel, and Add PC is in Settings and the
  palette. A lone PC that is not the Host keeps its header: its name says which PC this is, and its manage panel has
  no other place. No setting turns this off, since nothing is lost.
- **Settings → Remote PCs → Show in sidebar** hides a PC on this device (`lib/hiddenMachines.ts`,
  its own `ovis:hidden-pcs` key, like the fold): it leaves the PC groups, the Agents list and the
  command palette, stays connected, and a link or an alert to its pane still opens that pane. The
  list shows when there are two PCs or more, the Host first; the last PC shown cannot be hidden, and
  hiding the PC the selection is on moves it to the Host, else the first PC shown. Under the PCs a
  quiet `--fs-xs` `--text-dim` line says how many are hidden here and opens that group. The banner of
  a PC that needs setup or a bridge update still shows for a hidden PC: it asks for an action. herdr's
  TUI shows one session at a time and Orca hides other clients' workspaces; Ovis shows every PC of
  the roster, so the choice is per PC and per device, not a sidebar switch.
- A repository's parent row keeps `workspace.label`; its opened linked
  worktree rows show their actual checkout branches. Each row's compact status
  glyph rolls up all of the workspace's panes as herdr does (blocked, then done, then working,
  then ready); a folded worktree parent rolls up its whole group.
  Clicking its name opens the
  selected pane in that workspace, else the last viewed pane, else the pane herdr has focused,
  else its first pane. Tabs are selected from the tab strip; panes are selected on the canvas or from the command palette.
- A top-level workspace row starts with its project's icon in the grid's leading cell, under the
  PC's monitor, or a folder glyph when its folder keeps none; the row's mark and name follow it.
  For a repository workspace with linked worktree workspaces that cell is the group's fold, a
  button (`.workspace-toggle`) in `--text`: the folder (no icon) is open while the worktrees show
  and closed while they are folded, when a dim `+N` after the name counts the checkouts put away;
  a project icon stays until a pointer hovers the row or the button takes keyboard focus, when
  that same open or closed folder takes its place. Where nothing hovers (touch) the folder always
  shows. For any other workspace it is a dim glyph or the icon, and no control. Worktree rows have no folder: they sit one cell in, their marks under the parent's.
  Worktree folds are remembered at
  `ovis:worktree-group-collapsed:<machineId>:<repo_key>`; a folded group keeps the selected
  child visible, and status snapshots preserve a deliberate fold.
- Worktree branches come from the existing `GET /api/worktree/list`, matched by repository key,
  open workspace ID and normalized checkout path. A listing-confirmed detached checkout reads
  **Detached HEAD**; without matching branch metadata, the workspace name remains the fallback.
  A custom workspace name appears beside the branch in dim text; the default name made by
  replacing branch slashes with dashes is omitted. Full branch, workspace name and checkout
  path remain in the tooltip. Disk-only checkouts do not become sidebar rows.
- Create/open responses seed the branch immediately, open the parent group and reveal the
  selected row within the upper workspace scroll area, including on a phone. Inventory reads
  run once per repository with opened linked worktrees, through that PC's bound API. Structural
  checkout changes and returning to the visible page refresh them immediately; a serial 30 s
  backstop runs only while visible and online. Status changes and renames do not cause git
  inventory reads. Stale requests cannot overwrite a new branch or another PC's cache; a failed
  read retains earlier metadata only for the same workspace, repository and checkout path.
  This adds no status subscription or server contract.
- **Agents** is an independent pane list: agents from each PC's `snapshot.agents`
  join the matching pane in `snapshot.panes`; pane agent metadata supplies entries missing
  from that list, including a recognized OmO pane. Each row opens that agent's pane: the agent's
  bare brand mark, the pane's title, and one dim line naming the agent, then the PC (only when two
  or more are registered), the workspace and the tab (only when the workspace has two or more tabs
  or the tab was renamed, and never when it repeats the workspace). An agent with a live name
  leads that line with it in `--font-mono` and `--text` (`.agent-name`); the kind takes the label's
  place beside it, and the tooltip keeps the name. Its background-task count and
  compact status sit at the right. A pane that waits for an answer is not listed apart or moved
  up: its state shows on its workspace row and its agent row, and the alerts say the rest. Pane state is
  authoritative when the agent roster and pane status differ. The workspace and agent lists
  share the existing combined machine roster and its SSE updates; neither adds a status subscription.
  A disconnected PC's saved workspace and agent rows are dimmed, inert and draw no state until that PC reconnects.
- What herdr plugins report on a pane (its `tokens`, `herdr pane report-metadata --token`: the Quota
  plugin's usage left, a task's progress) is a line of its own under an agent row's place, on One
  line and Two lines alike, only where the pane has one (`.agent-tokens`: `--fs-xs` in
  `--text-dim`, tabular digits, the values joined by ` · ` and cut with an ellipsis). It follows
  herdr's own sidebar, the design's reference here: the row draws the `$name` tokens the user's
  `[ui.sidebar.agents]` `rows` (or that agent's `rows_by_agent`) name, in their order, and a rule
  with `hide = true` takes its token off; herdr's colors and weights are not drawn, the line keeps
  the app's dim. Where herdr's config names no rows, the row draws every token, by name. The rows
  are this server's herdr config, as herdr's sidebar is the client's, and apply to every PC's agents
  (server/herdr-sidebar.ts, told on the machine events). The server applies the hide rules: a value
  they hide wherever the rows name it is left out of every snapshot a browser gets (the PC roster,
  the session read, the `/ws` snapshot and a PC's relayed or proxied ones), and the rows' event
  carries no rule's operands. Another Ovis server reading this PC with its bridge token gets the
  snapshots whole and applies its own rows. The values are text, never markup; a blank
  or missing token draws nothing; the row's tooltip, and a phone's ⋯ sheet under its place
  (`.row-sheet-detail`, wrapped, scrolling past a third of the screen so the actions stay in
  reach, and following the row while open), say each whole. A PC that is away draws none, as it draws no
  state. A plugin's line for the agent (`display_agent`) leads the place, as before, where it says
  more than the mark and the title; it changes live like the tokens.
- The Agents list is flat and every row names its own place. Pinned agents (pinned from a row's
  menu) stand first, in the order they were pinned, in a card (a `--hairline` `--border` edge,
  `--radius-lg`, no fill, so hover and selection read inside it as elsewhere),
  with no mark of their own (the card says so); the rest follow `--space-2` below in the
  chosen order. The card's caption sits on its top edge, as a fieldset's legend does
  (`.sidebar-pinned-label`: a pin and **PINNED**, centered, `--fs-2xs` semibold caps in
  `--text-dim` on the `--bg-panel` it masks the edge with); it is hidden from screen readers,
  where the list itself is labelled **Pinned**. Without pins there is no card and no caption. Pins are shared with the other browsers of the server.
- Appearance's **Sidebar rows** is **One line** by default: a workspace row is its name, and an
  agent row is one line on a workspace row's height, its dim place after the title (the title keeps
  its width first, the place takes what is left with an ellipsis). Two lines draws the row as the
  roster did before it was one line, on an agent row's height and type: the title of the pane the
  row opens, and under it in `--text-dim` `--fs-xs` the place, "workspace · folder" with no name
  said twice (`taskRowLines`, lib/paneName.ts). A shell titled by its folder leads with the
  workspace instead; a linked worktree is placed by its branch, then its own workspace name. The
  folder, the mark, the status cell, the menu and the fold count stay where they are, and the menu
  and rename still act on the workspace. The choice is shared with the other browsers of the server
  and applies at once.
- Appearance's **Agents order** is **Workspaces** by default: the Agents list in herdr's
  workspace, tab and pane order. **Activity** pins a blocked agent on top and orders the rest by
  their most recent state change (herdr's `state_change_seq`, read from the snapshot's `agents`),
  within each PC, so the agent just worked in stays on top while it runs and after it finishes.
  It changes only the Agents list; herdr's order and the workspace rows stay as they are.
  A raw counter rollback clears synthetic recency even on older bridges without an epoch.
  This ordering correction never changes finish identities or read records.
- A DONE opened here draws as ready in the Agents list and its workspace roll-up, as herdr's
  own client does. This follows the Codex app's [unread completion dot](https://github.com/openai/codex/issues/50856).
  A finish read in one browser is read in every browser of the server (a phone and
  a desktop agree; herdr's own TUI keeps its own record, since herdr can mark a pane seen only by
  moving its focus). Only the
  selected pane actually rendered on a visible page counts. The drawer, Settings, New session,
  Files, a popup file/diff viewer, machine dialogs, descendant dialogs and menus (including
  composer slash/file suggestions and their failed-suggestions popup) all block it,
  on desktop too. Retained hidden/inert pane siblings and their invisible popups do not
  cover the shown pane. A docked file/web panel does not cover the pane. A zoom redirect never
  acknowledges the hidden target; neither does the inactive half of a browser split. A background
  wait still shows BG, and working or blocked never draws ready.
  The pane's content must also report readiness for its rendered lifetime. A terminal needs
  parsed output for its current pane/terminal and an active, unheld connection. An attachment
  loss (`input-ready: false`) revokes that proof even while the socket stays open, including
  queued parses. Recovery alone is insufficient: fresh output must parse after recovery.
  Attach preserves the input protocol: replay is sent first, and a positive readiness receipt
  is sent only once the attachment is ready. It does not send an early negative receipt that
  existing input clients could mistake for the attach-complete barrier. A client that joins an
  attachment whose stream ended after it was ready gets `output-recovering` before the retained
  replay instead: presentation only, so that replay (the screen from before) never acknowledges a
  finish, and like the members it needs fresh output after the next `input-ready`. A retained
  renderer starts a new output lifetime on resume, so a missed recovery cannot invalidate its
  quiet replay. This is independent of input permission.
  A native chat
  needs a successful fresh read for the displayed finish and a loaded timeline, not just cached
  turns or a loading/error placeholder. Any agent's DONE can precede its transcript flush.
  The newest real assistant turn must end in native `final_answer` evidence: Claude `end_turn`,
  Codex `final_answer`, Pi/OMP/OmO/GJC `stopReason: stop`, OpenCode `finish: stop`, or Grok
  `turn_completed`. Devin, Hermes and Agy adapters do not currently supply that proof, so their
  chats keep the dot; Terminal can acknowledge actual output. Only informational/local-command
  notices are skipped after an answer, not real user messages or runtime wakes.
  A completed answer is bound to a finish within its PC/pane/epoch. A later finish must have
  a different completed-answer identity with a later native completion timestamp, not just
  a fresh response containing the old answer. Missing or equal timestamps keep the dot.
  The first read of a new presentation key bypasses ETag revalidation; a 304 for a new key is
  never proof. The answer fingerprint is saved with seen records and retained across renderer
  lifetimes. A first independent completion establishes a baseline; missing older proof is
  handled conservatively. If intermediate finish IDs were missed, the first completion is
  only a baseline and a different answer must arrive before chat can acknowledge it.
  The reader must be at the end: a chat scrolled back to older
  turns, or showing New messages, keeps the dot until the end is in view. Requesting a jump
  is not arrival: the current content's endpoint and last rendered row must be measured in
  view, including after resize or restoration when no scroll event fires. A superseded jump
  does not acknowledge the answer. Every layout, mutation and resize measurement respects a
  pending older-position navigation, except content that fully fits. A zero-movement scroll
  notification cannot cancel that intent. The jump affordance and ordinary end detection use
  the same 1 px rounding allowance; a 2–48 px gap no longer hides the way back.
  Error boundaries remove readiness with the subtree;
  a failed message renderer also prevents acknowledgement. Agent scrollback fallbacks keep
  the dot until the terminal is opened rather than claim native conversation readiness.
- Each PC's bridge assigns `finish_id` after all status overrides, incrementing on each observed
  transition into DONE, not on herdr's `state_change_seq`. Snapshots and status events carry it.
  Authoritative recovery observations feed the same tracker before the ensuing async refresh;
  panes excluded as newer than the recovery read are left alone. Snapshot absence retires a
  finish only when the completion tracker also reconciled that absence; an older empty roster
  cannot retire a pane observed since its read began.
  A random `finish_epoch` changes when the web server starts or observes a replacement herdr
  socket (Windows: changed pid:start marker). A failed read or reconnect alone proves no restart.
  Events carry the epoch too: changing it invalidates other panes' cached finish IDs until their
  next snapshot. The browser never infers a finish epoch from counters. An older bridge missing either
  field always keeps the dot; transitions wholly missed by the server cannot be counted.
- Each `(PC, epoch, pane)` has its own `ovis:finish:` localStorage key, containing the
  greatest viewed finish ID, its write time and an optional completed-answer fingerprint. A
  delayed lower finish ID also stays read: counters only advance inside an epoch, while other
  epochs have separate keys. Tabs writing different panes cannot overwrite
  one another; storage events reconcile a same-pane race toward the maximum. A tab closed before
  reconciliation or storage eviction can bring back a read dot, never acknowledge a newer finish.
  Old `ovis:seen:<pc>` records are removed. Epochs this tab actually left are removed;
  unfamiliar epochs are ignored, not deleted using a possibly stale first roster. Storage is
  capped at 2,000 keys, oldest first, never pruned by a tab's pane or PC roster. A record this
  browser writes is also sent to its server (`POST /api/seen`, shared/seen.ts), which keeps the
  greatest finish per `(PC, epoch, pane)` in `seen.json` (500 records, oldest first out; a PC's
  records of a herdr run known to have ended are neither handed out nor taken, and the next write
  drops them: this server's own PC is only in the run its finish epoch names now, an earlier
  process's included; another PC's run ended once a read that started after every report this server
  held of it named another run. A snapshot restored from `machines.json` or a report that may be late
  proves no run ended; a late snapshot or status of a run its own server was read moving on from is
  neither kept nor told, as `server/finish-epoch-ledger.ts` says) and hands
  them to every browser as `seen` events on `/api/machines/events`: all of them when the stream
  opens, then each change. A received record is laid over this browser's own with the same
  max-finish rule, so it can mark a finish read, never bring a dot back. Each finish is sent once
  per page, again with its answer fingerprint once the chat has it, and again after a failure. A
  watching device's views stay its own (its POST is refused), and an older server without the
  route keeps every browser's record local. Saved read records survive reconnecting/offline rosters, which
  hide their status badges and cannot create new acknowledgements. Retention cleanup after a save runs only
  when storage was actually written, not on every repeated DONE frame. Raw statuses and herdr
  recency still determine Agents order.
- Each workspace row holds its folder (top-level rows), a leading glyph, the name (on two lines,
  the title over the place) and the compact state at the right. The leading glyph is the brand mark of the agent in the pane the row opens; a row that opens a
  shell shows the terminal glyph, and a linked worktree without an agent the branch glyph. The
  mark never stands for another pane's agent; the row's tooltip lists every agent in the
  workspace. A custom worktree workspace name follows the branch on the same line in dim text.
  On One line, as in herdr's own sidebar, a top-level git workspace (a repository, or a worktree
  whose repository is not open) says its branch under its name in `--text-dim` `--fs-xs`, on a
  two-line row's height (`--side-row-2`); an indented worktree, whose name already comes from its
  branch, a pinned workspace in its card (the branch stays in its tooltip and menu) and a folder
  outside git stay one line. The branch is read with the worktree inventory
  (`useWorktreeBranches`), a repository without worktrees and a git workspace herdr has not marked
  included. As herdr draws its tree, each indented worktree hangs from its repository's folder on
  a `--hairline` `--border-strong` branch in the indent: a tee for each but the last, an elbow for
  the last.
  Selection uses a neutral rounded fill; workspace rows have no amber rail or separate reorder
  gutter. Drag the row itself, or press `Alt+↑/↓` while its selector is focused, to reorder it.
  On a touch screen (`pointer: coarse`) the browser's drag is off: a long press (400ms, still
  within 8px) lifts the row (`.is-lifted`: `--bg-elevated` with `--shadow-card`), it follows
  the finger, the list scrolls near its edges, and a 2px `--accent` line (`data-drop`) shows
  where it lands. Alt+Up/Down moves the focused row one step at a time.
  Dragging is disabled while a name field is open. Each workspace's `⋯` opens its row menu
  (`.row-menu-toggle`: no width at rest; shown on hover, focus, selection and while its menu is
  open; always on touch; not drawn on a desktop, where a right-click opens the menu). Inline server failures
  stay beside their workspace. A repository's workspace moves past the
  next or previous group with its worktrees, and a worktree moves among its siblings only.
  A dropped order shows at once and stays until herdr is known to have it, drawn in the same rows
  and look (the Codex app's sidebar, as the rest of this list): nothing new is shown while it
  waits. Each move's answer names it in that PC's server's order (`order_epoch`, `moved_seq`), and
  each roster says how many moves its server had confirmed when the read began (`read_seq`). The
  drag's order gives way to the first full roster of the same server read after its last move,
  whatever order that roster shows (another browser's later move included), and a roster read
  before it never brings the old order back, while names, status and added or closed workspaces
  still update. A roster from another server lifetime changes the order only after that PC's
  server, asked after the move, proves it restarted. That question
  (`GET /api/machines?verify_source_boot`) costs a remote PC one health call, and its load is bounded
  by the manager alone: at most one call in flight per PC, started at least 1000 ms after the last,
  with every other asker joining it or refused with 503 and `Retry-After: 1`. The browser's
  coalescing and the 15-second deadline do not by themselves bound it, and this is no general HTTP
  or DoS protection. Agent of Empires keeps a dragged order for a
  fixed time; a time window ends before a slow move lands or holds a stale order after it, so here
  the operation's own evidence ends it and no clock is read. Only the newest drag of a PC rolls
  back or reports its own failure. A PC whose bridge predates this (until the next remote bundle
  release) gets the old behaviour back from the first roster loaded after its moves settle, so it
  can show an older cached order until the next full roster, event or poll. A drag whose moves were
  answered partly with and partly without these numbers waits for both: a roster of the same server
  at its last numbered move, loaded after the moves settle.
- A workspace is pinned from its row menu (**Pin workspace** / **Unpin workspace**, first in the
  menu), as Paseo pins a chat: pinned workspaces leave their place and stand first in their PC's
  list, in the order they were pinned, in the Agents list's card (`.sidebar-pinned`, under the same **Pinned** caption), with no mark
  of their own either. A pinned repository's workspace stands alone in the card; its unpinned
  worktrees stay as standalone rows at the group's position, in their order. They are not dragged
  or moved away from their repository; unpinning the head restores the group. A pinned worktree
  leaves its repository's group, which stays. Dragging, touch long-press and `Alt+↑/↓` reorder
  pinned rows inside their card by changing pin order, not herdr's workspace order or the position
  of their unpinned worktrees. Neither list accepts a drop from the other; the rest reorder
  through herdr among their movable rows. The pins are the Agents list's
  shared list (a workspace's key is `machine:workspace:id`), so other browsers of the server see them.
- A title that is a working directory written out (`/home/me/dev/api`, `~/dev/api`, `C:\work\api`)
  shows as its last folder, here, in the header, the palette and every alert; the full path stays
  in the row's tooltip. Parent workspace names stay fixed and linked checkouts are named by branch;
  agent rows show their pane's own title. Each row's
  place is available to screen readers, without repeating what its title already says. The
  palette, which has no header, names the workspace and folder once when they are the same.
- A PC group header is a monitor icon in the leading cell, the name in `--text-strong` semibold, “Host” for
  the local machine (also when it is the only PC: the name alone does not say which computer it
  is), and a state dot (done = connected, working pulse = connecting/reconnecting, blocked =
  error, idle = disconnected), then the fold's caret (`.machine-toggle`, always shown; the name
  itself is not a control) and a `+` in the status column that starts a workspace on that
  PC (disabled while it is offline). An SSH PC's manage button sits before the
  caret and shows on hover, focus, while its panel is open, while the PC is not connected, and always
  on touch. Connected is the dot alone; every other state is also written under the name, with the server's
  error clamped to two lines and complete in the tooltip.
- SSH PC management stays inline: its rename form and action buttons reflow within the sidebar
  instead of floating over it. Rename shares the name field's row where both fit and goes under
  the field in a narrow sidebar; the action buttons wrap into rows that share a height. A
  one-line button is `--control-h` tall, as the field beside it (`--touch-target` on a coarse
  pointer, where Rename keeps its own line under the field), and only a wrapped label grows its
  button. Wrapping labels keep controls contained at narrow widths, with touch-sized buttons
  on coarse pointers. This follows the
  width-constrained responsive sidebar in [T3 Code](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/ui/sidebar.tsx)
  but keeps herdr's existing inline panel instead of adopting its mobile sheet; no code is borrowed.
- A repository's worktree workspaces (`workspace.worktree.is_linked_worktree`)
  sit indented under the row of the workspace on its main checkout (`.worktree-children`), without
  a tree hairline; a worktree whose repository workspace is not open stays at the top level.
- Rows use only shared theme tokens in dark and light. Touch keeps row menus and folds visible,
  with `--touch-target` controls, and draws no hover fill; reduced motion removes row transitions
  and keeps the working dot's breath (opacity only).
- Footer holds the contextual **Install app** action and Settings, its gear alone (named
  **Settings** to screen readers and in its tooltip), with the plan meters filling the rest of its row,
  as rows on the same grid with no rule above.
  It carries no product name or version: the running versions are read in Settings.

### Plan meters (`.usage*`)
- Right of the Settings gear, one button holding as many chips as the row has room for (judged
  by the widest chip drawn, so the count settles), the rest folded into `+N`, one per account in
  the user's order: provider mark, mono `--fs-2xs` percent of the limit chosen in Settings, the
  plan's session by default or its week (what is left by default, or what is used), and a 2px bar on a `--border-strong` track
  filled to that percent. From 80% used the percent and bar take `--status-blocked`; amber stays
  chrome. A chip whose numbers are stale or missing dims. An account hidden in Settings is
  left out of the strip and the popover; with every account hidden, neither shows. The button's
  name and tooltip add, per account, another of its limits from 80% used that the chip does not
  show (`(Weekly 9% left)`); the chip itself does not mark it.
- The button opens a popover above the footer (`--shadow-pop`, `--radius-lg`), as wide as the
  footer and scrolling when it outgrows the sidebar: per account its mark, name and plan pill with
  the email or login right-aligned and ellipsized, then one row per limit (label, reset time, right-aligned percent) over a 4px bar. A problem
  note is dim, red for an expired sign-in or a failed request.

### New workspace dialog
- Agent select comes from `GET /api/agents`; shell-only is always available. The bridge offers the
  agents it types into the pane's shell itself (omo, gjc) exactly where it can start them: its own
  PATH first, then on Unix the PATH its user's login shell sets (`server/shell-agent.ts`
  ShellAgentLocator), and the start types the same absolute path the offer found. The login shell
  runs only on demand: when `/api/agents` or a shell-agent start asks for an agent its own PATH
  misses and the last answer is more than a minute old, never from a timer, and concurrent askers
  share one run. Each run is bounded (2 s, 64 KiB of output, a short wait after a kill or the
  shell's exit); a run that finds no PATH is a miss, and the server logs why once each time the
  reason changes. A server run as a service with a bare PATH therefore still offers an agent
  installed under `~/.local/bin` or a version manager. The agents herdr starts keep their own
  environment's answer. The picker itself is unchanged. Directory defaults to
  the selected pane cwd and name is an optional workspace label. **Browse** updates Directory as
  each folder opens (`onFolder`), so **Start** uses the path shown in the browser even when
  **Use this folder** was not pressed; Directory keeps the `~/…` form for a folder under home, as
  that button does, which also closes Browse. A folder-plus icon button at the end of Browse's bar
  (New workspace only, not Files) opens one name field under the bar: Enter makes the folder inside
  the one shown and opens it, so Directory follows; Escape or leaving it empty closes the field
  without closing the dialog, and a refusal (taken name, invalid name, no permission) shows as an
  inline alert under the field.
- Recent folders appear as neutral `.btn` chips with `--radius-pill` and `--space-2` gaps: the
  three most recent, on one row that never wraps. Each shows the folder basename with ellipsis
  and the full path in its tooltip and accessible name. Clicking puts the folder in Directory and
  starts nothing. History is per PC in this browser and retained after panes close. Only a
  successful workspace start puts its folder first; a folder merely seen in a connected PC's panes
  goes behind what is kept, since a pane's folder follows every `cd` of its shell. Pending and partial
  failures disable the chips. New tab keeps its workspace folder and shows no recent chips.
- Submit calls `POST /api/workspace/create`; the server performs `workspace.create` and, when an
  agent was chosen, `agent.start` in its root pane. Pending and partial agent-start failure are
  explicit before the created pane opens.
- As **New tab** (from a row's `⋯` menu, the tab menu's New tab with agent… or the palette),
  the same dialog is titled `New tab · <workspace>`, shows the workspace's folder as a fact in a
  dashed box (`.new-session-folder`: a worktree's checkout, else the folder of the pane in front)
  instead of asking for one, and its name is the tab's (optional; the placeholder is the number
  herdr gives it). Submit calls `POST /api/tab/create` with the same agent launch.
- Under Name, the launch's own choices, each only where the agent's CLI documents it
  (`lib/agentLaunchMode.ts` launchCapabilities; today Claude Code and Codex): **Model**, a `.input`
  whose empty value is the agent's own and whose datalist offers the aliases the agent documents
  (`sonnet`, `opus`, `haiku`), **Effort**, a `.select` of the agent's documented levels after
  **Agent default** (Claude Code's: low, medium, high, xhigh, max), and, for Claude Code alone,
  **Ultracode** on one line under Model and Effort (`.new-session-ultracode`): Settings' own
  `Toggle` (`role="switch"`, `.settings-toggle`), its track pulled to the fields' left edge, then a
  `<label>` tied to it and a dim note "Claude Code 2.1.284 or later" that ellipsizes first. The
  whole sentence, "Dynamic workflows at any effort level. Needs Claude Code 2.1.284 or later.", is
  the switch's description (`aria-describedby`, visually hidden) and the line's `title`, so the
  line stays as tall as the switch at every width; a field-sized column with a three-line hint
  took too much of the dialog (the owner's review of #2266; @fivetaku's #2282 suggested the
  compact line). The name sits beside the switch, as in a Settings row, rather than above it as a
  field label; it is Claude Code's own term and stays English in every language. Model and Effort
  sit side by side (`.new-session-launch`) at every width: a column is 9rem at least, or half the
  row on a phone narrower than two of those (320px). Ultracode is off at every opening, and off adds
  nothing to the launch, so Claude Code's own settings decide, as Agent default does; on adds
  `--settings '{"ultracode":true}'` after `--effort`, which keeps the level picked. A model that is
  not one word, or a model or effort the picked agent's launch does not take, disables Start and
  says so under its field in the blocked colour (`aria-invalid`, `role="alert"`); picking another
  agent drops the choices its launch does not take (Ultracode goes off for any agent but Claude
  Code). A switch left on where it is not shown, as when the agent list turns a remembered Claude
  Code into a shell without a pick, neither disables Start nor goes with the launch
  (`lib/newSession.ts` dialogLaunch). The agent picker's rows carry a `.menu-item-hint` (**model,
  effort**) beside the agents whose launch takes them.
- **First message** is a `.input` textarea (three rows, grown by hand) whose hint says where it goes.
  Codex takes it as its own positional argument behind `--` (`codex [OPTIONS] [PROMPT]`; clap matches
  a subcommand only before the separator, verified on codex 0.163.0: `codex -- logout` starts the TUI),
  so it starts with the agent. Claude Code's parser runs a subcommand named by the first operand even
  after `--` (`claude -- update` ran the updater on 2.1.304), so it and every other agent start bare
  and the text rides on the create request as `first_message`: the bridge queues it as its own pending
  message for the pane (`server/core/pending.ts` FIRST_MESSAGE_OWNER, one per pane), told to every
  connection that attaches the pane as a **Next turn** pending message with Discard and Send now, and
  typed once when the agent is first ready only through the page that sent the request
  (`first_message_connection`, its socket's id from the first snapshot) while it has the pane attached,
  with the queued path's own checks (a draft in Claude's box holds it with `input_draft`; another
  agent, or another process or session of the same kind than the one launched for it, holds it with
  `pending_target_changed`; the agent launched for it ending before it went holds it with
  `first_message_launch_ended`). When that page disconnects, reloads or leaves the pane first, it is held with a note and
  waits for someone's Send now or Discard, as any draft does after a disconnect. The page never types
  it itself. When the PC answers that it could not queue the message (`first_message.error`) or
  answers without `first_message` (a bridge before it), the text goes into the new tab's message box
  and the dialog stays open saying so, with **Open**. A Codex message with a tab or a line break is no
  one-line argument: it goes as `first_message` instead. The bridge checks the model, the effort and
  Codex's argument by the dialog's own rules (`shared/launch-rules.ts`); switching agents clears the model.
  It still takes Claude Code's `--effort ultracode` (xhigh with Ultracode on) from an older page or
  another client, and passes `--settings` on as the agent's own flag; on a Windows PC its inline
  JSON goes as the path of a file holding the same text (`server/claude-settings-file.ts`).
  Under the message, **Skills**: the agent's skills in the folder before any process exists
  (`GET /api/agent/commands?agent=&cwd=`, the pane commands route without a pane: the bridge's
  tables and a disk scan, no agent started; a device that may only watch is refused it as it is a
  directory listing and a file read), as mono `.btn` chips with `--radius-pill` that wrap to
  three rows and then scroll, each the token the agent types (`$review-pr` for Codex, `/review-pr`
  elsewhere, `@name` where that is the trigger) with the skill's description as its tooltip; a tap
  puts the token at the message's caret, spaced, and focuses the box. An empty list says **No skills
  for Codex in this folder.**; a folder not there yet, or a PC whose bridge is from before the
  route, is said in one hint line. Start sends exactly one create: a ref-held in-flight guard
  (`lib/sessionHistory.ts` inFlightGuard) refuses a second press before the disabled fields have
  rendered.
- In a mouse-driven window wider than 640px (the composer's own `(max-width: 640px), (pointer:
  coarse)` query) the chat's composer can show a **New tab with an agent…** icon button
  (lucide `MessageSquarePlus`, beside Attach) that opens this dialog as New tab on the pane's
  workspace, as the tab menu does. It is off until this device turns it on (Settings → Chat →
  Composer, **New tab button**, the device setting `composerNewTabButton`): the composer's row stays
  minimal, as the Codex and Claude apps keep theirs (attach and the mic; a new thread starts from the
  sidebar), and the tab menu opens the same dialog either way. A phone's card has no row to spare for
  it beside the mic and the tasks chip (the model label would lose its pill), so there the tab's own
  menu keeps **New tab with agent…**, and Settings does not offer the toggle on a touch screen or in
  a window 640px wide or narrower.
  The existing shortcuts are untouched.
- The design follows the Codex app's new thread screen (the model and reasoning-effort pickers
  under the prompt box, the prompt sent as the thread starts) and Claude Code's own session flags
  (`--model`, `--effort`, the positional prompt): here they are fields of the existing dialog, not a
  second launcher, because the dialog already owns the agent, the folder and the launch; the skills
  row is the composer's `/` and `$` menu brought forward to before the agent runs, as chips because
  a dialog has no caret to complete at until the message is typed. Ultracode follows Claude Code's
  own `/effort` slider, where since 2.1.284 it is a switch beside the levels rather than one of
  them.
- The browser demo answers `GET /api/agent/commands` with a few fictional skills per agent (`$` ones
  for Codex) and records nothing: a tab started from it is the demo's own new pane.

### Tab strip and pane canvas
- The tab strip is shown even for one pane, as herdr's TUI shows its single tab and `+`. The `+`
  is herdr's own new tab: it calls `POST /api/tab/create` with no agent at once, in the workspace's
  folder, and opens the new shell pane unless another pane was opened meanwhile; a refusal shows
  in the strip. An agent tab comes from the tab menu's New tab with agent…, which opens the dialog.
  Tabs retain their names, status dots, active underline, keyboard navigation, rename field and
  close confirmation. A right-click opens tab actions at the pointer, including Move tab left/right
  when a neighbouring position exists. Tabs have no close buttons or chevrons. Touch and narrow layouts show a `⋯` beside
  the selected tab for a trimmed menu, and there a tab is at least `--touch-target` tall and wide, so a one- or
  two-character name (탭 1) is still a finger's target with the `⋯` a target of its own beside it; a desktop with a mouse draws the same `⋯` on the selected tab, hidden in its place
  until the strip is hovered or the tab has keyboard focus (Menu / popover). Shift+F10 or the menu key opens the full tab menu from a focused tab.
  Pane actions are not tab actions. Up to 768px, where a split tab shows one pane at a time, the
  tab's menu lists the tab's panes first, the open one marked current, over a hairline.
  Only at these narrow widths does it omit Split and Zoom pane; Unzoom pane stays available whenever the tab is zoomed.
- A vertical mouse wheel over a strip whose tabs do not fit scrolls it sideways, as Zed's tab bar
  and VS Code's editor tabs do, by the wheel's own unit (pixels, lines or pages). Touch, a trackpad's sideways
  swipe, a pinch and a strip whose tabs fit are left to the browser.
- Mouse dragging previews an accent insertion line, with edge scrolling for an overflowing strip.
  The snapshot's tab order is authoritative: a tab's stable `number` is not its place. A drop calls
  `tab.move` with an insertion boundary before removal, within that workspace and PC. The visible
  order changes with herdr's snapshot, keeping selection and keyboard focus; a refusal shows an
  inline error. One request waits for acknowledgement before another move is accepted. Escape,
  a tab-list change or leaving the workspace cancels an unsent drag. Touch keeps native sideways
  scrolling and uses Move tab left/right in the selected tab's menu; Alt+Shift+Left/Right provides
  the same adjacent moves only while a tab has keyboard focus.
- `PaneCanvas` draws every pane in the active tab at `layouts[].panes[].rect`, normalized to
  the layout's own area. Panes share thin, square boundaries: `--border-strong` when inactive,
  `--accent` around the selected pane. The compact header names its pane and, on a screen that takes touch
  (`any-pointer: coarse`), the ellipsis; a mouse opens the same menu by right-click. Keyboard users
  tab to the pane's ellipsis, which becomes visible on keyboard focus, and press Enter.
  Shift+F10 in the terminal goes to the terminal program, not the app menu. A lone or zoomed
  pane is borderless; its actions live in the tab's `⋯` menu rather than a second ellipsis, on a desktop as on touch.
- A left click or keyboard focus selects the actual pane. Right-click opens the clicked pane's
  menu without changing the selected pane: Rename pane, Clear pane name when named, Swap with
  focused pane when another is selected, Split right, Split down, Zoom/Unzoom pane, Recover
  unsent text while there is some (Unsent text, below), Close pane. It appears at the pointer, clamped to the window. Up/Down
  stop at the ends, hover selects, Enter acts, Escape and an outside click dismiss.
- Split selects the new pane (`focus:true`), like the TUI. Swap exchanges the right-clicked
  pane with the previously selected pane and retains the browser's selection. On a desktop,
  dragging a pane's title onto another pane's title in the same tab on the same PC exchanges
  their positions too. The eligible title is highlighted instead of offering a split-view
  half. Sidebar drags, drops outside an eligible title, and drops across tabs or PCs keep
  their existing docking behavior. This follows tmux's explicit `swap-pane` operation,
  exposed through a title drop like VS Code's editor-group drag targets rather than a new
  layout setting. Explicit swaps leave herdr's focused pane, tab and workspace where they
  were: the bridge serializes Ovis focus-changing calls (focus, swaps, split, zoom and close)
  per herdr socket, reads its focused pane before
  the native swap, and restores it only after a changed swap if focus still belongs to the
  swapped source. A later Ovis focus choice runs after the restore and takes precedence.
  A focus change in herdr's own TUI between the check and restore cannot be serialized by
  Ovis; eliminating that window needs a native swap that does not move focus.
  Restoration is best effort: its failure is logged but the committed swap still succeeds.
  The browser keeps the request-only `movingHerdrFocus` guard used for a split: with
  Follow herdr focus enabled, a focus event received while a swap is pending can be ignored.
  A restore event received after its reply can still open the restored pane in the browser.
  This is the approved fallback after six ordering failures of a client-only restore filter.
  Native focus events carry no RPC correlation, so the bridge cannot prove which event was
  caused by restoration. No sequence fields, pane-name tokens, or held/replayed events are
  added. The root fix needs native `pane.swap focus:false` or correlated event identifiers.
  A refused title swap shows a layout notice with a localized reason.
  A close confirms when
  the pane is busy or is the last pane of the workspace. Rename is herdr's label; clearing it
  returns to its automatic title. Herdr owns every resulting layout and name.
- Up to 768px a split has no room: the canvas shows the selected pane alone, full size and
  borderless as a zoomed one, with no split boundary, and the tab's menu picks another. The
  other panes stay mounted and hidden at the same full size. This is only what the browser draws:
  herdr's layout and zoom are not changed, and a wider window draws the split again.
- Zoom uses herdr's zoom flag and focused pane. The other panes keep their mounted terminals
  hidden, preserving attachments and drafts; unzoom restores their rectangles. Web selection
  stays local to this browser and does not change herdr's focus in another client.
- The other way is opt-in, per device (Settings → Terminal → Follow herdr's focus, off by
  default): when herdr's own focus moves (a click in its window, `herdr tab focus`, a script's
  `herdr tab create --focus`), the server's `pane-focused` frame opens that pane here too, only
  on the PC open here and never for a pane already in front (the selected one or the other split
  half). It is an automatic pick: no keyboard is raised and no Back entry is added. A split this
  device asked to open (Split pane right and open it) stays its own pick, keyboard and Back entry
  included, even when herdr's frame comes before the split's answer: until that request is
  answered, for 10 s at most, that PC's frames are not followed. A PC on Ovis older than 0.4.13 sends no such frame,
  which the setting's description says. Off, a browser
  is a tmux client of a grouped session (its own current window); on, it shares the session's
  current window as herdr's own window does. The coding-agent apps have no outside focus to follow.
- Drag the actual split boundary to resize, with an 8px hit region and native 0.1–0.9 ratio
  limits. Its keyboard separator accepts arrow keys. `layout.set_split_ratio` receives the
  binary path (false first, true second), at most 30 times a second, one request in flight;
  release flushes the final ratio. A tab/topology change cancels the drag.
- Every pane keeps its own xterm, attachment, input ownership, lens, chat state and file-path
  context. Only the active pane may take keyboard focus after an asynchronous operation.
- Switching tabs retains an outgoing terminal while its explicit submit awaits a receipt;
  its chat/input UI is unmounted and its grid is not resized. The receipt settles the original
  draft before the pane attachment is released. No input is replayed. A canvas that already released
  its panes while away opens a replacement as view-only until the user returns.
  An automatic queue also retains its original pane lease until sent, discarded or held.
- The unlocked app owns one connection per visited PC, shared by its pane mounts. A pane leaving
  the canvas without an outstanding submit or automatic queue sends detach and loses its
  automatic-delivery lease, while the PC connection keeps
  receiving authoritative held/removal receipts. Returning exposes the same pending ID for an
  explicit Send now. Only an actual disconnect, PC removal, sign-out or app teardown suspends
  connection proof; reconnect/reload never resumes pending delivery.
  A newly split pane awaiting its first snapshot does not unmount its siblings. Geometry is
  fitted inside each rendered pane; layout rectangles are never used as PTY dimensions.
  A right-click on a pane always opens its menu.
  Native app shortcuts default to Mod+Shift in the browser, so Ctrl+key continues to reach the PTY;
  a plain Ctrl/Alt chord is taken only after the user records it and confirms Save anyway.

### Worktree dialog (`.worktree-modal`)
- From a workspace row's menu, as herdr's prefix+shift+g: **New worktree** asks for the branch
  (required), where to start from (HEAD when empty, ignored for a branch that exists) and a
  name, then checks the branch out under herdr's worktree folder and opens it as a
  workspace grouped with the repository's; its pane is selected. **Open worktree…** lists the
  repository's other checkouts as rows (branch, mono path, an **Already open** pill), and a row
  opens or returns to that workspace. herdr's own words explain a refusal, inside the dialog.
- The branch arrives filled in as herdr's own form fills it (`worktree/brave-valley-07f8`:
  adjective, noun, four hex digits) and selected, so typing replaces it. The name is the branch
  with its slashes as dashes and follows the branch until it is typed over.
- **Agent** is the New workspace dialog's picker, under the name: the agent last started, Shell
  for none. It starts in the checkout's pane once the checkout is made. One that fails to start
  leaves the worktree there: the dialog says why, locks its fields, and its button reads **Open**.
- The browser demo answers the same list/create/open/remove worktree APIs with fictional
  checkout records, so its branch rows and dialogs work without a filesystem or live herdr.
### Session history (`.session-modal`)
- From a workspace row's menu, **Earlier sessions…** (lucide `History`, beside Rename workspace),
  and from the chat: picking `/resume` in the `/` menu's Terminal commands opens it at once, and the
  same command typed and sent opens the list without sending anything. The
  dialog is the worktree dialog's anatomy: **Agent** is the New workspace dialog's picker
  (`AgentPicker`: each agent with its mark, its chevron inset like the app's other controls, no
  Shell entry; Escape on its open list closes the list, the next one the dialog) of the PC's
  installed agents (the row's or the pane's agent first), under it the folder the sessions were
  started in, in mono, then one `.session-row` per session as `GET /api/sessions/history` lists
  them, newest first: the title (else the first prompt; else the id in mono) in `--fs-sm` medium,
  the first prompt under it in `--text-dim`, each clamped to two lines, and at the trailing end
  the time it was last touched (the chat turn's timestamp format; on hover the full date of its
  start, where the store records one, and of its last touch) over the way on. The
  way on is a quiet `.btn` **Resume**, never the primary style: a list of up to fifty rows carries
  no fifty accents. A session a pane of the workspace already shows (its `agent_session`, by id or
  by file name) gets an **Already open** pill (over the button on a phone, beside it elsewhere) and
  **Open**, which selects that pane in the browser and moves herdr's focus nowhere. A row whose
  resume syntax is not verified (`resume: null`) is listed with no button. Resume sends one
  `POST /api/tab/create` with the row's own argv as the agent (`{ kind, args }`) and the listed
  folder; while it is in flight the row takes `--bg-hover`, every button is disabled, a
  `role="status"` line reads **Resuming…**, and a second click sends nothing
  (`lib/sessionHistory.ts` inFlightGuard). The list reopened before herdr has reported the new
  pane's session shows that session as **Already open** with **Open** on the new pane (disabled
  until the roster lists it) and no Resume: App keeps a record of each Resume
  (`lib/useRecentResumes.ts`) that ends on evidence alone: herdr reports the pane's session, or the
  pane it listed is gone; a pane still listed without a session keeps it however long ago the
  Resume was (time never brings Resume back for a pane that is there), and only a pane the roster
  never lists ends it, after two minutes. A refusal shows under the rows in the blocked colour.
  An empty store says **No earlier Codex sessions in this folder.**; a PC whose bridge answers
  404 for the route says the bridge does not offer this yet, and the workspace menu of such a PC
  has no item (the bridge is asked once, without a workspace, so nothing is listed by the probe).
- Claude keeps one store per `CLAUDE_CONFIG_DIR`, and two stores can hold the same session id. A
  Claude list is the store of the pane it is opened from (the pane asking; from a workspace row,
  the selected pane, else the workspace's first in tab order), and each row's Resume is bound to
  that pane and store: it goes to `POST /api/sessions/resume`, never the argv-only tab request,
  which starts it in the same store or names the pane already showing it there (selected, as
  **Open** is). A pane that reports the same id is **Already open** for the row only when it is the
  list's own pane; another may be on another store. A store that changed since the list is read
  again in place: the rows stay where they are without their buttons until the new ones come, the
  focus goes back to the row that asked, and the `role="status"` line under the rows says so. That
  line (`.session-status`) is kept one line high under every non-empty list, empty until it says
  **Resuming…**, **Reading sessions…** or why the list was read again, so no row moves under the
  pointer when it speaks. A pane whose store cannot be told (herdr reports none of its processes,
  two Claudes in front of it, an environment that cannot be read in full, as Linux's `/proc` and
  macOS's `sysctl` give it, or, on Windows, Claude's live PID record in no store, in two (a store
  copied while Claude ran) or in one that cannot be read) lists nothing and says why in words,
  with the next step: one Claude in the pane, its store folder there, then open the list again. A row its bridge bound to
  no store (an older bridge, or a store a new tab would not repeat: none exported by the pane's
  Claude while the environment a new tab inherits exports one; that is herdr's own on Linux and
  the bridge's elsewhere) shows a quiet **Resume unavailable** pill
  instead of the button: no store selector is added, and nothing is started in the default store
  in its place. This keeps the Codex CLI and Claude Code pickers' one-session-per-row design;
  Claude Code itself only ever lists the store it runs on, which is what binding to the pane does.
- Keyboard: the first row's button takes the focus once the rows are in (the agent field until
  then; focus the user moved meanwhile stays), ArrowUp/ArrowDown and Home/End move along the
  rows' buttons, Tab stays inside, Enter resumes, Escape, the X, Cancel and the scrim close, and
  the focus returns to what opened it. Rows carry their title and time as a label.
- The design follows the resume pickers of Codex CLI (`/resume`) and Claude Code
  (`claude --resume`): one session per row, newest first, the first prompt as the row's text, the
  time it was last touched beside it, Enter resuming. Both are full-screen tables in the terminal;
  here the list is a dialog over the pane, in the worktree dialog's rows, and the agent is a field
  above them because the folder may hold several agents' sessions.
- The browser demo answers `GET /api/sessions/history` with two fictional sessions per agent and
  marks a tab resumed through it as showing that session, so the **Already open** path shows too.
  Its flaky-retry-test workspace answers Claude's list as an older bridge would (no store source,
  no resume route), so **Resume unavailable** shows there.

### Unsent text (`.unsent-modal`)
- herdr gives pane IDs out again once it is replaced, so a pane's drafts (message box, terminal
  line, held input, held or unconfirmed chat messages) and its lens belong to the herdr they were made under (`herdr_lifetime` in the
  snapshot, src/lib/paneLifetime.ts). When a PC's snapshot names another herdr, its panes open with
  an empty box and their default lens in that same render, and the earlier text waits here instead
  of in a pane it was not written for. Nothing is deleted or sent on its own. Text stored before
  this release, which names no herdr, waits here too from the first load; a snapshot that names no
  herdr draws its panes with none of the stored state until one is named again.
- Opened only by the user, from a pane's menu (**Recover unsent text**, lucide `ArchiveRestore`,
  listed only while there is some). A `.modal` of 560px, a bottom sheet on a phone: a lead sentence,
  then one row per text, each with its PC, pane, kind (Message box, Terminal line, Held input, Held message) and
  time on one `--text-dim` line, the text in mono on `--bg-elevated` (whole, wrapped, scrolled past
  ten lines), and **Put in message box** (agent panes only: added after what the box of the pane it
  was opened from holds, and that pane shows its chat), **Copy** and **Discard**. Nothing here sends;
  the list closes when its last text is recovered or discarded.
- Slack's Drafts list is the model: unsent text kept apart from the conversation, put back only by
  hand. The coding-agent apps (the Codex and Claude apps, Paseo, T3 Code) make their own
  conversation IDs and never give one to another conversation, so none of them has a draft whose
  owner was replaced, and there is no app precedent to follow. A PC whose server names no herdr (an older bridge) keeps its drafts in the page alone.

### Changes list and diff viewer (`.repo-changes`, `.repo-diff*`)
- Files has two faces, **Browse** | **Changes** (`.segmented` in its header). **Changes** lists
  what a comparison changed in the repository the pane sits in: the working tree against the
  index, the index against HEAD, two commits named by hand (**From commit**, **To commit**,
  **Compare**), or the branch against a base (**Branch**, below); a Refresh button re-reads it,
  nothing polls. On a phone the four scopes share the bar's whole width and the fold-all and
  Refresh buttons take the row under them: side by side they would run past the card. Under the
  controls, the branch
  (`Detached HEAD`, `No commits yet`) beside a `GitBranch` glyph and the repository's root, mono,
  cut from its start. The files sit under the folders they are in (lib/changeTree.ts): a
  `.repo-change-folder` button row (caret, `--accent` folder glyph, name, and the count of files
  below it in `.repo-change-folder-count`) stands where its first file was listed, a folder holding
  nothing but one folder joins it into one row (`src/components/diffs`), every folder starts open,
  a tap folds it (kept across Refresh and scope changes), and an icon button beside Refresh folds
  or opens them all. Each level moves its rows in by `--depth` steps of `--repo-change-indent`, in
  nested lists. One `.repo-change` row per file, like the folder browser's rows (only file rows
  carry that class, and the folder prefix of a path stays in `.repo-change-path` as visually hidden
  text, so a screen reader reads the whole path in listing order): git's own
  letter in a `.repo-change-mark` chip (M, A, D, R, C, T, U, ?), the path in mono with a rename's
  old path dimmed before an arrow, and `+added −removed` in `--syntax-inserted` /
  `--syntax-deleted`, or **Binary**. The chip is tinted as the diff's rows are: added and
  untracked on `--status-done-tint`, deleted and conflicts on `--status-blocked-tint`, modified on
  `--accent-tint`; an untracked file's chip has the dashed edge of an unknown state. The status
  word is kept for assistive tech (`.visually-hidden`), so the letter is never the only name.
  Empty and refused comparisons say so in the list's own words (`No uncommitted changes`,
  `Nothing staged`, `These commits are the same`, a cut list with its counts, a folder outside
  git, a commit that does not exist, a bridge too old for the routes), never in git's.
- A row opens `.repo-diff-viewer`, a modal above the list with a history entry of its own
  (lib/useRepoDiffViewer.ts, as a file preview has): Back, Escape, Close and the scrim each close
  it alone and return the focus to its row; a reload restores it. Its header is the file viewer's:
  the name cut inside its stem, a mono meta line with the status in words (`.repo-diff-status`,
  tinted like the chip), the counts, a `--notice` warning with an icon when the rows are left
  plain or forced to one column, the comparison (`Working tree`, `Staged`, `abc1234..def5678`),
  and the folder giving way first. Its actions: **Unified** | **Split** (`.segmented`, the
  `diffStyle` setting; Split is disabled at `<=640px` with the reason as its tooltip and the note
  in the meta line), **Fold context** (an `aria-pressed` icon button: one unchanged line around
  each change instead of the three git printed, the rest counted in the separators), **Open
  file** (the file viewer, on the PC that holds the repository; not for a deleted file) and
  **Copy patch** (git's own text; without a clipboard the patch becomes a selected text box, as
  the file viewer's Copy does). On a phone the actions take the second row under Close.
- The rows are `@pierre/diffs`' `FileDiff` inside its `Virtualizer`: a window of a few hundred
  rows whatever the patch's length, drawn in the shadow root with the same tokens as a
  virtualized source (the `--diffs-*` hooks of lib/sourceTheme.ts): text `--text`, background
  `--bg`, numbers `--line-number`, and `--syntax-inserted` / `--syntax-deleted` as the package's
  base colors: its gutter bars, signs and word emphasis take them verbatim, and it mixes the added
  and removed rows' backgrounds from them and `--bg` (no tint token is handed to it, since it
  would be mixed again); separators on `--bg-elevated` with the package's own `N unmodified
  lines`. Old and new line numbers sit in the gutters, outside a
  selection and a copy; a blank row keeps its newline. Colors come from the package's worker
  within the source bounds (256 KB, 5 000 lines), else the rows stay plain and the header says
  `Too long to highlight`. Between hunks nothing expands: the routes serve the patch alone, not
  the files around it; **Open file** is the way to the whole file.
- **Find in diff** (a `Search` icon button first among the actions, `aria-pressed`, and Ctrl/Cmd+F
  while the viewer has the keyboard) opens the terminal find bar's markup and tokens
  (`.find-bar.repo-diff-find`) between the header and the rows: the query with its name `Find in
  diff` in view beside it, the count (`2 of 4`, `No matches`) with the active match's kind and line
  in words (`Removed line 4`), Previous, Next and Close (44px on touch, an 8px gap between them),
  and the hint `Searches this loaded patch, including context. Content outside the patch is not
  searched.` The bar's words take `--fs-md`, `--fs-chat` on a phone, above the terminal bar's
  `--fs-xs`: here they say what was and was not searched. No recent queries or suggestions: the
  terminal bar has none and this one keeps its behaviour. It searches the loaded patch as logical lines
  (lib/repoDiffFind.ts: added, removed and unchanged lines, an unchanged line once on its new
  side), literally and case-sensitively, never the mounted rows, so a match folded away or
  outside the window of rows is found; a match on a folded line turns Fold context off, and the
  row is brought to the middle by the same measured reveal as a virtualized source (a wrapped row
  taller than the view by the match's own lines, so a match near its end is not left below), and an
  unwrapped row is scrolled across until the match is in view beside the line numbers. The active
  row gets an inset `--accent` ring (only its side's column in split) and its text is painted in
  reverse through a CSS highlight, so it is not told by the tint alone. Enter / Shift+Enter step
  and wrap; Escape closes Find first and returns the focus to what first opened it (a repeated
  Ctrl/Cmd+F only refocuses the query), the viewer on the next press. Reopened, Find shows its
  query, count and active match again. A new file, comparison or patch drops the query and its anchor; without a patch
  (on its way, binary, too large, a conflict, a refusal, an offline PC, a watch-only device)
  Find is off and says there is no loaded patch to search. Nothing is fetched to widen the
  search: the routes serve the patch alone. Precedent: a browser's or an editor's find bar
  (Zed, VS Code), scoped to the one virtualized diff; that the Codex or Claude apps search their
  diff panels this way is unverified, so this is local discoverability for the app's own
  windowed rows rather than a copy of theirs.
- What has no rows says so in a `.repo-diff-note`: a binary file, a change past the server's
  patch cap (with the cap in bytes), a merge conflict, a path that is not a regular file, a pure
  rename or mode change (`No lines changed.`), a file that no longer differs, and every refusal of
  the routes in the app's words.
- **Branch** is the Codex app's review-pane scope of that name (its review pane offers Unstaged,
  Staged, Commit and Branch, the last "the diff against your base branch", and `/review` asks
  "Review against a base branch"), adapted to herdr's per-pane target: the base is chosen for this
  PC, pane and folder alone and remembered nowhere, never guessed from the remote's HEAD or a
  branch named `main`, and nothing is compared until **Compare**. One `.field`, **Base branch**,
  holds an editable combobox (`.input`, `role=combobox`) with a `ChevronDown` icon button at its
  end (**Choose a branch**, the touch target on a phone) and **Compare** beside it (`.btn-primary`,
  disabled while the field is empty; beside the field on a phone too, and the field as tall as it
  there). Before the first Compare the list says `Choose a base, then Compare.` and the field's
  placeholder `Branch or commit`; nothing is shown as loading. Opening the list reads the
  repository's local and remote branches (`GET /api/workspace/diff/refs`, nothing fetched) into a
  `.menu` listbox in the form's own flow, under the field and **Compare** and as wide as both, at
  every width: it pushes the files down instead of floating, so it never covers **Compare**, the
  scopes or the sheet's header, and a phone gets no popover over its sheet. A click elsewhere
  closes it once the click is done, so nothing moves under a press: one `.menu-item` per branch with a
  `GitBranch` glyph, its short name (`main`, `origin/main`) in mono and its commit's seven
  characters as the hint (both mono `--fs-md`, and on a phone the name `--fs-xl`, the hint and
  the list's notes `--fs-lg`: they are read and picked, not captions), the remote's symbolic HEAD
  left out, the typed text filtering the rows,
  the arrow keys walking them and Enter taking one (which compares against that branch by its
  full refname, so a tag of the same name is never meant). What the list has to say takes a
  `.repo-changes-refs-note` in its own words: on its way, no branches yet (a commit can still be
  typed), none matching (Compare takes the name as typed), cut at 200 (another can be typed by
  name), and every refusal (a watching device, a bridge too old for the route). The branch is
  compared from its merge base with the base, untracked files included, so the base's own later
  changes stay out; a second mono line under the repository line (`.repo-changes-identity`, a
  `GitMerge` glyph, wrapping on a phone) says so: `Compared from 3f1c2aa, the merge base with
  origin/main`. That identity (repository, HEAD, base and merge base) is what each file's patch
  is read from, and the diff header names it `Since origin/main`: a base that moves on changes
  nothing until Refresh, while a moved HEAD or another repository makes a patch say `HEAD or the
  repository changed since the list was read; refresh the list.` instead of drawing another
  comparison. A base that names no commit, a repository with no commit yet and a base sharing no
  history with HEAD are each refused in the list's own words, with nothing compared in their
  place; `Nothing changed since the base` is the empty state. The browser demo offers fictional
  refs and one fictional branch comparison against `main`. Another PC, pane or folder starts the
  scope over: the base is cleared, nothing is compared there until **Compare**, and a list still
  on its way for the target left behind is dropped.

### Header context and connection
- A selected pane shows agent mark + title (`--fs-md`), then on the same line the crumb
  PC › workspace › folder (`--fs-xs`, `--text-dim`); with one PC registered the PC is left out, as
  the sidebar leaves it out. The folder shows as its last name, and only
  when the title, the workspace or the PC name shown on the line does not already say it
  (`lib/headerCrumb.ts`, which also owns the one-PC rule). The
  title may shorten with an ellipsis; the crumb never does: when it does not fit whole beside the
  whole title it is not drawn, and the title has the row. The full path is in the context's
  tooltip and at the top of the More menu. With no selection, the brand fills the context slot.
- The More menu (`.header-more-button`, the `RowMenu` popover, a bottom sheet at `<=640px`) opens
  with the location on two lines, "PC › workspace" then the full path in mono. Its first item,
  at every width, is **Search panes and actions**, which opens the command palette (its shortcut
  as the item's hint where the pointer is fine); then **Find in terminal**, **Browse files** (at
  `<=768px` only: from `769px` Files is the header's own button), **Copy link** and **Alerts**,
  each under the condition its own button had. New tab stays on the tab strip's `+`. The Alerts item says
  this device's state in words after its label ("On in the app", "On in this tab", "On, pushed to
  this device", "Off on this device") and switches it: it is a `menuitemcheckbox` with
  `aria-checked` in the popover and a button with `aria-pressed` in the sheet. While alerts are off on this device the
  More button carries a `--dot-size` `--accent` dot and its name says "alerts are off": the dot
  marks the state that needs a look, never "on".
- The segmented Chat/Terminal view switch lives in the header. There is no floating view-toggle pill.
  Files is an action, not a third lens: it opens the Files dialog and never joins the switch.
- At `<=768px` the drawer toggle and More are `--touch-target-header` squares. The lens buttons
  are not: they keep the switch's track and inset, as the segmented control entry describes.
- Connection is one quiet chip, drawn only while the bridge is not live: a pulsing dot plus the
  written state - connecting until this page's first connection to the PC's socket, reconnecting
  after a drop, disconnected once output stopped. Below `900px` it keeps only its dot; the word stays as
  its accessible text and in its tooltip. While live the chip takes no room and stays in the
  document as a `role="status"` a screen reader can read (`.conn-live`; never `display: none`).

### Chat turn (`.chat-turn`)
- Native conversation rows use LegendList 3.3.5, with the chat view as the single
  scroll owner. The centered lane, exchange spacing and prompt portal stay separate from
  row lifetime. The list anchors prepends by a browser-local slot, never by a timestamp or
  mutable message text; machine, pane and history replacement reset that slot scope.
  Selected ranges and focused rows remain mounted outside the visible window. Disclosure
  choices and completed whole-output reads belong to logical rows and survive eviction.
  Spare list containers may remain offscreen after a selection ends; this is not an
  unlimited transcript DOM or a promise of bounded memory for all loaded source data.
  The web ESM patch orders pooled DOM slots before paint, uses state-preserving
  `moveBefore` where available, and clears stale prepend locks on explicit navigation.
  These changes preserve native drag/copy order and prevent a later layout from undoing
  a jump to a turn; the React Native and keyboard patches from t3code are not included.
- The chat lens is a centered `--chat-w` transcript over the still-attached terminal surface.
  At the Default chat width the lane follows the pane: min 820px, max 60rem (960px at a 16px
  root), 71% of the pane (`.terminal-stack`) between. `PaneTerminal` measures the pane and writes
  the lane on its stack as one length, and a file viewer over the app measures the pane that
  opened it and writes the same on itself for its Markdown preview (both `lib/chatLane.ts`),
  `min(max(820px, 60rem), <the pane's share>px)` (`chatLaneLength`,
  `lib/settings.ts`); `--chat-w` never holds that percentage, because each column would resolve
  it against its own box and they would differ by their gutters.
  The ceiling is in rem because Wide is (`72rem`), and it stays `60rem` inside the length, so
  Default is never wider than Wide at a root font of 11.4px and up, also when that size changes
  while the page is open (under 11.4px the 820px floor is itself wider than Wide's 72rem). The
  floor stays in px (`--content-w` is px); under a 13.67px root, where 60rem is less than 820px, the
  floor wins and Default is the same lane as Narrow.
  Structured Claude/omp transcripts fall back to ANSI-stripped pane scrollback when unavailable.
- The register is Codex / gajae-code-app: a quiet document. User turns are right-aligned neutral
  cards (`--bg-elevated`, a `--bubble-border` edge, `--radius-lg` on all four corners, ≤80% wide,
  no avatar or name). Assistant turns have no header: the answer is plain prose.
- A long user message (`lib/userMessageFold.ts`: more than `--chat-fold-lines` lines, or more
  characters than about that many lines of the widest bubble hold, a link or image counted by its
  label) is capped at `--chat-fold-lines` lines of its prose. Only such a message is measured, and
  only where the cap cuts it does it fold: the last line fades into the card through an alpha mask
  one prose line tall, over a **Show full message** text button on the card's right edge
  (`--text-dim`, `--fs-xs`, `--bg-hover` and `--text-strong` under the pointer; a `--touch-target`
  row where the primary pointer is coarse). Open, it reads **Show less**, and folding brings the
  card's top back into view as a code block's fold does. The choice stays with the row while it
  leaves and re-enters the list, and Find landing on the turn opens a cut message, so a match is
  never behind the fold.
- Space separates exchanges, not a rule: the transcript's gap is `--space-3`, so an answer sits
  close under its prompt, and a user turn that follows an assistant turn takes `--space-5` more.
  The one rule of an exchange is the hairline under each of its folded work blocks.
- Meta (time, copy) fades in on hover or focus and takes no click or tap while unseen; with any
  coarse pointer (a phone, or a touch screen beside a mouse) it is always visible. With a mouse and no touch screen (`(hover: hover) and
  (pointer: fine) and (not (any-pointer: coarse))`): from 481px a user turn's time and copy sit
  beside its bubble, and an answer has one copy glyph (it copies Markdown) with a **Plain text**
  text button in the regular weight beside it. Otherwise the answer keeps two labelled buttons,
  glyph + MD and glyph + TXT; where the primary pointer is coarse each is a `--touch-target` target on a
  one-line row, as is a user turn's copy, and a skill list under a user turn clears that target; the
  first copy drops its own left inset so its glyph stays on the prose edge (an overhang past the
  transcript's edge cannot be tapped). With a mouse the copy and format buttons keep their `--chip-h`
  look and take a `--pointer-target` hit area through an invisible `::before` expander.
- A user turn of Claude Code, grok or agy carries one more glyph button beside its copy, the same
  `.chat-copy` look (`.chat-rewind`, lucide Undo2): **Rewind in terminal** sends nothing and
  opens the pane's terminal with a dismissible, one-line `.terminal-banner-rewind` hint to run
  the agent's own `/rewind`. Drafts stay intact. Chat follows the native transcript's active
  branch once the agent records it; it never guesses a restore from a dialog's wording. The
  hover placement follows the message actions of the Claude and Codex apps; the terminal handoff
  deliberately differs from their native rewind controls because this bridge does not own them.
- A terminal-only command sent from Chat is one quiet right-aligned row, not a bubble:
  `SquareTerminal`, the command in mono `--fs-sm`, **Ran in terminal** in `--text-dim`,
  and one **Open Terminal** text button, which opens a terminal peek over the chat (see the
  composer's terminal commands). It has no outcome chip or unconfirmed output preview.
  The same row replaces a matching native user turn, so the command never appears twice.
  Recognized informational result cards, including Hermes, keep their existing presentation.
- An ordinary command sent from the chat says what became of it under its bubble (`.chat-outcome`,
  `lib/outcomeChip.ts`): one quiet `--fs-xs` line in `--text-dim` on the message's side, a 14px
  glyph and the state in words, read as a `role="status"` live region. It follows the delivery
  receipt messaging apps put under a sent bubble (iMessage's Delivered / Read; Claude's remote
  clients show a read-receipt indicator under a sent prompt), not a toast or a notice row, and
  unlike a receipt it names what the bridge saw: **Accepted** (hollow circle; the bridge sent it,
  nothing more), **Waiting for your answer** (`CircleAlert` in `--status-blocked`, with **Answer**,
  which focuses the waiting card), **Done · transcript / card answered / result on screen / agent
  event / saved state** (`CircleCheck` in `--status-done`, the evidence that showed it), **Runs in
  the terminal** (`SquareTerminal`, with **Open Terminal**) and **No result seen**
  (`CircleQuestionMark`). A skill OpenCode did not attach adds a second line in the same quiet
  register, **Not attached, sent as plain text: @effect** (`.chat-outcome-note`, the skill ids
  from `unattached_skills`, in the user's language), as the Codex app says why a turn stopped in a
  quiet line under it rather than in a notice. The word changes on evidence alone: a typed-only command is never done,
  and nothing animates a change. A screen that changed after the send folds under the chip as
  **Terminal output changed after /x, not confirmed** (`.chat-outcome-preview`, a `--radius-md`
  hairline card on `--bg-elevated`, mono `--fs-xs` text with its line breaks kept, 60vh at most),
  a passing view that never becomes a result. A result a registered reader recognized (Hermes
  `/status`, `/version`, `/profile`, `/help`, `/reload-skills`) instead shows what the agent printed,
  verbatim, in the same card open (`.chat-outcome-result`, `role="status"`, its text focusable for
  scrolling) with **Dismiss**, which only hides it in this view and sends nothing, as an
  informational sheet is closed in the Claude and Codex apps; no keys reach the pane.
  The chip's **Answer** / **Open Terminal** are text
  buttons in the fold control's register (`--chip-h`, `--touch-target` where the primary pointer
  is coarse). A command the transcript keeps no turn for (Claude's `/btw`, an informational
  command) still gets a sent row (`.chat-turn-sent`): the same neutral bubble, time and copy,
  placed by its send time; once a transcript turn records the command the chip moves onto that
  turn and the row goes, so a command never shows twice. Prose messages carry no chip.
- Selecting text in chat copies the browser's rendered selection as plain text, not reconstructed
  Markdown. Safe rich HTML accompanies it for formatted paste; the explicit MD and TXT actions
  still copy the whole answer. This follows ordinary browser selection and the Claude/ChatGPT
  distinction between selecting text and copying an answer, rather than T3 Code's Markdown-first
  selection behavior. No extra setting is needed.
- Markdown supports headings, lists (a task item `- [x]` / `- [ ]` shows a checked or empty box in
  place of its bullet, not clickable), links, quotes, tables, inline/fenced code and code-copy
  actions.
  A long press on a rendered link in the Android app opens the phone's sheet (RowMenu,
  `MarkdownLinkMenu.tsx`) with **Copy link**, **Open link** (the tap's own way) and, where the
  WebView has `navigator.share`, **Share link**; the link's words are its title, the address under
  them. Android's WebView draws no link menu of its own, while Chrome, Safari and the iOS app's
  WKWebView do, and keep theirs: the sheet follows Android Chrome's link menu, cut to those three.
  Only the WebView's own long press (its `contextmenu`, not a mouse's) opens it, so a tap, a swipe
  and a press on other words keep their meaning.
  Markdown files use the same renderer in the file viewer. **Open in a new tab** opens an
  app link to the resolved absolute file on its own PC, independent of the originating pane.
  **Open raw file** (Code glyph) opens the original bytes; Download still saves those bytes.
  The reader page and dialog share **Show source** (Braces glyph, pressed while the source shows, so it
  never looks like Open raw file), highlighted source with CSS-counter line
  numbers (past 2 000 lines, the virtualizer's numbered rows; see File viewer under Typography),
  and **Copy file** for complete text (selecting the source if clipboard copy fails).
  There is no separate Raw action. HTML blocks in Markdown files are parsed in the preview worker
  with HTML enabled; local images still pass through the file endpoint's image-size check.
  The page has an h1 and no Close or new-tab action; the dialog keeps its focus trap and sheet swipe.
  Actions use the existing header icon-button primitive, labels and focus states. On a phone the
  header is one row: the name cut inside its stem, Show source and Copy, a **More** (Ellipsis)
  menu holding new tab, raw and download, then Close; the size and folder are left out there unless
  a partial-view notice is among them. A reader page has no Close.
  A file opens in the popup unless Settings → Chat → Open files is Beside the pane (`fileOpen`,
  per device), which docks text and code from 980px; the header button moves the open file either way.
  This differs from t3code's and paseo's docked file panels, whose look the docked viewer keeps: a
  file read from the chat leaves the chat its width unless the user asks for the split.
  Docked beside the pane (from 980px, `aside.file-panel`) the viewer is a split of the workspace on
  `--bg` behind one `--border` hairline, not a raised card, and its chrome is two thin rows on
  hairlines (t3code's file surface subheader, paseo's file panel bar): a header of
  `--control-h` + `--space-2` with the file's glyph (`FileGlyph`), its name at `--fs-sm`
  `--fw-medium` cut inside its stem, then the actions as `--control-h` − 6px ghost buttons in one
  run (popup, new tab, raw, download, copy, Close), never stacked; and a toolbar of `--control-h` −
  `--space-1` carrying the meta line (size or partial-view notice, folder) and, at its end, the
  file's view modes as a compact segmented control (**Preview | Source** for Markdown in place of
  Show source, **Page | Source** for HTML) whose chosen segment is the row's one `--bg-hover` fill.
  The content fills the panel edge to edge (no inset, radius or frame around a page, PDF or
  video; code and Markdown keep their `--space-3` inset). The panel's left edge is an unseen
  `--space-2` grip that draws a 2px `--accent` seam under the pointer, while held and on focus.
  Under 300px (a 980px window with the sidebar at its widest) the header keeps the name, the
  popup toggle and Close alone. The panel is its pane's (its paths are read from the pane's
  folder): selecting another pane or PC closes it (a file in the popup too), and the move takes the
  file's history entry over, so Back returns to the pane the file was open on, without the file.
  Closed from inside itself (Close file, Escape) the panel gives the focus back to what opened the
  file, as the dialog does; a focus already elsewhere (the composer, a sidebar row) stays there.
  A link keeps `--accent` and a file chip reads in `--text-strong` with a dotted underline; both
  underlines are `--text-dim` at rest and both take the accent on hover and focus-visible.
  Code blocks are `--radius-lg` and never scroll inside: one longer than 30 lines opens at its
  first 20 behind **Show all N lines**. On touch a block has a header strip (language, copy);
  with a mouse and no touch screen the strip becomes a corner control over the block's top right,
  shown on hover or focus-within (no transition under reduced motion).
  Fenced code is colored by role (`--syntax-*`) up to 100 KB, in a worker past 2 KB; a longer block,
  or one the worker cannot color within 2 s, stays plain with a note under it. Past 20 000 lines
  code is drawn as one text rather than an element per line, so it never holds the page.
  A table fills the reply's width; its cells, file paths included, break between words only, so a
  column is never narrower than its longest word, and a table without room scrolls sideways in
  its own box.
  Thinking renders as a folded block only when **Show thinking** is enabled.
- Auto-follow stops when the reader scrolls up, or opens a tool, a folded block or a whole output:
  they read there, and the opened row stays put while the turn streams below it (#1388). T3 Code
  keeps a reader at the very bottom pinned when they toggle a tool; Ovis already reads scrolling
  up as "stop following until I come back", and opening joins that rule. Later output raises a
  **New messages** pill. A gjc rewrite of its session file that keeps every turn shown in its place
  (its first save, trimmed tool outputs: a new history ID whose newest page still opens with those
  turns, each part's kind and each tool's call and input unchanged) keeps the rows, what was opened
  and the reader's place. A compaction that drops turns, a rewind and any other new history start over.
  A message sent from this browser's message box resumes it once the bridge accepts it at once
  (a receipt with no pending item, no refusal and no uncertain answer): the view goes to the end
  and follows the turn and its reply there. Agent of Empires re-pins its view on any prompt, local,
  remote or replayed; Ovis's sends carry a receipt, so only that accepted local receipt counts. A
  refused, uncertain, queued or Send now delivery, another browser's message, a reconnect and a
  pane opened again keep the reader's place. Scrolling or paging back, opening a tool, a folded
  block or a whole output, a minimap jump, a restored
  place, a replaced history or leaving the pane after the message went out, before its receipt or
  before its turn shows, cancels the follow. Nothing new is drawn: the existing Jump to latest and
  New messages controls keep the Ovis/Codex chat look.
- An empty chat is greeted from the composer (`.composer-greeting`, below), only where the agent's
  conversation was read and holds no turn. A chat still loading, one whose read failed, an agent
  whose transcript could not be read and a pane with no recognized agent keep their own lines
  (`Loading conversation…`, the failure line, the terminal-output fallback, `No conversation yet — say
  something below`), as does an agent that is working or asking. A history read again after it
  changed is loading, not empty. A read that failed while the chat retries on its own is one line
  (`FailureLine`): a slow PC (a timeout, 408, 504) is waited for quietly, `Waiting for the PC…` in
  the same persistent `role="status"` container as `Loading conversation…`, and alarms only after
  three slow reads in a row, `The PC isn't responding` with Try again (`role="alert"`, a read now);
  any other failure is `Couldn't load the conversation · <cause>` when the cause is known, else
  `Couldn't load the conversation` with Try again. The advice and the PC's own words (the
  `Chat read timed out.` classification among them) fold behind a dim Details toggle, never on the
  line. The terminal-output fallback's failure is the same line, `Couldn't load the terminal output`. The server answers the terminal-output fallback for an agent
  that has not written its transcript yet (a new Claude Code or Codex pane before its first
  message), so those are not greeted; an omo session not yet written answers an empty
  conversation and is.
  While terminal output stands in for an unavailable native conversation, Chat retries on the
  existing 2 s polling cadence, not the 10 s native-push backstop. A verified native read restores
  the ordinary cadence without a lens switch; rejected history stays hidden meanwhile. This
  follows T3 Code's separation of [transport health and data freshness](https://github.com/pingdotgg/t3code/blob/main/docs/internals/connection-runtime.md):
  an open socket alone does not prove the conversation is current. No code or new controls are borrowed.
  A store that writes a turn only when it ends (Letta Code's transcript) keeps its turns on screen
  while the agent works or waits on the user, and under them a quiet `Live terminal` box
  (`.chat-terminal-fallback.is-live`): the pane's own terminal tail, open, read every second,
  12 rows high (8 on a phone) and following its newest line inside, so the chat around it never
  moves. It goes in the render that adds the written turn, not when the pane's status follows.
  Letta's own input box, the status row under it and the tip under its spinner are cut from the
  tail by the layout Letta draws (`src/lib/lettaScreen.ts`); a screen in another shape is shown
  as it is.
  The Codex and Claude apps stream the running turn into the conversation; nothing written exists
  to stream here, so this follows Zed's agent panel, which shows a running command's terminal
  inline in the thread rather than guessing at its words.

### Work block (`.work-block`, `.work-row`)
- One per run of work in an assistant turn, in the agent's own order as its terminal shows it:
  words the agent wrote before a tool call stay above that call's block, and a turn that talks
  between its tools has a block between each run of words (Claude app's order of tool groups and
  prose). The turn's last block that draws a row is its head: a `▸ Worked for 7s · 1 edit · 2
  commands` header (duration = next turn's timestamp minus this one's, the whole turn's even when
  the agent ran tools after its answer and the head sits under it; the runs before it read
  `Worked`; "Working…" in `--status-working` behind a breathing dot while the agent runs;
  "Needs you" in `--text-dim` behind a still `--status-blocked` dot while the
  agent is blocked, by the pane's status and not by whether a prompt card was parsed) over
  one-line rows on the header's own left edge, which is the prose edge too (the hover plate
  overhangs it by `--space-1`).
- A row is caret + verb + object: `▸ Read src/metrics.ts`, `▸ Edited src/pages/Reports.tsx`,
  `▸ Ran pnpm test`. The caret is always shown; there is no per-tool icon and no separator. The
  verb (Read, Edited, Wrote, Ran; `lib/toolVerbs.ts`, by exact tool id) is in the interface face,
  `--fs-sm`, `--text-dim`; the object is mono `--fs-xs`. A tool the table does not know, a call
  with no object, or a call summed up by something other than its own command or path (omp's
  `intent`: `bash Checking ports`) keeps its id in mono `--text` in the verb's place. A failed row
  turns the verb or id `--status-blocked` and adds the word "failed": after the object under a
  verb (`▸ Ran pnpm test [failed]`), after the id otherwise.
- A row expands to the typed input (command, diff, file, checklist, raw) and an Output pane. Under
  a verb the tool's own id (`exec`, `Bash`, `apply_patch`) is the first line of that detail
  (`.work-row-tool`, mono, dim) and the row's title.
- A file the detail names (`.chat-tool-file`: an edit's or a read's file, each file of a patch,
  a sent file) reads from the pane's folder as the file browser does, with the folder's name
  first: `/work/app/src/a.ts` in a pane on `/work/app` is `app/src/a.ts`. Only a folder herdr
  reports as an absolute POSIX path counts (a UNC folder, `//server/share` included, does not); a
  file outside it, in a sibling (`/work/app-2`), one with a
  `.` or `..` segment (`/work/app/../etc/passwd`), a relative or Windows path, or a pane with no folder known reads as written. The label alone is shorter:
  its title (`Open /work/app/src/a.ts`, or the bare path where nothing can open it), the file the
  viewer opens and a copy's text keep the path as written: selecting the whole label copies
  `/work/app/src/a.ts` (`data-raw-path`), a part of it copies that part. A selection reaching past the
  chat (Select All) copies, as plain text alone, the whole path of each shown label it takes whole;
  one that takes none stays the browser's own copy. On a touch screen the
  link grows to `--touch-target` both ways, so the files of a patch never share a hit area.
  Follows T3 Code's workspace-relative paths (`formatWorkspaceRelativePath`), already credited
  for the file browser.
- Mid-work narration sits between rows. While the turn runs it is the agent's voice: answer prose
  (`--text`, `--fs-chat` on `--lh-prose`) on the prose edge. Once the turn settles it is a quiet
  row again: `--text-dim`, `--fs-sm`. A run before the head has the agent's words after it, so it
  is settled while the turn still runs, and its narration is quiet already.
- Only the running turn's head block is open (working or blocked); the runs before it fold as a
  settled turn's do. A settled turn folds to its header
  with a hairline under it, and the header reads as a footnote: `--text-dim`, regular weight (the
  live one keeps medium weight and its state color). The answer is outside the fold. A settled
  turn stays open when its work holds text the answer does not end on: text with no answer at all
  (an action or Codex commentary came last) or text recorded after the answer, so the agent's
  words are never behind the fold. A block the reader opened or folded stays as they left it, and
  so does one they focused or clicked inside: the fold at the end of a turn never takes the rows
  from under them.
- The header is one line: the counts (`.work-block-summary`) take the width the title and the
  failure count leave and end in an ellipsis. `· 1 failed` (`.work-block-failed`) is its own item
  and is never cut, because the fold hides the failed row; at the largest chat type on the
  narrowest phone the title wraps to a second line instead.
- Pictures a tool returned (a Read of a screenshot, a browser screenshot; `tool.images`) sit at the
  end of their line as small thumbnails (`.work-images`, `.work-image`: 2.5rem by 1.5rem, cover, a
  hairline and `--radius-sm`), so a reader sees what the agent saw without opening anything.
  A folded block's line carries every picture of its tools; opened, each row's line carries its
  own, and an opened row shows them larger in its detail (`.chat-tool-images`) instead.
  A line carries only pictures the browser keeps once fetched (Claude's and pi's, served
  immutable), so a folded line never fetches one again; Codex's and OpenCode's are served
  `no-store` and appear only in their opened row, as before.
  The line keeps the latest four and puts the rest on one `+N` tile before them, so it never wraps;
  the words are cut first.
  On a coarse pointer each thumbnail and the tile is a `--touch-target` square, the line's own
  height, and the line keeps the latest three.
  Hovering a thumbnail, or reaching it with the keyboard, shows it larger over the page
  (`.work-image-preview`: 20rem wide, 16:9, `--shadow-pop`) with the tool's id and its place
  (`4 of 6`): above the thumbnail where that fits, else under it, else on the roomier side, always
  inside the viewport, and it follows the thumbnail when the chat scrolls under it.
  A touch has no hover and opens the viewer at once.
  A click opens the image viewer on all of the line's pictures at that one, and the tile opens it at
  the first.
  A picture that fails to load leaves the line rather than showing a broken icon.
  This follows the Claude app, whose folded `Read 2 files` line shows its pictures the same three
  ways (small on the line, larger on hover, the viewer on a click); none of its code is used.
- An OmO or omp `task` row opens to the tasks it starts (`.chat-task-calls`): each summary in
  `--text`, the agent as a hairline mono pill, the prompt in the bounded mono input box.
- Todo updates the agent made one after another (`.work-todo-group`) are one row:
  `▸ Plan 3 updates · 1/3 done [1 pending] [1 failed]`. Only an unbroken run folds: any other part between two
  updates, narration and hidden thinking included, ends it, and a single update stays an ordinary
  row, so the order of the work is never rewritten. The verb is the interface face like any verb;
  the summary is words, so it is the interface face too. Pending and failed counts are their own
  items after it (`.work-row-state` outlined in `--border`, `.work-row-failed` on its tint), never
  cut and never colour alone. Opened, it shows the list the row stands for with a caption saying
  what it is, then every update in order as ordinary rows, each with its state in words. An
  update opened there shows what it sent and got back, not the list again: its input as the agent
  sent it (JSON indented) under "Input", then its whole output.
- The list it stands for is the latest update that completed, judged only by what the transcript
  records (`call_id` / `state` on the tool part, `shared/protocol.ts`): Claude Code's tool_result
  says ok or error (an empty result is ok); Codex records no outcome, so an answered Codex update,
  like one from any agent that records neither, shows its list with "outcome not recorded" and no
  success claim, even after an earlier ok one. Output text and its emptiness never make an update
  succeed; an update the chat already marks failed (a Codex output that reads as a failure) is
  counted as failed. A later pending or failed update is counted beside the list, never taken for it; when
  the latest completed list cannot be read the row says so instead of showing an earlier one, and
  with no completed update it shows none.
- The run is named by its first call's own id in its turn's row (by the row and that call's index
  when the agent records no id), so appended updates and the next poll keep it open, focused and
  where the reader left it. When the second update turns a single row into the run, the run opens
  if that row was open, and the keyboard's focus stays on that update inside it (on the run's head
  when it is folded), never dropped to the page, also while the reader is in another app. This
  follows the app's own Codex-style work block (Codex app, Claude app: one row per action, folded
  under the turn); Agent of Empires' todo cards gave only the
  evidence that contiguous plan updates read better as one item, and none of its code is used.

### Plan (`.bg-tasks-plan`, `.bg-step`, `.plan-count`)
- A pane's plan has no control of its own: it shares the composer's background-task chip
  (`.bg-tasks-toggle`, beside the add button in the input card's last row). With a plan the chip
  starts with the list-checks glyph, the word **Plan** and `done/total` in tabular figures, then,
  after a middle dot, the step in progress in the agent's own words (`.bg-tasks-current`, #1040):
  one line, cut with an ellipsis past `16em` beside a mouse and `8em` on a narrow card, whole in
  the button's name and title. The figures and the task count are never cut for it, and on a card
  narrower than the row's controls the step gives its room back before the add button or the round
  button do (a one-line clamp, so its narrowest size is one glyph). The model pill beside the chip
  steps out before the step does, as it does for the chip's other words: on a phone a long step and
  a task count leave it no room, because the step is what the phone would otherwise open the plan
  to see; with no step
  in progress, between steps or once every step is done, the chip shows the figures alone and
  infers nothing from them. Running background tasks follow after a hairline as their glyph and
  number. The chip keeps the working tint while a step or a task is left, and goes quiet once every
  step is done and nothing runs. A narrow card drops the word and keeps the glyphs, the numbers and
  the step; a finger gets a `--touch-target` hit area through an invisible expander while the chip
  stays the `--chip-h` pill it is beside a mouse. The chip shows only in the chat lens, and not for
  an offline PC's cached plan. The sidebar's agent row repeats the count beside the background
  count, in its quiet mono figures and with no box (`.plan-count`). The step in the chip is the
  maintainer-approved adaptation of agent-of-empires' plan strip (#1040): only its step
  visibility is taken, and herdr keeps its existing shared chip rather than importing that
  separate always-visible strip or a progress bar, so the status line stays one row on a phone.
- The chip opens one list above the card: a **Plan** heading with `N of M done`, the steps in wave
  order (a status glyph, the name, what a running step does now, then a dim state · time · teammate
  line; a waiting step's name is dim), then a **Background tasks** heading over the tasks list when
  the pane has tasks to show. The steps are read again every few seconds while the list is open.

### Running background task detail (`.bg-task-open`, `.bg-agent-detail`)
- In the composer's background-task list, a running task's row is a disclosure button (the row's
  padding and hover tint, a dim caret at its end, `aria-haspopup="dialog"`, `aria-expanded` while
  its detail is open; `--touch-target` tall under a finger). Ended rows stay plain: what ended has
  the chat's task card.
- It opens one `.modal` (a sheet on a phone, 640px on a desktop) over the list, which stays open
  under the scrim: the working-tint status glyph, the task's title over its dim `agent · model`
  line (selectable, a phone's sheet header included), **Refresh** and **Close** as icon buttons.
  The sheet is as tall as `.modal`'s cap from the first frame, so loading, a note and the
  transcript fill the same frame and the title and buttons never move as a read lands. The body
  alone scrolls: a **Prompt** heading over the dispatch text, then **Work so far**, the agent's
  prose as it wrote it (`pre-wrap`, in a `52ch` measure) and each tool call as a mono name chip
  (`--chip-h` pill, hairline) with its arguments in dim mono after it, wrapping anywhere. Text
  only: nothing of the transcript renders as Markdown, loads an image or links out.
- It is read at length, so its type is at reading floors above the app's list scale: on a desktop
  the prose at `--fs-chat` and every other line at `--fs-md` or more; on a phone the prose and
  title at `--fs-xl` and every other line at `--fs-chat`.
- Read when opened and on Refresh, never polled; Refresh rests while a read is out, and the
  content it had stays. Each note says what happened and then, on a line of its own, what to do
  about it, never an empty transcript: loading, nothing recorded yet, the middle left out (over the
  read budget), records left out (torn or oversized), a read that failed (its own words in the
  blocked tint and `--danger-tint`, with the content as it last read under it when the failure
  passes), the agent gone from the session, the pane moved to another session, the PC
  disconnected. The sheet keeps to the Claude session its first read named: a read that finds the
  agent gone, the pane on another session, or an answer of another session clears what it showed.
  A Claude background command, an OmO task and a PC whose bridge is from before the route open the
  same sheet with the note that says so, and ask the PC for nothing.
- Escape, the scrim and a phone's Back close it, and the focus goes back to the row. An answer to a
  read of a sheet since closed, or of a pane since left, is dropped. The design keeps the
  app's own task disclosure (the chat's ended-task card and this list) rather than copying a
  coding-agent app's live view: none of the Codex, Claude, Paseo or T3 Code apps shows a running
  subagent's transcript; agent-of-empires's background-agents panel (MIT) suggested the
  interaction of opening prompt, tool and result from the row, and nothing of it is copied.

### Background tasks ended (`.chat-task-results`)
- Where OmO reports background tasks that ended, or a Claude Code subagent ends (its
  `<task-notification>`, drawn once however many records carry it), the transcript shows one `--bg-elevated` card
  (hairline edge, `--radius-lg`) on the prose column: a dim `--fs-xs` line with the layers icon,
  "2 background tasks ended" and the time, then one hairline-separated row per task.
- A row is the status icon (`--status-done` check, `--status-blocked` x, dim slash for
  cancelled), the task's summary (`--fs-sm`, medium) over a dim `--fs-xs` meta line (agent ·
  model · duration · turns · tool calls · tokens), and the status word at the right in the
  icon's color, with the skill caret. Opened, the task's answer renders as Markdown, indented to
  the title, bounded to 60vh.

### Prompt card (`.prompt-card`)
- Appears in chat while the agent is blocked and the visible pane contains a supported Claude, omp,
  omo or codex question, approval or plan menu.
- Placement: docked on the composer's column, directly above the input card, on the card's width
  and gutter (`--chat-w`). It is not part of the transcript and does not scroll with it. The
  stack from the top is transcript, held messages (folded to their caption while a card is
  open), prompt card, input card; PaneTerminal owns that order (`.prompt-dock`) and ChatView,
  which owns the prompt, renders the card into it. The dock is an `aria-live="polite"` region, as
  the transcript's log was for the card. It stays rendered while it is empty (zero height, never
  `display: none`): a live region that appears together with its content is not announced.
- Type: the card follows Settings → Chat font size and Chat font, as the transcript does. The dock
  scales the `--fs-*` tokens by `--chat-scale` and sets `--font-chat`; the reference text, the
  keycaps and the step numbers stay `--font-mono`. The height limit does not scale.
- Look: `--bg-elevated`, a `--border-strong` hairline, `--radius-xl`, no shadow. The title is
  the card's one red (`--status-blocked`, `--fs-sm`, semibold); the "input needed" badge is read
  by assistive tech and not drawn. The question is prose in `--text-strong`. Reference text (the
  command of an approval, a plan, a diff: the prompt's `body`) is the card's one mono box
  (`--bg`, `--fs-xs`); a question in words is never set in mono.
- Claude's words before its question (#2088): Claude Code 2.1.311 writes a turn's text to its
  session file only with the answer, so while a question waits the card shows the text the
  terminal draws right over the question (`screen_words`, read off the screen; the pane's wrapping
  joined back between plain prose, any other line break kept), over the question in `--text` prose with a `--text-dim` caption that it comes
  from the terminal. Like the reference text it gives way: eight lines at rest, two at the least,
  scrolling in itself. It follows Claude Code's own terminal, which keeps those words over its
  dialog; the Claude app shows them as the turn's text, which the chat shows once the transcript
  has the turn (then the card leaves its copy out). Words whose start is above the screen are not
  shown: they cannot be told from the user's own wrapped prompt.
- Height: at most the larger of 60% of the app's height (`--app-height`, so a phone's keyboard
  counts) and six touch rows (`240px`), at every width. Only the reference text gives way: six
  lines at rest, two at the least (one for a one-line command), scrolling in itself with a fade
  on its fold. The header, step chips, question, hint, options, custom answer and confirm row
  never shrink. A card still taller than its limit scrolls as a whole with a fade at its bottom
  edge, and the confirm row of a typed pick stays pinned on that edge. The card's scroll is
  contained (`overscroll-behavior: contain`), so a drag past its top is never the page's
  pull-to-refresh.
- The confirm row is kept short, since it is pinned over the options: its question
  (`Send 2. <label>?`) shows two lines at most and scrolls in itself, whatever the label's
  length, and Confirm and Cancel are one group on one line, beside the question when there is
  room and under it when there is not.
- Each prompt that appears has a card of its own: the next prompt opens at its top with nothing
  picked or typed, also when it asks the same question again. An answer that comes back after
  its card is gone (the next prompt is showing, or another pane is open) changes nothing on
  screen.
- A chevron at the header's end (`.prompt-card-fold`, after View plan) folds the card to its
  header, to read the transcript under it, and opens it again (`aria-expanded`, Collapse question
  / Expand question). The question still waits, so the card stays: a fold, never a dismiss. The
  sending line and an error still show while folded, a typed pick's confirm row opens the card, and
  the next prompt's card starts open. Follows T3 Code's pending-question panel, which folds per
  question the same way; its dismiss without answering needs an answer herdr's prompts do not have.
- A form of several questions (omo) shows a row of step chips (`.prompt-card-steps`) under the
  header: a chip per question, pill-shaped, mono number or a check once answered (`--accent`), the
  one asked now with an `--accent` border, `--accent-tint` fill and a `--primary` number. The title
  then reads `Question 1 of 2`; the review after the last question keeps the chips, all checked.
- Single options submit immediately; multi-select exposes checks plus Submit; supported custom input
  has its own labelled field. The prompt id names what the prompt says and which asking of it this is; an answer to another prompt, or to an earlier asking of the same one, is rejected with `prompt_changed`.
- OpenCode's native multi-step form uses the same question card, not a new wizard. Back and
  answered-step chips save the current step's unsent text and checks before navigating. Returning
  restores them without submitting them to the agent. This keeps the existing T3 Code-inspired
  per-question panel; folding is not cancellation, and no native cancel action is exposed.
- Pi's rpiv multi-question widget reuses that T3 Code-inspired panel and its step chips, not a
  second wizard. The native current tab is verified against the live styled viewport (background
  in colored themes; neutral versus dim/green in Pi's system theme); plain labels never authorize
  switching. Back, question chips and the complete review
  use native left/right only, observing each move without Enter. Saved choices and custom text
  are restored from the pane's verified pending call. Web-only edits must be sent or cleared
  before switching, with a hint rather than silently losing them. Review reuses the existing
  `.prompt-card-answers` definition list and its typography, not a terminal dump. Incomplete
  answers stay visible as Not answered with question-chip recovery, no partial-submit action.
- OpenCode multiselect Submit, custom Send and Enter send all checked choices and custom text
  together. A transient native-service failure keeps an existing question card and its edits;
  with no native question known, permissions and legacy prompts use the generic fallback card.
- While an answer is on its way, a `--text-dim` `--fs-xs` line under the actions says `Sending your answer…` (`role="status"`), so a slow PC never looks like a dead button. When two reads of the screen in a row fail, the same line says `Not updated: the question on screen may have changed.` and the card stays as it was; the next read that answers clears it. A restarted poll (after a refused answer, or the page shown again) keeps the notice and goes on counting: one failed read, a refused answer and one more failed read show it. The line is in the card from its first render, clipped and empty (`.visually-hidden`, never `display: none`) until the answer goes out: a live region that appears together with its content is not announced. The card's busy state (`aria-busy`) sits on its options group (`.prompt-card-options`), never on the card: Chromium fires no live-region event inside an `aria-busy` subtree, so the status line stays outside it.
- Options are flat full-width rows (`.prompt-card-option`), not boxes in the box: the menu's
  number as a keycap (mono, `--fs-2xs`, a `--border-strong` outline; the option's name keeps
  `1.`), the label, its description under it in `--text-dim`. All rows weigh the same: none is
  filled, outlined or put first as a default, since herdr has no ground to recommend one. Hover
  and focus fill a row `--bg-hover`; a checked or typed pick gets `--accent-tint` + an `--accent`
  border and keycap. A `(Recommended)` suffix, the agent's own mark, renders as a tag. On a
  coarse pointer a row is `--touch-target` tall.
- An omp Ask card whose text is the agent's own Markdown (`text_format: "markdown"`, #1644) draws
  its question as the chat draws an agent's message (`.markdown`, kept at the question's
  `--fs-md`), and its labels and descriptions as inline Markdown: emphasis and code (the chat's
  code chip), never a link or a picture, since a row answers when pressed. Links open from the
  question only. As in the Claude and Codex apps, which render a question's Markdown in their
  own question cards, the words are the agent's and the card only styles them.
- While a card that takes typed answers is open the message box's placeholder says how:
  `Type 1–3 to choose…`, or `Type 1–3 or your own reply…` when the card has a custom answer.
  Enter in an empty box answers nothing. A typed pick of an approval, plan or menu waits for
  Confirm in the card. After an answer pressed in the card with the keyboard or the mouse, focus
  moves to the message box, unless the user moved it somewhere else while the answer was on its
  way or the card is gone. A tap or a pen never moves it there (that would raise the on-screen
  keyboard). The press itself says what made it, not the device: a key or a mouse hands the focus
  on with a coarse pointer too (a tablet with a keyboard), and a tap does not on a touch-screen
  laptop with a fine pointer. Only a press that does not say what made it is read by the device's
  pointer, and stays out of the message box where that is coarse.
- `POST /api/pane/prompt/answer` translates the chosen answer into the agent's navigation keys and
  sends them through herdr `pane.send_keys` / text input. The card never fabricates a chat reply.

### Composer (`.composer`)
- Chat mode is ONE surface: the stack, the transcript and the composer region all sit on `--bg`,
  and the composer column equals the transcript column (`--chat-w`, same `--space-4` gutter,
  `--space-3` at `480px` and below).
  On a phone (`<=768px`), while the card follows the transcript directly (no held message, pending
  row, prompt card or notice between them) and no greeting stands over it, the card floats over the
  transcript's end as an iPhone's input bar does: the composer rises `--composer-over`
  (`--space-8`) into the transcript, whose last lines fade into `--bg` and blur behind the card on
  `--card-glass` and `--glass-blur`.
  The input box is a card: `--bg-elevated`, hairline border, `--radius-2xl`, `--shadow-card`
  (the only other card on this surface is the prompt card docked over it, while an agent asks);
  focus turns its border `--accent` (no inner outline). Above it the notices (below), the
  completion popover and the background-task list; inside, the image strip is its own row at the top, then the auto-growing
  message box as a row of its own at the card's full width (each tile's X is a `--chip-h` circle
  with a mouse, reaching `--pointer-target` through an invisible `::before` expander; under a
  coarse pointer the button itself grows to `--touch-target` wide and `--touch-target` plus
  `--space-1` tall), then ONE row of controls under it:
  on the left the add button (lucide `Plus`, named "Attach files"), the mic when voice input
  shows it (see Voice input), and the background-task chip; on the right the status content and ONE round Send/Stop button.
  The message's text starts `--space-4` in (`--space-3` on a phone, `480px` and below).
- The strip (`.composer-strip`) tucked under the card, as t3code's composer context strip: the
  card's own `--bg-elevated` with a `--border` hairline, inset on each side by the card's radius
  (`--radius-2xl`, never under `--space-5`) so it stays under the card's straight bottom edge,
  its top `--space-4` under the card, where the card's hairline and `--shadow-card` part the two,
  and only its bottom corners rounded (`--radius-xl`); `--space-5` top padding (so `--space-1`
  shows under the card), `--space-3` at the sides, `--space-1` under. It names the pane's
  working folder at its start (lucide `Folder`, the folder's last name, the whole path in its
  `title`) and the branch at its end (lucide `GitBranch`), each a glyph the text's size and a
  name in `--text-dim` at `--fs-xs`, `--chip-h` tall; a name that does not fit is cut short.
  A linked worktree's folder takes lucide `FolderGit2` and the word Worktree after its name, in
  a `--border` hairline box with `--radius-sm` corners.
  Nothing in it is pressed. `composerStrip` (`src/lib/composerStrip.ts`) decides what it draws from
  the composer's optional `cwd` and `branch`: a blank one is absent, and with neither there is no
  strip at all. A phone (`640px` and below, or a coarse pointer) draws no strip: the screen is the
  conversation's. The card stands over it (`z-index: 1`, so its popovers go with it and still rise
  over the transcript).
- Empty chat (`.composer-greeting`): one line on the composer's column, directly over it,
  `What should <agent> do in <folder>?` in `--text-strong`, `--fs-display`, `--fw-semibold`, `--tracking-display`, centred,
  and under it `PC · full path` in `--text-dim`, `--fs-sm`. Both wrap anywhere. While dictation's
  recording pill is open over the composer the greeting is hidden (its box stays). No suggestion
  chips or starter prompts. The greeting is out of the flow, so it takes no row from the terminal
  surface. In a mouse-driven window from `769px` the composer is moved up (a transform, nothing
  else changes size) so the greeting and the input card sit at the pane's vertical centre; a
  phone keeps the composer docked with the greeting above it. The first message sent removes the
  greeting and the composer is back at the bottom at once: it snaps, with no animation. Held
  messages keep the composer docked. Once a message went out, the greeting stays away for that
  pane until the conversation shows a turn or becomes another history: another lens, another
  pane or a failed read does not bring it back. A stack too short for the composer and the
  greeting leaves the greeting out (`.is-out`, hidden and `aria-hidden`) and the chat shows its
  own empty line. While the composer is lifted, the completion menu's height is capped to the
  room over the input card, where it scrolls. On a coarse pointer the greeting takes no touch:
  a tap or drag on it reaches the chat under it, which puts the keyboard away.
- The round button (`.composer-action`, a `--space-8` / `32px` circle with a `--space-4` glyph) is
  Send or Stop in the same place at the same size, so only the glyph changes: Send is `--primary`
  with lucide `ArrowUp`; Stop is `--text-strong` with a `--bg` square, and turns
  `--status-blocked` on hover and focus. Not connected, Stop is disabled and loses its fill
  (`--border-strong` outline, `--text-dim` glyph). A coarse pointer keeps that compact visible
  circle inside a transparent `--touch-target` / `44px` button, so tapping remains easy.
- The status content (`.composer-status`, `role="status"`) sits between the two control groups,
  pushed to the button's side. It draws, at `--fs-xs`: the model pill and the uploading
  or reconnecting sentence in `--text-dim`. The background-task chip is a button in the left controls;
  its count is repeated here as `.visually-hidden` text, so a change is still announced. The agent's written name, its separator, the state words
  `READY` / `RUN` / `INPUT` / `DONE` / `BG` and the sentence `Reasoning high` stay in it for assistive tech only
  (`.visually-hidden`): the header names the pane, and the state is told by Stop, the live row
  and the prompt card. No state word is drawn in the chat composer.
- The model pill (`.composer-pill`) holds the agent mark, the model, the reasoning level and the
  context ring in one quiet surface: `--bg-hover` fill, `--radius-pill`, `--control-h` tall,
  `--space-3` inline padding, `--space-2` between its parts. The model is in `--text` at
  `--fw-medium`; the level follows a middle dot in `--text-dim`, as the agent's own words with
  only the first letter drawn as a capital (`::first-letter`, the text is not rewritten); a pane
  that records no level draws no dot and no dash, only the name. On the
  fill the ring's track is `--border-strong`; a ring left bare on the card keeps `--border`.
  No part carries a chevron: herdr owns the agent, so none of them opens a menu. It is display only: a `span` with no role, no
  focus, no hover or pressed state, no pointer cursor and no chevron; the ring inside it is the
  one thing to press on desktop; mobile keeps the ring inert. The `title` of the model is the id as received, and the level's is its
  sentence; behind a name the id is also repeated as `.visually-hidden` text, since a touch
  cannot reach a title. A pane that names no model draws no pill: the mark and the ring stand
  alone, with a dim `Model —` and the level between them if the pane records only a level.
- Before a session's first message no transcript names its model, so the pill takes it from the
  agent's own screen (`server/start-screen.ts`), as the Codex and Claude apps show the model in
  their composers before anything is sent: Claude Code's model under its title, and the live
  status line of Codex and gjc. omp waits for its transcript to record the model: resolving its
  screen's catalog names would require `omp models`, whose discovery can refresh OAuth tokens.
  The bridge never runs that command or infers an omp model from its status line or directory.
  Codex is read only from the live footer beneath its composer; an answer quoting the /model
  picker or a draft cannot supply a model, and while a popup hides the footer the model is unknown.
  Only the live screen is read: the viewport, while herdr reports it at the bottom with the same
  history before and after the read; where herdr reports no scroll, nothing proves the live screen
  and no model is named. History can show an older frame with a model the agent no
  longer runs, so while the terminal is scrolled up (on this device or another) no model is named
  until it is back at the bottom; herdr's detection read is no stand-in, since on a short screen it
  reaches up into the history above. A Codex started in a terminal
  reports no session, so its terminal-output fallback carries the status line's model, and whether
  it has begun nothing yet (its greeting) is decided on the same live screen. Such an answer is
  marked `screen`, and the chat re-reads it on terminal output, so a switch made in the terminal
  shows once the agent draws it. A name on the screen that the
  agent's own naming does not turn into one id draws no pill (no catalog is looked up), nor does a
  screen that states no model, and an agent's default model never stands in for the session's.
- The model is drawn by name only where its id is one `modelLabel` (`src/lib/modelName.ts`) can
  name for certain, from the vendor's own regular naming and matched whole:
  `claude-<family>-<major>[-<minor>]`, also behind `anthropic/`, is `<Family> <major>.<minor>`
  (`Opus 5.5`, `Sonnet 5`); `gpt-<version>` is `GPT-<version>` and `gpt-<version>-sol` is `GPT-<version>-Sol`, as
  Codex's own status line writes it; `glm-<version>` is `GLM-<version>`. A name is never guessed. The rule is the
  vendor's id syntax, not a list of released versions, so a new model needs no change and a
  well-formed id of a version that does not exist is named too. Any other id — a dated snapshot, another tier or
  product suffix, another provider's prefix, another vendor, a spelling that is not the vendor's
  canonical one (a leading zero as in `claude-sonnet-5-05`, uppercase, a stray separator or
  space) — is drawn exactly as received in
  `--font-mono` at regular weight (`.composer-model.is-id`), so it reads as an identifier and no
  suffix is dropped.
- What does not fit the row gives way in this order: the task chip's words (icon and count below
  a `640px` card), then the reasoning level and model name according to the measured row. A long
  identifier can shorten inside the pill; the context ring remains visible: a name that would
  be cut to its floor (the `3ch` the box keeps) steps out whole instead, with its mark and its
  pill (`composerLabelDraw`, `src/lib/composerLabelFit.ts`, measured again with the level
  stepped out), so the ring stands alone and whole on a `320px` phone rather than being cut by
  the pill's edge. The row is measured
  again after fonts arrive and the context label opens or closes. The input card keeps one row
  of controls on desktop and phones.
- Every agent has one primary control: Stop while working with an empty draft, Send with text,
  and Send at rest. Uploads and in-flight sends disable Send without clearing its text. An in-flight Send keeps its accent circle at full opacity and replaces the arrow with a small progress ring, rotating in eight steps using `--dur-spin`; reduced motion keeps the ring static. Its accessible name is `Sending…` and `aria-busy` stays true until the receipt settles, without a live region. The button keeps the same size and position, even if its draft is edited to empty while sending. There
  is no separate Queue button or send menu. The placeholder is `Message <agent>…`; message text
  uses `--fs-chat` scaled by `--chat-scale` on `--lh-code` with a fine pointer. Otherwise it
  uses that scaled size or `--fs-input`, whichever is larger, keeping the 16px floor that avoids
  iOS zoom. It is set in the Chat font (`--font-chat`, else `--font-ui`), as the transcript is.
  Changing Chat font size, either font or density resizes the box around its existing draft. The
  box's height is automatic only: it has no resize grip.
- A local desktop composer shows the first visible account in Settings order for its agent's
  provider as a read-only usage reference inside the model pill. Plan-wide five-hour session is
  preferred, with weekly fallback; scoped, failed and unavailable limits do not substitute.
  The title names the account and reset times. This is not active-account detection. Mobile and
  remote panes omit it. The context ring is inert on mobile; details stay on desktop.
- Working Send on a supporting bridge adds a pending message above the input card, before the
  prompt dock. `PendingMessages` uses the chat's column and neutral user-bubble surface: plain
  text aligned right, with no outer card. Its scrolling stack is capped by `--pending-max-h`
  (`min(20dvh, 12rem)`). The text stays selectable. Its separate ↑ Send now action sends it, and the small sibling X
  discards it. A sibling pencil **Edit queued message** withdraws only that exact unsent ID
  before restoring its text to the composer, after any existing draft with a blank line between.
  Existing attachment mentions and other queued rows stay intact. This follows Claude Code's
  [pull-a-queued-message-back-to-input flow](https://wmedia.es/en/tips/claude-code-queue-messages-while-working),
  with an explicit labeled button for touch and keyboard access instead of an empty-input Up shortcut.
  Edit is available only for a row this connection owns on the bridge, not another tab's saved
  held copy. Delivery winning the serialized withdrawal race, including a held-copy resend from
  another tab, leaves the draft unchanged; withdrawal removes the shared saved copy. An ambiguous
  resend makes the original row uncertain across retry generations. Edit's withdrawal-only
  request then keeps that row and leaves the draft unchanged. Plain Discard dismisses an uncertain
  copy without proving withdrawal. An older server ignores the optional withdrawal-only flag
  and retains its existing discard behaviour.
  Stable-ID
  dispositions survive connection loss and retry generations in a bounded 1024-entry history,
  retained for at least the resend receipt's 60-second window. New pending input is refused if all
  those slots are recent or reserved for accepted rows. After history eviction or bridge restart,
  a stale copy that missed the removal remains explicitly resendable to preserve offline recovery.
  Actions keep a
  `--touch-target` touch target on phones.
  Sending disables that item's actions; errors stay inline. Uncertain messages offer Copy and
  Discard saved copy, with no retry action. Desktop and phones share this flow.
- Accepted pending messages clear only the draft prefix acknowledged by the bridge. For agents
  other than Pi, actual Enter delivery removes the pending row and refreshes the transcript. For
  a message submitted from Ovis Chat to Pi, Enter changes it to a read-only **Sent to Pi ·
  waiting for transcript** user bubble. Only a matching durable user record appended beyond the byte
  boundary captured on that exact Pi file/session and extending its captured leaf removes it, and
  only a record Pi stamped no earlier than that capture: Pi stamps a message when it is submitted,
  so an earlier stamp is the same text typed into Pi before Ovis's Enter, or a wall clock set back
  in between. When only such a record has the text, the receipt becomes **transcript confirmation
  unavailable** (dismissible) instead of confirmed or waiting for good. Pi exposes no submission
  id, so the same text submitted elsewhere after that Enter still confirms the receipt, and so does
  the same text typed while Pi compacts: Pi stamps what it stages then only when the stage drains.
  Bounded byte-exact tail checks assume Pi's append-only history contract, not arbitrary older
  history corruption detection; changed inode, header, anchor tail or branch fails closed. Pi may
  stage input while status says idle/done during automatic compaction, so status and screen text are
  not delivery evidence. A receipt belongs to its sending browser and authenticated device,
  not another attached typist. The bridge retains disconnected presentation receipts and exact
  consumed IDs for up to ten minutes, capped at 1024 each. An authorized, non-observing reattach
  with the same opaque browser resume ID and device can resume that receipt or receive its exact
  consumed removal on the local machine only. Remote-machine relays strip the resume ID from every
  attach because their shared bridge token carries no trusted origin-device namespace; remote
  reconnection cannot resume presentation receipts. This conveys no input permission. The browser's saved, non-resendable
  **transcript confirmation unavailable** copy remains after server restart or retention expiry;
  neither matching text nor an empty queue clears it. A changed terminal or session also makes
  confirmation unavailable. Ovis does not claim that Pi queued or consumed
  the message until the transcript proves it. Next-turn delivery and an explicit Send
  now action claim the same server ID. Connection loss never resumes automatic input. Previously
  held browser messages retain their explicit Send now/Discard recovery.
- Not connected, the one word `Reconnecting…` (`Connecting…` before this page's first connection to
  the PC's socket) is the placeholder while the box is empty and moves into the status content once
  there is a draft (`composerStatusHint`), on a phone too; it says no more (nothing is queued, and
  the disabled Send says so), and the chat body draws no connection line of its own: the header
  chip's word is the one place. A sentence there (`Uploading file…`, or the word) is never ellipsized: where it does not fit beside the model it takes a line
  of its own under it, without its leading dot, and wraps there; its `title` repeats it. Only
  the sentence takes a line: the mark, the model, the level and the ring stay one row over it
  (`.composer-status-meta`), where the label gives way exactly as it does with no sentence. The
  status content is then left-aligned, beside the add button. In a narrow card (`data-compact`,
  below `640px`) add, the icons and the round button at touch size leave it too little of the
  row for a word, so while a sentence shows the status content takes a row of its own over them,
  the card's width (`.composer-surface[data-compact]:has(> .composer-status[data-hint])`): the
  sentence is read whole beside the model pill or under it, from where the message's text
  starts, add and the round button keep their row, and the card grows by that row while the
  sentence shows. The primary control and add are disabled. With a draft, the reconnecting sentence is said instead of
  `Uploading file…`, never both: the attachment's own tile says it is uploading.
- The stack over the input card, on its column, is written once (PaneTerminal): held messages,
  then the prompt card (see Prompt card), then the input card. The notices are the input card's
  own: they stand inside the composer, over the card and its quick replies, so they move with it
  (a lifted greeting, a phone's keyboard) and the prompt card keeps its place directly over them.
- Notices (`.composer-notices`): under the chat lens, while the input card shows, the states the
  terminal lens floats as top-right pills (another app holds the pane, a failed output stream, the
  input held for the terminal, a copy note) stand over the card instead, in the held messages'
  anatomy: one `--border` hairline above the group, then a row per notice (`role="status"`), no
  tint and no box, every line of text `--space-3` in. A row is its lucide mark and its sentence in
  `--text-dim` at `--fs-xs` (`--status-working` for the two warnings: another app holds the pane,
  the stream failed), its own way on at its end (`Open here`, `Reconnect`, in the held rows' buttons)
  and an X named `Dismiss notice`. The held input's row has no sentence on screen: the held text
  (mono, one line, an ellipsis, the whole text as its title) and two `.icon-button` controls named
  `Send held input` and `Discard held input`, as the terminal lens's held-input row; a clipped
  `Input held:` stays in the row for its `role="status"` words. Top to bottom
  the rows are the plain notice, then the urgent ones, then the activity (the held input) nearest
  the card, as t3code's composer banner stack orders them (`src/lib/composerNotices.ts`). A
  dismissal lasts while the notice stands and says the same thing; it is forgotten once the
  notice goes or changes its words, so the next one shows again, and another pane's dismissals
  never carry over. A row's ways on sit at its end while the column holds them all beside the
  sentence; a narrower column (a phone, a narrow split) puts them on a line of their own under it,
  trailing-aligned, wrapping again when even that line is too short, and the X keeps the row's
  top trailing corner beside the first line, `--control-h` square (`--touch-target` under a
  coarse pointer) on space the row keeps clear for it, so nothing is ever cut at the column's
  edge. That is Primer's Banner anatomy (dismiss in the top right corner, actions under the
  content on a narrow viewport), with the actions trailing rather than leading so the last of
  them, the one that sends, stays over Send. With no input card (view
  only, ended, a secret prompt) the pills stay where the terminal lens draws them, and a notice
  keeps a phone's card docked: it never floats over the transcript. Under a terminal command's
  peek the grid shows, so they are its pills again.
- Held messages (`.composer-queue`) are quiet rows on the input card's column, above it: the
  card's width and gutter at every window width, no tint and no box. One `--border` hairline
  above the group, then one caption line in `--text-dim` at `--fs-xs` (a clock and the sentence
  `Held until the agent is ready`, plus `· 2 messages` from two; a translation too long for a
  phone's column takes a second line, it is never cut), then a row per message: its text, still
  a box to edit (transparent until focused, up to four lines, two at `480px` and below),
  `Send now` and `Discard`. Hairlines between rows run the column's width; every line of text starts `--space-3`
  in. The list, not the group, has the height limit (two and a half rows, then it scrolls), and it
  gives way before the caption does. "Queued messages (n)" and each row's "Message n" stay for
  assistive tech only (`.visually-hidden`).
- When the agent is ready the sentence becomes `Held message — review and send`, in `--text`, and
  the `--accent` goes on the clock and on the outline of `Send now`; the hairline stays `--border`.
  Nothing is sent without that button.
- While a prompt card is open, or in a short phone window (`480px` wide and `600px` tall or
  less, as a media query: Android's keyboard shrinks the window to that, iOS Safari's does not),
  the rows fold into the caption, which becomes a disclosure button (`aria-expanded`, a chevron,
  `--touch-target` tall on touch) and counts a single message too. The rows stay mounted and one
  tap opens them. A list that is ready, a row being edited and a row with an error are never
  folded away; while a row's error holds the rows open the caption is plain text, not a button.
  When the button goes, focus on it moves to the list, unless it went because the pane changed.
- At `480px` and below a held row is its text, `Send now` and a `--touch-target` X whose name is
  still `Discard`.
- `/` completions come from `GET /api/pane/commands` and group built-in, user and project commands;
  `@` completions query `GET /api/pane/files`. Arrow keys navigate, Enter/Tab accepts, Escape closes.
  A listing that failed is told apart from no matches: a `role="status"` row says **Couldn't load
  suggestions. Keep typing to try again.** (every change of the query asks again).
- Commands that run in the terminal (the catalog's `visibility: "terminal"`, or a bare form whose
  interaction is the terminal; `terminalCommand`, `src/lib/compose.ts`) are listed apart, last,
  under **Terminal commands**, and each carries a **Terminal** badge wherever it is listed, under a
  typed query too (`.composer-menu-badge`: the `.badge` primitive in the quiet register, `--text-dim`
  on `--bg-elevated`, never shrunk; the description beside it gives way). A row the agent's own
  menu hides (`agent-hidden`) is never listed, and typed by hand it is sent like any text. The
  menu inserts a terminal command like any other completion; Send/Enter submits it through the
  ordinary input path. There is no extra composer notice or confirmation button.
  `/resume` opens **Earlier sessions…** instead.
- Only an accepted direct send or an explicit **Send now** of a terminal command opens a
  **terminal peek** (`lib/terminalPeek.ts`): the pane's own attached grid over the chat's
  transcript, in the box the hidden grid already holds. It is this browser's state alone: the
  lens stays Chat (the header keeps Chat pressed; `ovis:view:<pane>` and `?view=` are not
  written), nothing attaches anew and herdr's focus never moves. Queue acceptance and automatic
  delivery open none, refused or unconfirmed sends keep the draft and existing note, and a
  view-only device has no composer to open one from. The chat stays mounted under the grid
  (`visibility: hidden`), keeping its layout, reading position and reads. A `--hairline` ring in
  `--accent` marks the grid as a passing view; it snaps open and closed, with no motion. On a
  desktop the composer, held messages and prompt card stay where they are, dimmed and `inert`,
  and the grid takes the focus as the terminal lens's does. Where the key bar shows (a coarse
  pointer, or `768px` and under) the key bar takes the composer's place and the composer is
  `display: none`, still mounted with its draft: the message box is blurred on the accepted
  receipt, so a phone's keyboard drops, and the grid is not focused.
- The peek's head stands in the terminal banner column and takes no grid row, in the rewind
  hint's anatomy (neutral elevated surface, hairline, `--radius-md`, `--fs-xs`, `--space-2`
  gaps, existing button targets): **/command ran** (truncated, whole in its title), under it
  **Chat may come back when you close it** when the return is armed (a possibility, never a
  promise: Claude may record no close, and a screen may close onto text), then **Back to Chat** and
  **Keep Terminal**, which move
  under the words when the pane is narrow. It has no focus trap, no Escape of its own and no dialog
  role: Escape, Tab and the arrows are the agent's. The inert composer is no dictation target, so
  Mod+Shift+Space and the Escape that cancels a recording stay the terminal's. A find bar left open
  under the Terminal lens closes when a peek opens; Find in terminal during a peek searches the
  peek's grid and keeps the peek.
- Back to Chat, the header's Chat, Mod+Shift+J (which ends the peek instead of switching
  lenses), a split half's lens button (which says the chat during a peek), a phone's Back (at
  `640px` and under, as a sheet's), another pane and a reload end the peek; so do the agent ending
  and the tab being put away. A sheet or Settings opened over a phone's peek closes back onto it
  (by its own close or by Back): the peek's history entry is made again, and only the next Back is
  the peek's (`lib/sheetHistory.ts`: the peek is a sheet that stays under what opens over it).
  Keep Terminal and the header's Terminal save the terminal lens, which ends it with the grid kept
  and focused. Every end back to the chat blurs the grid (keys typed after it reach no pty) and, on
  a desktop, focuses the message box; the chat is where it was. The quiet row's and an outcome
  chip's **Open Terminal** open a peek the reader ends by hand.
- Claude Code's chat can come back by itself. When one of its panels closes, Claude records a
  `local_command` answer ("Settings dialog dismissed"); a local-command notice timed after the
  send's own outcome (its `created_at`: both times are the PC's clock, never the browser's) ends
  the peek. Only a bare command Claude was recorded answering that way at close arms it
  (`CLAUDE_AUTO_RETURN`: `/usage`, `/cost`, `/status`, `/stats`, `/help`, `/config`, `/theme`,
  `/permissions`, `/hooks`, `/skills`, `/workflows`, `/passes`, `/resume`, `/powerup`, `/fast`).
  `/diff` records when its panel opens, `/export`, `/mcp`, `/plugin` and the like record nothing
  the chat reads, and custom commands are unrecorded: they return by hand. The send's own outcome
  is the newest one with its text the chat had not read as it left, so an identical send just
  before it, closed already, cannot end it. Held terminal input, the find bar or an IME
  composition in the grid or its input line leave the return to the reader. There is no timer and
  no key is sent: a record that never comes (Claude's fullscreen renderer writes none for most
  panels, nor does a session before its first message) leaves the peek until the reader ends it.
- The other agents whose screens were recorded come back from the screen itself
  (`lib/inputRow.ts`, `SCREEN_AUTO_RETURN` in `lib/terminalPeek.ts`): herdr reports their pickers
  and panels as idle and nothing reaches a transcript, but each draws its own empty input row
  again when the screen closes. One recognizer per agent reads the grid's bottom rows (and the
  cell attributes a placeholder needs: Codex's dim, Hermes' italic, gjc's and Devin's colour) off
  whole frames only: never inside one of herdr's synchronized-update blocks, nor between a resize
  and the agent's redraw for it (when the pane's grid changes size, the first frame for it, which
  may be herdr's own of the old screen reflowed, a box cut at its borders, neither arms nor ends
  the peek). The return arms on the first frame whose row an open screen hid
  (or covered, for omp, agy and Grok, whose panels can leave it drawn under them; Hermes, which
  draws its row again for a moment before every screen, arms on a covered row only), and ends the
  peek on the first frame that shows the row back, empty, by Back to Chat's own path. A screen
  that closes onto text in the row (Hermes' /palette, Grok's /model) leaves it to the reader, as do
  the blockers above. It arms only for a bare command whose recording hid and redrew the row
  (Codex's `/cd` into a folder too), and only when the row was read empty as the text left, so a
  screen the recognizer does not know never arms. Codex's `/side` and `/btw` (their side thread
  draws a composer of its own), print forms, toggles, `$EDITOR` handoffs, OpenCode (only its home
  screen was recorded) and every unrecorded command return by hand.
- A peek ended by hand while its command's screen is still open in the terminal (Claude's /btw
  answer, a picker left up) would let the next message be typed into that screen, where it does
  nothing. Where the pane's recognizer read the empty row as the peek began and does not see it
  now, the composer shows **/command is still open in the terminal** (`SquareTerminal`, an urgent
  row of `.composer-notices`) with **Show terminal**, which opens a peek the reader ends by hand.
  Send then keeps the message and says **Not sent: /command is still open in the terminal.** with
  **Send anyway**, which sends it once, as an ordinary send (never over a box the server showed);
  the next Send is held again. A quick reply and a queued or held message's Send now are held with
  the same note and no Send anyway. A peek opened from a chat row names no command (**A screen is
  still open in the terminal**): the reader may have opened another screen there. A listed command
  whose screen had not opened when the reader left (gjc's `/sessions` loads for seconds behind its
  empty box) leaves a silent guard that the first frame showing its screen turns into the notice,
  and that a turn of the agent drops. For Claude Code and Codex, whose recognizers read a missing
  row as a screen over it, a screen opened any other way (Codex's transcript search, Claude's
  /config, a peek's screen the Terminal lens kept) gets the unnamed notice too, once the chat shows
  it with the agent at rest and the recognizer has read the pane's empty row before; its **Show
  terminal** opens the Terminal lens, a dismissal holds until the row is drawn again, and a turn
  drops it. The notice goes on the first whole frame that shows the row
  back, with another pane, agent, terminal or session, or when dismissed. No key is sent to close
  anything. Claude Code has a recognizer for this (its box between the screen's last two rules,
  as `server/prompt.ts` reads it) while its own return stays on its record. It follows the
  composer's refusal of a Claude box that may not be empty and t3code's composer banner stack;
  Warp and Zed give an interactive program the input until it exits, which this bridge only sees
  on the screen.
- The peek follows Warp's full-screen handoff of an interactive program
  ([Warp's agent workflow](https://docs.warp.dev/agents/)), where the program takes over the
  conversation's area and the conversation is back as it was when the program exits, and Zed's
  terminal panel, which comes up over the workspace without disturbing the buffer under it. Unlike
  both it keeps the composer under the grid, inert, and comes back only on the agent's own record
  or its own input row drawn again, because the pty is the agent's own and this bridge cannot see
  a program exit. No code or pixels are copied.
- A pane whose rows carry `trigger: "@"` (OpenCode v2 skills, which it takes as `@skill-id`
  attachments) lists them in the `@` menu under a **Skills** heading before the **Files** group
  (the listbox is then **Skills and files**), a bare `@` opens that menu, and picking one inserts
  `@<id> ` (the row's `id`, its name where it has none). A path (`@src/`) never matches a skill:
  the match is a name's prefix or a word of it, as inline skills are matched. A file listing that
  failed says so in the Files group, under the skills.
- Paste, picker or drag/drop attaches up to 100 files per action; the message box names how many it left out.
  An image is stored as a paste, any other file under its own sanitised name. Each uploads through `POST /api/pane/image`, three at a time
  across all picks, and puts a removable editable `@path` mention at the start of the message (after
  a leading `/command`), in the order the files were picked. A path waits while the box holds only a
  `/command` still being typed or an IME composition, and a path that does not fit whole under the
  length cap waits on a tile whose badge is a warning glyph in `--notice` (`No room` for assistive
  tech only), with Send off and one status line, in `--notice`, saying the limit and how many
  characters over (`20,000-character limit · 41 over`); nothing else says it. Within 200 characters
  of the cap the status line counts what is left, and at the cap it names the limit
  (`20,000-character limit`), said once through the composer's polite region as the cap is reached;
  no line under the card repeats it. The caret and selection move only with the
  text they sit in, so typing while files upload is not disturbed.
- An upload that failed is one note on the box's top edge (`.composer-note`, `role="alert"`): what
  failed and the cause when it is known (`Couldn't attach · PC disk is full`, from the status or the
  server's own words, `lib/userError.ts` `userFailure`); with no known cause the line is
  `Couldn't attach` and Try again beside it uploads the file again (`offersRetry`: no cause, or the
  PC was only slow). The advice and the server's words fold behind a dim Details toggle under the
  line, never on it; the size limit's own sentence is the whole note. Removing the tile removes its
  note.
- While a phone's keyboard is up, a tap on the transcript or a drag down it (`32px`) puts the
  keyboard away. Each only blurs the field, so the draft stays. The prompt card, which can stand
  where the transcript was on a short screen, does the same: a tap on its text (never on an
  option, a box or its field), or a drag down it once the card and its reference text are
  scrolled to their top.
- On a touch screen, picking a pane (drawer, palette, notification) or switching its lens never
  raises the keyboard: the user reads first, and a tap on the message box or the grid raises it.
  A desktop's picked pane takes typing at once.
- Enter sends and Shift+Enter breaks by default; with **Enter sends** off, Mod+Enter sends. On touch screens the same device setting is shown inverted as **Return inserts a new line**, with Send and hardware Mod+Enter explained below it. IME Enter is ignored. Stop sends Escape. While the agent works and a draft shows Send in Stop's place, Escape in the box is Stop; an open completion menu takes the first Escape, and its X in the top corner (`.composer-menu-close`, Close suggestions, sticky over the rows it scrolls; the first row leaves it room) does the same for a pointer or a phone, which has no Escape, keeping the text and the focus in the box. T3 Code's command menu closes on Escape alone. Working Send schedules a pending message; its Send now action submits that same message now.

### Comments on a reply (`.reply-comment*`, `.reply-comments*`)
- Selecting text inside the words of one agent reply offers **Comment** (lucide `MessageSquarePlus`), a
  pill on `--bg-elevated` with `--shadow-pop`, drawn on a layer over the transcript (`.reply-comment-layer`,
  `--z-popover`), never in the flow: a selection in progress moves nothing (the composer row #1845 had
  shook the chat, #1922). With a mouse it stands under the point where the button was released; on a touch
  screen `28px` under the selection, clear of its handles, while the system's own menu stays above it.
  A selection reaching a user message, a work block, a skill or goal line or the copy row offers nothing;
  a watching device and an ended pane offer nothing either.
- Comment opens a small form at the same place (`360px` at most, `--radius-xl`): the quote, three lines
  at most behind a `2px` `--accent` rule, a field, Cancel and Save. Mod+Enter saves, Escape closes it
  while it is empty. Narrower than `560px` it docks along the chat's bottom edge, over the message box,
  where a phone's keyboard meets it.
- Saved comments wait per pane on this device (pane-state storage, so a replaced herdr takes them with
  its panes) as ONE chip on the row over the input card: "2 comments on the reply" on `--accent-tint`;
  a tap lists them upwards (quote and comment, an X on each), its own X removes them all. Nothing in
  Settings, and nothing is drawn in the reply itself.
- The next message sends them first, in the order written, each as `> ` quote lines and then the
  comment, a blank line between, then the typed text; a message may be comments alone. A slash command
  or an answer to the agent's question goes without them: the chip turns dashed and says "2 comments
  waiting". Such a message is `agent_only`: the bridge types it only where an agent is in front, so a
  shell never runs a quote as a redirect, and an older bridge is not sent it at all.
- Precedent: ChatGPT's selection action (a floating button over the selected answer text that puts a
  quote over the input) for the gesture, and a code review's pending comments (collected, then sent
  together, one turn for the agent) for the rest; it differs in collecting several quotes in one chip
  instead of one quote at a time.

### Voice input
- A mic button sits beside the add button in the composer and beside Send in the terminal input line; it
  fills with `--accent` while recording. Dictated text is inserted at the caret, never sent.
- `voiceInput`: `auto`, `on` or `off`; default `auto`. Auto puts the mic in the composer only, not on
  a phone (the composer's `(max-width: 640px), (pointer: coarse)`), and leaves it out where dictation
  cannot work (no HTTPS, or no key and no browser recognition). On shows it in both inputs and on a
  phone, disabled with its reason where it cannot work.
- The recording pill shows Cancel, a **Recording** label, the level bars, a mono timer and Done.
  Amber only; `--danger` stays for errors.

### Command palette
- At `<=480px` the header has no palette button: the More menu's first item, **Search panes and
  actions**, opens it by touch, and a connected keyboard still opens it with `Mod+Shift+K` (or
  the configured binding). A folder listing that fails says so in the empty list with a **Try
  again** button that asks for the same folder again.
- `Mod+Shift+K` opens a top-offset `--palette-w` dialog searching panes across all connected PCs
  and the selected PC's actions. PC names participate in search. Recent panes
  lead an empty query; arrows in the search field cycle through visible results, Enter activates
  and Escape closes. IME candidate, commit and cancel keys stay with composition. Buttons reached
  with Tab keep their native activation, and arrow navigation scrolls the selected result into view.
- Actions cover new workspace, new tab, lens/sidebar/theme, settings, notifications, lock and refresh, with
  `.kbd` hints resolved from this browser's shortcut settings; disabled bindings have no hint.
  With a pane selected they add herdr's **Split pane right / down**, the same **and open it**
  (herdr's `--focus`: the new pane is opened here only then) and, in a tab of several panes,
  **Zoom pane** / **Unzoom pane**.
- A typed query also lists Settings under a **Settings** heading: the pages, found by their name
  or the words of their settings, then the groups whose settings a page's words do not name
  (Typography, Composer, Quick replies, OpenAI API key), each with its page as the subtitle. A
  page opens Settings on it; a group opens its page scrolled to the group, with the focus on it,
  as Zed's settings search lands on the setting rather than its page. Titles rank before words
  found only in aliases, and a page before its groups. A search closed without picking leaves no
  request behind.
- Rows are grouped as herdr's Goto picker groups them: a `.menu-heading` per PC/workspace (PC
  name when multiple PCs are registered, workspace name, a linked worktree's branch in mono when
  the name does not say it, the row count), Recent (up to
  three, an unsearched and unfiltered list only) before the workspaces, Actions last. The
  workspaces stand in PC then roster order (a move in the sidebar moves the section); a search puts
  the best match's workspace first, and finds a tab by the name the strip shows it under ("Tab 2").
  A row's subtitle is "tab · folder" (the tab only in a workspace with several), "workspace · folder"
  under Recent, with the owning PC shown when more than one is registered. A result selects its
  captured PC and pane together. Disconnected PCs and stale recent targets are omitted.
- Branch inventories are read only while the palette is open, under each connected PC's own
  `MachineContext`, and accepted only for that PC's current workspace signature. Recent entries
  store both machine and pane IDs; existing per-PC history migrates into the combined list.
  New workspace, pane operations and plugin actions keep the selected PC's context and are not
  retargeted by hovering or searching another PC's panes.
- Status chips (`.palette-filter`, a `radiogroup`) sit between the search and the list: All, then
  INPUT, RUN, READY, DONE, BG in `STATUS_WORD`'s words with counts over all connected PCs. The
  checked chip takes its badge's tint and text (All and READY the neutral hover fill); a chip no
  pane answers to keeps a dashed edge. A chip is `--control-h` minus `--space-2` tall, and on a
  coarse pointer `--control-h` minus 2px with a `--touch-target` hit area. The row scrolls sideways
  without a scrollbar where it does not fit. A status filter leaves the actions out; `>` at the
  start of the query shows the actions alone and hides the chips.
- The footer (`.palette-footer`) names the picked row's place (PC › workspace › tab, omitting
  the PC for a single-PC roster) and its path in
  mono; on a desktop it also carries the `.kbd` hints for Left/Right (workspace) and `>` (actions).
- Keys: Left and Right step to the previous or next section from a row, or from the search field
  while the caret sits at the text's edge; inside the text they move the caret. herdr's picker
  letters (`b` `w` `i` `d` `a` for a filter, `/` back to the search) act only while the focus is
  outside the search field, so they never take a letter from a query. A letter puts the focus on
  the first row, also when it names the filter already shown. Left and Right on the chips move the
  filter. The pick is a row, not a place: a pane leaving the filter above it moves the pick with its
  row, and a picked row that leaves hands its place, and the focus, to the row now there (the search
  when none is left). Below 640px the sheet is one fixed height, the chips and footer staying put.

### Settings dialog
- A Settings shortcut opened over a file preview places Settings above it (`--z-modal + 2`, one
  above the preview). Settings owns Escape until it closes; the preview keeps its history entry
  underneath for the next Back or close. With no preview open Settings stays at `--z-modal`. The
  command palette opened from its shortcut shows above both (`--z-palette`).
- One page at a time. From 641px the dialog is two columns at a fixed size (`--content-w` wide,
  `40rem` tall, so turning a page never moves its edge): a `13rem` list of pages on `--bg`
  (icon + name, the open one on `--bg-hover` with its glyph in `--accent`) and the open page
  beside it under its own title and the close button. A phone shows one of the two: the sheet
  (`92%` tall) opens on the list, drawn as one card of rows with a chevron each, and a page
  replaces it under a Back to settings control. The dialog's accessible name stays **Settings**
  on every page; the list is a vertical `tablist` with one Tab stop, and the arrows walk it
  (beside an open page they turn the page too). Escape closes the dialog from any page.
- Each step into Settings is an entry of the browser's history (`lib/settingsHistory.ts`): the
  dialog, the page a phone opens from its list, the key bar editor. The system Back button (and
  an edge swipe) takes one step out and never leaves the app from inside Settings; the Back
  control, the X, Escape and the scrim take the same entries off. Beside the list, turning pages
  replaces the one entry. A reload steps out of the entries it finds; Forward reopens the page.
  Settings opened before the step back off its own closed entries lands, or off a phone sheet's
  closed entry (the palette's), stays open: those steps, and the address the app writes on the entry
  left, are no Back of the user's. Its own step that lands over a second after it was asked for is
  taken for one, as Back then may be the user's.
- Pages, in order: **Appearance** (theme, dark theme, light theme, density, language, sidebar rows; then
  **Typography**: interface font size and interface font), **Chat**
  (panes open in, show thinking, chat width, chat font size and family; then
  **Composer**: Enter sends, send queued messages automatically, in a mouse-driven window wider than
  640px the New tab button (off by default), and on a touch screen the suggestion chip (off by default); then
  **Quick replies**; then **File viewer**: wrap long lines, Markdown width, Diff layout), **Terminal** (font size, font family, wheel
  speed, input mode, Key bar, Clipboard from a pane, Use alongside herdr's own window, Follow
  herdr's focus), **Alerts**, **Voice input**, **Subscription usage**,
  **Shortcuts** (the platform-resolved global bindings), **Phone & devices** (the phone address,
  Keep screen on, Install; then Portal, where the server offers it; then paired devices; then
  Access),
  **Remote PCs** (Add PC, Update PC bridges automatically; then **Show in sidebar**), **About** (Updates, herdr, the repository links). A button that points at
  Updates opens the dialog on About.
- Every page is built from the same parts (`components/SettingsControls.tsx`). A group is an
  optional caption (`--fs-sm`, `--fw-semibold`, `--text-dim`, sentence case) over one card:
  `--bg-elevated`, hairline `--border`, `--radius-lg`, its rows parted by hairlines and never
  boxed on their own. A row is a label (`--fs-sm`, `--fw-medium`, `--text-strong`) with at most
  one dim sentence under it (`--fs-xs`, no wider than `54ch`) and one control at the end of the
  line. The controls are a switch, a segmented control for two to four short choices, a select
  for five or more, a stepper (minus, value in `--font-mono`, plus, in one bordered well) and a
  text field; inside a card they sit on `--bg-input`. On a phone a control that needs the line
  (three or more segments, a text field, or a long sentence above it) goes under its label at
  the card's width, its segments sharing it equally; the rest stay on the label's line. A
  condition that applies right now (Keep screen on without HTTPS) is one more line under the
  sentence, in `--text` (`.settings-condition`), and absent otherwise. A block's explanation is
  one dim sentence at rest with an accent "Details" word after a middle dot (`.settings-details`,
  a `details` whose `summary` is the sentence); the conditions and exceptions open under it. On
  coarse pointers an invisible expander gives that line the touch target without changing its
  height.
- Settings selects use `SettingsSelect` in `components/SettingsControls.tsx`: an inset Lucide
  chevron with space reserved beside the text. This follows the padded indicator in
  [T3 Code](https://github.com/pingdotgg/t3code/blob/main/apps/web/src/components/ui/select.tsx),
  but keeps the native select and OS picker rather than a custom popup. The decorative arrow
  passes clicks through; forced-colors mode restores the native indicator.
- Terminal keeps Key bar as a compact description and Edit key bar button. That button opens
  a detail screen in the same dialog with its own scroll body and a Back to settings control.
  Back or Escape returns to the Terminal page's scroll position and focuses Edit key bar;
  closing the dialog resets it for the next open. The detail lists the terminal keys
  in their display order. Every key can be
  removed or moved with up/down buttons; those controls keep `--touch-target` hit areas on phones.
  Add key offers the supported key catalog, and Ctrl/Alt/Shift toggles add or remove held-modifier
  buttons. Custom combination chooses one key or printable character plus modifiers, with its cap
  previewed before Add. Saved combinations send exactly those modifiers; ordinary keys inherit the
  held modifiers. Restore defaults returns the original row. The keyboard mode control stays first.
- A font family is a text field saved when it is left, on Enter or when the dialog closes, not
  per keystroke.
- Remote PCs: an **Add PC** row (label, one-line description, button) opens the PC
  setup dialog and closes Settings behind it; when that dialog closes, focus lands on the header's
  workspace-list toggle. Under the row, once the server has answered, the bridge auto-update switch.
- Install (a row of the Phone group) reflects installed, promptable or browser-instructions state;
  About links the repository.
- Portal, a group of its own between Phone and Devices where the server offers it: while it runs,
  the address and QR code as the Phone group draws them over a Relay row with Stop; otherwise one
  hint for what blocks it (no token, serve-only, no `portal` or an old one, with a link to get it)
  or a wide Relay row whose text field and Start stack on a phone. Starting and stopping are one
  dim status line, at body size (`--fs-md`, `--fs-lg` under a finger) since it is what Portal is
  doing now; a failure is the server's sentence over Portal's own lines, folded.
- A Portal that was serving and ends on its own is started again once by the server, on the same
  relay, port and identity: the address goes, the same dim status line says **Recovering…**
  with Stop still offered (disabled on a watch-only device), and a second exit or a restart
  that may not go ahead is the usual failure. The precedent is operational, not a coding-agent
  app's: Cloudflare Tunnel's service unit restarts on failure
  ([`Restart=on-failure`](https://github.com/cloudflare/cloudflared/blob/733bfb93/cmd/cloudflared/linux_service.go)),
  without limit. This differs on purpose: one restart, in the existing status row with no new
  control or setting, so a tunnel that keeps failing says so instead of looping.
- Access, the last group of Phone & devices, is read-only: one row per fact the server reports
  (`security` on `/api/health`), each a label, its dim sentence and the value in place of a
  control (`.settings-fact`: `--fs-md`, `--fw-medium`, `--text-strong`, end-aligned, at most 45%
  of the line). Access token Set or Not set; Pairing gate Not yet closed, Closed or Unavailable;
  Listens on Loopback, Tailscale address or Other address; This connection No proxy seen (with a line saying a proxy that adds nothing looks the same), Through a proxy,
  Through Tailscale, Through Tailscale Funnel or Unknown; Public internet Reachable (only seen on a
  Funnel request) or Unknown. No colour, icon or summary line carries a meaning, and nothing reads
  "safe", "secure" or "local only": a proxy or router in front can expose any bind, and only this
  request's own path is known. Before the server answers the group is one Loading line; a server
  that answers without the facts (an older one) and a check that failed are one sentence each, and
  neither shows an earlier answer or rebuilds one from `auth` or a missing LAN warning. The open-LAN
  warning stays where and as it was. Neither the Codex nor the Claude app shows such a summary, so
  there is no app to follow; Agent of Empires' security page was the prompt, but its short summary
  calls a loopback bind local-only, which this group does not.
- The running versions are always written, since the sidebar carries none. Updates opens with
  **Running vX.Y.Z (commit)**: the server's version and commit, or the client's own build version
  before the server answers and where it names neither. While the server runs another version than
  this tab was built from (updated, not yet reloaded), a second line names the tab's own. The
  **herdr** section opens with
  **Running herdr X.Y.Z**; where herdr cannot be updated from here (Windows, an older server) the
  section is that line alone, from the health check.
- An app update installs only the release the person was shown. **Update and restart** in Settings
  and **Update** / **Try again** on the header line send the commit of the offer they were drawn
  with; a release published in between installs nothing, and both places say so in one sentence
  whose action is **Check for updates** (the header's **Try again** checks), so the new release is
  read before it is installed. Under a server that cannot install by commit (an older supervisor)
  **Update and restart** stays disabled with a restart sentence and **How to restart** beside it,
  and the header line says the same as a wrapping warning line. No Codex or Claude app precedent
  for update consent is established here: this keeps Ovis's existing controls and their places and
  applies Agent of Empires' rule that consent covers one immutable offer, not a coding-agent-app
  pattern.
- Subscription usage keeps its meter preferences first, then an **Accounts** header with a dim total
  count and one **Add account** button (Plus + label). With meters off, one note follows it without
  provider placeholders; the configured hub connection remains available. With meters on, provider cards are ordered Claude,
  Codex, then the remaining reported providers; headings show mark, name and dim account count.
  Each row has email/name, then dim source (**This PC** or **Hub**), known plan and written
  sign-in status with an existing status-token dot, without badge pills. Within-provider reorder
  and visibility controls stay in fixed columns; hidden rows remain listed but fade. Empty lists
  show one dim sentence.
- An expired Claude or Codex sign-in on this PC gets one **Sign in again** button: under the row's status in
  Settings, and under **Sign-in expired.** in the usage popover (whose note then drops "Open X to
  renew it"). It runs Add account's terminal-tab sign-in, but in that account's own credential home
  (its `~/.claude-<name>`, CODEX_HOME or the default home), replacing the expired credential instead
  of adding an account: the request names the account by the key the list showed, and the server
  finds its home among the sign-ins on disk at that moment, never from a path the browser sends,
  and the tab's command sets that home (or removes an inherited one, for the default home). A hub's
  account (its sign-in lives in the hub), the other providers (their CLIs may keep a sign-in apart
  from the one read here: Cursor's app, Copilot's editor; Antigravity signs in only in its app) and
  a watching device get no button, and the popover keeps its "Open X" note for them. A refusal shows under the button; a
  started sign-in closes the popover or Settings and selects the new tab. This follows Claude
  Code's `/login` and `codex login`, which re-authenticate the config home they run in rather than
  adding an account.
- The global Add opens the shared `.modal` (a bottom sheet at 640px and below), with the existing
  focus trap, Escape/close and return focus. Its small stepper leads through provider (Claude, Codex,
  Cursor, GitHub Copilot, Grok, Antigravity, OpenCode, then Hub, in server discovery order),
  method, and authentication; Back preserves the provider context. The provider step uses two equal
  columns above 640px to fit eight choices without expanding the existing modal width, and a single
  column on phones. The existing bounded `.modal-body` alone scrolls inside the sheet; its header
  and Back/Close remain fixed. No grid reordering: keyboard and reading order match the server.
  Use **Hub** in labels and source metadata; name CLIProxyAPI only in the picker description,
  **Import accounts from CLIProxyAPI**. Descriptions stay short across all four languages.
  Only Claude/Codex offer the hub method and a named credential home. Other providers have no
  name field or disabled hub choice. PATH discovery replaces unavailable local actions with a
  named CLI installation hint. Single-home sign-in reads local account metadata without querying
  upstream usage, warns about an existing account and requires Continue; the POST independently
  refuses an unconfirmed replacement. Antigravity offers app sign-in guidance
  instead of an unverified standalone login command. OpenCode explains which subscriptions
  supply plan limits. Local sign-in uses a new native terminal tab on the connection server's local PC
  without moving native focus. It uses in-app pane selection and the existing canonical link writer,
  not a page reload, even when another PC was selected. Hub OAuth
  keeps the synchronous popup, bounded waiting, Cancel and redirect-paste form. Closing account setup
  cancels a pending hub sign-in; changing the UI language does not cancel it. The hub connection
  step has a labeled URL and DOM-only password, Connect, then Connected and Done; an account count
  is fetched only when plan limits are enabled. Connection save/edit/remove never requests usage
  while that opt-in is off.
- A configured hub is one compact connection row below Accounts, including with meters off: network
  icon, Hub label, dim URL/status and ghost Edit/Remove actions. Editing reopens the hub step
  with its URL filled and key blank. Remove uses `.confirm-dialog`, with Cancel initially focused
  and the danger action on the right, before deleting the saved management key. An unconfigured hub renders nothing. No dedicated Usage sources
  section, new tokens or decorative motion. References: Paseo's global account picker/provider counts
  and t3code's inline authentication metadata/compact hub row; their pixels are not copied.
  An unreadable hub configuration leaves the hub unconfigured without blocking server startup;
  its fixed diagnostic is logged and returned by the hub status endpoint, never its saved key.
- A shared setting or pin the server refused to save is one alert at the top of whichever page is
  open, never a mark on each row: the sentence in `--status-blocked` with the server's own words
  behind Details, then a dim "Not saved on the server yet; reloading or closing this page can undo
  the change." at the reading size (14 px, 15 px under a finger) and one `.btn` Retry, which wraps
  below the words on a phone. It never claims the change is kept on this device: only the open page
  holds it, and a reload takes the server's values again. While Retry's save is on the way the
  sentence says "Sending the change to the server…" and Retry is disabled, dimmed by its color
  rather than faded so it stays legible; a mouse's press draws the amber edge of a pressed icon
  button, a finger's fills it as a pressed settings row fills. Korean keeps each predicate and short
  phrase on one line.
  The change is sent again every few seconds; after three failures in a row sending pauses until
  Retry, the event stream reopens or a longer wait ends (a minute, doubling up to five), and edits
  made meanwhile go out with the next send. A refused value, while it is still as it was sent, gives
  way where another browser saved the same setting or the pins meanwhile, so a late send never
  overwrites the newer value; a value picked again after the refusal is the newest and goes out over
  what arrived, as any edit does. While the event stream is lost nothing is resent on its own (only
  Retry goes, once); its reopening sends what is unsent, in the same one chain, after the server's
  opening document. A stream the browser gives up on (a proxy's 502) holds back only a refused change,
  until the new stream the app opens brings that document, so a change nobody refused still goes and
  its refusal shows with Retry. The alert clears only when nothing unsent is left. This
  follows the app's actionable-error rule (one sentence and the control that does it, causes folded)
  as drawn in the Codex theme; it differs from AoE's per-field retry store because Ovis shares one
  ordered change set, so Retry resends the current change, never an old request body.

### Terminal host, key bar and drawer
- **Find in terminal** in the header's More menu and Mod+Shift+F opens a find bar above the
  grid. It uses the existing input and icon-button primitives: a query, match ordinal,
  previous/next and close controls, with a dim note that scrolling is shared by all clients.
  A phone places the query above the controls so neither counts nor touch targets are cut.
  Enter searches backward initially, then advances forward; Shift+Enter goes backward.
  Escape closes the bar and returns desktop focus to the terminal without changing its viewport.
  Searches are explicit, literal and supplied by herdr; no browser scrollback is added.
- `TerminalViewportTools` paints accent overlays for native, inclusive cell ranges after checking
  the corresponding text and cell widths in xterm's current attach buffer. The current result has
  a stronger fill and outline. The native response supplies at most 1024 ranges around a result;
  the match count remains exact, and highlighting covers that returned window rather than every
  match in unlimited history. Output, reflow and stale responses invalidate highlight data.
- Automatic refresh uses `jump:false` only after an explicit search response includes both
  `matches` and `scroll`. Older bridges can ignore unknown request fields, so they receive no
  automatic search POST. Their explicit count and previous/next navigation remain unchanged.
  Read-only views also send no automatic search POST and cannot page native history.
- The terminal draws no history scrollbar and reserves no gutter for one: the grid takes the
  mount's full width. Wheel, touch drag, page keys and Find move native history; paging calls
  `pane.scroll`, which moves the shared viewport for every client, including the TUI. Requests
  retain their owning PC/pane, and a failed request displays an error instead of inventing a
  local history position.
- A mirrored or observed grid may be wider than its mount. Its input caret and IME preedit stay
  inside the visible mount, at the terminal cursor when visible and at the nearest visible edge
  otherwise: inserting text must not move a manually panned view. This differs from Zed's
  locally sized terminal because this browser must preserve the remote owner's grid rather than
  resize it to reveal the caret. No terminal pixels or input handling code are copied from Zed.
  Local wheel panning in an oversized mirror survives subsequent output. A tap or a touch movement
  that produces no history step sends no shared scroll request.
- A mirrored grid wider than its mount (a Windows PC's pane, whose size a phone cannot change) is
  drawn folded (`lib/terminalFold.ts`): its rows are drawn again as SGR runs in a pre-wrap block at
  the mount's width, over the grid, which stays at the pane's size for input, the masked prompt, the
  input row and Find; it moves down under the folded rows until its cursor row lies on theirs, so an
  IME preedit shows where its text will. The apps this repo compares against all size their terminal
  to the window, which a mirror cannot; this follows Collie (AltanS/collie, `ansi-output.tsx`), which
  draws herdr's pane read the same way and never resizes the pane. No code is copied. A full-screen
  program's boxes fold with the text, so the pane menu offers Original width (`terminalMirrorWrap`,
  this device's, kept in its own `ovis:mirror-wrap` key so an older tab's save of `ovis:settings` cannot
  erase it), the grid at its size panned sideways as before, and Wrap to screen back. Until the
  user chooses, a narrow screen (a touch screen, or 768px and under) folds and a desktop does not. A
  watching phone folds too. An attached pane's grid folds the same way while this device does not
  size the pty: watching it (a device paired to watch), or under a phone's soft keyboard, where the
  grid stays at another device's size until the keyboard goes (#1045). It is drawn from the xterm
  buffer the attach stream wrote, never from a pane read, and the pane is never resized for it; the
  pane menu then offers the same choice, under the same setting. A cursor the grid shows (an attached
  pane's; a mirror hides it) is drawn in the folded rows in the grid's shape and colours, and the hidden
  grid moves down and sideways onto it, so a preedit stands on the caret even in an earlier part of a
  long folded line. A phone that drives the pty is never
  folded (the program redraws at its width), nor is a split's following half, and a grid its mount
  fits is drawn as it is. Under the keyboard the folded rows pan by finger and wheel up to their
  edges, past which a swipe scrolls the pane as before; a tap on them is no mouse click for the
  program (herdr's attach reports the mouse for every pane, so a program that wants clicks cannot be
  told apart): Original width keeps clicks. Folded
  rows keep the cursor's row in view and pan only up and down; a tap on a web address, a file path or
  an OSC 8 hyperlink's label opens it as the grid's links do, any other tap focuses the terminal, and a wheel past their edges
  scrolls the mirror's history at the chosen speed. Find's boxes are hidden while folded.
- In Safari, a Hangul syllable being typed and a dictation hypothesis wait in the terminal's
  editor as a preedit, and the next key, paste or blur sends the corrected text once. Dictation
  replaces its hypothesis in place (`thi`, `this`, `this is a test`), so sending each one typed
  every draft. A chord typed or tapped with the key bar's held modifier sends that preedit first,
  as text, never as the chord. This follows native macOS terminals (Terminal, iTerm2), where
  provisional input stays marked text and only the inserted result reaches the shell. A pane
  switch drops a pending preedit. A view-only terminal starts no dictation preedit, and one still
  pending when the role comes back is dropped. One composed while the pane was not ready goes to
  the draft when input returns, before its commit key, and waits there for Send or Discard.
- While herdr's viewport is above the bottom and the pane is interactive, a round ArrowDown
  "Jump to bottom" button floats over the grid's bottom-right corner and sends `pane.scroll`
  offset 0, the one-tap way back to the live bottom now that no scrollbar offers End. It uses
  the chat lens' round button form (`--control-h`, `--touch-target` on coarse pointers,
  `--radius-pill`, `--shadow-pop`), keeps focus in the terminal, and is hidden at the bottom, in
  read-only views and while Find owns the viewport. A grown touch input line floats over it.
- Mod+Shift+PageUp/PageDown pages the selected pane only, preserving chat composer focus and
  selection. Chat moves instantly by its viewport minus one prose line;
  Terminal uses native viewport rows minus one. A page still
  advances at least one pixel or one terminal row. Plain PageUp/PageDown always scroll the chat
  transcript. Paging is blocked by modals;
  repeated terminal pages accumulate against the pending offset until herdr acknowledges it.
- Explicit Find cancels unsent page offsets and waits for a native scroll already sent;
  paging is disabled until that search ends, so an older page cannot overwrite its result.
- xterm has `scrollback: 0`; wheel/touch gestures reach herdr's alternate-screen scrollback. The
  mount hides the unused xterm scrollbar.
- An attached touch swipe sends its wheel reports from animation frames, at most 6 per frame and in
  order, with at most 64 waiting: a fast flick that derived up to 24 reports in one frame now spreads
  them over the next few, and a two-screen swipe has drained within 300 ms of the lift. Every step
  the swipe derives (`wheelSteps`, then `finalStep` at the lift) still arrives; only travel beyond
  64 waiting reports is dropped, and the terminal counts it in `data-touch-wheel-dropped`. A new
  touch (a second finger anywhere on the page too), a key typed in the terminal, the key bar or the
  input line, a disconnect, another pane, a role acknowledgement, an attach held or released and
  unmount all drop what is left of the swipe, queued reports and unsent travel alike, and each
  report re-checks its pane, attach, role and input readiness before it goes: nothing of an old swipe reaches the pane after any of them, and a
  reconnect never drains one. Mirrored panes and OMP/OmO questions keep their direct `lineScroll`,
  and desktop wheels are not paced. This differs from Zed's locally resized terminal, which scrolls
  a grid it owns: here the grid is herdr's, shared by every attached client, so a report is input
  to a pane other people may be using. No app interaction precedent is claimed for the pacing.
- The screen a new attach is handed (`pty-data` with `replay: true`: a second tab, a phone, a
  reconnect) is presentation history: xterm draws it byte for byte, and an OSC 52 copy request in
  it is not run again. Output reaches xterm one frame at a time, so the frame being parsed is
  known; a replayed frame that ends inside an OSC that may still become OSC 52 (xterm's own
  `oscStringState()`, added by the xterm patch) keeps the next OSC 52 dispatch suppressed until
  that OSC ends. The edge is fail-closed: when such an OSC is aborted (CAN, SUB) or completes as
  another identifier, a whole live OSC 52 later in that same live frame is not copied either; one
  in the next frame is. An older bridge marks nothing, so its replay still counts as live output.
  A reconnect, a pane switch or a tab letting go of its attach retires the output from before
  it: frames still waiting are dropped unwritten, the one xterm is still parsing copies nothing,
  and an OSC the old output left open is guarded as a replayed one.
  The idea that a new viewer does not act on earlier writes is AoE's (Agent of Empires), whose
  clipboard consumer starts at the current point and never sees the replay; Ovis differs because a
  joining view needs the replay drawn, so only its side effect goes. Every xterm upgrade ports
  `oscStringState` (`scripts/xterm-parser-state.test.ts`) and reruns
  `scripts/replay-clipboard-demo-regression.ts`.
- Terminal banners stack top-right for ended, reconnecting, view-only and held-input states, and
  say only what the person needs now (section 1). Ended reads **Terminal ended**; input held for
  the pane stays until the person sends or discards it (pty-exit also comes with a herdr restart).
  View only is the neutral pill with an eye glyph and the words **View only**: no accent, no
  sentence about the operator's grid. Held input, once the socket is back, is one row on the
  neutral elevated surface with the `--border` hairline: the command in mono (one line, cut with an
  ellipsis, the whole text as its title) and two `.icon-button` controls named **Send held input**
  and **Discard held input**, `--touch-target` square on a coarse pointer; no label and no chip on
  screen (the live region keeps a clipped "Input held:" for its words). What the row has to tell
  only when it applies (text or an Enter left out) sits on a line under it.
  Under the chat lens, while the input card shows, the ones it shares with the composer (another
  app holds the pane, a failed output stream, the held draft, a copy note) stand over the card
  instead (Composer: Notices).
  Banners wrap inside their pane at any width (a phone, or a narrow split on a desktop): text breaks
  between words, and what does not fit beside the text (actions) moves to the next line with button
  labels kept whole; wrapped lines start at the left. The reconnecting banner's held preview
  (`Input held: “…”`) stays on one line in mono, cut with an ellipsis, with the whole text as its
  title: a command is never broken inside a word.
- The touch input line keeps `--space-1` above and below its field and send button (and `--space-2`
  at the sides, as the key bar), so neither sits on the key bar's rule; its row keeps the height it
  had, so the grid and the pty are not resized. Keys draw at `--key-h` (`--keybar-h` less `3 * --space-1`), centered
  in the bar with equal room above and below, and reach `--touch-target` through an invisible
  expander inside the bar; the bar's safe-area padding is added below that.
- The mobile key bar starts with Esc, Tab and `^C`, then sticky Ctrl/Alt/Shift, Enter and arrows;
  it never steals typing focus, and on a touch screen it never takes the focus either: a key tapped
  with the keyboard put away leaves it away (only the keyboard key or a tap on the line or the grid
  raises it). That follows the platform's own rule rather than an app's: a button never raises a
  phone's keyboard, only a text field does. A fine pointer, which raises no keyboard, still moves
  the focus to the grid. Modifiers remain highlighted until toggled off,
  leaving the pane/lens or disconnecting; each exposes `aria-pressed`.
- That is the default row. Settings → Terminal → Key bar can add, remove and reorder every
  terminal key and register exact combinations. Removing a held modifier clears it immediately.
  A deliberately empty row retains only the Input line switch, Paste and the keyboard control on a
  touch screen.
- On a touch screen the row starts with controls that are not keys: the **Input line** switch
  (the keyboard glyph, `aria-pressed` while the input line is on), **Paste** (below) and, after
  them, **Show keyboard** / **Hide keyboard** (#1046), which moves the soft keyboard without changing the input mode. Its glyph
  is the panel at the screen's bottom with the way it goes next (`PanelBottomOpen` to show,
  `PanelBottomClose` to hide), its name says the same, and its `aria-pressed` is the state
  `lib/viewport.ts` measured (`data-keyboard`), never the hope that a focus raised a keyboard: a
  hardware keyboard, or an occlusion the browser cannot report, leaves it at Show. Show focuses the
  field of the current input mode inside the tap, as Mod+Shift+E does on a desktop (the input
  line, else xterm's own field; the bar is not shown while the masked input is); Hide blurs this pane's
  field and nothing else. Neither sends a key, nor the focus report (DECSET 1004's ESC [ I / ESC [ O)
  its own focus move would make, fits or resizes the pane (the grid under a keyboard stays, #1045),
  changes the mode or acts on a sibling pane. A focus the user makes still reports, and so does a
  sibling's field that loses the focus to Show, as it would to a tap into this pane's line. Safari's
  Hangul or dictation preedit, which has no composition events and waits for the next key, is typed
  by Hide's blur, as a key-bar key types it first. While a word is being composed in
  either field, or its commit is still on its way, and while Paste still reads the clipboard (the
  paste's own focus would bring a hidden keyboard back), the control is `aria-disabled` and refuses the
  tap in place: a disabled button would let the tap move the focus and end the composition.
  Unlike the keys, which a hardware keyboard already has, the control is a Tab stop (after the
  input line and its Enter button) that Enter or Space presses, and its name is also its tooltip.
  Without a field it may focus (view only, held, ended, offline) the bar has no control or a
  disabled one, like its keys. The platform's own dismiss key is the model (iPadOS's keyboard key,
  Android's ▽): it lives in the key bar with the mode switch because this app keeps its touch
  controls in the bar and its menus, which is where it differs from AoE's floating button over
  the terminal; only the focus-preserving tap AoE's button relies on is shared, and the key bar
  already had it. Disabled keys (`.key:disabled`, and the refusing control) draw their glyph in
  `--text-dim`, so a bar with nothing to send to reads as such.
- When the row outgrows the viewport it scrolls sideways, and the edge that hides more keys fades
  out: `KeyBar` sets `data-overflow-start` / `data-overflow-end` on `.key-bar` (measured before
  first paint, on scroll and on resize, once a frame) and `KeyBar.css` masks that edge with a
  `--space-6` (24px) `mask-image` gradient, static, so reduced motion changes nothing. Every key
  whose cap is a symbol or abbreviation carries its spoken name as `aria-label` (Esc → Escape,
  `^C` → Control C, ⌫ → Backspace, Ctrl → Control, the arrows and page keys), translated with the
  UI; a cap that is a word (Tab, Enter, Home, End) is its own name.
- The mobile drawer slides over a scrim. Closed visibility removes its controls from the tab order.
- The terminal's input line carries its name in view (`.terminal-input-label`, "Input line", the
  key bar toggle's own words, `--fs-chat` in `--text-dim`) above the draft, whose text is
  `max(--fs-input, --fs-xl)`. It has **Insert** (`.terminal-input-insert`, named "Insert text without
  Enter") left of Send. Each action is one button: its words above (`.terminal-input-caption`,
  `--fs-chat`: "Insert text"; "Send", or "Enter" on an empty line) and its `--touch-target` round
  face below. Send's face is the filled accent; Insert's is outlined on `--bg-elevated` in
  `--text-dim`, which holds 3:1 against the panel where the `--border` hairline does not; its glyph
  is lucide's text-cursor-input, Send keeps its arrow. Off (an empty line, disconnected, a send or
  insert on its way) a face turns to a dashed `--text-dim` outline with dim words, never a fade. A
  composition says "Finish the word, then insert." instead of sending the preedit. The text goes as
  the keyboard would type it, with no Enter after it (`insert`, feature `terminal-insert`), and no
  resize, focus or take-over goes with it. It types one line: herdr reports no paste mode of the
  program (its attach opens with its own ESC[?2004h whatever the program set), so several lines
  are never sent as a guessed bracketed paste; the line says "Insert takes one line. Send several
  lines, or insert them one at a time." and nothing goes. The line clears only on the bridge's
  `insert-result`, and only the text that was sent; a refusal, a drop or an older PC keeps the
  text with the note under the line (`.terminal-input-note`, `--fs-chat`), and a clipboard read
  still waiting says so in the note's dim `.is-pending` form. Korean notes keep each clause whole
  (no-break spaces inside it, keep-all between). On a touch screen the key bar's **Paste**
  (`[data-key="paste"]`, lucide clipboard-paste, "Paste into the input line") stands beside the
  Input line toggle, `--space-1` further from its neighbours than other keys: a tap, never a hold,
  read from that tap alone and dropped when the line, its caret, a composition, the pane, mode,
  role, input lease or connection changed before the clipboard answered, even and back again. With
  the line put away (direct typing) it changes no mode and says "Tap Input line to paste." in the
  bar's own row (`.key-bar-note`, after the bar's fixed controls, in place of the other keys for a
  few seconds, gone on a tap), in the row of the key it names and never over the terminal's output. No widely used coding-agent app (the
  Codex and Claude apps, Paseo, T3 Code) was found to establish a precedent for a phone terminal
  draft with a separate no-Enter insert; agent-of-empires' compose sheet has Insert beside Send but
  clears its draft on a synchronous boolean, which this design rejects: the draft is cleared on the
  bridge's acknowledgement, as Send's is, and nothing typed is queued across a disconnect.

### In-app alert
- While the app is on screen, a pane that needs input, finishes a turn (by the device's Finished
  choice) or ends drops a card from the top edge: a black drop falls from above the safe area,
  spreads into the card, and its text shows. It hangs from `env(safe-area-inset-top)` only, so a
  Dynamic Island, a notch and a desktop window take the same path; no device is guessed.
- In the phone layout (768px and under) the card is one line, 44px high and as wide as its text
  (340px at most): the pane's name, then what happened. A long name is cut short, what happened is
  not, and the dot is left out. Wider than that it is the two-line card, 64px high.
- One at a time; a newer one folds the current one away first. Tap opens the pane; a drag or flick
  up puts it away; it leaves by itself 3.6s after its text shows, and waits while touched.
- Not for the pane already open, and not while the app is hidden (system notifications cover that).
- Reduced motion: it fades in and out where it rests, without falling or spreading.

### Alerts health notice (`.update-notice.is-alerts`)
- This device asked for alerts and the last push to it failed for good: one line in the pane
  column, on the update notice's row (`.update-notice`: `--space-2 --space-4` padding, `--fs-xs`,
  a hairline under it), tinted `--status-blocked-tint` with `--text-strong` text and a `BellOff`
  glyph in `--status-blocked` before the sentence, so the state is not carried by the tint alone.
  One sentence, one `.btn` at the end of the line (under it on a phone): **Turn alerts on again**
  where subscribing anew mends it (the push service retired the subscription, the server does not
  know it, it was made for another server key), reading **Turning alerts on…** and disabled
  while the repair runs; **Alerts**, opening Settings → Alerts, for a refusal, which
  re-subscribing does not mend and Send test answers. The update notice's dismiss button closes
  the line for that fault on this device, across reloads and open browser tabs. Another fault,
  a look where the server answers for a held subscription with no fault, alerts turned off or
  the device locking ends the dismissal; a look that proves nothing keeps it. Settings keeps
  showing the fault even while the line is dismissed.
- A failed **Turn alerts on again** replaces the fault sentence with its reason: the browser
  would not make a push subscription (in Brave, turn on **Use Google services for push
  messaging** in its privacy settings), the page's service worker is not running (reload, then
  try again), or the PC did not take the subscription (try again). The reason and the repair
  stay in Settings through looks with no new health evidence; a notice already showing the
  fault keeps them too. Working alerts, another fault, alerts turned off or a new repair ends
  the old reason.
- What it says is decided once (`lib/pushHealth.ts`) and read by this line and by the Test
  notification row of Settings → Alerts alike, so the two never disagree and no second banner
  competes: Settings' hint carries the same sentence, its **Turn alerts on again** is the same
  repair, and either place's button waits while the other's runs. A fault is a permanent failure
  strictly newer than the last success; a failure an alert has since gone past, no answer,
  throttling and a server error are history, at most one dim line in Settings. A denied
  permission has no notice (the More menu's Alerts item already reads **On in the app**);
  Settings says what to allow. The PC out of reach changes nothing, and nothing is said of a
  subscription nobody has looked at: no probe push is ever sent to find out.
- Design: herdr's own single-notice flow (the update, exposure and PC-action rows) and the
  existing Send test / Turn alerts on again pair, extended rather than a second surface. Neither
  the Codex app nor the Claude app surfaces push-delivery health, so there is no precedent to
  follow there; Agent of Empires' classifier (MIT, THIRD_PARTY_NOTICES.md) is adapted for the
  rule, with its repair narrowed to the faults re-subscribing mends. Dismissal follows the update
  notice's button and the PC-action notice's per-fault lifetime (`lib/machineNotice.ts`).

### Token gate
- A centered password card replaces the entire shell while authentication is required. It has a real
  label, autofocused field, primary Unlock button and linked alert text.
- Success mounts the shell; Lock unsubscribes push, deletes auth and returns to the gate.

### Role (no control surface)
- `interact` types and resizes; `observe` does neither. The server enforces both and the WS protocol
  carries `role` / `role-ack`.
- The app connects as `interact` and exposes no role switch. An observe acknowledgement still gates
  local input, adopts server geometry and displays the view-only banner.

## 6. Motion & Interaction

### Timing

The values are the ones in `src/styles.css`.

| Type | Token | Value | Usage |
|------|-------|-------|-------|
| Micro | `--dur-fast` | `120ms` | Hover, active, toggle and control state |
| Standard | `--dur-base` | `180ms` | Drawer slide; reserved dialog timing token |
| Pulse | `--dur-pulse` | `1600ms` | Working and reconnecting dots (trough opacity 0.35; text never pulses) |
| Spin | `--dur-spin` | `1600ms` | One turn of a stepped spinner (the command palette's busy arc); the step count sets the frame rate |
| Breathe | `--dur-breathe` | `2000ms` | The sidebar's working dot: full for 40% of the cycle, six steps down to opacity 0.5, held, six steps back; every dot shares the document clock's phase, so several runs breathe together. It replaced a spinning arc that read as flicker beside the rows |
| Easing | `--ease-out` | `cubic-bezier(0.2, 0, 0, 1)` | Finite transitions |
| Pulse easing | `--ease-pulse` | `steps(2, jump-none)` | Endless working and reconnecting dots; avoids drawing every display refresh |
| Spring easing | `--ease-spring` | `cubic-bezier(0.32, 0.72, 0, 1)` | Voice recording pill enter (180ms, scale 0.96->1 + opacity, from the mic button) and exit (120ms); a phone's sheet rising and springing back |
| Sheet in | `--dur-sheet` | `360ms` | A phone's sheet rising, and springing back after a short drag |
| Sheet out | `--dur-sheet-out` | `240ms` | A phone's sheet dropping, however it closed |

### Rules
- Only state changes move: hover/press, the drawer, a phone's sheets, settings switches, working and
  reconnecting.
- From `641px` dialogs and their scrims snap open and closed; they have no entrance or exit
  animation. At `<=640px` they are bottom sheets and move as an iPhone's do (Modal, above): what a
  finger drags follows the finger, and the rest rises and drops.
- The voice recording waveform is the one surface allowed to draw every frame: only while
  recording, driven by the live microphone level, transform-only (`scaleY` on 7 bars). The pill is
  a state change, not a dialog, so the snap rule above does not apply to it.
- `prefers-reduced-motion: reduce` removes pulses, drawer/control transitions, sheet rise and drop,
  smooth chat scrolling and settings toggle motion; a drag still follows the finger. State remains legible without animation.
  One exception: the sidebar's RUN dot keeps its stepped breath, opacity only and nothing moving,
  so a running agent does not look frozen.
- Under reduced motion the voice pill swaps its bars for one level bar updated at 4 Hz and drops
  the ring and the morph; the **Recording** label and the timer stay.

## 7. Depth & Surface

### Strategy

**Tonal shift + hairline, with shadow reserved for overlays.** Resting shell surfaces have no shadow.

| Type | Value | Usage |
|------|-------|-------|
| Hairline | `var(--hairline) solid var(--border)` | Shell, fields, controls |
| Strong edge | `var(--border-strong)` | Hover/focus separation |
| Dashed edge | `var(--hairline) dashed var(--border)` | Unknown/empty states |
| Tonal lift | `--bg-elevated` on `--bg-panel` | Selection, chips, tracks |
| Tinted lift | Named tint over an opaque surface | Primary and agent states |
| Drawer shadow | `--shadow-drawer` | Mobile drawer |
| Overlay shadow | `--shadow-pop` | Menus, palette and modal cards |
| Card shadow | `--shadow-card` | The composer's input box — the one resting card in chat mode |

## 8. Accessibility Constraints & Accepted Debt

### Constraints
- WCAG 2.2 AA is the target; do not document numeric contrast without measuring both shipped themes
  and every actual backing surface.
- Global `:focus-visible` uses `--ring`; interactive controls remain keyboard reachable except the
  touch key bar, which intentionally preserves terminal focus and has hardware-key equivalents.
- Icon-only controls carry `aria-label`; toggles expose `aria-pressed` or `role="switch"`; selected
  pane exposes `aria-current`; dialogs expose `role="dialog"` and `aria-modal`.
- Status, loading and composer progress use `role="status"`; failures use `role="alert"`. A status
  line that may hold words the moment it mounts (Connecting…, the connection chip's word, a PC's state
  word, Loading PCs… / workspaces… / agents… / conversation…, the chat's Waiting for the PC…, Opening link…,
  Opening…, Sending your answer…, Waiting for terminal input…) is one persistent container: in the
  document from its owner's first render, clipped while empty (`.visually-hidden`, never
  `display: none`), its words set a frame after mount through `useAnnouncedText`
  (`src/lib/useAnnouncedText.ts`) - a live region that appears together with its content is not
  announced. The container outlives what replaces its words (a PC's state line stays, empty, while
  the PC's notice shows), and the terminal's wait is drawn only for a selected pane. Agent state
  has text plus color. Compact sidebar states add distinct glyphs and keep their text accessible;
  ready and unknown draw nothing there, and unknown uses a dashed badge edge elsewhere.
- Touch targets grow to `--touch-target`; fields stay `--fs-input` where mobile zoom is a risk.
- On a touch screen (`hover: none` and `pointer: coarse`) the app is an app, not a page: its
  chrome (header, sidebar, tab strip, key bar, menus, sheet heads and feet, buttons, tabs, labels)
  is not selectable and opens no link callout, while the transcript, code, files and fields are;
  page pinch zoom remains available on ordinary content, while the terminal's two-finger pinch
  sizes its font; landscape does not inflate text. A pressed button dims to `0.55` at once in place
  of the amber `:active` box; a list row (sidebar, agent, menu, sheet, Settings page) fills instead.
- `prefers-reduced-motion` is honored. Lucide/inline SVG decoration is hidden from assistive tech.
- Global shortcuts default to **Mod+Shift+key**: Mod is Command on Apple platforms and Ctrl
  elsewhere. Settings lists the global bindings and allows changing or disabling them, with
  duplicate assignments blocked and known browser/OS reservations warned about. Record also keeps
  other chords exactly as pressed (such as ⌘+PageUp): chords the browser, OS or text editing keep
  are refused, and a plain Ctrl/Alt chord the terminal uses, or a ⌘ chord the browser commonly
  uses, saves only after Save anyway.
  Reservations vary by browser and installed-app mode; a warning is not a guarantee of delivery.
  Bindings belong to this browser, not the remote PC or pane. Hold-to-dictate remains fixed.
- Text-field selection and IME composition keep their keys. Focus-local list/tab navigation and
  reordering are separate from global bindings; they must not intercept terminal input.
  Global actions target the selected pane, and the original handled chord must never also reach its PTY.
  Paging scrolls herdr history when present; an explicit valid zero-history result instead sends
  one plain PageUp/PageDown through the existing live input lease to the running application.
  Application-owned paging has its own page length; no page input is queued across disconnects.
  The plain chat page keys preserve composer draft, selection and focus, excluding modified
  keys, composition, other editable controls and modal input. They do not capture terminal keys.
- On touch screens app actions stay in buttons and menus. More → Search panes and actions opens
  the command palette, including its plugin actions, in the phone touch UI.
  The key bar sends terminal input only, apart from its fixed controls (the input mode switch,
  Paste and keyboard visibility); it is not an app-action toolbar. Hardware keyboards use the same global
  bindings on phones and desktops.
- `document.title` is `<pane title> · Ovis` while selected, otherwise `Ovis`.

### Windows remote startup

An absent Windows herdr waits for the account's desktop sign-in. The PC's existing status notice
offers **Review startup options**; the existing setup dialog explains the sandbox and possible
desktop-tool limitations before **Start without Windows sign-in** authorizes one start. It adds no
persistent preference, second dialog, or new visual treatment. This follows the visible-state and
explicit-override pattern of [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust),
adapted to choosing a remote startup environment rather than granting workspace trust. No code or
visual assets are copied. Cancel stops pending attempts; existing servers and panes stay running.
Task Scheduler failures use the same notice and dialog with **Windows desktop startup failed**
and the scheduler's error, rather than instructions to sign in. They stop background retries until
the user reviews startup options. The existing VS Code-inspired explicit override remains the only
headless choice; sign-in waits continue reconnecting automatically.

### Accepted debt

| Item | Location | Why accepted | Exit |
|------|----------|--------------|------|
| Terminal content accessibility relies on xterm defaults | `PaneTerminal.tsx` | Screen-reader mode changes terminal DOM and input behavior | Decide with herdr TUI owners |
| Drawer has no focus trap | `.sidebar.is-open` | Closed state leaves the tab order, but open-state trapping is not implemented | Add a shared focus utility |
| Modal focus is initialized, not fully trapped | Dialog components | Escape/scrim/close work; tab containment is not shared | Add the same focus utility |
