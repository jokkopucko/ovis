import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import type { HoldState } from "../../../shared/account-devices-api.ts";
import { accountDeviceId } from "../../../shared/account-records.ts";
import { generateKeyPair } from "../../../shared/relay-e2ee.ts";
import { ACCOUNT_OPENS_ALL_FEATURE, encodeFrame, FrameType, MuxProtocolError, RELAY_PROTOCOL } from "../../../shared/relay-mux.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import { RelayPcTable } from "../../components/RelayPcTable.tsx";
import { RelayShell, type RelayShellProps } from "../../components/RelayShell.tsx";
import { beginSignIn } from "../account/signin.ts";
import { memoryAccountStore } from "../account/store.ts";
import { SettingsProvider } from "../settings.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import { dashboardModel, dashboardPcs } from "./dashboard.ts";
import { accountOpenPeer, accountOpenRefusalFrame } from "./accountOpenPeer.fixture.ts";
import type { ShellDeviceStore } from "./device.ts";
import { createShellTestPage } from "./shell.test.tsx";
import { AccountOpenUnsupportedError } from "../../../shared/relay-channel.ts";
import { mountRelayShell, type RelayShellMount } from "./shell.tsx";
import { openRelayTransport, RelayTransport } from "./transport.ts";

const SERVICE = "https://account.ovis.sh";
const APP = "https://app.ovis.sh";
const RELAY = "wss://relay.ovis.sh";
const store: ShellDeviceStore = {
  get: async () => undefined, list: async () => [], remove: async () => {},
  removeRow: async () => false, update: async (_id, change) => change(undefined),
};

let browser: ReturnType<typeof createShellTestPage>;
beforeEach(() => { browser = createShellTestPage(); browser.setVisibility("hidden"); });
afterEach(() => { jest.useRealTimers(); setTransport(nativeTransport); browser.dispose(); });

async function accountPc({ release = true, loseRegistrationReply = false, newUntil = null, seen = true, open }: {
  release?: boolean; loseRegistrationReply?: boolean; seen?: boolean;
  newUntil?: string | null;
  open: (...args: [...Parameters<NonNullable<RelayShellMount["open"]>>, ReturnType<typeof generateKeyPair>]) => Promise<RelayTransport>;
}) {
  const identity = generateKeyPair();
  const serverId = deriveServerId(identity.publicKey);
  const entry = { server_id: serverId, label: "Desk", public_key: Buffer.from(identity.publicKey).toString("hex"), relay: RELAY, added_at: new Date().toISOString(), last_seen_at: seen ? new Date().toISOString() : null, new_until: newUntil };
  const accountStore = memoryAccountStore();
  const service = new FakeAccountService();
  service.signInAs("github", "acct_1");
  const started = await beginSignIn("github", { store: accountStore, service: SERVICE, redirectUri: WEB_REDIRECT });
  const returned = (await service.fetch(started)).headers.get("location");
  if (returned === null) throw new TypeError("Missing OAuth return");
  const requests: string[] = [];
  const registrationKeys: string[] = [];
  const navigations: string[] = [];
  const navigated = Promise.withResolvers<string>();
  const appOpened = Promise.withResolvers<void>();
  let props: RelayShellProps | undefined;
  let apps = 0;
  const render = (node: ReactNode): void => {
    if (!isValidElement<{ readonly children?: ReactNode }>(node)) throw new TypeError("Missing shell");
    if (node.type === RelayShell && isValidElement<RelayShellProps>(node)) { props = node.props; return; }
    render(node.props.children);
  };
  const mountAt = (entryUrl: string) => mountRelayShell({
    container: Object.create(null), entryUrl, shellVersion: "1.0.0", store, accountStore,
    // these read the account's rows on the front page: a launch that leaves it for the PC (shell.test.tsx) does not run
    ...(new URL(entryUrl).pathname === "/" ? { navigatedSinceEntry: () => true } : {}),
    accountService: SERVICE, accountFetch: async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      requests.push(path);
      switch (path) {
        case "/v1/pcs": return Response.json({ pcs: [entry] });
        case "/v1/devices/challenge": return release
          ? Response.json({ challenge_id: "12".repeat(16), challenge: "register-this-sign-in" })
          : new Response(null, { status: 404 });
        case "/v1/devices": {
          const key = JSON.parse(String(init?.body)).key;
          registrationKeys.push(key);
          if (key !== registrationKeys[0]) return new Response(null, { status: 409 });
          if (loseRegistrationReply && registrationKeys.length === 1) throw new TypeError("Registration reply lost after commit");
          return Response.json({ no: 7, key });
        }
        default: return service.fetch(input, init);
      }
    },
    createRoot: () => ({ render, unmount() {} }),
    renderApp: () => { apps++; appOpened.resolve(); return { render() {}, unmount() {} }; },
    pendingPush: { get: async () => undefined, clear: async () => {} },
    checkPc: async () => ({ kind: "offline", reason: "relay" }),
    navigate: (path) => { navigations.push(path); navigated.resolve(path); },
    open: (offer, options) => open(offer, options, identity),
  });
  await mountAt(`${APP}/${new URL(returned).hash}`);
  const current = (): RelayShellProps => { if (props === undefined) throw new TypeError("Missing shell props"); return props; };
  const markup = (): string => {
    const { state, directoryRelays } = current();
    if (state.kind !== "empty" || state.account?.kind !== "signed-in" || state.account.pcs === null) throw new TypeError("Missing signed-in directory");
    const rows = dashboardModel(dashboardPcs(state.account.pcs, [], directoryRelays), { label: "Device" }, RELAY).rows;
    return renderToStaticMarkup(createElement(SettingsProvider, null, createElement(RelayPcTable, { rows, onSelect() {}, onOpenSheet() {} })));
  };
  return { accountStore, serverId, requests, registrationKeys, navigations, navigated: navigated.promise, appOpened: appOpened.promise, current, markup, apps: () => apps, reload: () => mountAt(`${APP}/`), openPage: () => mountAt(`${APP}/s/${serverId}/`), follow: (path: string) => mountAt(`${APP}${path}`) };
}

