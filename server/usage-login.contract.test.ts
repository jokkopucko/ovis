import { afterAll, beforeAll, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type { UsageLoginStarted } from "../shared/usage-login.ts";
import { createServer } from "./index.ts";
import { DEVICE_COOKIE } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { paneClose, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import * as herdr from "./herdr/client.ts";
import * as collector from "./collector.ts";
import { isJsonObject } from "./http.ts";
import { privateStateFs } from "./private-state.ts";
import { UsageLoginService } from "./usage-login.ts";
import { UsageService, USAGE_PROVIDERS, type UsageContext } from "./usage.ts";

const root = mkdtempSync(join(tmpdir(), "usage-login-'quoted-"));
const bin = join(root, "bin");
let workspaceId: string;
let server: ReturnType<typeof createServer>;
let usage: UsageService;
let usageLogin: UsageLoginService;
const openedPanes: string[] = [];
const missedExit = Promise.withResolvers<string>();
const ctx: UsageContext = {
  home: root, env: {}, platform: "linux", now: Date.now,
  fetch: async () => Response.json({ five_hour: { utilization: 20 }, plan_type: "plus", rate_limit: {} }),
  run: async () => null, has: () => true, keychain: async () => ({ status: "missing" }),
};
beforeAll(async () => {
  mkdirSync(bin);
  for (const provider of ["claude", "codex", "agent", "gh", "grok", "opencode"]) {
    writeFileSync(join(bin, provider), `#!${process.execPath}
import { renameSync } from "node:fs";
import { join } from "node:path";
const provider = ${JSON.stringify(provider)};
if (process.argv.includes("--help")) { console.log(provider === "claude" || process.env.TEST_LOGIN_NO_DEVICE ? "login" : "--device-auth"); process.exit(0); }
const variable = provider === "claude" ? "CLAUDE_CONFIG_DIR" : provider === "codex" ? "CODEX_HOME" : "HOME";
// the CLIs' default homes when no variable names another; a relative one is read from where the CLI runs
const home = process.env[variable] ?? join(process.env.HOME, provider === "codex" ? ".codex" : ".claude");
// a home named *-private is a sign-in the browser follows: the recorded screen, then a pasted code, as the real CLI asks
if (provider === "claude" && home.endsWith("-private")) {
  process.stdout.write(await Bun.file(${JSON.stringify(join(import.meta.dir, "fixtures/usage-login/claude.pty"))}).text());
  for await (const line of console) { await Bun.write(join(home, "pasted-code"), line); break; }
}
if (provider === "claude") {
  await Bun.write(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-local-token:" + home } }));
  // signing in again keeps the account the home already names
  if (!await Bun.file(join(home, ".claude.json")).exists()) await Bun.write(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "local-work", emailAddress: "work@example.test" } }));
} else if (provider === "codex") {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/profile": { email: "codex@example.test" } })).toString("base64url");
  await Bun.write(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "header." + claims + ".signature" } }));
}
// a held launch names its own receipt, so a test waits for that launch and no other
const receipt = process.env.TEST_LOGIN_RECEIPT ?? join(${JSON.stringify(root)}, provider + "-receipt.json");
await Bun.write(receipt + ".tmp", JSON.stringify({ argv: process.argv.slice(2), home,
  ...(["claude", "codex"].includes(provider) ? { configured: process.env[variable] ?? null } : {}),
  ...(provider === "agent" ? { noOpenBrowser: process.env.NO_OPEN_BROWSER } : {}),
  ...(["gh", "opencode"].includes(provider) ? { configHome: process.env[provider === "gh" ? "XDG_CONFIG_HOME" : "XDG_DATA_HOME"] } : {}) }));
renameSync(receipt + ".tmp", receipt);
console.log("Signed in to the isolated fixture.");
// a login still open in its tab: it ends when the tab closes
// (stdin, once read, would keep the process alive: exit with the sign-in)
if (process.env.TEST_LOGIN_HOLD) { await new Promise((resolve) => process.stdin.once("data", resolve)); process.exit(0); }
`, { mode: 0o755 });
  }
  workspaceId = (await workspaceCreate({ cwd: root, label: "usage-login-test" })).workspace.workspace_id;
  // Force the first login to finish before the collector's lifecycle connection starts.
  // The probe observes the real exit, but does not deliver it to the server; the replacement
  // subscribes only afterwards, just like a slow initial connection (or a reconnect gap).
  const subscribe = herdr.subscribeEvents;
  const startCollector = collector.startStatusCollector;
  const probeReady = Promise.withResolvers<void>();
  const delayed = spyOn(collector, "startStatusCollector").mockImplementation((handlers, overrides) => startCollector(handlers, {
    ...overrides,
    subscribe: (subscriptions, handlers, socketPath) => {
      if (!subscriptions.some((subscription) => subscription.type === "pane.exited")) {
        return subscribe(subscriptions, handlers, socketPath);
      }
      let live: ReturnType<typeof subscribe> | undefined;
      const probe = subscribe(subscriptions, {
        onStarted: () => probeReady.resolve(),
        onEvent: (frame) => {
          if (frame.data?.["type"] === "pane_exited" && typeof frame.data["pane_id"] === "string") {
            missedExit.resolve(frame.data["pane_id"]);
            probe.close();
            live = subscribe(subscriptions, handlers, socketPath);
          }
        },
        onError: handlers.onError,
      }, socketPath);
      return { close: () => { probe.close(); live?.close(); } };
    },
  }));
  try {
    server = createServer({
      port: 0, stateDir: mkdtempSync(join(root, "state-")), machines: false, registerBridge: false,
      sidecar: false, terminalAttach: false, usageLogin: usageLogin = new UsageLoginService(root, {
        ...process.env, PATH: bin, XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
      }, ctx),
      usage: usage = new UsageService(ctx, USAGE_PROVIDERS.filter((provider) => provider.id === "claude" || provider.id === "codex")),
    });
  } finally { delayed.mockRestore(); }
  await probeReady.promise;
});
afterAll(async () => {
  server?.stop();
  for (const pane of openedPanes) await paneClose(pane).catch(() => undefined);
  await workspaceClose(workspaceId);
  rmSync(root, { recursive: true, force: true });
});
const start = (body: unknown) => fetch(`http://127.0.0.1:${server.port}/api/usage/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

async function loginEvent<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("private login event did not arrive")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

for (const provider of ["claude", "codex"] as const) {
  it(`starts ${provider} in an isolated credential home when the account name is valid`, async () => {
    // Given: subscribe before starting; the fake publishes its receipt atomically after writing credentials.
    const receipt = `${provider}-receipt.json`;
    const signal = Promise.withResolvers<void>();
    const connected = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    const exits = new Set<string>();
    let opened: UsageLoginStarted | null = null;
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.onopen = () => connected.resolve();
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const frame: unknown = JSON.parse(event.data);
      if (isJsonObject(frame) && frame["type"] === "pane-exited" && typeof frame["pane_id"] === "string") {
        exits.add(frame["pane_id"]);
        if (frame["pane_id"] === opened?.pane_id) ended.resolve();
      }
    };
    const watcher = watch(root, (_event, filename) => { if (filename === receipt) signal.resolve(); });
    const timer = setTimeout(async () => {
      // Say which signal never came and what the pane showed, so a CI failure tells a CLI that
      // never started from one whose receipt or exit went unseen (#1260).
      const screen = opened
        ? await herdr.paneRead({ paneId: opened.pane_id, source: "visible", format: "text" }).then((read) => read.text.trimEnd(), (error: unknown) => `unreadable: ${String(error)}`)
        : "no pane was opened";
      const error = new Error(`login did not finish: receipt ${existsSync(join(root, receipt)) ? "written" : "missing"}, pane ${opened && exits.has(opened.pane_id) ? "exited" : "not exited"}; the pane shows:\n${screen}`);
      signal.reject(error); ended.reject(error); connected.reject(error);
      if (provider === "claude") missedExit.reject(error);
    }, 10_000);
    try {
      await connected.promise;
      // Cache the empty discovery too: completion must invalidate it, not wait five minutes.
      await fetch(`http://127.0.0.1:${server.port}/api/usage`);
      // When
      const response = await start({ provider, name: "work" });
      expect(response.status).toBe(200);
      opened = await response.json();
      if (!opened) throw new Error("login response missing");
      openedPanes.push(opened.pane_id);
      await signal.promise;
      if (provider === "claude") expect(await missedExit.promise).toBe(opened.pane_id);
      if (!exits.has(opened.pane_id)) await ended.promise;
      // Then: real herdr ran the quoted executable with exactly the official argv and isolated env.
      expect(opened.pane_id).toBeString();
      expect(JSON.parse(readFileSync(join(root, receipt), "utf8"))).toEqual({
        argv: provider === "claude" ? ["auth", "login"] : ["login", "--device-auth"],
        home: join(root, `.${provider}-work`), configured: join(root, `.${provider}-work`),
      });
      const usage: { providers: { account: string }[] } = await (await fetch(`http://127.0.0.1:${server.port}/api/usage`)).json();
      expect(usage.providers.map((entry) => entry.account)).toContain(provider === "claude" ? "work@example.test" : "codex@example.test");
    } finally { clearTimeout(timer); watcher.close(); socket.close(); }
  });
}

