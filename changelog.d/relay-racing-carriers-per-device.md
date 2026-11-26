### Fixed
- A device already holding its four sessions on a PC can always replace them, even while another
  device keeps unused racing connections open on that PC.
- The phone apps no longer fail a direct connection to a PC because a socket from an earlier
  attempt was still closing: the next one waits for its place instead of being refused.
