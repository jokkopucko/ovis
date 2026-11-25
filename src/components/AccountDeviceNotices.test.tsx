import { afterEach, expect, it, jest, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { LOCAL_MACHINE, type Machine } from "../../shared/machines.ts";
import { parseSafetyRecord, type BlockRecord } from "../../shared/account-records.ts";
import { ACCOUNT_SESSION_EVENT, indexedAccountStore, memoryAccountStore, newKey, type AccountSession } from "../lib/account/store.ts";
import { DeviceNoticeWire, deviceNotice } from "../lib/deviceNoticeWire.fixture.ts";
import { MachineSession, MachineSessionRegistry } from "../lib/machineSession.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { HerdrSocket } from "../lib/ws.ts";
import { ACCOUNT_SIGN_OUT_EVENT, AccountService } from "../lib/account/service.ts";
import { useAccountDeviceNotices } from "./AccountDeviceNotices.tsx";

function noticeSockets(...wires: DeviceNoticeWire[]) {
  return class {
    constructor(url: string) {
      const route = new URL(url);
      route.searchParams.delete("receipt_resume_id"); // identifies the browser, not the destination PC
      const wire = wires.find((candidate) => candidate.url === route.href);
      if (!wire) throw new Error(`Unexpected WebSocket: ${url}`);
      return wire;
    }
  };
}

it.each([
  ["T51, T60: retry the exact signed block after a lost response", "lost response"],
  ["T51, T60: retry the exact signed block after a 503 after dismissal", "503 after dismissal"],
  ["T51, T60: retry the exact signed block after a wrong record ID", "wrong record ID"],
  ["T51, T60, T65: show unopened and flag-off roster PCs without posting to them", "roster"],
  ["T51, T60, T65: a flag-off route outranks an unopened route to the same PC listed after it", "roster twin after"],
  ["T51, T60, T65: a flag-off route outranks an unopened route to the same PC listed before it", "roster twin before"],
] as const)("%s", async (_title, failure) => {
  const showRoster = failure.startsWith("roster");
  const dismissWhilePending = failure === "503 after dismissal";
  const notice = deviceNotice({ key: (await newKey()).public_spki });
  const wire = new DeviceNoticeWire("ws://localhost/ws");
  const events = new EventTarget();
  const posted: BlockRecord[] = [];
  const pcPosts: string[] = [];
  const onPc: string[] = [];
  const started = Promise.withResolvers<void>();
  const pendingReply = Promise.withResolvers<Response>();
  const serverId = "a".repeat(32);
  const roster = [
    { id: "study", name: "Study", server_id: "b".repeat(32) },
    { id: "studio", name: "Studio", server_id: "c".repeat(32) },
    { id: "lab", name: "Lab", server_id: "d".repeat(32) },
  ] as const;
  const machines: readonly Machine[] = [
    { id: LOCAL_MACHINE, name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null },
    ...(showRoster ? [
      ...(failure === "roster twin before" ? [{ id: "lab-relay", name: "Lab", server_id: "d".repeat(32) }] : []),
      ...roster,
      ...(failure === "roster twin after" ? [{ id: "lab-relay", name: "Lab", server_id: "d".repeat(32) }] : []),
      { id: "other", name: "Other", server_id: "e".repeat(32) },
    ].map((machine): Machine => ({
      ...machine, kind: "relay", enabled: true, state: "connected", error: null, snapshot: null,
    })) : []),
  ];
  const wires = new Map([
    [wire.url, wire],
    ...(["studio", "lab"] as const).map(id => [`ws://localhost/ws?pc=${id}`, new DeviceNoticeWire(`ws://localhost/ws?pc=${id}`)] as const),
  ]);
  const session = { account: "acct", provider: "github", service: "https://account.example", sign_in_id: "test", access_token: "access", refresh_token: "refresh", expires_at: Date.now() + 3600_000 } as const;
  const store = memoryAccountStore();
  await store.set("session", session);
  await store.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id, no: 1, key: await newKey() });
  const replaced = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: Object.assign(events, { location: new URL("http://localhost/"), setTimeout, clearTimeout, setInterval, clearInterval }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    WebSocket: noticeSockets(...wires.values()),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    replaced.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const get = spyOn(indexedAccountStore, "get").mockImplementation(store.get);
  const update = spyOn(indexedAccountStore, "update").mockImplementation(store.update);
  const updateMany = spyOn(indexedAccountStore, "updateMany").mockImplementation(store.updateMany);
  const postBlock: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    if (url === `${session.service}/v1/pcs` && init?.method === "GET") {
      return Response.json({ pcs: showRoster ? [...roster, { id: "attic", name: "Attic", server_id: "f".repeat(32) }].map(row => ({
        server_id: row.server_id, label: row.name, added_at: new Date(0).toISOString(), last_seen_at: null,
      })) : [] });
    }
    if (url.startsWith("/api/machines/") && init?.method === "POST") {
      pcPosts.push(url);
      const record = parseSafetyRecord(JSON.parse(String(init.body)).records[0]);
      return Response.json({ receipts: [{ outcome: "applied", id: record.id, n: 2 }] });
    }
    expect(url).toBe(`${session.service}/v1/safety-records`);
    const record = parseSafetyRecord(JSON.parse(String(init?.body)).record);
    if (record.kind !== "block") throw new TypeError("Expected a block");
    posted.push(record);
    if (posted.length === 1) {
      started.resolve();
      switch (failure) {
        case "503 after dismissal": return pendingReply.promise;
        case "wrong record ID": return Response.json({ id: "another-record" });
        case "lost response": throw new TypeError("The account response was lost");
        case "roster": case "roster twin after": case "roster twin before": break;
      }
    }
    return Response.json({ id: record.id });
  }, { preconnect: fetch.preconnect });
  const post = spyOn(globalThis, "fetch").mockImplementation(postBlock);
  const send = spyOn(wire, "send").mockImplementation((message) => {
    DeviceNoticeWire.prototype.send.call(wire, message);
    const outgoing = JSON.parse(message);
    if (outgoing.type !== "notice-answer") return;
    const record = parseSafetyRecord(outgoing.blocks[0]);
    onPc.push(record.id);
    wire.read({ type: "notice-answer-result", id: notice.id, receipts: [{ outcome: "applied", id: record.id, n: 2 }] });
  });
  const socket = new HerdrSocket(wire.url);
  const machineSessions = new MachineSessionRegistry((id) => new MachineSession(id, {
    socket: id === LOCAL_MACHINE ? socket : new HerdrSocket(`ws://localhost/ws?pc=${id}`),
  }));
  function Probe() {
    return useAccountDeviceNotices({ machines, machineSessions, selectedMachineId: LOCAL_MACHINE, pageServerId: serverId });
  }
  let renderer: ReactTestRenderer | undefined;
  try {
    machineSessions.get(LOCAL_MACHINE);
    if (showRoster) {
      for (const [id, capable] of [["studio", true], ["lab", false]] as const) {
        const remote = machineSessions.get(id).socket;
        remote.connect();
        const connection = wires.get(`ws://localhost/ws?pc=${id}`);
        if (connection === undefined) throw new Error(`Missing wire for ${id}`);
        connection.open();
        if (capable) connection.snapshot(); else connection.snapshot([]);
      }
    }
    await act(async () => { renderer = create(<SettingsProvider><Probe /></SettingsProvider>); });
    socket.connect();
    wire.open();
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice }); });
    const root = renderer?.root;
    if (root === undefined) throw new TypeError("Missing notice view");
    const button = (label: string) => root.findAllByType("button").find((node) => node.children.includes(label));

    const notMe = button("Not me");
    if (notMe === undefined) throw new TypeError("Missing Not me button");
    if (showRoster) {
      await act(async () => { await notMe.props.onClick(); });
      expect(pcPosts).toEqual(["/api/machines/studio/account/records"]);
      const lines = root.findAllByType("li").map(node => node.children.join(""));
      expect(lines).toContain("Study: not reached; it applies the block at its next check");
      expect(lines).toContain("Lab: needs an Ovis update to block");
      expect(lines.filter(line => line.startsWith("Lab:"))).toHaveLength(1);
      // a PC of the account this browser has never listed is still named, and still gets no request
      expect(lines).toContain("Attic: not reached; it applies the block at its next check");
      expect(lines.some(line => line.startsWith("Other:"))).toBe(false);
      return;
    }
    if (dismissWhilePending) {
      let delivery: Promise<void> | undefined;
      await act(async () => { delivery = notMe.props.onClick(); await started.promise; });
      await act(async () => { root.findByProps({ "aria-label": "Dismiss" }).props.onClick(); });
      expect(root.findAllByProps({ "data-testid": "device-notice" })).toHaveLength(0);
      await act(async () => { pendingReply.resolve(new Response(null, { status: 503 })); await delivery; });
      expect(root.findAllByProps({ "data-testid": "device-notice" })).toHaveLength(0);
    } else {
      await act(async () => { await notMe.props.onClick(); });
      expect(root.findAllByProps({ "data-state": "applied" })).toHaveLength(1);
    }
    expect(root.findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(1);

    // The PC already applied the block. Its decision and a disconnected notice feed must not drop the account retry.
    await act(async () => { wire.read({ type: "device-notice", notice: { ...notice, open: false } }); wire.close(); });
    const retry = button("Try again");
    if (retry === undefined) throw new TypeError("Missing account retry");
    await act(async () => { await retry.props.onClick(); });

    const [pcRecordId] = onPc;
    if (pcRecordId === undefined) throw new TypeError("The PC did not receive a block");
    expect(posted.map((record) => record.id)).toEqual([pcRecordId, pcRecordId]);
    expect(posted[0]).toEqual(posted[1]);
    expect(onPc).toHaveLength(1);
    expect(root.findAllByProps({ "data-state": "applied" })).toHaveLength(dismissWhilePending ? 0 : 1);
    expect(root.findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
    expect(button("Try again")).toBeUndefined();
  } finally {
    await act(async () => { renderer?.unmount(); });
    machineSessions.closeAll();
    send.mockRestore();
    post.mockRestore();
    updateMany.mockRestore();
    update.mockRestore();
    get.mockRestore();
    for (const [key, descriptor] of replaced) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

const itsMeMachines: readonly Machine[] = [
  { id: "local", name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null },
  { id: "lab", name: "Lab", kind: "relay", enabled: true, state: "connected", error: null, snapshot: null },
];

let itsMeRenderer: ReactTestRenderer | undefined;
let sessions: MachineSessionRegistry | undefined;
const globals = new Map<string, PropertyDescriptor | undefined>();

afterEach(async () => {
  await act(async () => { itsMeRenderer?.unmount(); });
  itsMeRenderer = undefined;
  sessions?.retainMachines(new Set());
  sessions = undefined;
  jest.restoreAllMocks();
  jest.useRealTimers();
  for (const [key, old] of globals) {
    if (old) Object.defineProperty(globalThis, key, old);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});

const itsMeSession = {
  service: "https://account.ovis.sh", account: "acct", provider: "github",
  access_token: "access", refresh_token: "refresh", sign_in_id: "this-sign-in",
} as const;

async function setupItsMe({
  session = { ...itsMeSession, expires_at: Date.now() + 60_000 },
  admission = deviceNotice({ row: "new-phone" }),
  localOnly = false,
  seed = true,
}: {
  readonly session?: AccountSession;
  readonly admission?: ReturnType<typeof deviceNotice>;
  readonly localOnly?: boolean;
  readonly seed?: boolean;
} = {}) {
  jest.useFakeTimers();
  const desk = new DeviceNoticeWire("ws://localhost/ws?pc=desk");
  const lab = new DeviceNoticeWire("ws://localhost/ws?pc=lab");
  for (const [key, value] of Object.entries({
    window: Object.assign(new EventTarget(), { location: new URL("http://localhost/"), setTimeout, clearTimeout, setInterval, clearInterval }),
    document: Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } }),
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    WebSocket: noticeSockets(desk, lab),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const store = memoryAccountStore();
  await store.set("session", session);
  if (!localOnly && session.sign_in_id !== undefined) {
    await store.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id, no: 1, key: await newKey() });
  }
  spyOn(indexedAccountStore, "get").mockImplementation(store.get);
  const registry = new MachineSessionRegistry((id) => new MachineSession(id, { socket: new HerdrSocket(id === "local" ? desk.url : lab.url) }));
  sessions = registry;
  const machines = localOnly ? itsMeMachines.filter(({ id }) => id === "local") : itsMeMachines;
  for (const machine of machines) registry.get(machine.id).socket.connect();
  desk.open();
  if (!localOnly) lab.open();
  function Notices({ selected }: { selected: string }) {
    return useAccountDeviceNotices({ machines, machineSessions: registry, selectedMachineId: selected, pageServerId: undefined });
  }
  await act(async () => { itsMeRenderer = create(<SettingsProvider><Notices selected="local" /></SettingsProvider>); });
  const view = itsMeRenderer;
  if (view === undefined) throw new TypeError("Missing notice view");
  const select = (selected: string) => act(async () => { view.update(<SettingsProvider><Notices selected={selected} /></SettingsProvider>); });
  const actions = () => view.root.findAll((node) => node.type === "button" && node.children.includes("It's me"));
  const button = () => view.root.find((node) => node.type === "button" && node.children.includes("It's me"));
  const refusal = () => view.root.findAll((node) => node.type === "p" && node.children.includes("Desk did not accept It's me from this device."));
  const answers = (wire = desk) => wire.sent.filter(({ type }) => type === "notice-answer");
  if (seed) await act(async () => {
    desk.snapshot();
    desk.read({ type: "device-notice", notice: admission });
    if (!localOnly) {
      lab.snapshot();
      lab.read({ type: "device-notice", notice: admission });
    }
  });
  return { desk, lab, session, store, view, admission, select, actions, button, refusal, answers };
}

it("a device is never shown the notice of its own admission: one about this sign-in's key stays off, another key's shows", async () => {
  const { desk, store, view } = await setupItsMe({ seed: false });
  const own = await store.get("signin_key");
  if (own === undefined) throw new TypeError("Missing sign-in key");
  const other = (await newKey()).public_spki;
  const shown = () => view.root.findAllByProps({ "data-testid": "device-notice" });
  await act(async () => {
    desk.snapshot();
    desk.read({ type: "device-notice", notice: deviceNotice({ row: "phone-joined-row", key: own.key.public_spki }) });
  });
  expect(shown()).toHaveLength(0);
  await act(async () => { desk.read({ type: "device-notice", notice: deviceNotice({ id: "b".repeat(32), seq: 2, row: "tablet", key: other }) }); });
  expect(shown()).toHaveLength(1);
});

it("T53, T57: It's me uses only the admission PC's socket and retries only until that PC confirms", async () => {
  const fetched = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(null, { status: 500 }), { preconnect: fetch.preconnect }));
  const { desk, lab, view, admission, select, actions, answers } = await setupItsMe({ seed: false });
  const confirmation = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
  const answer = { type: "notice-answer", id: admission.id, answer: "its_me" };

  await act(async () => {
    desk.snapshot();
    lab.snapshot();
    desk.read({ type: "device-notice", notice: deviceNotice({ ...admission, account: "another-account" }) });
  });
  expect(actions()).toHaveLength(0);
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  expect(actions()).toHaveLength(1);
  const [button] = actions();
  if (button === undefined) throw new TypeError("Missing admission action");
  await act(async () => { button.props.onClick(); });
  expect(button.props.disabled).toBe(true);
  expect(answers(desk)).toEqual([answer]);
  // away to Lab and back while it is out: still one answer out for this PC's notice
  await select("lab");
  await select("local");
  const [again] = actions();
  expect(again?.props.disabled).toBe(true);
  const notMe = view.root.find((node) => node.type === "button" && node.children.includes("Not me"));
  expect(notMe.props.disabled).toBe(true);
  await act(async () => { await Promise.all([again?.props.onClick(), notMe.props.onClick()]); });
  expect(answers(desk)).toEqual([answer]);
  expect(answers(lab)).toEqual([]);
  await act(async () => { lab.read({ type: "device-notice", notice: confirmation }); jest.advanceTimersByTime(5_000); });
  expect(answers(desk)).toEqual([answer, answer]);
  expect(answers(lab)).toEqual([]);
  await act(async () => { desk.read({ type: "device-notice", notice: confirmation }); });
  expect(actions()).toHaveLength(0);
  await act(async () => { jest.advanceTimersByTime(10_000); });
  expect(answers(desk)).toEqual([answer, answer]);
  expect(fetched.mock.calls.map(([input]) => String(input)).filter((url) => url.includes("records"))).toEqual([]);
});