it("follows a sign-in in the server's own terminal: no herdr pane, on any device, ever holds its address", async () => {
  const response = await start({ provider: "claude", name: "private", follow: true });
  expect(response.status).toBe(200);
  const started = await response.json() as Record<string, unknown>;
  expect(started).not.toHaveProperty("pane_id");
  const login = started["login_id"] as string;
  // the browser that started it sends back the cookie it was given
  const signIn = { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]! };
  const prompt = async (): Promise<Record<string, unknown>> => await (await fetch(`http://127.0.0.1:${server.port}/api/usage/login/prompt?login=${login}`, { headers: signIn })).json() as Record<string, unknown>;
  let shown: Record<string, unknown>;
  for (;;) {
    const changed = usageLogin.changed(login);
    shown = await prompt();
    if (shown["wants_code"] === true) break;
    if (shown["ended"]) throw new Error("private login ended before asking for its code");
    await loginEvent(changed);
  }
  const state = /state=([\w-]+)/.exec(String(shown["url"]))?.[1];
  expect(state).toBeString();
  // every pane herdr has, read as any device's GET /api/pane/read would: none shows the sign-in's address
  const panes = (await herdr.sessionSnapshot()).panes;
  const screens = await Promise.all(panes.map((pane) => herdr.paneRead({ paneId: pane.pane_id, source: "recent_unwrapped", lines: 500 }).then((read) => read.text, () => "")));
  expect(screens.filter((text) => text.includes(state!))).toEqual([]);
  // the code goes to the CLI itself, which signs in and ends
  const sent = await fetch(`http://127.0.0.1:${server.port}/api/usage/login/code`, { method: "POST", headers: { "content-type": "application/json", ...signIn }, body: JSON.stringify({ login, code: "fixture-code#fixture-state" }) });
  expect(sent.status).toBe(204);
  await loginEvent(usageLogin.settled(login));
  expect((await prompt())["ended"]).toBe(true);
  expect(readFileSync(join(root, ".claude-private", "pasted-code"), "utf8")).toBe("fixture-code#fixture-state");
});

it("binds prompt, code and cancel to the paired device even after another driver reads the lock file", async () => {
  const stateDir = mkdtempSync(join(root, "owner-state-"));
  const devices = new DeviceStore(stateDir);
  const pair = (label: string, role: "drive" | "watch") => {
    const paired = devices.pair(devices.startPairing().code, label, role);
    if (!paired) throw new Error("fixture pairing failed");
    devices.match(paired.token);
    return `${DEVICE_COOKIE}=${paired.token}`;
  };
  const owner = pair("Owner", "drive");
  const other = pair("Other driver", "drive");
  const watcher = pair("Watcher", "watch");
  const service = new UsageLoginService(root, { PATH: bin }, ctx);
  const app = createServer({ port: 0, stateDir, token: "fixture-only", machines: false, registerBridge: false,
    sidecar: false, terminalAttach: false, usageLogin: service });
  const base = `http://127.0.0.1:${app.port}`;
  const headers = (cookie: string) => ({ cookie, origin: base, "content-type": "application/json" });
  const post = (path: string, cookie: string, body: unknown) => fetch(`${base}/api/usage/login${path}`, {
    method: "POST", headers: headers(cookie), body: JSON.stringify(body),
  });
  try {
    const response = await post("", owner, { provider: "claude", name: "owner-private", follow: true });
    expect(response.status).toBe(200);
    const { login_id: login } = await response.json() as { login_id: string };
    const ownerBrowser = `${owner}; ${(response.headers.get("set-cookie") ?? "").split(";")[0]}`;
    const file = await fetch(`${base}/api/fs/file?path=${encodeURIComponent(join(stateDir, "usage-logins.json"))}`, { headers: headers(other) });
    expect(file.status).toBe(200);
    const saved = await file.text();
    expect(saved).not.toContain(login);
    const record = JSON.parse(saved) as { logins: { launch: string }[] };
    const lock = record.logins[0]?.launch;
    expect(lock).toBeString();
    for (const id of [lock, login]) {
      const denied = await fetch(`${base}/api/usage/login/prompt?login=${id}`, { headers: headers(other) });
      expect(denied.status).toBe(404);
    }
    for (const endpoint of ["/code", "/cancel"]) {
      expect((await post(endpoint, other, { login, code: "never-typed" })).status).toBe(404);
      expect((await post(endpoint, watcher, { login, code: "never-typed" })).status).toBe(403);
    }
    expect((await fetch(`${base}/api/usage/login/prompt?login=${login}`, { headers: headers(watcher) })).status).toBe(403);
    expect((await fetch(`${base}/api/usage/login/prompt?login=${login}`, { headers: headers(ownerBrowser) })).status).toBe(200);
    expect((await post("/cancel", ownerBrowser, { login })).status).toBe(204);
  } finally {
    await service.stopAll();
    app.stop();
  }
});

