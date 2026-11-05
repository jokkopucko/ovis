import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, readdirSync, type BigIntStats, type Dir, type Dirent, type Stats, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { SessionHistoryAgent, SessionSnapshot } from "../shared/protocol.ts";
import { HEAD_BYTES, HERMES_CANDIDATES, listSessions, MAX_ENTRIES, MAX_ROWS, MAX_STATS, MAX_WALK, SESSION_HISTORY_AGENTS } from "./session-history.ts";
import { handleSessionHistoryRequest, handleSessionResumeRequest, type PaneProcesses, RESUME_BUDGET_S, workspaceFolder } from "./session-history-routes.ts";
import { claudeProjectDir, darwinProcess, forgetClaudeSessions } from "./claude-store.ts";
import { slowMachinePath } from "./machine-api.ts";
import type { ProcessRow } from "./windows-processes.ts";
import { codexRolloutPath } from "./codex.ts";
import rolloutHeaders from "./fixtures/codex-rollout-headers.json";

/** A stat as the listing asks for it: with `bigint`, the identity an NTFS file ID above 2^53 keeps exactly. */
const statAs = (path: string, bigint?: boolean): Stats | BigIntStats => bigint ? statSync(path, { bigint: true }) : statSync(path);
const FIXTURES = join(import.meta.dir, "fixtures", "session-history");
const WINDOWS = process.platform === "win32";
const CWD = WINDOWS ? "C:\\work\\project" : "/work/project";
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
/** The folder each agent names after CWD, as the agent itself spells it. */
const FOLDERS: Partial<Record<SessionHistoryAgent, string>> = WINDOWS
  ? { claude: "C--work-project", pi: "--C--work-project--", omo: "--C--work-project--", omp: "--C--work-project--", gjc: "--C--work-project--", grok: "C%3A%5Cwork%5Cproject" }
  : { claude: "-work-project", pi: "--work-project--", omo: "--work-project--", omp: "--work-project--", gjc: "--work-project--", cmd: "work-project", grok: "%2Fwork%2Fproject" };
const EXPECTED: Record<SessionHistoryAgent, [string, string]> = {
  claude: [ID(2), ID(1)], codex: [ID(2), ID(1)], pi: [ID(2), ID(1)], omp: [ID(2), ID(1)], gjc: [ID(2), ID(1)], cmd: [ID(2), ID(1)],
  omo: [ID(2), ID(1)], grok: [ID(2), ID(1)], agy: [ID(2), ID(1)],
  opencode: ["ses_fixture0002", "ses_fixture0001"],
  hermes: ["20261002_090000_fx0002", "20261001_090000_fx0001"],
  devin: ["fixture-0002", "fixture-0001"],
};

const root = mkdtempSync(join(tmpdir(), "ovis-session-history-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let homes = 0;
const newHome = () => { const home = join(root, `home-${++homes}`); mkdirSync(home); return home; };

const sql = (value: string) => `'${value.replaceAll("'", "''")}'`;
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)]);
}

function install(agent: SessionHistoryAgent, home: string): void {
  const source = join(FIXTURES, agent);
  for (const file of filesUnder(source)) {
    const rel = relative(source, file).split(/[/\\]/).map((part, at) => part === "@folder" ? FOLDERS[agent]! : at === 0 && part.startsWith("dot-") ? `.${part.slice(4)}` : part);
    const target = join(home, ...rel);
    mkdirSync(dirname(target), { recursive: true });
    const text = readFileSync(file, "utf8").replaceAll('"{{CWD}}"', JSON.stringify(CWD));
    if (target.endsWith(".sql")) {
      const db = new Database(target.replace(/\.sql$/, ".db"), { create: true });
      // one transaction: a statement each would sync the disk each time, seconds on a loaded machine
      db.transaction(() => db.exec(text.replaceAll(":cwd", sql(CWD)).replaceAll(":uris", sql(JSON.stringify([pathToFileURL(CWD).href])))))();
      db.close();
      continue;
    }
    writeFileSync(target, text);
    const seconds = Date.parse("2026-10-01T00:00:00Z") / 1000 + (/0002|0004/.test(target) ? 2000 : 1000);
    utimesSync(target, seconds, seconds);
  }
}