it("A3: a newly added account PC is marked New and its page waits for the Join press", async () => {
  const attempts: boolean[] = [];
  const pressed = Promise.withResolvers<void>();
  const run = await accountPc({
    newUntil: new Date(Date.now() + 23 * 60 * 60_000).toISOString(),
    open: async (_offer, options) => {
      attempts.push(options?.accountOpensAll === true);
      pressed.resolve();
      throw new RangeError("Stop after observing the requested connection");
    },
  });
  const markup = run.markup();
  await run.openPage();
  expect(attempts).toEqual([]);
  const path = run.navigations[0];
  if (path === undefined) throw new TypeError("Missing the PC's join screen");
  await run.follow(path);
  expect(run.current().state.kind).toBe("confirm");
  expect(attempts).toEqual([]);
  expect(run.apps()).toBe(0);
  run.current().onPair();
  await pressed.promise;
  expect(attempts).toEqual([false]);
  // the overview shows nothing new (owner rule): no mark, and no quick Open
  expect(markup).not.toMatch(/>New( PC)?<\//);
  expect(markup).toContain('data-pc-action="join"');
  expect(markup).not.toContain('data-pc-action="open"');
});

it("T34, P18: a normal sign-in opens a listed unpaired PC as its registered account row", async () => {
  const admissions: { feature: boolean | undefined; row: string | null | undefined; key: string | undefined }[] = [];
  class Admitted extends RelayTransport {
    override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
  }
  const run = await accountPc({ open: async (offer, options) => {
    const row = await options?.store?.get(offer.server_id);
    admissions.push({ feature: options?.accountOpensAll, row: row?.device_id, key: row?.public_spki });
    return new Admitted(offer);
  } });
  const key = await run.accountStore.get("signin_key");
  const markup = run.markup();
  expect(markup).not.toContain(">New PC</");
  await run.openPage();
  expect({
    number: key?.no, open: markup.includes('data-pc-action="open"'), join: markup.includes('data-pc-action="join"'),
    admissions, apps: run.apps(), navigations: run.navigations,
  }).toEqual({
    number: 7, open: true, join: false,
    admissions: key ? [{ feature: true, row: accountDeviceId(run.serverId, key.key.public_spki), key: key.key.public_spki }] : [],
    apps: 1, navigations: [],
  });
});

it("C3: a reload of the join card a launch put up, not pressed yet, asks again and opens nothing by the account's key", async () => {
  const run = await accountPc({ open: () => { throw new TypeError("nothing may open before the press"); } });
  browser.sessionStore.set("ovis-launch-join", run.serverId);
  await run.openPage();
  expect({ apps: run.apps(), navigations: run.navigations }).toEqual({ apps: 0, navigations: [expect.stringContaining(`/s/${run.serverId}/#offer=`)] });
  expect(browser.sessionStore.get("ovis-launch-join")).toBe(run.serverId);
  // back on the front page (Back, Forward or a reload into the card keep it), only a press on that PC's link ends it
  await run.reload();
  expect(browser.sessionStore.get("ovis-launch-join")).toBe(run.serverId);
  const click = new Event("click");
  Object.defineProperty(click, "target", { value: { closest: () => ({ getAttribute: () => `/s/${run.serverId}/` }) } });
  browser.page.dispatchEvent(click);
  expect(browser.sessionStore.has("ovis-launch-join")).toBe(false);
});

it("a PC just added to the account that no device is in yet opens on its own page as a new PC, typing the number it shows", async () => {
  const run = await accountPc({ release: false, seen: false, open: () => { throw new TypeError("nothing opens before the number"); } });
  await run.openPage();
  expect(run.navigations).toEqual([expect.stringContaining(`/s/${run.serverId}/#offer=`)]);
  expect(JSON.parse(browser.sessionStore.get("ovis-add-pc-sheet") ?? "null")).toMatchObject({ mode: "new", server_id: run.serverId, alone: true });
  expect(browser.sessionStore.get("ovis-typed-join")).toBe(run.serverId);
});

it("a just-added PC that does not take the account's way in falls back to the new-PC pairing, typing its number", async () => {
  const run = await accountPc({ seen: false, open: async () => { throw new AccountOpenUnsupportedError(); } });
  await run.openPage();
  expect(run.navigations).toEqual([expect.stringContaining(`/s/${run.serverId}/#offer=`)]);
  expect(JSON.parse(browser.sessionStore.get("ovis-add-pc-sheet") ?? "null")).toMatchObject({ mode: "new", server_id: run.serverId, alone: true });
  expect(browser.sessionStore.get("ovis-typed-join")).toBe(run.serverId);
});

it("P18: an account service without the release only receives the challenge probe and still offers Join", async () => {
  const run = await accountPc({ release: false, open: () => { throw new TypeError("Join must wait for confirmation"); } });
  expect(run.markup()).toContain('data-pc-action="join"');
  expect(run.markup()).not.toContain('data-pc-action="open"');
  expect(run.requests.filter((path) => path.startsWith("/v1/devices"))).toEqual(["/v1/devices/challenge"]);
  expect(await run.accountStore.get("signin_key")).toBeUndefined();
  await run.openPage();
  expect(run.navigations).toEqual([expect.stringContaining(`/s/${run.serverId}/#`)]);
});

const refused = (code: string, hold?: HoldState) =>
  Object.assign(new MuxProtocolError("protocol_error", "PC refused"), { code, ...(hold === undefined ? {} : { hold }) });

it("P18, T34: reloading after a lost registration reply opens the PC with the same sign-in key", async () => {
  const run = await accountPc({ loseRegistrationReply: true, open: async (offer) => new class extends RelayTransport {
    override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
  }(offer) });
  const pending = await run.accountStore.get("signin_key");
  if (pending === undefined) throw new TypeError("Missing pending registration");
  expect(pending.no).toBeNull();
  await run.reload();
  expect(run.markup()).toContain('data-pc-action="open"');
  await run.openPage();
  expect(run.apps()).toBe(1);
  expect(run.registrationKeys).toEqual([pending.key.public_spki, pending.key.public_spki]);
});

it("P18, T34: refreshing the same shell after a lost registration reply opens the PC with the same key", async () => {
  const run = await accountPc({ loseRegistrationReply: true, open: async (offer) => new class extends RelayTransport {
    override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
  }(offer) });
  const pending = await run.accountStore.get("signin_key");
  if (pending === undefined) throw new TypeError("Missing pending registration");
  expect(pending.no).toBeNull();

  await run.current().onRefreshAccount?.();

  expect(run.markup()).toContain('data-pc-action="open"');
  expect(run.registrationKeys).toEqual([pending.key.public_spki, pending.key.public_spki]);
});

it.each([false, true])("G5: an old PC (provisional WELCOME: %s) gets no account AUTH and offers pairing", async (provisional) => {
  let auths = 0;
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [], provisional, auth: () => {
      auths++;
      return encodeFrame({ type: FrameType.SESSION_ERROR, stream_id: 0, flags: 0, payload: { code: "auth_failed", message: "" } });
    } }),
  }) });
  await run.openPage();
  expect({ auths, navigation: run.navigations, state: run.current().state.kind }).toEqual({
    auths: 0, navigation: [expect.stringContaining(`/s/${run.serverId}/#offer=`)], state: "connecting",
  });
});

