### Fixed
- On a Windows PC running matching herdr 0.9.3 or 0.9.5 CLI and server versions with protocol 22,
  the terminal can fit the browser instead of clipping the console at its original width. Watching
  does not resize it, and taking control from another viewer still requires an explicit takeover.
  Windows installations without a verified control stream keep their fixed mirror.
