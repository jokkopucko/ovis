import { afterEach, expect, it, jest, setSystemTime, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { appendFileSync, chmodSync, closeSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandHistory, commandHistorySettled, commandHistorySize, historyVersion, holdCommandHistory, resetCommandHistory, waitCommandHistory, watchCommandHistory } from "./claude-command-history.ts";
import { TranscriptBusyError, transcriptReader, type TranscriptFile } from "./transcript-reader.ts";

const roots: string[] = [];
const release: (() => void)[] = [];
afterEach(() => {
  for (const done of release.splice(0)) done();
  resetCommandHistory();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(name = "parent") {
  const root = mkdtempSync(join(tmpdir(), "ovis-command-history-"));
  roots.push(root);
  const path = join(root, name);
  writeFileSync(path, "");
  return { path, root, limit: () => statSync(path).size };
}
const json = (entry: unknown): string => `${JSON.stringify(entry)}\n`;
const notice = (id: string, status = "completed"): string => json({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-01T12:00:00.000Z", content: `<task-notification><task-id>${id}</task-id><status>${status}</status><summary>Background command finished</summary></task-notification>` });
const filler = json({ type: "progress", value: "x".repeat(1024) }).repeat(1024);
/** Resolves on the first change of `path`'s history for which `test` holds. */
function heard(path: string, test: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const stop = watchCommandHistory(path, () => { if (test()) { stop!(); resolve(); } });
    expect(stop).not.toBeNull();
    release.push(stop!);
  });
}

it("reuses complete all-ID coverage for newly discovered IDs and scans only appends", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("first") + notice("discovered_later", "failed") + filler);
  const first = await waitCommandHistory(s.path, s.limit());
  expect(first).toMatchObject({ complete: true, through: s.limit() });
  expect(first!.ends.map((end) => end.id)).toEqual(["first", "discovered_later"]);
  const again = commandHistory(s.path, s.limit());
  expect(again).toEqual(first);
  expect(commandHistorySize().waiting).toBe(0);
  appendFileSync(s.path, notice("next"));
  const next = await waitCommandHistory(s.path, s.limit());
  expect(next!.ends.map((end) => end.id)).toEqual(["first", "discovered_later", "next"]);
});

it("invalidates completion authority on replacement, truncation and same-size rewrites", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("old"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends).toHaveLength(1);
  const replacement = join(s.root, "replacement");
  writeFileSync(replacement, notice("new"));
  renameSync(replacement, s.path);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["new"]);
  writeFileSync(s.path, notice("alt"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["alt"]);
  writeFileSync(s.path, "{}\n");
  expect((await waitCommandHistory(s.path, s.limit()))!.ends).toEqual([]);
});

it("invalidates completion authority on a same-size rewrite within the timestamp tick of the check", async () => {
  const s = fixture();
  // one timestamp for both writes, as two writes a millisecond apart keep on Windows; a minute ahead,
  // so every check of this test begins within its tick however slowly it runs
  const tick = Math.ceil(Date.now() / 1000) + 60;
  writeFileSync(s.path, notice("new"));
  utimesSync(s.path, tick, tick);
  const before = historyVersion(s.path);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["new"]);
  writeFileSync(s.path, notice("alt"));
  utimesSync(s.path, tick, tick);
  expect(historyVersion(s.path)).toEqual(before);
  expect(commandHistory(s.path, s.limit(), false)!.ends).toEqual([]);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["alt"]);
});

it("times the recheck within a version's tick for a watch taken again after the last one let go", async () => {
  const s = fixture();
  const tick = Math.ceil(Date.now() / 1000) + 60;
  writeFileSync(s.path, notice("same"));
  utimesSync(s.path, tick, tick);
  await waitCommandHistory(s.path, s.limit());
  // asked while nobody watches: the recheck is held back untimed
  commandHistory(s.path, s.limit());
  expect(commandHistorySize().timers).toBe(0);
  release.push(watchCommandHistory(s.path, () => {})!);
  expect(commandHistorySize().timers).toBe(1);
});

/** `body` written with a timestamp a minute ahead, so every check of the test begins within its tick, and read through. */
async function racy(body: string) {
  const s = fixture();
  const tick = Math.ceil(Date.now() / 1000) + 60;
  writeFileSync(s.path, body);
  utimesSync(s.path, tick, tick);
  await waitCommandHistory(s.path, s.limit());
  return s;
}
/** The bytes `run` asks fs.readSync for, and how many reads. */
function reads(run: () => unknown): Promise<{ bytes: number; calls: number }> {
  const spy = spyOn(fs, "readSync");
  return Promise.resolve(run()).then(() => ({ bytes: spy.mock.calls.reduce((sum, call) => sum + ((call as unknown[])[3] as number), 0), calls: spy.mock.calls.length })).finally(() => spy.mockRestore());
}

it("tells the ends whose lines it reads again within a tick, past the most it reads at once, and all to a request it checked for", async () => {
  // five ends of 900 KB lines: more than one call reads again
  const big = (id: string) => json({ ...JSON.parse(notice(id)), pad: "x".repeat(900 * 1024) });
  const ids = ["a", "b", "c", "d", "e"];
  const s = await racy(ids.map(big).join(""));
  const now = commandHistory(s.path, s.limit(), false)!;
  expect(now.ends.map((end) => end.id)).toEqual(["b", "c", "d", "e"]);
  expect(now.complete).toBe(false);
  appendFileSync(s.path, json({ type: "progress" }));
  utimesSync(s.path, Math.ceil(Date.now() / 1000) + 60, Math.ceil(Date.now() / 1000) + 60);
  expect(await waitCommandHistory(s.path, s.limit())).toMatchObject({ complete: true, ends: ids.map((id) => ({ id })) });
});

it("shares one recheck within a version's tick among the requests that wait, reading only the lines of its ends", async () => {
  const s = await racy(filler.repeat(2) + notice("same"));
  const read = await reads(async () => { for (let request = 0; request < 5; request++) expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["same"]); });
  expect(read.bytes).toBeLessThan(s.limit());
});

