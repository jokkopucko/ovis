### Changed
- Signing in on a PC with **Sign in and add this PC** (Settings → Devices and PCs → Account, the
  first-run welcome) now adds that PC to the account in the same step: it lists itself and waits
  for one of your devices to add it, with no second "Add this PC to my account" press. Only a
  button that says it adds the PC does: a plain "Sign in", a provider's own button and the desktop
  app's sign-in add nothing and keep the "Add this PC to my account" button, as does a sign-in
  that was already there. With the relay off, one button, "Turn on the relay and add this PC",
  does both; the relay is never turned on without a press. The PC is listed only under the
  account that just signed in; a listing that gets no answer within a minute, or whose screen is
  closed, is dropped, its pairing window is closed, and the button comes back.
- Stop waiting on the add-this-PC screen now closes the PC's pairing window at once instead of
  letting it run out. The PC has one pairing window, so this also ends a phone pairing in
  progress through "Copy a link without a code".
- A device that only watches a PC is no longer shown the "Add this PC to my account" button, which
  it could not use.
