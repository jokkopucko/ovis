### Changed
- On herdr-core, the browser terminal's own answers to a program's queries (a cursor position, a
  mode report) reach hc as automatic input once hc says it takes it, so they no longer count as
  that viewer typing and taking the terminal's size. Until then, and on herdr's TUI, they are
  typed as before: hc 0.1.14 to 0.1.17 do not name the feature, and drop the frame unasked.
