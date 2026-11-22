import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireOwnerDirectory, guardLibrary, guardPath, OwnerGuardReleaseFailed, OwnerGuardUnavailable, withOwnerGuard } from "./owner-guard.ts";
import { parseOwnerRecord, readProcessBirth } from "./process-owner.ts";

const windows = process.platform === "win32";
const ERRORS = { running: "already running", starting: "another start" };
const MODULE = pathToFileURL(join(import.meta.dir, "owner-guard.ts")).href;

const FIXTURE = `
import { readFileSync, readSync, statSync, writeSync } from "node:fs";
const [module, lock, gateList = "", library = ""] = process.argv.slice(2);
const { acquireOwnerDirectory, guardLibrary } = await import(module);
if (library) guardLibrary.path = library;
const gates = new Set(gateList.split(",").filter(Boolean));
let session = null;
if (process.platform === "win32") {
  const { dlopen } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", { ProcessIdToSessionId: { args: ["u32", "ptr"], returns: "i32" } });
  const id = new Uint32Array(1);
  if (kernel.symbols.ProcessIdToSessionId(process.pid, id)) session = id[0];
}
const emit = (event, extra = {}) => writeSync(1, JSON.stringify({ event, pid: process.pid, session, ...extra }) + "\\n");
const wait = (gate) => {
  if (!gates.has(gate)) return;
  const one = Buffer.alloc(1);
  while (readSync(0, one, 0, 1, null) === 1 && one[0] !== 10);
};
const owner = () => { try { return JSON.parse(readFileSync(lock + "/owner.json", "utf8")); } catch { return null; } };
emit("started");
try {
  const lease = acquireOwnerDirectory(lock, { running: "already running", starting: "another start" }, {
    observed() { emit("observed"); wait("observed"); emit("acquiring"); },
    locked() { const guard = statSync(lock + ".guard"); emit("locked", { owner: owner(), guard: guard.dev + ":" + guard.ino }); },
    validated() { emit("validated"); wait("validated"); },
    staged(staging) { emit("staged", { staging }); wait("staged"); },
  });
  emit("published", { record: lease.record });
  wait("published");
  if (gates.has("release")) { lease.release(); emit("released"); }
} catch (error) {
  emit("refused", { message: error.message });
  process.exitCode = 3;
}
`;

const earlierBirth = { platform: process.platform, value: process.platform === "linux" ? `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:1` : process.platform === "darwin" ? "Thu Jan 1 00:00:00 1970" : "1" };

type Event = { event: string; pid: number; session: number | null; [key: string]: unknown };

function within<T>(promise: Promise<T>, what: string, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

class Events {
  readonly seen: Event[] = [];
  private waiters: { name: string; resolve(event: Event): void }[] = [];
  private buffer = "";
  private finished = Promise.withResolvers<void>();
  readonly ended = this.finished.promise;
  constructor(readonly label: string, private readonly send: (text: string) => void) {}
  feed(text: string) {
    this.buffer += text;
    for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (!line) continue;
      const event = JSON.parse(line) as Event;
      this.seen.push(event);
      for (const waiter of this.waiters.filter((entry) => entry.name === event.event)) waiter.resolve(event);
      this.waiters = this.waiters.filter((entry) => entry.name !== event.event);
    }
  }
  end() { this.finished.resolve(); }
  next(name: string): Promise<Event> {
    const found = this.seen.find((event) => event.event === name);
    if (found) return Promise.resolve(found);
    const arrived = new Promise<Event>((resolve) => this.waiters.push({ name, resolve }));
    const ended = this.ended.then(() => {
      const late = this.seen.find((event) => event.event === name);
      if (late) return late;
      throw new Error(`${this.label} ended before "${name}": ${JSON.stringify(this.seen)} ${this.detail()}`);
    });
    return within(Promise.race([arrived, ended]), `"${name}" from ${this.label}`);
  }
  has(name: string) { return this.seen.some((event) => event.event === name); }
  detail(): string { return ""; }
  release() { this.send("\n"); }
}

