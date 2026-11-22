/**
 * Which Letta Code conversation a pane shows. These facts must agree, or Chat uses Terminal:
 * - herdr's report from its Letta integration (`herdr integration install letta`), when there is one:
 *   `herdr:letta`,
 *   the conversation id, or `default:<agent id>` for an agent's default conversation. herdr 0.9.5
 *   keeps the first report of a letta process, so after `/new` or `/resume` it still names the
 *   conversation the pane left.
 * - Letta's own record of the conversation it opened, which every letta process writes into its
 *   project's `.letta/settings.local.json` (`sessionsByServer`) on start and on every switch, and
 *   reads back to resume. It is shared by every letta in that folder, and nothing in it says which
 *   process wrote it, so it speaks for the pane's process only when it is older than that process:
 *   a letta that opens the conversation the record names writes nothing (`setLocalLastSession`
 *   skips an equal session), and any later write (a `/new` or `/resume`, its own start on another
 *   conversation, or another letta, even one gone since) leaves Chat on Terminal until letta starts again.
 * - The pane's one letta process: its own environment for where Letta keeps its files
 *   (`LETTA_CONFIG_DIR`, `LETTA_TRANSCRIPT_ROOT`, `HOME`), read from the process on Linux and macOS
 *   (Windows has no such read, and uses Terminal), and the folder it started in (lettaInStartFolder),
 *   whose record is the only one read, while the process is still there.
 * The transcript must then be a regular file at exactly the path Letta derives from the two ids.
 *
 * herdr-core sends no report for Letta, and herdr none without the integration. Then nothing backs the
 * record but its own age, so more must hold (lettaRecordSpeaksAlone): the letta was started plainly,
 * which resumes the record's conversation; it saves its sessions; no other Letta pane goes unreported;
 * and the transcript was written since the process started, the process's own use of it.
 */
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type { ConversationMetadata, HerdrPane } from "../shared/protocol.ts";
import { darwinProcess } from "./claude-store.ts";
import { paneProcessInfo, type ProcessInfo } from "./herdr/client.ts";
import { processStartIdentity, processStartLowerBound, processStartUpperBound } from "./process-start.ts";

/** Letta's ids: `conv-<uuid>`, `local-conv-<n>`, `agent-<uuid>`, `agent-local-<uuid>`, and `default`. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const SETTINGS_BYTES = 256 * 1024;
const ENVIRON_BYTES = 1024 * 1024;

export interface LettaSession {
  reported: string;
  agent: string | null;
  conversation: string;
}

export function lettaSessionOf(pane: Pick<HerdrPane, "agent_session">): LettaSession | null {
  const session = pane.agent_session;
  if (session?.agent !== "letta" || session.source !== "herdr:letta" || session.kind !== "id" || typeof session.value !== "string") return null;
  const reported = session.value;
  if (reported.startsWith("default:")) {
    const agent = reported.slice("default:".length);
    return ID.test(agent) ? { reported, agent, conversation: "default" } : null;
  }
  return ID.test(reported) && reported !== "default" ? { reported, agent: null, conversation: reported } : null;
}

type Env = Record<string, string | undefined>;

/** Letta's config folder for an environment: `$LETTA_CONFIG_DIR` when absolute, else `$HOME/.letta`; null without either. */
export function lettaConfigDir(env: Env): string | null {
  const override = env["LETTA_CONFIG_DIR"]?.trim();
  if (override) return isAbsolute(override) ? normalize(override) : null;
  return env["HOME"] && isAbsolute(env["HOME"]) ? join(env["HOME"], ".letta") : null;
}

/** Where Letta writes transcripts: `$LETTA_TRANSCRIPT_ROOT`, else `transcripts` in its config folder. */
export function lettaTranscriptRoot(env: Env): string | null {
  const root = env["LETTA_TRANSCRIPT_ROOT"]?.trim();
  if (root) return isAbsolute(root) ? normalize(root) : null;
  const config = lettaConfigDir(env);
  return config === null ? null : join(config, "transcripts");
}

