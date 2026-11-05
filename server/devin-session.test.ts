import { describe, expect, it } from "bun:test";
import type { HerdrPane } from "../shared/protocol.ts";
import { DevinLockMissing, devinLockProof, devinSessionForPane, type DevinProc } from "./devin-session.ts";

function fixture() {
  const root = "/fixture/devin/cli";
  const db = `${root}/sessions.db`;
  const texts = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const links = new Map<string, string>();
  const stats = new Map<string, { dev: number; ino: number; uid: number; isFile(): boolean; isDirectory(): boolean }>();
  const stat = (ino: number, dir = false, uid = 1000) => ({ dev: 1, ino, uid, isFile: () => !dir, isDirectory: () => dir });
  const processStat = (parent: number, start: number) => `0 (devin) S ${parent} ${Array(17).fill("0").join(" ")} ${start} 0`;
  stats.set(root, stat(1, true));
  stats.set(`${root}/session_locks`, stat(2, true));
  stats.set(db, stat(3));
  for (const [pid, parent, start, command] of [[100, 5, 10, "devin\0"], [200, 100, 20, "/bin/devin\0acp\0"]] as const) {
    stats.set(`/proc/${pid}`, stat(pid, true));
    stats.set(`/proc/${pid}/exe`, stat(90));
    texts.set(`/proc/${pid}/stat`, processStat(parent, start));
    texts.set(`/proc/${pid}/cmdline`, command);
  }
  lists.set("/proc/100/task", ["100", "101"]);
  texts.set("/proc/100/task/100/children", "");
  texts.set("/proc/100/task/101/children", "200");
  lists.set("/proc/200/fd", ["8"]);
  const setLock = (session: string, ino = 50, fd = "8") => {
    const file = `${root}/session_locks/${session}.lock`;
    links.set(`/proc/200/fd/${fd}`, file);
    stats.set(file, stat(ino));
    stats.set(`/proc/200/fd/${fd}`, stat(ino));
    texts.set(`/proc/200/fdinfo/${fd}`, `pos:\t0\nlock:\t1: FLOCK  ADVISORY  WRITE 200 01:01:${ino} 0 EOF\n`);
  };
  setLock("fresh-session");
  const get = <T,>(map: Map<string, T>, path: string): T => {
    const value = map.get(path);
    if (value === undefined) throw new Error(`missing fixture ${path}`);
    return value;
  };
  const proc: DevinProc = {
    uid: 1000,
    read: (path) => get(texts, path),
    list: (path) => get(lists, path),
    link: (path) => get(links, path),
    real: (path) => path,
    stat: (path) => get(stats, path),
  };
  return { root, db, proc, texts, lists, links, stats, stat, processStat, setLock, proof: () => devinLockProof(100, db, proc) };
}

describe("Devin kernel session lock", () => {
  it("resolves a fresh session, then observes a switch and close", () => {
    const f = fixture();
    const first = f.proof();
    expect(first.session).toBe("fresh-session");
    f.setLock("continued-session", 51);
    const switched = f.proof();
    expect(switched.session).toBe("continued-session");
    expect(switched.binding).not.toBe(first.binding);
    f.lists.set("/proc/200/fd", []);
    expect(f.proof).toThrow();
  });

  it("rejects ambiguous, unlocked, deleted, replaced, foreign or malformed locks", () => {
    const f = fixture();
    f.setLock("another-session", 51, "9");
    f.lists.set("/proc/200/fd", ["8", "9"]);
    expect(f.proof).toThrow();
    f.lists.set("/proc/200/fd", ["8"]);
    const info = f.texts.get("/proc/200/fdinfo/8")!;
    f.texts.set("/proc/200/fdinfo/8", "pos: 0\n");
    expect(f.proof).toThrow();
    f.texts.set("/proc/200/fdinfo/8", info);
    const path = `${f.root}/session_locks/fresh-session.lock`;
    f.links.set("/proc/200/fd/8", `${path} (deleted)`);
    expect(f.proof).toThrow();
    f.links.set("/proc/200/fd/8", path);
    f.stats.set(path, f.stat(99));
    expect(f.proof).toThrow();
    f.stats.set(path, f.stat(50, false, 1001));
    expect(f.proof).toThrow();
    f.stats.delete(path);
    expect(f.proof).toThrow();
    f.links.set("/proc/200/fd/8", `${f.root}/session_locks/../bad.lock`);
    expect(f.proof).toThrow();
  });

  it("binds both process births and rejects a wrong parent or executable", () => {
    const f = fixture();
    const original = f.proof();
    f.texts.set("/proc/100/stat", f.processStat(5, 11));
    expect(f.proof().binding).not.toBe(original.binding);
    f.texts.set("/proc/200/stat", f.processStat(100, 21));
    expect(f.proof().binding).not.toBe(original.binding);
    f.texts.set("/proc/200/stat", f.processStat(101, 21));
    expect(f.proof).toThrow();
    f.texts.set("/proc/200/stat", f.processStat(100, 21));
    f.stats.set("/proc/200/exe", f.stat(91));
    expect(f.proof).toThrow();
  });

  it("tells no lock to read (a caller may fall back) from evidence that refuses", () => {
    const missing = (f: ReturnType<typeof fixture>) => { try { f.proof(); } catch (error) { return error instanceof DevinLockMissing; } throw new Error("proof did not throw"); };
    const noLocksDir = fixture();
    noLocksDir.stats.delete(`${noLocksDir.root}/session_locks`);
    expect(missing(noLocksDir)).toBeTrue();
    const noLockYet = fixture();
    noLockYet.lists.set("/proc/200/fd", []);
    expect(missing(noLockYet)).toBeTrue();
    const twoLocks = fixture();
    twoLocks.setLock("another-session", 51, "9");
    twoLocks.lists.set("/proc/200/fd", ["8", "9"]);
    expect(missing(twoLocks)).toBeFalse();
    // an unreadable child may hold another lock: never a proof from the readable one alone
    const unreadChild = fixture();
    unreadChild.texts.set("/proc/100/task/101/children", "200 300");
    expect(missing(unreadChild)).toBeTrue();
    const foreign = fixture();
    foreign.stats.set(`${foreign.root}/session_locks/fresh-session.lock`, foreign.stat(50, false, 1001));
    expect(missing(foreign)).toBeFalse();
  });

  it("binds the store it read: a database replaced between two proofs changes the binding", () => {
    const f = fixture();
    const first = f.proof();
    f.stats.set(f.db, f.stat(4));
    const replaced = f.proof();
    expect(replaced.session).toBe(first.session);
    expect(replaced.binding).not.toBe(first.binding);
  });

  it("accepts separate same-folder owners but refuses contradictory explicit identities", () => {
    const pane = { pane_id: "a", agent: "devin", cwd: "/work" } as HerdrPane;
    const peer = { ...pane, pane_id: "b" };
    expect(devinSessionForPane(pane, [pane, peer], ["devin"], "fresh-session")).toBe("fresh-session");
    expect(devinSessionForPane(peer, [pane, peer], ["devin"], "other-session")).toBe("other-session");
    expect(() => devinSessionForPane(pane, [pane, peer], ["devin", "--resume=old-session"], "fresh-session")).toThrow();
    const reported = { ...pane, agent_session: { agent: "devin", kind: "id", value: "other-session" } } as HerdrPane;
    expect(() => devinSessionForPane(reported, [reported], ["devin"], "fresh-session")).toThrow();
  });
});
