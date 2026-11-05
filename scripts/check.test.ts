import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { CI_NODE_MAJOR, DESK_WAIT_MS, HOST_LIMITS, MAX_LOCK_PORT, MAX_RUNS_LIMIT, acquire, acquireWaiting, takeTicket, ticketDesk, ticketPorts, applyHostLimits, checkoutIdentity, describeGroup, describeHolders, endGroup, isolate, lock, lockPort, maxRuns, needsLock, plan, processStart, sanitizeCommand, takeoverLock, stopSessions, teardown, waitSeconds, warnNodeVersionMismatch } from "./check.ts";

const made: string[] = [];
afterEach(() => { for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true }); });
// /tmp where there is one, as `isolate` itself prefers: macOS keeps its temp dir under a path so long
// that a socket inside a directory made there is past the limit `isolate` enforces
const scratchBase = existsSync("/tmp") ? realpathSync("/tmp") : tmpdir();
const scratch = (): string => { const dir = mkdtempSync(join(scratchBase, "hwc-")); made.push(dir); return dir; };
/**
 * A lock base whose `count` slot ports, admission port, ticket desk and ticket ports above them
 * nothing listens on, held for a moment to make sure, then given back. The queue's ports too:
 * acquire() asks them, and a run waiting there (another runner's test, or a real check on a CI host)
 * would come ahead of the test's run.
 *
 * Below 32768, under the ports a system hands out on its own by default: Linux gives a listener on
 * port 0 or an outgoing connection one from 32768 up (ip_local_port_range), macOS and Windows from
 * 49152 up. One
 * of those taking a ticket port after the look above (another test file's server, on a CI host
 * running files side by side) would take the place the test expects a run to take, and, listening
 * without a word, hold every ticket lookup for the whole lookup time (#1940, #1939).
 */
function freePortRange(count: number): number {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 12_000);
    const held: { stop: (force?: boolean) => void }[] = [];
    try {
      for (let index = 0; base + index <= ticketPorts(base, count, count).at(-1)!; index++) held.push(Bun.listen({ hostname: "127.0.0.1", port: base + index, socket: { data() {} } }));
      return base;
    } catch { /* taken: another base */ } finally {
      for (const listener of held) listener.stop(true);
    }
  }
  throw new Error("no free port range");
}
const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
};

describe("plan", () => {
  it("reads the modes: the fast steps, the lanes, both, concurrent, or one command", () => {
    expect(plan(["fast"])).toEqual({ fast: true, lanes: [], command: null, build: false, concurrent: false });
    expect(plan(["browser"])).toEqual({ fast: false, lanes: ["browser"], command: null, build: false, concurrent: false });
    expect(plan(["browser", "integration"])).toEqual({ fast: false, lanes: ["integration", "browser"], command: null, build: false, concurrent: false });
    expect(plan(["full"])).toEqual({ fast: true, lanes: ["integration", "browser"], command: null, build: false, concurrent: false });
    expect(plan(["concurrent"])).toEqual({ fast: false, lanes: ["integration", "browser"], command: null, build: false, concurrent: true });
    expect(plan(["run", "bun", "test", "./a.test.ts"])).toEqual({ fast: false, lanes: [], command: ["bun", "test", "./a.test.ts"], build: false, concurrent: false });
    expect(plan(["run", "--build", "bun", "scripts/browser-qa.ts"])).toEqual({ fast: false, lanes: [], command: ["bun", "scripts/browser-qa.ts"], build: true, concurrent: false });
    expect(plan(["run", "--build", "--", "bun", "scripts/browser-qa.ts"])).toEqual({ fast: false, lanes: [], command: ["bun", "scripts/browser-qa.ts"], build: true, concurrent: false });
  });

  it("refuses what it does not know instead of running something else", () => {
    for (const args of [[], ["quick"], ["fast", "run"], ["run"]]) expect(() => plan(args)).toThrow("Usage");
  });

  it("uses the existing lock for herdr-backed run commands and never serializes inline credentials", () => {
    expect(needsLock(plan(["run", "bun", "test", "./a.contract.test.ts"]))).toBe(true);
    expect(needsLock(plan(["fast"]))).toBe(false);
    expect(needsLock(plan(["concurrent"]))).toBe(true);
    expect(sanitizeCommand(["bun", "--api-token", "private", "--access-token=value", "https://example.test/?token=secret"]))
      .toEqual(["bun", "--api-token", "[REDACTED]", "--access-token=[REDACTED]", "https://example.test/?token=[REDACTED]"]);
  });
});

describe("check environment", () => {
  it("uses CHECK_LOCK_PORT within the allowed range and keeps the default", () => {
    expect(lockPort({})).toBe(41737);
    expect(lockPort({ CHECK_LOCK_PORT: "" })).toBe(41737);
    expect(lockPort({ CHECK_LOCK_PORT: "1024" })).toBe(1024);
    expect(lockPort({ CHECK_LOCK_PORT: String(MAX_LOCK_PORT) })).toBe(MAX_LOCK_PORT);
    expect(lockPort({ CHECK_LOCK_PORT: "50000" })).toBe(50000);
    for (const value of ["1023", String(MAX_LOCK_PORT + 1), "65535", "65536", "-1", "1.5", "port", " 5000"]) {
      expect(() => lockPort({ CHECK_LOCK_PORT: value })).toThrow("CHECK_LOCK_PORT");
    }
  });

  it("acquires every slot and the admission port at the highest CHECK_LOCK_PORT it accepts", async () => {
    const base = lockPort({ CHECK_LOCK_PORT: String(MAX_LOCK_PORT) });
    // the queue's last ticket port is the highest one a run uses
    expect(ticketPorts(base, MAX_RUNS_LIMIT, MAX_RUNS_LIMIT).at(-1)).toBe(65535);
    // the most slots a run can ask for, so the admission port is the highest slot-range port acquire() uses.
    // CI's runners share one loopback: a checkout of this run's own, and a wait, let two runs of
    // this test meet at the top range without refusing each other
    const top = { slots: MAX_RUNS_LIMIT, scan: MAX_RUNS_LIMIT, pid: process.pid, checkout: `/top-${process.pid}` };
    const held = await acquireWaiting({ ...top, base }, { waitMs: 10_000, pollMs: 20 });
    if (!("release" in held)) throw new Error(`the top lock range is held on this PC: ${describeHolders(held.holders)}`);
    held.release();
    // one port higher and the last ticket port would be past 65535: that base is refused
    expect(ticketPorts(MAX_LOCK_PORT + 1, MAX_RUNS_LIMIT, MAX_RUNS_LIMIT).at(-1)).toBe(65536);
    expect(() => lockPort({ CHECK_LOCK_PORT: String(MAX_LOCK_PORT + 1) })).toThrow("CHECK_LOCK_PORT");
  });

  it("warns only when the local Node major differs from CI", () => {
    const warnings: string[] = [];
    const warn = (message: string): void => { warnings.push(message); };
    warnNodeVersionMismatch("v24.18.0", warn);
    expect(warnings).toEqual(["check: warning: local Node v24.18.0 differs from CI Node 22"]);
    warnNodeVersionMismatch("v22.16.0", warn);
    warnNodeVersionMismatch(null, warn);
    expect(warnings).toHaveLength(1);
  });

  it("compares with the Node major the CI runner image installs", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL("./self-hosted-runner/Dockerfile", import.meta.url)), "utf8");
    expect(Number(dockerfile.match(/^ARG NODE_VERSION=(\d+)\./m)?.[1])).toBe(CI_NODE_MAJOR);
  });
});

describe("isolate", () => {
  it("replaces the user's login shell for Unix test panes, but keeps the native Windows environment", () => {
    const dir = scratch();
    const home = join(dir, "home");
    mkdirSync(home);
    for (const name of [".bashrc", ".bash_profile", ".profile", "bash-env"]) {
      writeFileSync(join(home, name), "export TEST_STARTUP_READ=yes\n");
    }
    const logout = join(dir, "logout-read");
    writeFileSync(join(home, ".bash_logout"), `printf logout > '${logout}'\n`);
    const { env } = isolate({ SHELL: "/bin/zsh", HOME: home, BASH_ENV: join(home, "bash-env") }, dir);
    if (process.platform === "win32") {
      expect(env["SHELL"]).toBe("/bin/zsh");
    } else if (!existsSync("/bin/bash")) {
      expect(env["SHELL"]).toBe("/bin/sh");
    } else {
      const shell = env["SHELL"];
      if (!shell) throw new Error("Missing test shell");
      // an interactive bash takes the controlling terminal, which stops a test run started from one
      // (a herdr pane included): the -i probes run in a session of their own, with no terminal
      const setsid = ["/usr/bin/setsid", "/bin/setsid"].find((path) => existsSync(path));
      for (const args of setsid ? [["-i"], ["-l", "-i"], []] : [[]]) {
        const probe = [shell, ...args, "-c", 'printf "%s|%s" "${TEST_STARTUP_READ-unread}" "$1"; exit', "test", "argument with spaces"];
        const result = setsid ? spawnSync(setsid, probe, { env, encoding: "utf8" }) : spawnSync(probe[0]!, probe.slice(1), { env, encoding: "utf8" });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("unread|argument with spaces");
        expect(existsSync(logout)).toBe(false);
      }
    }
  });

  it("points herdr, its plugins and the web UI at one directory of the run's own, under its own session name", () => {
    const first = isolate({ PATH: "/bin", XDG_CONFIG_HOME: "/home/someone/.config" });
    const second = isolate({ PATH: "/bin" });
    try {
      expect(first.env["PATH"]).toBe("/bin");
      expect(first.env["XDG_CONFIG_HOME"]).not.toBe("/home/someone/.config");
      for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "OVIS_STATE_DIR"]) {
        expect(existsSync(first.env[name]!)).toBe(true);
        expect(first.env[name]).not.toBe(second.env[name]);
      }
      expect(first.sessions).toBe(join(first.env["XDG_CONFIG_HOME"]!, "herdr", "sessions"));
      expect(first.env["HERDR_TEST_SESSION"]).toMatch(/^check-[0-9a-f]{6}$/);
      expect(first.env["HERDR_TEST_SESSION"]).not.toBe(second.env["HERDR_TEST_SESSION"]);
      if (process.platform !== "win32") {
        for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "OVIS_STATE_DIR"]) expect(statSync(first.env[name]!).mode & 0o777).toBe(0o700);
      }
      // one integration file at a time unless asked otherwise
      expect(first.env["HERDR_TEST_SHARDS"]).toBe("1");
      expect(isolate({ HERDR_TEST_SHARDS: "4" }, scratch()).env["HERDR_TEST_SHARDS"]).toBe("4");
      // the browsers of a run draw the English copy the scripts assert, whatever the desktop's language
      expect(isolate({ LANGUAGE: "ko:en_AU:en" }, scratch()).env["LANGUAGE"]).toBe("en_US:en");
    } finally {
      const dir = join(first.env["XDG_CONFIG_HOME"]!, "..");
      first.remove();
      second.remove();
      expect(existsSync(dir)).toBe(false);
    }
  });

  it("keeps a directory the caller named, and refuses one too long for a socket", () => {
    const kept = scratch();
    const isolation = isolate({}, kept);
    expect(isolation.env["XDG_CONFIG_HOME"]).toBe(join(kept, "config"));
    isolation.remove();
    expect(existsSync(join(kept, "config"))).toBe(true);
    expect(() => isolate({}, join(scratch(), "a".repeat(80)))).toThrow("too long for a unix socket");
  });

  it("refuses to run in the herdr the user works in, and hands on nothing that names it", () => {
    expect(() => isolate({ HERDR_TEST_LIVE: "1" }, scratch())).toThrow("HERDR_TEST_LIVE");
    // as a shell inside one of the user's panes has them, and a herdr config of the user's own,
    // which the run's herdr and every server it starts would otherwise read
    const { env } = isolate({ HERDR_SOCKET: "/live.sock", HERDR_SOCKET_PATH: "/live.sock", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1", HERDR_CONFIG_PATH: "/home/me/herdr.toml", OVIS_HERDR_BIN: "/bin/herdr" }, scratch());
    expect(Object.keys(env).filter((name) => name.startsWith("HERDR_") || name.startsWith("OVIS_")).sort()).toEqual(["HERDR_SOCKET", "HERDR_TEST_DISPOSABLE_CONFIG", "HERDR_TEST_SESSION", "HERDR_TEST_SHARDS", "OVIS_HERDR_BIN", "OVIS_STATE_DIR"]);
    // the socket it hands on is the run's own session's, where scripts/test-herdr.ts starts it
    expect(env["HERDR_SOCKET"]).toBe(join(env["XDG_CONFIG_HOME"]!, "herdr", "sessions", env["HERDR_TEST_SESSION"]!, "herdr.sock"));
  });
});

