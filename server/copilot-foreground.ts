/** Read-only identity for opted-in Linux TUIs. This never enables a listener or configures its authentication. */
import { closeSync, openSync, readSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { readProcessBirth } from "./process-owner.ts";

type Diagnostic = "unsupported_platform" | "process_unproved" | "not_opted_in" | "endpoint_unproved"
  | "process_changed" | "rpc_failed" | "rpc_timeout" | "malformed_rpc" | "rpc_rejected"
  | "unsupported_protocol" | "foreground_changed" | "no_foreground";
export type CopilotForeground =
  | { state: "unavailable"; diagnostic: Diagnostic }
  | { state: "selected"; sessionId: string; binding: string };
interface Endpoint { host: string; address: string; port: number; inode: string }
interface Owner { pid: number; birth: string; endpoint: Endpoint }
interface TcpEntry { address: string; port: number; remoteAddress: string; remotePort: number; state: string; inode: string }

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK: Readonly<Record<string, string>> = { "0100007F": "127.0.0.1", "00000000000000000000000001000000": "::1" };
const MAX_MESSAGE = 64 * 1024;
export const COPILOT_RPC_TIMEOUT_MS = 2000;
const clients = new Map<number, ForegroundClient>();
class Unavailable extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(diagnostic); }
}

function boundedFile(path: string, limit: number): string {
  const fd = openSync(path, "r");
  try {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) return bytes.subarray(0, length).toString("utf8");
      length += read;
    }
    throw new Unavailable("process_unproved");
  } finally { closeSync(fd); }
}

