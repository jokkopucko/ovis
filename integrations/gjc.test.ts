import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GJC_NATIVE_LEASE_MS, type GjcNativeBinding } from "../shared/gjc-native.ts";
import { readGjcNativeBinding } from "../server/gjc-native.ts";
import { createGjcNativePublisher, type GjcNativeContext, type GjcNativePublisherOptions, type GjcNativeSessionManager } from "./gjc.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function home(): string {
  const directory = mkdtempSync(join(tmpdir(), "herdr-gjc-native-"));
  homes.push(directory);
  return directory;
}

function session(homeDir: string, project: string, name: string, contents = "{}\n"): string {
  const file = join(homeDir, ".gjc", "agent", "sessions", project, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, contents);
  return file;
}

function manager(file: string | null, id = "session-id", cwd = "/work/project"): GjcNativeSessionManager {
  return {
    getSessionFile: () => file,
    getSessionId: () => id,
    getCwd: () => cwd,
  };
}

function context(sessionManager: GjcNativeSessionManager, hasUI = true): GjcNativeContext { return { sessionManager, hasUI }; }

function recordAt(homeDir: string, pid: number): GjcNativeBinding {
  return JSON.parse(readFileSync(join(homeDir, ".gjc", "agent", "herdr-web-ui", `${pid}.json`), "utf8")) as GjcNativeBinding;
}

function publisher(homeDir: string, overrides: Partial<GjcNativePublisherOptions> = {}) {
  return createGjcNativePublisher({
    home: homeDir,
    pid: 4312,
    instanceId: "instance-main",
    processStartedAt: () => 123_456,
    now: () => 200_000,
    ...overrides,
  });
}

it("publishes lifecycle updates, exact accessor values, unwritten state, and removes only its own record", async () => {
  const homeDir = home();
  const firstPath = session(homeDir, "project-a", "one.jsonl");
  let file: string | null = firstPath;
  let id = "one";
  let cwd = "/work/one";
  const mainManager: GjcNativeSessionManager = {
    getSessionFile: () => file,
    getSessionId: () => id,
    getCwd: () => cwd,
  };
  let unrefCalls = 0;
  let cleared = false;
  const fakeTimer = { unref: () => { unrefCalls++; } } as unknown as ReturnType<typeof setInterval>;
  const setTimer = ((handler: Parameters<typeof setInterval>[0], _delay: number) => {
    void handler;
    return fakeTimer;
  }) as typeof setInterval;
  const clearTimer = ((timer: ReturnType<typeof setInterval>) => { if (timer === fakeTimer) cleared = true; }) as typeof clearInterval;
  const pub = publisher(homeDir, { setInterval: setTimer, clearInterval: clearTimer });

  await pub.lifecycle("session_start", context(mainManager));
  expect(recordAt(homeDir, 4312)).toMatchObject({
    version: 1,
    pid: 4312,
    processStartedAt: 123_456,
    instanceId: "instance-main",
    sequence: 1,
    session: { id: "one", path: firstPath, cwd: "/work/one" },
  });
  expect(unrefCalls).toBe(1);
  if (process.platform !== "win32") expect(statSync(join(homeDir, ".gjc", "agent", "herdr-web-ui", "4312.json")).mode & 0o777).toBe(0o600);

  const secondPath = session(homeDir, "project-a", "two.jsonl");
  file = secondPath;
  id = "two";
  cwd = "/work/two";
  await pub.lifecycle("session_switch", context(mainManager));
  expect(recordAt(homeDir, 4312)).toMatchObject({ sequence: 2, session: { id: "two", path: secondPath, cwd: "/work/two" } });

  const branchPath = session(homeDir, "project-a", "branch.jsonl");
  file = branchPath;
  id = "branch";
  await pub.lifecycle("session_branch", context(mainManager));
  expect(recordAt(homeDir, 4312)).toMatchObject({ sequence: 3, session: { id: "branch", path: branchPath } });

  const notWrittenPath = join(homeDir, ".gjc", "agent", "sessions", "project-a", "not-written.jsonl");
  file = notWrittenPath;
  await pub.lifecycle("session_switch", context(mainManager));
  expect(existsSync(notWrittenPath)).toBe(false);
  expect(recordAt(homeDir, 4312)).toMatchObject({ sequence: 4, session: { id: "branch", path: notWrittenPath, cwd: "/work/two" } });

  file = null;
  await pub.heartbeat();
  expect(recordAt(homeDir, 4312)).toMatchObject({ sequence: 5, session: null });

  const childPath = join(homeDir, ".gjc", "agent", "sessions", "project-a", "branch.jsonl", "subagents", "child.jsonl");
  const subagent = context(manager(childPath, "child"), false);
  await pub.lifecycle("session_start", subagent);
  await pub.shutdown(subagent);
  expect(recordAt(homeDir, 4312)).toMatchObject({ sequence: 5, session: null });

  await pub.shutdown(context(mainManager));
  expect(existsSync(join(homeDir, ".gjc", "agent", "herdr-web-ui", "4312.json"))).toBe(false);
  expect(cleared).toBe(true);
});