it("reads the lines of ends close together at once", async () => {
  const s = await racy(Array.from({ length: 50 }, (_, index) => notice(`id${index}`)).join(""));
  const read = await reads(() => expect(commandHistory(s.path, s.limit(), false)!.ends).toHaveLength(50));
  expect(read.calls).toBe(1);
});

it("rechecks a version whose mtime is far ahead of the clock within the check interval", async () => {
  const s = fixture();
  // 60 days ahead: past setTimeout's limit, a delay that long would fire at once, again and again
  const tick = Math.ceil(Date.now() / 1000) + 60 * 86_400;
  writeFileSync(s.path, notice("same"));
  utimesSync(s.path, tick, tick);
  await waitCommandHistory(s.path, s.limit());
  const timers = spyOn(globalThis, "setTimeout");
  try {
    release.push(watchCommandHistory(s.path, () => {})!);
    const delays = timers.mock.calls.map((call) => call[1] as number);
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeLessThanOrEqual(5000);
  } finally { timers.mockRestore(); }
  // and once that interval is past, the check is due, not put off again
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
  try {
    commandHistory(s.path, s.limit());
    expect(commandHistorySize().waiting).toBe(1);
  } finally { clock.mockRestore(); }
});

it("reads again no more than its budget of bytes, the gaps between lines read at once too", async () => {
  const gap = json({ type: "progress", value: "x".repeat(1024) }).repeat(60);
  const s = await racy(Array.from({ length: 100 }, (_, index) => gap + notice(`id${index}`)).join(""));
  const read = await reads(() => commandHistory(s.path, s.limit(), false));
  expect(read.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});

it("forgets every end once any byte it read is rewritten, though the transcript only grew", async () => {
  const s = fixture();
  // the rewritten notice sits mid-file, far from the first and last bytes read
  const head = filler.repeat(2);
  writeFileSync(s.path, head + notice("same") + filler.repeat(2));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["same"]);
  const fd = openSync(s.path, "r+");
  writeSync(fd, Buffer.from(notice("else")), 0, Buffer.byteLength(notice("else")), Buffer.byteLength(head));
  closeSync(fd);
  appendFileSync(s.path, notice("next"));
  const after = await waitCommandHistory(s.path, s.limit());
  expect(after).toMatchObject({ complete: true, through: s.limit() });
  expect(after!.ends.map((end) => end.id)).toEqual(["else", "next"]);
});

it("tells no end it read before a rewrite that also grew the transcript until those bytes are checked again", async () => {
  const s = fixture();
  const head = filler.repeat(2);
  writeFileSync(s.path, head + notice("same") + filler);
  const limit = s.limit();
  expect((await waitCommandHistory(s.path, limit))!.ends.map((end) => end.id)).toEqual(["same"]);
  const fd = openSync(s.path, "r+");
  writeSync(fd, Buffer.from(notice("else")), 0, Buffer.byteLength(notice("else")), Buffer.byteLength(head));
  closeSync(fd);
  appendFileSync(s.path, notice("next"));
  // asked before any check of the grown transcript: what it read is unknown, not ended
  expect(commandHistory(s.path, limit)).toMatchObject({ complete: false, ends: [] });
  const checked = await waitCommandHistory(s.path, limit);
  expect(checked).toMatchObject({ complete: true });
  expect(checked!.ends.map((end) => end.id)).toEqual(["else", "next"]);
});

it.each([["the newline after it", 0], ["the newline before it (joining it to the record before)", -1]])("tells no end of a line once %s is rewritten", async (_, shift) => {
  const s = fixture();
  const head = json({ type: "progress" });
  writeFileSync(s.path, head + notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  const fd = openSync(s.path, "r+");
  const at = shift === 0 ? Buffer.byteLength(head + notice("same")) - 1 : Buffer.byteLength(head) - 1;
  writeSync(fd, Buffer.from(" "), 0, 1, at);
  closeSync(fd);
  appendFileSync(s.path, "\n");
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: false, ends: [] });
});

it("tells an end at once while the transcript grows, when its line begins exactly where a read chunk began", async () => {
  const s = fixture();
  const pad = json({ type: "progress", value: "" });
  // the first record fills the first 1 MiB chunk exactly: the notice begins the next one
  const first = json({ type: "progress", value: "x".repeat(1024 * 1024 - Buffer.byteLength(pad)) });
  expect(Buffer.byteLength(first)).toBe(1024 * 1024);
  writeFileSync(s.path, first + notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  appendFileSync(s.path, notice("next"));
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: true, ends: [{ id: "same" }] });
});

it("tells the ends it read at once while the transcript only grows, before any check of it", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("same") + filler);
  const limit = s.limit();
  await waitCommandHistory(s.path, limit);
  appendFileSync(s.path, notice("next"));
  expect(commandHistory(s.path, limit, false)).toMatchObject({ complete: true, ends: [{ id: "same" }] });
  // only the ids asked for
  expect(commandHistory(s.path, limit, false, new Set(["other"]))!.ends).toEqual([]);
});

it("shares accepted notice and successful TaskStop semantics without accepting quoted output", async () => {
  const s = fixture();
  const timestamp = "2026-10-01T12:00:00.000Z";
  writeFileSync(s.path, notice("accepted")
    + json({ type: "queue-operation", operation: "remove", timestamp, content: JSON.parse(notice("removed")).content })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result", content: JSON.parse(notice("quoted")).content }] } })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result" }] }, toolUseResult: { task_type: "shell", task_id: "stopped" } })
    + json({ type: "user", timestamp, message: { content: [{ type: "tool_result", is_error: true }] }, toolUseResult: { task_type: "shell", task_id: "failed_stop" } }));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => [end.id, end.status])).toEqual([["accepted", "completed"], ["stopped", "cancelled"]]);
});

it("takes no end from a row of another session", async () => {
  const s = fixture("this-session.jsonl");
  const foreign = { ...JSON.parse(notice("foreign")), sessionId: "other-session" };
  const own = { ...JSON.parse(notice("own")), sessionId: "this-session" };
  writeFileSync(s.path, json(foreign) + json(own) + notice("unnamed"));
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["own", "unnamed"]);
});

