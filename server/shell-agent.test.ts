import { afterEach, expect, it, jest, mock, spyOn } from "bun:test";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as client from "./herdr/client.ts";
import { isGjcProcess } from "./gjc-runtime.ts";
import { catalogLocator } from "./agent-catalog-detect.ts";
import { agentPathProbe, loginPathProbe, paneShell, parseLoginPath, powershellNativeArgs, shellAgentExecutable, ShellAgentLocator, shellCommandLine, startShellAgent, type LoginPathProbe, type LoginPathResult } from "./shell-agent.ts";
import { descendantArgv, descendantProcesses, parseProcessTable, windowsArgv, windowsProcessTable } from "./windows-processes.ts";

it("tells a pane's shell from the program herdr reports in front", () => {
  expect(paneShell("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
  expect(paneShell("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
  expect(paneShell("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
  expect(paneShell("/bin/zsh")).toBe("posix");
});

it("writes the line each shell runs as a command, not as a string", () => {
  const exe = "C:\\Users\\o'brien\\AppData\\Local\\gjc\\gjc.exe";
  expect(shellCommandLine("powershell", exe, ["--resume", "a b"])).toBe("& 'C:\\Users\\o''brien\\AppData\\Local\\gjc\\gjc.exe' '--resume' 'a b'");
  expect(shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["a b"])).toBe('"C:\\gjc\\gjc.exe" "a b"');
  expect(shellCommandLine("posix", "/usr/local/bin/gjc", ["it's"])).toBe("'/usr/local/bin/gjc' 'it'\\''s'");
  // a trailing backslash must not escape the closing quote for the program that parses it
  expect(shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["C:\\work\\", "--resume"])).toBe('"C:\\gjc\\gjc.exe" "C:\\work\\\\" "--resume"');
  // cmd cannot carry these inside quotes
  expect(() => shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ["%PATH%"])).toThrow();
  expect(() => shellCommandLine("cmd", "C:\\gjc\\gjc.exe", ['say "hi"'])).toThrow();
});

it("gives a native program its arguments through Windows PowerShell 5.1 as they were, and none 5.1 would split or PowerShell 7 might change", () => {
  // each as it arrived intact at node.exe from 5.1.26100 (live-verified)
  expect(powershellNativeArgs("powershell", ['say "hi"', "", "C:\\dir with space\\", "trail\\", "x y\\\\", 'a\\"b', "it's", "a\u00a0b\\", "a\ufeffb\\"])).toEqual([
    // 5.1 escapes no quote for the program's own parser, and drops an empty argument
    'say \\"hi\\"',
    '""',
    // the backslash ending an argument 5.1 quotes would escape the quote it closes it with; unquoted, it is read as it is
    "C:\\dir with space\\\\",
    "trail\\",
    "x y\\\\\\\\",
    // the backslashes before a quote are doubled, and one more escapes it
    'a\\\\\\"b',
    "it's",
    // 5.1 quotes for what .NET calls whitespace: a no-break space, not a byte-order mark
    "a\u00a0b\\\\",
    "a\ufeffb\\",
  ]);
  expect(shellCommandLine("powershell", "codex", powershellNativeArgs("powershell", ["--", 'fix the "x" bug']))).toBe(`& 'codex' '--' 'fix the \\"x\\" bug'`);
  // 5.1 counts the escaped quotes too: whitespace only after an odd number of them goes unquoted, and the argument arrives split
  for (const arg of ['"fix the bug"', 'x="a b"', 'a"b c']) expect(() => powershellNativeArgs("powershell", [arg])).toThrow();
  // one whitespace after an even number of them is enough for 5.1 to quote it
  expect(powershellNativeArgs("powershell", ['"a b" c', 'say "hi"'])).toEqual(['\\"a b\\" c', 'say \\"hi\\"']);
  // PowerShell 7 escapes them itself from 7.3, and passes them as 5.1 does before that
  expect(powershellNativeArgs("pwsh", ["--model", "a b", "trail\\", "it's"])).toEqual(["--model", "a b", "trail\\", "it's"]);
  for (const arg of ['say "hi"', "", "C:\\dir with space\\"]) expect(() => powershellNativeArgs("pwsh", [arg])).toThrow();
  // cmd reads an agent's arguments again when PowerShell finds it as a .cmd file: `&` there runs the rest
  for (const program of ["powershell", "pwsh"] as const) {
    // and inside its quotes too: % and !NAME! expand, and a shim's `call` doubles a ^
    for (const arg of ['fix "a&echo ran&b" now', "a&b", "x|y", "a<b", "a>b", "^caret", "%PATH%", "a b %OS%", "a & !OS!", "up ^ caret"]) expect(() => powershellNativeArgs(program, [arg])).toThrow();
    // unless PowerShell puts it in quotes, for a space, where cmd reads & | < > as text
    // (live-verified, 5.1.26100 and 7.6 to an npm-style .cmd shim): a profile folder named R&D (#3084)
    const settings = "C:\\Users\\R&D\\AppData\\Local\\ovis\\claude settings\\a.json";
    const quoted = [settings, "fix A & B", "x | y", "a < b > c"];
    expect(powershellNativeArgs(program, quoted)).toEqual(quoted);
    // but a `"` in any argument of the line toggles cmd's quotes, which run across arguments, and so
    // does a `!Q!` delayed expansion turns into one (#3092)
    for (const args of [['x"', "a & calc & rem"], ['"', " & echo INJECTED & rem "], ["--append-system-prompt", 'a 12" screen', "--settings", settings], ["!Q!", "a & calc & rem"]]) {
      expect(() => powershellNativeArgs(program, args)).toThrow();
    }
  }
});

it("recognizes gjc as Windows reports it", () => {
  expect(isGjcProcess(["C:\\Users\\devsw\\AppData\\Local\\gjc\\gjc.exe"])).toBe(true);
  expect(isGjcProcess(["C:\\Program Files\\nodejs\\node.exe", "C:\\tools\\gjc\\dist\\gjc.mjs"])).toBe(true);
  expect(isGjcProcess(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoExit"])).toBe(false);
  expect(isGjcProcess(["C:\\tools\\gjc-helper.exe"])).toBe(false);
});

it("finds what runs under a pane's shell in the process table", () => {
  // the table as PowerShell prints it; rows from a Windows PC with gjc running in a pane
  const table = parseProcessTable(JSON.stringify([
    { ProcessId: 41948, ParentProcessId: 26540, ExecutablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", CommandLine: "powershell.exe -NoExit" },
    { ProcessId: 12156, ParentProcessId: 41948, ExecutablePath: "C:\\Users\\devsw\\AppData\\Local\\gjc\\gjc.exe", CommandLine: '"C:\\Users\\devsw\\AppData\\Local\\gjc\\gjc.exe"' },
    { ProcessId: 700, ParentProcessId: 12156, ExecutablePath: null, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\x y\\tool.js" --flag' },
    { ProcessId: 9, ParentProcessId: 4, ExecutablePath: "C:\\other\\gjc.exe", CommandLine: "gjc.exe" },
    { ProcessId: "bad" },
  ]));
  const under = descendantArgv(table, 41948);
  expect(under).toEqual([
    ["C:\\Users\\devsw\\AppData\\Local\\gjc\\gjc.exe"],
    ["C:\\Program Files\\nodejs\\node.exe", "C:\\x y\\tool.js", "--flag"],
  ]);
  expect(under.some(isGjcProcess)).toBe(true);
  expect(descendantProcesses(table, 41948).map((entry) => entry.pid)).toEqual([12156, 700]);
  // Windows keeps a dead parent's number on its children: one that started before the process now
  // holding that number is not its child, and nor is anything below it
  const reused = [
    { pid: 50, parent: 0, path: null, commandLine: "shell", started: 1000 },
    { pid: 51, parent: 50, path: null, commandLine: "child", started: 1001 },
    { pid: 52, parent: 50, path: null, commandLine: "stray", started: 10 },
    { pid: 53, parent: 52, path: null, commandLine: "under stray", started: 20 },
    { pid: 54, parent: 50, path: null, commandLine: "no start" },
  ];
  expect(descendantProcesses(reused, 50).map((entry) => entry.pid)).toEqual([51, 54]);
  expect(descendantArgv(table, 26540).length).toBe(3);
  expect(descendantArgv(table, 4242)).toEqual([]);
  expect(parseProcessTable("not json")).toEqual([]);
  // the process's start, as the table script reads it (ms since 1970), comes along when present
  expect(parseProcessTable(JSON.stringify({ ProcessId: 2, ParentProcessId: 1, ExecutablePath: null, CommandLine: "x", Started: 1790886000123 }))).toEqual([{ pid: 2, parent: 1, path: null, commandLine: "x", started: 1790886000123 }]);
  expect(windowsArgv('"C:\\a b\\x.exe" one "two three"')).toEqual(["C:\\a b\\x.exe", "one", "two three"]);
});

it("gives up on a process-table query that stalls, and kills it", async () => {
  const started = Date.now();
  expect(await windowsProcessTable(200, ["sleep", "30"])).toEqual([]);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(await windowsProcessTable(5000, ["printf", '[{"ProcessId":2,"ParentProcessId":1,"ExecutablePath":null,"CommandLine":"x"}]'])).toEqual([{ pid: 2, parent: 1, path: null, commandLine: "x" }]);
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(profile = "echo 'Welcome to the fixture shell'") {
  const root = mkdtempSync(join(tmpdir(), "ovis-shell-agent-path-"));
  roots.push(root);
  const home = join(root, "home"), serviceBin = join(root, "service bin"), loginBin = join(root, "login bin");
  for (const dir of [home, serviceBin, loginBin]) mkdirSync(dir);
  const gjc = join(loginBin, "gjc");
  writeFileSync(gjc, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const shell = join(root, "login-shell");
  writeFileSync(shell, [
    "#!/bin/sh",
    `if [ "$1" = "-l" ]; then PATH='${loginBin}:/usr/bin:/bin'; export PATH; shift; ${profile}; fi`,
    '[ "$1" = "-c" ] && exec /bin/sh -c "$2"',
    "exit 64",
    "",
  ].join("\n"), { mode: 0o755 });
  const env = { HOME: home, PATH: serviceBin };
  const servicePath = () => `${serviceBin}:/nonexistent`;
  return { root, home, serviceBin, loginBin, gjc, shell, env, servicePath };
}

function counted(probe: LoginPathProbe): { probe: LoginPathProbe; runs: () => number } {
  let runs = 0;
  return { probe: (signal) => { runs += 1; return probe(signal); }, runs: () => runs };
}

function manual() {
  let answer: (result: LoginPathResult) => void = () => { throw new Error("no run is waiting"); };
  const { probe, runs } = counted(() => new Promise((resolve) => { answer = resolve; }));
  return { probe, runs, found: (path: string) => answer({ path }), missed: (reason: string) => answer({ path: null, reason }) };
}

const once = (probe: LoginPathProbe): Promise<LoginPathResult> => probe(new AbortController().signal);

/** Whether `pid` still runs; a zombie waiting for its new parent to reap it does not. */
async function running(pid: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch { return false; }
  const state = (await Bun.$`ps -o stat= -p ${pid}`.nothrow().text()).trim();
  return state !== "" && !state.startsWith("Z");
}

/**
 * What a fixture shell writes into `file`, made here as a FIFO before the shell starts: the read
 * ends when the shell has written and closed it. Not a watched file: a PC near its inotify instance
 * limit (every agent's file watchers count) refuses fs.watch with EMFILE. Bounded, so a shell that
 * never writes fails the test; the bound opens the write end itself, which ends the pending read.
 */
function fifo(file: string, timeoutMs = 5000): Promise<string> {
  if (Bun.spawnSync(["mkfifo", file]).exitCode !== 0) throw new Error(`mkfifo ${file} failed`);
  const text = readFile(file, "utf8");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // ENXIO: the read had not opened the FIFO yet, so there is nothing to end
      try { closeSync(openSync(file, constants.O_WRONLY | constants.O_NONBLOCK)); } catch { /* no reader yet */ }
      reject(new Error(`${file} was not written`));
    }, timeoutMs);
  });
  return Promise.race([text.then((said) => said.trim()), deadline]).finally(() => clearTimeout(timer));
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); })]).finally(() => clearTimeout(timer));
}

it("reads the login PATH between its markers, whatever the profile prints around them", () => {
  expect(parseLoginPath("motd\n__OVIS_LOGIN_PATH__\n/a:/b\n__OVIS_LOGIN_PATH_END__\nbye\n")).toBe("/a:/b");
  expect(parseLoginPath("/a:/b\n")).toBeNull();
  expect(parseLoginPath("__OVIS_LOGIN_PATH__\n/a\nno end\n")).toBeNull();
  expect(parseLoginPath("__OVIS_LOGIN_PATH__\n\n__OVIS_LOGIN_PATH_END__\n")).toBeNull();
});

/**
 * A login shell that also takes `-i`, as zsh does: `-l` sets the login PATH, `-i` runs `rc` (a
 * .zshrc) and puts gjc's folder in front of it.
 */
function rcFixture(rc = ":") {
  const f = fixture();
  const rcBin = join(f.root, "rc bin");
  mkdirSync(rcBin);
  const gjc = join(rcBin, "gjc");
  writeFileSync(gjc, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  unlinkSync(f.gjc);
  const shell = join(f.root, "interactive-shell");
  writeFileSync(shell, [
    "#!/bin/sh",
    "PATH=/usr/bin:/bin",
    'while :; do case "$1" in -l) PATH="' + f.loginBin + ':$PATH"; shift;; -i) ' + rc + '; PATH="' + rcBin + ':$PATH"; shift;; *) break;; esac; done',
    "export PATH",
    '[ "$1" = "-c" ] && exec /bin/sh -c "$2"',
    "exit 64",
    "",
  ].join("\n"), { mode: 0o755 });
  return { ...f, rcBin, gjc, shell };
}

it("finds an agent a pane's interactive shell puts on PATH (zsh's .zshrc), and keeps the login PATH where that shell gives none", async () => {
  const f = rcFixture();
  // the login shell alone misses it: what hid Claude Code from the desktop app's agent list on a Mac
  expect(await new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe: loginPathProbe({ shell: f.shell, env: f.env }) }).executable("gjc")).toBeNull();
  expect(await once(agentPathProbe({ shell: f.shell, env: f.env }))).toEqual({ path: `${f.rcBin}:${f.loginBin}:/usr/bin:/bin` });
  expect(await new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe: agentPathProbe({ shell: f.shell, env: f.env }) }).executable("gjc")).toBe(f.gjc);
  const plain = fixture();
  expect(await once(agentPathProbe({ shell: plain.shell, env: plain.env }))).toEqual({ path: `${plain.loginBin}:/usr/bin:/bin` });
  const failing = fixture("exit 3");
  const failed = await once(agentPathProbe({ shell: failing.shell, env: failing.env }));
  expect(failed.path).toBeNull();
  expect(failed.path === null && failed.reason).toContain("exit 3");
});

