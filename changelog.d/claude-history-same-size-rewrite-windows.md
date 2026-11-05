### Fixed
- On Windows, a Claude background command whose finish was rewritten in place in the transcript
  no longer keeps the old result: two writes a millisecond apart could leave the file looking
  unchanged.
