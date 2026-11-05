### Fixed
- A remote PC whose session snapshot is larger than 1 MiB opens in the browser instead of closing as
  stalled, and a second large frame (a large mirrored screen) sent while that snapshot is still on
  its way no longer closes the connection.
- On a slow link, a pane opened while a large session snapshot is still arriving is no longer closed
  as stalled, and a client that stops reading a large frame is now closed instead of holding it.
