import { afterEach, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageLoginFollowed, UsageLoginPrompt } from "../shared/usage-login.ts";
import type { UsageReport } from "../shared/protocol.ts";
import { createServer } from "./index.ts";
import { PtySession } from "./pty/session.ts";
import { UsageLoginService } from "./usage-login.ts";
import { homeSignIn, UsageService, USAGE_PROVIDERS, type UsageContext } from "./usage.ts";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface FixtureOptions {
  readonly platform?: NodeJS.Platform;
  readonly keychain?: UsageContext["keychain"];
  readonly timing?: { readonly leaseMs: number; readonly maxMs: number };
  readonly env?: Record<string, string>;
}

function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "ovis-login-outcome-"));
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
  if (code === "noop") process.exit(0);
  await Bun.write(join(home, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: \`fixture-\${crypto.randomUUID()}\`, expiresAt: code === "write-expired" ? 1 : 9999999999999, subscriptionType: "max" } }));
  if (code === "write-fail") process.exit(1);
  // a signal ends it after it wrote a sign-in
  if (code === "write-kill") process.kill(process.pid, "SIGKILL");
  if (!await Bun.file(join(home, ".claude.json")).exists()) await Bun.write(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "added", emailAddress: "added@example.test" } }));
  // another home signed in meanwhile (another terminal): not this login's account
  if (code === "also-elsewhere") {
    await Bun.write(join(process.env.HOME, ".claude-unrelated", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-unrelated", expiresAt: 9999999999999 } }));
    await Bun.write(join(process.env.HOME, ".claude-unrelated", ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "unrelated", emailAddress: "unrelated@example.test" } }));
  }
  process.exit(0);
}
`, { mode: 0o755 });
  // signs in at once to what codex-plan.json names: "own" is the home Codex writes (CODEX_HOME, else ~/.codex)
  writeFileSync(join(bin, "codex"), `#!${process.execPath}
import { join } from "node:path";
if (process.argv.includes("--help")) { console.log("--device-auth"); process.exit(0); }
process.stdout.write(await Bun.file(${JSON.stringify(join(import.meta.dir, "fixtures/usage-login/codex-device.pty"))}).text());
const plan = await Bun.file(join(process.env.HOME, "codex-plan.json")).json();
for (const { dir, email } of plan.write) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = [part({ alg: "none" }), part({ exp: 9999999999, nonce: crypto.randomUUID(), "https://api.openai.com/profile": { email }, "https://api.openai.com/auth": { chatgpt_account_user_id: email } }), "sig"].join(".");
  await Bun.write(join(dir === "own" ? process.env.CODEX_HOME ?? join(process.env.HOME, ".codex") : dir, "auth.json"), JSON.stringify({ tokens: { access_token: token } }));
}
const { rmSync } = await import("node:fs");
for (const dir of plan.remove ?? []) rmSync(join(dir === "own" ? process.env.CODEX_HOME ?? join(process.env.HOME, ".codex") : dir, "auth.json"), { force: true });
// what the test's keychain reads to tell the CLI ran
if (plan.ran) await Bun.write(join(process.env.HOME, "codex-ran"), "");
process.exit(plan.exit);
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
    home: root, env: options.env ?? {}, platform: options.platform ?? "linux", now: () => 1_000,
    fetch: async () => Response.json({ five_hour: { utilization: 20 } }),
    keychain: options.keychain ?? (async () => ({ status: "missing" })), run: async () => null, has: () => false,
  };
  const start = () => {
    const login = new UsageLoginService(root, { PATH: bin }, ctx, options.timing);
    const server = createServer({
      port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"),
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

/** A Codex sign-in runs to its end without a code: the fake signs in as codex-plan.json says. */
async function completeCodexLogin(host: ReturnType<ReturnType<typeof fixture>["start"]>, body: object) {
  const started = await fetch(`${host.origin}/api/usage/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, provider: "codex", follow: true }),
  });
  expect(started.status).toBe(200);
  const { login_id: id }: UsageLoginFollowed = await started.json();
  const cookie = started.headers.get("set-cookie")?.split(";")[0] ?? "";
  await host.login.settled(id);
  const prompt: UsageLoginPrompt = await (await fetch(`${host.origin}/api/usage/login/prompt?login=${id}`, { headers: { cookie } })).json();
  expect(prompt.ended).toBe(true);
  return prompt;
}

