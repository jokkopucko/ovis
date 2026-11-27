/**
 * `ovis recover` (docs/account.md, "Recovery at the PC"): this PC's own user, in a terminal on it or over SSH, reaches
 * the server over a Unix socket in a folder only that user may enter. It is no route: no request the server's
 * listeners, the relay or Portal take reaches it. The boundary is the folder's and the socket's modes, which the
 * kernel enforces on connect; Bun names no peer on an accepted Unix socket, so no peer check stands beside them.
 * Each connection asks the folder and the socket again, and a change refuses it. On Windows nothing is opened: there
 * recovery is the desktop app's screen.
 *
 * A release lets rows this PC already held sign in while they wait for a whole read. It is in memory only, ended by
 * that read, a restart or an undo, and is journalled before it takes effect.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, rmSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Socket } from "bun";

export const RECOVER_DIR = "recover";
export const RECOVER_SOCKET = "recover.sock";
const REQUEST_MAX_BYTES = 64 * 1024;

export type RecoveryRefusal = "windows" | "state_dir_unsafe" | "recover_dir_unsafe" | "socket_unsafe";

const ownUid = () => process.getuid?.() ?? -1;

function stateDirSafe(stat: Stats, owner: number): boolean {
  const sticky = (stat.mode & 0o1000) !== 0;
  return stat.isDirectory() && !stat.isSymbolicLink() && (owner === ownUid() || owner === 0) && ((stat.mode & 0o022) === 0 || sticky);
}

function recoverDirSafe(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === ownUid() && (stat.mode & 0o777) === 0o700;
}

function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); } catch { return null; }
}

interface Connection { buffered: string; answered: boolean; reply?: Uint8Array }

function writeReply(socket: Socket<Connection>): void {
  const reply = socket.data.reply;
  if (reply === undefined) return;
  const written = socket.write(reply);
  if (written >= 0 && written < reply.byteLength) {
    socket.data.reply = reply.subarray(written);
    return;
  }
  socket.data.reply = undefined;
  socket.end();
}

/**
 * Opens `<stateDir>/recover/recover.sock`. Each connection sends one JSON line and gets one JSON line back from
 * `handle`; anything else is closed with no answer.
 */
export function openRecoverySocket(options: {
  stateDir: string;
  handle(request: unknown): Promise<unknown>;
  platform?: NodeJS.Platform;
  /** the state folder's owner, from its lstat unless a test says otherwise */
  ownerOf?: (stat: Stats) => number;
}): { path: string; stop(): void } | { refused: RecoveryRefusal } {
  if ((options.platform ?? process.platform) === "win32") return { refused: "windows" };
  const parent = lstatOrNull(options.stateDir);
  if (parent === null || !stateDirSafe(parent, (options.ownerOf ?? ((stat) => stat.uid))(parent))) return { refused: "state_dir_unsafe" };
  const dir = join(options.stateDir, RECOVER_DIR);
  if (lstatOrNull(dir) === null) mkdirSync(dir, { mode: 0o700 });
  const dirStat = lstatOrNull(dir);
  if (dirStat === null || !recoverDirSafe(dirStat)) return { refused: "recover_dir_unsafe" };
  const path = join(dir, RECOVER_SOCKET);
  const previous = lstatOrNull(path);
  if (previous !== null) {
    if (!previous.isSocket() || previous.uid !== ownUid()) return { refused: "socket_unsafe" };
    rmSync(path, { force: true });
  }
  const umask = process.umask(0o077);
  let listener: ReturnType<typeof Bun.listen<Connection>>;
  try {
    listener = Bun.listen<Connection>({ unix: path, socket: {
      open(socket) {
        socket.data = { buffered: "", answered: false };
        if (!stillSafe()) socket.end();
      },
      data(socket, chunk) {
        if (socket.data.answered) return;
        socket.data.buffered += chunk.toString();
        if (socket.data.buffered.length > REQUEST_MAX_BYTES) { socket.end(); return; }
        const newline = socket.data.buffered.indexOf("\n");
        if (newline < 0) return;
        socket.data.answered = true;
        void answer(socket, socket.data.buffered.slice(0, newline));
      },
      drain: writeReply,
    } });
    chmodSync(path, 0o600);
  } finally {
    process.umask(umask);
  }
  const bound = lstatSync(path);
  const stillSafe = () => {
    const nowDir = lstatOrNull(dir);
    const nowSocket = lstatOrNull(path);
    return nowDir !== null && recoverDirSafe(nowDir) && nowDir.ino === dirStat.ino
      && nowSocket !== null && nowSocket.isSocket() && nowSocket.ino === bound.ino && nowSocket.dev === bound.dev
      && nowSocket.uid === ownUid() && (nowSocket.mode & 0o777) === 0o600;
  };
  const answer = async (socket: Socket<Connection>, line: string) => {
    let request: unknown;
    try { request = JSON.parse(line); } catch { socket.end(); return; }
    let reply: unknown;
    try { reply = await options.handle(request); }
    catch (error) { reply = { error: error instanceof Error ? error.message : String(error) }; }
    socket.data.reply = new TextEncoder().encode(`${JSON.stringify(reply)}\n`);
    writeReply(socket);
  };
  return {
    path,
    stop() {
      listener.stop(true);
      const now = lstatOrNull(path);
      if (now !== null && now.ino === bound.ino) rmSync(path, { force: true });
    },
  };
}

