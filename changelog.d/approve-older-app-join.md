### Fixed
- `ovis approve` (and `ovis add`'s wait for a first device) on a PC pinned to its account's signed
  list no longer says "is let in" for a join from an Ovis older than 0.5.10, which that PC cannot
  let in: it approves nothing and says to update Ovis on that device, then ask to join again. The
  PC's own window says the same, with no Allow or number field for that join, and so does a
  member's approval card on another device, where Approve approves nothing for it either.
