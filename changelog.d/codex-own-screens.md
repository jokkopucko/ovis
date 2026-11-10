### Fixed
- A chat message is no longer typed into one of Codex's own screens: the `/model`, `/permissions`,
  `/review`, `/theme`, `/resume` and `/experimental` lists, `/rename`'s field, the `/statusline`
  and `/keymap` editors, the agents view, the `/diff` pager, Find and the search through earlier
  prompts. herdr reports Codex at rest while one is open, so the message was pasted into it and its
  Enter took the row under the cursor: it could change the permission mode, trust a folder, or
  save a model for every new session. The message now stays in the box until the screen is closed
  in the terminal, and a queued one is held with that reason until you send it.
  ([#3103](https://github.com/devswha/ovis/pull/3103), reported by @nocstah)
- Codex at Ultra reasoning effort marks its composer `»`: a new pane's chat now opens empty instead
  of "Conversation unavailable", its first answer shows, and the notice that a command's screen is
  still open in the terminal works there. ([#3103](https://github.com/devswha/ovis/pull/3103),
  reported by @nocstah)
