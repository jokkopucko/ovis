import { expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "./runs.ts";

it("a reserved run is nobody; after bind its depth survives restart, and revocation survives re-opening", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-"));
  try {
    const store = new RunStore(dir);
    const reservation = store.reserve();
    const token = readFileSync(reservation.tokenFile, "utf8");
    expect(statSync(reservation.tokenFile).mode & 0o777).toBe(0o600);
    expect(store.verify(token)).toBeNull();
    reservation.bind({ self: "t1", harness: "claude", started_by: null, root: reservation.id, depth: 0 });
    const child = store.reserve();
    child.bind({ self: "t2", harness: "gjc", started_by: reservation.id, root: reservation.id, depth: 1 });
    store.rememberForeground(reservation.id, process.pid);
    const childToken = readFileSync(child.tokenFile, "utf8");
    const restored = new RunStore(dir);
    for (let n = 0; n < 257; n++) restored.rememberStart(reservation.id, `key${n}`, child.id);
    expect(new RunStore(dir).previousStart(reservation.id, "key0")).toBe(child.id);
    expect(restored.verify(childToken)).toMatchObject({ self: "t2", depth: 1 });
    expect(readFileSync(join(dir, "runs.json"), "utf8")).not.toContain(childToken);
    restored.reconcile([
      { address: "t1", state: "live", labels: {}, foreground: { pid: process.ppid, argv: ["claude", "--mcp-config", join(dir, "mcp", `${reservation.id}.json`)] } },
      { address: "t2", state: "live", labels: { "ovis.run": child.id, "ovis.acp": "keeper" } },
    ], address => address === "t2" ? "keeper" : undefined);
    expect(restored.verify(token)).toBeNull();
    expect(restored.verify(childToken)).not.toBeNull();
    restored.revokeAll();
    expect(existsSync(child.tokenFile)).toBe(false);
    expect(new RunStore(dir).verify(childToken)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.skipIf(process.platform === "win32")("a TUI's run ends when its process does, though the pane's shell stays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-"));
  try {
    const store = new RunStore(dir);
    const tui = Bun.spawn(["sleep", "30"]);
    const run = store.reserve();
    run.bind({ self: "t1", harness: "omo", started_by: null, root: run.id, depth: 0 });
    store.rememberForeground(run.id, tui.pid);
    const token = readFileSync(run.tokenFile, "utf8");
    expect(store.verify(token)).not.toBeNull();
    tui.kill(); await tui.exited;
    expect(store.verify(token)).toBeNull();
    expect(existsSync(run.tokenFile)).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("an OmO or pi still running with its launch extension keeps its run across a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-"));
  try {
    const store = new RunStore(dir);
    const live = store.reserve(), gone = store.reserve();
    live.bind({ self: "t1", harness: "omo", started_by: null, root: live.id, depth: 0 });
    gone.bind({ self: "t2", harness: "pi", started_by: null, root: gone.id, depth: 0 });
    for (const run of [live, gone]) store.rememberForeground(run.id, process.pid);
    const [kept, dropped] = [live, gone].map(run => readFileSync(run.tokenFile, "utf8"));
    const restored = new RunStore(dir);
    restored.reconcile([
      { address: "t1", state: "live", labels: {}, foreground: { pid: process.pid, argv: ["bun", "cli.js", "-e", join(dir, "mcp", `${live.id}.js`)] } },
      { address: "t2", state: "live", labels: {}, foreground: { pid: process.pid, argv: ["bun", "cli.js", "-e", join(dir, "mcp", `${live.id}.js`)] } },
    ], () => undefined);
    expect(restored.verify(kept!)).toMatchObject({ harness: "omo" });
    expect(restored.verify(dropped!)).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// pi, OmO and Claude Code set process.title, which leaves only their name in /proc/<pid>/cmdline (#4864)
it.skipIf(process.platform !== "linux")("a TUI whose title hides its launch argv keeps the run its environment names across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-"));
  const tuis: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const store = new RunStore(dir);
    const [kept, wrong, none, notShells] = ["t1", "t2", "t3", "t4"].map(self => {
      const run = store.reserve();
      run.bind({ self, harness: "pi", started_by: null, root: run.id, depth: 0 });
      return run;
    });
    const env = (tokenFile?: string) => {
      const { OVIS_AGENT_TOKEN_FILE: _, ...rest } = process.env;
      return tokenFile ? { ...rest, OVIS_AGENT_TOKEN_FILE: tokenFile } : rest;
    };
    for (const [run, tokenFile] of [[kept!, kept!.tokenFile], [wrong!, kept!.tokenFile], [none!, undefined], [notShells!, notShells!.tokenFile]] as const) {
      const tui = Bun.spawn(["sleep", "30"], { env: env(tokenFile) });
      tuis.push(tui);
      store.rememberForeground(run.id, tui.pid);
    }
    mkdirSync(join(dir, "mcp"), { recursive: true });
    for (const run of [kept!, wrong!, none!, notShells!]) writeFileSync(join(dir, "mcp", `${run.id}.js`), "export default () => {};\n");
    const tokens = [kept!, wrong!, none!, notShells!].map(run => readFileSync(run.tokenFile, "utf8"));
    const restored = new RunStore(dir);
    // this test is each pane's shell, which started its TUI; t4's shell is another process: what runs in front there
    // inherited the token file from something else, a program the agent ran or one it left behind
    restored.reconcile(tuis.map((tui, i) => ({ address: `t${i + 1}`, state: "live", labels: {}, pid: i === 3 ? tuis[0]!.pid : process.pid, foreground: { pid: tui.pid, argv: ["pi"] } })), () => undefined);
    expect(restored.verify(tokens[0]!)).toMatchObject({ self: "t1", harness: "pi" });
    expect(existsSync(kept!.tokenFile)).toBe(true);
    expect(existsSync(join(dir, "mcp", `${kept!.id}.js`))).toBe(true);
    for (const [i, run] of [[1, wrong!], [2, none!], [3, notShells!]] as const) {
      expect(restored.verify(tokens[i]!)).toBeNull();
      expect(existsSync(run.tokenFile)).toBe(false);
      expect(existsSync(join(dir, "mcp", `${run.id}.js`))).toBe(false);
    }
  } finally {
    for (const tui of tuis) tui.kill();
    await Promise.all(tuis.map(tui => tui.exited));
    rmSync(dir, { recursive: true, force: true });
  }
});