it("runs the interactive shell once until asked to read it again, with the marker a profile can skip on", async () => {
  const f = rcFixture('echo "x$OVIS_PATH_PROBE" >> "$HOME/rc-runs"');
  const runs = () => existsSync(join(f.home, "rc-runs")) ? readFileSync(join(f.home, "rc-runs"), "utf8").split("\n").filter(Boolean) : [];
  const probe = agentPathProbe({ shell: f.shell, env: f.env, rereadGapMs: 0 });
  await Promise.all([once(probe), once(probe)]);
  expect(await once(probe)).toEqual({ path: `${f.rcBin}:${f.loginBin}:/usr/bin:/bin` });
  expect(runs()).toEqual(["x1"]);
  probe.reread();
  await once(probe);
  expect(runs()).toEqual(["x1", "x1"]);
  let clock = 0;
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe, now: () => clock });
  await locator.executable("gjc");
  clock += 120_000;
  await locator.executable("omo");
  expect(runs()).toHaveLength(2);
  await locator.refresh(false);
  expect(runs()).toHaveLength(2);
  await locator.refresh();
  expect(runs()).toHaveLength(3);
  const locate = catalogLocator({ probe, servicePath: () => "/nonexistent" });
  expect(await locate("gjc")).toBe(f.gjc);
  expect(runs()).toHaveLength(3);
  await locate.refresh?.();
  expect(runs()).toHaveLength(4);
});

