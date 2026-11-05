/**
 * Earlier sessions of a folder, read from each agent's own store, newest first (#1314).
 *
 * Bounded by the #1147 rules: at most the first 64 KiB of non-Pi files is read. Pi alone uses the
 * asynchronous bounded streaming reader in pi-session-metadata.ts (its work/deadline policy
 * is documented there), to find late names and prompts without retaining history. At most 65536 directory
 * entries are walked per listing (taken or passed over) and at most 16384 lstats time the entries
 * taken (a session file one, a Grok session folder three), and the entries taken are all ordered by
 * time before any is checked, so the newest of them are checked first whatever the readdir order (a
 * folder past those bounds is seen as far as its readdir order reaches); at most
 * 400 checks are made per listing, a
 * check being one session file's resolution with its stat (spent whatever the resolution finds),
 * or one resolution or stat of a store, a folder or a database; at most 50 rows are returned, and
 * every path is resolved
 * (realpath) and refused when it lands outside the agent's store, nested subagent files
 * included: only a store's own session files are listed, never a file a link makes look like
 * one. SQLite stores are opened read-only and asked for at most 50 sessions, their text cut in
 * the query. Nothing here starts an agent or loads a whole transcript into memory.
 *
 * A row's first message is prompt text: the route returns it only to a connection that may
 * drive (session-history-routes.ts), and it is never logged.
 */
import { constants as sqliteConstants, Database } from "bun:sqlite";
import { closeSync, constants, fstat, fstatSync, lstatSync, opendirSync, open, openSync, readSync, realpathSync, statSync, type BigIntStats, type Dir, type Dirent, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { SessionHistoryAgent, SessionHistoryRow } from "../shared/protocol.ts";
import { agyUserText } from "./agy.ts";
import { claudeProjectDir } from "./claude-store.ts";
import { cmdSlug } from "./cmd.ts";
import { grokSessionGroups } from "./grok-store.ts";
import { directoryKey, interactiveCodexRollout, storedCwds, withoutVerbatimPrefix } from "./codex.ts";
import { hermesHome } from "./hermes-home.ts";
import { opencodeDatabasePath } from "./opencode.ts";
import { environmentHome } from "./user-home.ts";
import { defaultPiSessionReader, PI_CACHE_ENTRIES, PI_HEADER_DEADLINE_MS, PiMetadataBusy, PiMetadataDeadline, type PiSessionReader } from "./pi-session-metadata.ts";
import type { PiLabel } from "./pi-session-label.ts";

/** At most this much of any one non-Pi file is read. */
export const HEAD_BYTES = 64 * 1024;
/**
 * At most this many checks for one listing. A check is one session file's resolution with its stat
 * (spent even when the resolution fails or lands outside the store), or one resolution or stat of a
 * store, a folder or a database. A listing's per-candidate lstats are bounded by MAX_ENTRIES instead.
 */
export const MAX_STATS = 400;
/**
 * At most this many times are taken for one listing, every folder's together: one lstat for each
 * session file taken, three for a Grok session folder (its two files, else itself), none for a
 * Codex day folder. None of these is a check. Bun's opendirSync still reads a whole folder from the
 * kernel before any of it.
 */
export const MAX_ENTRIES = 16384;
/**
 * At most this many directory entries are walked for one listing, every folder's together, taken or
 * passed over (Claude's per-session folders, say): passed-over entries cost the walk, not MAX_ENTRIES.
 */
export const MAX_WALK = 65536;
/** At most this many sessions are returned. */
export const MAX_ROWS = 50;
const TITLE_CHARS = 200;
const MESSAGE_CHARS = 2000;
const BUSY_TIMEOUT_MS = 250;

export const SESSION_HISTORY_AGENTS = ["claude", "codex", "pi", "omp", "gjc", "cmd", "omo", "opencode", "hermes", "grok", "agy", "devin"] as const satisfies readonly SessionHistoryAgent[];

export function isSessionHistoryAgent(value: string): value is SessionHistoryAgent {
  return (SESSION_HISTORY_AGENTS as readonly string[]).includes(value);
}

export interface SessionHistoryOptions {
  /** The user's home; defaults to this process's. */
  home?: string;
  /** The environment the stores are found by; defaults to this process's. */
  env?: Record<string, string | undefined>;
  /** Explicit stores, as the server's own options name them. */
  codexHome?: string;
  opencodeDb?: string;
  hermesHome?: string;
  /** Pi's streaming reader and bounded stat-keyed label cache; createServer owns and closes one. */
  piReader?: PiSessionReader;
  /** Reads at most `max` bytes from the start of a checked non-Pi file (tests count bytes): descriptor only. */
  readHead?: (fd: number, max: number) => Buffer;
  /** Stats a path the listing looks at (tests count the calls). */
  stat?: (path: string, bigint?: boolean) => Stats | BigIntStats;
  /** Resolves a path the listing looks at (tests count the calls); defaults to realpathSync. */
  resolve?: (path: string) => string;
  /** A listed entry's own time, its link not followed (tests count the calls); defaults to lstatSync. */
  lstat?: (path: string) => Stats;
  /** Stats an opened file's descriptor (tests change the identity it reports); defaults to fstatSync. */
  fstat?: (fd: number, bigint?: boolean) => Stats | BigIntStats;
  /** Called right after a store's database opens, before it is read (tests write to the store then). */
  opened?: (path: string, immutable: boolean, db: Database) => void;
  /** Opens a folder to walk its entries (tests count the entries walked); defaults to opendirSync. */
  opendir?: (dir: string) => Dir;
  /** Checks already spent when the listing starts (tests place a check at the bound). */
  spent?: number;
  /** The OS whose folder rules apply; defaults to this one's (tests take Windows's on any OS). */
  platform?: NodeJS.Platform;
  /** Resolves a Windows cwd to its canonical long form (tests map an 8.3 alias); defaults to realpathSync.native. */
  realpath?: (path: string) => string;
  /** The temp folder omp keys sessions below; defaults to os.tmpdir(). */
  tmpdir?: string;
}

/** A session id safe to put after a flag: it cannot be read as another option. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

/**
 * How each agent reopens one session by id, verified before it was enabled. argv[0] is the
 * agent kind herdr's manifest launches; the rest are its arguments.
 */
const RESUME: Record<SessionHistoryAgent, (id: string) => string[]> = {
  // https://code.claude.com/docs/en/cli-reference: `--resume`, `-r` "Resume a specific session by ID or name"
  claude: (id) => ["claude", "--resume", id],
  // server/codex.ts:1049 (resumedThread reads `codex resume <thread>`); https://learn.chatgpt.com/docs/developer-commands
  // "`codex resume` Continue an interactive session by ID"
  codex: (id) => ["codex", "resume", id],
  // @earendil-works/pi-coding-agent 0.86.0 README.md:251: `pi --session <path|id> # Use specific session file or ID`
  pi: (id) => ["pi", "--session", id],
  // @oh-my-pi/pi-coding-agent 17.4.1 CHANGELOG.md:158 and :976: `omp --resume <id>`
  omp: (id) => ["omp", "--resume", id],
  // gajae-code (https://github.com/Yeachan-Heo/gajae-code), its docs embedded in the gjc build of
  // 2026-10-18: "### `--resume <value>`", and its exit banner prints `gjc --resume <id>`
  gjc: (id) => ["gjc", "--resume", id],
  // https://commandcode.ai/docs/reference/cli: "`--session <path|id>` Resume a session by transcript
  // path (`.jsonl`) or a unique session-id prefix"
  cmd: (id) => ["cmd", "--session", id],
  // omo-ai 5.1.38, node_modules/@code-yeongyu/senpi/dist/cli/args.js:389: "`--session-id <id>` Use
  // exact project session ID"; server/omo.ts:313 reads the same flag from a running omo
  omo: (id) => ["omo", "--session-id", id],
  // https://opencode.ai/docs/cli/: `--session`, `-s` "Session ID to continue"
  opencode: (id) => ["opencode", "--session", id],
  // hermes-agent 354724fb085162678964c116ceb4c40fc57c717c, hermes_cli/_parser.py:98:
  // "hermes --resume <session_id>  Resume a specific session by ID"
  hermes: (id) => ["hermes", "--resume", id],
  // https://docs.x.ai/build/features/sessions: "grok --resume <session-id>   # a specific session"
  grok: (id) => ["grok", "--resume", id],
  // https://antigravity.google/docs/cli/commands/resume: "agy --conversation <conversation-id>"
  agy: (id) => ["agy", "--conversation", id],
  // server/conversation.ts:1455-1459 (devinSessionForPane reads `--resume <id>` / `--resume=<id>`)
  devin: (id) => ["devin", "--resume", id],
};

type Row = SessionHistoryRow;
type Json = Record<string, unknown>;
const record = (value: unknown): Json => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const str = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value : null;
const clip = (value: string | null, max: number): string | null => {
  if (value === null) return null;
  const text = value.trim();
  return text === "" ? null : text.length > max ? `${text.slice(0, max)}…` : text;
};

function iso(value: unknown, unit: "ms" | "s" = "ms"): string | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const date = new Date(unit === "s" ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value !== "") {
    // `2026-07-29 23:09:40.970073289+00:00`: a space for the T, nanoseconds JS does not parse
    const normal = value.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
    const time = Date.parse(normal);
    return Number.isNaN(time) ? null : new Date(time).toISOString();
  }
  return null;
}

