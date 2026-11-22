import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPPORTED_AGENT_KINDS } from "../shared/supported-agents.ts";
import { ACTIVE_LATE_DAYS, COUNTS_LATE_DAYS, emptyUsage, harnessOf, TELEMETRY_COUNT_MAX, TELEMETRY_HARNESSES, type TelemetryActive, type TelemetryChange, type TelemetryCounts, type TelemetryEvent, type TelemetryRuntime, type TelemetrySettings, type TelemetryUsage } from "../shared/telemetry.ts";
import { NOTICE_VERSION } from "../shared/telemetry-notice.ts";
import { DEFAULT_SETTINGS, telemetrySettingsSnapshot, type Settings } from "../src/lib/settings.ts";
import { COUNTS_SETTLE_MS, handleTelemetryRequest, installMethod, Telemetry, telemetryBlocked, USAGE_RESEND_MS, visitSurface } from "./telemetry.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** a fixture receiver: never the real ACTIVE_URL */
const TEST_ACTIVE_URL = "https://telemetry.test/v1/active";
const TEST_COUNTS_URL = "https://telemetry.test/v1/counts";

function setup(options: { version?: string; env?: Record<string, string>; status?: number; previous?: string | null; stateDir?: string; grace?: number; fetch?: typeof fetch; now?: string; runtime?: TelemetryRuntime; countsOn?: boolean } = {}) {
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), "telemetry-"));
  if (!options.stateDir) dirs.push(stateDir);
  const sent: TelemetryEvent[] = [];
  const actives: TelemetryActive[] = [];
  const counts: TelemetryCounts[] = [];
  const urls: string[] = [];
  const answer = { status: options.status ?? 204 };
  const waiting: ((active: TelemetryActive) => void)[] = [];
  const fake = options.fetch ?? (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    const body: unknown = JSON.parse(String(init?.body));
    if (String(url) === TEST_ACTIVE_URL) {
      actives.push(body as TelemetryActive);
      for (const resolve of waiting.splice(0)) resolve(body as TelemetryActive);
    } else if (String(url) === TEST_COUNTS_URL) counts.push(body as TelemetryCounts);
    else sent.push(body as TelemetryEvent);
    return new Response(null, { status: answer.status });
  }) as typeof fetch;
  const clock = { now: Date.parse(options.now ?? "2026-10-08T12:00:00Z") };
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const telemetry = new Telemetry({
    stateDir, version: options.version ?? "0.4.1", env: options.env ?? {}, fetch: fake,
    activeUrl: TEST_ACTIVE_URL, countsUrl: TEST_COUNTS_URL,
    platform: "linux", arch: "x64", previousVersion: () => options.previous ?? null, runtime: options.runtime, countsOn: options.countsOn,
    now: () => clock.now, noticeGraceMs: options.grace ?? 0,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return { clear: () => { timer.cleared = true; } };
    },
  });
  const nextActive = () => Promise.race([
    new Promise<TelemetryActive>((resolve) => waiting.push(resolve)),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("no active message was sent")), 5_000).unref?.()),
  ]);
  const fireTimer = () => {
    const timer = timers.filter((candidate) => !candidate.cleared).at(-1);
    if (!timer) throw new Error("no grace timer was armed");
    timer.fn();
  };
  return { telemetry, sent, actives, counts, urls, answer, stateDir, clock, timers, nextActive, fireTimer };
}

const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

const telemetryPost = (body: unknown) => new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(body) });

function savedFile(stateDir: string) {
  return JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"));
}

function seen(telemetry: Telemetry) {
  telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
}

function settingsSnapshot(overrides: Partial<Settings> = {}): TelemetrySettings {
  return telemetrySettingsSnapshot({ ...DEFAULT_SETTINGS, ...overrides });
}