it("rejects nested subagent paths before publishing a main binding", async () => {
  const homeDir = home();
  const childPath = join(homeDir, ".gjc", "agent", "sessions", "project-a", "parent.jsonl", "subagents", "child.jsonl");
  const pub = publisher(homeDir);
  const subagent = context(manager(childPath, "child"));
  await pub.lifecycle("session_start", subagent);
  expect(recordAt(homeDir, 4312)).toMatchObject({ session: null });
  await pub.shutdown(subagent);
  expect(existsSync(join(homeDir, ".gjc", "agent", "herdr-web-ui", "4312.json"))).toBe(false);
});

it("canonicalizes the existing parent and publishes an unsaved session path", async () => {
  if (process.platform === "win32") return;
  const homeDir = home();
  const savedPath = session(homeDir, "real-project", "seed.jsonl");
  const aliasDirectory = join(homeDir, ".gjc", "agent", "sessions", "alias-project");
  symlinkSync(dirname(savedPath), aliasDirectory, "dir");
  const accessorPath = join(aliasDirectory, "new-session.jsonl");
  const canonicalPath = join(realpathSync(dirname(accessorPath)), "new-session.jsonl");
  const pub = publisher(homeDir);

  await pub.lifecycle("session_start", context(manager(accessorPath, "new-session")));

  expect(recordAt(homeDir, 4312)).toMatchObject({
    sequence: 1,
    session: { id: "new-session", path: canonicalPath, cwd: "/work/project" },
  });
  expect(existsSync(accessorPath)).toBe(false);
  await pub.shutdown(context(manager(accessorPath, "new-session")));
});

it("refreshes the latest live accessors on heartbeat", async () => {
  const homeDir = home();
  const path = session(homeDir, "project-a", "one.jsonl");
  let id = "before";
  let cwd = "/work/before";
  let timestamp = 200_000;
  const mainManager: GjcNativeSessionManager = {
    getSessionFile: () => path,
    getSessionId: () => id,
    getCwd: () => cwd,
  };
  const pub = publisher(homeDir, { now: () => timestamp });
  await pub.lifecycle("session_start", context(mainManager));
  id = "after";
  cwd = "/work/after";
  await pub.heartbeat();
  expect(recordAt(homeDir, 4312)).toMatchObject({ sequence: 2, session: { id: "after", path, cwd: "/work/after" } });
  const firstUpdatedAt = recordAt(homeDir, 4312).updatedAt;
  timestamp++;
  await pub.heartbeat();
  expect(recordAt(homeDir, 4312)).toMatchObject({ sequence: 2, updatedAt: firstUpdatedAt + 1 });
  await pub.shutdown(context(mainManager));
});

it("does not scan or delete records owned by other process IDs", async () => {
  const homeDir = home();
  const directory = join(homeDir, ".gjc", "agent", "herdr-web-ui");
  mkdirSync(directory, { recursive: true });
  const binding = (pid: number, updatedAt: number): GjcNativeBinding => ({
    version: 1, pid, processStartedAt: 50_000, instanceId: `instance-${pid}`, sequence: 1, updatedAt, session: null,
  });
  writeFileSync(join(directory, "100.json"), JSON.stringify(binding(100, 80_000)));
  writeFileSync(join(directory, "101.json"), JSON.stringify(binding(101, 199_999)));
  writeFileSync(join(directory, "102.json"), "not a binding");
  const path = session(homeDir, "project-a", "main.jsonl");
  const pub = publisher(homeDir);
  const main = context(manager(path));
  await pub.lifecycle("session_start", main);
  expect(existsSync(join(directory, "100.json"))).toBe(true);
  expect(existsSync(join(directory, "101.json"))).toBe(true);
  expect(existsSync(join(directory, "102.json"))).toBe(true);
  await pub.shutdown(main);
});

