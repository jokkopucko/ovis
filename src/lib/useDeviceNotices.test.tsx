import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, useEffect } from "react";

import { DeviceNotices } from "../components/DevicePairedNotice.tsx";
import type { DeviceNotice, NoticeAnswer, NoticeSeen } from "../../shared/account-devices-api.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { DEVICE_NOTICE_FEATURE, DeviceNoticeWire, deviceNotice } from "./deviceNoticeWire.fixture.ts";
import { openPage, type Page } from "./page.fixture.ts";
import { SettingsProvider } from "./settings.ts";
import { useDeviceNotices, type NoticeSocket } from "./useDeviceNotices.ts";
import { HerdrSocket } from "./ws.ts";

const notice = (seq: number, open = true): DeviceNotice => ({
  seq, id: seq.toString(16).padStart(32, "0"), at: "2026-11-20T04:00:00.000Z", kind: open ? "admit" : "method", how: "list", key: "k".repeat(43), no: 4,
  row: "r1", label: "Galaxy S30", by: null, account: "acct", open, method: "github", two_step: "set",
});

describe("device notices on the real PC socket", () => {
  let page: Page;
  let webSocket: PropertyDescriptor | undefined;
  const sockets: HerdrSocket[] = [];
  let result: ReturnType<typeof useDeviceNotices> | undefined;

  function Probe({ socket, visible = true }: { socket: HerdrSocket; visible?: boolean }) {
    result = useDeviceNotices([{ id: "desk", socket }], "desk");
    return visible ? <SettingsProvider><DeviceNotices pc="Desk" notices={result.byPc.get("desk")?.notices ?? []}
      onDismiss={(item) => result?.dismiss("desk", item)} onShown={result.acknowledgeShown} /></SettingsProvider> : null;
  }

  beforeEach(() => {
    page = openPage();
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(page.window.navigator, "languages", { configurable: true, value: ["en"] });
    webSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  });

  async function connect(visible = true) {
    const wire = new DeviceNoticeWire("ws://localhost/ws");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class { constructor() { return wire; } } });
    const socket = new HerdrSocket(wire.url);
    sockets.push(socket);
    await page.render(<Probe socket={socket} visible={visible} />);
    socket.connect();
    wire.open();
    return { wire, socket };
  }

  afterEach(async () => {
    await page.render(null);
    result = undefined;
    for (const socket of sockets.splice(0)) socket.close();
    if (webSocket) Object.defineProperty(globalThis, "WebSocket", webSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
    await page.close();
  });

  const hintLines = (card: Element) => [...card.querySelectorAll('[class="settings-hint"]')]
    .flatMap((line) => [...line.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent ?? ""));

  it("a notice with two-step missing, unknown, null or unrecognised says how it signed in and nothing of two-step (T57)", async () => {
    const { wire } = await connect();
    await act(async () => {
      wire.snapshot();
      for (const [index, twoStep] of [undefined, "unknown", null, "bogus"].entries()) {
        // JSON omits undefined; both it and the unknown string enter through the PC socket decoder.
        const seq = index + 1;
        const payload = { ...notice(seq), label: `Phone ${seq}`, method: "google", two_step: twoStep };
        wire.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "device-notice", notice: payload }) }));
      }
    });
    const rendered = page.container.querySelectorAll('[data-testid="device-notice"]');
    expect(rendered).toHaveLength(4);
    for (const card of rendered) {
      const lines = hintLines(card);
      expect(lines.filter((line) => line.startsWith("Google sign-in"))).toEqual(["Google sign-in"]);
      expect(lines.filter((line) => line.toLowerCase().includes("two-step"))).toEqual([]);
    }
  });

  it("a list admission without a sign-in method speaks of two-step only when the account has it set (T34, T57)", async () => {
    const { wire } = await connect();
    const twoStepValues = ["unknown", null, "set", "verified", undefined, "bogus"] as const;
    await act(async () => {
      wire.snapshot();
      for (const [index, two_step] of twoStepValues.entries()) {
        const payload = { ...notice(index + 1), label: `Phone ${index + 1}`, method: null, two_step };
        wire.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "device-notice", notice: payload }) }));
      }
    });
    const rendered = [...page.container.querySelectorAll('[data-testid="device-notice"]')];
    expect(rendered).toHaveLength(twoStepValues.length);
    const labels = rendered.map((card) => hintLines(card).filter((line) => line.toLowerCase().includes("two-step sign-in")));
    expect(labels).toEqual([[], [], ["Two-step sign-in set on the account"], [], [], []]);
  });

  const cards = () => result?.byPc.get("desk")?.notices ?? [];
  const method = deviceNotice({ id: "b".repeat(32), seq: 2, kind: "method", open: false });

  it("T57, P15: a later decision replaces the open admission and makes it dismissible", async () => {
    const { wire } = await connect();
    const admission = deviceNotice({ row: "row-1" });
    const decided = { ...admission, open: false };
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice: admission }); });
    await act(async () => { wire.read({ type: "device-notice", notice: decided }); });
    expect(cards()).toEqual([decided]);
    await act(async () => { result?.dismiss("desk", decided); });
    expect(cards()).toEqual([]);
  });

  it("T57, P15: an acknowledged admission survives a reconnect that omits it", async () => {
    const { wire, socket } = await connect();
    const admission = deviceNotice();
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice: admission }); });
    expect(wire.seen()).toEqual([{ type: "notice-seen", seq: 1 }]);
    await act(async () => { wire.close(); });
    expect(cards()).toEqual([]);

    await act(async () => { socket.connect(); wire.open(); });
    expect(cards()).toEqual([]);
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice-replay", replay: { notices: [], cut: 0 } }); });
    expect(cards()).toEqual([admission]);
    expect(wire.seen()).toEqual([{ type: "notice-seen", seq: 1 }]);

    const decided = { ...admission, open: false };
    await act(async () => { wire.read({ type: "device-notice", notice: decided }); });
    expect(cards()).toEqual([decided]);
  });

  it("T57: replay cannot resurrect a dismissed method notice, and a rowless open admission stays", async () => {
    const { wire } = await connect();
    const admission = deviceNotice();
    const replay = { type: "device-notice-replay", replay: { notices: [admission, method], cut: 0 } } as const;
    await act(async () => { wire.snapshot(); wire.read(replay); });
    await act(async () => { result?.dismiss("desk", admission); result?.dismiss("desk", method); });
    expect(cards()).toEqual([admission]);
    await act(async () => { wire.read(replay); });
    expect(cards()).toEqual([admission]);
  });

  it("T57, G5: the capability snapshot acknowledges offered replay, never a subsequent dismiss", async () => {
    const { wire, socket } = await connect();
    await act(async () => {
      wire.read({ type: "features", herdr_lifetime: "new", connection: "desk-1", features: [DEVICE_NOTICE_FEATURE] });
      wire.read({ type: "device-notice-replay", replay: { notices: [deviceNotice(), method], cut: 0 } });
    });
    expect(socket.accountOpensAll()).toBe(false);
    expect(wire.seen()).toEqual([]);
    const beforeSnapshot = cards();
    await act(async () => { wire.snapshot(); });
    const afterSnapshot = [...wire.seen()];
    const beforeDismiss = [...wire.sent];
    await act(async () => { result?.dismiss("desk", method); });
    expect({ beforeSnapshot, afterSnapshot, dismissSent: wire.sent.slice(beforeDismiss.length) }).toEqual({
      beforeSnapshot: [], afterSnapshot: [{ type: "notice-seen", seq: 2 }], dismissSent: [],
    });
    expect(cards()).toEqual([deviceNotice()]);
  });

  it("P10, T57: renders the live method received between replay and confirmation before acknowledging a later admission", async () => {
    const { wire } = await connect();
    const admission = deviceNotice({ seq: 4 });
    const earlyMethod = { ...method, seq: 5 };
    const laterAdmission = deviceNotice({ id: "c".repeat(32), seq: 6 });
    await act(async () => {
      wire.read({ type: "features", herdr_lifetime: "new", connection: "desk-1", features: [DEVICE_NOTICE_FEATURE] });
      wire.read({ type: "device-notice-replay", replay: { notices: [admission], cut: 0 } });
      wire.read({ type: "device-notice", notice: earlyMethod });
    });
    expect(wire.seen()).toEqual([]);
    await act(async () => { wire.snapshot(); });
    const confirmed = page.container.textContent ?? "";
    const ackAfterConfirmation = wire.seen();
    await act(async () => { wire.read({ type: "device-notice", notice: laterAdmission }); });
    expect({ methodRendered: confirmed.includes("A sign-in method was added"), ackAfterConfirmation, allAcks: wire.seen() }).toEqual({
      methodRendered: true, ackAfterConfirmation: [{ type: "notice-seen", seq: 5 }],
      allAcks: [{ type: "notice-seen", seq: 5 }, { type: "notice-seen", seq: 6 }],
    });
  });

  it("P10, T57: a confirmed notice is not acknowledged until its card is rendered", async () => {
    const { wire, socket } = await connect(false);
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice: method }); });
    expect(wire.seen()).toEqual([]);
    await page.render(<Probe socket={socket} />);
    expect(page.container.textContent).toContain("A sign-in method was added");
    expect(wire.seen()).toEqual([{ type: "notice-seen", seq: 2 }]);
  });

  it("G5: ignores unadvertised notice frames even if the socket later offers the feature", async () => {
    const { wire } = await connect();
    await act(async () => {
      wire.read({ type: "device-notice-replay", replay: { notices: [deviceNotice()], cut: 7 } });
      wire.snapshot([]);
      wire.read({ type: "device-notice", notice: method });
    });
    const beforeOffer = result?.byPc.has("desk");
    await act(async () => { wire.snapshot(); });
    expect({ beforeOffer, afterOffer: result?.byPc.has("desk"), acknowledged: wire.seen() }).toEqual({
      beforeOffer: false, afterOffer: false, acknowledged: [],
    });
  });

  it("G5, T57: withdrawing the capability hides cards and ignores later frames", async () => {
    const { wire } = await connect();
    await act(async () => { wire.snapshot(); wire.read({ type: "device-notice", notice: deviceNotice() }); });
    expect(cards()).toHaveLength(1);
    await act(async () => { wire.snapshot([]); });
    const withdrawn = cards();
    await act(async () => { wire.read({ type: "device-notice", notice: method }); wire.snapshot(); });
    expect({ withdrawn, restored: cards(), acknowledged: wire.seen() }).toEqual({
      withdrawn: [], restored: [deviceNotice()], acknowledged: [{ type: "notice-seen", seq: 1 }],
    });
  });

  it("P15: exposes the selected PC's trimmed replay count even with no surviving cards", async () => {
    const { wire } = await connect();
    await act(async () => {
      wire.snapshot();
      wire.read({ type: "device-notice-replay", replay: { notices: [], cut: 12 } });
    });
    expect(result).toHaveProperty("cut", 12);
    await act(async () => { wire.read({ type: "device-notice", notice: method }); });
    expect(result).toHaveProperty("cut", 12);
    await act(async () => { wire.snapshot([]); });
    expect(result).toHaveProperty("cut", 0);
  });
});

