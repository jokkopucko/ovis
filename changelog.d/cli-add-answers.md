### Changed
- `ovis add` (also `login` and `link`) and `pair --approve` no longer ask y/N about a device that
  wants in. The question shows the device's six digits and asks for them: typing all six (with or
  without the space) or the last three approves that request, and Enter by itself declines it.
  An answer so names the request it is for: a line begun for another request, or typed ahead,
  approves nothing.

### Fixed
- `ovis add` (also `login` and `link`) no longer takes a line typed ahead as the answer to a device
  that asks to join: only a line typed after a request's question and its six digits showed answers
  it. A line typed during the sign-in, while nothing was asked, twice at one question, or within a
  second and a half of a question showing (a key pressed twice) is dropped with a line saying so.
  So is the first line that comes after a request left the screen unanswered, whenever it comes:
  the terminal may still hold what was typed for that request, and the question is asked again.
- `ovis add` run without a terminal (`yes | ovis add`, a pipe, a file, `ssh` without `-t`) approves
  nothing, whenever its lines come: it says so, names the way out and declines every request. It
  also says so when the terminal's input ends (Ctrl+D), and stops at once when reading the
  terminal fails.
- `ovis add` opens its last approval window and lists the PC anew in time when the PC's server
  answers slowly near the end of the run, and puts the PC back in the account's list while the
  account's other devices are still being brought in.