it("reads through oversized and malformed records, which prove nothing", async () => {
  const s = fixture();
  writeFileSync(s.path, "x".repeat(2 * 1024 * 1024) + "\nnot json\n" + notice("accepted"));
  const evidence = await waitCommandHistory(s.path, s.limit());
  expect(evidence).toMatchObject({ complete: true, through: s.limit() });
  expect(evidence!.ends.map((end) => end.id)).toEqual(["accepted"]);
});

it("answers a request at once while a record waits to be written whole, and reads it once it is", async () => {
  const s = fixture();
  const record = notice("finished");
  writeFileSync(s.path, record.slice(0, -4));
  const boundary = s.limit();
  // the test's own timeout fails it if the request waits for its deadline
  const partial = await waitCommandHistory(s.path, boundary, 60_000);
  expect(partial).toMatchObject({ complete: false, through: 0, ends: [] });
  expect(commandHistorySize().waiting).toBe(0);
  appendFileSync(s.path, record.slice(-4));
  const completed = await waitCommandHistory(s.path, boundary);
  expect(completed).toMatchObject({ complete: true, through: s.limit() });
  expect(completed!.ends.map((end) => end.id)).toEqual(["finished"]);
}, 5000);

it("follows a transcript replaced while a request waits, within the same deadline", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("old") + filler.repeat(4));
  const waiting = waitCommandHistory(s.path, s.limit(), 60_000);
  const replacement = join(s.root, "replacement");
  writeFileSync(replacement, notice("new"));
  renameSync(replacement, s.path);
  commandHistory(s.path, s.limit());
  expect((await waiting)!.ends.map((end) => end.id)).toEqual(["new"]);
}, 5000);

it("answers a waiting request when a read fails, and tries again after a backoff while watched", async () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return; // an unreadable file needs POSIX modes and no root
  const s = fixture();
  writeFileSync(s.path, notice("late"));
  chmodSync(s.path, 0o000);
  commandHistory(s.path, s.limit(), false);
  const recovered = heard(s.path, () => commandHistory(s.path, s.limit(), false)?.complete === true);
  const failed = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(failed).toMatchObject({ complete: false, through: 0 });
  expect(commandHistorySize().timers).toBe(1);
  chmodSync(s.path, 0o644);
  await recovered;
  expect(commandHistory(s.path, s.limit(), false)!.ends.map((end) => end.id)).toEqual(["late"]);
}, 5000);

it("evicts the least recently used read, never a watched one", () => {
  const paths = Array.from({ length: 16 }, (_, index) => { const s = fixture(`s${index}`); writeFileSync(s.path, notice(`c${index}`)); return s.path; });
  for (const path of paths) expect(commandHistory(path, 0, false)).not.toBeNull();
  const owner = watchCommandHistory(paths[0]!, () => {});
  release.push(owner!);
  commandHistory(paths[1]!, 0, false);
  const extra = fixture("extra");
  writeFileSync(extra.path, notice("x"));
  expect(commandHistory(extra.path, 0, false)).not.toBeNull();
  expect(commandHistorySize().sessions).toBe(16);
  expect(watchCommandHistory(paths[2]!, () => {})).toBeNull();
  for (const path of [paths[0]!, paths[1]!]) { const watch = watchCommandHistory(path, () => {}); expect(watch).not.toBeNull(); release.push(watch!); }
  for (const path of paths.slice(3)) { const watch = watchCommandHistory(path, () => {}); release.push(watch!); }
  const watched = watchCommandHistory(extra.path, () => {});
  release.push(watched!);
  // every read is watched: a new one is refused, and nothing watched goes
  expect(commandHistory(paths[2]!, 0, false)).toBeNull();
  expect(commandHistorySize().sessions).toBe(16);
});

it("lets a small session finish before a large one, a slice each in turn", async () => {
  const large = fixture();
  // every line a notice: the large read takes many slices
  writeFileSync(large.path, Array.from({ length: 40_000 }, (_, index) => notice(`l${index}`)).join(""));
  commandHistory(large.path, large.limit());
  let largeDone = false;
  void heard(large.path, () => commandHistory(large.path, large.limit(), false)?.through === large.limit()).then(() => { largeDone = true; });
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  expect((await waitCommandHistory(small.path, small.limit()))!.complete).toBe(true);
  expect(largeDone).toBe(false);
});

it("drops every read and timer once the last server lets go", async () => {
  const hold = holdCommandHistory();
  const s = fixture();
  writeFileSync(s.path, filler.repeat(8));
  commandHistory(s.path, s.limit());
  release.push(watchCommandHistory(s.path, () => {})!);
  expect(commandHistorySize()).toMatchObject({ sessions: 1, waiting: 1 });
  hold();
  expect(commandHistorySize()).toMatchObject({ sessions: 0, waiting: 0, timers: 0 });
});

const gate = () => { let open!: () => void; const opened = new Promise<void>((resolve) => { open = resolve; }); return { opened, open }; };
type Work = (file: TranscriptFile) => Promise<unknown>;
/** Runs every history read's work through `wrap`, for as long as the test lasts. */
function wrapReads(wrap: (path: string, work: Work) => Work): void {
  const read = transcriptReader.read.bind(transcriptReader);
  const spy = spyOn(transcriptReader, "read").mockImplementation(((path: string, work: Work, options?: { deadline?: number }) => read(path, wrap(path, work), options)) as typeof transcriptReader.read);
  release.push(() => spy.mockRestore());
}
/** Holds every slice after its lease opened (its first stat taken) until `release` is called; `entered` opens as one is held. */
function holdSlices() {
  const entered = gate(), held = gate();
  wrapReads((_, work) => async (file) => { entered.open(); await held.opened; return work(file); });
  return { entered: entered.opened, release: held.open };
}
/**
 * Every window read takes 10 ms of the clock (performance.now), more than a slice, and opening a
 * transcript `openMs`, though no time passes: storage as slow as an SSHFS home. Counts the reads of
 * each path, and the leases they were read in (`leases`); `read` hears of each read; `elapsed` is
 * the clock's time so far. With `look`, the clock moves by that much at each look at it instead
 * of with real time.
 */
