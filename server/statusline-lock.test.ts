import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installStatusline, removeStatusline } from "./statusline-install.ts";

/**
 * Changes to the status line in separate processes, interleaved at the points where taking over an
 * abandoned lock could let two of them hold it at once. Each contender stops at its point, says so on
 * stdout, and waits on a FIFO the test writes to; nothing waits on time.
 */
const ROLE = process.env["STATUSLINE_LOCK_ROLE"];
const ORIGINAL = JSON.stringify({ statusLine: { type: "command", command: "printf original" } });

type Fs = (...args: unknown[]) => unknown;

describe.skipIf(process.platform === "win32")("status-line lock", () => {
  it.skipIf(ROLE === undefined)("lock race contender", () => {
    const home = process.env["STATUSLINE_LOCK_HOME"]!;
    const config = join(home, ".claude");
    const lock = join(config, ".herdr-statusline.lock");
    const owner = join(lock, "owner");
    const settings = join(config, "settings.json");
    const stop = (label: string) => {
      fs.writeSync(1, `STAGE:${label}\n`);
      fs.readFileSync(join(home, `gate-${ROLE}-${label}`));
    };
    const read = fs.readFileSync as Fs;
    const write = fs.writeFileSync as Fs;
    let once = false;
    // takeover: stops right after reading the owner of the lock it found held
    if (ROLE === "takeover") {
      spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
        const value = read(path, ...rest);
        if (!once && String(path) === owner) { once = true; stop("read-owner"); }
        return value;
      }) as typeof fs.readFileSync);
    }
    // discard (a takeover) and release (an install letting go): stop part way through deleting a lock,
    // its owner file already gone
    if (ROLE === "discard" || ROLE === "release") {
      const remove = fs.rmSync as Fs;
      spyOn(fs, "rmSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
        const target = String(path);
        if (!once && (target === lock || target.endsWith(".old"))) {
          once = true;
          fs.unlinkSync(join(target, "owner"));
          stop("emptied");
        }
        return remove(path, ...rest);
      }) as typeof fs.rmSync);
    }
    // install: stops while holding the lock, part way through
    if (ROLE === "install") {
      spyOn(fs, "writeFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
        if (!once && String(path).includes("/.statusline-capture.ts.")) { once = true; stop("installing"); }
        return write(path, ...rest);
      }) as typeof fs.writeFileSync);
    }
    // remove: stops while holding the lock, after reading settings.json
    if (ROLE === "remove") {
      spyOn(fs, "readFileSync").mockImplementation(((path: unknown, ...rest: unknown[]) => {
        const value = read(path, ...rest);
        if (!once && String(path) === settings) { once = true; stop("removing"); }
        return value;
      }) as typeof fs.readFileSync);
    }
    try {
      fs.writeSync(1, `RESULT:${ROLE === "remove" ? removeStatusline({ home }) : installStatusline({ home })}\n`);
    } catch (error) {
      fs.writeSync(1, `RESULT_ERROR:${error instanceof Error ? error.message : String(error)}\n`);
    }
  });

  function setup() {
    const home = fs.mkdtempSync(join(tmpdir(), "ovis-statusline-lock-"));
    const config = join(home, ".claude");
    fs.mkdirSync(config);
    fs.writeFileSync(join(config, "settings.json"), ORIGINAL);
    for (const gate of ["takeover-read-owner", "discard-emptied", "release-emptied", "install-installing", "remove-removing"]) {
      expect(Bun.spawnSync(["mkfifo", join(home, `gate-${gate}`)]).exitCode).toBe(0);
    }
    const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
    const contender = (role: string) => {
      const child = Bun.spawn([process.execPath, "test", import.meta.path, "-t", "lock race contender"], {
        env: { ...process.env, STATUSLINE_LOCK_ROLE: role, STATUSLINE_LOCK_HOME: home },
        stdin: "ignore", stdout: "pipe", stderr: "pipe",
      });
      children.push(child);
      const reader = child.stdout.getReader();
      let output = "";
      let paused: string | null = null;
      const next = async (): Promise<string> => {
        for (;;) {
          const seen = output.slice(output.lastIndexOf("RESUMED") + 1);
          const stage = /STAGE:(\S+)\n/.exec(seen);
          if (stage) return (paused = stage[1]!);
          const result = /RESULT(?:_ERROR)?:.*/.exec(seen);
          if (result) return result[0];
          const { value, done } = await reader.read();
          if (done) return `EXITED:${output}`;
          output += new TextDecoder().decode(value);
        }
      };
      const resume = () => {
        fs.writeFileSync(join(home, `gate-${role}-${paused}`), "go");
        output += "RESUMED";
        paused = null;
      };
      return { next, resume, exited: () => child.exited };
    };
    const cleanup = async () => {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
      fs.rmSync(home, { recursive: true, force: true });
    };
    const lockOwner = () => { try { return fs.readFileSync(join(config, ".herdr-statusline.lock", "owner"), "utf8"); } catch { return null; } };
    return { home, config, contender, cleanup, lockOwner };
  }

  it.skipIf(ROLE !== undefined)("takes over an abandoned lock only once, refusing a second takeover meanwhile", async () => {
    const { config, contender, cleanup, lockOwner } = setup();
    try {
      fs.mkdirSync(join(config, ".herdr-statusline.lock"));
      fs.writeFileSync(join(config, ".herdr-statusline.lock", "owner"), `${Bun.spawnSync(["true"]).pid}:${crypto.randomUUID()}`);
      const takeover = contender("takeover");
      expect(await takeover.next()).toBe("read-owner"); // has judged the lock abandoned
      const install = contender("install");
      expect(await install.next()).toMatch(/^RESULT_ERROR:.*in progress/); // a second takeover meanwhile is refused
      takeover.resume();
      expect(await takeover.next()).toMatch(/^RESULT:installed/);
      expect(await takeover.exited()).toBe(0);
      const remove = contender("remove");
      expect(await remove.next()).toBe("removing");
      remove.resume();
      expect(await remove.next()).toMatch(/^RESULT:removed/);
      expect(fs.readFileSync(join(config, "settings.json"), "utf8")).toBe(ORIGINAL);
      expect(lockOwner()).toBeNull();
      expect(fs.readdirSync(config).filter((name) => name.startsWith(".herdr-statusline.lock"))).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it.skipIf(ROLE !== undefined)("never loses a lock taken while an abandoned one is being deleted", async () => {
    const { config, contender, cleanup, lockOwner } = setup();
    try {
      fs.mkdirSync(join(config, ".herdr-statusline.lock"));
      fs.writeFileSync(join(config, ".herdr-statusline.lock", "owner"), `${Bun.spawnSync(["true"]).pid}:${crypto.randomUUID()}`);
      const discard = contender("discard");
      expect(await discard.next()).toBe("emptied"); // deleting the abandoned lock, its owner file gone
      const install = contender("install");
      expect(await install.next()).toBe("installing"); // took the lock meanwhile and holds it
      const held = lockOwner();
      expect(held).not.toBeNull();
      discard.resume();
      expect(await discard.next()).toMatch(/^RESULT_ERROR:.*in progress/);
      expect(lockOwner()).toBe(held);
      install.resume();
      expect(await install.next()).toMatch(/^RESULT:installed/);
      expect(fs.readdirSync(config).filter((name) => name.startsWith(".herdr-statusline.lock"))).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it.skipIf(ROLE !== undefined)("never loses a lock taken while its previous holder is releasing", async () => {
    const { config, contender, cleanup, lockOwner } = setup();
    try {
      const release = contender("release");
      expect(await release.next()).toBe("emptied"); // installed, deleting its own lock, owner file gone
      const remove = contender("remove");
      expect(await remove.next()).toBe("removing"); // took the lock meanwhile and holds it
      const held = lockOwner();
      expect(held).not.toBeNull();
      release.resume();
      expect(await release.next()).toMatch(/^RESULT:installed/);
      expect(lockOwner()).toBe(held);
      remove.resume();
      expect(await remove.next()).toMatch(/^RESULT:removed/);
      expect(fs.readFileSync(join(config, "settings.json"), "utf8")).toBe(ORIGINAL);
      expect(fs.readdirSync(config).filter((name) => name.startsWith(".herdr-statusline.lock"))).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 30_000);

  it.skipIf(ROLE !== undefined)("never removes a lock taken after the holder it found had released and gone", async () => {
    const { config, contender, cleanup, lockOwner } = setup();
    try {
      const install = contender("install");
      expect(await install.next()).toBe("installing"); // holds the lock
      const takeover = contender("takeover");
      expect(await takeover.next()).toBe("read-owner"); // has read the install's owner, still live
      install.resume();
      expect(await install.next()).toMatch(/^RESULT:installed/); // released the lock
      expect(await install.exited()).toBe(0); // and its process is gone
      const remove = contender("remove");
      expect(await remove.next()).toBe("removing"); // took the free lock and holds it
      const held = lockOwner();
      expect(held).not.toBeNull();
      takeover.resume();
      expect(await takeover.next()).toMatch(/^RESULT_ERROR:.*in progress/); // the lock it judged is not the one held now
      expect(lockOwner()).toBe(held);
      remove.resume();
      expect(await remove.next()).toMatch(/^RESULT:removed/);
      expect(fs.readFileSync(join(config, "settings.json"), "utf8")).toBe(ORIGINAL);
      expect(fs.readdirSync(config).filter((name) => name.startsWith(".herdr-statusline.lock"))).toEqual([]);
    } finally {
      await cleanup();
    }
  }, 30_000);
});
