import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./machine-security.ts";
import type { ProcessInfo } from "./herdr/client.ts";
import type { TerminalProcess } from "./kiro-terminal.ts";
import { parseTerminalProcesses, tmuxCodexProcess as discoverTmux, tmuxWrapper } from "./tmux-terminal.ts";

// Synthetic interpreter PIDs must never read the host's argv unless a test supplies its own reader.
const tmuxCodexProcess: typeof discoverTmux = (info, platform, clients, rows, birth, argv = () => null) =>
  discoverTmux(info, platform, clients, rows, birth, argv);

const info = { foreground_processes: [{ pid: 10, argv: ["tmux", "-S", "/fixture/tmux.sock", "attach-session", "-t", "old-name"] }] } as ProcessInfo;
const mapping = "10\t/dev/pts/1\t11\t/fixture/tmux.sock\t$2\t@3\t%4\t20\t/dev/pts/2\t0\t0\n";
const processes: TerminalProcess[] = [
  { pid: 10, parent: 1, group: 10, foreground: 10, tty: "pts/1", command: "tmux: client" },
  { pid: 11, parent: 1, group: 11, foreground: -1, tty: "?", command: "tmux: server" },
  { pid: 20, parent: 11, group: 20, foreground: 30, tty: "pts/2", command: "/bin/bash" },
  { pid: 30, parent: 20, group: 30, foreground: 30, tty: "pts/2", command: "/opt/bin/codex" },
];
const births = (pid: number) => pid * 100;
const wrapped = processes.map((row) => row.pid === 20 ? { ...row, foreground: 25 }
  : row.pid === 30 ? { ...row, parent: 25, group: 25, foreground: 25 } : row)
  .concat({ pid: 25, parent: 20, group: 25, foreground: 25, tty: "pts/2", command: "/bin/sh" });