export const lettaTranscriptPath = (root: string, agent: string, conversation: string): string =>
  join(root, agent, conversation, "transcript.jsonl");

/** A NUL-separated environment, as /proc/<pid>/environ holds it. */
export function parseEnviron(text: string): Env {
  const env: Env = {};
  for (const entry of text.split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
}

/** O_NONBLOCK, so a FIFO put where a record was is not waited on; O_NOFOLLOW, so a link there is refused. */
const RECORD_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** The text of a regular file of at most `bytes`, opened through no final link; null otherwise. */
function readBounded(path: string, bytes: number): string | null {
  let fd: number;
  try { fd = openSync(path, RECORD_FLAGS); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > bytes) return null;
    const size = stat.size;
    const buffer = Buffer.alloc(size);
    return buffer.subarray(0, readSync(fd, buffer, 0, size, 0)).toString("utf8");
  } catch { return null; } finally { closeSync(fd); }
}

function processEnvironment(pid: number): Env | null {
  if (process.platform === "linux") {
    try {
      const bytes = readFileSync(`/proc/${pid}/environ`);
      return bytes.length > ENVIRON_BYTES ? null : parseEnviron(bytes.toString("utf8"));
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    const text = darwinProcess.environment(pid);
    return text === null ? null : parseEnviron(text);
  }
  return null;
}

export function lettaOpenedSessions(text: string): { agent: string; conversation: string }[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const servers = (parsed as Record<string, unknown>)["sessionsByServer"];
  if (servers === undefined) return [];
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) return null;
  const sessions: { agent: string; conversation: string }[] = [];
  for (const value of Object.values(servers as Record<string, unknown>)) {
    const ref = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
    if (typeof ref["agentId"] !== "string" || typeof ref["conversationId"] !== "string") return null;
    sessions.push({ agent: ref["agentId"], conversation: ref["conversationId"] });
  }
  return sessions;
}

/**
 * The agent and conversation the report and Letta's record both name, or null. The agent comes
 * from the record when the report names only a conversation (`local-conv-<n>` repeats across
 * agents), and every record of that agent must name the reported conversation.
 */
export function lettaBinding(session: LettaSession, opened: readonly { agent: string; conversation: string }[]): { agent: string; conversation: string } | null {
  const named = opened.filter((ref) => ref.conversation === session.conversation && (session.agent === null || ref.agent === session.agent));
  const agents = new Set(named.map((ref) => ref.agent));
  if (agents.size !== 1) return null;
  const agent = [...agents][0]!;
  if (!ID.test(agent) || opened.some((ref) => ref.agent === agent && ref.conversation !== session.conversation)) return null;
  return { agent, conversation: session.conversation };
}

/** A letta process: the `letta` executable, or a runtime running Letta's `letta` / `letta.js` entry. */
export function isLettaProcess(argv: readonly string[]): boolean {
  const name = (value: string | undefined): string => basename((value ?? "").replace(/\\/g, "/")).replace(/\.(exe|cmd)$/i, "");
  if (name(argv[0]) === "letta") return true;
  return ["node", "bun"].includes(name(argv[0])) && ["letta", "letta.js"].includes(name(argv[1]));
}

/**
 * `startedAt`: no later than the process started (processStartLowerBound), which may read differently each time;
 * `startedBy`: no earlier than it started (processStartUpperBound), null where that is not known;
 * `identity`: processStartIdentity, the same on every read, so with the pid it names the process;
 * `verified`: the pid's live command line was read and is the one herdr reported, so its start and
 * environment are this letta's and not those of a process that reused the pid (Linux)
 */
export interface LettaProcess { pid: number; cwd: string; startedAt: number; startedBy: number | null; identity: number; env: Env; argv: readonly string[]; verified?: boolean }

/** A process's live command line, where the system tells it (Linux's /proc); null otherwise. */
function liveArgv(pid: number): string[] | null {
  if (process.platform !== "linux") return null;
  try {
    const words = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    if (words.at(-1) === "") words.pop();
    return words;
  } catch { return null; }
}