/** Whether this machine lets a test make symlinks (Windows needs Developer Mode or elevation). */
function canSymlink(): boolean {
  const probe = join(root, "probe-link");
  try { symlinkSync(root, probe, "dir"); rmSync(probe); return true; }
  catch (error) { if (WINDOWS && (error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
}
const SYMLINKS = canSymlink();

const piHeader = (id: string, cwd = CWD, padding = "") => `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T09:00:00.000Z", cwd, ...(padding ? { padding } : {}) })}\n`;
const piPrompt = (text: string) => `${JSON.stringify({ type: "message", message: { role: "user", content: text } })}\n`;
const piStore = (home: string) => join(home, ".pi", "agent", "sessions", FOLDERS.pi!);

describe("listSessions", () => {
  for (const agent of SESSION_HISTORY_AGENTS) {
    // Command Code's slug keeps a Windows drive's colon, which no Windows folder name may hold
    it.skipIf(agent === "cmd" && WINDOWS)(`lists ${agent}'s own sessions of the folder, newest first, with its resume command`, async () => {
      const home = newHome();
      install(agent, home);
      const rows = await listSessions(agent, CWD, { home, env: {} });
      expect(rows.map((row) => row.id)).toEqual(EXPECTED[agent]);
      expect(rows.map((row) => row.firstMessage)).toEqual([`Fixture ${agent} prompt 2`, `Fixture ${agent} prompt 1`]);
      for (const row of rows) {
        expect(row.resume?.argv[0]).toBe(agent);
        expect(row.resume?.argv.at(-1)).toBe(row.id);
        expect(row.startedAt).not.toBeNull();
        expect(Number.isNaN(Date.parse(row.updatedAt))).toBe(false);
      }
      expect(Date.parse(rows[0]!.updatedAt)).toBeGreaterThan(Date.parse(rows[1]!.updatedAt));
    });
  }

  it("lists nothing from a store that is not there", async () => {
    const home = newHome();
    for (const agent of SESSION_HISTORY_AGENTS) expect(await listSessions(agent, CWD, { home, env: {} })).toEqual([]);
  });

  it.skipIf(!SYMLINKS)("refuses a session file or folder that a link puts outside the store", async () => {
    const home = newHome();
    install("pi", home);
    const outside = join(root, `outside-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "escaped.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    symlinkSync(join(outside, "escaped.jsonl"), join(piStore(home), "escaped.jsonl"));
    install("codex", home);
    mkdirSync(join(outside, "day"));
    writeFileSync(join(outside, "day", `rollout-2026-10-09T09-00-00-${ID(9)}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: ID(9), cwd: CWD, source: "cli" } })}\n`);
    symlinkSync(join(outside, "day"), join(home, ".codex", "sessions", "2026", "10", "09"), "dir");
    expect((await listSessions("pi", CWD, { home, env: {} })).map((row) => row.id)).toEqual(EXPECTED.pi);
    expect(listSessions("codex", CWD, { home, env: {} }).map((row) => row.id)).toEqual(EXPECTED.codex);
  });

  it(`returns at most ${MAX_ROWS} sessions, the newest`, async () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (let n = 0; n < MAX_ROWS + 10; n++) {
      const path = join(piStore(home), `session-${String(n).padStart(3, "0")}.jsonl`);
      writeFileSync(path, piHeader(`session-${n}`) + piPrompt(`prompt ${n}`));
      utimesSync(path, 1_790_000_000 + n, 1_790_000_000 + n);
    }
    const rows = await listSessions("pi", CWD, { home, env: {} });
    expect(rows).toHaveLength(MAX_ROWS);
    expect(rows[0]!.id).toBe(`session-${MAX_ROWS + 9}`);
    expect(rows.at(-1)!.id).toBe("session-10");
  });

  it("still reads only the head of a 10 MB non-Pi family session file", () => {
    const home = newHome();
    const store = join(home, ".omp", "agent", "sessions", FOLDERS.omp!);
    mkdirSync(store, { recursive: true });
    const path = join(store, "large.jsonl");
    writeFileSync(path, piHeader(ID(5)) + piPrompt("large prompt") + `${JSON.stringify({ type: "message", message: { role: "assistant", content: "x".repeat(10 * 1024 * 1024) } })}\n`);
    expect(statSync(path).size).toBeGreaterThan(10 * 1024 * 1024);
    let bytes = 0;
    const rows = listSessions("omp", CWD, {
      home, env: {},
      readHead: (fd, max) => {
        const buffer = Buffer.alloc(max);
        const read = readSync(fd, buffer, 0, max, 0);
        bytes += read;
        return buffer.subarray(0, read);
      },
    });
    expect(rows.map((row) => [row.id, row.firstMessage])).toEqual([[ID(5), "large prompt"]]);
    expect(bytes).toBe(HEAD_BYTES);
  });

  /** A Codex store holding the shared fixture table's rollouts; returns the day folder and how many bytes each listing reads. */
  const codexTable = (home: string) => {
    const day = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    rolloutHeaders.cases.forEach((fixture, at) => {
      const path = join(day, fixture.file);
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: fixture.payload }).replaceAll('"{{CWD}}"', JSON.stringify(CWD))}\n`
        + `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: fixture.name } })}\n`);
      utimesSync(path, 1_790_000_000 + at, 1_790_000_000 + at);
    });
    return day;
  };
  const countingReads = () => {
    const reads = { files: 0, bytes: 0 };
    const readHead = (fd: number, max: number) => {
      const buffer = Buffer.alloc(max);
      const read = readSync(fd, buffer, 0, max, 0);
      reads.files++; reads.bytes += read;
      return buffer.subarray(0, read);
    };
    return { reads, readHead };
  };

  it("live and history share interactive rollout eligibility", () => {
    const home = newHome();
    const day = codexTable(home);
    const { reads, readHead } = countingReads();
    const rows = listSessions("codex", CWD, { home, env: {}, readHead });
    const eligible = rolloutHeaders.cases.filter((fixture) => fixture.interactive);
    // newest first, each with the prompt and the resume command of its own verified id
    expect(rows.map((row) => [row.id, row.firstMessage, row.resume?.argv])).toEqual([...eligible].reverse()
      .map((fixture) => [String(fixture.payload.id), fixture.name, ["codex", "resume", String(fixture.payload.id)]]));
    // the same files, and only they, are the live reader's
    for (const fixture of rolloutHeaders.cases) {
      expect([fixture.name, codexRolloutPath(join(day, fixture.file), join(home, ".codex")) !== null]).toEqual([fixture.name, fixture.interactive]);
    }
    // refusing a child or a contradiction reads nothing past each file's one head read
    expect(reads.files).toBe(rolloutHeaders.cases.length);
  });

  it("legacy omitted identities remain interactive", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const thread = "01a0d000-0000-7000-8000-0000000000dd";
    const legacy = { id: thread, timestamp: "2026-10-20T09:00:00.000Z", cwd: CWD, originator: "codex_cli_rs", cli_version: "0.0.0-fixture" };
    const path = join(day, `rollout-2026-10-20T09-00-00-${thread}.jsonl`);
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: legacy })}\n`);
    expect(listSessions("codex", CWD, { home, env: {} }).map((row) => [row.id, row.resume?.argv])).toEqual([[thread, ["codex", "resume", thread]]]);
    expect(codexRolloutPath(path, join(home, ".codex"))).toBe(path);
    // no id at all: nothing contradicts the file, and the live reader still takes it; the
    // history has no id to resume it by
    writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { ...legacy, id: undefined } })}\n`);
    expect(codexRolloutPath(path, join(home, ".codex"))).toBe(path);
    expect(listSessions("codex", CWD, { home, env: {} })).toEqual([]);
  });

  it("refuses an explicit null identity in live and history alike", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const thread = "01a0d000-0000-7000-8000-0000000000dd";
    const path = join(day, `rollout-2026-10-20T09-00-00-${thread}.jsonl`);
    const base = { id: thread, session_id: thread, cwd: CWD, source: "cli", thread_source: "user" };
    const eligible = (payload: unknown) => {
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload })}\n`);
      return [codexRolloutPath(path, join(home, ".codex")) !== null, listSessions("codex", CWD, { home, env: {} }).map((row) => row.resume?.argv)];
    };
    expect(eligible(base)).toEqual([true, [["codex", "resume", thread]]]);
    // a null id or session_id is present and not a thread: neither path takes it
    expect(eligible({ ...base, session_id: null })).toEqual([false, []]);
    expect(eligible({ ...base, id: null })).toEqual([false, []]);
  });

  it("lists a genuine fork apart from any child, as a thread of its own", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "20");
    mkdirSync(day, { recursive: true });
    const fork = "01a0d000-0000-7000-8000-0000000000ee";
    writeFileSync(join(day, `rollout-2026-10-20T09-00-00-${fork}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: {
      id: fork, session_id: fork, forked_from_id: rolloutHeaders.parent, cwd: CWD, source: "cli", thread_source: "user",
      history_base: { thread_id: rolloutHeaders.parent, end_ordinal_exclusive: 3, end_byte_offset: 400 } } })}\n`);
    expect(listSessions("codex", CWD, { home, env: {} }).map((row) => row.id)).toEqual([fork]);
  });

  it("a cut header cannot hide a child marker", () => {
    const home = newHome();
    const day = join(home, ".codex", "sessions", "2026", "10", "01");
    mkdirSync(day, { recursive: true });
    const path = join(day, `rollout-2026-10-01T09-00-00-${ID(1)}.jsonl`);
    const prompt = `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "cut prompt" } })}\n`;
    /** A header line of exactly `length` bytes, the marker (when asked) at its end. */
    const header = (length: number, marker: boolean) => {
      const line = (padding: string) => JSON.stringify({ type: "session_meta", payload: {
        id: ID(1), timestamp: "2026-10-01T09:00:00.000Z", cwd: CWD, source: "cli", base_instructions: { text: padding }, ...(marker ? { thread_source: "subagent" } : {}) } });
      const text = line("i".repeat(length - Buffer.byteLength(line(""))));
      expect(Buffer.byteLength(text)).toBe(length);
      return text;
    };
    const listed = (body: string) => {
      writeFileSync(path, body);
      const { reads, readHead } = countingReads();
      const ids = listSessions("codex", CWD, { home, env: {}, readHead }).map((row) => row.id);
      // never more than the one head read
      expect(reads).toEqual({ files: 1, bytes: Math.min(HEAD_BYTES, Buffer.byteLength(body)) });
      return ids;
    };
    // the marker past the read: the header is not listed, and neither is one without it
    expect(listed(`${header(2 * HEAD_BYTES, true)}\n${prompt}`)).toEqual([]);
    expect(listed(`${header(2 * HEAD_BYTES, false)}\n${prompt}`)).toEqual([]);
    // byte boundaries: a header whose newline is the read's last byte is whole and checked
    expect(listed(`${header(HEAD_BYTES - 1, false)}\n${prompt}`)).toEqual([ID(1)]);
    expect(listed(`${header(HEAD_BYTES - 1, true)}\n${prompt}`)).toEqual([]);
    // one byte longer fills the read without its newline: not listed
    expect(listed(`${header(HEAD_BYTES, false)}\n${prompt}`)).toEqual([]);
    // a file that is only its header, without a newline, ends within the read
    expect(listed(header(HEAD_BYTES - 1, false))).toEqual([ID(1)]);
    // a malformed first line, or a first record that is not session_meta, is no rollout
    expect(listed(`{"type":"session_meta","payload":\n${prompt}`)).toEqual([]);
    expect(listed(`${JSON.stringify({ type: "event_msg", payload: { id: ID(1), cwd: CWD, source: "cli" } })}\n${prompt}`)).toEqual([]);
  });

  it.skipIf(!SYMLINKS)("refuses a SQLite store that a link puts outside the store", () => {
    for (const [agent, dir, db] of [["hermes", [".hermes"], "state.db"], ["opencode", [".local", "share", "opencode"], "opencode.db"]] as const) {
      const home = newHome();
      install(agent, home);
      const outside = join(root, `outside-db-${homes}`);
      mkdirSync(outside);
      renameSync(join(home, ...dir, db), join(outside, db));
      symlinkSync(join(outside, db), join(home, ...dir, db));
      expect(listSessions(agent, CWD, { home, env: {} })).toEqual([]);
    }
  });

  it(`looks at no more than ${MAX_STATS} paths for one listing`, () => {
    const home = newHome();
    const group = join(home, ".grok", "sessions", FOLDERS.grok!);
    for (let n = 0; n < MAX_STATS + 50; n++) {
      const dir = join(group, `session-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: `session-${n}`, cwd: CWD }, updated_at: "2026-10-01T09:00:00Z" }));
    }
    let stats = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, stat: (path, bigint) => { stats++; return statAs(path, bigint); } });
    expect(stats).toBeGreaterThan(MAX_ROWS);
    expect(stats).toBeLessThanOrEqual(MAX_STATS);
    expect(rows).toHaveLength(MAX_ROWS);
  });

  it.skipIf(!SYMLINKS)(`counts every path resolution against the ${MAX_STATS} checks, whether it resolves, fails or lands outside`, async () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const outside = join(root, `outside-links-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "elsewhere.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    for (let n = 0; n < 2000; n++) symlinkSync(join(outside, `gone-${n}.jsonl`), join(piStore(home), `dangling-${String(n).padStart(4, "0")}.jsonl`));
    for (let n = 0; n < 100; n++) symlinkSync(join(outside, "elsewhere.jsonl"), join(piStore(home), `outside-${n}.jsonl`));
    let resolutions = 0;
    let stats = 0;
    const rows = await listSessions("pi", CWD, {
      home, env: {},
      resolve: (path) => { resolutions++; return realpathSync(path); },
      stat: (path, bigint) => { stats++; return statAs(path, bigint); },
    });
    expect(rows).toEqual([]);
    expect(resolutions).toBeGreaterThan(MAX_ROWS);
    expect(resolutions + stats).toBeLessThanOrEqual(MAX_STATS);
  });

  it.skipIf(!SYMLINKS)("reads nothing from a session file swapped for a link out of the store after it was checked", async () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const outside = join(root, `outside-swap-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    const session = join(piStore(home), "session.jsonl");
    writeFileSync(session, piHeader(ID(1)) + piPrompt("inside the store"));
    const checked = realpathSync(session);
    const rows = await listSessions("pi", CWD, {
      home, env: {},
      // the file is checked, then swapped for a link out of the store before it is opened
      stat: (path, bigint) => {
        const stat = statAs(path, bigint);
        if (path === checked) { rmSync(path); symlinkSync(join(outside, "secret.jsonl"), path); }
        return stat;
      },
    });
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  // a session file is one check (its resolution with its stat). On Windows a session of another
  // folder also spends two on its folder's file IDs, so this many of them would use the budget there
  it.skipIf(WINDOWS)("lists a folder's older Codex rollouts behind about 300 newer rollouts of other folders", () => {
    const home = newHome();
    const rollout = (day: string, n: number, at: number, cwd: string) => {
      const dir = join(home, ".codex", "sessions", "2026", "10", day);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `rollout-2026-10-${day}T09-00-00-${n.toString(16).padStart(12, "0")}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "session_meta", payload: { id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, cwd, source: "cli" } })}\n`);
      utimesSync(path, at, at);
    };
    for (let n = 0; n < 300; n++) rollout(String(20 + (n % 3)), 0x1000 + n, 1_790_100_000 + n, "/elsewhere");
    rollout("01", 1, 1_790_000_000, CWD);
    rollout("01", 2, 1_790_000_001, CWD);
    let resolutions = 0;
    const rows = listSessions("codex", CWD, { home, env: {}, resolve: (path) => { resolutions++; return realpathSync(path); } });
    expect(rows.map((row) => row.id)).toEqual([ID(2), ID(1)]);
    expect(resolutions).toBeLessThanOrEqual(MAX_STATS);
  });

  it.skipIf(!SYMLINKS)("reads nothing from a SQLite store swapped for a link to another database after it was checked", () => {
    const home = newHome();
    install("hermes", home);
    const elsewhere = newHome();
    install("hermes", elsewhere);
    const outside = new Database(join(elsewhere, ".hermes", "state.db"));
    outside.exec("UPDATE messages SET content = 'outside the store' WHERE role = 'user'");
    outside.close();
    const checked = realpathSync(join(home, ".hermes", "state.db"));
    let swapped = false;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      // the database is checked, then swapped for a link to another one before it is opened
      stat: (path, bigint) => {
        const stat = statAs(path, bigint);
        if (path === checked && !swapped) { swapped = true; rmSync(path); symlinkSync(join(elsewhere, ".hermes", "state.db"), path); }
        return stat;
      },
    });
    expect(swapped).toBe(true);
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  it.skipIf(!SYMLINKS)("gives a head reader only the checked descriptor, never an unchecked path", () => {
    const home = newHome();
    const store = join(home, ".omp", "agent", "sessions", FOLDERS.omp!);
    mkdirSync(store, { recursive: true });
    const outside = join(root, `outside-reader-${homes}`);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.jsonl"), piHeader(ID(9)) + piPrompt("outside the store"));
    const session = join(store, "session.jsonl");
    writeFileSync(session, piHeader(ID(1)) + piPrompt("inside the store"));
    const checked = realpathSync(session);
    let swap = false;
    const targets: Array<number | string> = [];
    const listed = () => listSessions("omp", CWD, {
      home, env: {},
      stat: (path, bigint) => {
        const stat = statAs(path, bigint);
        if (path === checked && swap) { rmSync(path); symlinkSync(join(outside, "secret.jsonl"), path); }
        return stat;
      },
      // A deliberately unchecked reader: handed a path, it would follow the swapped-in link.
      readHead: ((target: number | string, max: number) => {
        targets.push(target);
        if (typeof target !== "number") return readFileSync(target).subarray(0, max);
        const buffer = Buffer.alloc(max);
        return buffer.subarray(0, readSync(target, buffer, 0, max, 0));
      }) as never,
    });
    expect(listed().map((row) => row.firstMessage)).toEqual(["inside the store"]);
    expect(targets.map((target) => typeof target)).toEqual(["number"]);
    swap = true;
    expect(listed()).toEqual([]);
    // The unsafe replacement was refused before the reader could see it.
    expect(targets).toHaveLength(1);
  });

  // NTFS file IDs often pass 2^53: two that differ only in their low bits round to one number
  const NEAR = 2n ** 60n;
  const withIno = <T extends Stats | BigIntStats>(stat: T, ino: bigint): T =>
    Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as T, stat, { ino: typeof stat.ino === "bigint" ? ino : Number(ino) });

  it("refuses a session file whose opened identity differs from the checked one only past 2^53", async () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const session = join(piStore(home), "session.jsonl");
    writeFileSync(session, piHeader(ID(1)) + piPrompt("inside the store"));
    const checked = realpathSync(session);
    const listed = async (opened: bigint) => (await listSessions("pi", CWD, {
      home, env: {},
      stat: (path, bigint) => path === checked ? withIno(statAs(path, bigint), NEAR + 1n) : statAs(path, bigint),
      fstat: (fd, bigint) => withIno(bigint ? fstatSync(fd, { bigint: true }) : fstatSync(fd), opened),
    })).map((row) => row.id);
    expect(await listed(NEAR + 1n)).toEqual([ID(1)]);
    expect(await listed(NEAR + 2n)).toEqual([]);
  });

  it("refuses a SQLite store whose opened descriptor differs from the checked one only past 2^53", () => {
    const home = newHome();
    install("hermes", home);
    const checked = realpathSync(join(home, ".hermes", "state.db"));
    const listed = (opened: bigint) => listSessions("hermes", CWD, {
      home, env: {},
      stat: (path, bigint) => path === checked ? withIno(statAs(path, bigint), NEAR + 1n) : statAs(path, bigint),
      fstat: (fd, bigint) => withIno(bigint ? fstatSync(fd, { bigint: true }) : fstatSync(fd), opened),
    }).length;
    expect(listed(NEAR + 1n)).toBe(2);
    expect(listed(NEAR + 2n)).toBe(0);
  });

  it("reads nothing from a SQLite store swapped for another database and swapped back between its two checks", () => {
    const home = newHome();
    install("hermes", home);
    const elsewhere = newHome();
    install("hermes", elsewhere);
    const outside = new Database(join(elsewhere, ".hermes", "state.db"));
    outside.exec("UPDATE messages SET content = 'outside the store' WHERE role = 'user'");
    outside.close();
    const checked = realpathSync(join(home, ".hermes", "state.db"));
    const kept = `${checked}.kept`;
    let seen = 0;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      stat: (path, bigint) => {
        if (path !== checked) return statAs(path, bigint);
        // at its check the database is swapped for another one (a file, which no link check sees), and
        // swapped back before the next look, so both looks see the checked file
        if (seen++ === 0) {
          const stat = statAs(path, bigint);
          renameSync(checked, kept); copyFileSync(join(elsewhere, ".hermes", "state.db"), checked);
          return stat;
        }
        if (seen === 2) { rmSync(checked); renameSync(kept, checked); }
        return statAs(path, bigint);
      },
    });
    expect(rows.map((row) => row.firstMessage)).not.toContain("outside the store");
    expect(rows).toEqual([]);
  });

  it("finds Windows Hermes under LOCALAPPDATA, where 0.21.5 keeps it, and an earlier build's root only while it is the only store", () => {
    const home = newHome();
    const local = join(home, "Local");
    install("hermes", home);
    mkdirSync(local);
    renameSync(join(home, ".hermes"), join(local, "hermes"));
    expect(listSessions("hermes", CWD, { home, env: { LOCALAPPDATA: local }, platform: "win32" }).map((row) => row.id)).toEqual(EXPECTED.hermes);
    const legacy = newHome();
    install("hermes", legacy);
    expect(listSessions("hermes", CWD, { home: legacy, env: { LOCALAPPDATA: join(legacy, "Local") }, platform: "win32" }).map((row) => row.id)).toEqual(EXPECTED.hermes);
  });

  it("looks for stores under the OS's home, never a relative path, when the environment names none", () => {
    const looked: string[] = [];
    listSessions("claude", CWD, { env: {}, platform: "linux", stat: (path, bigint) => { looked.push(path); return statAs(path, bigint); } });
    expect(looked.length).toBeGreaterThan(0);
    expect(looked.filter((path) => !isAbsolute(path))).toEqual([]);
  });

  it("counts Windows Hermes's home probes against the listing's checks", () => {
    const home = newHome();
    const looked: string[] = [];
    const stat = (path: string, bigint?: boolean) => { looked.push(path); return statAs(path, bigint); };
    expect(listSessions("hermes", CWD, { home, env: { LOCALAPPDATA: join(home, "Local") }, platform: "win32", spent: MAX_STATS, stat })).toEqual([]);
    expect(looked).toEqual([]);
    listSessions("hermes", CWD, { home, env: { LOCALAPPDATA: join(home, "Local") }, platform: "win32", stat });
    expect(looked).toContain(join(home, "Local", "hermes", "state.db"));
  });

  it("looks in USERPROFILE on Windows when no home is given, even with HOME set", () => {
    const profile = newHome();
    install("hermes", profile);
    mkdirSync(join(profile, "AppData", "Local"), { recursive: true });
    renameSync(join(profile, ".hermes"), join(profile, "AppData", "Local", "hermes"));
    expect(listSessions("hermes", CWD, { env: { HOME: newHome(), USERPROFILE: profile }, platform: "win32" }).map((row) => row.id)).toEqual(EXPECTED.hermes);
  });

  const sideFiles = (dir: string) => readdirSync(dir).filter((name) => /-(wal|shm)$/.test(name)).sort();

  it("writes no -wal or -shm into a closed WAL store when no writer arrives", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const writer = new Database(db);
    writer.exec("PRAGMA journal_mode = WAL");
    writer.close();
    const before = sideFiles(dirname(db));
    let reads = 0;
    expect(listSessions("hermes", CWD, { home, env: {}, opened: () => { reads++; } }).map((row) => row.id)).toEqual(EXPECTED.hermes);
    expect(sideFiles(dirname(db))).toEqual(before);
    // nobody wrote meanwhile: the immutable read stands, and the store is read once
    expect(reads).toBe(1);
  });

  it("reads a WAL store once more, as it is being written, when a writer checkpoints into it during an immutable read", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const setup = new Database(db);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();
    let writer: Database | undefined;
    let reads = 0;
    try {
      const rows = listSessions("hermes", CWD, {
        home, env: {},
        // between the immutable open and the query, another connection writes and checkpoints into the
        // main file (an agent opening its store, writing, checkpointing); it stays open, as a writer does
        opened: (_path, immutable) => {
          reads++;
          if (!immutable || writer) return;
          writer = new Database(db);
          writer.exec("PRAGMA wal_autocheckpoint = 0");
          writer.transaction(() => {
            writer!.query("INSERT INTO sessions VALUES ('20261005_090000_fx0005', 'cli', NULL, 1791190800, NULL, ?, 'Fresh hermes title', 1791194400)").run(CWD);
            writer!.exec("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261005_090000_fx0005', 'user', 'fresh prompt', 1791190801)");
            writer!.exec("UPDATE messages SET content = 'rewritten prompt' WHERE role = 'user' AND session_id != '20261005_090000_fx0005'");
            for (let n = 0; n < 6000; n++) writer!.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261004_090000_fx0004', 'assistant', ?, 1791104401)").run(`filler ${n} ${"x".repeat(200)}`);
          })();
          writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        },
      });
      expect(rows.map((row) => [row.id, row.firstMessage])).toEqual([
        ["20261005_090000_fx0005", "fresh prompt"],
        ["20261002_090000_fx0002", "rewritten prompt"],
        ["20261001_090000_fx0001", "rewritten prompt"],
      ]);
      // the immutable read, then the one read as SQLite reads a store being written
      expect(reads).toBe(2);
    } finally { writer?.close(); }
  });

  it("reads a WAL store immutable once more, writing nothing into it, when its writer came and went during the read", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const setup = new Database(db);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();
    let reads = 0;
    let afterWriter: string[] | undefined;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      // between the immutable open and the query an agent opens the store, writes, checkpoints and
      // closes: its last close takes its side files with it
      opened: (_path, immutable) => {
        reads++;
        if (!immutable || afterWriter) return;
        const writer = new Database(db);
        writer.exec("UPDATE messages SET content = 'rewritten prompt' WHERE role = 'user'");
        writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        writer.close();
        afterWriter = sideFiles(dirname(db));
      },
    });
    // the listing made no side file of its own
    expect(sideFiles(dirname(db))).toEqual(afterWriter!);
    expect(rows.map((row) => row.firstMessage)).toEqual(["rewritten prompt", "rewritten prompt"]);
    expect(reads).toBe(2);
  });

  it("lists nothing when a writer changes the WAL store during both immutable reads", () => {
    // Given a closed WAL store and a writer that checkpoints and closes during each open.
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const setup = new Database(db);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();
    const modes: boolean[] = [];

    // When both immutable reads race a change to the main file.
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      opened: (_path, immutable) => {
        modes.push(immutable);
        const writer = new Database(db);
        try {
          writer.query("UPDATE messages SET content = ? WHERE role = 'user'").run(`rewritten prompt ${modes.length}`);
          writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally { writer.close(); }
        // Distinct fixed mtimes expose each change even within one filesystem timestamp tick.
        const seconds = 1_790_000_000 + modes.length;
        utimesSync(db, seconds, seconds);
      },
    });

    // Then the second immutable result is discarded, with no third attempt.
    expect(modes).toEqual([true, true]);
    expect(rows).toEqual([]);
  });

  it("lists nothing, and writes nothing into it, from a WAL store whose first read failed with no writer", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const setup = new Database(db);
    setup.exec("PRAGMA journal_mode = WAL");
    setup.close();
    const before = sideFiles(dirname(db));
    let reads = 0;
    const rows = listSessions("hermes", CWD, {
      home, env: {},
      // the first read fails (its connection is gone) while nobody writes: nothing changed, so it is not read again
      opened: (_path, immutable, opened) => { if (reads++ === 0 && immutable) opened.close(); },
    });
    expect(sideFiles(dirname(db))).toEqual(before);
    expect(rows).toEqual([]);
    expect(reads).toBe(1);
  });

  it("reads a restored WAL store whose -wal has no -shm immutable, writing nothing into it", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const writer = new Database(db);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE)");
    writer.exec("UPDATE messages SET content = 'only in the log' WHERE session_id = '20261002_090000_fx0002' AND role = 'user'");
    // a store restored from a copy: its main file and a valid -wal, no -shm
    const restored = newHome();
    mkdirSync(join(restored, ".hermes"));
    copyFileSync(db, join(restored, ".hermes", "state.db"));
    copyFileSync(`${db}-wal`, join(restored, ".hermes", "state.db-wal"));
    writer.close();
    const store = join(restored, ".hermes");
    const before = sideFiles(store);
    expect(before).toEqual(["state.db-wal"]);
    const rows = listSessions("hermes", CWD, { home: restored, env: {} });
    expect(sideFiles(store)).toEqual(before);
    // immutable reads the main file alone: what only the log holds is not seen
    expect(rows.map((row) => row.firstMessage)).toEqual(["Fixture hermes prompt 2", "Fixture hermes prompt 1"]);
  });

  it("lists nothing from a SQLite store whose path names another file once SQLite has opened it", () => {
    for (const wal of [false, true]) {
      const home = newHome();
      install("hermes", home);
      const db = join(home, ".hermes", "state.db");
      if (wal) { const setup = new Database(db); setup.exec("PRAGMA journal_mode = WAL"); setup.close(); }
      const checked = realpathSync(db);
      let opened = false;
      const listed = listSessions("hermes", CWD, {
        home, env: {},
        opened: () => { opened = true; },
        // once SQLite has opened the store, its path reports another file
        stat: (path, bigint) => path === checked && opened ? withIno(statAs(path, bigint), NEAR + 9n) : statAs(path, bigint),
      });
      expect([wal, listed]).toEqual([wal, []]);
    }
  });

  it("never reads a crashed writer's uncommitted change from a rollback-journal store", () => {
    const home = newHome();
    mkdirSync(join(home, ".hermes"));
    const db = join(home, ".hermes", "state.db");
    const writer = new Database(db, { create: true });
    // a writer whose uncommitted pages reach the main file (a tiny cache spills them), then a crash:
    // the main file and its hot -journal, as they are on disk
    writer.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = OFF");
    // Setup needs no disk syncs; eight padded rows still spill beyond the crash's one-page cache.
    writer.transaction(() => {
      writer.exec(readFileSync(join(FIXTURES, "hermes", "dot-hermes", "state.sql"), "utf8").replaceAll(":cwd", sql(CWD)));
      for (let n = 0; n < 8; n++) writer.query("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('20261004_090000_fx0004', 'assistant', ?, 1791104401)").run(`pad ${"x".repeat(500)}`);
    })();
    writer.exec("PRAGMA synchronous = FULL; PRAGMA cache_spill = ON; PRAGMA cache_size = 1");
    writer.exec("BEGIN; UPDATE messages SET content = 'uncommitted prompt' WHERE role = 'user'");
    writer.exec(`UPDATE messages SET content = '${"y".repeat(500)}' WHERE role = 'assistant'`);
    const crashed = newHome();
    mkdirSync(join(crashed, ".hermes"));
    copyFileSync(db, join(crashed, ".hermes", "state.db"));
    expect(existsSync(`${db}-journal`)).toBe(true);
    copyFileSync(`${db}-journal`, join(crashed, ".hermes", "state.db-journal"));
    writer.exec("ROLLBACK");
    writer.close();
    const rows = listSessions("hermes", CWD, { home: crashed, env: {} });
    expect(rows.map((row) => row.firstMessage)).not.toContain("uncommitted prompt");
  });

  it("lists a session still in a WAL store's log while its agent writes", () => {
    const home = newHome();
    install("hermes", home);
    const db = join(home, ".hermes", "state.db");
    const writer = new Database(db);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE)");
      // written after the last checkpoint: only the -wal holds it (an immutable open would miss it)
      writer.exec("UPDATE messages SET content = 'only in the log' WHERE session_id = '20261002_090000_fx0002' AND role = 'user'");
      const before = sideFiles(dirname(db));
      const rows = listSessions("hermes", CWD, { home, env: {} });
      expect(rows.map((row) => row.firstMessage)).toContain("only in the log");
      expect(sideFiles(dirname(db))).toEqual(before);
    } finally { writer.close(); }
  });

  it(`lists a database whose check is the ${MAX_STATS}th: its identity after the open is part of that check`, () => {
    const home = newHome();
    install("hermes", home);
    // a Hermes listing spends 6 checks up to its database's identity: the cwd's canonical form, the
    // store's stat and resolution, the database's and its folder's resolutions, then the identity
    const listed = (spent: number) => listSessions("hermes", CWD, { home, env: {}, spent }).length;
    expect(listed(MAX_STATS - 7)).toBe(2);
    expect(listed(MAX_STATS - 6)).toBe(2);
    // one check further and the identity is past the bound: nothing is listed
    expect(listed(MAX_STATS - 5)).toBe(0);
  });

  // the store hermes-agent's own SessionDB made, and what Hermes answered about each row
  // (scripts/hermes-history-schema-probe.ts)
  const HERMES_NATIVE = join(import.meta.dir, "fixtures", "hermes-history");
  const hermesEvidence = JSON.parse(readFileSync(join(HERMES_NATIVE, "evidence.json"), "utf8")) as {
    native_list_in_cwd: string[]; rows: Array<{ id: string; kind: string; resume_opens: string }>;
    decision: { proven: Array<{ id: string }> };
  };
  const nativeHermes = (home: string, change?: string) => {
    mkdirSync(join(home, ".hermes"));
    const db = new Database(join(home, ".hermes", "state.db"), { create: true });
    db.transaction(() => db.exec(readFileSync(join(HERMES_NATIVE, "state.sql"), "utf8").replaceAll(":cwd", sql(CWD))))();
    if (change) db.exec(change);
    db.close();
  };
  const kindOf = (id: string) => hermesEvidence.rows.find((row) => row.id === id)!.kind;

  it("lists Hermes's branched and reset conversations of the folder with their own ids, and none of its other children", () => {
    const home = newHome();
    nativeHermes(home);
    const rows = listSessions("hermes", CWD, { home, env: {} });
    // left out, as Hermes resumes each as another row: fx0106 (an older branch branched again) as
    // fx0119, fx0121 through its empty child as fx0123, fx0129 (no end reason) as its unmarked child,
    // fx0132 (a legacy branch compressed later) as its continuation; fx0135, a reset compressed later,
    // resumes as itself
    expect(rows.map((row) => `${row.id.slice(-6)} ${kindOf(row.id)}`)).toEqual([
      "fx0135 reset", "fx0134 root", "fx0131 root", "fx0128 root", "fx0125 branch", "fx0124 root", "fx0120 root", "fx0119 legacy-branch", "fx0110 branch",
      "fx0109 root", "fx0108 legacy-reset", "fx0107 root", "fx0105 root", "fx0104 reset", "fx0103 root",
      "fx0102 branch", "fx0101 root",
    ]);
    // the children are exactly those Hermes lists in the folder and resumes as themselves
    expect(rows.filter((row) => kindOf(row.id) !== "root").map((row) => row.id).sort())
      .toEqual(hermesEvidence.decision.proven.map((row) => row.id).sort());
    for (const row of rows) {
      // Hermes's own list shows it, and `hermes --resume <id>` opens it
      expect(hermesEvidence.native_list_in_cwd).toContain(row.id);
      if (kindOf(row.id) !== "root") expect(hermesEvidence.rows.find((made) => made.id === row.id)!.resume_opens).toBe(row.id);
      expect(row.resume?.argv).toEqual(["hermes", "--resume", row.id]);
    }
    const child = rows.find((row) => row.id.endsWith("fx0104"))!;
    expect([child.title, child.firstMessage, child.startedAt]).toEqual(["Fixture native reset", "Fixture hermes native reset prompt", "2026-10-10T09:30:00.000Z"]);
  });

  it("hides an unmarked Hermes child that started before its parent ended branched", () => {
    const home = newHome();
    // fx0105 ended "branched" at 1791625560: this child started a minute before
    nativeHermes(home, `INSERT INTO sessions (id, source, parent_session_id, started_at, cwd) VALUES ('20261010_094500_fx0199', 'cli', '20261010_094000_fx0105', 1791625500, ${sql(CWD)})`);
    const plain = newHome();
    nativeHermes(plain);
    expect(listSessions("hermes", CWD, { home, env: {} }).map((row) => row.id))
      .toEqual(listSessions("hermes", CWD, { home: plain, env: {} }).map((row) => row.id));
  });

  it("hides a Hermes child that ended in a compression whose continuation holds no messages yet", () => {
    const home = newHome();
    // Hermes's resume still opens the continuation (get_compression_tip reads no messages)
    nativeHermes(home, "DELETE FROM messages WHERE session_id = '20261010_134000_fx0133'");
    const plain = newHome();
    nativeHermes(plain);
    expect(listSessions("hermes", CWD, { home, env: {} }).map((row) => row.id))
      .toEqual(listSessions("hermes", CWD, { home: plain, env: {} }).map((row) => row.id));
  });

  it(`walks Hermes's resume for the folder's newest ${HERMES_CANDIDATES} roots and branch or reset children alone`, () => {
    const home = newHome();
    // newer than every row of the store: branches of fx0101 that each resume as their child, which has messages
    nativeHermes(home, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${HERMES_CANDIDATES - 1})
      INSERT INTO sessions (id, source, parent_session_id, model_config, started_at, last_activity_at, cwd)
      SELECT 'newer_branch_' || i, 'cli', '20261010_090000_fx0101', '{"_branched_from": "20261010_090000_fx0101"}', 1800000000 + i, 1800000000 + i, ${sql(CWD)} FROM n;
      INSERT INTO sessions (id, source, parent_session_id, started_at) SELECT 'newer_child_' || substr(id, 14), 'cli', id, started_at + 1 FROM sessions WHERE id LIKE 'newer_branch_%';
      INSERT INTO messages (session_id, role, content, timestamp) SELECT id, 'user', 'newer', started_at FROM sessions WHERE id LIKE 'newer_child_%';`);
    // the window holds those and the folder's newest conversation; the older ones are not reached
    expect(listSessions("hermes", CWD, { home, env: {} }).map((row) => row.id)).toEqual(["20261010_136000_fx0135"]);
  });

  for (const [store, change] of [
    ["lacks a column its children are told apart by", "ALTER TABLE sessions DROP COLUMN model_config"],
    ["has a newer schema than the one proven", "UPDATE schema_version SET version = 32"],
    ["has no schema version", "DROP TABLE schema_version"],
  ] as const) {
    it(`lists a Hermes store's roots alone when it ${store}`, () => {
      const home = newHome();
      nativeHermes(home, change);
      expect(listSessions("hermes", CWD, { home, env: {} }).map((row) => kindOf(row.id))).toEqual(Array(10).fill("root"));
    });
  }

  // the entries a listing walks, taken or passed over, as the opendir seam counts them
  const walking = () => {
    const seen = { walked: 0, lstats: 0 };
    const opendir = (dir: string): Dir => {
      const handle = opendirSync(dir);
      return Object.assign(Object.create(Object.getPrototypeOf(handle) as object) as Dir, {
        readSync: () => { const entry = handle.readSync(); if (entry !== null) seen.walked++; return entry; },
        closeSync: () => handle.closeSync(),
      });
    };
    return { seen, opendir, lstat: (path: string) => { seen.lstats++; return lstatSync(path); } };
  };

  it(`walks at most ${MAX_WALK} entries of a folder, entries passed over included, and times at most ${MAX_ENTRIES}`, () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    // a project of folders the listing passes over (Claude's per-session folders), and a few sessions
    for (let n = 0; n < MAX_ENTRIES + 4000; n++) mkdirSync(join(project, `folder-${n}`));
    for (let n = 0; n < 10; n++) writeFileSync(join(project, `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000.jsonl`), "");
    const { seen, opendir, lstat } = walking();
    try { listSessions("claude", CWD, { home, env: {}, opendir, lstat }); }
    finally { rmSync(home, { recursive: true, force: true }); }
    expect(seen.walked).toBeGreaterThan(MAX_ENTRIES);
    expect(seen.walked).toBeLessThanOrEqual(MAX_WALK);
    expect(seen.lstats).toBeLessThanOrEqual(MAX_ENTRIES);
  }, 60_000);

  it(`counts every lstat a Grok session folder takes within the ${MAX_ENTRIES} timed`, () => {
    const home = newHome();
    const group = join(home, ".grok", "sessions", FOLDERS.grok!);
    for (let n = 0; n < 6000; n++) {
      const dir = join(group, `s-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), "{}");
      writeFileSync(join(dir, "updates.jsonl"), "");
    }
    const { seen, opendir, lstat } = walking();
    try { listSessions("grok", CWD, { home, env: {}, opendir, lstat }); }
    finally { rmSync(home, { recursive: true, force: true }); }
    expect(seen.lstats).toBeGreaterThan(MAX_STATS);
    expect(seen.lstats).toBeLessThanOrEqual(MAX_ENTRIES);
    expect(seen.walked).toBeLessThanOrEqual(MAX_WALK);
  }, 60_000);

  it("keeps the newest 50 of 16,000 Claude sessions with their per-session folders", () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    const written: { id: string; at: number }[] = [];
    const count = 16000;
    try {
      for (let n = 0; n < count; n++) {
        const id = `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
        const path = join(project, `${id}.jsonl`);
        writeFileSync(path, `${JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: `prompt ${n}` } })}\n`);
        const at = (n * 7919) % count;
        utimesSync(path, 1_790_000_000 + at, 1_790_000_000 + at);
        mkdirSync(join(project, id));
        written.push({ id, at });
      }
      const newest = written.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS).map((entry) => entry.id);
      expect(listSessions("claude", CWD, { home, env: {} }).map((row) => row.id)).toEqual(newest);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 240_000);

  it(`stops walking a folder at ${MAX_WALK} entries, however many it holds`, () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    // a folder of more entries than the walk takes, all passed over, made up by the opendir seam
    let walked = 0;
    const opendir = (dir: string): Dir => {
      if (dir !== project) return opendirSync(dir);
      let n = 0;
      return Object.assign(Object.create(null) as Dir, {
        readSync: () => { if (n >= 4 * MAX_WALK) return null; walked++; const name = `folder-${n++}`; return { name, isDirectory: () => true, isFile: () => false } as unknown as Dirent; },
        closeSync: () => {},
      });
    };
    expect(listSessions("claude", CWD, { home, env: {}, opendir })).toEqual([]);
    expect(walked).toBe(MAX_WALK);
  });

  it(`reads at most ${MAX_ENTRIES} entries of a folder, however many it holds`, async () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (let n = 0; n < MAX_ENTRIES + 500; n++) writeFileSync(join(piStore(home), `s-${n}.jsonl`), "");
    let looked = 0;
    try {
      await listSessions("pi", CWD, { home, env: {}, lstat: (path) => { looked++; return lstatSync(path); } });
    } finally {
      // removed here, inside this test's own time: on NTFS making and removing them takes seconds
      rmSync(home, { recursive: true, force: true });
    }
    expect(looked).toBeGreaterThan(MAX_STATS);
    expect(looked).toBeLessThanOrEqual(MAX_ENTRIES);
  }, 60_000);

  it(`lists the newest sessions of a folder that holds more than ${MAX_STATS}, whatever their names`, () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
    mkdirSync(project, { recursive: true });
    // Claude names a session by a random id: the names say nothing of the times
    const written: { id: string; at: number }[] = [];
    for (let n = 0; n < 500; n++) {
      const id = `${(n * 7919 % 500).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
      const path = join(project, `${id}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: `prompt ${n}` } })}\n`);
      utimesSync(path, 1_790_000_000 + n, 1_790_000_000 + n);
      written.push({ id, at: n });
    }
    const newest = written.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS).map((entry) => entry.id);
    expect(listSessions("claude", CWD, { home, env: {} }).map((row) => row.id)).toEqual(newest);
  });

  // more entries than the 4096 the listing once took: which ones it saw followed readdir order
  for (const [count, folders] of [[2500, true], [5000, false]] as const) {
    it(`keeps the newest ${MAX_ROWS} of ${count} Claude sessions${folders ? " with their per-session folders" : ""}, whatever the readdir order`, () => {
      const home = newHome();
      const project = join(home, ".claude", "projects", claudeProjectDir(CWD));
      mkdirSync(project, { recursive: true });
      const written: { id: string; at: number }[] = [];
      for (let n = 0; n < count; n++) {
        const id = `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
        const path = join(project, `${id}.jsonl`);
        writeFileSync(path, `${JSON.stringify({ type: "user", cwd: CWD, message: { role: "user", content: `prompt ${n}` } })}\n`);
        // the times follow neither the names nor the order the files were made in
        const at = (n * 7919) % count;
        utimesSync(path, 1_790_000_000 + at, 1_790_000_000 + at);
        // Claude keeps a folder of subagent transcripts beside a session
        if (folders) mkdirSync(join(project, id));
        written.push({ id, at });
      }
      const newest = written.sort((a, b) => b.at - a.at).slice(0, MAX_ROWS).map((entry) => entry.id);
      expect(listSessions("claude", CWD, { home, env: {} }).map((row) => row.id)).toEqual(newest);
    }, 30_000);
  }

  it("checks the Grok session written last first, by its files' times rather than its folder's", () => {
    const home = newHome();
    const group = join(home, ".grok", "sessions", FOLDERS.grok!);
    const session = (id: string, updated: number, folder: number) => {
      const dir = join(group, id);
      mkdirSync(dir, { recursive: true });
      for (const name of ["summary.json", "updates.jsonl"]) {
        const path = join(dir, name);
        writeFileSync(path, name === "summary.json" ? JSON.stringify({ info: { id, cwd: CWD }, updated_at: new Date(updated * 1000).toISOString() }) : "");
        utimesSync(path, updated, updated);
      }
      // a folder's time moves when a file is made in it, not while a session keeps writing to one
      utimesSync(dir, folder, folder);
    };
    for (let n = 0; n < 300; n++) session(`idle-${n}`, 1_790_000_000 + n, 1_790_500_000 + n);
    session("active", 1_790_900_000, 1_789_000_000);
    expect(listSessions("grok", CWD, { home, env: {} })[0]?.id).toBe("active");
  });

  it("lists a hashed Grok group's session folders once", () => {
    const home = newHome();
    for (let n = 0; n < 100; n++) {
      const dir = join(home, ".grok", "sessions", "long-slug-abc123", `s-${n}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: `s-${n}`, cwd: CWD }, updated_at: "2026-10-01T10:00:00Z" }));
      writeFileSync(join(dir, "updates.jsonl"), "");
    }
    let looked = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, lstat: (path) => { looked++; return lstatSync(path); } });
    expect(rows).toHaveLength(MAX_ROWS);
    // each of the 100 folders timed once: at least one lstat (its files, else itself), at most its two
    // files' times, never those times twice
    expect(looked).toBeGreaterThanOrEqual(100);
    expect(looked).toBeLessThanOrEqual(2 * 100);
  });

  it("finds Grok sessions in a native hashed cwd group", () => {
    const home = newHome();
    const dir = join(home, ".grok", "sessions", "long-slug-abc123", ID(7));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id: ID(7), cwd: CWD }, created_at: "2026-10-01T09:00:00Z", updated_at: "2026-10-01T10:00:00Z" }));
    const other = join(home, ".grok", "sessions", "other-slug-def456", ID(8));
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "summary.json"), JSON.stringify({ info: { id: ID(8), cwd: "/elsewhere" }, updated_at: "2026-10-01T10:00:00Z" }));
    expect(listSessions("grok", CWD, { home, env: {} }).map((row) => row.id)).toEqual([ID(7)]);
  });

  const grokSession = (group: string, id: string, cwd: string, home: string) => {
    const dir = join(home, ".grok", "sessions", group, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "summary.json"), JSON.stringify({ info: { id, cwd }, updated_at: "2026-10-01T10:00:00Z" }));
  };

  it("spends no stats on the sessions of another folder's Grok group", () => {
    const home = newHome();
    for (let n = 0; n < MAX_STATS + 10; n++) grokSession("foreign-slug-aaa111", `foreign-${n}`, "/elsewhere", home);
    grokSession("target-slug-bbb222", ID(7), CWD, home);
    let stats = 0;
    const rows = listSessions("grok", CWD, { home, env: {}, stat: (path, bigint) => { stats++; return statAs(path, bigint); } });
    expect(rows.map((row) => row.id)).toEqual([ID(7)]);
    expect(stats).toBeLessThan(20);
  });

  it("reads the cwd's own Grok group even when the store holds too many groups to list", () => {
    const home = newHome();
    for (let n = 0; n <= 4096; n++) mkdirSync(join(home, ".grok", "sessions", `empty-${n}`), { recursive: true });
    grokSession(FOLDERS.grok!, ID(6), CWD, home);
    expect(listSessions("grok", CWD, { home, env: {} }).map((row) => row.id)).toEqual([ID(6)]);
  });

  it.skipIf(!SYMLINKS)("checks a folder's identity under Windows rules within the counted stat budget", () => {
    const home = newHome();
    const real = join(root, `real-${homes}`);
    mkdirSync(real);
    const alias = join(root, `alias-${homes}`);
    symlinkSync(real, alias, WINDOWS ? "junction" : "dir");
    for (let n = 0; n < 5; n++) grokSession(encodeURIComponent(real), `alias-${n}`, alias, home);
    let stats = 0;
    const rows = listSessions("grok", real, {
      home, env: {}, platform: "win32",
      stat: (path, bigint) => { stats++; return bigint ? statSync(path, { bigint: true }) : statSync(path); },
    });
    expect(rows).toHaveLength(5);
    // the store, five summaries, and both folders of each of the five sessions
    expect(stats).toBe(1 + 5 + 5 * 2);
  });

  for (const [name, cwd, spelling] of [
    ["a drive letter in another case", "C:\\work\\project", "c:\\work\\project"],
    ["a verbatim drive prefix", "C:\\work\\project", "\\\\?\\C:\\work\\project"],
    ["a verbatim UNC prefix", "\\\\server\\share\\project", "\\\\?\\UNC\\server\\share\\project"],
  ] as const) {
    it(`reads a Grok group named after the same Windows folder with ${name}`, () => {
      const home = newHome();
      grokSession(encodeURIComponent(spelling), ID(5), spelling, home);
      expect(listSessions("grok", cwd, { home, env: {} }).map((row) => row.id)).toEqual([ID(5)]);
    });
  }

  for (const [name, spelling] of [
    ["forward slashes", "C:/work/project"],
    ["a trailing separator", "C:\\work\\project\\"],
    ["mixed separators", "C:\\work/project"],
  ] as const) {
    it(`reads a Grok group of the same Windows folder spelled with ${name}`, () => {
      const home = newHome();
      grokSession(encodeURIComponent(spelling), ID(4), spelling, home);
      expect(listSessions("grok", "C:\\work\\project", { home, env: {}, platform: "win32" }).map((row) => row.id)).toEqual([ID(4)]);
    });
  }

  it("reads the Grok group of a Windows short-name cwd's long name, resolving it once", () => {
    const home = newHome();
    const long = "C:\\Program Files\\Project Folder";
    grokSession(encodeURIComponent(long), ID(3), long, home);
    const resolved: string[] = [];
    let stats = 0;
    const rows = listSessions("grok", "C:\\PROGRA~1\\PROJEC~1", {
      home, env: {}, platform: "win32",
      realpath: (path) => { resolved.push(path); return path === "C:\\PROGRA~1\\PROJEC~1" ? long : path; },
      stat: (path, bigint) => { stats++; return bigint ? statSync(path, { bigint: true }) : statSync(path); },
    });
    expect(rows.map((row) => row.id)).toEqual([ID(3)]);
    expect(resolved).toEqual(["C:\\PROGRA~1\\PROJEC~1"]);
    // stat calls: the store and the session's summary (the one resolution is budgeted, through realpath)
    expect(stats).toBe(2);
  });

  const SHORT = "C:\\PROGRA~1\\PROJEC~1";
  const LONG = "C:\\Program Files\\Project Folder";
  const shortAlias = (resolved: string[]) => (path: string) => { resolved.push(path); return path === SHORT ? LONG : path; };

  it("finds Claude's project of a Windows short-name cwd's long name, resolving it once", () => {
    const home = newHome();
    const project = join(home, ".claude", "projects", claudeProjectDir(LONG));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${ID(2)}.jsonl`), `${JSON.stringify({ type: "user", cwd: LONG, timestamp: "2026-10-01T09:00:00.000Z", message: { role: "user", content: "long-name prompt" } })}\n`);
    const resolved: string[] = [];
    const rows = listSessions("claude", SHORT, { home, env: {}, platform: "win32", realpath: shortAlias(resolved) });
    expect(rows.map((row) => [row.id, row.firstMessage])).toEqual([[ID(2), "long-name prompt"]]);
    expect(resolved).toEqual([SHORT]);
  });

  it("finds a pi session folder of a Windows short-name cwd's long name", async () => {
    const home = newHome();
    const folder = join(home, ".pi", "agent", "sessions", "--C--Program Files-Project Folder--");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "long.jsonl"), piHeader(ID(3), LONG) + piPrompt("long-name prompt"));
    const resolved: string[] = [];
    expect((await listSessions("pi", SHORT, { home, env: {}, platform: "win32", realpath: shortAlias(resolved) })).map((row) => row.id)).toEqual([ID(3)]);
    expect(resolved).toEqual([SHORT]);
  });

  it("finds omp's temp-scoped folder when TEMP is a Windows short-name alias of the cwd's base", () => {
    const home = newHome();
    const shortTemp = "C:\\Users\\LONGUS~1\\AppData\\Local\\Temp";
    const longTemp = "C:\\Users\\Long User Name\\AppData\\Local\\Temp";
    const cwd = `${longTemp}\\project`;
    const folder = join(home, ".omp", "agent", "sessions", "-tmp-project");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "scoped.jsonl"), piHeader(ID(8), cwd) + piPrompt("temp-scoped prompt"));
    const resolved: string[] = [];
    const rows = listSessions("omp", cwd, {
      home, env: {}, platform: "win32", tmpdir: shortTemp,
      realpath: (path) => { resolved.push(path); return path === shortTemp ? longTemp : path; },
    });
    expect(rows.map((row) => row.id)).toEqual([ID(8)]);
    expect(resolved.sort()).toEqual([cwd, home, shortTemp].sort());
  });

  for (const [agent, store] of [["omp", ".omp"], ["gjc", ".gjc"]] as const) {
    it.skipIf(!SYMLINKS || WINDOWS)(`lists ${agent}'s session recorded under the canonical folder of a cwd reached through a link`, () => {
      const home = newHome();
      // macOS's /var -> /private/var: the pane names the link, the agent records the folder it resolves to
      const privateVar = join(root, `private-${homes}`, "var");
      mkdirSync(join(privateVar, "project"), { recursive: true });
      const link = join(root, `var-${homes}`);
      symlinkSync(privateVar, link, "dir");
      const canonical = join(privateVar, "project");
      const folder = join(home, store, "agent", "sessions", `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "linked.jsonl"), piHeader(ID(9), canonical) + piPrompt("linked prompt"));
      const options = { home, env: {}, tmpdir: join(root, "no-temp-scope") };
      expect(listSessions(agent, canonical, options).map((row) => row.id)).toEqual([ID(9)]);
      expect(listSessions(agent, join(link, "project"), options).map((row) => row.id)).toEqual([ID(9)]);
    });
  }

  it("lists a pi session only in a layout version pi documents", async () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    const header = (id: string, version?: number) => `${JSON.stringify({ type: "session", ...(version === undefined ? {} : { version }), id, timestamp: "2026-10-01T09:00:00.000Z", cwd: CWD })}\n`;
    writeFileSync(join(piStore(home), "future.jsonl"), header("future", 999) + piPrompt("future"));
    writeFileSync(join(piStore(home), "v1.jsonl"), header("v1") + piPrompt("v1"));
    writeFileSync(join(piStore(home), "v2.jsonl"), header("v2", 2) + piPrompt("v2"));
    expect((await listSessions("pi", CWD, { home, env: {} })).map((row) => row.id).sort()).toEqual(["v1", "v2"]);
  });

  it("puts the most recently written session first, whatever its file name", async () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    for (const [name, seconds] of [["2026-10-01T09-00-00_a.jsonl", 1_790_000_300], ["2026-10-02T09-00-00_b.jsonl", 1_790_000_100], ["2026-10-03T09-00-00_c.jsonl", 1_790_000_200]] as const) {
      const path = join(piStore(home), name);
      writeFileSync(path, piHeader(name) + piPrompt(name));
      utimesSync(path, seconds, seconds);
    }
    expect((await listSessions("pi", CWD, { home, env: {} })).map((row) => row.id)).toEqual(["2026-10-01T09-00-00_a.jsonl", "2026-10-03T09-00-00_c.jsonl", "2026-10-02T09-00-00_b.jsonl"]);
  });

  it("gives no resume command for an id that could be read as an option", async () => {
    const home = newHome();
    mkdirSync(piStore(home), { recursive: true });
    writeFileSync(join(piStore(home), "flag.jsonl"), piHeader("--yolo") + piPrompt("flag"));
    expect((await listSessions("pi", CWD, { home, env: {} })).map((row) => [row.id, row.resume])).toEqual([["--yolo", null]]);
  });
});

const snapshot = (worktree: string | null = null): Pick<SessionSnapshot, "workspaces" | "tabs" | "panes"> => ({
  workspaces: [{ workspace_id: "w1", ...(worktree ? { worktree: { checkout_path: worktree, is_linked_worktree: true, repo_key: "", repo_name: "", repo_root: "" } } : {}) }],
  tabs: [{ tab_id: "t2", workspace_id: "w1", number: 2 }, { tab_id: "t1", workspace_id: "w1", number: 1 }],
  panes: [{ pane_id: "p2", tab_id: "t2", workspace_id: "w1", cwd: "/second" }, { pane_id: "p1", tab_id: "t1", workspace_id: "w1", cwd: CWD }],
} as unknown as Pick<SessionSnapshot, "workspaces" | "tabs" | "panes">);

describe("GET /api/sessions/history", () => {
  const request = (query: string) => {
    const url = new URL(`http://localhost/api/sessions/history?${query}`);
    return [new Request(url), url] as const;
  };

  it("names the workspace's worktree checkout, else its first tab's folder", () => {
    expect(workspaceFolder(snapshot(), "w1")).toBe(CWD);
    expect(workspaceFolder(snapshot("/checkout"), "w1")).toBe("/checkout");
    expect(workspaceFolder(snapshot(), "w9")).toBeNull();
  });

  it("lists the workspace folder's sessions", async () => {
    const home = newHome();
    install("codex", home);
    const response = await handleSessionHistoryRequest(...request("workspace_id=w1&agent=codex"), { readOnly: false, stores: { home, env: {} }, snapshot: async () => snapshot() });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { cwd: string; sessions: { id: string; resume: { argv: string[] } | null }[] };
    expect(body.cwd).toBe(CWD);
    expect(body.sessions.map((row) => row.resume?.argv)).toEqual(EXPECTED.codex.map((id) => ["codex", "resume", id]));
  });

  it("refuses a device that may only watch", async () => {
    let asked = false;
    const response = await handleSessionHistoryRequest(...request("workspace_id=w1&agent=codex"), { readOnly: true, snapshot: async () => { asked = true; return snapshot(); } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("read_only");
    expect(asked).toBe(false);
  });

  /** One store's transcript of `id` in CWD's project, its first prompt `prompt`. */
  const claudeStore = (store: string, id: string, prompt: string): void => {
    const folder = join(store, "projects", claudeProjectDir(CWD));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.jsonl`), `${JSON.stringify({ type: "user", cwd: CWD, sessionId: id, timestamp: "2026-10-01T09:00:00.000Z", message: { role: "user", content: prompt } })}\n`);
  };
  /** A started user process standing for a pane's Claude, with the environment given (macOS hides system binaries' environments). */
  const claudeStandIn = async (env: Record<string, string | undefined>) => {
    // alive until the test ends it: it waits on a stdin nothing writes to, and says it is ready first
    const child = Bun.spawn([process.execPath, "-e", "process.stdin.resume(); console.log('ready')"], { env, stdin: "pipe", stdout: "pipe" });
    await child.stdout.getReader().read();
    return child;
  };
  /** Ends the stand-ins and waits until each has exited. */
  const stop = async (...children: ReturnType<typeof Bun.spawn>[]) => { for (const child of children) { child.kill(); await child.exited; } };
  /** herdr's own environment, which a new tab inherits: none exported, unless a test says otherwise */
  const launchAbsent = async () => ({ state: "absent" as const });
  const claudePane = (pid: number) => async (): Promise<PaneProcesses> => ({ shell_pid: null, foreground_processes: [{ pid, name: "claude", argv: ["claude"] }] });
  type ClaudeListing = { sessions: { id: string; firstMessage: string | null; resume: { argv: string[]; source?: { pane_id: string; store_key: string } } | null }[] };

  it.skipIf(process.platform !== "linux")("Claude history uses the source pane store", async () => {
    const home = newHome();
    const alternate = join(home, "alternate-store");
    // the same session id in two stores, each with its own first prompt
    claudeStore(join(home, ".claude"), ID(1), "default store prompt");
    claudeStore(alternate, ID(1), "alternate store prompt");
    const child = await claudeStandIn({ PATH: process.env["PATH"] ?? "", CLAUDE_CONFIG_DIR: alternate });
    try {
      const response = await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, stores: { home, env: {} }, snapshot: async () => snapshot(), paneProcesses: claudePane(child.pid) });
      expect(response.status).toBe(200);
      const body = await response.json() as ClaudeListing;
      expect(body.sessions.map((row) => [row.id, row.firstMessage, row.resume?.source?.pane_id])).toEqual([[ID(1), "alternate store prompt", "p1"]]);
      expect(body.sessions[0]!.resume?.source?.store_key).toMatch(/^[0-9a-f]{24}$/);
      expect(JSON.stringify(body)).not.toContain(alternate);
    } finally { await stop(child); }
  });

  describe("POST /api/sessions/resume", () => {
    // unit tests have no herdr: a request that got as far as making a tab would fail on the missing socket, not answer these
    const resume = (body: Record<string, unknown>, options: Omit<Parameters<typeof handleSessionResumeRequest>[1], "readOnly"> & { readOnly?: boolean }) =>
      handleSessionResumeRequest(new Request("http://localhost/api/sessions/resume", { method: "POST", body: JSON.stringify(body) }), { readOnly: false, ...options });
    const answer = async (response: Response) => [response.status, ((await response.json()) as { error?: { code: string }; action?: string; workspace_id?: string; pane_id?: string })] as const;
    const twoWorkspaces = (reported: string | null = null) => {
      const base = snapshot();
      return {
        workspaces: [...base.workspaces, { workspace_id: "w2" }],
        tabs: [...base.tabs, { tab_id: "t9", workspace_id: "w2", number: 1 }],
        panes: [...base.panes.map((pane) => pane.pane_id === "p1" && reported !== null ? { ...pane, agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: reported } } : pane), { pane_id: "p9", tab_id: "t9", workspace_id: "w2", cwd: CWD }],
      } as unknown as Pick<SessionSnapshot, "workspaces" | "tabs" | "panes">;
    };

    it.skipIf(process.platform !== "linux")("refuses a changed, foreign, forged or unknown source before anything is made", async () => {
      const home = newHome();
      const alternate = join(home, "alternate-store");
      claudeStore(join(home, ".claude"), ID(1), "default store prompt");
      claudeStore(alternate, ID(1), "alternate store prompt");
      const child = await claudeStandIn({ PATH: process.env["PATH"] ?? "", CLAUDE_CONFIG_DIR: alternate });
      const implicit = await claudeStandIn({ PATH: process.env["PATH"] ?? "" });
      try {
        const stores = { home, env: {} };
        const base: { stores: typeof stores; snapshot: () => Promise<ReturnType<typeof twoWorkspaces>>; paneProcesses: (paneId: string) => Promise<PaneProcesses | undefined>; launchSource: () => Promise<{ state: "absent" } | { state: "override"; dir: string } | { state: "unreadable" }> } = { stores, snapshot: async () => twoWorkspaces(), paneProcesses: claudePane(child.pid), launchSource: launchAbsent };
        const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
        const key = listed.sessions[0]!.resume!.source!.store_key;
        const valid = { workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: key };
        const codes = async (body: Record<string, unknown>, options: Partial<typeof base> & { readOnly?: boolean } = {}) => {
          const [status, json] = await answer(await resume(body, { ...base, ...options }));
          return [status, json.error?.code];
        };
        expect(await codes(valid, { readOnly: true })).toEqual([403, "read_only"]);
        expect(await codes({ ...valid, agent: "codex" })).toEqual([400, "invalid_agent"]);
        expect(await codes({ ...valid, session_id: "../../outside" })).toEqual([400, "invalid_session_id"]);
        expect(await codes({ ...valid, store_key: "/home/someone/.claude" })).toEqual([400, "invalid_store_key"]);
        expect(await codes({ ...valid, store_key: "0".repeat(24) })).toEqual([409, "stale_source"]);
        expect(await codes({ ...valid, pane_id: "p9" })).toEqual([400, "pane_not_in_workspace"]);
        expect(await codes({ ...valid, pane_id: "p-gone" })).toEqual([409, "stale_source"]);
        expect(await codes({ ...valid, session_id: ID(7) })).toEqual([404, "session_not_found"]);
        // the pane's Claude moved to the default store since the list: the key no longer matches
        expect(await codes(valid, { paneProcesses: claudePane(implicit.pid) })).toEqual([409, "stale_source"]);
        // two Claudes in the pane, or none readable: no store is guessed
        expect(await codes(valid, { paneProcesses: async () => ({ shell_pid: null, foreground_processes: [{ pid: child.pid, name: "claude" }, { pid: implicit.pid, name: "claude" }] }) })).toEqual([409, "claude_store_unknown"]);
        expect(await codes(valid, { paneProcesses: async () => { throw new Error("herdr busy"); } })).toEqual([409, "claude_store_unknown"]);
        // herdr's answer without the pane's processes says nothing of its Claude: never the default store
        for (const partial of [undefined, {}, { shell_pid: 7 }, { foreground_processes: [] }]) expect(await codes(valid, { paneProcesses: async () => partial })).toEqual([409, "claude_store_unknown"]);
        // none exported by the pane's Claude, but herdr exports one (the pane's shell dropped it): a new
        // tab would start in herdr's store, so the list withholds Resume and the endpoint refuses it
        const implicitPane = claudePane(implicit.pid);
        const implicitKey = ((await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base, paneProcesses: implicitPane })).json()) as ClaudeListing).sessions[0]!.resume!.source!.store_key;
        for (const launchSource of [async () => ({ state: "override" as const, dir: alternate }), async () => ({ state: "unreadable" as const })]) {
          const withheld = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base, paneProcesses: implicitPane, launchSource })).json() as ClaudeListing;
          expect(withheld.sessions.map((row) => [row.firstMessage, row.resume?.source])).toEqual([["default store prompt", undefined]]);
          expect(await codes({ ...valid, store_key: implicitKey }, { paneProcesses: implicitPane, launchSource })).toEqual([409, "launch_unsupported"]);
        }
        // nothing the refusals said names a store's path or a prompt
        for (const body of [{ ...valid, store_key: "0".repeat(24) }, { ...valid, pane_id: "p-gone" }, { ...valid, session_id: ID(7) }]) expect(JSON.stringify(await (await resume(body, base)).json())).not.toMatch(/alternate|prompt/);
      } finally { await stop(child, implicit); }
    });

    it.skipIf(process.platform !== "linux")("opens the pane already showing the session in the same store, and makes nothing", async () => {
      const home = newHome();
      const alternate = join(home, "alternate-store");
      claudeStore(alternate, ID(1), "alternate store prompt");
      const child = await claudeStandIn({ PATH: process.env["PATH"] ?? "", CLAUDE_CONFIG_DIR: alternate });
      try {
        const base = { stores: { home, env: {} }, snapshot: async () => twoWorkspaces(ID(1)), paneProcesses: claudePane(child.pid) };
        const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
        const [status, json] = await answer(await resume({ workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: listed.sessions[0]!.resume!.source!.store_key }, base));
        expect([status, json]).toEqual([200, { action: "opened", workspace_id: "w1", pane_id: "p1" }]);
      } finally { await stop(child); }
    });

    /** A resume's tab, Claude start and close as herdr would answer them, with each close kept. */
    const fakeTabs = (closed: string[], started = true) => ({
      create: async () => ({ tab: { tab_id: "t-new", workspace_id: "w1" }, root_pane: { pane_id: "p-new" } }) as unknown as Awaited<ReturnType<typeof import("./herdr/client.ts").tabCreate>>,
      start: async () => started ? { agent_started: true as const } : { agent_started: false as const, error: { code: "agent_start_failed", message: "not in this test" } },
      close: async (tabId: string) => { closed.push(tabId); },
    });

    it.skipIf(process.platform !== "linux")("closes a resumed Claude's tab when its shell chose another store, and keeps one on the listed store", async () => {
      const home = newHome();
      const alternate = join(home, "alternate-store");
      const rcStore = join(home, "rc-store");
      mkdirSync(rcStore);
      claudeStore(alternate, ID(1), "alternate store prompt");
      const child = await claudeStandIn({ PATH: process.env["PATH"] ?? "", CLAUDE_CONFIG_DIR: alternate });
      // the new tab's shell exports its own store from a startup file, overriding the tab's env
      const rcClaude = await claudeStandIn({ PATH: process.env["PATH"] ?? "", CLAUDE_CONFIG_DIR: rcStore });
      const sameClaude = await claudeStandIn({ PATH: process.env["PATH"] ?? "", CLAUDE_CONFIG_DIR: alternate });
      try {
        // the new pane shows its shell first, then the Claude the resume started
        const panes = (resumed: number) => {
          let asked = 0;
          return async (paneId: string): Promise<PaneProcesses> => paneId === "p-new" && asked++ === 0
            ? { shell_pid: null, foreground_processes: [{ pid: 1, name: "bash", argv: ["bash"] }] }
            : { shell_pid: null, foreground_processes: [{ pid: paneId === "p-new" ? resumed : child.pid, name: "claude", argv: ["claude"] }] };
        };
        const base = { stores: { home, env: {} }, snapshot: async () => twoWorkspaces(), paneProcesses: panes(rcClaude.pid), launchSource: launchAbsent, launchCheckMs: 5_000 };
        const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
        const valid = { workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: listed.sessions[0]!.resume!.source!.store_key };
        const closed: string[] = [];
        const [status, json] = await answer(await resume(valid, { ...base, tabs: fakeTabs(closed) }));
        expect([status, json.error?.code, closed]).toEqual([409, "launch_store_changed", ["t-new"]]);
        const kept: string[] = [];
        expect(await answer(await resume(valid, { ...base, paneProcesses: panes(sameClaude.pid), tabs: fakeTabs(kept) }))).toEqual([200, { action: "created", workspace_id: "w1", pane_id: "p-new", agent_started: true }] as never);
        expect(kept).toEqual([]);
      } finally { await stop(child, rcClaude, sameClaude); }
    });

    it.skipIf(process.platform !== "linux")("opens a pane showing the session from the same store folder, however that folder was chosen", async () => {
      const home = newHome();
      claudeStore(join(home, ".claude"), ID(1), "default store prompt");
      // the list's pane runs Claude with none exported; another pane runs it on ~/.claude by name
      const implicit = await claudeStandIn({ PATH: process.env["PATH"] ?? "" });
      const explicit = await claudeStandIn({ PATH: process.env["PATH"] ?? "", CLAUDE_CONFIG_DIR: join(home, ".claude") });
      try {
        const shown = snapshot();
        const reporting = { ...shown, panes: shown.panes.map((pane) => pane.pane_id === "p2" ? { ...pane, agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: ID(1) } } : pane) } as typeof shown;
        const paneProcesses = async (paneId: string): Promise<PaneProcesses> => ({ shell_pid: null, foreground_processes: [{ pid: paneId === "p2" ? explicit.pid : implicit.pid, name: "claude", argv: ["claude"] }] });
        const base = { stores: { home, env: {} }, snapshot: async () => reporting, paneProcesses, launchSource: launchAbsent };
        const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
        const closed: string[] = [];
        // a second `claude --resume` would write the same transcript: the pane showing it is opened instead
        expect(await answer(await resume({ workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: listed.sessions[0]!.resume!.source!.store_key }, { ...base, tabs: fakeTabs(closed) })))
          .toEqual([200, { action: "opened", workspace_id: "w1", pane_id: "p2" }] as never);
      } finally { await stop(implicit, explicit); }
    });

    it("closes a resumed Claude's tab that does not say its store in time", async () => {
      const home = newHome();
      claudeStore(join(home, ".claude"), ID(1), "default store prompt");
      // the new pane never shows a Claude whose store can be read: no proof of the store, so nothing is kept.
      // Both panes are a shell with nothing under it, on every platform: Windows looks under shell_pid
      const shell = async (): Promise<PaneProcesses> => ({ shell_pid: 1, foreground_processes: [{ pid: 1, name: "bash", argv: ["bash"] }] });
      const table = async (): Promise<ProcessRow[]> => [{ pid: 1, parent: 0, path: "bash", commandLine: "bash" }];
      const base = { stores: { home, env: {} }, snapshot: async () => snapshot(), paneProcesses: shell, table, launchSource: launchAbsent, launchCheckMs: 0 };
      const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
      const closed: string[] = [];
      const [status, json] = await answer(await resume({ workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: listed.sessions[0]!.resume!.source!.store_key }, { ...base, tabs: fakeTabs(closed) }));
      expect([status, json.error?.code, closed]).toEqual([409, "launch_store_unknown", ["t-new"]]);
    });

    it("holds a resume's request open past the server's first idle window, through its start and store check", async () => {
      // Bun 1.4 puts a request's deadline at its start plus the last timeout set for it once its body is in
      // (one set before is dropped as the body is read): setting the same value again moves nothing. So a
      // window is in force when the route starts, 4 s here, and the start alone takes 5.5 s: the answer
      // comes only if the route's own budget, asked once, really extends that window
      const home = newHome();
      claudeStore(join(home, ".claude"), ID(1), "default store prompt");
      const shell = async (): Promise<PaneProcesses> => ({ shell_pid: 1, foreground_processes: [{ pid: 1, name: "bash", argv: ["bash"] }] });
      const table = async (): Promise<ProcessRow[]> => [{ pid: 1, parent: 0, path: "bash", commandLine: "bash" }];
      const base = { stores: { home, env: {} }, snapshot: async () => snapshot(), paneProcesses: shell, table, launchSource: launchAbsent, launchCheckMs: 0 };
      const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
      const closed: string[] = [];
      const tabs = {
        create: async () => ({ tab: { tab_id: "t-new", workspace_id: "w1" }, root_pane: { pane_id: "p-new" } }) as unknown as Awaited<ReturnType<typeof import("./herdr/client.ts").tabCreate>>,
        // fixed wait: a start slower than the 4 s window is the case under test; the time is the behaviour
        start: async () => { await Bun.sleep(5_500); return { agent_started: true as const }; },
        close: async (tabId: string) => { closed.push(tabId); },
      };
      const asked: number[] = [];
      const server = Bun.serve({
        port: 0, hostname: "127.0.0.1",
        fetch: async (incoming) => {
          // the body in, then the first window, as index.ts's own 75 s was before this budget
          const body = await incoming.text();
          server.timeout(incoming, 4);
          return handleSessionResumeRequest(new Request(incoming.url, { method: "POST", body }), { readOnly: false, ...base, tabs, holdOpen: (seconds: number) => { asked.push(seconds); server.timeout(incoming, seconds); } });
        },
      });
      try {
        const body = JSON.stringify({ workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: listed.sessions[0]!.resume!.source!.store_key });
        const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/resume`, { method: "POST", body });
        // the new pane never shows a Claude, so the store check refuses it: an answer, not a dropped socket
        expect([response.status, ((await response.json()) as { error?: { code: string } }).error?.code, closed]).toEqual([409, "launch_store_unknown", ["t-new"]]);
      } finally { server.stop(true); }
      // one budget, asked once, covering busy-shell retries (10 s), one agentStart (60 s) and the store
      // check (15 s), within the most Bun takes (255 s)
      expect(asked).toEqual([RESUME_BUDGET_S]);
      expect(RESUME_BUDGET_S).toBeGreaterThanOrEqual(10 + 60 + 15);
      expect(RESUME_BUDGET_S).toBeLessThanOrEqual(255);
      // a PC's resume goes through the proxy, which waits on it as long as on a worktree's creation
      expect(["sessions/resume", "worktree/create", "sessions/history", "tab/create"].map(slowMachinePath)).toEqual([true, true, false, false]);
    }, 20_000);

    it("answers by its own deadline while the start still runs, and closes the tab that start made after", async () => {
      // the per-call limits of herdr's RPCs add up past any one budget: the route answers by its deadline,
      // within the window it asked for, and work that ends after that answer leaves no tab behind. The
      // deadline here falls once the start is under way (in the server, a timer)
      const home = newHome();
      claudeStore(join(home, ".claude"), ID(1), "default store prompt");
      const shell = async (): Promise<PaneProcesses> => ({ shell_pid: 1, foreground_processes: [{ pid: 1, name: "bash", argv: ["bash"] }] });
      const table = async (): Promise<ProcessRow[]> => [{ pid: 1, parent: 0, path: "bash", commandLine: "bash" }];
      const base = { stores: { home, env: {} }, snapshot: async () => snapshot(), paneProcesses: shell, table, launchSource: launchAbsent, launchCheckMs: 0 };
      const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
      const valid = { workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: listed.sessions[0]!.resume!.source!.store_key };
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<string>();
      const made: string[] = [];
      const tabs = {
        create: async () => { made.push("t-new"); return { tab: { tab_id: "t-new", workspace_id: "w1" }, root_pane: { pane_id: "p-new" } } as unknown as Awaited<ReturnType<typeof import("./herdr/client.ts").tabCreate>>; },
        // the start is still running when the deadline falls: it ends only once released
        start: async () => { started.resolve(); await release.promise; return { agent_started: true as const }; },
        close: async (tabId: string) => { closed.resolve(tabId); },
      };
      const server = Bun.serve({
        port: 0, hostname: "127.0.0.1",
        fetch: (incoming) => handleSessionResumeRequest(incoming, { readOnly: false, ...base, tabs, deadline: started.promise, holdOpen: (seconds: number) => server.timeout(incoming, seconds) }),
      });
      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/sessions/resume`, { method: "POST", body: JSON.stringify(valid) });
        expect([response.status, ((await response.json()) as { error?: { code: string } }).error?.code]).toEqual([504, "resume_timed_out"]);
        // a retry while that start still runs is refused: the tab it may find is the one about to be closed
        const retried: string[] = [];
        const shown = snapshot();
        // the roster already lists the late start's pane, reporting the session, on the same store folder
        const showing = { ...shown, tabs: [...shown.tabs, { tab_id: "t-new", workspace_id: "w1", number: 3 }], panes: [...shown.panes, { pane_id: "p-new", tab_id: "t-new", workspace_id: "w1", cwd: CWD, agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: ID(1) } }] } as unknown as typeof shown;
        const [status, json] = await answer(await resume(valid, { ...base, snapshot: async () => showing, tabs: { ...tabs, create: async () => { retried.push("t-retry"); return tabs.create(); } } }));
        expect([status, json.error?.code, retried]).toEqual([409, "resume_in_progress", []]);
        release.resolve();
        // the client was told the resume did not happen: the tab the late start made is closed
        expect(await closed.promise).toBe("t-new");
        expect(made).toEqual(["t-new"]);
        // once that is done, the session can be resumed again
        const again = await answer(await resume(valid, { ...base, tabs: { ...tabs, start: async () => ({ agent_started: false as const, error: { code: "agent_start_failed", message: "not in this test" } }) } }));
        expect([again[0], again[1].action]).toEqual([200, "created"]);
      } finally { release.resolve(); server.stop(true); }
    });

    it("closes a macOS resume whose Claude only looks exported to the listed store, and keeps one that writes there", async () => {
      // macOS: NOTE="example CLAUDE_CONFIG_DIR=<store>" reads as an export in `ps -E`; the environment as the
      // kernel keeps it (sysctl) says nothing is exported, so that Claude writes ~/.claude
      const home = newHome();
      const alternate = join(home, "alternate-store");
      claudeStore(alternate, ID(1), "alternate store prompt");
      const SOURCE = 501;
      const STARTED = 502;
      const exported = `PATH=/usr/bin\0CLAUDE_CONFIG_DIR=${alternate}\0HOME=${home}`;
      const environments: Record<number, string> = { [SOURCE]: exported, [STARTED]: `PATH=/usr/bin\0NOTE=example CLAUDE_CONFIG_DIR=${alternate}\0HOME=${home}` };
      const environment = spyOn(darwinProcess, "environment").mockImplementation((pid: number) => environments[pid] ?? null);
      // the live chat's reading stays ps's: it answers nothing here
      const spawned = spyOn(Bun, "spawn").mockImplementation((() => ({ stdout: new Response("").body, exited: Promise.resolve(0), kill: () => {} })) as unknown as typeof Bun.spawn);
      const paneProcesses = async (paneId: string): Promise<PaneProcesses> => ({ shell_pid: null, foreground_processes: [{ pid: paneId === "p-new" ? STARTED : SOURCE, name: "claude", argv: ["claude"] }] });
      try {
        const base = { stores: { home, env: {} }, snapshot: async () => snapshot(), paneProcesses, launchSource: launchAbsent, platform: "darwin", launchCheckMs: 0 };
        const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
        const valid = { workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: listed.sessions[0]!.resume!.source!.store_key };
        const closed: string[] = [];
        const [status, json] = await answer(await resume(valid, { ...base, tabs: fakeTabs(closed) }));
        expect([status, json.error?.code, closed]).toEqual([409, "launch_store_changed", ["t-new"]]);
        // the control: a Claude the store really is exported to is kept
        environments[STARTED] = exported;
        forgetClaudeSessions();
        const kept: string[] = [];
        expect(await answer(await resume(valid, { ...base, tabs: fakeTabs(kept) }))).toEqual([200, { action: "created", workspace_id: "w1", pane_id: "p-new", agent_started: true }] as never);
        expect(kept).toEqual([]);
      } finally { environment.mockRestore(); spawned.mockRestore(); forgetClaudeSessions(); }
    });
  });

  describe("a Windows pane's Claude", () => {
    // herdr names only the pane's shell on Windows: Claude is found under shell_pid in the process
    // table, and its store by its live PID record. These run anywhere, with the table handed in.
    const SHELL = 10;
    const PID = 4242;
    const STARTED = 1_791_384_794_216;
    const PROC_START = String((BigInt(STARTED) + 11_644_473_600_000n) * 10_000n);
    const CLAUDE_EXE = "C:\\Users\\u\\.local\\bin\\claude.exe";
    const table = async (): Promise<ProcessRow[]> => [
      { pid: SHELL, parent: 1, path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", commandLine: "powershell.exe" },
      { pid: PID, parent: SHELL, path: CLAUDE_EXE, commandLine: `"${CLAUDE_EXE}"`, started: STARTED },
    ];
    const shellOnly = async (): Promise<PaneProcesses> => ({ shell_pid: SHELL, foreground_processes: [{ pid: SHELL, name: "powershell.exe", argv: ["powershell.exe"] }] });
    const record = (store: string) => {
      mkdirSync(join(store, "sessions"), { recursive: true });
      writeFileSync(join(store, "sessions", `${PID}.json`), JSON.stringify({ pid: PID, sessionId: ID(5), procStart: PROC_START, kind: "interactive" }));
    };
    let serverConfigDir: string | undefined;
    beforeEach(() => { serverConfigDir = process.env["CLAUDE_CONFIG_DIR"]; delete process.env["CLAUDE_CONFIG_DIR"]; forgetClaudeSessions(); });
    afterEach(() => { forgetClaudeSessions(); if (serverConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"]; else process.env["CLAUDE_CONFIG_DIR"] = serverConfigDir; });
    const list = async (home: string, tableRows = table) => (await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), {
      readOnly: false, stores: { home, env: {} }, snapshot: async () => snapshot(), paneProcesses: shellOnly, launchSource: launchAbsent, platform: "win32", table: tableRows,
    })).json()) as ClaudeListing & { error?: { code: string } };

    it("lists the store of the Claude under the pane's shell, not the default one", async () => {
      const home = newHome();
      claudeStore(join(home, ".claude"), ID(1), "default store prompt");
      claudeStore(join(home, ".claude-second"), ID(1), "second store prompt");
      record(join(home, ".claude-second"));
      const listed = await list(home);
      expect(listed.sessions.map((row) => [row.firstMessage, row.resume?.source?.pane_id])).toEqual([["second store prompt", "p1"]]);
    });

    it("offers Resume for the default ~/.claude, as before the store was bound", async () => {
      const home = newHome();
      claudeStore(join(home, ".claude"), ID(1), "default store prompt");
      record(join(home, ".claude"));
      const listed = await list(home);
      expect(listed.sessions.map((row) => [row.firstMessage, row.resume?.source?.pane_id])).toEqual([["default store prompt", "p1"]]);
    });

    it("keeps a resume from a shell pane that came up on ~/.claude, and closes one on another store", async () => {
      // p1 is a shell with no Claude (the default store, chosen by nothing exported); the new pane's
      // shell runs the resumed Claude, whose PID record cannot say how its store was chosen
      const NEW_SHELL = 20;
      const rows = async (): Promise<ProcessRow[]> => [
        { pid: SHELL, parent: 1, path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", commandLine: "powershell.exe" },
        { pid: NEW_SHELL, parent: 1, path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", commandLine: "powershell.exe" },
        { pid: PID, parent: NEW_SHELL, path: CLAUDE_EXE, commandLine: `"${CLAUDE_EXE}" --resume ${ID(1)}`, started: STARTED },
      ];
      const paneProcesses = async (paneId: string): Promise<PaneProcesses> => {
        const shell = paneId === "p-new" ? NEW_SHELL : SHELL;
        return { shell_pid: shell, foreground_processes: [{ pid: shell, name: "powershell.exe", argv: ["powershell.exe"] }] };
      };
      const tabs = (closed: string[]) => ({
        create: async () => ({ tab: { tab_id: "t-new", workspace_id: "w1" }, root_pane: { pane_id: "p-new" } }) as unknown as Awaited<ReturnType<typeof import("./herdr/client.ts").tabCreate>>,
        start: async () => ({ agent_started: true as const }),
        close: async (tabId: string) => { closed.push(tabId); },
      });
      const outcome = async (recordedIn: string | readonly string[]) => {
        const home = newHome();
        claudeStore(join(home, ".claude"), ID(1), "default store prompt");
        claudeStore(join(home, ".claude-second"), ID(1), "second store prompt");
        const base = { stores: { home, env: {} }, snapshot: async () => snapshot(), paneProcesses, launchSource: launchAbsent, platform: "win32", table: rows, launchCheckMs: 0 };
        const listed = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), { readOnly: false, ...base })).json() as ClaudeListing;
        expect(listed.sessions.map((row) => row.firstMessage)).toEqual(["default store prompt"]);
        for (const store of typeof recordedIn === "string" ? [recordedIn] : recordedIn) record(join(home, store));
        forgetClaudeSessions();
        const closed: string[] = [];
        const response = await handleSessionResumeRequest(new Request("http://localhost/api/sessions/resume", { method: "POST", body: JSON.stringify({ workspace_id: "w1", pane_id: "p1", agent: "claude", session_id: ID(1), store_key: listed.sessions[0]!.resume!.source!.store_key }) }), { readOnly: false, ...base, tabs: tabs(closed) });
        const body = (await response.json()) as { action?: string; error?: { code: string } };
        return [response.status, body.action ?? body.error?.code, closed];
      };
      expect(await outcome(".claude")).toEqual([200, "created", []]);
      expect(await outcome(".claude-second")).toEqual([409, "launch_store_changed", ["t-new"]]);
      // the new Claude's live record in two stores (one copied while it ran): which one it writes cannot be told
      expect(await outcome([".claude", ".claude-second"])).toEqual([409, "launch_store_unknown", ["t-new"]]);
    });

    it("tells no store when the process table says nothing", async () => {
      const home = newHome();
      claudeStore(join(home, ".claude"), ID(1), "default store prompt");
      expect((await list(home, async () => [])).error?.code).toBe("claude_store_unknown");
    });
  });

  it("lists a pane with no Claude from the server's default store, and refuses a pane of another workspace before reading any", async () => {
    const home = newHome();
    claudeStore(join(home, ".claude"), ID(1), "default store prompt");
    // a shell with nothing under it, on every platform: Windows looks under shell_pid
    const shell = async () => ({ shell_pid: 1, foreground_processes: [{ pid: 1, name: "bash", argv: ["bash"] }] });
    const table = async (): Promise<ProcessRow[]> => [{ pid: 1, parent: 0, path: "bash", commandLine: "bash" }];
    let asked = 0;
    const options = { readOnly: false, stores: { home, env: {} }, snapshot: async () => snapshot(), paneProcesses: async () => { asked += 1; return shell(); }, table, launchSource: launchAbsent };
    const body = await (await handleSessionHistoryRequest(...request("workspace_id=w1&agent=claude&pane_id=p1"), options)).json() as ClaudeListing;
    expect(body.sessions.map((row) => [row.firstMessage, row.resume?.source?.pane_id])).toEqual([["default store prompt", "p1"]]);
    asked = 0;
    const base = snapshot();
    const elsewhere = { ...base, workspaces: [...base.workspaces, { workspace_id: "w2" }], panes: [...base.panes, { pane_id: "p-elsewhere", tab_id: "t9", workspace_id: "w2", cwd: CWD }] } as typeof base;
    const codes = async (paneId: string) => {
      const response = await handleSessionHistoryRequest(...request(`workspace_id=w1&agent=claude&pane_id=${paneId}`), { ...options, snapshot: async () => elsewhere });
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    };
    expect(await codes("p-elsewhere")).toEqual([400, "pane_not_in_workspace"]);
    // a pane that is gone is a stale source, as Resume answers it
    expect(await codes("p-gone")).toEqual([409, "stale_source"]);
    expect(asked).toBe(0);
  });

  it("refuses an unknown agent, a missing or unknown workspace", async () => {
    const options = { readOnly: false, snapshot: async () => snapshot() };
    const codes = async (query: string) => {
      const response = await handleSessionHistoryRequest(...request(query), options);
      return [response.status, ((await response.json()) as { error: { code: string } }).error.code];
    };
    expect(await codes("workspace_id=w1&agent=bash")).toEqual([400, "invalid_agent"]);
    expect(await codes("agent=codex")).toEqual([400, "missing_workspace_id"]);
    expect(await codes("workspace_id=w9&agent=codex")).toEqual([404, "workspace_not_found"]);
  });
});
