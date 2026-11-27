### Fixed
- A chat message to an idle Codex that Ovis started on herdr-core now goes to that Codex's own server as a new turn
  instead of being typed into its terminal. Text typed in Codex's input box stays there and no longer blocks the
  message. Shell commands, slash commands, mentions, `$skills` and pasted pictures are still typed, and so is
  everything when the server cannot take it.
