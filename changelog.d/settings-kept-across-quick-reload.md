### Fixed
- A shared setting turned back while its save was on its way (a switch flipped on and off quickly)
  no longer snaps back to the value it just left.
- A setting changed just before a reload is kept even when the browser drops the save sent on the
  way out: the reloaded tab sends it again, unless another browser saved that setting since.
