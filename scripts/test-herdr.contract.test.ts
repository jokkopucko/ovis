import { describe, expect, it, onTestFinished } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrRpc, ping } from "../server/herdr/client.ts";

const answers = (socket: string): Promise<boolean> => ping(socket).then(() => true, () => false);
const pluginIds = async (socket: string): Promise<string[]> =>
  (await herdrRpc<{ plugins: { plugin_id: string }[] }>("plugin.list", {}, socket)).plugins.map((entry) => entry.plugin_id);

/**
 * A user's config folder with one installed plugin whose startup hook leaves a file, and a fresh run's environment
 * with it as XDG_CONFIG_HOME. The session's herdr is stopped and the folder removed after the test; a herdr that
 * does not stop keeps its folder, and the test fails naming it.
 */
function userWithPlugin() {
  // a short root: the session socket lives under it (104 bytes on macOS, 108 on Linux)
  const root = mkdtempSync(join("/tmp", "herdr-test-plugins-"));
  const user = join(root, "config");
  const plugin = join(root, "plugin");
  const ran = join(root, "startup-ran");
  const session = "plugins";
  const socket = join(user, "herdr", "sessions", session, "herdr.sock");
  const herdr = Bun.which(process.env["OVIS_HERDR_BIN"] || "herdr")!;
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^(HERDR_|OVIS_TEST_USER_)/.test(entry[0]))),
    XDG_CONFIG_HOME: user, XDG_STATE_HOME: join(root, "state"), HERDR_TEST_SESSION: session, OVIS_HERDR_BIN: herdr,
  };
  const stop = () => Bun.spawnSync([herdr, "--session", session, "server", "stop"], { env, stdout: "pipe", stderr: "pipe" });
  onTestFinished(async () => {
    if (await answers(socket) && stop().exitCode !== 0) throw new Error(`the test herdr at ${socket} did not stop; ${root} is kept`);
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(plugin);
  writeFileSync(join(plugin, "herdr-plugin.toml"), [
    'id = "example.user-plugin"', 'name = "User plugin"', 'version = "0.0.0"', 'min_herdr_version = "0.9.0"', 'platforms = ["linux", "macos"]',
    "[[startup]]", `command = ${JSON.stringify(["sh", "-c", `: > '${ran}'`])}`, "",
  ].join("\n"));
  const linked = Bun.spawnSync([herdr, "plugin", "link", plugin], { env, stdout: "pipe", stderr: "pipe" });
  if (linked.exitCode !== 0) throw new Error(`herdr plugin link failed: ${linked.stderr}`);
  // what every test run does first: the preload starts the session's herdr, which outlives it
  const preload = () => {
    const started = Bun.spawnSync([process.execPath, join(import.meta.dir, "test-herdr.ts")], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    if (started.exitCode !== 0) throw new Error(`scripts/test-herdr.ts failed: ${started.stderr}`);
  };
  const stopped = async () => {
    expect(stop().exitCode).toBe(0);
    for (const deadline = Date.now() + 10_000; await answers(socket);) {
      if (Date.now() > deadline) throw new Error(`the test herdr at ${socket} did not stop`);
      await Bun.sleep(50);
    }
  };
  return { herdr, env, session, socket, ran, stopped, preload };
}

// herdr runs every plugin the user installed (its plugins.json) in each server it starts: an installed Ovis's
// startup hook would start the user's own Ovis from inside the test session. A unit run starts no herdr.
describe.skipIf(process.platform === "win32" || process.env["HERDR_TEST_MODE"] === "unit")("the test herdr", () => {
  it("runs none of the user's installed plugins, and stops as its session", async () => {
    const { socket, ran, stopped, preload } = userWithPlugin();
    preload();
    expect(await pluginIds(socket)).toEqual([]);
    expect(existsSync(ran)).toBe(false);
    // the documented way to stop it, `herdr --session <name> server stop`, still reaches it
    await stopped();
  }, 30_000);

  it("replaces a session herdr that an older checkout started with the user's plugins after a run of this one", async () => {
    const { herdr, env, session, socket, stopped, preload } = userWithPlugin();
    preload();
    await stopped();
    const older = Bun.spawn([herdr, "--session", session, "server"], { env, stdout: "ignore", stderr: "ignore" });
    onTestFinished(() => older.kill());
    for (const deadline = Date.now() + 10_000; !(await answers(socket));) {
      if (Date.now() > deadline) throw new Error(`the older checkout's herdr at ${socket} did not start`);
      await Bun.sleep(50);
    }
    expect(await pluginIds(socket)).toEqual(["example.user-plugin"]);

    preload();
    expect(await pluginIds(socket)).toEqual([]);
    expect(await older.exited).toBe(0);
  }, 30_000);
});
