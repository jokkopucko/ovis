import { expect, it } from "bun:test";
import type { ProcessInfo } from "./herdr/client.ts";
import { kiroCodexProcess, kiroNested, kiroWrapper, nestedCodex, parseTerminalProcesses, type TerminalProcess } from "./kiro-terminal.ts";

const info = { shell_pid: 10, foreground_processes: [{ pid: 10, argv: ["zsh (kiro-cli-term)"] }] } as ProcessInfo;
const table = () => parseTerminalProcesses(`
 10 1 10 10 ttys001 zsh (kiro-cli-term)
 20 10 20 30 ttys002 /bin/zsh
 30 20 30 30 ttys002 codex
 40 1 40 40 ttys003 codex
`);

it("selects only the known wrapper's nested foreground Codex", async () => {
  expect(nestedCodex(info, table())?.codex.pid).toBe(30);
  expect(await kiroCodexProcess(info, "darwin", async () => table(), () => 1)).toEqual({
    pid: 30, argv: ["codex"], identity: "10:1,20:1,30:1",
  });
});

it("changes the binding identity when any nested process is replaced between requests", async () => {
  const discover = (replaced?: number) => kiroCodexProcess(info, "darwin", async () => table(), (pid) => pid === replaced ? 2 : 1);
  const first = await discover();
  expect(first).not.toBeNull();
  expect(await discover()).toEqual(first);
  for (const pid of [10, 20, 30]) {
    const replacement = await discover(pid);
    expect(replacement).not.toBeNull();
    expect(replacement!.pid).toBe(first!.pid);
    expect(replacement!.identity).not.toBe(first!.identity);
  }
});

it("does not search normal shells or other platforms", async () => {
  let reads = 0;
  const read = async () => { reads++; return table(); };
  expect(await kiroCodexProcess(info, "linux", read)).toBeNull();
  expect(await kiroCodexProcess({ ...info, foreground_processes: [{ pid: 10, argv: ["/bin/zsh"] }] } as ProcessInfo,
    "darwin", read)).toBeNull();
  expect(reads).toBe(0);
});

it("rejects background agents, shared foreground groups, multiple shells, and deeper descendants", () => {
  const reject = (change: (rows: TerminalProcess[]) => void) => {
    const rows = table(); change(rows); expect(nestedCodex(info, rows)).toBeNull();
  };
  reject((rows) => { rows[1]!.foreground = 20; });
  reject((rows) => { rows[2]!.parent = 999; });
  reject((rows) => { rows[2]!.tty = "ttys001"; });
  reject((rows) => { rows[2]!.command = "echo codex"; });
  reject((rows) => { rows.push({ ...rows[1]!, pid: 21 }); });
  reject((rows) => { rows.push({ ...rows[2]!, pid: 31, command: "other" }); });
  reject((rows) => { rows[0]!.foreground = 99; });
});

it("rejects exits, topology changes, PID reuse, and incomplete reads", async () => {
  let reads = 0;
  expect(await kiroCodexProcess(info, "darwin", async () => ++reads === 1 ? table() : [], () => 1)).toBeNull();
  reads = 0;
  expect(await kiroCodexProcess(info, "darwin", async () => { reads++; return table(); },
    () => reads < 2 ? 1 : 2)).toBeNull();
  expect(await kiroCodexProcess(info, "darwin", async () => table(), () => null)).toBeNull();
  expect(await kiroCodexProcess(info, "darwin", async () => { throw new Error("timeout"); }, () => 1)).toBeNull();
  expect(parseTerminalProcesses("malformed\n")).toEqual([]);
});

it("reads herdr's wrapper fact on macOS only, and only for the wrapper herdr started", () => {
  expect(kiroWrapper(info, "darwin")).toBe(true);
  expect(kiroWrapper(info, "linux")).toBe(false);
  expect(kiroWrapper({ ...info, shell_pid: 11 } as ProcessInfo, "darwin")).toBe(false);
  expect(kiroWrapper({ ...info, foreground_processes: [{ pid: 10, argv: ["/bin/zsh"] }] } as ProcessInfo, "darwin")).toBe(false);
  expect(kiroWrapper(undefined, "darwin")).toBe(false);
});

it("tells a nested pane on macOS by the wrapper, or by missing process facts for a pane herdr does not label Codex", () => {
  expect(kiroNested(info, true, "darwin")).toBe(true);
  expect(kiroNested(undefined, false, "darwin")).toBe(true);
  // herdr labels it Codex, or another platform: a plain pane, as on main
  expect(kiroNested(undefined, true, "darwin")).toBe(false);
  expect(kiroNested(undefined, false, "linux")).toBe(false);
  expect(kiroNested(info, false, "linux")).toBe(false);
  expect(kiroNested({ shell_pid: 10, foreground_processes: [{ pid: 10, argv: ["/bin/zsh"] }] } as ProcessInfo, false, "darwin")).toBe(false);
});
