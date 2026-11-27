import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUsageRequest, UsageService, type UsageContext } from "./usage.ts";
import { kimiUsage } from "./usage-kimi.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const HOUR = 3600_000;

type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; error?: Error };

let home: string;
let now: number;
let replies: Map<string, Reply>;
let requests: Array<{ url: string; init: RequestInit }>;

function context(env: Record<string, string | undefined> = {}): UsageContext {
  return {
    home, platform: "linux", env,
    now: () => now,
    async fetch(url, init) {
      requests.push({ url, init });
      const reply = replies.get(url);
      if (!reply) throw new Error(`unexpected request ${url}`);
      if (reply.error) throw reply.error;
      return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers });
    },
    keychain: async () => ({ status: "missing" }),
    run: async () => null,
    has: () => false,
  };
}

function write(path: string, value: unknown) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
}

function scopedName(oauthHost: string, baseUrl: string): string {
  const digest = createHash("sha256").update(JSON.stringify({ oauthHost, baseUrl })).digest("hex").slice(0, 16);
  return `kimi-code-env-${digest}`;
}

function signInKimi(dir = join(home, ".kimi-code"), name = "kimi-code", expiresAt = NOW / 1000 + HOUR / 1000) {
  write(join(dir, "credentials", `${name}.json`), {
    access_token: `fixture-token-${dir}-${name}`, refresh_token: "r", expires_at: expiresAt,
    scope: "all", token_type: "Bearer", expires_in: 3600,
  });
}

const KIMI_USAGE = "https://api.kimi.com/coding/v1/usages";
const KIMI_ME = "https://api.kimi.com/coding/v1/me";

