import { afterEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageLoginFollowed, UsageLoginPrompt } from "../shared/usage-login.ts";
import type { UsageReport } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { DEVICE_COOKIE } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { UsageLoginService } from "./usage-login.ts";
import { UsageService, USAGE_PROVIDERS, type UsageContext } from "./usage.ts";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ovis-account-list-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
import { join } from "node:path";
if (process.argv.includes("--help")) { console.log("login"); process.exit(0); }
const home = process.env.CLAUDE_CONFIG_DIR;
process.stdout.write(await Bun.file(${JSON.stringify(join(import.meta.dir, "fixtures/usage-login/claude.pty"))}).text());
for await (const code of console) {
  if (code === "fail") process.exit(1);
  await Bun.write(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-renewed", expiresAt: 9999999999999, subscriptionType: "max" } }));
  if (!await Bun.file(join(home, ".claude.json")).exists()) await Bun.write(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "added", emailAddress: "added@example.test" } }));
  process.exit(0);
}
`, { mode: 0o755 });
  for (const name of ["work", "home", "expired"]) {
    const dir = join(root, `.claude-${name}`);
    mkdirSync(dir);
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: name, emailAddress: `${name}@example.test` } }));
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
      accessToken: `fixture-${name}`, expiresAt: name === "expired" ? 1 : 9_999_999_999_999, subscriptionType: "max",
    } }));
  }
  const ctx: UsageContext = {
    home: root, env: {}, platform: "linux", now: () => 1_000,
    fetch: async () => Response.json({ five_hour: { utilization: 20 } }),
    keychain: async () => ({ status: "missing" }), run: async () => null, has: () => false,
  };
  const start = (token = "") => {
    const login = new UsageLoginService(root, { PATH: bin }, ctx);
    const server = createServer({
      port: 0, hostname: "127.0.0.1", token, stateDir: join(root, "state"),
      machines: false, registerBridge: false, sidecar: false, terminalAttach: false,
      herdrConfigPath: join(root, "herdr.toml"),
      usage: new UsageService(ctx, USAGE_PROVIDERS.filter((provider) => provider.id === "claude")),
      usageLogin: login,
    });
    servers.push(server);
    return { server, login, origin: `http://127.0.0.1:${server.port}` };
  };
  return { root, start };
}

it("removes only the selected account across a server restart without changing CLI credentials", async () => {
  const { root, start } = fixture();
  const credentials = ["work", "home", "expired"].map((name) => join(root, `.claude-${name}`, ".credentials.json"));
  const before = credentials.map((path) => readFileSync(path, "utf8"));
  const first = start();
  const removed = await fetch(`${first.origin}/api/usage/accounts`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "claude:expired" }),
  });
  expect(removed.status).toBe(204);
  first.server.stop();
  servers.splice(servers.indexOf(first.server), 1);
  const second = start();
  const report = await (await fetch(`${second.origin}/api/usage`)).json();
  expect(report.providers.map((entry: { key: string }) => entry.key).sort()).toEqual(["claude:home", "claude:work"]);
  expect(credentials.map((path) => readFileSync(path, "utf8"))).toEqual(before);
});