it.each([
  ["not_listed", [true, true]],
  ["admission", [true]],
] as const)("T34, G5: %s offers the same PC's pairing path after the allowed account attempts", async (code, expected) => {
  const attempts: (boolean | undefined)[] = [];
  const run = await accountPc({ open: async (_offer, options) => {
    attempts.push(options?.accountOpensAll);
    throw refused(code);
  } });
  await run.openPage();
  expect({ attempts, navigation: run.navigations, apps: run.apps() }).toEqual({
    attempts: [...expected], navigation: [expect.stringContaining(`/s/${run.serverId}/#offer=`)], apps: 0,
  });
});

it("T34, T53, P17: the held device shows the PC's deadline and retries when it expires", async () => {
  const delay = 4_321;
  const expired = Promise.withResolvers<boolean | undefined>();
  let attempts = 0;
  let until = "";
  const run = await accountPc({ open: async (_offer, options) => {
    if (++attempts === 1) throw refused("held", { reason: "join_hold", until });
    expired.resolve(options?.accountOpensAll);
    throw refused("admission");
  } });
  jest.useFakeTimers();
  until = new Date(Date.now() + delay).toISOString();
  await run.openPage();
  expect(run.current().state.kind).toBe("connecting");
  const screen = renderToStaticMarkup(createElement(SettingsProvider, null, createElement(RelayShell, run.current())));
  expect(screen).toContain('class="join-wait"');
  expect(screen).toContain("opens in 5 s");
  jest.advanceTimersByTime(delay - 1);
  expect(attempts).toBe(1);
  jest.advanceTimersByTime(1);
  expect(await expired.promise).toBe(true);
});