function slowReads(read: (path: string, reads: number) => void = () => {}, openMs = 0, look?: number) {
  const real = performance.now.bind(performance), base = real();
  let looked = 0;
  const clock = look === undefined ? real : () => base + (looked += look);
  let waited = 0;
  const reads = new Map<string, number>(), leases = new Map<string, number>();
  const now = spyOn(performance, "now").mockImplementation(() => clock() + waited);
  release.push(() => now.mockRestore());
  wrapReads((path, work) => { leases.set(path, (leases.get(path) ?? 0) + 1); waited += openMs; return (file) => work({ ...file, waited: () => true, window: async (position, length) => {
    const bytes = await file.window(position, length);
    waited += 10;
    reads.set(path, (reads.get(path) ?? 0) + 1);
    read(path, reads.get(path)!);
    return bytes;
  } }); });
  return Object.assign((path: string) => reads.get(path) ?? 0, { leases: (path: string) => leases.get(path) ?? 0, elapsed: () => waited });
}
/** An open on remote storage: several round trips (open, stat, the path's stat), each slower than a read. */
const OPEN_MS = 100;
/** The clock's time `reads` reads take, and `opens` opens. */
const took = (reads: number, opens: number) => reads * 10 + opens * OPEN_MS;
const MIB = 1024 * 1024;

it("backs off a read the reader is too busy for without counting it a failure of the transcript", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("late"));
  let now = Date.now();
  const busy = spyOn(transcriptReader, "read").mockImplementation(() => Promise.reject(new TranscriptBusyError()));
  try {
    // more refusals than the failures a read is given up after (and then told complete with no end)
    for (let round = 0; round < 6; round++) {
      setSystemTime(new Date(now += 60_000)); // past any backoff
      expect(await waitCommandHistory(s.path, s.limit(), 60_000)).toMatchObject({ complete: false, through: 0, ends: [] });
    }
    expect(busy.mock.calls.length).toBeGreaterThanOrEqual(6);
    busy.mockRestore();
    setSystemTime(new Date(now += 60_000));
    const read = await waitCommandHistory(s.path, s.limit(), 60_000);
    expect(read).toMatchObject({ complete: true, through: s.limit() });
    expect(read!.ends.map((end) => end.id)).toEqual(["late"]);
  } finally { busy.mockRestore(); setSystemTime(); }
}, 5000);

it("keeps the chunks it read and checked when a read gives up on its stat after a chunk", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("first") + filler.repeat(4));
  // written a minute before: the read begins past the version's tick, and no recheck within it is due
  const past = Math.floor(Date.now() / 1000) - 60;
  utimesSync(s.path, past, past);
  const chunks = Math.ceil(s.limit() / MIB);
  let windows = 0, failed = false;
  // the stat after the second chunk runs out of time (the reader's deadline): TranscriptBusyError
  wrapReads((_, work) => (file) => work({ ...file,
    window: async (position, length) => { windows++; return file.window(position, length); },
    stat: async () => { if (windows === 2 && !failed) { failed = true; throw new TranscriptBusyError(); } return file.stat(); } }));
  let now = Date.now();
  try {
    expect(await waitCommandHistory(s.path, s.limit(), 60_000)).toMatchObject({ complete: false });
    expect(failed).toBe(true);
    setSystemTime(new Date(now += 60_000)); // past the backoff
    const read = await waitCommandHistory(s.path, s.limit(), 60_000);
    expect(read).toMatchObject({ complete: true, through: s.limit() });
    expect(read!.ends.map((end) => end.id)).toEqual(["first"]);
    // the chunk whose stat failed is read again, and nothing is checked over
    expect(windows).toBe(chunks + 1);
  } finally { setSystemTime(); }
}, 5000);

it("lets the event loop run while a slice waits for the disk", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("slow") + filler);
  const held = holdSlices();
  let answered = false;
  const waiting = waitCommandHistory(s.path, s.limit(), 60_000).then((found) => { answered = true; return found; });
  await held.entered;
  // a macrotask comes round while the read is still under way
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(answered).toBe(false);
  expect(commandHistorySize().draining).toBe(true);
  held.release();
  expect((await waiting)!.ends.map((end) => end.id)).toEqual(["slow"]);
}, 5000);

it("queues a session asked for while its slice reads only once", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("slow") + filler.repeat(3));
  // asked for again while its first read is under way; that read alone outlasts the slice
  const reads = slowReads((_, count) => { if (count === 1) commandHistory(s.path, s.limit()); });
  const waits: number[] = [];
  const waiting = waitCommandHistory(s.path, s.limit(), 60_000);
  release.push(watchCommandHistory(s.path, () => waits.push(commandHistorySize().waiting))!);
  expect((await waiting)!.ends.map((end) => end.id)).toEqual(["slow"]);
  expect(reads(s.path)).toBeGreaterThan(1);
  expect(Math.max(...waits)).toBe(1);
}, 5000);

it("keeps what it read when a slice's stat is older than one a poll took while the slice waited", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("kept") + filler);
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["kept"]);
  appendFileSync(s.path, notice("next"));
  const held = holdSlices();
  commandHistory(s.path, s.limit());
  await held.entered;
  // the transcript grows on, and a status poll sees it: the held slice's stat is now behind
  appendFileSync(s.path, notice("later"));
  commandHistory(s.path, s.limit(), false);
  const changed = heard(s.path, () => true);
  held.release();
  await changed;
  // an ordinary append never starts the read over: the end read before stays told
  expect(commandHistory(s.path, s.limit(), false)!.ends.map((end) => end.id)).toContain("kept");
  expect((await waitCommandHistory(s.path, s.limit()))!.ends.map((end) => end.id)).toEqual(["kept", "next", "later"]);
}, 5000);

