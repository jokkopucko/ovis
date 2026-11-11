### Fixed
- Going to the end of a long chat (dragging the scrollbar there, or End) no longer jumps back now and
  then to where you were reading. It happened when a row was still being measured in that moment,
  such as a long output you had just unfolded drawing its lines: the chat's list moved the view back
  to where it had last seen it.
