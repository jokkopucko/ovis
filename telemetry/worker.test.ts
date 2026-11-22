import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIVE_LATE_DAYS, COUNTS_LATE_DAYS, TELEMETRY_COUNTERS, TELEMETRY_SHOWN, TELEMETRY_THEME_IDS, telemetrySettings, type TelemetrySettings, type TelemetryUsage, type TelemetryWidthCounts } from "../shared/telemetry.ts";
import { handle, readActive, readCounts, readEvent, requestCountry, type Env } from "./worker.ts";

const event = {
  event: "update", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", version: "0.4.2", previous_version: "0.4.1",
  os: "linux", arch: "x64", install_method: "plugin",
};
const settings: TelemetrySettings = {
  terminalInputMode: "auto",
  theme: "dark",
  density: "comfortable",
  sidebarRows: "two",
  agentOrder: "activity",
  agentMarks: "mono",
  statusIndicators: "symbols",
  palette: "catppuccin",
  paletteLight: "amber",
  paletteDark: "catppuccin",
  terminalFontSize: 22,
  terminalWheelSpeed: 10,
  paneClipboard: false,
  releasePaneAway: true,
  chatFontSize: 24,
  uiFontSize: null,
  chatWidth: "narrow",
  enterSends: true,
  autoSendQueued: false,
  suggestionChip: false,
  showThinking: true,
  keepScreenOn: false,
  language: "ko",
  alertsOn: true,
  alertInput: false,
  alertDone: "always",
  alertInApp: true,
  alertSound: false,
  showQuickReplies: true,
  showUsage: true,
  usageCount: "left",
  usageGlance: "session",
  defaultView: "terminal",
  voiceInput: "auto",
  voiceLanguage: "zh-TW",
  voicePolishChat: true,
  voicePolishTerminal: false,
  wrapCode: true,
  markdownWidth: "full",
  diffStyle: "split",
  terminalFontCustom: true,
  chatFontCustom: false,
  shortcutsCustom: true,
  keyBarCustom: false,
  quickRepliesCustom: true,
  quickReplyCount: 12,
  usageHiddenCount: 64,
  usageOrderCustom: true,
};
const now = new Date("2026-10-08T13:45:00Z");

function fakeDb() {
  const rows: { query: string; values: unknown[] }[] = [];
  const env: Env = { DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => { rows.push({ query, values }); return {}; } }) }) } };
  return { env, rows };
}

const post = (body: string, type = "application/json") =>
  new Request("https://receiver.test/v1/events", { method: "POST", headers: { "content-type": type, "cf-connecting-ip": "203.0.113.9" }, body });
/** Cloudflare hangs what it knows about a request on `cf`; Bun's Request has none */
const from = (request: Request, cf: unknown) => Object.assign(request, { cf });