it("starts over on a transcript cut short in place while a slice reads it", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("old") + filler.repeat(3));
  // rewritten shorter, the same file, as the first read returns
  slowReads((_, count) => { if (count === 1) writeFileSync(s.path, notice("new")); });
  // answered well before the test's timeout: a read that never starts over waits out the request
  const read = await waitCommandHistory(s.path, s.limit(), 3000);
  expect(read).toMatchObject({ complete: true, through: s.limit() });
  expect(read!.ends.map((end) => end.id)).toEqual(["new"]);
}, 5000);

it("reads on by whole chunks when every read outlasts a slice, as on slow storage", async () => {
  const s = fixture();
  // a notice every 2 KiB, about 3 MiB: each chunk is far less than a slice's work
  writeFileSync(s.path, Array.from({ length: 1500 }, (_, index) => notice(`c${index}`) + json({ type: "progress", value: "x".repeat(2048) })).join(""));
  // the clock moves by the reads alone (and 1 µs a look), so taking in a chunk takes less than a slice
  const reads = slowReads(undefined, 0, 0.001);
  // the ends known each time the event loop runs
  const known: number[] = [];
  let probing = true;
  const probe = () => { if (!probing) return; known.push(commandHistory(s.path, s.limit(), false)?.ends.length ?? 0); setImmediate(probe); };
  release.push(() => { probing = false; });
  probe();
  const history = await waitCommandHistory(s.path, s.limit(), 60_000);
  probing = false;
  expect(history).toMatchObject({ complete: true, through: s.limit() });
  expect(history!.ends).toHaveLength(1500);
  // a read for each chunk, not one for each record
  expect(reads(s.path)).toBeLessThanOrEqual(Math.ceil(s.limit() / MIB) + 1);
  // each chunk, though it came after its slice's end, is taken in for a slice of its own before the
  // event loop runs (several hundred ends), not a record at a time
  const heard = known.slice(1).map((ends, index) => ends - known[index]!).filter((more) => more > 0);
  expect(heard.length).toBeGreaterThan(0);
  expect(Math.min(...heard)).toBeGreaterThan(100);
}, 5000);

it("takes in the rest of a window a slice ended in without reading it again", async () => {
  const s = fixture();
  // a notice every 1 KiB or so, about 3 MiB
  const ids = Array.from({ length: 3000 }, (_, index) => `c${index}`);
  writeFileSync(s.path, ids.map((id) => notice(id) + json({ type: "progress", value: "x".repeat(1024) })).join(""));
  // a clock that moves on at every look: slices end several times inside each window
  const clock = performance.now.bind(performance);
  let moved = 0;
  const now = spyOn(performance, "now").mockImplementation(() => clock() + (moved += 0.02));
  release.push(() => now.mockRestore());
  let windows = 0;
  wrapReads((_, work) => (file) => work({ ...file, window: (position, length) => { windows++; return file.window(position, length); } }));
  const history = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(history).toMatchObject({ complete: true, through: s.limit() });
  expect(history!.ends.map((end) => end.id)).toEqual(ids);
  expect(windows).toBeLessThanOrEqual(Math.ceil(s.limit() / MIB) + 1);
}, 5000);

it("starts over on a transcript rewritten and grown while it reads a window ahead", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("a") + filler.repeat(4));
  let rewritten = false;
  wrapReads((_, work) => (file) => work({ ...file, ahead: (position, length) => {
    file.ahead(position, length);
    // the same file, its first record another: whatever the read ahead finds, what was read before it is gone
    if (!rewritten) { rewritten = true; writeFileSync(s.path, notice("b") + filler.repeat(5)); }
  } }));
  const read = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(rewritten).toBe(true);
  expect(read).toMatchObject({ complete: true });
  expect(read!.ends.map((end) => end.id)).toEqual(["b"]);
}, 5000);

it("lets a small session have its turn after each slow read of a large one", async () => {
  const large = fixture();
  writeFileSync(large.path, notice("large") + filler.repeat(8));
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  // the small one is asked for while the large one's first read is under way
  let answered: Promise<number> | undefined;
  const reads = slowReads((path, count) => {
    if (path === large.path && count === 1) answered = waitCommandHistory(small.path, small.limit(), 60_000).then((found) => {
      expect(found!.ends.map((end) => end.id)).toEqual(["small"]);
      return reads(large.path);
    });
  });
  const reading = waitCommandHistory(large.path, large.limit(), 60_000);
  expect((await reading)!.complete).toBe(true);
  expect(reads(large.path)).toBeGreaterThan(8);
  // read before the large one went on past the slice its first read began
  expect(await answered!).toBe(1);
}, 5000);

it("keeps a transcript open across turns while no other session waits", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  const reads = slowReads(undefined, OPEN_MS);
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  // a turn for every slow read, but the read takes the time of its reads and an open or two, not an open a turn
  expect(reads(s.path)).toBeGreaterThan(8);
  expect(reads.elapsed()).toBeLessThan(took(reads(s.path), 2));
}, 5000);

it("lets go of a transcript it keeps open at the end of the turn another session is asked for in", async () => {
  const large = fixture();
  writeFileSync(large.path, notice("large") + filler.repeat(8));
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  let answered: Promise<number> | undefined;
  const reads = slowReads((path, count) => {
    if (path === large.path && count === 3) answered = waitCommandHistory(small.path, small.limit(), 60_000).then((found) => {
      expect(found!.ends.map((end) => end.id)).toEqual(["small"]);
      return reads(large.path);
    });
  });
  expect((await waitCommandHistory(large.path, large.limit(), 60_000))!.complete).toBe(true);
  // the small one was read while the large one still had reads to go: it let go, and opened again after
  expect(await answered!).toBeLessThan(reads(large.path));
}, 5000);

it("lets go of a transcript it keeps open well before the read's deadline", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  let now = Date.now();
  setSystemTime(new Date(now));
  try {
    // half the read's deadline passes during the second read, and as much again two reads later: a
    // lease still held then would run out of time, and the read would give up for now
    slowReads((_, count) => { if (count === 2 || count === 4) setSystemTime(new Date(now += 5_000)); });
    expect(await waitCommandHistory(s.path, s.limit(), 60_000)).toMatchObject({ complete: true, through: s.limit() });
  } finally { setSystemTime(); }
}, 5000);

