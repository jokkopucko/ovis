import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { legacyName } from "../../../server/legacy-env.ts";
import { choosePort, compareVersions, coreEnv, endLeftover, installCore, layout, openLog, portFree, processCommand, processStart, processStartSync, readSaved, serverEnv, startServer, stopServer, withoutInherited, writeSaved } from "./children.ts";

const dirs: string[] = [];
const listeners: Server[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const listener of listeners.splice(0)) listener.close();
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ovis-desktop-"));
  dirs.push(dir);
  return dir;
}

/** a stand-in server: bin/bun is this Bun, server/server/index.ts the given script */
function fakeServer(script: string): ReturnType<typeof layout> {
  const root = tempDir();
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "server", "server"), { recursive: true });
  writeFileSync(join(root, "bin", "bun"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(root, "bin", "bun"), 0o755);
  writeFileSync(join(root, "server", "server", "index.ts"), script);
  return layout(root);
}

describe("environments", () => {
  it("gives hc the app's own session unless one is named", () => {
    expect(coreEnv({ PATH: "/bin" })["HC_SESSION"]).toBe("ovis");
    expect(coreEnv({ HC_SESSION: " test-1 " })["HC_SESSION"]).toBe("test-1");
    expect(coreEnv({ ELECTRON_RUN_AS_NODE: "1" })).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(coreEnv({ HC_SOCKET: "/run/user/1000/herdr-core/default.sock" })).not.toHaveProperty("HC_SOCKET");
  });

  it("runs the server on herdr-core through the bundled hc, on loopback, in the app's state folder", () => {
    const env = serverEnv({ PATH: "/bin", HOST: "0.0.0.0", HERDR_PLUGIN_ROOT: "/p", OVIS_MANAGED: "1", HERDR_SOCKET: "/s", OVIS_TOKEN: "t" }, { hc: "/app/bin/herdr-core", stateDir: "/data/server", port: 4321 });
    expect(env).toMatchObject({ PATH: "/bin", OVIS_RUNTIME: "herdr-core", OVIS_HC_BIN: "/app/bin/herdr-core", OVIS_STATE_DIR: "/data/server", HOST: "127.0.0.1", PORT: "4321", HC_SESSION: "ovis" });
    for (const name of ["HERDR_PLUGIN_ROOT", "OVIS_MANAGED", "HERDR_SOCKET", "OVIS_TOKEN"]) expect(env).not.toHaveProperty(name);
  });

  it("drops a token set under its name from before the rename, which the server would take back", () => {
    const old = legacyName("OVIS_TOKEN")!;
    const env = serverEnv({ [old]: "t", [legacyName("OVIS_TELEMETRY")!]: "0" }, { hc: "/hc", stateDir: "/s", port: 1 });
    expect(env).not.toHaveProperty(old);
    expect(env).toHaveProperty(legacyName("OVIS_TELEMETRY")!, "0");
  });
});

describe("withoutInherited", () => {
  it.if(process.platform === "linux")("starts a program without the descriptors its parent left open", () => {
    const [command, args] = withoutInherited("ls", ["/proc/self/fd"]);
    // the parent holds fd 9 and 23 open across exec, as Chromium does
    const listed = spawnSync("/bin/bash", ["-c", 'exec 9</dev/null 23</dev/null; exec "$@"', "parent", command, ...args], { encoding: "utf8" });
    const fds = listed.stdout.split("\n");
    expect(fds).toContain("2");
    expect(fds).not.toContain("9");
    expect(fds).not.toContain("23");
    const control = spawnSync("/bin/bash", ["-c", 'exec 9</dev/null 23</dev/null; exec "$@"', "parent", "ls", "/proc/self/fd"], { encoding: "utf8" });
    expect(control.stdout.split("\n")).toContain("23");
  });

  it("starts the program directly without bash", () => {
    expect(withoutInherited("/app/bin/bun", ["index.ts"], "/no/bash")).toEqual(["/app/bin/bun", ["index.ts"]]);
  });
});

