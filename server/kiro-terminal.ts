/** Read-only Codex discovery behind Kiro's macOS shell-integration PTY. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProcessInfo } from "./herdr/client.ts";
import { processStartedAt } from "./process-start.ts";

export interface TerminalProcess {
  pid: number; parent: number; group: number; foreground: number; tty: string; command: string;
}

function wrapperPid(info: ProcessInfo | undefined): number | null {
  const processes = info?.foreground_processes ?? [];
  const wrapper = processes.length === 1 ? processes[0] : undefined;
  return wrapper?.pid === info?.shell_pid && wrapper?.argv?.length === 1
    && wrapper.argv[0] === "zsh (kiro-cli-term)" ? wrapper.pid : null;
}

/**
 * Whether herdr reports Kiro's shell-integration wrapper as the pane's one foreground process, on macOS:
 * a fact of herdr's own, so the pane stays a nested terminal while a process-table probe fails or races.
 */
export function kiroWrapper(info: ProcessInfo | undefined, platform = process.platform): boolean {
  // the nested Codex behind it is proven on macOS alone: elsewhere the pane stays a plain one
  return platform === "darwin" && wrapperPid(info) !== null;
}

/**
 * Whether a Codex pane is a nested terminal, on macOS: herdr reports Kiro's wrapper (kiroWrapper), or
 * herdr's process facts are missing for a pane it does not label Codex, whose Codex was then inferred
 * (a wrapper's, or its probe would have found none). Elsewhere a pane is never nested.
 */
export function kiroNested(info: ProcessInfo | undefined, labelled: boolean, platform = process.platform): boolean {
  return platform === "darwin" && (wrapperPid(info) !== null || (info === undefined && !labelled));
}

export function parseTerminalProcesses(text: string): TerminalProcess[] {
  return text.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]),
      foreground: Number(match[4]), tty: match[5]!, command: match[6]!.trim() }] : [];
  });
}

/** Only the wrapper's one direct shell and its one foreground Codex, never arbitrary descendants. */
export function nestedCodex(info: ProcessInfo | undefined, rows: readonly TerminalProcess[]): { shell: TerminalProcess; codex: TerminalProcess } | null {
  const pid = wrapperPid(info);
  if (pid === null) return null;
  const wrapper = rows.find((row) => row.pid === pid);
  if (!wrapper || wrapper.command !== "zsh (kiro-cli-term)" || wrapper.group !== wrapper.foreground) return null;
  const children = rows.filter((row) => row.parent === pid);
  if (children.length !== 1) return null;
  const shell = children[0]!;
  if (!/^\/(?:bin|usr\/bin)\/(?:zsh|bash|sh)$/.test(shell.command)
    || !/^ttys\d+$/.test(shell.tty) || shell.tty === wrapper.tty) return null;
  const foreground = rows.filter((row) => row.tty === shell.tty && row.group === shell.foreground);
  const candidates = foreground.filter((row) => row.parent === shell.pid && /(?:^|\/)codex$/.test(row.command));
  if (candidates.length !== 1) return null;
  const codex = candidates[0]!;
  if (codex.group !== codex.foreground || foreground.some((row) => row.pid !== codex.pid)) return null;
  return { shell, codex };
}

const exec = promisify(execFile);
async function processTable(): Promise<TerminalProcess[]> {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,tty=,comm="],
    { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
  return parseTerminalProcesses(stdout);
}

/** Verify both reads; retain process births so later requests cannot reuse a replaced process's binding. */
export async function kiroCodexProcess(info: ProcessInfo | undefined, platform = process.platform,
  read = processTable, birth = processStartedAt): Promise<{ pid: number; argv: string[]; identity: string } | null> {
  const pid = wrapperPid(info);
  if (platform !== "darwin" || pid === null) return null;
  try {
    const wrapperBirth = birth(pid);
    if (wrapperBirth === null) return null;
    const began = Date.now();
    const first = nestedCodex(info, await read());
    if (first === null) return null;
    const shellBirth = birth(first.shell.pid), codexBirth = birth(first.codex.pid);
    if (shellBirth === null || codexBirth === null || shellBirth > began || codexBirth > began) return null;
    const second = nestedCodex(info, await read());
    if (second === null || JSON.stringify(first) !== JSON.stringify(second)
      || birth(pid) !== wrapperBirth || birth(first.shell.pid) !== shellBirth || birth(first.codex.pid) !== codexBirth) return null;
    const identity = `${pid}:${wrapperBirth},${first.shell.pid}:${shellBirth},${first.codex.pid}:${codexBirth}`;
    return { pid: first.codex.pid, argv: [first.codex.command], identity };
  } catch { return null; }
}
