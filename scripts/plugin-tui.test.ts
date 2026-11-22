import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findTui, lookupMessage, runTui, tuiEnv, tuiPaths, WINDOWS_MESSAGE, type TuiOptions } from "./plugin-tui.ts";

const ROOT = join(import.meta.dir, "..");
let scratch: string;

const STANDIN = `#!/bin/sh
{
  for arg in "$@"; do printf 'arg:%s\\n' "$arg"; done
  printf 'url:%s\\n' "\${OVIS_URL-}"
  if [ "\${OVIS_TOKEN+set}" = set ]; then printf 'token:%s\\n' "$OVIS_TOKEN"; else echo token-unset; fi
} > "$STANDIN_RECORD"
if [ -n "\${STANDIN_READY:-}" ]; then echo ready; read -r line; fi
if [ -n "\${STANDIN_SIGNAL:-}" ]; then kill -"$STANDIN_SIGNAL" $$; fi
exit "\${STANDIN_EXIT:-0}"
`;

function standIn(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, STANDIN);
  chmodSync(path, 0o755);
  return path;
}

interface Seen { readonly args: string[]; readonly url: string; readonly token: string | null }

function record(): Seen | null {
  const file = join(scratch, "record");
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
  const token = lines.find((line) => line.startsWith("token:"));
  return {
    args: lines.filter((line) => line.startsWith("arg:")).map((line) => line.slice(4)),
    url: lines.find((line) => line.startsWith("url:"))?.slice(4) ?? "",
    token: token === undefined ? null : token.slice(6),
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ovis-plugin-tui-"));
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("which program runs", () => {
  const where = { root: "/install", home: "/home/me" };
  const [installed, beside, built] = tuiPaths(where.root) as [string, string, string];
  const only = (...files: string[]) => (path: string) => files.includes(path);

  it("is OVIS_TUI_BIN first, then the install's bin/, then a local build", () => {
    const all = only("/opt/tui", installed, built);
    expect(findTui({ OVIS_TUI_BIN: "/opt/tui" }, where, all)).toEqual({ kind: "found", path: "/opt/tui" });
    expect(findTui({}, where, all)).toEqual({ kind: "found", path: "/install/bin/ovis-tui" });
    expect(findTui({ OVIS_TUI_BIN: "" }, where, only(built))).toEqual({ kind: "found", path: "/install/crates/ovis-tui/target/release/ovis-tui" });
    expect(findTui({}, where, only(beside, built))).toEqual({ kind: "found", path: "/install/ovis-tui" });
    expect(findTui({}, where, only())).toEqual({ kind: "missing", looked: [installed, beside, built] });
  });

  it("does not fall back to the install's own when OVIS_TUI_BIN names no file", () => {
    expect(findTui({ OVIS_TUI_BIN: "/opt/gone" }, where, only(installed, built))).toEqual({ kind: "configured-missing", path: "/opt/gone" });
  });

  it("finds the program beside a compiled install's server, whose root is its bin/", () => {
    expect(tuiPaths("/home/me/.local/share/ovis/bin")).toContain("/home/me/.local/share/ovis/bin/ovis-tui");
  });

  it("checks a bare OVIS_TUI_BIN as the PATH finds it, the file that would run", () => {
    const onPath = (name: string) => (name === "ovis-tui" ? "/usr/local/bin/ovis-tui" : null);
    expect(findTui({ OVIS_TUI_BIN: "ovis-tui" }, { ...where, onPath }, only("/usr/local/bin/ovis-tui"))).toEqual({ kind: "found", path: "/usr/local/bin/ovis-tui" });
    expect(findTui({ OVIS_TUI_BIN: "ovis-tui" }, { ...where, onPath }, only("ovis-tui"))).toEqual({ kind: "configured-missing", path: "/usr/local/bin/ovis-tui" });
  });

  it("takes a leading ~/ in OVIS_TUI_BIN as the home folder", () => {
    expect(findTui({ OVIS_TUI_BIN: "~/bin/ovis-tui" }, where, only("/home/me/bin/ovis-tui"))).toEqual({ kind: "found", path: "/home/me/bin/ovis-tui" });
  });
});

describe("the program's environment", () => {
  it("is the caller's without the Ovis server's token or address", () => {
    expect(tuiEnv({ TERM: "xterm", OVIS_TOKEN: "exported", OVIS_URL: "http://127.0.0.1:9", HERDR_WEB_TOKEN: "old-name", HC_SESSION: "s" }))
      .toEqual({ TERM: "xterm", HC_SESSION: "s" });
  });
});

describe("runTui", () => {
  function options(extra: Partial<TuiOptions> = {}): TuiOptions & { readonly said: string[] } {
    const said: string[] = [];
    return {
      platform: "linux",
      where: { root: join(scratch, "root"), home: scratch },
      settings: { OVIS_TUI_BIN: join(scratch, "ovis-tui"), OVIS_TOKEN: "secret" },
      err: (text) => said.push(text),
      on: () => () => undefined,
      ...extra,
      caller: { PATH: process.env["PATH"], STANDIN_RECORD: join(scratch, "record"), ...extra.caller },
      said,
    };
  }

  it("passes every argument through unchanged, and no token, configured or exported", async () => {
    standIn(join(scratch, "ovis-tui"));
    const args = ["--session", "two words", ""];
    expect(await runTui(args, options({ caller: { OVIS_TOKEN: "exported" } }))).toBe(0);
    expect(record()).toEqual({ args, url: "", token: null });
  });

  it("exits with the program's code, or 128 + the signal that ended it", async () => {
    standIn(join(scratch, "ovis-tui"));
    expect(await runTui([], options({ caller: { STANDIN_EXIT: "3" } }))).toBe(3);
    expect(await runTui([], options({ caller: { STANDIN_SIGNAL: "TERM" } }))).toBe(128 + 15);
  });

  it("says where it looked and how to build the program when there is none", async () => {
    const run = options({ settings: {} });
    expect(await runTui([], run)).toBe(1);
    const said = run.said.join("");
    for (const path of tuiPaths(join(scratch, "root"))) expect(said).toContain(path);
    expect(said).toContain("crates/ovis-tui/prepare.sh");
    expect(said).toContain("cargo build --release --manifest-path crates/ovis-tui/Cargo.toml");
  });

  it("names a set OVIS_TUI_BIN that is no file", async () => {
    standIn(join(scratch, "root", "bin", "ovis-tui"));
    const run = options({ settings: { OVIS_TUI_BIN: join(scratch, "gone") } });
    expect(await runTui([], run)).toBe(1);
    expect(run.said.join("")).toContain(join(scratch, "gone"));
    expect(record()).toBeNull();
  });

  function watched(): { readonly seen: string[]; readonly handlers: Map<string, () => void>; readonly on: TuiOptions["on"]; [Symbol.dispose]: () => void } {
    const seen: string[] = [];
    const handlers = new Map<string, () => void>();
    const spawn = Bun.spawn;
    Bun.spawn = ((...args: Parameters<typeof spawn>) => { seen.push("spawn"); return spawn(...args); }) as typeof spawn;
    return {
      seen, handlers,
      on: (signal, handler) => { seen.push(signal); handlers.set(signal, handler); return () => { seen.push(`off ${signal}`); }; },
      [Symbol.dispose]: () => { Bun.spawn = spawn; },
    };
  }

  it.skipIf(process.platform === "win32")("listens for SIGTERM and SIGHUP before the program starts, passes them on, and stops listening once it ended", async () => {
    const program = join(scratch, "ovis-tui");
    writeFileSync(program, "#!/bin/sh\nwhile :; do sleep 0.05; done\n");
    chmodSync(program, 0o755);
    using signals = watched();
    const ran = runTui([], options({ on: signals.on }));
    expect(signals.seen).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "spawn"]);
    signals.handlers.get("SIGTERM")!();
    expect(await ran).toBe(128 + 15);
    expect(signals.seen.slice(4).sort()).toEqual(["off SIGHUP", "off SIGINT", "off SIGTERM"]);
  });

  it("stops listening when the program cannot be started, and a signal after it finds nothing to pass on", async () => {
    const program = join(scratch, "ovis-tui");
    writeFileSync(program, "not a program\n");
    chmodSync(program, 0o644);
    using signals = watched();
    const run = options({ on: signals.on });
    expect(await runTui([], run)).toBe(1);
    expect(run.said.join("")).toContain(`could not run ${program}`);
    expect(signals.seen.filter((event) => event.startsWith("off ")).sort()).toEqual(["off SIGHUP", "off SIGINT", "off SIGTERM"]);
    for (const handler of signals.handlers.values()) expect(handler).not.toThrow();
  });

  it("runs nothing on Windows", async () => {
    standIn(join(scratch, "ovis-tui"));
    const run = options({ platform: "win32" });
    expect(await runTui([], run)).toBe(1);
    expect(run.said).toEqual([WINDOWS_MESSAGE]);
    expect(record()).toBeNull();
  });
});