it("lets no other browser signed in with the server's token reach a sign-in, even with its id", async () => {
  const stateDir = mkdtempSync(join(root, "token-state-"));
  const service = new UsageLoginService(root, { PATH: bin }, ctx);
  const app = createServer({ port: 0, stateDir, token: "fixture-only", machines: false, registerBridge: false,
    sidecar: false, terminalAttach: false, usageLogin: service });
  const base = `http://127.0.0.1:${app.port}`;
  // two browsers, each with the server's token: to the server they are the same owner
  const headers = (extra: Record<string, string> = {}) => ({ authorization: "Bearer fixture-only", origin: base, "content-type": "application/json", ...extra });
  try {
    const response = await fetch(`${base}/api/usage/login`, { method: "POST", headers: headers(), body: JSON.stringify({ provider: "claude", name: "token-private", follow: true }) });
    expect(response.status).toBe(200);
    const { login_id: login } = await response.json() as { login_id: string };
    const starter = { cookie: (response.headers.get("set-cookie") ?? "").split(";")[0]! };
    expect((await fetch(`${base}/api/usage/login/prompt?login=${login}`, { headers: headers() })).status).toBe(404);
    for (const endpoint of ["/code", "/cancel"]) {
      expect((await fetch(`${base}/api/usage/login${endpoint}`, { method: "POST", headers: headers(), body: JSON.stringify({ login, code: "never-typed" }) })).status).toBe(404);
    }
    expect((await fetch(`${base}/api/usage/login/prompt?login=${login}`, { headers: headers(starter) })).status).toBe(200);
    expect((await fetch(`${base}/api/usage/login/cancel`, { method: "POST", headers: headers(starter), body: JSON.stringify({ login }) })).status).toBe(204);
  } finally {
    await service.stopAll();
    app.stop();
  }
});

it("rejects shell syntax and traversal when an account name is not a short slug", async () => {
  // Given
  const before = readdirSync(root);
  // When
  const responses = await Promise.all(["../escape", "x;touch bad", "$(id)", "a'b", "UPPER", "", "a".repeat(33)].map((name) => start({ provider: "claude", name })));
  // Then
  expect(responses.map((response) => response.status)).toEqual(Array(7).fill(400));
  expect(readdirSync(root)).toEqual(before);
});

/** An account Claude or Codex signed in to whose sign-in has expired, in `dir` (relative to the fixture home). */
function expiredHome(provider: "claude" | "codex", dir: string, email: string): void {
  const past = Math.floor(Date.now() / 1000) - 3600;
  mkdirSync(join(root, dir), { recursive: true });
  if (provider === "claude") {
    writeFileSync(join(root, dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: `fixture-expired:${dir}`, expiresAt: past * 1000 } }));
    writeFileSync(join(root, dir === ".claude" ? ".claude.json" : join(dir, ".claude.json")), JSON.stringify({ oauthAccount: { accountUuid: `uuid-${email}`, emailAddress: email } }));
  } else {
    const claims = Buffer.from(JSON.stringify({ exp: past, "https://api.openai.com/profile": { email } })).toString("base64url");
    writeFileSync(join(root, dir, "auth.json"), JSON.stringify({ tokens: { access_token: `header.${claims}.signature` } }));
  }
}

/** `fixture`: a home was just written here, which a refresh within a minute would not look for */
const listed = async (fixture = false): Promise<{ key: string; account: string | null; problem: string | null }[]> => {
  if (fixture) usage.invalidate();
  return (await (await fetch(`http://127.0.0.1:${server.port}/api/usage`)).json()).providers;
};

for (const [provider, dir] of [["claude", ".claude-team"], ["claude", ".claude"], ["codex", ".codex-team"]] as const) {
  it(`signs in to an expired ${provider} account again in its own credential home ${dir}`, async () => {
    // Given: an expired sign-in this PC lists, found by the key the browser was shown
    const email = `again${dir}@example.test`;
    expiredHome(provider, dir, email);
    const expired = (await listed(true)).find((usage) => usage.account === email);
    expect(expired?.problem).toBe("expired");
    const before = readdirSync(root).filter((name) => name.startsWith(`.${provider}`)).sort();
    const receipt = `${provider}-receipt.json`;
    const written = Promise.withResolvers<void>();
    const connected = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<void>();
    let opened: UsageLoginStarted | null = null;
    const exits = new Set<string>();
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    socket.onopen = () => connected.resolve();
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const frame: unknown = JSON.parse(event.data);
      if (isJsonObject(frame) && frame["type"] === "pane-exited" && typeof frame["pane_id"] === "string") {
        exits.add(frame["pane_id"]);
        if (frame["pane_id"] === opened?.pane_id) ended.resolve();
      }
    };
    const watcher = watch(root, (_event, filename) => { if (filename === receipt) written.resolve(); });
    const timer = setTimeout(() => {
      const error = new Error(`sign-in again did not finish: receipt ${existsSync(join(root, receipt)) ? "written" : "missing"}`);
      written.reject(error); ended.reject(error); connected.reject(error);
    }, 10_000);
    // the tab's shell inherits another account's home, as one started from a profile that exports it
    const inherited = join(root, `.${provider}-inherited`);
    const realCreate = herdr.tabCreate;
    const create = spyOn(herdr, "tabCreate").mockImplementation((options: Parameters<typeof realCreate>[0]) =>
      realCreate({ ...options, env: { [provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: inherited, ...options.env } }));
    try {
      await connected.promise;
      // When
      const response = await start({ provider, account: expired!.key });
      expect(response.status).toBe(200);
      opened = await response.json();
      if (!opened) throw new Error("login response missing");
      openedPanes.push(opened.pane_id);
      await written.promise;
      if (!exits.has(opened.pane_id)) await ended.promise;
      // Then: the official login ran against that account's home (the default one with no variable
      // at all), the inherited home was left alone, and no new home was made
      expect(JSON.parse(readFileSync(join(root, receipt), "utf8"))).toEqual({
        argv: provider === "claude" ? ["auth", "login"] : ["login", "--device-auth"], home: join(root, dir),
        configured: dir === ".claude" ? null : join(root, dir),
      });
      expect(existsSync(inherited)).toBe(false);
      expect(readdirSync(root).filter((name) => name.startsWith(`.${provider}`)).sort()).toEqual(before);
      const after = await listed();
      if (provider === "claude") expect(after.find((usage) => usage.key === expired!.key)?.problem).toBeNull();
      else expect(after.some((usage) => usage.problem === "expired")).toBe(false);
    } finally { create.mockRestore(); clearTimeout(timer); watcher.close(); socket.close(); }
  });
}

it("signs in again to a Codex home named by a relative CODEX_HOME where this server found it", async () => {
  // Given: CODEX_HOME relative to this server's directory, holding an expired sign-in
  const dir = join(root, ".relative-codex");
  expiredHome("codex", ".relative-codex", "relative@example.test");
  const expired = readFileSync(join(dir, "auth.json"), "utf8");
  const relativeHome = relative(process.cwd(), dir);
  const relativeCtx = { ...ctx, env: { CODEX_HOME: relativeHome } };
  const listedHere = await new UsageService(relativeCtx, USAGE_PROVIDERS.filter((provider) => provider.id === "codex")).report();
  const key = listedHere.providers.find((usage) => usage.account === "relative@example.test")!.key;
  const local = new UsageLoginService(root, { ...process.env, PATH: bin }, relativeCtx);
  const written = Promise.withResolvers<void>();
  const watcher = watch(root, (_event, filename) => { if (filename === "codex-receipt.json") written.resolve(); });
  const timer = setTimeout(() => written.reject(new Error("sign-in again did not write its receipt")), 10_000);
  try {
    // When
    const response = await local.handle(new Request("http://localhost/api/usage/login", {
      method: "POST", body: JSON.stringify({ provider: "codex", account: key }),
    }));
    // Then: the CLI ran where the path means that same home, and replaced its sign-in
    expect(response.status).toBe(200);
    const opened: UsageLoginStarted = await response.json();
    openedPanes.push(opened.pane_id);
    await written.promise;
    expect(JSON.parse(readFileSync(join(root, "codex-receipt.json"), "utf8"))).toMatchObject({ home: relativeHome, configured: relativeHome });
    expect(readFileSync(join(dir, "auth.json"), "utf8")).not.toBe(expired);
  } finally { clearTimeout(timer); watcher.close(); }
});