class FakeSocket implements NoticeSocket {
  readonly sent: (NoticeSeen | NoticeAnswer)[] = [];
  offers = true;
  private readonly handlers = new Set<(message: ServerMessage) => void>();
  on(handler: (message: ServerMessage) => void) { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; }
  onDisconnect() { return () => {}; }
  accountOpensAll() { return this.offers; }
  sendNotice(message: NoticeSeen | NoticeAnswer) { if (!this.offers) return false; this.sent.push(message); return true; }
  receive(message: ServerMessage) { for (const handler of this.handlers) handler(message); }
}

describe("each PC's device notices in the app", () => {
  let page: Page;
  let seen: ReturnType<typeof useDeviceNotices> | undefined;
  beforeEach(() => { page = openPage(); });
  afterEach(async () => {
    await page.close();
  });

  function Probe({ sockets, onClose }: { sockets: readonly { id: string; socket: NoticeSocket }[]; onClose?: (pcId: string, noticeId: string) => void }) {
    const current = useDeviceNotices(sockets, "desk", onClose);
    seen = current;
    const notices = current.byPc.get("desk")?.notices;
    const newest = notices?.at(-1)?.seq;
    const { acknowledgeShown } = current;
    useEffect(() => { if (newest !== undefined) acknowledgeShown(newest); }, [acknowledgeShown, newest]);
    return <>{notices?.map((item) => <p key={item.id}>{item.label}</p>)}</>;
  }

  it("T57: a PC's replay shows once and is acknowledged once, up to its newest notice", async () => {
    const desk = new FakeSocket();
    await page.render(<Probe sockets={[{ id: "desk", socket: desk }]} />);
    await act(async () => { desk.receive({ type: "device-notice-replay", replay: { notices: [notice(2), notice(3, false)], cut: 0 } }); });
    await act(async () => { desk.receive({ type: "device-notice", notice: notice(3, false) }); });
    expect(seen!.byPc.get("desk")?.notices.map((item) => item.seq)).toEqual([2, 3]);
    expect(desk.sent).toEqual([{ type: "notice-seen", seq: 3 }]);
  });

  it("S2P-9: onClose reports the PC and admission ID removed by a matching confirmation", async () => {
    const desk = new FakeSocket();
    const admission = notice(1);
    const confirmed = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
    const closed: [string, string][] = [];
    await page.render(<Probe sockets={[{ id: "desk", socket: desk }]} onClose={(pc, id) => closed.push([pc, id])} />);
    await act(async () => { desk.receive({ type: "device-notice", notice: admission }); });
    expect(closed).toEqual([]);
    await act(async () => { desk.receive({ type: "device-notice", notice: confirmed }); });
    expect(closed).toEqual([["desk", admission.id]]);
  });

  it("S2P-11: replay of It's me and its same-ID close does not bring back the admission card", async () => {
    const desk = new FakeSocket();
    const admission = notice(1);
    const confirmed = deviceNotice({ ...admission, id: "b".repeat(32), seq: 2, kind: "confirm", how: "its_me", open: false });
    const close = { ...admission, seq: 3, open: false };
    const unrelated = { ...notice(4), no: 5, open: false };
    await page.render(<Probe sockets={[{ id: "desk", socket: desk }]} />);
    await act(async () => { desk.receive({ type: "device-notice", notice: admission }); });
    await act(async () => { desk.receive({ type: "device-notice-replay", replay: { notices: [confirmed, close, unrelated], cut: 0 } }); });
    expect(seen?.byPc.get("desk")?.notices.map(item => item.id)).toEqual([confirmed.id, unrelated.id]);
  });

  it("T57: dismissing a told notice decides nothing on the PC, and an open admission stays", async () => {
    const desk = new FakeSocket();
    await page.render(<Probe sockets={[{ id: "desk", socket: desk }]} />);
    await act(async () => { desk.receive({ type: "device-notice-replay", replay: { notices: [notice(2), notice(3, false)], cut: 0 } }); });
    await act(async () => { seen!.dismiss("desk", notice(3, false)); seen!.dismiss("desk", notice(2)); });
    expect(seen!.byPc.get("desk")?.notices.map((item) => item.seq)).toEqual([2]);
    expect(desk.sent.filter((message) => message.type === "notice-answer")).toEqual([]);
  });

  it("G5: a PC that does not offer it gets no acknowledgment, and is asked again once it does", async () => {
    const desk = new FakeSocket();
    desk.offers = false;
    await page.render(<Probe sockets={[{ id: "desk", socket: desk }]} />);
    await act(async () => { desk.receive({ type: "device-notice-replay", replay: { notices: [notice(5)], cut: 0 } }); });
    expect(desk.sent).toEqual([]);
    desk.offers = true;
    await act(async () => { desk.receive({ type: "device-notice", notice: notice(6, false) }); });
    expect(desk.sent).toEqual([{ type: "notice-seen", seq: 6 }]);
  });
});
