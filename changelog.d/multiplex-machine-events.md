### Fixed
- Multiple browser tabs no longer occupy the HTTP/1.1 connection pool with separate machine event
  streams when the server supports machine notifications on the existing terminal WebSocket.
  Older servers retain SSE, with a server-side transport rollback switch.