it("an interactive shell that outruns its time leaves the login PATH, is not run again for the next lookups, and says why, once", async () => {
  const f = rcFixture('echo x >> "$HOME/rc-runs"; sleep 30');
  const runs = () => readFileSync(join(f.home, "rc-runs"), "utf8").split("\n").filter(Boolean).length;
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const probe = agentPathProbe({ shell: f.shell, env: f.env, timeoutMs: 300 });
    expect(await once(probe)).toEqual({ path: `${f.loginBin}:/usr/bin:/bin` });
    expect(probe.problem()).toContain("timed out after 300 ms");
    expect(await once(probe)).toEqual({ path: `${f.loginBin}:/usr/bin:/bin` });
    expect(await once(probe)).toEqual({ path: `${f.loginBin}:/usr/bin:/bin` });
    expect(runs()).toBe(1);
    expect(warn.mock.calls.filter(([line]) => String(line).includes("interactive shell PATH not read"))).toHaveLength(1);
    expect(catalogLocator({ probe, servicePath: () => "/nonexistent" }).problem?.()).toContain("timed out");
  } finally {
    warn.mockRestore();
  }
});

it("a reread asked for while a run is out gets a run that starts after it, and rereads within the gap share one", async () => {
  const f = rcFixture('echo x >> "$HOME/rc-runs"; [ -e "$HOME/added" ] || return 0 2>/dev/null || exit 0');
  const runs = () => readFileSync(join(f.home, "rc-runs"), "utf8").split("\n").filter(Boolean).length;
  const probe = agentPathProbe({ shell: f.shell, env: f.env, rereadGapMs: 0 });
  const first = once(probe);
  writeFileSync(join(f.home, "added"), "");
  probe.reread();
  const second = once(probe);
  await first;
  expect((await second).path).toBe(`${f.rcBin}:${f.loginBin}:/usr/bin:/bin`);
  expect(runs()).toBe(2);
  const gapped = agentPathProbe({ shell: f.shell, env: f.env, rereadGapMs: 300 });
  await once(gapped);
  for (let i = 0; i < 5; i++) gapped.reread();
  const asked = [once(gapped), once(gapped)];
  gapped.reread();
  asked.push(once(gapped));
  await Promise.all(asked);
  expect(runs()).toBe(4);
});

