/**
 * Windows has no unix socket file to hand the client, so there the adapter listens on a named pipe,
 * as herdr's own server and hc's core do (live-verified in the Windows VM: Bun.listen and Bun.connect
 * take `\\.\pipe\…`, a second listener on the same name is refused with EADDRINUSE, and a pipe whose
 * server ended answers ENOENT). Windows paths ignore case.
 */
import { createHash } from "node:crypto";
import { join, posix, win32 } from "node:path";

const PIPE_PREFIX = "\\\\.\\pipe\\";

export function isCoreAdapterSocket(path: string): boolean {
  return posix.basename(path) === "herdr-core.sock";
}

export function adapterAddress(stateDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return join(stateDir, "herdr-core.sock");
  const digest = createHash("sha256").update(win32.resolve(stateDir).toLowerCase()).digest("hex").slice(0, 32);
  return `${PIPE_PREFIX}ovis-herdr-core-${digest}`;
}

/** a Windows named pipe's address, which has no file behind it to read or stat for identity */
export function isNamedPipe(path: string): boolean {
  return path.startsWith(PIPE_PREFIX);
}

const STARTED = crypto.randomUUID();

export function pipeIdentity(path: string): string {
  return `${path}#${STARTED}`;
}