describe("telemetry events", () => {
  test("nothing is sent before the current notice was shown", async () => {
    const { telemetry, sent } = setup();
    await telemetry.report();
    expect(sent).toEqual([]);
    expect(telemetry.status()).toMatchObject({ enabled: true, notice_seen: false, blocked_by_env: false });
  });

  test("the install event and the day's active message name the runtime the server serves", async () => {
    const { telemetry, sent, actives } = setup({ runtime: "herdr-core" });
    seen(telemetry);
    await telemetry.report();
    await telemetry.active(["claude"]);
    expect(sent.map((event) => event.runtime)).toEqual(["herdr-core"]);
    expect(actives.map((active) => active.runtime)).toEqual(["herdr-core"]);
    expect(telemetry.status().next).toBeNull();
    expect(telemetry.status().active.runtime).toBe("herdr-core");
  });

  test("the notice sends the install once, and a restart on the same version sends nothing", async () => {
    const { telemetry, sent, stateDir } = setup();
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ event: "install", version: "0.4.1", previous_version: null, os: "linux", arch: "x64", install_method: "source", settings: null, runtime: "herdr" });
    expect(sent[0]!.install_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(join(stateDir, "telemetry.json")).mode & 0o777).toBe(0o600);

    const again = setup({ stateDir });
    await again.telemetry.report();
    expect(again.sent).toEqual([]);
    expect(again.telemetry.status().next).toBeNull();
  });

  test("a new version sends one update from the version last reported", async () => {
    const first = setup();
    first.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await first.telemetry.report();
    const next = setup({ stateDir: first.stateDir, version: "0.4.2" });
    await next.telemetry.report();
    expect(next.sent).toEqual([expect.objectContaining({ event: "update", version: "0.4.2", previous_version: "0.4.1", install_id: first.sent[0]!.install_id })]);
  });

  test("the first event of an install updated from before telemetry is an update that names no replaced version", async () => {
    // the updater's record of the version it replaced is from before this state file: not sent
    const { telemetry, sent } = setup({ previous: "0.4.0" });
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toEqual([expect.objectContaining({ event: "update", previous_version: null })]);
  });

  test("after a blocked start removed the state file, the next event names no version the updater says it replaced", async () => {
    const { telemetry, stateDir } = setup({ grace: 600_000, previous: "0.5.4" });
    seen(telemetry);
    mkdirSync(join(stateDir, `telemetry.json.${process.pid}.tmp`));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try { setup({ stateDir, env: { OVIS_TELEMETRY: "0" }, previous: "0.5.4" }); } finally { errors.mockRestore(); }
    expect(existsSync(join(stateDir, "telemetry.json"))).toBe(false);
    rmSync(join(stateDir, `telemetry.json.${process.pid}.tmp`), { recursive: true });
    const restarted = setup({ stateDir, previous: "0.5.4" });
    restarted.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await restarted.telemetry.report();
    expect(restarted.sent).toEqual([expect.objectContaining({ event: "update", previous_version: null })]);
  });

  test("the switch off sends nothing, and on again sends what is owed", async () => {
    const { telemetry, sent } = setup();
    telemetry.change({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toEqual([]);
    telemetry.change({ enabled: true });
    await telemetry.report();
    expect(sent.map((event) => event.event)).toEqual(["install"]);
  });

  test("the environment can forbid sending whatever the switch says", async () => {
    const environments: Record<string, string>[] = [{ OVIS_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }, { CI: "true" }, { HERDR_TEST_MODE: "unit" }];
    for (const env of environments) {
      const { telemetry, sent } = setup({ env });
      telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
      await telemetry.report();
      expect(sent).toEqual([]);
      expect(telemetry.status().blocked_by_env).toBe(true);
    }
    expect(telemetryBlocked({ DO_NOT_TRACK: "0" })).toBe(false);
  });

  test("an event the receiver refused is sent again later", async () => {
    const failing = setup({ status: 503 });
    failing.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await failing.telemetry.report();
    expect(failing.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(failing.stateDir, "telemetry.json"), "utf8")).reported_version).toBeNull();
    const retry = setup({ stateDir: failing.stateDir });
    await retry.telemetry.report();
    expect(retry.sent).toHaveLength(1);
  });

  test("the first event waits after the notice, so Turn off on the notice sends nothing", async () => {
    const off = setup({ grace: 600_000 });
    off.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await off.telemetry.report();
    expect(off.sent).toEqual([]);
    off.telemetry.change({ enabled: false });
    off.clock.now += 600_000;
    await off.telemetry.report();
    expect(off.sent).toEqual([]);

    const kept = setup({ grace: 600_000 });
    kept.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    kept.clock.now += 599_999;
    await kept.telemetry.report();
    expect(kept.sent).toEqual([]);
    kept.clock.now += 1;
    await kept.telemetry.report();
    expect(kept.sent.map((event) => event.event)).toEqual(["install"]);
  });

  test("turning the switch off stops an event already on its way", async () => {
    let signal: AbortSignal | undefined;
    const pending = (async (_url: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason)));
    }) as typeof fetch;
    const { telemetry, stateDir } = setup({ fetch: pending });
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    const sending = telemetry.report();
    expect(signal?.aborted).toBe(false);
    telemetry.change({ enabled: false });
    expect(signal?.aborted).toBe(true);
    await sending;
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"))).toMatchObject({ enabled: false, reported_version: null });
  });

  test("a switch turned off by another server on the same state directory holds", async () => {
    const first = setup();
    first.telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await first.telemetry.report();
    const plugin = setup({ stateDir: first.stateDir, version: "0.4.2" });
    const source = setup({ stateDir: first.stateDir, version: "0.4.2" });
    plugin.telemetry.change({ enabled: false });
    await source.telemetry.report();
    expect(source.sent).toEqual([]);
    expect(source.telemetry.status().enabled).toBe(false);
    expect(JSON.parse(readFileSync(join(first.stateDir, "telemetry.json"), "utf8")).enabled).toBe(false);
  });

  test("a state directory that cannot be written leaves the app running and sends nothing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(parent);
    writeFileSync(join(parent, "file"), "");
    const { telemetry, sent } = setup({ stateDir: join(parent, "file", "state") });
    await telemetry.report();
    expect(sent).toEqual([]);
    // no state directory to tell whether the counts were turned off reads as off (offMarked fails closed)
    expect(telemetry.status().enabled).toBe(false);
  });

  test("full safe settings persist across restarts and are included in install and update events", async () => {
    const settings = settingsSnapshot({
      theme: "light",
      terminalFontSize: 18,
      terminalFontFamily: "private font name",
      quickReplies: ["private quick reply"],
      usageHidden: ["private-account-key"],
    });
    const { telemetry, sent, stateDir } = setup();
    // told before the notice: not kept (the page sends its settings with the acknowledgement)
    telemetry.change({ settings });
    expect(telemetry.status().next?.settings).toBeNull();
    await telemetry.report();
    expect(sent).toEqual([]);

    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION, settings, generation: 0 });
    await telemetry.report();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.settings).toEqual(settings);
    expect(sent[0]!.settings).toMatchObject({ theme: "light", terminalFontSize: 18, terminalFontCustom: true, quickRepliesCustom: true, quickReplyCount: 1, usageHiddenCount: 1 });
    expect(JSON.stringify(sent[0]!.settings)).not.toContain("private font name");
    expect(JSON.stringify(sent[0]!.settings)).not.toContain("private quick reply");
    expect(JSON.stringify(sent[0]!.settings)).not.toContain("private-account-key");
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8")).settings).toEqual(settings);

    const restarted = setup({ stateDir });
    expect(restarted.telemetry.status().next).toBeNull();
    await restarted.telemetry.report();
    expect(restarted.sent).toEqual([]);

    const latestSettings = settingsSnapshot({ theme: "system", terminalFontSize: 16 });
    const latestBrowser = setup({ stateDir });
    latestBrowser.telemetry.change({ settings: latestSettings, generation: 0 });
    await latestBrowser.telemetry.report();
    expect(latestBrowser.sent).toEqual([]);

    const updated = setup({ stateDir, version: "0.4.2" });
    await updated.telemetry.report();
    expect(updated.sent).toEqual([expect.objectContaining({ event: "update", previous_version: "0.4.1", settings: latestSettings })]);
  });

  test("invalid settings cannot be persisted or sent, and changing settings after a counted version adds no event", async () => {
    // the grace holds the install event, so its preview can be read after the acknowledgement
    const { telemetry, sent, stateDir, clock } = setup({ grace: 600_000 });
    const safe = settingsSnapshot();
    const submitted = { ...safe };
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION, settings: submitted, generation: 0 });
    submitted.theme = "light";
    const preview = telemetry.status().next?.settings;
    expect(preview).toEqual(safe);
    if (!preview) throw new Error("telemetry preview omitted the settings snapshot");
    preview.theme = "system";
    expect(telemetry.status().next?.settings).toEqual(safe);
    const before = JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"));

    const invalid = { ...safe, theme: "user supplied text", unknown: true } as unknown as TelemetrySettings;
    expect(() => telemetry.change({ settings: invalid })).toThrow();
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"))).toEqual(before);
    expect(telemetry.status().next?.settings).toEqual(safe);
    expect(sent).toEqual([]);

    clock.now += 600_001;
    await telemetry.report();
    expect(sent).toHaveLength(1);
    telemetry.change({ settings: settingsSnapshot({ theme: "light" }), generation: 0 });
    await telemetry.report();
    expect(sent).toHaveLength(1);
    expect(telemetry.status().next).toBeNull();
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8")).settings).toEqual(settingsSnapshot({ theme: "light" }));
  });

  test("notice upgrades preserve the install ID and disabled state, and invalid or legacy settings become null", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const settings = settingsSnapshot();
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84",
      enabled: false,
      notice_seen_at: "2026-10-01T00:00:00.000Z",
      notice_version: NOTICE_VERSION - 1,
      reported_version: "0.4.0",
      settings: { ...settings, theme: "invalid" },
      changed_settings: ["theme"],
    }));
    const { telemetry, sent } = setup({ stateDir });
    expect(telemetry.status()).toMatchObject({ enabled: false, notice_seen: false, next: { event: "update", previous_version: "0.4.0", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", settings: null } });
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    expect(sent).toEqual([]);
    expect(telemetry.status().enabled).toBe(false);
    telemetry.change({ enabled: true });
    await telemetry.report();
    expect(sent).toEqual([expect.objectContaining({ event: "update", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", settings: null })]);
    const saved = JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8"));
    expect(saved.settings).toBeNull();
    expect(saved.changed_settings).toBeUndefined();
  });

  test("the install method follows how the app was started", () => {
    expect(installMethod({ HERDR_PLUGIN_ROOT: "/x", OVIS_MANAGED: "1" })).toBe("plugin");
    expect(installMethod({ OVIS_MANAGED: "1" })).toBe("managed");
    expect(installMethod({})).toBe("source");
  });
});

describe("daily active message", () => {
  test("(a) a visit sends one active message with the harness kinds, and the same kinds again send nothing", async () => {
    const { telemetry, actives, urls } = setup();
    seen(telemetry);
    await telemetry.active(["claude", null, "claude", "weird"]);
    expect(urls.filter((url) => url === TEST_ACTIVE_URL)).toHaveLength(1);
    expect(actives).toEqual([{ event: "active", day: "2026-10-08", install_id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: "0.4.1", os: "linux", arch: "x64", install_method: "source", harnesses: ["claude", "other"], usage: emptyUsage(), runtime: "herdr" }]);
    await telemetry.active(["claude", null, "claude", "weird"]);
    expect(actives).toHaveLength(1);
  });

  test("(b) a new kind the same day resends the grown set", async () => {
    const { telemetry, actives } = setup();
    seen(telemetry);
    await telemetry.active(["claude", "weird"]);
    await telemetry.active(["codex"]);
    expect(actives.map((active) => [active.day, active.harnesses])).toEqual([["2026-10-08", ["claude", "other"]], ["2026-10-08", ["claude", "codex", "other"]]]);
  });

  test("(c) the next day sends its own message and does not resend the day before", async () => {
    const { telemetry, actives, clock } = setup();
    seen(telemetry);
    await telemetry.active(["claude"]);
    clock.now += 86_400_000;
    await telemetry.active([]);
    expect(actives.map((active) => [active.day, active.harnesses])).toEqual([["2026-10-08", ["claude"]], ["2026-10-09", []]]);
  });

  test("(d) nothing is sent while off, blocked, before the notice, after only an older notice, or inside the grace", async () => {
    const off = setup();
    off.telemetry.change({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION });
    await off.telemetry.active(["claude"]);
    expect(off.actives).toEqual([]);

    const blocked = setup({ env: { OVIS_TELEMETRY: "0" } });
    seen(blocked.telemetry);
    await blocked.telemetry.active(["claude"]);
    expect(blocked.actives).toEqual([]);

    const unseen = setup();
    await unseen.telemetry.active(["claude"]);
    expect(unseen.actives).toEqual([]);

    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: 3, reported_version: "0.4.1", settings: null }));
    const older = setup({ stateDir });
    await older.telemetry.active(["claude"]);
    expect(older.actives).toEqual([]);

    // a visit made while off is not kept: turning the switch on again sends nothing for it
    off.telemetry.change({ enabled: true });
    await settled();
    expect(off.actives).toEqual([]);
    expect(savedFile(off.stateDir).active ?? []).toEqual([]);
    expect(off.telemetry.counting()).toBe(true);
    expect(blocked.telemetry.counting()).toBe(false);

    const grace = setup({ grace: 600_000 });
    seen(grace.telemetry);
    await grace.telemetry.active(["claude"]);
    expect(grace.actives).toEqual([]);
    expect(grace.timers.at(-1)?.ms).toBe(600_000);
    grace.clock.now += 600_000;
    const delivered = grace.nextActive();
    grace.fireTimer();
    expect(await delivered).toMatchObject({ day: "2026-10-08", harnesses: ["claude"] });
  });

  test("(e) a refused active message stays undelivered and the next visit retries it", async () => {
    const { telemetry, actives, answer, stateDir } = setup({ status: 500 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    expect(actives).toHaveLength(1);
    // refused, the message still went on the wire: the hour counts from it
    expect(savedFile(stateDir).active).toEqual([{ day: "2026-10-08", harnesses: ["claude"], sent: null, visited: true, usage: emptyUsage(), sent_usage: null, wire_usage: emptyUsage(), sent_at: expect.any(Number) }]);
    answer.status = 204;
    await telemetry.active([]);
    expect(actives.map((active) => active.harnesses)).toEqual([["claude"], ["claude"]]);
    expect(savedFile(stateDir).active).toEqual([{ day: "2026-10-08", harnesses: ["claude"], sent: ["claude"], visited: true, usage: emptyUsage(), sent_usage: emptyUsage(), wire_usage: emptyUsage(), sent_at: expect.any(Number) }]);
  });

  test("(f) the delivered day survives a restart and is not resent", async () => {
    const first = setup();
    seen(first.telemetry);
    await first.telemetry.active(["claude"]);
    expect(first.actives).toHaveLength(1);
    const again = setup({ stateDir: first.stateDir });
    await again.telemetry.active(["claude"]);
    again.telemetry.change({ enabled: true });
    await settled();
    expect(again.actives).toEqual([]);
    expect(again.telemetry.status().active).toMatchObject({ day: "2026-10-08", harnesses: ["claude"], install_id: first.actives[0]!.install_id });
  });

  test("(g) status().active previews today's message as it would be sent", async () => {
    const { telemetry } = setup();
    seen(telemetry);
    const before = telemetry.status().active;
    expect(before).toEqual({ event: "active", day: "2026-10-08", install_id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: "0.4.1", os: "linux", arch: "x64", install_method: "source", harnesses: [], usage: emptyUsage(), runtime: "herdr" });
    await telemetry.active(["codex", "claude", undefined]);
    expect(telemetry.status().active).toEqual({ ...before, harnesses: ["claude", "codex"] });
  });

  test("(h) every supported agent kind is a telemetry harness, or other until the Worker lists it", () => {
    // the deployed Worker refuses a harness it does not list, so these count as other until a deploy adds them
    const undeployed = new Set(["letta", "copilot", "dsh-tui"]);
    for (const kind of undeployed) expect(harnessOf(kind)).toBe("other");
    const missing = [...SUPPORTED_AGENT_KINDS].filter((kind) => !undeployed.has(kind) && !(TELEMETRY_HARNESSES as readonly string[]).includes(kind));
    if (missing.length > 0) throw new Error(`${missing.join(", ")}: add it to TELEMETRY_HARNESSES and deploy the Worker`);
    expect(missing).toEqual([]);
  });

  test("(j) a visit before the notice is not kept: once it is seen, only a later visit goes, after the grace", async () => {
    const { telemetry, actives, clock } = setup({ grace: 600_000 });
    await telemetry.active(["claude"], { surface: "ios-app", ingress: "tailscale" });
    expect(telemetry.status().active).toMatchObject({ harnesses: [], usage: emptyUsage() });
    expect((await handleTelemetryRequest(telemetryPost({ notice_seen: true, notice_version: NOTICE_VERSION }), telemetry)).status).toBe(200);
    await settled();
    clock.now += 600_001;
    await telemetry.active([]);
    expect(actives.map((active) => [active.day, active.harnesses, active.usage.surfaces])).toEqual([["2026-10-08", [], []]]);
  });

  test("nothing is kept before the current notice: a new install, and one whose older notice did not name it", async () => {
    // a new install: a visit, its usage and the settings told before the acknowledgement are not kept
    const fresh = setup({ grace: 600_000 });
    await fresh.telemetry.active(["claude"], { surface: "ios-app", ingress: "tailscale" });
    fresh.telemetry.tally("prompt_answers");
    expect((await handleTelemetryRequest(telemetryPost({ settings: settingsSnapshot() }), fresh.telemetry)).status).toBe(200);
    expect(fresh.telemetry.status()).toMatchObject({ notice_seen: false, active: { harnesses: [], usage: emptyUsage() }, next: { settings: null } });
    expect(existsSync(join(fresh.stateDir, "telemetry.json")) ? savedFile(fresh.stateDir) : { active: [], settings: null }).toMatchObject({ active: [], settings: null });
    // an older build may have kept a visit day or a settings snapshot from before its notice: from a file without the mark
    // neither is kept, whatever notice it saw
    const day = { day: "2026-10-07", harnesses: ["claude"], sent: null, visited: true, usage: { ...emptyUsage(), prompt_answers: 2 }, sent_usage: null, sent_at: null };
    const cases: [number, { active: (typeof day)[]; settings: TelemetrySettings | null }][] = [[2, { active: [], settings: null }], [3, { active: [], settings: null }], [4, { active: [], settings: null }]];
    for (const [older, kept] of cases) {
      const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
      dirs.push(stateDir);
      writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: older, reported_version: "0.4.1", settings: settingsSnapshot(), active: [day] }));
      const { telemetry, actives } = setup({ stateDir });
      expect(telemetry.status().notice_seen).toBe(false);
      telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
      await settled();
      expect(savedFile(stateDir).settings).toEqual(kept.settings);
      expect(actives.map((active): unknown[] => [active.day, active.harnesses, active.usage])).toEqual(kept.active.map((entry) => [entry.day, entry.harnesses, entry.usage]));
    }
  });

  test("an off drops every visit day and usage not yet sent, and on again sends nothing from before it", async () => {
    for (const off of ["here", "another server"] as const) {
      const { telemetry, actives, clock, stateDir } = setup({ grace: 600_000 });
      seen(telemetry);
      await telemetry.active(["claude"], { surface: "ios-app", ingress: "tailscale" });
      telemetry.tally("prompt_answers");
      expect(savedFile(stateDir).active).toHaveLength(1);
      if (off === "here") {
        expect((await handleTelemetryRequest(telemetryPost({ enabled: false }), telemetry)).status).toBe(200);
        expect(savedFile(stateDir).active).toEqual([]);
      } else writeFileSync(join(stateDir, "telemetry-off"), "");
      expect(telemetry.status().enabled).toBe(false);
      expect((await handleTelemetryRequest(telemetryPost({ enabled: true }), telemetry)).status).toBe(200);
      clock.now += 600_001;
      telemetry.change({ enabled: true });
      await settled();
      expect(actives).toEqual([]);
      expect(savedFile(stateDir).active).toEqual([]);
    }
  });

  test("an event owed across an off goes after the on with what holds then: no settings, no version it replaced", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.0", settings: null, active: [], usage_after_notice: true, counts: [] }));
    const { telemetry, sent } = setup({ stateDir, status: 503 });
    expect((await handleTelemetryRequest(telemetryPost({ settings: settingsSnapshot({ theme: "light" }), generation: 0 }), telemetry)).status).toBe(200);
    expect(telemetry.status().next).toMatchObject({ event: "update", previous_version: "0.4.0", settings: settingsSnapshot({ theme: "light" }) });
    expect((await handleTelemetryRequest(telemetryPost({ enabled: false }), telemetry)).status).toBe(200);
    expect((await handleTelemetryRequest(telemetryPost({ enabled: true }), telemetry)).status).toBe(200);
    const next = { event: "update", install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", version: "0.4.1", previous_version: null, settings: null };
    expect(telemetry.status().next).toMatchObject(next);
    expect(savedFile(stateDir).settings).toBeNull();
    await settled();
    expect(sent.at(-1)).toMatchObject(next);
  });

  test("an on with nothing owed names the version running then as what a later update replaced", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null, active: [], usage_after_notice: true, counts: [] }));
    const { telemetry } = setup({ stateDir });
    telemetry.change({ enabled: false });
    telemetry.change({ enabled: true });
    const updated = setup({ stateDir, version: "0.4.2" });
    expect(updated.telemetry.status().next).toMatchObject({ event: "update", previous_version: "0.4.1" });
  });

  test("a day a 0.5.4 file kept and did not deliver is dropped (it may be from before the notice); a delivered one stays delivered", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null, usage_after_notice: true, counts: [],
      active: [
        { day: "2026-10-07", harnesses: ["codex"], sent: ["codex"], visited: true, usage: emptyUsage(), sent_usage: emptyUsage(), wire_usage: emptyUsage(), sent_at: Date.parse("2026-10-07T09:00:00Z") },
        { day: "2026-10-08", harnesses: ["claude"], sent: null, visited: true, usage: emptyUsage(), sent_usage: null, wire_usage: null, sent_at: null },
      ],
    }));
    const { telemetry, actives, stateDir: dir } = setup({ stateDir });
    telemetry.change({ enabled: true });
    await settled();
    expect(actives).toEqual([]);
    expect(savedFile(dir).active.map((entry: { day: string }) => entry.day)).toEqual(["2026-10-07"]);
  });

  test("a pane read across an off and an on adds nothing to a later visit of the same day", async () => {
    const { telemetry, actives, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    const before = Promise.withResolvers<string[]>();
    const first = telemetry.active(before.promise);
    telemetry.change({ enabled: false });
    telemetry.change({ enabled: true });
    await telemetry.active(["codex"]);
    before.resolve(["claude"]);
    await first;
    expect(savedFile(stateDir).active.map((entry: { day: string; harnesses: string[] }) => [entry.day, entry.harnesses])).toEqual([["2026-10-08", ["codex"]]]);
    expect(actives).toEqual([]);
  });

  test("a send begun before another server's off and on neither sends nor writes back the days that off deleted", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const days: string[] = [];
    const { telemetry, clock } = setup({
      stateDir,
      grace: 129_600_000,
      fetch: (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(url) === TEST_ACTIVE_URL) {
          days.push((JSON.parse(String(init?.body)) as TelemetryActive).day);
          const other = setup({ stateDir }).telemetry;
          other.change({ enabled: false });
          other.change({ enabled: true });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    seen(telemetry);
    await telemetry.active(["claude"]);
    clock.now += 86_400_000;
    await telemetry.active(["codex"]);
    clock.now += 86_400_000;
    telemetry.change({ enabled: true });
    await settled();
    expect(days).toEqual(["2026-10-08"]);
    expect(savedFile(stateDir).active).toEqual([]);
  });

  test("a day kept before the environment forbade sending is not sent once it allows it again", async () => {
    for (const env of [{ OVIS_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }] as Record<string, string>[]) {
      const { telemetry, stateDir } = setup({ grace: 600_000 });
      seen(telemetry);
      telemetry.change({ settings: settingsSnapshot({ theme: "light" }) });
      await telemetry.active(["claude"], { surface: "ios-app", ingress: "tailscale" });
      telemetry.tally("prompt_answers");
      setup({ stateDir, env });
      const allowed = setup({ stateDir, grace: 0 });
      allowed.telemetry.change({ enabled: true });
      await settled();
      expect(allowed.actives).toEqual([]);
      expect(savedFile(stateDir)).toMatchObject({ active: [], settings: null });
    }
  });

  test("an older build's settings snapshot is not sent: it waits for a page to tell them again", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.0", settings: settingsSnapshot({ theme: "dark" }), active: [], usage_after_notice: true, counts: [] }));
    const { telemetry, sent } = setup({ stateDir });
    expect(telemetry.status().next).toMatchObject({ event: "update", previous_version: "0.4.0", settings: null });
    telemetry.change({ settings: settingsSnapshot({ theme: "light" }), generation: 0 });
    await telemetry.report();
    expect(sent.at(-1)).toMatchObject({ event: "update", settings: settingsSnapshot({ theme: "light" }) });
  });

  test("a start with sending forbidden is an off: a later update names no version from before it, and settings told then are not kept", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null, active: [], usage_after_notice: true, visits_after_notice: true, counts: [] }));
    const blocked = setup({ stateDir, env: { OVIS_TELEMETRY: "0" } });
    expect((await handleTelemetryRequest(telemetryPost({ settings: settingsSnapshot({ theme: "light" }) }), blocked.telemetry)).status).toBe(200);
    expect(savedFile(stateDir).settings).toBeNull();
    const updated = setup({ stateDir, version: "0.4.2" });
    expect(updated.telemetry.status().next).toMatchObject({ event: "update", previous_version: null, settings: null });
  });

  test("an install event answered after another server's off and on does not count as reported", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.0", settings: null, active: [], usage_after_notice: true, visits_after_notice: true, counts: [] }));
    const sent: TelemetryEvent[] = [];
    const telemetry = new Telemetry({
      stateDir, version: "0.4.1", env: {}, url: "https://telemetry.test/v1/events", activeUrl: TEST_ACTIVE_URL, platform: "linux", arch: "x64", noticeGraceMs: 0, now: () => Date.parse("2026-10-08T12:00:00Z"),
      fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        sent.push(JSON.parse(String(init?.body)) as TelemetryEvent);
        const other = setup({ stateDir, status: 503 }).telemetry;
        other.change({ enabled: false });
        other.change({ enabled: true });
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await telemetry.report();
    expect(sent.map((event) => [event.event, event.previous_version])).toEqual([["update", "0.4.0"]]);
    // still owed, and now from the state after the off: no version it replaced
    expect(savedFile(stateDir)).toMatchObject({ reported_version: "0.4.0", replaced_forgotten: true });
    expect(telemetry.status().next).toMatchObject({ event: "update", previous_version: null });
  });

  test("a write from before another server's off neither lowers its counter nor brings its days back", async () => {
    const { telemetry, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    const before = savedFile(stateDir).forgotten;
    setup({ stateDir }).telemetry.change({ enabled: false });
    setup({ stateDir }).telemetry.change({ enabled: true });
    (telemetry as unknown as { persist(): void }).persist();
    expect(savedFile(stateDir)).toMatchObject({ forgotten: before + 2, active: [] });
  });

  test("a 0.5.4 file's delivered day is cut back to what was delivered: what was added after it is not sent", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const sentUsage = { ...emptyUsage(), surfaces: ["browser"] };
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null, usage_after_notice: true, counts: [],
      active: [{ day: "2026-10-08", harnesses: ["claude", "codex"], sent: ["claude"], visited: true, usage: { ...emptyUsage(), surfaces: ["browser", "ios-app"], prompt_answers: 3 }, sent_usage: sentUsage, wire_usage: sentUsage, sent_at: Date.parse("2026-10-08T09:00:00Z") }],
    }));
    const { telemetry, actives } = setup({ stateDir });
    telemetry.change({ enabled: true });
    await settled();
    expect(actives).toEqual([]);
    expect(savedFile(stateDir).active).toEqual([expect.objectContaining({ day: "2026-10-08", harnesses: ["claude"], usage: sentUsage })]);
  });

  test("a start with sending forbidden whose deletion cannot be written removes the state file instead", async () => {
    const { telemetry, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    mkdirSync(join(stateDir, `telemetry.json.${process.pid}.tmp`));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try { setup({ stateDir, env: { DO_NOT_TRACK: "1" } }); } finally { errors.mockRestore(); }
    expect(existsSync(join(stateDir, "telemetry.json"))).toBe(false);
  });

  test("settings told with a generation from before an off the page did not hear are not kept, nor any that name none", async () => {
    const { telemetry, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    expect(telemetry.status().counts_generation).toBe(0);
    telemetry.change({ enabled: false });
    telemetry.change({ enabled: true });
    expect((await handleTelemetryRequest(telemetryPost({ settings: settingsSnapshot({ theme: "light" }), generation: 0 }), telemetry)).status).toBe(200);
    expect((await handleTelemetryRequest(telemetryPost({ settings: settingsSnapshot({ theme: "light" }) }), telemetry)).status).toBe(200);
    expect(savedFile(stateDir).settings).toBeNull();
    // told with the generation as it is now: kept
    const now = telemetry.status().counts_generation;
    expect((await handleTelemetryRequest(telemetryPost({ settings: settingsSnapshot({ theme: "light" }), generation: now }), telemetry)).status).toBe(200);
    expect(savedFile(stateDir).settings).toEqual(settingsSnapshot({ theme: "light" }));
    expect((await handleTelemetryRequest(telemetryPost({ settings: settingsSnapshot(), generation: -1 }), telemetry)).status).toBe(400);
  });

  test("a 0.5.4 file that is off with days and a snapshot holds none of them after one start", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const day = { day: "2026-10-08", harnesses: ["claude"], sent: null, visited: true, usage: emptyUsage(), sent_usage: null, wire_usage: null, sent_at: null };
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: false, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: settingsSnapshot(), usage_after_notice: true, active: [day], counts: [{ day: "2026-10-08", version: "0.4.1", narrow: null, wide: { counts: { chat_send: 2 }, shown: [] } }] }));
    setup({ stateDir });
    expect(savedFile(stateDir)).toMatchObject({ enabled: false, active: [], counts: [], settings: null });
  });

  test("a marked file left off with a snapshot (a stop between the mark and the cleaned write) holds none after one start", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", replaced_forgotten: false, forgotten: 0, visits_after_notice: true, settings: settingsSnapshot(), usage_after_notice: true, active: [], counts: [] }));
    writeFileSync(join(stateDir, "telemetry-off"), "");
    setup({ stateDir });
    expect(savedFile(stateDir)).toMatchObject({ settings: null, active: [], counts: [] });
  });

  test("an off another server makes while this server applies an on wins: the on writes nothing and leaves the mark", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: null, notice_version: NOTICE_VERSION, reported_version: "0.4.1", replaced_forgotten: false, forgotten: 0, visits_after_notice: true, settings: null, usage_after_notice: true, active: [], counts: [] }));
    let offAtClock = false;
    const telemetry = new Telemetry({
      stateDir, version: "0.4.1", env: {}, fetch: (async () => new Response(null, { status: 204 })) as unknown as typeof fetch, platform: "linux", arch: "x64", noticeGraceMs: 600_000,
      now: () => {
        if (offAtClock) { offAtClock = false; setup({ stateDir }).telemetry.change({ enabled: false }); }
        return Date.parse("2026-10-08T12:00:00Z");
      },
    });
    // the other server's off cannot get this server's lock: it goes without it, as an off does
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      offAtClock = true;
      telemetry.change({ enabled: true, notice_seen: true, notice_version: NOTICE_VERSION });
    } finally { errors.mockRestore(); }
    expect(existsSync(join(stateDir, "telemetry-off"))).toBe(true);
    expect(savedFile(stateDir).enabled).toBe(false);
  });

  test("a lock another live server holds keeps a count out, but an off still goes and nothing is sent after it", async () => {
    const { telemetry, actives, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    writeFileSync(join(stateDir, "telemetry.lock"), `${process.ppid} ${Date.now()}`);
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      telemetry.tally("prompt_answers");
      expect(savedFile(stateDir).active[0].usage.prompt_answers).toBe(0);
      expect(errors.mock.calls.some(([line]) => String(line).includes("telemetry.lock"))).toBe(true);
      // the off does not wait for it to be let go: marked, and what was not sent deleted
      telemetry.change({ enabled: false });
      expect(existsSync(join(stateDir, "telemetry-off"))).toBe(true);
      expect(savedFile(stateDir)).toMatchObject({ enabled: false, active: [] });
    } finally { errors.mockRestore(); }
    rmSync(join(stateDir, "telemetry.lock"));
    await settled();
    expect(actives).toEqual([]);
  });

  test("a lock whose server is gone, this process's own from an earlier run, one never given a pid, or one held for minutes is taken over; a live holder's is not", () => {
    {
      const { telemetry, stateDir } = setup({ grace: 600_000 });
      seen(telemetry);
      void telemetry.active(["claude"]);
      writeFileSync(join(stateDir, "telemetry.lock"), `${process.ppid} ${Date.now() - 60_000}`);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try { telemetry.tally("prompt_answers"); } finally { errors.mockRestore(); }
      expect(savedFile(stateDir).active[0].usage.prompt_answers).toBe(0);
      expect(existsSync(join(stateDir, "telemetry.lock"))).toBe(true);
    }
    {
      const { telemetry, stateDir } = setup({ grace: 600_000 });
      seen(telemetry);
      void telemetry.active(["claude"]);
      writeFileSync(join(stateDir, "telemetry.lock"), "");
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try { telemetry.tally("prompt_answers"); } finally { errors.mockRestore(); }
      expect(savedFile(stateDir).active[0].usage.prompt_answers).toBe(0);
    }
    for (const lock of [`${process.pid} ${Date.now()} earlier-run`, `${process.ppid} ${Date.now() - 10 * 60_000}`]) {
      const { telemetry, stateDir } = setup({ grace: 600_000 });
      seen(telemetry);
      void telemetry.active(["claude"]);
      const file = join(stateDir, "telemetry.lock");
      writeFileSync(file, lock);
      if (lock.startsWith(`${process.ppid} `)) utimesSync(file, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
      telemetry.tally("prompt_answers");
      expect(savedFile(stateDir).active[0].usage.prompt_answers).toBe(1);
      expect(existsSync(file)).toBe(false);
    }
    for (const lock of [`999999999 ${Date.now()}`, "garbage"]) {
      const { telemetry, stateDir } = setup({ grace: 600_000 });
      seen(telemetry);
      void telemetry.active(["claude"]);
      const file = join(stateDir, "telemetry.lock");
      writeFileSync(file, lock);
      if (lock === "garbage") utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
      telemetry.tally("prompt_answers");
      expect(savedFile(stateDir).active[0].usage.prompt_answers).toBe(1);
      expect(existsSync(file)).toBe(false);
    }
  });

  test("a lock another server holds for a moment is waited for", async () => {
    const { telemetry, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    const file = join(stateDir, "telemetry.lock");
    const child = Bun.spawn(["bun", "-e", `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(file)}, process.pid + " " + Date.now(), { flag: "wx" }); console.log("HELD"); setTimeout(() => fs.rmSync(${JSON.stringify(file)}), 40);`], { stdout: "pipe" });
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("HELD");
    telemetry.tally("prompt_answers");
    expect(savedFile(stateDir).active[0].usage.prompt_answers).toBe(1);
    expect(await child.exited).toBe(0);
  });

  test("a server removes only the lock it took, not one another server holds since", () => {
    const { telemetry, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    const file = join(stateDir, "telemetry.lock");
    (telemetry as unknown as { locked<T>(section: () => T, busy: () => T): T }).locked(() => { writeFileSync(file, `${process.ppid} ${Date.now()} other`); }, () => undefined);
    expect(readFileSync(file, "utf8")).toContain("other");
    rmSync(file);
  });

  test("a section whose lock was taken over while it held it writes nothing back", async () => {
    const { telemetry, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    const file = join(stateDir, "telemetry.lock");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      (telemetry as unknown as { locked<T>(section: () => T, busy: () => T): T }).locked(() => {
        writeFileSync(file, `${process.ppid} ${Date.now()} other`);
        setup({ stateDir }).telemetry.change({ enabled: false });
        rmSync(join(stateDir, "telemetry-off"), { force: true });
        writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ ...savedFile(stateDir), enabled: true }));
        telemetry.tally("prompt_answers");
      }, () => undefined);
    } finally { errors.mockRestore(); }
    expect(savedFile(stateDir)).toMatchObject({ active: [], forgotten: 1 });
    rmSync(file);
  });

  test("an off is marked before it waits for another server's lock, so that server's next send already finds it", async () => {
    const { telemetry, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    const lock = join(stateDir, "telemetry.lock");
    const off = join(stateDir, "telemetry-off");
    const child = Bun.spawn(["bun", "-e", `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(lock)}, process.pid + " " + Date.now(), { flag: "wx" }); console.log("HELD"); const start = Date.now(); let seen = false; while (Date.now() - start < 150) { if (fs.existsSync(${JSON.stringify(off)})) { seen = true; break; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); } console.log(seen ? "SEEN" : "NOT"); fs.rmSync(${JSON.stringify(lock)});`], { stdout: "pipe" });
    const reader = child.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("HELD");
    telemetry.change({ enabled: false });
    expect(await child.exited).toBe(0);
    let rest = "";
    for (;;) { const { value, done } = await reader.read(); if (done) break; rest += new TextDecoder().decode(value); }
    expect(rest).toContain("SEEN");
    expect(savedFile(stateDir).enabled).toBe(false);
  });

  test("a server never waits on its own lock and leaves none behind", async () => {
    const { telemetry, stateDir } = setup({ grace: 600_000 });
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      seen(telemetry);
      await telemetry.active(["claude"]);
      telemetry.tally("prompt_answers");
      telemetry.change({ enabled: false });
      telemetry.change({ enabled: true });
      expect(errors.mock.calls.some(([line]) => String(line).includes("telemetry.lock"))).toBe(false);
    } finally { errors.mockRestore(); }
    expect(existsSync(join(stateDir, "telemetry.lock"))).toBe(false);
  });

  test("(k) an install that was never visited sends no active message", async () => {
    const { telemetry, actives, sent } = setup();
    seen(telemetry);
    telemetry.change({ enabled: false });
    telemetry.change({ enabled: true });
    await settled();
    expect(actives).toEqual([]);
    expect(sent.map((event) => event.event)).toEqual(["install"]);
  });

  test("(l) a visit held by the grace across midnight is delivered for its own day", async () => {
    const { telemetry, actives, clock, nextActive, fireTimer } = setup({ grace: 600_000, now: "2026-10-08T23:55:00Z" });
    seen(telemetry);
    clock.now = Date.parse("2026-10-08T23:56:00Z");
    await telemetry.active(["claude"]);
    clock.now = Date.parse("2026-10-09T00:07:00Z");
    const delivered = nextActive();
    fireTimer();
    expect(await delivered).toMatchObject({ day: "2026-10-08", harnesses: ["claude"] });
    await settled();
    expect(actives).toHaveLength(1);
    expect(telemetry.status().active).toMatchObject({ day: "2026-10-09", harnesses: [] });
  });

  test("(m) an undelivered day older than ACTIVE_LATE_DAYS is dropped and never sent", async () => {
    const { telemetry, actives, clock, stateDir } = setup({ grace: ACTIVE_LATE_DAYS * 86_400_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    clock.now += 86_400_000;
    await telemetry.active(["codex"]);
    clock.now += ACTIVE_LATE_DAYS * 86_400_000;
    telemetry.change({ enabled: true });
    await settled();
    expect(actives.map((active) => [active.day, active.harnesses])).toEqual([["2026-10-09", ["codex"]]]);
    expect(savedFile(stateDir).active.map((entry: { day: string }) => entry.day)).toEqual(["2026-10-09"]);
  });

  test("(n) agents read after midnight still count for the day of the visit", async () => {
    const { telemetry, actives, clock } = setup({ now: "2026-10-08T23:59:59Z" });
    seen(telemetry);
    const agents = Promise.withResolvers<string[]>();
    const visit = telemetry.active(agents.promise);
    clock.now = Date.parse("2026-10-09T00:00:05Z");
    agents.resolve(["codex"]);
    await visit;
    expect(actives.map((active) => [active.day, active.harnesses])).toEqual([["2026-10-08", ["codex"]]]);
    expect(telemetry.status().active).toMatchObject({ day: "2026-10-09", harnesses: [] });
  });

  test("(p) a visit whose panes are read across an off and an on is not kept, and nothing of it is sent", async () => {
    const { telemetry, actives, stateDir } = setup({ grace: 600_000 });
    seen(telemetry);
    const agents = Promise.withResolvers<string[]>();
    const visit = telemetry.active(agents.promise);
    expect(savedFile(stateDir).active).toHaveLength(1);
    telemetry.change({ enabled: false });
    telemetry.change({ enabled: true });
    agents.resolve(["codex"]);
    await visit;
    expect(savedFile(stateDir).active).toEqual([]);
    await settled();
    expect(actives).toEqual([]);
  });

  test("(o) a pane read that fails still counts the visit", async () => {
    const { telemetry, actives, stateDir } = setup();
    seen(telemetry);
    await telemetry.active(Promise.reject(new Error("herdr down")));
    expect(actives.map((active) => [active.day, active.harnesses])).toEqual([["2026-10-08", []]]);
    expect(savedFile(stateDir).active).toEqual([{ day: "2026-10-08", harnesses: [], sent: [], visited: true, usage: emptyUsage(), sent_usage: emptyUsage(), wire_usage: emptyUsage(), sent_at: expect.any(Number) }]);
  });

  test("an unreadable active list in the state file is read as no visits", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null,
      active: [{ day: "yesterday", harnesses: [], sent: null }, { day: "2026-10-07", harnesses: ["pi", "claude"], sent: null }, { day: "2026-10-07", harnesses: ["cursor"], sent: null }, { day: "2026-10-08", harnesses: ["claude"], sent: ["claude"] }],
    }));
    const { telemetry, actives } = setup({ stateDir });
    expect(telemetry.status().active).toMatchObject({ day: "2026-10-08", harnesses: ["claude"] });
    await telemetry.active([]);
    expect(actives).toEqual([]);
  });
});

