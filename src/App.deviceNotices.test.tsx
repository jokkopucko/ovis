import { afterEach, expect, it, jest, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { openPage, type Page } from "./lib/page.fixture.ts";
import { DeviceJournal, JOURNAL_MAX } from "../server/account/device-journal.ts";
import { parseNoticeAnswer, type DeviceNotice } from "../shared/account-devices-api.ts";
import { parseSafetyRecord, verifySafetyRecord, type BlockRecord } from "../shared/account-records.ts";
import { FakeAccountService } from "../shared/account-service-fake.ts";
import type { OwnJoinRequest, PendingKey } from "../shared/machines.ts";
import type { DeviceRole } from "../shared/access.ts";
import { App } from "./App.tsx";
import { indexedAccountService } from "./lib/account/service.ts";
import { indexedAccountStore, memoryAccountStore, newKey } from "./lib/account/store.ts";
import { DEVICE_NOTICE_FEATURE, DeviceNoticeWire, deviceNotice, NOTICE_SNAPSHOT } from "./lib/deviceNoticeWire.fixture.ts";
import { GhosttyTerminal } from "./lib/ghostty/terminal.ts";
import { translate } from "./lib/i18n.ts";
import { MachineSessionRegistry } from "./lib/machineSession.ts";
import { SettingsProvider } from "./lib/settings.ts";
import { storeSelection } from "./lib/useSplitView.ts";
import { backoffDelay } from "./lib/ws.ts";

let closeFixture: (() => Promise<void>) | undefined;
afterEach(async () => {
  jest.useRealTimers();
  await closeFixture?.();
  closeFixture = undefined;
});

async function withDeviceNotices(
  options: { readonly no?: number | null; readonly laptopId?: string; readonly remoteNotice?: boolean; readonly deskFeatures?: Parameters<DeviceNoticeWire["snapshot"]>[0]; readonly admission?: Partial<DeviceNotice>; readonly decline?: () => Promise<Response>; readonly role?: () => DeviceRole; readonly ownJoins?: () => Response | Promise<Response> },
  check: (fixture: { readonly page: Page; readonly laptop: DeviceNoticeWire; readonly desk: DeviceNoticeWire;
    readonly admission: DeviceNotice; readonly blockPosted: Promise<void>;
    readonly delivered: readonly BlockRecord[]; readonly servicePosts: readonly { readonly body: unknown; readonly status: number }[] }) => void | Promise<void>,
) {
  const keys = memoryAccountStore();
  const service = new FakeAccountService();
  service.opensAll = true;
  const accountId = "acct";
  const target = await newKey();
  const key = options.no === undefined ? undefined : await newKey();
  await keys.set("session", { account: accountId, sign_in_id: "test", provider: "github", service: "https://account.example", access_token: service.issueToken(accountId), refresh_token: "test", expires_at: Number.MAX_SAFE_INTEGER });
  if (key !== undefined && options.no !== undefined) await keys.set("signin_key", { account: accountId, sign_in_id: "test", key, no: options.no });
  for (const no of [1, 2, 3, 4]) {
    service.registerDevice(accountId, no === 4 ? target.public_spki : no === options.no && key !== undefined ? key.public_spki : String(no).repeat(43), `Device ${no}`);
  }
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  const location = new URL("http://localhost:4880/");
  const page = openPage(location.href);
  const matchMedia = () => Object.assign(new EventTarget(), { matches: false });
  const wires = new Map<string, DeviceNoticeWire>();
  const delivered: BlockRecord[] = [];
  const blockPosted = Promise.withResolvers<void>();
  const servicePosts: { readonly body: unknown; readonly status: number }[] = [];
  class Wire extends DeviceNoticeWire {
    constructor(url: string) { super(url); wires.set(new URL(url, location).searchParams.get("machine_id") ?? "local", this); }
    override send(message: string) {
      super.send(message);
      const frame: unknown = JSON.parse(message);
      if (typeof frame !== "object" || frame === null || !("type" in frame) || frame.type !== "notice-answer") return;
      const answer = parseNoticeAnswer(frame);
      if (answer.answer !== "not_me") return;
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        type: "notice-answer-result", id: answer.id, receipts: answer.blocks.map(({ id }) => ({ outcome: "applied", id, n: 1 })),
      }) }));
    }
  }
  Object.defineProperty(page.window, "matchMedia", { configurable: true, value: matchMedia });
  page.window.happyDOM.setViewport({ width: 1440, height: 900 });
  Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(page.window.document, "hasFocus", { configurable: true, value: () => true });
  Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en-US"] });
  Object.defineProperty(page.window.navigator, "userAgent", { configurable: true, value: "Test" });
  Object.defineProperty(page.window.navigator, "platform", { configurable: true, value: "Linux" });
  Object.defineProperty(page.window.navigator, "onLine", { configurable: true, value: true });
  install("localStorage", page.window.localStorage);
  install("sessionStorage", page.window.sessionStorage);
  install("location", page.window.location);
  install("history", page.window.history);
  install("matchMedia", matchMedia);
  install("HTMLElement", page.window.HTMLElement);
  install("requestAnimationFrame", page.window.requestAnimationFrame.bind(page.window));
  install("cancelAnimationFrame", page.window.cancelAnimationFrame.bind(page.window));
  install("MutationObserver", class { observe() {} disconnect() {} });
  install("ResizeObserver", class { observe() {} disconnect() {} });
  install("__HERDR_TEST_HOOKS__", false);
  install("WebSocket", Wire);
  install("EventSource", class extends EventTarget { close() {} });
  install("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input, location);
    const { pathname } = url;
    if (url.origin === "https://account.example" && pathname === "/v1/safety-records" && typeof init?.body === "string") {
      const response = await service.fetch(url, init);
      servicePosts.push({ body: JSON.parse(init.body), status: response.status });
      blockPosted.resolve();
      return response;
    }
    if (url.origin === "https://account.example" && pathname === "/v1/signout") return service.fetch(url, init);
    if (pathname === "/api/devices/pending/decline" && options.decline !== undefined) return options.decline();
    if (pathname === "/api/relay/joins" && options.ownJoins !== undefined) return options.ownJoins();
    if (pathname === "/api/health") return Response.json({
      auth: { required: false, authenticated: true, role: options.role?.() ?? "drive", ...(options.ownJoins === undefined ? {} : { via: "local" }) },
      web_ui: { boot_id: null, revision: null, server_id: options.laptopId },
    });
    if (pathname === "/api/machines") return Response.json({ machines: [
      { id: "local", name: "Laptop", kind: "local", enabled: true, state: "connected", error: null, snapshot: NOTICE_SNAPSHOT },
      { id: "desk", server_id: "b".repeat(32), name: "Desk", kind: "address", enabled: true, state: "connected", error: null, snapshot: NOTICE_SNAPSHOT },
    ] });
    if ((pathname === "/api/machines/desk/account/records" || pathname === "/api/account/records") && init?.method === "POST" && typeof init.body === "string") {
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== "object" || body === null || !("records" in body) || !Array.isArray(body.records)) return new Response(null, { status: 400 });
      const receipts = [];
      for (const input of body.records) {
        const record = parseSafetyRecord(input);
        if (record.kind !== "block") return new Response(null, { status: 400 });
        delivered.push(record);
        receipts.push({ outcome: "applied", id: record.id, n: 2 });
      }
      return Response.json({ receipts });
    }
    return new Response(null, { status: 404 });
  });
  // The notice fixture has no panes; do not start the placeholder terminal's WASM engine.
  const terminal = spyOn(GhosttyTerminal.prototype, "open").mockImplementation(() => {});
  const sessions = spyOn(MachineSessionRegistry.prototype, "peek").mockImplementation(function (this: MachineSessionRegistry, id) {
    const session = this.get(id);
    session.connect();
    return session;
  });
  const account = spyOn(indexedAccountStore, "get").mockImplementation(keys.get);
  const accountUpdate = spyOn(indexedAccountStore, "update").mockImplementation(keys.update);
  const accountUpdateMany = spyOn(indexedAccountStore, "updateMany").mockImplementation(keys.updateMany);
  closeFixture = async () => {
    await page.close();
    terminal.mockRestore();
    sessions.mockRestore();
    account.mockRestore();
    accountUpdate.mockRestore();
    accountUpdateMany.mockRestore();
    for (const [key, previous] of originals) {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  storeSelection(options.remoteNotice ? "desk" : "local", null);
  await page.render(<SettingsProvider><App /></SettingsProvider>);
  const laptop = wires.get("local");
  const desk = wires.get("desk");
  if (!laptop || !desk) throw new Error(`App sockets not connected: ${[...wires.keys()]}`);
  const admission = deviceNotice({ label: "Laptop phone", key: target.public_spki, ...options.admission });
  await act(async () => {
    laptop.open();
    desk.open();
    laptop.snapshot();
    desk.snapshot(options.deskFeatures);
    laptop.read({ type: "device-notice", notice: admission });
    desk.read({ type: "device-notice", notice: deviceNotice({ label: "Desk phone", key: target.public_spki }) });
  });
  await check({ page, get laptop() { return wires.get("local") ?? laptop; }, desk, admission, blockPosted: blockPosted.promise, delivered, servicePosts });
}

it("T57, P15: Laptop's pane never shows Desk's device notice", async () => {
  await withDeviceNotices({}, ({ page, laptop, desk }) => {
    const cards = page.container.querySelectorAll('div[data-testid="device-notice"]');
    expect(cards).toHaveLength(1);
    expect(page.container.textContent).toContain("Laptop phone");
    expect(page.container.textContent).not.toContain("Desk phone");
    expect(laptop.seen()).toEqual([{ type: "notice-seen", seq: 1 }]);
    expect(desk.seen()).toEqual([]);
  });
});

it.each(["local link reconnects", "page becomes visible"])("#4457: shows a waiting join without the next poll when the %s", async (trigger) => {
  jest.useFakeTimers();
  let waiting: readonly OwnJoinRequest[] = [];
  await withDeviceNotices({ ownJoins: () => Response.json({ joins: waiting }) }, async (fixture) => {
    const { page, laptop } = fixture;
    const cards = () => page.container.querySelectorAll('[data-testid="own-join-card"]');
    expect(cards()).toHaveLength(0);
    if (trigger === "local link reconnects") {
      await act(async () => { laptop.close(); jest.advanceTimersByTime(backoffDelay(0)); });
      expect(fixture.laptop).not.toBe(laptop);
    } else {
      Object.defineProperty(page.window.document, "hidden", { configurable: true, value: true });
      await act(async () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
    }
    waiting = [{ id: "waiting-join", label: "Phone", asked_at: new Date().toISOString(), left_ms: 60_000 }];
    await act(async () => {
      if (trigger === "local link reconnects") fixture.laptop.open();
      else {
        Object.defineProperty(page.window.document, "hidden", { configurable: true, value: false });
        page.window.document.dispatchEvent(new page.window.Event("visibilitychange"));
      }
    });
    expect([...cards()].map((card) => card.getAttribute("data-join"))).toEqual(["waiting-join"]);
  });
});

it.each([
  ["locked before reconnect", "locked", true],
  ["locked while reconnect read is pending", "locked", false],
  ["own window refusal while reconnect read is pending", "own_window_required", false],
] as const)("#4457: a waiting join still appears after %s", async (_scenario, code, answerBeforeReconnect) => {
  jest.useFakeTimers();
  let readJoins: () => Response | Promise<Response> = () => Response.json({ joins: [] });
  await withDeviceNotices({ ownJoins: () => readJoins() }, async (fixture) => {
    const { page, laptop } = fixture;
    await act(async () => { laptop.close(); jest.advanceTimersByTime(backoffDelay(0)); });
    expect(fixture.laptop).not.toBe(laptop);
    const visibility = Promise.withResolvers<Response>();
    const reconnect = Promise.withResolvers<Response>();
    let reconnectReads = 0;
    readJoins = () => visibility.promise;
    const show = () => { page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); };
    const refuse = () => { visibility.resolve(Response.json({ error: { code } }, { status: 403 })); };
    await act(async () => { show(); });
    if (answerBeforeReconnect) await act(async () => { refuse(); });
    readJoins = () => { reconnectReads++; return reconnect.promise; };
    await act(async () => { fixture.laptop.open(); });
    if (!answerBeforeReconnect) await act(async () => { refuse(); });
    await act(async () => {
      reconnect.resolve(Response.json({ joins: [{ id: "waiting-join", label: "Phone", asked_at: new Date().toISOString(), left_ms: 60_000 }] }));
    });
    const card = '[data-testid="own-join-card"]';
    expect(reconnectReads).toBe(1);
    expect([...page.container.querySelectorAll(card)].map((node) => node.getAttribute("data-join"))).toEqual(["waiting-join"]);
    readJoins = () => Response.json({ joins: [] });
    await act(async () => { show(); });
    expect(page.container.querySelectorAll(card)).toHaveLength(0);
  });
});

it.each([
  ["older", 3, 1],
  ["same order", 4, 0],
  ["newer", 5, 0],
  ["unregistered", null, 0],
  ["missing", undefined, 0],
] as const)("T51: Not me is gated by a %s sign-in key", async (_label, no, count) => {
  await withDeviceNotices(no === undefined ? {} : { no }, ({ page }) => {
    expect([...page.container.querySelectorAll("button")].filter((button) => button.textContent === "Not me")).toHaveLength(count);
  });
});

it.each([
  ["identified", { laptopId: "a".repeat(32) }, "applied", "Laptop: blocked"],
  ["unidentified", {}, "waiting", "Laptop: waiting for its answer"],
  ["identified with a flag-off roster PC", { laptopId: "a".repeat(32), deskFeatures: [] }, "applied", "Laptop: blocked"],
] as const)("G5, T51, T60, T65: %s notice PC takes one signed block and only enabled roster PCs get records POSTs", async (_label, identity, state, line) => {
  await withDeviceNotices({ no: 3, ...identity }, async ({ page, laptop, desk, delivered, servicePosts, blockPosted }) => {
    const button = [...page.container.querySelectorAll("button")].find((node) => node.textContent === "Not me");
    if (button === undefined) throw new TypeError("Missing Not me");
    await act(async () => { button.click(); await blockPosted; });

    const answers = laptop.sent.filter((frame) => frame.type === "notice-answer").map(parseNoticeAnswer);
    expect(answers).toHaveLength(1);
    const answer = answers[0];
    expect(answer).toMatchObject({ id: deviceNotice().id, answer: "not_me" });
    if (answer?.answer !== "not_me") return;
    expect(answer.blocks).toHaveLength(1);
    for (const block of answer.blocks) expect(await verifySafetyRecord(block)).toBe(true);
    expect(desk.sent.filter((frame) => frame.type === "notice-answer")).toEqual([]);
    expect(servicePosts).toEqual([{ body: { record: answer.blocks[0] }, status: 200 }]);
    expect(delivered).toEqual("deskFeatures" in identity ? [] : answer.blocks);

    const card = page.one('[data-testid="device-notice"]');
    expect([...card.querySelectorAll("li")].map((row) => [row.getAttribute("data-state"), row.textContent])).toEqual(
      "deskFeatures" in identity ? [[state, line]] : [[state, line], ["waiting", "Desk: waiting for its answer"]],
    );
  });
});

it("an admission with two-step unknown keeps the one-tap Not me (T51, T60)", async () => {
  await withDeviceNotices({ no: 3, admission: { method: "google", two_step: "unknown" } }, ({ page }) => {
    const card = page.one('[data-testid="device-notice"]');
    const buttons = [...card.querySelectorAll("button")].filter((button) => button.textContent === translate("en", "Not me"));
    expect(buttons.map((button) => button.disabled)).toEqual([false]);
  });
});

it("T60: a remote notice counts the page PC’s own records receipt, not the proxy receipt", async () => {
  await withDeviceNotices({ no: 3, laptopId: "a".repeat(32), remoteNotice: true }, async ({ page, desk, laptop, delivered, blockPosted }) => {
    const card = page.one('[data-testid="device-notice"]');
    const button = [...card.querySelectorAll("button")].find((node) => node.textContent === "Not me");
    if (!button) throw new TypeError("Missing Not me");
    await act(async () => { button.click(); await blockPosted; });
    expect(laptop.sent.filter((frame) => frame.type === "notice-answer")).toEqual([]);
    const [answer] = desk.sent.filter((frame) => frame.type === "notice-answer").map(parseNoticeAnswer);
    if (answer?.answer !== "not_me") throw new TypeError("Missing remote notice answer");
    expect(delivered).toEqual(answer.blocks);
    expect([...card.querySelectorAll("li")].map((row) => row.textContent).sort()).toEqual([
      "Desk: waiting for its answer", "Laptop: blocked",
    ]);
  });
});

it("T51: signing out hides Not me on an open admission without a fresh notice", async () => {
  await withDeviceNotices({ no: 3 }, async ({ page }) => {
    const card = page.one('[data-testid="device-notice"]');
    const actions = () => [...card.querySelectorAll("button")].filter((node) => node.textContent === "Not me");
    expect(actions()).toHaveLength(1);
    const event = Object.getOwnPropertyDescriptor(globalThis, "Event");
    Object.defineProperty(globalThis, "Event", { configurable: true, value: page.window.Event });
    try {
      await act(async () => { await indexedAccountService.signOut(); });
    } finally {
      if (event) Object.defineProperty(globalThis, "Event", event);
      else Reflect.deleteProperty(globalThis, "Event");
    }
    expect(await indexedAccountService.session()).toBeUndefined();
    expect(actions()).toHaveLength(0);
  });
});

it("T53: an open admission offers It's me and Not me", async () => {
  await withDeviceNotices({ no: 3 }, ({ page }) => {
    const card = page.one('[data-testid="device-notice"]');
    const actionLabels = [...card.querySelectorAll("button")].flatMap((button) => [...button.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent));
    expect(actionLabels).toEqual([translate("en", "It's me"), translate("en", "Not me")]);
  });
});

it("S2P-10, T53: replayed closes clear a refusal and stop a locked press from retrying", async () => {
  jest.useFakeTimers();
  try {
    await withDeviceNotices({}, async (fixture) => {
      const { page, laptop, admission } = fixture;
      const pending = deviceNotice({ id: "b".repeat(32), seq: 2, label: "Second phone" });
      const actions = () => [...page.container.querySelectorAll("button")].filter((button) => button.textContent === "It's me");
      const refusals = () => page.container.querySelectorAll('[class="settings-hint its-me-refused"]');
      const [first] = actions();
      if (!first) throw new TypeError("Missing first admission action");
      await act(async () => { first.click(); });
      await act(async () => { jest.advanceTimersByTime(5_000); });
      await act(async () => { jest.advanceTimersByTime(5_000); });
      expect(refusals()).toHaveLength(1);

      await act(async () => { laptop.read({ type: "device-notice", notice: pending }); });
      expect(laptop.seen()).toEqual([{ type: "notice-seen", seq: 1 }, { type: "notice-seen", seq: 2 }]);
      const [, second] = actions();
      if (!second) throw new TypeError("Missing second admission action");
      await act(async () => { second.click(); });
      expect(second.disabled).toBe(true);
      expect(laptop.sent.filter((frame) => frame.type === "notice-answer")).toHaveLength(3);

      await act(async () => { laptop.close(); jest.advanceTimersByTime(backoffDelay(0)); });
      const reconnect = fixture.laptop;
      expect(reconnect).not.toBe(laptop);
      await act(async () => {
        reconnect.open();
        reconnect.read({ type: "features", features: [DEVICE_NOTICE_FEATURE], connection: "laptop-reconnect" });
        reconnect.read({ type: "device-notice-replay", replay: { notices: [
          { ...admission, seq: 3, open: false },
          { ...pending, seq: 4, open: false },
        ], cut: 0 } });
        reconnect.snapshot();
      });
      expect(refusals()).toHaveLength(0);
      expect(actions()).toHaveLength(0);
      expect(reconnect.seen()).toEqual([{ type: "notice-seen", seq: 4 }]);
      await act(async () => { jest.advanceTimersByTime(5_000); });
      expect(reconnect.sent.filter((frame) => frame.type === "notice-answer")).toEqual([]);
    });
  } finally {
    jest.useRealTimers();
  }
});

it.each(["refused", "locked"] as const)("S2P-10: a reconnect cut clears a %s open card after its close was trimmed", async (state) => {
  const dir = mkdtempSync(join(tmpdir(), "ovis-app-notice-cut-"));
  jest.useFakeTimers();
  try {
    const journal = DeviceJournal.open(dir);
    const input = { kind: "admit", how: "list", account: "acct", key: null, by: null, row: "phone", no: 2, label: "Decided phone" } as const;
    const stale = journal.append(input);
    const survivor = journal.notice(journal.append({ ...input, row: "other", no: 3, label: "Still open phone" }));
    await withDeviceNotices({ admission: journal.notice(stale) }, async (fixture) => {
      const { page, laptop } = fixture;
      const actions = () => [...page.container.querySelectorAll("button")].filter(button => button.textContent === "It's me");
      const refusals = () => page.container.querySelectorAll('[class="settings-hint its-me-refused"]');
      await act(async () => { laptop.read({ type: "device-notice", notice: survivor }); });
      const [press] = actions();
      if (!press) throw new Error("Missing admission action");
      await act(async () => { press.click(); });
      if (state === "refused") {
        await act(async () => { jest.advanceTimersByTime(5_000); });
        await act(async () => { jest.advanceTimersByTime(5_000); });
        expect(refusals()).toHaveLength(1);
      } else {
        expect(press.disabled).toBe(true);
      }
      const observer = "observer";
      const ack = laptop.seen().at(-1)?.seq;
      expect(ack).toBe(survivor.seq);
      if (ack === undefined) throw new Error("Missing observer acknowledgment");
      journal.ack(observer, ack);
      await act(async () => { laptop.close(); });
      expect(journal.decide(stale.id)).toBe(true);
      for (let i = 0; i < JOURNAL_MAX; i++) journal.append({ ...input, kind: "drop", row: "unrelated" });
      const replay = DeviceJournal.open(dir).replay(observer, entry => entry.row !== "unrelated");
      expect(replay).toEqual({ notices: [survivor], cut: 1 });

      await act(async () => { jest.advanceTimersByTime(backoffDelay(0)); });
      const reconnect = fixture.laptop;
      expect(reconnect).not.toBe(laptop);
      await act(async () => {
        reconnect.open();
        reconnect.read({ type: "features", features: [DEVICE_NOTICE_FEATURE], connection: "laptop-reconnect" });
        reconnect.read({ type: "device-notice-replay", replay });
        reconnect.snapshot();
      });
      expect(actions().map(action => action.disabled)).toEqual([false]);
      expect(page.container.textContent).not.toContain("Decided phone");
      expect(refusals()).toHaveLength(0);
      await act(async () => {
        reconnect.read({ type: "device-notice", notice: deviceNotice({ id: "c".repeat(32), seq: ack + JOURNAL_MAX + 2, kind: "method", open: false }) });
        jest.advanceTimersByTime(5_000);
      });
      expect(actions().map(action => action.disabled)).toEqual([false]);
      expect(reconnect.sent.filter(frame => frame.type === "notice-answer")).toEqual([]);
    });
  } finally {
    jest.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it("T71, T72: a delayed decline reply cannot restore a key removed by a newer PC event", async () => {
  const reply = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  await withDeviceNotices({ decline: () => { started.resolve(); return reply.promise; } }, async ({ page, laptop }) => {
    const first: PendingKey = { id: "first", label: "Phone", fingerprint: "AB12-CD34", via: "relay", redeemed_at: "2026-11-20T04:00:00.000Z", slots: { used: 1, of: 5 } };
    const second: PendingKey = { ...first, id: "second", label: "Tablet" };
    const declines = () => [...page.container.querySelectorAll("button")].filter((button) => button.textContent === "Decline");
    await act(async () => {
      laptop.snapshot([DEVICE_NOTICE_FEATURE, "machine-events"]);
      laptop.read({ type: "machine-event", event: { type: "pending-redemptions", pending: [first, second] } });
    });
    const [decline] = declines();
    expect(declines()).toHaveLength(2);
    if (decline === undefined) throw new TypeError("Missing Decline button");
    await act(async () => { decline.click(); await started.promise; });

    await act(async () => { laptop.read({ type: "machine-event", event: { type: "pending-redemptions", pending: [] } }); });
    expect(declines()).toHaveLength(0);
    await act(async () => { reply.resolve(Response.json({ pending: [second] })); });
    expect(declines()).toHaveLength(0);
  });
});

it("T71, T72: losing drive clears the waiting keys without needing another PC event", async () => {
  let role: DeviceRole = "drive";
  await withDeviceNotices({ role: () => role }, async ({ page, laptop }) => {
    const pending: PendingKey = { id: "waiting", label: "Phone", fingerprint: "AB12-CD34", via: "relay", redeemed_at: "2026-11-20T04:00:00.000Z", slots: { used: 1, of: 5 } };
    const declines = () => [...page.container.querySelectorAll("button")].filter((button) => button.textContent === "Decline");
    await act(async () => {
      laptop.snapshot([DEVICE_NOTICE_FEATURE, "machine-events"]);
      laptop.read({ type: "machine-event", event: { type: "pending-redemptions", pending: [pending] } });
    });
    expect(declines()).toHaveLength(1);

    await act(async () => { role = "watch"; page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
    expect(declines()).toHaveLength(0);
    await act(async () => { laptop.read({ type: "machine-event", event: { type: "pending-redemptions", pending: [pending] } }); });
    await act(async () => { role = "drive"; page.window.document.dispatchEvent(new page.window.Event("visibilitychange")); });
    expect(declines()).toHaveLength(0);
  });
});
