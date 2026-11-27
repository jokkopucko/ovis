### Fixed
- The address follows a pane that takes over while Settings is open, also after a menu or a drawer
  was closed on that page.
- Phone: Back pressed right after a sheet closes goes to the page before it, also when the browser
  told the app nothing of the sheet's own step back: the address no longer changes alone while the
  screen stays, and an address change made as the sheet closed is no longer left unwritten.
- File previews opened after a sheet refuses Back use the selected pane's address also in browsers
  that tell the app nothing of their history entries (Safari and Firefox without the Navigation API).
