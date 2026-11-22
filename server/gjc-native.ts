import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import nodePath, { join } from "node:path";

import { GJC_NATIVE_DIRECTORY, GJC_NATIVE_LEASE_MS, isGjcNativeBindingShape, type GjcNativeBinding } from "../shared/gjc-native.ts";

export const GJC_NATIVE_MAX_BYTES = 16 * 1024;
const GJC_TRANSCRIPT_HEADER_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBytes(fd: number, limit: number): Buffer {
  const buffer = Buffer.alloc(limit);
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return buffer.subarray(0, offset);
}

function samePath(left: string, right: string, platform: string): boolean {
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function childName(root: string, file: string): string | null {
  const relative = nodePath.relative(root, file);
  if (relative === "" || nodePath.isAbsolute(relative)) return null;
  const parts = relative.split(nodePath.sep);
  return parts.length === 1 && parts[0] !== ".." ? parts[0]! : null;
}

function parseBinding(value: unknown, pid: number, now: number): GjcNativeBinding | null {
  if (!isGjcNativeBindingShape(value) || value.pid !== pid || value.processStartedAt > now
    || value.updatedAt > now || now - value.updatedAt >= GJC_NATIVE_LEASE_MS) return null;
  return value;
}

function readNativeFile(home: string, pid: number): unknown | null {
  if (!nodePath.isAbsolute(home)) return null;
  const agentPath = join(home, ".gjc", "agent");
  const identityPath = join(agentPath, GJC_NATIVE_DIRECTORY);
  const filePath = join(identityPath, `${pid}.json`);
  let fd: number | undefined;
  try {
    const agent = realpathSync(agentPath);
    const identityStat = lstatSync(identityPath);
    if (identityStat.isSymbolicLink() || !identityStat.isDirectory()) return null;
    const identity = realpathSync(identityPath);
    if (childName(agent, identity) !== GJC_NATIVE_DIRECTORY) return null;

    const before = lstatSync(filePath);
    if (before.isSymbolicLink() || !before.isFile() || before.size > GJC_NATIVE_MAX_BYTES) return null;
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    const nonBlock = fsConstants.O_NONBLOCK ?? 0;
    fd = openSync(filePath, fsConstants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > GJC_NATIVE_MAX_BYTES || opened.dev !== before.dev || opened.ino !== before.ino) return null;

    const canonicalFile = realpathSync(filePath);
    if (!samePath(canonicalFile, join(identity, `${pid}.json`), process.platform)) return null;
    const bytes = readBytes(fd, GJC_NATIVE_MAX_BYTES);
    const after = fstatSync(fd);
    const afterPath = lstatSync(filePath);
    if (after.size > GJC_NATIVE_MAX_BYTES || afterPath.isSymbolicLink() || !afterPath.isFile()
      || after.dev !== afterPath.dev || after.ino !== afterPath.ino
      || !samePath(realpathSync(filePath), canonicalFile, process.platform)) return null;
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readGjcNativeBinding(home: string, pid: number, now?: number): GjcNativeBinding | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const value = readNativeFile(home, pid);
  // A heartbeat can land while the file is read. Compare against the clock after
  // the read, not a timestamp captured before it that would reject fresh evidence.
  const clockAfterRead = now ?? Date.now();
  if (!Number.isSafeInteger(clockAfterRead) || clockAfterRead < 0) return null;
  return value === null ? null : parseBinding(value, pid, clockAfterRead);
}

function canonicalDirectory(path: string): string | null {
  try {
    if (!statSync(path).isDirectory()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function readSessionHeader(path: string): { id: unknown; cwd: unknown; type: unknown; identity: string } | null {
  let fd: number | undefined;
  try {
    const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
    fd = openSync(path, fsConstants.O_RDONLY | noFollow | (fsConstants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile()) return null;
    const bytes = readBytes(fd, GJC_TRANSCRIPT_HEADER_BYTES);
    const newline = bytes.indexOf(0x0a);
    if (newline < 0) return null;
    const after = fstatSync(fd, { bigint: true });
    const pathStat = lstatSync(path, { bigint: true });
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || after.dev !== pathStat.dev || after.ino !== pathStat.ino
      || !samePath(realpathSync(path), path, process.platform)) return null;
    const value: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
    if (!isRecord(value)) return null;
    return { id: value.id, cwd: value.cwd, type: value.type, identity: `${after.dev}:${after.ino}` };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function validateGjcNativeTranscript(
  binding: GjcNativeBinding,
  cwd: string,
  home: string,
  platform: string = process.platform,
): string | null {
  return validatedGjcNativeTranscript(binding, cwd, home, platform)?.path ?? null;
}

export function validatedGjcNativeTranscript(
  binding: GjcNativeBinding,
  cwd: string,
  home: string,
  platform: string = process.platform,
): { path: string; identity: string } | null {
  const session = binding?.session;
  if (!session || typeof session.id !== "string" || session.id === ""
    || typeof session.path !== "string" || typeof session.cwd !== "string"
    || !nodePath.isAbsolute(cwd) || !nodePath.isAbsolute(home)
    || !nodePath.isAbsolute(session.path) || !nodePath.isAbsolute(session.cwd)) return null;
  const agentDir = join(home, ".gjc", "agent");
  const root = canonicalDirectory(join(agentDir, "sessions"));
  const expectedCwd = canonicalDirectory(cwd);
  const recordCwd = canonicalDirectory(session.cwd);
  if (!root || !expectedCwd || !recordCwd || !samePath(recordCwd, expectedCwd, platform)) return null;

  let path: string;
  try { path = realpathSync(session.path); }
  catch { return null; }
  const relative = nodePath.relative(root, path);
  if (relative === "" || nodePath.isAbsolute(relative)) return null;
  const parts = relative.split(nodePath.sep);
  if (parts.length !== 2 || parts[0] === ".." || !path.endsWith(".jsonl")) return null;
  const header = readSessionHeader(path);
  if (!header || header.type !== "session" || header.id !== session.id || typeof header.cwd !== "string") return null;
  const headerCwd = canonicalDirectory(header.cwd);
  return headerCwd && samePath(headerCwd, expectedCwd, platform) ? { path, identity: header.identity } : null;
}
