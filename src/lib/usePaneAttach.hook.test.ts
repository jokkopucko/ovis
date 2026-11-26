import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import type { GhosttyTerminal } from "./ghostty/terminal.ts";
import { fontSettled } from "./fontFamily.ts";
import { openPage, type Page } from "./page.fixture.ts";
import { usePaneAttach, type PaneAttachDeps } from "./usePaneAttach.ts";
import { useTerminalRefits, type TerminalRefitsDeps } from "./useTerminalRefits.ts";
import { HerdrSocket } from "./ws.ts";

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = FakeSocket.CONNECTING;
  readonly sent: { type: string; [key: string]: unknown }[] = [];
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly url: string) { FakeSocket.last = this; }
  addEventListener(type: string, listener: (event: unknown) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
  send(data: string): void { this.sent.push(JSON.parse(data)); }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = FakeSocket.OPEN; for (const listener of this.listeners.get("open") ?? []) listener({}); }
}

const BEFORE = "w1:p1";
const AFTER = "w1:p2";
const COLORS = {} as TerminalRefitsDeps["colors"];

describe("usePaneAttach with the inbox mode's list over the pane", () => {
  let savedSocket: PropertyDescriptor | undefined;
  let page: Page;
  let client: HerdrSocket;
  let socket: FakeSocket;
  const termRef: RefObject<GhosttyTerminal | null> = { current: null };
  const paneRef: RefObject<string | null> = { current: BEFORE };
  const coveredRef: RefObject<boolean> = { current: false };
  const releasedRef: RefObject<boolean> = { current: false };
  const cachedRef: RefObject<boolean> = { current: false };
  let presentations = 0;
  const presentationRef: RefObject<() => void> = { current: () => { presentations += 1; } };

  beforeEach(() => {
    releasedRef.current = false;
    cachedRef.current = false;
    presentations = 0;
    page = openPage();
    savedSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
    // the page in use: an attach sizes the pty unless it says keep_size
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    Object.defineProperty(page.window.document, "hasFocus", { configurable: true, value: () => true });
    termRef.current = null;
    client = new HerdrSocket("ws://test/ws");
    client.connect();
    socket = FakeSocket.last;
    socket.open();
    client.attach(BEFORE, 100, 30);
  });

  afterEach(async () => {
    await page.render(null);
    client.close();
    await page.close();
    if (savedSocket) Object.defineProperty(globalThis, "WebSocket", savedSocket);
    else Reflect.deleteProperty(globalThis, "WebSocket");
  });

  const ref = <T,>(current: T): RefObject<T> => ({ current });
  const nothing = (): void => {};
  const settled = fontSettled();
  settled.settle();
  function Probe({ paneId, covered, mirrored = false, presented = false, cached = false }: { paneId: string; covered: boolean; mirrored?: boolean | null; presented?: boolean; cached?: boolean }) {
    paneRef.current = paneId;
    coveredRef.current = covered;
    const shared = { activeRef: ref(false), autoSelected: false, coarseRef: ref(false), findOpenRef: ref(false), fitRef: ref(null), fittedRef: ref(nothing), fixedGridRef: ref(false), followCursorRef: ref(nothing), keyboardHoldsRef: ref(() => false), observeRef: ref(false), sharedGridRef: ref(null), socketRef: ref(client), termRef, chatViewRef: ref(false), fontSettledRef: ref(settled) };
    useTerminalRefits({
      ...shared, baseFontRef: ref(13), pinchingRef: ref(false), chatView: false, covered, follow: false, narrowFont: false, narrowFontFitted: ref(false),
      colors: COLORS, paneRef, peekRef: ref(null), shown: true, sizesPty: () => !coveredRef.current, terminalFontFamily: "", terminalFontSize: 13,
    });
    const attach: PaneAttachDeps = {
      ...shared, cached, watched: false, coveredRef, deferAttachRef: ref(() => false), draftPaneRef: ref(null), frameGateRef: ref({ reset: nothing }),
      hyperlinksRef: ref({ reset: nothing }), hostRef: ref(null), machineId: "local", mirrored, modifyOtherKeysRef: ref(0), paneId, pending: [], presented,
      presentationRef, releaseRef: ref(nothing), releasedRef, retireOutputRef: ref(nothing), secretRef: ref(null), setDraft: nothing,
      setComposing: nothing, setEnded: nothing, setHeld: nothing, setInputError: nothing, setInputReady: nothing, setOutputError: nothing, setOutputReady: nothing,
      setReleased: nothing, setSecret: nothing, setUnsupported: nothing, setWatching: nothing, stalledRef: ref(false), terminalId: null, cancelLeaveRef: ref(nothing),
      cachedRef, watchingRef: ref(false), followRef: ref(false), leaveRef: ref(nothing), shownRef: ref(true), typeAheadRef: ref(nothing),
    };
    usePaneAttach(attach);
    return null;
  }
  const draw = async (props: { paneId: string; covered: boolean; mirrored?: boolean | null; presented?: boolean; cached?: boolean }): Promise<void> => {
    await page.render(createElement(Probe, props));
  };
  const sizing = (from: number) => socket.sent.slice(from).filter((frame) => ["attach", "resize", "release-size"].includes(frame.type));
  const layOut = (): void => { termRef.current = { cols: 100, rows: 30, options: {}, reset: nothing } as unknown as GhosttyTerminal; };

  it("attaches a pane that comes to the slot under the list keeping the pty's size, and asks for its grid once as it is shown", async () => {
    await draw({ paneId: BEFORE, covered: false });
    layOut();
    await draw({ paneId: BEFORE, covered: true });
    const from = socket.sent.length;
    await draw({ paneId: AFTER, covered: true });
    expect(sizing(from)).toEqual([{ type: "attach", pane_id: AFTER, cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true, windows_fit: true }]);
    const shown = socket.sent.length;
    await draw({ paneId: AFTER, covered: false });
    expect(sizing(shown)).toEqual([{ type: "resize", pane_id: AFTER, cols: 100, rows: 30 }]);
  });

  it("attaches a pane that comes to the slot with no list over it sizing the pty, as before", async () => {
    await draw({ paneId: BEFORE, covered: false });
    layOut();
    const from = socket.sent.length;
    await draw({ paneId: AFTER, covered: false });
    expect(sizing(from)).toEqual([{ type: "attach", pane_id: AFTER, cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String), windows_fit: true }]);
  });

  describe("how the pane is presented", () => {
    const shown = { paneId: BEFORE, covered: false, presented: true };

    it("is not decided again for a pane in use that only learns whether herdr can attach", async () => {
      await draw({ ...shown, mirrored: null });
      expect(presentations).toBe(1);
      await draw({ ...shown, mirrored: false });
      await draw({ ...shown, mirrored: true });
      expect(presentations).toBe(1);
    });

    it("is decided again when a pane that let go of its size, or a cached one, learns it", async () => {
      await draw({ ...shown, mirrored: null });
      releasedRef.current = true;
      await draw({ ...shown, mirrored: false });
      expect(presentations).toBe(2);
      releasedRef.current = false;
      cachedRef.current = true;
      await draw({ ...shown, mirrored: true });
      expect(presentations).toBe(3);
    });

    it("is decided once when the pane is presented, put in the cache or taken out, with or without that answer in the same render", async () => {
      await draw({ paneId: BEFORE, covered: false, presented: false, mirrored: null });
      await draw({ ...shown, mirrored: false });
      expect(presentations).toBe(2);
      await draw({ ...shown, mirrored: false, cached: true });
      expect(presentations).toBe(3);
      await draw({ ...shown, mirrored: null, cached: false });
      expect(presentations).toBe(4);
      await draw({ ...shown, mirrored: null, cached: false });
      expect(presentations).toBe(4);
    });
  });
});
