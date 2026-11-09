### Fixed
- An agy or grok pane whose turn ended on a background task (a deploy, a CI watch, a test run) or
  an agy `schedule` timer reads BG, not DONE, and alerts its finish once the turn that task's end
  starts is over; a timer due within a day is held until it is due,
  while its agy process lasts.
