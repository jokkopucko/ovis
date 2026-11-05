### Fixed
- The full output of an OmO tool call is looked up in the latest 16 MiB of the transcript instead
  of reading the whole file, and stops at a context clear; an older call's output can be
  unavailable.
