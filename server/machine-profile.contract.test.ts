import { afterEach, expect, it as test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { files, read, stripComments } from "../scripts/source-scan.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import { unmanagedUpdateStatus } from "../shared/update.ts";
import { createServer } from "./index.ts";
import * as herdr from "./herdr/client.ts";
import { HerdrError, herdrRpc, paneRead } from "./herdr/client.ts";
import { harmlessGroups, trustRefusal } from "./herdr-core/discovery.ts";
import { claimServerState, MachineProfileError } from "./machine-profile.ts";
import { guardLibrary } from "./owner-guard.ts";
import { RelayService } from "./relay/service.ts";
import { bounded, deferred } from "./relay/test-helpers.ts";
import { connectUpdater } from "./update-api.ts";
import { updateStateDir } from "./update-state.ts";

/**
 * serve() refuses the machine profile on Windows (its owner's door is a unix socket in a folder only this
 * account may enter): every case here runs a profile or compares a server with one, so all are skipped there,
 * and the one case of `test.if` below checks that refusal instead.
 */
const it = process.platform === "win32" ? test.skip : test;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const root = resolve(import.meta.dir, "..");
const token = "machine-contract-owner";
const headers = { authorization: `Bearer ${token}`, "x-herdr-update": "1", "x-herdr-machine": "1" };
/**
 * The profile walks its state folder's path at start and refuses one under a folder another account
 * may write: a TMPDIR the walk refuses (a group-writable folder whose group cannot be shown to be
 * private) leaves these folders in root's sticky /tmp, where every CI runner has them.
 */
const parent = trustRefusal(realpathSync(tmpdir()), harmlessGroups(), true) === null ? tmpdir() : "/tmp";
function folder(under: string, prefix = "ovis-machine-profile-") {
  const dir = mkdtempSync(join(under, prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const state = () => folder(parent);
const scratch = () => folder(tmpdir());
/** The local owner's call: on the profile's socket in its state folder, addressed as the command line addresses it. */
function owner(stateDir: string, path: string, init: RequestInit = {}) {
  return fetch(`http://localhost${path}`, { ...init, unix: join(stateDir, "serve.sock") });
}
const upgrade = { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
function cookieRow(stateDir: string, secret: string): string {
  const id = "machine-contract-cookie-row";
  const at = new Date().toISOString();
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: at, devices: [
    { id, label: "a browser at the machine's address", role: "drive", token_hash: createHash("sha256").update(secret).digest("hex"), created_at: at, last_seen_at: null },
  ] }), { mode: 0o600 });
  return id;
}
function marked(stateDir: string) {
  writeFileSync(join(stateDir, "machine-profile.json"), '{"profile":"machine"}', { mode: 0o600 });
}
function contents(dir: string) {
  return (readdirSync(dir, { recursive: true }) as string[]).sort().map((name) => {
    const path = join(dir, name);
    const entry = lstatSync(path);
    return [name, entry.isFile() ? readFileSync(path, "base64") : entry.isDirectory() ? "folder" : "other"];
  });
}
function fakeHerdr(socket: string, refuse?: { method: string; message: string } | { method: string; close: true }) {
  let connections = 0;
  const listener = Bun.listen<{ line: string }>({ unix: socket, socket: {
    open(client) { connections++; client.data = { line: "" }; },
    data(client, chunk) {
      client.data.line += chunk.toString();
      if (!client.data.line.includes("\n")) return;
      const { id, method } = JSON.parse(client.data.line) as { id: string; method: string };
      if (method === refuse?.method && "close" in refuse) { client.end(); return; }
      const answer = method === refuse?.method && "message" in refuse ? { error: { code: "server_error", message: refuse.message } } : { result: { version: "fixture", protocol: 22 } };
      client.write(`${JSON.stringify({ id, ...answer })}\n`);
      client.end();
    },
  } });
  cleanup.push(() => listener.stop(true));
  return { connections: () => connections };
}
/**
 * A folder for XDG_CONFIG_HOME, its herdr folder `<it>/herdr`: a short path, as a unix socket's in it must be, and
 * with no link in it (macOS's temporary folder is reached through one), as the profile requires of a herdr socket.
 */
const herdrConfig = () => realpathSync(folder(parent, "ovis-h-"));
const unsafeSocket = expect.stringMatching(/^The selected herdr socket cannot be used safely by this account/);
/**
 * A server reads the versions of the agent tools it finds on its PATH, each in a process group of its
 * own that outlives a server a test ends, and those tools would write into the HOME of a server whose
 * folders the test has removed.
 */
const launchPath = "/usr/bin:/bin";
/**
 * HOME is a folder of its own unless `env` names one: Bun writes its cache into HOME before the server
 * runs, and a profile starts only on an empty state folder or one it marked.
 */
function launch(stateDir: string, env: Record<string, string | undefined> = {}, umask?: string) {
  const ready = deferred<string>();
  let output = "";
  let errors = "";
  const merged: Record<string, string | undefined> = { ...process.env, OVIS_PROFILE: "machine", OVIS_PREVIEW: "fleet", OVIS_RUNTIME: "herdr", OVIS_STATE_DIR: stateDir,
    HOME: env["HOME"] ?? scratch(), OVIS_TOKEN: token, PATH: launchPath, PORT: "0", HOST: "127.0.0.1", HERDR_REMOTE_SOCKET: process.env["HERDR_SOCKET"] ?? "",
    OVIS_MANAGED: "0", OVIS_TAILSCALE_SERVE_ONLY: "0", OVIS_RELAY_URL: "wss://relay.invalid", ...env };
  const command = umask === undefined ? [process.execPath, "server/main.ts", "serve"] : ["/bin/sh", "-c", `umask ${umask} && exec "$0" server/main.ts serve`, process.execPath];
  const child = Bun.spawn(command, {
    cwd: root, env: Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const read = async (stream: ReadableStream<Uint8Array>, standardError: boolean) => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      output += text;
      if (standardError) errors += text;
      const match = /Ovis listening on (http:\/\/[^\s]+)/.exec(output);
      if (match?.[1]) ready.resolve(match[1]);
    }
  };
  const drained = Promise.all([read(child.stdout, false), read(child.stderr, true)]);
  const exited = child.exited.then(async (code) => { await drained; ready.reject(new Error(output || `Server exited ${code}`)); return code; });
  void ready.promise.catch(() => undefined);
  cleanup.push(async () => { if (child.exitCode === null) child.kill(); await bounded(exited, 15_000); });
  return { child, ready: ready.promise, exited, output: () => output, errors: () => errors };
}

async function refused(server: ReturnType<typeof launch>): Promise<string> {
  expect(await bounded(server.exited, 20_000)).toBe(1);
  const sentence = server.errors().trim();
  expect(sentence).not.toContain("\n");
  expect(sentence).toMatch(/^[A-Z].*\.$/);
  return sentence;
}

it("binds the machine profile only to IPv4 loopback despite publishing settings", async () => {
  const dir = state();
  const herdr = join(dir, "bin", "herdr");
  const server = launch(dir, { HOST: "0.0.0.0", OVIS_IPV6_LOOPBACK: "1", OVIS_LAN_HTTPS: "1", OVIS_TAILSCALE_SERVE_ONLY: "1", OVIS_HERDR_BIN: herdr });
  const base = await bounded(server.ready, 20_000);
  expect(new URL(base).hostname).toBe("127.0.0.1");
  expect(server.output()).toContain(`herdr binary: ${herdr} (from OVIS_HERDR_BIN)\n`);
  const response = await owner(dir, "/api/health", { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, machine_profile: { engine: "herdr" } });
  const direct = await owner(dir, "/api/relay/direct", { method: "POST", headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, body: '{"on":true}' });
  expect(direct.status).toBe(409);
  expect(server.output()).not.toContain("LAN HTTPS on");
});

it.each(["environment", "saved"])("refuses herdr-core selected by %s in its health and runs no hc process", async (source) => {
  const dir = state();
  const bin = scratch();
  const calls = join(bin, "hc-calls");
  const hc = join(bin, "hc");
  writeFileSync(hc, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nif [ "$1" = --version ]; then echo 'hc 0.1.18'; else exit 1; fi\n`, { mode: 0o700 });
  if (source === "saved") { marked(dir); writeFileSync(join(dir, "runtime-0.json"), JSON.stringify({ runtime: "herdr-core", previous: "herdr" })); }
  // the core's own folders are this test's: no core of the user's is ever looked at. Under root's sticky
  // /tmp: a core socket is taken only on a path that no other account can write
  const core = mkdtempSync("/tmp/ovis-machine-core-absent-");
  cleanup.push(() => rmSync(core, { recursive: true, force: true }));
  const server = launch(dir, { OVIS_RUNTIME: source === "environment" ? "herdr-core" : "", OVIS_HC_BIN: hc, HC_SOCKET: join(core, "absent.sock"),
    XDG_RUNTIME_DIR: core, XDG_STATE_HOME: core, XDG_CONFIG_HOME: core });
  await bounded(server.ready, 20_000);
  for (const path of ["/api/health", "/api/health?scope=bridge"]) {
    const response = await owner(dir, path, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, machine_profile: {
      engine: "herdr-core", runtime_down: true, reason: "herdr-core is not supported for a machine yet",
    } });
  }
  await (await owner(dir, "/api/session", { headers })).text();
  expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
});

it("a second machine start on another port and canonical spelling leaves the first owner answering", async () => {
  const dir = state();
  const alias = `${dir}-alias`;
  symlinkSync(dir, alias, "junction");
  cleanup.push(() => rmSync(alias));
  const first = launch(dir, {});
  await bounded(first.ready, 20_000);
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop();
  const second = launch(alias, { PORT: String(port) });
  const outcome = await bounded(Promise.race([second.exited.then((code) => ({ code })), second.ready.then(() => ({ code: 0 }), () => second.exited.then((code) => ({ code })))]), 20_000);
  expect(outcome.code).toBe(1);
  expect(await refused(second)).toContain("already owns this Ovis state directory");
  expect((await owner(dir, "/api/health?scope=bridge")).status).toBe(200);
});

it("refuses the machine profile without OVIS_PREVIEW=fleet before its state folder is touched, and starts it with the preview on", async () => {
  const dir = state();
  // a HOME of its own: Bun keeps its transpiler cache there, which is not the server's writing
  expect(await refused(launch(dir, { OVIS_PREVIEW: undefined, HOME: scratch() }))).toContain("OVIS_PREVIEW=fleet");
  expect(readdirSync(dir)).toEqual([]);
  await bounded(launch(dir).ready, 20_000);
  const health = await (await owner(dir, "/api/health")).json() as Record<string, unknown>;
  expect(health["machine_profile"]).toBeDefined();
});

test.if(process.platform === "win32")("refuses the machine profile on Windows before its state folder is touched", async () => {
  const dir = scratch();
  expect(await refused(launch(dir))).toContain("Windows");
  expect(readdirSync(dir)).toEqual([]);
});

it("keeps an ordinary server's health free of the profile's facts, with OVIS_PREVIEW set or not", async () => {
  for (const preview of [undefined, "fleet"]) {
    const base = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: preview }).ready, 20_000);
    const answer = await fetch(`${base}/api/health`, { headers });
    expect(answer.status).toBe(200);
    const body = await answer.json() as Record<string, unknown>;
    expect(body["auth"]).toMatchObject({ authenticated: true });
    expect(body).not.toHaveProperty("machine_profile");
    const stranger = await (await fetch(`${base}/api/health`)).json() as Record<string, unknown>;
    expect(stranger["auth"]).toMatchObject({ authenticated: false });
    expect(stranger).not.toHaveProperty("machine_profile");
  }
});

it("has an ordinary server hold its state folder only with OVIS_PREVIEW=fleet", async () => {
  for (const [preview, held] of [[undefined, false], ["fleet", true]] as const) {
    const dir = state();
    await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: preview, HOME: scratch() }).ready, 20_000);
    expect(existsSync(join(dir, "serve.own"))).toBe(held);
  }
});

it("ordinary servers on one state folder and different ports both answer without a lease", async () => {
  const dir = state();
  const first = launch(dir, { OVIS_PROFILE: "" });
  const one = await bounded(first.ready, 20_000);
  const second = launch(dir, { OVIS_PROFILE: "" });
  const two = await bounded(second.ready, 20_000);
  expect(one).not.toBe(two);
  for (const base of [one, two]) {
    const answer = await fetch(base + "/api/health?scope=bridge", { headers });
    expect(answer.status).toBe(200);
    expect(await answer.json()).not.toHaveProperty("machine_profile");
  }
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
});

async function supervisorRecord(lock: string) {
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
  const holder = Bun.spawn([process.execPath, "-e", `const { acquireOwnerDirectory } = await import(${JSON.stringify(join(root, "server/owner-guard.ts"))});
acquireOwnerDirectory(${JSON.stringify(lock)}, { running: "running", starting: "starting" });
console.log("held");
setInterval(() => {}, 60_000);`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const held = deferred<void>();
  void (async () => { for await (const chunk of holder.stdout) if (new TextDecoder().decode(chunk).includes("held")) held.resolve(); })();
  void holder.exited.then((code) => held.reject(new Error(`the record's holder exited ${code}`)));
  cleanup.push(async () => { holder.kill(); await bounded(holder.exited, 15_000); });
  await bounded(held.promise, 20_000);
  return holder;
}

async function sharedHold(path: string) {
  const holder = Bun.spawn([process.execPath, "-e", `const { holdForLife } = await import(${JSON.stringify(join(root, "server/owner-guard.ts"))});
holdForLife(${JSON.stringify(path)}, "shared");
console.log("held");
setInterval(() => {}, 60_000);`], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  const held = deferred<void>();
  void (async () => { for await (const chunk of holder.stdout) if (new TextDecoder().decode(chunk).includes("held")) held.resolve(); })();
  void holder.exited.then((code) => held.reject(new Error(`the hold's holder exited ${code}`)));
  cleanup.push(async () => { holder.kill(); await bounded(holder.exited, 15_000); });
  await bounded(held.promise, 20_000);
}

it("refuses a state folder where an Ovis supervisor alive records itself, and starts once that owner is gone", async () => {
  const dir = state();
  marked(dir);
  const lock = join(updateStateDir(root, 7317, dir), "supervisor.lock");
  const holder = await supervisorRecord(lock);
  const before = readdirSync(dir).sort();
  // a HOME of its own: Bun itself writes into HOME, which the state folder is in the other launches
  const server = launch(dir, { HOME: scratch() });
  expect(await refused(server)).toContain(`An Ovis already runs on this state folder (lock ${lock}, owner pid ${holder.pid} generation `);
  expect(readdirSync(dir).sort()).toEqual(before);
  holder.kill();
  await bounded(holder.exited, 15_000);
  expect(existsSync(join(lock, "owner.json"))).toBe(true);
  const after = launch(dir);
  await bounded(after.ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

const spellings: [string, (home: string) => string | undefined][] = [
  ["OVIS_STATE_DIR unset", () => undefined],
  ["the default folder", (home) => join(home, ".config", "ovis")],
  ["the older default folder", (home) => join(home, ".config", "herdr-web-ui")],
  ["a trailing slash", (home) => `${join(home, ".config", "ovis")}/`],
  ["a path through ..", (home) => join(home, ".config", "herdr-web-ui", "..", "ovis")],
  ["a relative path", (home) => relative(root, join(home, ".config", "ovis"))],
  ["a symlink", (home) => { const alias = join(home, "alias"); symlinkSync(join(home, ".config", "ovis"), alias, "junction"); return alias; }],
];
it.each(spellings)("refuses a default Ovis state folder named by %s and writes nothing there", async (_, spelling) => {
  const home = scratch();
  for (const name of ["ovis", "herdr-web-ui"]) {
    mkdirSync(join(home, ".config", name), { recursive: true });
    writeFileSync(join(home, ".config", name, "devices.json"), "{}");
  }
  const server = launch(home, { HOME: home, XDG_CONFIG_HOME: undefined, OVIS_STATE_DIR: spelling(home) });
  expect(await refused(server)).toContain("default Ovis state folder");
  for (const name of ["ovis", "herdr-web-ui"]) expect(readdirSync(join(home, ".config", name))).toEqual(["devices.json"]);
});

it("removes its lease, its socket and the recorded listener when stopped cleanly", async () => {
  const dir = state();
  const server = launch(dir);
  const base = await bounded(server.ready, 20_000);
  expect(JSON.parse(readFileSync(join(dir, "serve.lock", "http.json"), "utf8"))).toEqual({ port: Number(new URL(base).port), hostname: "127.0.0.1", socket: join(realpathSync(dir), "serve.sock"), door: 1 });
  server.child.kill("SIGTERM");
  expect(await bounded(server.exited, 20_000)).toBe(0);
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
  expect(existsSync(join(dir, "serve.sock"))).toBe(false);
});

it("names HERDR_SOCKET when the socket it gives cannot be used, and says which herdr it runs", async () => {
  const dir = state();
  const server = launch(dir, { HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: "relative/herdr.sock", OVIS_HERDR_BIN: "" });
  await bounded(server.ready, 20_000);
  expect(server.output()).toMatch(/herdr binary: [^\n]+ \(from PATH\)\n/);
  const response = await owner(dir, "/api/health", { headers });
  expect(await response.json()).toMatchObject({ machine_profile: { runtime_down: true, reason: "HERDR_SOCKET must be an absolute path ending in /herdr.sock" } });
});

it.each([["does not exist yet", false], ["exists", true]] as const)("keeps authenticated health while the selected herdr is absent under this account's herdr folder that %s, and uses that herdr once it starts", async (_, made) => {
  const dir = state();
  const config = herdrConfig();
  if (made) mkdirSync(join(config, "herdr"), { mode: 0o700 });
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  const response = await owner(dir, "/api/health", { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, auth: { authenticated: true }, machine_profile: { engine: "herdr", runtime_down: true, reason: "herdr is not running for the selected session" } });
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const herdr = fakeHerdr(socket);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { protocol: 22 } });
  expect(herdr.connections()).toBeGreaterThan(0);
});

it("refuses an absent HERDR_REMOTE_SOCKET in a folder another account may write, and never uses a socket made there later", async () => {
  // outside every herdr folder of this account, where anyone could make the socket once the profile runs
  const open = scratch();
  chmodSync(open, 0o777);
  const socket = join(open, "herdr.sock");
  const dir = state();
  const server = launch(dir, { HERDR_REMOTE_SOCKET: socket, XDG_CONFIG_HOME: undefined });
  await bounded(server.ready, 20_000);
  const refusal = { machine_profile: { engine: "herdr", runtime_down: true, reason: unsafeSocket } };
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject(refusal);
  const planted = fakeHerdr(socket);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject(refusal);
  await (await owner(dir, "/api/session", { headers })).text();
  expect(planted.connections()).toBe(0);
});

it("connects to nothing that appears at the selected path but this account's own socket", async () => {
  const dir = state();
  const config = herdrConfig();
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  // what appears at the selected path is a link to a herdr in a folder anyone may write
  const open = scratch();
  chmodSync(open, 0o777);
  const planted = fakeHerdr(join(open, "herdr.sock"));
  const selected = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(selected), { recursive: true, mode: 0o700 });
  symlinkSync(join(open, "herdr.sock"), selected);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: true, reason: unsafeSocket } });
  await (await owner(dir, "/api/session", { headers })).text();
  expect(planted.connections()).toBe(0);
});

it("finds the one herdr session that starts after it, when none was selected", async () => {
  const dir = state();
  const config = herdrConfig();
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: true, reason: "herdr is not running for the selected session" } });
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  fakeHerdr(socket);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { protocol: 22 } });
});