it.each<HoldState>([{ reason: "catching_up" }, { reason: "join_hold", until: null }])("P7, T53: a temporary hold without a deadline retries: $reason", async (hold) => {
  let attempts = 0;
  const run = await accountPc({ open: async (offer) => {
    if (++attempts === 1) throw refused("held", hold);
    return new class extends RelayTransport {
      override get server() { return { version: "1.0.0", relayProtocol: RELAY_PROTOCOL }; }
    }(offer);
  } });
  jest.useFakeTimers();
  await run.openPage();
  jest.advanceTimersByTime(999);
  expect({ kind: run.current().state.kind, attempts }).toEqual({ kind: "connecting", attempts: 1 });
  jest.advanceTimersByTime(1);
  await run.appOpened;
  expect({ attempts, apps: run.apps(), navigations: run.navigations }).toEqual({ attempts: 2, apps: 1, navigations: [] });
});

it("T53: a hold deadline already past on this clock backs off rather than reconnecting immediately", async () => {
  let attempts = 0;
  let until = "";
  const run = await accountPc({ open: async () => {
    if (++attempts <= 2) throw refused("held", { reason: "join_hold", until });
    throw refused("admission");
  } });
  jest.useFakeTimers();
  until = new Date(Date.now() - 1_000).toISOString();
  await run.openPage();

  for (const [advance, expected] of [[999, 1], [1, 2], [1_999, 2], [1, 3]] as const) {
    jest.advanceTimersByTime(advance);
    for (let turn = 0; turn < 100; turn++) await Promise.resolve();
    expect(attempts).toBe(expected);
  }
});