const moved = new Set<string>();

/**
 * Letta's SetWorkingDirectory and EnterWorktree tools move a running letta into another project without
 * recording its conversation there, so that project's record is no record of it. The start folder is
 * the `PWD` its shell gave it, which its environment keeps whatever it does later; without one, or
 * once seen elsewhere, it is never bound again.
 */
export function lettaInStartFolder(owner: LettaProcess): boolean {
  const key = `${owner.pid}:${owner.identity}`;
  if (moved.has(key)) return false;
  const start = owner.env["PWD"];
  const here = canonical(owner.cwd);
  if (start === undefined || !isAbsolute(start) || here === null) return false;
  if (canonical(start) === here) return true;
  moved.add(key);
  if (moved.size > 256) moved.delete(moved.values().next().value!);
  return false;
}

export async function paneLettaProcess(paneId: string, known?: ProcessInfo | null): Promise<LettaProcess | null> {
  const info = known === undefined ? await paneProcessInfo(paneId).catch(() => null) : known;
  const found = (info?.foreground_processes ?? []).filter((process) =>
    Number.isSafeInteger(process.pid) && process.pid > 1 && Array.isArray(process.argv) && isLettaProcess(process.argv.map(String)));
  if (found.length !== 1) return null;
  const { pid, cwd } = found[0]!;
  const argv = (found[0]!.argv ?? []).map(String);
  if (typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  // herdr named the process a moment ago: the pid now may be another one's. Its live command line must be
  // the reported one, and its start the same before and after its start and environment are read
  const live = liveArgv(pid);
  if (live !== null && (live.length !== argv.length || live.some((word, at) => word !== argv[at]))) return null;
  const identity = processStartIdentity(pid);
  const startedAt = processStartLowerBound(pid);
  const startedBy = processStartUpperBound(pid);
  const env = processEnvironment(pid);
  if (startedAt === null || identity === null || env === null || processStartIdentity(pid) !== identity) return null;
  return { pid, cwd, startedAt, startedBy, identity, env, argv, verified: live !== null };
}

export type LettaTranscript = { path: string; session: string; agent: string; conversation: string };

/**
 * The transcript a Letta pane shows (see the top of this file), or null when it is not proven, or
 * when another pane reports the same conversation. The file may not exist yet.
 */
export async function lettaTranscriptFor(pane: HerdrPane, panes: readonly HerdrPane[], owner: LettaProcess): Promise<LettaTranscript | null> {
  const session = lettaSessionOf(pane);
  // a report in another form is not the absence of one
  if (session === null && pane.agent_session) return null;
  if (session === null && !lettaRecordSpeaksAlone(pane, panes, owner)) return null;
  if (session !== null && panes.some((other) => other.pane_id !== pane.pane_id && lettaSessionOf(other)?.reported === session.reported)) return null;
  const record = join(owner.cwd, ".letta", "settings.local.json");
  const text = recordOlderThan(record, owner.startedAt);
  const opened = text === null ? null : lettaOpenedSessions(text);
  const bound = opened === null ? null : session === null ? lettaRecordedBinding(opened) : lettaBinding(session, opened);
  const root = lettaTranscriptRoot(owner.env);
  if (bound === null || root === null) return null;
  // the peers are read off the event loop: the record bound on must still stand once they answer
  if (session === null && (await claimedElsewhere(pane, panes, owner, bound) || recordOlderThan(record, owner.startedAt) !== text)) return null;
  const path = lettaTranscriptPath(root, bound.agent, bound.conversation);
  // without a report the record only proves the process has not written yet: its own use of the conversation must show
  if (session === null && (owner.startedBy === null || !writtenSince(path, owner.startedBy))) return null;
  const reported = session?.reported ?? (bound.conversation === "default" ? `default:${bound.agent}` : bound.conversation);
  return { path, session: reported, ...bound };
}

/** The words a letta may start with and still resume its project's last conversation: model, backend, tools and prompt preset (letta-code 0.34.44 --help). */
const RESUMING_OPTIONS = new Set(["-m", "--model", "--backend", "--toolset", "-s", "--system"]);

/**
 * Whether Letta's record may speak for a pane with no report at all. Plain `letta` resumes the
 * project's last conversation, the one the record names; any other option may pick another
 * (`--new`, `--resume`, `--agent`, `--name`, a flag this does not know). With session saving off
 * (LETTA_DISABLE_SESSION_PERSIST set at all, or a subagent's LETTA_CODE_AGENT_ROLE) the record is not this process's. Another Letta pane with no
 * report may have moved here from a folder with the same record, so it leaves both unbound.
 */
function lettaRecordSpeaksAlone(pane: HerdrPane, panes: readonly HerdrPane[], owner: LettaProcess): boolean {
  // a process whose command line could not be checked live may be another one under a reused pid
  if (owner.verified === false) return false;
  if (owner.env["LETTA_DISABLE_SESSION_PERSIST"] !== undefined || owner.env["LETTA_CODE_AGENT_ROLE"] === "subagent") return false;
  const program = owner.argv.findIndex((word) => /(^|[\\/])letta(\.(?:js|cmd|exe))?$/i.test(word));
  if (program === -1) return false;
  for (let at = program + 1; at < owner.argv.length; at += 2) {
    if (!RESUMING_OPTIONS.has(owner.argv[at]!) || at + 1 >= owner.argv.length) return false;
  }
  return !panes.some((other) => other.pane_id !== pane.pane_id && other.agent === "letta" && lettaSessionOf(other) === null);
}

/** Whether `path` is a regular file last written after `startedAt`: a write in the same instant may be the process before. */
function writtenSince(path: string, startedAt: number): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && stat.mtimeMs > startedAt;
  } catch { return false; }
}

