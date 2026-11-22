import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import type { SlashCommand } from "../shared/protocol.ts";
import { registerCatalogSource } from "./catalog-sources.ts";
import type { CatalogSource } from "./catalog-sources.ts";
import { defaultCodexHome, paneCodexProcess } from "./codex.ts";
import { processEnviron } from "./omo.ts";

/**
 * Skills from the Codex app-server daemon every Codex TUI shares since 0.157, read-only.
 *
 * It only connects to a control socket that already exists, at $CODEX_HOME/app-server-control/
 * app-server-control.sock (a WebSocket over the unix socket), and never starts a daemon. It sends
 * `initialize` (experimentalApi false), the `initialized` notification and `skills/list`, nothing
 * else: no thread, turn or approval method. Whatever goes wrong leaves the scanned rows.
 * codex-rs at 83086188ae0614bd882818ff1aa23f3194962012: app-server-transport/src/transport/
 * unix_socket.rs, app-server/src/request_processors/catalog_processor.rs.
 */
const MIN_VERSION = [0, 157, 0] as const;
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_MS = 30_000;
const FAILURE_MS = 10_000;
const IDLE_MS = 2 * CACHE_MS;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** The version in a `userAgent` such as `codex_cli_rs/0.163.0 (Linux ...)`. */
function versionOf(userAgent: unknown): readonly number[] | null {
  const match = typeof userAgent === "string" ? /\/(\d+)\.(\d+)\.(\d+)/.exec(userAgent) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (const [index, limit] of minimum.entries()) if (version[index]! !== limit) return version[index]! > limit;
  return true;
}

const ORIGINS: Record<string, SlashCommand["origin"]> = { user: "user", repo: "project", system: "bundled", admin: "bundled" };

const SCOPES = new Set(["user", "repo", "system", "admin"]);

/**
 * The rows of a `skills/list` answer (SkillsListResponse, SkillsListEntry and SkillMetadata of the
 * pinned protocol), enabled skills only, as the TUI offers them. An entry that reports errors or a
 * skill without the protocol's required fields (name, description, path, scope, enabled) makes the
 * whole answer unusable: null.
 */
function skillRows(result: unknown): SlashCommand[] | null {
  if (!isObject(result) || !Array.isArray(result.data) || result.data.length === 0) return null;
  const rows: SlashCommand[] = [];
  const seen = new Set<string>();
  for (const entry of result.data) {
    if (!isObject(entry) || typeof entry.cwd !== "string" || !Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length > 0) return null;
    for (const skill of entry.skills) {
      if (!isObject(skill) || typeof skill.name !== "string" || !skill.name || typeof skill.description !== "string" || typeof skill.path !== "string" || typeof skill.enabled !== "boolean" || typeof skill.scope !== "string" || !SCOPES.has(skill.scope)) return null;
      if (skill.pluginId !== undefined && skill.pluginId !== null && typeof skill.pluginId !== "string") return null;
      if (!skill.enabled || seen.has(skill.path)) continue;
      seen.add(skill.path);
      const origin = typeof skill.pluginId === "string" && skill.pluginId ? "plugin" : ORIGINS[skill.scope];
      rows.push({
        name: skill.name,
        description: skill.description.replace(/\s+/g, " ").trim(),
        source: "skill", trigger: "$", ...(origin === undefined ? {} : { origin }), id: skill.path,
        forms: [{ match: "bare", interaction: "unknown" }], visibility: "offered", provenance: { transport: "native", verified: true },
      });
    }
  }
  return rows;
}

const CONTROL_SOCKET = "app-server-control.sock";

/**
 * Where the control socket may be, as the pinned Codex makes it (unix_socket.rs, daemon_directory.rs):
 * the advertised path in $CODEX_HOME/app-server-control/ is either the socket itself, or a link to
 * <real /tmp>/codex-daemon-<euid>/<sha256 of the canonical advertised path>, in a directory that is
 * a user-owned 0700 directory. Anything else is not the daemon's and is never connected to.
 */