describe("lock", () => {
  /** a port nothing listens on: asked of the system, then given back */
  const freePort = async (): Promise<number> => {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    return port;
  };

  it("lets one run in, names the run that holds it, and is free again once released", async () => {
    const port = await freePort();
    const first = await lock(port, 111);
    expect("release" in first).toBe(true);
    expect(await lock(port, 222)).toEqual({ heldBy: 111 });
    (first as { release: () => void }).release();
    const next = await lock(port, 222);
    expect("release" in next).toBe(true);
    (next as { release: () => void }).release();
  });

  it("says so when something that is no run listens on the port", async () => {
    const other = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(socket) { socket.end("hello"); }, data() {} } });
    try {
      expect(await lock(other.port, 222)).toEqual({ heldBy: Number.NaN });
    } finally {
      other.stop(true);
    }
  });

  it("is free again once the run that held it is killed", async () => {
    const port = await freePort();
    const holder = Bun.spawn([process.execPath, "-e", `const { lock } = await import(${JSON.stringify(fileURLToPath(new URL("./check.ts", import.meta.url)))}); await lock(${port}, 111, "/a"); console.log("HELD"); setInterval(() => {}, 1000);`], { stdout: "pipe" });
    try {
      const reader = holder.stdout.getReader();
      let said = "";
      while (!said.includes("HELD")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the holder ended before it held the lock");
        said += new TextDecoder().decode(value);
      }
      expect(await lock(port, 222)).toEqual({ heldBy: 111, checkout: "/a" });
      holder.kill("SIGKILL");
      await holder.exited;
      const next = await lock(port, 222);
      expect("release" in next).toBe(true);
      (next as { release: () => void }).release();
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

describe("slots", () => {
  const freeRange = async (count: number): Promise<number> => freePortRange(count);
  const release = (result: Awaited<ReturnType<typeof acquire>> | Awaited<ReturnType<typeof lock>>): void => {
    if ("release" in result) result.release();
  };
  /**
   * The wait between a waiting run's rounds, driven by the test: `asleep` resolves once the run is
   * between rounds, and `wake` lets it ask again. No timer runs.
   */
  const stepper = () => {
    let asleep = Promise.withResolvers<void>();
    let wake = Promise.withResolvers<void>();
    return {
      sleep: async () => { const woken = wake; asleep.resolve(); await woken.promise; },
      asleep: () => asleep.promise,
      wake: () => { asleep = Promise.withResolvers(); const woken = wake; wake = Promise.withResolvers(); woken.resolve(); },
    };
  };
  /** the slot range and the queue's ticket ports above it, for slots/scan of 3 */
  const queueRange = () => freeRange(3);

  it("takes the first free slot when another checkout holds an earlier one", async () => {
    const base = await freeRange(3);
    const other = await lock(base, 111, "/other");
    try {
      const mine = await acquire({ slots: 3, scan: 3, base, pid: 222, checkout: "/mine" });
      expect(mine).toMatchObject({ port: base + 1 });
      expect(await lock(base + 1, 333)).toEqual({ heldBy: 222, checkout: "/mine" });
      release(mine);
    } finally {
      release(other);
    }
  });

  it("refuses when every slot is taken and names each holder", async () => {
    const base = await freeRange(3);
    const first = await lock(base, 111, "/a");
    const second = await lock(base + 1, 333, "/c");
    try {
      const refused = await acquire({ slots: 2, scan: 3, base, pid: 222, checkout: "/b" });
      expect(refused).toEqual({ refused: "busy", holders: [{ port: base, heldBy: 111, checkout: "/a" }, { port: base + 1, heldBy: 333, checkout: "/c" }] });
      expect(describeHolders((refused as { holders: Parameters<typeof describeHolders>[0] }).holders)).toBe(`port ${base}: pid 111 in /a; port ${base + 1}: pid 333 in /c`);
      // what it refused it does not keep: the third port is still free
      const third = await lock(base + 2, 444);
      expect("release" in third).toBe(true);
      release(third);
    } finally {
      release(first);
      release(second);
    }
  });

  it("refuses a second run in the same checkout while slots are free, also past its own slot count", async () => {
    const base = await freeRange(3);
    const same = await lock(base + 2, 111, "/mine");
    try {
      const refused = await acquire({ slots: 2, scan: 3, base, pid: 222, checkout: "/mine" });
      expect(refused).toEqual({ refused: "same-checkout", holders: [{ port: base + 2, heldBy: 111, checkout: "/mine" }] });
      // the slot it took on the way is given back
      const first = await lock(base, 333);
      expect("release" in first).toBe(true);
      release(first);
      const elsewhere = await acquire({ slots: 2, scan: 3, base, pid: 222, checkout: "/elsewhere" });
      expect(elsewhere).toMatchObject({ port: base });
      release(elsewhere);
    } finally {
      release(same);
    }
  });

  it("refuses different lock ranges while the checkout claim is live, then admits after release", async () => {
    const firstBase = await freeRange(3);
    let secondBase = await freeRange(3);
    while (Math.abs(firstBase - secondBase) <= 3) secondBase = await freeRange(3);
    const checkoutLock = join(scratch(), "checkout.lock");
    const first = await acquire({ slots: 1, scan: 3, base: firstBase, checkout: "/same", checkoutLock });
    try {
      expect("release" in first).toBe(true);
      const refused = await acquire({ slots: 1, scan: 3, base: secondBase, checkout: "/same", checkoutLock });
      try {
        expect(refused).toEqual({ refused: "same-checkout", holders: [{ port: secondBase + 3, heldBy: process.pid, checkout: "/same" }] });
      } finally { release(refused); }
    } finally { release(first); }
    const next = await acquire({ slots: 1, scan: 3, base: secondBase, checkout: "/same", checkoutLock });
    expect("release" in next).toBe(true);
    release(next);
  });

  it("claims the checkout for a run that takes no slot, so fast and a herdr-backed run refuse each other", async () => {
    const base = await freeRange(3);
    const checkoutLock = join(scratch(), "checkout.lock");
    const fast = await acquire({ slots: 0, scan: 3, base, checkout: "/same", checkoutLock });
    try {
      expect("release" in fast).toBe(true);
      const secondFast = await acquire({ slots: 0, scan: 3, base, checkout: "/same", checkoutLock });
      try { expect(secondFast).toMatchObject({ refused: "same-checkout", holders: [{ heldBy: process.pid, checkout: "/same" }] }); }
      finally { release(secondFast); }
      const lane = await acquire({ slots: 1, scan: 3, base, checkout: "/same", checkoutLock });
      try { expect(lane).toMatchObject({ refused: "same-checkout", holders: [{ heldBy: process.pid, checkout: "/same" }] }); }
      finally { release(lane); }
    } finally { release(fast); }
    const lane = await acquire({ slots: 1, scan: 3, base, checkout: "/same", checkoutLock });
    try {
      expect("release" in lane).toBe(true);
      const fastBeside = await acquire({ slots: 0, scan: 3, base, checkout: "/same", checkoutLock });
      try { expect(fastBeside).toMatchObject({ refused: "same-checkout" }); }
      finally { release(fastBeside); }
      // another checkout's fast run is no business of this one
      const elsewhere = await acquire({ slots: 0, scan: 3, base, checkout: "/other", checkoutLock: join(scratch(), "checkout.lock") });
      try { expect(elsewhere).toMatchObject({ port: null }); }
      finally { release(elsewhere); }
    } finally { release(lane); }
  });

  it("admits a run that takes no slot while another run holds the admission port", async () => {
    const base = await freeRange(3);
    // base + max(slots, scan): the port a herdr-backed run holds while it is admitted
    const admitting = await lock(base + 3, 111, "/admitting");
    if (!("release" in admitting)) throw new Error("the admission port was free");
    try {
      const fast = await acquire({ slots: 0, scan: 3, base, checkout: "/mine", checkoutLock: join(scratch(), "checkout.lock") });
      try { expect(fast).toMatchObject({ port: null }); }
      finally { release(fast); }
    } finally { release(admitting); }
  });

  it("takes over a checkout claim left by a dead pid", async () => {
    const base = await freeRange(3);
    const checkoutLock = join(scratch(), "checkout.lock");
    const finished = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(finished.status).toBe(0);
    writeFileSync(`${checkoutLock}.check-lock`, JSON.stringify({ pid: Number(finished.stdout.trim()), checkout: "/dead" }));
    const result = await acquire({ slots: 1, scan: 3, base, checkout: "/mine", checkoutLock });
    try {
      expect("release" in result).toBe(true);
      expect(JSON.parse(readFileSync(`${checkoutLock}.check-lock`, "utf8")).pid).toBe(process.pid);
    } finally { release(result); }
  });

  it("refuses a stale checkout marker while a live process holds its reclaim file (no takeover socket)", async () => {
    const base = await freeRange(3);
    const checkoutLock = join(scratch(), "checkout.lock");
    const finished = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(finished.status).toBe(0);
    const marker = `${checkoutLock}.check-lock`;
    writeFileSync(marker, JSON.stringify({ pid: Number(finished.stdout.trim()), checkout: "/dead" }));
    writeFileSync(`${marker}.reclaim`, JSON.stringify({ pid: process.pid, checkout: "/reclaimer" }));
    const result = await acquire({ slots: 1, scan: 3, base, checkout: "/mine", checkoutLock, fileTakeover: true });
    try {
      expect(result).toEqual({ refused: "same-checkout", holders: [{ port: base + 3, heldBy: process.pid, checkout: "/reclaimer" }] });
      expect(readFileSync(marker, "utf8")).toContain('"/dead"');
    } finally { release(result); }
  });

  it.skipIf(process.platform !== "linux")("refuses a stale checkout marker while a live run holds its takeover lock, and takes it over once that run is killed", async () => {
    const base = await freeRange(3);
    const checkoutLock = join(scratch(), "checkout.lock");
    const finished = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(finished.status).toBe(0);
    const marker = `${checkoutLock}.check-lock`;
    writeFileSync(marker, JSON.stringify({ pid: Number(finished.stdout.trim()), checkout: "/dead" }));
    const script = fileURLToPath(new URL("./check.ts", import.meta.url));
    // a run that took the lock and is killed before it lets go, as a SIGKILL mid-takeover would leave it
    const holder = Bun.spawn([process.execPath, "-e", `const { takeoverLock } = await import(${JSON.stringify(script)}); const lock = await takeoverLock(process.env.MARKER, JSON.stringify({ pid: process.pid, checkout: "/taking-over" })); console.log("release" in lock ? "HELD" : "NOT HELD"); setInterval(() => {}, 1000);`], {
      env: { ...process.env, MARKER: marker }, stdout: "pipe", stderr: "inherit",
    });
    try {
      const reader = holder.stdout.getReader();
      let said = "";
      while (!said.includes("HELD")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("the lock holder exited before it held the lock");
        said += new TextDecoder().decode(value);
      }
      expect(said.trim()).toBe("HELD");
      const refused = await acquire({ slots: 1, scan: 3, base, checkout: "/mine", checkoutLock });
      try { expect(refused).toEqual({ refused: "same-checkout", holders: [{ port: base + 3, heldBy: holder.pid, checkout: "/taking-over" }] }); }
      finally { release(refused); }
      holder.kill("SIGKILL");
      await holder.exited;
      const taken = await acquire({ slots: 1, scan: 3, base, checkout: "/mine", checkoutLock });
      try {
        expect("release" in taken).toBe(true);
        expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ pid: process.pid, checkout: "/mine" });
      } finally { release(taken); }
    } finally { holder.kill("SIGKILL"); }
  });

  it("clears a reclaim file a run killed while taking over left, and the run after it meets the claim", async () => {
    const checkoutLock = join(scratch(), "checkout.lock");
    const finished = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(finished.status).toBe(0);
    const marker = `${checkoutLock}.check-lock`;
    // what a run killed right after linking its reclaim leaves: both files name a pid that is gone
    const stale = JSON.stringify({ pid: Number(finished.stdout.trim()), checkout: "/dead" });
    writeFileSync(marker, stale);
    writeFileSync(`${marker}.reclaim`, stale);
    // two runs on other lock bases, as two checks started at once would be
    const firstBase = await freeRange(3);
    let secondBase = await freeRange(3);
    while (Math.abs(firstBase - secondBase) <= 3) secondBase = await freeRange(3);
    const results = await Promise.all([firstBase, secondBase].map((base) => acquire({ slots: 1, scan: 3, base, checkout: "/mine", checkoutLock, fileTakeover: true })));
    try {
      expect(results.filter((result) => "release" in result)).toHaveLength(1);
      expect(results.find((result) => "refused" in result)).toMatchObject({ refused: "same-checkout", holders: [{ heldBy: process.pid, checkout: "/mine" }] });
      expect(JSON.parse(readFileSync(marker, "utf8")).pid).toBe(process.pid);
      expect(existsSync(`${marker}.reclaim`)).toBe(false);
    } finally { for (const result of results) release(result); }
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("names a process's start the same for runs in other time zones and locales", () => {
    // macOS reads it from ps, whose clock and words follow the caller's TZ and locale; ps on Linux does too
    const script = fileURLToPath(new URL("./check.ts", import.meta.url));
    const said = [{ TZ: "UTC", LC_ALL: "C" }, { TZ: "Asia/Seoul", LC_ALL: "fr_FR.UTF-8" }].map((zone) => {
      const child = spawnSync(process.execPath, ["-e", `const { processStart } = await import(${JSON.stringify(script)}); console.log(processStart(${process.pid}, "darwin"));`], { env: { ...process.env, ...zone }, encoding: "utf8" });
      expect(child.status, child.stderr).toBe(0);
      return child.stdout.trim();
    });
    expect(said[0]).not.toBe("null");
    expect(said[1]).toBe(said[0]!);
  });

  it.skipIf(process.platform !== "linux" || !Bun.which("perl"))("takes over a marker whose run has exited but is not reaped yet", async () => {
    const base = await freeRange(3);
    const checkoutLock = join(scratch(), "checkout.lock");
    const marker = `${checkoutLock}.check-lock`;
    // a parent that never reaps its child: the child exits at once, and the parent's SIGCHLD, which the
    // kernel sends as the child becomes a zombie, says so
    const parent = spawn("perl", ["-MPOSIX", "-e", '$| = 1; $SIG{CHLD} = sub { print "ZOMBIE\\n" }; my $pid = fork() // die "fork: $!"; POSIX::_exit(0) unless $pid; print "PID $pid\\n"; POSIX::pause() while 1;'], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      let said = "";
      const heard = new Promise<void>((resolve, reject) => {
        parent.stdout!.on("data", (chunk: Buffer) => { said += chunk.toString(); if (/^PID \d+$/m.test(said) && /^ZOMBIE$/m.test(said)) resolve(); });
        parent.once("exit", (code) => reject(new Error(`the parent exited (${code}) before its child was a zombie: ${said}`)));
      });
      await within(heard, 5_000, "the parent did not hear its child exit", () => said);
      const pid = Number(/^PID (\d+)$/m.exec(said)![1]);
      expect(readFileSync(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /);
      const started = processStart(pid);
      for (const claim of [{ pid, checkout: "/exited", start: started }, { pid, checkout: "/exited-old" }]) {
        writeFileSync(marker, JSON.stringify(claim));
        const result = await acquire({ slots: 0, scan: 3, base, checkout: "/mine", checkoutLock });
        try { expect(result).toMatchObject({ port: null }); }
        finally { release(result); }
      }
    } finally { parent.kill("SIGKILL"); }
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("takes over a dead marker although a draft a killed run left is still the same file", async () => {
    const base = await freeRange(3);
    const checkoutLock = join(scratch(), "checkout.lock");
    const marker = `${checkoutLock}.check-lock`;
    // a run killed between linking its draft into place and removing it, whose pid is this one's now
    writeFileSync(marker, JSON.stringify({ pid: process.pid, checkout: "/killed", start: "an-earlier-start" }));
    linkSync(marker, `${marker}.${process.pid}.draft`);
    const result = await acquire({ slots: 0, scan: 3, base, checkout: "/mine", checkoutLock });
    try {
      expect(result).toMatchObject({ port: null });
      expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ pid: process.pid, checkout: "/mine" });
    } finally { release(result); }
  });

  it("claims a report whose name is long, its working files named apart from it", async () => {
    const base = await freeRange(3);
    // 220 bytes: the claim's name (+ ".check-lock") fits under the 255-byte limit; a draft named after it would not
    const report = join(scratch(), `${"r".repeat(215)}.json`);
    const result = await acquire({ slots: 0, scan: 3, base, checkout: "/mine", reports: [report] });
    try { expect(result).toMatchObject({ port: null }); }
    finally { release(result); }
  });

  it("names no start rather than failing when the boot id cannot be read", () => {
    // a directory where the boot id should be: reading it fails, whoever runs the test
    expect(processStart(process.pid, "linux", scratch())).toBeNull();
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")("takes over a marker whose pid now belongs to a process that started later", async () => {
    const base = await freeRange(3);
    const checkoutLock = join(scratch(), "checkout.lock");
    const marker = `${checkoutLock}.check-lock`;
    const started = processStart(process.pid);
    expect(started).not.toBeNull();
    // the same pid, honoured while it is the process that wrote the claim
    writeFileSync(marker, JSON.stringify({ pid: process.pid, checkout: "/old", start: started }));
    const honoured = await acquire({ slots: 0, scan: 3, base, checkout: "/mine", checkoutLock });
    try { expect(honoured).toMatchObject({ refused: "same-checkout", holders: [{ heldBy: process.pid, checkout: "/old" }] }); }
    finally { release(honoured); }
    // a claim left by a run that is gone, its pid since given to this process
    writeFileSync(marker, JSON.stringify({ pid: process.pid, checkout: "/old", start: `${started}-earlier` }));
    const reused = await acquire({ slots: 0, scan: 3, base, checkout: "/mine", checkoutLock });
    try {
      expect(reused).toMatchObject({ port: null });
      expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({ pid: process.pid, checkout: "/mine", start: started });
    } finally { release(reused); }
  });

  for (const fileTakeover of process.platform === "linux" ? [false, true] : [true]) it(`admits exactly one cross-base contender reclaiming a stale checkout marker (${fileTakeover ? "reclaim file" : "takeover socket"})`, async () => {
    const checkoutLock = join(scratch(), "checkout.lock");
    const marker = `${checkoutLock}.check-lock`;
    const finished = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(finished.status).toBe(0);
    const script = fileURLToPath(new URL("./check.ts", import.meta.url));
    for (let round = 0; round < 10; round++) {
      writeFileSync(marker, JSON.stringify({ pid: Number(finished.stdout.trim()), checkout: "/dead" }));
      const firstBase = await freeRange(3);
      let secondBase = await freeRange(3);
      while (Math.abs(firstBase - secondBase) <= 3) secondBase = await freeRange(3);
      const bases = [firstBase, secondBase];
      const childCode = `import { readFileSync } from "node:fs"; import { acquire } from ${JSON.stringify(script)}; console.log("READY"); await new Promise(resolve => process.stdin.once("data", resolve)); const result = await acquire({ slots: 1, scan: 3, base: Number(process.env.BASE), checkout: "/same", checkoutLock: process.env.CHECKOUT_LOCK, fileTakeover: process.env.FILE_TAKEOVER === "1" }); console.log("RESULT " + ("release" in result ? "held " + process.pid + " " + readFileSync(process.env.CHECKOUT_LOCK + ".check-lock", "utf8") : result.refused)); if ("release" in result) { await new Promise(resolve => { process.stdin.once("data", resolve); process.stdin.once("end", resolve); }); result.release(); }`;
      const children = bases.map((base) => Bun.spawn([process.execPath, "-e", childCode], {
        env: { ...process.env, BASE: String(base), CHECKOUT_LOCK: checkoutLock, FILE_TAKEOVER: fileTakeover ? "1" : "0" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      }));
      const output = children.map(() => "");
      const readers = children.map((child) => child.stdout.getReader());
      const ready = readers.map(async (reader, index) => {
        while (!output[index]?.includes("READY")) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`cross-base contender ${index} exited before ready`);
          output[index] += new TextDecoder().decode(value);
        }
      });
      await Promise.all(ready);
      for (const child of children) child.stdin.write("GO");
      // the winner holds until both have answered, so the loser always meets a live claim
      const outcomes = await Promise.all(readers.map(async (reader, index) => {
        while (!/RESULT .*\n/.test(output[index] ?? "")) {
          const { value, done } = await within(reader.read(), 5_000, `cross-base contender ${index} gave no result in round ${round}`);
          if (done) break;
          output[index] += new TextDecoder().decode(value);
        }
        const result = /RESULT (.*)/.exec(output[index] ?? "")?.[1];
        return result?.startsWith("held ") ? "held" : result;
      }));
      for (const child of children) { child.stdin.write("RELEASE"); child.stdin.end(); }
      await Promise.all(children.map(async (child) => {
        const stderr = await new Response(child.stderr).text();
        expect(await within(child.exited, 5_000, `cross-base contender timed out in round ${round}`), stderr).toBe(0);
      }));
      // either contender may win; exactly one must
      expect({ outcomes: outcomes.sort(), bases }).toEqual({ outcomes: ["held", "same-checkout"], bases });
    }
  });

  it("tells runners that share a loopback apart although they check out to one path", async () => {
    const base = await freeRange(3);
    const path = "/w/herdr-web-ui/herdr-web-ui";
    expect(checkoutIdentity(path, {})).toBe(path);
    const first = checkoutIdentity(path, { RUNNER_NAME: "herdr-ci-pc-1" });
    const second = checkoutIdentity(path, { RUNNER_NAME: "herdr-ci-pc-2" });
    expect(first).not.toBe(second);
    const other = await lock(base, 111, first);
    try {
      const mine = await acquire({ slots: 2, scan: 3, base, pid: 222, checkout: second });
      expect(mine).toMatchObject({ port: base + 1 });
      release(mine);
      const again = await acquire({ slots: 2, scan: 3, base, pid: 222, checkout: first });
      expect(again).toEqual({ refused: "same-checkout", holders: [{ port: base, heldBy: 111, checkout: first }] });
    } finally {
      release(other);
    }
  });

  it("waits for a busy slot and takes it once its holder ends", async () => {
    const base = await freeRange(3);
    const holder = await lock(base, 111, "/a");
    let told: unknown = null;
    const waiting = acquireWaiting({ slots: 1, scan: 3, base, pid: 222, checkout: "/b" }, {
      waitMs: 10_000,
      pollMs: 20,
      onWait: (holders) => { told = holders; release(holder); },
    });
    const result = await waiting;
    try {
      expect(told).toEqual([{ port: base, heldBy: 111, checkout: "/a" }]);
      expect(result).toMatchObject({ port: base });
    } finally {
      release(result);
    }
  });

  it("stops waiting at its deadline, and never waits on a run in its own checkout", async () => {
    const base = await freeRange(3);
    const busy = await lock(base, 111, "/a");
    try {
      let waits = 0;
      // the clock moves only between rounds, by the poll interval: three rounds fit in the wait, whatever the PC's load
      let clock = 0;
      const late = await acquireWaiting({ slots: 1, scan: 3, base, pid: 222, checkout: "/b" }, {
        waitMs: 60, pollMs: 20, onWait: () => { waits += 1; }, now: () => clock, sleep: async (ms) => { clock += ms; },
      });
      expect(late).toEqual({ refused: "busy", holders: [{ port: base, heldBy: 111, checkout: "/a" }] });
      expect(waits).toBe(1);
      const now = await acquireWaiting({ slots: 2, scan: 3, base, pid: 222, checkout: "/a" }, { waitMs: 10_000, pollMs: 20, onWait: () => { waits += 1; } });
      expect(now).toEqual({ refused: "same-checkout", holders: [{ port: base, heldBy: 111, checkout: "/a" }] });
      expect(waits).toBe(1);
    } finally {
      release(busy);
    }
  });

  it("gives a freed slot to the run that has waited, not to one that arrives after it (#1881)", async () => {
    const base = await queueRange();
    const holder = await lock(base, 111, "/a");
    const waiter = stepper();
    // a run that found the PC busy, now between two rounds of its wait
    const waiting = acquireWaiting({ slots: 1, scan: 3, base, pid: 222, checkout: "/b" }, { waitMs: 60_000, now: () => 1_000, sleep: waiter.sleep });
    await waiter.asleep();
    release(holder);
    // the slot is free, and a run that arrives now would take it ahead of the one that waited
    const ticket = ticketPorts(base, 1, 3)[0]!;
    expect(await acquire({ slots: 1, scan: 3, base, pid: 333, checkout: "/c" }))
      .toEqual({ refused: "busy", holders: [{ port: ticket, heldBy: 222, checkout: "/b", queuedAt: 1_000 }] });
    waiter.wake();
    const admitted = await waiting;
    try {
      expect(admitted).toMatchObject({ port: base });
      // its place in the queue went with it: only the slot it now holds keeps the newer run out
      expect(await acquire({ slots: 1, scan: 3, base, pid: 333, checkout: "/c" }))
        .toEqual({ refused: "busy", holders: [{ port: base, heldBy: 222, checkout: "/b" }] });
    } finally {
      release(admitted);
    }
  });

  it("serves waiting runs in the order they first found the PC busy, whichever asks first", async () => {
    const base = await queueRange();
    const holder = await lock(base, 111, "/a");
    const [first, second] = [stepper(), stepper()];
    // the earlier run takes the higher ticket port, so the order can only come from the time
    const lowest = await lock(ticketPorts(base, 1, 3)[0]!, 999, "/filler");
    const earlier = acquireWaiting({ slots: 1, scan: 3, base, pid: 201, checkout: "/first" }, { waitMs: 60_000, now: () => 1_000, sleep: first.sleep });
    await first.asleep();
    release(lowest);
    const later = acquireWaiting({ slots: 1, scan: 3, base, pid: 202, checkout: "/second" }, { waitMs: 60_000, now: () => 2_000, sleep: second.sleep });
    await second.asleep();
    expect((await acquire({ slots: 1, scan: 3, base, pid: 203, checkout: "/probe" }))).toMatchObject({
      refused: "busy", holders: [{ port: ticketPorts(base, 1, 3)[1], queuedAt: 1_000 }, { port: ticketPorts(base, 1, 3)[0], queuedAt: 2_000 }],
    });
    // as the later run sees it, from its lower port: only the earlier run is ahead, its place being
    // by time, not by port
    expect(await acquire({ slots: 1, scan: 3, base, pid: 202, checkout: "/second", retry: true, ticket: { at: 2_000, port: ticketPorts(base, 1, 3)[0]! } }))
      .toEqual({ refused: "busy", holders: [{ port: ticketPorts(base, 1, 3)[1], heldBy: 201, checkout: "/first", queuedAt: 1_000 }] });
    release(holder);
    // the later run asks first, finds the slot free, and still lets the earlier one go first
    second.wake();
    await second.asleep();
    first.wake();
    const one = await earlier;
    expect(one).toMatchObject({ port: base });
    release(one);
    second.wake();
    const two = await later;
    try {
      expect(two).toMatchObject({ port: base });
    } finally {
      release(two);
    }
  });

  it("leaves the admission port to the head of the queue: a run behind it never takes the port", async () => {
    const base = await queueRange();
    // the admission port is held, as by the head of the queue in the middle of its own round
    const admissionPort = base + 3;
    const head = await takeTicket({ base, slots: 1, scan: 3, at: 1_000, pid: 201, checkout: "/head" });
    const admission = await lock(admissionPort, 201, "/head");
    const behind = await takeTicket({ base, slots: 1, scan: 3, at: 2_000, pid: 202, checkout: "/behind" });
    try {
      // the run behind finds its place without reaching for the port: refused by the head's ticket,
      // not by the port; were it to hold the port while it looked, the head could not get in
      expect(await acquire({ slots: 1, scan: 3, base, pid: 202, checkout: "/behind", ticket: behind!.ticket }))
        .toEqual({ refused: "busy", holders: [{ port: head!.ticket.port, heldBy: 201, checkout: "/head", queuedAt: 1_000 }] });
      // a run that just arrived holds no place yet: it meets its claims first, then the port
      expect(await acquire({ slots: 1, scan: 3, base, pid: 203, checkout: "/new" }))
        .toEqual({ refused: "busy", holders: [{ port: admissionPort, heldBy: 201, checkout: "/head" }] });
      // one that waits without a ticket (every ticket was held) stays off the port too
      expect(await acquire({ slots: 1, scan: 3, base, pid: 204, checkout: "/overflow", retry: true }))
        .toMatchObject({ refused: "busy", holders: [{ port: head!.ticket.port, heldBy: 201 }, { port: behind!.ticket.port, heldBy: 202 }] });
    } finally {
      release(admission);
      head?.release();
      behind?.release();
    }
  });

  it("tells a second run in the same checkout so at once, also while runs wait in the queue", async () => {
    const base = await queueRange();
    const checkoutLock = join(scratch(), "checkout.lock");
    const first = await acquire({ slots: 2, scan: 3, base, pid: process.pid, checkout: "/same", checkoutLock });
    const waiting = await takeTicket({ base, slots: 2, scan: 3, at: 1_000, pid: 301, checkout: "/other" });
    try {
      expect("release" in first).toBe(true);
      expect(await acquire({ slots: 2, scan: 3, base, pid: process.pid, checkout: "/same", checkoutLock })).toMatchObject({ refused: "same-checkout" });
    } finally {
      waiting?.release();
      release(first);
    }
  });

  it("does not wait on a ticket port whose listener keeps talking, ticket-like or not", async () => {
    const base = await queueRange();
    // one says a ticket's first word and then trickles, one chatters: neither ever closes
    const talkers = ["ticket\n", "hello\n"].map((first, index) => {
      const server = createServer((socket) => {
        socket.on("error", () => undefined);
        socket.write(first);
        // fixed wait: a peer that keeps a connection busy, which is what the lookup must not wait on
        const trickle = setInterval(() => socket.write("1"), 20);
        socket.on("close", () => clearInterval(trickle));
      });
      server.listen(ticketPorts(base, 1, 3)[index]!, "127.0.0.1");
      return server;
    });
    try {
      await Promise.all(talkers.map((server) => new Promise((resolve) => server.once("listening", resolve))));
      // neither is a waiting run, so the slot is this run's, and the lookup ended on its own
      const admitted = await acquire({ slots: 1, scan: 3, base, pid: 222, checkout: "/b" });
      expect(admitted).toMatchObject({ port: base });
      release(admitted);
    } finally {
      for (const server of talkers) server.close();
    }
  });

  it("tells a waiting run that its checkout is in use at once, not after its turn in the queue", async () => {
    const base = await queueRange();
    const checkoutLock = join(scratch(), "checkout.lock");
    const first = await acquire({ slots: 2, scan: 3, base, pid: process.pid, checkout: "/same", checkoutLock });
    const older = await takeTicket({ base, slots: 2, scan: 3, at: 1_000, pid: 301, checkout: "/other" });
    const mine = await takeTicket({ base, slots: 2, scan: 3, at: 2_000, pid: process.pid, checkout: "/same" });
    try {
      expect("release" in first).toBe(true);
      expect(await acquire({ slots: 2, scan: 3, base, pid: process.pid, checkout: "/same", checkoutLock, retry: true, ticket: mine!.ticket }))
        .toMatchObject({ refused: "same-checkout" });
    } finally {
      older?.release();
      mine?.release();
      release(first);
    }
  });

  it("takes places one run at a time: a run waits for the ticket desk, then takes the next place", async () => {
    const base = await queueRange();
    // another run looking at the places taken, about to take its own: a desk that stays taken past
    // the wait leaves the run without a place for this round
    const other = await lock(ticketDesk(base, 1, 3), 501, "/other");
    try {
      expect(await takeTicket({ base, slots: 1, scan: 3, at: 900, pid: 502, checkout: "/mine", deskWaitMs: 0 })).toBeNull();
      // one that frees the desk while this run waits for it lets it take its place in the same round
      const waiting = takeTicket({ base, slots: 1, scan: 3, at: 900, pid: 502, checkout: "/mine", deskWaitMs: 60_000 });
      release(other);
      const mine = await waiting;
      expect(mine).not.toBeNull();
      mine?.release();
    } finally {
      release(other);
    }
    // once it has its place, the next run takes one after it, whatever its clock says
    const first = await takeTicket({ base, slots: 1, scan: 3, at: 1_000, pid: 501, checkout: "/other" });
    const next = await takeTicket({ base, slots: 1, scan: 3, at: 900, pid: 502, checkout: "/mine" });
    try {
      expect(next!.ticket.at).toBeGreaterThan(first!.ticket.at);
    } finally {
      first?.release();
      next?.release();
    }
  });

  it("waits for the ticket desk no longer than CHECK_WAIT_SECONDS leaves", async () => {
    const base = await queueRange();
    const holder = await lock(base, 111, "/a");
    const desk = await lock(ticketDesk(base, 1, 3), 501, "/other");
    let clock = 1_000;
    // The desk is waited for on the monotonic clock: here one of the test's own, a thirtieth of the
    // desk's wait further on at every look, so a run that waits out the desk's own wait shows by the
    // clock and not by how fast this host is (#1939).
    let monotonic = 0;
    const looks = spyOn(performance, "now").mockImplementation(() => (monotonic += DESK_WAIT_MS / 30));
    try {
      // a wait of 1 ms, far shorter than the desk's own: the desk stays taken, and the run gives up within its wait
      const held = await acquireWaiting({ slots: 1, scan: 3, base, pid: 222, checkout: "/b" }, { waitMs: 1, now: () => clock, sleep: async (ms) => { clock += ms + 1; } });
      expect(held).toMatchObject({ refused: "busy" });
      expect(looks).toHaveBeenCalled();
      expect(monotonic).toBeLessThan(DESK_WAIT_MS / 2);
    } finally {
      looks.mockRestore();
      release(desk);
      release(holder);
    }
  });

  it("keeps the order when the clock steps back: a later place still comes after every waiting one", async () => {
    const base = await queueRange();
    const earlier = await takeTicket({ base, slots: 1, scan: 3, at: 1_000, pid: 401, checkout: "/earlier" });
    // the clock was set back between the two
    const later = await takeTicket({ base, slots: 1, scan: 3, at: 900, pid: 402, checkout: "/later" });
    try {
      expect(later!.ticket.at).toBeGreaterThan(earlier!.ticket.at);
      expect(await acquire({ slots: 1, scan: 3, base, pid: 402, checkout: "/later", retry: true, ticket: later!.ticket }))
        .toEqual({ refused: "busy", holders: [{ port: earlier!.ticket.port, heldBy: 401, checkout: "/earlier", queuedAt: 1_000 }] });
      const head = await acquire({ slots: 1, scan: 3, base, pid: 401, checkout: "/earlier", retry: true, ticket: earlier!.ticket });
      expect(head).toMatchObject({ port: base });
      release(head);
    } finally {
      earlier?.release();
      later?.release();
    }
  });

  it("gives its place up when it stops waiting, and waits without one when every ticket is held", async () => {
    const base = await queueRange();
    const holder = await lock(base, 111, "/a");
    let clock = 1_000;
    const waiter = stepper();
    const late = acquireWaiting({ slots: 1, scan: 3, base, pid: 222, checkout: "/b" }, { waitMs: 5_000, now: () => clock, sleep: waiter.sleep });
    await waiter.asleep();
    clock = 6_000;
    waiter.wake();
    expect(await late).toMatchObject({ refused: "busy" });
    release(holder);
    // out of time, it left no place behind to hold the next run back
    const next = await acquire({ slots: 1, scan: 3, base, pid: 333, checkout: "/c" });
    expect(next).toMatchObject({ port: base });
    // every ticket port taken: a run still waits, and is served when the slot frees
    // one after another: the ticket desk takes one run at a time
    const tickets: Awaited<ReturnType<typeof takeTicket>>[] = [];
    for (const _ of ticketPorts(base, 1, 3)) tickets.push(await takeTicket({ base, slots: 1, scan: 3, at: 500, pid: 444, checkout: "/queued" }));
    expect(tickets.every((ticket) => ticket !== null)).toBe(true);
    expect(await takeTicket({ base, slots: 1, scan: 3, at: 600, pid: 555, checkout: "/none" })).toBeNull();
    const overflow = stepper();
    const crowded = acquireWaiting({ slots: 1, scan: 3, base, pid: 555, checkout: "/none" }, { waitMs: 60_000, now: () => 700, sleep: overflow.sleep });
    await overflow.asleep();
    release(next);
    for (const ticket of tickets) ticket?.release();
    overflow.wake();
    const served = await crowded;
    try {
      expect(served).toMatchObject({ port: base });
    } finally {
      release(served);
    }
  });

  it("reads CHECK_WAIT_SECONDS as 0 to 7200, else no wait", () => {
    expect(waitSeconds({})).toBe(0);
    expect(waitSeconds({ CHECK_WAIT_SECONDS: "" })).toBe(0);
    expect(waitSeconds({ CHECK_WAIT_SECONDS: "0" })).toBe(0);
    expect(waitSeconds({ CHECK_WAIT_SECONDS: "1800" })).toBe(1800);
    expect(waitSeconds({ CHECK_WAIT_SECONDS: "7200" })).toBe(7200);
    for (const value of ["7201", "-1", "1.5", "ten", " 30"]) expect(() => waitSeconds({ CHECK_WAIT_SECONDS: value })).toThrow("CHECK_WAIT_SECONDS");
  });

  it("reads CHECK_MAX_RUNS as 1 to 8, else one slot per eight cores, from 1 to 2", () => {
    expect(maxRuns({}, 32)).toBe(2);
    expect(maxRuns({}, 64)).toBe(2);
    expect(maxRuns({}, 16)).toBe(2);
    expect(maxRuns({}, 15)).toBe(1);
    expect(maxRuns({}, 4)).toBe(1);
    expect(maxRuns({ CHECK_MAX_RUNS: "" }, 32)).toBe(2);
    expect(maxRuns({ CHECK_MAX_RUNS: "1" }, 32)).toBe(1);
    expect(maxRuns({ CHECK_MAX_RUNS: "8" }, 4)).toBe(8);
    for (const value of ["0", "9", "-1", "1.5", "two", " 3"]) expect(() => maxRuns({ CHECK_MAX_RUNS: value }, 32)).toThrow("CHECK_MAX_RUNS");
  });

  it("lets a CI host's own limits replace the workflow's, and leaves them when the host names none", () => {
    const workflow = { CHECK_MAX_RUNS: "3", HERDR_TEST_SHARDS: "4", BROWSER_WORKERS: "6", UNIT_TEST_WORKERS: "4" };
    const host: Record<string, string | undefined> = { ...workflow, CHECK_HOST_MAX_RUNS: "6", CHECK_HOST_TEST_SHARDS: "8", CHECK_HOST_BROWSER_WORKERS: "12", CHECK_HOST_UNIT_WORKERS: "" };
    applyHostLimits(host);
    expect(host).toMatchObject({ CHECK_MAX_RUNS: "6", HERDR_TEST_SHARDS: "8", BROWSER_WORKERS: "12", UNIT_TEST_WORKERS: "4" });
    expect(maxRuns(host, 4)).toBe(6);
    const plain: Record<string, string | undefined> = { ...workflow };
    applyHostLimits(plain);
    expect(plain).toEqual(workflow);
    const bad: Record<string, string | undefined> = { CHECK_MAX_RUNS: "3", CHECK_HOST_MAX_RUNS: "12" };
    applyHostLimits(bad);
    expect(() => maxRuns(bad, 32)).toThrow("CHECK_MAX_RUNS");
  });

  it("applies a CI host's limits before a run takes a slot", () => {
    // the workflow's 3 is valid; only the host's 12, applied by main(), stops the run, before any herdr starts
    const env: Record<string, string | undefined> = { ...process.env, CHECK_MAX_RUNS: "3", CHECK_HOST_MAX_RUNS: "12" };
    delete env["CHECK_DIR"];
    delete env["CHECK_REPORT"];
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check.ts", import.meta.url)), "run", "--", "true"], {
      env, encoding: "utf8", timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CHECK_MAX_RUNS must be a whole number from 1 to 8, not \"12\"");
  });

  it("refuses the paused contender when an earlier holder turns over to its checkout", async () => {
    const base = await freeRange(4);
    let resume: () => void = () => {};
    let observed: () => void = () => {};
    const paused = new Promise<void>((resolve) => { observed = resolve; });
    const old = createServer((socket) => {
      resume = () => socket.end("111\n/other");
      old.close();
      observed();
    });
    await new Promise<void>((resolve) => old.listen(base, "127.0.0.1", resolve));
    let replacement: Awaited<ReturnType<typeof lock>> | undefined;
    const contender = acquire({ slots: 2, scan: 3, base, pid: 222, checkout: "/mine" });
    try {
      await paused;
      replacement = await lock(base, 333, "/mine");
      expect("release" in replacement).toBe(true);
      resume();
      const result = await contender;
      try {
        expect(result).toMatchObject({ refused: "same-checkout", holders: [{ port: base, heldBy: 333, checkout: "/mine" }] });
      } finally { release(result); }
    } finally {
      resume();
      old.close();
      if (replacement) release(replacement);
    }
  });

  it("counts a higher slot when a new run lowers the PC-wide capacity", async () => {
    const base = await freeRange(4);
    const higher = await lock(base + 1, 111, "/other");
    try {
      const result = await acquire({ slots: 1, scan: 3, base, pid: 222, checkout: "/mine" });
      try {
        expect(result).toEqual({ refused: "busy", holders: [{ port: base + 1, heldBy: 111, checkout: "/other" }] });
      } finally { release(result); }
      const first = await lock(base, 333);
      expect("release" in first).toBe(true);
      release(first);
    } finally { release(higher); }
  });

  for (const resource of ["CHECK_DIR", "CHECK_REPORT"]) {
    it(`refuses different checkouts sharing a canonical ${resource}`, async () => {
      const base = await freeRange(4);
      const dir = scratch();
      const alias = join(scratch(), "alias");
      symlinkSync(dir, alias, process.platform === "win32" ? "junction" : "dir");
      const path = resource === "CHECK_DIR" ? dir : join(dir, "report.json");
      const aliasPath = resource === "CHECK_DIR" ? alias : join(alias, "report.json");
      const first = await acquire({ slots: 2, scan: 3, base, checkout: "/first", resources: [path] });
      try {
        expect("release" in first).toBe(true);
        const second = await acquire({ slots: 2, scan: 3, base, checkout: "/second", resources: [aliasPath] });
        try { expect(second).toMatchObject({ refused: "resource" }); }
        finally { release(second); }
      } finally { release(first); }
      const next = await acquire({ slots: 2, scan: 3, base, checkout: "/second", resources: [aliasPath] });
      expect("release" in next).toBe(true);
      release(next);
    });
  }

  it("reclaims only a dead owner's marker and rolls back partial resource claims", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const finished = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
    expect(finished.status).toBe(0);
    const marker = join(dir, ".check-lock");
    writeFileSync(marker, JSON.stringify({ pid: Number(finished.stdout.trim()), checkout: "/dead" }));
    const first = await acquire({ slots: 0, scan: 3, base, checkout: "/first", resources: [dir] });
    try {
      expect("release" in first).toBe(true);
      expect(JSON.parse(readFileSync(marker, "utf8")).pid).toBe(process.pid);
      const free = join(scratch(), "report.json");
      const refused = await acquire({ slots: 0, scan: 3, base, checkout: "/second", resources: [free, dir] });
      try {
        expect(refused).toMatchObject({ refused: "resource" });
        expect(existsSync(`${free}.check-lock`)).toBe(false);
        expect(existsSync(marker)).toBe(true);
      } finally { release(refused); }
    } finally { release(first); }
    expect(existsSync(marker)).toBe(false);
  });

  it("recovers from a corrupt resource marker instead of crashing", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const marker = join(dir, ".check-lock");
    writeFileSync(marker, "{ truncated");
    const result = await acquire({ slots: 0, scan: 3, base, checkout: "/mine", resources: [dir] });
    try {
      expect("release" in result).toBe(true);
      expect(JSON.parse(readFileSync(marker, "utf8")).pid).toBe(process.pid);
    } finally { release(result); }
    expect(existsSync(marker)).toBe(false);
  });

  it("locks a file resource by its name, not a symlink target that renameSync replaces", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const target = join(dir, "previous.json");
    const link = join(dir, "latest.json");
    writeFileSync(target, "{}");
    symlinkSync(target, link);
    const first = await acquire({ slots: 0, scan: 3, base, checkout: "/first", reports: [link] });
    try {
      expect("release" in first).toBe(true);
      // Simulate persistReport replacing the symlink with a regular file
      rmSync(link);
      writeFileSync(link, '{"replaced": true}');
      const second = await acquire({ slots: 0, scan: 3, base, checkout: "/second", reports: [link] });
      try { expect(second).toMatchObject({ refused: "resource" }); }
      finally { release(second); }
    } finally { release(first); }
  });

  it("locks a report by its name when the name is a symlink to a directory", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const target = join(dir, "previous");
    const link = join(dir, "latest.json");
    mkdirSync(target);
    symlinkSync(target, link);
    const first = await acquire({ slots: 0, scan: 3, base, checkout: "/first", reports: [link] });
    try {
      expect("release" in first).toBe(true);
      expect(existsSync(join(target, ".check-lock"))).toBe(false);
      // persistReport's rename puts a regular file where the symlink was
      rmSync(link);
      writeFileSync(link, '{"replaced": true}');
      const second = await acquire({ slots: 0, scan: 3, base, checkout: "/second", reports: [link] });
      try { expect(second).toMatchObject({ refused: "resource" }); }
      finally { release(second); }
    } finally { release(first); }
  });

  it("leaves a marker it cannot read where it is, and does not claim the resource", async () => {
    const base = await freeRange(3);
    const dir = scratch();
    const marker = join(dir, ".check-lock");
    // a read that fails for a reason other than its content, whoever runs the test: the name
    // exists and can be unlinked, but reading it answers EISDIR
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), marker);
    await expect(acquire({ slots: 0, scan: 3, base, checkout: "/mine", resources: [dir] })).rejects.toThrow();
    expect(lstatSync(marker).isSymbolicLink()).toBe(true);
  });

  it("leaves the PC to a run from before slots, which names no checkout", async () => {
    const base = await freeRange(3);
    const old = await lock(base, 111);
    if (!("release" in old)) throw new Error("the first slot was free");
    try {
      const refused = await acquire({ slots: 2, scan: 3, base, checkout: "/mine" });
      try { expect(refused).toEqual({ refused: "busy", holders: [{ port: base, heldBy: 111 }] }); }
      finally { release(refused); }
      // the candidate slot it took while asking is free again
      const next = await lock(base + 1, 222, "/other");
      expect("release" in next).toBe(true);
      if ("release" in next) next.release();
    } finally { old.release(); }
  });

  it("serializes simultaneous admission without leaving a candidate slot behind", async () => {
    const base = await freeRange(3);
    const results = await Promise.all([
      acquire({ slots: 1, scan: 3, base, checkout: "/first" }),
      acquire({ slots: 1, scan: 3, base, checkout: "/second" }),
    ]);
    try { expect(results.filter((result) => "release" in result)).toHaveLength(1); }
    finally { for (const result of results) release(result); }
    const next = await acquire({ slots: 1, scan: 3, base, checkout: "/third" });
    expect("release" in next).toBe(true);
    release(next);
  });
});

