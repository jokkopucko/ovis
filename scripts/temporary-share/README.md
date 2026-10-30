# Temporary workspace instance

This gateway gives one isolated Ovis instance a UUID entry URL. Opening that URL sets an HttpOnly admission cookie. Ovis's existing root-relative assets, API calls, and WebSockets then use the same gateway. This is an entry URL, not a general path-prefix implementation. Use one isolated instance per gateway listener.

The gateway rejects anonymous API calls, checks the public Host and browser Origin, replaces client authorization with the instance's backend credential, and strips client forwarding headers. Expiry rejects both the entry URL and existing cookies. It also closes active connections. A public listener requires TLS. A listener without TLS can bind only to loopback for staging or use behind a trusted TLS endpoint.

Run Ovis and herdr in a dedicated non-root container. Mount only the project, its own home/state directory, the application runtime, and a Unix socket directory. Do not mount the owner's home, SSH keys, normal Ovis state, normal herdr socket, or Docker socket. The gateway connects to that Unix socket; the container needs no exposed TCP port. The container entry point creates or names its sole workspace `music-classifier`.

The initial deployment uses `--network none`, `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`, memory/CPU/PID limits, and a separate persistent home. It supports terminal control and project edits. It cannot download dependencies or use hosted model APIs. Providing those capabilities requires a separate, explicit egress and credential design.

Keep the gateway configuration outside the repository with mode `0600`. It contains `id`, `cookieSecret`, `backendToken`, `socketPath`, `publicOrigin`, `expiresAt`, `hostname`, and `port`. A direct HTTPS listener also needs `tls.key` and `tls.cert`, which name certificate files. The UUID and cookie are capabilities: do not publish the real configuration in source or logs.

Run `bun scripts/temporary-share/gateway.ts /path/to/share.json`. `container-entry.ts` expects a runtime under `/opt/ovis`, a Bun executable and herdr under `/usr/local/bin`, a project at `/workspace`, an isolated home, and a writable `/run/ovis-share` directory. It creates `/run/ovis-share/ovis.sock` for the gateway.

The gateway's deadline is independent of browser cookie retention. Also install a persistent host timer to stop the project container and gateway at the deadline. Retain the project files after expiry. This prevents a restart from restoring expired access and stops guest processes that would otherwise outlive their browser connection.

Verification: `bun test scripts/temporary-share/gateway.test.ts`. The deployment must also exercise an actual control command through Ovis, verify the resulting file only in the project, check the container's mounts and network mode, and test the external HTTPS route before giving out a link.
