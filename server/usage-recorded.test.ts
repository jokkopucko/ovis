import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderUsage, UsageProblem } from "../shared/protocol.ts";
import { FRESH_MS, MIN_REFRESH_MS, UsageHttpError, UsageService, type UsageContext, type UsageProvider } from "./usage.ts";
import type { RecordedReading, RecordedSource, RecordedWindow } from "./usage-recorded.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 86400;
const iso = (at: number): string => new Date(at).toISOString();

let home: string;
let now: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "herdr-usage-recorded-"));
  now = NOW;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function context(): UsageContext {
  return {
    home, platform: "linux", env: {},
    now: () => now,
    fetch: async (url) => { throw new Error(`unexpected request ${url}`); },
    keychain: async () => ({ status: "missing" }),
    run: async () => null,
    has: () => true,
  };
}

const session = (usedPercent: number, resetsAt: number | null): RecordedWindow => ({ kind: "session", scope: null, usedPercent, resetsAt, seconds: FIVE_HOURS });
const week = (usedPercent: number, resetsAt: number | null): RecordedWindow => ({ kind: "week", scope: null, usedPercent, resetsAt, seconds: SEVEN_DAYS });

function record(readAt: number, windows: readonly RecordedWindow[] = [session(42, NOW + 3 * HOUR)], accountId = "acct-1"): RecordedReading {
  return { accountId, label: "me@example.com", readAt, windows };
}

function recordedBy(readings: () => readonly RecordedReading[], staleAfterMs = 15 * MINUTE): RecordedSource {
  return { by: "omp", staleAfterMs, read: () => [...readings()] };
}

function recordedOnly(...sources: RecordedSource[]): UsageProvider {
  return { id: "claude", recorded: sources, async signIns() { return []; }, async read() { return null; } };
}

function ownSignIn(source: RecordedSource | null, refusal: () => UsageHttpError | null = () => null, capturedAt: number | null = null): UsageProvider {
  return {
    id: "claude",
    recorded: source ? [source] : [],
    async signIns() { return [{ source: "default", token: "own-token", expiresAt: null, plan: "max", account: { id: "acct-1", label: "me@example.com" } }]; },
    readLocal() {
      return capturedAt === null ? null : { plan: null, windows: [{ kind: "session", scope: null, used_percent: 20, resets_at: iso(NOW + 2 * HOUR), starts_at: null }], checkedAt: capturedAt };
    },
    async read() {
      const refused = refusal();
      if (refused) throw refused;
      return { plan: null, windows: [{ kind: "session", scope: null, used_percent: 10, resets_at: iso(NOW + 2 * HOUR), starts_at: null }] };
    },
  };
}

async function listed(...providers: UsageProvider[]): Promise<readonly ProviderUsage[]> {
  return (await new UsageService(context(), providers).report()).providers;
}