function openHome() {
  const home = herdrConfig();
  chmodSync(home, 0o777);
  mkdirSync(join(home, ".config"), { mode: 0o700 });
  return { home, socket: join(home, ".config", "herdr", "sessions", "a", "herdr.sock") };
}

it.each(["absent", "running"])("refuses a named session whose herdr is %s under a HOME another account may write, and names that folder to its owner alone", async (herdr) => {
  // that account could rename ~/.config between the check and a connection, with no link on the path
  const { home, socket } = openHome();
  let planted: ReturnType<typeof fakeHerdr> | undefined;
  if (herdr === "running") { mkdirSync(dirname(socket), { recursive: true, mode: 0o700 }); planted = fakeHerdr(socket); }
  const dir = state();
  const server = launch(dir, { HOME: home, XDG_CONFIG_HOME: undefined, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  const base = await bounded(server.ready, 20_000);
  const health = await (await owner(dir, "/api/health", { headers })).json() as { machine_profile: { reason: string } };
  // read first: toMatchObject puts its matcher where it matched
  const { reason } = health.machine_profile;
  expect(health).toMatchObject({ machine_profile: { runtime_down: true, reason: unsafeSocket } });
  // the walk's reason names the folder another account may write, in the start's engine line too, never on standard error
  expect(reason).toContain(`${home} `);
  expect(server.output()).toContain(`Machine engine: herdr (${reason})\n`);
  expect(server.errors()).not.toContain(home);
  // nobody without full access reads it: TCP answers liveness, and the socket a request naming another host 401
  expect(await (await fetch(`${base}/api/health`, { headers })).text()).toBe('{"ok":true}');
  const stranger = await owner(dir, "/api/health", { headers: { ...headers, host: "evil.example" } });
  expect([stranger.status, (await stranger.text()).includes(home)]).toEqual([401, false]);
  expect(planted?.connections() ?? 0).toBe(0);
});

it("refuses its pinned herdr at once when a folder on the way becomes writable by everyone", async () => {
  const dir = state();
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const herdr = fakeHerdr(socket);
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null } });
  const used = herdr.connections();
  // well inside the age the profile keeps its ACL answers: a folder's mode is read before every connection
  chmodSync(join(config, "herdr"), 0o777);
  const health = await (await owner(dir, "/api/health", { headers })).json() as { machine_profile: { reason: string } };
  const { reason } = health.machine_profile;
  expect(health).toMatchObject({ machine_profile: { runtime_down: true, reason: unsafeSocket } });
  expect(reason).toContain(join(config, "herdr"));
  expect(herdr.connections()).toBe(used);
});

