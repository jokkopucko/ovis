import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { DOUBLE_ESCAPE_GAP_MS } from "./hermesStop.ts";
import { useTypedKeys, type TypedKeysDeps } from "./useTypedKeys.ts";

function mount(agent: string) {
  const sent: string[] = [];
  const marks: (number | null)[] = [];
  let pane: string | null = "p1";
  let lease = "1:0:0";
  const socket = { connected: true, inputLease: () => lease };
  const term = { input: (data: string) => { sent.push(data); marks.push(refs.stopKeyRef.current); }, rows: 0, buffer: { active: { baseY: 0, getLine: () => undefined } }, focus: () => {} };
  const ref = <T,>(current: T) => ({ current });
  const refs = {
    barKeyRef: ref(null), coarseRef: ref(false), compositionCommitPendingRef: ref(false), composingRef: ref(false), inputLineRef: ref(false),
    modifiersRef: ref({}), lockedRef: ref({}), reassertIfStaleRef: ref(() => {}), socketRef: ref(socket), stopKeyRef: ref<number | null>(null),
    tRef: ref((key: string) => key), termRef: ref(term),
  };
  let hook: ReturnType<typeof useTypedKeys> | null = null;
  function Probe() {
    hook = useTypedKeys({ ...refs, agent, agentStatus: "working", commitPendingText: () => {}, setLatch: () => {}, consumeModifiers: () => {},
      paneId: pane, setInputError: () => {} } as unknown as TypedKeysDeps);
    return null;
  }
  let renderer: ReactTestRenderer | null = null;
  act(() => { renderer = create(createElement(Probe)); });
  return {
    sent,
    marks,
    stop: () => act(() => { hook!.abortTurn(); }),
    wait: () => act(() => { jest.advanceTimersByTime(DOUBLE_ESCAPE_GAP_MS); }),
    switchPane: (next: string) => { pane = next; act(() => { renderer!.update(createElement(Probe)); }); },
    reconnect: () => { lease = "2:0:0"; },
    drop: () => { socket.connected = false; },
    unmount: () => act(() => { renderer!.unmount(); }),
  };
}

describe("the second Escape of a two-Escape Stop", () => {
  beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it("carries the mark of the Stop, as the first does, so a link lost since refuses it", () => {
    const h = mount("devin");
    h.stop();
    h.wait();
    expect(h.sent).toEqual(["\u001b", "\u001b"]);
    expect(h.marks[0]).toBeNumber();
    expect(h.marks[1]).toBe(h.marks[0]!);
    h.unmount();
  });

  it("follows the first on the same pane and connection", () => {
    const h = mount("devin");
    h.stop();
    expect(h.sent).toEqual(["\u001b"]);
    h.wait();
    expect(h.sent).toEqual(["\u001b", "\u001b"]);
  });

  it("is not sent to a pane the terminal was switched to meanwhile", () => {
    const h = mount("devin");
    h.stop();
    h.switchPane("p2");
    h.wait();
    expect(h.sent).toEqual(["\u001b"]);
  });

  it("is not sent on a connection that came back meanwhile", () => {
    const h = mount("kilo");
    h.stop();
    h.reconnect();
    h.wait();
    expect(h.sent).toEqual(["\u001b"]);
  });

  it("is not sent while disconnected, nor after the terminal is gone", () => {
    const dropped = mount("maki");
    dropped.stop();
    dropped.drop();
    dropped.wait();
    expect(dropped.sent).toEqual(["\u001b"]);
    const gone = mount("maki");
    gone.stop();
    gone.unmount();
    act(() => { jest.advanceTimersByTime(DOUBLE_ESCAPE_GAP_MS); });
    expect(gone.sent).toEqual(["\u001b"]);
  });
});
