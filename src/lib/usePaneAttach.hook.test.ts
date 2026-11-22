import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Terminal } from "@xterm/xterm";
import { fontSettled } from "./fontFamily.ts";
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
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let client: HerdrSocket;
  let socket: FakeSocket;
  const termRef: RefObject<Terminal | null> = { current: null };
  const paneRef: RefObject<string | null> = { current: BEFORE };
  const coveredRef: RefObject<boolean> = { current: false };

  beforeEach(() => {
    for (const key of ["IS_REACT_ACT_ENVIRONMENT", "WebSocket", "window", "document"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    // the page in use: an attach sizes the pty unless it says keep_size
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", hasFocus: () => true, addEventListener() {}, removeEventListener() {} } });
    termRef.current = null;
    client = new HerdrSocket("ws://test/ws");
    client.connect();
    socket = FakeSocket.last;
    socket.open();
    client.attach(BEFORE, 100, 30);
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    client.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    saved.clear();
  });

  const ref = <T,>(current: T): RefObject<T> => ({ current });
  const nothing = (): void => {};
  const settled = fontSettled();
  settled.settle();
  function Probe({ paneId, covered }: { paneId: string; covered: boolean }) {
    paneRef.current = paneId;
    coveredRef.current = covered;
    const shared = { activeRef: ref(false), autoSelected: false, coarseRef: ref(false), findOpenRef: ref(false), fitRef: ref(null), fittedRef: ref(nothing), fixedGridRef: ref(false), followCursorRef: ref(nothing), keyboardHoldsRef: ref(() => false), observeRef: ref(false), sharedGridRef: ref(null), socketRef: ref(client), termRef, chatViewRef: ref(false), fontSettledRef: ref(settled) };
    useTerminalRefits({
      ...shared, baseFontRef: ref(13), pinchingRef: ref(false), chatView: false, covered, follow: false, narrowFont: false, narrowFontFitted: ref(false),
      colors: COLORS, paneRef, peekRef: ref(null), shown: true, sizesPty: () => !coveredRef.current, terminalFontFamily: "", terminalFontSize: 13,
    });
    const attach: PaneAttachDeps = {
      ...shared, cached: false, watched: false, coveredRef, deferAttachRef: ref(() => false), draftPaneRef: ref(null), frameGateRef: ref({ reset: nothing }),
      hyperlinksRef: ref({ reset: nothing }), hostRef: ref(null), machineId: "local", mirrored: false, modifyOtherKeysRef: ref(0), paneId, pending: [], presented: false,
      presentationRef: ref(nothing), releaseRef: ref(nothing), releasedRef: ref(false), retireOutputRef: ref(nothing), secretRef: ref(null), setDraft: nothing,
      setComposing: nothing, setEnded: nothing, setHeld: nothing, setInputError: nothing, setInputReady: nothing, setOutputError: nothing, setOutputReady: nothing,
      setReleased: nothing, setSecret: nothing, setUnsupported: nothing, setWatching: nothing, stalledRef: ref(false), terminalId: null, cancelLeaveRef: ref(nothing),
      cachedRef: ref(false), watchingRef: ref(false), followRef: ref(false), leaveRef: ref(nothing), shownRef: ref(true), typeAheadRef: ref(nothing),
    };
    usePaneAttach(attach);
    return null;
  }
  const draw = async (props: { paneId: string; covered: boolean }): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, props));
      else renderer = create(createElement(Probe, props));
    });
  };
  const sizing = (from: number) => socket.sent.slice(from).filter((frame) => ["attach", "resize", "release-size"].includes(frame.type));
  const layOut = (): void => { termRef.current = { cols: 100, rows: 30, options: {}, reset: nothing } as unknown as Terminal; };

  it("attaches a pane that comes to the slot under the list keeping the pty's size, and asks for its grid once as it is shown", async () => {
    await draw({ paneId: BEFORE, covered: false });
    layOut();
    await draw({ paneId: BEFORE, covered: true });
    const from = socket.sent.length;
    await draw({ paneId: AFTER, covered: true });
    expect(sizing(from)).toEqual([{ type: "attach", pane_id: AFTER, cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true }]);
    const shown = socket.sent.length;
    await draw({ paneId: AFTER, covered: false });
    expect(sizing(shown)).toEqual([{ type: "resize", pane_id: AFTER, cols: 100, rows: 30 }]);
  });

  it("attaches a pane that comes to the slot with no list over it sizing the pty, as before", async () => {
    await draw({ paneId: BEFORE, covered: false });
    layOut();
    const from = socket.sent.length;
    await draw({ paneId: AFTER, covered: false });
    expect(sizing(from)).toEqual([{ type: "attach", pane_id: AFTER, cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String) }]);
  });
});
