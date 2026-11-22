import { expect, it, onTestFinished } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc, paneRead, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { testShellEnv } from "./test-shell.ts";

/** Its own XDG config isolates the global plugin registry as well as the owned herdr panes. */
it("herdr loads the Phone setup entrypoint and keeps its QR and code visible in a pane", async () => {
  // the session socket lives under root: a temp dir (macOS's, or a TMPDIR set deeper by hand) is too deep for a socket
  // path (104 bytes on macOS, 108 on Linux), and herdr then refuses to start
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "herdr-phone-pane-"));
  // after the test's own finally has stopped the daemon, also when an assertion before it fails
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const source = join(import.meta.dir, "..");
  const config = join(root, "config");
  const plugin = join(root, "plugin");
  mkdirSync(plugin);
  const manifest = Bun.TOML.parse(readFileSync(join(source, "herdr-plugin.toml"), "utf8")) as any;
  const phone = manifest.panes.find((pane: any) => pane.id === "phone");
  expect(phone.placement).toBe("zoomed");
  expect(phone.command).toEqual(["sh", "scripts/with-bun.sh", "scripts/plugin-launch.ts", "phone-setup"]);
  expect(manifest.actions.find((action: any) => action.id === "phone").command).toEqual([
    "herdr", "plugin", "pane", "open", "--plugin", manifest.id, "--entrypoint", "phone", "--placement", "zoomed", "--focus",
  ]);
  writeFileSync(join(plugin, "herdr-plugin.toml"), `id = "${manifest.id}"\nname = "Phone setup QA"\nversion = "0.0.0"\nmin_herdr_version = "0.9.0"\nplatforms = ["linux", "macos"]\n[[panes]]\nid = "phone"\ntitle = "Phone setup"\nplacement = "${phone.placement}"\ncommand = ${JSON.stringify([process.execPath, join(source, phone.command[2]), phone.command[3]])}\n`);
  const binary = process.env["OVIS_HERDR_BIN"] || Bun.which("herdr")!;
  const session = "phone-setup-qa";
  const socket = join(config, "herdr", "sessions", session, "herdr.sock");
  // OVIS_FROM_SOURCE: the pane runs this checkout's scripts/plugin.ts. Without it the launcher would ask GitHub whether
  // package.json's version has a compiled server (this plugin never ran the build step that remembers the answer):
  // a network call in a contract test, and once that release exists, a download of it instead of these sources
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("HERDR_"))), ...testShellEnv(config), XDG_CONFIG_HOME: config, OVIS_FROM_SOURCE: "1" };
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([binary, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`herdr ${args.join(" ")}: ${err || out}`);
    return out.trim();
  };
  const app = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/health") return Response.json({ ok: true, herdr: { version: "0.9.3", protocol: 1 }, auth: { required: false, authenticated: true } });
    if (path === "/api/access") return Response.json({ port: app.port, tailscale: { serving_url: "https://demo.example.ts.net" } });
    if (path === "/api/devices/pair/start") return Response.json({ code: "123456" });
    return new Response(null, { status: 404 });
  } });
  let daemon: ReturnType<typeof Bun.spawn> | undefined;
  let workspace: string | undefined;
  try {
    await cli("plugin", "link", plugin);
    const pluginConfig = await cli("plugin", "config-dir", manifest.id);
    writeFileSync(join(pluginConfig, ".env"), `PORT=${app.port}\nHOST=127.0.0.1\nOVIS_TOKEN=\nOVIS_STATE_DIR=${join(root, "app-state")}\n`);
    daemon = Bun.spawn([binary, "--session", session, "server"], { env, stdout: "ignore", stderr: "ignore" });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { await herdrRpc("session.snapshot", {}, socket); break; }
      catch { if (Date.now() >= deadline) throw new Error("Phone QA server did not start"); await Bun.sleep(50); }
    }
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-phone-setup" }, socket);
    workspace = created.workspace.workspace_id;
    await cli("--session", session, "plugin", "pane", "open", "--plugin", manifest.id, "--entrypoint", phone.id, "--placement", phone.placement, "--target-pane", created.root_pane.pane_id, "--no-focus");
    const paneId = (await sessionSnapshot(socket)).panes.find((pane) => pane.workspace_id === workspace && pane.pane_id !== created.root_pane.pane_id)?.pane_id;
    expect(typeof paneId).toBe("string");
    let text = "";
    while (Date.now() < deadline) {
      text = (await paneRead({ paneId: paneId!, source: "visible", format: "text" }, socket)).text;
      if (text.includes("Press Enter to finish")) break;
      await Bun.sleep(50);
    }
    expect(text).toContain("Phone setup");
    expect(text).toContain("https://demo.example.ts.net");
    expect(text).toContain("123 456");
    expect(text).toMatch(/[█▀▄]/);
    expect(text).toContain("Press Enter to finish");
  } finally {
    if (workspace) await workspaceClose(workspace, socket).catch(() => undefined);
    if (daemon) { daemon.kill(); await daemon.exited; }
    app.stop(true);
  }
}, 15_000);
