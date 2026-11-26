### Fixed
- Relay and direct LAN uploads larger than 3 MiB (such as phone camera photos over ~2.3 MB whose
  JSON request body arrives as one chunk) no longer fail with `resource_exhausted` / "Relay request
  failed": `HttpStream.sendBody` now slices each chunk to one `HTTP_DATA` frame at a time (#4476).