it("lets go of a transcript it keeps open at the end of the turn another reader waits for it in", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  // another reader of the same transcript (one lease a path) asks while the third read is under way
  let other: Promise<number> | undefined;
  const reads = slowReads((_, count) => { if (count === 3) other = transcriptReader.read(s.path, async () => reads(s.path)); });
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  expect(await other!).toBe(3);
}, 5000);

it("lets go of a transcript it keeps open at the end of a turn that told a watcher of an end", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("first") + filler.repeat(8));
  let heard = -1;
  const reads = slowReads();
  commandHistory(s.path, s.limit(), false);
  release.push(watchCommandHistory(s.path, () => { if (heard < 0 && commandHistory(s.path, s.limit(), false)!.ends.length > 0) heard = reads(s.path); })!);
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  expect(heard).toBe(1);
}, 5000);

it("reads on in the same lease when the session it reads is asked for again", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  // the clock's time as each read was made
  let at = 0;
  const reads = slowReads((_, count) => { at = reads.elapsed(); if (count === 3) commandHistory(s.path, s.limit()); }, OPEN_MS);
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  // the request at the third read cost no open: through its last read, the read took the time of its reads and one open
  expect(reads(s.path)).toBeGreaterThan(8);
  expect(at).toBe(took(reads(s.path), 1));
}, 5000);

it("gives each turn of a transcript it keeps open a slice of its own", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(16));
  // storage that answers at once, so the event loop runs only when a turn ends, and a clock that
  // moves only by 1 ms a read: four reads to a slice
  const bytes = readFileSync(s.path);
  let waited = 0;
  const base = performance.now();
  const now = spyOn(performance, "now").mockImplementation(() => base + waited);
  release.push(() => now.mockRestore());
  wrapReads((_, work) => (file) => work({ ...file, stat: async () => file.initial, ahead: () => {}, waited: () => false, window: async (position, length) => {
    waited += 1;
    return bytes.subarray(position, position + length);
  } }));
  // the clock each time the event loop runs
  const runs: number[] = [];
  let probing = true;
  const probe = () => { runs.push(waited); if (probing) setImmediate(probe); };
  release.push(() => { probing = false; });
  probe();
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  probing = false;
  expect(waited).toBeGreaterThan(16);
  // how long of the clock the event loop waited between one run and the next, where the read ran
  const held = runs.slice(1).map((at, index) => at - runs[index]!).filter((ms) => ms > 0);
  // never longer than a slice and the read that ended it; and each turn but the last works a slice
  // of its own, not just a read (the read's last may be short)
  expect(Math.max(...held)).toBeLessThanOrEqual(5);
  expect(held.slice(0, -1).every((ms) => ms >= 2)).toBe(true);
}, 5000);

it.skipIf(process.platform !== "linux")("holds the event loop no longer than a slice and the call that ended it when it reads on the event loop", async () => {
  const s = fixture();
  // an end in every record, about 7 MiB: taking in a window takes several slices
  writeFileSync(s.path, Array.from({ length: 6000 }, (_, index) => notice(`c${index}`) + json({ type: "progress", value: "x".repeat(1024) })).join(""));
  // a clock that moves only as the read does: a read or a stat on the event loop takes 0.5 ms, and
  // each look at the clock 0.01 ms
  let clock = performance.now();
  // on a local filesystem (btrfs), where the reader reads on the event loop. Looking that up takes
  // 2 ms of the clock: the first slice counts it, as main's counts its open
  const statfs = fsp.statfs;
  const local = spyOn(fsp, "statfs").mockImplementation((async (directory: string) => {
    const found = { ...(await statfs(directory)), type: 0x9123683e };
    clock += 2;
    return found;
  }) as typeof statfs);
  const now = spyOn(performance, "now").mockImplementation(() => clock += 0.01);
  const readSync = fs.readSync, fstatSync = fs.fstatSync;
  const reads = spyOn(fs, "readSync").mockImplementation(((...args: Parameters<typeof readSync>) => { clock += 0.5; return readSync(...args); }) as typeof readSync);
  const stats = spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fstatSync>) => { clock += 0.5; return fstatSync(...args); }) as typeof fstatSync);
  release.push(() => { local.mockRestore(); now.mockRestore(); reads.mockRestore(); stats.mockRestore(); });
  // the clock each time the event loop runs
  const runs: number[] = [];
  let probing = true;
  const probe = () => { runs.push(clock); if (probing) setImmediate(probe); };
  release.push(() => { probing = false; });
  probe();
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.complete).toBe(true);
  probing = false;
  // a read on the event loop for each window
  expect(reads.mock.calls.length).toBeGreaterThanOrEqual(Math.ceil(s.limit() / MIB));
  // never longer than a slice (4 ms, the lookup and the lease's first stat included) and the read
  // and stat that ended it, with the clock's looks: a window read on the event loop after the
  // slice's end has no slice of its own
  const held = runs.slice(1).map((at, index) => at - runs[index]!);
  expect(held.filter((ms) => ms > 4).length).toBeGreaterThan(4);
  expect(Math.max(...held)).toBeLessThanOrEqual(4 + 0.5 + 0.5 + 0.5);
}, 5000);

it("reads one slice for a request nobody watches or waits for", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(9));
  slowReads();
  commandHistory(s.path, s.limit());
  await commandHistorySettled();
  // read on some way, and nothing left to read it on
  const { through } = commandHistory(s.path, s.limit(), false)!;
  expect(through).toBeGreaterThan(0);
  expect(through).toBeLessThan(s.limit());
  expect(commandHistorySize()).toMatchObject({ draining: false, waiting: 0, timers: 0 });
}, 5000);

