import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { USAGE_PROVIDERS, UsageService, type UsageContext } from "./usage.ts";
import type { RecordedContext } from "./usage-recorded.ts";
import { ompRecorded } from "./usage-recorded-omp.ts";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ACCOUNT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const KEY = `oauth|account:${ACCOUNT}|email:me@example.com|org:org-1`;
const SIGN_IN_SECRET = "sentinel-access-token-of-oh-my-pi";
const CLAUDE_USAGE = "https://api.anthropic.com/api/oauth/usage";

/** `usage_history` as Oh My Pi 18.14 to 18.19 create it, beside the table that holds its sign-ins. */
const SCHEMA = `
  CREATE TABLE usage_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, recorded_at INTEGER NOT NULL, provider TEXT NOT NULL, account_key TEXT NOT NULL,
    email TEXT, account_id TEXT, limit_id TEXT NOT NULL, label TEXT NOT NULL, window_label TEXT, used_fraction REAL, status TEXT, resets_at INTEGER
  );
  CREATE INDEX idx_usage_history_series ON usage_history(provider, account_key, limit_id, recorded_at);
  CREATE INDEX idx_usage_history_recorded ON usage_history(recorded_at);
  CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, provider TEXT NOT NULL, credential_type TEXT NOT NULL, data TEXT NOT NULL);
`;

interface Row {
  at: number;
  limit: string;
  label?: string;
  used?: number | string | null;
  resets?: number | null;
  account?: string | null;
  key?: string;
  email?: string | null;
  provider?: string;
}

let home: string;
let now: number;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "herdr-usage-omp-"));
  now = NOW;
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function recordedContext(env: Record<string, string | undefined> = {}): RecordedContext {
  return { home, env, platform: "linux", now: () => now };
}

function insert(db: Database, rows: readonly Row[]): void {
  const statement = db.prepare("INSERT INTO usage_history (recorded_at, provider, account_key, email, account_id, limit_id, label, window_label, used_fraction, status, resets_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  db.transaction(() => {
    for (const row of rows) {
      statement.run(row.at, row.provider ?? "anthropic", row.key ?? KEY, row.email === undefined ? "me@example.com" : row.email, row.account === undefined ? ACCOUNT : row.account,
        row.limit, row.label ?? "Claude", null, row.used === undefined ? 0.5 : row.used, "ok", row.resets === undefined ? NOW + 3 * HOUR : row.resets);
    }
  })();
  // a statement left open keeps the connection, and with it the write-ahead log, past close()
  statement.finalize();
}

/** A store Oh My Pi has closed: only its database file is left in the folder. */
function store(rows: readonly Row[], path = join(home, ".omp", "agent", "agent.db"), schema = SCHEMA): string {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(schema);
  if (schema === SCHEMA) {
    db.exec(`INSERT INTO auth_credentials (provider, credential_type, data) VALUES ('anthropic', 'oauth', '${JSON.stringify({ access: SIGN_IN_SECRET, refresh: SIGN_IN_SECRET })}')`);
    insert(db, rows);
  }
  db.close();
  return path;
}

const latest = (limit: string, used: Row["used"], more: Partial<Row> = {}): Row => ({ at: NOW - 4 * MINUTE, limit, used, ...more });