/** One request to the recovery socket of `stateDir`, as `ovis recover` sends it. */
export function askRecovery(stateDir: string, request: unknown, timeoutSeconds?: number): Promise<unknown> {
  return askRecoverySocket(join(stateDir, RECOVER_DIR, RECOVER_SOCKET), request, timeoutSeconds);
}

/** One request to a recovery socket at `path`: this PC's own, or another PC's forwarded over SSH (server/machines.ts). */
export function askRecoverySocket(path: string, request: unknown, timeoutSeconds?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    let buffered = "";
    let settled = false;
    const settle = (error: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    Bun.connect({ unix: path, socket: {
      open(socket) {
        if (timeoutSeconds !== undefined) socket.timeout(timeoutSeconds);
        socket.write(`${JSON.stringify(request)}\n`);
      },
      data(_socket, chunk) {
        if (settled) return;
        buffered += decoder.decode(chunk, { stream: true });
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        try { settle(null, JSON.parse(buffered.slice(0, newline))); } catch (error) { settle(error as Error); }
      },
      close() { settle(new Error("The server answered nothing on its recovery socket")); },
      timeout() { settle(new Error("The recovery socket timed out")); },
      error(_socket, error) { settle(error); },
      connectError(_socket, error) { settle(error); },
    } }).catch((error: unknown) => settle(error instanceof Error ? error : new Error(String(error))));
  });
}

/** What the PC knows of a row for `ovis recover`: why it waits, and what stands against releasing it. */
export interface RecoveryCandidate {
  id: string;
  key: string;
  label: string;
  /** null: no `origin` written in this folder (a row a merge brought in) */
  origin: { from: string; how: string } | null;
  /** why it waits for a whole read, or null when it does not */
  waiting: "catching_up" | "held_by_age" | null;
  joinHold: boolean;
  held: boolean;
  openNotice: boolean;
  expired: boolean;
  /** a marker, a local Revoke or a tombstone covers its key */
  covered: boolean;
  /** a block or a freeze in force freezes its key */
  frozen: boolean;
  /** when this PC last saw the row, as its store keeps it */
  lastSeenAt: string | null;
}

export type ReleaseRefusal = "log_unreadable" | "not_waiting" | "no_origin" | "join_hold" | "held" | "notice_open" | "expired" | "removed" | "frozen";