it("ignores non-UI lifecycle and shutdown contexts without starting or stopping publishing", async () => {
  const homeDir = home();
  const path = session(homeDir, "project-a", "main.jsonl");
  const main = context(manager(path));
  let timerStarts = 0;
  let timerStops = 0;
  const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;
  const pub = publisher(homeDir, {
    setInterval: (() => { timerStarts++; return timer; }) as unknown as typeof setInterval,
    clearInterval: (() => { timerStops++; }) as typeof clearInterval,
  });

  await pub.lifecycle("session_start", { sessionManager: manager(path) });
  await pub.shutdown({ sessionManager: manager(path) });
  await pub.lifecycle("session_start", context(manager(path), false));
  expect(timerStarts).toBe(0);
  expect(existsSync(join(homeDir, ".gjc", "agent", "herdr-web-ui", "4312.json"))).toBe(false);

  await pub.lifecycle("session_start", main);
  const before = recordAt(homeDir, 4312);
  const childPath = session(homeDir, "project-a", "child.jsonl");
  await pub.lifecycle("session_switch", context(manager(childPath, "child"), false));
  await pub.shutdown(context(manager(path), false));
  expect(recordAt(homeDir, 4312)).toEqual(before);
  expect(timerStarts).toBe(1);
  expect(timerStops).toBe(0);

  await pub.shutdown(main);
  expect(timerStops).toBe(1);
  expect(existsSync(join(homeDir, ".gjc", "agent", "herdr-web-ui", "4312.json"))).toBe(false);
});

it("does not replace or remove another live publisher instance for this PID", async () => {
  const homeDir = home();
  const path = session(homeDir, "project-a", "main.jsonl");
  const directory = join(homeDir, ".gjc", "agent", "herdr-web-ui");
  mkdirSync(directory, { recursive: true });
  const existing: GjcNativeBinding = {
    version: 1, pid: 4312, processStartedAt: 123_456, instanceId: "instance-other", sequence: 8, updatedAt: 199_999, session: null,
  };
  writeFileSync(join(directory, "4312.json"), JSON.stringify(existing));
  const pub = publisher(homeDir);
  const main = context(manager(path));
  await pub.lifecycle("session_start", main);
  await pub.shutdown(main);
  expect(recordAt(homeDir, 4312)).toMatchObject({ instanceId: "instance-other", sequence: 8 });
});

it("rejects the same malformed record shapes in the publisher and server", async () => {
  const homeDir = home();
  const path = session(homeDir, "project-a", "main.jsonl");
  const directory = join(homeDir, ".gjc", "agent", "herdr-web-ui");
  mkdirSync(directory, { recursive: true });
  const existing: GjcNativeBinding = {
    version: 1, pid: 4312, processStartedAt: 123_456, instanceId: "instance-other", sequence: 8, updatedAt: 199_999,
    session: { id: "main", path, cwd: homeDir },
  };
  for (const malformed of [
    { ...existing, extra: true },
    { ...existing, processStartedAt: 123_456.5 },
    { ...existing, instanceId: "x".repeat(257) },
    { ...existing, instanceId: "instance\u0000other" },
    { ...existing, session: { ...existing.session, id: "main", path, cwd: homeDir, extra: true } },
    { ...existing, session: { id: "main", path: "relative.jsonl", cwd: homeDir } },
  ]) {
    writeFileSync(join(directory, "4312.json"), JSON.stringify(malformed));
    const pub = publisher(homeDir, { processStartedAt: () => malformed.processStartedAt });
    const main = context(manager(path));
    try {
      const binding = readGjcNativeBinding(homeDir, 4312, 200_000);
      await pub.lifecycle("session_start", main);

      expect(binding).toBeNull();
      expect(recordAt(homeDir, 4312).instanceId).toBe("instance-main");
    } finally { await pub.shutdown(main); }
  }
});