it("connects to no session its walk refuses while it looks for one, names why to its owner, and takes it once its place is safe", async () => {
  const { home, socket } = openHome();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const unsafe = fakeHerdr(socket);
  const dir = state();
  const server = launch(dir, { HOME: home, XDG_CONFIG_HOME: undefined, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  // the one session under a HOME everyone may write is not a session found: the discovery before the start did not even connect to it
  expect(unsafe.connections()).toBe(0);
  const health = await (await owner(dir, "/api/health", { headers })).json() as { machine_profile: { reason: string } };
  const { reason } = health.machine_profile;
  expect(health).toMatchObject({ machine_profile: { runtime_down: true, reason: unsafeSocket } });
  expect(reason).toContain(`${home} `);
  expect(server.output()).toContain(`Machine engine: herdr (${reason})\n`);
  expect(server.errors()).not.toContain(home);
  expect(unsafe.connections()).toBe(0);
  chmodSync(home, 0o700);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { protocol: 22 } });
});

it("pins the one safe session running beside an unsafe one", async () => {
  const { home, socket } = openHome();
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const unsafe = fakeHerdr(socket);
  const config = herdrConfig();
  const safe = join(config, "herdr", "sessions", "b", "herdr.sock");
  mkdirSync(dirname(safe), { recursive: true, mode: 0o700 });
  fakeHerdr(safe);
  const dir = state();
  const server = launch(dir, { HOME: home, XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null }, herdr: { protocol: 22 } });
  expect(unsafe.connections()).toBe(0);
});

it("still asks which one when two safe sessions run", async () => {
  const config = herdrConfig();
  for (const name of ["a", "b"]) {
    const socket = join(config, "herdr", "sessions", name, "herdr.sock");
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    fakeHerdr(socket);
  }
  const dir = state();
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: true, reason: "Several herdr sessions are running; select one with HERDR_REMOTE_SOCKET" } });
});

it.each(["/api/session", "/api/machines"])("looks for a herdr that started after it on a request for %s too, before any health check", async (path) => {
  const dir = state();
  const config = herdrConfig();
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "", HERDR_SOCKET: undefined });
  await bounded(server.ready, 20_000);
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const herdr = fakeHerdr(socket);
  await (await owner(dir, path, { headers })).text();
  expect(herdr.connections()).toBeGreaterThan(0);
});

