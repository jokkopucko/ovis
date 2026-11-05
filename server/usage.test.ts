import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageReport } from "../shared/protocol.ts";
import { FRESH_MS, handleStatuslineRequest, handleUsageRequest, MAX_READ_BYTES, MIN_REFRESH_MS, RETRY_MS, runCommand, USAGE_PROVIDERS, UsageHttpError, UsageService, type KeychainRead, type UsageContext, type UsageProvider } from "./usage.ts";
import { installStatusline } from "./statusline-install.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const HOUR = 3600_000;

function jwt(claims: Record<string, unknown>): string {
  return ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; gate?: Promise<void> };

let home: string;
let now: number;
let replies: Map<string, Reply>;
let requests: Array<{ url: string; init: RequestInit }>;
let keychain: Map<string, KeychainRead>;
let commands: Map<string, string>;
let commandCalls: string[][];
/** commands this PC does not have installed */
let absent: Set<string>;

function context(platform: NodeJS.Platform = "linux"): UsageContext {
  return {
    home, platform, env: { USER: "me" },
    now: () => now,
    async fetch(url, init) {
      requests.push({ url, init });
      const reply = replies.get(url);
      if (!reply) throw new Error(`unexpected request ${url}`);
      await reply.gate;
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
    },
    keychain: async (service, account) => keychain.get(`${service}|${account ?? ""}`) ?? { status: "missing" },
    run: async (argv) => {
      commandCalls.push(argv);
      return commands.get(argv.join(" ")) ?? null;
    },
    has: (command) => !absent.has(command),
  };
}

function only(id: string) {
  return USAGE_PROVIDERS.filter((provider) => provider.id === id);
}