async function completeLogin(host: ReturnType<ReturnType<typeof fixture>["start"]>, body: object, code: string) {
  const started = await fetch(`${host.origin}/api/usage/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, follow: true }),
  });
  expect(started.status).toBe(200);
  const { login_id: id }: UsageLoginFollowed = await started.json();
  const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? "";
  const prompt = async (): Promise<UsageLoginPrompt> => (await fetch(`${host.origin}/api/usage/login/prompt?login=${id}`, { headers: { cookie } })).json();
  for (;;) {
    const changed = host.login.changed(id);
    const current = await prompt();
    if (current.wants_code) break;
    if (current.ended) throw new Error("The fixture exited before accepting a code");
    await changed;
  }
  const ended = host.login.settled(id);
  const response = await fetch(`${host.origin}/api/usage/login/code`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ login: id, code }),
  });
  expect(response.status).toBe(204);
  await ended;
  return prompt();
}

it("re-authenticates the expired account in its own home and reports it signed in", async () => {
  const { root, start } = fixture();
  const host = start();
  const other = readFileSync(join(root, ".claude-work", ".credentials.json"), "utf8");
  const result = await completeLogin(host, { provider: "claude", account: "claude:expired" }, "success");
  expect(result.succeeded).toBe(true);
  const report: UsageReport = await (await fetch(`${host.origin}/api/usage`)).json();
  expect(report.providers.find((account) => account.key === "claude:expired")?.problem).toBeNull();
  expect(readFileSync(join(root, ".claude-work", ".credentials.json"), "utf8")).toBe(other);
});

it("adds a signed-in account after the new home's login completes", async () => {
  const host = fixture().start();
  await completeLogin(host, { provider: "claude", name: "added" }, "success");
  const report: UsageReport = await (await fetch(`${host.origin}/api/usage`)).json();
  expect(report.providers.find((account) => account.key === "claude:added")).toMatchObject({ account: "added@example.test", problem: null });
});

it("does not report a failed re-login as successful just because other accounts exist", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:expired" }, "fail");
  expect(result.succeeded).toBe(false);
});

it("restores only the removed account whose explicit sign-in succeeds", async () => {
  const host = fixture().start();
  for (const account of ["claude:expired", "claude:work"]) {
    expect((await fetch(`${host.origin}/api/usage/accounts`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ account }),
    })).status).toBe(204);
  }
  await completeLogin(host, { provider: "claude", account: "claude:expired" }, "success");
  const report: UsageReport = await (await fetch(`${host.origin}/api/usage`)).json();
  expect(report.providers.map((account) => account.key).sort()).toEqual(["claude:expired", "claude:home"]);
});

it("keeps the selected account order after restarting the server", async () => {
  const { start } = fixture();
  const first = start();
  const order = ["claude:work", "claude:expired", "claude:home"];
  const saved = await fetch(`${first.origin}/api/preferences`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ settings: { usageOrder: order } }),
  });
  expect(saved.status).toBe(200);
  first.server.stop();
  servers.splice(servers.indexOf(first.server), 1);
  const second = start();
  expect((await (await fetch(`${second.origin}/api/preferences`)).json()).settings.usageOrder).toEqual(order);
});

it("refuses account removal from a watching device", async () => {
  const { root, start } = fixture();
  const devices = new DeviceStore(join(root, "state"));
  const paired = devices.pair(devices.startPairing().code, "Watcher", "watch");
  if (!paired) throw new Error("The fixture could not pair its watcher");
  devices.match(paired.token);
  const host = start("fixture-owner");
  const response = await fetch(`${host.origin}/api/usage/accounts`, {
    method: "DELETE", headers: { "content-type": "application/json", cookie: `${DEVICE_COOKIE}=${paired.token}` },
    body: JSON.stringify({ account: "claude:expired" }),
  });
  expect(response.status).toBe(403);
});

const keys = (report: UsageReport | { providers?: readonly { key: string }[] } | undefined) => (report?.providers ?? []).map((entry) => entry.key).sort();

it("lists a removed account under removed, and POST lists it again", async () => {
  const host = fixture().start();
  const account = (method: string) => fetch(`${host.origin}/api/usage/accounts`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "claude:work" }),
  });
  expect((await account("DELETE")).status).toBe(204);
  const hidden: UsageReport = await (await fetch(`${host.origin}/api/usage`)).json();
  expect(keys(hidden)).toEqual(["claude:expired", "claude:home"]);
  expect(hidden.removed?.map((entry) => entry.key)).toEqual(["claude:work"]);
  expect((await account("POST")).status).toBe(204);
  const restored: UsageReport = await (await fetch(`${host.origin}/api/usage`)).json();
  expect(keys(restored)).toEqual(["claude:expired", "claude:home", "claude:work"]);
  expect(restored.removed).toBeUndefined();
});

it("sets a damaged removed-accounts list aside instead of failing the usage report", async () => {
  const { root, start } = fixture();
  const state = join(root, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "usage-removed.json"), "{not json");
  const host = start();
  const response = await fetch(`${host.origin}/api/usage`);
  expect(response.status).toBe(200);
  expect(keys(await response.json())).toEqual(["claude:expired", "claude:home", "claude:work"]);
  expect(readdirSync(state).filter((name) => name.startsWith("usage-removed.json.corrupt-"))).toHaveLength(1);
  expect((await fetch(`${host.origin}/api/usage/accounts`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "claude:work" }),
  })).status).toBe(204);
  expect(keys(await (await fetch(`${host.origin}/api/usage`)).json())).toEqual(["claude:expired", "claude:home"]);
});
