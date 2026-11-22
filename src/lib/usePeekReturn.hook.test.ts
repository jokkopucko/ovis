import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { FrameGate, InputRowState } from "./inputRow.ts";
import type { Translate } from "./i18n.ts";
import { usePeekReturn, type PeekReturnDeps } from "./usePeekReturn.ts";

type Hook = ReturnType<typeof usePeekReturn>;
type Props = { agent: string; agentStatus: string; chatMounted: boolean };

function mount(initial: Props) {
  let row: InputRowState | null = null;
  let props = initial;
  let hook: Hook | null = null;
  const ref = <T,>(current: T) => ({ current });
  const refs = {
    activeRef: ref(true), agentRef: ref<string | null>(initial.agent), coarseRef: ref(false), compositionCommitPendingRef: ref(false),
    composingRef: ref(false), draftHeldForRef: ref<string | null>(null), findOpenRef: ref(false),
    frameGateRef: ref({ reflowing: false } as unknown as FrameGate), lineComposingRef: ref(false), onEndPeekRef: ref(undefined),
    onPeekRef: ref(undefined), paneRef: ref<string | null>("p1"), peekRef: ref(null), receiptRowRef: ref(null), stackRef: ref(null),
    termRef: ref(null), heldRef: ref(false), unsupportedRef: ref(false),
  };
  const inputRowNow = () => row;
  const t = ((key: string) => key) as Translate;
  function Probe() {
    refs.agentRef.current = props.agent;
    hook = usePeekReturn({ ...refs, agent: props.agent, agentStatus: props.agentStatus, chatMounted: props.chatMounted, ended: false, inputRowNow,
      onOpenTerminal: undefined, paneId: "p1", peek: null, presented: true, terminalId: "t1", t } as PeekReturnDeps);
    return null;
  }
  let renderer: ReactTestRenderer | null = null;
  act(() => { renderer = create(createElement(Probe)); });
  const live = (): Hook => { if (hook === null) throw new Error("not rendered"); return hook; };
  return {
    open: () => live().stillOpenRef.current,
    frame: (state: InputRowState) => { row = state; act(() => { live().onInputRowFrameRef.current(); }); },
    set: (next: Partial<Props>) => { props = { ...props, ...next }; act(() => { renderer!.update(createElement(Probe)); }); },
    dismiss: () => act(() => { live().setStillOpen(null); }),
    raise: (named: { command: string }) => act(() => { live().setStillOpen({ pane: "p1", agent: props.agent, command: named.command, named: true, history: undefined }); }),
    unmount: () => act(() => { renderer!.unmount(); }),
  };
}

describe("a screen opened over the agent's row outside a peek", () => {
  const mounted: { unmount: () => void }[] = [];
  const at = (props: Props) => { const probe = mount(props); mounted.push(probe); return probe; };
  beforeAll(() => { Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true }); });
  afterEach(() => { for (const probe of mounted.splice(0)) probe.unmount(); });

  it("holds the next message once Claude's row, seen before, is gone while the chat shows", () => {
    const pane = at({ agent: "claude", agentStatus: "done", chatMounted: true });
    pane.frame("ready");
    expect(pane.open()).toBeNull();
    pane.frame("gone");
    expect(pane.open()).toEqual({ pane: "p1", agent: "claude", command: "", named: false, history: undefined });
    pane.frame("ready");
    expect(pane.open()).toBeNull();
  });

  it("holds Codex's covered row the same way", () => {
    const pane = at({ agent: "codex", agentStatus: "idle", chatMounted: true });
    pane.frame("ready");
    pane.frame("covered");
    expect(pane.open()?.named).toBe(false);
  });

  it("takes no other agent's missing row for a screen: pi's footer rows read gone on an empty editor", () => {
    const pane = at({ agent: "pi", agentStatus: "idle", chatMounted: true });
    pane.frame("ready");
    pane.frame("gone");
    expect(pane.open()).toBeNull();
  });

  it("needs the row read before on this pane, and the agent at rest", () => {
    const fresh = at({ agent: "claude", agentStatus: "done", chatMounted: true });
    fresh.frame("gone");
    expect(fresh.open()).toBeNull();
    const blocked = at({ agent: "claude", agentStatus: "blocked", chatMounted: true });
    blocked.frame("ready");
    blocked.frame("gone");
    expect(blocked.open()).toBeNull();
  });

  it("stays dismissed for the same screen, and comes back for the next one", () => {
    const pane = at({ agent: "claude", agentStatus: "done", chatMounted: true });
    pane.frame("ready");
    pane.frame("gone");
    expect(pane.open()).not.toBeNull();
    pane.dismiss();
    pane.frame("gone");
    expect(pane.open()).toBeNull();
    pane.frame("ready");
    pane.frame("gone");
    expect(pane.open()).not.toBeNull();
  });

  it("lets a screen closed while the Terminal lens was up end the dismissed one, so the next screen is held", () => {
    const pane = at({ agent: "claude", agentStatus: "done", chatMounted: true });
    pane.frame("ready");
    pane.frame("gone");
    pane.dismiss();
    pane.set({ chatMounted: false });
    pane.frame("ready");
    pane.frame("gone");
    pane.set({ chatMounted: true });
    expect(pane.open()?.named).toBe(false);
  });

  it("keeps a dismissed peek's notice dismissed: the same screen raises no unnamed one", () => {
    const pane = at({ agent: "claude", agentStatus: "done", chatMounted: true });
    pane.frame("ready");
    pane.raise({ command: "/config" });
    pane.frame("gone");
    expect(pane.open()?.command).toBe("/config");
    pane.dismiss();
    pane.frame("gone");
    expect(pane.open()).toBeNull();
  });

  it("drops it once the agent works on a turn", () => {
    const pane = at({ agent: "claude", agentStatus: "done", chatMounted: true });
    pane.frame("ready");
    pane.frame("gone");
    expect(pane.open()).not.toBeNull();
    pane.set({ agentStatus: "working" });
    expect(pane.open()).toBeNull();
  });

  it("keeps a peek's notice that outlived a turn dismissed for the same screen", () => {
    const pane = at({ agent: "claude", agentStatus: "done", chatMounted: true });
    pane.frame("ready");
    pane.raise({ command: "/config" });
    pane.set({ agentStatus: "working" });
    expect(pane.open()?.command).toBe("/config");
    pane.set({ agentStatus: "done" });
    pane.dismiss();
    pane.frame("gone");
    expect(pane.open()).toBeNull();
  });

  it("reads the screen as it stands when the chat comes back by its lens", () => {
    const pane = at({ agent: "claude", agentStatus: "done", chatMounted: false });
    pane.frame("ready");
    pane.frame("gone");
    expect(pane.open()).toBeNull();
    pane.set({ chatMounted: true });
    expect(pane.open()?.named).toBe(false);
  });
});
