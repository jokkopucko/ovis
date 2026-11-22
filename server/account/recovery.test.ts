/**
 * `ovis recover` (device-row-states rows R11, T70, P7, P23, S22, E41, E46): the recovery socket only this PC's user
 * reaches, and the temporary release of rows this PC already held from the wait for a whole read.
 */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bounded } from "../relay/test-helpers.ts";
import {
  RECOVER_DIR, RECOVER_SOCKET, RecoveryReleases, ReleaseJournalError, askRecovery, openRecoverySocket, releaseRefusal,
  type RecoveryCandidate, type RecoveryJournalEntry,
} from "./recovery.ts";

const ends: (() => void)[] = [];
afterEach(() => { for (const end of ends.splice(0).reverse()) end(); });

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-recover-"));
  chmodSync(dir, 0o700);
  ends.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const echo = async (request: unknown) => ({ heard: request });
const unix = process.platform !== "win32";

function opened(dir: string, handle: (request: unknown) => Promise<unknown> = echo) {
  const socket = openRecoverySocket({ stateDir: dir, handle });
  if ("refused" in socket) throw new Error(`The recovery socket did not open: ${socket.refused}`);
  ends.push(() => socket.stop());
  return socket;
}

test.if(unix)("R11: the recovery socket is in a folder only this PC's user may enter, and answers its user", async () => {
  const dir = stateDir();
  const socket = opened(dir);
  expect(statSync(join(dir, RECOVER_DIR)).mode & 0o777).toBe(0o700);
  expect(statSync(socket.path).mode & 0o777).toBe(0o600);
  expect(socket.path).toBe(join(dir, RECOVER_DIR, RECOVER_SOCKET));
  expect(await bounded(askRecovery(dir, { act: "list" }))).toEqual({ heard: { act: "list" } });
});

test.if(unix)("R11: the recovery socket delivers a complete reply larger than its send buffer", async () => {
  const dir = stateDir();
  const reply = { rows: "x".repeat(2 * 1024 * 1024) };
  opened(dir, async () => reply);
  expect(await bounded(askRecovery(dir, { act: "list" }))).toEqual(reply);
});

test.if(unix)("R11: the recovery client preserves UTF-8 device labels across socket chunks", async () => {
  const dir = stateDir();
  const label = "Téléphone€".repeat(80_000);
  opened(dir, async () => ({ label }));
  const result = await bounded(askRecovery(dir, { act: "list" }));
  if (typeof result !== "object" || result === null || !("label" in result) || typeof result.label !== "string") {
    throw new Error("The response did not contain a label");
  }
  expect(result.label.includes("\ufffd")).toBe(false);
  expect(result.label === label).toBe(true);
});

test.if(unix)("R11: a recovery folder another user may enter is refused", () => {
  const dir = stateDir();
  mkdirSync(join(dir, RECOVER_DIR), { mode: 0o700 });
  chmodSync(join(dir, RECOVER_DIR), 0o755);
  expect(openRecoverySocket({ stateDir: dir, handle: echo })).toHaveProperty("refused");
});

test.if(unix)("R11: a recovery folder that is a symlink is refused", () => {
  const dir = stateDir();
  const elsewhere = mkdtempSync(join(tmpdir(), "ovis-recover-elsewhere-"));
  chmodSync(elsewhere, 0o700);
  ends.push(() => rmSync(elsewhere, { recursive: true, force: true }));
  symlinkSync(elsewhere, join(dir, RECOVER_DIR));
  expect(openRecoverySocket({ stateDir: dir, handle: echo })).toHaveProperty("refused");
});

for (const { kind, create } of [
  { kind: "directory", create: (path: string) => mkdirSync(path) },
  { kind: "file", create: (path: string) => writeFileSync(path, "leave this alone") },
]) {
  test.if(unix)(`R11: an existing ${kind} at the socket path is refused and preserved`, () => {
    const dir = stateDir();
    mkdirSync(join(dir, RECOVER_DIR), { mode: 0o700 });
    const path = join(dir, RECOVER_DIR, RECOVER_SOCKET);
    create(path);
    const result = openRecoverySocket({ stateDir: dir, handle: echo });
    if ("stop" in result) ends.push(() => result.stop());
    expect(result).toEqual({ refused: "socket_unsafe" });
    expect(kind === "directory" ? statSync(path).isDirectory() : statSync(path).isFile()).toBe(true);
  });
}