function socketInodes(pid: number): Set<string> {
  const descriptors = readdirSync(`/proc/${pid}/fd`);
  if (descriptors.length > 4096) throw new Unavailable("process_unproved");
  const inodes = new Set<string>();
  for (const descriptor of descriptors) {
    let target: string;
    try { target = readlinkSync(`/proc/${pid}/fd/${descriptor}`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const match = /^socket:\[(\d+)\]$/.exec(target);
    if (match) inodes.add(match[1]!);
  }
  return inodes;
}

function tcpEntries(pid: number): TcpEntry[] {
  return ["tcp", "tcp6"].flatMap((table) =>
    boundedFile(`/proc/${pid}/net/${table}`, 4 * 1024 * 1024).split("\n").slice(1).filter((line) => line.trim()).map((line) => {
      const fields = line.trim().split(/\s+/);
      const local = /^([\dA-F]+):([\dA-F]{4})$/.exec(fields[1] ?? "");
      const remote = /^([\dA-F]+):([\dA-F]{4})$/.exec(fields[2] ?? "");
      if (!local || !remote || !fields[3] || !/^\d+$/.test(fields[9] ?? "")) throw new Unavailable("endpoint_unproved");
      return { address: local[1]!, port: Number.parseInt(local[2]!, 16), remoteAddress: remote[1]!,
        remotePort: Number.parseInt(remote[2]!, 16), state: fields[3], inode: fields[9]! };
    }));
}

function owner(pid: number): Owner {
  if (!Number.isSafeInteger(pid) || pid < 1 || statSync(`/proc/${pid}`).uid !== process.getuid?.()) throw new Unavailable("process_unproved");
  const birth = readProcessBirth(pid);
  if (birth.state !== "identified") throw new Unavailable("process_unproved");
  const argv = boundedFile(`/proc/${pid}/cmdline`, MAX_MESSAGE).split("\0");
  const delimiter = argv.indexOf("--");
  if (!argv.slice(0, delimiter < 0 ? undefined : delimiter).includes("--ui-server")) throw new Unavailable("not_opted_in");
  const inodes = socketInodes(pid);
  const listening = tcpEntries(pid).filter((entry) => entry.state === "0A" && inodes.has(entry.inode));
  const endpoint = listening[0];
  if (listening.length !== 1 || !endpoint || !Object.hasOwn(LOOPBACK, endpoint.address)) throw new Unavailable("endpoint_unproved");
  return { pid, birth: birth.birth.value, endpoint: { ...endpoint, host: LOOPBACK[endpoint.address]! } };
}

function unchanged(expected: Owner): void {
  const current = owner(expected.pid);
  if (current.birth !== expected.birth || current.endpoint.inode !== expected.endpoint.inode
    || current.endpoint.address !== expected.endpoint.address || current.endpoint.port !== expected.endpoint.port) {
    throw new Unavailable("process_changed");
  }
}

function acceptedByOwner(expected: Owner, socket: Socket): boolean {
  unchanged(expected);
  const inodes = socketInodes(expected.pid);
  return tcpEntries(expected.pid).some((entry) => entry.state === "01" && inodes.has(entry.inode)
    && entry.address === expected.endpoint.address && entry.port === expected.endpoint.port
    && entry.remoteAddress === expected.endpoint.address && entry.remotePort === socket.localPort);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface Pending {
  id: number;
  resolve: (value: unknown) => void;
  reject: (error: Unavailable) => void;
  timer: ReturnType<typeof setTimeout>;
}

class ForegroundClient {
  readonly generation = randomUUID();
  readonly socket: Socket;
  private readonly ready: Promise<void>;
  private queue = Promise.resolve();
  private queued = 0;
  private bytes: Buffer = Buffer.alloc(0);
  private pending: Pending | null = null;
  private sequence = 0;
  private revision = 0;
  private selected: string | null | undefined;
  private failure: Unavailable | null = null;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly expected: Owner) {
    const socket = this.socket = createConnection({ host: expected.endpoint.host, port: expected.endpoint.port });
    const connected = new Promise<void>((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("error", () => reject(new Unavailable("rpc_failed")));
      this.socket.once("close", () => reject(new Unavailable("rpc_failed")));
    });
    this.socket.on("error", () => this.close(new Unavailable("rpc_failed")));
    this.socket.on("close", () => this.close(new Unavailable("rpc_failed")));
    this.socket.on("data", (chunk: Buffer) => {
      try { this.receive(chunk); }
      catch (error) {
        this.close(error instanceof Unavailable ? error : new Unavailable("malformed_rpc"));
      }
    });
    const timer = setTimeout(() => this.close(new Unavailable("rpc_timeout")), COPILOT_RPC_TIMEOUT_MS);
    this.ready = (async () => {
      try {
        await connected;
        const deadline = performance.now() + COPILOT_RPC_TIMEOUT_MS;
        while (!acceptedByOwner(expected, socket)) {
          this.check();
          if (performance.now() > deadline) throw new Unavailable("rpc_timeout");
          await Bun.sleep(5);
        }
        const result = await this.request("connect");
        if (!record(result) || result.protocolVersion !== 3) throw new Unavailable("unsupported_protocol");
      } finally { clearTimeout(timer); }
    })();
  }

  close(error = new Unavailable("rpc_failed")): void {
    if (this.failure !== null) return;
    this.failure = error;
    clearTimeout(this.idle);
    if (this.pending !== null) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    this.socket.destroy();
    if (clients.get(this.expected.pid) === this) clients.delete(this.expected.pid);
  }

  // Ownership reads the whole network-namespace TCP table, which can take hundreds of ms on a busy
  // host, so it is proven once on connect and once at the end of each read, not around every request.
  private check(): void {
    if (this.failure !== null) throw this.failure;
  }

  private receive(chunk: Buffer): void {
    this.bytes = Buffer.concat([this.bytes, chunk]);
    if (this.bytes.length > MAX_MESSAGE + 8192) throw new Unavailable("malformed_rpc");
    for (;;) {
      const boundary = this.bytes.indexOf("\r\n\r\n");
      if (boundary < 0) {
        if (this.bytes.length > 8192) throw new Unavailable("malformed_rpc");
        return;
      }
      if (boundary > 8192) throw new Unavailable("malformed_rpc");
      const lengths = this.bytes.subarray(0, boundary).toString("ascii").split("\r\n").filter((line) => /^Content-Length:/i.test(line));
      const match = lengths.length === 1 ? /^Content-Length: (\d+)$/i.exec(lengths[0]!) : null;
      const length = match ? Number(match[1]) : 0;
      if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MESSAGE) throw new Unavailable("malformed_rpc");
      if (this.bytes.length < boundary + 4 + length) return;
      let value: unknown;
      try { value = JSON.parse(this.bytes.subarray(boundary + 4, boundary + 4 + length).toString("utf8")); }
      catch { throw new Unavailable("malformed_rpc"); }
      this.bytes = this.bytes.subarray(boundary + 4 + length);
      if (!record(value) || value.jsonrpc !== "2.0") throw new Unavailable("malformed_rpc");
      if (!Object.hasOwn(value, "id")) {
        if (typeof value.method !== "string") throw new Unavailable("malformed_rpc");
        if (value.method === "session.lifecycle") {
          if (!record(value.params) || typeof value.params.type !== "string"
            || typeof value.params.sessionId !== "string" || !SESSION_ID.test(value.params.sessionId)) throw new Unavailable("malformed_rpc");
          if (!["session.created", "session.updated"].includes(value.params.type)) this.revision++;
        }
        continue;
      }
      const pending = this.pending;
      if (pending === null || value.id !== pending.id || Object.hasOwn(value, "method")) throw new Unavailable("malformed_rpc");
      clearTimeout(pending.timer);
      this.pending = null;
      if (Object.hasOwn(value, "error")) pending.reject(new Unavailable("rpc_rejected"));
      else if (!Object.hasOwn(value, "result")) pending.reject(new Unavailable("malformed_rpc"));
      else pending.resolve(value.result);
    }
  }

  private request(method: "connect" | "session.getForeground"): Promise<unknown> {
    this.check();
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => this.close(new Unavailable("rpc_timeout")), COPILOT_RPC_TIMEOUT_MS);
      this.pending = { id, timer, resolve, reject };
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
      this.socket.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    });
  }

  private async selection(): Promise<string> {
    const result = await this.request("session.getForeground");
    this.check();
    if (!record(result)) throw new Unavailable("malformed_rpc");
    if (result.sessionId !== null && result.sessionId !== undefined
      && (typeof result.sessionId !== "string" || !SESSION_ID.test(result.sessionId))) throw new Unavailable("malformed_rpc");
    const selected = typeof result.sessionId === "string" ? result.sessionId : null;
    if (this.selected !== undefined && this.selected !== selected) this.revision++;
    this.selected = selected;
    if (selected === null) throw new Unavailable("no_foreground");
    return selected;
  }

  read(): Promise<CopilotForeground> {
    if (++this.queued > 32) {
      this.queued--;
      return Promise.reject(new Unavailable("rpc_failed"));
    }
    clearTimeout(this.idle);
    this.socket.ref();
    const result = this.queue.then(async (): Promise<CopilotForeground> => {
      await this.ready;
      const first = await this.selection();
      const revision = this.revision;
      const second = await this.selection();
      this.check();
      if (!acceptedByOwner(this.expected, this.socket)) throw new Unavailable("process_changed");
      if (first !== second || revision !== this.revision || this.bytes.length !== 0) throw new Unavailable("foreground_changed");
      return { state: "selected", sessionId: second, binding: `${this.generation}:${this.revision}` };
    }).finally(() => {
      if (--this.queued === 0 && this.failure === null) {
        this.socket.unref();
        this.idle = setTimeout(() => this.close(), 30_000);
        this.idle.unref();
      }
    });
    this.queue = result.then(() => {}, () => {});
    return result;
  }
}