/** Resolves once `stream` has said `text`, whenever it says it, before or after the call. */
const listen = (stream: Readable): ((text: string) => Promise<void>) => {
  let said = "";
  const waiting: { text: string; resolve: () => void }[] = [];
  stream.on("data", (chunk: Buffer) => {
    said += chunk.toString();
    for (const waiter of waiting.splice(0)) if (said.includes(waiter.text)) waiter.resolve(); else waiting.push(waiter);
  });
  return (text) => new Promise((resolve) => { if (said.includes(text)) resolve(); else waiting.push({ text, resolve }); });
};
const errno = (code: string): Error => Object.assign(new Error(`${code} (fixture)`), { code });
/** Settles as `promise` does, or fails naming `what` (and `detail()`) once `ms` pass without it. */
const within = <T>(promise: Promise<T>, ms: number, what: string, detail: () => string = () => ""): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} within ${ms} ms ${detail()}`.trim())), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
/** A process's state and parent, for a failure that names where a lifecycle stopped. */
const processState = (pid: number): string => {
  try { return readFileSync(`/proc/${pid}/status`, "utf8").split("\n").filter((line) => /^(?:State|PPid):/.test(line)).join(", "); }
  catch (error) { return `pid ${pid}: ${(error as NodeJS.ErrnoException).code ?? "no /proc"}`; }
};

describe("endGroup", () => {
  it.skipIf(process.platform === "win32")("waits for a leaderless group until its descendant exits", async () => {
    // The descendant says when SIGTERM reached it, then exits once released. Its handler can take
    // effect after the code that installs it has run, and a SIGTERM before that kills it silently:
    // it is ready only once the handler has caught a SIGTERM it sent itself. A timer keeps it alive
    // (a read on the stdin it inherits sometimes let it exit on its own), and SIGUSR1 releases it.
    const descendant = 'let caught = 0; process.on("SIGTERM", () => process.stdout.write(caught++ === 0 ? `READY ${process.pid}\\n` : "TERM\\n")); process.on("SIGUSR1", () => process.exit(0)); setInterval(() => {}, 1 << 30); process.kill(process.pid, "SIGTERM");';
    const leader = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" }).unref();`;
    const parent = spawn(process.execPath, ["-e", leader], { detached: true, stdio: ["pipe", "pipe", "inherit"] });
    const group = parent.pid!;
    // Every step of the lifecycle is an event, subscribed before it can happen, and each has a
    // deadline that names the step it stopped at: a hang becomes a failure that says where.
    const leaderExited = new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    // the descendant holds the pipe's last writer once the leader is gone: its end is the descendant's exit
    const outputEnded = new Promise<void>((resolve) => { parent.stdout!.once("end", () => resolve()); parent.stdout!.once("close", () => resolve()); });
    let said = "";
    parent.stdout!.on("data", (chunk: Buffer) => { said += chunk.toString(); });
    const saw = listen(parent.stdout!);
    const STEP_MS = 12_000;
    try {
      await within(saw("READY"), STEP_MS, "the descendant did not start");
      await within(leaderExited, STEP_MS, "the leader did not exit");
      const pid = Number(/READY (\d+)/.exec(said)?.[1]);
      let released = false;
      let reapDeadline = Number.POSITIVE_INFINITY;
      const outcome = await endGroup(group, "SIGTERM", {
        // endGroup's clock stands still: only the descendant's exit ends the wait, never SIGKILL
        now: () => 0,
        wait: async () => {
          if (!released) {
            await within(saw("TERM"), STEP_MS, "SIGTERM did not reach the descendant:", () => processState(pid));
            released = true;
            process.kill(pid, "SIGUSR1");
            await within(outputEnded, STEP_MS, "the released descendant did not exit:", () => processState(pid));
            // an exited process stays in its group until the process that adopted it reaps it
            reapDeadline = Date.now() + STEP_MS;
          } else if (Date.now() > reapDeadline) {
            throw new Error(`the exited descendant was not reaped within ${STEP_MS} ms: ${processState(pid)}`);
          }
          await new Promise((resolve) => setImmediate(resolve));
        },
      });
      expect(released).toBe(true);
      expect(outcome).toEqual({ pgid: group, result: "gone", signals: ["SIGTERM"], cause: null });
      expect(() => process.kill(-group, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      parent.stdin!.destroy();
      try { process.kill(-group, "SIGKILL"); } catch { /* already gone */ }
    }
  }, 70_000);

  it("fails after SIGKILL cannot empty the group", async () => {
    let clock = 0;
    const calls: [number, NodeJS.Signals | 0][] = [];
    const outcome = await endGroup(4242, "SIGTERM", {
      kill: (pid, signal) => { expect(pid).toBe(-4242); calls.push([clock, signal]); },
      now: () => clock,
      wait: async (ms) => { clock += ms; },
    });
    expect(outcome).toEqual({ pgid: 4242, result: "surviving", signals: ["SIGTERM", "SIGKILL"], cause: "still running after SIGKILL" });
    // TERM first; KILL only once the 5 s grace has passed; then probes until the 2 s kill grace has
    const sent = calls.filter(([, signal]) => signal !== 0);
    expect(sent.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    const killAt = sent[1]![0];
    expect(killAt).toBeGreaterThanOrEqual(5_000);
    expect(killAt).toBeLessThan(6_000);
    expect(calls.at(1)).toEqual([0, 0]);
    expect(clock - killAt).toBeGreaterThanOrEqual(2_000);
    expect(clock - killAt).toBeLessThan(3_000);
    expect(describeGroup(outcome)).toContain("4242");
  });

  it("treats EPERM as unproved death", async () => {
    let clock = 0;
    const seams = (kill: (signal: NodeJS.Signals | 0) => void) => ({ kill: (_pid: number, signal: NodeJS.Signals | 0) => kill(signal), now: () => clock, wait: async (ms: number) => { clock += ms; } });
    // a probe answered EPERM is a process still there: escalate, then fail
    const unprovable = await endGroup(7, "SIGINT", seams((signal) => { if (signal === 0) throw errno("EPERM"); }));
    expect(unprovable).toMatchObject({ result: "surviving", signals: ["SIGINT", "SIGKILL"] });
    expect(unprovable.cause).toContain("EPERM");
    // a signal that may not be sent proves nothing either, and SIGKILL would not be allowed
    const sent: (NodeJS.Signals | 0)[] = [];
    const refused = await endGroup(7, "SIGTERM", seams((signal) => { sent.push(signal); throw errno("EPERM"); }));
    expect(refused).toMatchObject({ result: "error", signals: ["SIGTERM"] });
    expect(refused.cause).toContain("EPERM");
    expect(sent).toEqual(["SIGTERM"]);
    // only ESRCH is proof: at once, or after a few probes, and without SIGKILL
    expect(await endGroup(7, "SIGTERM", seams(() => { throw errno("ESRCH"); }))).toEqual({ pgid: 7, result: "gone", signals: ["SIGTERM"], cause: null });
    let probes = 0;
    expect(await endGroup(7, "SIGTERM", seams((signal) => { if (signal === 0 && ++probes > 1) throw errno(probes > 2 ? "ESRCH" : "EPERM"); })))
      .toEqual({ pgid: 7, result: "gone", signals: ["SIGTERM"], cause: null });
  });
});

