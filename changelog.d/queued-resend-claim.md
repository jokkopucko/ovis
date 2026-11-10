### Fixed
- A held message is typed once when herdr moves its pane while one tab's **Send now** is on its
  way: the other tab's copy under the pane's new ID is refused until that send ends, and then
  reads as sent.
- A held message that a **Send now** may have typed stays "not confirmed" in another tab for its
  whole ten minutes, also after its first connection's record is gone.
- A pane that takes the ID of one that ended is no longer offered the ended pane's held message
  with **Send now**.
- A held message's **Send now** in another tab ends with the PC's receipt also when this device's
  clock is set back.
