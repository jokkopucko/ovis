import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { defaultRustSidecar, installedHostVouched, probeRustHost, resetPtyHostForTests, RUST_HOST_FIX, RUST_SIDECAR_BUILD, rustSidecar, rustSidecarPath } from "./host.ts";
import { LEAVE_WITHIN_MS, PtySession, type PtySessionOptions } from "./session.ts";
import { sidecarAvailable } from "./sidecar.ts";

const RUST_HOST = rustSidecar();
const built = RUST_HOST !== null;
const LIMIT_MS = 10_000;

describe("rustSidecar", () => {
  beforeEach(resetPtyHostForTests);
  it.skipIf(process.platform === "win32")("runs the host it is pointed at where it passes its check, also for an old OVIS_PTY_SIDECAR=node, which it says once is gone", () => {
    const said = spyOn(console, "log").mockImplementation(() => {});
    const warned = spyOn(console, "error").mockImplementation(() => {});
    try {
      const binary = fakeHost(`${IDENTITY}\nexit 0`);
      expect(rustSidecar({ OVIS_PTY_SIDECAR_BIN: binary })).toBe(binary);
      expect(warned).not.toHaveBeenCalled();
      for (let i = 0; i < 2; i++) expect(rustSidecar({ OVIS_PTY_SIDECAR: "node", OVIS_PTY_SIDECAR_BIN: binary })).toBe(binary);
      expect(warned.mock.calls.map((call) => String(call[0]))).toEqual(["OVIS_PTY_SIDECAR=node: the Node PTY sidecar was removed, so the Rust PTY host runs every terminal"]);
    } finally { said.mockRestore(); warned.mockRestore(); }
  });

  it.skipIf(process.platform === "win32")("says once, as an error, that there is no PTY host, why, and how to get one", () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { OVIS_PTY_SIDECAR_BIN: join(tmpdir(), `ovis-no-pty-sidecar-${crypto.randomUUID()}`) };
      expect(rustSidecar(env)).toBeNull();
      expect(rustSidecar(env)).toBeNull();
      expect(said.mock.calls.length).toBe(1);
      const message = String(said.mock.calls[0]?.[0]);
      expect(message).toStartWith("No PTY host: the Rust PTY host cannot run");
      expect(message).toContain("ENOENT");
      expect(message).toContain(RUST_HOST_FIX);
    } finally { said.mockRestore(); }
  });

  it("prefers the installed host to a local build only while its record vouches for it", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-pty-installed-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
      const installed = join(dir, "bin", "ovis-pty-sidecar");
      const record = (fields: Record<string, unknown>) => writeFileSync(`${installed}.json`, JSON.stringify(fields));
      expect(defaultRustSidecar(installed)).toBe(RUST_SIDECAR_BUILD);
      writeFileSync(installed, "host");
      const digest = createHash("sha256").update("host").digest("hex");
      expect(defaultRustSidecar(installed)).toBe(RUST_SIDECAR_BUILD);
      record({ sha256: digest, version: "0.0.1" });
      expect(defaultRustSidecar(installed)).toBe(RUST_SIDECAR_BUILD);
      record({ sha256: "0".repeat(64), version: "9.9.9" });
      writeFileSync(installed, "host\n");
      expect(defaultRustSidecar(installed)).toBe(RUST_SIDECAR_BUILD);
      writeFileSync(installed, "host");
      record({ sha256: digest, version: "9.9.9" });
      writeFileSync(installed, "host");
      expect(installedHostVouched(installed)).toBe(true);
      expect(defaultRustSidecar(installed)).toBe(installed);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads a record rewritten within one tick of the file clock, not a cached verdict", () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-pty-installed-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
      const installed = join(dir, "bin", "ovis-pty-sidecar");
      writeFileSync(installed, "host");
      const digest = createHash("sha256").update("host").digest("hex");
      // a whole second, so both writes carry exactly the same mtime, as on a coarse file clock
      const tick = 1_700_000_000;
      writeFileSync(`${installed}.json`, JSON.stringify({ sha256: digest, version: "0.0.1" }));
      utimesSync(`${installed}.json`, tick, tick);
      expect(installedHostVouched(installed)).toBe(false);
      writeFileSync(`${installed}.json`, JSON.stringify({ sha256: digest, version: "9.9.9" }));
      utimesSync(`${installed}.json`, tick, tick);
      expect(statSync(`${installed}.json`).mtimeMs).toBe(tick * 1000);
      expect(installedHostVouched(installed)).toBe(true);
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.10" }));
      expect(installedHostVouched(installed)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(!existsSync(defaultRustSidecar()))("runs the installed host or the Rust build, or OVIS_PTY_SIDECAR_BIN", () => {
    expect(rustSidecar({})).toBe(defaultRustSidecar());
    expect(rustSidecar({ OVIS_PTY_SIDECAR_BIN: defaultRustSidecar() })).toBe(defaultRustSidecar());
  });
});

