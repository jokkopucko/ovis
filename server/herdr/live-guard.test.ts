import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, herdrSocketPath } from "./client.ts";
import { spawnHcConnect } from "../herdr-core/connection.ts";
import { coreSocket } from "../herdr-core/discovery.ts";

// A script that names a test session but never ran scripts/test-herdr.ts (an import Bun drops
// because its binding is unused) is left on herdr's default socket: the user's own session.
// HOME is a temp folder here, so the default socket is nobody's and nothing live is reached.
const NAMES = ["HOME", "XDG_CONFIG_HOME", "OVIS_TEST_USER_XDG_CONFIG_HOME", "HERDR_SOCKET", "HERDR_TEST_SESSION", "HERDR_TEST_LIVE", "OVIS_ALLOW_LIVE_HERDR", "HC_SOCKET", "HC_SESSION"] as const;
const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
const home = mkdtempSync(join(tmpdir(), "ovis-live-guard-"));
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
});
const codeOf = (error: unknown): string | undefined => (error as { code?: string; kind?: string } | null)?.code ?? (error as { kind?: string } | null)?.kind;
const isolatedIntent = () => {
  process.env["HOME"] = home;
  for (const name of ["HERDR_SOCKET", "HERDR_TEST_LIVE", "OVIS_ALLOW_LIVE_HERDR", "HC_SOCKET", "HC_SESSION"]) delete process.env[name];
  process.env["HERDR_TEST_SESSION"] = "ovis-test-guard";
};

it("refuses herdr's default socket to a process that names a test session", async () => {
  try {
    isolatedIntent();
    const refused = await herdrRpc("ping", {}).then(() => null, (error: unknown) => error);
    expect(codeOf(refused)).toBe("live_herdr_refused");
    // another spelling of the same socket
    const spelled = await herdrRpc("ping", {}, join(home, ".config", "herdr", "..", "herdr", "herdr.sock")).then(() => null, (error: unknown) => error);
    expect(codeOf(spelled)).toBe(process.platform === "win32" ? codeOf(spelled) : "live_herdr_refused");
    // said out loud, the live session may be used
    process.env["OVIS_ALLOW_LIVE_HERDR"] = "1";
    const reached = await herdrRpc("ping", {}, herdrSocketPath()).then(() => null, (error: unknown) => error);
    expect(codeOf(reached)).not.toBe("live_herdr_refused");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("refuses herdr's socket under the run's own XDG_CONFIG_HOME, not under one a test chose later", async () => {
  // regression (fails on main): a child a test spawns with XDG_CONFIG_HOME=<temp>/config was refused its own herdr there
  isolatedIntent();
  const temp = mkdtempSync(join(tmpdir(), "ovis-live-guard-xdg-"));
  const ping = (socket: string) => herdrRpc("ping", {}, socket).then(() => null, (error: unknown) => error);
  try {
    // the run started with the user's config (recorded by scripts/test-herdr.ts); a test then chose its own
    const users = join(temp, "user-config"), own = join(temp, "test-config");
    process.env["OVIS_TEST_USER_XDG_CONFIG_HOME"] = users;
    process.env["XDG_CONFIG_HOME"] = own;
    expect(codeOf(await ping(join(own, "herdr", "herdr.sock")))).not.toBe("live_herdr_refused");
    // the user's stays refused, before anything connects
    expect(codeOf(await ping(join(users, "herdr", "herdr.sock")))).toBe("live_herdr_refused");
    // with no record (a script that never ran the preload), this process's own config counts as the user's
    delete process.env["OVIS_TEST_USER_XDG_CONFIG_HOME"];
    expect(codeOf(await ping(join(own, "herdr", "herdr.sock")))).toBe("live_herdr_refused");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it("refuses hc's default core to a process that names a test session, not a core it names", () => {
  isolatedIntent();
  const refused = (() => { try { spawnHcConnect(join(home, "no-such-hc")); return null; } catch (error) { return error; } })();
  expect(codeOf(refused)).toBe("live_core_refused");
  const named = (() => { try { spawnHcConnect(join(home, "no-such-hc"), { HC_SOCKET: join(home, "hc.sock") }); return null; } catch (error) { return error; } })();
  expect(codeOf(named)).not.toBe("live_core_refused");
  // an inherited HC_SOCKET that names the default core is the user's core all the same
  const inherited = (() => { try { spawnHcConnect(join(home, "no-such-hc"), { HC_SOCKET: coreSocket({ env: { ...process.env, HC_SOCKET: undefined, HC_SESSION: undefined } }).path }); return null; } catch (error) { return error; } })();
  expect(codeOf(inherited)).toBe("live_core_refused");
});