for (const [provider, variable] of [["codex", "CODEX_HOME"], ["claude", "CLAUDE_CONFIG_DIR"]] as const) {
  it(`signs in again in a ${variable} directory literally named default, not in the default home`, async () => {
    // Given: this server runs where ./default is the configured home, holding an expired sign-in
    const cwd = mkdtempSync(join(root, "named-default-"));
    const email = `named-default-${provider}@example.test`;
    expiredHome(provider, join(relative(root, cwd), "default"), email);
    const credentials = join(cwd, "default", provider === "claude" ? ".credentials.json" : "auth.json");
    const expired = readFileSync(credentials, "utf8");
    const previous = process.cwd();
    process.chdir(cwd);
    const written = Promise.withResolvers<void>();
    const watcher = watch(root, (_event, filename) => { if (filename === `${provider}-receipt.json`) written.resolve(); });
    const timer = setTimeout(() => written.reject(new Error("sign-in again did not write its receipt")), 10_000);
    try {
      const homeCtx = { ...ctx, home: cwd, env: { [variable]: "default" } };
      const shown = await new UsageService(homeCtx, USAGE_PROVIDERS.filter((usage) => usage.id === provider)).report();
      const key = shown.providers.find((usage) => usage.account === email)!.key;
      const local = new UsageLoginService(cwd, { ...process.env, PATH: bin }, homeCtx);
      // When
      const response = await local.handle(new Request("http://localhost/api/usage/login", {
        method: "POST", body: JSON.stringify({ provider, account: key }),
      }));
      // Then: the CLI was told that directory, and replaced the sign-in there; the default home was not made
      expect(response.status).toBe(200);
      openedPanes.push((await response.json() as UsageLoginStarted).pane_id);
      await written.promise;
      expect(JSON.parse(readFileSync(join(root, `${provider}-receipt.json`), "utf8"))).toMatchObject({ home: "default", configured: "default" });
      expect(readFileSync(credentials, "utf8")).not.toBe(expired);
      expect(existsSync(join(cwd, provider === "claude" ? ".claude" : ".codex"))).toBe(false);
    } finally { process.chdir(previous); clearTimeout(timer); watcher.close(); }
  });
}

/** Tabs whose fake CLI stays open, as a sign-in the user has not finished; restore when done. */
/** Resolves once `path` exists; rejects after 10 s naming `what`. */
async function fileWritten(path: string, what: string): Promise<void> {
  const seen = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), (_event, filename) => { if (filename === basename(path) && existsSync(path)) seen.resolve(); });
  const timer = setTimeout(() => seen.reject(new Error(`${what} did not write its receipt`)), 10_000);
  try {
    if (existsSync(path)) seen.resolve();
    await seen.promise;
  } finally { clearTimeout(timer); watcher.close(); }
}

let heldLaunches = 0;
/**
 * Tabs whose fake CLI stays open, as a sign-in the user has not finished, each with a receipt of its
 * own: `launched(n)` waits for the n-th tab's CLI to have written its sign-in; `open` opens one such tab,
 * for a test that makes one call of `create` wait. Restore `create` when done.
 */
function holdLogins() {
  const realCreate = herdr.tabCreate;
  const receipts: string[] = [];
  const open = (options: Parameters<typeof realCreate>[0]) => {
    const receipt = join(root, `held-${++heldLaunches}.json`);
    receipts.push(receipt);
    return realCreate({ ...options, env: { ...options.env, TEST_LOGIN_HOLD: "1", TEST_LOGIN_RECEIPT: receipt } });
  };
  const create = spyOn(herdr, "tabCreate").mockImplementation(open);
  return { create, open, launched: (n: number) => fileWritten(receipts[n]!, `held sign-in ${n}`) };
}

const statusAndCode = async (response: Response) => [response.status, response.status === 200 ? null : (await response.json()).error.code];

/** Finishes a held sign-in as its user would, and resolves once the server says its pane (and so its CLI) ended. */
async function finishLogin(paneId: string): Promise<void> {
  const ended = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  socket.onopen = () => connected.resolve();
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") return;
    const frame: unknown = JSON.parse(event.data);
    if (isJsonObject(frame) && frame["type"] === "pane-exited" && frame["pane_id"] === paneId) ended.resolve();
  };
  const timer = setTimeout(async () => {
    // say what the tab showed, so a CLI that never read the Enter is told from an exit that went unheard
    const screen = await herdr.paneRead({ paneId, source: "visible", format: "text" }).then((read) => read.text.trimEnd(), (error: unknown) => `unreadable: ${String(error)}`);
    const error = new Error(`sign-in in ${paneId} did not end; the pane shows:\n${screen}`);
    ended.reject(error); connected.reject(error);
  }, 10_000);
  try {
    await connected.promise;
    await herdr.paneSendKeys(paneId, ["Enter"]);
    await ended.promise;
  } finally { clearTimeout(timer); socket.close(); }
}

it("starts one sign-in again when two arrive at once for an account, also once its tab moved, and another once it ended", async () => {
  // Given: an expired account this PC lists, and logins that stay open
  expiredHome("claude", ".claude-race", "race@example.test");
  const key = (await listed(true)).find((usage) => usage.account === "race@example.test")!.key;
  const { create, launched } = holdLogins();
  const elsewhere = (await workspaceCreate({ cwd: root, label: "usage-login-moved" })).workspace.workspace_id;
  try {
    // When: two requests for it race
    const raced = await Promise.all([start({ provider: "claude", account: key }), start({ provider: "claude", account: key })]);
    // Then: one tab signs in, the other is told it is already open
    const results = await Promise.all(raced.map(statusAndCode));
    expect(results.map(([status]) => status).sort()).toEqual([200, 409]);
    expect(results.find(([status]) => status === 409)?.[1]).toBe("login_in_progress");
    const pane = (await raced.find((response) => response.status === 200)!.json() as UsageLoginStarted).pane_id;
    openedPanes.push(pane);
    expect(await statusAndCode(await start({ provider: "claude", account: key }))).toEqual([409, "login_in_progress"]);
    // When its tab moves to another workspace, the same sign-in runs on under a new pane ID
    const moved = (await herdr.paneMoveToNewTab(pane, elsewhere, null)).pane.pane_id;
    openedPanes.push(moved);
    expect(moved).not.toBe(pane);
    expect(await statusAndCode(await start({ provider: "claude", account: key }))).toEqual([409, "login_in_progress"]);
    // When it ends, the home is free again
    await finishLogin(moved);
    const again = await start({ provider: "claude", account: key });
    expect(again.status).toBe(200);
    openedPanes.push((await again.json() as UsageLoginStarted).pane_id);
    expect(create).toHaveBeenCalledTimes(2);
    // its CLI has run before the next test reads the homes
    await launched(1);
  } finally { create.mockRestore(); await workspaceClose(elsewhere).catch(() => undefined); }
});