const fixtures = mkdtempSync(join(tmpdir(), "ovis-pty-host-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));
const IDENTITY = 'if [ "$#" -eq 0 ]; then printf "pty-sidecar: usage: fixture\\n" >&2; exit 2; fi';
const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

// No core dump from a process that crashes on purpose: with a relative core_pattern it would land in
// the working directory, the checkout, where check.ts counts it as a source change. A piped one
// (systemd-coredump) ignores a limit of 0 and reports the crash to the desktop on every run; a limit
// of 1 byte keeps the kernel from starting it. `prlimit` is Linux's, and it cannot raise a hard limit
// of 0; there, and where `prlimit` is missing, only `ulimit -c 0` applies, as before. Its path is
// resolved here, as a test may run its fixtures on a PATH of `/usr/bin:/bin` alone,
// where a `prlimit` installed anywhere else is not found.
// https://github.com/torvalds/linux/blob/028ef9c96e96197026887c0f092424679298aae8/fs/coredump.c#L978-L996
const PRLIMIT = Bun.which("prlimit");
const NO_CORE = PRLIMIT === null ? "ulimit -c 0" : `${quote(PRLIMIT)} --pid $$ --core=1:1 2>/dev/null || ulimit -c 0`;
const HARD_CORE_LIMIT = process.platform === "linux" ? /^Max core file size\s+\S+\s+(\S+)/m.exec(readFileSync("/proc/self/limits", "utf8"))?.[1] : undefined;

function fakeHost(body: string, mode = 0o755, shebang = true): string {
  const path = join(fixtures, crypto.randomUUID());
  writeFileSync(path, `${shebang ? `#!/bin/sh\n${NO_CORE}\n` : ""}${body}\n`);
  chmodSync(path, mode);
  return path;
}

it.skipIf(process.platform !== "linux" || PRLIMIT === null || HARD_CORE_LIMIT === "0")("runs the processes it crashes with a core limit of 1 byte, which no piped core_pattern is started for, also on a PATH without `prlimit`", () => {
  const limits = Bun.spawnSync(["/bin/sh", "-c", `${NO_CORE}; ${quote(Bun.which("grep") ?? "grep")} 'Max core file size' /proc/$$/limits`], { env: { PATH: fixtures }, stdout: "pipe", stderr: "pipe" });
  expect(limits.stdout.toString()).toMatch(/^Max core file size\s+1\s+1\s+bytes/);
});

describe.skipIf(process.platform === "win32")("probeRustHost", () => {
  beforeEach(resetPtyHostForTests);

  it.skipIf(!existsSync(RUST_SIDECAR_BUILD))("passes the built host", () => {
    expect(probeRustHost(RUST_SIDECAR_BUILD)).toEqual({ ok: true });
  });

  const refused = (binary: string, timeoutMs?: number): string => {
    const verdict = probeRustHost(binary, process.env, timeoutMs);
    expect(verdict.ok).toBe(false);
    return verdict.ok ? "" : verdict.reason;
  };

  it("refuses a program that is not the host", () => {
    expect(refused("/bin/true")).toContain("exit 0");
    const other = fakeHost('if [ "$#" -eq 0 ]; then printf "another usage line\\n" >&2; exit 2; fi\nexit 0');
    expect(refused(other)).toContain("exit 2");
  });

  it("says why a binary cannot start", () => {
    for (const [path, reason] of [
      [fakeHost("exit 0", 0o644), "EACCES"],
      [fakeHost("exit 0", 0o755, false), "ENOEXEC"],
      [join(fixtures, "missing"), "ENOENT"],
    ] as const) {
      const verdict = probeRustHost(path);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(reason);
    }
  });

  it("gives up on a host that hangs", () => {
    const start = performance.now();
    expect(refused(fakeHost("exec sleep 30"), 200)).toContain("200 ms");
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("gives up on a host that ignores SIGTERM, so the server's start never waits on it", () => {
    const start = performance.now();
    expect(refused(fakeHost("trap '' TERM\nwhile :; do :; done"), 200)).toContain("200 ms");
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it("refuses a host that crashes on the pty path", () => {
    expect(refused(fakeHost(`${IDENTITY}\nkill -SEGV $$`))).toContain("SIGSEGV");
  });

  it("refuses a nonzero exit on the pty path", () => {
    expect(refused(fakeHost(`${IDENTITY}\nprintf "pty failed\\n" >&2; exit 7`))).toContain("exit 7");
  });

  it("rejects a timeout even when the host handles SIGTERM with exit zero", () => {
    const binary = fakeHost(`${IDENTITY}\ntrap 'exit 0' TERM\nwhile :; do :; done`);
    expect(refused(binary, 200)).toContain("200 ms");
  });

  it("scrubs both bridge tokens from both probe legs without changing the caller env", () => {
    const binary = fakeHost(`${IDENTITY}\nexit 0`);
    const env = { ...process.env, OVIS_TOKEN: "fixture", HERDR_WEB_TOKEN: "fixture" };
    const spawn = spyOn(Bun, "spawnSync");
    try {
      expect(probeRustHost(binary, env, 250)).toEqual({ ok: true });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls.map((call) => call[0])).toEqual([[binary], [binary, "1", "1", "true"]]);
      for (const call of spawn.mock.calls) {
        expect(call[1]?.env).not.toHaveProperty("OVIS_TOKEN");
        expect(call[1]?.env).not.toHaveProperty("HERDR_WEB_TOKEN");
      }
      expect(env.OVIS_TOKEN).toBe("fixture");
      expect(env.HERDR_WEB_TOKEN).toBe("fixture");
    } finally { spawn.mockRestore(); }
  });
});

describe("rustSidecar policy", () => {
  beforeEach(resetPtyHostForTests);

  it.skipIf(process.platform === "win32")("probes a path once and warns once", () => {
    const spawn = spyOn(Bun, "spawnSync");
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { OVIS_PTY_SIDECAR_BIN: join(fixtures, "broken") };
      for (let i = 0; i < 3; i++) expect(rustSidecar(env)).toBeNull();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(said).toHaveBeenCalledTimes(1);
      expect(String(said.mock.calls[0]?.[0])).toContain("ENOENT");
    } finally { spawn.mockRestore(); said.mockRestore(); }
  });

  it("expands only home shorthand in the Rust sidecar path", () => {
    const path = (binary: string) => rustSidecarPath({ OVIS_PTY_SIDECAR_BIN: binary }, "/home/fixture");
    expect(path("~")).toBe("/home/fixture");
    expect(path("~/x")).toBe("/home/fixture/x");
    expect(path("~user/x")).toBe("~user/x");
    expect(path("/absolute/x")).toBe("/absolute/x");
    expect(rustSidecarPath({})).toBe(defaultRustSidecar());
  });

  it.skipIf(process.platform === "win32")("caches each passing path and announces it once", () => {
    const spawn = spyOn(Bun, "spawnSync");
    const said = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let path = 0; path < 2; path++) {
        const binary = fakeHost(`${IDENTITY}\nexit 0`);
        const env = { OVIS_PTY_SIDECAR_BIN: binary };
        for (let i = 0; i < 3; i++) expect(rustSidecar(env)).toBe(binary);
      }
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(said).toHaveBeenCalledTimes(2);
    } finally { spawn.mockRestore(); said.mockRestore(); }
  });
});

describe.skipIf(process.platform === "win32")("PtySession and a host that cannot serve", () => {
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    resetPtyHostForTests();
    previous = { ...process.env };
    process.env["HOME"] = mkdtempSync(join(fixtures, "home-"));
  });
  afterEach(() => {
    for (const key of ["OVIS_PTY_SIDECAR_BIN", "HOME"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  /** A host that passes its check and does nothing else. */
  const PROBE_ONLY = `${IDENTITY}\nif [ "$3" = true ]; then exit 0; fi`;

  it("keeps the host after an unrequested signal, saying so", async () => {
    const binary = fakeHost(`${PROBE_ONLY}\nprintf READY\nkill -SEGV $$`);
    process.env["OVIS_PTY_SIDECAR_BIN"] = binary;
    const said = spyOn(console, "error").mockImplementation(() => {});
    const exitCodes: Array<number | null> = [];
    const crashed = new PtySession({ command: "sh", args: ["-c", "true"], cols: 80, rows: 24, onData: () => {}, onExit: (code) => { exitCodes.push(code); } });
    try {
      await crashed.exited;
      expect(exitCodes).toEqual([139]);
      expect(rustSidecar()).toBe(binary);
      expect(said.mock.calls.map((call) => String(call[0]))).toEqual(["Rust PTY host: ended by SIGSEGV"]);
    } finally { crashed.kill(); said.mockRestore(); }
  });

  it("starts nothing without a host that runs, and tells the server to mirror", () => {
    process.env["OVIS_PTY_SIDECAR_BIN"] = join(fixtures, "absent-host");
    const said = spyOn(console, "error").mockImplementation(() => {});
    const spawn = spyOn(Bun, "spawn");
    try {
      expect(() => new PtySession({ command: "true", args: [], cols: 1, rows: 1, onData: () => {}, onExit: () => {} })).toThrow("no PTY host");
      expect(spawn).not.toHaveBeenCalled();
      expect(sidecarAvailable()).toBe(false);
      process.env["OVIS_PTY_SIDECAR_BIN"] = fakeHost(`${PROBE_ONLY}\nexit 0`);
      expect(sidecarAvailable()).toBe(true);
    } finally { spawn.mockRestore(); said.mockRestore(); }
  });

  it("says why when the host vanished after its check", () => {
    const binary = fakeHost(`${PROBE_ONLY}\nexit 0`);
    process.env["OVIS_PTY_SIDECAR_BIN"] = binary;
    const said = spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(rustSidecar()).toBe(binary);
      rmSync(binary);
      expect(() => new PtySession({ command: "true", args: [], cols: 1, rows: 1, onData: () => {}, onExit: () => {} })).toThrow(/no PTY host: .* could not be started \(.*ENOENT/);
    } finally { said.mockRestore(); }
  });

  it.skipIf(!existsSync(RUST_SIDECAR_BUILD))("keeps the Rust host after its own immediate kill, twenty times", async () => {
    process.env["OVIS_PTY_SIDECAR_BIN"] = RUST_SIDECAR_BUILD;
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 20; i++) {
        const session = new PtySession({ command: "cat", args: [], cols: 80, rows: 24, onData: () => {}, onExit: () => {} });
        try {
          session.kill();
          await session.exited;
          expect(rustSidecar()).toBe(RUST_SIDECAR_BUILD);
        } finally { session.kill(); }
      }
      expect(said).not.toHaveBeenCalled();
    } finally { said.mockRestore(); }
  });
});

interface Run {
  session: PtySession;
  output: () => string;
  until: (label: string, check: (output: string) => boolean) => Promise<void>;
  exited: Promise<number | null>;
}

function run(command: string, args: string[], extra: Partial<PtySessionOptions> = {}): Run {
  let output = "";
  const waiters = new Set<() => void>();
  let reportExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => { reportExit = resolve; });
  const session = new PtySession({
    command, args, cols: 80, rows: 24, ...extra,
    onData: (data) => {
      output += data;
      for (const waiter of [...waiters]) waiter();
    },
    onExit: (code) => reportExit(code),
  });
  const until = (label: string, check: (output: string) => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(test);
      reject(new Error(`no ${label} in ${LIMIT_MS} ms: ${JSON.stringify(output.slice(-200))}`));
    }, LIMIT_MS);
    const test = () => {
      if (!check(output)) return;
      clearTimeout(timer);
      waiters.delete(test);
      resolve();
    };
    waiters.add(test);
    test();
  });
  return { session, output: () => output, until, exited };
}

