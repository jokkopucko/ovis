/** Read-only native Codex discovery through one verified local tmux attach client. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ProcessInfo } from "./herdr/client.ts";
import type { TerminalProcess } from "./kiro-terminal.ts";
import { processStartIdentity } from "./process-start.ts";
import { darwinArgv } from "./darwin-process.ts";
import { codexAppServerSocket, codexConversationMode, type CodexConversationMode, isCodexExecutable, isCodexInterpreter, optionValue } from "./codex-executable.ts";

const TMUX = /(?:^|\/)tmux$/;

function attachClient(client: { pid: number; argv?: readonly string[] | null }) {
  const argv = client.argv ?? [];
  if (!TMUX.test(argv[0] ?? "")) return null;
  const args: string[] = [];
  let socket: string | null = null;
  let at = 1;
  while (argv[at]?.startsWith("-")) {
    const flag = argv[at++];
    if (flag === "-u" || flag === "-2") continue;
    if ((flag !== "-S" && flag !== "-L") || args.length > 0) return null;
    const value = argv[at++];
    if (!value || /[\r\n\t]/.test(value) || (flag === "-S" && !isAbsolute(value))) return null;
    args.push(flag, value);
    if (flag === "-S") socket = value;
  }
  if (!/^(?:attach-session|attach|at|a)$/.test(argv[at] ?? "")) return null;
  return { pid: client.pid, args, socket };
}

export function tmuxWrapper(info: ProcessInfo | undefined, platform = process.platform): boolean {
  return (platform === "linux" || platform === "darwin")
    && (info?.foreground_processes ?? []).some(({ argv, name }) => TMUX.test(argv?.[0] ?? (name ?? "").replace(/: client$/, "")));
}

const FORMAT = "#{client_pid}\t#{client_tty}\t#{pid}\t#{socket_path}\t#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{client_control_mode}\t#{pane_dead}";
const exec = promisify(execFile);
async function run(args: readonly string[]): Promise<string> {
  // Neither the bridge's own TMUX nor the attach command's old -t selects the client's current pane.
  const env = { ...process.env };
  delete env["TMUX"]; delete env["TMUX_PANE"];
  // Non-UTF8 clients sanitize tabs and non-ASCII pane text to underscores.
  return (await exec("tmux", ["-u", ...args], { env, timeout: 2000, maxBuffer: 2 * 1024 * 1024 })).stdout;
}
const clients = (args: string[]) => run([...args, "list-clients", "-F", FORMAT]);

/** Codex's process proof ignores exited zombies without changing Kiro's reader. */
export function parseTerminalProcesses(text: string): TerminalProcess[] {
  return text.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    return match && !match[6]!.startsWith("Z") ? [{ pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]),
      foreground: Number(match[4]), tty: match[5]!, command: match[7]!.trim() }] : [];
  });
}

export async function processTable(): Promise<TerminalProcess[]> {
  const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,tty=,stat=,comm="],
    { timeout: 2000, maxBuffer: 2 * 1024 * 1024 });
  return parseTerminalProcesses(stdout);
}

const tty = (value: string) => value.replace(/^\/dev\//, "");
const pid = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const SHELL = /(?:^|\/)(?:sh|bash|dash|zsh)$/;

export function codexProcessArgv(pid: number): string[] | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "darwin") return darwinArgv(pid);
    if (process.platform !== "linux") return null;
    const text = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    if (!text.endsWith("\0")) return null;
    const words = text.split("\0");
    words.pop();
    return words.length > 0 && words[0] !== "" ? words : null;
  } catch { return null; }
}