/**
 * How long the peer folders may take to answer a claim check. One that has not answered by then may
 * hide a claim of its own (a mount that stopped answering), so it claims.
 */
export const peerClaimDeadline = { ms: 5_000 };

/**
 * Whether another Letta pane's folder record names the same conversation: a Letta there resumed it
 * too, and which pane shows it cannot be told. Its record is read as it stands, written whenever:
 * an old one only costs this pane its chat, never shows it another's.
 */
async function claimedElsewhere(pane: HerdrPane, panes: readonly HerdrPane[], owner: LettaProcess, bound: { agent: string; conversation: string }): Promise<boolean> {
  const own = await realpath(owner.cwd).catch(() => null);
  // its process may run in a folder other than where the pane started: each folder's record counts
  const folders = lettaPeerFolders(pane, panes).filter((cwd) => isAbsolute(cwd));
  // the folders are read off the event loop, and one of them may never answer: what a deadline passes is a claim,
  // as a read that failed is, and the check that was left waiting is not kept
  const claims = await beforePeerDeadline(folders, (folder) => folderClaims(folder, own, bound).catch(() => true));
  return claims === "late" || claims.includes(true);
}

const lettaPeerFolders = (pane: HerdrPane, panes: readonly HerdrPane[]): string[] =>
  panes.filter((other) => other.pane_id !== pane.pane_id && (other.agent === "letta" || other.agent_session?.agent === "letta"))
    .flatMap((other) => [other.foreground_cwd, other.cwd]).filter((cwd): cwd is string => typeof cwd === "string" && cwd !== "");

/**
 * Peer folders with a check still running past its deadline, by how many: on a mount that stopped answering,
 * each check left waiting holds a slot of Bun's fs pool until it settles, so none is started there meanwhile.
 */
const stuckPeers = new Map<string, number>();