async function appears(path: string): Promise<void> {
  const watcher = watch(dirname(path));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${basename(path)} never appeared`)), LIMIT_MS);
      const check = () => {
        if (!existsSync(path)) return;
        clearTimeout(timer);
        resolve();
      };
      watcher.on("change", check);
      check();
    });
  } finally { watcher.close(); }
}

const sleepTag = () => `sleep ${5000 + Math.floor(Math.random() * 4000)}.${String(Math.random()).slice(2, 10)}`;

/** Whether every process whose command line holds `tag` is gone within 3 s (a SIGKILLed one takes a moment). */
async function gone(tag: string): Promise<boolean> {
  for (const deadline = Date.now() + 3000; ;) {
    if (Bun.spawnSync(["pgrep", "-f", tag]).stdout.length === 0) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
}

const LEAVE = { keys: "\x02q", notAfter: /\x02$/ };
const bytes = (text: string): string => [...Buffer.from(text)].map((byte) => `<${byte.toString(16).padStart(2, "0")}>`).join("");
/**
 * Stands where `herdr terminal attach` stands: reads its terminal raw and says each byte it read (`<61>`), and reads
 * nothing before `gate` is there. One that `leaves` exits at LEAVE's keys.
 */
const READS = (gate: string | null, leaves: boolean) => ["-e", `
  const fs = require("fs");
  const gate = ${JSON.stringify(gate)};
  process.stdin.setRawMode(true);
  let read = "", reading = false;
  function start() {
    if (reading || (gate && !fs.existsSync(gate))) return;
    reading = true;
    process.stdin.on("data", (data) => {
      const now = [...data].map((byte) => "<" + byte.toString(16).padStart(2, "0") + ">").join("");
      read += now;
      process.stdout.write(now, () => { if (${leaves} && read.includes("<02><71>")) process.exit(0); });
    });
  }
  if (gate) fs.watch(require("path").dirname(gate), start);
  start();
  process.stdout.write("READY");
`];

/** A command in a process group of its own whose members ignore SIGHUP: a hangup alone never ends it. */
const STUBBORN_GROUP = (tag: string, then: string) => ["-c", `trap '' HUP; ${tag} & printf READY; ${then}`];

describe.skipIf(!built)("PtySession on the Rust PTY host", () => {
  beforeEach(resetPtyHostForTests);
  const home = process.env["HOME"];
  beforeAll(() => {
    process.env["HOME"] = mkdtempSync(join(fixtures, "home-"));
  });
  afterAll(() => {
    if (home === undefined) delete process.env["HOME"];
    else process.env["HOME"] = home;
  });

  it("starts that host and hands the command its environment without the bridge token", async () => {
    const token = `ovis-host-token-fixture-${crypto.randomUUID()}`;
    const kept = process.env["OVIS_TOKEN"];
    process.env["OVIS_TOKEN"] = token;
    const spawn = spyOn(Bun, "spawn");
    let started: Run | undefined;
    try {
      started = run("sh", ["-c", 'printf "[%s|%s|%s|%s]" "$HERDR_SOCKET_PATH" "$TERM" "${OVIS_TOKEN-unset}" "${HERDR_WEB_TOKEN-unset}"'], {
        env: { HERDR_SOCKET_PATH: "/tmp/ovis-host-parity.sock", HERDR_WEB_TOKEN: token },
      });
      expect(await started.exited).toBe(0);
      const argv = (spawn.mock.calls[0] as unknown as [string[]])[0];
      expect(argv[0]).toBe(RUST_HOST ?? "");
      expect(started.output()).toContain("[/tmp/ovis-host-parity.sock|xterm-256color|unset|unset]");
      // compared as a boolean so a failure never prints the token
      expect(started.output().includes(token)).toBe(false);
    } finally {
      started?.session.kill();
      spawn.mockRestore();
      if (kept === undefined) delete process.env["OVIS_TOKEN"];
      else process.env["OVIS_TOKEN"] = kept;
    }
  }, 15_000);

  it("delivers split UTF-8 and the entire final burst before reporting the exit code", async () => {
    const expected = "한글🙂\u001b[31m끝\u001b[0m".repeat(100_000);
    const burst = run("node", ["-e", `
      const data = Buffer.from("한글🙂\\x1b[31m끝\\x1b[0m".repeat(100000));
      process.stdout.write(data.subarray(0, 1));
      setTimeout(() => process.stdout.write(data.subarray(1), () => process.exit(7)), 10);
    `]);
    try {
      expect(await burst.exited).toBe(7);
      expect(burst.output() === expected).toBe(true);
    } finally { burst.session.kill(); }
  }, 15_000);

  // a signal's end is never the 0 of a success: told as a shell tells it
  it.skipIf(process.platform === "win32")("reports a command a signal ended as 128 plus the signal's number", async () => {
    const ended = run("sh", ["-c", "kill -TERM $$"]);
    try {
      expect(await ended.exited).toBe(143);
    } finally { ended.session.kill(); }
  }, 15_000);

  // The host's grace deadline may not release the hold:
  // the same exit check used in production must observe the command's end.
  it.skipIf(process.platform === "win32")("ends a plain exit without waiting out the hold for a closed terminal", async () => {
    const ended = run("sh", ["-c", "exit 7"], { env: { OVIS_TEST_PTY_NO_CLOSE_DEADLINE: "1" } });
    try {
      expect(await ended.exited).toBe(7);
    } finally { ended.session.kill(); }
  }, 15_000);

  // the host waits (EXIT_QUIET) for a command that closed its terminal, as a dying one does, before hanging it up:
  // time is the behaviour here, a command exiting 50 ms after it closed its terminal is well within that wait
  it.skipIf(process.platform === "win32")("lets a command that closed its terminal exit with its own code", async () => {
    const ended = run("sh", ["-c", "exec 0<&- 1>&- 2>&-; sleep 0.05; exit 3"]);
    try {
      expect(await ended.exited).toBe(3);
    } finally { ended.session.kill(); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("hangs up a command that closed its terminal and kept running as an end of its own, not a signal", async () => {
    const ended = run("sh", ["-c", "exec 0<&- 1>&- 2>&-; sleep 5"]);
    try {
      expect(await ended.exited).toBe(0);
    } finally { ended.session.kill(); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("reports a signal the command sent itself after the host hung it up, as that signal", async () => {
    const ended = run("sh", ["-c", "trap '' HUP; exec 0<&- 1>&- 2>&-; sleep 0.45; kill -TERM $$"]);
    try {
      expect(await ended.exited).toBe(143);
    } finally { ended.session.kill(); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("ends a command that closed its terminal and ignores the hangup, as an end of its own", async () => {
    const ended = run("sh", ["-c", "trap '' HUP; exec 0<&- 1>&- 2>&-; sleep 30"]);
    try {
      expect(await ended.exited).toBe(0);
    } finally { ended.session.kill(); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("signals SIGWINCH to the command without changing its size", async () => {
    const winch = run("node", ["-e", `
      process.on("SIGWINCH", () => process.stdout.write("WINCH " + process.stdout.columns + "x" + process.stdout.rows, () => process.exit(0)));
      process.stdout.write("READY");
      setInterval(() => {}, 1000);
    `], { cols: 40, rows: 5 });
    try {
      await winch.until("READY", (output) => output.includes("READY"));
      winch.session.winch();
      expect(await winch.exited).toBe(0);
      expect(winch.output()).toContain("WINCH 40x5");
    } finally { winch.session.kill(); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("resizes the pty, and the command hears it", async () => {
    // process.stdout first: its own SIGWINCH listener, which refreshes the size, has to run before ours
    const resized = run("node", ["-e", `
      const out = process.stdout;
      process.on("SIGWINCH", () => out.write("WINCH " + out.columns + "x" + out.rows, () => process.exit(0)));
      out.write("READY");
      setInterval(() => {}, 1000);
    `], { cols: 40, rows: 5 });
    try {
      await resized.until("READY", (output) => output.includes("READY"));
      resized.session.resize(60, 10);
      expect(await resized.exited).toBe(0);
      expect(resized.output()).toContain("WINCH 60x10");
    } finally { resized.session.kill(); }
  }, 15_000);

  it("holds output while paused with input live, and delivers it all on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-pty-pause-"));
    const wrote = join(dir, "wrote");
    const interrupted = join(dir, "interrupted");
    const held = "B".repeat(1000);
    const paused = run("node", ["-e", `
      const fs = require("fs");
      process.stdin.setRawMode(true);
      process.stdin.on("data", (data) => {
        const text = data.toString();
        if (text.includes("\\x03")) fs.writeFileSync(${JSON.stringify(interrupted)}, "");
        if (text.includes("go")) process.stdout.write("B".repeat(1000), () => fs.writeFileSync(${JSON.stringify(wrote)}, ""));
        if (text.includes("q")) process.stdout.write("END", () => process.exit(0));
      });
      process.stdout.write("READY");
    `]);
    try {
      await paused.until("READY", (output) => output.includes("READY"));
      paused.session.pause();
      paused.session.write("go");
      await appears(wrote);
      expect(paused.output()).not.toContain("B");
      paused.session.write("\x03");
      await appears(interrupted);
      expect(paused.output()).not.toContain("B");
      paused.session.resume();
      await paused.until("the held output", (output) => output.includes(held));
      paused.session.write("q");
      expect(await paused.exited).toBe(0);
      expect(paused.output()).toEndWith("END");
    } finally {
      paused.session.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("writes a lone surrogate as U+FFFD, the way JavaScript encodes it", async () => {
    const echo = run("node", ["-e", `
      process.stdin.setRawMode(true);
      process.stdin.once("data", (data) => process.stdout.write("HEX:" + data.toString("hex"), () => process.exit(0)));
      process.stdout.write("READY");
    `]);
    try {
      await echo.until("READY", (output) => output.includes("READY"));
      echo.session.write("a\ud83db");
      expect(await echo.exited).toBe(0);
      expect(echo.output()).toContain("HEX:61efbfbd62");
    } finally { echo.session.kill(); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("lets a command that leaves at its own keys read everything written before them, however late it reads (#4174)", async () => {
    const gate = join(mkdtempSync(join(fixtures, "gate-")), "open");
    const leaving = run("node", READS(gate, true), { leaveAt: LEAVE });
    try {
      await leaving.until("READY", (output) => output.includes("READY"));
      const typed = ["a", ...Array.from({ length: 6 }, (_, wheel) => `\x1b[<64;10;${wheel + 1}M`)];
      for (const text of typed) expect(leaving.session.write(text)).toBe(true);
      leaving.session.leave();
      expect(leaving.session.write("b")).toBe(false);
      writeFileSync(gate, "");
      await leaving.session.exited;
      expect(leaving.output()).toBe(`READY${bytes(typed.join("") + LEAVE.keys)}`);
    } finally { leaving.session.kill(); }
  }, 15_000);

  it.skipIf(process.platform === "win32")("ends a command with its keys unwritten behind input they would not be read as its way out after", async () => {
    const held = run("node", READS(null, true), { leaveAt: LEAVE });
    try {
      await held.until("READY", (output) => output.includes("READY"));
      held.session.write("\x02");
      await held.until("the chord's first key", (output) => output.includes("<02>"));
      held.session.leave();
      await held.session.exited;
      expect(held.output()).toBe("READY<02>");
    } finally { held.session.kill(); }
  }, 15_000);

  // time is the behaviour here: a command that does not leave is ended as a kill ends it, once it has had
  // LEAVE_WITHIN_MS for it and well after a kill at once would have (some 250 ms)
  it.skipIf(process.platform === "win32")("ends a command that has not left at its keys within LEAVE_WITHIN_MS", async () => {
    const staying = run("node", READS(null, false), { leaveAt: LEAVE });
    try {
      await staying.until("READY", (output) => output.includes("READY"));
      staying.session.write("a");
      const asked = performance.now();
      staying.session.leave();
      await staying.session.exited;
      expect(performance.now() - asked).toBeGreaterThan(LEAVE_WITHIN_MS / 2);
      expect(staying.output()).toBe(`READY${bytes(`a${LEAVE.keys}`)}`);
    } finally { staying.session.kill(); }
  }, 15_000);

  it("reaps both processes when killed with output paused", async () => {
    const tag = `ovis-pty-reap-${crypto.randomUUID()}`;
    const flood = run("node", ["-e", `/* ${tag} */ setInterval(() => process.stdout.write("x".repeat(4096)), 5);`]);
    try {
      await flood.until("output", (output) => output.length > 0);
      flood.session.pause();
      flood.session.kill();
      await flood.session.exited;
      expect(Bun.spawnSync(["pgrep", "-f", tag]).stdout.length).toBe(0);
    } finally { flood.session.kill(); }
  }, 15_000);

  it("kills the command's whole process group when stopped, even one ignoring SIGHUP", async () => {
    const tag = sleepTag();
    const stubborn = run("sh", STUBBORN_GROUP(tag, "wait"));
    try {
      await stubborn.until("READY", (output) => output.includes("READY"));
      stubborn.session.kill();
      await stubborn.session.exited;
      expect(await gone(tag)).toBe(true);
    } finally {
      stubborn.session.kill();
      Bun.spawnSync(["pkill", "-KILL", "-f", tag]);
    }
  }, 15_000);

  it("kills what is left of the command's process group when the command exits", async () => {
    const tag = sleepTag();
    const leaving = run("sh", STUBBORN_GROUP(tag, "exit 0"));
    try {
      expect(await leaving.exited).toBe(0);
      expect(await gone(tag)).toBe(true);
    } finally {
      leaving.session.kill();
      Bun.spawnSync(["pkill", "-KILL", "-f", tag]);
    }
  }, 15_000);

  it("holds output paused when the command exits, and delivers all of it on resume", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-pty-exit-paused-"));
    const wrote = join(dir, "wrote");
    const ending = run("node", ["-e", `
      const fs = require("fs");
      process.stdin.setRawMode(true);
      process.stdin.once("data", () => process.stdout.write("Q".repeat(1000), () => { fs.writeFileSync(${JSON.stringify(wrote)}, ""); process.exit(3); }));
      process.stdout.write("READY");
    `]);
    try {
      await ending.until("READY", (output) => output.includes("READY"));
      ending.session.pause();
      ending.session.write("go");
      await appears(wrote);
      await Bun.sleep(400); // fixed wait: past the 200 ms a host may keep reading once its command has exited
      expect(ending.output()).not.toContain("Q");
      ending.session.resume();
      expect(await ending.exited).toBe(3);
      expect(ending.output()).toContain("Q".repeat(1000));
    } finally {
      ending.session.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

function direct(args: string[]) {
  // exec keeps the host's pid; no core dump when a test aborts it (NO_CORE)
  const proc = Bun.spawn(["sh", "-c", `${NO_CORE}; exec "$0" "$@"`, RUST_HOST ?? "", "40", "5", ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let output = "";
  const waiters = new Set<() => void>();
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) {
      output += decoder.decode(chunk, { stream: true });
      for (const waiter of [...waiters]) waiter();
    }
  })();
  let errors = "";
  void (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr) errors += decoder.decode(chunk, { stream: true });
  })();
  const until = (label: string, text: string) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(test); reject(new Error(`no ${label} in ${LIMIT_MS} ms: ${JSON.stringify(output.slice(-200))}`)); }, LIMIT_MS);
    const test = () => {
      if (!output.includes(text)) return;
      clearTimeout(timer);
      waiters.delete(test);
      resolve();
    };
    waiters.add(test);
    test();
  });
  const peakMiB = () => Number(readFileSync(`/proc/${proc.pid}/status`, "utf8").match(/VmHWM:\s+(\d+)/)?.[1]) / 1024;
  const errorLines = () => errors.split("\n").filter(Boolean).length;
  return { proc, until, peakMiB, errorLines };
}

/** Reports each resize, and never reads its input: what it is sent piles up in the pty (raw, so the line discipline keeps it). */
const UNREAD = ["sh", "-c", 'stty raw -echo; exec node -e "$1"', "sh", `
  const out = process.stdout;
  process.on("SIGWINCH", () => out.write("WINCH " + out.columns + "x" + out.rows));
  out.write("READY");
  setInterval(() => {}, 1000);
`];
const RESIZE = `${JSON.stringify({ t: "r", c: 60, r: 10 })}\n`;

describe.skipIf(!built || process.platform !== "linux")("the Rust PTY host under more input than it may hold", () => {
  beforeEach(resetPtyHostForTests);
  it("discards a control frame that never ends once it passes the limit, and takes the next one", async () => {
    const host = direct(UNREAD);
    try {
      await host.until("READY", "READY");
      const chunk = Buffer.alloc(1024 * 1024, 0x78);
      host.proc.stdin.write('{"t":"i","d":"');
      for (let mib = 0; mib < 96; mib++) {
        host.proc.stdin.write(chunk);
        await host.proc.stdin.flush();
      }
      host.proc.stdin.write(`"}\n${RESIZE}`);
      await host.proc.stdin.flush();
      await host.until("the resize", "WINCH 60x10");
      expect(host.peakMiB()).toBeLessThan(48);
    } finally {
      host.proc.kill();
      await host.proc.exited;
    }
  }, 30_000);

  it("drops 64 KiB input frames a command does not read once 16 MiB wait, and still takes control frames", async () => {
    const host = direct(UNREAD);
    try {
      await host.until("READY", "READY");
      const frame = `${JSON.stringify({ t: "i", d: "y".repeat(64 * 1024) })}\n`;
      for (let sent = 1; sent <= 1536; sent++) {
        host.proc.stdin.write(frame);
        if (sent % 16 === 0) await host.proc.stdin.flush();
      }
      host.proc.stdin.write(RESIZE);
      await host.proc.stdin.flush();
      await host.until("the resize", "WINCH 60x10");
      expect(host.peakMiB()).toBeLessThan(48);
    } finally {
      host.proc.kill();
      await host.proc.exited;
    }
  }, 30_000);

  it("keeps a flood of tiny and empty input frames a command does not read within the limit, and still takes control frames", async () => {
    const host = direct(UNREAD);
    try {
      await host.until("READY", "READY");
      const pairs = `${JSON.stringify({ t: "i", d: "a" })}\n${JSON.stringify({ t: "i", d: "" })}\n`.repeat(4096);
      for (let sent = 0; sent < 1_500_000; sent += 4096) {
        host.proc.stdin.write(pairs);
        await host.proc.stdin.flush();
      }
      host.proc.stdin.write(RESIZE);
      await host.proc.stdin.flush();
      await host.until("the resize", "WINCH 60x10");
      expect(host.peakMiB()).toBeLessThan(48);
      expect(host.errorLines()).toBeLessThanOrEqual(2);
    } finally {
      host.proc.kill();
      await host.proc.exited;
    }
  }, 60_000);

  it("kills the command's process group when the host aborts", async () => {
    const tag = sleepTag();
    const host = direct(["sh", ...STUBBORN_GROUP(tag, "wait")]);
    try {
      await host.until("READY", "READY");
      process.kill(host.proc.pid, "SIGABRT");
      await host.proc.exited;
      expect(host.proc.signalCode).toBe("SIGABRT");
      expect(await gone(tag)).toBe(true);
    } finally {
      host.proc.kill();
      Bun.spawnSync(["pkill", "-KILL", "-f", tag]);
    }
  }, 15_000);
});
