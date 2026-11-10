### Fixed
- app.ovis.sh opens a PC as soon as it is paired, instead of stopping at a Ready screen with an
  Open PC button; that screen now appears only when adding the PC to your account failed, where
  it offers Try again. While you are signed in, the PC opens once this device has joined it
  under your account (a moment later, or after 15 seconds when the PC is slow to answer), so
  that step no longer disconnects a terminal you just opened. A PC paired with a QR or a code
  no longer says "Adding it to your account…" for a minute.
- When you are signed in and open a pairing link for a PC your account does not list, the
  question now reads "Add {name} to your account?", says that every device of your account will
  be able to open it, and shows the PC's ID.
- A pairing link's question is asked again when what it said stopped being true before you
  pressed its button (you signed in or out in another tab, signed in as another account, or the
  PC left your account), so a pairing never does more to your account than the screen said.
  The question waits for your sign-in and your account's list of PCs instead of guessing, for at
  most 8 seconds when either does not answer, and says "Checking your account…" meanwhile. Not
  now stops a pairing whose button was already pressed.
- A pairing whose question said this device gets a key of its own no longer adds the PC to an
  account you signed in to meanwhile when the page reloads for a newer version before the PC
  opens. Opening the PC later while signed in adds it to your account, as before.
