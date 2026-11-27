/**
 * A PC known to have no terminal attach (a Windows herdr) keeps its chat lens and its "soon" mark
 * through failed reads, and no failed read opens an attach. All files and HTTP traffic stay in this
 * disposable, loopback-only app; no herdr session is opened. HEALTH_FLAP_RESULTS=<dir> keeps each
 * scenario's record there.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext, installClock } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";

type Outcome = "ok" | "error" | "network";
interface Frame { type: string; mode?: string; pane_id?: string }
interface HealthFlap {
  seen: number;
  pending: Array<{ id: number; resolve(outcome: Outcome): void }>;
  released: Array<{ id: number; outcome: Outcome }>;
  identity: Record<string, unknown> | null;
  sockets: number;
  sent: Frame[];
  pills: string[];
}
declare global { interface Window { healthFlap: HealthFlap; releaseHealth(id: number, outcome: Outcome, identity?: Record<string, unknown>): void; setRemoteGone(gone: boolean): void } }

export function installHealthFlap(): void {
  const query = new URLSearchParams(location.search);
  const flap: HealthFlap = { seen: 0, pending: [], released: [], identity: JSON.parse(query.get("herdr") ?? "null") as Record<string, unknown> | null, sockets: 0, sent: [], pills: [] };
  window.healthFlap = flap;
  const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const demoFetch = window.fetch.bind(window);
  const remotes = query.has("remotes");
  const localName = query.get("pcname");
  type Roster = Array<Record<string, unknown> & { id: string }>;
  const roster = (machines: Roster): Roster => {
    const local = machines.find((machine) => machine.id === "local")!;
    const named = localName ? { ...local, name: localName } : local;
    if (!remotes) return machines.map((machine) => machine.id === "local" ? named : machine);
    const copy = (id: string, name: string, extra: Record<string, unknown>) => ({ ...structuredClone(local), id, kind: "ssh", name, ...extra });
    return [named,
      copy("remote", "Build PC", remoteGone ? { state: "disconnected" } : { state: "connected", herdr: { version: "0.9.4", protocol: 22, terminal_attach: true } }),
      copy("offline", "Old PC", { state: "disconnected" })];
  };
  let last: Roster | null = null;
  let remoteGone = false;
  const sources = new Set<{ onmessage: ((event: MessageEvent) => void) | null }>();
  window.setRemoteGone = (gone) => {
    remoteGone = gone;
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: roster(last!) }) }));
  };
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname === "/api/health" && url.searchParams.get("scope") !== "bridge") {
      const id = ++flap.seen;
      const answer = await (await demoFetch(input, init)).json() as Record<string, unknown>;
      const outcome = await new Promise<Outcome>((resolve) => flap.pending.push({ id, resolve }));
      flap.released.push({ id, outcome });
      if (outcome === "network") throw new TypeError("Failed to fetch");
      if (outcome === "error") return json({ error: { code: "herdr_unavailable", message: "herdr did not answer" } }, 503);
      return json({ ...answer, herdr: flap.identity ?? answer["herdr"] });
    }
    if (url.pathname === "/api/machines") {
      last = (await (await demoFetch(input, init)).json() as { machines: Roster }).machines;
      return json({ machines: roster(last) });
    }
    const match = url.pathname.match(/^\/api\/machines\/([^/]+)(\/.*)$/);
    if (match && match[2] === "/session" && last) return json({ snapshot: roster(last).find((machine) => machine.id === decodeURIComponent(match[1]!))?.["snapshot"] ?? null });
    if (match) return demoFetch(`/api${match[2]}${url.search}`, init);
    return demoFetch(input, init);
  }) as typeof window.fetch;
  window.releaseHealth = (id, outcome, identity) => {
    const at = flap.pending.findIndex((read) => read.id === id);
    if (at < 0) throw new Error(`health read ${id} is not waiting`);
    if (identity) flap.identity = identity;
    flap.pending.splice(at, 1)[0]!.resolve(outcome);
  };
  const DemoSource = window.EventSource;
  window.EventSource = class extends EventTarget {
    inner: EventSource; readyState = 1;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onopen: ((event: Event) => void) | null = null;
    constructor(url: string | URL, options?: EventSourceInit) {
      super();
      sources.add(this);
      this.inner = new DemoSource(url, options);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type: string; machines?: Roster };
        if (message.type === "machines" && message.machines) { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close(): void { sources.delete(this); this.inner.close(); this.readyState = 2; }
  } as unknown as typeof EventSource;
  const observe = query.has("observe");
  const DemoSocket = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new DemoSocket(url, protocols);
    if (new URL(String(url), location.href).pathname !== "/ws") return socket;
    flap.sockets++;
    const send = socket.send.bind(socket);
    socket.send = (raw: string) => {
      const frame = JSON.parse(String(raw)) as Frame;
      // an observer: the connection asks to watch only, as a second browser on a held pane does
      const sent = observe && frame.type === "role" ? { ...frame, mode: "observe" } : frame;
      if (/attach|watch|role|take|input|keys|submit|resize/.test(sent.type)) flap.sent.push({ type: sent.type, mode: sent.mode, pane_id: sent.pane_id });
      send(sent === frame ? raw : JSON.stringify(sent));
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: DemoSocket[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
  new MutationObserver(() => {
    const text = [...document.querySelectorAll(".header-meta .pill-offline, .header-meta .pill-stale")].map((pill) => pill.textContent?.trim() ?? "").join("|");
    if (text !== (flap.pills.at(-1) ?? "")) flap.pills.push(text);
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

const POLL_MS = 30_000;
export const readHeader = (page: Page) => page.evaluate(() => {
  const pill = (selector: string) => {
    const node = document.querySelector(`.header-meta ${selector}`);
    return node ? { text: node.textContent?.trim() ?? "", title: node.getAttribute("title") } : null;
  };
  const lens = [...document.querySelectorAll(".view-switch button")].findIndex((button) => button.getAttribute("aria-pressed") === "true");
  const flap = window.healthFlap;
  return {
    stale: pill(".pill-stale"), offline: pill(".pill-offline"),
    lens: lens === 0 ? "chat" : lens === 1 ? "terminal" : null,
    soon: document.querySelector(".view-switch .pill-soon") !== null,
    chip: document.querySelector(".header-meta .conn")?.getAttribute("title") ?? null,
    sockets: flap.sockets, sent: flap.sent.length, claims: flap.sent.filter((frame) => frame.type !== "role").length,
    roles: flap.sent.filter((frame) => frame.type === "role").map((frame) => frame.mode),
    pills: [...flap.pills], waiting: flap.pending.map((read) => read.id),
  };
});
export type Header = Awaited<ReturnType<typeof readHeader>>;

export async function nextRead(page: Page): Promise<number> {
  const before = await page.evaluate(() => window.healthFlap.seen);
  await page.clock.fastForward(POLL_MS);
  await page.waitForFunction((seen) => window.healthFlap.pending.some((read) => read.id > seen), before);
  return await page.evaluate((seen) => Math.max(...window.healthFlap.pending.filter((read) => read.id > seen).map((read) => read.id)), before);
}
export const release = (page: Page, id: number, outcome: Outcome, identity?: Record<string, unknown>) =>
  page.evaluate(({ id, outcome, identity }) => window.releaseHealth(id, outcome, identity), { id, outcome, identity });
const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
export async function headerAfter(page: Page, pill: "stale" | "offline" | "none", step: string): Promise<Header> {
  try {
    await page.waitForFunction((pill) => {
      const stale = document.querySelector(".header-meta .pill-stale") !== null;
      const offline = document.querySelector(".header-meta .pill-offline") !== null;
      // a stale wait also ends on an offline pill, so a header that says offline at once fails on what it says
      return pill === "stale" ? stale || offline : pill === "offline" ? offline : !stale && !offline;
    }, pill, { timeout: 10_000 });
  } catch (error) {
    throw new Error(`${step}: the header never settled on ${pill}: ${JSON.stringify(await readHeader(page))}`, { cause: error });
  }
  await settled(page);
  return await readHeader(page);
}

export const WINDOWS = { version: "0.9.5", protocol: 22, terminal_attach: false };
const MIRROR = { version: "0.9.5", protocol: 22, terminal_attach: false, terminal_mirror: true };
const OLDER = { version: "0.8.2", protocol: 21 };
const SETTINGS = { language: "en", alertsOn: false };

export async function openDemo(browser: Browser, url: string, query: Record<string, string>, options: { width?: number; settings?: Record<string, unknown>; mobile?: boolean } = {}) {
  const width = options.width ?? 1440;
  const mobile = options.mobile ?? width < 500;
  const context = await appContext(browser, { viewport: { width, height: mobile ? 844 : 900 }, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, ...options.settings }));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installClock(page);
  await page.goto(`${url}?${new URLSearchParams(query)}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  return { context, page, errors };
}

const firstRead = async (page: Page): Promise<number> => {
  await page.waitForFunction(() => window.healthFlap.pending.length > 0);
  return await page.evaluate(() => Math.min(...window.healthFlap.pending.map((read) => read.id)));
};
const established = async (page: Page, step: string): Promise<Header> => {
  try { await page.locator(".view-switch .pill-soon").waitFor(); }
  catch (error) { throw new Error(`${step}: the PC's capabilities never arrived: ${JSON.stringify(await readHeader(page))}`, { cause: error }); }
  await settled(page);
  return await readHeader(page);
};
const sameCapabilities = (before: Header, after: Header, step: string): void => {
  assert.equal(after.lens, before.lens, `${step}: the pane keeps its lens`);
  assert.equal(after.soon, before.soon, `${step}: the terminal lens keeps what the PC can do`);
  assert.equal(after.sockets, before.sockets, `${step}: no new terminal connection`);
  assert.equal(after.claims, before.claims, `${step}: no attach or watch is sent`);
  assert.deepEqual(after.roles, before.roles, `${step}: the connection's role is unchanged`);
};

async function transientRecovery(browser: Browser, url: string): Promise<Record<string, unknown>> {
  const { context, page, errors } = await openDemo(browser, url, { pane: panes.shell, herdr: JSON.stringify(WINDOWS) });
  const steps: Record<string, unknown>[] = [];
  try {
    await release(page, await firstRead(page), "ok");
    const healthy = await established(page, "healthy");
    assert.equal(healthy.lens, "chat", "a shell pane on a PC without attach opens in the chat");
    assert.equal(healthy.stale, null); assert.equal(healthy.offline, null);
    steps.push({ state: "healthy", ...healthy });

    await release(page, await nextRead(page), "error");
    const unknown = await headerAfter(page, "stale", "first failure");
    assert.equal(unknown.offline, null, "one failed read does not say herdr is offline");
    assert.equal(unknown.stale?.text, "Status unknown");
    assert.match(unknown.stale?.title ?? "", /herdr 0\.9\.5 · protocol 22/, "the last-known herdr is named");
    sameCapabilities(healthy, unknown, "first failure");
    steps.push({ state: "first-failure-unknown", ...unknown });

    await release(page, await nextRead(page), "ok");
    const recovered = await headerAfter(page, "none", "recovery");
    sameCapabilities(healthy, recovered, "recovery");
    steps.push({ state: "recovered", ...recovered });

    await release(page, await nextRead(page), "network");
    const again = await headerAfter(page, "stale", "isolated failure after recovery");
    assert.equal(again.offline, null, "a later lone failure is unknown again");
    sameCapabilities(healthy, again, "isolated failure after recovery");
    steps.push({ state: "isolated-failure-unknown", ...again });

    await release(page, await nextRead(page), "error");
    const unavailable = await headerAfter(page, "offline", "second failure");
    assert.equal(unavailable.stale, null);
    assert.equal(unavailable.offline?.text, "herdr unavailable", "two failed reads say unavailable, never that herdr stopped");
    assert.doesNotMatch(unavailable.chip ?? "", /herdr \d/, "the connection status names no herdr as current once unavailable");
    sameCapabilities(healthy, unavailable, "second failure");
    steps.push({ state: "repeated-failure-unavailable", ...unavailable });

    await release(page, await nextRead(page), "ok");
    const back = await headerAfter(page, "none", "recovery after unavailable");
    sameCapabilities(healthy, back, "recovery after unavailable");
    assert.match(back.chip ?? "", /herdr 0\.9\.5 · protocol 22/, "an answer names its herdr again");
    steps.push({ state: "recovered-after-unavailable", ...back });
    assert.deepEqual(back.pills, ["Status unknown", "", "Status unknown", "herdr unavailable", ""], "the header never said offline on a lone failure");
    assert.deepEqual(errors, []);
    return { scenario: "transient-health-recovery", pass: true, steps };
  } finally { await context.close(); }
}

async function scopeAndCapability(browser: Browser, url: string): Promise<Record<string, unknown>> {
  const cases: Record<string, unknown>[] = [];
  {
    const { context, page, errors } = await openDemo(browser, url, { pane: panes.shell, herdr: JSON.stringify(WINDOWS) });
    try {
      await release(page, await firstRead(page), "ok");
      const healthy = await established(page, "overlap");
      const older = await nextRead(page);
      const newer = await nextRead(page);
      assert.ok(newer > older);
      await release(page, newer, "ok");
      await release(page, older, "error");
      const marker = await nextRead(page);
      await release(page, marker, "ok", { ...WINDOWS, version: "0.9.6" });
      await page.waitForFunction(() => document.querySelector(".header-meta .conn")?.getAttribute("title")?.includes("herdr 0.9.6") === true);
      await settled(page);
      const after = await readHeader(page);
      assert.deepEqual(after.pills, [], "the older failure never reached the header");
      sameCapabilities(healthy, after, "overlap");
      await release(page, await nextRead(page), "error");
      const lone = await headerAfter(page, "stale", "failure after overlap");
      assert.equal(lone.offline, null, "the dropped failure did not count toward unavailable");
      cases.push({ case: "older-failure-after-newer-success", reads: { older, newer, marker }, after, lone });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await openDemo(browser, url, { pane: panes.shell, herdr: JSON.stringify(WINDOWS) });
    try {
      const held = await firstRead(page);
      const newer = await nextRead(page);
      assert.ok(newer > held);
      await release(page, newer, "error");
      const cold = await headerAfter(page, "stale", "newer read failed first");
      assert.equal(cold.soon, false, "nothing is known yet");
      await release(page, held, "ok");
      const late = await established(page, "late answer after a newer failure");
      assert.equal(late.lens, "chat", "the late answer's terminal_attach: false gives the chat lens");
      assert.equal(late.offline, null);
      assert.equal(late.stale?.text, "Status unknown", "the newer failure still stands");
      assert.match(late.stale?.title ?? "", /herdr 0\.9\.5 · protocol 22/, "the late answer is the last herdr seen");
      cases.push({ case: "older-success-after-newer-failure", reads: { held, newer }, cold, late });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await openDemo(browser, url, { pane: panes.shell, herdr: JSON.stringify(WINDOWS) });
    try {
      await release(page, await firstRead(page), "ok");
      const healthy = await established(page, "reverse failures");
      const older = await nextRead(page);
      const newer = await nextRead(page);
      assert.ok(newer > older);
      await release(page, newer, "error");
      const first = await headerAfter(page, "stale", "newer read failed first");
      assert.equal(first.offline, null, "one failure is unknown");
      await release(page, older, "network");
      const second = await headerAfter(page, "offline", "older read failed second");
      assert.equal(second.offline?.text, "herdr unavailable", "the older failure is the second in the run");
      sameCapabilities(healthy, second, "reverse failures");
      cases.push({ case: "failures-in-reverse-order", reads: { older, newer }, first, second });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await openDemo(browser, url, { pane: panes.shell, herdr: JSON.stringify(WINDOWS) });
    try {
      await release(page, await firstRead(page), "ok");
      const healthy = await established(page, "late success");
      const before = await nextRead(page);
      const late = await nextRead(page);
      const after = await nextRead(page);
      await release(page, before, "error");
      await headerAfter(page, "stale", "failure before the late answer");
      await release(page, after, "error");
      const unavailable = await headerAfter(page, "offline", "failure after the late answer");
      await release(page, late, "ok", { ...WINDOWS, version: "0.9.6" });
      try {
        await page.waitForFunction(() => document.querySelector(".header-meta .pill-offline") === null
          && document.querySelector(".header-meta .pill-stale")?.getAttribute("title")?.includes("herdr 0.9.6") === true, undefined, { timeout: 10_000 });
      } catch (error) {
        throw new Error(`late success: the header never said unknown naming the late answer: ${JSON.stringify(await readHeader(page))}`, { cause: error });
      }
      await settled(page);
      const reconciled = await readHeader(page);
      assert.equal(reconciled.stale?.text, "Status unknown", "only the failure after the late answer stands");
      sameCapabilities(healthy, reconciled, "late success");
      cases.push({ case: "late-success-between-failures", reads: { before, late, after }, unavailable, reconciled });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await openDemo(browser, url, { pane: panes.shell, herdr: JSON.stringify(WINDOWS) });
    try {
      const before = await readHeader(page);
      assert.equal(before.stale, null, "nothing is claimed before the first read completes");
      assert.equal(before.offline, null, "nothing is claimed before the first read completes");
      await release(page, await firstRead(page), "error");
      const cold = await headerAfter(page, "stale", "cold failure");
      assert.equal(cold.offline, null, "a first failure with nothing before it is unknown");
      assert.doesNotMatch(cold.stale?.title ?? "", /herdr \d/, "no herdr identity is claimed");
      assert.doesNotMatch(cold.chip ?? "", /herdr \d/, "the chip names no herdr");
      assert.equal(cold.soon, false, "with nothing known, the PC is taken as attach-capable, as before");
      await release(page, await nextRead(page), "error");
      const twice = await headerAfter(page, "offline", "second cold failure");
      assert.equal(twice.offline?.text, "herdr unavailable");
      assert.equal(twice.lens, cold.lens, "the lens holds through failures");
      assert.equal(twice.claims, cold.claims, "no attach from a failed read");
      await release(page, await nextRead(page), "ok");
      const first = await established(page, "first success after cold failures");
      await page.locator(".header-meta .pill-offline").waitFor({ state: "detached" });
      assert.equal(first.lens, "chat", "the first real answer brings the PC's capabilities");
      cases.push({ case: "cold-start", cold, twice, first });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  for (const [name, identity, soon] of [["mirror", MIRROR, false], ["older-fields", OLDER, false], ["windows-no-mirror", WINDOWS, true]] as const) {
    for (const observe of [false, true]) {
      const { context, page, errors } = await openDemo(browser, url, { pane: panes.shell, herdr: JSON.stringify(identity), ...(observe ? { observe: "1" } : {}) });
      try {
        await release(page, await firstRead(page), "ok");
        await page.waitForFunction((version) => document.querySelector(".header-meta .conn")?.getAttribute("title")?.includes(`herdr ${version}`) === true, identity.version);
        await settled(page);
        const healthy = await readHeader(page);
        assert.equal(healthy.soon, soon, `${name}: what the terminal lens offers`);
        if (observe) assert.ok(healthy.roles.length > 0 && healthy.roles.every((mode) => mode === "observe"), `${name}: the connection only watches`);
        await release(page, await nextRead(page), "error");
        const unknown = await headerAfter(page, "stale", `${name} first failure`);
        sameCapabilities(healthy, unknown, `${name}${observe ? " observe" : ""} first failure`);
        await release(page, await nextRead(page), "network");
        const unavailable = await headerAfter(page, "offline", `${name} second failure`);
        sameCapabilities(healthy, unavailable, `${name}${observe ? " observe" : ""} second failure`);
        cases.push({ case: `${name}${observe ? "-observe" : ""}`, healthy, unknown, unavailable });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
  }
  {
    const { context, page, errors } = await openDemo(browser, url, { machine: "remote", pane: panes.api, remotes: "1", herdr: JSON.stringify(WINDOWS) });
    try {
      await page.waitForFunction(() => document.querySelector(".header-meta .conn")?.getAttribute("title")?.includes("herdr 0.9.4") === true);
      await release(page, await firstRead(page), "ok");
      await release(page, await nextRead(page), "error");
      const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
      const pick = async (machine: string): Promise<void> => {
        await page.keyboard.press("ControlOrMeta+Shift+K");
        await palette.locator(`.palette-pane[data-machine="${machine}"]`).first().click();
        await palette.waitFor({ state: "detached" });
      };
      await pick("local");
      const local = await headerAfter(page, "stale", "local PC after its failure");
      assert.equal(local.offline, null);
      await pick("remote");
      await page.waitForFunction(() => document.querySelector(".header-meta .conn")?.getAttribute("title")?.includes("herdr 0.9.4") === true);
      const remote = await headerAfter(page, "none", "remote PC");
      assert.equal(remote.stale, null, "a local failure does not mark the remote PC unknown");
      assert.equal(remote.offline, null, "the remote PC's herdr is connected");
      assert.match(remote.chip ?? "", /herdr 0\.9\.4/, "the remote PC's own herdr");
      assert.equal(remote.soon, false, "the remote PC keeps its own attach");
      await page.evaluate(() => window.setRemoteGone(true));
      const offline = await headerAfter(page, "offline", "offline PC");
      assert.equal(offline.offline?.text, "herdr offline", "a PC its bridge reports disconnected keeps the offline pill");
      assert.equal(offline.stale, null);
      cases.push({ case: "pc-scopes", local, remote, offline });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  }
  return { scenario: "health-scope-and-capability", pass: true, cases };
}

if (import.meta.main) {
  const results = process.env["HEALTH_FLAP_RESULTS"];
  if (results) mkdirSync(results, { recursive: true });
  await withDemoBrowser({ tempPrefix: "herdr-health-flap-demo-", afterTransport: `\n<script>(${installHealthFlap.toString()})()</script>` }, async ({ browser, baseUrl }) => {
    for (const scenario of [transientRecovery, scopeAndCapability]) {
      const result = await scenario(browser, baseUrl);
      if (results) writeFileSync(join(results, `${result["scenario"] as string}.json`), JSON.stringify(result, null, 2));
      console.log(`PASS ${result["scenario"] as string}`);
    }
  });
}
