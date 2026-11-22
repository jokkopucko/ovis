/** Docker-backed SSH lifecycle test. Build scripts/fixtures/herdr-ssh first.
 * HERDR_SSH_QA_BUNDLE must point to a verified official bundle for the Docker host platform.
 * Uses a temporary container/account, real SSH, real Herdr and no API mocks.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "../server/index.ts";
import { parseHerdrProfiles } from "../server/herdr-profiles.ts";
import { REMOTE_BUNDLE_VERSION, type Machine, type SetupJob } from "../shared/machines.ts";
import type { ServerMessage, SessionSnapshot, WorkspaceCreated } from "../shared/protocol.ts";

const archive = resolve(process.env.HERDR_SSH_QA_BUNDLE ?? "");
assert.ok(process.env.HERDR_SSH_QA_BUNDLE && existsSync(archive), "Set HERDR_SSH_QA_BUNDLE to the verified bundle archive");
const root = mkdtempSync(join(tmpdir(), "herdr-profiles-ssh-"));
// Bun's subprocess defaults retain the launch environment. Re-exec with the test
// SSH wrapper on PATH so master, exec and mux commands all read the same config.
if (!process.env.HERDR_SSH_QA_CONFIG) {
  const bin = join(root, "bin"); mkdirSync(bin);
  const config = join(root, "ssh-config"), calls = join(root, "ssh-calls");
  writeFileSync(config, "");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexec '${Bun.which("ssh")!}' -F '${config}' "$@"\n`);
  chmodSync(join(bin, "ssh"), 0o700);
  try {
    const child = Bun.spawn([process.execPath, import.meta.path], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HERDR_SSH_QA_CONFIG: config, HERDR_SSH_QA_CALLS: calls }, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
    process.exitCode = await child.exited;
  } finally { rmSync(root, { recursive: true, force: true }); }
  process.exit(process.exitCode);
}
const container = `herdr-profiles-qa-${process.pid}`;
const state = join(root, "state");
const oldManifest = process.env.OVIS_BUNDLE_MANIFEST, oldSocket = process.env.HERDR_SOCKET;
process.env.HERDR_SOCKET = join(root, "local-offline.sock");
let server: ReturnType<typeof createServer> | undefined;
let rows: ReturnType<typeof parseHerdrProfiles> = [];
const sockets: WebSocket[] = [];
function command(args: string[]) {
  const r = Bun.spawnSync(args, { timeout: 180_000 });
  assert.equal(r.exitCode, 0, `${args.slice(0, 3).join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
}
function remote(script: string) { return command(["docker", "exec", "-u", "fixture", "-e", "HOME=/home/fixture", container, "sh", "-c", script]); }
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout; let value: T;
  do { value = await read(); if (done(value)) return value; await Bun.sleep(100); } while (Date.now() < deadline);
  throw new Error(`Timed out ${label}: ${JSON.stringify(value!)}`);
}
async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${server!.port}${path}`, { method, headers: { "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.ok(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
  return response.json() as Promise<T>;
}
const machines = async () => (await api<{ machines: Machine[] }>("/api/machines")).machines;
const start = (stateDir = state) => createServer({ port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null, stateDir, herdrProfiles: async () => rows });
async function connect(machine: Machine, expectApproval = true) {
  let job = await api<SetupJob>("/api/machines/setup", "POST", { ...machine.target, machine_id: machine.id });
  let approved = false;
  const deadline = Date.now() + 180_000;
  while (!["connected", "failed", "cancelled"].includes(job.phase)) {
    assert.ok(Date.now() < deadline, `setup deadline: ${job.phase}`);
    if (job.challenge) job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "answer", challenge_id: job.challenge.id, answer: job.challenge.kind === "host_key" ? "yes" : "herdr-test-only" });
    else if (job.phase === "approval") {
      assert.ok(!job.installations.some((s) => s.startsWith("Bundled herdr")), "existing Herdr must be reused");
      approved = true; job = await api<SetupJob>(`/api/machines/setup/${job.id}`, "POST", { action: "approve" });
    } else { await Bun.sleep(100); job = await api<SetupJob>(`/api/machines/setup/${job.id}`); }
  }
  assert.equal(job.phase, "connected", job.error ?? ""); assert.equal(approved, expectApproval, "connection consent must not imply installation approval");
  return job;
}
try {
  command(["docker", "run", "-d", "--name", container, "-p", "127.0.0.1::22", "herdr-profile-ssh-qa"]);
  const port = Number(command(["docker", "port", container, "22/tcp"]).split(":").at(-1));
  command(["docker", "cp", archive, `${container}:/tmp/bundle.tgz`]);
  command(["docker", "exec", container, "sh", "-c", "mkdir -p /home/fixture/.local/bin; tar xzf /tmp/bundle.tgz -C /tmp ./bin/herdr; cp /tmp/bin/herdr /home/fixture/.local/bin/herdr; chown -R fixture:fixture /home/fixture/.local"]);
  remote("nohup /home/fixture/.local/bin/herdr server >/tmp/herdr-default.log 2>&1 </dev/null &");
  await until(async () => remote("/home/fixture/.local/bin/herdr status server"), (s) => s.includes("status: running"), "existing default Herdr");
  const groundTruth = JSON.parse(remote('/home/fixture/.local/bin/herdr workspace create --label existing-default --cwd /home/fixture'));
  assert.ok(groundTruth);
  remote("mkdir -p /home/fixture/.ssh; chmod 700 /home/fixture/.ssh; ssh-keygen -q -t ed25519 -N '' -f /home/fixture/.ssh/id_ed25519; cat /home/fixture/.ssh/id_ed25519.pub >> /home/fixture/.ssh/authorized_keys; chmod 600 /home/fixture/.ssh/authorized_keys; ssh-keyscan 127.0.0.1 > /home/fixture/.ssh/known_hosts");
  remote("/home/fixture/.local/bin/herdr machine add fixture@127.0.0.1 --label 'Existing default' --remote-session default || { /home/fixture/.local/bin/herdr server stop; /home/fixture/.local/bin/herdr machine add fixture@127.0.0.1 --label 'Existing default' --remote-session default; }");
  const catalog = parseHerdrProfiles(remote("/home/fixture/.local/bin/herdr machine list --json"));
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]!.label, "Existing default");
  assert.equal(catalog[0]!.target!.destination, "fixture@127.0.0.1");
  assert.equal(catalog[0]!.target!.session, undefined);
  console.log("PASS parser against a machine saved by the real herdr CLI");
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const filename = "bundle.tgz";
  command(["ln", "-s", archive, join(root, filename)]);
  const platform = remote("uname -m") === "x86_64" ? "linux-x64" : "linux-arm64";
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ version: REMOTE_BUNDLE_VERSION, assets: { [platform]: { url: filename, sha256 } } }));
  process.env.OVIS_BUNDLE_MANIFEST = manifest;
  rows = [{ ...catalog[0]!, target: { ...catalog[0]!.target!, destination: "herdr-profile-fixture", port } }];
  assert.equal(rows[0]!.target!.session, undefined);
  server = start();
  const discovered = await until(machines, (list) => list.some((m) => m.herdr_profile_id === catalog[0]!.id), "discovery");
  const machine = discovered.find((m) => m.herdr_profile_id)!;
  assert.equal(machine.action_required, "connect");
  assert.equal(machine.state, "disconnected");
  assert.ok(!existsSync(join(state, "ssh")), "discovery must not even create SSH state");
  // Inject a config only for this process. Occupied local ports make any accidental
  // config forwarding fail; the remote forward must never listen either.
  const config = process.env.HERDR_SSH_QA_CONFIG!;
  writeFileSync(config, `Host herdr-profile-fixture\n  HostName 127.0.0.1\n  User fixture\nHost *\n  LocalForward 127.0.0.1:${server.port} 127.0.0.1:80\n  DynamicForward 127.0.0.1:${server.port}\n  RemoteForward 127.0.0.1:18080 127.0.0.1:80\n`);
  await connect(machine);
  assert.equal(remote("awk '$2 ~ /:46A0$/ && $4 == \"0A\" { print }' /proc/net/tcp"), "", "configured remote forward must not listen");
  assert.ok(readFileSync(process.env.HERDR_SSH_QA_CALLS!, "utf8").includes("-O forward"), "forwarding regression must exercise config on mux commands too");
  console.log("PASS unwanted config forwards suppressed while the bridge forward works");
  assert.ok(existsSync(join(state, "ssh", machine.id)), "dedicated key saved");
  const path = `/api/machines/${machine.id}`;
  const snapshot = (await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot;
  assert.ok(snapshot.workspaces.some((w) => w.label === "existing-default"), "inherited default is the existing server");
  assert.equal(remote("test ! -e /home/fixture/.config/herdr/sessions/default/herdr.sock && echo correct"), "correct");
  console.log("PASS discovery, fingerprint/password approval, bundle install, existing Herdr reuse and default session identity");
  const created = await api<WorkspaceCreated>(path + "/workspace/create", "POST", { cwd: "/home/fixture", label: "ovis-test-ssh-profile" });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws?machine_id=${machine.id}`); sockets.push(ws);
  const frames: ServerMessage[] = [];
  ws.onmessage = (event) => { const m = JSON.parse(String(event.data)) as ServerMessage; frames.push(m); if (m.type === "pty-data" && m.flow) ws.send(JSON.stringify({ type: "pty-ack", pane_id: m.pane_id, stream_id: m.flow.stream_id, offset: m.flow.offset })); };
  await until(async () => ws.readyState, (state) => { assert.notEqual(state, WebSocket.CLOSED, "WebSocket failed"); return state === WebSocket.OPEN; }, "WebSocket open", 10_000);
  ws.send(JSON.stringify({ type: "role", mode: "interact" }));
  ws.send(JSON.stringify({ type: "attach", pane_id: created.pane_id, cols: 80, rows: 24, flow_control: "ack" }));
  await until(async () => frames, (f) => f.some((m) => m.type === "pty-data"), "terminal paint");
  ws.send(JSON.stringify({ type: "resize", pane_id: created.pane_id, cols: 90, rows: 28 }));
  await until(async () => frames, (f) => f.some((m) => m.type === "pane-geometry" && m.cols === 90 && m.rows === 28), "terminal resize");
  // The marker is absent from the echoed command, so only executed input can satisfy the read.
  ws.send(JSON.stringify({ type: "input", pane_id: created.pane_id, text: "printf 'profile-%s-ok\\n' input\r" }));
  await until(async () => api<{ read: { text: string } }>(path + `/pane/read?pane_id=${encodeURIComponent(created.pane_id)}&source=recent&format=text`), (v) => v.read.text.includes("profile-input-ok"), "terminal input");
  ws.close();
  console.log("PASS real remote terminal attach, resize and input");
  server.stop(); server = start();
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state === "connected"), "manager restart");
  const descriptors = JSON.parse(remote("cat /home/fixture/.config/herdr-web-ui/bridges/*.json"));
  remote(`kill -TERM ${Number(descriptors.pid)}`);
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state !== "connected"), "bridge stopped");
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state === "connected"), "approved bridge auto-restart");
  assert.ok((await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot.panes.some((p) => p.pane_id === created.pane_id));
  console.log("PASS manager restart and approved bridge restart preserve existing panes");
  // A second, fresh web state connects to the existing bridge with keys only.
  // That grants reconnection, but not permission to start the bridge after it stops.
  server.stop();
  const connectionState = join(root, "connection-only");
  writeFileSync(config, readFileSync(config, "utf8") + `  IdentityFile ${join(state, "ssh", machine.id)}\n`);
  server = start(connectionState);
  const fresh = (await until(machines, (ms) => ms.some((m) => m.id === machine.id), "fresh discovery")).find((m) => m.id === machine.id)!;
  assert.equal(fresh.action_required, "connect");
  await connect(fresh, false);
  const connectionPermission = JSON.parse(readFileSync(join(connectionState, "herdr-profile-state.json"), "utf8"))[0];
  assert.equal(connectionPermission.connectionApproved, true);
  assert.equal(connectionPermission.approved, false);
  const running = JSON.parse(remote("cat /home/fixture/.config/herdr-web-ui/bridges/*.json"));
  remote(`kill -TERM ${Number(running.pid)}`);
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.action_required === "setup"), "connection-only permission cannot restart the bridge");
  server.stop(); server = start();
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state === "connected"), "approved owner restarts the bridge");
  writeFileSync(config, readFileSync(config, "utf8").replace(/  IdentityFile .*\n/, ""));
  console.log("PASS connecting to an existing bridge grants no installation or startup authority");
  rows = [{ ...rows[0]!, enabled: false }];
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && !m.enabled && m.state === "disconnected"), "source disable");
  rows = [{ ...rows[0]!, enabled: true }];
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.state === "connected"), "source re-enable");
  rows = [{ ...rows[0]!, target: { ...rows[0]!.target!, session: "named-fixture" } }];
  await until(machines, (ms) => ms.some((m) => m.id === machine.id && m.target?.session === "named-fixture"), "retarget");
  assert.ok(!existsSync(join(state, "ssh", machine.id)), "retarget clears old key");
  await connect((await machines()).find((m) => m.id === machine.id)!);
  const named = (await api<{ snapshot: SessionSnapshot }>(path + "/session")).snapshot;
  assert.ok(!named.workspaces.some((w) => w.label === "existing-default"), "named session remains distinct");
  rows = [];
  await until(machines, (ms) => !ms.some((m) => m.id === machine.id), "source removal");
  assert.ok(!existsSync(join(state, "ssh", machine.id)), "removal clears generated key");
  assert.deepEqual(JSON.parse(readFileSync(join(state, "herdr-profile-state.json"), "utf8")), []);
  assert.ok(remote("/home/fixture/.local/bin/herdr status server").includes("status: running"));
  console.log("PASS disable/re-enable, named-session retarget, new approval and removal cleanup; Herdr stays running");
} finally {
  for (const ws of sockets) ws.close(); server?.stop();
  Bun.spawnSync(["docker", "rm", "-f", container]);
  for (const [key, value] of [["OVIS_BUNDLE_MANIFEST", oldManifest], ["HERDR_SOCKET", oldSocket]]) { if (value === undefined) delete process.env[key!]; else process.env[key!] = value; }
  rmSync(root, { recursive: true, force: true });
}