describe("daily usage", () => {
  const tap = () => new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ alert_opened: true }) });
  test("a visit names its kind of screen and way in, and the day's message carries them sorted, once each", async () => {
    const { telemetry, actives, clock } = setup();
    seen(telemetry);
    await telemetry.active(["claude"], { surface: "mobile-pwa", ingress: "tailscale" });
    await telemetry.active(["claude"], { surface: "browser", ingress: "local" });
    await telemetry.active(["claude"], { surface: "mobile-pwa", ingress: "tailscale" });
    clock.now += USAGE_RESEND_MS;
    await telemetry.active(["claude"]);
    expect(actives.map((active) => active.usage)).toEqual([
      { ...emptyUsage(), surfaces: ["mobile-pwa"], ingress: ["tailscale"] },
      { ...emptyUsage(), surfaces: ["browser", "mobile-pwa"], ingress: ["local", "tailscale"] },
    ]);
  });

  test("today's usage goes at most once an hour, with the next visit after it: a new screen, way in, agent or tap sends no fresher usage", async () => {
    const { telemetry, actives, clock } = setup();
    seen(telemetry);
    await telemetry.active(["claude"], { surface: "browser", ingress: "local" });
    clock.now += 1_000;
    telemetry.tally("prompt_answers");
    telemetry.tally("prompt_answers");
    telemetry.tally("alerts_delivered");
    // a second later a new kind of screen and way in send nothing: they wait with the counts
    await telemetry.active(["claude"], { surface: "ios-app", ingress: "tailscale" });
    expect(actives).toHaveLength(1);
    expect(telemetry.status().active.usage).toEqual({ surfaces: ["browser", "ios-app"], ingress: ["local", "tailscale"], prompt_answers: 2, alerts_delivered: 1, alerts_opened: 0 });
    // a new kind of agent still goes at once, as it did before usage, but with the usage already sent
    await telemetry.active(["codex"]);
    const first: TelemetryUsage = { ...emptyUsage(), surfaces: ["browser"], ingress: ["local"] };
    expect(actives.map((active) => [active.harnesses, active.usage])).toEqual([[["claude"], first], [["claude", "codex"], first]]);
    // past the hour a tapped alert is counted but sends nothing by itself; the next visit takes it all
    clock.now += USAGE_RESEND_MS;
    expect((await handleTelemetryRequest(tap(), telemetry)).status).toBe(200);
    await settled();
    expect(actives).toHaveLength(2);
    await telemetry.active(["codex"]);
    expect(actives.map((active) => active.usage).at(-1)).toEqual({ surfaces: ["browser", "ios-app"], ingress: ["local", "tailscale"], prompt_answers: 2, alerts_delivered: 1, alerts_opened: 1 });
    expect(actives).toHaveLength(3);
  });

  test("usage that went out without its answer still holds the hour, across a restart: a retry carries what went", async () => {
    for (const restart of [false, true]) {
      const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
      dirs.push(stateDir);
      const bodies: TelemetryActive[] = [];
      const lost = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(url) === TEST_ACTIVE_URL) bodies.push(JSON.parse(String(init?.body)) as TelemetryActive);
        throw new Error("connection reset");
      }) as typeof fetch;
      const first = setup({ stateDir, fetch: lost });
      seen(first.telemetry);
      await first.telemetry.active(["claude"], { surface: "browser", ingress: "local" });
      const later = restart ? setup({ stateDir, fetch: lost, now: "2026-10-08T12:00:01Z" }) : first;
      if (!restart) later.clock.now += 1_000;
      later.telemetry.tally("prompt_answers");
      await later.telemetry.active(["claude"], { surface: "ios-app", ingress: "tailscale" });
      expect(bodies.map((body) => body.usage)).toEqual([
        { ...emptyUsage(), surfaces: ["browser"], ingress: ["local"] },
        { ...emptyUsage(), surfaces: ["browser"], ingress: ["local"] },
      ]);
    }
  });

  test("a state file that cannot be written just before a message goes stops only that try: the next visit sends", async () => {
    const { telemetry, actives, stateDir, clock, fireTimer } = setup({ grace: 60_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    clock.now += 60_000;
    const temp = join(stateDir, `telemetry.json.${process.pid}.tmp`);
    mkdirSync(temp);
    fireTimer();
    await settled();
    rmSync(temp, { recursive: true });
    expect(actives).toEqual([]);
    await telemetry.active(["codex"]);
    expect(actives.map((active) => active.harnesses)).toEqual([["claude", "codex"]]);
  });

  test("a day's last usage keeps the hour across midnight, also when an answer was lost: the next day's first visit sends only that day", async () => {
    for (const lose of [false, true]) {
      const bodies: TelemetryActive[] = [];
      const receiver = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(url) === TEST_ACTIVE_URL) bodies.push(JSON.parse(String(init?.body)) as TelemetryActive);
        if (lose) throw new Error("connection reset");
        return new Response(null, { status: 204 });
      }) as typeof fetch;
      const { telemetry, clock } = setup({ fetch: receiver, now: "2026-10-08T23:59:59Z" });
      seen(telemetry);
      await telemetry.active(["claude"]);
      telemetry.tally("prompt_answers");
      clock.now += 1_000;
      await telemetry.active(["claude"]);
      const late = bodies.filter((body) => body.day === "2026-10-08").map((body) => body.usage.prompt_answers);
      expect(late.every((answers) => answers === 0)).toBe(true);
      expect(bodies.map((body) => body.day)).toEqual(lose ? ["2026-10-08", "2026-10-08"] : ["2026-10-08", "2026-10-09"]);
      clock.now += USAGE_RESEND_MS;
      await telemetry.active(["claude"]);
      expect(bodies.filter((body) => body.day === "2026-10-08").at(-1)!.usage.prompt_answers).toBe(1);
    }
  });

  test("fresh usage goes only with a visit: a settings change or a late notice timer past the hour sends none", async () => {
    const { telemetry, actives, clock, fireTimer } = setup({ grace: 60_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    clock.now += 60_000;
    fireTimer();
    await settled();
    expect(actives).toHaveLength(1);
    clock.now += USAGE_RESEND_MS;
    telemetry.tally("alerts_delivered");
    telemetry.change({ settings: settingsSnapshot() });
    await settled();
    expect(actives).toHaveLength(1);
    await telemetry.active(["claude"]);
    expect(actives.map((active) => active.usage.alerts_delivered)).toEqual([0, 1]);
  });

  test("nothing of the day's usage is kept before the current notice, on a new install or after an older notice", async () => {
    for (const older of [null, NOTICE_VERSION - 1]) {
      const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
      dirs.push(stateDir);
      if (older !== null) {
        writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: older, reported_version: "0.4.1", settings: null, active: [] }));
      }
      const before = setup({ stateDir });
      await before.telemetry.active(["claude"], { surface: "ios-app", ingress: "tailscale" });
      before.telemetry.tally("prompt_answers");
      before.telemetry.tally("alerts_delivered");
      expect((await handleTelemetryRequest(tap(), before.telemetry)).status).toBe(200);
      expect(existsSync(join(stateDir, "telemetry.json")) ? savedFile(stateDir).active : []).toEqual([]);
      // after a restart and the notice, the day goes out without anything counted before it
      const after = setup({ stateDir });
      seen(after.telemetry);
      await after.telemetry.active(["claude"]);
      expect(after.actives.map((active) => [active.harnesses, active.usage])).toEqual([[["claude"], emptyUsage()]]);
      expect(before.actives).toEqual([]);
    }
  });

  test("usage a build before the notice rule kept is dropped once, and sends nothing for it", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const kept = { surfaces: ["ios-app"], ingress: ["tailscale"], prompt_answers: 3, alerts_delivered: 2, alerts_opened: 1 };
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null,
      active: [
        { day: "2026-10-06", harnesses: [], sent: null, visited: false, usage: { ...emptyUsage(), alerts_delivered: 1 }, sent_usage: null, sent_at: null },
        { day: "2026-10-07", harnesses: ["claude"], sent: ["claude"], visited: true, usage: { ...kept, prompt_answers: 5 }, sent_usage: kept, sent_at: Date.parse("2026-10-07T09:00:00Z") },
        { day: "2026-10-08", harnesses: ["claude"], sent: null, visited: true, usage: kept, sent_usage: null, sent_at: null },
      ],
    }));
    const { telemetry, actives } = setup({ stateDir });
    expect(telemetry.status().active.usage).toEqual(emptyUsage());
    await telemetry.active(["claude"]);
    expect(actives.map((active) => [active.day, active.usage])).toEqual([["2026-10-08", emptyUsage()]]);
    expect(savedFile(stateDir).active.map((entry: { day: string; usage: unknown }) => [entry.day, entry.usage])).toEqual([["2026-10-07", emptyUsage()], ["2026-10-08", emptyUsage()]]);
  });

  test("a day's last counts go out with the next day's visit, under their own day", async () => {
    const { telemetry, actives, clock } = setup();
    seen(telemetry);
    await telemetry.active(["claude"]);
    telemetry.tally("alerts_delivered");
    telemetry.tally("alerts_opened");
    clock.now += 86_400_000;
    await telemetry.active([]);
    expect(actives.map((active) => [active.day, active.usage.alerts_delivered, active.usage.alerts_opened])).toEqual([
      ["2026-10-08", 0, 0], ["2026-10-08", 1, 1], ["2026-10-09", 0, 0],
    ]);
  });

  test("a count on a day the app is not opened is kept for that day's visit and never sent alone", async () => {
    const { telemetry, actives, clock, stateDir } = setup();
    seen(telemetry);
    telemetry.tally("alerts_delivered");
    await settled();
    expect(actives).toEqual([]);
    expect(savedFile(stateDir).active).toEqual([{ day: "2026-10-08", harnesses: [], sent: null, visited: false, usage: { ...emptyUsage(), alerts_delivered: 1 }, sent_usage: null, wire_usage: null, sent_at: null }]);
    clock.now += 86_400_000;
    telemetry.tally("alerts_delivered");
    clock.now += 86_400_000;
    await telemetry.active([]);
    expect(actives.map((active) => active.day)).toEqual(["2026-10-10"]);
    const later = setup();
    seen(later.telemetry);
    later.telemetry.tally("alerts_opened");
    await later.telemetry.active(["claude"], { surface: "ios-app" });
    expect(later.actives.map((active) => active.usage)).toEqual([{ ...emptyUsage(), surfaces: ["ios-app"], alerts_opened: 1 }]);
  });

  test("nothing is counted while off or blocked, and a count stops at its most", () => {
    const off = setup();
    off.telemetry.change({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION });
    off.telemetry.tally("prompt_answers");
    expect(savedFile(off.stateDir).active ?? []).toEqual([]);
    const blocked = setup({ env: { DO_NOT_TRACK: "1" } });
    blocked.telemetry.tally("prompt_answers");
    expect(savedFile(blocked.stateDir).active ?? []).toEqual([]);

    const { telemetry, stateDir } = setup();
    seen(telemetry);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ ...savedFile(stateDir), active: [{ day: "2026-10-08", harnesses: [], sent: null, visited: true, usage: { ...emptyUsage(), prompt_answers: TELEMETRY_COUNT_MAX }, sent_usage: null, sent_at: null }] }));
    telemetry.tally("prompt_answers");
    expect(telemetry.status().active.usage.prompt_answers).toBe(TELEMETRY_COUNT_MAX);
  });

  test("a state file from before usage keeps its delivered days delivered", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({
      install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null,
      active: [{ day: "2026-10-07", harnesses: ["claude"], sent: ["claude"] }, { day: "2026-10-08", harnesses: ["claude"], sent: ["claude"] }],
    }));
    const { telemetry, actives } = setup({ stateDir });
    await telemetry.active(["claude"]);
    expect(actives).toEqual([]);
    expect(telemetry.status().active).toMatchObject({ day: "2026-10-08", usage: emptyUsage() });
  });

  test("a /ws surface no page names counts nothing of its visit's usage; a page that names none still counts its way in", () => {
    expect(visitSurface("ios-app")).toBe("ios-app");
    expect(visitSurface(null)).toBeNull();
    for (const bad of ["", "IOS-APP", "private@example.com", "-1", "x".repeat(9000)]) expect(visitSurface(bad)).toBe(false);
  });

  test("an oversized change is refused, announced or measured, and counts nothing", async () => {
    const { telemetry } = setup();
    seen(telemetry);
    const change = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1", ...headers }, body });
    expect((await handleTelemetryRequest(change(JSON.stringify({ alert_opened: true }), { "content-length": "100000" }), telemetry)).status).toBe(413);
    expect((await handleTelemetryRequest(change(`${" ".repeat(20_000)}${JSON.stringify({ alert_opened: true })}`), telemetry)).status).toBe(413);
    expect(telemetry.status().active.usage).toEqual(emptyUsage());
    expect((await handleTelemetryRequest(change(JSON.stringify({ alert_opened: true })), telemetry)).status).toBe(200);
    expect(telemetry.status().active.usage.alerts_opened).toBe(1);
  });

  test("POST alert_opened counts a tap and nothing else, and takes only true", async () => {
    const { telemetry } = setup();
    seen(telemetry);
    const post = (body: unknown) => new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(body) });
    expect((await handleTelemetryRequest(post({ alert_opened: false }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ alert_opened: 1 }), telemetry)).status).toBe(400);
    const response = await handleTelemetryRequest(post({ alert_opened: true }), telemetry);
    expect(response.status).toBe(200);
    expect((await response.json()).active.usage).toEqual({ ...emptyUsage(), alerts_opened: 1 });
    expect(telemetry.status()).toMatchObject({ enabled: true, notice_seen: true });
  });
});

