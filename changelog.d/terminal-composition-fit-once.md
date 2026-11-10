### Fixed
- Korean, and other text typed through an input method, keeps up with fast typing in the terminal
  again: the box that shows the syllable being composed measures its glyph once per glyph and font
  instead of on every change, which made the browser recalculate the whole page's style several
  times per key.
