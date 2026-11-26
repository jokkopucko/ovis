import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { legacyName } from "../../../server/legacy-env.ts";
import { readSaved } from "../../../shared/desktop-command-listener.ts";
import { processStart, processStartSync, withoutInherited } from "../../../shared/desktop-process.ts";
import { choosePort, compareVersions, coreEnv, endLeftover, installCore, layout, openLog, portFree, processCommand, serverEnv, startCore, startServer, stopServer, writeSaved } from "./children.ts";

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

function fakeServer(script: string): ReturnType<typeof layout> {
  const root = tempDir();
  mkdirSync(join(root, "server"), { recursive: true });
  writeFileSync(join(root, "script.ts"), script);
  writeFileSync(join(root, "server", "ovis-server"), `#!/bin/sh\n[ "$1" = serve ] || exit 64\nexec "${process.execPath}" "${join(root, "script.ts")}"\n`);
  chmodSync(join(root, "server", "ovis-server"), 0o755);
  return layout(root);
}

describe("environments", () => {
  it("gives hc the app's own session unless one is named", () => {
    expect(coreEnv({ PATH: "/bin" })["HC_SESSION"]).toBe("ovis");
    expect(coreEnv({ HC_SESSION: " test-1 " })["HC_SESSION"]).toBe("test-1");
    expect(coreEnv({ ELECTRON_RUN_AS_NODE: "1" })).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(coreEnv({ HC_SOCKET: "/run/user/1000/herdr-core/default.sock" })).not.toHaveProperty("HC_SOCKET");
  });

  it("keeps the AppImage's own settings out of hc and the terminals that outlive the app", () => {
    const mount = "/tmp/.mount_OvisAb12";
    const env = coreEnv({
      APPDIR: mount, APPIMAGE: "/home/u/Ovis.AppImage", ARGV0: "Ovis.AppImage", OWD: "/home/u",
      PATH: `${mount}:${mount}/usr/sbin:/usr/bin::/bin`,
      LD_LIBRARY_PATH: `${mount}/usr/lib`,
      XDG_DATA_DIRS: `${mount}/usr/share/:/usr/local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/`,
      GSETTINGS_SCHEMA_DIR: `${mount}/usr/share/glib-2.0/schemas:/opt/schemas`,
    }, `${mount}/ovis`);
    for (const name of ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "LD_LIBRARY_PATH"]) expect(env).not.toHaveProperty(name);
    // the user's own empty entry (the current folder) stays
    expect(env["PATH"]).toBe("/usr/bin::/bin");
    expect(env["XDG_DATA_DIRS"]).toBe("/usr/local/share:/usr/share:/usr/share/gnome:/usr/local/share/:/usr/share/");
    expect(env["GSETTINGS_SCHEMA_DIR"]).toBe("/opt/schemas");
  });

  it("leaves the environment alone outside an AppImage", () => {
    const base = { PATH: "/usr/bin", LD_LIBRARY_PATH: "/opt/lib", XDG_DATA_DIRS: "/usr/share" };
    expect(coreEnv(base, "/opt/Ovis/ovis")).toMatchObject(base);
  });

  it("keeps another AppImage's settings the app was only started under", () => {
    const base = { APPDIR: "/tmp/.mount_Other", APPIMAGE: "/home/u/Other.AppImage", PATH: "/tmp/.mount_Other/usr/bin:/usr/bin", LD_LIBRARY_PATH: "/tmp/.mount_Other/usr/lib" };
    expect(coreEnv(base, "/opt/Ovis/ovis")).toMatchObject(base);
  });

  it("runs the server on herdr-core through the bundled hc, on loopback, in the app's state folder", () => {
    const env = serverEnv({ PATH: "/bin", HOST: "0.0.0.0", HERDR_PLUGIN_ROOT: "/p", OVIS_MANAGED: "1", HERDR_SOCKET: "/s", OVIS_TOKEN: "t" }, { hc: "/app/bin/herdr-core", stateDir: "/data/server", port: 4321 });
    expect(env).toMatchObject({ PATH: "/bin", OVIS_RUNTIME: "herdr-core", OVIS_HC_BIN: "/app/bin/herdr-core", OVIS_HC_BIN_BUNDLED: "1", OVIS_STATE_DIR: "/data/server", HOST: "127.0.0.1", PORT: "4321", HC_SESSION: "ovis", OVIS_DESKTOP_APP: "1" });
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

  it("starts the program directly on Windows, whatever bash the PC has", () => {
    expect(withoutInherited("C:\\app\\bin\\bun.exe", ["index.ts"], process.execPath, "win32")).toEqual(["C:\\app\\bin\\bun.exe", ["index.ts"]]);
  });
});

describe("layout", () => {
  it("names the Windows programs with .exe", () => {
    expect(layout("/r", "win32")).toEqual({ bun: join("/r", "bin", "bun.exe"), hc: join("/r", "bin", "herdr-core.exe"), server: join("/r", "server"), serverBinary: join("/r", "server", "ovis-server.exe") });
    expect(layout("/r", "linux").hc).toBe(join("/r", "bin", "herdr-core"));
  });
});

// the stand-ins below are POSIX shell scripts, which Windows cannot run
const posix = process.platform !== "win32";

describe.skipIf(!posix)("startCore", () => {
  it("starts the core in the home folder, where a workspace with no folder opens, not in the app's", async () => {
    const root = tempDir();
    const hc = join(root, "herdr-core");
    writeFileSync(hc, `#!/bin/sh\npwd > "$(dirname "$0")/cwd"\n`);
    chmodSync(hc, 0o755);
    const log = openLog(join(root, "ovis.log"));
    await startCore(hc, process.env, log);
    expect(realpathSync(readFileSync(join(root, "cwd"), "utf8").trim())).toBe(realpathSync(homedir()));
    await new Promise<void>((resolve) => log.end(resolve));
  });

  it("still starts the core when the home folder is not there", async () => {
    const root = tempDir();
    const hc = join(root, "herdr-core");
    writeFileSync(hc, `#!/bin/sh\npwd > "$(dirname "$0")/cwd"\n`);
    chmodSync(hc, 0o755);
    const log = openLog(join(root, "ovis.log"));
    await startCore(hc, process.env, log, 30_000, join(root, "gone"));
    expect(realpathSync(readFileSync(join(root, "cwd"), "utf8").trim())).toBe(realpathSync(process.cwd()));
    await new Promise<void>((resolve) => log.end(resolve));
  });
});

describe.skipIf(!posix)("startServer", () => {
  it("resolves with the address the server says it listens on, and stops it", async () => {
    const programs = fakeServer(`process.on("SIGTERM", () => process.exit(0)); console.log("Ovis listening on http://127.0.0.1:" + process.env.PORT); setInterval(() => {}, 1000);`);
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
    const programs = fakeServer(`process.on("SIGTERM", () => process.exit(0)); process.stdout.write("x".repeat(200 * 1024) + "\\n"); console.log("Ovis listening on http://127.0.0.1:" + process.env.PORT); setInterval(() => {}, 1000);`);
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

  it("takes the ConPTY beside the bundled hc along on a first copy, as hc on Windows needs it there", async () => {
    const root = tempDir();
    const bundled = fakeHc(join(root, "bundle"), "0.1.17");
    mkdirSync(join(root, "bundle", "conpty", "x64"), { recursive: true });
    writeFileSync(join(root, "bundle", "conpty", "conpty.dll"), "dll");
    writeFileSync(join(root, "bundle", "conpty", "x64", "OpenConsole.exe"), "exe");
    const log = openLog(join(root, "ovis.log"));
    await installCore(bundled, join(root, "data", "bin"), process.env, log);
    expect(readFileSync(join(root, "data", "bin", "conpty", "conpty.dll"), "utf8")).toBe("dll");
    expect(readFileSync(join(root, "data", "bin", "conpty", "x64", "OpenConsole.exe"), "utf8")).toBe("exe");
    await new Promise<void>((resolve) => log.end(resolve));
  });

  it.skipIf(!posix)("swaps a different copy the way hc's installer does, with hc update --from", async () => {
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
  it.skipIf(!posix)("keeps a newer hc in the data folder instead of asking it to go back", async () => {
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

  it("has the file open once it returns, so its folder going away later does not fail the stream", async () => {
    const dir = tempDir();
    const path = join(dir, "ovis.log");
    const log = openLog(path);
    expect(existsSync(path)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
    const failed = new Promise<Error>((resolve) => log.once("error", resolve));
    const closed = new Promise<null>((resolve) => log.once("close", () => resolve(null)));
    log.end("after the folder went\n");
    expect(await Promise.race([failed, closed])).toBeNull();
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
  it.skipIf(!posix)("ends only the same process: this app's server binary serving, started at the recorded time", async () => {
    const programs = fakeServer(`process.on("SIGTERM", () => process.exit(0)); console.log("Ovis listening on http://127.0.0.1:1"); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    let spawned = 0;
    const server = await startServer(programs, process.env, log, 20_000, () => { spawned += 1; });
    expect(spawned).toBe(1);
    const pid = server.child.pid!;
    const binary = programs.serverBinary;
    const ours = { command: async () => `${binary} serve`, started: async () => "then" };
    expect(await endLeftover({ pid, bun: binary, started: "then" }, { ...ours, command: async () => `/other/ovis-server serve` })).toBe(false);
    // the same binary running another entry is not the app's server
    expect(await endLeftover({ pid, bun: binary, started: "then" }, { ...ours, command: async () => `${binary} plugin status` })).toBe(false);
    expect(await endLeftover({ pid, bun: binary, started: "then" }, { ...ours, command: async () => null })).toBe(false);
    expect(await endLeftover({ pid, bun: binary, started: "then" }, { ...ours, started: async () => "later" })).toBe(false);
    expect(await endLeftover({ pid, bun: binary, started: null }, ours)).toBe(false);
    expect(server.child.exitCode).toBeNull();
    // Windows quotes a program path with a space in it; a quoted other program is still not ours
    expect(await endLeftover({ pid, bun: binary, started: "then" }, { ...ours, command: async () => `"/other/ovis-server" serve` })).toBe(false);
    expect(await endLeftover({ pid, bun: binary, started: "then" }, { ...ours, command: async () => `"${binary}" serve` })).toBe(true);
    expect(await server.exited).toBe(0);
    log.end();
  });

  it.skipIf(!posix)("ends the server an app from before the binary left: its Bun on the server's source", async () => {
    const programs = fakeServer(`process.on("SIGTERM", () => process.exit(0)); console.log("Ovis listening on http://127.0.0.1:1"); setInterval(() => {}, 1000);`);
    const log = openLog(join(tempDir(), "ovis.log"));
    const server = await startServer(programs, process.env, log, 20_000);
    const pid = server.child.pid!;
    const ours = { command: async () => `${programs.bun} ${programs.server}/server/index.ts`, started: async () => "then" };
    expect(await endLeftover({ pid, bun: programs.bun, started: "then" }, { ...ours, command: async () => `/other/bun ${programs.server}/server/index.ts` })).toBe(false);
    expect(await endLeftover({ pid, bun: programs.bun, started: "then" }, ours)).toBe(true);
    expect(await server.exited).toBe(0);
    log.end();
  });

  it("reads a live process's start time and command, and nothing for one that is gone", async () => {
    // ps's `Wed Nov  4 08:00:00 2026`, or CIM's UTC `2026-11-04T08:00:00.1234560Z` on Windows
    expect(await processStart(process.pid)).toMatch(process.platform === "win32" ? /^\d{4}-\d\d-\d\dT.*Z$/ : /\d{4}$/);
    expect(processStartSync(process.pid)).toBe(await processStart(process.pid));
    expect(await processCommand(process.pid)).toContain("bun");
    const gone = Bun.spawn(process.platform === "win32" ? ["cmd.exe", "/c", "exit"] : ["true"]);
    await gone.exited;
    expect(await processStart(gone.pid)).toBeNull();
    // each lookup on Windows starts PowerShell for its CIM query: over 5 s for the four on a cold runner, at most 15 s each
  }, 90_000);

  it.skipIf(process.platform !== "win32")("reads a command line whose path is not ASCII whole, as a user name may be", async () => {
    const dir = join(tempDir(), "오비스 사용자");
    mkdirSync(dir);
    const exe = join(dir, "ping.exe");
    copyFileSync(join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "ping.exe"), exe);
    const child = Bun.spawn([exe, "-n", "60", "127.0.0.1"], { stdout: "ignore", stderr: "ignore" });
    try {
      expect(await processCommand(child.pid)).toContain(dir);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 90_000);
});