class Starter extends Events {
  readonly proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
  stderr = "";
  constructor(label: string, lock: string, gates: string[], library = "") {
    const proc = Bun.spawn([process.execPath, fixture, MODULE, lock, gates.join(","), library], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
    super(label, (text) => { proc.stdin.write(text); proc.stdin.flush(); });
    this.proc = proc;
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stdout) this.feed(decoder.decode(chunk, { stream: true }));
      this.stderr = await new Response(proc.stderr).text();
      this.end();
    })();
    starters.push(this);
  }
  override detail() { return this.stderr; }
  async kill() {
    if (windows) Bun.spawnSync(["taskkill", "/PID", String(this.proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    else this.proc.kill("SIGKILL");
    await this.proc.exited;
  }
  async close() {
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    await this.proc.exited;
    await this.ended;
  }
}

let root = "", fixture = "", starters: Starter[] = [], others: Bun.Subprocess<"pipe", "ignore", "ignore">[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "owner-guard-"));
  fixture = join(root, "starter.ts");
  writeFileSync(fixture, FIXTURE);
});
afterEach(async () => {
  for (const starter of starters.splice(0)) await starter.close();
  for (const other of others.splice(0)) { other.stdin.end(); await other.exited; }
  rmSync(root, { recursive: true, force: true });
});

function unrelated() {
  const other = Bun.spawn([process.execPath, "-e", "for await (const _ of console) break;"], { stdin: "pipe", stdout: "ignore", stderr: "ignore", windowsHide: true });
  others.push(other);
  return other;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** Signal 0 to `pid` is refused (EPERM), as another user's or a protected process refuses it; every other PID is probed for real. */
function refusing(pid: number) {
  const kill = process.kill.bind(process);
  return spyOn(process, "kill").mockImplementation(((target: number, signal?: NodeJS.Signals | number) => {
    if (target === pid) throw Object.assign(new Error(`kill ${target} EPERM`), { code: "EPERM" });
    return kill(target, signal);
  }) as typeof process.kill);
}
function staleLock(lock: string, pid: number) {
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), String(pid));
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid, generation: "crashed-owner", birth: earlierBirth }));
}
const ownerOf = (lock: string) => parseOwnerRecord(readFileSync(join(lock, "owner.json"), "utf8"));
const identity = (path: string) => { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; };
const staging = (dir: string) => readdirSync(dir).filter((name) => name.includes(".tmp-"));