it("never takes a relative PATH entry a .zshrc adds, which would make the server's folder an agent's", async () => {
  const f = rcFixture();
  const relativeBin = relative(process.cwd(), f.rcBin);
  const shell = join(f.root, "relative-shell");
  writeFileSync(shell, `#!/bin/sh\nPATH='${relativeBin}:${f.loginBin}:/usr/bin:/bin'; export PATH\n[ "$1" = "-l" ] && shift\n[ "$1" = "-c" ] && exec /bin/sh -c "$2"\nexit 64\n`, { mode: 0o755 });
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe: loginPathProbe({ shell, env: f.env }) });
  expect(await locator.executable("gjc")).toBeNull();
  expect(await catalogLocator({ probe: loginPathProbe({ shell, env: f.env }), servicePath: () => "/nonexistent" })("gjc")).toBeNull();
});

it("service miss resolves the same executable for offer and start", async () => {
  const f = fixture();
  expect(shellAgentExecutable("gjc", "linux", f.servicePath())).toBeNull();
  const { probe, runs } = counted(loginPathProbe({ shell: f.shell, env: f.env }));
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe });
  const serviceOnly = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe: null });
  await expect(startShellAgent("gjc", "w1-1", [], { locator: serviceOnly })).rejects.toThrow("not on this server's PATH");
  expect(await locator.executable("gjc")).toBe(f.gjc);
  expect(await locator.executable("omo")).toBeNull();
  expect(await locator.executable("claude")).toBeNull();
  const sent: string[] = [];
  const rpc = spyOn(client, "herdrRpc").mockImplementation((async (method: string, params: { text?: string }) => {
    if (method === "pane.send_text") { sent.push(params.text ?? ""); return {}; }
    if (method === "pane.process_info") return { process_info: { shell_pid: 7, foreground_processes: sent.length === 0 ? [] : [{ pid: 4242, argv: [f.gjc, "it's"] }] } };
    throw new Error(`unexpected ${method}`);
  }) as typeof client.herdrRpc);
  try {
    expect(await startShellAgent("gjc", "w1-1", ["it's"], { locator, timeoutMs: 5000 })).toBe(4242);
  } finally {
    rpc.mockRestore();
  }
  expect(sent).toEqual([`${shellCommandLine("posix", f.gjc, ["it's"])}\n`]);
  expect(runs()).toBe(1);
});

