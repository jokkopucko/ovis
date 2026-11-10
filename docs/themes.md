# Theme files

[← User guide](guide.md)

Besides its built-in themes, Ovis draws a theme you import from a file: **Settings > Appearance >
Theme file > Import**. A theme file holds colors and nothing else. No code or CSS is read from
it, so a file from someone else can change how the app looks and nothing more.

An imported theme appears as a card before the built-in ones, and is chosen for the side it has
(dark, light or both). It is kept on the PC with the other shared settings, so the other browsers
and phones of that PC get it too. Up to 12 themes are kept; the trash button beside a name removes
one.

**Importing a file again replaces the theme of that name.** Change a color, import the file once
more, and the new colors take the place of the old ones, on whichever side drew them. Only a theme
with the same name and the same sides is replaced: a dark file and a light file of one name are
kept as two themes, told apart by the side written beside each. Names that look the same are the
same name: characters that draw nothing are not kept.

## The colors

A theme is the sixteen colors of a [Base16](https://github.com/chriskempson/base16) scheme,
`base00` to `base0F`, each written `#rrggbb` (the `#` may be left out):

| Color | What Ovis draws with it |
|---|---|
| `base00` | The background: the page, the sidebar and panels, the terminal |
| `base01` | Raised surfaces: cards, menus, input fields, your own chat bubble |
| `base02` | Hovered and selected rows, borders, the terminal's selection |
| `base03` | Strong borders, the idle status dot |
| `base04` | Dim text: secondary lines, line numbers |
| `base05` | Text, the terminal's text and cursor |
| `base06`, `base07`, `base0F` | Read and kept, not drawn yet |
| `base08` | Red: an agent waiting for you, errors; the terminal's red on a light theme |
| `base09` | Orange: numbers in code |
| `base0A` | Yellow: notices, types in code |
| `base0B` | Green: an agent that is done, strings in code |
| `base0C` | Cyan: annotations in code |
| `base0D` | Blue: the accent (selection, focus, the Send button), a working agent, functions in code |
| `base0E` | Purple: keywords in code |

Every other color the app uses (hover steps, tints, shadows, a light theme's terminal colors) is
derived from these.

**Colors are adjusted until they can be read.** Ovis holds an imported theme to the same contrast
floors as its own themes: 4.5:1 for text and code on the surfaces they sit on, 3:1 for status
colors. A color under its floor keeps its hue and is made lighter or darker by the smallest step
that clears the floor. The text takes such a step to stay readable on the theme's own surfaces; a
surface it could only be read on by moving far moves toward the background instead. A hovered or
selected row always stays a visible step off the background, also where a file gives it the
background's own color. A theme whose colors already read is drawn exactly as written.

**Only `base00` and `base05` are required.** A surface or grey that is left out is a step between
the background and the text, and a hue that is left out is the text color, so a file with two
colors is a plain two-tone theme. Keys the app does not know are ignored. A color that is there
but is not written `#rrggbb` refuses the file, and the message names it.

**Dark or light is told by the colors the file writes.** Light text on a darker background is a
dark theme, whatever the file calls it: a block filed under the wrong side goes to its own, two
blocks filed under each other's side change places, and a scheme's `variant` line is not read. No
block is left out: two dark blocks both stay where the file put them, and the light side then
draws a dark one. A faint block whose text has to be moved across its background to be read stays
on the side it was written for.

The status glyphs of the sidebar and the tabs keep herdr's own colors, made lighter or darker only
where the theme's surfaces need it.

On a dark theme the terminal keeps xterm's own sixteen ANSI colors, as with the built-in dark
themes; on a light theme they come from the theme's hues.

## A file with a dark and a light side

One JSON file with a `name` and a `dark` block, a `light` block or both:

```json
{
  "name": "Lamplight",
  "dark": {
    "base00": "#181613", "base01": "#211e1a", "base02": "#2a2621", "base03": "#3e3830",
    "base04": "#9b9183", "base05": "#d8d0c3", "base06": "#f2ebdf", "base07": "#fff8ec",
    "base08": "#ff7b70", "base09": "#f0a830", "base0A": "#e8c55c", "base0B": "#93c36b",
    "base0C": "#6cc5b0", "base0D": "#6cb8d6", "base0E": "#c39bd3", "base0F": "#b07a4a"
  },
  "light": {
    "base00": "#faf8f3", "base01": "#f2eee6", "base02": "#e6dfd2", "base03": "#b5ab9b",
    "base04": "#685e52", "base05": "#2a251f", "base06": "#16120d", "base07": "#000000",
    "base08": "#a82323", "base09": "#8c5000", "base0A": "#7a5a00", "base0B": "#2f6317",
    "base0C": "#0f6b6f", "base0D": "#155a72", "base0E": "#8a3f7a", "base0F": "#6b4a2a"
  }
}
```

A theme with one side can still be picked for the other: it is drawn as it is, the way a built-in
dark theme picked for light mode stays dark. A side that is in the file has to have its `base00`
and `base05`, or the file is refused.

## A Base16 scheme as published

A scheme file from a Base16 collection is read as it is, in YAML or JSON, so the schemes that
already exist can be imported without converting them:

```yaml
system: "base16"
name: "Lamplight"
variant: "dark"
palette:
  base00: "#181613"
  base01: "#211e1a"
  # ... base02 to base0F
```

The older flat form (`scheme: "Name"` with `base00: "181613"` lines beside it) is read too. A
scheme is one side: a background darker than the text is a dark theme. A file with a dark and a
light side is the JSON above; YAML that holds two sides (a `dark:` or `light:` block, or a color
named twice) is refused rather than read as one.

## Limits

- A file is at most 64 KB, and a name at most 40 characters.
- A JSON file has to be plain JSON: a trailing comma, a comment or an unquoted key refuses it, and
  the message says so.
- The imported themes and the choice for each side are one shared setting, and the last save wins.
  When two devices change it before they have heard from each other (one imports a theme while
  the other, offline, imports one or switches a side back to a built-in theme), the later save
  stands and the other device's import is gone from every device. Import it again.
- A theme changes colors only. Fonts, sizes, spacing and layout stay in Settings.
- The theme is drawn from the first frame on a device that has opened it once; a device that
  receives it from the PC opens in the built-in theme for a moment the first time.