const codexAuth = (email: string) => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return JSON.stringify({ tokens: { access_token: [part({ alg: "none" }), part({ exp: 9_999_999_999, "https://api.openai.com/profile": { email }, "https://api.openai.com/auth": { chatgpt_account_user_id: email } }), "sig"].join(".") } });
};

/** Starts a followed Claude sign-in and waits until its CLI asks for the code. */
async function untilCode(host: ReturnType<ReturnType<typeof fixture>["start"]>, body: object) {
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
  const post = (path: string, extra: object = {}) => fetch(`${host.origin}/api/usage/login/${path}`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ login: id, ...extra }),
  });
  return { id, prompt, post };
}

async function completeLogin(host: ReturnType<ReturnType<typeof fixture>["start"]>, body: object, code: string, beforeCode?: () => void) {
  const login = await untilCode(host, body);
  beforeCode?.();
  const ended = host.login.settled(login.id);
  expect((await login.post("code", { code })).status).toBe(204);
  await ended;
  return login.prompt();
}

/**
 * A keychain whose reads wait, once armed, until released: a sign-in's read of its home after its CLI
 * exited stays pending while the test acts. Before arming it holds nothing.
 */
function heldKeychain() {
  let armed = false;
  const asked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const keychain: UsageContext["keychain"] = async () => {
    if (!armed) return { status: "missing" };
    asked.resolve();
    await release.promise;
    return { status: "missing" };
  };
  return { keychain, arm: () => { armed = true; }, asked: asked.promise, release: () => release.resolve() };
}

/** Resolves when a sign-in's PTY is next told to stop (a cancel, a lease or a deadline). */
function nextKill() {
  const killed = Promise.withResolvers<void>();
  const original = PtySession.prototype.kill;
  const spy = spyOn(PtySession.prototype, "kill").mockImplementation(function (this: PtySession) {
    killed.resolve();
    return original.call(this);
  });
  return { killed: killed.promise, restore: () => spy.mockRestore() };
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

it("does not report a failed re-login as successful just because other accounts exist", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:expired" }, "fail");
  expect(result.succeeded).toBe(false);
});

it("does not count an exit 0 that left the home's earlier sign-in as it was", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "noop");
  expect(result.succeeded).toBe(false);
});

it("does not count a CLI a signal ended, even after it wrote a new sign-in", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "write-kill");
  expect(result.succeeded).toBe(false);
});

it("does not count a CLI that wrote a new sign-in and then exited with an error", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "write-fail");
  expect(result.succeeded).toBe(false);
});

it("does not count a new sign-in that has already expired", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "write-expired");
  expect(result.succeeded).toBe(false);
});

it("does not count a sign-in cancelled while its home is read after the CLI exited", async () => {
  const held = heldKeychain();
  const host = fixture({ platform: "darwin", keychain: held.keychain }).start();
  const login = await untilCode(host, { provider: "claude", account: "claude:work" });
  held.arm();
  const ended = host.login.settled(login.id);
  expect((await login.post("code", { code: "success" })).status).toBe(204);
  await held.asked;
  const kill = nextKill();
  try {
    const cancelled = login.post("cancel");
    await kill.killed;
    held.release();
    expect((await cancelled).status).toBe(204);
  } finally { kill.restore(); }
  await ended;
  expect((await login.prompt()).succeeded).toBe(false);
});

it("does not count a sign-in whose deadline passed while its home is read after the CLI exited", async () => {
  const held = heldKeychain();
  const host = fixture({ platform: "darwin", keychain: held.keychain, timing: { leaseMs: 30_000, maxMs: 3_000 } }).start();
  const login = await untilCode(host, { provider: "claude", account: "claude:work" });
  held.arm();
  const ended = host.login.settled(login.id);
  const kill = nextKill();
  try {
    expect((await login.post("code", { code: "success" })).status).toBe(204);
    await held.asked;
    await kill.killed;
    held.release();
  } finally { kill.restore(); }
  await ended;
  expect((await login.prompt()).succeeded).toBe(false);
}, 15_000);