describe("telemetry receiver", () => {
  test("refuses a field no sender has ever had, and still takes an older sender's changed_settings", async () => {
    const { env, rows } = fakeDb();
    const refused = await handle(from(post(JSON.stringify({ ...event, settings, email: "person@example.com" })), { country: "KR" }), env, now);
    expect(refused.status).toBe(400);
    expect(rows).toHaveLength(0);
    const { settings: _current, ...legacy } = { ...event, settings } as Record<string, unknown>;
    const accepted = await handle(from(post(JSON.stringify({ ...legacy, changed_settings: ["theme", "palette"] })), { country: "KR" }), env, now);
    expect(accepted.status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.values.at(-1)).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("changed_settings");
  });

  test("stores a normalized complete settings snapshot, the event fields and the country, never the address", async () => {
    const { env, rows } = fakeDb();
    const unordered = Object.fromEntries(Object.entries(settings).reverse());
    const body = { ...event, settings: unordered };
    expect(new TextEncoder().encode(JSON.stringify(body)).byteLength).toBeLessThan(8192);
    const response = await handle(from(post(JSON.stringify(body)), { country: "KR", city: "Seoul", postalCode: "04524", latitude: "37.5" }), env, now);
    expect(response.status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toContain("INSERT OR IGNORE");
    expect(rows[0]!.values).toEqual(["2026-10-08", "update", event.install_id, "0.4.2", "0.4.1", "linux", "x64", "plugin", null, "KR", JSON.stringify(settings)]);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.9");
    expect(JSON.stringify(rows)).not.toMatch(/Seoul|04524|37\.5/);
    expect(readEvent({ ...event, settings: unordered }, now)?.settings).toEqual(settings);
  });

  test("missing and null snapshots stay null; country is stored only when it is a country", async () => {
    const { env, rows } = fakeDb();
    expect((await handle(post(JSON.stringify(event)), env, now)).status).toBe(204);
    expect(rows[0]!.values[8]).toBeNull();
    expect(rows[0]!.values[9]).toBeNull();
    expect((await handle(post(JSON.stringify({ ...event, settings: null })), env, now)).status).toBe(204);
    expect(rows[1]!.values[9]).toBeNull();
    // XX is Cloudflare's "unknown" and T1 its Tor marker: neither is a country, and T1 would say more than one
    for (const cf of [undefined, {}, { country: "Korea" }, { country: "kr" }, { country: 82 }, { country: "XX" }, { country: "T1" }]) expect(requestCountry(from(post("{}"), cf))).toBeNull();
    for (const country of ["US", "KR"]) expect(requestCountry(from(post("{}"), { country }))).toBe(country);
  });

  test("refuses malformed values and unexpected or sensitive snapshot keys without persisting them", async () => {
    const { env, rows } = fakeDb();
    const invalidSettings = [
      { ...settings, theme: "user-selected theme" },
      { ...settings, statusIndicators: "unknown" },
      { ...settings, terminalWheelSpeed: 11 },
      { ...settings, chatFontSize: "16px" },
      { ...settings, language: "tr" },
      { ...settings, account: { accountId: "acct-private-42", email: "person@example.com" } },
      { ...settings, fontFamily: { value: "D2Coding" } },
      Object.fromEntries(Object.entries(settings).filter(([key]) => key !== "agentOrder")),
    ];
    for (const bad of invalidSettings) {
      expect(readEvent({ ...event, settings: bad }, now)).toBeNull();
      expect((await handle(post(JSON.stringify({ ...event, settings: bad })), env, now)).status).toBe(400);
    }
    expect(rows).toEqual([]);
  });

  test("takes herdr theme ids and the dark/light theme keys, and every older app's snapshot too", async () => {
    const { env, rows } = fakeDb();
    const themed: TelemetrySettings = { ...settings, palette: "tokyo-night", paletteDark: "tokyo-night", paletteLight: "tokyo-night-day", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" };
    for (const valid of [settings, { ...settings, palette: "tokyo-night" }, themed] satisfies TelemetrySettings[]) {
      expect(telemetrySettings(valid)).toEqual(valid);
      expect(readEvent({ ...event, settings: valid }, now)?.settings).toEqual(valid);
    }
    for (const id of TELEMETRY_THEME_IDS) expect(telemetrySettings({ ...themed, darkTheme: id, lightTheme: id, palette: id })).not.toBeNull();
    expect((await handle(post(JSON.stringify({ ...event, settings: themed })), env, now)).status).toBe(204);
    expect(rows[0]!.values.at(-1)).toBe(JSON.stringify(themed));

    const { lightTheme: _light, ...oneSide } = themed;
    for (const bad of [
      { ...settings, palette: "not-a-theme" },
      { ...themed, darkTheme: "not-a-theme" },
      { ...themed, lightTheme: null },
      { ...settings, palette: "lilac" },
      { ...settings, paletteDark: "terminal" },
      oneSide,
      { ...themed, unknownSetting: true },
    ]) {
      expect(telemetrySettings(bad)).toBeNull();
      expect((await handle(post(JSON.stringify({ ...event, settings: bad })), env, now)).status).toBe(400);
    }
    expect(rows).toHaveLength(1);
  });

  describe("against the real table", () => {
    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
    const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8");
    const sqlite = (db: Database): Env => ({ DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } });
    const send = (env: Env, body: object, country?: string) => handle(from(post(JSON.stringify(body)), country ? { country } : undefined), env, now);

    test("the INSERT fits a new table and an upgraded table while retaining historical rows", async () => {
      const fresh = new Database(":memory:");
      fresh.exec(schema);
      const migrated = new Database(":memory:");
      const legacySchema = schema
        .replace("  country TEXT,\n", "")
        .replace("  settings TEXT CHECK (settings IS NULL OR json_valid(settings)),\n", "  changed_settings TEXT,\n");
      migrated.exec(legacySchema);
      migrated.exec("INSERT INTO events (day, event, install_id, version, previous_version, os, arch, install_method, changed_settings) VALUES ('2026-10-07', 'install', '11111111-2222-4333-8444-555555555555', '0.4.0', NULL, 'linux', 'x64', 'plugin', 'theme')");
      const columns = migrated.query("PRAGMA table_info(events)").all().map((row) => (row as { name: string }).name);
      expect(columns).toContain("changed_settings");
      expect(columns).not.toContain("settings");
      // An existing D1 cannot take the new INSERT until its columns are added.
      await expect(send(sqlite(migrated), event, "KR")).rejects.toThrow(/country|settings/);
      const alters = [...readme.matchAll(/"(ALTER TABLE events ADD COLUMN (?:country|settings) TEXT)"/g)].map((match) => match[1]!);
      expect(alters).toEqual(["ALTER TABLE events ADD COLUMN country TEXT", "ALTER TABLE events ADD COLUMN settings TEXT"]);
      for (const alter of alters) migrated.exec(alter);
      expect(migrated.query("SELECT settings, country, changed_settings FROM events").all()).toEqual([{ settings: null, country: null, changed_settings: "theme" }]);
      for (const db of [fresh, migrated]) {
        expect((await send(sqlite(db), { ...event, settings }, "KR")).status).toBe(204);
        expect((await send(sqlite(db), { ...event, settings: { ...settings, theme: "light" } }, "US")).status).toBe(204);
        expect(db.query("SELECT country, version, settings FROM events WHERE version = '0.4.2'").all()).toEqual([
          { country: "KR", version: "0.4.2", settings: JSON.stringify(settings) },
        ]);
      }
      expect(fresh.query("PRAGMA table_info(events)").all().map((row) => (row as { name: string }).name)).not.toContain("changed_settings");
    });

    test("the README's country query counts an install once, under the last country it was seen in", async () => {
      const db = new Database(":memory:");
      db.exec(schema);
      const env = sqlite(db);
      const other = "7c1d2a90-4b3e-4f5a-8c6d-9e0f1a2b3c4d";
      db.exec(`INSERT INTO events (day, event, install_id, version, previous_version, os, arch, install_method) VALUES ('2026-10-08', 'install', '${event.install_id}', '0.4.0', NULL, 'linux', 'x64', 'plugin')`);
      await send(env, { ...event, version: "0.4.1", previous_version: "0.4.0" }, "KR");
      await send(env, event, "US");
      await send(env, event, "JP");
      await send(env, { ...event, install_id: other });
      const query = /-- installs per country[^\n]*\n--[^\n]*\n(SELECT[\s\S]+?;)/.exec(readme)![1]!;
      const counts = db.query(query).all().map((row) => Object.values(row as object));
      expect(counts).toHaveLength(2);
      expect(counts).toContainEqual(["US", 1]);
      expect(counts).toContainEqual([null, 1]);
    });

    test("the README's json_each distribution uses each install's last non-null snapshot", async () => {
      const db = new Database(":memory:");
      db.exec(schema);
      const env = sqlite(db);
      const ids = ["11111111-2222-4333-8444-555555555555", "22222222-3333-4444-8555-666666666666", "33333333-4444-4555-8666-777777777777"];
      await send(env, { ...event, install_id: ids[0], version: "0.4.1", previous_version: "0.4.0", settings: { ...settings, theme: "light", density: "compact", wrapCode: true } });
      await send(env, { ...event, install_id: ids[0], version: "0.4.3", previous_version: "0.4.2", settings: null });
      await send(env, { ...event, install_id: ids[1], settings: { ...settings, theme: "dark", density: "comfortable", wrapCode: false } });
      await send(env, { ...event, install_id: ids[2] });
      const query = /-- values of every setting[\s\S]*?\n(WITH[\s\S]+?;)/.exec(readme)![1]!;
      const values = db.query(query).all().map((row) => Object.values(row as object));
      expect(values).toContainEqual(["theme", "text", "light", 1]);
      expect(values).toContainEqual(["theme", "text", "dark", 1]);
      expect(values).toContainEqual(["wrapCode", "true", 1, 1]);
      expect(values).not.toContainEqual(["theme", "text", "dark", 2]);
      const themeQuery = /-- a focused distribution using json_extract[\s\S]*?\n(WITH[\s\S]+?;)/.exec(readme)![1]!;
      const themes = db.query(themeQuery).all().map((row) => Object.values(row as object));
      expect(themes).toContainEqual(["light", 1]);
      expect(themes).toContainEqual(["dark", 1]);
      expect(themes).toHaveLength(2);
    });
  });

  test("refuses what is not one event", async () => {
    const { env, rows } = fakeDb();
    for (const body of [
      "not json", "[]",
      JSON.stringify({ ...event, event: "heartbeat" }),
      JSON.stringify({ ...event, install_id: "me@example.com" }),
      JSON.stringify({ ...event, version: "latest" }),
      JSON.stringify({ ...event, event: "install" }),
      JSON.stringify({ ...event, os: "Linux 6.8 my-laptop" }),
      JSON.stringify({ ...event, install_method: "docker" }),
    ]) expect((await handle(post(body), env, now)).status).toBe(400);
    expect((await handle(post(JSON.stringify(event), "text/plain"), env, now)).status).toBe(415);
    expect((await handle(post(JSON.stringify({ ...event, pad: "x".repeat(9000) })), env, now)).status).toBe(413);
    expect((await handle(new Request("https://receiver.test/v1/events"), env, now)).status).toBe(405);
    expect((await handle(new Request("https://receiver.test/"), env, now)).status).toBe(404);
    expect(rows).toEqual([]);
  });

  test("refuses an oversized body before it ends", async () => {
    const { env, rows } = fakeDb();
    // More than the 8 KB cap arrive and the stream never closes: do not wait for the rest.
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(8193).fill(0x20)); } });
    const request = new Request("https://receiver.test/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    expect((await handle(request, env, now)).status).toBe(413);
    expect(rows).toEqual([]);
  });

  test("a prerelease version is one event too, so its sender is not refused at every start", async () => {
    const { env, rows } = fakeDb();
    expect((await handle(post(JSON.stringify({ ...event, version: "0.5.0-rc.1" })), env, now)).status).toBe(204);
    expect(rows[0]!.values[3]).toBe("0.5.0-rc.1");
    expect(readEvent({ ...event, version: "0.5.0-rc.1; DROP" }, now)).toBeNull();
  });

  test("takes the terminal runtime a newer sender names, keeps none for an older one, and refuses any other", async () => {
    const { env, rows } = fakeDb();
    expect(readEvent({ ...event, runtime: "herdr-core" }, now)?.runtime).toBe("herdr-core");
    expect(readEvent({ ...event, runtime: "herdr" }, now)?.runtime).toBe("herdr");
    expect(readEvent(event, now)?.runtime).toBeNull();
    for (const runtime of ["tmux", "", null, 1, "HERDR"]) expect(readEvent({ ...event, runtime }, now)).toBeNull();
    expect((await handle(post(JSON.stringify({ ...event, runtime: "herdr-core" })), env, now)).status).toBe(204);
    expect(rows[0]!.values[8]).toBe("herdr-core");
  });

  test("an install has no previous version", () => {
    expect(readEvent({ ...event, event: "install", previous_version: null }, now)).toMatchObject({ event: "install", previous_version: null });
  });
});