it("finds a kind installed on the kept login PATH after a miss, with no new login shell", async () => {
  const f = fixture();
  const { probe, runs } = counted(async () => ({ path: `${f.loginBin}:/usr/bin` }));
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe });
  expect(await locator.executable("omo")).toBeNull();
  // its installer puts it on the login PATH (~/.local/bin and the like) a moment later
  writeFileSync(join(f.loginBin, "omo"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await locator.executable("omo")).toBe(join(f.loginBin, "omo"));
  expect(runs()).toBe(1);
});

it("a refresh asked for while a run is out runs a new one after it, which every later read waits for", async () => {
  const f = fixture();
  const { probe, runs, found } = manual();
  let clock = 0;
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe, now: () => clock });
  const first = locator.executable("omo");
  const refreshed = locator.refresh();
  found(`${f.root}:/usr/bin`);
  expect(await first).toBeNull();
  writeFileSync(join(f.loginBin, "omo"), "#!/bin/sh\n", { mode: 0o755 });
  expect(runs()).toBe(2);
  found(`${f.loginBin}:/usr/bin`);
  await refreshed;
  expect(await locator.executable("omo")).toBe(join(f.loginBin, "omo"));
  expect(runs()).toBe(2);
});

it("runs no login shell until asked, and again only once its answer is older than the TTL", async () => {
  const f = fixture();
  const { probe, runs } = counted(async () => ({ path: `${f.loginBin}:/usr/bin` }));
  jest.useFakeTimers();
  try {
    const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe });
    jest.advanceTimersByTime(24 * 60 * 60_000);
    expect(runs()).toBe(0);
    writeFileSync(join(f.serviceBin, "omo"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await locator.executable("omo")).toBe(join(f.serviceBin, "omo"));
    expect(await locator.executable("claude")).toBeNull();
    expect(runs()).toBe(0);
    expect(await locator.executable("gjc")).toBe(f.gjc);
    expect(runs()).toBe(1);
    jest.advanceTimersByTime(59_999);
    expect(await locator.executable("gjc")).toBe(f.gjc);
    expect(runs()).toBe(1);
    jest.advanceTimersByTime(10 * 60_000);
    expect(runs()).toBe(1);
    expect(await locator.executable("gjc")).toBe(f.gjc);
    expect(runs()).toBe(2);
  } finally {
    jest.useRealTimers();
  }
});

