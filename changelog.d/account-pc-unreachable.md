### Fixed
- Through a PC's page, the account's other PCs, and a PC added to this app that keeps not answering
  through the relay, no longer read **Switched off**: nothing answering in time does not say a PC is
  off (it may be on another relay, or busy). They read **Can't reach the PC: it may be off**, and a PC
  whose answer was kept away otherwise (the relay unreachable from that PC, a PC that began and did
  not finish) reads **Can't reach the PC**. The check waits 15 seconds for an answer, as a device
  does, instead of 10.
