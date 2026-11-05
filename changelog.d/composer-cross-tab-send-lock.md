### Fixed
- Two tabs of one browser pressing Send on the same pane at the same moment no longer send the
  message twice on HTTPS and localhost, where the browser offers a cross-tab lock. On plain HTTP
  the send's lease alone guards it, as before, so a press at the very same moment can still send
  twice there. A tab whose draft another tab already sent no longer sends it again.
