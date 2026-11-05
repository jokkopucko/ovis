### Changed
- A pane with no agent shows its terminal output as one preserved snapshot with one copy control,
  instead of splitting it into guessed chat messages with their own copy buttons. A command sent
  from there keeps its state, names the command when the snapshot does not show it, and repeats
  a recorded result only when the snapshot lacks it. Long lines wrap on narrow screens.