function write(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

const CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";

function signInCodex(exp = NOW / 1000 + HOUR / 1000, dir = ".codex", user = "user-1", email = "me@example.com") {
  write(join(home, dir, "auth.json"), {
    tokens: {
      access_token: jwt({ exp, "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_user_id: `${user}__acct-1` }, "https://api.openai.com/profile": { email } }),
      account_id: "acct-1", refresh_token: "r",
    },
  });
}

function codexReply(used = 77): Reply {
  return {
    body: {
      plan_type: "pro",
      rate_limit: {
        primary_window: { used_percent: 12, limit_window_seconds: 18_000, reset_at: NOW / 1000 + 3600 },
        secondary_window: { used_percent: used, limit_window_seconds: 604_800, reset_after_seconds: 7200 },
      },
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "herdr-usage-"));
  now = NOW;
  replies = new Map();
  requests = [];
  keychain = new Map();
  commands = new Map();
  commandCalls = [];
  absent = new Set();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("providers", () => {
  it("lists nothing when no CLI is signed in, and asks no one", async () => {
    const report = await new UsageService(context("darwin")).report();
    expect(report).toEqual({ providers: [] });
    expect(requests).toEqual([]);
  });

  it("reads Codex windows with the account header and names them by length", async () => {
    signInCodex();
    replies.set(CODEX_USAGE, codexReply());
    const report = await new UsageService(context(), only("codex")).report();
    expect(report.providers).toEqual([{
      id: "codex", key: "codex:user-1__acct-1", account: "me@example.com", plan: "pro", problem: null, checked_at: new Date(NOW).toISOString(),
      windows: [
        { kind: "session", scope: null, used_percent: 12, resets_at: new Date(NOW + HOUR).toISOString(), starts_at: new Date(NOW - 4 * HOUR).toISOString() },
        { kind: "week", scope: null, used_percent: 77, resets_at: new Date(NOW + 2 * HOUR).toISOString(), starts_at: new Date(NOW + 2 * HOUR - 7 * 24 * HOUR).toISOString() },
      ],
    }]);
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toStartWith("Bearer ");
    expect(headers["chatgpt-account-id"]).toBe("acct-1");
  });

  it("prefers the Claude keychain item on macOS and reads the scoped weekly limits", async () => {
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR, subscriptionType: "max" } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "file", expiresAt: NOW + HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: {
      five_hour: { utilization: 42, resets_at: "2026-09-29T14:00:00.000Z" },
      seven_day: { utilization: 63.44, resets_at: "2026-10-03T00:00:00Z" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 5, resets_at: null },
    } });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    expect(usage!.plan).toBe("max");
    expect(usage!.windows).toEqual([
      { kind: "session", scope: null, used_percent: 42, resets_at: "2026-09-29T14:00:00.000Z", starts_at: "2026-09-29T09:00:00.000Z" },
      { kind: "week", scope: null, used_percent: 63.4, resets_at: "2026-10-03T00:00:00.000Z", starts_at: "2026-09-26T00:00:00.000Z" },
      { kind: "week", scope: "Sonnet", used_percent: 5, resets_at: null, starts_at: null },
    ]);
  });

  it("reads Claude's windows from the status line Claude's own payload keeps, without a request", async () => {
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR, subscriptionType: "max" } }) });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "uuid-1" } });
    const path = join(home, ".herdr", "statusline-last.json");
    write(path, { _herdr: { account: { id: "uuid-1" } }, session_id: "s", model: { display_name: "Opus 5.5" }, rate_limits: {
      five_hour: { used_percentage: 17, resets_at: (NOW + 2 * HOUR) / 1000 },
      seven_day: { used_percentage: 64, resets_at: (NOW + 48 * HOUR) / 1000 },
    } });
    utimesSync(path, new Date(NOW), new Date(NOW));
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    // the endpoint answers 403 from some networks; nothing is asked of it when the line has the numbers
    expect(requests).toEqual([]);
    expect(usage!.problem).toBeNull();
    expect(usage!.plan).toBe("max");
    expect(usage!.windows).toEqual([
      { kind: "session", scope: null, used_percent: 17, resets_at: new Date(NOW + 2 * HOUR).toISOString(), starts_at: new Date(NOW + 2 * HOUR - 5 * HOUR).toISOString() },
      { kind: "week", scope: null, used_percent: 64, resets_at: new Date(NOW + 48 * HOUR).toISOString(), starts_at: new Date(NOW + 48 * HOUR - 7 * 24 * HOUR).toISOString() },
    ]);
  });

  it("uses only the captured account's local limits, falling back for other or unknown accounts", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "personal", expiresAt: NOW + HOUR } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "personal" } });
    write(join(home, ".claude-work", ".credentials.json"), { claudeAiOauth: { accessToken: "work", expiresAt: NOW + HOUR } });
    write(join(home, ".claude-work", ".claude.json"), { oauthAccount: { accountUuid: "work" } });
    const path = join(home, ".herdr", "statusline-last.json");
    write(path, { _herdr: { account: { id: "work" } }, rate_limits: { five_hour: { used_percentage: 17 } } });
    utimesSync(path, new Date(NOW), new Date(NOW));
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 42 } } });
    const report = await new UsageService(context(), only("claude")).report();
    expect(report.providers.map((usage) => [usage.key, usage.windows[0]?.used_percent])).toEqual([["claude:personal", 42], ["claude:work", 17]]);
    expect(requests.map((request) => (request.init.headers as Record<string, string>)["authorization"])).toEqual(["Bearer personal"]);
    requests.length = 0;
    write(path, { rate_limits: { five_hour: { used_percentage: 99 } } });
    utimesSync(path, new Date(NOW), new Date(NOW));
    expect((await new UsageService(context(), only("claude")).report()).providers.map((usage) => usage.windows[0]?.used_percent)).toEqual([42, 42]);
    expect(requests).toHaveLength(2);
  });

  it("falls back to the Claude endpoint when every captured usage window has reset", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "a" } });
    const path = join(home, ".herdr", "statusline-last.json");
    write(path, { _herdr: { account: { id: "a" } }, rate_limits: { five_hour: { used_percentage: 99, resets_at: NOW / 1000 } } });
    utimesSync(path, new Date(NOW - 60_000), new Date(NOW - 60_000));
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1 } } });
    const [usage] = (await new UsageService(context(), only("claude")).report()).providers;
    expect(usage?.windows[0]?.used_percent).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("invalidates a cached local reading at its reset instead of waiting for the report TTL", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "a" } });
    const path = join(home, ".herdr", "statusline-last.json");
    write(path, { _herdr: { account: { id: "a" } }, rate_limits: { five_hour: { used_percentage: 99, resets_at: (NOW + 60_000) / 1000 } } });
    utimesSync(path, new Date(NOW), new Date(NOW));
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1 } } });
    const service = new UsageService(context(), only("claude"));
    expect((await service.report()).providers[0]?.windows[0]?.used_percent).toBe(99);
    expect(requests).toHaveLength(0);
    now += 60_000;
    expect((await service.report()).providers[0]?.windows[0]?.used_percent).toBe(1);
    expect(requests).toHaveLength(1);
  });

  it("accepts matched local Claude limits with an expired token but never sends that token", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "expired", expiresAt: NOW - HOUR } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "a" } });
    const path = join(home, ".herdr", "statusline-last.json");
    write(path, { _herdr: { account: { id: "a" } }, rate_limits: { five_hour: { used_percentage: 17 } } });
    utimesSync(path, new Date(NOW), new Date(NOW));
    const [usage] = (await new UsageService(context(), only("claude")).report()).providers;
    expect(usage?.problem).toBeNull();
    expect(usage?.windows[0]?.used_percent).toBe(17);
    rmSync(path);
    const [missing] = (await new UsageService(context(), only("claude")).report()).providers;
    expect(missing?.problem).toBe("expired");
    expect(requests).toEqual([]);
  });

  it("asks the endpoint over a capture older than five minutes, and falls back to it with its own time", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "a" } });
    const path = join(home, ".herdr", "statusline-last.json");
    write(path, { _herdr: { account: { id: "a" } }, rate_limits: { five_hour: { used_percentage: 17 } } });
    const taken = NOW - 10 * 60_000;
    utimesSync(path, new Date(taken), new Date(taken));
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 42 } } });
    const [answered] = (await new UsageService(context(), only("claude")).report()).providers;
    expect(answered).toMatchObject({ problem: null, checked_at: new Date(NOW).toISOString(), windows: [{ used_percent: 42 }] });
    expect(requests).toHaveLength(1);
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 403, body: { error: { message: "Request not allowed" } } });
    const [refused] = (await new UsageService(context(), only("claude")).report()).providers;
    expect(refused).toMatchObject({ problem: null, checked_at: new Date(taken).toISOString(), windows: [{ used_percent: 17 }] });
    expect(requests).toHaveLength(2);
  });

  it("offers the status line for a 403 to a token that has not expired, never for a real expiry or once it is on", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "a" } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 403, body: { error: { message: "Request not allowed" } } });
    const read = async () => (await new UsageService(context(), only("claude")).report()).providers[0];
    expect(await read()).toMatchObject({ problem: "expired", statusline_offer: true });
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 401, body: {} });
    expect(await read()).not.toHaveProperty("statusline_offer");
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 403, body: { error: { message: "Request not allowed" } } });
    installStatusline({ home });
    expect(await read()).not.toHaveProperty("statusline_offer");
    expect((await read())?.problem).toBe("expired");
  });

  it("offers the status line only for the sign-in whose config directory the switch changes", async () => {
    write(join(home, ".claude-work", ".credentials.json"), { claudeAiOauth: { accessToken: "work", expiresAt: NOW + HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 403, body: { error: { message: "Request not allowed" } } });
    const [elsewhere] = (await new UsageService(context(), only("claude")).report()).providers;
    expect(elsewhere).toMatchObject({ problem: "expired" });
    expect(elsewhere).not.toHaveProperty("statusline_offer");
    const configured = { ...context(), env: { ...context().env, CLAUDE_CONFIG_DIR: join(home, ".claude-work") } };
    const [switched] = (await new UsageService(configured, only("claude")).report()).providers;
    expect(switched).toMatchObject({ problem: "expired", statusline_offer: true });
  });

  it("takes a CLAUDE_CONFIG_DIR named default as a path, not as the default ~/.claude", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 403, body: { error: { message: "Request not allowed" } } });
    const [usage] = (await new UsageService({ ...context(), env: { ...context().env, CLAUDE_CONFIG_DIR: "default" } }, only("claude")).report()).providers;
    expect(usage).toMatchObject({ problem: "expired" });
    expect(usage).not.toHaveProperty("statusline_offer");
  });

  it("offers the status line when CLAUDE_CONFIG_DIR names the default ~/.claude, however it is spelled", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 403, body: { error: { message: "Request not allowed" } } });
    for (const spelled of [join(home, ".claude"), `${join(home, ".claude")}/`]) {
      const [usage] = (await new UsageService({ ...context(), env: { ...context().env, CLAUDE_CONFIG_DIR: spelled } }, only("claude")).report()).providers;
      expect(usage).toMatchObject({ problem: "expired", statusline_offer: true });
    }
  });

  it("answers a failed switch without quoting Claude's settings or a command saved in them", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const service = new UsageService(context(), only("claude"));
    const post = () => handleStatuslineRequest(new Request("http://x/api/usage/statusline", { method: "POST", body: JSON.stringify({ enabled: true }) }), service);
    expect((await post()).status).toBe(200);
    // a command that runs the installed wrapper behind a secret of its own is refused, not wrapped
    const wrapper = join(home, ".claude", "herdr-statusline", "statusline-tee.sh");
    write(join(home, ".claude", "settings.json"), { statusLine: { type: "command", command: `API_KEY=FAKE_SECRET_FOR_TEST sh ${wrapper}` } });
    const refused = await post();
    expect(refused.status).toBe(409);
    expect(await refused.text()).not.toContain("FAKE_SECRET_FOR_TEST");
    writeFileSync(join(home, ".claude", "settings.json"), "{ \"statusLine\": API_KEY=FAKE_SECRET_FOR_TEST");
    const broken = await post();
    expect(broken.status).toBe(500);
    expect(await broken.text()).not.toContain("FAKE_SECRET_FOR_TEST");
  });

  it("answers a turn-off it could only do in part as refused, not as off", async () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const service = new UsageService(context(), only("claude"));
    const post = (enabled: boolean) => handleStatuslineRequest(new Request("http://x/api/usage/statusline", { method: "POST", body: JSON.stringify({ enabled }) }), service);
    expect((await post(true)).status).toBe(200);
    const wrapper = join(home, ".claude", "herdr-statusline", "statusline-tee.sh");
    write(join(home, ".claude", "settings.json"), { statusLine: { type: "command", command: `sh ${wrapper}` } });
    const kept = await post(false);
    expect(kept.status).toBe(409);
    expect(existsSync(wrapper)).toBe(true);
  });

  it("never offers the status line where it cannot run", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 403, body: { error: { message: "Request not allowed" } } });
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const [usage] = (await new UsageService(context(), only("claude")).report()).providers;
      expect(usage).toMatchObject({ problem: "expired" });
      expect(usage).not.toHaveProperty("statusline_offer");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("keeps a newer endpoint answer over an older capture when a later refresh is refused", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "k", expiresAt: NOW + 2 * HOUR } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "a" } });
    const path = join(home, ".herdr", "statusline-last.json");
    write(path, { _herdr: { account: { id: "a" } }, rate_limits: { five_hour: { used_percentage: 17 } } });
    utimesSync(path, new Date(NOW - 10 * 60_000), new Date(NOW - 10 * 60_000));
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 42 } } });
    const service = new UsageService(context(), only("claude"));
    expect((await service.report()).providers[0]).toMatchObject({ problem: null, windows: [{ used_percent: 42 }] });
    now += 6 * 60_000;
    replies.set("https://api.anthropic.com/api/oauth/usage", { status: 403, body: { error: { message: "Request not allowed" } } });
    expect((await service.report()).providers[0]).toMatchObject({ problem: "expired", checked_at: new Date(NOW).toISOString(), windows: [{ used_percent: 42 }] });
    expect(requests).toHaveLength(2);
  });

  it("reads Claude's other per-model weekly limits from `limits`, after the flat fields", async () => {
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR, subscriptionType: "max" } }) });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: {
      five_hour: { utilization: 42, resets_at: "2026-09-29T14:00:00.000Z" },
      seven_day_sonnet: { utilization: 5, resets_at: null },
      limits: [
        { kind: "session", group: "session", percent: 42, resets_at: "2026-09-29T14:00:00.000Z", scope: null },
        { kind: "weekly_scoped", group: "weekly", percent: 30.04, resets_at: "2026-10-11T19:59:00Z", scope: { model: { display_name: "Fable" } } },
        { kind: "weekly_scoped", group: "weekly", percent: 9, resets_at: null, scope: { model: { display_name: "Sonnet" } } },
        { kind: "weekly_scoped", group: "weekly", percent: 12, resets_at: null, scope: { model: null } },
      ],
    } });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect(usage!.windows).toEqual([
      { kind: "session", scope: null, used_percent: 42, resets_at: "2026-09-29T14:00:00.000Z", starts_at: "2026-09-29T09:00:00.000Z" },
      { kind: "week", scope: "Sonnet", used_percent: 5, resets_at: null, starts_at: null },
      { kind: "week", scope: "Fable", used_percent: 30, resets_at: "2026-10-11T19:59:00.000Z", starts_at: null },
    ]);
  });

  it("reads the Claude credentials file when Claude Code refreshed it but not the keychain item", async () => {
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "stale", expiresAt: NOW - HOUR } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "file", expiresAt: NOW + 8 * HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer file");
    expect(usage!.problem).toBeNull();
  });

  it("keeps the Claude keychain item when the credentials file is older", async () => {
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: NOW + 8 * HOUR } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "old", expiresAt: NOW - HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    await new UsageService(context("darwin"), only("claude")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
  });

  it("reads the later of two unexpired Claude sign-ins, and keeps a keychain item that names no expiry", async () => {
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k", expiresAt: NOW + HOUR } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "file", expiresAt: NOW + 8 * HOUR } });
    await new UsageService(context("darwin"), only("claude")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer file");

    requests.length = 0;
    keychain.set("Claude Code-credentials|me", { status: "found", value: JSON.stringify({ claudeAiOauth: { accessToken: "k" } }) });
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "old", expiresAt: NOW - HOUR } });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
    expect(usage!.problem).toBeNull();
  });

  it("lists each Codex account once, from ~/.codex and a ~/.codex-* sibling", async () => {
    signInCodex(NOW / 1000 + 3600, ".codex", "user-1", "work@example.com");
    signInCodex(NOW / 1000 + 7200, ".codex-personal", "user-2", "me@example.com");
    // the same account signed in twice is one plan
    signInCodex(NOW / 1000 + 5400, ".codex-copy", "user-1", "work@example.com");
    replies.set(CODEX_USAGE, codexReply());
    const report = await new UsageService(context(), only("codex")).report();
    expect(report.providers.map((usage) => [usage.key, usage.account])).toEqual([
      ["codex:user-1__acct-1", "work@example.com"],
      ["codex:user-2__acct-1", "me@example.com"],
    ]);
  });

  it("finds a second Claude account in a ~/.claude-* config dir, named by its .claude.json", async () => {
    const credentials = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: NOW + HOUR } });
    const dir = join(home, ".claude-work");
    keychain.set("Claude Code-credentials|me", { status: "found", value: credentials("personal") });
    keychain.set(`Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}|me`, { status: "found", value: credentials("work") });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: "uuid-1", emailAddress: "me@example.com" } });
    write(join(dir, ".claude.json"), { oauthAccount: { accountUuid: "uuid-2", emailAddress: "work@example.com" } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    const report = await new UsageService(context("darwin"), only("claude")).report();
    expect(report.providers.map((usage) => [usage.key, usage.account])).toEqual([["claude:uuid-1", "me@example.com"], ["claude:uuid-2", "work@example.com"]]);
    expect(requests.map((request) => (request.init.headers as Record<string, string>)["authorization"])).toEqual(["Bearer personal", "Bearer work"]);
  });

  it("reads the Claude credentials file where there is no keychain", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "file", expiresAt: NOW + HOUR } });
    replies.set("https://api.anthropic.com/api/oauth/usage", { body: { five_hour: { utilization: 1, resets_at: null } } });
    await new UsageService(context("linux"), only("claude")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer file");
  });

  it("reads Cursor's plan usage from the app's state database", async () => {
    const path = join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new Database(path);
    db.run("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
    db.run("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?), ('cursorAuth/stripeMembershipType', 'pro')", [jwt({ exp: NOW / 1000 + 3600 })]);
    db.close();
    replies.set("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", { body: {
      billingCycleEnd: "1790812800000",
      planUsage: { limit: 40000, remaining: 32000, autoPercentUsed: 12.5, apiPercentUsed: 7.5 },
    } });
    const [usage] = (await new UsageService(context("linux"), only("cursor")).report()).providers;
    const resets_at = new Date(1790812800000).toISOString();
    expect(usage).toMatchObject({ plan: "pro", windows: [
      { kind: "month", scope: null, used_percent: 20, resets_at },
      { kind: "month", scope: "Cursor models", used_percent: 12.5, resets_at },
      { kind: "month", scope: "Other models", used_percent: 7.5, resets_at },
    ] });
    expect(requests[0]!.init.method).toBe("POST");
  });

  it("reads Copilot Free from an editor sign-in and leaves unlimited quotas out", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_x" } });
    replies.set("https://api.github.com/copilot_internal/user", { body: {
      copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_reset_date: "2026-10-01",
      quota_snapshots: {
        chat: { entitlement: 200, percent_remaining: 100, unlimited: false },
        completions: { entitlement: 2000, percent_remaining: 97.8, unlimited: false },
        premium_interactions: { entitlement: 0, percent_remaining: 0, unlimited: false },
      },
    } });
    const [usage] = (await new UsageService(context(), only("copilot")).report()).providers;
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("token gho_x");
    expect(usage).toMatchObject({
      plan: "free",
      windows: [
        { kind: "month", scope: "Chat", used_percent: 0, resets_at: "2026-10-01T00:00:00.000Z" },
        { kind: "month", scope: "Completions", used_percent: 2.2, resets_at: "2026-10-01T00:00:00.000Z" },
      ],
    });
  });

  it("tries the GitHub CLI's token when an old editor sign-in is refused, and lists the account once", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_stale", user: "me" } });
    commands.set("gh auth token --hostname github.com", "gho_live");
    const url = "https://api.github.com/copilot_internal/user";
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const live = (init.headers as Record<string, string>)["authorization"] === "token gho_live";
      return new Response(JSON.stringify(live ? { login: "me", copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 90 } } } : {}), { status: live ? 200 : 401 });
    } }, only("copilot"));
    const { providers } = await service.report();
    const [usage] = providers;
    // a CLI too old to name its account: the answer names it, and the refused sign-in of the same login gives way
    expect(providers).toHaveLength(1);
    expect(requests.map((request) => (request.init.headers as Record<string, string>)["authorization"])).toEqual(["token gho_stale", "token gho_live"]);
    expect(requests.every((request) => request.url === url)).toBe(true);
    expect(usage).toMatchObject({ problem: null, windows: [{ kind: "month", scope: "Chat", used_percent: 10 }] });
  });

  it("tries the next Copilot token after a 404, an account without Copilot", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_other_account" } });
    commands.set("gh auth token --hostname github.com", "gho_with_copilot");
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const found = (init.headers as Record<string, string>)["authorization"] === "token gho_with_copilot";
      return new Response(JSON.stringify(found ? { copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 50 } } } : {}), { status: found ? 200 : 404 });
    } }, only("copilot"));
    const [usage] = (await service.report()).providers;
    expect(requests).toHaveLength(2);
    expect(usage).toMatchObject({ problem: null, windows: [{ scope: "Chat", used_percent: 50 }] });
  });

  it("reads every GitHub CLI account with its own token, trying the editor's first, and skips one gh found broken", async () => {
    write(join(home, ".config", "github-copilot", "apps.json"), { "github.com:Iv1.x": { oauth_token: "gho_editor", user: "Alice" } });
    commands.set("gh auth status --hostname github.com --json hosts", JSON.stringify({ hosts: { "github.com": [
      { state: "success", login: "alice" }, { state: "success", login: "bob" }, { state: "error", login: "carol" },
    ] } }));
    commands.set("gh auth token --hostname github.com --user alice", "gho_alice");
    commands.set("gh auth token --hostname github.com --user bob", "gho_bob");
    commands.set("gh auth token --hostname github.com --user carol", "gho_carol");
    const service = new UsageService({ ...context(), async fetch(target, init) {
      const token = (init.headers as Record<string, string>)["authorization"];
      requests.push({ url: target, init });
      if (token === "token gho_editor") return new Response("{}", { status: 401 });
      const login = token === "token gho_alice" ? "alice" : "Bob";
      return new Response(JSON.stringify({ login, copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 50 } } }));
    } }, only("copilot"));
    const report = await service.report();
    expect(report.providers.map((usage) => [usage.key, usage.account, usage.problem])).toEqual([["copilot:alice", "alice", null], ["copilot:bob", "Bob", null]]);
    expect(requests.map((request) => (request.init.headers as Record<string, string>)["authorization"])).toEqual(["token gho_editor", "token gho_bob", "token gho_alice"]);
  });

  it("leaves out Copilot Free found only through the GitHub CLI, but shows a paid plan there", async () => {
    commands.set("gh auth token --hostname github.com", "gho_cli");
    const free = { login: "me", copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 100 } } };
    replies.set("https://api.github.com/copilot_internal/user", { body: free });
    expect((await new UsageService(context(), only("copilot")).report()).providers).toEqual([]);
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("token gho_cli");
    replies.set("https://api.github.com/copilot_internal/user", { body: { ...free, access_type_sku: "plus_monthly_subscriber", copilot_plan: "individual" } });
    const [paid] = (await new UsageService(context(), only("copilot")).report()).providers;
    expect(paid).toMatchObject({ key: "copilot:me", plan: "individual" });
  });

  it("shows Copilot Free when the same account is also signed in to Copilot in an editor", async () => {
    write(join(home, ".config", "github-copilot", "apps.json"), { "github.com:Iv1.x": { oauth_token: "gho_editor", user: "me" } });
    commands.set("gh auth status --hostname github.com --json hosts", JSON.stringify({ hosts: { "github.com": [{ state: "success", login: "me" }] } }));
    commands.set("gh auth token --hostname github.com --user me", "gho_cli");
    replies.set("https://api.github.com/copilot_internal/user", { body: { login: "me", copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 90 } } } });
    const [usage] = (await new UsageService(context(), only("copilot")).report()).providers;
    expect(usage).toMatchObject({ key: "copilot:me", plan: "free" });
  });

  it("keeps Copilot Free from an unnamed CLI sign-in when it answers for an expired editor account", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_stale", user: "Me" } });
    commands.set("gh auth token --hostname github.com", "gho_cli");
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const live = (init.headers as Record<string, string>)["authorization"] === "token gho_cli";
      return new Response(JSON.stringify(live ? { login: "me", copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 90 } } } : {}), { status: live ? 200 : 401 });
    } }, only("copilot"));
    expect((await service.report()).providers).toMatchObject([{ key: "copilot:me", plan: "free", problem: null, windows: [{ scope: "Chat", used_percent: 10 }] }]);
    expect(requests).toHaveLength(2);
  });

  it("still leaves out an unnamed CLI's Copilot Free when its account differs from the editor's", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_editor", user: "alice" } });
    commands.set("gh auth token --hostname github.com", "gho_cli");
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const editor = (init.headers as Record<string, string>)["authorization"] === "token gho_editor";
      return new Response(JSON.stringify({ login: editor ? "alice" : "bob", copilot_plan: "individual", access_type_sku: "free_limited_copilot", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 90 } } }));
    } }, only("copilot"));
    expect((await service.report()).providers).toMatchObject([{ key: "copilot:alice", plan: "free" }]);
    expect(requests).toHaveLength(2);
  });

  it("says expired when every Copilot token is refused", async () => {
    write(join(home, ".config", "github-copilot", "hosts.json"), { "github.com": { oauth_token: "gho_stale" } });
    replies.set("https://api.github.com/copilot_internal/user", { status: 401 });
    const [usage] = (await new UsageService(context(), only("copilot")).report()).providers;
    expect(usage!.problem).toBe("expired");
    expect(requests).toHaveLength(1);
  });

  it("leaves a GitHub account without Copilot out of the report", async () => {
    commands.set("gh auth token --hostname github.com", "gho_x");
    replies.set("https://api.github.com/copilot_internal/user", { status: 404 });
    expect((await new UsageService(context(), only("copilot")).report()).providers).toEqual([]);
  });

  it("reads Grok's credit period, a missing percent being zero", async () => {
    write(join(home, ".grok", "auth.json"), { default: { key: "g", expires_at: new Date(NOW + HOUR).toISOString() } });
    replies.set("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { body: {
      config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-25T00:00:00Z", end: "2026-10-02T00:00:00Z" } },
    } });
    const [usage] = (await new UsageService(context(), only("grok")).report()).providers;
    expect(usage!.windows).toEqual([{ kind: "week", scope: null, used_percent: 0, resets_at: "2026-10-02T00:00:00.000Z", starts_at: "2026-09-25T00:00:00.000Z" }]);
  });

  it("reads every Grok account signed in", async () => {
    write(join(home, ".grok", "auth.json"), {
      "https://auth.x.ai::a": { key: "ga", user_id: "u-a", email: "a@example.com" },
      "https://auth.x.ai::b": { key: "gb", user_id: "u-b", email: "b@example.com" },
    });
    replies.set("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { body: { config: { creditUsagePercent: 5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } } });
    const report = await new UsageService(context(), only("grok")).report();
    expect(report.providers.map((usage) => [usage.key, usage.account])).toEqual([["grok:u-a", "a@example.com"], ["grok:u-b", "b@example.com"]]);
  });

  it("shows no Grok limit for an answer that states no period and no percent", async () => {
    write(join(home, ".grok", "auth.json"), { default: { key: "g" } });
    replies.set("https://cli-chat-proxy.grok.com/v1/billing?format=credits", { body: { error: "invalid_token" } });
    const [usage] = (await new UsageService(context(), only("grok")).report()).providers;
    expect(usage).toMatchObject({ problem: null, windows: [] });
  });

  it("reads Antigravity's buckets from its go-keyring item, falling back to the second host", async () => {
    const item = { token: { access_token: "ya29", expiry: new Date(NOW + HOUR).toISOString() } };
    keychain.set("gemini|antigravity", { status: "found", value: `go-keyring-base64:${Buffer.from(JSON.stringify(item)).toString("base64")}` });
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { status: 503 });
    replies.set("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [{ buckets: [
      { bucketId: "gemini-5h", remainingFraction: 0.75, resetTime: "2026-09-29T16:00:00Z" },
      { bucketId: "3p-weekly", resetTime: "2026-10-04T00:00:00Z" },
      { bucketId: "3p-5h", remainingFraction: 0, resetTime: "2026-09-29T15:00:00Z" },
      { bucketId: "unknown", remainingFraction: 0.5 },
    ] }] } } });
    const [usage] = (await new UsageService(context("darwin"), only("antigravity")).report()).providers;
    // a bucket without a fraction is left out, never shown as exhausted
    expect(usage!.windows).toEqual([
      { kind: "session", scope: null, used_percent: 25, resets_at: "2026-09-29T16:00:00.000Z", starts_at: null },
      { kind: "session", scope: "Other models", used_percent: 100, resets_at: "2026-09-29T15:00:00.000Z", starts_at: null },
    ]);
  });

  it.each(["gemini-5h", "gemini-weekly"])("never starts the CLI when HTTP includes %s", async (bucketId) => {
    write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), {
      token: { access_token: "ya29-file", expiry: new Date(NOW + HOUR).toISOString() },
    });
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { groups: [{ buckets: [
      { bucketId, remainingFraction: 0.75 },
    ] }] } });
    let calls = 0;
    const ctx: UsageContext = { ...context(), async run(argv) { if (argv[0] === "agy") calls++; return null; } };
    const [usage] = (await new UsageService(ctx, only("antigravity")).report()).providers;
    expect(usage).toMatchObject({ problem: null, windows: [{ scope: null, used_percent: 25 }] });
    expect(calls).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it.each([401, 403, 429])("preserves HTTP %s handling without starting the CLI", async (status) => {
    write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), {
      token: { access_token: "ya29-file", expiry: new Date(NOW + HOUR).toISOString() },
    });
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { status });
    let calls = 0;
    const ctx: UsageContext = { ...context(), async run(argv) { if (argv[0] === "agy") calls++; return null; } };
    const [usage] = (await new UsageService(ctx, only("antigravity")).report()).providers;
    expect(usage!.problem).toBe(status === 429 ? "rate_limited" : "expired");
    expect(calls).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it("uses the official CLI only after HTTP omits Gemini quotas", async () => {
    write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), {
      token: { access_token: "ya29-file", expiry: new Date(NOW + HOUR).toISOString() },
    });
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { groups: [{ buckets: [
      { bucketId: "3p-weekly", remainingFraction: 1 },
    ] }] } });
    const argv = ["agy", "--print", "/usage", "--output-format", "json", "--print-timeout", "30s"];
    const calls: Array<{ argv: string[]; timeoutMs?: number }> = [];
    const ctx: UsageContext = { ...context("win32"), async run(argv, timeoutMs) {
      expect(requests).toHaveLength(1);
      calls.push({ argv, timeoutMs });
      return JSON.stringify({ status: "SUCCESS", command: { data: { groups: [{ buckets: [
        { id: "gemini-weekly", remaining_fraction: 0.712, reset_time: "2026-10-04T00:00:00Z" },
        { id: "gemini-5h", remaining_fraction: 1, reset_time: "2026-09-29T16:00:00Z" },
        { id: "3p-weekly", remaining_fraction: 0.5 },
        { id: "3p-5h", remaining_fraction: 0 },
        { id: "gemini-5h" },
        { id: "unknown", remaining_fraction: 0.5 },
      ] }] } } });
    } };
    const [usage] = (await new UsageService(ctx, only("antigravity")).report()).providers;
    expect(usage).toMatchObject({ problem: null, windows: [
      { kind: "week", scope: null, used_percent: 28.8, resets_at: "2026-10-04T00:00:00.000Z", starts_at: null },
      { kind: "session", scope: null, used_percent: 0, resets_at: "2026-09-29T16:00:00.000Z", starts_at: null },
      { kind: "week", scope: "Other models", used_percent: 50, resets_at: null, starts_at: null },
      { kind: "session", scope: "Other models", used_percent: 100, resets_at: null, starts_at: null },
    ] });
    expect(calls).toEqual([{ argv, timeoutMs: 35_000 }]);
    expect(requests).toHaveLength(1);
  });

  it.each([
    null,
    "not json",
    JSON.stringify({ status: "ERROR" }),
    JSON.stringify({ status: "SUCCESS", command: { data: { groups: [] } } }),
    JSON.stringify({ status: "SUCCESS", command: { data: { groups: [{ buckets: [{ id: "gemini-5h" }] }] } } }),
  ])("keeps the HTTP reading when Antigravity CLI output is unusable: %s", async (output) => {
    write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), {
      token: { access_token: "ya29-file", expiry: new Date(NOW + HOUR).toISOString() },
    });
    if (output !== null) commands.set("agy --print /usage --output-format json --print-timeout 30s", output);
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { groups: [{ buckets: [
      { bucketId: "3p-weekly", remainingFraction: 1 },
    ] }] } });
    const [usage] = (await new UsageService(context(), only("antigravity")).report()).providers;
    expect(usage).toMatchObject({ problem: null, windows: [{ kind: "week", scope: "Other models", used_percent: 0 }] });
    expect(requests).toHaveLength(1);
  });

  it("reads Antigravity from its token file on Linux", async () => {
    write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), {
      token: { access_token: "ya29-file", expiry: new Date(NOW + HOUR).toISOString() },
      id_token: jwt({ email: "user@example.com", sub: "sub-123" }),
    });
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [{ buckets: [
      { bucketId: "gemini-5h", remainingFraction: 0.8, resetTime: "2026-09-29T16:00:00Z" },
    ] }] } } });
    const [usage] = (await new UsageService(context("linux"), only("antigravity")).report()).providers;
    expect(usage).toMatchObject({
      id: "antigravity",
      key: "antigravity:sub-123",
      account: "user@example.com",
      windows: [
        { kind: "session", scope: null, used_percent: 20, resets_at: "2026-09-29T16:00:00.000Z" },
      ],
    });
  });

  it("reads Antigravity from the Linux desktop keyring without a token file", async () => {
    commands.set("secret-tool lookup service gemini username antigravity", JSON.stringify({
      token: { access_token: "ya29-keyring", expiry: new Date(NOW + HOUR).toISOString() },
      id_token: jwt({ email: "keyring@example.com", sub: "keyring-sub" }),
    }));
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [] } } });
    const [usage] = (await new UsageService(context("linux"), only("antigravity")).report()).providers;
    expect(usage).toMatchObject({ id: "antigravity", key: "antigravity:keyring-sub", account: "keyring@example.com" });
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer ya29-keyring");
  });

  it.each(["missing", "failing"] as const)("does not show Antigravity when Linux secret-tool is %s", async (result) => {
    if (result === "failing") commands.set("secret-tool lookup service gemini username antigravity", "");
    const report = await new UsageService(context("linux"), only("antigravity")).report();
    expect(report).toEqual({ providers: [] });
    expect(commandCalls).toEqual([["secret-tool", "lookup", "service", "gemini", "username", "antigravity"]]);
  });

  it("names secret-tool when Linux lacks it and no Antigravity sign-in was found, and looks again on the next report", async () => {
    absent.add("secret-tool");
    const service = new UsageService(context("linux"), only("antigravity"));
    expect(await service.report()).toEqual({ providers: [], missing_commands: [{ provider: "antigravity", command: "secret-tool" }] });
    // installed since: the next plain report finds the keyring item, without waiting for FRESH_MS
    absent.delete("secret-tool");
    commands.set("secret-tool lookup service gemini username antigravity", JSON.stringify({
      token: { access_token: "ya29-keyring", expiry: new Date(NOW + HOUR).toISOString() },
      id_token: jwt({ email: "keyring@example.com", sub: "keyring-sub" }),
    }));
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [] } } });
    now += 1000;
    const report = await service.report();
    expect(report.missing_commands).toBeUndefined();
    expect(report.providers).toMatchObject([{ id: "antigravity", key: "antigravity:keyring-sub" }]);
  });

  it("looks in the keyring again once secret-tool, removed after a search was kept, is back", async () => {
    const service = new UsageService(context("linux"), only("antigravity"));
    expect(await service.report()).toEqual({ providers: [] });
    absent.add("secret-tool");
    now += 1000;
    expect((await service.report()).missing_commands).toEqual([{ provider: "antigravity", command: "secret-tool" }]);
    absent.delete("secret-tool");
    commands.set("secret-tool lookup service gemini username antigravity", JSON.stringify({ token: { access_token: "ya29-keyring", expiry: new Date(NOW + HOUR).toISOString() } }));
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [] } } });
    now += 1000;
    expect((await service.report()).providers).toHaveLength(1);
  });

  it("names no missing secret-tool once Antigravity's token file gives its account", async () => {
    absent.add("secret-tool");
    write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), { token: { access_token: "ya29-file", expiry: new Date(NOW + HOUR).toISOString() } });
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [] } } });
    const report = await new UsageService(context("linux"), only("antigravity")).report();
    expect(report.missing_commands).toBeUndefined();
    expect(report.providers).toHaveLength(1);
  });

  it("never names secret-tool off Linux", async () => {
    absent.add("secret-tool");
    expect(await new UsageService(context("darwin"), only("antigravity")).report()).toEqual({ providers: [] });
  });

  it.each([
    { name: "the token file when it expires after the keyring item", file: NOW + 8 * HOUR, item: NOW - HOUR, bearer: "file" },
    { name: "the keyring item when the token file is older", file: NOW - HOUR, item: NOW + 8 * HOUR, bearer: "keyring" },
  ])("keeps $name on Linux", async ({ file, item, bearer }) => {
    const token = (access: string, expiry: number) => JSON.stringify({ token: { access_token: access, expiry: new Date(expiry).toISOString() } });
    commands.set("secret-tool lookup service gemini username antigravity", token("keyring", item));
    write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), token("file", file));
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [] } } });
    await new UsageService(context("linux"), only("antigravity")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${bearer}`);
  });

  it.each([
    { name: "the token file when it expires after the keychain item", file: NOW + 8 * HOUR, item: NOW - HOUR, bearer: "file" },
    { name: "the keychain item when the token file is older", file: NOW - HOUR, item: NOW + 8 * HOUR, bearer: "item" },
  ])("reads $name for Antigravity", async ({ file, item, bearer }) => {
    const token = (access: string, expiry: number) => JSON.stringify({ token: { access_token: access, expiry: new Date(expiry).toISOString() } });
    keychain.set("gemini|antigravity", { status: "found", value: token("item", item) });
    write(join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"), token("file", file));
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [] } } });
    await new UsageService(context("darwin"), only("antigravity")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe(`Bearer ${bearer}`);
  });

  it("reads the Antigravity token file from ANTIGRAVITY_APP_DATA_DIR", async () => {
    const dir = join(home, "agy-data");
    write(join(dir, "antigravity-oauth-token"), { token: { access_token: "custom", expiry: new Date(NOW + HOUR).toISOString() } });
    replies.set("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", { body: { response: { groups: [] } } });
    await new UsageService({ ...context("linux"), env: { USER: "me", ANTIGRAVITY_APP_DATA_DIR: dir } }, only("antigravity")).report();
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer custom");
  });

  it("reads OpenCode Go usage windows from ~/.local/share/opencode/auth.json", async () => {
    write(join(home, ".local", "share", "opencode", "auth.json"), {
      "opencode-go": { type: "api", key: "oc_sk_test" },
    });
    replies.set("https://opencode.ai/zen/go/v1/usage", { body: {
      usage: {
        rolling: { status: "ok", percent: 10, resetsAt: "2026-09-29T16:00:00Z" },
        weekly: { status: "ok", percent: 45, resetsAt: "2026-10-05T00:00:00Z" },
        monthly: { status: "ok", percent: 20, resetsAt: "2026-10-27T00:00:00Z" },
      },
    } });
    const [usage] = (await new UsageService(context("linux"), only("opencode")).report()).providers;
    expect(usage).toMatchObject({
      id: "opencode",
      plan: "Go",
      windows: [
        { kind: "session", scope: null, used_percent: 10, resets_at: "2026-09-29T16:00:00.000Z", starts_at: null },
        { kind: "week", scope: null, used_percent: 45, resets_at: "2026-10-05T00:00:00.000Z", starts_at: null },
        { kind: "month", scope: null, used_percent: 20, resets_at: "2026-10-27T00:00:00.000Z", starts_at: null },
      ],
    });
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer oc_sk_test");
  });

  /**
   * OpenCode 2's own credential store, the `credential` table of the DB `server/opencode.ts` reads;
   * `v1` leaves out `session_v2`, as in a 1.x store, whose `credential` table stays empty.
   */
  function opencodeStore(rows: Array<{ id?: string; integration?: string; value: unknown; active?: number | null; updated?: number }>, dir = join(home, ".local", "share", "opencode"), v1 = false) {
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "opencode.db"));
    db.exec("create table credential (id text primary key, integration_id text, label text, value text, active integer, time_created integer, time_updated integer)");
    if (!v1) db.exec("create table session_v2 (id text primary key)");
    const insert = db.query("insert into credential values (?, ?, ?, ?, ?, ?, ?)");
    rows.forEach((row, i) => insert.run(row.id ?? `cred_${i}`, row.integration ?? "opencode-go", "OpenCode Go", JSON.stringify(row.value), row.active === undefined ? 1 : row.active, i, row.updated ?? i));
    db.close();
  }

  // OpenCode 2 stopped writing auth.json but left it standing, holding the key it replaced: that
  // file alone reports a CLI signed in and working as expired, so the store answers first
  it("reads OpenCode 2's own credential store ahead of the auth.json it left behind", async () => {
    write(join(home, ".local", "share", "opencode", "auth.json"), { "opencode-go": { type: "api", key: "oc_sk_replaced" } });
    opencodeStore([{ value: { type: "key", key: "oc_sk_live" } }]);
    replies.set("https://opencode.ai/zen/go/v1/usage", { body: { usage: { weekly: { percent: 30 } } } });
    const [usage] = (await new UsageService(context("linux"), only("opencode")).report()).providers;
    expect(usage).toMatchObject({ id: "opencode", problem: null, windows: [{ kind: "week", scope: null, used_percent: 30 }] });
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer oc_sk_live");
  });

  it("takes OpenCode's active credential row, its Go row before its Zen row", async () => {
    opencodeStore([
      { integration: "opencode-go", value: { type: "key", key: "oc_sk_go_old" }, active: 0, updated: 5 },
      { integration: "opencode-go", value: { type: "key", key: "oc_sk_go_active" }, active: 1, updated: 1 },
      { integration: "opencode", value: { type: "key", key: "oc_sk_zen" }, active: 1, updated: 9 },
    ]);
    replies.set("https://opencode.ai/zen/go/v1/usage", { body: { usage: { weekly: { percent: 5 } } } });
    const [usage] = (await new UsageService(context("linux"), only("opencode")).report()).providers;
    expect(usage).toMatchObject({ id: "opencode", windows: [{ kind: "week", scope: null, used_percent: 5 }] });
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer oc_sk_go_active");
  });

  // OpenCode 2 imports auth.json once, when it takes over a 1.x store, and leaves the file standing:
  // signed out of OpenCode 2, or signed in by OAuth, the file's key is one OpenCode no longer uses
  it("leaves out the auth.json OpenCode 2 no longer reads when its store holds no key", async () => {
    opencodeStore([{ value: { type: "oauth", methodID: "browser", refresh: "rt" }, active: null }]);
    write(join(home, ".local", "share", "opencode", "auth.json"), { "opencode-go": { type: "api", key: "oc_sk_signed_out" } });
    expect((await new UsageService(context("linux"), only("opencode")).report()).providers).toEqual([]);
    expect(requests).toEqual([]);
  });

  // known to be OpenCode 2's, a store that will not answer now (busy past the timeout, damaged)
  // still leaves the file's key one OpenCode no longer uses; the variable it reads still answers
  it("keeps OpenCode 2's old auth.json out when its credential cannot be read, and reads OPENCODE_API_KEY", async () => {
    const dir = join(home, ".local", "share", "opencode");
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, "opencode.db"));
    db.exec("create table session_v2 (id text primary key); create table credential (id text primary key, integration_id text, value text)");
    db.close();
    write(join(dir, "auth.json"), { "opencode-go": { type: "api", key: "oc_sk_signed_out" } });
    replies.set("https://opencode.ai/zen/go/v1/usage", { body: { usage: { weekly: { percent: 3 } } } });
    await new UsageService({ ...context("linux"), env: { USER: "me", OPENCODE_API_KEY: "oc_sk_env" } }, only("opencode")).report();
    expect(requests.map((request) => (request.init.headers as Record<string, string>)["authorization"])).toEqual(["Bearer oc_sk_env"]);
  });

  it("does not read an OpenCode 2 credential over MAX_READ_BYTES", async () => {
    opencodeStore([{ value: { type: "key", key: "oc_sk_big", pad: "x".repeat(MAX_READ_BYTES) } }]);
    expect((await new UsageService(context("linux"), only("opencode")).report()).providers).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reads auth.json beside an OpenCode 1 store", async () => {
    opencodeStore([], undefined, true);
    write(join(home, ".local", "share", "opencode", "auth.json"), { "opencode-go": { type: "api", key: "oc_sk_file" } });
    replies.set("https://opencode.ai/zen/go/v1/usage", { body: { usage: { weekly: { percent: 7 } } } });
    const [usage] = (await new UsageService(context("linux"), only("opencode")).report()).providers;
    expect(usage).toMatchObject({ id: "opencode", windows: [{ kind: "week", scope: null, used_percent: 7 }] });
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer oc_sk_file");
  });

  // OpenCode keeps every sign-in in one file, <XDG data>/opencode/auth.json (xdg-basedir: on macOS
  // too), keyed by provider; it has no keychain item, and the file names no account
  it("reads OpenCode's auth.json under XDG_DATA_HOME, its Go key before its Zen key", async () => {
    const data = join(home, "data");
    write(join(data, "opencode", "auth.json"), {
      opencode: { type: "api", key: "oc_sk_zen" },
      "opencode-go": { type: "api", key: "oc_sk_go" },
    });
    replies.set("https://opencode.ai/zen/go/v1/usage", { body: { usage: { weekly: { percent: 5 } } } });
    const [usage] = (await new UsageService({ ...context("linux"), env: { USER: "me", XDG_DATA_HOME: data } }, only("opencode")).report()).providers;
    expect(usage).toMatchObject({ id: "opencode", account: null, windows: [{ kind: "week", scope: null, used_percent: 5 }] });
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer oc_sk_go");
  });

  it("looks for OpenCode nowhere else: no keychain, no config directory, no other provider's key", async () => {
    keychain.set("opencode|", { status: "found", value: JSON.stringify({ "opencode-go": { type: "api", key: "oc_sk_keychain" } }) });
    const custom = join(home, "custom-opencode");
    for (const dir of [custom, join(home, ".config", "opencode"), join(home, "Library", "Application Support", "opencode")]) {
      write(join(dir, "auth.json"), { "opencode-go": { type: "api", key: "oc_sk_elsewhere" } });
    }
    write(join(home, ".local", "share", "opencode", "auth.json"), { anthropic: { type: "api", key: "oc_sk_not_opencode" } });
    const report = await new UsageService({ ...context("darwin"), env: { USER: "me", OPENCODE_CONFIG_DIR: custom, OPENCODE_GO_API_KEY: "oc_sk_unknown_variable" } }, only("opencode")).report();
    expect(report.providers).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reads OpenCode from OPENCODE_API_KEY environment variable", async () => {
    replies.set("https://opencode.ai/zen/go/v1/usage", { body: { usage: { weekly: { percent: 8 } } } });
    const [usage] = (await new UsageService({ ...context("linux"), env: { USER: "me", OPENCODE_API_KEY: "oc_sk_env" } }, only("opencode")).report()).providers;
    expect(usage).toMatchObject({ id: "opencode", windows: [{ kind: "week", scope: null, used_percent: 8 }] });
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer oc_sk_env");
  });

  it("treats HTTP 403 from OpenCode Go as null usage for accounts without a Go subscription", async () => {
    write(join(home, ".local", "share", "opencode", "auth.json"), { opencode: { type: "api", key: "oc_sk_no_sub" } });
    replies.set("https://opencode.ai/zen/go/v1/usage", { status: 403, body: { type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } } });
    const report = await new UsageService(context("linux"), only("opencode")).report();
    expect(requests).toHaveLength(1);
    expect(report.providers).toEqual([]);
  });
});

describe("the service", () => {
  it("never sends an expired token, and says the sign-in expired", async () => {
    signInCodex(NOW / 1000 - 60);
    const [usage] = (await new UsageService(context(), only("codex")).report()).providers;
    expect(usage).toEqual({ id: "codex", key: "codex:user-1__acct-1", account: "me@example.com", plan: "plus", windows: [], problem: "expired", checked_at: null });
    expect(requests).toEqual([]);
  });

  it("names a keychain it cannot read instead of hiding the provider", async () => {
    keychain.set("Claude Code-credentials|me", { status: "locked" });
    const [usage] = (await new UsageService(context("darwin"), only("claude")).report()).providers;
    expect(usage).toMatchObject({ id: "claude", problem: "locked", windows: [] });
    expect(requests).toEqual([]);
  });

  it("answers from its cache until FRESH_MS, and a forced refresh only after MIN_REFRESH_MS", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    replies.set(CODEX_USAGE, codexReply());
    const service = new UsageService(context(), only("codex"));
    await service.report();
    now += MIN_REFRESH_MS - 1;
    await service.report(true);
    expect(requests).toHaveLength(1);
    now += 1;
    await service.report(true);
    expect(requests).toHaveLength(2);
    now += FRESH_MS - 1;
    await service.report();
    expect(requests).toHaveLength(2);
    now += 1;
    await service.report();
    expect(requests).toHaveLength(3);
  });

  it("shares one pass between concurrent callers", async () => {
    signInCodex();
    replies.set(CODEX_USAGE, codexReply());
    const service = new UsageService(context(), only("codex"));
    const [a, b] = await Promise.all([service.report(), service.report()]);
    expect(a).toBe(b);
    expect(requests).toHaveLength(1);
  });

  it("runs a refresh that arrives during a plain pass after it, so a cached provider is asked again", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "c", expiresAt: NOW + 24 * HOUR } });
    const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";
    replies.set(CODEX_USAGE, codexReply());
    replies.set(CLAUDE_USAGE, { status: 500 });
    const service = new UsageService(context(), [...only("claude"), ...only("codex")]);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await service.report();
      now += RETRY_MS;
      let open!: () => void;
      replies.set(CLAUDE_USAGE, { body: { five_hour: { utilization: 1, resets_at: null } }, gate: new Promise((resolve) => { open = resolve; }) });
      const plain = service.report();
      const forced = service.report(true);
      expect(forced).not.toBe(plain);
      open();
      await plain;
      await forced;
      expect(requests.filter((request) => request.url === CODEX_USAGE)).toHaveLength(2);
    } finally { console.warn = warn; }
  });

  it("keeps the last numbers through a refused token and a rate limit, and waits out Retry-After", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    replies.set(CODEX_USAGE, codexReply(50));
    const service = new UsageService(context(), only("codex"));
    const first = (await service.report()).providers[0]!;

    now += FRESH_MS;
    replies.set(CODEX_USAGE, { status: 401 });
    expect((await service.report()).providers[0]).toEqual({ ...first, problem: "expired" });

    now += RETRY_MS;
    replies.set(CODEX_USAGE, { status: 429, headers: { "retry-after": "600" } });
    expect((await service.report()).providers[0]).toEqual({ ...first, problem: "rate_limited" });
    const asked = requests.length;
    now += 599_000;
    await service.report(true);
    expect(requests).toHaveLength(asked);

    now += 1000;
    replies.set(CODEX_USAGE, codexReply(60));
    const recovered = (await service.report()).providers[0]!;
    expect(recovered.problem).toBeNull();
    expect(recovered.windows[1]!.used_percent).toBe(60);
  });

  it("drops an account whose sign-in is gone, and finds a new one at the next search", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    replies.set(CODEX_USAGE, codexReply());
    const service = new UsageService(context(), only("codex"));
    expect((await service.report()).providers).toHaveLength(1);
    rmSync(join(home, ".codex"), { recursive: true });
    signInCodex(NOW / 1000 + 24 * 3600, ".codex-other", "user-2", "other@example.com");
    now += FRESH_MS;
    expect((await service.report()).providers.map((usage) => usage.account)).toEqual(["other@example.com"]);
  });

  it("marks a failed request and asks again after RETRY_MS", async () => {
    signInCodex(NOW / 1000 + 24 * 3600);
    replies.set(CODEX_USAGE, { status: 500 });
    const service = new UsageService(context(), only("codex"));
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect((await service.report()).providers[0]!.problem).toBe("failed");
      now += RETRY_MS;
      replies.set(CODEX_USAGE, codexReply());
      expect((await service.report()).providers[0]!.problem).toBeNull();
    } finally { console.warn = warn; }
  });
});

describe("bounded reads", () => {
  it("treats a credential file over MAX_READ_BYTES as no sign-in", async () => {
    write(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: jwt({ exp: NOW / 1000 + 3600 }) }, pad: "x".repeat(MAX_READ_BYTES) }));
    expect((await new UsageService(context(), only("codex")).report()).providers).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("reads an answer over MAX_READ_BYTES as a failure, not a report", async () => {
    signInCodex();
    replies.set(CODEX_USAGE, { body: { plan_type: "pro", pad: "x".repeat(MAX_READ_BYTES) } });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect((await new UsageService(context(), only("codex")).report()).providers[0]!.problem).toBe("failed");
    } finally { console.warn = warn; }
  });

  it("bounds commands by their supplied timeout and keeps successful output", async () => {
    expect(await runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], 100)).toBeNull();
    expect(await runCommand([process.execPath, "-e", "console.log('ok')"], 5000)).toBe("ok");
  });

  it("gives up on a command whose output passes MAX_READ_BYTES", async () => {
    expect(await runCommand([process.execPath, "-e", `process.stdout.write(Buffer.alloc(${MAX_READ_BYTES + 1}))`])).toBeNull();
    expect(await runCommand([process.execPath, "-e", "process.stdout.write(Buffer.alloc(3))"])).toBe("\0\0\0");
  });
});

describe("GET /api/usage", () => {
  it("answers the report uncached and refuses other methods", async () => {
    signInCodex();
    replies.set(CODEX_USAGE, codexReply());
    const service = new UsageService(context(), only("codex"));
    const response = await handleUsageRequest(new Request("http://x/api/usage"), new URL("http://x/api/usage"), service);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await response.json()) as UsageReport).providers[0]!.id).toBe("codex");
    const refused = await handleUsageRequest(new Request("http://x/api/usage", { method: "POST" }), new URL("http://x/api/usage"), service);
    expect(refused.status).toBe(405);
  });
});

describe("accounts across reads (review fixes)", () => {
  /** a provider whose sign-ins and answers the test sets: `found` by place, `answer` by token */
  function fake(found: () => Array<Record<string, unknown>>, answer: (token: string) => unknown): UsageProvider {
    return {
      id: "codex",
      signIns: async () => found() as never,
      read: async (_ctx, signIn) => {
        const reply = answer(signIn.token);
        if (reply instanceof Error) throw reply;
        return reply as never;
      },
    };
  }
  const window = (used: number) => ({ kind: "session" as const, scope: "5h", used_percent: used, resets_at: null, starts_at: null });

  it("does not show the previous account's numbers when the same place now holds another account's failing sign-in", async () => {
    let signIn = { source: "/home/me/.codex", token: "alice-token", expiresAt: null, account: { id: "alice", label: "alice@example.com" } };
    const service = new UsageService(context(), [fake(() => [signIn], (token) => token === "alice-token" ? { plan: "plus", windows: [window(40)] } : new UsageHttpError(401, null))]);
    expect((await service.report()).providers.map((u) => [u.key, u.account])).toEqual([["codex:alice", "alice@example.com"]]);
    signIn = { source: "/home/me/.codex", token: "bob-token", expiresAt: null, account: { id: "bob", label: "bob@example.com" } };
    now += FRESH_MS;
    const [usage] = (await service.report(true)).providers;
    expect(usage).toMatchObject({ key: "codex:bob", account: "bob@example.com", problem: "expired", windows: [], plan: null });
  });

  it("keeps a 429's wait for the account when its sign-in moves to another place", async () => {
    let place = "/home/me/.codex";
    let asked = 0;
    const service = new UsageService(context(), [fake(() => [{ source: place, token: "t", expiresAt: null, account: { id: "acct", label: null } }], () => {
      asked++;
      return new UsageHttpError(429, HOUR);
    })]);
    expect((await service.report()).providers[0]!.problem).toBe("rate_limited");
    place = "/home/me/.codex-work";
    now += MIN_REFRESH_MS;
    expect((await service.report(true)).providers[0]!.problem).toBe("rate_limited");
    expect(asked).toBe(1);
  });

  it("numbers sign-ins of one provider that name no account, and never shows where they were found", async () => {
    const service = new UsageService(context(), [fake(() => [
      { source: "/home/me/.codex-a", token: "a", expiresAt: null },
      { source: "/home/me/.codex-b", token: "b", expiresAt: null },
    ], () => ({ plan: null, windows: [window(10)] }))]);
    const { providers } = await service.report();
    expect(providers.map((u) => u.account).sort()).toEqual(["#1", "#2"]);
    expect(JSON.stringify(providers)).not.toContain("/home/me");
  });

  it("reads a GitHub CLI sign-in that comes from GH_TOKEN without a per-user lookup", async () => {
    const status = JSON.stringify({ hosts: { "github.com": [{ state: "success", login: "alice", tokenSource: "GH_TOKEN" }] } });
    commands.set("gh auth status --hostname github.com --json hosts", status);
    // what a CLI without --hostname would answer too: the account path must be the one taken
    commands.set("gh auth status --json hosts", status);
    commands.set("gh auth token --hostname github.com", "gho_env");
    replies.set("https://api.github.com/copilot_internal/user", { body: { login: "alice", copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 50 } } } });
    const report = await new UsageService(context(), only("copilot")).report();
    expect(report.providers.map((u) => [u.key, u.problem])).toEqual([["copilot:alice", null]]);
    expect((requests[0]!.init.headers as Record<string, string>)["authorization"]).toBe("token gho_env");
  });

  it("asks each editor token of no known login on its own", async () => {
    write(join(home, ".config", "github-copilot", "apps.json"), {
      "github.com:Iv1.a": { oauth_token: "gho_a" }, "github.com:Iv1.b": { oauth_token: "gho_b" },
    });
    const service = new UsageService({ ...context(), async fetch(target, init) {
      requests.push({ url: target, init });
      const login = (init.headers as Record<string, string>)["authorization"] === "token gho_a" ? "alice" : "bob";
      return new Response(JSON.stringify({ login, copilot_plan: "individual", quota_snapshots: { chat: { entitlement: 50, percent_remaining: 50 } } }));
    } }, only("copilot"));
    const keys = (await service.report()).providers.map((u) => u.key).sort();
    expect(keys).toEqual(["copilot:alice", "copilot:bob"]);
  });
});