it("answers /api/session with its health's reason while its herdr is down", async () => {
  const dir = state();
  const server = launch(dir, { XDG_CONFIG_HOME: herdrConfig(), HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  const reason = (await (await owner(dir, "/api/health", { headers })).json() as { machine_profile: { reason: string } }).machine_profile.reason;
  expect(reason).toBe("herdr is not running for the selected session");
  const response = await owner(dir, "/api/session", { headers });
  const text = await response.text();
  expect([response.status, JSON.parse(text)]).toEqual([502, { error: { code: "connect_failed", message: reason } }]);
  expect([text.includes(realpathSync(dir)), text.includes("herdr.sock")]).toEqual([false, false]);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it.each(["/api/session", "/api/machines"])("answers a herdr read that fails on %s while herdr answers its health with one sentence of its own", async (path) => {
  const dir = state();
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  fakeHerdr(socket, { method: "session.snapshot", message: `cannot read the session behind ${socket}` });
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  expect(await (await owner(dir, "/api/health", { headers })).json()).toMatchObject({ machine_profile: { runtime_down: false, reason: null } });
  const response = await owner(dir, path, { headers });
  const text = await response.text();
  // a code herdr gave is answered as one fixed code; the status is the one every failed herdr read answers with
  expect([response.status, JSON.parse(text)]).toEqual([404, { error: { code: "herdr_error", message: "herdr did not answer this request" } }]);
  expect([text.includes(config), text.includes(realpathSync(dir)), text.includes("herdr.sock")]).toEqual([false, false, false]);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("keeps the bridge's own code when herdr closes the connection before it answers the read", async () => {
  const dir = state();
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  fakeHerdr(socket, { method: "session.snapshot", close: true });
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  const response = await owner(dir, "/api/session", { headers });
  expect([response.status, await response.json()]).toEqual([404, { error: { code: "closed", message: "herdr did not answer this request" } }]);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("answers an ordinary server's failed /api/session with herdr's own message", async () => {
  const socket = join(scratch(), "herdr.sock");
  const base = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: undefined, HERDR_SOCKET: socket }).ready, 20_000);
  const response = await fetch(`${base}/api/session`, { headers });
  const body = await response.json() as { error: { code: string; message: string } };
  expect([response.status, body.error.code]).toEqual([502, "connect_failed"]);
  expect(body.error.message).toContain(`cannot reach herdr at ${socket}`);
});

it("lists this machine alone on GET /api/machines, under its own name, and says why its engine is down", async () => {
  const dir = state();
  const server = launch(dir, { XDG_CONFIG_HOME: herdrConfig(), HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  const health = await (await owner(dir, "/api/health", { headers })).json() as { machine_profile: { reason: string }; web_ui: { boot_id: string; server_id?: string } };
  expect(health.machine_profile.reason).toBe("herdr is not running for the selected session");
  const response = await owner(dir, "/api/machines", { headers });
  expect(response.status).toBe(200);
  const { machines } = await response.json() as { machines: Record<string, unknown>[] };
  expect(machines).toEqual([{ id: "local", name: hostname(), kind: "local", enabled: true, state: "error", error: health.machine_profile.reason,
    snapshot: null, source_boot_id: health.web_ui.boot_id, ...(health.web_ui.server_id ? { server_id: health.web_ui.server_id } : {}) }]);
});

it("proves its own boot to its owner on GET /api/machines?verify_source_boot=local, and names no other PC", async () => {
  const { stateDir } = profileServer();
  const boot = (await (await owner(stateDir, "/api/health", { headers })).json() as { web_ui: { boot_id: string } }).web_ui.boot_id;
  const proved = await owner(stateDir, "/api/machines?verify_source_boot=local", { headers });
  expect(proved.status).toBe(200);
  const body = await proved.json() as { machines: { id: string; source_boot_id: string }[]; verified_source_boot?: unknown };
  expect(body.machines.map((machine) => [machine.id, machine.source_boot_id])).toEqual([["local", boot]]);
  expect(body.verified_source_boot).toEqual({ machine_id: "local", boot_id: boot });
  for (const path of ["/api/machines?verify_source_boot=other", "/api/machines"]) {
    expect(await (await owner(stateDir, path, { headers })).json()).not.toHaveProperty("verified_source_boot");
  }
  // the roster answers this app's page only, as an ordinary server's does
  const foreign = await owner(stateDir, "/api/machines", { headers: { ...headers, origin: "http://evil.example" } });
  expect([foreign.status, (await foreign.json() as { error: { code: string } }).error.code]).toEqual([403, "invalid_origin"]);
});

it("refuses every other route of /api/machines to its owner, as the routes between PCs", async () => {
  const { stateDir } = profileServer();
  const routes: [string, string][] = [["POST", "/api/machines"], ["DELETE", "/api/machines"], ["PATCH", "/api/machines"], ["GET", "/api/machines/events"],
    ["GET", "/api/machines/local/session"], ["GET", "/api/machines/ssh-candidates"], ["GET", "/api/machines/tailnet"], ["GET", "/api/machines/other-pc/session"],
    ["GET", "/api/machines/"]];
  for (const [method, path] of routes) {
    const response = await owner(stateDir, path, { method, headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, ...(method === "GET" ? {} : { body: "{}" }) });
    expect([method, path, response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([method, path, 409, "machine_profile"]);
  }
});

it("takes a state folder holding only an unheld serve.own, as a start killed before its mark leaves it", async () => {
  const dir = state();
  writeFileSync(join(dir, "serve.own"), "", { mode: 0o600 });
  await bounded(launch(dir).ready, 20_000);
  expect(JSON.parse(readFileSync(join(dir, "machine-profile.json"), "utf8"))).toEqual({ profile: "machine" });
});

it("refuses a state folder whose serve.own an ordinary server holds shared, as owned by another server", async () => {
  const dir = state();
  await sharedHold(join(dir, "serve.own"));
  expect(await refused(launch(dir))).toContain("already owns this Ovis state directory");
  expect(readdirSync(dir)).toEqual(["serve.own"]);
});

it("refuses a state folder an ordinary server has used, and leaves it as it was", async () => {
  const dir = state();
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  await bounded(ordinary.ready, 20_000);
  ordinary.child.kill("SIGKILL");
  await bounded(ordinary.exited, 15_000);
  const before = contents(dir);
  expect(before.length).toBeGreaterThan(0);
  const profile = launch(dir);
  expect(await bounded(profile.ready.then(() => "started", () => profile.exited), 20_000)).toBe(1);
  expect(await refused(profile)).toContain(realpathSync(dir));
  expect(contents(dir)).toEqual(before);
});

it("refuses a folder another server wrote into while the profile took its hold, and leaves what that server left", () => {
  const dir = realpathSync(state());
  guardLibrary.posix = (calls) => ({ ...calls, flock: (fd, operation) => { writeFileSync(join(dir, "telemetry.json"), "{}"); return calls.flock(fd, operation); } });
  cleanup.push(() => { delete guardLibrary.posix; });
  expect(() => claimServerState(dir)).toThrow(MachineProfileError);
  expect(readdirSync(dir)).toEqual(["telemetry.json"]);
});

it("leaves the serve.own another server made right before this start would make it, when it refuses the folder", () => {
  const dir = realpathSync(state());
  const hold = join(dir, "serve.own");
  const open = fs.openSync;
  let theirs: number | undefined;
  const made = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
    if (path === hold && theirs === undefined) {
      writeFileSync(hold, "", { mode: 0o600 });
      theirs = lstatSync(hold).ino;
      writeFileSync(join(dir, "telemetry.json"), "{}");
    }
    return (open as (...args: unknown[]) => number)(path, ...rest);
  }) as typeof fs.openSync);
  cleanup.push(() => { made.mockRestore(); });
  expect(() => claimServerState(dir)).toThrow(MachineProfileError);
  expect(theirs).toBeDefined();
  expect(lstatSync(hold).ino).toBe(theirs ?? -1);
  expect(readdirSync(dir).sort()).toEqual(["serve.own", "telemetry.json"]);
});

it("refuses an ordinary server whose folder a profile marked after its first look, before the device list is read", () => {
  const dir = state();
  marked(dir);
  let error: unknown;
  try {
    const server = createServer({ stateDir: dir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false });
    cleanup.push(() => server.stop());
  } catch (thrown) { error = thrown; }
  expect(String(error)).toContain(join(dir, "machine-profile.json"));
  expect(readdirSync(dir)).toEqual(["machine-profile.json"]);
});

it("refuses a state folder whose machine-profile.json is not its own, naming that file, and leaves it as it was", async () => {
  const dir = realpathSync(state());
  writeFileSync(join(dir, "machine-profile.json"), '{"profile":"other"}', { mode: 0o600 });
  const before = contents(dir);
  expect(await refused(launch(dir))).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
});

it("takes an empty state folder and marks it as its own, and starts again on the folder it marked", async () => {
  const dir = state();
  const first = launch(dir);
  await bounded(first.ready, 20_000);
  const marker = join(dir, "machine-profile.json");
  expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ profile: "machine" });
  expect(statSync(marker).mode & 0o777).toBe(0o600);
  first.child.kill("SIGKILL");
  await bounded(first.exited, 15_000);
  await bounded(launch(dir).ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

const restricted = [
  "/api/herdr/update", "/api/runtime", "/api/runtime/move", "/api/runtime/move/install",
  "/api/runtime/move/stop", "/api/runtime/move/stop-all", "/api/runtime/move/start", "/api/runtime/move/cancel",
  "/api/portal", "/api/portal/start", "/api/relay/direct", "/api/machines", "/api/machines/ssh-candidates",
  "/api/fleet/machines", "/api/fleet/invites", "/api/fleet/restore/confirm", "/api/bridge", "/api/devices/pair/start",
];
it.each(restricted)("refuses %s even to an owner in the machine profile", async (path) => {
  const stateDir = scratch();
  const server = createServer({ profile: "machine", stateDir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false });
  cleanup.push(() => server.stop());
  const response = await owner(stateDir, path, { method: "POST", headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, body: '{}' });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "machine_profile" } });
});

it("answers its owner's check for updates as unmanaged, and asks the updater nothing, even when given a managed one", async () => {
  const sent: unknown[] = [];
  let deliver: (message: unknown) => void = () => {};
  const updates = connectUpdater({ send: (message) => { sent.push(message); }, onMessage: (listener) => { deliver = listener; } });
  deliver({ type: "update-status", status: { ...unmanagedUpdateStatus(), managed: true, blocked_reason: null } });
  expect(updates.status().managed).toBe(true);
  const stateDir = scratch();
  const server = createServer({ profile: "machine", stateDir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false, updates });
  cleanup.push(() => server.stop());
  const response = await owner(stateDir, "/api/updates/check", { method: "POST", headers: { origin: "http://localhost", "x-herdr-update": "1" } });
  expect([response.status, (await response.json() as { error?: { code: string } }).error?.code]).toEqual([409, "updates_unmanaged"]);
  expect(sent).toEqual([{ type: "update-status-request" }]);
});

it.each(["", "?scope=bridge"])("gives an unknown caller only plain liveness at /api/health%s", async (query) => {
  const options = { profile: "machine" as const, stateDir: scratch(), port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false };
  const server = createServer(options);
  cleanup.push(() => server.stop());
  const response = await fetch(`http://127.0.0.1:${server.port}/api/health${query}`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
  expect(response.headers.get("cache-control")).toBe("no-store");
});

function pair(options: NonNullable<Parameters<typeof createServer>[0]>) {
  const stateDir = scratch();
  const profile = createServer({ profile: "machine", stateDir, port: 0, hostname: "127.0.0.1", sidecar: false, ...options });
  const ordinary = createServer({ stateDir: scratch(), port: 0, hostname: "127.0.0.1", sidecar: false, ...options });
  cleanup.push(() => profile.stop(), () => ordinary.stop());
  return { profile: profile.port, ordinary: ordinary.port, stateDir };
}

it("closes the pairing gate from the profile's first answer", async () => {
  const { stateDir, ordinary } = pair({ token: "", tailscaleOwner: null });
  const first = await (await owner(stateDir, "/api/health")).json();
  expect(first).toMatchObject({ auth: { via: "local" }, security: { pairing_gate: "closed" } });
  expect(await (await fetch(`http://127.0.0.1:${ordinary}/api/health`)).json()).toMatchObject({ security: { pairing_gate: "open" } });
});

it("lets a DNS-rebinding page in nowhere before the relay was ever on, while this PC's own account still gets in on its socket", async () => {
  const { profile, ordinary, stateDir } = pair({ token: "", tailscaleOwner: null });
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string } }>("workspace.create", { label: "ovis-test-machine-door", cwd: root, focus: false });
  cleanup.push(async () => { await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id }); });
  const paneId = created.root_pane.pane_id;
  const page = (port: number) => ({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` });
  // control: an ordinary server whose pairing gate is still open answers this as an open install; the profile, whose gate is closed, does not
  const forwarded = { "x-forwarded-for": "203.0.113.7" };
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: forwarded })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: forwarded })).status).toBe(401);
  // the page's own name from loopback is a rebound name on an ordinary server too (#3876): it is asked to pair
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: page(ordinary) })).status).toBe(401);
  expect((await (await fetch(`http://127.0.0.1:${ordinary}/api/health`, { headers: page(ordinary) })).json()).auth).toMatchObject({ authenticated: false, reason: "pairing_required" });
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: page(profile) })).status).toBe(401);
  const typed = await fetch(`http://127.0.0.1:${profile}/api/pane/input`, { method: "POST", headers: { ...page(profile), "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, text: "MACHINE_REBIND" }) });
  expect(typed.status).toBe(401);
  const socket = await fetch(`http://127.0.0.1:${profile}/ws`, { headers: { ...page(profile), ...upgrade } });
  expect(socket.status).toBe(401);
  // a program of this PC's own account on loopback TCP with no header of value is nobody either
  const loopback = await fetch(`http://127.0.0.1:${profile}/api/pane/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, text: "MACHINE_LOOPBACK" }) });
  expect(loopback.status).toBe(401);
  const own = await owner(stateDir, "/api/pane/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId, text: "MACHINE_OWNER" }) });
  expect(own.status).toBe(200);
  const deadline = Date.now() + 15_000;
  let text = "";
  while (!text.includes("MACHINE_OWNER")) {
    if (Date.now() > deadline) throw new Error(`the owner's text never reached the pane: ${text}`);
    text = (await paneRead({ paneId, source: "recent", format: "text", lines: 200 })).text ?? "";
    if (!text.includes("MACHINE_OWNER")) await Bun.sleep(25);
  }
  expect(text).not.toContain("MACHINE_REBIND");
  expect(text).not.toContain("MACHINE_LOOPBACK");
});

it("lets nobody in by a Tailscale identity header, the machine's own login included", async () => {
  const { profile, ordinary } = pair({ token: "", tailscaleOwner: "owner@example.com" });
  const identity = { "tailscale-user-login": "owner@example.com", "x-forwarded-for": "100.64.0.7" };
  const admitted = await fetch(`http://127.0.0.1:${ordinary}/api/health`, { headers: identity });
  expect(await admitted.json()).toMatchObject({ auth: { authenticated: true, via: "tailscale" } });
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: identity })).status).toBe(401);
  const health = await fetch(`http://127.0.0.1:${profile}/api/health`, { headers: identity });
  expect(await health.text()).toBe('{"ok":true}');
});

it("treats the bridge token as nobody in the profile", async () => {
  const bridgeToken = "machine-contract-bridge-token";
  const { profile, ordinary } = pair({ token, bridgeToken, tailscaleOwner: null });
  const bearer = { authorization: `Bearer ${bridgeToken}` };
  expect((await fetch(`http://127.0.0.1:${ordinary}/api/session`, { headers: bearer })).status).toBe(200);
  expect((await fetch(`http://127.0.0.1:${profile}/api/session`, { headers: bearer })).status).toBe(401);
  expect(await (await fetch(`http://127.0.0.1:${profile}/api/health?scope=bridge`, { headers: bearer })).text()).toBe('{"ok":true}');
});