describe("an account another tool recorded", () => {
  it("is listed with the limits and the time that tool read them, named as its record", async () => {
    const source = recordedBy(() => [record(NOW - 4 * MINUTE, [session(42, NOW + 3 * HOUR), week(13.44, NOW + 4 * DAY), { kind: "week", scope: "Fable", usedPercent: 7, resetsAt: null, seconds: SEVEN_DAYS }])]);
    expect(await listed(recordedOnly(source))).toEqual([{
      id: "claude", key: "claude:acct-1", account: "me@example.com", plan: null, problem: null, checked_at: iso(NOW - 4 * MINUTE),
      windows: [
        { kind: "session", scope: null, used_percent: 42, resets_at: iso(NOW + 3 * HOUR), starts_at: iso(NOW - 2 * HOUR) },
        { kind: "week", scope: null, used_percent: 13.4, resets_at: iso(NOW + 4 * DAY), starts_at: iso(NOW - 3 * DAY) },
        { kind: "week", scope: "Fable", used_percent: 7, resets_at: null, starts_at: null },
      ],
      recorded: { by: "omp", stale: false, signed_in: false },
    }]);
  });

  it("keeps a used share inside 0 to 100", async () => {
    const [usage] = await listed(recordedOnly(recordedBy(() => [record(NOW, [session(104.2, NOW + HOUR), week(-3, NOW + DAY)])])));
    expect(usage?.windows.map((window) => window.used_percent)).toEqual([100, 0]);
  });

  it("is stale once the tool has not read for longer than it leaves between its reads", async () => {
    const provider = recordedOnly(recordedBy(() => [record(NOW)], 15 * MINUTE));
    now = NOW + 15 * MINUTE;
    expect((await listed(provider))[0]?.recorded).toEqual({ by: "omp", stale: false, signed_in: false });
    now += 1;
    expect((await listed(provider))[0]?.recorded).toEqual({ by: "omp", stale: true, signed_in: false });
  });

  it("says its own time with each report, as the report leaves: a page counts a record's age from it", async () => {
    const service = new UsageService(context(), [recordedOnly(recordedBy(() => [record(NOW)]))], async () => { now += 30_000; return []; });
    expect((await service.report()).server_time).toBe(iso(NOW + 30_000));
    now = NOW + 7 * MINUTE;
    expect((await service.report()).server_time).toBe(iso(NOW + 7 * MINUTE + 30_000));
  });

  it("reads a tool's store once for the reports of half a minute, and again after that", async () => {
    let reads = 0;
    const service = new UsageService(context(), [recordedOnly(recordedBy(() => { reads += 1; return [record(NOW)]; }))]);
    await service.report();
    now = NOW + MIN_REFRESH_MS - 1;
    expect((await service.report()).providers.map((usage) => usage.key)).toEqual(["claude:acct-1"]);
    expect(reads).toBe(1);
    now = NOW + MIN_REFRESH_MS;
    await service.report();
    expect(reads).toBe(2);
  });

  it("judges a record it keeps from its last read by the time of each report", async () => {
    let reads = 0;
    const service = new UsageService(context(), [recordedOnly(recordedBy(() => { reads += 1; return [record(NOW)]; }, 15 * MINUTE))]);
    now = NOW + 15 * MINUTE;
    expect((await service.report()).providers[0]?.recorded).toMatchObject({ stale: false });
    now += 1;
    expect((await service.report()).providers[0]?.recorded).toMatchObject({ stale: true });
    expect(reads).toBe(1);
  });

  it("loses a limit whose window has turned over, and one that names no reset once it is older than its window", async () => {
    const limits = async (readAt: number, windows: readonly RecordedWindow[]) =>
      (await listed(recordedOnly(recordedBy(() => [record(readAt, windows)]))))[0]?.windows.map((window) => window.kind) ?? [];
    expect(await limits(NOW - 6 * HOUR, [session(90, NOW - HOUR), week(13, NOW + 2 * DAY)])).toEqual(["week"]);
    expect(await limits(NOW - 6 * HOUR, [session(90, NOW), week(13, NOW + 2 * DAY)])).toEqual(["week"]);
    expect(await limits(NOW - 5 * HOUR + 1, [session(90, null), week(13, null)])).toEqual(["session", "week"]);
    expect(await limits(NOW - 5 * HOUR, [session(90, null), week(13, null)])).toEqual(["week"]);
    expect(await limits(NOW - 7 * DAY, [week(13, null)])).toEqual([]);
  });

  it("is not listed once none of its recorded limits is current", async () => {
    expect(await listed(recordedOnly(recordedBy(() => [record(NOW - 2 * DAY, [session(90, NOW - DAY)])])))).toEqual([]);
  });

  it("is listed once from two tools' records, by the one read last", async () => {
    const older = recordedBy(() => [record(NOW - 20 * MINUTE, [session(30, NOW + 3 * HOUR)])]);
    const newer = recordedBy(() => [record(NOW - 2 * MINUTE, [session(36, NOW + 3 * HOUR)])]);
    for (const sources of [[older, newer], [newer, older]]) {
      const accounts = await listed(recordedOnly(...sources));
      expect(accounts.map((usage) => [usage.key, usage.checked_at, usage.windows[0]?.used_percent])).toEqual([["claude:acct-1", iso(NOW - 2 * MINUTE), 36]]);
    }
  });

  it("keeps its place among recorded accounts whichever of them was read last", async () => {
    const source = recordedBy(() => [record(NOW - MINUTE, undefined, "acct-b"), record(NOW - 9 * MINUTE, undefined, "acct-a")]);
    expect((await listed(recordedOnly(source))).map((usage) => usage.key)).toEqual(["claude:acct-a", "claude:acct-b"]);
  });

  it("comes after this PC's own accounts and before a hub's", async () => {
    const codex: UsageProvider = {
      id: "codex",
      async signIns() { return [{ source: "codex-home", token: "codex-token", expiresAt: null, account: { id: "work", label: "me@work.example" } }]; },
      async read() { return { plan: "pro", windows: [] }; },
    };
    const hub: ProviderUsage = { id: "claude", key: "claude:cliproxy:team", account: "team", plan: null, windows: [], problem: null, checked_at: iso(NOW) };
    const service = new UsageService(context(), [recordedOnly(recordedBy(() => [record(NOW)])), codex], async () => [hub]);
    expect((await service.report()).providers.map((usage) => usage.key)).toEqual(["codex:work", "claude:acct-1", "claude:cliproxy:team"]);
  });
});