export function forgetCopilotForeground(): void {
  for (const client of clients.values()) client.close();
}

/** Attach only to an already-enabled, process-owned endpoint; never launch a server or send control methods. */
export async function readCopilotForeground(pid: number): Promise<CopilotForeground> {
  if (process.platform !== "linux") return { state: "unavailable", diagnostic: "unsupported_platform" };
  let client = clients.get(pid);
  try {
    const expected = owner(pid);
    if (client !== undefined && (client.expected.birth !== expected.birth
      || client.expected.endpoint.inode !== expected.endpoint.inode
      || client.expected.endpoint.address !== expected.endpoint.address || client.expected.endpoint.port !== expected.endpoint.port)) {
      client.close(new Unavailable("process_changed"));
      client = undefined;
    }
    if (client === undefined) {
      if (clients.size >= 128) throw new Unavailable("endpoint_unproved");
      client = new ForegroundClient(expected);
      clients.set(pid, client);
    }
    return await client.read();
  }
  catch (error) {
    if (error instanceof Unavailable) {
      if (error.diagnostic !== "foreground_changed" && error.diagnostic !== "no_foreground") client?.close(error);
      return { state: "unavailable", diagnostic: error.diagnostic };
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO", "ECONNRESET", "ECONNREFUSED"].includes(code ?? "")) {
      client?.close(new Unavailable("process_unproved"));
      return { state: "unavailable", diagnostic: "process_unproved" };
    }
    throw error;
  }
}
