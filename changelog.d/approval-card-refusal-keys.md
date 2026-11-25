### Fixed
- Refusing a GitHub Copilot CLI or Letta Code approval from its card now refuses it: the card presses
  Esc for their "No, and tell … what to do differently" row, which neither takes as a typed number.
- A Grok Build approval card can be refused: it offers Grok's own "No, reject" row instead of Esc,
  which in Grok moves to the scrollback and leaves the approval waiting.
