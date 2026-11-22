import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BRIDGE_PROTOCOL, REMOTE_BUNDLE_VERSION, type BridgeIdentity } from "../shared/machines.ts";
import { HerdrError, herdrSocketPath, ping } from "./herdr/client.ts";
import { OwnerGuardUnavailable, withOwnerGuard } from "./owner-guard.ts";
import { newOwnerRecord, ownerGone, probeProcess, type ProcessBirth } from "./process-owner.ts";
import type { Socket } from "bun";
import { MAX_IMAGE_BODY_BYTES } from "./paste.ts";
import { attachableIdentity, sidecarAvailable } from "./pty/sidecar.ts";

/**
 * `generation` and `birth` identify the registering process beyond its PID; older bridges wrote neither.
 * `port` is on 127.0.0.1, the only address the app's SSH tunnel goes to (`loopbackRelay`).
 */
export interface BridgeDescriptor { managed_remote?: boolean; port: number; token: string; pid: number; generation?: string; birth?: ProcessBirth; socket_path: string; bridge_protocol: number; bundle_version: string }
/**
 * The bridges' folder. On Windows, Ovis's state migration leaves a junction at the legacy folder (to
 * `.config\\ovis`), and a process an SSH session started may not traverse it ("untrusted mount point"):
 * the junction's target is used, read without going through it (#3633).
 */
export function bridgeRegistry(): string {
  const legacy = join(homedir(), ".config", "herdr-web-ui");
  if (process.platform !== "win32") return join(legacy, "bridges");
  let junction = false;
  try { junction = lstatSync(legacy).isSymbolicLink(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return join(junction ? resolve(dirname(legacy), readlinkSync(legacy)) : legacy, "bridges");
}
export function socketPath(): string {
  const path = resolve(herdrSocketPath());
  try { return realpathSync(path); } catch { return path; }
}
export function descriptorPath(socket = socketPath()): string { return join(bridgeRegistry(), createHash("sha256").update(socket).digest("hex") + ".json"); }
export async function bridgeIdentity(sidecar = sidecarAvailable()): Promise<BridgeIdentity> {
  const socket = socketPath();
  let stat;
  try { stat = statSync(socket); } catch (error) {
    // A herdr that is not running leaves no socket (on Windows, no marker). Said by code and
    // without the path: the server that asked shows this to whoever is adding the PC.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new HerdrError("socket_missing", "herdr's socket is missing; herdr is not running for this session");
    throw error;
  }
  const info = attachableIdentity(await ping(), sidecar);
  return { pid: process.pid, managed_remote: process.env["OVIS_REMOTE"] === "1", bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION, socket_path: socket, socket_id: `${stat.dev}:${stat.ino}`, herdr: info };
}
/**
 * Whether the bridge a descriptor names still runs: a PID now held by a process of another birth
 * does not count. Outside Windows neither does a PID this user may not signal (EPERM), whatever
 * birth was recorded: every bridge in this user's registry runs as this user, so that is someone
 * else's process. The app's own check (`kill -0`, remote-host.ts) takes it for gone too and starts
 * a bridge, which must not then find the old one live. On Windows a logon session of this same user
 * may refuse the probe, so there only the birth decides.
 */
export function descriptorLive(descriptor: Pick<BridgeDescriptor, "pid" | "birth">): boolean {
  if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0) return false;
  if (process.platform !== "win32" && probeProcess(descriptor.pid) === "denied") return false;
  return !ownerGone(descriptor);
}

function readDescriptor(path: string): { id: string; text: string } | null {
  try {
    const stat = statSync(path);
    return { id: `${stat.dev}:${stat.ino}:${stat.mtimeMs}`, text: readFileSync(path, "utf8") };
  } catch { return null; }
}
function liveIn(reading: { text: string } | null): boolean {
  if (!reading) return false;
  try { return descriptorLive(JSON.parse(reading.text) as BridgeDescriptor); } catch { return false; }
}

/**
 * `registered` says whether this server's descriptor was written: it is not while another live
 * bridge holds the descriptor, when the descriptor changed while this one started, or when its
 * guard cannot be taken.
 */
export function registerBridge(port: number, token = randomBytes(32).toString("hex"), options: { path?: string; sampled?(): void } = {}): { token: string; registered: boolean; close(): void } {
  const path = options.path ?? descriptorPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const unregistered = { token, registered: false, close() {} };
  // Registration never overwrites a live bridge. Its credential remains reusable.
  const seen = readDescriptor(path);
  if (liveIn(seen)) return unregistered;
  options.sampled?.();
  const record = newOwnerRecord();
  try {
    const registered = withOwnerGuard(path, () => {
      const now = readDescriptor(path);
      if (now?.id !== seen?.id || now?.text !== seen?.text || liveIn(now)) return false;
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ managed_remote: process.env["OVIS_REMOTE"] === "1", port, token, pid: process.pid, generation: record.generation, ...(record.birth ? { birth: record.birth } : {}), socket_path: socketPath(), bridge_protocol: BRIDGE_PROTOCOL, bundle_version: REMOTE_BUNDLE_VERSION } satisfies BridgeDescriptor), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
      return true;
    });
    if (!registered) return unregistered;
  } catch (error) {
    // a guard that could not be released (OwnerGuardReleaseFailed) fails the start: this process
    // must not keep serving on a guard it may still hold
    if (!(error instanceof OwnerGuardUnavailable)) throw error;
    // fails closed: this server runs unregistered and the descriptor is left as it was
    console.error(`This bridge was not registered (descriptor ${path}): ${error.message}`);
    return unregistered;
  }
  return {
    token,
    registered: true,
    close() {
      try {
        withOwnerGuard(path, () => {
          let current: Partial<BridgeDescriptor> | null;
          try { current = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeDescriptor> | null; }
          catch { return; }
          if (current?.pid === process.pid && current.generation === record.generation) unlinkSync(path);
        });
      } catch (error) {
        console.error(`The bridge descriptor ${path} may have been left in place: ${error instanceof Error ? error.message : error}`);
      }
    },
  };
}