describe("teardown", () => {
  it("stops every live session and names each that failed", async () => {
    const sessions = join(scratch(), "sessions");
    for (const session of ["a", "b", "c", "stopped"]) mkdirSync(join(sessions, session), { recursive: true });
    for (const session of ["a", "b", "c"]) writeFileSync(join(sessions, session, "herdr.sock"), "");
    const asked: string[] = [];
    const results: Record<string, Parameters<typeof stopSessions>[1] extends (session: string) => infer R ? R : never> = {
      a: { error: errno("ENOENT"), status: null, signal: null },
      b: { status: 1, signal: null, stderr: "server is not running\n" },
      c: { status: 0, signal: null },
    };
    await expect(stopSessions(sessions, (session) => { asked.push(session); return results[session]!; }, async () => {})).rejects.toThrow(/a \(ENOENT.*b \(herdr server stop exited with code 1: server is not running\)/);
    expect(asked.sort()).toEqual(["a", "b", "c"]);
    await expect(stopSessions(sessions, () => ({ status: null, signal: "SIGTERM" }), async () => {})).rejects.toThrow("terminated by SIGTERM");
    await stopSessions(join(sessions, "none"), () => { throw new Error("nothing to stop"); });
  });

  it("accepts refused or missing sockets after a failed stop, but not live or unproven sockets", async () => {
    const sessions = join(scratch(), "sessions");
    const socket = join(sessions, "stale", "herdr.sock");
    mkdirSync(join(sessions, "stale"), { recursive: true });
    writeFileSync(socket, "");
    const stop = () => ({ status: 1, signal: null, stderr: "Connection refused" });
    for (const code of ["ECONNREFUSED", "ENOENT"]) {
      await stopSessions(sessions, stop, async (path) => { expect(path).toBe(socket); throw errno(code); });
    }
    await expect(stopSessions(sessions, stop, async () => {})).rejects.toThrow("stale");
    await expect(stopSessions(sessions, stop, async () => { throw errno("EACCES"); })).rejects.toThrow("EACCES");
  });

  it.skipIf(process.platform === "win32")("probes actual socket connections after a failed stop", async () => {
    const sessions = join(scratch(), "sessions");
    const socket = join(sessions, "owned", "herdr.sock");
    mkdirSync(join(sessions, "owned"), { recursive: true });
    const server = createServer((client) => client.end());
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
      await expect(stopSessions(sessions, () => ({ status: 1, signal: null }))).rejects.toThrow("owned");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    // A file with no listener gives the same ECONNREFUSED as a socket left after SIGKILL.
    writeFileSync(socket, "");
    await stopSessions(sessions, () => ({ status: 1, signal: null }));
    await stopSessions(sessions, () => { rmSync(socket); return { status: 1, signal: null }; });
  });

  it("retains isolation and reports a cleanup exception", async () => {
    const isolation = isolate({});
    made.push(isolation.dir);
    const evidence = join(isolation.env["OVIS_STATE_DIR"]!, "evidence.txt");
    writeFileSync(evidence, "left behind");
    const order: string[] = [];
    const failed = await teardown([() => { order.push("first"); throw new Error("stop exploded"); }, async () => { order.push("second"); }], isolation);
    expect(order).toEqual(["first", "second"]);
    expect(failed).toEqual({ failures: ["stop exploded"], retained: isolation.dir });
    expect(isAbsolute(failed.retained!)).toBe(true);
    expect(readFileSync(evidence, "utf8")).toBe("left behind");
    // a process group that did not end keeps it too, although every stop worked
    expect(await teardown([() => undefined], isolation, ["step process group 1 did not end"])).toEqual({ failures: [], retained: isolation.dir });
    // a removal that fails is a failure of its own, and names what is left
    expect(await teardown([], { dir: isolation.dir, remove: () => { throw new Error("EBUSY (fixture)"); } }))
      .toEqual({ failures: [`could not remove ${isolation.dir}: EBUSY (fixture)`], retained: isolation.dir });
    expect(existsSync(evidence)).toBe(true);
    // nothing failed: the implicit directory goes
    expect(await teardown([() => undefined], isolation)).toEqual({ failures: [], retained: null });
    expect(existsSync(isolation.dir)).toBe(false);
  });
});

describe("check CLI teardown", () => {
  const checkScript = fileURLToPath(new URL("./check.ts", import.meta.url));
  // two sessions with a socket each, as a herdr server leaves them, and a file of the command's
  const sessionsCommand = 'for s in fx-1 fx-2; do mkdir -p "$XDG_CONFIG_HOME/herdr/sessions/$s" && : > "$XDG_CONFIG_HOME/herdr/sessions/$s/herdr.sock"; done; echo kept > "$OVIS_STATE_DIR/evidence.txt"';
  type Report = { status: string; exitCode: number; errors: string[]; verification: { status: string }; evidence: { retained: string[] }; steps: { name: string; status: string }[] };
  /** A repository to check, and a herdr stand-in that records each stop and fails it when asked: no real herdr is involved. */
  const fixture = (stopFails: boolean) => {
    const root = scratch();
    const script = join(root, "check.ts");
    // Failed-stop cases stand in for sessions whose sockets still answer after stop returns.
    writeFileSync(script, `import { main } from ${JSON.stringify(checkScript)};\nawait main({ probeSession: async () => {} });\n`);
    const herdr = join(root, "herdr");
    writeFileSync(herdr, '#!/bin/sh\ncase "$1" in --version) echo "herdr 0.9.3"; exit 0;; esac\necho "$2" >> "$STUB_LOG"\nif [ -n "$STUB_STOP_FAIL" ]; then echo "cannot stop $2" >&2; exit 1; fi\nrm -f "$XDG_CONFIG_HOME/herdr/sessions/$2/herdr.sock"\n');
    chmodSync(herdr, 0o755);
    const cwd = join(root, "repo");
    mkdirSync(cwd);
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "check test");
    git(cwd, "config", "user.email", "check@example.invalid");
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n.check/\n");
    git(cwd, "add", ".gitignore");
    git(cwd, "commit", "-qm", "fixture");
    const env: Record<string, string | undefined> = {
      ...process.env,
      CHECK_REPORT: ".check/report.json",
      // slots, an admission port and a queue of its own: on the PC's (or a CI host's) shared lock
      // range these throwaway runs would wait in line behind every real run waiting for a slot
      CHECK_LOCK_PORT: String(freePortRange(MAX_RUNS_LIMIT)),
      CHECK_MAX_RUNS: "8",
      CHECK_WAIT_SECONDS: "90",
      OVIS_HERDR_BIN: herdr,
      STUB_LOG: join(root, "stops.log"),
      STUB_STOP_FAIL: stopFails ? "1" : "",
    };
    // A runner host's own limits (CHECK_HOST_*, from its env file) outrank CHECK_MAX_RUNS in the
    // check: left in, they would set these throwaway runs' slot count to the host's, not the 8 asked
    // for here (#1875).
    for (const name of ["CHECK_DIR", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "HERDR_TEST_LIVE", ...Object.keys(HOST_LIMITS)]) delete env[name];
    const stops = (): string[] => existsSync(join(root, "stops.log")) ? readFileSync(join(root, "stops.log"), "utf8").split("\n").filter(Boolean).sort() : [];
    const report = (path = join(cwd, ".check", "report.json")): Report => JSON.parse(readFileSync(path, "utf8")) as Report;
    const isolated = (stdout: string): string => /config and state in (\S+)/.exec(stdout)?.[1] ?? "";
    const runCheck = (command: string, extra: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [script, "run", "sh", "-c", command], {
      cwd, env: { ...env, ...extra }, encoding: "utf8", timeout: 200_000,
    });
    return { cwd, env, stops, report, isolated, runCheck, script };
  };

  it.skipIf(process.platform === "win32")("removes implicit state, keeps a named CHECK_DIR and releases its claims after the final report", () => {
    const { cwd, stops, report, isolated, runCheck } = fixture(false);
    const implicit = runCheck(sessionsCommand);
    expect(implicit.status).toBe(0);
    const dir = isolated(implicit.stdout);
    expect(isAbsolute(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(stops()).toEqual(["fx-1", "fx-2"]);
    expect(report()).toMatchObject({ status: "success", exitCode: 0, errors: [], verification: { status: "verified" }, evidence: { retained: [] } });
    expect(existsSync(join(cwd, ".check", "report.json.check-lock"))).toBe(false);

    const named = join(cwd, ".check", "named");
    const kept = runCheck(sessionsCommand, { CHECK_DIR: named, CHECK_REPORT: undefined });
    expect(kept.status).toBe(0);
    expect(isolated(kept.stdout)).toBe(named);
    expect(readFileSync(join(named, "web-state", "evidence.txt"), "utf8")).toBe("kept\n");
    expect(report(join(named, "report.json"))).toMatchObject({ status: "success", exitCode: 0, evidence: { retained: [] } });
    expect(existsSync(join(named, ".check-lock"))).toBe(false);
  }, 420_000);

  it.skipIf(process.platform === "win32")("fails a zero-exit command when teardown fails", () => {
    const { stops, report, isolated, runCheck } = fixture(true);
    const result = runCheck(sessionsCommand);
    const dir = isolated(result.stdout);
    made.push(dir);
    expect(result.status).toBe(1);
    const failed = report();
    expect(failed).toMatchObject({ status: "failure", exitCode: 1, verification: { status: "unknown" }, evidence: { retained: [dir] } });
    expect(failed.steps.find((step) => step.name === "run")?.status).toBe("success");
    expect(failed.errors.some((error) => error.startsWith("teardown: could not stop herdr session fx-1") && error.includes("fx-2"))).toBe(true);
    // every stop was tried, and what they left is where the run said
    expect(stops()).toEqual(["fx-1", "fx-2"]);
    expect(isAbsolute(dir)).toBe(true);
    expect(result.stderr).toContain(dir);
    expect(readFileSync(join(dir, "web-state", "evidence.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(dir, "config", "herdr", "sessions", "fx-2", "herdr.sock"))).toBe(true);
  }, 210_000);

  it.skipIf(process.platform === "win32")("preserves interruption codes and retained teardown evidence", async () => {
    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
      const { cwd, env, stops, report, isolated, script } = fixture(true);
      // `read` waits on the check's stdin, which stays open: the command runs until the signal. The
      // check echoes the command line, so the marker is spelled so that only the command prints it.
      const check = spawn(process.execPath, [script, "run", "sh", "-c", `${sessionsCommand}; echo "RE""ADY"; read line`], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const exited = new Promise<number | null>((resolve) => check.once("exit", (exitCode) => resolve(exitCode)));
      let stdout = "";
      check.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      const saw = listen(check.stdout!);
      try {
        await within(saw("READY"), 150_000, "the command did not start");
        check.kill(signal);
        expect(await within(exited, 30_000, "the interrupted run did not finish")).toBe(code);
      } finally {
        check.kill("SIGKILL");
      }
      const dir = isolated(stdout);
      made.push(dir);
      const interrupted = report();
      expect(interrupted).toMatchObject({ status: "interrupted", exitCode: code, verification: { status: "unknown" }, evidence: { retained: [dir] } });
      expect(interrupted.steps.find((step) => step.name === "run")?.status).toBe("interrupted");
      expect(interrupted.errors.some((error) => error.startsWith("teardown: could not stop herdr session"))).toBe(true);
      expect(stops()).toEqual(["fx-1", "fx-2"]);
      expect(readFileSync(join(dir, "web-state", "evidence.txt"), "utf8")).toBe("kept\n");
    }
  }, 420_000);

  it.skipIf(process.platform === "win32")("ends what a zero-exit command left running with its output closed", () => {
    const { cwd, report, isolated, runCheck } = fixture(false);
    const pidFile = join(cwd, "..", "left.pid");
    // the command exits 0 at once; what it started runs on in its process group, its output closed
    const result = runCheck(`${sessionsCommand}; tail -f /dev/null </dev/null >/dev/null 2>&1 & echo $! > "$LEFT_PID"`, { LEFT_PID: pidFile });
    const left = Number(readFileSync(pidFile, "utf8"));
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("ended processes left running in step process group");
      // ended (and reaped) before the run removed what the process could have been using
      expect(() => process.kill(left, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(existsSync(isolated(result.stdout))).toBe(false);
      const ended = report();
      expect(ended).toMatchObject({ status: "success", exitCode: 0, errors: [], evidence: { retained: [] } });
      expect(ended.steps.find((step) => step.name === "run")).toMatchObject({ status: "success", reason: "ended processes the command left running" });
    } finally {
      try { process.kill(left, "SIGKILL"); } catch { /* already gone */ }
    }
  }, 210_000);

  it.skipIf(process.platform === "win32")("finalizes an interrupted run whose step group cannot be stopped", async () => {
    const { cwd, env, report, isolated } = fixture(false);
    // Only this check's groups are denied, as if the step ran as another user.
    const deny = join(cwd, "..", "deny-groups.ts");
    writeFileSync(deny, `import { main } from ${JSON.stringify(checkScript)};\nawait main({ kill() { throw Object.assign(new Error("EPERM (fixture)"), { code: "EPERM" }); } });\n`);
    // A listener survives even when the checker closes stdin; only our explicit cleanup ends it.
    const command = 'Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response(); } }); console.log("GRO" + "UP " + process.pid);';
    const check = spawn(process.execPath, [deny, "run", process.execPath, "-e", command], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => check.once("exit", (exitCode) => resolve(exitCode)));
    let stdout = "";
    check.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const saw = listen(check.stdout!);
    let group = 0;
    try {
      await within(saw("GROUP "), 150_000, "the command did not start");
      group = Number(/GROUP (\d+)/.exec(stdout)?.[1]);
      check.kill("SIGINT");
      // the run ends with its code although the step it could not stop never settles
      expect(await within(exited, 30_000, "the interrupted run did not finish")).toBe(130);
      expect(() => process.kill(-group, 0)).not.toThrow();
      const dir = isolated(stdout);
      made.push(dir);
      const interrupted = report() as Report & { endedAt: string | null };
      expect(interrupted).toMatchObject({ status: "interrupted", exitCode: 130, verification: { status: "unknown" }, evidence: { retained: [dir] } });
      expect(interrupted.endedAt).not.toBeNull();
      expect(interrupted.errors.some((error) => error.startsWith(`teardown: step process group ${group} did not end`) && error.includes("EPERM"))).toBe(true);
      expect(existsSync(join(dir, "web-state"))).toBe(true);
    } finally {
      check.kill("SIGKILL");
      await exited;
      if (group) expect((await endGroup(group, "SIGKILL")).result).toBe("gone");
    }
  }, 210_000);

  it.skipIf(process.platform === "win32")("bounds interrupted draining when an escaped process holds stdout", async () => {
    const { cwd, env, report, isolated } = fixture(false);
    const script = join(cwd, "..", "drain-timeout.ts");
    // Advance only the interrupted-drain deadline when it is armed, not a polling delay.
    writeFileSync(script, `import { main } from ${JSON.stringify(checkScript)};\nawait main({ scheduleDrainTimeout(expire, ms) { if (ms !== 9000) throw new Error("unexpected drain budget"); queueMicrotask(expire); return () => {}; } });\n`);
    const pidFile = join(cwd, "..", "escaped.pid");
    const holder = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { return new Response(); } }); console.log("ESCA" + "PED " + process.pid);`;
    const leader = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(holder)}], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); process.stdin.resume();`;
    const check = spawn(process.execPath, [script, "run", process.execPath, "-e", leader], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise<number | null>((resolve) => check.once("exit", resolve));
    let stdout = "";
    let stderr = "";
    check.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    check.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const saw = listen(check.stdout!);
    try {
      await within(saw("ESCAPED "), 150_000, "the escaped holder did not start");
      check.kill("SIGINT");
      expect(await within(exited, 15_000, "the interrupted drain did not finish")).toBe(130);
      const dir = isolated(stdout);
      made.push(dir);
      const failure = "could not end the interrupted steps: interrupted step output did not finish draining";
      expect(report()).toMatchObject({ status: "interrupted", exitCode: 130, evidence: { retained: [dir] } });
      expect(report().errors).toEqual([`teardown: ${failure}`]);
      expect(stderr).toContain(failure);
      expect(existsSync(dir)).toBe(true);
      // Its group escaped the check's ownership and is still holding the inherited stdout.
      expect(() => process.kill(-Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow();
    } finally {
      check.kill("SIGKILL");
      await exited;
      // a pid file caught half written reads 0, and group 0 is this test's own process group
      const escaped = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
      if (escaped > 0) expect((await endGroup(escaped, "SIGKILL")).result).toBe("gone");
    }
  }, 180_000);

  it.skipIf(process.platform === "win32")("fails and retains evidence when a zero-exit step group survives KILL", () => {
    const { cwd, env, report, isolated } = fixture(false);
    const survive = join(cwd, "..", "survive-groups.ts");
    // Simulate an unkillable owned group without leaving a real unkillable process on the PC.
    // Both grace periods advance through the same clock/wait seam as the unit tests.
    writeFileSync(survive, `import { main } from ${JSON.stringify(checkScript)};\nlet clock = 0;\nawait main({ kill() {}, now: () => clock, wait: async (ms) => { clock += ms; } });\n`);
    const result = spawnSync(process.execPath, [survive, "run", "sh", "-c", sessionsCommand], { cwd, env, encoding: "utf8", timeout: 200_000 });
    const dir = isolated(result.stdout);
    made.push(dir);
    expect(result.status).toBe(1);
    const failed = report();
    expect(failed).toMatchObject({ status: "failure", exitCode: 1, evidence: { retained: [dir] } });
    expect(failed.errors.some((error) => /step process group \d+ did not end: still running after SIGKILL/.test(error))).toBe(true);
    expect(failed.steps.find((step) => step.name === "run")?.status).toBe("success");
    expect(isAbsolute(dir)).toBe(true);
    expect(result.stderr).toContain(dir);
    expect(readFileSync(join(dir, "web-state", "evidence.txt"), "utf8")).toBe("kept\n");
  }, 210_000);

  it.skipIf(process.platform === "win32")("shares a pending group termination with an interrupt", () => {
    const { cwd, env, report, isolated } = fixture(false);
    const script = join(cwd, "..", "overlapping-stop.ts");
    // Deliver SIGINT while normal teardown is awaiting its first probe, not after it settles.
    writeFileSync(script, `import { main } from ${JSON.stringify(checkScript)};
let clock = 0;
let interrupted = false;
await main({
  kill() {},
  now: () => clock,
  async wait(ms) {
    clock += ms;
    if (!interrupted) {
      interrupted = true;
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.kill(process.pid, "SIGINT");
      });
    }
  },
});
`);
    const result = spawnSync(process.execPath, [script, "run", "sh", "-c", sessionsCommand], { cwd, env, encoding: "utf8", timeout: 200_000 });
    const dir = isolated(result.stdout);
    made.push(dir);
    expect(result.status).toBe(130);
    expect(report()).toMatchObject({ status: "interrupted", evidence: { retained: [dir] } });
    expect(report().errors).toHaveLength(1);
    expect(report().errors[0]).toMatch(/step process group \d+ did not end: still running after SIGKILL/);
  }, 210_000);
});

describe("check CLI", () => {
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("fails closed when source identity is lost after the fast checks", () => {
    const cwd = scratch();
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "check test");
    git(cwd, "config", "user.email", "check@example.invalid");
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n.check/\ndist/\n");
    const noOp = 'node -e "process.exit(0)" --';
    const fixtureBuild = 'node -e "const fs=require(\'node:fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.writeFileSync(\'dist/index.html\',\'fixture\')"';
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "check-cli-fixture",
      scripts: {
        "generate:types": noOp,
        "generate:themes": noOp,
        typecheck: noOp,
        build: fixtureBuild,
        "test:unit": noOp,
      },
    }));
    git(cwd, "add", ".gitignore", "package.json");
    git(cwd, "commit", "-qm", "fixture");

    const actionlintDirectory = join(cwd, "node_modules", ".cache", "actionlint-1.7.12");
    mkdirSync(actionlintDirectory, { recursive: true });
    const actionlint = join(actionlintDirectory, "actionlint");
    writeFileSync(actionlint, "#!/bin/sh\nexit 0\n");
    chmodSync(actionlint, 0o755);

    const env: Record<string, string | undefined> = { ...process.env, CHECK_DIR: ".check" };
    delete env["CHECK_REPORT"];
    delete env["GITHUB_EVENT_NAME"];
    delete env["GITHUB_EVENT_PATH"];
    const runCheck = () => spawnSync(process.execPath, [fileURLToPath(new URL("./check.ts", import.meta.url)), "fast"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
    git(cwd, "init", "-q", "nested");
    writeFileSync(join(cwd, "nested", "source.txt"), "nested repository fixture");
    const initialUnknown = runCheck();
    expect(initialUnknown.status).toBe(1);
    const initialReport = JSON.parse(readFileSync(join(cwd, ".check", "report.json"), "utf8")) as {
      source: { unchanged: boolean | null; start: { fingerprint: string | null; reason: string | null } };
      verification: { status: string };
      errors: string[];
    };
    expect(initialReport.source.unchanged).toBeNull();
    expect(initialReport.source.start.fingerprint).toBeNull();
    expect(initialReport.source.start.reason).toContain("nested/");
    expect(initialReport.verification.status).toBe("unknown");
    expect(initialReport.errors.some((error) => error.includes("source identity unavailable at start") && error.includes("nested/"))).toBe(true);

    rmSync(join(cwd, "nested"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "check-cli-fixture",
      scripts: {
        "generate:types": noOp,
        "generate:themes": noOp,
        typecheck: noOp,
        build: fixtureBuild,
        "test:unit": "git init -q nested && node -e \"require('node:fs').writeFileSync('nested/source.txt','fixture')\"",
      },
    }));
    const result = runCheck();

    expect(result.status).toBe(1);
    const report = JSON.parse(readFileSync(join(cwd, ".check", "report.json"), "utf8")) as {
      status: string;
      exitCode: number;
      revision: { head: string | null; testedSha: string | null; headSha: string | null };
      source: { unchanged: boolean | null; end: { fingerprint: string | null; reason: string | null } };
      verification: { status: string };
      errors: string[];
    };
    expect(report.status).toBe("failure");
    expect(report.exitCode).toBe(1);
    expect(report.source.unchanged).toBe(false);
    expect(report.source.end.fingerprint).toBeNull();
    expect(report.source.end.reason).toContain("nested/");
    expect(report.errors.some((error) => error.includes("source identity unavailable at end") && error.includes("nested/"))).toBe(true);
    expect(report.verification.status).toBe("invalidated");
    expect(report.revision.testedSha).toBe(report.revision.head);
    expect(report.revision.headSha).toBe(report.revision.testedSha);

    rmSync(join(cwd, "nested"), { recursive: true });
    rmSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "check-cli-fixture",
      scripts: { "generate:types": noOp, "generate:themes": noOp, typecheck: noOp, build: noOp, "test:unit": noOp },
    }));
    const missingBuild = runCheck();
    expect(missingBuild.status).toBe(1);
    const missingBuildReport = JSON.parse(readFileSync(join(cwd, ".check", "report.json"), "utf8"));
    expect(missingBuildReport.source.unchanged).toBe(true);
    expect(missingBuildReport.browserArtifact.buildThisRun).toBe(true);
    expect(missingBuildReport.verification.status).toBe("unknown");
    expect(missingBuildReport.errors).toContain("built dist identity unavailable; cannot verify the built artifact");
  }, 180_000);

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("refuses a fast run in a checkout another check run holds, before any step", () => {
    const cwd = realpathSync(scratch());
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "check test");
    git(cwd, "config", "user.email", "check@example.invalid");
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\ndist/\nran\n");
    const noOp = 'node -e "process.exit(0)" --';
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "check-cli-fixture",
      scripts: {
        "generate:types": 'node -e "require(\'node:fs\').writeFileSync(\'ran\',\'\')" --',
        "generate:themes": noOp,
        typecheck: noOp,
        build: 'node -e "const fs=require(\'node:fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.writeFileSync(\'dist/index.html\',\'fixture\')"',
        "test:unit": noOp,
      },
    }));
    git(cwd, "add", ".gitignore", "package.json");
    git(cwd, "commit", "-qm", "fixture");
    const actionlintDirectory = join(cwd, "node_modules", ".cache", "actionlint-1.7.12");
    mkdirSync(actionlintDirectory, { recursive: true });
    writeFileSync(join(actionlintDirectory, "actionlint"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(actionlintDirectory, "actionlint"), 0o755);
    // a live run of this checkout (this test's own process stands in for it) holds the checkout claim
    const marker = join(cwd, "node_modules", ".cache", "check", "checkout.lock.check-lock");
    mkdirSync(join(cwd, "node_modules", ".cache", "check"), { recursive: true });
    const holder = JSON.stringify({ pid: process.pid, checkout: "/the-other-run" });
    writeFileSync(marker, holder);
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of ["CHECK_DIR", "CHECK_REPORT", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH"]) delete env[name];

    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check.ts", import.meta.url)), "fast"], { cwd, env, encoding: "utf8", timeout: 30_000 });

    expect(result.status).toBe(1);
    // refused, not crashed: the refusal names the holder's pid and checkout
    expect(result.stderr).toContain(String(process.pid));
    expect(result.stderr).toContain("/the-other-run");
    // refused before any step and before a report: the claim is the only file under the check cache
    expect(existsSync(join(cwd, "ran"))).toBe(false);
    expect(readdirSync(join(cwd, "node_modules", ".cache", "check"))).toEqual(["checkout.lock.check-lock"]);
    expect(readFileSync(marker, "utf8")).toBe(holder);
  }, 60_000);

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("says on the console why a run whose steps all passed failed when the source changed mid-run", () => {
    const cwd = scratch();
    git(cwd, "init", "-q");
    git(cwd, "config", "user.name", "check test");
    git(cwd, "config", "user.email", "check@example.invalid");
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n.check/\ndist/\n");
    writeFileSync(join(cwd, "tracked.txt"), "before");
    const noOp = 'node -e "process.exit(0)" --';
    writeFileSync(join(cwd, "package.json"), JSON.stringify({
      name: "check-cli-fixture",
      scripts: {
        "generate:types": noOp,
        "generate:themes": noOp,
        typecheck: noOp,
        build: 'node -e "const fs=require(\'node:fs\');fs.mkdirSync(\'dist\',{recursive:true});fs.writeFileSync(\'dist/index.html\',\'fixture\')"',
        // the unit tests pass, but edit a tracked file while the check runs
        "test:unit": 'node -e "require(\'node:fs\').writeFileSync(\'tracked.txt\',\'after\')"',
      },
    }));
    git(cwd, "add", ".gitignore", "package.json", "tracked.txt");
    git(cwd, "commit", "-qm", "fixture");
    const actionlintDirectory = join(cwd, "node_modules", ".cache", "actionlint-1.7.12");
    mkdirSync(actionlintDirectory, { recursive: true });
    writeFileSync(join(actionlintDirectory, "actionlint"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(actionlintDirectory, "actionlint"), 0o755);
    const env: Record<string, string | undefined> = { ...process.env, CHECK_DIR: ".check" };
    for (const name of ["CHECK_REPORT", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH"]) delete env[name];

    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check.ts", import.meta.url)), "fast"], { cwd, env, encoding: "utf8", timeout: 30_000 });

    expect(result.status).toBe(1);
    const reportPath = join(cwd, ".check", "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { steps: { status: string }[]; errors: string[] };
    expect(report.steps.every((step) => step.status === "success")).toBe(true);
    expect(report.errors).toEqual(["source changed during the check; verification was invalidated"]);
    // the start line names the report on stdout; the failure's reason and the report come last, on stderr
    const said = result.stderr.split("\n");
    expect(said).toContain("check: source changed during the check; verification was invalidated");
    expect(said).toContain(`check: report ${reportPath}`);
  }, 60_000);
});