function usageReply(): Reply {
  return {
    body: {
      usages: {
        limit_5h: { used_ratio: 0.25, reset_time: new Date(NOW + 2 * HOUR).toISOString() },
        limit_7d: { used_ratio: 0.5, reset_time: new Date(NOW + 3 * 24 * HOUR).toISOString() },
        limit_month_total: { used_ratio: 0.8, reset_time: new Date(NOW + 10 * 24 * HOUR).toISOString() },
        limit_month_code: { used_ratio: 0.3 },
      },
      boosterWallet: {
        balance: { type: "BOOSTER", amount: 5_000_000, amountLeft: 2_500_000 },
        monthlyChargeLimitEnabled: true,
        monthlyChargeLimit: { priceInCents: 1000, currency: "USD" },
        monthlyUsed: { priceInCents: 400, currency: "USD" },
      },
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "herdr-usage-kimi-"));
  now = NOW;
  replies = new Map();
  requests = [];
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("kimi usage provider", () => {
  it("lists nothing without a Kimi sign-in, and asks no one", async () => {
    const report = await new UsageService(context(), [kimiUsage]).report();
    expect(report).toEqual({ server_time: expect.any(String), providers: [] });
    expect(requests).toEqual([]);
  });

  it("reads the plan limits and extra usage of the default sign-in, and names the account from its profile", async () => {
    signInKimi();
    replies.set(KIMI_USAGE, usageReply());
    replies.set(KIMI_ME, { body: { user_id: "u-1", nickname: "Kimi Fan", email: "fan@example.test" } });
    const report = await new UsageService(context(), [kimiUsage]).report();
    expect(report.providers).toEqual([{
      id: "kimi", key: "kimi:u-1", account: "Kimi Fan", plan: null, problem: null, checked_at: new Date(NOW).toISOString(),
      windows: [
        { kind: "session", scope: null, used_percent: 25, resets_at: new Date(NOW + 2 * HOUR).toISOString(), starts_at: null },
        { kind: "week", scope: null, used_percent: 50, resets_at: new Date(NOW + 3 * 24 * HOUR).toISOString(), starts_at: null },
        { kind: "month", scope: null, used_percent: 80, resets_at: new Date(NOW + 10 * 24 * HOUR).toISOString(), starts_at: null },
        { kind: "month", scope: "Code", used_percent: 30, resets_at: null, starts_at: null },
      ],
      credits: { kind: "spend", currency: "USD", used: 4, limit: 10, used_percent: 40 },
    }]);
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toStartWith("Bearer ");
  });

  it("reads the sign-in KIMI_CODE_HOME names", async () => {
    const dir = join(home, "elsewhere");
    signInKimi(dir);
    replies.set(KIMI_USAGE, usageReply());
    replies.set(KIMI_ME, { status: 404 });
    const report = await new UsageService(context({ KIMI_CODE_HOME: dir }), [kimiUsage]).report();
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]!.windows).toHaveLength(4);
    expect(report.providers[0]!.account).toBeNull();
    expect(report.providers[0]!.key).toMatch(/^kimi@[0-9a-f]{12}$/);
  });

  it("asks the global region's API for a global sign-in", async () => {
    signInKimi(join(home, ".kimi-code"), scopedName("https://auth.kimi.ai", "https://api.kimi.ai/coding/v1"));
    replies.set("https://api.kimi.ai/coding/v1/usages", usageReply());
    replies.set("https://api.kimi.ai/coding/v1/me", { status: 404 });
    const report = await new UsageService(context(), [kimiUsage]).report();
    expect(report.providers).toHaveLength(1);
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.kimi.ai/coding/v1/usages",
      "https://api.kimi.ai/coding/v1/me",
    ]);
  });

  it("never reads a sign-in scoped to an API base that is not Kimi's, and so sends its token nowhere", async () => {
    const name = scopedName("https://auth.kimi.com", "https://gw.example.com");
    signInKimi(join(home, ".kimi-code"), name);
    const env = { KIMI_CODE_BASE_URL: "https://gw.example.com" };
    const report = await new UsageService(context(env), [kimiUsage]).report();
    expect(report.providers).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("refuses a redirect, so the token is not carried to another host", async () => {
    signInKimi(join(home, ".kimi-code"));
    replies.set("https://api.kimi.com/coding/v1/usages", usageReply());
    replies.set("https://api.kimi.com/coding/v1/me", { status: 404 });
    await new UsageService(context(), [kimiUsage]).report();
    expect(requests.map((request) => request.init?.redirect)).toEqual(["error", "error"]);
  });

  it("says why the limits could not be read: a page that is not its usage, or a redirect it refused", async () => {
    signInKimi();
    const warn = console.warn;
    console.warn = () => {};
    try {
      replies.set(KIMI_USAGE, { raw: "<!DOCTYPE html><title>Just a moment...</title>" });
      expect((await new UsageService(context(), [kimiUsage]).report()).providers[0]).toMatchObject({ problem: "failed", failure: "bad_response" });
      // fetch with redirect: "error" rejects with a TypeError when the answer is a redirect
      replies.set(KIMI_USAGE, { error: new TypeError("fetch failed: unexpected redirect") });
      expect((await new UsageService(context(), [kimiUsage]).report()).providers[0]).toMatchObject({ problem: "failed", failure: "network" });
    } finally { console.warn = warn; }
  });

  it("keeps the last reading when Kimi answers without usages", async () => {
    signInKimi();
    replies.set(KIMI_USAGE, usageReply());
    replies.set(KIMI_ME, { status: 404 });
    const service = new UsageService(context(), [kimiUsage]);
    expect((await service.report()).providers[0]!.windows).toHaveLength(4);
    replies.set(KIMI_USAGE, { body: { code: "internal_error", message: "try again" } });
    now += 10 * 60_000;
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect((await service.report()).providers[0]).toMatchObject({ problem: "failed", failure: "bad_response", windows: [expect.anything(), expect.anything(), expect.anything(), expect.anything()] });
    } finally { console.warn = warn; }
  });

  it("names Kimi only to a client that lists it in ?providers=, as a phone app from before it does not", async () => {
    signInKimi();
    replies.set(KIMI_USAGE, usageReply());
    replies.set(KIMI_ME, { status: 404 });
    const service = new UsageService(context(), [kimiUsage]);
    const ids = async (path: string) => ((await (await handleUsageRequest(new Request(`http://localhost${path}`), new URL(`http://localhost${path}`), service)).json()) as { providers: { id: string }[] }).providers.map((usage) => usage.id);
    expect(await ids("/api/usage?providers=claude,kimi")).toEqual(["kimi"]);
    expect(await ids("/api/usage")).toEqual([]);
  });

  it("reports an expired token without asking the API", async () => {
    signInKimi(join(home, ".kimi-code"), "kimi-code", NOW / 1000 - 60);
    const report = await new UsageService(context(), [kimiUsage]).report();
    expect(report.providers).toMatchObject([{ id: "kimi", problem: "expired", windows: [] }]);
    expect(requests).toEqual([]);
  });

  it("reports a refused token as expired", async () => {
    signInKimi();
    replies.set(KIMI_USAGE, { status: 401 });
    const report = await new UsageService(context(), [kimiUsage]).report();
    expect(report.providers).toMatchObject([{ id: "kimi", problem: "expired" }]);
  });

  it("reads a token file without an expiry and reports the API's answer", async () => {
    const dir = join(home, ".kimi-code");
    write(join(dir, "credentials", "kimi-code.json"), { access_token: "fixture-token", refresh_token: "r" });
    replies.set(KIMI_USAGE, { body: { usages: { limit_5h: { used_ratio: 0.1 } } } });
    replies.set(KIMI_ME, { status: 404 });
    const report = await new UsageService(context(), [kimiUsage]).report();
    expect(report.providers[0]!.windows).toEqual([
      { kind: "session", scope: null, used_percent: 10, resets_at: null, starts_at: null },
    ]);
    expect(report.providers[0]!.problem).toBeNull();
    expect(report.providers[0]!).not.toHaveProperty("credits");
  });

  it("ignores credential files that are not Kimi Code's", async () => {
    write(join(home, ".kimi-code", "credentials", "some-other-tool.json"), { access_token: "fixture-token" });
    const report = await new UsageService(context(), [kimiUsage]).report();
    expect(report.providers).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("honors the Retry-After of a 429 from the profile endpoint", async () => {
    signInKimi(join(home, ".kimi-code"), "kimi-code", NOW / 1000 + 2 * HOUR / 1000);
    replies.set(KIMI_USAGE, usageReply());
    replies.set(KIMI_ME, { status: 429, headers: { "retry-after": "3600" } });
    const service = new UsageService(context(), [kimiUsage]);
    const first = await service.report();
    expect(first.providers).toMatchObject([{ id: "kimi", problem: "rate_limited", windows: [] }]);
    expect(requests.map((request) => request.url)).toEqual([KIMI_USAGE, KIMI_ME]);
    // five minutes on, the reading is no longer fresh, but the backoff still stands
    now += 5 * 60_000;
    const again = await service.report();
    expect(again.providers[0]!.problem).toBe("rate_limited");
    expect(requests).toHaveLength(2);
    // once the hour is over, the profile is asked again and names the account
    now += HOUR;
    replies.set(KIMI_ME, { body: { user_id: "u-1", nickname: "Kimi Fan" } });
    const recovered = await service.report();
    expect(recovered.providers).toMatchObject([{ id: "kimi", key: "kimi:u-1", account: "Kimi Fan", problem: null }]);
    expect(recovered.providers[0]!.windows).toHaveLength(4);
  });

  it("keeps the account's identity and last numbers when the profile request fails transiently", async () => {
    signInKimi();
    replies.set(KIMI_USAGE, usageReply());
    replies.set(KIMI_ME, { body: { user_id: "u-1", nickname: "Kimi Fan" } });
    const service = new UsageService(context(), [kimiUsage]);
    const first = await service.report();
    expect(first.providers[0]).toMatchObject({ key: "kimi:u-1", account: "Kimi Fan", problem: null });
    now += 6 * 60_000; // past FRESH_MS: the sign-in is read anew
    replies.set(KIMI_ME, { status: 500 });
    const degraded = await service.report();
    expect(degraded.providers).toMatchObject([{ id: "kimi", key: "kimi:u-1", account: "Kimi Fan", problem: "failed" }]);
    expect(degraded.providers[0]!.windows).toHaveLength(4);
  });

  it.each([401, 403, 408])("keeps the account's identity and last numbers when the profile request is refused with %i", async (status) => {
    signInKimi();
    replies.set(KIMI_USAGE, usageReply());
    replies.set(KIMI_ME, { body: { user_id: "u-1", nickname: "Kimi Fan" } });
    const service = new UsageService(context(), [kimiUsage]);
    const first = await service.report();
    expect(first.providers[0]).toMatchObject({ key: "kimi:u-1", account: "Kimi Fan", problem: null });
    now += 6 * 60_000; // past FRESH_MS: the sign-in is read anew
    replies.set(KIMI_ME, { status });
    const degraded = await service.report();
    // not "expired": /usages just answered, so the sign-in is fine
    expect(degraded.providers).toMatchObject([{ id: "kimi", key: "kimi:u-1", account: "Kimi Fan", problem: "failed" }]);
    expect(degraded.providers[0]!.windows).toHaveLength(4);
  });
});
