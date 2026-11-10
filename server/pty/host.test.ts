import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { defaultRustSidecar, installedHostVouched, probeRustHost, resetPtyHostForTests, RUST_SIDECAR_BUILD, rustSidecar, rustSidecarPath } from "./host.ts";
import { PtySession, type PtySessionOptions } from "./session.ts";
import { nodeSidecarAvailable, resetSidecarForTests, sidecarAvailable } from "./sidecar.ts";

/** the Rust host these tests run: OVIS_PTY_SIDECAR_BIN, else the release build */
const RUST_HOST = rustSidecar({ ...process.env, OVIS_PTY_SIDECAR: "rust" });
const built = RUST_HOST !== null;
const LIMIT_MS = 10_000;

describe("rustSidecar", () => {
  beforeEach(resetPtyHostForTests);
  it.skipIf(process.platform === "win32")("runs the Rust host by default where it passes its check, and Node when OVIS_PTY_SIDECAR=node asks", () => {
    const said = spyOn(console, "log").mockImplementation(() => {});
    try {
      const binary = fakeHost(`${IDENTITY}\nexit 0`);
      expect(rustSidecar({ OVIS_PTY_SIDECAR_BIN: binary })).toBe(binary);
      expect(rustSidecar({ OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: binary })).toBe(binary);
      expect(rustSidecar({ OVIS_PTY_SIDECAR: "node", OVIS_PTY_SIDECAR_BIN: binary })).toBeNull();
    } finally { said.mockRestore(); }
  });

  it.skipIf(process.platform === "win32")("falls back to Node quietly by default, and loudly when OVIS_PTY_SIDECAR=rust asked", () => {
    const logged = spyOn(console, "log").mockImplementation(() => {});
    const warned = spyOn(console, "error").mockImplementation(() => {});
    try {
      const missing = join(tmpdir(), `ovis-no-pty-sidecar-${crypto.randomUUID()}`);
      expect(rustSidecar({ OVIS_PTY_SIDECAR_BIN: missing })).toBeNull();
      expect(warned).not.toHaveBeenCalled();
      expect(String(logged.mock.calls[0]?.[0])).toContain("Rust PTY host unavailable");
      resetPtyHostForTests();
      expect(rustSidecar({ OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: missing })).toBeNull();
      expect(String(warned.mock.calls[0]?.[0])).toContain("OVIS_PTY_SIDECAR=rust");
    } finally { logged.mockRestore(); warned.mockRestore(); }
  });

  it("falls back to the Node sidecar when the Rust binary is missing, saying so at most once", () => {
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      const env = { OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: join(tmpdir(), `ovis-no-pty-sidecar-${crypto.randomUUID()}`) };
      expect(rustSidecar(env)).toBeNull();
      expect(rustSidecar(env)).toBeNull();
      expect(said.mock.calls.length).toBe(1);
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
      // a server of another version, after a verdict for this one
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.10" }));
      expect(installedHostVouched(installed)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(!existsSync(defaultRustSidecar()))("runs the installed host or the Rust build, or OVIS_PTY_SIDECAR_BIN, when asked", () => {
    expect(rustSidecar({ OVIS_PTY_SIDECAR: "rust" })).toBe(defaultRustSidecar());
    expect(rustSidecar({ OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: defaultRustSidecar() })).toBe(defaultRustSidecar());
  });
});

const fixtures = mkdtempSync(join(tmpdir(), "ovis-pty-host-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));
const NODE_HOST = join(import.meta.dir, "pty-host.mjs");
const IDENTITY = 'if [ "$#" -eq 0 ]; then printf "pty-sidecar: usage: fixture\\n" >&2; exit 2; fi';
const DELEGATE = `exec node '${NODE_HOST}' "$@"`;

// No core dump from a process that crashes on purpose: with a relative core_pattern it would land in
// the working directory, the checkout, where check.ts counts it as a source change. A piped one
// (systemd-coredump) ignores a limit of 0 and reports the crash to the desktop on every run; a limit
// of 1 byte keeps the kernel from starting it. `prlimit` is Linux's, and it cannot raise a hard limit
// of 0; there, and where `prlimit` is missing, only `ulimit -c 0` applies, as before.
// https://github.com/torvalds/linux/blob/028ef9c96e96197026887c0f092424679298aae8/fs/coredump.c#L978-L996
const NO_CORE = "prlimit --pid $$ --core=1:1 2>/dev/null || ulimit -c 0";
const HARD_CORE_LIMIT = process.platform === "linux" ? /^Max core file size\s+\S+\s+(\S+)/m.exec(readFileSync("/proc/self/limits", "utf8"))?.[1] : undefined;

function fakeHost(body: string, mode = 0o755, shebang = true): string {
  const path = join(fixtures, crypto.randomUUID());
  writeFileSync(path, `${shebang ? `#!/bin/sh\n${NO_CORE}\n` : ""}${body}\n`);
  chmodSync(path, mode);
  return path;
}

it.skipIf(process.platform !== "linux" || !Bun.which("prlimit") || HARD_CORE_LIMIT === "0")("runs the processes it crashes with a core limit of 1 byte, which no piped core_pattern is started for", () => {
  const limits = Bun.spawnSync(["sh", "-c", `${NO_CORE}; grep 'Max core file size' /proc/$$/limits`], { stdout: "pipe", stderr: "pipe" });
  expect(limits.stdout.toString()).toMatch(/^Max core file size\s+1\s+1\s+bytes/);
});

describe.skipIf(process.platform === "win32")("probeRustHost", () => {
  beforeEach(resetPtyHostForTests);

  it.skipIf(!existsSync(RUST_SIDECAR_BUILD))("passes the built host", () => {
    expect(probeRustHost(RUST_SIDECAR_BUILD)).toEqual({ ok: true });
  });

  /** the verdict's reason, failing the test when the probe passed */
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
      const env = { OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: join(fixtures, "broken") };
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

  it.skipIf(process.platform === "win32")("warns once for each unknown value, uses Node for it, and never probes for node", () => {
    const spawn = spyOn(Bun, "spawnSync");
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const choice of ["RUST", "yes", "RUST", "yes"]) expect(rustSidecar({ OVIS_PTY_SIDECAR: choice })).toBeNull();
      expect(said).toHaveBeenCalledTimes(2);
      expect(String(said.mock.calls[0]?.[0])).toContain('OVIS_PTY_SIDECAR=RUST: expected "node" or "rust"');
      expect(String(said.mock.calls[1]?.[0])).toContain("yes");
      said.mockClear();
      expect(rustSidecar({ OVIS_PTY_SIDECAR: "node" })).toBeNull();
      expect(said).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); said.mockRestore(); }
  });

  it("attaches with the Rust host alone, with Node and node-pty alone, and mirrors with neither", () => {
    expect(sidecarAvailable({ rust: () => true, node: () => false, pty: () => false })).toBe(true);
    expect(sidecarAvailable({ rust: () => false, node: () => true, pty: () => true })).toBe(true);
    expect(sidecarAvailable({ rust: () => false, node: () => false, pty: () => true })).toBe(false);
    expect(sidecarAvailable({ node: () => true, pty: () => false })).toBe(false);
  });

  it.skipIf(process.platform === "win32")("caches each passing path and announces it once", () => {
    const spawn = spyOn(Bun, "spawnSync");
    const said = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let path = 0; path < 2; path++) {
        const binary = fakeHost(`${IDENTITY}\nexit 0`);
        const env = { OVIS_PTY_SIDECAR: "rust", OVIS_PTY_SIDECAR_BIN: binary };
        for (let i = 0; i < 3; i++) expect(rustSidecar(env)).toBe(binary);
      }
      expect(spawn).toHaveBeenCalledTimes(4);
      expect(said).toHaveBeenCalledTimes(2);
    } finally { spawn.mockRestore(); said.mockRestore(); }
  });
});

describe.skipIf(process.platform === "win32")("PtySession Rust fallback", () => {
  let previous: Record<string, string | undefined>;
  beforeEach(() => {
    resetPtyHostForTests();
    previous = { ...process.env };
    process.env["OVIS_PTY_SIDECAR"] = "rust";
    // a home without the app's own Node (server/pty/sidecar.ts looks there first), whatever this PC has
    process.env["HOME"] = mkdtempSync(join(fixtures, "home-"));
  });
  afterEach(() => {
    for (const key of ["OVIS_PTY_SIDECAR", "OVIS_PTY_SIDECAR_BIN", "PATH", "HOME"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    resetSidecarForTests();
  });

  /** A PC without Node, as `bun run` leaves one: the `node` on PATH is Bun itself. Nothing here may run pty-host.mjs on it. */
  function withoutNode(): void {
    const dir = mkdtempSync(join(fixtures, "bun-as-node-"));
    symlinkSync(process.execPath, join(dir, "node"));
    process.env["PATH"] = `${dir}:/usr/bin:/bin`;
    // and no Node of the app's own (install.sh's) in its home
    process.env["HOME"] = mkdtempSync(join(fixtures, "home-"));
    resetSidecarForTests();
    expect(nodeSidecarAvailable()).toBe(false);
  }
  /** passes the check without Node: its pty leg exits 0 instead of delegating to pty-host.mjs */
  const NODELESS_PROBE = `${IDENTITY}\nif [ "$3" = true ]; then exit 0; fi`;

  it("keeps the Rust host after an unrequested signal on a PC without Node, which has nothing to fall back to", async () => {
    const binary = fakeHost(`${NODELESS_PROBE}\nprintf READY\nkill -SEGV $$`);
    process.env["OVIS_PTY_SIDECAR_BIN"] = binary;
    withoutNode();
    const said = spyOn(console, "error").mockImplementation(() => {});
    const exitCodes: Array<number | null> = [];
    const crashed = new PtySession({ command: "sh", args: ["-c", "true"], cols: 80, rows: 24, onData: () => {}, onExit: (code) => { exitCodes.push(code); } });
    try {
      expect(crashed.host).toBe("rust");
      await crashed.exited;
      expect(exitCodes).toEqual([139]);
      expect(rustSidecar()).toBe(binary);
      expect(said).toHaveBeenCalledTimes(1);
      expect(String(said.mock.calls[0]?.[0])).toContain("kept, as this PC has no Node");
    } finally { crashed.kill(); said.mockRestore(); }
  });

  it("never runs pty-host.mjs on a node that is Bun: without the Rust host there is no PTY host", () => {
    process.env["OVIS_PTY_SIDECAR"] = "node";
    withoutNode();
    const spawn = spyOn(Bun, "spawn");
    try {
      expect(() => new PtySession({ command: "true", args: [], cols: 1, rows: 1, onData: () => {}, onExit: () => {} })).toThrow("no PTY host");
      expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockRestore(); }
  });

  // #596: the installer no longer links its Node into ~/.local/bin, and herdr's PATH may hold a Node older than 18 first
  for (const where of [".local/share/ovis/node", ".local/share/herdr-web-ui/node"]) {
    it(`runs the Node the installer put in ~/${where} over an older one first on PATH, probed and spawned at one path`, async () => {
      const real = Bun.which("node");
      if (real === null) throw new Error("this test needs Node");
      const home = mkdtempSync(join(fixtures, "home-"));
      const appNode = join(home, where, "bin", "node");
      mkdirSync(dirname(appNode), { recursive: true });
      symlinkSync(real, appNode);
      const old = mkdtempSync(join(fixtures, "old-node-"));
      writeFileSync(join(old, "node"), "#!/bin/sh\necho 10.24.1\n", { mode: 0o755 });
      process.env["HOME"] = home;
      process.env["PATH"] = `${old}:/usr/bin:/bin`;
      process.env["OVIS_PTY_SIDECAR"] = "node";
      resetSidecarForTests();
      const spawn = spyOn(Bun, "spawn");
      let started: Run | undefined;
      try {
        expect(nodeSidecarAvailable()).toBe(true);
        started = runOn("node", "sh", ["-c", "printf ok"]);
        expect((spawn.mock.calls[0] as unknown as [string[]])[0][0]).toBe(appNode);
        expect(await started.exited).toBe(0);
        expect(started.output()).toBe("ok");
      } finally { started?.session.kill(); spawn.mockRestore(); }
    });
  }

  it("tells the server to attach with the Rust host alone on a PC without Node, and to mirror with neither", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      process.env["OVIS_PTY_SIDECAR_BIN"] = fakeHost(`${NODELESS_PROBE}\nexit 0`);
      delete process.env["OVIS_PTY_SIDECAR"];
      withoutNode();
      expect(sidecarAvailable()).toBe(true);
      resetPtyHostForTests();
      resetSidecarForTests();
      process.env["OVIS_PTY_SIDECAR"] = "node";
      expect(sidecarAvailable()).toBe(false);
      expect(log.mock.calls.map((call) => String(call[0]))).toContain("PTY host: none (no Rust host and no Node for the sidecar), so panes are mirrored");
    } finally { log.mockRestore(); }
  });

  function passingHost(): string {
    const binary = fakeHost(`${IDENTITY}\n${DELEGATE}`);
    process.env["OVIS_PTY_SIDECAR_BIN"] = binary;
    expect(rustSidecar()).toBe(binary);
    return binary;
  }

  it("starts on Node when the Rust binary vanished after the probe", async () => {
    const binary = passingHost();
    rmSync(binary);
    const said = spyOn(console, "error").mockImplementation(() => {});
    let started: Run | undefined;
    try {
      started = runOn("node", "sh", ["-c", "printf ok"]);
      expect(await started.exited).toBe(0);
      expect(started.output()).toBe("ok");
      expect(rustSidecar()).toBeNull();
      expect(rustSidecar()).toBeNull();
      expect(said).toHaveBeenCalledTimes(1);
      expect(String(said.mock.calls[0]?.[0])).toContain("ENOENT");
    } finally { started?.session.kill(); said.mockRestore(); }
  });

  it("trips the breaker before onExit when the Rust host ends by an unrequested signal", async () => {
    const binary = fakeHost(`${IDENTITY}\nif [ "$3" = true ]; then ${DELEGATE}; fi\nprintf READY\nkill -SEGV $$`);
    process.env["OVIS_PTY_SIDECAR_BIN"] = binary;
    const said = spyOn(console, "error").mockImplementation(() => {});
    let following: Run | undefined;
    let output = "";
    const exitCodes: Array<number | null> = [];
    const crashed = new PtySession({
      command: "sh", args: ["-c", "printf unused"], cols: 80, rows: 24,
      onData: (data) => { output += data; },
      onExit: (code) => { exitCodes.push(code); following = runOn("node", "sh", ["-c", "printf ok"]); },
    });
    try {
      expect(crashed.host).toBe("rust");
      await crashed.exited;
      expect(exitCodes).toEqual([139]);
      expect(output).toBe("READY");
      expect(following).toBeDefined();
      expect(await following?.exited).toBe(0);
      expect(following?.output()).toBe("ok");
      expect(rustSidecar()).toBeNull();
      expect(said).toHaveBeenCalledTimes(1);
      expect(String(said.mock.calls[0]?.[0])).toContain("SIGSEGV");
    } finally { crashed.kill(); following?.session.kill(); said.mockRestore(); }
  });

  it.skipIf(!existsSync(RUST_SIDECAR_BUILD))("keeps the Rust host after its own immediate kill, twenty times", async () => {
    process.env["OVIS_PTY_SIDECAR_BIN"] = RUST_SIDECAR_BUILD;
    const said = spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 20; i++) {
        const session = new PtySession({ command: "cat", args: [], cols: 80, rows: 24, onData: () => {}, onExit: () => {} });
        try {
          expect(session.host).toBe("rust");
          session.kill();
          await session.exited;
          expect(rustSidecar()).toBe(RUST_SIDECAR_BUILD);
        } finally { session.kill(); }
      }
      expect(said).not.toHaveBeenCalled();
    } finally { said.mockRestore(); }
  });

  it("does not trip when both hosts fail to start", () => {
    const binary = passingHost();
    rmSync(binary);
    const said = spyOn(console, "error").mockImplementation(() => {});
    const path = process.env["PATH"];
    const empty = mkdtempSync(join(fixtures, "empty-"));
    try {
      try {
        // the server answers this once, at its start, while its PATH is whole; a PATH emptied later must not change it
        expect(nodeSidecarAvailable()).toBe(true);
        process.env["PATH"] = empty;
        expect(() => new PtySession({ command: "true", args: [], cols: 1, rows: 1, onData: () => {}, onExit: () => {} })).toThrow();
      } finally {
        if (path === undefined) delete process.env["PATH"];
        else process.env["PATH"] = path;
      }
      expect(rustSidecar()).toBe(binary);
      expect(said).not.toHaveBeenCalled();
    } finally { said.mockRestore(); }
  });
});

