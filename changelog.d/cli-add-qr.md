### Changed
- `ovis add` (also `login` and `link`) now ends in one QR code: after the sign-in, scan it with a
  device that is signed in to the same Ovis account (or type its code at app.ovis.sh) and the PC
  joins the account, with no Add to press, no digits to compare and nothing to answer in the
  terminal. The code is a key to the PC, so it is drawn only on a terminal (`--print` writes it
  anyway), on the terminal's other screen, which the command leaves when a device paired, when
  the run stops and on Ctrl+C (a terminal without such a screen, or a recording of the session,
  keeps the drawing of a code that no longer works). It is taken back when the run ends, however
  it does short of the process being killed, and comes three codes at most (about 30 minutes).
  The command then says which account the PC joined and which of that account's devices added
  it. A device that got in with the code without being in that account is asked about, and only
  the word keep keeps it: anything else, no answer, Ctrl+C, the terminal closing or an error
  removes it (a line that comes within a second and a half of the question, and the first line
  after the question changed, answer nothing and it is asked again). When the PC ended in another
  account than the one that signed in, every device that came since the code was shown is removed
  without a question, and the command fails. `ovis add --approve` keeps the earlier way: the
  adding device's request is approved in the terminal by typing its six digits.