/** Only the exact client's active pane and its one foreground native Codex, never a session-name guess. */
export async function tmuxCodexProcess(info: ProcessInfo | undefined, platform = process.platform,
  readClients = clients, readProcesses = processTable, birth = processStartIdentity,
  readArgv: (pid: number) => readonly string[] | null = codexProcessArgv,
): Promise<{ pid: number; argv: string[]; identity: string; argvRead: boolean; argvState: CodexConversationMode } | null> {
  const reported = info?.foreground_processes ?? [];
  const attachments = reported.map(attachClient).filter((client) => client !== null);
  if (!tmuxWrapper(info, platform) || attachments.length !== 1) return null;
  const client = attachments[0]!;
  try {
    const clientBirth = birth(client.pid);
    if (clientBirth === null) return null;
    const observe = async () => {
      const text = await readClients(client.args);
      const lines = text.trimEnd().split("\n").map((line) => line.split("\t"));
      const matches = lines.filter((fields) => fields[0] === String(client.pid));
      if (matches.length !== 1) return null;
      const fields = matches[0]!;
      const [clientPid, clientTty, serverPid, socket, session, window, pane, panePid, paneTty, control, dead] = fields;
      if (fields.length !== 11 || dead !== "0" || !pid(clientPid!) || !pid(serverPid!) || !pid(panePid!)
        || !isAbsolute(socket!) || (client.socket !== null && resolve(socket!) !== resolve(client.socket))
        || !/^\$\d+$/.test(session!) || !/^@\d+$/.test(window!) || !/^%\d+$/.test(pane!) || control !== "0"
        || !clientTty?.startsWith("/dev/") || !paneTty?.startsWith("/dev/") || clientTty === paneTty) return null;
      // A client can keep the same pane while the shell takes back its foreground group.
      const rows = await readProcesses();
      const outer = rows.find((row) => row.pid === client.pid);
      const root = rows.find((row) => row.pid === Number(panePid));
      // Remain-on-exit keeps a dead pane's PID/TTY; only its live server-owned child is proof.
      if (!outer || outer.group !== outer.foreground || tty(outer.tty) !== tty(clientTty)
        || !root || root.parent !== Number(serverPid) || tty(root.tty) !== tty(paneTty)) return null;
      const outerChain = [outer];
      const expected = new Set(reported.map((process) => process.pid));
      if (expected.size !== reported.length) return null;
      if (reported.length > 1) {
        const shellPid = info?.shell_pid;
        if (shellPid === undefined || shellPid === null || !expected.has(shellPid)) return null;
        const seen = new Set([outer.pid]);
        while (outerChain.at(-1)!.pid !== shellPid) {
          const parent = rows.find((row) => row.pid === outerChain.at(-1)!.parent);
          if (!parent || seen.has(parent.pid) || !SHELL.test(parent.command)
            || tty(parent.tty) !== tty(clientTty) || parent.group !== outer.group
            || parent.foreground !== outer.foreground) return null;
          seen.add(parent.pid);
          outerChain.push(parent);
        }
      }
      // The reported and kernel foreground must both be exactly this chain, never filtered siblings.
      const outerForeground = rows.filter((row) => tty(row.tty) === tty(clientTty) && row.group === outer.group);
      if (outerForeground.length !== expected.size || outerChain.length !== expected.size
        || outerForeground.some((row) => !expected.has(row.pid) || !outerChain.includes(row))) return null;
      const foreground = rows.filter((row) => tty(row.tty) === tty(paneTty) && row.group === root.foreground);
      const candidates: { row: TerminalProcess; argv: string[]; argvBirth: number | null; argvRead: boolean; candidateBirth: number | null; argvState: CodexConversationMode }[] = foreground
        .filter((row) => /(?:^|\/)codex(?:-(?:x86_64|aarch64)-[a-z0-9_-]+)?$/.test(row.command))
        .map((row) => {
          const before = birth(row.pid);
          let argv: readonly string[] | null = null;
          try { argv = readArgv(row.pid); } catch { /* comm still identifies the attachment, never its local conversation mode */ }
          const readable = before !== null && argv !== null && birth(row.pid) === before;
          return { row, argv: argv === null ? [row.command] : [...argv], argvBirth: readable ? before : null,
            argvRead: readable, candidateBirth: before, argvState: codexConversationMode(readable ? argv : null) };
        })
        .filter(({ argv, argvRead }) => !argvRead || codexAppServerSocket(argv) === null);
      // Existing native proof stays first; interpreter argv is evidence only for the script fallback.
      if (candidates.length === 0) for (const row of foreground) {
        const before = birth(row.pid);
        if (before === null) return null;
        const argv = readArgv(row.pid);
        if (argv === null || birth(row.pid) !== before) return null;
        // comm is mutable (Node may name its main thread); the kernel's argv names the interpreter.
        if (isCodexInterpreter(argv[0] ?? "") && isCodexExecutable(argv)) candidates.push({ row, argv: [...argv], argvBirth: before, argvRead: true, candidateBirth: before, argvState: codexConversationMode(argv) });
      }
      // Non-interactive launchers can leave their app server in the TUI's foreground group.
      // Only a child or sibling listening on this TUI's named local socket can be that peer.
      const [selected] = candidates;
      if (candidates.length !== 1 || selected === undefined) return null;
      const codex = selected.row;
      const remote = selected.argvState === "remote" ? optionValue(selected.argv, "--remote") : null;
      if (codex.group !== codex.foreground) return null;
      const chain: TerminalProcess[] = [codex];
      const argvProofs = new Map<number, { pid: number; birth: number; key: string }>();
      const checkedArgv = (row: TerminalProcess) => {
        const before = birth(row.pid);
        if (before === null) return null;
        const argv = readArgv(row.pid);
        if (argv === null || birth(row.pid) !== before) return null;
        argvProofs.set(row.pid, { pid: row.pid, birth: before,
          key: createHash("sha256").update(JSON.stringify(argv)).digest("hex") });
        return argv;
      };
      const seen = new Set([codex.pid]);
      while (chain.at(-1)!.pid !== root.pid) {
        const parent = rows.find((row) => row.pid === chain.at(-1)!.parent);
        if (!parent || seen.has(parent.pid) || tty(parent.tty) !== tty(paneTty)
          || (parent.pid !== root.pid && (parent.group !== root.foreground || parent.foreground !== root.foreground))) return null;
        if (!SHELL.test(parent.command)) {
          // npm's recognised Node launcher may keep its native Codex child instead of execve-ing it.
          if (chain.length !== 1 || !/(?:^|\/)codex(?:-(?:x86_64|aarch64)-[a-z0-9_-]+)?$/.test(codex.command)) return null;
          const argv = checkedArgv(parent);
          if (argv === null || !/(?:^|\/)node$/.test(argv[0] ?? "") || !isCodexExecutable(argv)) return null;
        }
        seen.add(parent.pid);
        chain.push(parent);
      }
      // Apart from its own app server, only verified non-Codex descendants may share the job.
      const auxiliary = foreground.filter((row) => !chain.includes(row));
      for (const row of auxiliary) {
        if (row.foreground === root.foreground && remote?.startsWith("unix:///") && (row.parent === codex.pid || row.parent === codex.parent)
          && codexAppServerSocket(checkedArgv(row) ?? []) === remote) continue;
        const visited = new Set<number>();
        let current = row;
        while (current.pid !== codex.pid) {
          if (visited.has(current.pid) || !foreground.includes(current) || current.foreground !== root.foreground) return null;
          visited.add(current.pid);
          const argv = checkedArgv(current);
          if (argv === null || isCodexExecutable(argv)) return null;
          const parent = foreground.find((candidate) => candidate.pid === current.parent);
          if (parent === undefined) return null;
          current = parent;
        }
      }
      const server = Number(serverPid);
      const serverBirth = birth(server);
      const outerBirths = outerChain.map((row) => birth(row.pid));
      const chainBirths = chain.map((row) => birth(row.pid));
      if (serverBirth === null || [...outerBirths, ...chainBirths].some((value) => value === null)
        || selected.candidateBirth === null || chainBirths[0] !== selected.candidateBirth) return null;
      return { fields, outerChain, chain, argvProofs: [...argvProofs.values()], codex, server, serverBirth, outerBirths, chainBirths,
        argv: selected.argv, argvBirth: selected.argvBirth, argvRead: selected.argvRead, argvState: selected.argvState };
    };
    const first = await observe();
    if (first === null) return null;
    const second = await observe();
    const { serverBirth, outerBirths, chainBirths } = first;
    if (second === null || JSON.stringify(first) !== JSON.stringify(second)
      || birth(client.pid) !== clientBirth || birth(first.server) !== serverBirth
      || first.outerChain.some((row, index) => birth(row.pid) !== outerBirths[index])
      || first.chain.some((row, index) => birth(row.pid) !== chainBirths[index])
      || first.argvProofs.some((proof) => birth(proof.pid) !== proof.birth)) return null;
    const argvKey = first.argvBirth === null ? "" : `:${createHash("sha256").update(JSON.stringify(first.argv)).digest("hex")}`;
    const identity = `${first.fields.join(":")}:${clientBirth}:${serverBirth}:${first.outerChain.map((row, index) => `${row.pid}:${outerBirths[index]}`).join(",")}:${first.chain.map((row, index) => `${row.pid}:${chainBirths[index]}`).join(",")}${argvKey}`;
    const launchers = first.argvProofs.filter((proof) => first.chain.some((row) => row.pid === proof.pid));
    const launcherKey = launchers.length ? `:${JSON.stringify(launchers)}` : "";
    return { pid: first.codex.pid, argv: first.argv, identity: identity + launcherKey, argvRead: first.argvRead, argvState: first.argvState };
  } catch { return null; }
}