interface Run {
  session: PtySession;
  output: () => string;
  until: (label: string, check: (output: string) => boolean) => Promise<void>;
  /** onExit's code; a killed session never reports one */
  exited: Promise<number | null>;
}

function runOn(host: "node" | "rust", command: string, args: string[], extra: Partial<PtySessionOptions> = {}): Run {
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
  expect(session.host).toBe(host);
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

/** Resolves once `path` exists: the command's own word that it got that far, whatever the pty carried. */
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

/** A `sleep` whose arguments no other process has: the mark of one test's process group. */
const sleepTag = () => `sleep ${5000 + Math.floor(Math.random() * 4000)}.${String(Math.random()).slice(2, 10)}`;

/** Whether every process whose command line holds `tag` is gone within 3 s (a SIGKILLed one takes a moment). */
async function gone(tag: string): Promise<boolean> {
  for (const deadline = Date.now() + 3000; ;) {
    if (Bun.spawnSync(["pgrep", "-f", tag]).stdout.length === 0) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(25);
  }
}

/** A command in a process group of its own whose members ignore SIGHUP: a hangup alone never ends it. */
const STUBBORN_GROUP = (tag: string, then: string) => ["-c", `trap '' HUP; ${tag} & printf READY; ${then}`];

/** The same checks on each host: the Rust one has to behave as the Node one does. */
function parity(host: "node" | "rust") {
  describe.skipIf(host === "rust" && !built)(`PtySession on the ${host} PTY host`, () => {
    beforeEach(resetPtyHostForTests);
    const run = (command: string, args: string[], extra: Partial<PtySessionOptions> = {}) => runOn(host, command, args, extra);
    const previous = process.env["OVIS_PTY_SIDECAR"];
    const home = process.env["HOME"];
    beforeAll(() => {
      process.env["OVIS_PTY_SIDECAR"] = host;
      // a home without the app's own Node, so the Node host is the one on PATH whatever this PC has
      process.env["HOME"] = mkdtempSync(join(fixtures, "home-"));
    });
    afterAll(() => {
      if (previous === undefined) delete process.env["OVIS_PTY_SIDECAR"];
      else process.env["OVIS_PTY_SIDECAR"] = previous;
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
        // Node by the absolute path the guard probed, so the check and the spawn find the same one
        expect(argv[0]).toBe(host === "rust" ? RUST_HOST ?? "" : Bun.which("node") ?? "");
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

    // that wait ends the moment the command has exited: a plain exit is not held for it (timing is the
    // behaviour here, bounded well past a host's start and well under the 200 ms wait plus a quiet one)
    it.skipIf(process.platform === "win32")("ends a plain exit without waiting out the hold for a closed terminal", async () => {
      const started = performance.now();
      const ended = run("sh", ["-c", "exit 7"]);
      try {
        expect(await ended.exited).toBe(7);
        expect(performance.now() - started).toBeLessThan(150);
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

    // past that wait the host ends the command itself: only the signals it sent are its own end
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

    // the Node host signals the command alone, and exits right after its SIGKILL: only the Rust one promises these
    it.skipIf(host !== "rust")("kills the command's whole process group when stopped, even one ignoring SIGHUP", async () => {
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

    it.skipIf(host !== "rust")("kills what is left of the command's process group when the command exits", async () => {
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

    // the Node host kills the group once node-pty's exit timer ends, also while it holds paused output; the Rust
    // host hangs it up at the exit and kills it after the drain
    it.skipIf(host !== "node" || process.platform === "win32")("kills what is left of the command's process group when the command exits, while output is paused", async () => {
      const tag = sleepTag();
      // the tag's seconds as an argument: the host's own command line must not match `tag`
      const leaving = run("sh", ["-c", `trap '' HUP; sleep "$1" & printf READY; read -r _; exit 4`, "sh", tag.slice("sleep ".length)]);
      try {
        await leaving.until("READY", (output) => output.includes("READY"));
        leaving.session.pause();
        leaving.session.write("go\r");
        expect(await gone(tag)).toBe(true);
        leaving.session.resume();
        expect(await leaving.exited).toBe(4);
      } finally {
        leaving.session.kill();
        Bun.spawnSync(["pkill", "-KILL", "-f", tag]);
      }
    }, 15_000);

    // node-pty on Windows reads ConPTY through its own pipe, not the Unix socket pty-host.mjs holds open
    it.skipIf(host === "node" && process.platform === "win32")("holds output paused when the command exits, and delivers all of it on resume", async () => {
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
}

parity("node");
parity("rust");

/** The Rust host run directly, so a test can write what PtySession never does: frames cut off, floods. */
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
  /** the host's peak resident memory so far, in MiB */
  const peakMiB = () => Number(readFileSync(`/proc/${proc.pid}/status`, "utf8").match(/VmHWM:\s+(\d+)/)?.[1]) / 1024;
  /** how many diagnostic lines the host wrote */
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
      // one line for the overflow, not one per frame dropped
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
