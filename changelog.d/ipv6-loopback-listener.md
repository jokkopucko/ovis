### Added
- `OVIS_IPV6_LOOPBACK=1` adds an IPv6 loopback listener on `::1` beside `HOST=127.0.0.1`, so
  localhost can reach the same HTTP and WebSocket services over either address without redirecting
  origins. Other binds ignore it.
