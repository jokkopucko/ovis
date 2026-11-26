import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, type RefObject } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { GhosttyTerminal } from "./ghostty/terminal.ts";
import { fontSettled } from "./fontFamily.ts";
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

const PANE = "w1:p1";
const COLORS = {} as TerminalRefitsDeps["colors"];

describe("useTerminalRefits under the inbox mode's list", () => {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;
  let client: HerdrSocket;
  let socket: FakeSocket;
  const termRef: RefObject<GhosttyTerminal | null> = { current: null };

  beforeEach(() => {
    for (const key of ["IS_REACT_ACT_ENVIRONMENT", "WebSocket", "window", "document"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeSocket });
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible", hasFocus: () => true, addEventListener() {}, removeEventListener() {} } });
    termRef.current = null;
    client = new HerdrSocket("ws://test/ws");
    client.connect();
    socket = FakeSocket.last;
    socket.open();
    client.attach(PANE, 100, 30);
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
  function Probe({ covered, chatView = false }: { covered: boolean; chatView?: boolean }) {
    const deps: TerminalRefitsDeps = {
      activeRef: ref(false), autoSelected: false, baseFontRef: ref(13), pinchingRef: ref(false), fontSettledRef: ref(fontSettled()),
      chatView, chatViewRef: ref(chatView), coarseRef: ref(false), covered, findOpenRef: ref(false), fitRef: ref(null), fittedRef: ref(() => {}),
      fixedGridRef: ref(false), follow: false, followCursorRef: ref(() => {}), keyboardHoldsRef: ref(() => false), narrowFont: false,
      narrowFontFitted: ref(false), observeRef: ref(false), colors: COLORS, paneRef: ref(PANE), peekRef: ref(null),
      sharedGridRef: ref(null), shown: true, sizesPty: () => true, socketRef: ref(client), termRef, terminalFontFamily: "", terminalFontSize: 13,
    };
    useTerminalRefits(deps);
    return null;
  }
  const draw = async (covered: boolean, chatView = false): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, { covered, chatView }));
      else renderer = create(createElement(Probe, { covered, chatView }));
    });
  };
  const sizing = (from: number) => socket.sent.slice(from).filter((frame) => ["attach", "resize", "release-size"].includes(frame.type));

  it("attaches a pane the list covers keeping the pty's size when the connection comes back, and asks for its grid as it is shown", async () => {
    await draw(false);
    await draw(true);
    const from = socket.sent.length;
    socket.open();
    expect(sizing(from)).toEqual([{ type: "attach", pane_id: PANE, cols: 100, rows: 30, flow_control: "ack", receipt_resume_id: expect.any(String), keep_size: true }]);
    termRef.current = { cols: 100, rows: 30 } as GhosttyTerminal;
    const shown = socket.sent.length;
    await draw(false);
    expect(sizing(shown)).toEqual([{ type: "resize", pane_id: PANE, cols: 100, rows: 30 }]);
  });

  it("takes the history the browser keeps to its newest rows once as the chat stops covering the grid, and not under a selection", async () => {
    let bottoms = 0;
    let selecting = false;
    await draw(false, true);
    termRef.current = { cols: 100, rows: 30, hasSelection: () => selecting, scrollToBottom: () => { bottoms += 1; } } as unknown as GhosttyTerminal;
    expect(bottoms).toBe(0);
    await draw(false, false);
    expect(bottoms).toBe(1);
    await draw(false, false);
    expect(bottoms).toBe(1);
    selecting = true;
    await draw(false, true);
    await draw(false, false);
    expect(bottoms).toBe(1);
  });

  it("sends nothing for a pane the list covers and shows again in the box it had, the connection unbroken", async () => {
    await draw(false);
    const from = socket.sent.length;
    await draw(true);
    termRef.current = { cols: 100, rows: 30 } as GhosttyTerminal;
    await draw(false);
    expect(sizing(from)).toEqual([]);
  });
});
