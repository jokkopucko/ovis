/**
 * Tests talk to their own herdr: a headless server for the named session
 * `ovis-test` (HERDR_TEST_SESSION overrides), started on first use and left
 * running for the next run. The workspaces, panes and agents the tests create never
 * show in the herdr the user works in.
 *
 * `bun test` loads this first (bunfig.toml); the browser and SSH scripts import it.
 * HERDR_TEST_LIVE=1 keeps the old behaviour: tests use HERDR_SOCKET, else the default
 * session. Without a herdr binary nothing changes, so CI runs as before.
 * HERDR_TEST_MODE=unit points HERDR_SOCKET at a socket that does not exist, so a test that
 * reaches for herdr in a unit run fails instead of working in the user's herdr.
 */
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { ping, sessionSnapshot, workspaceCreate } from "../server/herdr/client.ts";
import { testShellEnv } from "./test-shell.ts";

// macOS's temp dir is behind a symlink (/var -> /private/var): herdr reports a pane's cwd
// resolved, so a fixture made under the unresolved path never matches the pane it is for
process.env["TMPDIR"] = realpathSync(tmpdir());

// the config folder this run started with: the live-herdr guard (server/herdr/client.ts) refuses its
// herdr socket, in this process and the children tests spawn, whatever XDG_CONFIG_HOME a test sets later
process.env["OVIS_TEST_USER_XDG_CONFIG_HOME"] ??= process.env["XDG_CONFIG_HOME"] ?? "";

export const TEST_SESSION = process.env["HERDR_TEST_SESSION"] || "ovis-test";

/**
 * Where herdr puts a named session's socket: under XDG_CONFIG_HOME when it is set, on Windows too
 * (live-verified, herdr 0.9.3; `bun run check` isolates herdr through it), else under APPDATA on
 * Windows and ~/.config elsewhere.
 */
export function testSocketPath(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string {
  const root = env["XDG_CONFIG_HOME"]
    || (platform === "win32" ? env["APPDATA"] || join(homedir(), "AppData", "Roaming") : join(homedir(), ".config"));
  return join(root, "herdr", "sessions", TEST_SESSION, "herdr.sock");
}

function herdrBinary(): string | null {
  const configured = process.env["OVIS_HERDR_BIN"];
  if (configured) return configured;
  const found = Bun.which("herdr");
  return found ?? null;
}

async function answers(socket: string): Promise<boolean> {
  try { await ping(socket); return true; } catch { return false; }
}

/**
 * The agent kinds a contract test launches with no program behind it ("muse"). On a PC where that CLI
 * is installed, a pane would run the real one, which checks for updates and writes beside itself in
 * the user's bin: these stand-ins, first on the test server's PATH, exit as a missing command does.
 */
export function agentStandIns(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const name of ["muse"]) {
    const path = join(dir, name);
    writeFileSync(path, "#!/bin/sh\nexit 127\n");
    chmodSync(path, 0o755);
  }
  return dir;
}

/** Point this process (and what it spawns) at the test session, starting its server if needed. */
export async function useTestHerdr(): Promise<string | null> {
  // Unit tests must not discover or start herdr, even on a developer's PC. Nor may they fall back
  // to the default socket: a bare `HERDR_TEST_MODE=unit bun test` also loads the contract files,
  // and those would open their workspaces and stand-in agents in the herdr the user works in.
  if (process.env["HERDR_TEST_MODE"] === "unit") {
    process.env["HERDR_SOCKET"] = join(tmpdir(), "ovis-unit-tests-have-no-herdr.sock");
    return null;
  }
  if (process.env["HERDR_TEST_LIVE"] === "1") return null;
  const herdr = herdrBinary();
  // no herdr to isolate: a socket that does not exist, never the default one (the user's own session)
  if (!herdr) {
    process.env["HERDR_SOCKET"] = join(tmpdir(), "ovis-tests-found-no-herdr.sock");
    return null;
  }
  const socket = testSocketPath();
  // an empty ZDOTDIR: a pane's zsh (macOS's login shell) reads none of the user's own files,
  // where a shell integration can start a CLI herdr takes for an agent, ending the agent a test
  // reported, or set a title that names the pane's tab
  const zdotdir = join(dirname(socket), "zdotdir");
  // Windows panes cannot run the stand-ins (and keep their own PATH)
  const standIns = process.platform === "win32" ? null : join(dirname(socket), "agent-stand-ins");
  // a server left running from before either directory existed has panes reading those files, or
  // the user's agents on their PATH: it is stopped once, and started again below
  if ((!existsSync(zdotdir) || (standIns !== null && !existsSync(join(standIns, "muse")))) && await answers(socket)) {
    Bun.spawnSync([herdr, "--session", TEST_SESSION, "server", "stop"]);
    for (const deadline = Date.now() + 15_000; await answers(socket);) {
      if (Date.now() > deadline) throw new Error(`The test herdr session "${TEST_SESSION}" did not stop`);
      await Bun.sleep(100);
    }
  }
  // Empty of the user's files, not of every file: with no startup file at all, a zsh that ships
  // its new-user wizard (zsh-newuser-install; Ubuntu's zsh does) opens it in every pane, and the
  // wizard takes the first keys a test types into the shell. An empty .zshrc is read as nothing.
  // A pane reads it when its shell starts, so a server already running needs no restart for it.
  mkdirSync(zdotdir, { recursive: true });
  if (!existsSync(join(zdotdir, ".zshrc"))) writeFileSync(join(zdotdir, ".zshrc"), "");
  if (!(await answers(socket))) {
    const path = standIns === null ? {} : { PATH: [agentStandIns(standIns), process.env["PATH"]].filter(Boolean).join(delimiter) };
    Bun.spawn([herdr, "--session", TEST_SESSION, "server"], {
      stdin: "ignore",
      stdout: Bun.file(join(dirname(socket), "test-server.log")),
      stderr: Bun.file(join(dirname(socket), "test-server.log")),
      // run from inside a herdr pane, this process carries that pane's HERDR_* variables; run by
      // an agent, it carries the agent's too (OMO_CODING_AGENT_DIR moves where a pane's omo is
      // read from), and every pane of this server would inherit them
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(HERDR|OMO|SENPI|PI)_/.test(name))), ...testShellEnv(dirname(socket)), ...path, ZDOTDIR: zdotdir },
    }).unref();
    const deadline = Date.now() + 15_000;
    while (!(existsSync(socket) && await answers(socket))) {
      if (Date.now() > deadline) throw new Error(`The test herdr session "${TEST_SESSION}" did not start; see ${join(dirname(socket), "test-server.log")}`);
      await Bun.sleep(100);
    }
  }
  // some tests read "a live workspace" without owning one: keep one resident, as a
  // session in use always has
  if ((await sessionSnapshot(socket)).workspaces.length === 0) {
    await workspaceCreate({ cwd: homedir(), label: "ovis-test-resident" }, socket);
  }
  process.env["HERDR_SOCKET"] = socket;
  return socket;
}

await useTestHerdr();
