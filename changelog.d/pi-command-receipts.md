### Fixed
- Ovis Chat no longer keeps a Pi send "waiting for transcript" when Pi runs it itself: a builtin
  such as `/model` or `/compact`, a prompt template or a `!command`. Pi never records these as the
  text sent, so they get no transcript receipt, and the messages sent after them are confirmed again.
  A `/name` Pi takes as a message, such as an unknown one or `/new please`, keeps its receipt.
- A `/skill:name` sent from Ovis Chat to Pi is confirmed by the record Pi writes for it (the whole
  SKILL.md before the request). Its receipt waited for good before, and so did every message sent
  to the pane after it.