function row(agent: SessionHistoryAgent, id: string, fields: { title?: string | null; firstMessage?: string | null; startedAt?: string | null; updatedAt: string }): Row {
  return {
    id,
    title: clip(fields.title ?? null, TITLE_CHARS),
    firstMessage: clip(fields.firstMessage ?? null, MESSAGE_CHARS),
    startedAt: fields.startedAt ?? null,
    updatedAt: fields.updatedAt,
    resume: SAFE_ID.test(id) ? { argv: RESUME[agent](id) } : null,
  };
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return str(content);
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((part) => {
    const value = record(part);
    return (value.type === "text" || value.type === "input_text") && typeof value.text === "string" ? [value.text] : [];
  });
  return str(texts.join("\n"));
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

/** A file identity field as bigint (a stat taken without bigint gives a number). */
const bigintOf = (value: number | bigint): bigint => typeof value === "bigint" ? value : BigInt(value);

/** At most `max` bytes from the start of an open file. */
function defaultReadHead(fd: number, max: number): Buffer {
  const buffer = Buffer.alloc(max);
  const length = readSync(fd, buffer, 0, max, 0);
  return buffer.subarray(0, length);
}

/**
 * The checked file, opened: O_NONBLOCK, so a FIFO put where a file was is not waited on; O_NOFOLLOW,
 * so a link put there since the check is not followed; and the file opened must be the one checked
 * (a folder above it swapped for a link reaches another file by the same path). A reader gets only
 * this descriptor, so none can read another file.
 */
function openChecked(budget: Budget, file: { real: string; dev: bigint; ino: bigint }): number {
  const fd = openSync(file.real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = budget.fstatOf(fd, true);
    if (!opened.isFile() || bigintOf(opened.dev) !== file.dev || bigintOf(opened.ino) !== file.ino) throw new Error("not the file that was checked");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

const defaultFstat = (fd: number, bigint?: boolean): Stats | BigIntStats => bigint ? fstatSync(fd, { bigint: true }) : fstatSync(fd);

/** Pi opens and checks asynchronously too; custom fstat seams stay on the test's calling thread. */
async function openPiChecked(budget: Budget, file: Found, checkActive: () => void): Promise<number | null> {
  const fd = await new Promise<number | null>((done, fail) => open(file.real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0), (error, fd) => {
    if (error?.code === "ELOOP") done(null);
    else if (error) fail(error);
    else done(fd);
  }));
  if (fd === null) return null;
  try {
    checkActive();
    const opened = budget.fstatOf !== defaultFstat ? budget.fstatOf(fd, true)
      : await new Promise<BigIntStats>((done, fail) => fstat(fd, { bigint: true }, (error, stat) => error ? fail(error) : done(stat)));
    checkActive();
    if (!opened.isFile() || bigintOf(opened.dev) !== file.dev || bigintOf(opened.ino) !== file.ino) { closeSync(fd); return null; }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/**
 * One listing's bounds: every check of a path (store, folder, file or database), a resolution or a
 * stat, counts against MAX_STATS whatever it finds, and every directory entry read against MAX_ENTRIES.
 */
class Budget {
  used = 0;
  entries = 0;
  walked = 0;
  constructor(
    private readonly statOf: (path: string, bigint?: boolean) => Stats | BigIntStats,
    readonly platform: NodeJS.Platform,
    private readonly resolveOf: (path: string) => string = realpathSync,
    private readonly lstatOf: (path: string) => Stats = lstatSync,
    readonly fstatOf: (fd: number, bigint?: boolean) => Stats | BigIntStats = defaultFstat,
    private readonly opendirOf: (dir: string) => Dir = opendirSync,
    readonly onOpened: (path: string, immutable: boolean, db: Database) => void = () => {},
  ) {}

  get exhausted(): boolean { return this.used >= MAX_STATS; }

  stat(path: string): Stats | null {
    if (this.exhausted) return null;
    this.used++;
    try { return this.statOf(path) as Stats; } catch { return null; }
  }

  /**
   * A file's stat with its identity in bigint, as one counted check; null once spent, or when it is
   * gone. `again`: the same file's identity once more, part of the check already made, not another.
   */
  identity(path: string, again = false): { isFile: boolean; dev: bigint; ino: bigint } | null {
    if (!again) {
      if (this.exhausted) return null;
      this.used++;
    }
    try { const stat = this.statOf(path, true); return { isFile: stat.isFile(), dev: bigintOf(stat.dev), ino: bigintOf(stat.ino) }; } catch { return null; }
  }

  /** The path resolved (realpath), as one counted check; null once spent, or when it does not resolve. */
  resolve(path: string): string | null {
    if (this.exhausted) return null;
    this.used++;
    try { return this.resolveOf(path); } catch { return null; }
  }

  /**
   * A session file, as one check: its resolution, and its stat once it resolves inside `root`. The
   * check is spent whatever the resolution finds (a dangling or outside link costs it too).
   */
  file(path: string, root: string): { real: string; stat: Stats | BigIntStats } | null {
    if (this.exhausted) return null;
    this.used++;
    let real: string;
    try { real = this.resolveOf(path); } catch { return null; }
    if (!inside(root, real)) return null;
    // bigint: an NTFS file ID can pass 2^53, and two that differ only in their low bits round to one number
    try { return { real, stat: this.statOf(real, true) }; } catch { return null; }
  }

  /**
   * A folder's entries that `keep` takes (decided from the entry alone: its name and type), unordered,
   * as many as the listing has left. Every entry walked counts against MAX_WALK, taken or passed over
   * (a Claude session's folder of subagent transcripts, say); a taken one reserves `lstats` of
   * MAX_ENTRIES for the times taken of it later. None for an unreadable folder.
   */
  list(dir: string, keep: (entry: Dirent) => boolean = () => true, lstats = 0): Dirent[] {
    const found: Dirent[] = [];
    let handle: Dir | undefined;
    try {
      handle = this.opendirOf(dir);
      while (this.walked < MAX_WALK) {
        const entry = handle.readSync();
        if (entry === null) break;
        this.walked++;
        if (!keep(entry)) continue;
        if (this.entries + lstats > MAX_ENTRIES) break;
        this.entries += lstats;
        found.push(entry);
      }
    } catch { /* an unreadable folder lists nothing */ }
    finally { try { handle?.closeSync(); } catch { /* already closed */ } }
    return found;
  }

  /** A listed entry's own modification time, its link not followed; null when it is gone. */
  modified(path: string): number | null {
    try { return this.lstatOf(path).mtimeMs; } catch { return null; }
  }

  /**
   * Whether two cwds are one folder, as codex.ts sameDirectory decides, with its Windows file-ID
   * check (bigint: two 64-bit IDs can round to one number) taken from this budget.
   */
  /** The canonical form of a path (Windows long names), as one counted stat; the path itself when it cannot say. */
  canonical(path: string, realpath: (path: string) => string): string {
    if (this.exhausted) return path;
    this.used++;
    try { return realpath(path); } catch { return path; }
  }

  sameFolder(left: string, right: string): boolean {
    if (directoryKey(left) === directoryKey(right)) return true;
    // one Windows folder in two spellings needs no file IDs; the letter case still does (#587)
    if (this.platform === "win32" && windowsFolder(left) === windowsFolder(right)) return true;
    if (this.platform !== "win32" || this.used + 2 > MAX_STATS) return false;
    this.used += 2;
    try {
      const a = this.statOf(left, true);
      const b = this.statOf(right, true);
      return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
    } catch { return false; }
  }
}

/** A store being read: its resolved root, the listing's budget, and how files are read. */
class Scan {
  constructor(readonly root: string, readonly budget: Budget, private readonly reader: (fd: number, max: number) => Buffer) {}

  get exhausted(): boolean { return this.budget.exhausted; }

  /** The file at this path, resolved, when it is a regular file inside the store. */
  file(path: string): Found | null {
    const checked = this.budget.file(path, this.root);
    if (checked === null || !checked.stat.isFile()) return null;
    const { real, stat } = checked;
    return { real, mtimeMs: Number(stat.mtimeMs), size: Number(stat.size), dev: bigintOf(stat.dev), ino: bigintOf(stat.ino) };
  }

  /** At most HEAD_BYTES of a resolved file, split in lines; `cut` when the file goes on past them. */
  head(file: Found): { lines: string[]; cut: boolean } {
    let head: Buffer;
    try {
      const fd = openChecked(this.budget, file);
      try { head = this.reader(fd, HEAD_BYTES); } finally { closeSync(fd); }
    } catch { return { lines: [], cut: false }; }
    return { lines: head.toString("utf8").split("\n"), cut: head.length >= HEAD_BYTES && file.size > head.length };
  }

  /** The complete lines of the head: a cut last line is no record. */
  lines(file: Found): string[] {
    const { lines, cut } = this.head(file);
    return cut ? lines.slice(0, -1) : lines;
  }

  records(file: Found): Json[] {
    return this.lines(file).flatMap((line) => {
      if (line.trim() === "") return [];
      try { return [record(JSON.parse(line))]; } catch { return []; }
    });
  }
}

function storeRoot(budget: Budget, path: string): string | null {
  if (!budget.stat(path)?.isDirectory()) return null;
  return budget.resolve(path);
}

function scanOf(budget: Budget, path: string, read: SessionHistoryOptions["readHead"]): Scan | null {
  const root = storeRoot(budget, path);
  return root === null ? null : new Scan(root, budget, read ?? defaultReadHead);
}

/** These folders' entries newest first by their own times (a link not followed), within the listing's entry bound. */
function newestEntries(budget: Budget, dirs: readonly string[], keep: (entry: Dirent) => boolean, lstats = 1, timeOf: (path: string) => number | null = (path) => budget.modified(path)): string[] {
  return dirs.flatMap((dir) => budget.list(dir, keep, lstats).flatMap((entry) => {
    const path = join(dir, entry.name);
    const time = timeOf(path);
    return time === null ? [] : [{ path, time }];
  })).sort((a, b) => b.time - a.time).map((entry) => entry.path);
}

type Found = { real: string; mtimeMs: number; size: number; dev: bigint; ino: bigint };

/**
 * The `.jsonl` files directly in these directories (subagent folders beside them are not read), newest
 * first. They are ordered by their own times before any is checked, so the checks go to the newest:
 * a name (Claude's is a random id) says nothing of when a session was written.
 */
function sessionFiles(scan: Scan, dirs: readonly string[]): Found[] {
  const found = new Map<string, Found>();
  for (const path of newestEntries(scan.budget, [...new Set(dirs)], (entry) => entry.name.endsWith(".jsonl"))) {
    if (scan.exhausted) break;
    const file = scan.file(path);
    if (file) found.set(file.real, file);
  }
  return [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function rowsOf(files: readonly Found[], read: (file: Found) => Row | null): Row[] {
  const rows: Row[] = [];
  for (const file of files) {
    if (rows.length >= MAX_ROWS) break;
    const found = read(file);
    if (found) rows.push(found);
  }
  return rows;
}

/* ---------------------------------------------------------------------------------------------
 * pi and its descendants (omp, gjc, omo, Command Code): a `session` header with id, timestamp and
 * cwd (gjc may put a `title` line before it), then `message` lines.
 * ------------------------------------------------------------------------------------------- */

/** pi's folder for a cwd (pi-coding-agent 0.86.0 dist/core/session-manager.js:248), which senpi (omo) keeps. */
export function piSessionFolder(cwd: string, platform: NodeJS.Platform = process.platform): string {
  return `--${(platform === "win32" ? win32.resolve(cwd) : resolve(cwd)).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * omp's folders for a cwd (@oh-my-pi/pi-coding-agent 17.4.1 src/session/session-paths.ts:62-90): a
 * folder below home is `-<relative>`, below the temp dir `-tmp-<relative>`, anywhere else pi's legacy
 * name, which older sessions keep. gjc lays its store out alike. omp compares canonical paths, so each
 * of the cwd, home and temp dir comes in every spelling the listing knows (given and canonical: a
 * Windows TEMP is often an 8.3 alias of the folder the pane opens), and every combination is a key.
 */
export function ompSessionFolders(cwds: readonly string[], homes: readonly string[], temps: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  const paths = platform === "win32" ? win32 : posix;
  const under = (prefix: string, base: string, target: string): string | null => {
    const rel = paths.relative(base, target);
    if (rel !== "" && (rel.startsWith("..") || paths.isAbsolute(rel))) return null;
    const encoded = rel.replace(/[/\\:]/g, "-");
    return encoded ? (prefix.endsWith("-") ? `${prefix}${encoded}` : `${prefix}-${encoded}`) : prefix;
  };
  const keys = cwds.flatMap((target) => [
    ...homes.map((base) => under("-", base, target)),
    ...temps.map((base) => under("-tmp", base, target)),
    piSessionFolder(target, platform),
  ]);
  return [...new Set(keys.filter((key): key is string => key !== null))];
}

/**
 * The header versions pi's format has had: none (1), 2 and 3 (pi-coding-agent 0.86.0
 * dist/core/session-manager.js:77-83 migrates them; pi, omp 17.4.1 src/session/session-entries.ts:6
 * and senpi dist/core/session-manager.js:108 write CURRENT_SESSION_VERSION = 3). Any other layout
 * is not one this reader knows, so it lists nothing from it.
 */
const PI_VERSIONS = new Set<unknown>([undefined, 1, 2, 3]);

function piFamilyRow(agent: SessionHistoryAgent, scan: Scan, file: Found, cwds: readonly string[], idFromName: boolean): Row | null {
  const records = scan.records(file);
  const header = records.find((value) => value.type === "session");
  if (!header || !PI_VERSIONS.has(header.version)) return null;
  const headerCwd = str(header.cwd);
  if (headerCwd === null || !cwdMatches(scan.budget, headerCwd, cwds)) return null;
  const id = str(header.id) ?? (idFromName ? basename(file.real, ".jsonl") : null);
  if (id === null) return null;
  let title: string | null = null;
  let firstMessage: string | null = null;
  for (const value of records) {
    if (value.type === "title") title = str(value.title) ?? title;
    else if (value.type === "session_info") title = str(value.name) ?? title;
    else if (firstMessage === null && value.type === "message") {
      const message = record(value.message);
      if (message.role === "user") firstMessage = textOf(message.content);
    }
  }
  return row(agent, id, { title, firstMessage, startedAt: iso(header.timestamp), updatedAt: new Date(file.mtimeMs).toISOString() });
}

async function piSessions(sessions: string, folders: readonly string[], cwds: readonly string[], budget: Budget, reader: PiSessionReader): Promise<Row[]> {
  const scan = scanOf(budget, sessions, undefined);
  const directories = folders.map((folder) => join(sessions, folder));
  const files = scan === null ? [] : sessionFiles(scan, directories);
  const scope = JSON.stringify(directories.map((directory) => resolve(directory)));
  reader.retain(scope, files.map((file) => file.real));
  if (scan === null) return [];
  const deadline = performance.now() + reader.listingDeadlineMs;
  const headerDeadline = performance.now() + Math.max(PI_HEADER_DEADLINE_MS, reader.listingDeadlineMs);
  const rows: Row[] = [];
  const selected: Array<{ index: number; file: Found; header: NonNullable<PiLabel["header"]> }> = [];
  let incomplete = false;
  let unfinishedHeaders = 0;
  let cacheTouches = 0;
  const headerCacheLimit = Math.floor(PI_CACHE_ENTRIES * 3 / 4);
  // Establish rows before a large transcript can consume the label budget. Header work has
  // both byte and elapsed-time bounds; an unknown header must never imply an empty store.
  for (const file of files) {
    // Every retained entry touch counts, with a quarter of the cache capacity left in reserve.
    // Label scans revisit this same set, so one traversal cannot evict its own checkpoints.
    if (rows.length >= MAX_ROWS) break;
    if (unfinishedHeaders >= MAX_ROWS || cacheTouches >= headerCacheLimit) { incomplete = true; break; }
    let rejected = false;
    let retainedHeaderless = false;
    try {
      const label = await reader.read((checkActive) => openPiChecked(budget, file, checkActive), headerDeadline, {
        path: file.real, scope,
        headerless: () => { retainedHeaderless = true; },
        // Reject ineligible headers before caching them, and spend folder-identity checks once.
        acceptHeader: (header) => {
          rejected = !PI_VERSIONS.has(header.version) || header.id === "" || header.cwd === "" || !cwdMatches(budget, header.cwd, cwds);
          return !rejected;
        },
      }, "header");
      const header = label?.header;
      if (label && header) {
        rows.push(row("pi", header.id, { title: label.title, firstMessage: label.firstMessage, startedAt: iso(header.timestamp), updatedAt: new Date(file.mtimeMs).toISOString() }));
        // A row already labelled is complete; rescanning it would spend the label deadline
        // ahead of the unfinished rows after it on every open.
        if (label.title === null && label.firstMessage === null) selected.push({ index: rows.length - 1, file, header });
      } else if (label) { incomplete = true; unfinishedHeaders++; }
      else rejected = !retainedHeaderless;
    } catch (error) {
      if (!(error instanceof PiMetadataBusy) || error.reason === "stopped" || error.reason === "queue") throw error;
      incomplete = true;
    } finally {
      // Only rejected and single-chunk headerless files are uncached and free.
      if (!rejected) cacheTouches++;
    }
  }
  if (rows.length === 0 && incomplete) throw new PiMetadataBusy();
  // A slow header pass must not starve labels on every open: keep a quarter of the listing
  // deadline for label reads, so each listing still makes bounded progress.
  const labelDeadline = Math.max(deadline, performance.now() + reader.listingDeadlineMs / 4);
  for (const { index, file, header: checked } of selected) {
    try {
      const label = await reader.read((checkActive) => openPiChecked(budget, file, checkActive), labelDeadline, { path: file.real, scope });
      const header = label?.header;
      // The header pass already proved eligibility, even if it spent the last identity checks.
      // A changed identity must not replace that established row during this listing.
      if (!label || !header || header.id !== checked.id || header.cwd !== checked.cwd || header.version !== checked.version) continue;
      rows[index] = row("pi", header.id, { title: label.title, firstMessage: label.firstMessage, startedAt: iso(header.timestamp), updatedAt: new Date(file.mtimeMs).toISOString() });
    } catch (error) {
      if (!(error instanceof PiMetadataBusy) || error.reason === "stopped") throw error;
      if (error instanceof PiMetadataDeadline || error.reason === "queue") break;
    }
  }
  return rows;
}

function piFamily(agent: SessionHistoryAgent, sessions: string, folders: readonly string[], cwds: readonly string[], budget: Budget, read: SessionHistoryOptions["readHead"], idFromName = false): Row[] {
  const scan = scanOf(budget, sessions, read);
  if (scan === null) return [];
  const files = sessionFiles(scan, folders.map((folder) => join(sessions, folder)));
  return rowsOf(files, (file) => piFamilyRow(agent, scan, file, cwds, idFromName));
}

/* ---------------------------------------------------------------------------------------------
 * Claude Code: `<config dir>/projects/<project>/<session uuid>.jsonl` (claude-store.ts).
 * ------------------------------------------------------------------------------------------- */

const CLAUDE_SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What Claude Code records as a user line that is no prompt: a slash command's echo, its output, a caveat. */
const CLAUDE_NOT_PROMPT = /^<(?:command-|local-command-)|^Caveat: /;

function claudeRow(scan: Scan, file: Found, cwds: readonly string[]): Row | null {
  const id = basename(file.real, ".jsonl");
  if (!CLAUDE_SESSION.test(id)) return null;
  const records = scan.records(file);
  let seenCwd: string | null = null;
  let title: string | null = null;
  let firstMessage: string | null = null;
  let startedAt: string | null = null;
  for (const value of records) {
    seenCwd ??= str(value.cwd);
    startedAt ??= iso(value.timestamp);
    title = str(value.customTitle) ?? str(value.aiTitle) ?? (value.type === "summary" ? str(value.summary) : null) ?? title;
    if (firstMessage === null && value.type === "user" && value.isMeta !== true && value.isSidechain !== true) {
      const text = textOf(record(value.message).content);
      if (text !== null && !CLAUDE_NOT_PROMPT.test(text)) firstMessage = text;
    }
  }
  // the project folder's name is lossy (`a_b` and `a-b` share it): a recorded cwd decides
  if (seenCwd !== null && !cwdMatches(scan.budget, seenCwd, cwds)) return null;
  return row("claude", id, { title, firstMessage, startedAt, updatedAt: new Date(file.mtimeMs).toISOString() });
}

function claudeSessions(cwds: readonly string[], home: string, env: Record<string, string | undefined>, budget: Budget, read: SessionHistoryOptions["readHead"]): Row[] {
  const projects = join(env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"), "projects");
  const scan = scanOf(budget, projects, read);
  if (scan === null) return [];
  return rowsOf(sessionFiles(scan, cwds.map((cwd) => join(projects, claudeProjectDir(cwd)))), (file) => claudeRow(scan, file, cwds));
}

/* ---------------------------------------------------------------------------------------------
 * Codex: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl`, a `session_meta` first line.
 * ------------------------------------------------------------------------------------------- */

function codexRow(scan: Scan, file: Found, cwds: readonly string[]): Row | null {
  const { lines, cut } = scan.head(file);
  // a header the read cut is not listed: a child marker past the read could not be checked
  if (cut && lines.length < 2) return null;
  const records = cut ? lines.slice(1, -1) : lines.slice(1);
  let header: Json;
  try {
    const parsed = record(JSON.parse(lines[0]!));
    // interactive threads only, by the rule codex.ts reads them with
    if (parsed.type !== "session_meta" || !interactiveCodexRollout(parsed.payload, basename(file.real))) return null;
    header = record(parsed.payload);
  } catch { return null; }
  const id = str(header.id);
  const sessionCwd = str(header.cwd);
  const startedAt = iso(header.timestamp);
  if (id === null || sessionCwd === null || !cwdMatches(scan.budget, sessionCwd, cwds)) return null;
  let firstMessage: string | null = null;
  for (const line of records) {
    try {
      const value = record(JSON.parse(line));
      const payload = record(value.payload);
      if (value.type === "event_msg" && payload.type === "user_message") { firstMessage = str(payload.message); break; }
    } catch { /* not a record */ }
  }
  return row("codex", id, { firstMessage, startedAt, updatedAt: new Date(file.mtimeMs).toISOString() });
}

function codexSessions(cwds: readonly string[], codexHome: string, budget: Budget, read: SessionHistoryOptions["readHead"]): Row[] {
  const sessions = join(codexHome, "sessions");
  const scan = scanOf(budget, sessions, read);
  if (scan === null) return [];
  const desc = (dir: string) => budget.list(dir, (entry) => /^\d+$/.test(entry.name)).map((entry) => entry.name).sort().reverse();
  // newest day first, so the files looked at are the newest ones
  const files: Found[] = [];
  walk: for (const year of desc(sessions)) {
    for (const month of desc(join(sessions, year))) {
      for (const day of desc(join(sessions, year, month))) {
        if (scan.exhausted) break walk;
        files.push(...sessionFiles(scan, [join(sessions, year, month, day)]));
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rowsOf(files, (file) => codexRow(scan, file, cwds));
}

/* ---------------------------------------------------------------------------------------------
 * Grok: `$GROK_HOME/sessions/<group>/<session>/summary.json` with `info.{id,cwd}`, and the prompts in
 * `updates.jsonl` beside it. A group is the cwd URI-encoded or, for a long one, a native hashed name
 * (https://docs.x.ai/build/features/sessions: "keyed by working directory"); the groups are listed as
 * grok-store.ts lists them, and each session's own `info.cwd` decides.
 * ------------------------------------------------------------------------------------------- */

/** Whether a recorded cwd is one of the pane's spellings: free when spelled alike, else one counted identity check. */
function cwdMatches(budget: Budget, recorded: string, cwds: readonly string[]): boolean {
  return cwds.some((cwd) => directoryKey(recorded) === directoryKey(cwd) || (budget.platform === "win32" && windowsFolder(recorded) === windowsFolder(cwd)))
    || budget.sameFolder(recorded, cwds.at(-1)!);
}

function grokRow(scan: Scan, dir: string, cwds: readonly string[]): Row | null {
  const summaryFile = scan.file(join(dir, "summary.json"));
  if (!summaryFile) return null;
  let summary: Json;
  try { summary = record(JSON.parse(scan.lines(summaryFile).join("\n"))); } catch { return null; }
  const info = record(summary.info);
  const id = str(info.id);
  const sessionCwd = str(info.cwd);
  if (id === null || sessionCwd === null || !cwdMatches(scan.budget, sessionCwd, cwds)) return null;
  let firstMessage: string | null = null;
  const updates = scan.file(join(dir, "updates.jsonl"));
  if (updates) {
    const chunks: string[] = [];
    for (const value of scan.records(updates)) {
      const update = record(record(value.params).update);
      if (update.sessionUpdate === "user_message_chunk") {
        const text = record(update.content).text;
        if (typeof text === "string") chunks.push(text);
      } else if (chunks.length > 0) break;
    }
    firstMessage = str(chunks.join(""));
  }
  const updatedAt = iso(summary.updated_at) ?? iso(summary.last_active_at) ?? new Date(summaryFile.mtimeMs).toISOString();
  return row("grok", id, { title: str(summary.generated_title) ?? str(summary.session_summary), firstMessage, startedAt: iso(summary.created_at), updatedAt });
}

function grokSessions(cwds: readonly string[], home: string, env: Record<string, string | undefined>, budget: Budget, read: SessionHistoryOptions["readHead"]): Row[] {
  const grokHome = env["GROK_HOME"] || join(home, ".grok");
  const scan = scanOf(budget, join(grokHome, "sessions"), read);
  if (scan === null) return [];
  // a session's folder keeps its time while the session writes to its files: the newest of its two
  // files says when it was last written (two lstats, not checks), the folder's own time without them
  const written = (dir: string): number | null => {
    const times = ["summary.json", "updates.jsonl"].map((name) => budget.modified(join(dir, name))).filter((time): time is number => time !== null);
    return times.length > 0 ? Math.max(...times) : budget.modified(dir);
  };
  const sessionDirs = (group: string): string[] => {
    // newest first, within the listing's entry bound, so the checks go to the newest sessions
    // up to three lstats each: its two files, else the folder itself
    return newestEntries(budget, [join(scan.root, group)], (entry) => entry.isDirectory(), 3, written);
  };
  const rows: Row[] = [];
  const readGroup = (group: string, dirs: readonly string[] = sessionDirs(group)) => {
    for (const dir of dirs) {
      if (scan.exhausted) break;
      const found = grokRow(scan, dir, cwds);
      if (found) rows.push(found);
    }
  };
  // the cwd's own group is known by name: read it whatever else the store holds
  const encoded = new Set(cwds.map((spelling) => encodeURIComponent(spelling)));
  for (const group of encoded) readGroup(group);
  // a hashed group (a long cwd) is known only by what its sessions record: another folder's
  // URI-encoded group is skipped by name, and a hashed one is read only once a session in it
  // names this cwd, so no other folder's sessions spend the budget
  for (const group of grokSessionGroups(grokHome)?.groups ?? []) {
    if (scan.exhausted) break;
    if (encoded.has(group) || cwds.every((spelling) => otherFolder(group, spelling, budget.platform))) continue;
    // listed once: the same folders say whose group it is and are then read
    const dirs = sessionDirs(group);
    if (grokGroupCwd(scan, dirs, cwds)) readGroup(group, dirs);
  }
  // on a case-insensitive file system the cwd's group and its other-case spelling are one folder, read twice
  const ids = new Set<string>();
  return rows.filter((found) => !ids.has(found.id) && ids.add(found.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_ROWS);
}

/**
 * Whether a Grok group's name is the URI-encoded name of another folder than the cwd. A hashed name
 * is not, nor is another spelling of the cwd: a drive letter in either case, a verbatim `\\?\` or
 * `\\?\UNC\` prefix (codex.ts directoryKey), and on Windows any letter case.
 */
function otherFolder(group: string, cwd: string, platform: NodeJS.Platform): boolean {
  let decoded: string;
  try { decoded = decodeURIComponent(group); } catch { return false; }
  if (decoded === group || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(decoded)) return false;
  const key = (path: string) => platform === "win32" ? windowsFolder(path).toLowerCase() : directoryKey(path);
  return key(decoded) !== key(cwd);
}

/**
 * A Windows folder in one spelling: without a verbatim `\\?\` or `\\?\UNC\` prefix (codex.ts
 * withoutVerbatimPrefix), normalized by path.win32 (either separator, `.` and `..` resolved), with no
 * trailing separator past a drive or share root, and an upper-case drive letter. The rest keeps its case.
 */
function windowsFolder(path: string): string {
  const normal = win32.normalize(withoutVerbatimPrefix(path.replaceAll("/", "\\")));
  const root = win32.parse(normal).root;
  const trimmed = normal.length > root.length ? normal.replace(/[\\/]+$/, "") : normal;
  return /^[a-z]:/.test(trimmed) ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : trimmed;
}

/** Whether a hashed group holds this cwd's sessions: the first readable of at most three summaries says. */
function grokGroupCwd(scan: Scan, dirs: readonly string[], cwds: readonly string[]): boolean {
  for (const dir of dirs.slice(0, 3)) {
    const file = scan.file(join(dir, "summary.json"));
    if (!file) continue;
    try {
      const recorded = str(record(record(JSON.parse(scan.lines(file).join("\n"))).info).cwd);
      return recorded !== null && cwdMatches(scan.budget, recorded, cwds);
    } catch { /* unreadable summary: ask the next */ }
  }
  return false;
}

/* ---------------------------------------------------------------------------------------------
 * SQLite stores: OpenCode, Hermes, Devin, Antigravity. Read-only, at most MAX_ROWS sessions, text cut
 * to HEAD_BYTES in the query.
 * ------------------------------------------------------------------------------------------- */

/**
 * Reads a database of the store at `storeDir`, as files are read: the store resolved, the database
 * and its folder resolved inside it (a link out of the store is refused), opened read-only.
 */
function withDatabase<T>(budget: Budget, storeDir: string, path: string, read: (db: Database) => T): T | null {
  const root = storeRoot(budget, storeDir);
  if (root === null) return null;
  const real = budget.resolve(path);
  const parent = real === null ? null : budget.resolve(dirname(path));
  if (real === null || parent === null) return null;
  if (!inside(root, real) || (parent !== root && !inside(root, parent)) || dirname(real) !== parent) return null;
  const checked = budget.identity(real);
  if (!checked?.isFile) return null;
  let fd: number | undefined;
  let db: Database | undefined;
  try {
    // the checked file itself, opened: a link put in its place is refused (O_NOFOLLOW), and the
    // descriptor must be the checked file (a file swapped in and back between two looks at the path
    // is not; nor is a folder above it swapped for a link)
    fd = openSync(real, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    const opened = budget.fstatOf(fd, true);
    if (!opened.isFile() || bigintOf(opened.dev) !== checked.dev || bigintOf(opened.ino) !== checked.ino) return null;
    // a -wal there before the first read (a restored store's) is no writer; one appearing after is
    const logBefore = budget.modified(`${real}-wal`) !== null;
    const first = openDatabase(budget, real, fd, checked, true);
    if (first === null) return null;
    db = first.db;
    let answer: { value: T } | null = null;
    try { db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`); answer = { value: read(db) }; } catch { /* read again below when immutable */ }
    db.close();
    db = undefined;
    if (!first.immutable) return answer?.value ?? null;
    // an immutable read is only sound while nobody writes: SQLite gives undefined results (stale rows,
    // SQLITE_CORRUPT) when the file changes under it. A writer is spotted by the file's modification
    // time, change time and size, and by a -wal appearing. Coarse timestamp ticks (Linux's too) can
    // hide a same-size rewrite within one tick: the limit. Unchanged: the answer holds, or, when the
    // read failed, nothing is listed (reading again would fail the same way). Changed: read once
    // more, as SQLite reads a store being written only when both its -wal and -shm are there at the
    // check (see openDatabase's departing-writer limit), else immutable again, which must find the
    // file unchanged too; at most two reads
    const unchanged = (since: BigIntStats) => {
      const now = budget.fstatOf(fd!, true) as BigIntStats;
      return now.mtimeNs === since.mtimeNs && now.ctimeNs === since.ctimeNs && now.size === since.size && (budget.modified(`${real}-wal`) !== null) === logBefore;
    };
    if (unchanged(opened as BigIntStats)) return answer?.value ?? null;
    const before = budget.fstatOf(fd, true) as BigIntStats;
    const second = openDatabase(budget, real, fd, checked, !liveLog(budget, real));
    if (second === null) return null;
    db = second.db;
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const value = read(db);
    if (second.immutable && !unchanged(before)) return null;
    return value;
  } catch { return null; }
  finally { db?.close(); if (fd !== undefined) closeSync(fd); }
}

/**
 * Whether a WAL store has both -wal and -shm at the check, not a guarantee its writer stays live.
 * SQLite makes whichever is missing when it opens a WAL store as such, so with one of them missing
 * (a store restored with its -wal and no -shm, say) it is read immutable: nothing is written, and
 * what only that -wal holds is not seen.
 */
const liveLog = (budget: Budget, real: string): boolean => budget.modified(`${real}-wal`) !== null && budget.modified(`${real}-shm`) !== null;

/**
 * SQLite on the checked database, read-only; immutable opens create no side files.
 *
 * - A WAL database with no `-wal` beside it has nothing in its log: it opens `immutable=1`, so SQLite
 *   neither locks it nor makes a `-wal` and `-shm` (a plain read-only open would make both). That read
 *   holds only while nobody writes; withDatabase checks the file after it and reads it once more when
 *   it changed: as such when a writer's -wal is live then, else immutable again, checked again.
 * - A WAL database whose `-wal` and `-shm` both exist at the check opens as such, so the sessions
 *   still in its log are read. If the writer closes between that check and the first query, SQLite
 *   can recreate the side files it removed; reading live-log rows cannot exclude this race.
 *   With only one side file at the check it reads immutable (liveLog).
 * - A rollback-journal database opens as such, with SQLite's locks against a writer mid-change.
 *
 * On Linux and macOS SQLite opens the checked descriptor as /dev/fd/N: macOS opens the descriptor
 * itself, and Linux the file it names now (the checked file, wherever it went). macOS would look for a
 * live log or a crashed writer's hot journal beside /dev/fd/N, so only an immutable read opens the
 * descriptor there; a live WAL and a rollback-journal store open by their path. Windows has no /dev/fd: there and
 * for a live WAL on macOS, the path is opened and must still be the checked file after the open (a
 * file swapped in between the descriptor's check and that open, then back, is not caught: the
 * residual, while an agent writes on macOS, or on Windows).
 */
function openDatabase(budget: Budget, real: string, fd: number, checked: { dev: bigint; ino: bigint }, mayBeImmutable: boolean): { db: Database; immutable: boolean } | null {
  const header = Buffer.alloc(20);
  const wal = readSync(fd, header, 0, 20, 0) === 20 && header[18] === 2 && header[19] === 2;
  const logged = wal && liveLog(budget, real);
  const immutable = mayBeImmutable && wal && !logged;
  // macOS looks for a store's -wal or -journal beside /dev/fd/N, where there is none: only an immutable
  // read, which reads neither, opens the descriptor there
  const descriptor = process.platform === "linux" || (process.platform === "darwin" && immutable) ? `/dev/fd/${fd}` : null;
  const flags = sqliteConstants.SQLITE_OPEN_READONLY | sqliteConstants.SQLITE_OPEN_URI;
  if (descriptor !== null) {
    const db = new Database(immutable ? `file:${descriptor}?immutable=1` : descriptor, flags);
    budget.onOpened(real, immutable, db);
    // Linux resolves /dev/fd/N to the path that names the descriptor's file and opens that: the path
    // must still be the checked file once SQLite has it (part of the database's one check)
    const again = budget.identity(real, true);
    if (!again?.isFile || again.dev !== checked.dev || again.ino !== checked.ino) { db.close(); return null; }
    return { db, immutable };
  }
  const db = new Database(immutable ? `${pathToFileURL(real).href}?immutable=1` : real, flags | sqliteConstants.SQLITE_OPEN_NOFOLLOW);
  budget.onOpened(real, immutable, db);
  // part of the database's one check: a database checked at the 400th check is still listed
  const again = budget.identity(real, true);
  if (!again?.isFile || again.dev !== checked.dev || again.ino !== checked.ino) { db.close(); return null; }
  return { db, immutable };
}

const tableExists = (db: Database, name: string) => db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
const columnsOf = (db: Database, table: string) => new Set(db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}')`).all().map((column) => column.name));
/** The spellings a store may hold this cwd in (codex.ts storedCwds, plus the drive-letter key). */
const cwdSpellings = (cwd: string): string[] => [...new Set([cwd, directoryKey(cwd), ...storedCwds(cwd)])];
const spellingsOf = (cwds: readonly string[]): string[] => [...new Set(cwds.flatMap(cwdSpellings))];
const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(", ");

function opencodeSessions(cwds: readonly string[], storeDir: string, path: string | null, budget: Budget): Row[] {
  if (path === null) return [];
  return withDatabase(budget, storeDir, path, (db) => {
    const spellings = spellingsOf(cwds);
    if (tableExists(db, "session_v2")) {
      const top = columnsOf(db, "session_v2").has("parent_id") ? " AND parent_id IS NULL" : "";
      const sessions = db.query<{ id: string; title: string | null; created: number; updated: number }, string[]>(
        `SELECT id, substr(title, 1, ${TITLE_CHARS * 4}) AS title, time_created AS created, time_updated AS updated FROM session_v2
         WHERE directory IN (${placeholders(spellings)})${top} ORDER BY time_updated DESC LIMIT ${MAX_ROWS}`,
      ).all(...spellings);
      const first = db.query<{ data: string }, [string]>(`SELECT substr(data, 1, ${HEAD_BYTES}) AS data FROM session_message WHERE session_id = ? AND type = 'user' ORDER BY seq LIMIT 1`);
      return sessions.map((session) => {
        let firstMessage: string | null = null;
        try { firstMessage = str(record(JSON.parse(first.get(session.id)?.data ?? "null")).text); } catch { /* cut by the read */ }
        return row("opencode", session.id, { title: session.title, firstMessage, startedAt: iso(session.created), updatedAt: iso(session.updated) ?? new Date(0).toISOString() });
      });
    }
    if (!tableExists(db, "session")) return [];
    const top = columnsOf(db, "session").has("parent_id") ? " AND parent_id IS NULL" : "";
    const sessions = db.query<{ id: string; title: string | null; created: number; updated: number }, string[]>(
      `SELECT id, substr(title, 1, ${TITLE_CHARS * 4}) AS title, time_created AS created, time_updated AS updated FROM session
       WHERE directory IN (${placeholders(spellings)})${top} ORDER BY time_updated DESC LIMIT ${MAX_ROWS}`,
    ).all(...spellings);
    const hasParts = tableExists(db, "message") && tableExists(db, "part");
    const firstUser = hasParts ? db.query<{ id: string }, [string]>("SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created, id LIMIT 1") : null;
    const parts = hasParts ? db.query<{ data: string }, [string]>(`SELECT substr(data, 1, ${HEAD_BYTES}) AS data FROM part WHERE message_id = ? ORDER BY id LIMIT 8`) : null;
    return sessions.map((session) => {
      let firstMessage: string | null = null;
      const message = firstUser?.get(session.id);
      if (message && parts) {
        for (const part of parts.all(message.id)) {
          try {
            const value = record(JSON.parse(part.data));
            if (value.type === "text" && (firstMessage = str(value.text)) !== null) break;
          } catch { /* cut by the read */ }
        }
      }
      return row("opencode", session.id, { title: session.title, firstMessage, startedAt: iso(session.created), updatedAt: iso(session.updated) ?? new Date(0).toISOString() });
    });
  }) ?? [];
}

/**
 * The children Hermes lists as conversations of their own, each opened by `hermes --resume <its id>`:
 * a /branch and a gateway reset (hermes-agent 354724fb, hermes_state_common.py _LISTABLE_CHILD_SQL;
 * scripts/hermes-history-schema-probe.ts recorded it in server/fixtures/hermes-history/evidence.json).
 * A marker counts only when it names the row's own parent: a compression continuation inherits its
 * parent's model_config, markers included (as Hermes's own _non_continuation_child_sql reads them).
 * An older row with no marker key is a branch when its parent ended "branched" before it started, or
 * a reset when its parent ended at a reset and both carry the same routing key. Delegated runs, tool
 * sessions, continuations and any child whose model_config is no JSON or holds another marker value
 * stay hidden. Hermes's own list is looser (it shows a continuation that inherited a branch marker).
 * A child is listed only when `hermes --resume` opens it as itself. resolve_resume_session_id first
 * follows the compression chain (get_compression_tip: an unmarked, non-reset child of a row that
 * ended "compression"), then walks the newest unmarked child at each step, through rows with no
 * messages, to the deepest one with messages. So an older branch branched again, or a legacy branch
 * Hermes compressed later, is left out: it resumes as another row. A /branch or a reset compressed
 * later stays listed and opens there, before the compression: its continuation inherits the marker,
 * which the chain step skips.
 * Children are listed only from a store whose schema_version the probe proved, or an older one; a
 * newer store lists its roots until the probe is run against that release.
 */
const HERMES_PROVEN_SCHEMA = 31;
/**
 * How many of the folder's newest roots and admitted children the resume walk examines: the walk runs
 * on these alone, never on every row of the store. When more of them than MAX_ROWS resume as another
 * row, the list is shorter than MAX_ROWS.
 */
export const HERMES_CANDIDATES = MAX_ROWS * 4;
const HERMES_CHILD_COLUMNS = ["parent_session_id", "model_config", "source", "session_key", "started_at", "ended_at", "end_reason"];
const HERMES_RESET_END_REASONS = ["session_reset", "session_switch", "idle", "daily", "suspended", "resume_pending_expired"];
const hermesConfig = "(CASE WHEN json_valid(s.model_config) THEN s.model_config ELSE NULL END)";
const hermesMarker = (name: string) => `json_type(${hermesConfig}, '$.${name}')`;
/** a root, or a child Hermes lists as a branch or a reset of its parent */
const HERMES_ADMITTED = `(s.parent_session_id IS NULL OR (coalesce(s.source, '') != 'tool' AND EXISTS (
  SELECT 1 FROM sessions p WHERE p.id = s.parent_session_id AND (
    (${hermesMarker("_delegate_from")} IS NULL AND (
      (${hermesMarker("_branched_from")} = 'text' AND json_extract(${hermesConfig}, '$._branched_from') = p.id)
      OR (${hermesMarker("_reset_from")} = 'text' AND json_extract(${hermesConfig}, '$._reset_from') = p.id)))
    OR ((s.model_config IS NULL OR (json_type(${hermesConfig}) = 'object'
        AND ${hermesMarker("_branched_from")} IS NULL AND ${hermesMarker("_reset_from")} IS NULL AND ${hermesMarker("_delegate_from")} IS NULL))
      AND ((p.end_reason = 'branched' AND s.started_at >= p.ended_at)
        OR (p.end_reason IN (${HERMES_RESET_END_REASONS.map((reason) => `'${reason}'`).join(", ")})
          AND coalesce(s.session_key, '') != '' AND s.session_key = p.session_key))))
)))`;
/** a root, or a child `hermes --resume` opens as itself: no compression continuation to follow, and nothing past it in the walk has messages */
const HERMES_RESUMES_ITSELF = `(s.parent_session_id IS NULL OR NOT EXISTS (
  WITH RECURSIVE walk(id, depth) AS (
    SELECT s.id, 0
    UNION ALL
    SELECT (SELECT c.id FROM sessions c WHERE c.parent_session_id = walk.id AND coalesce(c.source, '') != 'tool'
        AND ${["_branched_from", "_delegate_from", "_reset_from"].map((name) => `json_extract(CASE WHEN json_valid(c.model_config) THEN c.model_config ELSE '{}' END, '$.${name}') IS NULL`).join(" AND ")}
        AND NOT EXISTS (SELECT 1 FROM sessions r WHERE r.id = c.parent_session_id AND r.end_reason IN (${HERMES_RESET_END_REASONS.map((reason) => `'${reason}'`).join(", ")})
          AND coalesce(c.session_key, '') != '' AND c.session_key = r.session_key)
        ORDER BY c.started_at DESC, c.id DESC LIMIT 1), depth + 1
    FROM walk WHERE walk.id IS NOT NULL AND depth < 31)
  SELECT 1 FROM walk w WHERE w.depth > 0 AND w.id IS NOT NULL
    AND ((w.depth = 1 AND s.end_reason = 'compression') OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = w.id))))`;

function hermesSessions(cwds: readonly string[], hermesHome: string, budget: Budget): Row[] {
  return withDatabase(budget, hermesHome, join(hermesHome, "state.db"), (db) => {
    if (!tableExists(db, "sessions")) return [];
    const columns = columnsOf(db, "sessions");
    if (!columns.has("cwd")) return [];
    const spellings = spellingsOf(cwds);
    const updated = ["last_activity_at", "ended_at"].filter((name) => columns.has(name));
    const updatedAt = `coalesce(${[...updated, "started_at"].map((name) => `s.${name}`).join(", ")})`;
    // a store of an unproven schema, or without every column the children are told apart by, lists its roots alone
    const schema = tableExists(db, "schema_version") ? db.query<{ version: number | null }, []>("SELECT max(version) AS version FROM schema_version").get()?.version ?? null : null;
    const proven = typeof schema === "number" && schema <= HERMES_PROVEN_SCHEMA && HERMES_CHILD_COLUMNS.every((name) => columns.has(name)) && tableExists(db, "messages");
    const title = columns.has("title") ? `substr(s.title, 1, ${TITLE_CHARS * 4})` : "NULL";
    const folder = `FROM sessions s WHERE s.cwd IN (${placeholders(spellings)})`;
    // the resume walk runs on the newest HERMES_CANDIDATES admitted rows of the folder, after its cheap rules
    const sessions = db.query<{ id: string; title: string | null; started: number; updated: number }, string[]>(proven
      ? `SELECT s.id AS id, s.title AS title, s.started AS started, s.updated AS updated FROM (
           SELECT s.id AS id, s.parent_session_id AS parent_session_id, s.end_reason AS end_reason, ${title} AS title, s.started_at AS started, ${updatedAt} AS updated
           ${folder} AND ${HERMES_ADMITTED} ORDER BY updated DESC LIMIT ${HERMES_CANDIDATES}) s
         WHERE ${HERMES_RESUMES_ITSELF} ORDER BY s.updated DESC LIMIT ${MAX_ROWS}`
      : `SELECT s.id AS id, ${title} AS title, s.started_at AS started, ${updatedAt} AS updated
         ${folder}${columns.has("parent_session_id") ? " AND s.parent_session_id IS NULL" : ""}
         ORDER BY updated DESC LIMIT ${MAX_ROWS}`,
    ).all(...spellings);
    const first = tableExists(db, "messages")
      ? db.query<{ content: string | null }, [string]>(`SELECT substr(content, 1, ${HEAD_BYTES}) AS content FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id LIMIT 1`)
      : null;
    return sessions.map((session) => row("hermes", session.id, {
      title: session.title,
      firstMessage: str(first?.get(session.id)?.content ?? null),
      startedAt: iso(session.started, "s"),
      updatedAt: iso(session.updated, "s") ?? new Date(0).toISOString(),
    }));
  }) ?? [];
}

function devinSessions(cwds: readonly string[], dbPath: string, budget: Budget): Row[] {
  return withDatabase(budget, dirname(dbPath), dbPath, (db) => {
    if (!tableExists(db, "sessions")) return [];
    const columns = columnsOf(db, "sessions");
    const spellings = spellingsOf(cwds);
    const created = columns.has("created_at") ? "created_at" : "NULL";
    const updated = columns.has("last_activity_at") ? `coalesce(last_activity_at, ${created})` : created;
    const sessions = db.query<{ id: string; title: string | null; created: number | null; updated: number | null }, string[]>(
      `SELECT id, ${columns.has("title") ? `substr(title, 1, ${TITLE_CHARS * 4})` : "NULL"} AS title, ${created} AS created, ${updated} AS updated
       FROM sessions WHERE working_directory IN (${placeholders(spellings)})${columns.has("hidden") ? " AND hidden = 0" : ""}
       ORDER BY updated DESC LIMIT ${MAX_ROWS}`,
    ).all(...spellings);
    const nodes = tableExists(db, "message_nodes")
      ? db.query<{ message: string | null }, [string]>(`SELECT substr(chat_message, 1, ${HEAD_BYTES}) AS message FROM message_nodes WHERE session_id = ? ORDER BY node_id LIMIT 16`)
      : null;
    return sessions.map((session) => {
      let firstMessage: string | null = null;
      for (const node of nodes?.all(session.id) ?? []) {
        try {
          const value = record(JSON.parse(node.message ?? "null"));
          if (value.role === "user" && (firstMessage = textOf(value.content)) !== null) break;
        } catch { /* cut by the read */ }
      }
      return row("devin", session.id, { title: session.title, firstMessage, startedAt: iso(session.created, "s"), updatedAt: iso(session.updated, "s") ?? new Date(0).toISOString() });
    });
  }) ?? [];
}

/**
 * Antigravity CLI: `~/.gemini/antigravity-cli/conversation_summaries.db` names each conversation's
 * workspace folders (`workspace_uris`, file URIs), and its first prompt is the first USER_INPUT step
 * of `brain/<id>/.system_generated/logs/transcript_full.jsonl`.
 */
function agySessions(cwds: readonly string[], home: string, budget: Budget, read: SessionHistoryOptions["readHead"]): Row[] {
  const base = join(home, ".gemini", "antigravity-cli");
  const listed = withDatabase(budget, base, join(base, "conversation_summaries.db"), (db) => {
    if (!tableExists(db, "conversation_summaries")) return [];
    const columns = columnsOf(db, "conversation_summaries");
    const top = [columns.has("nesting_depth") ? "nesting_depth = 0" : "", columns.has("parent_conversation_id") ? "parent_conversation_id = ''" : ""].filter(Boolean);
    // folders are matched here, not in SQL: read at most as many rows as files elsewhere
    return db.query<{ id: string; title: string; updated: string; uris: string }, []>(
      `SELECT conversation_id AS id, substr(title, 1, ${TITLE_CHARS * 4}) AS title, last_modified_time AS updated, substr(workspace_uris, 1, ${HEAD_BYTES}) AS uris
       FROM conversation_summaries${top.length ? ` WHERE ${top.join(" AND ")}` : ""} ORDER BY last_modified_time DESC LIMIT ${MAX_STATS}`,
    ).all();
  }) ?? [];
  const matching = listed.filter((entry) => {
    try {
      const uris: unknown = JSON.parse(entry.uris);
      return Array.isArray(uris) && uris.some((uri) => typeof uri === "string" && uri.startsWith("file:") && cwdMatches(budget, fileURLToPath(uri), cwds));
    } catch { return false; }
  }).slice(0, MAX_ROWS);
  const brain = join(base, "brain");
  const scan = matching.length === 0 ? null : scanOf(budget, brain, read);
  return matching.map((entry) => {
    let firstMessage: string | null = null;
    let startedAt: string | null = null;
    const file = scan && SAFE_ID.test(entry.id) ? scan.file(join(brain, entry.id, ".system_generated", "logs", "transcript_full.jsonl")) : null;
    if (scan && file) {
      for (const value of scan.records(file)) {
        startedAt ??= iso(value.created_at);
        if (value.type === "USER_INPUT" && typeof value.content === "string") { firstMessage = str(agyUserText(value.content)); break; }
      }
    }
    return row("agy", entry.id, { title: entry.title, firstMessage, startedAt, updatedAt: iso(entry.updated) ?? new Date(0).toISOString() });
  });
}

/**
 * The earlier sessions of `agent` in the folder `cwd`, newest first, from the agent's own store.
 * An absent, unreadable or foreign store lists nothing.
 */
export function listSessions(agent: "pi", cwd: string, options?: SessionHistoryOptions): Promise<Row[]>;
export function listSessions(agent: Exclude<SessionHistoryAgent, "pi">, cwd: string, options?: SessionHistoryOptions): Row[];
export function listSessions(agent: SessionHistoryAgent, cwd: string, options?: SessionHistoryOptions): Row[] | Promise<Row[]>;
export function listSessions(agent: SessionHistoryAgent, cwd: string, options: SessionHistoryOptions = {}): Row[] | Promise<Row[]> {
  const env = options.env ?? process.env;
  // the OS's answer when the environment names no home, as before: never a relative store path
  const home = options.home ?? (environmentHome(env, options.platform ?? process.platform) || homedir());
  const read = options.readHead;
  const budget = new Budget(options.stat ?? ((path, bigint) => bigint ? statSync(path, { bigint: true }) : statSync(path)), options.platform ?? process.platform, options.resolve, options.lstat, options.fstat, options.opendir, options.opened);
  budget.used = options.spent ?? 0;
  // the pane's cwd may be another spelling of the folder the agent recorded: a Windows 8.3 alias (a
  // child keeps the short cwd) or a link (macOS /var -> /private/var). Resolve it once, as one counted
  // stat, and key and match every store by both spellings
  const realpath = options.realpath ?? realpathSync.native;
  const canonical = budget.canonical(cwd, realpath);
  const cwds = [...new Set([cwd, canonical])];
  const keys = (key: (cwd: string) => string | readonly string[]) => [...new Set(cwds.flatMap(key))];
  // omp and gjc key by paths relative to home and the temp dir, each canonical as omp resolves it
  const spellings = (path: string) => [...new Set([path, budget.canonical(path, realpath)])];
  const ompFolders = () => ompSessionFolders(cwds, spellings(home), spellings(options.tmpdir ?? tmpdir()), budget.platform);
  const rows = ((): Row[] | Promise<Row[]> => {
    switch (agent) {
      case "claude": return claudeSessions(cwds, home, env, budget, read);
      case "codex": return codexSessions(cwds, options.codexHome ?? (env["CODEX_HOME"] || join(home, ".codex")), budget, read);
      case "pi": {
        const sessions = env["PI_CODING_AGENT_SESSION_DIR"] || join(env["PI_CODING_AGENT_DIR"] || join(home, ".pi", "agent"), "sessions");
        return piSessions(sessions, keys((spelling) => piSessionFolder(spelling, budget.platform)), cwds, budget, options.piReader ?? defaultPiSessionReader);
      }
      case "omo": {
        // senpi takes the first of these that is set (server/omo.ts omoAgentDir)
        const dir = ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"].map((name) => env[name]).find(Boolean) || join(home, ".omo", "agent");
        return piFamily("omo", join(dir, "sessions"), keys((spelling) => piSessionFolder(spelling, budget.platform)), cwds, budget, read);
      }
      case "omp": return piFamily("omp", join(home, ".omp", "agent", "sessions"), ompFolders(), cwds, budget, read);
      case "gjc": return piFamily("gjc", join(env["GJC_CODING_AGENT_DIR"] || join(home, ".gjc", "agent"), "sessions"), ompFolders(), cwds, budget, read);
      case "cmd": return piFamily("cmd", join(home, ".commandcode", "projects"), keys(cmdSlug), cwds, budget, read, true);
      case "opencode": {
        // a database the user named (OPENCODE_DB, the server's option) is its own store; else OpenCode's data dir
        const named = options.opencodeDb ?? (env["OPENCODE_DB"] ? opencodeDatabasePath(env, home) : null);
        const data = join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), "opencode");
        return opencodeSessions(cwds, named ? dirname(named) : data, named ?? opencodeDatabasePath(env, home), budget);
      }
      case "hermes": return hermesSessions(cwds, options.hermesHome ?? hermesHome(home, env, budget.platform, (path) => budget.stat(path) !== null), budget);
      case "devin": return devinSessions(cwds, join(env["XDG_DATA_HOME"] || join(home, ".local", "share"), "devin", "cli", "sessions.db"), budget);
      case "grok": return grokSessions(cwds, home, env, budget, read);
      case "agy": return agySessions(cwds, home, budget, read);
    }
  })();
  const sorted = (rows: Row[]) => rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_ROWS);
  return rows instanceof Promise ? rows.then(sorted) : sorted(rows);
}