it("replaces another publisher's lease exactly when the server expires it", async () => {
  const homeDir = home();
  const path = session(homeDir, "project-a", "main.jsonl");
  const directory = join(homeDir, ".gjc", "agent", "herdr-web-ui");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "4312.json"), JSON.stringify({
    version: 1, pid: 4312, processStartedAt: 123_456, instanceId: "instance-other", sequence: 8,
    updatedAt: 200_000 - GJC_NATIVE_LEASE_MS, session: null,
  }));
  const pub = publisher(homeDir);
  const main = context(manager(path));
  try {
    const expired = readGjcNativeBinding(homeDir, 4312, 200_000);
    await pub.lifecycle("session_start", main);

    expect(expired).toBeNull();
    expect(recordAt(homeDir, 4312)).toMatchObject({ instanceId: "instance-main", sequence: 1 });
  } finally { await pub.shutdown(main); }
});

it("checks record size with fstat before a bounded 16 KiB read", async () => {
  const homeDir = home();
  const path = session(homeDir, "project-a", "main.jsonl");
  const target = join(homeDir, ".gjc", "agent", "herdr-web-ui", "4312.json");
  let fstatBeforeRead = false;
  let readCount = 0;
  let maximumReadLength = 0;
  const fileSystem = {
    ...fs,
    fstatSync: (fd: number) => { fstatBeforeRead = true; return fs.fstatSync(fd); },
    readSync: (fd: number, buffer: Uint8Array, offset: number, length: number, position: number) => {
      expect(fstatBeforeRead).toBe(true);
      fstatBeforeRead = false;
      readCount++;
      maximumReadLength = Math.max(maximumReadLength, length);
      return fs.readSync(fd, buffer, offset, length, position);
    },
  };
  const pub = publisher(homeDir, { fileSystem });
  const main = context(manager(path));
  await pub.lifecycle("session_start", main);
  await pub.heartbeat();
  expect(readCount).toBe(1);
  expect(maximumReadLength).toBeLessThanOrEqual(16 * 1024);

  writeFileSync(target, `{"version":1,"padding":"${"x".repeat(20 * 1024)}"}`);
  const readsBeforeOversized = readCount;
  fstatBeforeRead = false;

  await pub.shutdown(main);

  expect(fstatBeforeRead).toBe(true);
  expect(readCount).toBe(readsBeforeOversized);
  expect(existsSync(target)).toBe(true);
  expect(statSync(target).size).toBeGreaterThan(16 * 1024);
});

it("cannot revive a queued start after shutdown", async () => {
  const homeDir = home();
  const path = session(homeDir, "project-a", "main.jsonl");
  let resolveBirth!: (value: number | null) => void;
  const birth = new Promise<number | null>((resolveBirthValue) => { resolveBirth = resolveBirthValue; });
  const pub = publisher(homeDir, { processStartedAt: () => birth });
  const main = context(manager(path));
  const starting = pub.lifecycle("session_start", main);
  const stopping = pub.shutdown(main);
  resolveBirth(123_456);
  await Promise.all([starting, stopping]);
  expect(existsSync(join(homeDir, ".gjc", "agent", "herdr-web-ui", "4312.json"))).toBe(false);
});

it("treats an unavailable birth timestamp and filesystem errors as harmless", async () => {
  const homeDir = home();
  const path = session(homeDir, "project-a", "main.jsonl");
  const unavailable = publisher(homeDir, { processStartedAt: () => null });
  const main = context(manager(path));
  await expect(unavailable.lifecycle("session_start", main)).resolves.toBeUndefined();
  expect(existsSync(join(homeDir, ".gjc", "agent", "herdr-web-ui", "4312.json"))).toBe(false);
  await unavailable.shutdown(main);

  const blockedHome = join(homeDir, "not-a-directory");
  writeFileSync(blockedHome, "file");
  const blockedPath = resolve(blockedHome, ".gjc", "agent", "sessions", "project-a", "main.jsonl");
  const blocked = publisher(blockedHome);
  const blockedContext = context(manager(blockedPath));
  await expect(blocked.lifecycle("session_start", blockedContext)).resolves.toBeUndefined();
  await blocked.shutdown(blockedContext);
});