it("does not count a home whose earlier sign-in could not be read as newly signed in", async () => {
  let locked = true;
  const old = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-work", expiresAt: 9_999_999_999_999, subscriptionType: "max" } });
  const { root, start } = fixture({
    platform: "darwin",
    keychain: async (service) => service.startsWith("Claude Code-credentials-") && locked ? { status: "locked" } : service.startsWith("Claude Code-credentials-") ? { status: "found", value: old } : { status: "missing" },
  });
  // the sign-in lives in the keychain alone, as Claude Code keeps it on a Mac
  rmSync(join(root, ".claude-work", ".credentials.json"));
  const host = start();
  // the keychain is locked until the CLI runs, then gives the same old sign-in
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "noop", () => { locked = false; });
  expect(result.succeeded).toBe(false);
});

/** A Claude keychain that answers `before` until the CLI runs, then the same other old sign-in: nothing changed. */
function keychainThen(before: Awaited<ReturnType<UsageContext["keychain"]>>) {
  let ran = false;
  const other = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-work-keychain", expiresAt: 9_999_999_999_999, subscriptionType: "max" } });
  const keychain: UsageContext["keychain"] = async (service) => !service.startsWith("Claude Code-credentials-") ? { status: "missing" }
    : ran ? { status: "found", value: other } : before;
  return { keychain, ran: () => { ran = true; } };
}

it("does not count a home whose keychain was locked before, though its credential file read", async () => {
  const held = keychainThen({ status: "locked" });
  const host = fixture({ platform: "darwin", keychain: held.keychain }).start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "noop", held.ran);
  expect(result.succeeded).toBe(false);
});

it("does not count a token another of the home's keychain queries already held", async () => {
  let ran = false;
  const item = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: 9_999_999_999_999, subscriptionType: "max" } });
  let work = "";
  // the work home's item under $USER holds A and its unnamed one B; the CLI's run leaves only B, unchanged
  const keychain: UsageContext["keychain"] = async (service, account) => service !== work ? { status: "missing" }
    : account === "fixture-user" ? (ran ? { status: "missing" } : { status: "found", value: item("fixture-keychain-a") })
    : { status: "found", value: item("fixture-keychain-b") };
  const made = fixture({ platform: "darwin", keychain, env: { USER: "fixture-user" } });
  work = `Claude Code-credentials-${createHash("sha256").update(join(made.root, ".claude-work")).digest("hex").slice(0, 8)}`;
  const host = made.start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "noop", () => { ran = true; });
  expect(result.succeeded).toBe(false);
});

it("does not count a home whose keychain item was not a sign-in it could read before", async () => {
  const held = keychainThen({ status: "found", value: "{not json" });
  const host = fixture({ platform: "darwin", keychain: held.keychain }).start();
  const result = await completeLogin(host, { provider: "claude", account: "claude:work" }, "noop", held.ran);
  expect(result.succeeded).toBe(false);
});

it("signs a Codex home that held only an API key in to its first account", async () => {
  const { root, start } = fixture();
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture-api-key", tokens: null }));
  writeFileSync(join(root, "codex-plan.json"), JSON.stringify({ write: [{ dir: "own", email: "first@example.test" }], exit: 0 }));
  const result = await completeCodexLogin(start(), { default: true, replace: true });
  expect(result.succeeded).toBe(true);
  expect(result.account).toBe("first@example.test");
});

/**
 * A default Codex home whose auth.json holds token A, with a `Codex Auth` keychain item answering `before`
 * until the CLI ran, then its own old token B; the CLI only removes the file, so no token is new.
 */
function codexKeychainHome(before: Awaited<ReturnType<UsageContext["keychain"]>>) {
  let root = "";
  const old = codexAuth("keychain@example.test");
  const keychain: UsageContext["keychain"] = async (service) => service !== "Codex Auth" ? { status: "missing" }
    : existsSync(join(root, "codex-ran")) ? { status: "found", value: old } : before;
  const made = fixture({ platform: "darwin", keychain });
  root = made.root;
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), codexAuth("file@example.test"));
  writeFileSync(join(root, "codex-plan.json"), JSON.stringify({ write: [], remove: ["own"], ran: true, exit: 0 }));
  return made;
}

