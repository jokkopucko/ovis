import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { DOUBLE_ESCAPE_GAP_MS } from "./hermesStop.ts";
import { useTypedKeys, type TypedKeysDeps } from "./useTypedKeys.ts";

let page: Page;
let probes: Map<number, ReactElement>;
let nextProbe: number;

async function mount(agent: string) {
  const sent: string[] = [];
  let status: TypedKeysDeps["agentStatus"] = "working";
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
    hook = useTypedKeys({ ...refs, agent, agentStatus: status, commitPendingText: () => {}, setLatch: () => {}, consumeModifiers: () => {},
      paneId: pane, setInputError: () => {} } as unknown as TypedKeysDeps);
    return null;
  }
  const id = nextProbe++;
  const render = () => {
    probes.set(id, createElement(Probe, { key: id }));
    return page.render([...probes.values()]);
  };
  await render();
  return {
    sent,
    marks,
    stop: () => act(async () => { hook!.abortTurn(); }),
    wait: () => act(async () => { jest.advanceTimersByTime(DOUBLE_ESCAPE_GAP_MS); }),
    switchPane: (next: string) => { pane = next; return render(); },
    status: (next: TypedKeysDeps["agentStatus"]) => { status = next; return render(); },
    reconnect: () => { lease = "2:0:0"; },
    drop: () => { socket.connected = false; },
    unmount: () => { probes.delete(id); return page.render(probes.size === 0 ? null : [...probes.values()]); },
  };
}

describe("the second Escape of a two-Escape Stop", () => {
  beforeEach(() => {
    page = openPage();
    probes = new Map();
    nextProbe = 0;
    jest.useFakeTimers();
  });
  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
  });

  it("carries the mark of the Stop, as the first does, so a link lost since refuses it", async () => {
    const h = await mount("devin");
    await h.stop();
    await h.wait();
    expect(h.sent).toEqual(["\u001b", "\u001b"]);
    expect(h.marks[0]).toBeNumber();
    expect(h.marks[1]).toBe(h.marks[0]!);
    await h.unmount();
  });

  it("follows the first on the same pane and connection", async () => {
    const h = await mount("devin");
    await h.stop();
    expect(h.sent).toEqual(["\u001b"]);
    await h.wait();
    expect(h.sent).toEqual(["\u001b", "\u001b"]);
  });

  it("is not sent to a pane the terminal was switched to meanwhile", async () => {
    const h = await mount("devin");
    await h.stop();
    await h.switchPane("p2");
    await h.wait();
    expect(h.sent).toEqual(["\u001b"]);
  });

  it("does not follow a stop into the next observed turn", async () => {
    const h = await mount("devin");
    await h.stop();
    await h.status("idle");
    await h.status("working");
    await h.wait();
    expect(h.sent).toEqual(["\u001b"]);
  });

  it("is not sent on a connection that came back meanwhile", async () => {
    const h = await mount("kilo");
    await h.stop();
    h.reconnect();
    await h.wait();
    expect(h.sent).toEqual(["\u001b"]);
  });

  it("is not sent while disconnected, nor after the terminal is gone", async () => {
    const dropped = await mount("maki");
    await dropped.stop();
    dropped.drop();
    await dropped.wait();
    expect(dropped.sent).toEqual(["\u001b"]);
    const gone = await mount("maki");
    await gone.stop();
    await gone.unmount();
    await act(async () => { jest.advanceTimersByTime(DOUBLE_ESCAPE_GAP_MS); });
    expect(gone.sent).toEqual(["\u001b"]);
  });
});
