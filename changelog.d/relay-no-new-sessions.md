### Added
- The relay can refuse new device sessions to a PC whose relay pass allows none (account limits, such as
  a relay data limit): while passes are enforced, a client the PC identifies as a device new to it closes
  `4403`. The PC's own devices, reconnecting or not, and the sessions already open stay.