async function beforePeerDeadline<T>(folders: readonly string[], check: (folder: string) => Promise<T>): Promise<T[] | "late"> {
  const unique = [...new Set(folders)];
  if (unique.some((folder) => stuckPeers.has(folder))) return "late";
  const settled = new Set<string>();
  let passed = false;
  const work = Promise.all(unique.map(async (folder) => {
    try { return await check(folder); } finally {
      if (!passed) settled.add(folder);
      else if (stuckPeers.get(folder) === 1) stuckPeers.delete(folder);
      else stuckPeers.set(folder, (stuckPeers.get(folder) ?? 1) - 1);
    }
  }));
  let late: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"late">((resolve) => { late = setTimeout(() => resolve("late"), peerClaimDeadline.ms); });
  try {
    const answer = await Promise.race([work, deadline]);
    if (answer === "late") {
      passed = true;
      for (const folder of unique) if (!settled.has(folder)) stuckPeers.set(folder, (stuckPeers.get(folder) ?? 0) + 1);
    }
    return answer;
  } finally { clearTimeout(late); }
}

/** Where Linux names an open descriptor's own path: what is opened through it is inside the folder held. */
const FD_DIR = "/proc/self/fd";
/**
 * How a peer's record is reached. `procFd`: Linux reaches into a held folder by its /proc/self/fd entry;
 * elsewhere (macOS, Windows, a Linux without /proc) the record is opened by its path and proven by its
 * identity instead (folderClaims).
 */
export const peerRecordReach = { procFd: ((): boolean => { try { return process.platform === "linux" && lstatSync(FD_DIR).isDirectory(); } catch { return false; } })() };
/** A folder opened as itself: O_DIRECTORY, and O_NOFOLLOW so a link put where it was stands refused. */
const FOLDER_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);

/** A folder's identity as the checks compare it: its device and inode, whole (a 64-bit inode does not fit a number). */
const deviceInode = (stat: { dev: bigint; ino: bigint }): string => `${stat.dev}:${stat.ino}`;

const sameChain = (a: readonly string[] | null, b: readonly string[] | null): boolean => {
  if (a === null || b === null || a.length !== b.length) return false;
  return a.every((at, step) => at === b[step]);
};

/**
 * Whether an error says only that nothing is there, not that it cannot be read. A file standing where a
 * folder should be (ENOTDIR) is something there, not absence.
 */
const absent = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** Whether what a lookup found missing is still missing on a second look: one gone only for a moment is there. */
const stillAbsent = async (error: unknown, again: () => Promise<unknown>): Promise<boolean> =>
  absent(error) && await again().then(() => false, absent);

/**
 * Whether a peer folder's record names the conversation, read without blocking (the folder may be on a
 * slow mount). The folder is opened itself, and its `.letta` and the record inside that, each through
 * the descriptor held before it, so nothing swapped into a folder already checked is read in its stead;
 * what was opened must be the folder the chain of plain folders from the root names, still where it was
 * resolved to after the read. Without /proc (peerRecordReach) the record is opened by its path, through
 * no final link where the platform refuses one, and the file opened must be the one the path names
 * after the read, on the device of the `.letta` the chain names. Either way the record read must be the
 * file its path names after the read. A record not proven to be the folder's own claims it unread: reached
 * through a link, or read under a folder, `.letta` or record swapped for a decoy and put back. Only a folder known to be gone claims nothing; one that cannot be resolved (no
 * permission, an I/O error) may hide a record of its own.
 */