function profileServer(prepare: (stateDir: string) => void = () => {}) {
  const stateDir = scratch();
  prepare(stateDir);
  const account = new FakeAccountService();
  const server = createServer({ profile: "machine", stateDir, port: 0, hostname: "127.0.0.1", token, tailscaleOwner: null, sidecar: false,
    machineRefusal: () => "no engine in this test", relay: new RelayService({ stateDir, relay: "wss://relay.invalid" }),
    accountService: { url: "https://account.test", fetch: account.fetch } });
  cleanup.push(() => server.stop());
  return { stateDir, base: `http://127.0.0.1:${server.port}` };
}

it("answers only liveness on TCP to every caller: the token, a device paired at the machine's own address, the command line's headers", async () => {
  const secret = "machine-contract-cookie";
  let id = "";
  const { stateDir, base } = profileServer((dir) => { id = cookieRow(dir, secret); });
  const shapes: Record<string, string>[] = [
    { ...headers, origin: base },
    { cookie: `ovis_device=${secret}`, origin: base },
    { authorization: `Device ${secret}`, "x-herdr-machine": "1", origin: base },
    {},
  ];
  const calls: [string, string][] = [["GET", "/api/session"], ["GET", "/api/devices"], ["GET", "/api/account/status"], ["POST", "/api/relay/start"],
    ["POST", "/api/relay/offer"], ["POST", "/api/devices/pair/start"], ["POST", "/api/auth"], ["POST", "/api/devices/pair"], ["GET", "/api/nothing"]];
  for (const shape of shapes) {
    for (const [method, path] of calls) {
      const response = await fetch(base + path, { method, headers: { ...shape, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      const body = await response.json() as { error?: { code?: string } };
      expect([method, path, response.status, body.error?.code]).toEqual([method, path, 401, "unauthorized"]);
    }
    for (const query of ["", "?scope=bridge"]) {
      const health = await fetch(`${base}/api/health${query}`, { headers: shape });
      expect([health.status, await health.text()]).toEqual([200, '{"ok":true}']);
    }
    expect((await fetch(`${base}/ws`, { headers: { ...shape, ...upgrade } })).status).toBe(401);
    expect((await fetch(`${base}/`, { headers: shape })).status).toBe(404);
  }
  // nothing on TCP started the relay or paired anyone
  expect(await (await owner(stateDir, "/api/relay")).json()).toMatchObject({ phase: "off" });
  expect((await (await owner(stateDir, "/api/devices")).json() as { devices: { id: string }[] }).devices.map((device) => device.id)).toEqual([id]);
});

it("takes the caller on its socket as the local owner, and a cookie there adds nothing", async () => {
  const secret = "machine-contract-cookie";
  const { stateDir } = profileServer((dir) => cookieRow(dir, secret));
  for (const extra of [{}, { cookie: `ovis_device=${secret}` }, { authorization: `Device ${secret}` }] as Record<string, string>[]) {
    const health = await owner(stateDir, "/api/health", { headers: { "x-herdr-machine": "1", ...extra } });
    expect(health.status).toBe(200);
    const body = await health.json() as { auth: Record<string, unknown> };
    expect(body).toMatchObject({ ok: true, auth: { authenticated: true, via: "local", role: "drive" }, machine_profile: { engine: "herdr" }, security: { pairing_gate: "closed" } });
    expect(body.auth).not.toHaveProperty("device");
  }
  expect((await owner(stateDir, "/api/devices")).status).toBe(200);
  expect((await owner(stateDir, "/api/account/status")).status).toBe(200);
  const offer = await owner(stateDir, "/api/relay/offer", { method: "POST", headers: { origin: "http://localhost", "x-herdr-update": "1", "x-ovis-expect-account": "acct_owner" } });
  expect([offer.status, (await offer.json() as { error: { code: string } }).error.code]).toEqual([409, "relay_off"]);
});

it("refuses on its socket a request that names another host or shows a proxy, a change from another site, and a cookie's pairing", async () => {
  const { stateDir } = profileServer();
  for (const host of ["localhost:80", "127.0.0.1", hostname(), "evil.example"]) {
    for (const path of ["/api/devices", "/api/health"]) {
      const response = await owner(stateDir, path, { headers: { host } });
      expect([host, path, response.status]).toEqual([host, path, 401]);
    }
  }
  const proxied: [string, string][] = [["x-forwarded-for", "203.0.113.7"], ["x-forwarded-host", "localhost"], ["x-forwarded-proto", "http"], ["x-real-ip", "203.0.113.7"],
    ["forwarded", "for=203.0.113.7"], ["via", "1.1 proxy"], ["tailscale-user-login", "owner@example.com"], ["tailscale-funnel-request", "?1"],
    ["x-forwarded-port", "443"], ["x-forwarded-server", "proxy"], ["x-forwarded-scheme", "https"], ["x-original-forwarded-for", "203.0.113.7"],
    ["cf-connecting-ip", "203.0.113.7"], ["true-client-ip", "203.0.113.7"], ["x-client-ip", "203.0.113.7"], ["fly-client-ip", "203.0.113.7"],
    ["x-envoy-external-address", "203.0.113.7"], ["cdn-loop", "cloudflare"]];
  for (const [name, value] of proxied) {
    const response = await owner(stateDir, "/api/devices", { headers: { [name]: value } });
    expect([name, response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([name, 401, "unauthorized"]);
  }
  for (const other of [{ origin: "http://evil.example" }, { origin: "http://localhost", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    const change = await owner(stateDir, "/api/relay/offer", { method: "POST", headers: { ...other, "x-herdr-update": "1" } });
    expect([change.status, (await change.json() as { error: { code: string } }).error.code]).toEqual([403, "invalid_origin"]);
    expect((await owner(stateDir, "/ws", { headers: { ...other, ...upgrade } })).status).toBe(403);
  }
  const paired = await owner(stateDir, "/api/devices/pair", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: '{"code":"123456"}' });
  expect([paired.status, (await paired.json() as { error: { code: string } }).error.code]).toEqual([409, "machine_profile"]);
});

it("refuses on its socket a request that names no host at all, as HTTP/1.0 may", async () => {
  const { stateDir } = profileServer();
  let answer = "";
  const closed = deferred<void>();
  await Bun.connect({ unix: join(stateDir, "serve.sock"), socket: {
    open(client) { client.write("GET /api/devices HTTP/1.0\r\n\r\n"); },
    data(_client, chunk) { answer += chunk.toString(); },
    close() { closed.resolve(); },
  } });
  await bounded(closed.promise);
  expect(answer.split("\r\n")[0]).toBe("HTTP/1.1 401 Unauthorized");
  expect(JSON.parse(answer.slice(answer.indexOf("\r\n\r\n") + 4))).toMatchObject({ error: { code: "unauthorized" } });
});

it("ignores OVIS_TOKEN and says so once at its start, and names the devices paired at its own address that cannot reach it", async () => {
  const dir = state();
  const secret = "machine-contract-cookie";
  marked(dir);
  const id = cookieRow(dir, secret);
  const server = launch(dir);
  const base = await bounded(server.ready, 20_000);
  expect(server.output().split("\n").filter((line) => line.includes("OVIS_TOKEN"))).toHaveLength(1);
  expect(server.output()).toContain(id);
  for (const shape of [headers, { cookie: `ovis_device=${secret}` }]) {
    expect((await fetch(`${base}/api/session`, { headers: shape })).status).toBe(401);
    expect(await (await fetch(`${base}/api/health`, { headers: shape })).text()).toBe('{"ok":true}');
  }
  expect(await (await owner(dir, "/api/health")).json()).toMatchObject({ auth: { via: "local" } });
});

it("makes its folder 0700 and its socket 0600 under umask 002, gives the umask back, and names the socket in its lease", async () => {
  const dir = join(state(), "made");
  // a HOME of its own: Bun makes HOME's folders itself before the server runs
  const server = launch(dir, { HOME: scratch() }, "002");
  const base = await bounded(server.ready, 20_000);
  const socket = join(realpathSync(dir), "serve.sock");
  expect(statSync(dir).mode & 0o7777).toBe(0o700);
  expect(lstatSync(socket).isSocket()).toBe(true);
  expect(lstatSync(socket).mode & 0o7777).toBe(0o600);
  if (process.platform === "linux") expect(/^Umask:\s+(\d+)$/m.exec(readFileSync(`/proc/${server.child.pid}/status`, "utf8"))?.[1]).toBe("0002");
  expect(JSON.parse(readFileSync(join(dir, "serve.lock", "http.json"), "utf8"))).toEqual({ port: Number(new URL(base).port), hostname: "127.0.0.1", socket, door: 1 });
  // the kernel checks the folder at every connect, for this account too
  chmodSync(dir, 0o600);
  try {
    const connected = await Bun.connect({ unix: socket, socket: { data() {} } }).then((client) => { client.end(); return "connected"; }, (error: { code?: string }) => error.code);
    expect(connected).toBe("EACCES");
  } finally { chmodSync(dir, 0o700); }
});

const unsafe: [string, () => { told: string; looked: string }][] = [
  ["a folder above it that everyone can write", () => { const above = state(); chmodSync(above, 0o777); cleanup.push(() => chmodSync(above, 0o700)); return { told: join(above, "state"), looked: above }; }],
  ["a state folder of mode 0755", () => { const dir = state(); chmodSync(dir, 0o755); return { told: dir, looked: dir }; }],
];
it.each(unsafe)("refuses to start with %s, and writes nothing", async (_, setup) => {
  const { told, looked } = setup();
  const before = readdirSync(looked).sort();
  const sentence = await refused(launch(told, { HOME: scratch() }));
  expect(sentence).toContain(realpathSync(looked));
  expect(readdirSync(looked).sort()).toEqual(before);
});

it.skipIf(process.getuid?.() === 0)("refuses a state folder that root owns", async () => {
  const sentence = await refused(launch("/root", { HOME: scratch() }));
  expect(sentence).toContain("/root");
  expect(sentence).not.toContain("EACCES");
});

it("starts in a folder of a mktemp -d under /tmp", async () => {
  const dir = mkdtempSync("/tmp/ovis-machine-walk-");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  await bounded(launch(join(dir, "state"), { HOME: scratch() }).ready, 20_000);
  expect((await owner(join(dir, "state"), "/api/health")).status).toBe(200);
});

it("refuses a state folder whose socket path would be longer than 100 bytes, and writes nothing", async () => {
  const above = realpathSync(state());
  const dir = join(above, "x".repeat(Math.max(1, 110 - above.length)));
  mkdirSync(dir, { mode: 0o700 });
  expect(Buffer.byteLength(join(dir, "serve.sock"))).toBeGreaterThan(100);
  expect(await refused(launch(dir, { HOME: scratch() }))).toContain("OVIS_STATE_DIR");
  expect(readdirSync(dir)).toEqual([]);
});

it("starts again where a killed profile left its socket", async () => {
  const dir = state();
  const first = launch(dir);
  await bounded(first.ready, 20_000);
  first.child.kill("SIGKILL");
  await bounded(first.exited, 15_000);
  expect(lstatSync(join(dir, "serve.sock")).isSocket()).toBe(true);
  const second = launch(dir);
  await bounded(second.ready, 20_000);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

it("leaves no socket and no lease when its port is taken", async () => {
  const dir = state();
  const squatter = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  cleanup.push(() => squatter.stop(true));
  await refused(launch(dir, { PORT: String(squatter.port), HOME: scratch() }));
  expect(existsSync(join(dir, "serve.sock"))).toBe(false);
  expect(existsSync(join(dir, "serve.lock"))).toBe(false);
});

it("keeps an ordinary server with the preview off a folder a profile marked, running or killed, and a profile off a folder an ordinary server uses", async () => {
  const dir = state();
  // a HOME of its own for each: Bun and the programs a server asks write into HOME
  const profile = launch(dir, { HOME: scratch() });
  await bounded(profile.ready, 20_000);
  const before = readdirSync(dir).sort();
  expect(await refused(launch(dir, { OVIS_PROFILE: "", HOME: scratch() }))).toContain(join(dir, "machine-profile.json"));
  expect(readdirSync(dir).sort()).toEqual(before);
  profile.child.kill("SIGKILL");
  await bounded(profile.exited, 15_000);
  // a killed profile holds nothing, but the folder it marked is still its own
  expect(await refused(launch(dir, { OVIS_PROFILE: "", HOME: scratch() }))).toContain(join(dir, "machine-profile.json"));
  const other = state();
  const ordinary = launch(other, { OVIS_PROFILE: "", HOME: scratch() });
  const base = await bounded(ordinary.ready, 20_000);
  await refused(launch(other, { HOME: scratch() }));
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("refuses an ordinary server without the preview on a folder a profile runs on, leaves the folder as it was, and the profile keeps answering", async () => {
  const dir = state();
  const profile = launch(dir);
  await bounded(profile.ready, 20_000);
  const before = contents(dir);
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  expect(await bounded(ordinary.ready.then(() => "started", () => ordinary.exited), 20_000)).toBe(1);
  expect(await refused(ordinary)).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
  expect((await owner(dir, "/api/health")).status).toBe(200);
});

it("refuses an ordinary server without the preview on a folder a stopped profile marked, and leaves it as it was", async () => {
  const dir = state();
  const profile = launch(dir);
  await bounded(profile.ready, 20_000);
  profile.child.kill("SIGTERM");
  expect(await bounded(profile.exited, 20_000)).toBe(0);
  const before = contents(dir);
  expect(before.map(([name]) => name)).toContain("machine-profile.json");
  const ordinary = launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined });
  expect(await bounded(ordinary.ready.then(() => "started", () => ordinary.exited), 20_000)).toBe(1);
  expect(await refused(ordinary)).toContain(join(dir, "machine-profile.json"));
  expect(contents(dir)).toEqual(before);
});

it("starts an ordinary server without the preview on a folder whose machine-profile.json is a FIFO, as main does", async () => {
  const dir = state();
  // opened for reading, a FIFO would wait for a writer that never comes
  expect(Bun.spawnSync(["mkfifo", join(dir, "machine-profile.json")]).exitCode).toBe(0);
  const base = await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined }).ready, 20_000);
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("starts an ordinary server without the preview beside a machine-profile.json that is not a profile's marker", async () => {
  const dir = state();
  writeFileSync(join(dir, "machine-profile.json"), '{"profile":"other"}', { mode: 0o600 });
  const base = await bounded(launch(dir, { OVIS_PROFILE: "", OVIS_PREVIEW: undefined }).ready, 20_000);
  expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
});

it("lets exactly one of a profile and an ordinary server started at the same moment on one folder run", async () => {
  const pairs = Array.from({ length: 5 }, () => {
    const dir = state();
    return [launch(dir, { HOME: scratch() }), launch(dir, { OVIS_PROFILE: "", HOME: scratch() })];
  });
  const outcomes = await Promise.all(pairs.map((started) => Promise.all(started.map((server) => bounded(server.ready.then(() => "ready", () => server.exited), 30_000)))));
  await Promise.all(pairs.flat().map((server) => { server.child.kill("SIGKILL"); return bounded(server.exited, 15_000); }));
  for (const outcome of outcomes) expect(outcome.filter((one) => one === "ready")).toHaveLength(1);
});

it("starts an ordinary server whose hold cannot be taken for another reason, and refuses a profile there", async () => {
  const dir = state();
  mkdirSync(join(dir, "serve.own"));
  const ordinary = launch(dir, { OVIS_PROFILE: "", HOME: scratch() });
  await bounded(ordinary.ready, 20_000);
  expect(ordinary.errors()).toContain(join(dir, "serve.own"));
  ordinary.child.kill("SIGTERM");
  await bounded(ordinary.exited, 20_000);
  marked(dir);
  expect(await refused(launch(dir, { HOME: scratch() }))).toContain("serve.own");
});

function refusingHerdr(socket: string, refusal: { code: string; message: string }, answers: Record<string, (params: Record<string, unknown>, before: number) => unknown> = {}) {
  let calls = 0;
  const asked = new Map<string, number>();
  const listener = Bun.listen<{ line: string }>({ unix: socket, socket: {
    open(client) { client.data = { line: "" }; },
    data(client, chunk) {
      client.data.line += chunk.toString();
      if (!client.data.line.includes("\n")) return;
      const { id, method, params } = JSON.parse(client.data.line) as { id: string; method: string; params: Record<string, unknown> };
      const before = asked.get(method) ?? 0;
      asked.set(method, before + 1);
      const result = method === "ping" ? { version: "fixture", protocol: 22 } : answers[method]?.(params, before);
      if (result === undefined && method !== "events.subscribe" && method !== "pane.process_info") calls++;
      client.write(`${JSON.stringify(result === undefined ? { id, error: refusal } : { id, result })}\n`);
      client.end();
    },
  } });
  cleanup.push(() => listener.stop(true));
  return { calls: () => calls };
}

const walkPane = (cwd: string, id: string, tab = "w1:t1") => ({ pane_id: id, workspace_id: "w1", tab_id: tab, terminal_id: `term-${id}`, focused: id === "w1:p1",
  agent_status: "unknown", revision: 0, cwd });
const reads = (cwd: string): Record<string, () => unknown> => ({
  "session.snapshot": () => ({ snapshot: { focused_pane_id: "w1:p1", workspaces: [{ workspace_id: "w1", label: "x", number: 1, focused: true, pane_count: 2, tab_count: 1,
    active_tab_id: "w1:t1", agent_status: "unknown" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }], panes: [walkPane(cwd, "w1:p1"), walkPane(cwd, "w1:p2")],
    layouts: [{ tab_id: "w1:t1", zoomed: false, panes: [] }] } }),
  "pane.get": () => ({ pane: walkPane(cwd, "w1:p1") }),
});

function shippedRoutes(): string[] {
  const paths = new Set<string>();
  for (const file of files("server/**/*.ts").filter((name) => !/\.test\.ts$|\.fake\.ts$/.test(name))) {
    for (const match of stripComments(read(file)).matchAll(/["'`](\/api\/[A-Za-z0-9_\-/]+)["'`]/g)) paths.add(match[1]!.replace(/\/$/, ""));
  }
  return [...paths].sort();
}
const NO_HERDR = /^\/api\/(?:account|relay|devices|push|alerts|auth|telemetry|preferences|seen|system|fonts|updates|voice|cliproxy|access|health|connection-diagnostics|info|event|herdr-ui|usage(?!\/login))(?:\/|$)/;
const ids = { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", target: "w1:p1", target_pane_id: "w1:p2", source: "recent", text: "x", keys: "Enter",
  name: "x", label: "x", agent_id: "x", plugin_id: "x", action_id: "x", branch: "x", query: "x", q: "x", ref: "x", id: "x", provider: "claude" };
const walkQuery = `?${new URLSearchParams({ ...ids, offset: "1", index: "0", start: "0", end: "1" }).toString()}`;
const walkBody = { ...ids, keys: ["Enter"], direction: "right", cols: 80, rows: 24, lines: 10, offset: 1, index: 0 };
const OWN: Record<string, Record<string, string>> = {
  "/api/sessions/history": { agent: "claude" }, "/api/pane/find": { direction: "forward" },
  "/api/pane/move": { side: "right" },
};
const NOT_WALKED = /^(?:(?:GET|POST|PUT) \/api\/(?:usage\/login|agent-catalog\/(?:install|sign-in)|fs\/favicon|workspace\/directories|agent\/commands)|PUT \/api\/fs\/text|POST \/api\/(?:layout\/ratio|pane\/image|pane\/prompt\/answer|pane\/scroll|pane\/swap|tab\/move|workspace\/move|workspace\/pr\/merge|worktree\/create|worktree\/open|tab\/create|workspace\/create|sessions\/resume)|(?:GET|POST|PUT) \/api\/pane\/(?:selection|conversation\/image)|GET \/api\/plugin\/action)(?:$|\?|\/)/;

async function walk(ask: (path: string, init: RequestInit) => Promise<Response>, calls: () => number) {
  const answers: { route: string; status: number; code: string | null; text: string; headers: string; reached: boolean }[] = [];
  for (const path of shippedRoutes().filter((route) => !NO_HERDR.test(route))) {
    for (const method of ["GET", "POST", "PUT"]) {
      const before = calls();
      const own = OWN[path] ?? {};
      const response = await ask(`${path}${walkQuery}&${new URLSearchParams(own).toString()}`, { method, headers: { ...headers, origin: "http://localhost", "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ ...walkBody, ...own }) }), signal: AbortSignal.timeout(10_000) });
      const text = await response.text();
      let code: string | null = null;
      try { code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? null; } catch {}
      answers.push({ route: `${method} ${path}`, status: response.status, code, text, headers: [...response.headers.entries()].join(";"), reached: calls() > before });
    }
  }
  return answers;
}
const answeredFirst = (answer: { status: number; code: string | null }) => answer.code === "machine_profile" || answer.code === "not_found" && answer.status === 404 || answer.code === "method_not_allowed" || answer.status === 405;

it.each(["refusing every call", "answering only its snapshot and panes", "not listening"])("answers every failed herdr call with its own words while herdr is %s", async (mode) => {
  const dir = state();
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  const marker = `herdr-own-${Math.random().toString(36).slice(2)}`;
  let calls = () => 0;
  if (mode !== "not listening") {
    mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
    calls = refusingHerdr(socket, { code: marker, message: `${marker} at ${socket}` }, mode === "refusing every call" ? {} : reads(scratch())).calls;
  }
  const server = launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" });
  await bounded(server.ready, 20_000);
  const answers = await walk((path, init) => owner(dir, path, init), calls);
  const shown = answers.filter((answer) => [marker, socket, dirname(socket), realpathSync(dir)].some((text) => answer.text.includes(text) || answer.headers.includes(text)));
  expect(shown.map((answer) => `${answer.route} ${answer.status} ${answer.text.slice(0, 160)}`)).toEqual([]);
  if (mode !== "not listening") {
    if (mode === "refusing every call") {
      expect(answers.filter((answer) => !answeredFirst(answer) && !answer.reached && !NOT_WALKED.test(answer.route)).map((answer) => `${answer.route} ${answer.status} ${answer.code}`)).toEqual([]);
    }
    // the profile's own answer to the stand-in's refusal, wherever a route answers with it, is never stored
    const worded = answers.filter((each) => each.code === "herdr_error");
    expect(worded.length).toBeGreaterThan(0);
    for (const answer of worded) expect([answer.route, answer.headers]).toEqual([answer.route, expect.stringContaining("no-store")]);
    const ordinary = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: undefined, HERDR_SOCKET: socket }).ready, 20_000);
    for (const answer of worded.filter((each) => each.route !== "GET /api/machines")) {
      const [method, path] = answer.route.split(" ") as [string, string];
      const own = OWN[path] ?? {};
      const response = await fetch(`${ordinary}${path}${walkQuery}&${new URLSearchParams(own).toString()}`, { method, headers: { ...headers, origin: ordinary, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({ ...walkBody, ...own }) }), signal: AbortSignal.timeout(10_000) });
      const body = await response.json() as { error?: unknown };
      expect([answer.route, response.status, body.error, response.headers.get("cache-control")]).toEqual([answer.route, answer.status, { code: marker, message: `${marker} at ${socket}` }, null]);
    }
  }
}, 240_000);

async function bothOn(socket: string) {
  const dir = state();
  await bounded(launch(dir, { XDG_CONFIG_HOME: dirname(dirname(dirname(dirname(socket)))), HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" }).ready, 20_000);
  const ordinary = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: undefined, HERDR_SOCKET: socket }).ready, 20_000);
  const post = async (on: "profile" | "ordinary", path: string, body: object) => {
    const init = { method: "POST", headers: { ...headers, origin: on === "profile" ? "http://localhost" : ordinary, "content-type": "application/json" }, body: JSON.stringify(body) };
    const response = on === "profile" ? await owner(dir, path, init) : await fetch(`${ordinary}${path}`, init);
    return { status: response.status, text: await response.text(), cache: response.headers.get("cache-control") };
  };
  return post;
}

it("answers a pane move herdr did not make with its own reason and words, and keeps a reason the app acts on", async () => {
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const marker = `herdr-own-${Math.random().toString(36).slice(2)}`;
  const cwd = scratch();
  let script: "plain" | "swap" | "stray" | "malformed" = "plain";
  let moves = 0;
  const pane = (id: string, tab?: string) => walkPane(cwd, id, tab);
  refusingHerdr(socket, { code: marker, message: `${marker} at ${socket}` }, {
    ...reads(cwd),
    "pane.move": () => {
      moves++;
      if (script === "plain") return { move_result: { changed: false, reason: marker, pane: pane("w1:p1") } };
      if (script === "swap") return { move_result: { changed: true, pane: pane("w1:p1"), source_layout: { focused_pane_id: "w1:p2" } } };
      if (moves === 1) return { move_result: { changed: false, reason: "same_tab", pane: pane("w1:p1") } };
      if (moves === 2) return { move_result: { changed: true, pane: pane("w1:p9", "w1:t9"), source_layout: { focused_pane_id: "w1:p2" } } };
      if (script === "malformed") return null;
      return { move_result: { changed: false, reason: `${marker}-reason`, pane: pane("w1:p9", "w1:t9") } };
    },
  });
  const post = await bothOn(socket);
  const asks = { plain: { side: "right" }, swap: { side: "left" }, stray: { side: "right" }, malformed: { side: "right" } } as const;
  let stranded = "";
  for (const each of ["plain", "swap", "stray", "malformed"] as const) {
    const body = { pane_id: "w1:p1", target_pane_id: "w1:p2", ...asks[each] };
    script = each; moves = 0;
    const theirs = await post("ordinary", "/api/pane/move", body);
    script = each; moves = 0;
    const mine = await post("profile", "/api/pane/move", body);
    expect([each, mine.text.includes(marker), mine.cache]).toEqual([each, false, "no-store"]);
    expect([each, theirs.text.includes(marker), theirs.cache]).toEqual([each, each !== "malformed", null]);
    if (each === "malformed") {
      expect([mine.status, mine.text]).toEqual([theirs.status, stranded]);
    } else if (each === "stray") {
      stranded = mine.text;
      const refused = await post("profile", "/api/pane/zoom", { pane_id: "w1:p1" });
      const sentence = (JSON.parse(refused.text) as { error: { message: string } }).error.message;
      const told = (JSON.parse(mine.text) as { error: { code: string; message: string } }).error;
      expect([mine.status, told.code, told.message === sentence, told.message.length > 0]).toEqual([theirs.status, "pane_not_moved", false, true]);
    } else {
      const [own, plain] = [JSON.parse(mine.text) as { reason: string }, JSON.parse(theirs.text) as { reason: string }];
      expect([mine.status, own]).toEqual([200, { ...plain, reason: "herdr_error" }]);
    }
  }
}, 60_000);

it("keeps a layout reason the app acts on, and answers any other reason herdr gave with its own code", async () => {
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const marker = `herdr-own-${Math.random().toString(36).slice(2)}`;
  let reason = "no_neighbor";
  const outcome = () => ({ changed: false, reason, focused_pane_id: "w1:p1", layout: { tab_id: "w1:t1", zoomed: false, panes: [] } });
  refusingHerdr(socket, { code: marker, message: marker }, { ...reads(scratch()), "pane.swap": () => ({ swap: { ...outcome(), target_pane_id: null } }),
    "pane.zoom": () => ({ zoom: { ...outcome(), zoomed: false } }), "pane.resize": () => ({ resize: outcome() }) });
  const post = await bothOn(socket);
  const routes = [["/api/pane/swap", { pane_id: "w1:p1", direction: "right" }], ["/api/pane/zoom", { pane_id: "w1:p1" }], ["/api/pane/resize", { pane_id: "w1:p1", direction: "right" }]] as const;
  for (const given of ["no_neighbor", marker]) {
    reason = given;
    for (const [path, body] of routes) {
      const [mine, theirs] = [await post("profile", path, body), await post("ordinary", path, body)];
      const kept = given === marker ? "herdr_error" : given;
      expect([path, mine.status, (JSON.parse(mine.text) as { reason: string }).reason, mine.cache]).toEqual([path, 200, kept, "no-store"]);
      expect([path, theirs.status, (JSON.parse(theirs.text) as { reason: string }).reason, theirs.cache]).toEqual([path, 200, given, null]);
    }
  }
}, 60_000);

it("answers a find herdr refused as stale with the code the app acts on, in its own words", async () => {
  const { ordinary, stateDir } = pair({ token, tailscaleOwner: null });
  const refused = { code: "stale_content", message: `herdr-own-${Math.random().toString(36).slice(2)}` };
  const find = spyOn(herdr, "paneFind").mockImplementation(async () => { throw new HerdrError(refused.code, refused.message, true, true); });
  cleanup.push(() => find.mockRestore());
  const body = JSON.stringify({ pane_id: "w1:p1", query: "x", direction: "forward" });
  const profile = await owner(stateDir, "/api/pane/find", { method: "POST", headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, body });
  const own = await fetch(`http://127.0.0.1:${ordinary}/api/pane/find`, { method: "POST", headers: { ...headers, origin: `http://127.0.0.1:${ordinary}`, "content-type": "application/json" }, body });
  const [mine, theirs] = [await profile.json(), await own.json()] as { error: { code: string; message: string } }[];
  expect([profile.status, mine!.error.code, mine!.error.message === refused.message, profile.headers.get("cache-control")]).toEqual([409, "stale_content", false, "no-store"]);
  expect([own.status, theirs!.error, own.headers.get("cache-control")]).toEqual([409, refused, null]);
});

it("answers a worktree inventory whose read herdr refused in its own words, never stored, and an ordinary server answers as main does", async () => {
  const { ordinary, stateDir } = pair({ token, tailscaleOwner: null });
  const refused = { code: `herdr-own-${Math.random().toString(36).slice(2)}`, message: "herdr's own words" };
  const list = spyOn(herdr, "worktreeList").mockImplementation(async () => { throw new HerdrError(refused.code, refused.message, true, true); });
  cleanup.push(() => list.mockRestore());
  const profile = await owner(stateDir, "/api/worktree/inventory?workspace_id=w1", { headers });
  const own = await fetch(`http://127.0.0.1:${ordinary}/api/worktree/inventory?workspace_id=w1`, { headers });
  const [mine, theirs] = [await profile.text(), await own.text()];
  expect([profile.status, mine.includes(refused.code), profile.headers.get("cache-control")]).toEqual([200, false, "no-store"]);
  expect([own.status, theirs.includes(refused.code), own.headers.get("cache-control")]).toEqual([200, true, null]);
});

it("answers a create whose agent herdr did not start in its own words, never stored, and an ordinary server answers as main does", async () => {
  const { ordinary, stateDir } = pair({ token, tailscaleOwner: null });
  const refused = { code: "agent_name_taken", message: `herdr-own-${Math.random().toString(36).slice(2)}` };
  const create = spyOn(herdr, "workspaceCreate").mockImplementation(async () => ({ tab: { workspace_id: "w1" }, root_pane: { pane_id: "w1:p1" } }) as never);
  const start = spyOn(herdr, "agentStart").mockImplementation(async () => { throw new HerdrError(refused.code, refused.message, true, true); });
  cleanup.push(() => create.mockRestore(), () => start.mockRestore());
  const body = JSON.stringify({ agent: { kind: "claude", name: "claude-create-test" } });
  const profile = await owner(stateDir, "/api/workspace/create", { method: "POST", headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, body });
  const own = await fetch(`http://127.0.0.1:${ordinary}/api/workspace/create`, { method: "POST", headers: { ...headers, origin: `http://127.0.0.1:${ordinary}`, "content-type": "application/json" }, body });
  const [mine, theirs] = [await profile.json(), await own.json()] as { agent_started: boolean; error: { code: string; message: string } }[];
  expect([profile.status, mine!.agent_started, mine!.error.message === refused.message, profile.headers.get("cache-control")]).toEqual([200, false, false, "no-store"]);
  expect([own.status, theirs!.error, own.headers.get("cache-control")]).toEqual([200, refused, null]);
});

it("words a failed herdr call on its own answers only, when a profile and an ordinary server run in one process", async () => {
  const { ordinary, stateDir } = pair({ token, tailscaleOwner: null });
  const ask = (target: "profile" | "ordinary") => target === "profile" ? owner(stateDir, "/api/pane/read?pane_id=w-none:p-none", { headers })
    : fetch(`http://127.0.0.1:${ordinary}/api/pane/read?pane_id=w-none:p-none`, { headers });
  const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => ask(index % 2 === 0 ? "profile" : "ordinary").then(async (response) => ({
    target: index % 2 === 0 ? "profile" : "ordinary", body: await response.text(), cache: response.headers.get("cache-control") }))));
  const of = (target: string) => answers.filter((answer) => answer.target === target);
  expect(new Set(of("profile").map((answer) => answer.body)).size).toBe(1);
  expect(new Set(of("ordinary").map((answer) => answer.body)).size).toBe(1);
  expect(of("profile")[0]!.body).not.toBe(of("ordinary")[0]!.body);
  expect([new Set(of("profile").map((answer) => answer.cache)), new Set(of("ordinary").map((answer) => answer.cache))]).toEqual([new Set(["no-store"]), new Set([null])]);
});

function nextError(socket: WebSocket): Promise<{ code: string; message: string }> {
  const frame = deferred<{ code: string; message: string }>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { type: string; code: string; message: string };
    if (message.type === "error") frame.resolve(message);
  });
  return bounded(frame.promise, 15_000);
}

it("words a failed herdr call in its WebSocket frames, and an ordinary server answers as main does", async () => {
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const refusal = { code: `herdr-own-${Math.random().toString(36).slice(2)}`, message: "herdr's own words" };
  refusingHerdr(socket, refusal);
  const dir = state();
  await bounded(launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" }).ready, 20_000);
  const ordinary = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: undefined, HERDR_SOCKET: socket }).ready, 20_000);
  const frames = async (url: string, init?: { headers: Record<string, string> }) => {
    const ws = new WebSocket(url, init as never);
    cleanup.push(() => ws.close());
    const opened = nextError(ws);
    const first = await opened;
    await bounded(new Promise<void>((resolve) => { if (ws.readyState === WebSocket.OPEN) resolve(); else ws.addEventListener("open", () => resolve(), { once: true }); }), 15_000);
    const attached = nextError(ws);
    ws.send(JSON.stringify({ type: "attach", pane_id: "w1:p1", cols: 80, rows: 24 }));
    return [first, await attached];
  };
  const mine = await frames(`ws+unix://${join(realpathSync(dir), "serve.sock")}:/ws`);
  const theirs = await frames(`${ordinary.replace(/^http/, "ws")}/ws`, { headers: { authorization: headers.authorization } });
  for (const frame of mine) expect([frame.code === refusal.code, frame.message === refusal.message]).toEqual([false, false]);
  expect(theirs.map((frame) => ({ code: frame.code, message: frame.message }))).toEqual([refusal, refusal]);
}, 60_000);

it("words a submit that failed for a fault of the bridge's own in its sentence, keeping the code, and an ordinary server answers as main does", async () => {
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  refusingHerdr(socket, { code: "refused", message: "refused" }, { ...reads(scratch()), "pane.process_info": () => null });
  const dir = state();
  await bounded(launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" }).ready, 20_000);
  const ordinary = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: undefined, HERDR_SOCKET: socket }).ready, 20_000);
  const submitted = async (url: string, init?: { headers: Record<string, string> }) => {
    const ws = new WebSocket(url, init as never);
    cleanup.push(() => ws.close());
    const frame = <T,>(match: (message: Record<string, unknown>) => boolean) => {
      const seen = deferred<T>();
      ws.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)) as Record<string, unknown>; if (match(message)) seen.resolve(message as T); });
      return bounded(seen.promise, 15_000);
    };
    await frame((message) => message.type === "snapshot");
    const result = frame<{ ok: boolean; code: string; message: string }>((message) => message.type === "submit-result" && message.id === 3);
    ws.send(JSON.stringify({ type: "submit", id: 3, pane_id: "w1:p1", text: "hello", payload: "hello", delivery: "immediate" }));
    return result;
  };
  const mine = await submitted(`ws+unix://${join(realpathSync(dir), "serve.sock")}:/ws`);
  const theirs = await submitted(`${ordinary.replace(/^http/, "ws")}/ws`, { headers: { authorization: headers.authorization } });
  const refused = await owner(dir, "/api/pane/zoom", { method: "POST", headers: { ...headers, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ pane_id: "w1:p1" }) });
  const sentence = ((await refused.json()) as { error: { message: string } }).error.message;
  expect([mine.ok, mine.code, mine.message]).toEqual([false, theirs.code, sentence]);
  expect([theirs.ok, theirs.message === sentence]).toEqual([false, false]);
}, 60_000);

