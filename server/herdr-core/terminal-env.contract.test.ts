import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedHcEnv, stopIsolatedCore } from "../../scripts/test-hc.ts";
import { workspaceCreate } from "../herdr/client.ts";
import { coreDestination } from "../runtime-move-service.ts";
import { startRuntime } from "./runtime.ts";

/**
 * Terminals Ovis starts on a real hc whose core an agent's shell started first (herdr-core#86):
 * colour off there, and none of the tokens the user's profile exports. Runs only where
 * OVIS_TEST_HC_BIN names an hc.
 */
const bin = process.env["OVIS_TEST_HC_BIN"];
const TEST_MS = 60_000;

describe.skipIf(!bin || process.platform === "win32")("terminals Ovis starts on a core an agent's shell started", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "te-")));
  let env: Record<string, string> = {};
  const saved = Object.fromEntries(["OVIS_HC_ENV", "OVIS_HC_BIN", "OVIS_RUNTIME", "HERDR_SOCKET"].map((name) => [name, process.env[name]]));

  beforeAll(async () => {
    for (const sub of ["state", "config", "run", "home", "ovis-state"]) mkdirSync(join(root, sub), { mode: 0o700 });
    writeFileSync(join(root, "home", ".profile"), "export GH_TOKEN=from-profile\n");
    env = isolatedHcEnv(root, { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" });
    const agent = { ...env, TERM: "dumb", COLORTERM: "", NO_COLOR: "1" };
    // as an agent starts it: `hc run` in its shell, which starts the core and a terminal (and so its holder)
    const started = Bun.spawn([bin!, "run", "--bg", "--json"], { env: agent, stdout: "ignore", stderr: "pipe" });
    expect({ exit: await started.exited, stderr: await new Response(started.stderr).text() }).toMatchObject({ exit: 0 });
    process.env["OVIS_HC_ENV"] = JSON.stringify(env);
    process.env["OVIS_HC_BIN"] = bin!;
  }, TEST_MS);

  afterAll(async () => {
    await stopIsolatedCore(bin!, env);
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    rmSync(root, { recursive: true, force: true });
  });

  async function paneEnv(address: string): Promise<Record<string, string>> {
    const out = join(root, `env-${address}`);
    const sent = Bun.spawn([bin!, "send", address, `env > ${out}.part && mv ${out}.part ${out}`], { env, stdout: "ignore", stderr: "pipe" });
    expect(await sent.exited).toBe(0);
    for (const deadline = Date.now() + 10_000; !existsSync(out); ) {
      if (Date.now() > deadline) throw new Error(`${address} wrote no environment`);
      await Bun.sleep(50);
    }
    return Object.fromEntries(readFileSync(out, "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  }

  const expected = { GH_TOKEN: "from-profile", NO_COLOR: "", TERM: "xterm-256color", COLORTERM: "truecolor" };

  it("gives the move's panes the user's login environment in colour", async () => {
    const destination = await coreDestination(join(root, "ovis-state"), "env-move");
    try {
      const made = await destination.createWorkspace("env-move", join(root, "home"), "moved");
      expect(await paneEnv(made.paneId)).toMatchObject(expected);
    } finally { destination.close(); }
  }, TEST_MS);

  it("gives a workspace a herdr-core server opens the same", async () => {
    process.env["OVIS_RUNTIME"] = "herdr-core";
    const adapter = await startRuntime(join(root, "ovis-state"), async () => ({ bin: bin!, version: "0.1.17" }));
    if (!adapter) throw new Error("runtime did not start");
    try {
      const made = await workspaceCreate({ cwd: join(root, "home"), label: "served" }, adapter.socketPath);
      expect(await paneEnv(made.root_pane.pane_id)).toMatchObject(expected);
    } finally { adapter.stop(); }
  }, TEST_MS);
});
