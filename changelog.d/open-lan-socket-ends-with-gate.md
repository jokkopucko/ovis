### Fixed
- A connection that another machine on the LAN opened while nothing was paired no longer stays able
  to type into panes and read them once the first device is paired or the relay is turned on. It is
  closed when the pairing gate closes, as that machine's new requests already were refused.