it("tells a pane herdr could not restore in its own words, keeping the field, and an ordinary server answers as main does", async () => {
  const config = herdrConfig();
  const socket = join(config, "herdr", "sessions", "a", "herdr.sock");
  mkdirSync(dirname(socket), { recursive: true, mode: 0o700 });
  const marker = `herdr-own-${Math.random().toString(36).slice(2)}`;
  const cwd = scratch();
  const snapshot = (reads(cwd)["session.snapshot"]!() as { snapshot: { panes: object[] } }).snapshot;
  const restored = { ...snapshot, panes: [walkPane(cwd, "w1:p1"), { ...walkPane(cwd, "w1:p2"), restore_error: `${marker} could not restore` }] };
  refusingHerdr(socket, { code: "refused", message: "refused" }, { ...reads(cwd), "session.snapshot": () => ({ snapshot: restored }) });
  const dir = state();
  await bounded(launch(dir, { XDG_CONFIG_HOME: config, HERDR_REMOTE_SOCKET: "", HERDR_REMOTE_SESSION: "a" }).ready, 20_000);
  const ordinary = await bounded(launch(state(), { OVIS_PROFILE: "", OVIS_PREVIEW: undefined, HERDR_SOCKET: socket }).ready, 20_000);
  const frames = async (url: string, init?: { headers: Record<string, string> }) => {
    const ws = new WebSocket(url, init as never);
    cleanup.push(() => ws.close());
    const frame = <T,>(match: (message: Record<string, unknown>) => boolean) => {
      const seen = deferred<T>();
      ws.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)) as Record<string, unknown>; if (match(message)) seen.resolve(message as T); });
      return bounded(seen.promise, 15_000);
    };
    const opened = await frame<{ snapshot: unknown }>((message) => message.type === "snapshot");
    const failed = frame<{ code: string; message: string }>((message) => message.type === "error");
    ws.send(JSON.stringify({ type: "attach", pane_id: "w1:p2", cols: 80, rows: 24 }));
    return { snapshot: opened.snapshot, attach: await failed };
  };
  const restoreOf = (snapshot: unknown) => (snapshot as { panes: { pane_id: string; restore_error?: string | null }[] }).panes.find((pane) => pane.pane_id === "w1:p2")?.restore_error;
  const mine = await frames(`ws+unix://${join(realpathSync(dir), "serve.sock")}:/ws`);
  const asked = await owner(dir, "/api/session", { headers });
  const session = await asked.json() as { snapshot: unknown };
  const listed = await (await owner(dir, "/api/machines", { headers })).json() as { machines: { snapshot: unknown }[] };
  const theirs = await frames(`${ordinary.replace(/^http/, "ws")}/ws`, { headers: { authorization: headers.authorization } });
  const theirAnswer = await fetch(`${ordinary}/api/session`, { headers });
  const theirSession = await theirAnswer.json() as { snapshot: unknown };
  const told = [restoreOf(session.snapshot), restoreOf(listed.machines[0]!.snapshot), restoreOf(mine.snapshot), mine.attach.message];
  expect(told.map((text) => [typeof text === "string" && text.length > 0, text?.includes(marker)])).toEqual(told.map(() => [true, false]));
  expect([new Set(told).size, mine.attach.code, asked.headers.get("cache-control")]).toEqual([1, "pane_not_restored", "no-store"]);
  expect([restoreOf(theirSession.snapshot), restoreOf(theirs.snapshot), theirs.attach.code, theirs.attach.message, theirAnswer.headers.get("cache-control")])
    .toEqual([`${marker} could not restore`, `${marker} could not restore`, "pane_not_restored", `${marker} could not restore`, null]);
}, 60_000);