test.if(unix)("R11: a state folder others may write without the sticky bit is refused", () => {
  const dir = stateDir();
  chmodSync(dir, 0o777);
  expect(openRecoverySocket({ stateDir: dir, handle: echo })).toHaveProperty("refused");
  chmodSync(dir, 0o1777);
  const socket = openRecoverySocket({ stateDir: dir, handle: echo });
  if ("stop" in socket) socket.stop();
  expect(socket).not.toHaveProperty("refused");
});

test.if(unix)("R11: a state folder owned by another user is refused", () => {
  const dir = stateDir();
  expect(openRecoverySocket({ stateDir: dir, handle: echo, ownerOf: () => (process.getuid?.() ?? 0) + 1 })).toEqual({ refused: "state_dir_unsafe" });
  const socket = openRecoverySocket({ stateDir: dir, handle: echo, ownerOf: () => 0 });
  if ("stop" in socket) socket.stop();
  expect(socket).not.toHaveProperty("refused");
});

test.if(unix)("R11: a socket whose mode was widened after it was bound answers nothing", async () => {
  const dir = stateDir();
  const socket = opened(dir);
  chmodSync(socket.path, 0o666);
  await expect(bounded(askRecovery(dir, { act: "list" }))).rejects.toThrow("The server answered nothing on its recovery socket");
});

test.if(unix)("R11: a socket swapped for another after it was bound answers nothing", async () => {
  const dir = stateDir();
  const socket = opened(dir);
  const other = mkdtempSync(join(tmpdir(), "ovis-recover-other-"));
  chmodSync(other, 0o700);
  ends.push(() => rmSync(other, { recursive: true, force: true }));
  const impostor = openRecoverySocket({ stateDir: other, handle: async () => ({ impostor: true }) });
  if ("refused" in impostor) throw new Error(impostor.refused);
  ends.push(() => impostor.stop());
  rmSync(socket.path);
  renameSync(impostor.path, socket.path);
  await expect(bounded(askRecovery(dir, { act: "list" }))).rejects.toThrow("The server answered nothing on its recovery socket");
});

test.if(unix)("R11: a recovery folder whose mode was widened after the socket was bound answers nothing", async () => {
  const dir = stateDir();
  opened(dir);
  chmodSync(join(dir, RECOVER_DIR), 0o711);
  await expect(bounded(askRecovery(dir, { act: "list" }))).rejects.toThrow("The server answered nothing on its recovery socket");
});

test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("R11: another user cannot connect (needs Linux root to switch user)", async () => {
  const dir = stateDir();
  const socket = opened(dir);
  const run = Bun.spawn(["setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", process.execPath, "-e", `
    import { createConnection } from "node:net";
    const socket = createConnection(process.argv[1]);
    socket.on("connect", () => { console.log("connected"); socket.destroy(); });
    socket.on("error", (error) => { console.log(JSON.stringify({ uid: process.getuid(), code: error.code })); });
  `, socket.path], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
  ends.push(() => { if (run.exitCode === null) run.kill(); });
  const [exit, stdout, stderr] = await bounded(Promise.all([
    run.exited, new Response(run.stdout).text(), new Response(run.stderr).text(),
  ]));
  expect(exit, stderr).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ uid: 65534, code: "EACCES" });
});

test.if(unix)("R11: an HTTP request on the socket gets no HTTP answer", async () => {
  const dir = stateDir();
  const socket = opened(dir);
  const answer = await bounded(fetch("http://localhost/api/devices", { unix: socket.path }).then((response) => response.status, () => "refused"));
  expect(answer).toBe("refused");
});

test("R11: no recovery socket opens on Windows", () => {
  const dir = stateDir();
  expect(openRecoverySocket({ stateDir: dir, handle: echo, platform: "win32" })).toEqual({ refused: "windows" });
  expect(existsSync(join(dir, RECOVER_DIR))).toBe(false);
});

const waiting = (id: string, extra: Partial<RecoveryCandidate> = {}): RecoveryCandidate => ({
  id, key: `key-${id}`, label: id, origin: { from: "remote", how: "list" }, waiting: "catching_up",
  joinHold: false, held: false, openNotice: false, expired: false, covered: false, frozen: false, lastSeenAt: null, ...extra,
});

