import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement, useRef, useState } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSelectPane } from "./useSelection.ts";

// The real hook: a pane the user picks (the next/previous pane keys, a palette action) is a pick the
// setup guide steps aside for, as selectTarget's are; the app's own fallback selection is not.
describe("selectPane", () => {
  let saved: PropertyDescriptor | undefined;
  let renderer: ReactTestRenderer | undefined;
  let select: (paneId: string, focusInput?: boolean) => void;
  let picks: number;

  beforeEach(() => {
    saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    picks = 0;
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function mount(): Promise<void> {
    function Probe() {
      const pendingLink = useRef(null);
      const pendingFile = useRef(null);
      const selectionHint = useRef(null);
      const [, setLinkLanded] = useState(true);
      const [, setSelectedPaneId] = useState<string | null>(null);
      const [, setNotificationViewTarget] = useState(null);
      const [, setTerminalPeek] = useState(null);
      const [, setAutoSelected] = useState(false);
      const [, setDrawerOpen] = useState(false);
      select = useSelectPane({ pendingLink, pendingFile, setLinkLanded, selectionHint, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, setDrawerOpen, onPick: () => { picks += 1; } } as Parameters<typeof useSelectPane>[0]).selectPane;
      return null;
    }
    await act(async () => { renderer = create(createElement(Probe)); });
  }

  it("tells of a pane the user picked", async () => {
    await mount();
    await act(async () => { select("w1:p2"); });
    expect(picks).toBe(1);
  });

  it("does not tell of the app's own selection", async () => {
    await mount();
    await act(async () => { select("w1:p2", false); });
    expect(picks).toBe(0);
  });
});
