import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants as fsConstants, fstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { GJC_NATIVE_DIRECTORY, GJC_NATIVE_HEARTBEAT_MS, GJC_NATIVE_LEASE_MS, isGjcNativeBindingShape, type GjcNativeBinding } from "../shared/gjc-native.ts";
import { processStartedAt as readProcessStartedAt } from "../server/process-start.ts";
import { windowsProcessTable } from "../server/windows-processes.ts";

export type GjcLifecycleEvent = "session_start" | "session_switch" | "session_branch" | "session_shutdown";

export interface GjcNativeSessionManager {
  getSessionFile(): unknown;
  getSessionId(): unknown;
  getCwd(): unknown;
}

export interface GjcNativeContext {
  hasUI?: boolean;
  sessionManager?: GjcNativeSessionManager;
}

export interface GjcNativeExtensionAPI {
  on(event: GjcLifecycleEvent, handler: (event: unknown, context: GjcNativeContext) => void | Promise<void>): void;
}

export interface GjcNativeFileSystem {
  mkdirSync(path: string, options: { recursive: true; mode: number }): unknown;
  openSync(path: string, flags: number): number;
  fstatSync(fd: number): { isFile(): boolean; size: number };
  readSync(fd: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
  realpathSync(path: string): string;
  writeFileSync(path: string, data: string, options: { flag: "wx"; mode: number }): void;
  chmodSync(path: string, mode: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
}

const nativeFileSystem: GjcNativeFileSystem = {
  mkdirSync: (path, options) => mkdirSync(path, options),
  openSync: (path, flags) => openSync(path, flags),
  fstatSync: (fd) => fstatSync(fd),
  readSync: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => closeSync(fd),
  realpathSync: (path) => realpathSync(path),
  writeFileSync: (path, data, options) => writeFileSync(path, data, options),
  chmodSync: (path, mode) => chmodSync(path, mode),
  renameSync: (from, to) => renameSync(from, to),
  rmSync: (path, options) => rmSync(path, options),
};

export interface GjcNativePublisherOptions {
  home?: string;
  pid?: number;
  instanceId?: string;
  now?: () => number;
  processStartedAt?: (pid: number) => number | null | Promise<number | null>;
  heartbeatMs?: number;
  fileSystem?: GjcNativeFileSystem;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export interface GjcNativePublisher {
  lifecycle(event: Exclude<GjcLifecycleEvent, "session_shutdown">, context: GjcNativeContext): Promise<void>;
  heartbeat(): Promise<void>;
  shutdown(context: GjcNativeContext): Promise<void>;
}

function nativeProcessStartedAt(pid: number): Promise<number | null> {
  if (process.platform !== "win32") return Promise.resolve(readProcessStartedAt(pid));
  return windowsProcessTable().then((rows) => rows.find((row) => row.pid === pid)?.started ?? null);
}

const MAX_RECORD_BYTES = 16 * 1024;

function bindingFromFile(file: string, io: GjcNativeFileSystem): GjcNativeBinding | null {
  let fd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    fd = io.openSync(file, fsConstants.O_RDONLY | noFollow | (fsConstants.O_NONBLOCK ?? 0));
    const fileInfo = io.fstatSync(fd);
    if (!fileInfo.isFile() || fileInfo.size > MAX_RECORD_BYTES) return null;
    const bytes = new Uint8Array(MAX_RECORD_BYTES);
    const bytesRead = io.readSync(fd, bytes, 0, MAX_RECORD_BYTES, 0);
    if (bytesRead !== fileInfo.size) return null;
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, bytesRead)));
    return isGjcNativeBindingShape(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { io.closeSync(fd); } catch {}
    }
  }
}

function canonicalMainSessionPath(file: unknown, home: string, io: Pick<GjcNativeFileSystem, "realpathSync">): string | null {
  if (typeof file !== "string" || !isAbsolute(file) || !file.endsWith(".jsonl")) return null;
  const root = resolve(home, ".gjc", "agent", "sessions");
  const normalized = resolve(file);
  const lexicalSubpath = relative(root, normalized);
  if (lexicalSubpath === "" || isAbsolute(lexicalSubpath) || lexicalSubpath === ".." || lexicalSubpath.startsWith(`..${sep}`)) return null;
  const lexicalParts = lexicalSubpath.split(sep);
  if (lexicalParts.length !== 2 || lexicalParts[0] === "" || !lexicalParts[1]!.endsWith(".jsonl")) return null;
  try {
    const canonicalRoot = io.realpathSync(root);
    const canonicalFile = join(io.realpathSync(dirname(normalized)), basename(normalized));
    const canonicalSubpath = relative(canonicalRoot, canonicalFile);
    if (canonicalSubpath === "" || isAbsolute(canonicalSubpath) || canonicalSubpath === ".." || canonicalSubpath.startsWith(`..${sep}`)) return null;
    const canonicalParts = canonicalSubpath.split(sep);
    return canonicalParts.length === 2 && canonicalParts[0] !== "" && canonicalParts[1]!.endsWith(".jsonl")
      ? canonicalFile
      : null;
  } catch {
    return null;
  }
}

