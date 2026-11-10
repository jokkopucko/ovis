### Fixed
- A PC added over SSH with "Use Default session" starts herdr's default session by itself after that
  PC restarts also when another herdr session is already running there. Before, it stopped and asked
  which session to use.
- A PC saved in herdr (`herdr machine`) for which "Use Default session" was chosen keeps that choice:
  the next refresh of herdr's saved machines, or a restart of this app, no longer ties it to the
  default session's socket again, which stopped it at "the herdr session chosen for this PC is no
  longer running" after that PC restarted.
- Adding a PC over SSH that runs its own Ovis on herdr-core asks which to use in two more cases, both
  on a PC where this app's bridge runtime is not installed yet: when that Ovis is an older one that
  does not list herdr sessions and the dialog names no session (herdr's default session there is
  offered beside it), and when herdr's socket there is only what a stopped herdr left. Before, the
  PC was set up as a herdr PC without asking, and in the second case a new herdr was started beside
  its Ovis.