/** Why `ovis recover --release` refuses a row, or null when it may release it. */
export function releaseRefusal(row: RecoveryCandidate, pc: { logReadable: boolean }): ReleaseRefusal | null {
  if (!pc.logReadable) return "log_unreadable";
  if (row.waiting === null) return "not_waiting";
  if (row.origin === null) return "no_origin";
  if (row.joinHold) return "join_hold";
  if (row.held) return "held";
  if (row.openNotice) return "notice_open";
  if (row.expired) return "expired";
  if (row.covered) return "removed";
  if (row.frozen) return "frozen";
  return null;
}

export type RecoveryJournalEntry =
  | { kind: "release"; release: string; rows: { id: string; key: string }[]; by: string }
  | { kind: "undo"; releases: string[]; rows: string[]; by: string };

export class ReleaseJournalError extends Error {}

/** A row under a release is not released again: the release it is under holds its sessions, and an undo ends them. */
export class AlreadyReleasedError extends Error {}

/** The releases `ovis recover` made since this start. */
export class RecoveryReleases {
  readonly #byRow = new Map<string, string>();
  readonly #watchers = new Map<string, Set<() => void>>();
  readonly #sources = new Set<() => readonly RecoveryCandidate[]>();
  readonly #journal: (entry: RecoveryJournalEntry) => void;

  constructor(options: { journal(entry: RecoveryJournalEntry): void }) {
    this.#journal = options.journal;
  }

  /** A store of rows (devices.json, the account rows) names the rows it holds back, with what stands against each. */
  registerRecoverySource(list: () => readonly RecoveryCandidate[]): () => void {
    this.#sources.add(list);
    return () => { this.#sources.delete(list); };
  }

  candidates(): RecoveryCandidate[] {
    return [...this.#sources].flatMap((list) => list());
  }

  /** `end` runs when `release` is undone: a session that signed in under it closes then. */
  watch(release: string, end: () => void): () => void {
    let watchers = this.#watchers.get(release);
    if (watchers === undefined) this.#watchers.set(release, watchers = new Set());
    watchers.add(end);
    return () => { watchers.delete(end); };
  }

  /** Releases `rows`, each already judged releasable; the journal entry is on disk first, or nobody is released. */
  release(rows: readonly Pick<RecoveryCandidate, "id" | "key">[], by: string): string {
    const again = rows.find((row) => this.#byRow.has(row.id));
    if (again !== undefined) throw new AlreadyReleasedError(`${again.id} is released already`);
    const release = randomBytes(8).toString("hex");
    try { this.#journal({ kind: "release", release, rows: rows.map(({ id, key }) => ({ id, key })), by }); }
    catch (error) { throw new ReleaseJournalError(`The release could not be journalled, so nothing was released: ${error instanceof Error ? error.message : String(error)}`); }
    for (const row of rows) this.#byRow.set(row.id, release);
    return release;
  }

  releaseOf(rowId: string): string | null {
    return this.#byRow.get(rowId) ?? null;
  }

  /**
   * Ends the releases `rowIds` were let in by, whole (every release when omitted), and closes the sessions that signed in
   * under them. A
   * narrowing: it takes effect whether or not its journal entry could be written, and a failed write is returned.
   */
  undo(rowIds: readonly string[] | undefined, by: string): { releases: string[]; journalError: Error | null } {
    const named = (rowIds ?? [...this.#byRow.keys()]).filter((id) => this.#byRow.has(id));
    const releases = new Set(named.map((id) => this.#byRow.get(id)!));
    const rows = [...this.#byRow].filter(([, release]) => releases.has(release)).map(([id]) => id);
    for (const id of rows) this.#byRow.delete(id);
    for (const release of releases) {
      const watchers = this.#watchers.get(release);
      this.#watchers.delete(release);
      for (const end of watchers ?? []) {
        try { end(); } catch (error) { console.error(`A session under an undone release did not close: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    let journalError: Error | null = null;
    try { this.#journal({ kind: "undo", releases: [...releases], rows, by }); }
    catch (error) { journalError = error instanceof Error ? error : new Error(String(error)); }
    return { releases: [...releases], journalError };
  }

  /** The first whole read judges every released row afresh: every release ends. */
  endAll(): void {
    this.#byRow.clear();
    this.#watchers.clear();
  }
}