describe("Oh My Pi's record of Claude's limits", () => {
  it("gives each account's latest report: the session, the week and each model's week, as read then", () => {
    store([
      { at: NOW - 2 * HOUR, limit: "anthropic:5h", used: 0.11 },
      { at: NOW - 2 * HOUR, limit: "anthropic:7d", used: 0.12 },
      latest("anthropic:5h", 0.425, { label: "Claude 5 Hour", resets: NOW + 3 * HOUR }),
      latest("anthropic:7d", 0.13, { label: "Claude 7 Day", resets: NOW + 4 * DAY }),
      latest("anthropic:7d:fable", 0.0625, { label: "Claude 7 Day (Fable)", resets: null }),
    ]);
    expect(ompRecorded.read(recordedContext())).toEqual([{
      accountId: ACCOUNT, label: "me@example.com", readAt: NOW - 4 * MINUTE,
      windows: [
        { kind: "session", scope: null, usedPercent: 42.5, resetsAt: NOW + 3 * HOUR, seconds: 5 * 3600 },
        { kind: "week", scope: null, usedPercent: 13, resetsAt: NOW + 4 * DAY, seconds: 7 * 86400 },
        { kind: "week", scope: "Fable", usedPercent: 6.25, resetsAt: null, seconds: 7 * 86400 },
      ],
    }]);
  });

  it("names a model's week by its label, else by the last part of the limit's id", () => {
    store([latest("anthropic:7d:opus", 0.2, { label: "Claude 7 Day (Opus)" }), latest("anthropic:7d:haiku", 0.3, { label: "Weekly" })]);
    expect(ompRecorded.read(recordedContext())[0]?.windows.map((window) => window.scope).sort()).toEqual(["Opus", "haiku"]);
  });

  it("leaves out extra usage, a limit it does not know and a limit recorded without a number", () => {
    store([latest("anthropic:5h", 0.4), latest("anthropic:extra", 0.9), latest("anthropic:1h", 0.9), latest("anthropic:7d", null)]);
    expect(ompRecorded.read(recordedContext())[0]?.windows.map((window) => window.kind)).toEqual(["session"]);
  });

  it("does not carry a limit over from an older report when the latest one has none", () => {
    store([{ at: NOW - 2 * HOUR, limit: "anthropic:7d:opus", label: "Claude 7 Day (Opus)", used: 0.9 }, latest("anthropic:5h", 0.4)]);
    expect(ompRecorded.read(recordedContext())[0]?.windows.map((window) => [window.kind, window.scope])).toEqual([["session", null]]);
  });

  it("does not carry a limit over from an account's older report recorded at the very time of another account's latest", () => {
    const other = { account: OTHER, key: `oauth|account:${OTHER}`, email: null };
    store([
      { at: NOW - 9 * MINUTE, limit: "anthropic:5h", used: 0.4 },
      { at: NOW - 9 * MINUTE, limit: "anthropic:5h", used: 0.9, ...other },
      { at: NOW - 9 * MINUTE, limit: "anthropic:7d", used: 0.8, ...other },
      { at: NOW - 2 * MINUTE, limit: "anthropic:5h", used: 0.2, ...other },
    ]);
    const readings = ompRecorded.read(recordedContext());
    expect(readings.map((reading) => [reading.accountId, reading.windows.map((window) => [window.kind, window.usedPercent])]).sort()).toEqual([[ACCOUNT, [["session", 40]]], [OTHER, [["session", 20]]]]);
  });

  it("does not show an older report's limits when the latest report records its limits without a number", () => {
    store([{ at: NOW - HOUR, limit: "anthropic:5h", used: 0.4 }, latest("anthropic:5h", null)]);
    expect(ompRecorded.read(recordedContext())).toEqual([]);
  });

  it("gives an account Oh My Pi stopped reading days ago, however many rows its other accounts wrote since", () => {
    const since = Array.from({ length: 2400 }, (_, minute): Row => ({ at: NOW - 2 * DAY + minute * MINUTE, limit: "anthropic:5h", used: 0.6, account: OTHER, key: `oauth|account:${OTHER}`, email: null }));
    store([{ at: NOW - 6 * DAY, limit: "anthropic:7d", used: 0.4, resets: NOW + DAY }, ...since]);
    expect(ompRecorded.read(recordedContext()).map((reading) => [reading.accountId, reading.readAt]).sort()).toEqual([[ACCOUNT, NOW - 6 * DAY], [OTHER, NOW - 2 * DAY + 2399 * MINUTE]]);
  });

  it("gives one account kept under two of its keys once, by the key read last", () => {
    store([
      { at: NOW - 3 * DAY, limit: "anthropic:7d:sonnet", label: "Claude 7 Day (Sonnet)", used: 0.8, key: `oauth|account:${ACCOUNT}` },
      latest("anthropic:5h", 0.4),
    ]);
    const readings = ompRecorded.read(recordedContext());
    expect(readings.map((reading) => [reading.accountId, reading.readAt, reading.windows.map((window) => window.scope)])).toEqual([[ACCOUNT, NOW - 4 * MINUTE, [null]]]);
  });

  it("gives an account by its other key when the latest report under the key read last holds no limit the meters show", () => {
    store([
      { at: NOW - 2 * MINUTE, limit: "anthropic:extra", label: "Claude Extra Usage", used: 0.5, key: `oauth|account:${ACCOUNT}|org:org-2` },
      { at: NOW - 9 * MINUTE, limit: "anthropic:5h", used: 0.4 },
    ]);
    const readings = ompRecorded.read(recordedContext());
    expect(readings.map((reading) => [reading.accountId, reading.readAt, reading.windows.map((window) => [window.kind, window.usedPercent])])).toEqual([[ACCOUNT, NOW - 9 * MINUTE, [["session", 40]]]]);
  });

  it("gives every Claude account it recorded, and no other provider's", () => {
    store([
      latest("anthropic:5h", 0.4),
      latest("anthropic:5h", 0.6, { account: OTHER, key: `oauth|account:${OTHER}`, email: null }),
      latest("openai-codex:primary", 0.9, { provider: "openai-codex", account: "workspace-1", key: "oauth|account:workspace-1" }),
    ]);
    const readings = ompRecorded.read(recordedContext());
    expect(readings.map((reading) => [reading.accountId, reading.label]).sort()).toEqual([[ACCOUNT, "me@example.com"], [OTHER, null]]);
  });

  it("skips a row whose values are not what Oh My Pi writes", () => {
    store([
      latest("anthropic:5h", 0.4, { account: OTHER, key: `oauth|account:${OTHER}` }),
      { at: Math.floor(NOW / 1000), limit: "anthropic:5h" },
      { at: NOW + 2 * MINUTE, limit: "anthropic:5h" },
      latest("anthropic:5h", 0.4, { account: null }),
      latest("anthropic:5h", "most of it"),
      latest("anthropic:7d", 0.4, { label: "x".repeat(300) }),
    ]);
    expect(ompRecorded.read(recordedContext()).map((reading) => reading.accountId)).toEqual([OTHER]);
  });

  it("takes a reset that cannot be the window's as no reset: zero, or later than a whole window after the read", () => {
    store([latest("anthropic:5h", 0.5, { resets: 0 }), latest("anthropic:7d", 0.25, { resets: NOW + 30 * DAY })]);
    expect(ompRecorded.read(recordedContext())[0]?.windows).toEqual([
      { kind: "session", scope: null, usedPercent: 50, resetsAt: null, seconds: 5 * 3600 },
      { kind: "week", scope: null, usedPercent: 25, resetsAt: null, seconds: 7 * 86400 },
    ]);
  });
});