test("T70: only a row that waits for a whole read, with an origin written here and nothing else against it, is releasable", () => {
  expect(releaseRefusal(waiting("a"), { logReadable: true })).toBeNull();
  expect(releaseRefusal(waiting("a", { waiting: "held_by_age" }), { logReadable: true })).toBeNull();
  expect(releaseRefusal(waiting("a", { origin: { from: "legacy", how: "legacy" } }), { logReadable: true })).toBeNull();
  expect(releaseRefusal(waiting("a", { waiting: null }), { logReadable: true })).toBe("not_waiting");
  expect(releaseRefusal(waiting("a", { origin: null }), { logReadable: true })).toBe("no_origin");
  expect(releaseRefusal(waiting("a", { joinHold: true }), { logReadable: true })).toBe("join_hold");
  expect(releaseRefusal(waiting("a", { held: true }), { logReadable: true })).toBe("held");
  expect(releaseRefusal(waiting("a", { openNotice: true }), { logReadable: true })).toBe("notice_open");
  expect(releaseRefusal(waiting("a", { expired: true }), { logReadable: true })).toBe("expired");
  expect(releaseRefusal(waiting("a", { covered: true }), { logReadable: true })).toBe("removed");
  expect(releaseRefusal(waiting("a", { frozen: true }), { logReadable: true })).toBe("frozen");
  expect(releaseRefusal(waiting("a"), { logReadable: false })).toBe("log_unreadable");
});

function releases(options: { failJournal?: () => boolean } = {}) {
  const journal: RecoveryJournalEntry[] = [];
  const closed: string[] = [];
  const store = new RecoveryReleases({
    journal: (entry) => { if (options.failJournal?.()) throw new Error("disk full"); journal.push(entry); },
  });
  const session = (row: string) => { const release = store.releaseOf(row)!; store.watch(release, () => closed.push(`${row}@${release}`)); };
  return { store, journal, closed, session };
}

test("T70: a release is journalled before it takes effect, and a failed write releases nobody", () => {
  let fail = true;
  const { store, journal } = releases({ failJournal: () => fail });
  expect(() => store.release([waiting("a")], "owner")).toThrow(ReleaseJournalError);
  expect(store.releaseOf("a")).toBeNull();
  fail = false;
  const id = store.release([waiting("a"), waiting("b")], "owner");
  expect(journal).toEqual([{ kind: "release", release: id, rows: [{ id: "a", key: "key-a" }, { id: "b", key: "key-b" }], by: "owner" }]);
  expect(store.releaseOf("a")).toBe(id);
  expect(store.releaseOf("b")).toBe(id);
  expect(store.releaseOf("c")).toBeNull();
});

test("T70: a release ends at the first whole read and at a restart", () => {
  const { store } = releases();
  store.release([waiting("a")], "owner");
  store.endAll();
  expect(store.releaseOf("a")).toBeNull();
  const before = releases();
  before.store.release([waiting("a")], "owner");
  expect(releases().store.releaseOf("a")).toBeNull();
});

test("T70: undo closes each session opened under the named release, also when its journal write fails", () => {
  let fail = false;
  const { store, journal, closed, session } = releases({ failJournal: () => fail });
  const first = store.release([waiting("a")], "owner");
  const second = store.release([waiting("b")], "owner");
  session("a");
  session("a");
  session("b");
  fail = true;
  const undone = store.undo(["a"], "owner");
  expect(undone.journalError).toBeInstanceOf(Error);
  expect(closed).toEqual([`a@${first}`, `a@${first}`]);
  expect(store.releaseOf("a")).toBeNull();
  expect(store.releaseOf("b")).toBe(second);
  fail = false;
  store.undo(undefined, "owner");
  expect(closed).toEqual([`a@${first}`, `a@${first}`, `b@${second}`]);
  expect(journal.at(-1)).toEqual({ kind: "undo", releases: [second], rows: ["b"], by: "owner" });
});

test("T70: the rows a source registers are the candidates, across every source, and a source can be removed", () => {
  const { store } = releases();
  const unregister = store.registerRecoverySource(() => [waiting("a")]);
  store.registerRecoverySource(() => [waiting("b", { waiting: null })]);
  expect(store.candidates().map((row) => row.id)).toEqual(["a", "b"]);
  unregister();
  expect(store.candidates().map((row) => row.id)).toEqual(["b"]);
});

test("T70: undo of one row ends that row's whole release, its other rows included", () => {
  const { store } = releases();
  const release = store.release([waiting("a"), waiting("b")], "owner");
  const undone = store.undo(["a"], "owner");
  expect(undone.releases).toEqual([release]);
  expect(store.releaseOf("a")).toBeNull();
  expect(store.releaseOf("b")).toBeNull();
});