describe("telemetry receiver: active", () => {
  const active = {
    event: "active", day: "2026-10-08", install_id: event.install_id, version: "0.4.2",
    os: "linux", arch: "x64", install_method: "plugin", harnesses: ["claude", "codex", "other"],
  };
  const postActive = (body: string, type = "application/json") =>
    new Request("https://receiver.test/v1/active", { method: "POST", headers: { "content-type": type }, body });

  test("active: readActive accepts a valid message, no harnesses, and a day ACTIVE_LATE_DAYS back", () => {
    expect(readActive(active, now)).toEqual({
      day: "2026-10-08", install_id: event.install_id, version: "0.4.2", os: "linux", arch: "x64", install_method: "plugin", harnesses: ["claude", "codex", "other"], usage: null, runtime: null,
    });
    expect(readActive({ ...active, harnesses: [] }, now)?.harnesses).toEqual([]);
    expect(ACTIVE_LATE_DAYS).toBe(2);
    expect(readActive({ ...active, day: "2026-10-06" }, now)?.day).toBe("2026-10-06");
  });

  test("active: readActive refuses a day outside the window or not a date", () => {
    const { day: _day, ...noDay } = active;
    for (const body of [{ ...active, day: "2026-10-05" }, { ...active, day: "2026-10-09" }, { ...active, day: "2026-02-30" }, { ...active, day: "2026-10-8" }, noDay]) {
      expect(readActive(body, now)).toBeNull();
    }
  });

  test("active: readActive refuses bad harnesses, keys, event and install id", () => {
    const { os: _os, ...noOs } = active;
    for (const body of [
      { ...active, harnesses: ["pi", "claude"] },
      { ...active, harnesses: ["claude", "claude"] },
      { ...active, harnesses: ["cursor"] },
      { ...active, harnesses: "claude" },
      { ...active, harnesses: [1] },
      { ...active, pane_count: 3 },
      noOs,
      { ...active, event: "install" },
      { ...active, install_id: "me@example.com" },
    ]) expect(readActive(body, now)).toBeNull();
  });

  test("active: handle on /v1/active answers 204, 400, 405 and 415", async () => {
    const { env, rows } = fakeDb();
    expect((await handle(from(postActive(JSON.stringify(active)), { country: "KR" }), env, now)).status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toContain("INSERT INTO active");
    expect(rows[0]!.values).toEqual(["2026-10-08", event.install_id, "0.4.2", "linux", "x64", "plugin", "KR", JSON.stringify(["claude", "codex", "other"]), null, null]);
    for (const body of [
      "not json",
      JSON.stringify({ ...active, harnesses: ["cursor"] }),
      JSON.stringify({ ...active, harnesses: ["pi", "claude"] }),
      JSON.stringify({ ...active, event: "install" }),
      JSON.stringify(event),
    ]) expect((await handle(postActive(body), env, now)).status).toBe(400);
    expect((await handle(new Request("https://receiver.test/v1/active"), env, now)).status).toBe(405);
    expect((await handle(postActive(JSON.stringify(active), "text/plain"), env, now)).status).toBe(415);
    expect((await handle(postActive(JSON.stringify({ ...active, pad: "x".repeat(9000) })), env, now)).status).toBe(413);
    expect((await handle(post(JSON.stringify(active)), env, now)).status).toBe(400);
    expect(rows).toHaveLength(1);
  });

  const usage: TelemetryUsage = { surfaces: ["browser", "mobile-pwa"], ingress: ["local", "tailscale"], prompt_answers: 3, alerts_delivered: 2, alerts_opened: 1 };

  test("active: readActive takes a message with the day's usage, and an older sender's without it", () => {
    expect(readActive({ ...active, usage }, now)?.usage).toEqual(usage);
    expect(readActive({ ...active, usage: { ...usage, ingress: ["lan", "portal", "relay"] } }, now)?.usage?.ingress).toEqual(["lan", "portal", "relay"]);
    expect(readActive(active, now)?.usage).toBeNull();
  });

  test("active: readActive refuses usage with an unknown, unsorted or repeated kind, a bad count or another key", () => {
    for (const bad of [
      { ...usage, surfaces: ["tv"] },
      { ...usage, surfaces: ["mobile-pwa", "browser"] },
      { ...usage, ingress: ["local", "local"] },
      { ...usage, prompt_answers: -1 },
      { ...usage, alerts_delivered: 1.5 },
      { ...usage, alerts_opened: 10_000 },
      { ...usage, pane_id: "w1:p1" },
      { surfaces: [], ingress: [], prompt_answers: 0, alerts_delivered: 0 },
      null,
      "usage",
    ]) expect(readActive({ ...active, usage: bad }, now)).toBeNull();
  });

  test("active: the day's latest usage replaces the row's, and an older sender's message leaves it", async () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
    const env: Env = { DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } };
    const send = (body: object) => handle(postActive(JSON.stringify(body)), env, now);
    const usageOf = () => (db.query("SELECT usage FROM active").get() as { usage: string | null }).usage;
    expect((await send(active)).status).toBe(204);
    expect(usageOf()).toBeNull();
    expect((await send({ ...active, usage: { ...usage, prompt_answers: 1 } })).status).toBe(204);
    expect((await send({ ...active, usage })).status).toBe(204);
    expect(JSON.parse(usageOf()!)).toEqual(usage);
    expect((await send(active)).status).toBe(204);
    expect(JSON.parse(usageOf()!)).toEqual(usage);
  });

  test("active: an existing table takes the usage only after the README's ALTER, keeping its rows", async () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8").replace("  usage TEXT CHECK (usage IS NULL OR json_valid(usage)),\n", ""));
    const env: Env = { DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } };
    db.exec("INSERT INTO active (day, install_id, version, os, arch, install_method, country, harnesses) VALUES ('2026-10-07', '11111111-2222-4333-8444-555555555555', '0.4.20', 'linux', 'x64', 'plugin', 'KR', '[\"claude\"]')");
    await expect(handle(postActive(JSON.stringify({ ...active, usage })), env, now)).rejects.toThrow(/usage/);
    const alter = readFileSync(join(import.meta.dir, "README.md"), "utf8").match(/"(ALTER TABLE active ADD COLUMN usage [^"]+)"/)?.[1];
    expect(alter).toBeDefined();
    db.exec(alter!);
    expect((await handle(postActive(JSON.stringify({ ...active, usage })), env, now)).status).toBe(204);
    expect(db.query("SELECT day, usage FROM active ORDER BY day").all()).toEqual([{ day: "2026-10-07", usage: null }, { day: "2026-10-08", usage: JSON.stringify(usage) }]);
  });

  test("active: takes the runtime with the usage, keeps the row's for an older sender, and refuses another runtime or one without usage", async () => {
    expect(readActive({ ...active, usage, runtime: "herdr-core" }, now)?.runtime).toBe("herdr-core");
    expect(readActive({ ...active, usage }, now)?.runtime).toBeNull();
    for (const bad of [{ ...active, usage, runtime: "tmux" }, { ...active, usage, runtime: null }, { ...active, runtime: "herdr" }]) expect(readActive(bad, now)).toBeNull();
    const db = new Database(":memory:");
    db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
    const env: Env = { DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } };
    const runtimeOf = () => (db.query("SELECT runtime FROM active").get() as { runtime: string | null }).runtime;
    expect((await handle(postActive(JSON.stringify({ ...active, usage })), env, now)).status).toBe(204);
    expect(runtimeOf()).toBeNull();
    expect((await handle(postActive(JSON.stringify({ ...active, usage, runtime: "herdr-core" })), env, now)).status).toBe(204);
    expect(runtimeOf()).toBe("herdr-core");
    expect((await handle(postActive(JSON.stringify({ ...active, usage })), env, now)).status).toBe(204);
    expect(runtimeOf()).toBe("herdr-core");
  });

  test("an existing database takes the runtime only after the README's ALTERs, keeping its rows", async () => {
    const column = "  runtime TEXT CHECK (runtime IS NULL OR runtime IN ('herdr', 'herdr-core')),\n";
    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
    expect(schema.split(column)).toHaveLength(3);
    const db = new Database(":memory:");
    db.exec(schema.replaceAll(column, ""));
    const env: Env = { DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } };
    db.exec("INSERT INTO active (day, install_id, version, os, arch, install_method, country, harnesses) VALUES ('2026-10-07', '11111111-2222-4333-8444-555555555555', '0.4.20', 'linux', 'x64', 'plugin', 'KR', '[\"claude\"]')");
    const sendEvent = () => handle(new Request("https://receiver.test/v1/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...event, runtime: "herdr-core" }) }), env, now);
    const sendActive = () => handle(postActive(JSON.stringify({ ...active, usage, runtime: "herdr-core" })), env, now);
    await expect(sendEvent()).rejects.toThrow(/runtime/);
    await expect(sendActive()).rejects.toThrow(/runtime/);
    const alters = [...readFileSync(join(import.meta.dir, "README.md"), "utf8").matchAll(/"(ALTER TABLE (?:events|active) ADD COLUMN runtime [^"]+)"/g)].map((match) => match[1]!);
    expect(alters).toHaveLength(2);
    for (const alter of alters) db.exec(alter);
    expect((await sendEvent()).status).toBe(204);
    expect((await sendActive()).status).toBe(204);
    expect(db.query("SELECT runtime FROM events").all()).toEqual([{ runtime: "herdr-core" }]);
    expect(db.query("SELECT day, runtime FROM active ORDER BY day").all()).toEqual([{ day: "2026-10-07", runtime: null }, { day: "2026-10-08", runtime: "herdr-core" }]);
    expect(() => db.exec("UPDATE active SET runtime = 'tmux'")).toThrow(/CHECK/);
  });

  test("active: the upsert keeps one row per install and day, with the latest set, under the visit's day", async () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
    const env: Env = { DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } };
    const send = (body: object, at: Date, country?: string) => handle(from(postActive(JSON.stringify(body)), country ? { country } : undefined), env, at);
    const rowsOf = () => db.query("SELECT day, install_id, version, country, harnesses FROM active ORDER BY day").all();

    expect((await send({ ...active, harnesses: ["claude"] }, now, "KR")).status).toBe(204);
    expect((await send({ ...active, version: "0.4.3", harnesses: ["claude", "codex"] }, now)).status).toBe(204);
    expect(rowsOf()).toEqual([{ day: "2026-10-08", install_id: event.install_id, version: "0.4.3", country: "KR", harnesses: '["claude","codex"]' }]);

    expect((await send({ ...active, day: "2026-10-09", harnesses: [] }, new Date("2026-10-09T10:00:00Z"), "KR")).status).toBe(204);
    expect(rowsOf()).toHaveLength(2);

    const other = "7c1d2a90-4b3e-4f5a-8c6d-9e0f1a2b3c4d";
    expect((await send({ ...active, install_id: other, day: "2026-10-09", harnesses: ["pi"] }, new Date("2026-10-10T00:05:00Z"))).status).toBe(204);
    expect(db.query("SELECT day, harnesses FROM active WHERE install_id = ?").all(other)).toEqual([{ day: "2026-10-09", harnesses: '["pi"]' }]);
    expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 0 });
  });
});

