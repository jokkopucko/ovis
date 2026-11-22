import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const windows = process.platform === "win32";
// macOS's per-user TMPDIR is long enough to push herdr's socket names past the 104-byte sun_path limit
const root = realpathSync(mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "herdr-bundle-smoke-")));
const bundle = join(root, "runtime");
const home = join(root, "home");
// herdr follows XDG_CONFIG_HOME; a value apart from ~/.config proves the bridge follows it too.
// On Windows it follows APPDATA instead, and the bundle carries no herdr: the one herdr's own
// installer left (the stable alias under %LOCALAPPDATA%), or OVIS_HERDR_BIN.
const xdg = join(home, "xdg");
// Claude's store: the bridge reads a pane's Claude transcripts from here, not the runner's own
const claudeConfig = join(home, ".claude");
mkdirSync(bundle); mkdirSync(home);
const server = join(bundle, windows ? "ovis-server.exe" : "ovis-server");
const herdr = windows ? process.env["OVIS_HERDR_BIN"] || join(process.env["LOCALAPPDATA"] ?? "", "Programs/Herdr/bin/herdr.exe") : join(bundle, "bin/herdr");
if (windows) assert.ok(existsSync(herdr), `herdr is not installed at ${herdr}`);
// The PC this stands for has no Node of its own: the terminal attach must run on the Node the
// bundle carries (#265: looked up on the launch PATH alone, such a PC mirrored instead). So every
// PATH entry that holds a node is left out; a Windows bundle carries none and mirrors.
const delimiter = windows ? ";" : ":";
const path = (process.env["PATH"] ?? "").split(delimiter).filter((dir) => dir && !existsSync(join(dir, windows ? "node.exe" : "node"))).join(delimiter);
// the pane's shell is a plain one: a login shell with an empty HOME may stop to ask how it should be set up
const env = { ...process.env, ...(windows ? {} : { SHELL: "/bin/sh" }), PATH: path, HOME: home, USERPROFILE: home, APPDATA: xdg, XDG_CONFIG_HOME: xdg, HERDR_REMOTE_SESSION: "smoke", OVIS_HERDR_BIN: herdr, CLAUDE_CONFIG_DIR: claudeConfig };
if (!windows) assert.equal(Bun.which("node", { PATH: path }), null, "the smoke runs with no Node on PATH");
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  const archive = resolve(`remote-bundles/herdr-web-ui-${process.platform}-${process.arch}.tgz`);
  assert.equal(Bun.spawnSync(["tar", "xzf", archive, "-C", bundle]).exitCode, 0);
  if (!windows && process.env["HERDR_BUNDLE_PTY_SIDECAR"]) {
    const host = Bun.spawnSync([join(bundle, "bin/ovis-pty-sidecar")], { stdin: "ignore", stderr: "pipe" });
    assert.equal(host.exitCode, 2, "the bundle's Rust PTY host runs and prints its usage");
    assert.match(host.stderr.toString(), /^pty-sidecar: usage:/);
  }
  for (const sources of ["server", "shared"]) assert.equal(existsSync(join(bundle, sources)), false, `the bundle holds no ${sources}/`);
  child = Bun.spawn([server, "remote"], { env, stdout: "inherit", stderr: "inherit" });
  const { createHash } = await import("node:crypto");
  const socket = join(xdg, "herdr/sessions/smoke/herdr.sock");
  const described = join(home, ".config/herdr-web-ui/bridges", createHash("sha256").update(socket).digest("hex") + ".json");
  let descriptor: { port: number; token: string } | undefined;
  for (let i = 0; i < 400; i++) { try { descriptor = JSON.parse(readFileSync(described, "utf8")); break; } catch { await Bun.sleep(100); } }
  if (!descriptor) {
    for (const log of [join(home, ".config/herdr-web-ui/bridges/herdr.log"), join(xdg, "herdr/sessions/smoke/herdr-server.log")]) {
      console.error(`--- ${log}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-4000) : "(missing)"}`);
    }
  }
  assert.ok(descriptor, "bundle starts a private daemon and bridge without system runtimes");
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/api/bridge`, { headers: { authorization: `Bearer ${descriptor.token}` } });
  assert.equal(response.status, 200);
  const identity = await response.json() as { socket_path: string; herdr: { terminal_attach?: boolean } };
  assert.equal(identity.socket_path, socket);
  // a Windows herdr has no terminal attach (herdrdev/herdr#4821); the bridge must say so
  assert.equal(identity.herdr.terminal_attach, !windows);
  assert.equal((await fetch(`http://127.0.0.1:${descriptor.port}/api/session`)).status, 401);
  console.log("Remote bundle startup, isolated socket and authentication passed");

  // A live terminal, not only what the bridge says of itself: herdr's own attach where the
  // bundle carries Node, a mirror of the pane's screen on Windows.
  const headers = { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" };
  const created = await fetch(`http://127.0.0.1:${descriptor.port}/api/workspace/create`, { method: "POST", headers, body: JSON.stringify({ cwd: home, label: "herdr-web-ui-test-bundle-smoke" }) });
  assert.equal(created.status, 200, await created.clone().text());
  const paneId = (await created.json() as { pane_id: string }).pane_id;
  const frames: { type: string; pane_id?: string; data?: string; fixed?: boolean; code?: string; message?: string }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${descriptor.port}/ws`, { headers } as never);
  ws.onmessage = (event) => { frames.push(JSON.parse(String(event.data))); };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("bridge websocket failed")); });
  const until = async (what: string, done: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !done(); i++) await Bun.sleep(100);
    assert.ok(done(), `${what}: ${JSON.stringify(frames.filter((frame) => frame.type !== "pty-data").slice(-6))}`);
  };
  try {
    ws.send(JSON.stringify({ type: "attach", pane_id: paneId, cols: 100, rows: 30 }));
    await until("the terminal paints", () => frames.some((frame) => frame.type === "pty-data" && frame.pane_id === paneId));
    const mirrored = frames.some((frame) => frame.type === "pane-geometry" && frame.pane_id === paneId && frame.fixed === true);
    assert.equal(mirrored, windows, windows ? "a Windows bridge mirrors the pane's screen" : "the bundle's own Node runs the terminal attach: no mirror");
    ws.send(JSON.stringify({ type: "input", pane_id: paneId, text: windows ? "echo \"smoke-$(40+2)\"\r" : "echo smoke-$((40+2))\r" }));
    await until("typing reaches the shell and its output comes back", () => frames.some((frame) => frame.type === "pty-data" && frame.pane_id === paneId && (frame.data ?? "").includes("smoke-42")));
    console.log(`Remote bundle live terminal passed (${mirrored ? "mirror" : "attach"})`);
  } finally {
    ws.close();
  }

  const session = randomUUID();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
  const record = (entry: object) => JSON.stringify({ sessionId: session, cwd: home, timestamp: new Date().toISOString(), ...entry }) + "\n";
  const [prompt, call, result] = [randomUUID(), randomUUID(), randomUUID()];
  mkdirSync(join(claudeConfig, "projects", "smoke"), { recursive: true });
  writeFileSync(join(claudeConfig, "projects", "smoke", `${session}.jsonl`),
    record({ type: "user", uuid: prompt, parentUuid: null, message: { role: "user", content: "look at the screenshot" } })
    + record({ type: "assistant", uuid: call, parentUuid: prompt, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_smoke", name: "Read", input: { file_path: "shot.png" } }] } })
    + record({ type: "user", uuid: result, parentUuid: call, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_smoke", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } }] }] } }));
  const { herdrRpc } = await import("../server/herdr/client.ts");
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "claude", state: "idle" }, socket);
  await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:claude", agent: "claude", agent_session_id: session, session_start_source: "new", seq: 1 }, socket);
  const image = `http://127.0.0.1:${descriptor.port}/api/pane/conversation/image?${new URLSearchParams({ pane_id: paneId, ref: `${result}:0:0` })}`;
  let fetched: Response | undefined;
  for (let i = 0; i < 100; i++) {
    fetched = await fetch(image, { headers: { authorization: `Bearer ${descriptor.token}` } });
    if (fetched.status === 200) break;
    await Bun.sleep(100);
  }
  assert.ok(fetched?.status === 200, `the picture is served: ${fetched?.status} ${await fetched?.clone().text()}`);
  assert.equal(fetched.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), png, "the picture's exact bytes");
  console.log("Remote bundle Claude picture passed");
} finally {
  child?.kill(); if (child) await child.exited;
  Bun.spawnSync([herdr, "--session", "smoke", "server", "stop"], { env });
  // Windows keeps the directory busy for a moment after the daemon lets go of its files
  for (let i = 0; ; i++) {
    try { rmSync(root, { recursive: true, force: true }); break; } catch (error) {
      // a throw here would replace the assertion that failed above with a cleanup error
      if (i === 20) { console.error(`could not remove ${root}: ${error instanceof Error ? error.message : String(error)}`); break; }
      await Bun.sleep(500);
    }
  }
}