/**
 * Finishes a held sign-in and resolves once herdr says its pane ended, heard on a subscription of the
 * test's own: the shared server hears no exit before the file's first (see beforeAll), and a server
 * started in the test may subscribe after it.
 */
async function finishLoginInHerdr(paneId: string): Promise<void> {
  const started = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const subscription = herdr.subscribeEvents([{ type: "pane.exited" }], {
    onStarted: () => started.resolve(),
    onEvent: (frame) => { if (frame.data?.["type"] === "pane_exited" && frame.data["pane_id"] === paneId) ended.resolve(); },
    onError: (error) => { started.reject(error); ended.reject(error); },
  });
  const timer = setTimeout(() => {
    const error = new Error(`herdr did not say the sign-in in ${paneId} ended`);
    started.reject(error); ended.reject(error);
  }, 10_000);
  try {
    await started.promise;
    await herdr.paneSendKeys(paneId, ["Enter"]);
    await ended.promise;
  } finally { clearTimeout(timer); subscription.close(); }
}

/** A server on `stateDir` signing in from the fixture home, as one started again after a restart would be. */
function serveOn(stateDir: string) {
  return createServer({
    port: 0, stateDir, machines: false, registerBridge: false, sidecar: false, terminalAttach: false,
    usageLogin: new UsageLoginService(root, { ...process.env, PATH: bin }, ctx),
    usage: new UsageService(ctx, USAGE_PROVIDERS.filter((provider) => provider.id === "claude" || provider.id === "codex")),
  });
}
const startOn = (instance: { readonly port: number }, body: unknown) => fetch(`http://127.0.0.1:${instance.port}/api/usage/login`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

it("keeps a home taken across a server restart while its sign-in still runs in its tab, and frees it once that ended", async () => {
  // Given: a sign-in again still open in its tab, started by a server that has stopped since
  expiredHome("claude", ".claude-restart", "restart@example.test");
  const key = (await listed(true)).find((usage) => usage.account === "restart@example.test")!.key;
  const stateDir = mkdtempSync(join(root, "restart-state-"));
  const { create, launched } = holdLogins();
  const before = serveOn(stateDir);
  // a server beside it on the same state, started before that sign-in was, so it learns of it from the file only then
  const beside = serveOn(stateDir);
  let after: ReturnType<typeof createServer> | undefined;
  try {
    const first = await startOn(before, { provider: "claude", account: key });
    expect(first.status).toBe(200);
    const pane = (await first.json() as UsageLoginStarted).pane_id;
    openedPanes.push(pane);
    await launched(0);
    expect(await statusAndCode(await startOn(beside, { provider: "claude", account: key }))).toEqual([409, "login_in_progress"]);
    beside.stop();
    before.stop();
    // When: the server starts again on its state, and the same account is asked for
    after = serveOn(stateDir);
    const again = await startOn(after, { provider: "claude", account: key });
    // Then: no second CLI signs in to that home while the first runs
    expect(await statusAndCode(again)).toEqual([409, "login_in_progress"]);
    expect(create).toHaveBeenCalledTimes(1);
    // once that sign-in ends, the home is free again: the restarted server asks herdr, not its own events
    await finishLoginInHerdr(pane);
    const later = await startOn(after, { provider: "claude", account: key });
    expect(later.status).toBe(200);
    openedPanes.push((await later.json() as UsageLoginStarted).pane_id);
    await launched(1);
  } finally { before.stop(); beside.stop(); after?.stop(); create.mockRestore(); }
});

it("starts one sign-in when two servers on one state dir are asked for one home at once", async () => {
  // Given: two servers on one state dir, and the first one's sign-in still opening its tab
  expiredHome("claude", ".claude-two-servers", "two-servers@example.test");
  const key = (await listed(true)).find((usage) => usage.account === "two-servers@example.test")!.key;
  const stateDir = mkdtempSync(join(root, "two-servers-state-"));
  const { create, open, launched } = holdLogins();
  const opening = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  create.mockImplementationOnce(async (options) => { opening.resolve(); await gate.promise; return open(options); });
  const first = serveOn(stateDir);
  const second = serveOn(stateDir);
  let answer: Promise<Response> | undefined;
  try {
    answer = startOn(first, { provider: "claude", account: key });
    await opening.promise;
    // When: the other server is asked for that home meanwhile
    const other = await startOn(second, { provider: "claude", account: key });
    // Then: it refuses, and the first one's sign-in opens
    expect(await statusAndCode(other)).toEqual([409, "login_in_progress"]);
    gate.resolve();
    const started = await answer;
    expect(started.status).toBe(200);
    openedPanes.push((await started.json() as UsageLoginStarted).pane_id);
    expect(create).toHaveBeenCalledTimes(1);
    await launched(0);
  } finally {
    // a check that failed early leaves the held launch to finish here, its tab closed with the others
    gate.resolve();
    const late = await answer?.catch(() => undefined);
    if (late?.ok && !late.bodyUsed) openedPanes.push((await late.json() as UsageLoginStarted).pane_id);
    first.stop(); second.stop(); create.mockRestore();
  }
});

for (const damage of ["corrupt", "unreadable"] as const) {
  // root reads any file, and Windows has no mode that refuses its owner
  it.skipIf(damage === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0))(`refuses a sign-in while the state file of running sign-ins is ${damage}, rather than reading it as empty`, async () => {
    // Given: a state file that may name a sign-in still running, which does not parse or may not be read
    const stateDir = mkdtempSync(join(root, `${damage}-state-`));
    const saved = join(stateDir, "usage-logins.json");
    writeFileSync(saved, damage === "corrupt" ? "{broken" : JSON.stringify({ logins: [] }));
    if (damage === "unreadable") chmodSync(saved, 0);
    const local = new UsageLoginService(root, { ...process.env, PATH: bin }, ctx);
    local.persistTo(stateDir);
    const { create } = holdLogins();
    try {
      // When
      const response = await local.handle(new Request("http://localhost/api/usage/login", { method: "POST", body: JSON.stringify({ provider: "claude", name: `${damage}-state` }) }));
      const body = await response.json();
      if (response.status === 200) openedPanes.push((body as UsageLoginStarted).pane_id);
      // Then: no login starts, and no credential home is left for a retry to trip on
      expect([response.status, body.error?.code ?? null]).toEqual([409, "login_state_unreadable"]);
      expect(create).not.toHaveBeenCalled();
      expect(existsSync(join(root, `.claude-${damage}-state`))).toBe(false);
    } finally { create.mockRestore(); chmodSync(saved, 0o600); }
  });
}

