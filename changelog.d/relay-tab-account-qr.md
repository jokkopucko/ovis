### Added
- Settings → Devices and PCs → Add a connection → Ovis relay now has "Add with a QR code" on a PC
  that is in no account, whether or not the page is signed in: press Show the QR code and scan it
  with a device that is signed in to your Ovis account, and the PC joins that account with no
  number to type and no approval on the PC. The code is made only on that press, is shown as a QR
  code alone with no code to type, and is ended when the dialog closes, another tab opens, the
  page is reloaded or closed, the page was hidden for a minute, or after 30 minutes. The dialog
  then says which account the PC joined, whether it is the one this browser is signed in to, and
  which device of that account added it, with "Not me: revoke every device", which comes first
  unless the account is this browser's own; any other device that paired meanwhile is named and
  asked about, with "Not me: remove it" first, and the notice cannot be closed while one is
  unanswered. A notice that was not answered comes back the next time Devices and PCs is opened.
- A PC that is already in an account shows no QR code there and makes no code for one: the tab
  says which account the PC is in and to sign in to that account on the device and open the PC
  there (a device the PC does not know yet is approved once, by picking its number on a device
  that is already a member of the PC). A QR code that is up when the PC joins an account is taken
  back and leaves the screen.