describe("another server on the same state directory", () => {
  test.each(["active", "install", "update"] as const)("an off first seen on the final re-read stops the %s POST", async (event) => {
    const { telemetry, sent, actives, clock, stateDir, fireTimer } = setup({
      grace: 60_000, previous: event === "update" ? "0.4.0" : null,
    });
    const other = setup({ stateDir, grace: 60_000 });
    seen(telemetry);
    if (event === "active") await telemetry.active(["claude"]);
    clock.now += 60_000;

    const accessSync = fs.accessSync;
    let readsBeforeMark = event === "active" ? 1 : 2;
    const access = spyOn(fs, "accessSync").mockImplementation((path, mode) => {
      accessSync(path, mode);
      if (path === stateDir && !existsSync(join(stateDir, "telemetry.lock")) && --readsBeforeMark === 0) {
        // The other server has marked off and is paused before updating telemetry.json.
        writeFileSync(join(stateDir, "telemetry-off"), "");
      }
    });
    try {
      if (event === "active") fireTimer();
      else await telemetry.report();
      await settled();
    } finally { access.mockRestore(); telemetry.stop(); }
    expect(other.telemetry.status().enabled).toBe(false);
    expect(event === "active" ? actives : sent).toEqual([]);
  });

  test("an off marked while the final check lets go of the lock stops the install POST", async () => {
    const lock = (stateDir: string) => join(stateDir, "telemetry.lock");
    const releasesBeforeSend = async (offAt?: number) => {
      const { telemetry, sent, clock, stateDir } = setup({ grace: 60_000 });
      const other = setup({ stateDir, grace: 60_000 });
      seen(telemetry);
      clock.now += 60_000;
      const rmSync = fs.rmSync;
      let releases = 0;
      let atSend = -1;
      const remove = spyOn(fs, "rmSync").mockImplementation((path, options) => {
        rmSync(path, options);
        if (path !== lock(stateDir)) return;
        releases += 1;
        // the other server's off, between this one letting go of the lock and starting its POST
        if (releases === offAt) other.telemetry.change({ enabled: false });
      });
      const before = sent.length;
      try {
        const going = telemetry.report();
        atSend = releases;
        await going;
        await settled();
      } finally { remove.mockRestore(); telemetry.stop(); }
      return { atSend, sent: sent.slice(before), off: other.telemetry.status().enabled === false };
    };
    const control = await releasesBeforeSend();
    expect(control.sent).toHaveLength(1);
    const raced = await releasesBeforeSend(control.atSend);
    expect(raced.off).toBe(true);
    expect(raced.sent).toEqual([]);
  });

  test("an on told while another server's off is marked but not written keeps no settings", () => {
    const { telemetry, stateDir } = setup();
    seen(telemetry);
    const generation = telemetry.status().counts_generation;
    // the other server's off has marked, and is paused before it writes telemetry.json
    writeFileSync(join(stateDir, "telemetry-off"), "paused off");
    const browser = setup({ stateDir });
    browser.telemetry.change({ enabled: true, settings: settingsSnapshot({ theme: "light" }), generation });
    expect(savedFile(stateDir).settings).toBeNull();
  });

  test("an on asked before a status read marks an older build's off still turns the counts on", () => {
    const { telemetry, stateDir } = setup();
    const other = setup({ stateDir });
    const file = join(stateDir, "telemetry.json");
    // an older build turned the counts off: FILE alone says so, with no mark
    writeFileSync(file, JSON.stringify({ ...savedFile(stateDir), enabled: false }));
    rmSync(join(stateDir, "telemetry-off"), { force: true });
    const off = join(stateDir, "telemetry-off");
    const lstatSync = fs.lstatSync;
    let read = false;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((path: fs.PathLike, options?: fs.StatSyncOptions) => {
      try { return lstatSync(path, options); } finally {
        if (path === off && !read) {
          read = true;
          // the on has looked at the mark (there is none); another server's read marks the older off before the on gets the lock
          other.telemetry.counting();
        }
      }
    }) as typeof fs.lstatSync);
    try { expect(telemetry.change({ enabled: true }).enabled).toBe(true); }
    finally { lstat.mockRestore(); }
    expect(read).toBe(true);
    expect(existsSync(off)).toBe(true);
  });

  test("an on cannot erase an off marked after its last observation of the old mark", () => {
    const { telemetry, stateDir } = setup();
    const other = setup({ stateDir });
    telemetry.change({ enabled: false });
    const off = join(stateDir, "telemetry-off");
    const file = join(stateDir, "telemetry.json");
    const statSync = fs.statSync;
    const lstatSync = fs.lstatSync;
    const renameSync = fs.renameSync;
    let persisted = false;
    let marked = false;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renameSync(from, to);
      if (to === file) persisted = true;
    });
    const interleave: ProxyHandler<fs.StatSyncFn> = {
      apply(target, receiver, args) {
        const result = Reflect.apply(target, receiver, args);
        if (args[0] === off && persisted && !marked) {
          marked = true;
          // The other server has written a fresh off mark and has not taken the state lock yet.
          writeFileSync(off, "a newer off");
        }
        return result;
      },
    };
    const stat = spyOn(fs, "statSync").mockImplementation(new Proxy(statSync, interleave));
    const lstat = spyOn(fs, "lstatSync").mockImplementation(new Proxy(lstatSync, interleave));
    try { telemetry.change({ enabled: true }); }
    finally { lstat.mockRestore(); stat.mockRestore(); rename.mockRestore(); }
    expect(marked).toBe(true);
    expect(other.telemetry.status().enabled).toBe(false);
  });

  test("an off marked after an on was asked wins over it, also once the on holds the lock", () => {
    const { telemetry, stateDir } = setup();
    const other = setup({ stateDir });
    telemetry.change({ enabled: false });
    telemetry.change({ enabled: true });
    const off = join(stateDir, "telemetry-off");
    const lock = join(stateDir, "telemetry.lock");
    const lstatSync = fs.lstatSync;
    let offDone = false;
    const interleave: ProxyHandler<typeof fs.lstatSync> = {
      apply(target, receiver, args) {
        if (args[0] === off && !offDone && fs.existsSync(lock)) {
          offDone = true;
          // the other server's off, between this on taking the lock and reading the mark: it cannot wait for the lock
          other.telemetry.change({ enabled: false });
        }
        return Reflect.apply(target, receiver, args);
      },
    };
    const lstat = spyOn(fs, "lstatSync").mockImplementation(new Proxy(lstatSync, interleave));
    try { telemetry.change({ enabled: true }); }
    finally { lstat.mockRestore(); }
    expect(offDone).toBe(true);
    expect([telemetry.status().enabled, other.telemetry.status().enabled]).toEqual([false, false]);
  });

  test("each active POST uses the usage re-read under the lock for that day", async () => {
    const held = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const actives: TelemetryActive[] = [];
    const first = setup({
      grace: 2 * 86_400_000,
      fetch: Object.assign(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === TEST_ACTIVE_URL) {
          actives.push(JSON.parse(String(init?.body)));
          if (actives.length === 1) { started.resolve(); return held.promise; }
        }
        return new Response(null, { status: 204 });
      }, { preconnect: fetch.preconnect }),
    });
    const other = setup({ stateDir: first.stateDir, now: "2026-10-09T12:00:00Z" });
    seen(first.telemetry);
    await first.telemetry.active(["claude"]);
    first.clock.now += 86_400_000;
    await first.telemetry.active(["claude"]);
    first.clock.now += 86_400_000;

    first.fireTimer();
    await started.promise;
    other.telemetry.tally("prompt_answers");
    held.resolve(new Response(null, { status: 204 }));
    await settled();
    expect(actives.map(({ day, usage }) => [day, usage.prompt_answers])).toEqual([
      ["2026-10-08", 0], ["2026-10-09", 1],
    ]);
  });

  test("another server waits for an active POST and can retry the sample after refusal", async () => {
    const held = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const first = setup({
      fetch: Object.assign(async (url: string | URL | Request) => {
        if (String(url) === TEST_ACTIVE_URL) { started.resolve(); return held.promise; }
        return new Response(null, { status: 204 });
      }, { preconnect: fetch.preconnect }),
    });
    seen(first.telemetry);
    const other = setup({ stateDir: first.stateDir });
    const sending = first.telemetry.active(["claude"]);
    await started.promise;
    try {
      await other.telemetry.active(["claude"]);
      expect(other.actives).toEqual([]);
    } finally {
      held.resolve(new Response(null, { status: 503 }));
      await sending;
    }
    await other.telemetry.active(["claude"]);
    expect(other.actives).toHaveLength(1);
  });

  /** Its lines are written synchronously: a buffered write might never leave before the blocking read. */
  async function pausedWriter(stateDir: string, call: string) {
    const script = `
      const { readSync, writeSync } = require("node:fs");
      const { Telemetry } = await import(${JSON.stringify(join(import.meta.dir, "telemetry.ts"))});
      let armed = false;
      const telemetry = new Telemetry({
        stateDir: ${JSON.stringify(stateDir)}, version: "0.4.1", env: {}, activeUrl: "https://telemetry.test/v1/active",
        fetch: async () => { writeSync(1, "SENT\\n"); return new Response(null, { status: 204 }); },
        now: () => {
          if (armed) { armed = false; writeSync(1, "PAUSED\\n"); readSync(0, Buffer.alloc(1)); }
          return Date.parse("2026-10-08T12:00:00Z");
        },
      });
      armed = true;
      ${call}
      writeSync(1, "DONE\\n");
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: { ...process.env, HERDR_TEST_MODE: "unit" } });
    const lines: string[] = [];
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const next = () => Promise.race([
      (async () => {
        while (!buffered.includes("\n")) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`the writer ended early: ${lines.join(" ")}`);
          buffered += decoder.decode(value);
        }
        const line = buffered.slice(0, buffered.indexOf("\n"));
        buffered = buffered.slice(line.length + 1);
        lines.push(line);
        return line;
      })(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("the writer did not answer")), 10_000).unref?.()),
    ]);
    return { child, next, resume: () => { child.stdin.write("\n"); child.stdin.flush(); } };
  }

  for (const call of ["tally", "active"] as const) {
    test(`turning the counts off while another server is midway through a ${call === "tally" ? "count" : "visit"} keeps them off, and nothing is sent`, async () => {
      const { telemetry, actives, stateDir } = setup();
      seen(telemetry);
      const writer = await pausedWriter(stateDir, call === "tally" ? "telemetry.tally(\"prompt_answers\");" : "await telemetry.active([\"claude\"]);");
      try {
        expect(await writer.next()).toBe("PAUSED");
        expect(telemetry.change({ enabled: false }).enabled).toBe(false);
        writer.resume();
        const after: string[] = [];
        for (let line = await writer.next(); line !== "DONE"; line = await writer.next()) after.push(line);
        expect(await writer.child.exited).toBe(0);
        // the other server's write lands after the opt-out: it must not turn the counts back on
        expect(after).toEqual([]);
        expect(telemetry.status().enabled).toBe(false);
        expect(setup({ stateDir }).telemetry.status().enabled).toBe(false);
        await telemetry.active(["claude"]);
        await settled();
        expect(actives).toEqual([]);
      } finally { writer.child.kill(); }
    });
  }

  test("an off that overlaps an on from another server and ends last keeps the counts off against a late write", async () => {
    const { telemetry, stateDir } = setup();
    const writer = await pausedWriter(stateDir, `telemetry.change({ enabled: false, notice_seen: true, notice_version: ${NOTICE_VERSION} });`);
    try {
      expect(await writer.next()).toBe("PAUSED");
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try { expect(() => telemetry.change({ enabled: true })).toThrow("try again"); } finally { errors.mockRestore(); }
      expect(telemetry.status().enabled).toBe(false);
      writer.resume();
      expect(await writer.next()).toBe("DONE");
      expect(await writer.child.exited).toBe(0);
      expect(telemetry.status().enabled).toBe(false);
      const file = join(stateDir, "telemetry.json");
      writeFileSync(file, JSON.stringify({ ...savedFile(stateDir), enabled: true }));
      expect(telemetry.status().enabled).toBe(false);
    } finally { writer.child.kill(); }
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an older build's off that could not be marked at start is marked at the next read", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const file = join(stateDir, "telemetry.json");
    const older = { install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: false, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null, active: [] };
    writeFileSync(file, JSON.stringify(older));
    chmodSync(stateDir, 0o500);
    const telemetry = (() => { try { return setup({ stateDir }).telemetry; } finally { chmodSync(stateDir, 0o700); } })();
    expect(telemetry.status().enabled).toBe(false);
    writeFileSync(file, JSON.stringify({ ...older, enabled: true }));
    expect(telemetry.status().enabled).toBe(false);
  });

  test("a switch an older build turned off stays off when a late write of the state file says on", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const file = join(stateDir, "telemetry.json");
    const older = { install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: false, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: "0.4.1", settings: null, active: [] };
    writeFileSync(file, JSON.stringify(older));
    const { telemetry } = setup({ stateDir });
    expect(telemetry.status().enabled).toBe(false);
    writeFileSync(file, JSON.stringify({ ...older, enabled: true }));
    expect(telemetry.status().enabled).toBe(false);
  });

  test("days still to send stop going once another server turns the counts off", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const days: string[] = [];
    const { telemetry, clock } = setup({
      grace: 129_600_000,
      stateDir,
      fetch: (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(url) === TEST_ACTIVE_URL) {
          days.push((JSON.parse(String(init?.body)) as TelemetryActive).day);
          setup({ stateDir }).telemetry.change({ enabled: false });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    seen(telemetry);
    await telemetry.active(["claude"]);
    clock.now += 86_400_000;
    await telemetry.active(["claude"]);
    clock.now += 86_400_000;
    telemetry.change({ enabled: true });
    await settled();
    expect(days).toEqual(["2026-10-08"]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a state directory that cannot be read sends nothing, even with the counts on in memory", async () => {
    const { telemetry, sent, actives, clock, stateDir, fireTimer } = setup({ grace: 60_000 });
    seen(telemetry);
    await telemetry.active(["claude"]);
    clock.now += 60_000;
    chmodSync(stateDir, 0o000);
    try {
      await telemetry.report();
      fireTimer();
      await settled();
      expect(sent).toEqual([]);
      expect(actives).toEqual([]);
      expect(telemetry.status().enabled).toBe(false);
    } finally {
      chmodSync(stateDir, 0o700);
      telemetry.stop();
    }
  });

  test.skipIf(process.platform === "win32")("an off mark that is a dangling link still reads off", async () => {
    const { telemetry, sent, actives, stateDir } = setup();
    symlinkSync(join(stateDir, "gone"), join(stateDir, "telemetry-off"));
    expect(telemetry.status().enabled).toBe(false);
    telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION });
    await telemetry.report();
    await telemetry.active(["claude"]);
    await settled();
    expect(sent).toEqual([]);
    expect(actives).toEqual([]);
  });

  test("an install event held back by an off marked just before it goes is sent once the counts are on again", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ install_id: "0b5f3c2e-8a51-4c47-9d0e-3f6a2b1c9e84", enabled: true, notice_seen_at: "2026-10-01T00:00:00.000Z", notice_version: NOTICE_VERSION, reported_version: null, settings: null, active: [] }));
    const sent: TelemetryEvent[] = [];
    let markAtClock = false;
    const telemetry = new Telemetry({
      stateDir, version: "0.4.1", env: {}, url: "https://telemetry.test/v1/events", activeUrl: TEST_ACTIVE_URL, platform: "linux", arch: "x64", noticeGraceMs: 0,
      fetch: (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        sent.push(JSON.parse(String(init?.body)) as TelemetryEvent);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
      now: () => {
        if (markAtClock) { markAtClock = false; writeFileSync(join(stateDir, "telemetry-off"), ""); }
        return Date.parse("2026-10-08T12:00:00Z");
      },
    });
    markAtClock = true;
    await telemetry.report();
    expect(sent).toEqual([]);
    telemetry.change({ enabled: true });
    await telemetry.report();
    expect(sent.map((event) => event.event)).toEqual(["install"]);
  });

  test("turning the counts on again from either server turns them on", async () => {
    const first = setup();
    seen(first.telemetry);
    first.telemetry.change({ enabled: false });
    const second = setup({ stateDir: first.stateDir });
    expect(second.telemetry.status().enabled).toBe(false);
    second.telemetry.change({ enabled: true });
    expect(first.telemetry.status().enabled).toBe(true);
    await first.telemetry.active(["claude"]);
    expect(first.actives).toHaveLength(1);
  });
});

describe("/api/telemetry", () => {
  test("POST reports 503 if another server takes over the lock before the change is saved", async () => {
    const { telemetry, stateDir } = setup();
    const other = setup({ stateDir });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handleTelemetryRequest(request, telemetry) });
    const lock = join(stateDir, "telemetry.lock");
    const temp = join(stateDir, `telemetry.json.${process.pid}.tmp`);
    const writeFileSync = fs.writeFileSync;
    const write = spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
      writeFileSync(path, data, options);
      if (path === temp) {
        write.mockRestore();
        const stale = new Date(Date.now() - 10 * 60_000);
        utimesSync(lock, stale, stale);
        other.telemetry.change({ enabled: false });
      }
    });
    try {
      const request = telemetryPost({ notice_seen: true, notice_version: NOTICE_VERSION });
      const response = await fetch(new URL("/api/telemetry", server.url), request);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "file_busy" } });
      expect(other.telemetry.status()).toMatchObject({ enabled: false, notice_seen: false });
    } finally { write.mockRestore(); server.stop(true); }
  });

  const post = (body: unknown, headers: Record<string, string> = { "x-herdr-update": "1" }) =>
    new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("a server without telemetry answers 404", async () => {
    const response = await handleTelemetryRequest(new Request("http://localhost/api/telemetry"));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  });

  test("GET tells the status and previews only an allowlisted event", async () => {
    const { telemetry } = setup();
    const response = await handleTelemetryRequest(new Request("http://localhost/api/telemetry"), telemetry);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ enabled: true, notice_seen: false, next: { event: "install", version: "0.4.1", settings: null } });
  });

  test("POST validates exact settings and current notice acknowledgements before changing state", async () => {
    const { telemetry, sent, stateDir } = setup();
    const settings = settingsSnapshot({ theme: "light", terminalFontFamily: "private font name", quickReplies: ["private reply"] });
    expect((await handleTelemetryRequest(post({ enabled: false }, {}), telemetry)).status).toBe(403);
    expect((await handleTelemetryRequest(post({ enabled: "no" }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ notice_seen: false, notice_version: NOTICE_VERSION }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ notice_seen: true }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ notice_seen: true, notice_version: NOTICE_VERSION - 1 }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ settings: { ...settings, theme: "private text" } }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ settings: { ...settings, extra: true } }), telemetry)).status).toBe(400);
    expect((await handleTelemetryRequest(post({ settings, old_alias: ["theme"] }), telemetry)).status).toBe(400);
    expect(telemetry.status()).toMatchObject({ notice_seen: false, next: { settings: null } });
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8")).settings).toBeNull();
    expect(sent).toEqual([]);

    // settings told with an off are not kept: nothing captured while off goes after the on
    const response = await handleTelemetryRequest(post({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION, settings }), telemetry);
    expect(await response.json()).toMatchObject({ enabled: false, notice_seen: true, next: { settings: null } });
    expect(JSON.parse(readFileSync(join(stateDir, "telemetry.json"), "utf8")).settings).toBeNull();
    await telemetry.report();
    expect(sent).toEqual([]);

    const enabled = await handleTelemetryRequest(post({ enabled: true, settings, generation: 1 }), telemetry);
    expect(await enabled.json()).toMatchObject({ enabled: true, next: { settings } });
    expect(JSON.stringify(telemetry.status())).not.toContain("private font name");
    expect(JSON.stringify(telemetry.status())).not.toContain("private reply");
    await telemetry.report();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.settings).toEqual(settings);
  });

  test("change() requires the exact current notice version before acknowledging", () => {
    const { telemetry } = setup();
    expect(() => telemetry.change({ notice_seen: true } as TelemetryChange)).toThrow();
    expect(() => telemetry.change({ notice_seen: true, notice_version: NOTICE_VERSION - 1 })).toThrow();
    expect(telemetry.status().notice_seen).toBe(false);
    expect(telemetry.change({ enabled: false, notice_seen: true, notice_version: NOTICE_VERSION }).notice_seen).toBe(true);
  });
});

describe("telemetry counts", () => {
  test("a counts POST completed after an off and on leaves the new generation's batch for the same day", async () => {
    const held = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const first = setup({
      countsOn: true,
      fetch: Object.assign(async (url: string | URL | Request) => {
        if (String(url) === TEST_COUNTS_URL) { started.resolve(); return held.promise; }
        return new Response(null, { status: 204 });
      }, { preconnect: fetch.preconnect }),
    });
    const other = setup({ stateDir: first.stateDir, countsOn: true });
    seen(first.telemetry);
    first.telemetry.tallyCounts({ width: "wide", add: { chat_send: 1 }, shown: [], generation: 0 });
    first.clock.now += 86_400_000;
    await first.telemetry.active([]);
    await started.promise;

    other.telemetry.change({ enabled: false });
    const { counts_generation: generation } = other.telemetry.change({ enabled: true });
    other.telemetry.tallyCounts({ width: "wide", add: { chat_send: 5 }, shown: [], generation });
    held.resolve(new Response(null, { status: 204 }));
    await settled();
    other.clock.now += 86_400_000;
    await other.telemetry.active([]);
    expect(other.counts.map(({ day, wide }) => [day, wide?.counts])).toEqual([["2026-10-08", { chat_send: 2 }]]);
  });

  test("another server does not send a counts day while its POST is in flight", async () => {
    const held = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    const first = setup({
      countsOn: true,
      fetch: Object.assign(async (url: string | URL | Request) => {
        if (String(url) === TEST_COUNTS_URL) { started.resolve(); return held.promise; }
        return new Response(null, { status: 204 });
      }, { preconnect: fetch.preconnect }),
    });
    const other = setup({ stateDir: first.stateDir, countsOn: true });
    seen(first.telemetry);
    first.telemetry.tallyCounts({ width: "wide", add: { chat_send: 1 }, shown: [], generation: 0 });
    first.clock.now += 86_400_000;
    other.clock.now = first.clock.now;
    await first.telemetry.active([]);
    await started.promise;
    try {
      await other.telemetry.active([]);
      expect(other.counts).toEqual([]);
    } finally {
      held.resolve(new Response(null, { status: 503 }));
      await settled();
    }
    await other.telemetry.active([]);
    expect(other.counts).toHaveLength(1);
  });

  test("a day still waiting is not sent once another server on the same state turned the counts off and on again", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const taken: TelemetryCounts[] = [];
    let other: Telemetry | null = null;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === TEST_COUNTS_URL) {
        taken.push(JSON.parse(String(init?.body)));
        if (taken.length === 1) { other!.change({ enabled: false }); other!.change({ enabled: true }); }
      }
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const first = setup({ countsOn: true, stateDir, fetch });
    other = setup({ countsOn: true, stateDir }).telemetry;
    seen(first.telemetry);
    first.clock.now = Date.parse("2026-10-06T12:00:00Z");
    first.telemetry.change({ counts: { width: "wide", add: { chat_send: 1 }, shown: [], generation: 0 } });
    first.clock.now = Date.parse("2026-10-07T12:00:00Z");
    first.telemetry.change({ counts: { width: "wide", add: { chat_send: 2 }, shown: [], generation: 0 } });
    first.clock.now = Date.parse("2026-10-08T12:00:00Z");
    await first.telemetry.active([]);
    await settled();
    expect(taken.map((counts) => counts.day)).toEqual(["2026-10-06"]);
  });
  test("a day's counts wait COUNTS_SETTLE_MS after its midnight, so a batch from its last minute still goes with it", async () => {
    const { telemetry, counts, clock } = setup({ countsOn: true });
    seen(telemetry);
    clock.now = Date.parse("2026-11-15T23:59:30Z");
    telemetry.change({ counts: { width: "wide", add: { chat_send: 2 }, shown: [], generation: 0 } });
    clock.now = Date.parse("2026-11-16T00:00:20Z");
    await telemetry.active([]);
    await settled();
    expect(counts).toEqual([]);
    // the tab's batch from before midnight arrives within its minute
    clock.now = Date.parse("2026-11-16T00:00:50Z");
    telemetry.change({ counts: { width: "wide", add: { chat_send: 1 }, shown: [], generation: 0, day: "2026-11-15" } });
    clock.now = Date.parse("2026-11-16T00:00:00Z") + COUNTS_SETTLE_MS;
    await telemetry.active([]);
    await settled();
    expect(counts.map((sent) => [sent.day, sent.wide?.counts])).toEqual([["2026-11-15", { chat_send: 2 }]]);
  });
  test("a day still settling at the only visit goes when the settle time ends, with no other visit", async () => {
    const { telemetry, counts, clock, timers, fireTimer } = setup({ countsOn: true });
    seen(telemetry);
    clock.now = Date.parse("2026-11-15T20:00:00Z");
    telemetry.change({ counts: { width: "wide", add: { chat_send: 1 }, shown: [], generation: 0 } });
    clock.now = Date.parse("2026-11-16T00:01:00Z");
    await telemetry.active([]);
    await settled();
    expect(counts).toEqual([]);
    expect(timers.filter((timer) => !timer.cleared).map((timer) => timer.ms)).toEqual([COUNTS_SETTLE_MS - 60_000]);
    clock.now = Date.parse("2026-11-16T00:00:00Z") + COUNTS_SETTLE_MS;
    fireTimer();
    await settled();
    expect(counts.map((sent) => sent.day)).toEqual(["2026-11-15"]);
  });
  test("a batch for the ended day that arrives after the only visit arms the settle flush too", async () => {
    const { telemetry, counts, clock, timers, fireTimer } = setup({ countsOn: true });
    seen(telemetry);
    clock.now = Date.parse("2026-11-16T00:00:20Z");
    await telemetry.active([]);
    await settled();
    expect(timers.filter((timer) => !timer.cleared)).toEqual([]);
    clock.now = Date.parse("2026-11-16T00:00:50Z");
    telemetry.change({ counts: { width: "wide", add: { chat_send: 1 }, shown: [], generation: 0, day: "2026-11-15" } });
    expect(timers.filter((timer) => !timer.cleared).map((timer) => timer.ms)).toEqual([COUNTS_SETTLE_MS - 50_000]);
    clock.now = Date.parse("2026-11-16T00:00:00Z") + COUNTS_SETTLE_MS;
    fireTimer();
    await settled();
    expect(counts.map((sent) => sent.day)).toEqual(["2026-11-15"]);
  });
  test("a batch is counted under the day it names, yesterday or today; any other day is dropped", () => {
    const { telemetry, clock, stateDir } = setup({ countsOn: true });
    seen(telemetry);
    clock.now = Date.parse("2026-11-16T00:00:20Z");
    const change = (day: string) => telemetry.change({ counts: { width: "wide", add: { chat_send: 1 }, shown: [], generation: 0, day } });
    change("2026-11-15");
    change("2026-11-14");
    change("2026-11-17");
    expect(telemetry.status().counts?.wide).toBeNull();
    clock.now = Date.parse("2026-11-15T12:00:00Z");
    expect(telemetry.status().counts?.wide).toEqual({ counts: { chat_send: 1 }, shown: [] });
    expect(savedFile(stateDir).counts.map((entry: { day: string }) => entry.day)).toEqual(["2026-11-15"]);
  });
  test("a day the receiver took is not sent again when its removal could not be written", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "telemetry-"));
    dirs.push(stateDir);
    const taken: TelemetryCounts[] = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === TEST_COUNTS_URL) { taken.push(JSON.parse(String(init?.body))); chmodSync(stateDir, 0o500); }
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch;
    const { telemetry, clock } = setup({ countsOn: true, stateDir, fetch });
    seen(telemetry);
    telemetry.change({ counts: { width: "wide", add: { chat_send: 2 }, shown: [], generation: 0 } });
    clock.now += 86_400_000;
    try {
      await telemetry.active([]);
      await settled();
    } finally { chmodSync(stateDir, 0o700); }
    expect(savedFile(stateDir).counts).toHaveLength(1);
    await telemetry.active([]);
    await settled();
    expect(taken).toHaveLength(1);
  });
  test("a batch counted before an off (another tab's) is dropped; the current generation's is kept", () => {
    const { telemetry } = setup({ countsOn: true });
    seen(telemetry);
    expect(telemetry.status().counts_generation).toBe(0);
    telemetry.change({ enabled: false });
    telemetry.change({ enabled: true });
    expect(telemetry.status().counts_generation).toBe(2);
    telemetry.change({ counts: { width: "wide", add: { chat_send: 5 }, shown: [], generation: 0 } });
    telemetry.change({ counts: { width: "wide", add: { chat_send: 1 }, shown: [] } });
    expect(telemetry.status().counts?.wide).toBeNull();
    telemetry.change({ counts: { width: "wide", add: { chat_send: 1 }, shown: [], generation: 2 } });
    expect(telemetry.status().counts?.wide).toEqual({ counts: { chat_send: 1 }, shown: [] });
  });
  test("POST counts is refused with 400 while this build counts nothing, as before counts existed", async () => {
    const off = setup({ countsOn: false });
    seen(off.telemetry);
    const post = (telemetry: Telemetry) => handleTelemetryRequest(new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify({ counts: { width: "wide", add: { chat_send: 1 }, shown: [], generation: 0 } }) }), telemetry);
    const refused = await post(off.telemetry);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.code).toBe("invalid_body");
    const on = setup({ countsOn: true });
    seen(on.telemetry);
    expect((await post(on.telemetry)).status).toBe(200);
  });
  test("the shipped default counts and sends nothing before the notice that says so (version 6)", async () => {
    const { telemetry, counts, clock, stateDir } = setup();
    seen(telemetry);
    telemetry.change({ counts: { width: "wide", add: { chat_send: 3 }, shown: ["composer"], generation: 0 } });
    clock.now += 86_400_000;
    await telemetry.active([]);
    await settled();
    // 6 is the notice whose wording says buttons are counted: below it, nothing is kept, previewed or sent
    const on = NOTICE_VERSION >= 6;
    expect([counts.length > 0, telemetry.status().counts !== undefined, savedFile(stateDir).counts.length > 0 || counts.length > 0]).toEqual([on, on, on]);
  });
  test("off in this build (its notice is below COUNTS_NOTICE_VERSION): nothing is counted, sent or previewed", async () => {
    const { telemetry, counts, clock, stateDir } = setup({ countsOn: false });
    seen(telemetry);
    telemetry.change({ counts: { width: "narrow", add: { chat_send: 3 }, shown: ["composer"], generation: 0 } });
    expect(savedFile(stateDir).counts).toEqual([]);
    expect(telemetry.status().counts).toBeUndefined();
    clock.now += 86_400_000;
    await telemetry.active([]);
    await settled();
    expect(counts).toEqual([]);
  });

  const DAY_MS = 86_400_000;
  const narrow = (add: TelemetryChange["counts"] extends infer C ? C extends { add: infer A } ? A : never : never, shown: ("composer" | "composer_voice" | "view_switch_header")[] = []) =>
    ({ counts: { width: "narrow", add, shown, generation: 0 } }) satisfies TelemetryChange;

  test("nothing used before the current notice is kept, and a browser's counts alone send nothing", async () => {
    const { telemetry, counts, urls, clock } = setup({ countsOn: true });
    telemetry.change(narrow({ chat_send: 5 }, ["composer"]));
    expect(telemetry.status().counts).toMatchObject({ narrow: null, wide: null });
    seen(telemetry);
    telemetry.change(narrow({ chat_send: 1 }));
    expect(telemetry.status().counts?.narrow).toEqual({ counts: { chat_send: 1 }, shown: [] });
    await settled();
    expect(counts).toEqual([]);
    // the next day, a browser's counts still send nothing by themselves: only a visit or a start does
    clock.now += DAY_MS;
    telemetry.change(narrow({ chat_send: 1 }));
    await settled();
    expect(counts).toEqual([]);
    expect(urls.filter((url) => url === TEST_COUNTS_URL)).toEqual([]);
  });

  test("a finished day goes once, at the next visit, as buckets per width under that day's version", async () => {
    const { telemetry, counts, clock, stateDir } = setup({ version: "0.5.5", countsOn: true });
    seen(telemetry);
    telemetry.change(narrow({ chat_send: 2, view_terminal_claude: 3, view_terminal_by_header: 3 }, ["view_switch_header", "composer"]));
    telemetry.change(narrow({ chat_send: 8 }, ["composer"]));
    telemetry.change({ counts: { width: "wide", add: { composer_voice: 30, inbox_enter: 9 }, shown: ["composer_voice"], generation: 0 } });
    // today's counts are exact here and stay here
    expect(savedFile(stateDir).counts[0].narrow.counts).toEqual({ chat_send: 10, view_terminal_by_header: 3, view_terminal_claude: 3 });
    await telemetry.active([]);
    expect(counts).toEqual([]);
    clock.now += DAY_MS;
    await telemetry.active([]);
    await settled();
    expect(counts).toEqual([{
      event: "counts", day: "2026-10-08", install_id: telemetry.status().active.install_id, version: "0.5.5",
      narrow: { counts: { chat_send: 3, view_terminal_by_header: 2, view_terminal_claude: 2 }, shown: ["composer", "view_switch_header"] },
      wide: { counts: { composer_voice: 4, inbox_enter: 2 }, shown: ["composer_voice"] },
    }]);
    expect(savedFile(stateDir).counts).toEqual([]);
    clock.now += DAY_MS;
    await telemetry.active([]);
    await settled();
    expect(counts).toHaveLength(1);
  });

  test("the buckets: 1-2, 3-9, 10-29, 30 or more, and the count stops at TELEMETRY_COUNT_MAX", () => {
    const { telemetry } = setup({ countsOn: true });
    seen(telemetry);
    const bucketOf = (n: number) => {
      const { telemetry: one } = setup({ countsOn: true });
      seen(one);
      one.change(narrow({ chat_send: n }));
      return one.status().counts?.narrow?.counts.chat_send;
    };
    expect([1, 2, 3, 9, 10, 29, 30, 9999].map(bucketOf)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    telemetry.change(narrow({ chat_send: TELEMETRY_COUNT_MAX }));
    telemetry.change(narrow({ chat_send: TELEMETRY_COUNT_MAX }));
    expect(telemetry.status().counts?.narrow?.counts.chat_send).toBe(4);
  });

  test("turned off, the days not sent yet are dropped, and turned on again nothing from before goes", async () => {
    const { telemetry, counts, clock, stateDir } = setup({ countsOn: true });
    seen(telemetry);
    telemetry.change(narrow({ chat_send: 4 }));
    telemetry.change({ enabled: false });
    expect(savedFile(stateDir).counts).toEqual([]);
    telemetry.change(narrow({ chat_send: 4 }));
    expect(savedFile(stateDir).counts).toEqual([]);
    telemetry.change({ enabled: true });
    clock.now += DAY_MS;
    await telemetry.active([]);
    await settled();
    expect(counts).toEqual([]);
  });

  test("a day the receiver did not take is tried again at the next visit, and one past COUNTS_LATE_DAYS is dropped", async () => {
    const { telemetry, counts, answer, clock, stateDir } = setup({ countsOn: true });
    seen(telemetry);
    telemetry.change(narrow({ chat_send: 1 }));
    answer.status = 500;
    clock.now += DAY_MS;
    await telemetry.active([]);
    await settled();
    expect(counts).toHaveLength(1);
    expect(savedFile(stateDir).counts).toHaveLength(1);
    answer.status = 204;
    await telemetry.active([]);
    await settled();
    expect(counts).toHaveLength(2);
    expect(counts[1]!.day).toBe("2026-10-08");
    expect(savedFile(stateDir).counts).toEqual([]);

    telemetry.change(narrow({ chat_send: 1 }));
    clock.now += (COUNTS_LATE_DAYS + 1) * DAY_MS;
    await telemetry.active([]);
    await settled();
    expect(counts).toHaveLength(2);
    expect(savedFile(stateDir).counts).toEqual([]);
  });

  test("a notice older than the current one drops the counts a file holds", () => {
    const { telemetry, stateDir } = setup({ countsOn: true });
    seen(telemetry);
    telemetry.change(narrow({ chat_send: 1 }));
    const file = savedFile(stateDir);
    expect(file.counts).toHaveLength(1);
    writeFileSync(join(stateDir, "telemetry.json"), JSON.stringify({ ...file, notice_version: NOTICE_VERSION - 1 }));
    const again = setup({ stateDir, countsOn: true });
    expect(again.telemetry.status().counts).toMatchObject({ narrow: null, wide: null });
    expect(again.telemetry.status().notice_seen).toBe(false);
  });

  test("POST counts: known names are added, a newer page's unknown names are dropped, and a bad shape is refused", async () => {
    const { telemetry } = setup({ countsOn: true });
    seen(telemetry);
    const post = (body: unknown) => handleTelemetryRequest(new Request("http://localhost/api/telemetry", { method: "POST", headers: { "content-type": "application/json", "x-herdr-update": "1" }, body: JSON.stringify(body) }), telemetry);
    const ok = await post({ counts: { width: "wide", add: { chat_send: 2, composer_rewind: 1 }, shown: ["composer", "future_panel"], generation: 0 } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).counts.wide).toEqual({ counts: { chat_send: 1 }, shown: ["composer"] });
    for (const bad of [
      { counts: { width: "tablet", add: {}, shown: [] } },
      { counts: { width: "wide", add: { chat_send: 0 }, shown: [], generation: 0 } },
      { counts: { width: "wide", add: { chat_send: 1.5 }, shown: [], generation: 0 } },
      { counts: { width: "wide", add: { chat_send: TELEMETRY_COUNT_MAX + 1 }, shown: [], generation: 0 } },
      { counts: { width: "wide", add: { chat_send: "fix the bug" }, shown: [], generation: 0 } },
      { counts: { width: "wide", add: {}, shown: "composer" } },
      { counts: { width: "wide", add: {}, shown: [], pane: "w1:p1" } },
    ]) expect((await post(bad)).status).toBe(400);
    expect(telemetry.status().counts?.wide).toEqual({ counts: { chat_send: 1 }, shown: ["composer"] });
  });
});
