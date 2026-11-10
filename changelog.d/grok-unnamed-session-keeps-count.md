### Fixed
- A grok pane keeps its background-task count, and the hold of a turn that ended on a task, when
  herdr names no session for it for a moment: the pane was looked up as another session, not
  found, and read as holding nothing for about ten seconds.
- A grok session herdr has just named is looked up at once: it waited up to ten seconds when a
  lookup of the pane's session before it, or of the pane before herdr named any session, had failed.
