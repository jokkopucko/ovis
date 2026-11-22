import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HerdrPane } from "../shared/protocol.ts";
import { heldRuntime, omoProcessIdentity, omoSessionFolder, omoTranscriptsOfCwd, selectOmoTranscript } from "./omo.ts";
import { processStartedAt } from "./process-start.ts";

const holdRecord = (dir: string, id: string, pid: number, record: object): void => {
  const holders = join(dir, "session-holders", encodeURIComponent(id));
  mkdirSync(holders, { recursive: true });
  writeFileSync(join(holders, `${pid}.json`), JSON.stringify(record));
};
const writeSession = (dir: string, id: string, cwd: string): string => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `2026-10-02T16-47-10-905Z_${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "session", id, cwd, timestamp: "2026-10-02T16:47:10.905Z" }) + "\n");
  return path;
};
const info = (processes: { pid: number; argv?: string[]; cwd?: string }[]) => ({ process_info: { foreground_processes: processes } });
const NEUTRAL = ["/opt/team-ai/bin/run"];

it.skipIf(process.platform !== "linux")("prefers the OS cwd over stale pane directories for a held custom session", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-proc-cwd-")));
  try {
    const home = join(root, "home");
    const pid = process.pid;
    const cwd = readlinkSync(`/proc/${pid}/cwd`);
    const agentDir = join(root, "agent");
    const dir = join(agentDir, "sessions", omoSessionFolder(cwd));
    holdRecord(dir, "held", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    const written = writeSession(dir, "held", cwd);
    writeSession(dir, "unheld", cwd);
    const pane = { pane_id: "w:p1", cwd: join(root, "stale-pane"), foreground_cwd: join(root, "stale-foreground") } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL }])]]);
    const resolved = omoTranscriptsOfCwd(cwd, [pane], infos, home, () => [`OMO_CODING_AGENT_DIR=${agentDir}`]).get(pane.pane_id);
    expect(resolved?.path).toBe(realpathSync(written));
    expect(resolved?.pending).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps a held claim's store when its own file cannot be read as a candidate", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-scope-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const dirB = join(home, ".omo", "agent", "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    holdRecord(dirA, "sess-x", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    writeFileSync(join(dirA, "2026-10-02T16-47-10-905Z_sess-x.jsonl"), "{");
    writeSession(dirB, "sess-x", cwd);
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL, cwd }, { pid: process.ppid, argv: ["node", "/opt/omo/bin/omo.js"], cwd }])]]);
    const envOf = (pid: number) => pid === process.pid ? [`OMO_CODING_AGENT_DIR=${storeA}`] : ["PATH=/bin"];
    const out = omoTranscriptsOfCwd(cwd, [pane], infos, home, envOf).get(pane.pane_id);
    // the claim still binds store A: B's same-id file is another session, and the pane
    // reports nothing — not the other store's transcript
    expect(out?.path).toBeNull();
    expect(out?.pending).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps a truly pending held id pending while another store has the id written", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-pending-scope-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const dirB = join(home, ".omo", "agent", "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    holdRecord(dirA, "sess-x", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    writeSession(dirB, "sess-x", cwd);
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL, cwd }, { pid: process.ppid, argv: ["node", "/opt/omo/bin/omo.js"], cwd }])]]);
    const envOf = (pid: number) => pid === process.pid ? [`OMO_CODING_AGENT_DIR=${storeA}`] : ["PATH=/bin"];
    const out = omoTranscriptsOfCwd(cwd, [pane], infos, home, envOf).get(pane.pane_id);
    expect(out?.path).toBeNull();
    expect(out?.pending).toBe("sess-x");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("binds a structured claim to its store and a legacy string claim to none", () => {
  const a = { path: "/a/s.jsonl", id: "same", createdAt: 100, store: "/store-a" };
  const b = { path: "/b/s.jsonl", id: "same", createdAt: 100, store: "/store-b" };
  const runtime = { paneId: "p", startedAt: 10, paths: [] as string[], ids: [] as string[] };
  const scoped = heldRuntime(runtime, [{ id: "same", store: "/store-b" }], [a, b]);
  expect(selectOmoTranscript("p", [a, b], [scoped])).toBe("/b/s.jsonl");
  expect(selectOmoTranscript("p", [a], [heldRuntime(runtime, [{ id: "same", store: "/store-b" }], [a])])).toBeNull();
  // a claim whose file is gone still binds: it never resolves to another store's file
  expect(selectOmoTranscript("p", [a], [heldRuntime(runtime, [{ id: "same", store: "/store-b" }], [a, b])])).toBeNull();
  const unscoped = heldRuntime(runtime, ["same"], [a]);
  expect(selectOmoTranscript("p", [a], [unscoped])).toBe("/a/s.jsonl");
});

it("fails closed when one pane holds two different sessions", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-ambiguous-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    holdRecord(dirA, "sess-1", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    holdRecord(dirA, "sess-2", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    writeSession(dirA, "sess-1", cwd);
    writeSession(dirA, "sess-2", cwd);
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL, cwd }])]]);
    const out = omoTranscriptsOfCwd(cwd, [pane], infos, home, () => [`OMO_CODING_AGENT_DIR=${storeA}`]).get(pane.pane_id);
    expect(out?.path).toBeNull();
    expect(out?.pending).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("lets an ambiguous peer's claims still block a pane claiming a known file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-peer-block-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const pidA = process.pid;
    const pidB = process.ppid;
    holdRecord(dirA, "shared", pidA, { pid: pidA, processStartedAtMs: processStartedAt(pidA), cwd });
    holdRecord(dirA, "shared", pidB, { pid: pidB, processStartedAtMs: processStartedAt(pidB), cwd });
    holdRecord(dirA, "other", pidB, { pid: pidB, processStartedAtMs: processStartedAt(pidB), cwd });
    writeSession(dirA, "shared", cwd);
    writeSession(dirA, "other", cwd);
    const panes = [{ pane_id: "w:p1", cwd } as HerdrPane, { pane_id: "w:p2", cwd } as HerdrPane];
    const infos = new Map([
      ["w:p1", info([{ pid: pidA, argv: NEUTRAL, cwd }])],
      ["w:p2", info([{ pid: pidB, argv: NEUTRAL, cwd }])],
    ]);
    const out = omoTranscriptsOfCwd(cwd, panes, infos, home, () => [`OMO_CODING_AGENT_DIR=${storeA}`]);
    expect(out.get("w:p1")?.path).toBeNull();
    expect(out.get("w:p2")?.path).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("rejects a holder the pane's cwd names when the process runs elsewhere", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-cwd-win-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const other = join(root, "other");
    const storeA = join(root, "a", "agent");
    const dirA = join(storeA, "sessions", omoSessionFolder(cwd));
    const pid = process.pid;
    const env = [`OMO_CODING_AGENT_DIR=${storeA}`];
    holdRecord(dirA, "stale", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd });
    expect(omoProcessIdentity({ pid, argv: NEUTRAL, cwd: other }, cwd, home, () => env)).toBeNull();
    holdRecord(join(storeA, "sessions", omoSessionFolder(other)), "moved", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd: other });
    expect(omoProcessIdentity({ pid, argv: NEUTRAL, cwd: other }, cwd, home, () => env))
      .toEqual({ agentDir: storeA, heldIds: ["moved"], custom: true, held: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("binds the folder a moved process runs in and resolves the session it holds there", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-moved-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const other = join(root, "other");
    const storeA = join(root, "a", "agent");
    const dirOther = join(storeA, "sessions", omoSessionFolder(other));
    const pid = process.pid;
    holdRecord(dirOther, "moved", pid, { pid, processStartedAtMs: processStartedAt(pid), cwd: other });
    const file = writeSession(dirOther, "moved", other);
    const env = () => [`OMO_CODING_AGENT_DIR=${storeA}`];
    const pane = { pane_id: "w:p1", cwd } as HerdrPane;
    const infos = new Map([[pane.pane_id, info([{ pid, argv: NEUTRAL, cwd: other }])]]);
    expect(omoTranscriptsOfCwd(other, [pane], infos, home, env).get(pane.pane_id)?.path).toBe(realpathSync(file));
    expect(omoTranscriptsOfCwd(cwd, [pane], infos, home, env).has(pane.pane_id)).toBeFalse();
    const moved = { pane_id: "w:p1", cwd, foreground_cwd: other } as HerdrPane;
    const processCwd = new Map([[moved.pane_id, info([{ pid, argv: NEUTRAL, cwd: other }])]]);
    expect(omoTranscriptsOfCwd(other, [moved], processCwd, home, env).get(moved.pane_id)?.path).toBe(realpathSync(file));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("still rejects conflicting claims among peers that moved to one cwd", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-omo-moved-peers-")));
  try {
    const home = join(root, "home");
    const cwd = join(root, "project");
    const other = join(root, "other");
    const storeA = join(root, "a", "agent");
    const dirOther = join(storeA, "sessions", omoSessionFolder(other));
    const pidA = process.pid;
    const pidB = process.ppid;
    holdRecord(dirOther, "shared", pidA, { pid: pidA, processStartedAtMs: processStartedAt(pidA), cwd: other });
    holdRecord(dirOther, "shared", pidB, { pid: pidB, processStartedAtMs: processStartedAt(pidB), cwd: other });
    writeSession(dirOther, "shared", other);
    const panes = [{ pane_id: "w:p1", cwd } as HerdrPane, { pane_id: "w:p2", cwd: other } as HerdrPane];
    const infos = new Map([
      ["w:p1", info([{ pid: pidA, argv: NEUTRAL, cwd: other }])],
      ["w:p2", info([{ pid: pidB, argv: NEUTRAL, cwd: other }])],
    ]);
    const out = omoTranscriptsOfCwd(other, panes, infos, home, () => [`OMO_CODING_AGENT_DIR=${storeA}`]);
    expect(out.get("w:p1")?.path).toBeNull();
    expect(out.get("w:p2")?.path).toBeNull();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