it("does not count a default Codex home whose keychain was locked before, though its auth.json read", async () => {
  const result = await completeCodexLogin(codexKeychainHome({ status: "locked" }).start(), { default: true, replace: true });
  expect(result.succeeded).toBe(false);
});

it("does not count a default Codex home whose keychain item was not JSON before, though its auth.json read", async () => {
  const result = await completeCodexLogin(codexKeychainHome({ status: "found", value: "{not json" }).start(), { default: true, replace: true });
  expect(result.succeeded).toBe(false);
});

it("does not count a token the default Codex home's keychain already held once the file is gone", async () => {
  const result = await completeCodexLogin(codexKeychainHome({ status: "found", value: codexAuth("keychain@example.test") }).start(), { default: true, replace: true });
  expect(result.succeeded).toBe(false);
});

it("names the account this login signed in, not one another home gained meanwhile", async () => {
  const host = fixture().start();
  const result = await completeLogin(host, { provider: "claude", name: "added" }, "also-elsewhere");
  expect(result.succeeded).toBe(true);
  expect(result.account).toBe("added@example.test");
});

it("reports a first Codex sign-in in its default home as signed in", async () => {
  const { root, start } = fixture();
  writeFileSync(join(root, "codex-plan.json"), JSON.stringify({ write: [{ dir: "own", email: "first@example.test" }], exit: 0 }));
  const result = await completeCodexLogin(start(), { default: true });
  expect(result.succeeded).toBe(true);
  expect(result.account).toBe("first@example.test");
});

it("signs a named Codex home in to its own account only", async () => {
  const { root, start } = fixture();
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), codexAuth("other@example.test"));
  writeFileSync(join(root, "codex-plan.json"), JSON.stringify({ write: [{ dir: "own", email: "team@example.test" }], exit: 0 }));
  const result = await completeCodexLogin(start(), { name: "team" });
  expect(result.succeeded).toBe(true);
  expect(result.account).toBe("team@example.test");
});

it("does not credit a Codex home another sign-in wrote while this one failed", async () => {
  const { root, start } = fixture();
  writeFileSync(join(root, "codex-plan.json"), JSON.stringify({ write: [{ dir: join(root, ".codex-elsewhere"), email: "unrelated@example.test" }], exit: 0 }));
  const result = await completeCodexLogin(start(), { name: "team" });
  expect(result.succeeded).toBe(false);
});

it("tells a home whose credential file will not read from one that holds none", async () => {
  const { root } = fixture();
  const ctx: UsageContext = {
    home: root, env: {}, platform: "linux", now: () => 1_000, fetch: async () => Response.json({}),
    keychain: async () => ({ status: "missing" }), run: async () => null, has: () => false,
  };
  const dir = join(root, ".codex-damaged");
  mkdirSync(dir);
  expect(await homeSignIn(ctx, "codex", { kind: "dir", dir })).toBeNull();
  // read whole, but no sign-in: an API key, or a Claude file with only MCP sign-ins, holds none
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "fixture-api-key", tokens: null }));
  expect(await homeSignIn(ctx, "codex", { kind: "dir", dir })).toBeNull();
  const claudeDir = join(root, ".claude-mcp");
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, ".credentials.json"), JSON.stringify({ mcpOAuth: { server: { accessToken: "fixture-mcp" } } }));
  expect(await homeSignIn(ctx, "claude", { kind: "dir", dir: claudeDir })).toBeNull();
  writeFileSync(join(dir, "auth.json"), "{not json");
  expect(await homeSignIn(ctx, "codex", { kind: "dir", dir })).toBe("unknown");
  writeFileSync(join(dir, "auth.json"), "x".repeat(2 * 1024 * 1024));
  expect(await homeSignIn(ctx, "codex", { kind: "dir", dir })).toBe("unknown");
});
