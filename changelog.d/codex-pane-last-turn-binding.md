### Fixed
- A Codex pane herdr reports no thread for no longer stays on "Conversation unavailable" in three
  cases: its last answer is longer than the screen or holds a code block, its last answer is a
  short word such as "ok", or a second Codex has just started in its folder and was asked nothing
  yet. Chat shows the conversation while that finished turn is on screen, and the terminal again
  while the pane works on its next turn. It still shows the terminal whenever the screen could be
  another conversation's: a prompt or a tool's output that quotes one, two conversations that
  ended on the same text or were asked the same prompt, or, for a long answer, another Codex
  conversation with a turn under way. The first two cases need the list of conversations Codex
  has loaded, which cannot be read on Windows: there they stay on the terminal.
  ([#3558](https://github.com/devswha/ovis/pull/3558),
  [#3559](https://github.com/devswha/ovis/pull/3559),
  [#3560](https://github.com/devswha/ovis/pull/3560) by @vibewriter-hand)