/**
 * The address a loopback relay passes connections to for a server bound to `hostname`, or null when
 * it needs none (127.0.0.1 or a wildcard already answers on 127.0.0.1; 127.0.0.2 does not) or gets
 * none: a host name is not relayed, since by the next connection it may resolve to another machine
 * and take the bridge token there. Such a server gets the app's message to set HOST=127.0.0.1.
 */
export function relayTarget(hostname: string): string | null {
  const name = hostname.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (name === "127.0.0.1" || name === "0.0.0.0" || name === "::" || isIP(name) === 0) return null;
  return name;
}

/**
 * How far a client may get ahead of a server that is not reading before the relay cuts both off: the
 * largest request body the server reads (a picture at the attachment limit), twice over.
 */
export const RELAY_CLIENT_AHEAD_BYTES = 2 * MAX_IMAGE_BODY_BYTES;
interface Relayed { peer?: Socket<Relayed>; queue: Uint8Array[]; queued: number; closed?: boolean; ending?: boolean }
function send(socket: Socket<Relayed>, chunk: Uint8Array): number {
  if (!socket.data.queue.length) {
    const written = Math.max(socket.write(chunk), 0);
    if (written === chunk.byteLength) return 0;
    chunk = chunk.subarray(written);
  }
  socket.data.queue.push(chunk);
  socket.data.queued += chunk.byteLength;
  return socket.data.queued;
}
function drain(socket: Socket<Relayed>): void {
  while (socket.data.queue.length) {
    const chunk = socket.data.queue[0]!;
    const written = Math.max(socket.write(chunk), 0);
    socket.data.queued -= written;
    if (written < chunk.byteLength) { socket.data.queue[0] = chunk.subarray(written); return; }
    socket.data.queue.shift();
  }
  if (socket.data.ending) socket.end();
  else socket.data.peer?.resume();
}
function endAfterQueue(socket: Socket<Relayed> | undefined): void {
  if (!socket) return;
  socket.data.ending = true;
  if (!socket.data.queue.length) socket.end();
}

/**
 * A port on 127.0.0.1 that passes each connection on to `target:port` (#1960), `target` an IP address (`relayTarget`). An Ovis whose HOST
 * is another address does not answer on the PC's loopback, where the app's SSH tunnel always goes:
 * it registers this port as its bridge instead. The tunnel then never reaches past the PC's loopback,
 * whatever a descriptor says, and a request through it still arrives from that address, not loopback.
 *
 * A client slow to read pauses the server's side, so the server feels it as its own backpressure (its
 * output-stall checks read it) instead of the relay holding it all. The client's side is never paused:
 * a paused socket would not see its client leave. A client more than RELAY_CLIENT_AHEAD_BYTES ahead of
 * a server that is not reading is cut off instead.
 */
export function loopbackRelay(target: string, port: number): { port: number; stop(): void } {
  const listener = Bun.listen<Relayed>({ hostname: "127.0.0.1", port: 0, socket: {
    open(client) {
      client.data = { queue: [], queued: 0 };
      client.pause();
      void Bun.connect<Relayed>({ hostname: target, port, data: { queue: [], queued: 0 }, socket: {
        open(peer) {
          if (client.data.closed) { peer.end(); return; }
          peer.data.peer = client;
          client.data.peer = peer;
          client.resume();
        },
        data(peer, chunk) { if (send(client, chunk)) peer.pause(); },
        drain,
        close() { endAfterQueue(client); },
        error() { endAfterQueue(client); },
      } }).catch(() => client.end());
    },
    data(client, chunk) {
      const peer = client.data.peer;
      if (peer && send(peer, chunk) > RELAY_CLIENT_AHEAD_BYTES) { client.terminate(); peer.terminate(); }
    },
    drain,
    // nothing a departed client sent still matters, and a server that reads nothing would hold the
    // queue forever: its side goes at once (a server's own close still lets the client read the rest)
    close(client) { client.data.closed = true; client.data.peer?.terminate(); },
    error(client) { client.data.closed = true; client.data.peer?.terminate(); },
  } });
  return { port: listener.port, stop: () => listener.stop(true) };
}