describe("where Oh My Pi keeps its store", () => {
  const found = (env: Record<string, string | undefined>) => ompRecorded.read(recordedContext(env)).map((reading) => reading.accountId);

  it("is ~/.omp/agent by default", () => {
    store([latest("anthropic:5h", 0.4)]);
    expect(found({})).toEqual([ACCOUNT]);
  });

  it("is the folder PI_CONFIG_DIR names under the home, in place of .omp", () => {
    store([latest("anthropic:5h", 0.4)]);
    store([latest("anthropic:5h", 0.4, { account: OTHER, key: `oauth|account:${OTHER}` })], join(home, ".omp-work", "agent", "agent.db"));
    expect(found({ PI_CONFIG_DIR: ".omp-work" })).toEqual([OTHER]);
    expect(found({ PI_CONFIG_DIR: "" })).toEqual([ACCOUNT]);
    // the agent folder, when it is named, still decides alone
    expect(found({ PI_CONFIG_DIR: ".omp-work", PI_CODING_AGENT_DIR: join(home, "nothing-here") })).toEqual([]);
  });

  it("is PI_CODING_AGENT_DIR when that is set, and then nowhere else", () => {
    store([latest("anthropic:5h", 0.4)]);
    const elsewhere = join(home, "agent-dir");
    expect(found({ PI_CODING_AGENT_DIR: elsewhere })).toEqual([]);
    store([latest("anthropic:5h", 0.4, { account: OTHER, key: `oauth|account:${OTHER}` })], join(elsewhere, "agent.db"));
    expect(found({ PI_CODING_AGENT_DIR: elsewhere })).toEqual([OTHER]);
  });

  it("is $XDG_DATA_HOME/omp once that folder exists", () => {
    store([latest("anthropic:5h", 0.4)]);
    const data = join(home, "xdg-data");
    expect(found({ XDG_DATA_HOME: data })).toEqual([ACCOUNT]);
    store([latest("anthropic:5h", 0.4, { account: OTHER, key: `oauth|account:${OTHER}` })], join(data, "omp", "agent.db"));
    expect(found({ XDG_DATA_HOME: data })).toEqual([OTHER]);
  });
});

describe("a store that is not there or not Oh My Pi's", () => {
  const path = () => join(home, ".omp", "agent", "agent.db");
  const cases: ReadonlyArray<readonly [string, () => void]> = [
    ["no store", () => {}],
    ["a folder in its place", () => mkdirSync(path(), { recursive: true })],
    ["bytes that are no database", () => { mkdirSync(dirname(path()), { recursive: true }); writeFileSync(path(), "not a database\n".repeat(64)); }],
    ["an empty file", () => { mkdirSync(dirname(path()), { recursive: true }); writeFileSync(path(), ""); }],
    ["a store of a version without the table", () => { store([], path(), "CREATE TABLE auth_credentials (id INTEGER PRIMARY KEY, data TEXT NOT NULL);"); }],
    ["a table without one of the columns", () => { store([], path(), "CREATE TABLE usage_history (id INTEGER PRIMARY KEY, recorded_at INTEGER NOT NULL, provider TEXT NOT NULL, account_key TEXT NOT NULL, limit_id TEXT NOT NULL, label TEXT NOT NULL, used_fraction REAL);"); }],
  ];

  for (const [name, arrange] of cases) {
    it(`gives no accounts for ${name}`, () => {
      arrange();
      expect(ompRecorded.read(recordedContext())).toEqual([]);
    });
  }
});