for (const failure of ["refused", "not synced"] as const) {
// Windows syncs no directory, so a rename there is not checked that way
it.skipIf(failure === "not synced" && process.platform === "win32")(`closes the tab and sends no login when the record of that tab as the home's holder is ${failure}`, async () => {
  // Given: the launch is recorded, but the next write, the one naming its tab, is refused (ENOSPC) or
  // lands without its directory synced (EIO), so a crash could undo it
  const stateDir = mkdtempSync(join(root, "unrecorded-state-"));
  const local = new UsageLoginService(root, { ...process.env, PATH: bin }, ctx);
  local.persistTo(stateDir);
  let renames = 0;
  let directorySyncs = 0;
  const realRename = privateStateFs.renameSync;
  const realSync = privateStateFs.fsyncSync;
  const rename = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    if (failure === "refused" && ++renames === 2) throw Object.assign(new Error("fixture: no space left on device"), { code: "ENOSPC" });
    realRename(from, to);
  });
  const sync = spyOn(privateStateFs, "fsyncSync").mockImplementation((fd) => {
    if (failure === "not synced" && fstatSync(fd).isDirectory() && ++directorySyncs === 2) throw Object.assign(new Error("fixture: i/o error"), { code: "EIO" });
    realSync(fd);
  });
  const sent = spyOn(herdr, "paneSendText");
  const { create } = holdLogins();
  const name = failure === "refused" ? "unrecorded" : "unsynced";
  try {
    // When
    const response = await local.handle(new Request("http://localhost/api/usage/login", { method: "POST", body: JSON.stringify({ provider: "claude", name }) }));
    const opened = (await (create.mock.results[0]!.value as ReturnType<typeof herdr.tabCreate>)).root_pane.pane_id;
    openedPanes.push(opened);
    // Then: no login runs in that tab, which is closed, and the home is free again for this or another server
    expect(response.status).toBe(500);
    expect(sent.mock.calls.filter(([pane]) => pane === opened)).toEqual([]);
    expect(await herdr.paneGet(opened).then(() => "open", () => "closed")).toBe("closed");
    expect(JSON.parse(readFileSync(join(stateDir, "usage-logins.json"), "utf8"))).toEqual({ logins: [] });
    expect(existsSync(join(root, `.claude-${name}`))).toBe(false);
  } finally { rename.mockRestore(); sync.mockRestore(); sent.mockRestore(); create.mockRestore(); }
});
}

it("refuses once, without looking again and again, when a crashed launch's entry cannot be replaced, and signs in once it can", async () => {
  // Given: a launch that never opened its tab, long ago, and a disk that refuses the file's next writes
  const stateDir = mkdtempSync(join(root, "full-disk-state-"));
  writeFileSync(join(stateDir, "usage-logins.json"), JSON.stringify({ logins: [
    { home: `claude:${join(realpathSync(root), ".claude-full-disk")}`, launch: "crashed", pid: process.pid, at: 0 },
  ] }));
  const local = new UsageLoginService(root, { ...process.env, PATH: bin }, ctx);
  local.persistTo(stateDir);
  let writes = 0;
  const realRename = privateStateFs.renameSync;
  const rename = spyOn(privateStateFs, "renameSync").mockImplementation((from, to) => {
    // a server that tried again for each refused write would never get past them; give up after 20
    if (++writes <= 20) throw Object.assign(new Error("fixture: no space left on device"), { code: "ENOSPC" });
    realRename(from, to);
  });
  const { create, launched } = holdLogins();
  const post = () => local.handle(new Request("http://localhost/api/usage/login", { method: "POST", body: JSON.stringify({ provider: "claude", name: "full-disk" }) }));
  try {
    // When
    const refused = await post();
    // Then: a sign-in no other server could see is not started, after one try to take that launch's place
    expect(refused.status).toBe(500);
    expect(writes).toBe(1);
    expect(create).not.toHaveBeenCalled();
    // once the file can be written, the crashed launch holds nothing
    rename.mockRestore();
    const started = await post();
    expect(started.status).toBe(200);
    openedPanes.push((await started.json() as UsageLoginStarted).pane_id);
    await launched(0);
  } finally { rename.mockRestore(); create.mockRestore(); }
});

it("frees a home after a restart when its sign-in ended while no server ran, even when its pane ID now names another tab", async () => {
  // Given: a sign-in started by a server that stopped, whose tab then closed while none ran
  // Claude's stand-in keeps the account its home names, so the key still lists it once it has run
  expiredHome("claude", ".claude-restart-gone", "restart-gone@example.test");
  const key = (await listed(true)).find((usage) => usage.account === "restart-gone@example.test")!.key;
  const stateDir = mkdtempSync(join(root, "restart-gone-state-"));
  // a plain tab, not one of the held sign-ins counted below
  const plainTab = herdr.tabCreate;
  const { create, launched } = holdLogins();
  const before = serveOn(stateDir);
  let after: ReturnType<typeof createServer> | undefined;
  try {
    const first = await startOn(before, { provider: "claude", account: key });
    expect(first.status).toBe(200);
    await launched(0);
    before.stop();
    await paneClose((await first.json() as UsageLoginStarted).pane_id);
    // a herdr started again hands the same pane IDs out again: here the saved one names another live tab
    const other = (await plainTab({ cwd: root, label: "usage-login-other", workspaceId })).root_pane.pane_id;
    openedPanes.push(other);
    const saved = join(stateDir, "usage-logins.json");
    const state: { logins: { pane: string }[] } = JSON.parse(readFileSync(saved, "utf8"));
    expect(state.logins).toHaveLength(1);
    writeFileSync(saved, JSON.stringify({ ...state, logins: state.logins.map((login) => ({ ...login, pane: other })) }));
    // When: the server starts again and the account is asked for
    after = serveOn(stateDir);
    const again = await startOn(after, { provider: "claude", account: key });
    // Then: nothing holds the home any more
    expect(again.status).toBe(200);
    openedPanes.push((await again.json() as UsageLoginStarted).pane_id);
    await launched(1);
  } finally { before.stop(); after?.stop(); create.mockRestore(); }
});

for (const alias of [false, true]) {
  it(`refuses Sign in again while Add account's sign-in into that home is still open${alias ? ", reached through a symlinked CODEX_HOME" : ""}`, async () => {
    // Given: Add account's login has written its sign-in and is still open in its tab
    const home = mkdtempSync(join(root, "one-login-"));
    // through an alias, Sign in again names the home by another path than Add account made it at
    const homeCtx = { ...ctx, home, env: alias ? { CODEX_HOME: join(home, "alias") } : {} };
    const local = new UsageLoginService(home, { ...process.env, PATH: bin }, homeCtx);
    const post = (body: unknown) => local.handle(new Request("http://localhost/api/usage/login", { method: "POST", body: JSON.stringify(body) }));
    const { create, launched } = holdLogins();
    try {
      const added = await post({ provider: "codex", name: "new" });
      expect(added.status).toBe(200);
      const pane = (await added.json() as UsageLoginStarted).pane_id;
      openedPanes.push(pane);
      await launched(0);
      if (alias) symlinkSync(join(home, ".codex-new"), join(home, "alias"));
      const key = (await new UsageService(homeCtx, USAGE_PROVIDERS.filter((usage) => usage.id === "codex")).report()).providers[0]!.key;
      // When
      const again = await post({ provider: "codex", account: key });
      // Then: no second CLI writes that home; once Add account's sign-in has ended, it may
      expect(await statusAndCode(again)).toEqual([409, "login_in_progress"]);
      await finishLogin(pane);
      const later = await post({ provider: "codex", account: key });
      expect(later.status).toBe(200);
      openedPanes.push((await later.json() as UsageLoginStarted).pane_id);
      expect(create).toHaveBeenCalledTimes(2);
      // the retry's CLI has run before the next test starts
      await launched(1);
    } finally { create.mockRestore(); }
  });
}

