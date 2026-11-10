### Fixed
- Back and Forward go to the pane of the entry they land on when the app was about to draw a change
  at that moment (a pane's status arriving, the New workspace dialog writing its fields to the
  address). Before, the press could do nothing, and the entry it landed on was overwritten with the
  place just left. Forward off a file that a tab switch had left under it (Reopen files on return)
  and a jump back from Settings past the pane it opened over (the browser's Back menu) failed that
  way every time.
