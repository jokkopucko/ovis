### Changed
- An HTML file opened in the file viewer is drawn without its scripts until you press **Run
  scripts** above it; its HTML and CSS still show. A page's script could reach other hosts over
  WebRTC and take the keyboard from the app, so it now runs only when you ask. Beside the pane, a
  page whose script takes the keyboard anyway has its scripts turned off again.