describe("startServer", () => {
  it("resolves with the address the server says it listens on, and stops it", async () => {
    const programs = fakeServer(`console.log("Ovis listening on http://127.0.0.1:" + process.env.PORT); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "logs", "ovis.log"));
    const server = await startServer(programs, { ...process.env, PORT: "45678" }, log, 20_000);
    expect(server.url).toBe("http://127.0.0.1:45678");
    await stopServer(server, 5_000);
    expect(await server.exited).toBe(0);
    log.end();
  });

  it("fails with the end of the output when the server ends first", async () => {
    const programs = fakeServer(`console.error("Ovis cannot start: no herdr-core found."); process.exit(1);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    await expect(startServer(programs, process.env, log, 20_000)).rejects.toThrow(/stopped \(exit code 1\)\nOvis cannot start: no herdr-core found\./);
    log.end();
  });

  it("finds where it listens after more output than it keeps", async () => {
    const programs = fakeServer(`process.stdout.write("x".repeat(200 * 1024) + "\\n"); console.log("Ovis listening on http://127.0.0.1:" + process.env.PORT); process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    const server = await startServer(programs, { ...process.env, PORT: "45679" }, log, 20_000);
    expect(server.url).toBe("http://127.0.0.1:45679");
    await stopServer(server, 5_000);
    log.end();
  });

  it("fails when the server says nothing in time, and ends it", async () => {
    const programs = fakeServer(`setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    await expect(startServer(programs, process.env, log, 300)).rejects.toThrow(/did not start within/);
    log.end();
  });

  it("ends a server that ignores SIGTERM once the grace time is over", async () => {
    const programs = fakeServer(`process.on("SIGTERM", () => {}); console.log("Ovis listening on http://127.0.0.1:1"); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    const server = await startServer(programs, process.env, log, 20_000);
    await stopServer(server, 200);
    expect(server.child.signalCode).toBe("SIGKILL");
    log.end();
  });
});

describe("installCore", () => {
  /** an hc that records how it was run, beside itself */
  function fakeHc(dir: string, tag: string): string {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "herdr-core");
    writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then echo "hc ${tag}"; exit 0; fi\necho "$@" >> "$(dirname "$0")/ran"\n`);
    chmodSync(path, 0o755);
    return path;
  }

  it("copies the bundled hc into the data folder, then leaves an identical copy alone", async () => {
    const root = tempDir();
    const bundled = fakeHc(join(root, "bundle"), "0.1.17");
    const log = openLog(join(root, "ovis.log"));
    const installed = await installCore(bundled, join(root, "data", "bin"), process.env, log);
    expect(installed).toBe(join(root, "data", "bin", "herdr-core"));
    expect(readFileSync(installed, "utf8")).toBe(readFileSync(bundled, "utf8"));
    expect(await installCore(bundled, join(root, "data", "bin"), process.env, log)).toBe(installed);
    expect(() => readFileSync(join(root, "data", "bin", "ran"))).toThrow();
    log.end();
  });

  it("swaps a different copy the way hc's installer does, with hc update --from", async () => {
    const root = tempDir();
    const bundled = fakeHc(join(root, "bundle"), "0.1.18");
    const installed = fakeHc(join(root, "data", "bin"), "0.1.17");
    const log = openLog(join(root, "ovis.log"));
    expect(await installCore(bundled, join(root, "data", "bin"), process.env, log)).toBe(installed);
    expect(readFileSync(join(root, "data", "bin", "ran"), "utf8")).toBe(`update --from ${bundled}\n`);
    log.end();
  });
});

describe("installCore after a rollback", () => {
  it("keeps a newer hc in the data folder instead of asking it to go back", async () => {
    const root = tempDir();
    const write = (dir: string, version: string) => {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "herdr-core");
      writeFileSync(path, `#!/bin/sh\nif [ "$1" = --version ]; then echo "hc ${version}"; exit 0; fi\necho "$@" >> "$(dirname "$0")/ran"; exit 1\n`);
      chmodSync(path, 0o755);
      return path;
    };
    const bundled = write(join(root, "bundle"), "0.1.17");
    const installed = write(join(root, "data", "bin"), "0.1.18");
    const log = openLog(join(root, "ovis.log"));
    expect(await installCore(bundled, join(root, "data", "bin"), process.env, log)).toBe(installed);
    expect(() => readFileSync(join(root, "data", "bin", "ran"))).toThrow();
    log.end();
  });

  it("orders versions by number", () => {
    expect(compareVersions([0, 1, 18], [0, 1, 17])).toBeGreaterThan(0);
    expect(compareVersions([0, 2, 0], [0, 10, 0])).toBeLessThan(0);
    expect(compareVersions([0, 1, 17], [0, 1, 17])).toBe(0);
  });
});

describe("openLog", () => {
  it("keeps the previous run's log as .1", async () => {
    const path = join(tempDir(), "logs", "ovis.log");
    const first = openLog(path);
    await new Promise<void>((resolve) => first.end("first run\n", resolve));
    const second = openLog(path);
    await new Promise<void>((resolve) => second.end("second run\n", resolve));
    expect(readFileSync(`${path}.1`, "utf8")).toBe("first run\n");
    expect(readFileSync(path, "utf8")).toBe("second run\n");
  });
});

describe("choosePort", () => {
  it("keeps the saved port while it is free", async () => {
    const port = await choosePort(null);
    expect(await choosePort(port)).toBe(port);
  });

  it("takes another port when the saved one is in use", async () => {
    const taken = await new Promise<number>((resolve) => {
      const listener = createServer().listen({ host: "127.0.0.1", port: 0 }, () => {
        const address = listener.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
      listeners.push(listener);
    });
    expect(await portFree(taken)).toBe(false);
    const port = await choosePort(taken);
    expect(port).not.toBe(taken);
    expect(port).toBeGreaterThan(0);
  });
});

describe("saved settings", () => {
  it("round-trips, and reads a missing or broken file as nothing saved", () => {
    const dir = tempDir();
    const path = join(dir, "desktop.json");
    expect(readSaved(path)).toEqual({ port: null, server: null });
    writeSaved(path, { port: 4321, server: { pid: 99, bun: "/app/bin/bun", started: "Wed Nov  4 08:00:00 2026" } });
    expect(readSaved(path)).toEqual({ port: 4321, server: { pid: 99, bun: "/app/bin/bun", started: "Wed Nov  4 08:00:00 2026" } });
    writeFileSync(path, "{");
    expect(readSaved(path)).toEqual({ port: null, server: null });
  });
});

describe("endLeftover", () => {
  it("ends only the same process: this app's Bun on its server, started at the recorded time", async () => {
    const programs = fakeServer(`process.on("SIGTERM", () => process.exit(0)); console.log("Ovis listening on http://127.0.0.1:1"); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    let spawned = 0;
    const server = await startServer(programs, process.env, log, 20_000, () => { spawned += 1; });
    expect(spawned).toBe(1);
    const pid = server.child.pid!;
    const ours = { command: async () => `${programs.bun} ${programs.server}/server/index.ts`, started: async () => "then" };
    expect(await endLeftover({ pid, bun: programs.bun, started: "then" }, { ...ours, command: async () => `/other/bun ${programs.server}/server/index.ts` })).toBe(false);
    expect(await endLeftover({ pid, bun: programs.bun, started: "then" }, { ...ours, command: async () => null })).toBe(false);
    expect(await endLeftover({ pid, bun: programs.bun, started: "then" }, { ...ours, started: async () => "later" })).toBe(false);
    expect(await endLeftover({ pid, bun: programs.bun, started: null }, ours)).toBe(false);
    expect(server.child.exitCode).toBeNull();
    expect(await endLeftover({ pid, bun: programs.bun, started: "then" }, ours)).toBe(true);
    expect(await server.exited).toBe(0);
    log.end();
  });

  it("reads a live process's start time and command, and nothing for one that is gone", async () => {
    expect(await processStart(process.pid)).toMatch(/\d{4}$/);
    expect(processStartSync(process.pid)).toBe(await processStart(process.pid));
    expect(await processCommand(process.pid)).toContain("bun");
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    expect(await processStart(gone.pid)).toBeNull();
  });
});