async function controlSocketTarget(home: string, daemonRoot: () => Promise<string>): Promise<string> {
  const euid = process.geteuid?.();
  if (euid === undefined) throw new Error("no effective user id");
  const control = join(home, "app-server-control");
  const [realHome, realControl] = await Promise.all([realpath(home), realpath(control)]);
  if (realControl !== join(realHome, "app-server-control")) throw new Error("the control directory is a link");
  const advertised = join(realControl, CONTROL_SOCKET);
  const entry = await lstat(advertised);
  if (entry.isSocket()) {
    if (entry.uid !== euid) throw new Error("the control socket is not this user's");
    return advertised;
  }
  if (!entry.isSymbolicLink()) throw new Error("the control socket is not a socket");
  const target = resolve(realControl, await readlink(advertised));
  const root = await daemonRoot();
  if (target !== join(root, createHash("sha256").update(Buffer.from(advertised)).digest("hex"))) throw new Error("the control socket link leads elsewhere");
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.uid !== euid || (directory.mode & 0o777) !== 0o700) throw new Error("the daemon directory is not a private one");
  const socket = await lstat(target);
  if (!socket.isSocket() || socket.uid !== euid) throw new Error("the link's target is not this user's socket");
  return target;
}

class Refused extends Error {}

const REQUESTS = new Set<string>(["initialize", "skills/list"]);
const NOTIFICATIONS = new Set<string>(["initialized"]);

/** One connection to the daemon; it speaks only initialize, initialized and skills/list. */
export class DaemonConnection {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private next = 1;
  private readonly ready: Promise<void>;
  private opened!: () => void;
  private failed!: (error: Error) => void;
  closed = false;
  userAgent = "";

  private constructor(private readonly socket: WebSocket, private readonly onChanged: () => void, private readonly onClose: () => void) {
    this.ready = new Promise<void>((resolve, reject) => { this.opened = resolve; this.failed = reject; });
    this.ready.catch(() => undefined);
    socket.onopen = () => this.opened();
    socket.onmessage = (event) => this.receive(event.data);
    socket.onclose = () => this.finish();
    socket.onerror = () => this.finish();
  }

  static start(path: string, onChanged: () => void, onClose: () => void): DaemonConnection {
    return new DaemonConnection(new WebSocket(`ws+unix://${path}:/`), onChanged, onClose);
  }

