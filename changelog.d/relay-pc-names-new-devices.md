### Added
- A PC whose relay pass allows no new device sessions (account limits) now tells the relay of a new
  device that pairs with it, so the relay closes that device `4403` while passes are enforced: no
  device is made, the pairing code is not spent, and no failed pairing is counted. Devices the PC
  already knows sign in as before, one of them that pairs again with the key it saved is not
  refused, and a client that has not paired learns nothing of the limit. The relay's `sync` now
  also says its pass mode (`relay_pass.mode`), and `GET /api/relay` says whether the relay enforces
  passes now (`pass.enforced`).
- The PC shows "This account has reached its relay data limit for new connections" whenever it
  refuses new devices, also on a relay that enforces passes without naming a date.

### Fixed
- A relay pass that follows another within a minute now reaches the relay: the PC sends it once the
  relay takes renewals again, instead of at once, when the relay dropped it and kept the older pass
  for half a day. A pass that arrived while the PC was still connecting is sent as soon as it has.