it.each([
  ["a confirm for another admission on the same PC leaves it waiting, and it is sent once more", "other", 2],
  ["a confirm on the first try sends it no second time", "first", 1],
] as const)("T53, P15: %s; no attempt goes to a records route", async (_name, reply, sentTimes) => {
  const fetched = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(null, { status: 500 }), { preconnect: fetch.preconnect }));
  const { desk, view, admission, button: findButton, answers } = await setupItsMe({ localOnly: true });
  const confirm = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false, ...(reply === "other" ? { row: "another-phone" } : {}) });
  const button = findButton();
  await act(async () => { button.props.onClick(); });
  await act(async () => { desk.read({ type: "device-notice", notice: confirm }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(sentTimes);
  // another admission's confirm leaves this card where it was; this one's own closes it
  expect(view.root.findAllByProps({ "data-testid": "device-notice" })).toHaveLength(reply === "other" ? 1 : 0);
  if (reply === "other") expect(button.props.disabled).toBe(false);
  fetched.mockRestore();
});

it("T53: an It's me refusal survives switching PCs and clears on the next press", async () => {
  const { desk, view, admission, select, button, refusal, answers } = await setupItsMe();
  const notMe = () => view.root.find((node) => node.type === "button" && node.children.includes("Not me"));
  await act(async () => { button().props.onClick(); });
  expect(refusal()).toHaveLength(0);
  // one answer at a time per notice: Not me waits while It's me is out
  expect(notMe().props.disabled).toBe(true);
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(2);
  expect(refusal()).toHaveLength(0);
  // away to Lab while Desk still waits: Desk's last wait ends there, and its refusal is not Lab's
  await select("lab");
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(button().props.disabled).toBe(false);
  expect(view.root.findAllByProps({ className: "settings-hint its-me-refused" })).toHaveLength(0);
  await select("local");
  expect(refusal()).toHaveLength(1);
  expect(button().props.disabled).toBe(false);
  expect(notMe().props.disabled).toBe(false);
  await act(async () => { button().props.onClick(); });
  expect(refusal()).toHaveLength(0);
  expect(answers()).toHaveLength(3);
  // decided on that PC another way meanwhile: its silence is no refusal, through both waits
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(refusal()).toHaveLength(0);
  expect(view.root.findAll((node) => node.type === "button" && node.children.includes("It's me"))).toHaveLength(0);
});

it.each([
  ["a sign-out and a sign-in to the same account after the refusal", "after"],
  ["a new sign-in that began while the request still waited", "during"],
] as const)("T53: an It's me refusal belongs to its sign-in: %s shows none", async (_name, when) => {
  const { session, store, button, refusal } = await setupItsMe();
  const signInAgain = async () => {
    await store.set("session", { ...session, refresh_token: "refresh-2", sign_in_id: "a-later-sign-in" });
    window.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
  };
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  if (when === "during") await act(async () => { await signInAgain(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  if (when === "after") {
    expect(refusal()).toHaveLength(1);
    await act(async () => { await signInAgain(); });
  }
  expect(refusal()).toHaveLength(0);
});

it("S2P-6: a refusal goes with its notice even while another PC is shown: the same id opened again shows none", async () => {
  const { desk, admission, select, button, refusal } = await setupItsMe();
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(refusal()).toHaveLength(1);
  await select("lab");
  // decided on Desk while Lab is shown, then the same notice id opened there again
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  await select("local");
  expect(refusal()).toHaveLength(0);
});

it("S2P-6: an It's me still out when its notice closes records no refusal, also once the same id opens again", async () => {
  const { desk, admission, select, button, refusal } = await setupItsMe();
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await select("lab");
  // closed on Desk and opened again while the answer was still out, then its last wait ends
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await select("local");
  expect(refusal()).toHaveLength(0);
});

it("S2P-7: reopening offscreen releases the old press without letting it unlock the new press", async () => {
  const { desk, lab, admission, select, button, view, answers } = await setupItsMe();
  const answer = { type: "notice-answer", id: admission.id, answer: "its_me" };
  await act(async () => { button().props.onClick(); });
  expect(answers()).toEqual([answer]);
  await act(async () => { jest.advanceTimersByTime(1_000); });
  await select("lab");
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  await select("local");
  expect(button().props.disabled).toBe(false);
  await act(async () => { button().props.onClick(); });
  expect(answers()).toEqual([answer, answer]);

  // Only the first press's deadline has passed. The second press still owns the lock.
  await act(async () => { jest.advanceTimersByTime(4_000); });
  expect(button().props.disabled).toBe(true);
  expect(answers()).toEqual([answer, answer]);
  expect(answers(lab)).toEqual([]);
  const confirmation = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
  await act(async () => { desk.read({ type: "device-notice", notice: confirmation }); });
  expect(view.root.findAllByProps({ "data-testid": "device-notice" })).toHaveLength(0);
});

it("S2P-7: a closed press sends no retry, even after its notice reopens", async () => {
  const { desk, admission, button, answers } = await setupItsMe();
  await act(async () => { button().props.onClick(); });
  expect(answers()).toHaveLength(1);
  await act(async () => { desk.read({ type: "device-notice", notice: { ...admission, open: false } }); });
  await act(async () => { desk.read({ type: "device-notice", notice: admission }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(1);
});

it.each([
  ["S2P-8: a close and reopen in one render batch drops the old refusal", "batched", "a".repeat(32)],
  ["S2P-L3: closing a notice with a colon in its ID drops only that notice's refusal", "separate", "admission:phone"],
] as const)("%s", async (_title, delivery, id) => {
  const { desk, lab, admission, select, button, refusal } = await setupItsMe({ admission: deviceNotice({ id, row: "new-phone" }) });
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(refusal()).toHaveLength(1);
  await select("lab");
  expect(button().props.disabled).toBe(false);
  if (delivery === "separate") {
    await act(async () => { button().props.onClick(); });
    expect(button().props.disabled).toBe(true);
  }
  const close = () => desk.read({ type: "device-notice", notice: { ...admission, open: false } });
  const reopen = () => desk.read({ type: "device-notice", notice: admission });
  if (delivery === "batched") {
    await act(async () => { close(); reopen(); });
  } else {
    await act(async () => { close(); });
    await act(async () => { reopen(); });
    expect(button().props.disabled).toBe(true);
    const confirmation = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
    await act(async () => { lab.read({ type: "device-notice", notice: confirmation }); });
  }
  await select("local");
  expect(refusal()).toHaveLength(0);
  expect(button().props.disabled).toBe(false);
});

it("S2P-9, T53: replacing the sign-in ID before the first timeout prevents a resend with the same refresh token", async () => {
  const { session, store, button, refusal, answers } = await setupItsMe();
  await act(async () => { button().props.onClick(); });
  expect(answers()).toHaveLength(1);
  await act(async () => { await store.set("session", { ...session, sign_in_id: "a-later-sign-in" }); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(1);
  expect(button().props.disabled).toBe(false);
  expect(refusal()).toHaveLength(0);
});

it.each([
  ["a different sign-in ID with the same refresh token", { ...itsMeSession }, { ...itsMeSession, sign_in_id: "a-later-sign-in" }, 2],
  ["neither a sign-in ID nor a refresh token", {
    service: itsMeSession.service, account: itsMeSession.account, provider: itsMeSession.provider, access_token: "access", refresh_token: "",
  }, undefined, 1],
] as const)("S2P-L2, S2P-9: records no refusal for %s", async (_name, initial, replacement, sent) => {
  const expires_at = Date.now() + 60_000;
  const { session, store, button, refusal, answers } = await setupItsMe({ session: { ...initial, expires_at } });
  await act(async () => { button().props.onClick(); });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(answers()).toHaveLength(sent);
  if (replacement !== undefined) await act(async () => {
    await store.set("session", { ...replacement, expires_at });
    window.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
  });
  await act(async () => { jest.advanceTimersByTime(5_000); });
  expect(button().props.disabled).toBe(false);
  if (replacement !== undefined) await act(async () => {
    await store.set("session", session);
    window.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
  });
  expect(refusal()).toHaveLength(0);
});


async function notMePage(options: { service: (record: BlockRecord) => Response | Promise<Response>; capable?: boolean; holdStore?: Promise<void>; failStore?: boolean; token?: () => Response | Promise<Response>; drawn?: boolean }) {
  // with a token answer, the access token is due for a refresh at the press
  const session = { account: "acct", provider: "github", service: "https://account.example", sign_in_id: "test", access_token: "access", refresh_token: "refresh", expires_at: options.token === undefined ? Date.now() + 3600_000 : Date.now() } as const;
  const notice = deviceNotice({ key: (await newKey()).public_spki });
  const wire = new DeviceNoticeWire("ws://localhost/ws");
  const events = new EventTarget();
  const store = memoryAccountStore();
  await store.set("session", session);
  await store.set("signin_key", { account: session.account, sign_in_id: session.sign_in_id, no: 1, key: await newKey() });
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" as "visible" | "hidden", hasFocus: () => true, querySelector: () => null, documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } } });
  const replaced = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: Object.assign(events, { location: new URL("http://localhost/"), setTimeout, clearTimeout, setInterval, clearInterval }),
    document: page,
    navigator: { languages: ["en"] },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    WebSocket: noticeSockets(wire),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    replaced.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  const order: string[] = [];
  const spies = [
    spyOn(indexedAccountStore, "get").mockImplementation(store.get),
    spyOn(indexedAccountStore, "update").mockImplementation(store.update),
    spyOn(indexedAccountStore, "updateMany").mockImplementation(async (names, change) => {
      const keeping = (names as readonly string[]).includes("unsent_blocks");
      if (keeping && options.failStore === true) throw new DOMException("full", "QuotaExceededError");
      if (keeping && options.holdStore !== undefined) await options.holdStore;
      await store.updateMany(names, change);
      if (keeping) order.push("stored");
    }),
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      if (url === `${session.service}/v1/pcs`) return Response.json({ pcs: [] });
      if (url === `${session.service}/v1/token` && options.token !== undefined) { order.push("token"); return options.token(); }
      expect(url).toBe(`${session.service}/v1/safety-records`);
      const record = parseSafetyRecord(JSON.parse(String(init?.body)).record) as BlockRecord;
      order.push(`service ${record.id}`);
      return options.service(record);
    }, { preconnect: fetch.preconnect })),
    spyOn(wire, "send").mockImplementation((message) => {
      DeviceNoticeWire.prototype.send.call(wire, message);
      const outgoing = JSON.parse(message);
      if (outgoing.type !== "notice-answer") return;
      const record = parseSafetyRecord(outgoing.blocks[0]);
      order.push(`pc ${record.id}`);
      wire.read({ type: "notice-answer-result", id: notice.id, receipts: [{ outcome: "applied", id: record.id, n: 2 }] });
    }),
  ];
  const machines: readonly Machine[] = [{ id: LOCAL_MACHINE, name: "Desk", kind: "local", enabled: true, state: "connected", error: null, snapshot: null }];
  let renderer: ReactTestRenderer | undefined;
  let registry: MachineSessionRegistry | undefined;
  let live: HerdrSocket | undefined;
  const mount = async () => {
    const socket = new HerdrSocket(wire.url);
    live = socket;
    registry = new MachineSessionRegistry(() => new MachineSession(LOCAL_MACHINE, { socket }));
    const sessions = registry;
    // drawn: false is the App behind its access gate, which runs the hook but draws none of it
    function Probe() {
      const drawn = useAccountDeviceNotices({ machines, machineSessions: sessions, selectedMachineId: LOCAL_MACHINE, pageServerId: "a".repeat(32) });
      return options.drawn === false ? null : drawn;
    }
    sessions.get(LOCAL_MACHINE);
    await act(async () => { renderer = create(<SettingsProvider><Probe /></SettingsProvider>); });
    socket.connect();
    wire.readyState = 0;
    await act(async () => { wire.open(); if (options.capable === false) wire.snapshot([]); else wire.snapshot(); });
  };
  const unmount = async () => {
    await act(async () => { renderer?.unmount(); });
    registry?.closeAll();
  };
  const root = () => { if (renderer === undefined) throw new TypeError("Missing notice view"); return renderer.root; };
  const button = (label: string) => root().findAllByType("button").find((node) => node.children.includes(label));
  const restore = async () => {
    await unmount();
    for (const spy of spies) spy.mockRestore();
    for (const [key, descriptor] of replaced) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { store, session, notice, wire, events, page, order, socket: () => live, mount, unmount, root, button, restore, setCapable: (on: boolean) => { options.capable = on; } };
}

it("S32-1, T51: the signed block is stored before it goes to any PC or the service; a reload sends it again with the same id", async () => {
  const stored = Promise.withResolvers<void>();
  let answer = 503;
  const page = await notMePage({ holdStore: stored.promise, service: (record) => answer === 200 ? Response.json({ id: record.id }) : new Response(null, { status: answer }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    const notMe = page.button("Not me");
    if (notMe === undefined) throw new TypeError("Missing Not me button");
    let pressed: Promise<void> | undefined;
    await act(async () => { pressed = notMe.props.onClick(); });
    expect(page.order).toEqual([]);
    await act(async () => { stored.resolve(); await pressed; });
    expect(page.order[0]).toBe("stored");
    const id = page.order.find((step) => step.startsWith("service "))?.slice("service ".length);
    expect(page.order.filter((step) => step.startsWith("pc ") || step.startsWith("service ")).every((step) => step.endsWith(id ?? "?"))).toBe(true);
    await page.unmount();
    answer = 200;
    await page.mount();
    expect(page.order.filter((step) => step === `service ${id}`)).toHaveLength(2);
    expect(await page.store.get("unsent_blocks")).toBeUndefined();
  } finally { await page.restore(); }
});

it("S32-1: while no PC here offers the account release, a reload sends nothing and keeps the queue", async () => {
  const page = await notMePage({ service: () => new Response(null, { status: 503 }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    const before = page.order.length;
    await page.unmount();
    page.setCapable(false);
    await page.mount();
    expect(page.order.slice(before).filter((step) => step.startsWith("service "))).toEqual([]);
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toHaveLength(1);
  } finally { await page.restore(); }
});

it("S32-1: signing out takes the unsent line and its Try again away", async () => {
  const page = await notMePage({ service: () => new Response(null, { status: 503 }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    await page.unmount();
    await page.mount();
    expect(page.button("Try again")).toBeDefined();
    await act(async () => { page.events.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT)); });
    expect(page.button("Try again")).toBeUndefined();
  } finally { await page.restore(); }
});

it("S32-1: a final refusal from the service shows the line with no Try again, and leaves the queue only when its owner presses OK", async () => {
  const page = await notMePage({ service: () => Response.json({ error: { code: "signer_not_older", message: "x" } }, { status: 403 }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(1);
    expect(page.button("Try again")).toBeUndefined();
    expect(Object.values(await page.store.get("unsent_blocks") ?? {}).map((entry) => entry.refused)).toEqual([true]);
    await act(async () => { await page.button("OK")!.props.onClick(); });
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
    expect(await page.store.get("unsent_blocks")).toBeUndefined();
  } finally { await page.restore(); }
});

it("S32-1: a refused token refresh is no refusal of the block: it stays stored and Try again stays", async () => {
  const page = await notMePage({ token: () => Response.json({ error: { code: "forbidden", message: "x" } }, { status: 403 }), service: (record) => Response.json({ id: record.id }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    expect(page.order.filter((step) => step.startsWith("service "))).toEqual([]);
    expect(page.order).toContain("token");
    expect(page.button("Try again")).toBeDefined();
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toHaveLength(1);
  } finally { await page.restore(); }
});

it("S32-1: a final refusal answered after a sign-out is shown at the next sign-in to that account, and leaves only on its OK", async () => {
  let first = true;
  const held = Promise.withResolvers<Response>();
  const page = await notMePage({ service: () => { if (first) { first = false; return new Response(null, { status: 503 }); } return held.promise; } });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    await page.unmount();
    await page.mount();
    await act(async () => {
      await page.store.set("session", undefined);
      page.events.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
    });
    await act(async () => { held.resolve(Response.json({ error: { code: "signer_not_older", message: "x" } }, { status: 403 })); await held.promise; });
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
    expect(Object.values(await page.store.get("unsent_blocks") ?? {}).map((entry) => entry.refused)).toEqual([true]);
    await act(async () => {
      await page.store.set("session", { ...page.session, sign_in_id: "a-later-sign-in" });
      page.events.dispatchEvent(new Event(ACCOUNT_SESSION_EVENT));
    });
    await act(async () => {});
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(1);
    expect(page.button("Try again")).toBeUndefined();
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toHaveLength(1);
    await act(async () => { await page.button("OK")!.props.onClick(); });
    expect(await page.store.get("unsent_blocks")).toBeUndefined();
  } finally { await page.restore(); }
});

it("S32-1: a final refusal the page never draws (the App behind its access gate) stays in the store", async () => {
  const page = await notMePage({ drawn: false, service: () => Response.json({ error: { code: "signer_not_older", message: "x" } }, { status: 403 }) });
  try {
    await page.store.set("unsent_blocks", { r1: { account: page.session.account, sign_in_id: page.session.sign_in_id, records: [{ id: "r1" } as unknown as BlockRecord], refused: true } });
    await page.mount();
    await act(async () => {});
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toEqual(["r1"]);
  } finally { await page.restore(); }
});

it("S32-1: a final refusal drawn on a seen page stays queued until its owner presses OK", async () => {
  const page = await notMePage({ service: () => Response.json({ error: { code: "signer_not_older", message: "x" } }, { status: 403 }) });
  try {
    await page.store.set("unsent_blocks", { r1: { account: page.session.account, sign_in_id: page.session.sign_in_id, records: [{ id: "r1" } as unknown as BlockRecord], refused: true } });
    await page.mount();
    await act(async () => {});
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(1);
    await act(async () => { page.page.dispatchEvent(new Event("visibilitychange")); });
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toEqual(["r1"]);
    await act(async () => { await page.button("OK")!.props.onClick(); });
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
    expect(await page.store.get("unsent_blocks")).toBeUndefined();
  } finally { await page.restore(); }
});

it("S32-1: Try again asks again right before the record goes out, after a token refresh", async () => {
  const fresh = () => Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 3600, account: "acct", provider: "github" });
  let hold: { asked: ReturnType<typeof Promise.withResolvers<void>>; answer: ReturnType<typeof Promise.withResolvers<Response>> } | undefined;
  const page = await notMePage({
    service: () => new Response(null, { status: 503 }),
    token: () => { if (hold === undefined) return fresh(); hold.asked.resolve(); return hold.answer.promise; },
  });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    const retry = page.button("Try again");
    if (retry === undefined) throw new TypeError("Missing account retry");
    await page.store.update("session", (current) => current === undefined ? undefined : { ...current, expires_at: Date.now() });
    const posts = page.order.filter((step) => step.startsWith("service ")).length;
    const held = { asked: Promise.withResolvers<void>(), answer: Promise.withResolvers<Response>() };
    hold = held;
    await act(async () => {
      const pressed = retry.props.onClick();
      await held.asked.promise;
      // the release goes while the refresh is out
      page.wire.snapshot([]);
      held.answer.resolve(fresh());
      await pressed;
    });
    expect(page.order.filter((step) => step.startsWith("service "))).toHaveLength(posts);
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toHaveLength(1);
  } finally { await page.restore(); }
});

it("S32-1: a sign-in again to the same account on the open page sends the waiting block, with the same id", async () => {
  let answer = 503;
  const page = await notMePage({ service: (record) => answer === 200 ? Response.json({ id: record.id }) : new Response(null, { status: answer }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    const id = page.order.find((step) => step.startsWith("service "))?.slice("service ".length);
    await act(async () => {
      await page.store.set("session", undefined);
      page.events.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
    });
    answer = 200;
    await act(async () => {
      await page.store.set("session", { ...page.session, sign_in_id: "a-later-sign-in" });
      page.events.dispatchEvent(new Event(ACCOUNT_SESSION_EVENT));
    });
    await act(async () => {});
    expect(page.order.filter((step) => step === `service ${id}`)).toHaveLength(2);
    expect(await page.store.get("unsent_blocks")).toBeUndefined();
  } finally { await page.restore(); }
});

it("S32-1: another account signed in on the open page (no sign-out event: its sign-in simply ended) never sees the waiting line", async () => {
  const page = await notMePage({ service: () => new Response(null, { status: 503 }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    await page.unmount();
    await page.mount();
    expect(page.button("Try again")).toBeDefined();
    await act(async () => {
      await page.store.set("session", { ...page.session, account: "another-account", sign_in_id: "b" });
      page.events.dispatchEvent(new Event(ACCOUNT_SESSION_EVENT));
    });
    await act(async () => {});
    expect(page.button("Try again")).toBeUndefined();
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
  } finally { await page.restore(); }
});

it("S32-1: Try again on the press's own line sends nothing once no PC offers the account release", async () => {
  const page = await notMePage({ service: () => new Response(null, { status: 503 }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    const retry = page.button("Try again");
    if (retry === undefined) throw new TypeError("Missing account retry");
    const posts = page.order.filter((step) => step.startsWith("service ")).length;
    await act(async () => { page.wire.snapshot([]); });
    await act(async () => { await retry.props.onClick(); });
    expect(page.order.filter((step) => step.startsWith("service "))).toHaveLength(posts);
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toHaveLength(1);
  } finally { await page.restore(); }
});

it("S32-1: a final refusal met on an in-session Try again keeps the line once, with no Try again", async () => {
  let answer: Response = new Response(null, { status: 503 });
  const page = await notMePage({ service: () => answer });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    const retry = page.button("Try again");
    if (retry === undefined) throw new TypeError("Missing account retry");
    answer = Response.json({ error: { code: "signer_not_older", message: "x" } }, { status: 403 });
    await act(async () => { await retry.props.onClick(); });
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(1);
    expect(page.button("Try again")).toBeUndefined();
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toHaveLength(1);
    await act(async () => { await page.button("OK")!.props.onClick(); });
    expect(await page.store.get("unsent_blocks")).toBeUndefined();
  } finally { await page.restore(); }
});

it("S32-1: once the PC withdrew the account release, Try again sends nothing, also after the PC disconnects", async () => {
  const page = await notMePage({ service: () => new Response(null, { status: 503 }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    const retry = page.button("Try again");
    if (retry === undefined) throw new TypeError("Missing account retry");
    const posts = page.order.filter((step) => step.startsWith("service ")).length;
    await act(async () => { page.wire.snapshot([]); });
    await act(async () => { page.wire.close(); });
    await act(async () => { await retry.props.onClick(); });
    expect(page.order.filter((step) => step.startsWith("service "))).toHaveLength(posts);
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toHaveLength(1);
  } finally { await page.restore(); }
});

it("S32-1: an explicit withdrawal holds through a reconnect that has listed nothing yet", async () => {
  const page = await notMePage({ service: () => new Response(null, { status: 503 }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    const retry = page.button("Try again");
    if (retry === undefined) throw new TypeError("Missing account retry");
    const posts = page.order.filter((step) => step.startsWith("service ")).length;
    await act(async () => { page.wire.snapshot([]); });
    await act(async () => { page.wire.close(); });
    // back, with no feature list yet
    await act(async () => { page.socket()?.connect(); page.wire.readyState = 0; page.wire.open(); });
    await act(async () => { await retry.props.onClick(); });
    expect(page.order.filter((step) => step.startsWith("service "))).toHaveLength(posts);
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toHaveLength(1);
  } finally { await page.restore(); }
});

it("S32-2 (kept): an earlier sign-in's unsent block is not dropped by this sign-in's load", async () => {
  const page = await notMePage({ service: (record) => Response.json({ id: record.id }) });
  try {
    await page.store.set("unsent_blocks", { old: { account: page.session.account, sign_in_id: "earlier", records: [{ id: "old" } as unknown as BlockRecord] } });
    await page.mount();
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toEqual(["old"]);
  } finally { await page.restore(); }
});

it("S32-1: a block this browser could not store is not sent: it says so and offers Try again", async () => {
  const page = await notMePage({ failStore: true, service: (record) => Response.json({ id: record.id }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    expect(page.order.filter((step) => step.startsWith("pc ") || step.startsWith("service "))).toEqual([]);
    expect(page.root().findAll((node) => node.type === "p" && node.children.join("").includes("The block was not sent. Try again."))).toHaveLength(1);
    expect(page.button("Try again")).toBeDefined();
  } finally { await page.restore(); }
});

it("S32-1: a replay that answers after sign-out brings no line and no entry back", async () => {
  let answer = Promise.withResolvers<Response>();
  let first = true;
  const page = await notMePage({ service: () => { if (first) { first = false; return new Response(null, { status: 503 }); } return answer.promise; } });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    await page.unmount();
    await page.mount();
    await act(async () => {
      await page.store.set("session", undefined);
      await page.store.set("unsent_blocks", undefined);
      page.events.dispatchEvent(new Event(ACCOUNT_SIGN_OUT_EVENT));
    });
    await act(async () => { answer.resolve(new Response(null, { status: 503 })); await answer.promise; });
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
    expect(await page.store.get("unsent_blocks")).toBeUndefined();
    answer = Promise.withResolvers<Response>();
  } finally { await page.restore(); }
});

it("S32-1: a final refusal on a Try again after the notice was dismissed is still said once", async () => {
  let status = 503;
  const page = await notMePage({ service: () => Response.json({ error: { code: status === 403 ? "signer_not_older" : "unavailable", message: "x" } }, { status }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    await act(async () => { page.root().findByProps({ "aria-label": "Dismiss" }).props.onClick(); });
    status = 403;
    await act(async () => { await page.button("Try again")!.props.onClick(); });
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(1);
    expect(page.button("Try again")).toBeUndefined();
  } finally { await page.restore(); }
});

it("S32-1: when the PC stops offering the account release, the unsent line and its Try again go", async () => {
  const page = await notMePage({ service: () => new Response(null, { status: 503 }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    await page.unmount();
    await page.mount();
    expect(page.button("Try again")).toBeDefined();
    await act(async () => { page.wire.snapshot([]); });
    expect(page.button("Try again")).toBeUndefined();
    expect(page.root().findAllByProps({ "data-account-delivery": "failed" })).toHaveLength(0);
  } finally { await page.restore(); }
});

it.each([
  ["a later sign-in to the same account sends it again with the same id", "same", 2],
  ["another account signed in on this browser never sends it", "other", 1],
] as const)("S32-1: after a sign-out, %s", async (_name, who, posts) => {
  let answer = 503;
  const page = await notMePage({ service: (record) => answer === 200 ? Response.json({ id: record.id }) : new Response(null, { status: answer }) });
  try {
    await page.mount();
    await act(async () => { page.wire.read({ type: "device-notice", notice: page.notice }); });
    await act(async () => { await page.button("Not me")!.props.onClick(); });
    const id = page.order.find((step) => step.startsWith("service "))?.slice("service ".length);
    await page.unmount();
    const before = (await page.store.get("session"))!;
    await new AccountService({ store: page.store, fetch: (async () => Response.json({})) as unknown as typeof fetch }).signOut();
    await page.store.set("session", { ...before, sign_in_id: "a-later-sign-in", ...(who === "other" ? { account: "another-account" } : {}) });
    answer = 200;
    await page.mount();
    expect(page.order.filter((step) => step === `service ${id}`)).toHaveLength(posts);
    expect(Object.keys(await page.store.get("unsent_blocks") ?? {})).toEqual(who === "same" ? [] : [id ?? "?"]);
  } finally { await page.restore(); }
});