  /** The handshake: the upgrade, then initialize (experimentalApi false) and initialized. */
  async handshake(): Promise<void> {
    const timer = setTimeout(() => this.close(), REQUEST_TIMEOUT_MS);
    try {
      await this.ready;
      const initialized = await this.request("initialize", {
        clientInfo: { name: "ovis", title: "Ovis", version: "0" },
        capabilities: { experimentalApi: false },
      });
      this.userAgent = isObject(initialized) && typeof initialized.userAgent === "string" ? initialized.userAgent : "";
      this.notify("initialized");
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  static async open(path: string, onChanged: () => void, onClose: () => void): Promise<DaemonConnection> {
    const connection = DaemonConnection.start(path, onChanged, onClose);
    await connection.handshake();
    return connection;
  }

  async request(method: "initialize" | "skills/list", params: Json): Promise<unknown> {
    if (!REQUESTS.has(method)) throw new Error(`${String(method)} is not a request this client sends`);
    if (this.closed) throw new Error("the daemon connection is closed");
    const id = this.next++;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  notify(method: "initialized"): void {
    if (!NOTIFICATIONS.has(method)) throw new Error(`${String(method)} is not a notification this client sends`);
    if (this.closed) throw new Error("the daemon connection is closed");
    this.socket.send(JSON.stringify({ method }));
  }

  private receive(data: unknown): void {
    let message: unknown;
    try { message = JSON.parse(String(data)); } catch { return; }
    if (!isObject(message)) return;
    if (typeof message.id === "number") {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (isObject(message.error)) waiting.reject(new Refused(typeof message.error.message === "string" ? message.error.message : "refused"));
      else waiting.resolve(message.result);
    } else if (message.method === "skills/changed") this.onChanged();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.failed(new Error("the daemon connection closed"));
    for (const waiting of this.pending.values()) waiting.reject(new Error("the daemon connection closed"));
    this.pending.clear();
    this.onClose();
  }

  close(): void {
    const socket = this.socket as WebSocket & { terminate?: () => void };
    try { if (socket.terminate) socket.terminate(); else socket.close(); } catch {}
    this.finish();
  }
}

export interface CodexDaemonOptions {
  codexHome?: () => string;
  platform?: string;
  /** the directory the pinned Codex puts rendezvous targets in; defaults to <real /tmp>/codex-daemon-<euid>. */
  daemonRoot?: () => string;
  now?: () => number;
  warn?: (message: string) => void;
}

export interface CodexDaemonSource extends CatalogSource {
  close(): void;
}

export function createCodexDaemonSource(options: CodexDaemonOptions = {}): CodexDaemonSource {
  const home = options.codexHome ?? defaultCodexHome;
  const platform = options.platform ?? process.platform;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const cache = new Map<string, { at: number; rows: SlashCommand[] }>();
  const inflight = new Map<string, { pending: Promise<SlashCommand[] | null>; waiters: number }>();
  let connection: DaemonConnection | null = null;
  let connecting: Promise<DaemonConnection> | null = null;
  let attempt: AbortController | null = null;
  let closed = false;
  let failedAt = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let disabledFor: string | null = null;
  const logged = new Set<string>();
  const once = (key: string, message: string): void => {
    if (logged.has(key)) return;
    logged.add(key);
    warn(message);
  };

  const drop = (): void => {
    clearTimeout(idle);
    attempt?.abort();
    const current = connection;
    connection = null;
    cache.clear();
    current?.close();
  };
  const liveWaiters = (): boolean => [...inflight.values()].some((read) => read.waiters > 0);
  const failConnection = (): void => {
    failedAt = now();
    connection?.close();
  };
  const ownership = (aborted: boolean): void => {
    if (liveWaiters()) return;
    if (!aborted && cache.size > 0) {
      touch();
      return;
    }
    attempt?.abort();
    if (!aborted && connection) failedAt = now();
    connection?.close();
  };
  const touch = (): void => {
    clearTimeout(idle);
    idle = setTimeout(drop, IDLE_MS);
    idle.unref?.();
  };

  const stopped = (own: AbortController): void => {
    if (closed || own.signal.aborted) throw new Error("the connection attempt was cancelled");
  };

  const connect = async (): Promise<DaemonConnection> => {
    if (closed) throw new Error("the provider is closed");
    if (connection && !connection.closed) return connection;
    if (connecting) return connecting;
    if (now() - failedAt < FAILURE_MS) throw new Error("the daemon failed a moment ago");
    const own = new AbortController();
    attempt = own;
    connecting = (async () => {
      stopped(own);
      // never start one: only a socket that is already there, where Codex puts it, is used
      const path = await controlSocketTarget(home(), async () => options.daemonRoot?.() ?? join(await realpath("/tmp"), `codex-daemon-${process.geteuid?.() ?? 0}`));
      stopped(own);
      const started = DaemonConnection.start(path, () => cache.clear(), () => { if (connection === started) connection = null; cache.clear(); });
      const terminate = (): void => started.close();
      own.signal.addEventListener("abort", terminate, { once: true });
      try {
        await started.handshake();
        stopped(own);
      } catch (error) {
        started.close();
        throw error;
      } finally {
        own.signal.removeEventListener("abort", terminate);
      }
      connection = started;
      return started;
    })().catch((error: unknown) => {
      if (!own.signal.aborted && !closed) failedAt = now();
      throw error;
    }).finally(() => { connecting = null; if (attempt === own) attempt = null; });
    return connecting;
  };

  const load = async (cwd: string): Promise<SlashCommand[] | null> => {
    try {
      const opened = await connect();
      if (closed) return null;
      const version = versionOf(opened.userAgent);
      if (disabledFor !== null && disabledFor === opened.userAgent) {
        failConnection();
        return null;
      }
      if (version === null || !atLeast(version, MIN_VERSION)) {
        disabledFor = opened.userAgent;
        failConnection();
        once("version", `codex daemon skills are not used: its version (${opened.userAgent || "unknown"}) is not known to be ${MIN_VERSION.join(".")} or newer`);
        return null;
      }
      const rows = skillRows(await opened.request("skills/list", { cwds: [cwd] }));
      if (closed) return null;
      if (rows === null) {
        once("shape", "codex daemon skills are not used: its skills/list answer reported errors or is not the pinned protocol's shape; keeping scanned skills");
        return null;
      }
      cache.set(cwd, { at: now(), rows });
      return rows;
    } catch (error) {
      if (error instanceof Refused) {
        // skills/list is not accepted without the experimental flag at this version: stop asking it
        disabledFor = connection?.userAgent ?? "";
        failConnection();
        once("refused", `codex daemon refused skills/list without experimentalApi (${error.message}); keeping scanned skills`);
      } else if (connection && !connection.closed && !closed) {
        failConnection();
      }
      return null;
    }
  };

  return {
    agent: "codex",
    owns: ["skills"],
    close() {
      closed = true;
      drop();
    },
    async rows(_pane, cwd, signal) {
      if (platform === "win32" || !cwd || closed || signal.aborted) return null;
      const cached = cache.get(cwd);
      if (cached && now() - cached.at < CACHE_MS) return cached.rows;
      let read = inflight.get(cwd);
      if (!read) {
        const created = {
          pending: load(cwd).finally(() => {
            if (inflight.get(cwd) === created) inflight.delete(cwd);
          }),
          waiters: 0,
        };
        read = created;
        inflight.set(cwd, created);
      }
      const shared = read;
      shared.waiters++;
      return await new Promise<SlashCommand[] | null>((resolve, reject) => {
        let aborted = false;
        const abort = (): void => {
          aborted = true;
          shared.waiters--;
          ownership(true);
          if (connecting) connecting.then(() => resolve(null), () => resolve(null));
          else resolve(null);
        };
        signal.addEventListener("abort", abort, { once: true });
        shared.pending.then((rows) => { if (!aborted) resolve(rows); }, (error: unknown) => { if (!aborted) reject(error); }).finally(() => {
          signal.removeEventListener("abort", abort);
          if (!aborted) shared.waiters--;
          ownership(false);
        });
      });
    },
  };
}

/** One provider per Codex home: its connection, cache and refusals belong to that home's daemon only. */
const homeSources = new Map<string, CodexDaemonSource>();
const HOMES_MAX = 8;

function sourceFor(home: string): CodexDaemonSource {
  let source = homeSources.get(home);
  if (source) { homeSources.delete(home); homeSources.set(home, source); return source; }
  source = createCodexDaemonSource({ codexHome: () => home });
  homeSources.set(home, source);
  if (homeSources.size > HOMES_MAX) {
    const oldest = homeSources.keys().next().value!;
    homeSources.get(oldest)?.close();
    homeSources.delete(oldest);
  }
  return source;
}

export function closeCodexDaemonSources(): void {
  for (const source of homeSources.values()) source.close();
  homeSources.clear();
}

/**
 * The Codex home whose daemon serves the pane: the server's configured one, else the pane's own Codex
 * process's CODEX_HOME, else that process's HOME/.codex. Read from /proc only (no process is started
 * for it); null when it cannot be read (another platform, no Codex process, an unreadable environment).
 */
export async function paneDaemonHome(paneId: string, configured?: string, platform = process.platform, processFiles: {
  readonly lookup: typeof paneCodexProcess;
  readonly environ: (pid: number) => readonly string[] | null;
  readonly cwd?: (pid: number) => Promise<string>;
} = { lookup: paneCodexProcess, environ: processEnviron }): Promise<string | null> {
  if (configured) return configured;
  if (platform !== "linux") return null;
  const codex = await processFiles.lookup(paneId).catch(() => null);
  if (!codex) return null;
  const environ = processFiles.environ(codex.pid);
  if (!environ) return null;
  const value = (key: string): string | null => environ.find((word) => word.startsWith(`${key}=`))?.slice(key.length + 1) || null;
  const own = value("CODEX_HOME");
  const home = value("HOME");
  if (!own) return home ? join(home, ".codex") : null;
  try {
    const base = isAbsolute(own) ? `/proc/${codex.pid}/root` : await processFiles.cwd?.(codex.pid) ?? `/proc/${codex.pid}/cwd`;
    // Bun realpath normalizes ".." before following links. Let the kernel traverse the raw
    // path first; Linux O_PATH (0x200000) needs no directory read permission.
    const directory = await open(`${base}/${own}`, 0x200000 | constants.O_DIRECTORY);
    try {
      const canonical = await realpath(`/proc/self/fd/${directory.fd}`);
      return (await directory.stat()).nlink === 0 ? null : canonical;
    }
    finally { await directory.close(); }
  } catch { return null; }
}

registerCatalogSource({
  agent: "codex",
  owns: ["skills"],
  async rows(pane, cwd, signal, context) {
    const home = await paneDaemonHome(pane.pane_id, context?.codexHome);
    // no home known for this pane: no other home's list stands in for it
    if (!home || signal.aborted) return null;
    return await sourceFor(home).rows(pane, cwd, signal, context);
  },
});
