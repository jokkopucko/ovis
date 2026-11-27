import { afterEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import type { FrameGate, InputRowState } from "./inputRow.ts";
import type { Translate } from "./i18n.ts";
import { usePeekReturn, type PeekReturnDeps } from "./usePeekReturn.ts";

type Hook = ReturnType<typeof usePeekReturn>;
type Props = { agent: string; agentStatus: string; chatMounted: boolean };

async function mount(initial: Props, page: Page) {
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
  await page.render(createElement(Probe));
  const live = (): Hook => { if (hook === null) throw new Error("not rendered"); return hook; };
  return {
    open: () => live().stillOpenRef.current,
    frame: (state: InputRowState) => { row = state; return act(async () => { live().onInputRowFrameRef.current(); }); },
    set: (next: Partial<Props>) => { props = { ...props, ...next }; return page.render(createElement(Probe)); },
    dismiss: () => act(async () => { live().setStillOpen(null); }),
    raise: (named: { command: string }) => act(async () => { live().setStillOpen({ pane: "p1", agent: props.agent, command: named.command, named: true, history: undefined }); }),
  };
}

describe("a screen opened over the agent's row outside a peek", () => {
  const pages: Page[] = [];
  const at = (props: Props) => { const page = openPage(); pages.push(page); return mount(props, page); };
  afterEach(async () => { for (const page of pages.splice(0).reverse()) await page.close(); });

  it("holds the next message once Claude's row, seen before, is gone while the chat shows", async () => {
    const pane = await at({ agent: "claude", agentStatus: "done", chatMounted: true });
    await pane.frame("ready");
    expect(pane.open()).toBeNull();
    await pane.frame("gone");
    expect(pane.open()).toEqual({ pane: "p1", agent: "claude", command: "", named: false, history: undefined });
    await pane.frame("ready");
    expect(pane.open()).toBeNull();
  });

  it("holds Codex's covered row the same way", async () => {
    const pane = await at({ agent: "codex", agentStatus: "idle", chatMounted: true });
    await pane.frame("ready");
    await pane.frame("covered");
    expect(pane.open()?.named).toBe(false);
  });

  it("takes no other agent's missing row for a screen: pi's footer rows read gone on an empty editor", async () => {
    const pane = await at({ agent: "pi", agentStatus: "idle", chatMounted: true });
    await pane.frame("ready");
    await pane.frame("gone");
    expect(pane.open()).toBeNull();
  });

  it("needs the row read before on this pane, and the agent at rest", async () => {
    const fresh = await at({ agent: "claude", agentStatus: "done", chatMounted: true });
    await fresh.frame("gone");
    expect(fresh.open()).toBeNull();
    const blocked = await at({ agent: "claude", agentStatus: "blocked", chatMounted: true });
    await blocked.frame("ready");
    await blocked.frame("gone");
    expect(blocked.open()).toBeNull();
  });

  it("stays dismissed for the same screen, and comes back for the next one", async () => {
    const pane = await at({ agent: "claude", agentStatus: "done", chatMounted: true });
    await pane.frame("ready");
    await pane.frame("gone");
    expect(pane.open()).not.toBeNull();
    await pane.dismiss();
    await pane.frame("gone");
    expect(pane.open()).toBeNull();
    await pane.frame("ready");
    await pane.frame("gone");
    expect(pane.open()).not.toBeNull();
  });

  it("lets a screen closed while the Terminal lens was up end the dismissed one, so the next screen is held", async () => {
    const pane = await at({ agent: "claude", agentStatus: "done", chatMounted: true });
    await pane.frame("ready");
    await pane.frame("gone");
    await pane.dismiss();
    await pane.set({ chatMounted: false });
    await pane.frame("ready");
    await pane.frame("gone");
    await pane.set({ chatMounted: true });
    expect(pane.open()?.named).toBe(false);
  });

  it("keeps a dismissed peek's notice dismissed: the same screen raises no unnamed one", async () => {
    const pane = await at({ agent: "claude", agentStatus: "done", chatMounted: true });
    await pane.frame("ready");
    await pane.raise({ command: "/config" });
    await pane.frame("gone");
    expect(pane.open()?.command).toBe("/config");
    await pane.dismiss();
    await pane.frame("gone");
    expect(pane.open()).toBeNull();
  });

  it("drops it once the agent works on a turn", async () => {
    const pane = await at({ agent: "claude", agentStatus: "done", chatMounted: true });
    await pane.frame("ready");
    await pane.frame("gone");
    expect(pane.open()).not.toBeNull();
    await pane.set({ agentStatus: "working" });
    expect(pane.open()).toBeNull();
  });

  it("keeps a peek's notice that outlived a turn dismissed for the same screen", async () => {
    const pane = await at({ agent: "claude", agentStatus: "done", chatMounted: true });
    await pane.frame("ready");
    await pane.raise({ command: "/config" });
    await pane.set({ agentStatus: "working" });
    expect(pane.open()?.command).toBe("/config");
    await pane.set({ agentStatus: "done" });
    await pane.dismiss();
    await pane.frame("gone");
    expect(pane.open()).toBeNull();
  });

  it("reads the screen as it stands when the chat comes back by its lens", async () => {
    const pane = await at({ agent: "claude", agentStatus: "done", chatMounted: false });
    await pane.frame("ready");
    await pane.frame("gone");
    expect(pane.open()).toBeNull();
    await pane.set({ chatMounted: true });
    expect(pane.open()?.named).toBe(false);
  });
});