export function createGjcNativePublisher(options: GjcNativePublisherOptions = {}): GjcNativePublisher {
  const home = resolve(options.home ?? homedir());
  const pid = options.pid ?? process.pid;
  const instanceId = options.instanceId ?? randomUUID();
  const now = options.now ?? Date.now;
  const getProcessStartedAt = options.processStartedAt ?? nativeProcessStartedAt;
  const heartbeatMs = options.heartbeatMs ?? GJC_NATIVE_HEARTBEAT_MS;
  const io = options.fileSystem ?? nativeFileSystem;
  const schedule = options.setInterval ?? setInterval;
  const unschedule = options.clearInterval ?? clearInterval;
  const directory = join(home, ".gjc", "agent", GJC_NATIVE_DIRECTORY);
  const ownFile = join(directory, `${pid}.json`);

  let birth: number | null = null;
  let sequence = 0;
  let hasPublishedIdentity = false;
  let publishedIdentity: GjcNativeBinding["session"] = null;
  let currentContext: GjcNativeContext | undefined;
  let active = false;
  let stopped = false;
  let revision = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (job: () => Promise<void> | void): Promise<void> => {
    const next = queue.then(job).catch(() => {});
    queue = next;
    return next;
  };

  const sessionFile = (manager: GjcNativeSessionManager | undefined): unknown => {
    try { return manager?.getSessionFile(); } catch { return null; }
  };

  const mainPath = (file: unknown): string | null => canonicalMainSessionPath(file, home, io);

  const sessionFor = (manager: GjcNativeSessionManager, file: string): GjcNativeBinding["session"] | undefined => {
    try {
      const id = manager.getSessionId();
      const cwd = manager.getCwd();
      if (typeof id !== "string" || id.length === 0 || typeof cwd !== "string" || cwd.length === 0) return undefined;
      return { id, path: file, cwd };
    } catch {
      return undefined;
    }
  };

  const sameIdentity = (left: GjcNativeBinding["session"], right: GjcNativeBinding["session"]): boolean => {
    if (left === null || right === null) return left === right;
    return left.id === right.id && left.path === right.path && left.cwd === right.cwd;
  };

  const writeBinding = (session: GjcNativeBinding["session"], startedAt: number, at: number): void => {
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const previous = bindingFromFile(ownFile, io);
    if (previous && previous.instanceId !== instanceId) {
      const age = at - previous.updatedAt;
      if (previous.pid === pid && previous.processStartedAt === startedAt && age >= 0 && age < GJC_NATIVE_LEASE_MS) return;
    }

    if (!hasPublishedIdentity && previous?.instanceId === instanceId && previous.pid === pid && previous.processStartedAt === startedAt) {
      sequence = previous.sequence;
      publishedIdentity = previous.session;
      hasPublishedIdentity = true;
    }
    const nextSequence = hasPublishedIdentity
      ? sequence + (sameIdentity(publishedIdentity, session) ? 0 : 1)
      : 1;
    const record: GjcNativeBinding = {
      version: 1,
      pid,
      processStartedAt: startedAt,
      instanceId,
      sequence: nextSequence,
      updatedAt: at,
      session,
    };
    const temporary = `${ownFile}.${randomUUID()}.tmp`;
    try {
      io.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
      io.chmodSync(temporary, 0o600);
      io.renameSync(temporary, ownFile);
      sequence = nextSequence;
      publishedIdentity = session;
      hasPublishedIdentity = true;
    } finally {
      try { io.rmSync(temporary, { force: true }); } catch {}
    }
  };

  const removeOwnBinding = (): void => {
    const record = bindingFromFile(ownFile, io);
    if (record?.pid !== pid || record.processStartedAt !== birth || record.instanceId !== instanceId) return;
    try { io.rmSync(ownFile, { force: true }); } catch {}
  };

  const refresh = async (expectedRevision?: number): Promise<void> => {
    if (stopped || !active) return;
    if (expectedRevision !== undefined && expectedRevision !== revision) return;

    if (birth === null) {
      let startedAt: number | null;
      try { startedAt = await getProcessStartedAt(pid); } catch { startedAt = null; }
      if (stopped || (expectedRevision !== undefined && expectedRevision !== revision)) return;
      if (typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt <= 0) return;
      birth = startedAt;
    }

    const context = currentContext;
    const manager = context?.sessionManager;
    if (!manager) return;
    const file = mainPath(sessionFile(manager));

    let session: GjcNativeBinding["session"] = null;
    if (file !== null) {
      const accessorSession = sessionFor(manager, file);
      if (accessorSession === undefined) return;
      session = accessorSession;
    }
    try { writeBinding(session, birth, now()); } catch {}
  };

  const startTimer = (): void => {
    if (timer !== undefined) return;
    timer = schedule(() => { void heartbeat(); }, heartbeatMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  };

  const heartbeat = (): Promise<void> => enqueue(() => refresh());

  const lifecycle = (_event: Exclude<GjcLifecycleEvent, "session_shutdown">, context: GjcNativeContext): Promise<void> => {
    if (stopped || context?.hasUI !== true) return Promise.resolve();
    const manager = context?.sessionManager;
    if (!manager) return Promise.resolve();
    currentContext = context;
    active = true;
    const thisRevision = ++revision;
    startTimer();
    return enqueue(() => refresh(thisRevision));
  };

  const shutdown = (context: GjcNativeContext): Promise<void> => {
    if (context?.hasUI !== true) return Promise.resolve();
    if (stopped) return queue;

    stopped = true;
    active = false;
    currentContext = undefined;
    revision++;
    if (timer !== undefined) {
      unschedule(timer);
      timer = undefined;
    }
    return enqueue(() => { removeOwnBinding(); });
  };

  return { lifecycle, heartbeat, shutdown };
}

export default function gjcNativeExtension(api: GjcNativeExtensionAPI): void {
  const publisher = createGjcNativePublisher();
  api.on("session_start", (_event, context) => publisher.lifecycle("session_start", context));
  api.on("session_switch", (_event, context) => publisher.lifecycle("session_switch", context));
  api.on("session_branch", (_event, context) => publisher.lifecycle("session_branch", context));
  api.on("session_shutdown", (_event, context) => publisher.shutdown(context));
}