it("concurrent callers share one probe", async () => {
  const f = fixture();
  const { probe, runs, found, missed } = manual();
  let clock = 0;
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe, now: () => clock });
  const reads = Promise.all([...Array.from({ length: 8 }, () => locator.executable("gjc")), locator.executable("omo")]);
  expect(runs()).toBe(1);
  found(`${f.loginBin}:/usr/bin`);
  expect(await reads).toEqual([...Array.from({ length: 8 }, () => f.gjc), null]);
  expect(await locator.executable("gjc")).toBe(f.gjc);
  expect(await locator.executable("omo")).toBeNull();
  expect(runs()).toBe(1);
  clock += 60_000;
  const stale = Promise.all(Array.from({ length: 5 }, () => locator.executable("gjc")));
  expect(runs()).toBe(2);
  found(`${f.loginBin}:/usr/bin`);
  expect(await stale).toEqual(Array.from({ length: 5 }, () => f.gjc));

  unlinkSync(f.gjc);
  writeFileSync(join(f.root, "gjc"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await locator.executable("gjc")).toBeNull();
  expect(runs()).toBe(2);
  clock += 60_000;
  let read = locator.executable("gjc");
  found(`${f.loginBin}:/usr/bin`);
  expect(await read).toBeNull();
  writeFileSync(f.gjc, "#!/bin/sh\n", { mode: 0o755 });
  expect(await locator.executable("gjc")).toBe(f.gjc);
  expect(runs()).toBe(3);
  clock += 60_000;
  read = locator.executable("gjc");
  found(`${f.loginBin}:/usr/bin`);
  expect(await read).toBe(f.gjc);
  chmodSync(f.gjc, 0o644);
  clock += 60_000;
  read = locator.executable("gjc");
  found(`${f.loginBin}:relative`);
  expect(await read).toBeNull();
  chmodSync(f.gjc, 0o755);
  clock += 60_000;
  read = locator.executable("gjc");
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    missed("fixture miss");
    expect(await read).toBeNull();
  } finally {
    warn.mockRestore();
  }
  expect(runs()).toBe(6);
  writeFileSync(join(f.serviceBin, "gjc"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(f.serviceBin, "omo"), "#!/bin/sh\n", { mode: 0o755 });
  clock += 60_000;
  expect(await locator.executable("gjc")).toBe(join(f.serviceBin, "gjc"));
  expect(runs()).toBe(6);
});

it("says why the login shell gave no PATH once each time the reason changes", async () => {
  const f = fixture();
  const answers: (LoginPathResult | Error)[] = [
    { path: null, reason: "reason-a" }, { path: null, reason: "reason-a" }, { path: null, reason: "reason-a" },
    { path: null, reason: "reason-b" },
    { path: `${f.loginBin}:/usr/bin` }, { path: `${f.loginBin}:/usr/bin` },
    { path: null, reason: "reason-b" }, { path: null, reason: "reason-b" },
    new Error("reason-c"), new Error("reason-c"),
  ];
  const probe: LoginPathProbe = async () => {
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  };
  let clock = 0;
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe, now: () => clock });
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const results: (string | null)[] = [];
    for (let round = 0; round < 10; round += 1) {
      results.push(await locator.executable("gjc"));
      clock += 60_000;
    }
    expect(answers).toHaveLength(0);
    expect(results).toEqual([null, null, null, null, f.gjc, f.gjc, null, null, null, null]);
    const said = warn.mock.calls.map(([line]) => ["reason-a", "reason-b", "reason-c"].filter((reason) => String(line).includes(reason)));
    expect(said).toEqual([["reason-a"], ["reason-b"], ["reason-b"], ["reason-c"]]);
    // the PATH itself is never logged
    for (const [line] of warn.mock.calls) expect(String(line)).not.toContain(f.loginBin);
  } finally {
    warn.mockRestore();
  }
});