it("refuses to sign in again to one account signed in in two credential homes, rather than guess which", async () => {
  // Given: the same account (one id, the list's one row) in two homes, each with its own expired sign-in
  expiredHome("claude", ".claude-dup-a", "dup@example.test");
  expiredHome("claude", ".claude-dup-b", "dup@example.test");
  const rows = (await listed(true)).filter((usage) => usage.account === "dup@example.test");
  expect(rows.length).toBe(1);
  const realCreate = herdr.tabCreate;
  const create = spyOn(herdr, "tabCreate").mockImplementation(async (options: Parameters<typeof realCreate>[0]) => {
    const created = await realCreate(options);
    openedPanes.push(created.root_pane.pane_id);
    return created;
  });
  try {
    // When
    const response = await start({ provider: "claude", account: rows[0]!.key });
    // Then: no tab, and the user is told why
    expect(await statusAndCode(response)).toEqual([409, "account_ambiguous"]);
    expect(create).not.toHaveBeenCalled();
  } finally { create.mockRestore(); }
});

it("refuses a sign-in when it cannot tell which credential home it would write", async () => {
  // Given: Add account's login is open in ~/.codex-new, and Sign in again names that home through a
  // symlinked CODEX_HOME whose real path cannot be read
  const home = mkdtempSync(join(root, "unreadable-"));
  const homeCtx = { ...ctx, home, env: { CODEX_HOME: join(home, "alias") } };
  const local = new UsageLoginService(home, { ...process.env, PATH: bin }, homeCtx);
  const post = (body: unknown) => local.handle(new Request("http://localhost/api/usage/login", { method: "POST", body: JSON.stringify(body) }));
  const { create, launched } = holdLogins();
  try {
    const added = await post({ provider: "codex", name: "new" });
    expect(added.status).toBe(200);
    openedPanes.push((await added.json() as UsageLoginStarted).pane_id);
    await launched(0);
    symlinkSync(join(home, ".codex-new"), join(home, "alias"));
    const key = (await new UsageService(homeCtx, USAGE_PROVIDERS.filter((usage) => usage.id === "codex")).report()).providers[0]!.key;
    const refuse = (): never => { throw Object.assign(new Error("fixture: permission denied"), { code: "EACCES" }); };
    const denied = spyOn(fs, "realpathSync").mockImplementation(Object.assign(refuse, { native: refuse }));
    let again: Response;
    let another: Response;
    try {
      // When
      again = await post({ provider: "codex", account: key });
      another = await post({ provider: "codex", name: "other" });
    } finally { denied.mockRestore(); }
    // Then: neither starts a CLI on a home it cannot name, and Add account makes no home
    expect(await statusAndCode(again)).toEqual([409, "credential_home_unreadable"]);
    expect(await statusAndCode(another)).toEqual([409, "credential_home_unreadable"]);
    expect(existsSync(join(home, ".codex-other"))).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  } finally { create.mockRestore(); }
});

it("frees the home when the login command could not be sent to its new tab", async () => {
  // Given: an expired account, and a tab that opens but will not take the command once
  expiredHome("codex", ".codex-unsent", "unsent@example.test");
  const key = (await listed(true)).find((usage) => usage.account === "unsent@example.test")!.key;
  const send = spyOn(herdr, "paneSendText").mockRejectedValueOnce(new Error("fixture send failed"));
  const realCreate = herdr.tabCreate;
  // the tab left without its command is closed with the others
  const create = spyOn(herdr, "tabCreate").mockImplementation(async (options: Parameters<typeof realCreate>[0]) => {
    const created = await realCreate(options);
    openedPanes.push(created.root_pane.pane_id);
    return created;
  });
  let failed: Response;
  try {
    // When
    failed = await start({ provider: "codex", account: key });
  } finally { send.mockRestore(); create.mockRestore(); }
  // Then: that request fails, and the next is not told a sign-in is open
  expect(failed.status).toBe(500);
  const { create: held, launched } = holdLogins();
  try {
    const retried = await start({ provider: "codex", account: key });
    expect(retried.status).toBe(200);
    openedPanes.push((await retried.json() as UsageLoginStarted).pane_id);
    // its CLI has run before the next test reads the root
    await launched(0);
  } finally { held.mockRestore(); }
});

it("refuses to sign in again to an account this PC does not list, without opening a tab", async () => {
  // Given: one listed expired account, and keys that are not one of this PC's accounts
  expiredHome("claude", ".claude-refuse", "refuse@example.test");
  expiredHome("claude", ".claude-swap", "before@example.test");
  const shown = await listed(true);
  const key = shown.find((usage) => usage.account === "refuse@example.test")!.key;
  const stale = shown.find((usage) => usage.account === "before@example.test")!.key;
  // that home holds another account since the list was read; the server's list is not read again
  expiredHome("claude", ".claude-swap", "after@example.test");
  const before = readdirSync(root).sort();
  const create = spyOn(herdr, "tabCreate");
  const workspace = spyOn(herdr, "workspaceCreate");
  try {
    // When
    const unknown = await Promise.all([
      { provider: "claude", account: "claude:nobody" },
      { provider: "codex", account: "codex:cliproxy:hub-account" },
      { provider: "claude", account: ".claude-refuse" },
      { provider: "claude", account: join(root, ".claude-refuse") },
      { provider: "claude", account: "../../etc" },
      { provider: "claude", account: "claude@../../etc" },
      { provider: "codex", account: key },
      { provider: "claude", account: stale },
    ].map(start));
    const malformed = await Promise.all([
      { provider: "claude", account: 5 },
      { provider: "claude", account: null },
      { provider: "claude", account: "x".repeat(257) },
      { provider: "claude", account: key, name: "refuse" },
      { provider: "opencode", account: key, replace: true },
      { provider: "opencode", account: "opencode@0123456789ab" },
      { provider: "cursor", account: "cursor:c1" },
      { provider: "antigravity", account: "antigravity@keychain" },
    ].map(start));
    // Then
    expect(unknown.map((response) => response.status)).toEqual(unknown.map(() => 404));
    expect(await Promise.all(unknown.map(async (response) => (await response.json()).error.code))).toEqual(unknown.map(() => "account_not_found"));
    expect(malformed.map((response) => response.status)).toEqual(malformed.map(() => 400));
    expect(create).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
    expect(readdirSync(root).sort()).toEqual(before);
  } finally { create.mockRestore(); workspace.mockRestore(); }
});

it("rejects an existing credential home when its name is reused", async () => {
  // Given
  mkdirSync(join(root, ".claude-existing"));
  // When
  const response = await start({ provider: "claude", name: "existing" });
  // Then
  expect(response.status).toBe(409);
});

