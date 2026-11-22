import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { USAGE_PROVIDERS, UsageService, type UsageContext } from "./usage.ts";
import type { RecordedContext } from "./usage-recorded.ts";
import { gjcRecorded } from "./usage-recorded-gjc.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PREFIX = "usage_cache:report:anthropic:default:";
/** the key Gajae Code keeps a sign-in's report under: its kind, then the account, email and organization it signed in to */
const KEY = `${PREFIX}oauth|account:${ACCOUNT}|email:me@example.com|org:${ORG}`;
const SIGN_IN_SECRET = "sentinel-access-token-of-gajae-code";
const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";

/** `cache` as Gajae Code 0.18 to 0.20 create it (packages/ai/src/auth-storage.ts), beside the table that holds its sign-ins. */
const SCHEMA = `
  CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE INDEX idx_cache_expires ON cache(expires_at);
  CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL);
`;

interface Limit {
  id: string;
  label?: string;
  used?: number | string | null;
  resets?: number | null;
}

interface Entry {
  key?: string;
  readAt?: number;
  limits?: readonly Limit[];
  metadata?: Record<string, unknown>;
  reportInstead?: unknown;
  storedTextInstead?: string;
  expiresAtSeconds?: number | string;
}

let home: string;
let now: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "herdr-usage-gjc-"));
  now = NOW;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function recordedContext(env: Record<string, string | undefined> = {}): RecordedContext {
  return { home, env, platform: "linux", now: () => now };
}

/** One limit as Gajae Code's Claude reader writes it (packages/ai/src/usage/claude.ts). */
function limit({ id, label = "Claude", used = 0.5, resets = NOW + 3 * HOUR }: Limit): unknown {
  const week = id.startsWith("anthropic:7d");
  return {
    id, label,
    scope: { provider: "anthropic", windowId: week ? "7d" : "5h" },
    window: { id: week ? "7d" : "5h", label: week ? "7 Day" : "5 Hour", durationMs: week ? 7 * DAY : 5 * HOUR, ...(resets === null ? {} : { resetsAt: resets }) },
    amount: { ...(used === null ? {} : { used: typeof used === "number" ? used * 100 : used, usedFraction: used }), limit: 100, unit: "percent" },
    status: "ok",
  };
}

/** A report as Gajae Code keeps it: its own account id names the organization the limits belong to. */
function report(at: number, limits: readonly Limit[], metadata: Record<string, unknown> = { endpoint: CLAUDE_USAGE, accountId: ORG, email: "me@example.com", orgId: ORG }): unknown {
  return { provider: "anthropic", fetchedAt: at, limits: limits.map(limit), metadata };
}

function put(db: Database, entries: readonly Entry[]): void {
  const statement = db.prepare("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)");
  for (const entry of entries) {
    const readAt = entry.readAt ?? NOW - 4 * MINUTE;
    const value = "reportInstead" in entry ? entry.reportInstead : report(readAt, entry.limits ?? [{ id: "anthropic:5h" }], entry.metadata);
    statement.run(entry.key ?? KEY, entry.storedTextInstead ?? JSON.stringify({ value, expiresAt: readAt + 5 * MINUTE }), entry.expiresAtSeconds ?? Math.floor((readAt + DAY) / 1000));
  }
  // a statement left open keeps the connection, and with it the write-ahead log, past close()
  statement.finalize();
}

/** A store Gajae Code has closed: only its database file is left in the folder. */
function store(entries: readonly Entry[], path = join(home, ".gjc", "agent", "agent.db"), schema = SCHEMA): string {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(schema);
  if (schema === SCHEMA) {
    db.exec(`INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic', 'oauth', '${JSON.stringify({ access: SIGN_IN_SECRET, refresh: SIGN_IN_SECRET })}')`);
    put(db, entries);
  }
  db.close();
  return path;
}

const read = () => gjcRecorded.read(recordedContext());