describe("ovis tui", () => {
  function launch(args: string[], extra: Record<string, string> = {}) {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const key of ["PORT", "HOST", "OVIS_URL", "OVIS_TOKEN", "OVIS_TUI_BIN", "OVIS_STATE_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "HERDR_SOCKET", "HC_SESSION", "HC_SOCKET"]) delete env[key];
    Object.assign(env, {
      HOME: scratch,
      HERDR_PLUGIN_STATE_DIR: join(scratch, "state"),
      HERDR_PLUGIN_CONFIG_DIR: join(scratch, "config"),
      HERDR_PLUGIN_ROOT: join(scratch, "root"),
      STANDIN_RECORD: join(scratch, "record"),
      ...extra,
    });
    return Bun.spawn([process.execPath, "scripts/plugin.ts", "tui", ...args], { cwd: ROOT, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  }

  function listener() {
    const seen = { connections: 0 };
    const socket = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open: () => { seen.connections += 1; }, data: () => undefined } });
    return { port: socket.port, seen, [Symbol.dispose]: () => socket.stop(true) };
  }

  it("runs the program from the config's OVIS_TUI_BIN without the token or address, and never asks the server", async () => {
    using port = listener();
    mkdirSync(join(scratch, "config"));
    writeFileSync(join(scratch, "config", "env"), `PORT=${port.port}\nOVIS_TOKEN=config-secret\nOVIS_TUI_BIN=~/tui/ovis-tui\n`);
    standIn(join(scratch, "tui", "ovis-tui"));
    standIn(join(scratch, "root", "bin", "ovis-tui"));
    const child = launch(["--session", "my session"], { STANDIN_EXIT: "7" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, err).toBe(7);
    expect(record()).toEqual({ args: ["--session", "my session"], url: "", token: null });
    expect(port.seen.connections).toBe(0);
  }, 30_000);

  it("runs the install's bin/ovis-tui without the token and address the caller exported", async () => {
    standIn(join(scratch, "root", "bin", "ovis-tui"));
    const child = launch([], { OVIS_URL: "http://127.0.0.1:9", OVIS_TOKEN: "exported" });
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, err).toBe(0);
    expect(record()).toEqual({ args: [], url: "", token: null });
  }, 30_000);

  it("is not ended by a SIGINT while the program runs", async () => {
    standIn(join(scratch, "root", "bin", "ovis-tui"));
    const child = launch([], { STANDIN_READY: "1" });
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("ready\n");
    child.kill("SIGINT");
    child.stdin.write("done\n");
    await child.stdin.end();
    expect(await child.exited).toBe(0);
    expect(child.signalCode).toBeNull();
  }, 30_000);

  it("says there is no program yet and exits 1", async () => {
    const child = launch([]);
    const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    expect(err).toBe(lookupMessage({ kind: "missing", looked: tuiPaths(join(scratch, "root")) }));
  }, 30_000);
});