it("reads on in one lease for a tracker's watch after it hears the first end", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(9));
  const reads = slowReads();
  // as a tracker asks: a read, and a watch of it until it is no longer needed
  commandHistory(s.path, s.limit());
  const done = gate();
  let first: number | null = null;
  release.push(watchCommandHistory(s.path, () => {
    const history = commandHistory(s.path, s.limit(), false)!;
    if (first === null && history.ends.length > 0) first = history.through;
    if (history.complete) done.open();
  })!);
  await done.opened;
  expect(reads(s.path)).toBeGreaterThan(9);
  // the end from the first chunk is heard while the read goes on
  expect(first).not.toBeNull();
  expect(first!).toBeLessThan(s.limit());
}, 5000);

it("lets go of a transcript it keeps open at the end of the turn it started over in", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("a") + filler.repeat(16));
  expect((await waitCommandHistory(s.path, s.limit(), 60_000))!.ends.map((end) => end.id)).toEqual(["a"]);
  // a clock that moves only by 1 ms a read: four reads to a slice
  let waited = 0, reads = 0, heard = -1, through = -1;
  const base = performance.now();
  const now = spyOn(performance, "now").mockImplementation(() => base + waited);
  release.push(() => now.mockRestore());
  wrapReads((_, work) => (file) => work({ ...file, window: async (position, length) => {
    const bytes = await file.window(position, length);
    waited += 1;
    reads++;
    return bytes;
  } }));
  release.push(watchCommandHistory(s.path, () => { if (heard < 0) { heard = reads; through = commandHistory(s.path, s.limit(), false)!.through; } })!);
  // rewritten in place and grown: the same file, the record after the end's line another. Its line
  // reads as it did (a request reading it again finds nothing): only a check finds the rewrite
  writeFileSync(s.path, notice("a") + json({ type: "progress", value: "y".repeat(1024) }) + filler.repeat(17));
  const read = await waitCommandHistory(s.path, s.limit(), 60_000);
  expect(read!.ends.map((end) => end.id)).toEqual(["a"]);
  expect(reads).toBeGreaterThan(16);
  // the watcher hears of the start over in the turn it happened, not once the transcript is read again
  expect(heard).toBeGreaterThan(0);
  expect(through).toBeLessThan(s.limit());
}, 5000);

/**
 * Holds every window read of each of `paths` until its `release` is called, as a read stuck on its
 * disk; its `entered` opens as the first one is held.
 */
/** setTimeout, Date and performance.now as the test moves them, for as long as it lasts (setImmediate stays real). */
function controlledClock() {
  jest.useFakeTimers();
  release.push(() => jest.useRealTimers());
}

function holdWindows(...paths: string[]) {
  const holds = new Map(paths.map((path) => {
    const entered = gate(), held = gate();
    release.push(held.open);
    return [path, { entered: entered.opened, release: held.open, open: entered.open, held: held.opened }];
  }));
  wrapReads((path, work) => {
    const hold = holds.get(path);
    return hold === undefined ? work : (file) => work({ ...file, waited: () => true, window: async (position, length) => {
      hold.open();
      await hold.held;
      return file.window(position, length);
    } });
  });
  return (path: string) => holds.get(path)!;
}

it("reads another transcript while one transcript's read is stuck on its disk", async () => {
  const a = fixture("a"), b = fixture("b");
  writeFileSync(a.path, notice("a"));
  writeFileSync(b.path, notice("b"));
  const held = holdWindows(a.path)(a.path);
  controlledClock();
  const first = waitCommandHistory(a.path, a.limit(), 60_000);
  await held.entered;
  const other = waitCommandHistory(b.path, b.limit(), 60_000);
  // the time a stuck slice is waited for passes: B is read beside it
  jest.advanceTimersByTime(50);
  const found = await other;
  expect(found).toMatchObject({ complete: true, through: b.limit() });
  expect(found!.ends.map((end) => end.id)).toEqual(["b"]);
  held.release();
  expect(await first).toMatchObject({ complete: true, ends: [{ id: "a" }] });
}, 5000);

it("reads no other session beside a transcript it keeps open that takes its turns, however long it reads", async () => {
  const large = fixture();
  writeFileSync(large.path, notice("large") + filler.repeat(8));
  const small = fixture("small");
  writeFileSync(small.path, notice("small"));
  // the clock moves only as the test moves it (and by each slow read)
  controlledClock();
  let answered: Promise<unknown> | undefined;
  // the leases open as each read of the small one is made
  const open: number[] = [];
  const reads = slowReads((path, count) => {
    if (path === small.path) open.push(transcriptReader.size().active);
    else if (count === 3) {
      // between two turns of the large read, after it saw nobody waiting: the small one asks, and
      // the time a stuck slice is waited for passes. The large read took a turn since the drain
      // last looked, so the drain waits on, and the large one lets go at the end of its next turn
      setImmediate(() => {
        answered = waitCommandHistory(small.path, small.limit(), 60_000).then(() => reads(large.path));
        jest.advanceTimersByTime(50);
      });
    }
  });
  expect((await waitCommandHistory(large.path, large.limit(), 60_000))!.complete).toBe(true);
  expect(await answered!).toBeLessThan(reads(large.path));
  // the large one let go at the end of its turn, and the small one was read alone
  expect(open).toEqual([1]);
}, 5000);