describe("telemetry receiver: counts", () => {
  const narrow: TelemetryWidthCounts = { counts: { chat_send: 3, view_terminal_by_header: 1, view_terminal_claude: 1 }, shown: ["composer", "view_switch_header"] };
  const counts = { event: "counts", day: "2026-10-07", install_id: event.install_id, version: "0.5.5", narrow, wide: null };
  const postCounts = (body: string) => new Request("https://receiver.test/v1/counts", { method: "POST", headers: { "content-type": "application/json" }, body });
  const sqliteEnv = (db: Database): Env => ({ DB: { prepare: (query) => ({ bind: (...values) => ({ run: async () => db.prepare(query).run(...(values as (string | null)[])) }) }) } });

  test("takes a finished day's counts per width, up to COUNTS_LATE_DAYS back, and stores no country", async () => {
    expect(readCounts(counts, now)).toEqual({ day: "2026-10-07", install_id: event.install_id, version: "0.5.5", narrow, wide: null });
    const earliest = new Date(now.getTime() - COUNTS_LATE_DAYS * 86_400_000).toISOString().slice(0, 10);
    expect(readCounts({ ...counts, day: earliest }, now)?.day).toBe(earliest);
    expect(readCounts({ ...counts, wide: narrow, narrow: null }, now)?.wide).toEqual(narrow);
    expect(readCounts({ ...counts, narrow: { counts: {}, shown: [] } }, now)?.narrow).toEqual({ counts: {}, shown: [] });
    const { env, rows } = fakeDb();
    expect((await handle(from(postCounts(JSON.stringify(counts)), { country: "KR" }), env, now)).status).toBe(204);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.query).toContain("INSERT OR IGNORE INTO counts");
    expect(rows[0]!.values).toEqual(["2026-10-07", event.install_id, "0.5.5", JSON.stringify(narrow), null]);
    expect(JSON.stringify(rows)).not.toContain("KR");
  });

  test("drops a counter, a shown control or a bucket it does not know and keeps the rest of the row", () => {
    const newer = { counts: { ...narrow.counts, composer_rewind: 2, chat_send_twice: 1, view_chat_cursor: 4 }, shown: ["composer", "future_panel", "view_switch_header", "composer"] };
    expect(readCounts({ ...counts, narrow: newer }, now)?.narrow).toEqual(narrow);
    for (const bucket of [0, 5, 1.5, "1", null, -1]) {
      expect(readCounts({ ...counts, narrow: { ...narrow, counts: { ...narrow.counts, composer_voice: bucket } } }, now)?.narrow).toEqual(narrow);
    }
    const unordered = { counts: Object.fromEntries(Object.entries(narrow.counts).reverse()), shown: [...narrow.shown].reverse() };
    expect(JSON.stringify(readCounts({ ...counts, narrow: unordered }, now)?.narrow)).toBe(JSON.stringify(narrow));
  });

  test("refuses what is not a counts message, a day outside the window and a day not yet ended", async () => {
    const { install_id: _id, ...noId } = counts;
    for (const body of [
      { ...counts, event: "active" },
      { ...counts, day: "2026-09-23" },
      { ...counts, day: "2026-10-09" },
      { ...counts, day: "2026-10-08" },
      { ...counts, day: "2026-02-30" },
      { ...counts, install_id: "me@example.com" },
      { ...counts, version: "latest" },
      { ...counts, narrow: { counts: [] , shown: [] } },
      { ...counts, narrow: { counts: {}, shown: "composer" } },
      { ...counts, narrow: { counts: {}, shown: [1] } },
      { ...counts, narrow: { counts: {}, shown: [], pane: "w1:p1" } },
      { ...counts, narrow: undefined },
      { ...counts, harnesses: ["claude"] },
      { ...counts, prompt: "fix the bug" },
      noId,
    ]) expect(readCounts(body, now)).toBeNull();
    const { env, rows } = fakeDb();
    expect((await handle(postCounts(JSON.stringify({ ...counts, day: "2026-09-23" })), env, now)).status).toBe(400);
    expect((await handle(postCounts(JSON.stringify(event)), env, now)).status).toBe(400);
    expect((await handle(new Request("https://receiver.test/v1/counts"), env, now)).status).toBe(405);
    expect(rows).toEqual([]);
  });

  test("a day with every counter used and every control shown, at both widths, fits the body limit", async () => {
    const full: TelemetryWidthCounts = { counts: Object.fromEntries(TELEMETRY_COUNTERS.map((name) => [name, 4])), shown: [...TELEMETRY_SHOWN] };
    const body = JSON.stringify({ ...counts, install_id: event.install_id, version: "1000.1000.1000-rc.123456789012345678", narrow: full, wide: full });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThan(8192);
    const { env, rows } = fakeDb();
    expect((await handle(postCounts(body), env, now)).status).toBe(204);
    expect(JSON.parse(rows[0]!.values[3] as string)).toEqual(full);
  });

  test("against the real table: the first message for a day stands, and the README's share query reads it", async () => {
    const db = new Database(":memory:");
    db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
    const env = sqliteEnv(db);
    const yesterday = { ...counts, day: "2026-10-07" };
    expect((await handle(postCounts(JSON.stringify(yesterday)), env, now)).status).toBe(204);
    expect((await handle(postCounts(JSON.stringify({ ...yesterday, narrow: { counts: { chat_send: 4 }, shown: [] } })), env, now)).status).toBe(204);
    const other = "7c1d2a90-4b3e-4f5a-8c6d-9e0f1a2b3c4d";
    expect((await handle(postCounts(JSON.stringify({ ...yesterday, install_id: other, narrow: { counts: {}, shown: ["composer"] }, wide: { counts: { chat_send: 1 }, shown: [] } })), env, now)).status).toBe(204);
    expect(db.query("SELECT day, install_id, narrow FROM counts ORDER BY install_id").all()).toEqual([
      { day: "2026-10-07", install_id: event.install_id, narrow: JSON.stringify(narrow) },
      { day: "2026-10-07", install_id: other, narrow: JSON.stringify({ counts: {}, shown: ["composer"] }) },
    ]);
    const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8");
    db.exec("UPDATE counts SET day = date('now', '-1 day')");
    const query = /-- share of installs that used each counter[^\n]*\n--[^\n]*\n(SELECT[\s\S]+?;)/.exec(readme)![1]!;
    const shares = db.query(query).all().map((row) => Object.values(row as object));
    expect(shares).toContainEqual(["narrow", "chat_send", 1, 50]);
    expect(shares).toContainEqual(["narrow", "view_terminal_claude", 1, 50]);
    expect(shares).toContainEqual(["wide", "chat_send", 1, 100]);
    expect(shares).toHaveLength(4);
  });

  test("an existing database takes the counts only after the README's CREATE, keeping its other tables", async () => {
    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
    const db = new Database(":memory:");
    db.exec(schema.slice(0, schema.indexOf("-- One row per install and finished UTC day")));
    db.exec("INSERT INTO active (day, install_id, version, os, arch, install_method, country, harnesses) VALUES ('2026-10-07', '11111111-2222-4333-8444-555555555555', '0.4.20', 'linux', 'x64', 'plugin', 'KR', '[\"claude\"]')");
    const env = sqliteEnv(db);
    await expect(handle(postCounts(JSON.stringify(counts)), env, now)).rejects.toThrow(/counts/);
    const create = readFileSync(join(import.meta.dir, "README.md"), "utf8").match(/"(CREATE TABLE IF NOT EXISTS counts [^"]+)"/)?.[1];
    expect(create).toBeDefined();
    db.exec(create!);
    expect((await handle(postCounts(JSON.stringify(counts)), env, now)).status).toBe(204);
    expect(db.query("SELECT COUNT(*) AS n FROM active").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM counts").get()).toEqual({ n: 1 });
  });
});