for (const provider of ["claude", "codex"] as const) {
  it(`allows retrying ${provider} with the same name when creating the sign-in tab fails`, async () => {
    // Given: the official CLI is a fake and the credential home is disposable.
    const home = mkdtempSync(join(root, "retry-"));
    const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home });
    const request = () => new Request("http://localhost/api/usage/login", {
      method: "POST", body: JSON.stringify({ provider, name: "retry" }),
    });
    const create = spyOn(herdr, "tabCreate").mockRejectedValueOnce(new Error("fixture tab creation failed"));
    let failed: Response;
    try {
      // When
      failed = await local.handle(request());
    } finally { create.mockRestore(); }
    // Then: the failed launch does not reserve the name.
    expect(failed.status).toBe(500);
    expect(existsSync(join(home, `.${provider}-retry`))).toBe(false);
    const retried = await local.handle(request());
    expect(retried.status).toBe(200);
    const opened: UsageLoginStarted = await retried.json();
    openedPanes.push(opened.pane_id);
  });
}

it("preserves credentials written before a sign-in launch fails", async () => {
  // Given
  const home = mkdtempSync(join(root, "preserve-"));
  const credentials = join(home, ".claude-preserve", ".credentials.json");
  const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home });
  const create = spyOn(herdr, "tabCreate").mockImplementationOnce(async () => {
    writeFileSync(credentials, "fixture-existing-credentials");
    throw new Error("fixture tab creation failed after credentials were written");
  });
  try {
    // When
    const response = await local.handle(new Request("http://localhost/api/usage/login", {
      method: "POST", body: JSON.stringify({ provider: "claude", name: "preserve" }),
    }));
    // Then: cleanup must not delete a nonempty home or replace the launch error.
    expect(response.status).toBe(500);
    expect(readFileSync(credentials, "utf8")).toBe("fixture-existing-credentials");
  } finally { create.mockRestore(); }
});

for (const [provider, cli, argv] of [
  ["cursor", "agent", ["login"]],
  ["copilot", "gh", ["auth", "login", "--hostname", "github.com"]],
  ["grok", "grok", ["login", "--device-auth"]],
  ["opencode", "opencode", ["auth", "login"]],
] as const) {
  it(`starts ${provider} with official argv and the discovery home when no named homes are supported`, async () => {
    // Given: watch before the native tab runs the disposable CLI.
    const receipt = `${cli}-receipt.json`;
    const signal = Promise.withResolvers<void>();
    const watcher = watch(root, (_event, filename) => { if (filename === receipt) signal.resolve(); });
    const timer = setTimeout(() => signal.reject(new Error("login did not produce a receipt")), 10_000);
    try {
      // When
      const response = await start({ provider });
      expect(response.status).toBe(200);
      const opened: UsageLoginStarted = await response.json();
      openedPanes.push(opened.pane_id);
      await signal.promise;
      // Then
      expect(opened.device_auth).toBe(provider === "grok");
      expect(JSON.parse(readFileSync(join(root, receipt), "utf8"))).toEqual({
        argv, home: root,
        ...(provider === "cursor" ? { noOpenBrowser: "1" } : {}),
        ...(provider === "copilot" ? { configHome: join(root, "xdg-config") } : provider === "opencode" ? { configHome: join(root, "xdg-data") } : {}),
      });
      expect(readdirSync(root).some((name) => name.startsWith(`.${provider}-`))).toBe(false);
    } finally { clearTimeout(timer); watcher.close(); }
  });
}

it("lists every provider in discovery order without requesting upstream usage", async () => {
  // Given
  const local = new UsageLoginService(root, { PATH: bin }, { ...ctx, fetch: async () => { throw new Error("upstream usage requested"); } });
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login"));
  const result = await response.json();
  // Then
  expect(result.providers.map((provider: { id: string }) => provider.id)).toEqual(["claude", "codex", "cursor", "copilot", "grok", "antigravity", "opencode"]);
  expect(result.providers.filter((provider: { separate_home: boolean }) => provider.separate_home).map((provider: { id: string }) => provider.id)).toEqual(["claude", "codex"]);
});

it("reports an unavailable CLI instead of opening a dead sign-in tab", async () => {
  // Given
  const local = new UsageLoginService(root, { PATH: "" }, ctx);
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login", {
    method: "POST", body: JSON.stringify({ provider: "cursor" }),
  }));
  // Then
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("cli_unavailable");
});

it("omits device auth when the installed Grok help does not list it", async () => {
  // Given
  const local = new UsageLoginService(root, { PATH: bin, TEST_LOGIN_NO_DEVICE: "1" }, ctx);
  const signal = Promise.withResolvers<void>();
  const watcher = watch(root, (_event, filename) => { if (filename === "grok-receipt.json") signal.resolve(); });
  const timer = setTimeout(() => signal.reject(new Error("login receipt missing")), 10000);
  try {
    // When
    const response = await local.handle(new Request("http://localhost/api/usage/login", {
      method: "POST", body: JSON.stringify({ provider: "grok" }),
    }));
    // Then
    expect(response.status).toBe(200);
    const opened: UsageLoginStarted = await response.json();
    openedPanes.push(opened.pane_id);
    await signal.promise;
    expect(opened.device_auth).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "grok-receipt.json"), "utf8")).argv).toEqual(["login"]);
  } finally { clearTimeout(timer); watcher.close(); }
});

it("rejects unknown providers and names for single-home providers before launching a tab", async () => {
  // Given
  const bodies = [{ provider: "unknown" }, { provider: "constructor" }, { provider: "grok;id" },
    ...["cursor", "copilot", "grok", "opencode"].flatMap((provider) => ["work", "../escape", "$(id)"].map((name) => ({ provider, name })))];
  // When
  const responses = await Promise.all(bodies.map(start));
  // Then
  expect(responses.map((response) => response.status)).toEqual(bodies.map(() => 400));
});

it("requires explicit replacement when a single-home sign-in exists", async () => {
  // Given
  const home = mkdtempSync(join(root, "existing-"));
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fixture-go" } }));
  const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home });
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login", {
    method: "POST", body: JSON.stringify({ provider: "opencode" }),
  }));
  // Then
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("account_confirmation_required");
});

it("lists an existing sign-in without returning its key or fetching provider usage", async () => {
  // Given
  const home = mkdtempSync(join(root, "metadata-"));
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fixture-secret-metadata" } }));
  const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home, fetch: async () => { throw new Error("upstream usage requested"); } });
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login?provider=opencode"));
  // Then
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accounts: [null] });
});

it("opens the sign-in tab when replacement was explicitly confirmed", async () => {
  // Given
  const home = mkdtempSync(join(root, "confirmed-"));
  const dir = join(home, ".local", "share", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "fixture-go" } }));
  const local = new UsageLoginService(home, { PATH: bin }, { ...ctx, home });
  // When
  const response = await local.handle(new Request("http://localhost/api/usage/login", {
    method: "POST", body: JSON.stringify({ provider: "opencode", replace: true }),
  }));
  // Then
  expect(response.status).toBe(200);
  const opened: UsageLoginStarted = await response.json();
  openedPanes.push(opened.pane_id);
});

it("rejects Antigravity login when no standalone command is supported", async () => {
  // Given / When
  const response = await start({ provider: "antigravity" });
  // Then
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe("login_not_supported");
});