describe("owner guard", () => {
  it("reclaims a lock whose PID another process now holds, without signalling it", () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    staleLock(lock, other.pid);
    const lease = acquireOwnerDirectory(lock, ERRORS);
    expect(ownerOf(lock)).toEqual(lease.record);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(process.pid));
    expect(alive(other.pid)).toBe(true);
    lease.release();
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(guardPath(lock))).toBe(true);
  });

  it("reclaims a lock whose PID a process it may not signal now holds", () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    staleLock(lock, other.pid);
    const reading = readProcessBirth(other.pid);
    if (reading.state !== "identified") throw new Error(`no birth for ${other.pid}`);
    const refused = refusing(other.pid);
    try {
      const lease = acquireOwnerDirectory(lock, ERRORS);
      expect(ownerOf(lock)).toEqual(lease.record);
      lease.release();
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(other.pid));
      writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: other.pid, generation: "refused-owner", birth: reading.birth }));
      expect(() => acquireOwnerDirectory(lock, ERRORS)).toThrow(`already running (lock ${lock}, owner pid ${other.pid} generation refused-owner)`);
    } finally { refused.mockRestore(); }
    expect(alive(other.pid)).toBe(true);
  });

  it.skipIf(!windows)("reclaims a lock whose PID a process this user cannot open now holds", () => {
    // the System process refuses every caller's probe; CIM still reads its creation time, as main's
    // check did, for a record with a birth and for an older version's PID-only one alike
    const lock = join(root, "supervisor.lock");
    staleLock(lock, 4);
    acquireOwnerDirectory(lock, ERRORS).release();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), "4");
    expect(() => acquireOwnerDirectory(lock, ERRORS)).toThrow(`already running (lock ${lock}, owner pid 4)`);
    utimesSync(join(lock, "pid"), new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    acquireOwnerDirectory(lock, ERRORS).release();
    expect(existsSync(lock)).toBe(false);
  });

  it("keeps live, legacy and unknown owners", () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    const lease = acquireOwnerDirectory(lock, ERRORS);
    expect(() => acquireOwnerDirectory(lock, ERRORS)).toThrow(`already running (lock ${lock}, owner pid ${process.pid} generation ${lease.record.generation})`);
    lease.release();
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(other.pid));
    expect(() => acquireOwnerDirectory(lock, ERRORS)).toThrow(`already running (lock ${lock}, owner pid ${other.pid})`);
    writeFileSync(join(lock, "owner.json"), "{");
    expect(() => acquireOwnerDirectory(lock, ERRORS)).toThrow(`already running (lock ${lock}, owner pid ${other.pid})`);
    writeFileSync(join(lock, "pid"), "not a pid");
    expect(() => acquireOwnerDirectory(lock, ERRORS)).toThrow("unknown owner");
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe("not a pid");
    expect(alive(other.pid)).toBe(true);
  });

  it.skipIf(!windows)("reclaims a birth-less record whose PID a later process holds", () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "pid"), String(other.pid));
    writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: other.pid, generation: "birthless-owner" }));
    expect(() => acquireOwnerDirectory(lock, ERRORS)).toThrow(`already running (lock ${lock}, owner pid ${other.pid} generation birthless-owner)`);
    utimesSync(join(lock, "pid"), new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
    const lease = acquireOwnerDirectory(lock, ERRORS);
    expect(ownerOf(lock)).toEqual(lease.record);
    expect(alive(other.pid)).toBe(true);
    lease.release();
  });

  it("reclaims abandoned record-less state", () => {
    const lock = join(root, "supervisor.lock");
    mkdirSync(lock);
    const lease = acquireOwnerDirectory(lock, ERRORS);
    expect(ownerOf(lock)).toEqual(lease.record);
    lease.release();
    expect(existsSync(lock)).toBe(false);
  });

  it("does not release another generation", () => {
    const lock = join(root, "supervisor.lock");
    const first = acquireOwnerDirectory(lock, ERRORS);
    const later = JSON.stringify({ ...first.record, generation: "later-owner" });
    writeFileSync(join(lock, "owner.json"), later);
    first.release();
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(later);
    rmSync(lock, { recursive: true });
    const second = acquireOwnerDirectory(lock, ERRORS);
    second.release();
    expect(existsSync(lock)).toBe(false);
  });

  it("fails closed when the guard is unavailable", () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    staleLock(lock, other.pid);
    const before = { directory: identity(lock), owner: readFileSync(join(lock, "owner.json"), "utf8") };
    const original = guardLibrary.path;
    guardLibrary.path = join(root, "missing-libc.so.6"); // as on musl, which has no libc.so.6
    try {
      let ran = false;
      expect(() => withOwnerGuard(lock, () => { ran = true; })).toThrow(OwnerGuardUnavailable);
      expect(ran).toBe(false);
      let locked = false;
      expect(() => acquireOwnerDirectory(lock, ERRORS, { locked() { locked = true; } }))
        .toThrow(`another start (lock ${lock}, owner pid ${other.pid} generation crashed-owner; the file lock could not be loaded`);
      expect(locked).toBe(false);
    } finally { guardLibrary.path = original; }
    expect({ directory: identity(lock), owner: readFileSync(join(lock, "owner.json"), "utf8") }).toEqual(before);
    expect(staging(root)).toEqual([]);
    expect(alive(other.pid)).toBe(true);
  });

  it.skipIf(windows)("refuses a guard planted as a link, creating nothing where it points", () => {
    // Given: the guard's path is a dangling link to a file outside its directory
    const lock = join(root, "links", "usage-logins.json");
    mkdirSync(join(root, "links"));
    const outside = join(root, "outside-guard");
    symlinkSync(outside, guardPath(lock));
    // When / Then: nothing runs under it, and no file appears where it points
    let ran = false;
    expect(() => withOwnerGuard(lock, () => { ran = true; })).toThrow(OwnerGuardUnavailable);
    expect(ran).toBe(false);
    expect(existsSync(outside)).toBe(false);
  });

  it("serializes competing reclaimers", async () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    staleLock(lock, other.pid);
    const a = new Starter("A", lock, ["observed"]);
    const b = new Starter("B", lock, ["observed", "validated", "published"]);
    await Promise.all([a.next("observed"), b.next("observed")]);
    b.release();
    await b.next("validated");
    a.release();
    await a.next("acquiring");
    expect(a.has("locked")).toBe(false);
    b.release();
    const published = await b.next("published");
    const refused = await a.next("refused");
    expect((await a.next("locked"))["owner"]).toEqual(published["record"]);
    expect(refused["message"]).toBe(`another start (lock ${lock}, owner pid ${b.proc.pid} generation ${(published["record"] as { generation: string }).generation})`);
    expect(a.has("validated")).toBe(false);
    expect(ownerOf(lock)).toEqual(published["record"] as never);
    expect(staging(root)).toEqual([]);
    expect(alive(other.pid)).toBe(true);
  }, 60_000);

  it("releases the guard when its holder is killed", async () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    staleLock(lock, other.pid);
    const holder = new Starter("holder", lock, ["validated"]);
    await holder.next("validated");
    const guard = identity(guardPath(lock));
    const waiter = new Starter("waiter", lock, ["observed"]);
    await waiter.next("observed");
    waiter.release();
    await waiter.next("acquiring");
    expect(waiter.has("locked")).toBe(false);
    await holder.kill();
    // the kernel released the dead holder's lock; the waiter re-proved the untouched stale owner
    const published = await waiter.next("published");
    expect(ownerOf(lock)).toEqual(published["record"] as never);
    expect(identity(guardPath(lock))).toBe(guard);
    expect(staging(root)).toEqual([]);
    expect(alive(other.pid)).toBe(true);
  }, 60_000);

  it("publishes only complete owner directories", async () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    staleLock(lock, other.pid);
    const fixtureOwner = readFileSync(join(lock, "owner.json"), "utf8");
    const dying = new Starter("dying", lock, ["staged"]);
    const staged = String((await dying.next("staged"))["staging"]);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(fixtureOwner);
    expect(parseOwnerRecord(readFileSync(join(staged, "owner.json"), "utf8"))?.pid).toBe(dying.proc.pid);
    expect(readFileSync(join(staged, "pid"), "utf8")).toBe(String(dying.proc.pid));
    await dying.kill();
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(fixtureOwner);
    const next = new Starter("next", lock, ["staged"]);
    const nextStaged = String((await next.next("staged"))["staging"]);
    expect(readFileSync(join(lock, "owner.json"), "utf8")).toBe(fixtureOwner);
    next.release();
    const published = await next.next("published");
    expect(ownerOf(lock)).toEqual(published["record"] as never);
    expect(readFileSync(join(lock, "pid"), "utf8")).toBe(String(next.proc.pid));
    expect(existsSync(nextStaged)).toBe(false);
    expect(alive(other.pid)).toBe(true);
  }, 60_000);

  it.skipIf(windows)("contends through another spelling of the same path", async () => {
    const other = unrelated();
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const lock = join(root, "real", "supervisor.lock"), alias = join(root, "alias", "supervisor.lock");
    staleLock(lock, other.pid);
    await contend(lock, alias);
  }, 60_000);

  it.skipIf(!windows)("contends through a junction, another letter case and the 8.3 name", async () => {
    const other = unrelated();
    const real = join(root, "long-directory-name-for-alias");
    mkdirSync(real);
    const lock = join(real, "supervisor.lock");
    const junction = join(root, "junction");
    expect(Bun.spawnSync(["cmd", "/d", "/c", "mklink", "/J", junction, real], { stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
    const short = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${real.replaceAll("'", "''")}').ShortPath`], { stdout: "pipe", windowsHide: true }).stdout.toString().trim();
    const aliases = [join(junction, "supervisor.lock"), lock.toUpperCase(), ...(short && short.toLowerCase() !== real.toLowerCase() ? [join(short, "supervisor.lock")] : [])];
    if (aliases.length === 2) console.log(`no 8.3 name exists for ${real}; that alias was not tested`);
    else console.log(`8.3 alias: ${short}`);
    for (const alias of aliases) {
      rmSync(lock, { recursive: true, force: true });
      staleLock(lock, other.pid);
      await contend(lock, alias);
    }
  }, 60_000);

  it.skipIf(!windows)("serializes interactive and SSH session reclaimers", async () => {
    // a crashed owner whose PID is free: another logon session's process would refuse the
    // interactive starter's probe (EPERM), which never proves an owner gone
    const crashed = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore", windowsHide: true });
    await crashed.exited;
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    staleLock(lock, crashed.pid);
    // the interactive starter reaches this test through a loopback relay: a scheduled task's
    // output goes nowhere else, and it waits on its stdin for this test's lines like any starter
    const relay = join(root, "relay.ts");
    writeFileSync(relay, `
      const [port, ...args] = process.argv.slice(2);
      const child = Bun.spawn([process.execPath, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
      const socket = await Bun.connect({ hostname: "127.0.0.1", port: Number(port), socket: {
        data(_socket, data) { child.stdin.write(data); child.stdin.flush(); },
        close() { try { child.stdin.end(); } catch {} },
      } });
      for await (const chunk of child.stdout) socket.write(chunk);
      const stderr = await new Response(child.stderr).text();
      if (stderr.trim()) socket.write(JSON.stringify({ event: "stderr", pid: child.pid, session: null, text: stderr }) + "\\n");
      await child.exited;
      socket.end();
    `);
    const connected = Promise.withResolvers<Bun.Socket<undefined>>();
    let relayed = false;
    const interactive = new Events("interactive", (text) => { void connected.promise.then((socket) => socket.write(text)); });
    const decoder = new TextDecoder();
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: {
      open(socket) { relayed = true; connected.resolve(socket); },
      data(_socket, data) { interactive.feed(decoder.decode(data, { stream: true })); },
      close() { interactive.end(); },
    } });
    const task = `herdr-owner-guard-${process.pid}-${Date.now()}`;
    const command = join(root, "interactive.cmd");
    writeFileSync(command, `@"${process.execPath}" "${relay}" ${server.port} "${fixture}" "${MODULE}" "${lock}" observed,validated,published\r\n`);
    const user = Bun.spawnSync(["whoami"], { stdout: "pipe" }).stdout.toString().trim();
    const at = new Date(Date.now() + 60_000);
    const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
    const schtasks = (...args: string[]) => {
      const run = Bun.spawnSync(["schtasks", ...args], { stdout: "pipe", stderr: "pipe" });
      if (run.exitCode !== 0) throw new Error(`schtasks ${args[0]} failed: ${run.stderr.toString().trim()}`);
    };
    let ssh: Starter | null = null;
    try {
      schtasks("/Create", "/TN", task, "/SC", "ONCE", "/ST", time, "/RU", user, "/IT", "/TR", command, "/F");
      schtasks("/Run", "/TN", task);
      ssh = new Starter("ssh", lock.toUpperCase(), ["observed"]);
      const [mine, theirs] = await Promise.all([ssh.next("observed"), interactive.next("observed")]);
      console.log(`sessions: ssh ${mine.session}, interactive ${theirs.session}`);
      expect(mine.session).not.toBe(theirs.session);
      interactive.release();
      const held = await interactive.next("locked");
      await interactive.next("validated");
      ssh.release();
      await ssh.next("acquiring");
      expect(ssh.has("locked")).toBe(false);
      interactive.release();
      const published = await interactive.next("published");
      const refused = await ssh.next("refused");
      const seen = await ssh.next("locked");
      console.log(`guard file: interactive ${held["guard"]}, ssh ${seen["guard"]}`);
      console.log(`receipts: ${JSON.stringify({ interactive: interactive.seen.map((e) => e.event), ssh: ssh.seen.map((e) => e.event), refused: refused["message"] })}`);
      expect(seen["guard"]).toBe(held["guard"]);
      expect(seen["owner"]).toEqual(published["record"]);
      expect(String(refused["message"])).toStartWith("another start");
      expect(ownerOf(lock)).toEqual(published["record"] as never);
    } finally {
      Bun.spawnSync(["schtasks", "/Delete", "/TN", task, "/F"], { stdout: "ignore", stderr: "ignore" });
      if (relayed) {
        void connected.promise.then((socket) => socket.end());
        await within(interactive.ended, "the interactive starter to exit");
      }
      await ssh?.close();
      server.stop(true);
      expect(alive(other.pid)).toBe(true);
    }
  }, 60_000);
});