async function folderClaims(folder: string, own: string | null, bound: { agent: string; conversation: string }): Promise<boolean> {
  let real: string;
  try { real = await realpath(folder); } catch (error) { return !await stillAbsent(error, () => realpath(folder)); }
  if (real === own) return false;
  const letta = join(real, ".letta");
  const path = join(letta, "settings.local.json");
  let before: string[] | null;
  try { before = await folderChain(letta); } catch (error) { return !await stillAbsent(error, () => folderChain(letta)); }
  if (before === null) return true;
  const held: FileHandle[] = [];
  // once the record is open, any failure claims: only a record missing as it is opened can be absent
  let recordOpened = false;
  try {
    const hold = async (at: string, flags: number): Promise<FileHandle> => { const handle = await open(at, flags); held.push(handle); return handle; };
    let record: FileHandle;
    if (peerRecordReach.procFd) {
      // the folder itself, then its .letta and the record inside the ones held: each opened through the one before, never by its path
      const peer = await hold(real, FOLDER_FLAGS);
      if (deviceInode(await peer.stat({ bigint: true })) !== before.at(-2)) return true;
      const hidden = await hold(join(FD_DIR, `${peer.fd}`, ".letta"), FOLDER_FLAGS);
      if (deviceInode(await hidden.stat({ bigint: true })) !== before.at(-1)) return true;
      record = await hold(join(FD_DIR, `${hidden.fd}`, "settings.local.json"), RECORD_FLAGS);
    } else record = await hold(path, RECORD_FLAGS);
    recordOpened = true;
    // a record whose own stat fails is not proven the folder's own: it claims
    const found = await record.stat({ bigint: true }).catch(() => null);
    if (found === null) return true;
    const readable = found.isFile() && found.size <= BigInt(SETTINGS_BYTES);
    const buffer = Buffer.alloc(readable ? Number(found.size) : 0);
    const { bytesRead } = readable ? await record.read(buffer, 0, buffer.length, 0) : { bytesRead: 0 };
    // the folders are what they were and the peer's folder still resolves to them: one swapped for a decoy and put back shows here
    if (!sameChain(before, await folderChain(letta).catch(() => null)) || await realpath(folder).catch(() => null) !== real) return true;
    // the file read is the one the path names now, however it was reached (a record swapped for a decoy and back shows here),
    // and when opened by its path, in the .letta the chain names
    // nothing at the path now (a decoy opened, the path then removed) or a stat that fails proves nothing: it claims
    if (await lstat(path, { bigint: true }).then(deviceInode, () => null) !== deviceInode(found)) return true;
    if (!peerRecordReach.procFd && !before.at(-1)!.startsWith(`${found.dev}:`)) return true;
    // a record that is not a plain file, or too large to read, may name the conversation: it claims
    if (!readable) return true;
    // a record rewritten in place while it was read (a short read, or a new size or time) is not what was read: it claims
    const after = await record.stat({ bigint: true });
    if (bytesRead !== buffer.length || after.size !== found.size || after.mtimeNs !== found.mtimeNs) return true;
    // an equal size and time do not prove the same bytes (a coarse mtime, or one put back): read it again, and any change claims
    const again = Buffer.alloc(buffer.length + 1);
    const reread = await record.read(again, 0, again.length, 0);
    if (reread.bytesRead !== bytesRead || !again.subarray(0, bytesRead).equals(buffer)) return true;
    // a record that does not read as one Letta writes (empty, cut short, malformed, another shape) may be one mid-write: it claims
    const opened = lettaOpenedSessions(buffer.toString("utf8"));
    return opened === null || opened.some((ref) => ref.agent === bound.agent && ref.conversation === bound.conversation);
  } catch (error) {
    // gone only for a moment (moved away and back) is no absence: only a record still gone as it is opened claims nothing
    return recordOpened || !await stillAbsent(error, () => lstat(path));
  } finally { for (const handle of held) await handle.close().catch(() => {}); }
}

/** Each folder from the root down to `dir`, by device and inode; null when one is not a plain folder (a link, or nothing). */
async function folderChain(dir: string): Promise<string[] | null> {
  const folders = [dir];
  while (dirname(folders.at(-1)!) !== folders.at(-1)) folders.push(dirname(folders.at(-1)!));
  const stats = await Promise.all(folders.map((at) => lstat(at, { bigint: true })));
  return stats.every((found) => found.isDirectory()) ? stats.map(deviceInode).reverse() : null;
}

/**
 * With no report (herdr-core sends none for Letta, nor does herdr without its Letta integration), the
 * conversation Letta's record names when it names one: a record older than the process is what that
 * process resumed, as it writes nothing for the conversation the record already names.
 */