it("starts no more slices beside stuck ones than the reader has room for", async () => {
  const a = fixture("a"), b = fixture("b"), c = fixture("c");
  for (const s of [a, b, c]) writeFileSync(s.path, notice("done"));
  const holds = holdWindows(a.path, b.path);
  const heldA = holds(a.path), heldB = holds(b.path);
  controlledClock();
  const first = waitCommandHistory(a.path, a.limit(), 60_000);
  await heldA.entered;
  const second = waitCommandHistory(b.path, b.limit(), 60_000);
  jest.advanceTimersByTime(50);
  await heldB.entered;
  // both of the reader's leases are stuck: the third session waits without a slice (none waits in
  // the reader either), and has its slice once one ends
  const third = waitCommandHistory(c.path, c.limit(), 150);
  jest.advanceTimersByTime(50);
  for (let turn = 0; turn < 3; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
  jest.advanceTimersByTime(100);
  expect(await third).toMatchObject({ complete: false, through: 0 });
  expect(transcriptReader.size()).toMatchObject({ active: transcriptReader.capacity, waiting: 0 });
  heldA.release();
  expect(await first).toMatchObject({ complete: true });
  // A's slice ended; the drain, waiting on B's, looks again once the time passes and starts C's
  const after = waitCommandHistory(c.path, c.limit(), 60_000);
  jest.advanceTimersByTime(50);
  expect(await after).toMatchObject({ complete: true });
  heldB.release();
  expect(await second).toMatchObject({ complete: true });
}, 5000);

it("gives up a read stuck in flight once the last server lets go", async () => {
  const a = fixture("a"), b = fixture("b");
  writeFileSync(a.path, notice("a"));
  writeFileSync(b.path, notice("b"));
  const held = holdWindows(a.path)(a.path);
  const hold = holdCommandHistory();
  const first = waitCommandHistory(a.path, a.limit(), 60_000);
  await held.entered;
  hold();
  // the request gives up, and no slice is left waiting for the disk
  expect(await first).toBeNull();
  await commandHistorySettled();
  expect(commandHistorySize()).toMatchObject({ draining: false, sessions: 0, waiting: 0 });
  // the read in flight cannot be interrupted: it keeps its lease of the reader until it settles,
  // and other transcripts are read meanwhile
  expect(transcriptReader.size().active).toBe(1);
  expect(await waitCommandHistory(b.path, b.limit(), 1000)).toMatchObject({ complete: true, ends: [{ id: "b" }] });
  // the stuck transcript itself waits for that lease (one a path), then is read anew
  const again = waitCommandHistory(a.path, a.limit(), 60_000);
  held.release();
  expect(await again).toMatchObject({ complete: true, ends: [{ id: "a" }] });
  await transcriptReader.settled();
  expect(transcriptReader.size()).toEqual({ active: 0, waiting: 0, paths: 0 });
}, 5000);

it("counts the time it keeps a transcript open from when its read was asked for", async () => {
  const s = fixture();
  writeFileSync(s.path, notice("large") + filler.repeat(8));
  let now = Date.now();
  setSystemTime(new Date(now));
  try {
    // another reader of the same transcript (one lease a path) holds it while most of half the
    // read's deadline goes by
    const held = gate(), entered = gate();
    const other = transcriptReader.read(s.path, async () => { entered.open(); await held.opened; });
    await entered.opened;
    // and as much again at the third read: a lease held by its own start would run out of time then
    slowReads((_, count) => { if (count === 3) setSystemTime(new Date(now += 5_000)); });
    const reading = waitCommandHistory(s.path, s.limit(), 60_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    setSystemTime(new Date(now += 6_000));
    held.open();
    await other;
    expect(await reading).toMatchObject({ complete: true, through: s.limit() });
  } finally { setSystemTime(); }
}, 5000);

it("drops a window read across a start over that a request made while the window waited for the disk", async () => {
  const s = fixture();
  // one timestamp for both writes, a minute ahead: each request reads the lines of its ends again
  const tick = Math.ceil(Date.now() / 1000) + 60;
  writeFileSync(s.path, notice("a") + filler + notice("c") + filler);
  utimesSync(s.path, tick, tick);
  // every window but the first is held: the second until `second` opens, the rest until `rest` does
  const second = gate(), secondEntered = gate(), rest = gate(), restEntered = gate();
  release.push(second.open, rest.open);
  let held = 0;
  wrapReads((_, work) => (file) => work({ ...file, ahead: () => {}, window: async (position, length) => {
    if (position > 0) {
      if (held++ === 0) { secondEntered.open(); await second.opened; } else { restEntered.open(); await rest.opened; }
    }
    return file.window(position, length);
  } }));
  commandHistory(s.path, s.limit());
  release.push(watchCommandHistory(s.path, () => {})!);
  await secondEntered.opened;
  // rewritten in place within the tick: the first end another, the version the same
  writeFileSync(s.path, notice("b") + filler + notice("c") + filler);
  utimesSync(s.path, tick, tick);
  // a request reads the end's line again and finds it rewritten: the history starts over
  expect(commandHistory(s.path, s.limit(), false)!.ends).toEqual([]);
  second.open();
  await restEntered.opened;
  // the window read from before the start over is not taken in as the transcript's first: it was read from the start again
  expect(commandHistory(s.path, s.limit(), false)!.ends.map((end) => end.id)).toEqual(["b"]);
  rest.open();
  expect(await waitCommandHistory(s.path, s.limit(), 60_000)).toMatchObject({ complete: true, ends: [{ id: "b" }, { id: "c" }] });
}, 5000);

it("reads another transcript while one on a network filesystem is stuck in its native read", async () => {
  // every transcript on NFS: read through the thread pool, where a read can wait on the network for good
  const statfs = fsp.statfs;
  const network = spyOn(fsp, "statfs").mockImplementation((async (directory: string) => ({ ...(await statfs(directory)), type: 0x6969 })) as typeof statfs);
  release.push(() => network.mockRestore());
  const a = fixture("a"), b = fixture("b");
  writeFileSync(a.path, notice("a"));
  writeFileSync(b.path, notice("b"));
  // A's reads, the native ones below the reader, answer only once released
  const entered = gate(), held = gate();
  release.push(held.open);
  const open = fsp.open;
  const opens = spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (args[0] === a.path) {
      const read = handle.read.bind(handle) as (...rest: unknown[]) => Promise<unknown>;
      handle.read = (async (...rest: unknown[]) => { entered.open(); await held.opened; return read(...rest); }) as typeof handle.read;
    }
    return handle;
  }) as typeof open);
  release.push(() => opens.mockRestore());
  controlledClock();
  const first = waitCommandHistory(a.path, a.limit(), 60_000);
  await entered.opened;
  const other = waitCommandHistory(b.path, b.limit(), 60_000);
  jest.advanceTimersByTime(50);
  expect(await other).toMatchObject({ complete: true, through: b.limit(), ends: [{ id: "b" }] });
  held.open();
  expect(await first).toMatchObject({ complete: true, ends: [{ id: "a" }] });
}, 5000);