it("hung or oversized login probe is killed and reaped, and each miss says why", async () => {
  const hung = fixture(`sleep 30 & echo $! > "${"$"}HOME/child.pid"; echo $$ > "${"$"}HOME/shell.pid"; wait`);
  const pidsWritten = Promise.all([fifo(join(hung.home, "child.pid")), fifo(join(hung.home, "shell.pid"))]);
  const stop = new AbortController();
  const stopping = loginPathProbe({ shell: hung.shell, env: hung.env, timeoutMs: 60_000 })(stop.signal);
  const pids = (await pidsWritten).map(Number);
  for (const pid of pids) expect(pid).toBeGreaterThan(0);
  stop.abort();
  expect((await stopping).path).toBeNull();
  for (const pid of pids) expect(await running(Number(pid))).toBe(false);
  const started = Date.now();
  const timedOut = await once(loginPathProbe({ shell: hung.shell, env: hung.env, timeoutMs: 300 }));
  expect(timedOut.path).toBeNull();
  expect(Date.now() - started).toBeLessThan(5000);

  const noisy = fixture(`echo $$ > "${"$"}HOME/shell.pid"; head -c 200000 /dev/zero | tr '\\\\0' x`);
  const flooded = await once(loginPathProbe({ shell: noisy.shell, env: noisy.env, timeoutMs: 5000 }));
  expect(flooded.path).toBeNull();
  const noisyPid = Number(readFileSync(join(noisy.home, "shell.pid"), "utf8"));
  expect(noisyPid).toBeGreaterThan(0);
  expect(await running(noisyPid)).toBe(false);
  const loud = fixture(`echo $$ > "${"$"}HOME/shell.pid"; head -c 200000 /dev/zero | tr '\\\\0' x >&2`);
  expect((await once(loginPathProbe({ shell: loud.shell, env: loud.env, timeoutMs: 5000 }))).path).toBeNull();
  const loudPid = Number(readFileSync(join(loud.home, "shell.pid"), "utf8"));
  expect(loudPid).toBeGreaterThan(0);
  expect(await running(loudPid)).toBe(false);
  const mixed = fixture(`echo $$ > "${"$"}HOME/shell.pid"; head -c 40000 /dev/zero | tr '\\\\0' x; head -c 40000 /dev/zero | tr '\\\\0' y >&2`);
  expect((await once(loginPathProbe({ shell: mixed.shell, env: mixed.env, timeoutMs: 5000 }))).path).toBeNull();
  const mixedPid = Number(readFileSync(join(mixed.home, "shell.pid"), "utf8"));
  expect(mixedPid).toBeGreaterThan(0);
  expect(await running(mixedPid)).toBe(false);

  const chatty = fixture("echo 'PATH=/not/this'; echo __OVIS_LOGIN_PATH_END__");
  expect(await once(loginPathProbe({ shell: chatty.shell, env: chatty.env }))).toEqual({ path: `${chatty.loginBin}:/usr/bin:/bin` });
  const missing = await once(loginPathProbe({ shell: join(chatty.root, "no-such-shell"), env: chatty.env }));
  expect(missing.path).toBeNull();
  const failing = fixture("exit 3");
  const failed = await once(loginPathProbe({ shell: failing.shell, env: failing.env }));
  expect(failed.path).toBeNull();
  const reasons = [timedOut, flooded, missing, failed].map((result) => result.path === null ? result.reason : "");
  expect(new Set(reasons).size).toBe(4);
  for (const reason of reasons) expect(reason).not.toBe("");
  expect(reasons[2]).toContain("ENOENT");
  expect(reasons[3]).toContain("exit 3");
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: hung.servicePath, probe: loginPathProbe({ shell: hung.shell, env: hung.env, timeoutMs: 300 }) });
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(await locator.executable("gjc")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
  await locator.stop();
});

it("answers a shell SIGKILL does not end within the bound, and reaps it once it exits", async () => {
  const f = fixture(`echo $$ > "${"$"}HOME/shell.pid"; exec sleep 30`);
  const shellPid = fifo(join(f.home, "shell.pid"));
  const realKill = process.kill.bind(process);
  // the kills reach nothing while `stuck`, as for a shell blocked in the kernel; the exit's own group kill is seen
  let stuck = true;
  let reaped: (() => void) | null = null;
  const groupKilled = new Promise<void>((resolve) => { reaped = resolve; });
  let pid = 0;
  const kill = spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
    if (stuck) return true;
    if (target === -pid && signal === "SIGKILL") reaped?.();
    return realKill(target, signal);
  }) as typeof process.kill);
  try {
    const answer = once(loginPathProbe({ shell: f.shell, env: f.env, timeoutMs: 300, graceMs: 200 }));
    pid = Number(await shellPid);
    const result = await within(answer, 5000, "the probe waited on a shell SIGKILL did not end");
    expect(result.path).toBeNull();
    expect(await running(pid)).toBe(true);
    stuck = false;
    realKill(pid, "SIGKILL");
    await within(groupKilled, 5000, "the shell's exit was never handled");
    expect(() => realKill(pid, 0)).toThrow();
  } finally {
    stuck = false;
    kill.mockRestore();
    // pid stays 0 when the shell never wrote its pid file, and kill(0) would end this test's own
    // process group: every test file of the run beside it, with no failure reported
    if (pid > 0) try { realKill(pid, "SIGKILL"); } catch { }
  }
});