function ompStoreOf(account: string, email: string, readAt: number, used: number): void {
  const path = join(home, ".omp", "agent", "agent.db");
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE usage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER NOT NULL, provider TEXT NOT NULL, account_key TEXT NOT NULL,
      email TEXT, account_id TEXT, limit_id TEXT NOT NULL, label TEXT NOT NULL, window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER
    );
    INSERT INTO usage_history (recorded_at, provider, account_key, email, account_id, limit_id, label, used_fraction, status, resets_at)
      VALUES (${readAt}, 'anthropic', 'oauth|account:${account}', '${email}', '${account}', 'anthropic:5h', 'Claude 5 Hour', ${used}, 'ok', ${now + 3 * HOUR});
  `);
  db.close();
}

describe("Gajae Code's record of Claude's limits", () => {
  it("gives each account's last report: the session, the week and each model's week, as read then", () => {
    store([{ limits: [
      { id: "anthropic:5h", label: "Claude 5 Hour", used: 0.425, resets: NOW + 3 * HOUR },
      { id: "anthropic:7d", label: "Claude 7 Day", used: 0.13, resets: NOW + 4 * DAY },
      { id: "anthropic:7d:opus", label: "Claude 7 Day (Opus)", used: 0.0625, resets: null },
    ] }]);
    expect(read()).toEqual([{
      accountId: ACCOUNT, label: "me@example.com", readAt: NOW - 4 * MINUTE,
      windows: [
        { kind: "session", scope: null, usedPercent: 42.5, resetsAt: NOW + 3 * HOUR, seconds: 5 * 3600 },
        { kind: "week", scope: null, usedPercent: 13, resetsAt: NOW + 4 * DAY, seconds: 7 * 86400 },
        { kind: "week", scope: "Opus", usedPercent: 6.25, resetsAt: null, seconds: 7 * 86400 },
      ],
    }]);
  });

  it("takes the account from the sign-in its key names, never from the report, whose own account id is the organization's", () => {
    store([{ metadata: { endpoint: CLAUDE_USAGE, accountId: ORG, orgId: ORG } }]);
    expect(read().map((reading) => [reading.accountId, reading.label])).toEqual([[ACCOUNT, "me@example.com"]]);
  });

  it("names the account as the report spells its email, else as the key does, else not at all", () => {
    const named = (entry: Entry) => { rmSync(join(home, ".gjc"), { recursive: true, force: true }); store([entry]); return read().map((reading) => reading.label); };
    expect(named({ metadata: { email: "Me@Example.com" } })).toEqual(["Me@Example.com"]);
    expect(named({ metadata: { email: 7 } })).toEqual(["me@example.com"]);
    expect(named({ key: `${PREFIX}oauth|account:${ACCOUNT}`, metadata: {} })).toEqual([null]);
  });

  it("leaves out a limit it does not know and a limit recorded without a number", () => {
    store([{ limits: [{ id: "anthropic:5h", used: 0.4 }, { id: "anthropic:extra", used: 0.5 }, { id: "anthropic:30d", used: 0.6 }, { id: "anthropic:7d", used: null }] }]);
    expect(read()[0]?.windows.map((window) => [window.kind, window.usedPercent])).toEqual([["session", 40]]);
  });

  it("gives no account for the mark a failed read leaves, nor for a report without a limit shown here", () => {
    store([{ reportInstead: null }, { key: `${PREFIX}oauth|account:${OTHER}`, limits: [{ id: "anthropic:extra" }] }]);
    expect(read()).toEqual([]);
  });

  it("gives one account kept under two of its keys once, by the report read last that holds a limit shown here", () => {
    const second = `${PREFIX}oauth|account:${ACCOUNT}|email:me@example.com|org:org-2`;
    store([{ readAt: NOW - 9 * MINUTE, limits: [{ id: "anthropic:5h", used: 0.4 }] }, { key: second, readAt: NOW - 2 * MINUTE, limits: [{ id: "anthropic:5h", used: 0.6 }] }]);
    expect(read().map((reading) => [reading.accountId, reading.readAt, reading.windows[0]?.usedPercent])).toEqual([[ACCOUNT, NOW - 2 * MINUTE, 60]]);
    rmSync(join(home, ".gjc"), { recursive: true });
    store([{ readAt: NOW - 9 * MINUTE, limits: [{ id: "anthropic:5h", used: 0.4 }] }, { key: second, readAt: NOW - 2 * MINUTE, limits: [{ id: "anthropic:extra" }] }]);
    expect(read().map((reading) => [reading.accountId, reading.readAt, reading.windows[0]?.usedPercent])).toEqual([[ACCOUNT, NOW - 9 * MINUTE, 40]]);
  });

  it("gives every Claude account it keeps a report of, and no other provider's", () => {
    store([
      {},
      { key: `${PREFIX}oauth|account:${OTHER}`, limits: [{ id: "anthropic:5h", used: 0.6 }], metadata: {} },
      { key: "usage_cache:report:openai-codex:default:oauth|account:workspace-1", reportInstead: { provider: "openai-codex", fetchedAt: NOW - MINUTE, limits: [limit({ id: "anthropic:5h" })] } },
      { key: "usage_cache:reports:1f2e3d", reportInstead: [report(NOW - MINUTE, [{ id: "anthropic:5h" }])] },
    ]);
    expect(read().map((reading) => [reading.accountId, reading.label]).sort()).toEqual([[ACCOUNT, "me@example.com"], [OTHER, null]]);
  });

  it("skips an entry that is not what Gajae Code writes", () => {
    const entry = (name: string, more: Entry): Entry => ({ key: `${PREFIX}oauth|account:${name}`, ...more });
    store([
      entry("kept", {}),
      entry("not-json", { storedTextInstead: "{" }),
      entry("no-report", { reportInstead: "report" }),
      entry("another-provider", { reportInstead: { provider: "openai-codex", fetchedAt: NOW - MINUTE, limits: [limit({ id: "anthropic:5h" })] } }),
      entry("read-in-seconds", { readAt: Math.floor(NOW / 1000), expiresAtSeconds: Math.floor((NOW + DAY) / 1000) }),
      entry("read-in-the-future", { readAt: NOW + HOUR }),
      entry("read-as-text", { reportInstead: { provider: "anthropic", fetchedAt: String(NOW), limits: [limit({ id: "anthropic:5h" })] } }),
      entry("limits-not-a-list", { reportInstead: { provider: "anthropic", fetchedAt: NOW - MINUTE, limits: { id: "anthropic:5h" } } }),
      entry("number-as-text", { limits: [{ id: "anthropic:5h", used: "0.4" }] }),
      entry("expiry-as-text", { expiresAtSeconds: "soon" }),
      entry("x".repeat(129), {}),
      entry("too-long", { metadata: { note: "n".repeat(20_000) } }),
    ]);
    expect(read().map((reading) => reading.accountId)).toEqual(["kept"]);
  });

  it("gives no account for a report whose key names none: a sign-in known by its email or its token alone, or an API key", () => {
    store([{ key: `${PREFIX}oauth|email:me@example.com` }, { key: `${PREFIX}oauth|secret:1f2e3d` }, { key: `${PREFIX}api_key|account:${ACCOUNT}` }]);
    expect(read()).toEqual([]);
  });

  it("takes a reset that cannot be the window's as no reset: zero, or later than a whole window after the read", () => {
    store([{ limits: [{ id: "anthropic:5h", resets: 0 }, { id: "anthropic:7d", resets: NOW + 8 * DAY }, { id: "anthropic:7d:opus", label: "Claude 7 Day (Opus)", resets: NOW - 4 * MINUTE + 7 * DAY }] }]);
    expect(read()[0]?.windows.map((window) => window.resetsAt)).toEqual([null, null, NOW - 4 * MINUTE + 7 * DAY]);
  });

  it("gives no report Gajae Code has let expire", () => {
    store([{ readAt: NOW - 30 * HOUR }]);
    expect(read()).toEqual([]);
    rmSync(join(home, ".gjc"), { recursive: true });
    // kept on: Gajae Code stores its last good report again each time a later read fails
    store([{ readAt: NOW - 30 * HOUR, expiresAtSeconds: Math.floor((NOW + HOUR) / 1000) }]);
    expect(read().map((reading) => reading.readAt)).toEqual([NOW - 30 * HOUR]);
  });
});

describe("where Gajae Code keeps its store", () => {
  it("is ~/.gjc/agent by default", () => {
    store([{}]);
    expect(read().map((reading) => reading.accountId)).toEqual([ACCOUNT]);
  });

  it("is the folder GJC_CONFIG_DIR names under the home, else its older name PI_CONFIG_DIR, and .gjc for a name that climbs out of the home", () => {
    store([{ key: `${PREFIX}oauth|account:default` }]);
    store([{ key: `${PREFIX}oauth|account:renamed` }], join(home, "team", "agent", "agent.db"));
    store([{ key: `${PREFIX}oauth|account:older-name` }], join(home, ".pi-config", "agent", "agent.db"));
    const at = (env: Record<string, string>) => gjcRecorded.read(recordedContext(env)).map((reading) => reading.accountId);
    expect(at({ GJC_CONFIG_DIR: "team", PI_CONFIG_DIR: ".pi-config" })).toEqual(["renamed"]);
    expect(at({ PI_CONFIG_DIR: ".pi-config" })).toEqual(["older-name"]);
    // as Gajae Code joins it: trimmed, and beneath the home even where it looks absolute
    expect(at({ GJC_CONFIG_DIR: " /team " })).toEqual(["renamed"]);
    expect(at({ GJC_CONFIG_DIR: "../elsewhere" })).toEqual(["default"]);
    expect(at({ GJC_CONFIG_DIR: "../elsewhere", PI_CONFIG_DIR: ".pi-config" })).toEqual(["older-name"]);
    // the agent folder, when it is named, still decides alone
    expect(at({ GJC_CONFIG_DIR: "team", GJC_CODING_AGENT_DIR: join(home, "nothing-here") })).toEqual([]);
  });

  it("is GJC_CODING_AGENT_DIR when that is set, else its older name PI_CODING_AGENT_DIR, and then nowhere else", () => {
    store([{ key: `${PREFIX}oauth|account:default` }]);
    store([{ key: `${PREFIX}oauth|account:moved` }], join(home, "moved", "agent.db"));
    store([{ key: `${PREFIX}oauth|account:older-name` }], join(home, "older", "agent.db"));
    const at = (env: Record<string, string>) => gjcRecorded.read(recordedContext(env)).map((reading) => reading.accountId);
    expect(at({ GJC_CODING_AGENT_DIR: join(home, "moved"), PI_CODING_AGENT_DIR: join(home, "older") })).toEqual(["moved"]);
    expect(at({ PI_CODING_AGENT_DIR: join(home, "older") })).toEqual(["older-name"]);
    expect(at({ GJC_CODING_AGENT_DIR: join(home, "nothing-here") })).toEqual([]);
  });

  it("is $XDG_DATA_HOME/gjc once that folder exists", () => {
    store([{ key: `${PREFIX}oauth|account:default` }]);
    const data = join(home, "data");
    expect(gjcRecorded.read(recordedContext({ XDG_DATA_HOME: data })).map((reading) => reading.accountId)).toEqual(["default"]);
    store([{ key: `${PREFIX}oauth|account:xdg` }], join(data, "gjc", "agent.db"));
    expect(gjcRecorded.read(recordedContext({ XDG_DATA_HOME: data })).map((reading) => reading.accountId)).toEqual(["xdg"]);
  });
});

describe("a store that is not there or not Gajae Code's", () => {
  const path = () => join(home, ".gjc", "agent", "agent.db");

  it("gives no accounts for no store", () => {
    expect(read()).toEqual([]);
  });

  it("gives no accounts for a folder in its place", () => {
    mkdirSync(path(), { recursive: true });
    expect(read()).toEqual([]);
  });

  it("gives no accounts for bytes that are no database", () => {
    mkdirSync(dirname(path()), { recursive: true });
    writeFileSync(path(), "not a database, however long it is ".repeat(40));
    expect(read()).toEqual([]);
  });

  it("gives no accounts for a store of a version without the table", () => {
    store([], path(), "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    expect(read()).toEqual([]);
  });

  it("gives no accounts for a table without one of the columns", () => {
    store([], path(), "CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    expect(read()).toEqual([]);
  });
});

describe("reading Gajae Code's store", () => {
  const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

  it("leaves the store's bytes and its folder as Gajae Code left them", () => {
    const path = store([{}]);
    const before = { files: readdirSync(dirname(path)), bytes: digest(path) };
    expect(before.files).toEqual(["agent.db"]);
    expect(read().map((reading) => reading.accountId)).toEqual([ACCOUNT]);
    expect({ files: readdirSync(dirname(path)), bytes: digest(path) }).toEqual(before);
  });

  it("reads what a running Gajae Code has written but not yet folded into the store's file", () => {
    const path = store([]);
    const running = new Database(path);
    try {
      put(running, [{}]);
      const before = readdirSync(dirname(path)).sort();
      expect(before).toEqual(["agent.db", "agent.db-shm", "agent.db-wal"]);
      expect(read().map((reading) => reading.accountId)).toEqual([ACCOUNT]);
      expect(readdirSync(dirname(path)).sort()).toEqual(before);
    } finally {
      running.close();
    }
  });
});

describe("Claude's meter with Gajae Code's record", () => {
  function context(): UsageContext {
    return {
      ...recordedContext({ USER: "me" }),
      async fetch(url) { throw new Error(`unexpected request ${url}`); },
      keychain: async () => ({ status: "missing" }),
      run: async () => null,
      has: () => true,
    };
  }

  const claude = USAGE_PROVIDERS.filter((provider) => provider.id === "claude");
  const shown = async () => (await new UsageService(context(), claude).report()).providers
    .map((usage) => ({ key: usage.key, account: usage.account, recorded: usage.recorded, checked_at: usage.checked_at, session: usage.windows.find((window) => window.kind === "session")?.used_percent }));

  it("lists an account Claude Code is not signed in to, under the key a Claude Code sign-in of it would have, as Gajae Code's record", async () => {
    store([{ limits: [{ id: "anthropic:5h", used: 0.425 }] }]);
    expect(await shown()).toEqual([{ key: `claude:${ACCOUNT}`, account: "me@example.com", recorded: { by: "gjc", stale: false, signed_in: false }, checked_at: new Date(NOW - 4 * MINUTE).toISOString(), session: 42.5 }]);
  });

  it("lists an account Oh My Pi recorded too once, by whichever of the two read it last", async () => {
    store([{ readAt: NOW - 9 * MINUTE, limits: [{ id: "anthropic:5h", used: 0.425 }] }]);
    ompStoreOf(ACCOUNT, "me@example.com", NOW - 2 * MINUTE, 0.6);
    expect((await shown()).map((usage) => [usage.key, usage.recorded?.by, usage.session])).toEqual([[`claude:${ACCOUNT}`, "omp", 60]]);
    now = NOW + MINUTE;
    const again = new Database(join(home, ".gjc", "agent", "agent.db"));
    again.exec("DELETE FROM cache");
    put(again, [{ readAt: NOW, limits: [{ id: "anthropic:5h", used: 0.7 }] }]);
    again.close();
    expect((await shown()).map((usage) => [usage.key, usage.recorded?.by, usage.session])).toEqual([[`claude:${ACCOUNT}`, "gjc", 70]]);
  });

  it("answers nothing of Gajae Code's sign-ins", async () => {
    store([{}]);
    const answer = JSON.stringify(await new UsageService(context(), claude).report());
    expect(answer).toContain(ACCOUNT);
    expect(answer).not.toContain(SIGN_IN_SECRET);
  });
});

describe("the report gjc 0.18.12 wrote itself", () => {
  // captured from the real binary (`gjc accounts check anthropic --json`), signed in to a made-up account, a stand-in answering for Anthropic
  const row = JSON.parse(readFileSync(new URL("./fixtures/gjc-0.18.12-usage-cache-row.json", import.meta.url), "utf8")) as { key: string; value: string; expires_at: number };
  const wrote = (JSON.parse(row.value) as { value: { fetchedAt: number; limits: { window: { resetsAt: number } }[] } }).value;
  const OWN = "0b0b0b0b-1111-4222-8333-444444444444";
  let reply: { status: number; body: unknown };

  function context(): UsageContext {
    return {
      ...recordedContext({ USER: "me" }),
      async fetch(url) {
        if (url !== CLAUDE_USAGE) throw new Error(`unexpected request ${url}`);
        return new Response(JSON.stringify(reply.body), { status: reply.status });
      },
      keychain: async () => ({ status: "missing" }),
      run: async () => null,
      has: () => true,
    };
  }

  const write = (path: string, value: unknown): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
  const claude = USAGE_PROVIDERS.filter((provider) => provider.id === "claude");
  const shown = async () => (await new UsageService(context(), claude).report()).providers
    .map((usage) => ({ key: usage.key, problem: usage.problem, recorded: usage.recorded ? { by: usage.recorded.by, signed_in: usage.recorded.signed_in } : null, session: usage.windows.find((window) => window.kind === "session")?.used_percent }));

  beforeEach(() => {
    now = wrote.fetchedAt + 4 * MINUTE;
    const db = new Database(store([]));
    db.run("INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)", [row.key, row.value, row.expires_at]);
    db.close();
    reply = { status: 200, body: { five_hour: { utilization: 10, resets_at: new Date(now + 2 * HOUR).toISOString() } } };
  });

  it("is read as it stands: the account its key names, not the organization its report names, and its three limits", () => {
    expect(gjcRecorded.read(recordedContext())).toEqual([{
      accountId: OWN, label: "gjc-own@example.test", readAt: wrote.fetchedAt,
      windows: [
        { kind: "session", scope: null, seconds: 5 * 3600, usedPercent: 37.5, resetsAt: wrote.limits[0]?.window.resetsAt ?? null },
        { kind: "week", scope: null, seconds: 7 * 86400, usedPercent: 25, resetsAt: wrote.limits[1]?.window.resetsAt ?? null },
        { kind: "week", scope: "Opus", seconds: 7 * 86400, usedPercent: 12.5, resetsAt: wrote.limits[2]?.window.resetsAt ?? null },
      ],
    }]);
  });

  it("is one row with Claude Code's own sign-in of the account and Oh My Pi's record of it: Claude Code's reading while it answers, the record read last once it is refused", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "claude-code-token", expiresAt: now + HOUR, subscriptionType: "max" } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: OWN, emailAddress: "gjc-own@example.test" } });
    ompStoreOf(OWN, "gjc-own@example.test", wrote.fetchedAt - 5 * MINUTE, 0.6);
    expect(await shown()).toEqual([{ key: `claude:${OWN}`, problem: null, recorded: null, session: 10 }]);
    reply = { status: 401, body: {} };
    expect(await shown()).toEqual([{ key: `claude:${OWN}`, problem: "expired", recorded: { by: "gjc", signed_in: true }, session: 37.5 }]);
  });

  it("is one row with Oh My Pi's record of the account, which stands once Oh My Pi has read it later", async () => {
    ompStoreOf(OWN, "gjc-own@example.test", wrote.fetchedAt + 2 * MINUTE, 0.6);
    expect(await shown()).toEqual([{ key: `claude:${OWN}`, problem: null, recorded: { by: "omp", signed_in: false }, session: 60 }]);
  });
});
