### Added
- Settings → Appearance → Theme file imports a theme from a file of colors: a Base16 scheme as its
  projects publish it (YAML or JSON), or one JSON file with a dark and a light side. Only colors
  are read from a file, never code or CSS. Ovis derives every color it draws from the sixteen and
  holds them to the contrast floors of its own themes, so text stays readable and a selected row
  stays visible whatever the file says. An imported theme is a card beside the built-in ones, is
  shared with the other devices of the PC, and is drawn from the first frame. Importing a file
  again replaces the held theme of the same name and sides, so an edited file does not pile up
  copies. Dark or light is told by the colors the file writes, not by what it calls them, and a
  JSON file that does not parse is said to be invalid JSON. [docs/themes.md](docs/themes.md)
  describes the file.