it.skipIf(Bun.which("setsid") === null)("reads the PATH printed after the shell exited, before its output closed", async () => {
  // the profile hands the script to a process in a session of its own (the shell exits only once it
  // says, through a FIFO, that it left the group), which waits until the shell is reaped and only
  // then prints the PATH: all of it arrives after the shell's exit
  const afterExit = (before: string) => fixture(`mkfifo "${"$"}HOME/left"; setsid /bin/sh -c 'echo > "$HOME/left"; while kill -0 "$0" 2>/dev/null; do :; done; ${before} exec /bin/sh -c "$1"' "$$" "$2" & read _ < "${"$"}HOME/left"; exit 0`);
  const f = afterExit("");
  expect(await once(loginPathProbe({ shell: f.shell, env: f.env, timeoutMs: 5000 }))).toEqual({ path: `${f.loginBin}:/usr/bin:/bin` });
  const flood = afterExit("yes x | head -c 200000;");
  expect((await once(loginPathProbe({ shell: flood.shell, env: flood.env, timeoutMs: 5000 }))).path).toBeNull();
});

it.skipIf(Bun.which("setsid") === null)("answers with the PATH when a process outside the group keeps the output open", async () => {
  // the profile leaves a process in a session of its own holding stdout and stderr; the shell exits
  // only once it says, through a FIFO, that it left the group, so the group kill cannot end it
  const f = fixture(`mkfifo "${"$"}HOME/left"; setsid /bin/sh -c 'echo > "$HOME/left"; exec sleep 30' & echo $! > "${"$"}HOME/held.pid"; read _ < "${"$"}HOME/left"`);
  let held = 0;
  try {
    const result = await once(loginPathProbe({ shell: f.shell, env: f.env, timeoutMs: 2000, graceMs: 100 }));
    held = Number(readFileSync(join(f.home, "held.pid"), "utf8"));
    expect(result).toEqual({ path: `${f.loginBin}:/usr/bin:/bin` });
    expect(await running(held)).toBe(true);
  } finally {
    if (held === 0 && existsSync(join(f.home, "held.pid"))) held = Number(readFileSync(join(f.home, "held.pid"), "utf8"));
    if (held > 0) try { process.kill(held, "SIGKILL"); } catch { }
  }
});

it("clears every timer it set once it answered", async () => {
  const f = fixture();
  const set = spyOn(globalThis, "setTimeout");
  const cleared = spyOn(globalThis, "clearTimeout");
  try {
    expect(await once(loginPathProbe({ shell: f.shell, env: f.env, graceMs: 1000 }))).toEqual({ path: `${f.loginBin}:/usr/bin:/bin` });
    const timers = set.mock.results.map((result) => result.value as unknown);
    expect(timers.length).toBeGreaterThanOrEqual(2);
    const clearedTimers = new Set(cleared.mock.calls.map(([timer]) => timer as unknown));
    for (const timer of timers) expect(clearedTimers.has(timer)).toBe(true);
  } finally {
    set.mockRestore();
    cleared.mockRestore();
  }
});

it("Windows does not invoke a Unix login shell", async () => {
  const f = fixture();
  const probe = mock<LoginPathProbe>(async () => ({ path: f.loginBin }));
  const locator = new ShellAgentLocator({ platform: "win32", servicePath: f.servicePath, probe });
  expect(await locator.executable("gjc")).toBeNull();
  writeFileSync(join(f.serviceBin, "gjc"), "#!/bin/sh\n", { mode: 0o755 });
  expect(await locator.executable("gjc")).toBe(join(f.serviceBin, "gjc"));
  expect(probe).not.toHaveBeenCalled();
  const plain = new ShellAgentLocator({ platform: "win32", servicePath: f.servicePath });
  expect(await plain.executable("omo")).toBeNull();
});

it("stop cancels refresh without leaking a child", async () => {
  const f = fixture(`echo $$ > "${"$"}HOME/shell.pid"; exec sleep 30`);
  const shellPid = fifo(join(f.home, "shell.pid"));
  const { probe, runs } = counted(loginPathProbe({ shell: f.shell, env: f.env, timeoutMs: 30_000 }));
  let clock = 0;
  const locator = new ShellAgentLocator({ platform: "linux", servicePath: f.servicePath, probe, now: () => clock });
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const read = locator.executable("gjc");
    const pid = Number(await shellPid);
    expect(await running(pid)).toBe(true);
    const started = Date.now();
    await locator.stop();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await running(pid)).toBe(false);
    expect(await read).toBeNull();
    clock += 60 * 60_000;
    expect(await locator.executable("gjc")).toBeNull();
    expect(runs()).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

it("offers OmO on Windows when its launcher is on PATH", () => {
  const which = spyOn(Bun, "which").mockReturnValue("C:\\tools\\omo.exe");
  try {
    expect(shellAgentExecutable("omo", "win32")).toBe("C:\\tools\\omo.exe");
    expect(which).toHaveBeenCalledWith("omo", { PATH: process.env["PATH"] ?? "" });
    which.mockReturnValue(null);
    expect(shellAgentExecutable("omo", "win32")).toBeNull();
  } finally {
    which.mockRestore();
  }
});