describe("owner guard native failures", () => {
  const LOCK_EX = 2, LOCK_UN = 8, EBADF = 9, ERROR_NOT_LOCKED = 158, ERROR_INVALID_HANDLE = 6, ERROR_LOCK_VIOLATION = 33;
  let closes = 0;
  function failing(...fail: ("lock" | "unlock" | "close")[]) {
    closes = 0;
    let code: number | null = null;
    if (windows) {
      guardLibrary.windows = (calls) => ({
        ...calls,
        LockFileEx: (...args: Parameters<typeof calls.LockFileEx>) => fail.includes("lock") ? (code = ERROR_LOCK_VIOLATION, 0) : calls.LockFileEx(...args),
        UnlockFileEx: (...args: Parameters<typeof calls.UnlockFileEx>) => { const ok = calls.UnlockFileEx(...args); return fail.includes("unlock") ? (code = ERROR_NOT_LOCKED, 0) : ok; },
        CloseHandle: (handle: Parameters<typeof calls.CloseHandle>[0]) => { closes++; const ok = calls.CloseHandle(handle); return fail.includes("close") ? (code = ERROR_INVALID_HANDLE, 0) : ok; },
        GetLastError: () => code ?? calls.GetLastError(),
      });
    } else {
      guardLibrary.posix = (calls) => ({
        flock: (fd, operation) => {
          if ((operation === LOCK_EX && fail.includes("lock")) || (operation === LOCK_UN && fail.includes("unlock"))) { code = EBADF; return -1; }
          return calls.flock(fd, operation);
        },
        errno: () => code ?? calls.errno(),
        close: (fd) => {
          closes++;
          calls.close(fd);
          if (fail.includes("close")) throw Object.assign(new Error("input/output error"), { code: "EIO" });
        },
      });
    }
  }
  const unlockFailed = windows ? `unlocking failed (error ${ERROR_NOT_LOCKED})` : `unlocking failed (errno ${EBADF})`;
  const closeFailed = windows ? `closing failed (error ${ERROR_INVALID_HANDLE})` : "closing failed (EIO)";
  afterEach(() => { delete guardLibrary.posix; delete guardLibrary.windows; });
  const free = (lock: string) => expect(withOwnerGuard(lock, () => "taken")).toBe("taken");

  it("reports a failed unlock and still closes the guard", () => {
    const lock = join(root, "supervisor.lock");
    failing("unlock");
    let ran = false;
    expect(() => withOwnerGuard(lock, () => { ran = true; return "result"; })).toThrow(new OwnerGuardReleaseFailed(`${guardPath(lock)} was not released cleanly: ${unlockFailed}`));
    expect(ran).toBe(true);
    expect(closes).toBe(1);
    failing();
    free(lock);
  });

  it("reports a failed close", () => {
    const lock = join(root, "supervisor.lock");
    failing("unlock", "close");
    expect(() => withOwnerGuard(lock, () => "result")).toThrow(new OwnerGuardReleaseFailed(`${guardPath(lock)} was not released cleanly: ${unlockFailed}; ${closeFailed}`));
    failing("close");
    expect(() => withOwnerGuard(lock, () => "result")).toThrow(new OwnerGuardReleaseFailed(`${guardPath(lock)} was not released cleanly: ${closeFailed}`));
    expect(closes).toBe(1);
    failing();
    free(lock);
  });

  it("closes a guard it could not lock, runs nothing and reports a failed close", () => {
    const lock = join(root, "supervisor.lock");
    const lockFailed = windows ? `could not be locked (error ${ERROR_LOCK_VIOLATION})` : `could not be locked (errno ${EBADF})`;
    for (const fail of [["lock"], ["lock", "close"]] as const) {
      failing(...fail);
      let ran = false;
      const closing = fail.length === 2 ? `; closing it failed too (${windows ? `error ${ERROR_INVALID_HANDLE}` : "EIO"})` : "";
      expect(() => withOwnerGuard(lock, () => { ran = true; })).toThrow(new OwnerGuardUnavailable(`${guardPath(lock)} ${lockFailed}${closing}`));
      expect(ran).toBe(false);
      expect(closes).toBe(1);
    }
    failing();
    free(lock);
  });

  it("keeps the callback's own error when the release fails after it", () => {
    const lock = join(root, "supervisor.lock");
    failing("unlock");
    const thrown = (() => { try { withOwnerGuard(lock, () => { throw new Error("callback failed"); }); } catch (error) { return error as Error; } })();
    expect(thrown).toBeInstanceOf(OwnerGuardReleaseFailed);
    expect(thrown?.message).toBe(`${guardPath(lock)} was not released cleanly: ${unlockFailed}, after: callback failed`);
    expect((thrown?.cause as Error).message).toBe("callback failed");
    expect(closes).toBe(1);
  });

  it("fails a start whose guard was not released, and logs a release that was not clean", () => {
    const other = unrelated();
    const lock = join(root, "supervisor.lock");
    staleLock(lock, other.pid);
    failing("unlock");
    expect(() => acquireOwnerDirectory(lock, ERRORS)).toThrow(`another start (lock ${lock}; ${guardPath(lock)} was not released cleanly: ${unlockFailed})`);
    expect(ownerOf(lock)?.pid).toBe(process.pid);
    expect(closes).toBe(1);
    rmSync(lock, { recursive: true });
    failing();
    const lease = acquireOwnerDirectory(lock, ERRORS);
    failing("close");
    const logged = spyOn(console, "error").mockImplementation(() => {});
    let message = "";
    try { lease.release(); message = String(logged.mock.calls[0]?.[0]); } finally { logged.mockRestore(); }
    expect(message).toBe(`Releasing the startup lock ${lock} failed: ${guardPath(lock)} was not released cleanly: ${closeFailed}`);
    expect(existsSync(lock)).toBe(false);
    expect(alive(other.pid)).toBe(true);
    failing();
    free(lock);
  });
});

async function contend(lock: string, alias: string) {
  const holder = new Starter("holder", lock, ["validated", "published"]);
  const held = await holder.next("locked");
  await holder.next("validated");
  const rival = new Starter(`rival via ${alias}`, alias, ["observed"]);
  await rival.next("observed");
  rival.release();
  await rival.next("acquiring");
  expect(rival.has("locked")).toBe(false);
  holder.release();
  const published = await holder.next("published");
  const seen = await rival.next("locked");
  expect(seen["guard"]).toBe(held["guard"]);
  expect(seen["owner"]).toEqual(published["record"]);
  expect(String((await rival.next("refused"))["message"])).toStartWith("another start");
  await Promise.all([holder.close(), rival.close()]);
}
