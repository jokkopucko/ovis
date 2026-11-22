import { afterAll, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legacyName } from "../legacy-env.ts";
import { spawnHcConnect } from "./hc-connect.ts";

const dir = mkdtempSync(join(tmpdir(), "ovis-hc-connect-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** what a fake `hc connect` was started with: the env a core it starts (`hc serve`) would hand every pane */
async function connectEnv(env?: Record<string, string | undefined>): Promise<Record<string, string>> {
  const out = join(dir, `env-${crypto.randomUUID()}`);
  const bin = join(dir, `hc-${crypto.randomUUID()}`);
  writeFileSync(bin, `#!/bin/sh\nenv > '${out}'\n`);
  chmodSync(bin, 0o755);
  await spawnHcConnect(bin, env).exited;
  return Object.fromEntries(readFileSync(out, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

it.skipIf(process.platform === "win32")("runs hc connect without the server's own variables, keeping the user's", async () => {
  // regression (#3336): a core `hc connect` started gave every pane Ovis's PORT, so a dev server there took Ovis's port
  const server = { PORT: "7317", HOST: "100.64.0.1", OVIS_BOOT_ID: "boot", OVIS_TOKEN: "secret", [legacyName("OVIS_TOKEN")!]: "old-secret", HERDR_PLUGIN_ID: "devswha.herdr-web-ui",
    // the herdr pane Ovis was started from: an agent in a core's pane would take that pane's reports (#3260)
    HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1", HERDR_SOCKET_PATH: join(dir, "herdr.sock"), HERDR_AGENT: "claude", HERDR_BIN_PATH: "/usr/bin/herdr" };
  const user = { HC_SOCKET: join(dir, "hc.sock"), XDG_RUNTIME_DIR: join(dir, "run"), LANG: "ko_KR.UTF-8", SSH_AUTH_SOCK: join(dir, "agent.sock"), PATH: process.env["PATH"] ?? "/usr/bin:/bin" };
  const leaked = (env: Record<string, string>) => Object.keys(server).filter((name) => name in env);
  const given = await connectEnv({ ...server, ...user });
  expect(leaked(given)).toEqual([]);
  expect(given).toMatchObject(user);
  const saved = Object.fromEntries(Object.keys({ ...server, ...user }).map((name) => [name, process.env[name]]));
  Object.assign(process.env, server, user);
  try {
    const inherited = await connectEnv();
    expect(leaked(inherited)).toEqual([]);
    expect(inherited).toMatchObject(user);
  } finally {
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});