export function lettaRecordedBinding(opened: readonly { agent: string; conversation: string }[]): { agent: string; conversation: string } | null {
  const first = opened[0];
  if (first === undefined || opened.some((ref) => ref.agent !== first.agent || ref.conversation !== first.conversation)) return null;
  return ID.test(first.agent) && ID.test(first.conversation) ? { agent: first.agent, conversation: first.conversation } : null;
}

/**
 * Two seconds: a file system that keeps whole seconds (HFS+) or two (FAT) rounds a write after the
 * start down to before it by less than this.
 */
const MTIME_SLACK_MS = 2000;

/**
 * The text of Letta's record when it is a regular file Letta can still rewrite (it writes in place and
 * goes on after a failed write, which would leave an old record standing for a new conversation), last
 * written at least MTIME_SLACK_MS before `startedAt`, and unchanged while it was read: its time and its
 * words come from one descriptor, checked again after the read. Null otherwise.
 */
function recordOlderThan(path: string, startedAt: number): string | null {
  let fd: number;
  try {
    if (!lstatSync(path).isFile()) return null;
    accessSync(path, constants.W_OK);
    fd = openSync(path, "r");
  } catch { return null; }
  try {
    const before = fstatSync(fd);
    if (before.mtimeMs >= startedAt - MTIME_SLACK_MS || before.size > SETTINGS_BYTES) return null;
    const buffer = Buffer.alloc(before.size);
    const got = readSync(fd, buffer, 0, before.size, 0);
    const after = fstatSync(fd);
    if (got !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size) return null;
    return buffer.toString("utf8");
  } catch { return null; } finally { closeSync(fd); }
}

/**
 * Whether `path` (lettaTranscriptPath under `root`) is a regular file reached through no link below
 * the root: false for a missing file, a link, or one that cannot be checked.
 */
export function lettaTranscriptHeld(path: string, root: string): boolean {
  try {
    if (!lstatSync(path).isFile()) return false;
    return realpathSync(path) === join(realpathSync(root), path.slice(root.length));
  } catch { return false; }
}

const canonical = (path: string): string | null => { try { return realpathSync(path); } catch { return null; } };

/**
 * Whether Letta's project record can speak for the pane's process at all: not in its home folder,
 * where Letta with LETTA_CONFIG_DIR writes no project record (so an old one stays), and not while
 * another pane runs Letta in the same folder, which writes the same record.
 */
export async function lettaRecordOwned(pane: HerdrPane, panes: readonly HerdrPane[], owner: LettaProcess): Promise<boolean> {
  const resolve = (path: string): Promise<string | null> => realpath(path).catch(() => null);
  const [folder, home] = await Promise.all([resolve(owner.cwd), owner.env["HOME"] === undefined ? null : resolve(owner.env["HOME"])]);
  if (folder === null || home === null || home === folder) return false;
  // another pane's folder may be on an unresponsive mount: resolved off the event loop, and one that has not
  // answered by the deadline may be this folder, so the record is not this pane's
  const peers = await beforePeerDeadline(lettaPeerFolders(pane, panes), resolve);
  return peers !== "late" && !peers.includes(folder);
}

/** Letta's local backend store for an environment: `$LETTA_LOCAL_BACKEND_DIR`, else `lc-local-backend` in its config folder. */
export function lettaLocalStore(env: Env): string | null {
  const dir = env["LETTA_LOCAL_BACKEND_DIR"];
  if (dir !== undefined) return isAbsolute(dir) ? normalize(dir) : null;
  const config = lettaConfigDir(env);
  return config === null ? null : join(config, "lc-local-backend");
}

/**
 * Whether a local conversation (`local-conv-<n>`) is the agent's own in the process's store, where
 * Letta keys it by its id alone (`conversation:<id>`, one folder each, never reused across agents) and
 * names its agent. A cloud id (`conv-<uuid>`) or `default` (keyed with its agent) needs no such check.
 */