describe("tmux native process proof", () => {
  it.skipIf(process.platform === "win32")("requests UTF8 for native metadata under a C locale", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "ovis-tmux-read-"));
    const previousPath = process.env["PATH"], previousLocale = process.env["LC_ALL"];
    fs.writeFileSync(join(root, "tmux"), `#!/bin/sh
[ "$LC_ALL" = C ] || exit 2
[ "$1" = -u ] || exit 3
case "$4" in
  list-clients) printf '%s' ${shellQuote(mapping)} ;;
  *) exit 4 ;;
esac
`, { mode: 0o755 });
    process.env["PATH"] = `${root}:${previousPath ?? ""}`;
    process.env["LC_ALL"] = "C";
    try {
      const found = await discoverTmux(info, "linux", undefined, async () => processes, births, () => ["/opt/bin/codex"]);
      expect(found).toMatchObject({ pid: 30, argvState: "local" });
    } finally {
      if (previousPath === undefined) delete process.env["PATH"]; else process.env["PATH"] = previousPath;
      if (previousLocale === undefined) delete process.env["LC_ALL"]; else process.env["LC_ALL"] = previousLocale;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform !== "linux").each([
    ["node\0codex.js\0", true, false], ["node\0codex.js\0\0", true, true],
    ["node\0\0codex.js\0", false, false], ["node\0codex.js", false, false], ["", false, false],
  ] as const)("reads complete Linux NUL argv without dropping empty words %j", async (text, accepted, emptyLast) => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "fixture-title" } : row);
    const read = spyOn(fs, "readFileSync").mockImplementation(((path: fs.PathOrFileDescriptor) => {
      if (path === "/proc/30/cmdline") return text;
      throw new Error("unexpected host file read");
    }) as typeof fs.readFileSync);
    try {
      const found = await discoverTmux(info, "linux", async () => mapping, async () => rows, births);
      expect(found?.pid ?? null).toBe(accepted ? 30 : null);
      if (accepted) expect(found!.argv.at(-1) === "").toBe(emptyLast);
    } finally { read.mockRestore(); }
  });

  it.each(["node", "MainThread", "fixture-title"])("recognizes interpreter argv despite comm %s", async (command) => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command } : row);
    const found = await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      () => ["/usr/bin/node", "/fixture/codex.js", ""]);
    expect(found).toMatchObject({ pid: 30, argv: ["/usr/bin/node", "/fixture/codex.js", ""] });
    expect(found!.identity).not.toContain("/fixture/codex.js");
  });

  it.each([
    null, [], ["node", "", "codex.js"], ["node", "other.js", "codex.js"],
    ["node", "-e", "codex.js"], ["node", "--require=hook", "codex.js"],
    ["node", "--import", "codex.js"], ["sh", "-c", "codex.js"],
  ].map((argv) => [argv] as const))("refuses missing or non-script interpreter argv %j", async (argv) => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "node" } : row);
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births, () => argv)).toBeNull();
  });

  it("refuses interpreter argv or birth changing while it is observed", async () => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "node" } : row);
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      () => ["node", "codex.js", String(++reads)])).toBeNull();
    let generation = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows,
      (pid) => births(pid) + (pid === 30 ? generation : 0),
      () => { generation++; return ["node", "codex.js"]; })).toBeNull();
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      () => { throw new Error("denied"); })).toBeNull();
  });

  it("uses argv in an opaque binding key without exposing its values", async () => {
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "node" } : row);
    let argument = "fixture-argument-one";
    const read = () => tmuxCodexProcess(info, "darwin", async () => mapping, async () => rows, births,
      () => ["node", "/fixture/codex.js", argument]);
    const first = await read(); argument = "fixture-argument-two";
    const second = await read();
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(second!.identity).not.toBe(first!.identity);
    expect(first!.identity).not.toContain("fixture-argument-one");
    expect(second!.identity).not.toContain("fixture-argument-two");
  });

  it("keeps comm-only positives when argv is unreadable, but refuses two script candidates", async () => {
    expect((await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, births,
      () => { throw new Error("native must not read argv"); }))?.pid).toBe(30);
    const rows = processes.map((row) => row.pid === 30 ? { ...row, command: "node" } : row)
      .concat({ ...processes[3]!, pid: 31, command: "node" });
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      () => ["node", "codex.js"])).toBeNull();
  });

  it("retains native argv including remote/resume and revalidates it without exposing arguments", async () => {
    let argument = "--remote=fixture-endpoint";
    const read = () => tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, births,
      () => ["/opt/bin/codex", argument]);
    const first = await read();
    expect(first).toMatchObject({ argv: ["/opt/bin/codex", argument], argvRead: true });
    expect(first!.identity).not.toContain(argument);
    argument = "resume";
    expect((await read())!.identity).not.toBe(first!.identity);
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, births,
      () => ["codex", String(++reads)])).toBeNull();
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, births, () => null))
      .toMatchObject({ pid: 30, argvRead: false });
  });

  it.each([
    [["codex"], "local"], [["codex", "--profile", "e"], "local"],
    [["codex", "--remote=fixture"], "remote"], [["node", "other.js"], "rejected"],
    [["python3", "wrapper.py", "--remote", "unix:///fixture/codex.sock"], "rejected"],
    [["codex", "--", "--remote=fixture"], "local"],
    [null, "unavailable"],
  ] as const)("retains native argv evidence without weakening %j into comm-local proof", async (argv, state) => {
    const found = await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, births, () => argv);
    expect(found).not.toBeNull();
    expect(found!.argvState).toBe(state);
    expect(found!.argvRead).toBe(argv !== null);
    if (argv !== null) expect(found!.argv).toEqual([...argv]);
  });

  const outerInfo = { ...info, shell_pid: 8, foreground_processes: [
    { pid: 8, argv: ["/bin/sh", "-c", "fixture"] }, { pid: 9, argv: ["/bin/sh", "-c", "fixture"] },
    ...info.foreground_processes!,
  ] } as ProcessInfo;
  const outerRows: TerminalProcess[] = [
    ...wrapped.filter((row) => row.pid !== 10),
    { pid: 8, parent: 1, group: 8, foreground: 8, tty: "pts/1", command: "/bin/sh" },
    { pid: 9, parent: 8, group: 8, foreground: 8, tty: "pts/1", command: "/bin/sh" },
    { ...processes[0]!, parent: 9, group: 8, foreground: 8 },
  ];

  it("proves the complete outer shell chain before selecting its tmux attachment", async () => {
    expect(tmuxWrapper(outerInfo)).toBe(true);
    const found = await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows, births);
    expect(found).toMatchObject({ pid: 30, argv: ["/opt/bin/codex"] });
    expect(found!.identity).toContain("8:800");
    expect(found!.identity).toContain("9:900");
  });

  it.each([
    ["a sibling shell", [...outerRows, { ...outerRows.find((row) => row.pid === 9)!, pid: 12 }]],
    ["a foreign client parent", outerRows.map((row) => row.pid === 10 ? { ...row, parent: 99 } : row)],
    ["a missing shell", outerRows.filter((row) => row.pid !== 9)],
    ["a non-shell intermediary", outerRows.map((row) => row.pid === 9 ? { ...row, command: "node" } : row)],
    ["a cycle", outerRows.map((row) => row.pid === 9 ? { ...row, parent: 10 } : row)],
    ["another tty", outerRows.map((row) => row.pid === 9 ? { ...row, tty: "pts/8" } : row)],
    ["a background shell", outerRows.map((row) => row.pid === 9 ? { ...row, group: 99 } : row)],
  ])("refuses outer ancestry with %s", async (_name, rows) => {
    expect(await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => rows as TerminalProcess[], births)).toBeNull();
  });

  it.each([8, 9])("refuses missing/reused outer shell birth %s", async (changed) => {
    expect(await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows,
      (pid) => pid === changed ? null : births(pid))).toBeNull();
    let reads = 0;
    expect(await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows,
      (pid) => births(pid) + (pid === changed && ++reads > 1 ? 1 : 0))).toBeNull();
  });

  it("includes outer shell births in the binding across requests", async () => {
    let generation = 0;
    const read = () => tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows,
      (pid) => births(pid) + (pid === 9 ? generation : 0));
    const first = await read(); generation++;
    const second = await read();
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(second!.identity).not.toBe(first!.identity);
  });

  it("refuses an outer shell reparented between observations, which its parent's exit shows", async () => {
    let reads = 0;
    expect(await tmuxCodexProcess(outerInfo, "linux", async () => mapping, async () => outerRows,
      (pid) => pid === 8 && ++reads > 1 ? null : births(pid))).toBeNull();
  });

  it("refuses the same tmux pane when its shell takes the foreground back from Codex", async () => {
    let tables = 0;
    const suspended = processes.map((row) => row.tty === "pts/2" ? { ...row, foreground: 20 } : row);
    expect(await tmuxCodexProcess(info, "linux", async () => mapping,
      async () => ++tables === 1 ? processes : suspended, births)).toBeNull();
  });

  it("rejects stale reported membership, a missing root and multiple clients", async () => {
    for (const value of [
      { ...outerInfo, shell_pid: 99 },
      { ...outerInfo, foreground_processes: outerInfo.foreground_processes!.slice(1) },
      { ...outerInfo, foreground_processes: [...outerInfo.foreground_processes!, outerInfo.foreground_processes![0]!] },
      { ...outerInfo, foreground_processes: [...outerInfo.foreground_processes!, { pid: 12, argv: ["tmux", "attach"] }] },
    ]) expect(await tmuxCodexProcess(value as ProcessInfo, "linux", async () => mapping, async () => outerRows, births)).toBeNull();
    expect(tmuxWrapper({ ...outerInfo, foreground_processes: [...outerInfo.foreground_processes!, { pid: 12, argv: ["tmux", "attach"] }] } as ProcessInfo)).toBe(true);
  });

  const snapshot = (state: string, changed = 40, live = "S+") => parseTerminalProcesses([...wrapped,
    { pid: 40, parent: 30, group: 25, foreground: 25, tty: "pts/2", command: "chrome" },
  ].map((row) => `${row.pid} ${row.parent} ${row.group} ${row.foreground} ${row.tty} ${row.pid === changed ? state : live} ${row.command}`).join("\n"));

  it("ignores a zombie foreground peer while keeping live-state changes out of binding identity", async () => {
    let reads = 0;
    const found = await tmuxCodexProcess(info, "linux", async () => mapping,
      async () => ++reads === 1 ? snapshot("Z") : snapshot("Z+", 40, "R+"), births);
    expect(found).toMatchObject({ pid: 30, argv: ["/opt/bin/codex"] });
    expect(parseTerminalProcesses("30 25 25 25 pts/2 S+ /opt/bin/codex"))
      .toEqual(parseTerminalProcesses("30 25 25 25 pts/2 R+ /opt/bin/codex"));
  });

  it.each(["S", "R", "S+"])("still refuses a live %s foreground peer", async (state) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => snapshot(state), births)).toBeNull();
  });

  it.each([10, 20, 25, 30])("refuses zombie client/root/launcher/Codex PID %s", async (pid) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping,
      async () => snapshot("Z", pid).filter((row) => row.pid !== 40), births)).toBeNull();
  });

  it("parses Codex Linux/Darwin state columns separately from the unchanged Kiro parser", () => {
    expect(parseTerminalProcesses("30 20 30 30 pts/2 R+ /opt/bin/codex\n40 30 30 30 pts/2 Z chrome"))
      .toEqual([{ pid: 30, parent: 20, group: 30, foreground: 30, tty: "pts/2", command: "/opt/bin/codex" }]);
    expect(parseTerminalProcesses("30 20 30 30 ttys002 S+ codex\n40 30 30 30 ttys002 Z+ chrome"))
      .toEqual([{ pid: 30, parent: 20, group: 30, foreground: 30, tty: "ttys002", command: "codex" }]);
    expect(parseTerminalProcesses("malformed\n")).toEqual([]);
  });

  const nodeWrapped = wrapped.map((row) => row.pid === 25 ? { ...row, command: "MainThread" } : row);
  const launcherArgv = (pid: number) => pid === 25 ? ["/usr/bin/node", "/fixture/codex.js"] : null;

  it("proves a recognised Node Codex launcher and its one native child", async () => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => nodeWrapped, births, launcherArgv))
      .toMatchObject({ pid: 30 });
  });

  it.each([null, ["node", "other.js"], ["node", "-e", "codex.js"], ["bun", "codex.js"]].map((argv) => [argv] as const))
    ("refuses an unrecognised Node launcher %j", async (argv) => {
      expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => nodeWrapped, births, () => argv)).toBeNull();
    });

  it("refuses a Node launcher's changed argv or birth and includes its argv in later binding identity", async () => {
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => nodeWrapped, births,
      () => ["node", "codex.js", String(++reads)])).toBeNull();
    let generation = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => nodeWrapped,
      (pid) => births(pid) + (pid === 25 ? generation : 0), () => { generation++; return launcherArgv(25); })).toBeNull();
    let argument = "first";
    const read = () => tmuxCodexProcess(info, "linux", async () => mapping, async () => nodeWrapped, births,
      () => ["node", "codex.js", argument]);
    const first = await read(); argument = "second"; const second = await read();
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(first!.identity).not.toBe(second!.identity);
    expect(first!.identity).not.toContain("codex.js");
  });

  const tools: TerminalProcess[] = [
    ...wrapped,
    { pid: 40, parent: 30, group: 25, foreground: 25, tty: "pts/2", command: "node" },
    { pid: 41, parent: 40, group: 25, foreground: 25, tty: "pts/2", command: "rg" },
  ];
  const toolArgv = (pid: number) => pid === 40 ? ["node", "/fixture/mcp.js"] : ["/usr/bin/rg"];

  it("accepts verified Codex tool descendants without making their lifetimes the conversation identity", async () => {
    let generation = 0;
    const read = () => tmuxCodexProcess(info, "linux", async () => mapping, async () => tools,
      (pid) => births(pid) + (pid === 40 ? generation : 0), toolArgv);
    const first = await read(); generation++; const second = await read();
    expect(first).not.toBeNull(); expect(second).not.toBeNull();
    expect(first!.identity).toBe(second!.identity);
  });

  it.each([
    ["a sibling", tools.map((row) => row.pid === 40 ? { ...row, parent: 25 } : row)],
    ["a missing parent", tools.map((row) => row.pid === 40 ? { ...row, parent: 99 } : row)],
    ["a cycle", tools.map((row) => row.pid === 40 ? { ...row, parent: 41 } : row)],
    ["foreign foreground metadata", tools.map((row) => row.pid === 40 ? { ...row, foreground: 99 } : row)],
    ["another native Codex", tools.map((row) => row.pid === 40 ? { ...row, command: "codex" } : row)],
  ])("refuses tool ancestry with %s", async (_name, rows) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows as TerminalProcess[], births, toolArgv)).toBeNull();
  });

  it("refuses another interpreted Codex, unreadable argv and tool reuse during proof", async () => {
    for (const argv of [null, ["node", "codex.js"]]) {
      expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => tools, births, () => argv)).toBeNull();
    }
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => tools,
      (pid) => births(pid) + (pid === 40 && ++reads > 1 ? 1 : 0), toolArgv)).toBeNull();
  });

  it("accepts one foreground Codex through its pane root's foreground shell launcher", async () => {
    const found = await tmuxCodexProcess(info, "linux", async () => mapping, async () => wrapped, births);
    expect(found).toMatchObject({ pid: 30, argv: ["/opt/bin/codex"] });
    expect(found!.identity).toContain("25:2500");
  });

  it.each([
    ["an unrelated foreground shell", [...wrapped, { ...wrapped.at(-1)!, pid: 40 }]],
    ["two native Codex processes", [...wrapped, { ...wrapped.find((row) => row.pid === 30)!, pid: 31 }]],
    ["a missing shell ancestor", wrapped.filter((row) => row.pid !== 25)],
    ["a cyclic parent chain", wrapped.map((row) => row.pid === 25 ? { ...row, parent: 30 } : row)],
    ["a foreign shell ancestor", wrapped.map((row) => row.pid === 25 ? { ...row, parent: 99 } : row)],
    ["a non-shell launcher", wrapped.map((row) => row.pid === 25 ? { ...row, command: "/bin/node" } : row)],
    ["a background launcher", wrapped.map((row) => row.pid === 25 ? { ...row, group: 99 } : row)],
    ["a launcher on another tty", wrapped.map((row) => row.pid === 25 ? { ...row, tty: "pts/9" } : row)],
  ])("refuses wrapper ancestry with %s", async (_name, rows) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows as TerminalProcess[], births)).toBeNull();
  });

  // one table serves both observations: the births read after them show a launcher that exited, was reused, or was
  // reparented because the pane root above it exited
  it.each(["exit", "reparent", "reuse"])("refuses wrapper %s during verification", async (change) => {
    const changed = change === "reparent" ? 20 : 25;
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => wrapped,
      (pid) => pid !== changed || ++reads === 1 ? births(pid) : change === "reuse" ? births(pid) + 1 : null)).toBeNull();
  });

  it("changes the binding identity when a shell wrapper's birth changes between lookups", async () => {
    let generation = 0;
    const read = () => tmuxCodexProcess(info, "linux", async () => mapping, async () => wrapped,
      (pid) => births(pid) + (pid === 25 ? generation : 0));
    const before = await read();
    generation++;
    const after = await read();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!.identity).not.toBe(before!.identity);
  });

  it("follows the exact client's current pane, not its attach command's old target", async () => {
    const args: string[][] = [];
    const found = await tmuxCodexProcess(info, "linux", async (input) => { args.push(input); return mapping; }, async () => processes, births);
    expect(found).toMatchObject({ pid: 30, argv: ["/opt/bin/codex"] });
    expect(args).toEqual([["-S", "/fixture/tmux.sock"], ["-S", "/fixture/tmux.sock"]]);
    expect(found!.identity).toContain("$2:@3:%4");
  });

  it.each([
    ["a local TUI", 30, 30, ["codex"], "unix:///fixture/local.sock"],
    ["a nonlocal listener", 30, 30, ["codex", "--remote", "ws://127.0.0.1:1234"], "ws://127.0.0.1:1234"],
    ["the wrong socket", 30, 30, ["codex", "--remote", "unix:///fixture/local.sock"], "unix:///fixture/other.sock"],
    ["an unrelated process", 1, 30, ["codex", "--remote", "unix:///fixture/local.sock"], "unix:///fixture/local.sock"],
    ["inconsistent foreground metadata", 30, 99, ["codex", "--remote", "unix:///fixture/local.sock"], "unix:///fixture/local.sock"],
  ] as const)("refuses a foreground app server beside %s", async (_name, parent, foreground, tui, listen) => {
    const rows = [...processes, { pid: 31, parent, group: 30, foreground, tty: "pts/2", command: "codex" }];
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows, births,
      (pid) => pid === 30 ? tui : ["codex", "app-server", "--listen", listen])).toBeNull();
  });

  it.each([
    ["wrong client", mapping.replace(/^10\t/, "12\t")],
    ["wrong outer tty", mapping.replace("/dev/pts/1", "/dev/pts/8")],
    ["wrong socket", mapping.replace("/fixture/tmux.sock", "/other/tmux.sock")],
    ["duplicate client", mapping + mapping],
    ["control client", mapping.replace(/\t0\t0\n$/, "\t1\t0\n")],
    ["dead pane with reused PID and tty", mapping.replace(/\t0\n$/, "\t1\n")],
    ["missing pane liveness", mapping.replace(/\t0\n$/, "\n")],
    ["incomplete mapping", "10\t/dev/pts/1\n"],
  ])("rejects %s", async (_name, value) => {
    expect(await tmuxCodexProcess(info, "linux", async () => value, async () => processes, births)).toBeNull();
  });

  it.each(["%4", "@3", "$2", "/dev/pts/2"])("rejects a switched %s between reads", async (value) => {
    let reads = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => ++reads === 1 ? mapping : mapping.replace(value, value + "9"), async () => processes, births)).toBeNull();
  });

  it.each(["dead", "reparented"])("rejects a pane that becomes %s between reads", async (change) => {
    // a pane root is reparented only when its server exits
    let reads = 0, serverBirths = 0;
    expect(await tmuxCodexProcess(info, "linux",
      async () => ++reads > 1 && change === "dead" ? mapping.replace(/\t0\n$/, "\t1\n") : mapping,
      async () => processes,
      (pid) => change === "reparented" && pid === 11 && ++serverBirths > 1 ? null : births(pid))).toBeNull();
  });

  for (const argvMode of ["readable", "unreadable", "throwing"] as const) {
    const argv = () => {
      if (argvMode === "throwing") throw new Error("argv unavailable");
      return argvMode === "readable" ? ["/opt/bin/codex"] : null;
    };
    it(`rejects a native candidate's first unknown birth with ${argvMode} argv`, async () => {
      let reads = 0;
      expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes,
        (pid) => pid === 30 && ++reads === 1 ? null : births(pid), argv)).toBeNull();
    });
    it(`rejects a native candidate replaced after its first birth with ${argvMode} argv`, async () => {
      let reads = 0;
      expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes,
        (pid) => births(pid) + (pid === 30 && ++reads > 1 ? 1 : 0), argv)).toBeNull();
    });
    it(`retains a stable native candidate with ${argvMode} argv without inventing argv proof`, async () => {
      const found = await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, births, argv);
      expect(found).toMatchObject({ pid: 30, argvRead: argvMode === "readable" });
      if (argvMode !== "readable") expect(found!.argv).toEqual(["/opt/bin/codex"]);
    });
  }

  it.each([10, 11, 20, 30])("rejects PID %s reuse", async (reused) => {
    let count = 0;
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes,
      (pid) => births(pid) + (pid === reused && ++count > 1 ? 1 : 0))).toBeNull();
  });

  it.each([
    ["client no longer foreground", processes.map((row) => row.pid === 10 ? { ...row, foreground: 99 } : row)],
    ["wrong pane root", processes.filter((row) => row.pid !== 20)],
    ["pane root owned by another server", processes.map((row) => row.pid === 20 ? { ...row, parent: 99 } : row)],
    ["unrelated Codex", processes.map((row) => row.pid === 30 ? { ...row, parent: 99 } : row)],
    ["another foreground process", [...processes, { ...processes[3]!, pid: 31 }]],
    ["a shell only", processes.map((row) => row.pid === 30 ? { ...row, command: "/bin/bash" } : row)],
    ["wrong inner tty", processes.map((row) => row.pid === 30 ? { ...row, tty: "pts/9" } : row)],
  ])("rejects %s", async (_name, rows) => {
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => rows as TerminalProcess[], births)).toBeNull();
  });

  it("refuses inaccessible lookups and unknown births", async () => {
    expect(await tmuxCodexProcess(info, "linux", async () => { throw new Error("denied"); }, async () => processes, births)).toBeNull();
    expect(await tmuxCodexProcess(info, "linux", async () => mapping, async () => processes, () => null)).toBeNull();
  });

  it("recognizes unsupported tmux commands without querying their socket", async () => {
    let queries = 0;
    const read = async () => { queries++; return mapping; };
    for (const [argv, wrapped] of [
      [["codex"], false], [["zsh (kiro-cli-term)"], false], [["tmux", "-C", "attach"], true],
      [["tmux", "-S", "relative.sock", "attach"], true], [["tmux", "-f", "/dev/null", "attach"], true],
    ] as const) {
      const other: ProcessInfo = { pane_id: "fixture", foreground_processes: [{ pid: 10, name: argv[0], argv: [...argv] }] };
      expect(tmuxWrapper(other, "linux")).toBe(wrapped);
      expect(await tmuxCodexProcess(other, "linux", read)).toBeNull();
    }
    expect(await tmuxCodexProcess(info, "win32", read)).toBeNull();
    expect(queries).toBe(0);
  });
});