it.each([
  { code: "not_listed", auths: 2, screen: "connecting", pair: true },
  { code: "admission", auths: 1, screen: "connecting", pair: true },
  { code: "held", hold: { reason: "catching_up" }, auths: 1, screen: "connecting", pair: false },
  { code: "held", hold: { reason: "frozen", block: "b".repeat(64) }, auths: 1, screen: "connecting", pair: false },
  { code: "auth_revoked", auths: 1, screen: "revoked", pair: false },
] as const)("T34, G5, P7 wire: $code follows the decoded code, not the message 'held'", async (scenario) => {
  let auths = 0;
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: () => {
      auths++;
      return accountOpenRefusalFrame(scenario.code, "held", "hold" in scenario ? scenario.hold : undefined);
    } }),
  }) });
  jest.useFakeTimers();
  await run.openPage();
  const state = run.current().state;
  expect({ auths, screen: state.kind === "failed" ? state.failure : state.kind, navigation: run.navigations }).toEqual({
    auths: scenario.auths, screen: scenario.screen,
    navigation: scenario.pair ? [expect.stringContaining(`/s/${run.serverId}/#offer=`)] : [],
  });
});

it("T53, P17 wire: a held refusal whose notice is not published yet reaches the shell as a hold with no deadline", async () => {
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: () => accountOpenRefusalFrame("held", "", { reason: "join_hold", until: null }) }),
  }) });
  jest.useFakeTimers();
  await run.openPage();
  expect(run.current().state).toMatchObject({ kind: "connecting", hold: { reason: "join_hold", until: null } });
});

it("OD3, T53, P17 wire: a held device asks again within a second, so when the PC lets it in early (It's me) the app opens before the deadline", async () => {
  const rows: string[] = [];
  let until = "";
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: (frame) => {
      const device_id = frame.payload.device_id;
      rows.push(device_id);
      return rows.length === 1
        ? accountOpenRefusalFrame("held", "", { reason: "join_hold", until })
        : encodeFrame({ type: FrameType.AUTH_OK, stream_id: 0, flags: 0, payload: { device_id, session_id: "cd".repeat(16), role: "drive" } });
    } }),
  }) });
  const key = await run.accountStore.get("signin_key");
  if (key === undefined) throw new TypeError("Missing registered key");
  const row = accountDeviceId(run.serverId, key.key.public_spki);
  jest.useFakeTimers();
  until = new Date(Date.now() + 10_000).toISOString();
  await run.openPage();
  expect({ rows, apps: run.apps() }).toEqual({ rows: [row], apps: 0 });
  jest.advanceTimersByTime(999);
  expect({ rows, apps: run.apps() }).toEqual({ rows: [row], apps: 0 });
  expect(run.current().state).toMatchObject({ kind: "connecting", hold: { reason: "join_hold", until } });
  jest.advanceTimersByTime(1);
  await run.appOpened;
  expect({ rows, apps: run.apps(), navigations: run.navigations }).toEqual({ rows: [row, row], apps: 1, navigations: [] });
});

it("T34 wire: the shell stays Connecting until the decoded hold deadline, then retries AUTH", async () => {
  const delay = 900;
  let until = "";
  const rows: string[] = [];
  const run = await accountPc({ open: (offer, options, identity) => openRelayTransport(offer, {
    ...options, socket: () => accountOpenPeer(identity, { features: [ACCOUNT_OPENS_ALL_FEATURE], provisional: true, auth: (frame) => {
      rows.push(frame.payload.device_id);
      return rows.length === 1
        ? accountOpenRefusalFrame("held", "", { reason: "join_hold", until })
        : accountOpenRefusalFrame("admission", "");
    } }),
  }) });
  jest.useFakeTimers();
  until = new Date(Date.now() + delay).toISOString();
  await run.openPage();
  expect(run.current().state).toMatchObject({ kind: "connecting", hold: { reason: "join_hold", until } });
  jest.advanceTimersByTime(delay - 1);
  expect(rows).toHaveLength(1);
  jest.advanceTimersByTime(1);
  expect(await run.navigated).toContain(`/s/${run.serverId}/#offer=`);
  const key = await run.accountStore.get("signin_key");
  if (key === undefined) throw new TypeError("Missing registered key");
  expect(rows).toEqual(Array(2).fill(accountDeviceId(run.serverId, key.key.public_spki)));
});