describe("an account this PC is signed in to and another tool recorded", () => {
  it("shows this PC's own reading while that is current, however new the record", async () => {
    const service = new UsageService(context(), [ownSignIn(recordedBy(() => [record(NOW + 2 * MINUTE)]))]);
    await service.report();
    now = NOW + 3 * MINUTE;
    const accounts = (await service.report()).providers;
    expect(accounts).toEqual([expect.objectContaining({ key: "claude:acct-1", plan: "max", problem: null, checked_at: iso(NOW), windows: [expect.objectContaining({ used_percent: 10 })] })]);
    expect(accounts[0]).not.toHaveProperty("recorded");
  });

  it("puts the record's numbers in place of a sign-in that is refused, which stays this PC's: its plan, its problem", async () => {
    const own = ownSignIn(recordedBy(() => [record(NOW - 4 * MINUTE)]), () => new UsageHttpError(401, null));
    expect(await listed(own)).toEqual([{
      id: "claude", key: "claude:acct-1", account: "me@example.com", plan: "max", problem: "expired", checked_at: iso(NOW - 4 * MINUTE),
      windows: [{ kind: "session", scope: null, used_percent: 42, resets_at: iso(NOW + 3 * HOUR), starts_at: iso(NOW - 2 * HOUR) }],
      recorded: { by: "omp", stale: false, signed_in: true },
    }]);
  });

  it("still offers Claude's status line for a sign-in the network refuses while a record stands in", async () => {
    const refused = () => new UsageHttpError(403, null);
    expect((await listed(ownSignIn(null, refused)))[0]).toMatchObject({ problem: "expired", statusline_offer: true });
    expect((await listed(ownSignIn(recordedBy(() => [record(NOW - 4 * MINUTE)]), refused)))[0]).toMatchObject({ problem: "expired", statusline_offer: true, recorded: { signed_in: true } });
  });

  it("keeps the name this PC's sign-in gives the account, and takes the record's where it gives none", async () => {
    const renamed = recordedBy(() => [{ ...record(NOW - 4 * MINUTE), label: "alias@example.com" }]);
    const expired = () => new UsageHttpError(401, null);
    expect((await listed(ownSignIn(renamed, expired)))[0]?.account).toBe("me@example.com");
    const unnamed: UsageProvider = { ...ownSignIn(renamed, expired), async signIns() { return [{ source: "default", token: "own-token", expiresAt: null, account: { id: "acct-1", label: null } }]; } };
    expect((await listed(unnamed))[0]).toMatchObject({ key: "claude:acct-1", account: "alias@example.com" });
  });

  it("shows whichever was read later once this PC's own read fails: its kept numbers, or a newer record's with the failure still told", async () => {
    const cases: ReadonlyArray<{ recordedAt: number; shown: { problem: UsageProblem | null; checked_at: string; used: number; recorded: ProviderUsage["recorded"] } }> = [
      { recordedAt: NOW + 4 * MINUTE, shown: { problem: "failed", checked_at: iso(NOW + 4 * MINUTE), used: 42, recorded: { by: "omp", stale: false, signed_in: true } } },
      { recordedAt: NOW - 10 * MINUTE, shown: { problem: "failed", checked_at: iso(NOW), used: 10, recorded: undefined } },
    ];
    for (const { recordedAt, shown } of cases) {
      now = NOW;
      let down = false;
      const service = new UsageService(context(), [ownSignIn(recordedBy(() => [record(recordedAt)]), () => down ? new UsageHttpError(500, null) : null)]);
      await service.report();
      down = true;
      now = NOW + FRESH_MS + 1;
      const [usage] = (await service.report()).providers;
      expect({ problem: usage?.problem, checked_at: usage?.checked_at, used: usage?.windows[0]?.used_percent, recorded: usage?.recorded }).toEqual(shown);
    }
  });

  it("leaves out the credits and limit resets this PC read before: the record standing in holds neither", async () => {
    let down = false;
    const own: UsageProvider = {
      ...ownSignIn(recordedBy(() => [record(NOW + 4 * MINUTE)])),
      async read() {
        if (down) throw new UsageHttpError(500, null);
        return {
          plan: null, windows: [{ kind: "session", scope: null, used_percent: 10, resets_at: iso(NOW + 2 * HOUR), starts_at: null }],
          credits: { kind: "spend", currency: "USD", used: 12.5, limit: 50, used_percent: 25 }, resets: { available: 2, expires_at: null },
        };
      },
    };
    const service = new UsageService(context(), [own]);
    expect((await service.report()).providers[0]).toMatchObject({ credits: { kind: "spend" }, resets: { available: 2 } });
    down = true;
    now = NOW + FRESH_MS + 1;
    const [usage] = (await service.report()).providers;
    expect(usage).toMatchObject({ problem: "failed", recorded: { signed_in: true }, windows: [{ used_percent: 42 }] });
    expect(usage).not.toHaveProperty("credits");
    expect(usage).not.toHaveProperty("resets");
  });

  it("shows a newer record over a local capture of this PC's own that is hours old", async () => {
    const refused = () => new UsageHttpError(403, null);
    expect(await listed(ownSignIn(null, refused, NOW - 2 * HOUR))).toEqual([expect.objectContaining({ problem: null, checked_at: iso(NOW - 2 * HOUR) })]);
    const [usage] = await listed(ownSignIn(recordedBy(() => [record(NOW - 5 * MINUTE)]), refused, NOW - 2 * HOUR));
    expect(usage).toMatchObject({ key: "claude:acct-1", plan: "max", problem: null, checked_at: iso(NOW - 5 * MINUTE), recorded: { by: "omp", stale: false, signed_in: true }, windows: [{ used_percent: 42 }] });
  });
});

describe("a tool's store that cannot be read", () => {
  it("costs only its own accounts: the report still lists this PC's own", async () => {
    const broken: RecordedSource = { by: "omp", staleAfterMs: 15 * MINUTE, read: () => { throw new Error("store unreadable"); } };
    expect((await listed(ownSignIn(broken))).map((usage) => [usage.key, usage.problem])).toEqual([["claude:acct-1", null]]);
  });
});