export function lettaLocalOwner(store: string, agent: string, conversation: string): boolean {
  if (!conversation.startsWith("local-conv-")) return true;
  const record = join(store, "conversations", Buffer.from(`conversation:${conversation}`).toString("base64url"), "conversation.json");
  const text = readBounded(record, SETTINGS_BYTES);
  if (text === null) return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && (parsed as Record<string, unknown>)["id"] === conversation
      && (parsed as Record<string, unknown>)["agent_id"] === agent;
  } catch { return false; }
}

const recordAt = (path: string): Record<string, unknown> | null => {
  const text = readBounded(path, SETTINGS_BYTES);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
};
const fields = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const word = (value: unknown): string | null => typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * The model and reasoning effort Letta runs a local conversation with, as its local backend resolves
 * them for a turn: the conversation's own `model` (what `/model` sets in it), else its agent's, and the
 * conversation's `model_settings` over the agent's, whose effort Letta reads (reasoningForSettings) as
 * `reasoning.reasoning_effort`, else `effort` (what it writes for Anthropic and Bedrock), else
 * `reasoning_effort`. Letta's transcript names neither, and `/model` writes no turn. Null for a cloud
 * conversation, whose settings live on the server, and for records that do not read as Letta writes
 * them, name another agent, or (a local conversation's) another conversation.
 */
export function lettaLocalSettings(store: string, agent: string, conversation: string): ConversationMetadata | null {
  const key = conversation === "default" ? `default:${agent}` : conversation.startsWith("local-conv-") ? `conversation:${conversation}` : null;
  if (key === null) return null;
  const own = recordAt(join(store, "conversations", Buffer.from(key).toString("base64url"), "conversation.json"));
  const base = recordAt(join(store, "agents", `${Buffer.from(agent).toString("base64url")}.json`));
  if (own === null || base === null || own["agent_id"] !== agent || base["id"] !== agent) return null;
  if (conversation !== "default" && own["id"] !== conversation) return null;
  const settings = { ...fields(base["model_settings"]), ...fields(own["model_settings"]) };
  return {
    model: word(own["model"]) ?? word(base["model"]),
    reasoning_effort: word(fields(settings["reasoning"])["reasoning_effort"] ?? settings["effort"] ?? settings["reasoning_effort"]),
  };
}

/**
 * The local backend's own record of a conversation's messages, which Letta appends to as a turn goes
 * (its transcript is written only when the turn ends); null for a cloud conversation, kept on the server.
 */
export function lettaMessagesPath(store: string, agent: string, conversation: string): string | null {
  const key = conversation === "default" ? `default:${agent}` : conversation.startsWith("local-conv-") ? `conversation:${conversation}` : null;
  return key === null ? null : join(store, "conversations", Buffer.from(key).toString("base64url"), "messages.jsonl");
}

export async function resolveLettaTranscript(pane: HerdrPane, panes: readonly HerdrPane[], known?: ProcessInfo | null): Promise<(LettaTranscript & { store: string; startedAt: number }) | null> {
  const owner = await paneLettaProcess(pane.pane_id, known);
  if (owner === null || !lettaInStartFolder(owner) || !(await lettaRecordOwned(pane, panes, owner))) return null;
  const found = await lettaTranscriptFor(pane, panes, owner);
  const store = lettaLocalStore(owner.env);
  const root = lettaTranscriptRoot(owner.env);
  if (found === null || store === null || root === null || !lettaLocalOwner(store, found.agent, found.conversation)) return null;
  // the peer folders above (lettaRecordOwned resolves them all, claimedElsewhere reads their records) are answered while
  // this waits: the pane's letta may have exited, or moved to another project (whose record is another one's) since.
  // herdr is then asked once more, and only the same process in the same folder binds; with no peer nothing was waited on
  if (lettaPeerFolders(pane, panes).length > 0) {
    const same = await paneLettaProcess(pane.pane_id).catch(() => null);
    if (same === null || same.pid !== owner.pid || same.identity !== owner.identity || same.cwd !== owner.cwd || !lettaInStartFolder(same)) return null;
  }
  return lettaTranscriptHeld(found.path, root) ? { ...found, store, startedAt: owner.startedAt } : null;
}