describe("reading Oh My Pi's store", () => {
  const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

  it("leaves the store's bytes and its folder as Oh My Pi left them", () => {
    const path = store([latest("anthropic:5h", 0.4)]);
    const before = { files: readdirSync(dirname(path)), bytes: digest(path) };
    expect(before.files).toEqual(["agent.db"]);
    expect(ompRecorded.read(recordedContext()).map((reading) => reading.accountId)).toEqual([ACCOUNT]);
    expect({ files: readdirSync(dirname(path)), bytes: digest(path) }).toEqual(before);
  });

  it("reads what a running Oh My Pi has written but not yet folded into the store's file", () => {
    const path = store([]);
    const running = new Database(path);
    try {
      insert(running, [latest("anthropic:5h", 0.4)]);
      const before = readdirSync(dirname(path)).sort();
      expect(before).toEqual(["agent.db", "agent.db-shm", "agent.db-wal"]);
      expect(ompRecorded.read(recordedContext()).map((reading) => reading.accountId)).toEqual([ACCOUNT]);
      expect(readdirSync(dirname(path)).sort()).toEqual(before);
    } finally {
      running.close();
    }
  });

  it("reads the file alone where its log lies without the shared-memory file, and makes none to read the log", () => {
    const path = store([{ at: NOW - 2 * HOUR, limit: "anthropic:5h", used: 0.2 }]);
    const restored = join(home, "restored");
    const running = new Database(path);
    try {
      insert(running, [latest("anthropic:5h", 0.6)]);
      mkdirSync(restored);
      for (const name of ["agent.db", "agent.db-wal"]) copyFileSync(join(dirname(path), name), join(restored, name));
    } finally {
      running.close();
    }
    expect(ompRecorded.read(recordedContext({ PI_CODING_AGENT_DIR: restored })).map((reading) => reading.readAt)).toEqual([NOW - 2 * HOUR]);
    expect(readdirSync(restored).sort()).toEqual(["agent.db", "agent.db-wal"]);
  });
});

describe("Claude's meter with Oh My Pi's record", () => {
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
    .map((usage) => ({ key: usage.key, account: usage.account, plan: usage.plan, problem: usage.problem, recorded: usage.recorded ? { by: usage.recorded.by, signed_in: usage.recorded.signed_in } : null, session: usage.windows.find((window) => window.kind === "session")?.used_percent }));

  beforeEach(() => {
    store([latest("anthropic:5h", 0.425)]);
    reply = { status: 200, body: { five_hour: { utilization: 10, resets_at: new Date(NOW + 2 * HOUR).toISOString() } } };
  });

  it("lists an account Claude Code is not signed in to, under the key a Claude Code sign-in of it would have", async () => {
    // Claude Code's sign-in lapsed as its failed refresh leaves it: an empty token, expired at 0
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "", expiresAt: 0 } });
    expect(await shown()).toEqual([{ key: `claude:${ACCOUNT}`, account: "me@example.com", plan: null, problem: null, recorded: { by: "omp", signed_in: false }, session: 42.5 }]);
  });

  it("lists the account once beside Claude Code's own sign-in: Claude Code's reading while it answers, the record's numbers once it is refused, the sign-in still told", async () => {
    write(join(home, ".claude", ".credentials.json"), { claudeAiOauth: { accessToken: "claude-code-token", expiresAt: NOW + HOUR, subscriptionType: "max" } });
    write(join(home, ".claude.json"), { oauthAccount: { accountUuid: ACCOUNT, emailAddress: "me@example.com" } });
    expect(await shown()).toEqual([{ key: `claude:${ACCOUNT}`, account: "me@example.com", plan: "max", problem: null, recorded: null, session: 10 }]);
    reply = { status: 401, body: {} };
    expect(await shown()).toEqual([{ key: `claude:${ACCOUNT}`, account: "me@example.com", plan: "max", problem: "expired", recorded: { by: "omp", signed_in: true }, session: 42.5 }]);
  });

  it("is read only by a service that reads Claude: one built for no provider, or for another, opens no store", async () => {
    const codex = USAGE_PROVIDERS.filter((provider) => provider.id === "codex");
    expect((await new UsageService(context(), []).report()).providers).toEqual([]);
    expect((await new UsageService(context(), codex).report()).providers).toEqual([]);
    expect((await new UsageService(context(), claude).report()).providers.map((usage) => usage.key)).toEqual([`claude:${ACCOUNT}`]);
  });

  it("answers nothing of Oh My Pi's sign-ins", async () => {
    const report = JSON.stringify(await new UsageService(context(), claude).report());
    expect(report).toContain(ACCOUNT);
    expect(report).not.toContain(SIGN_IN_SECRET);
  });
});
