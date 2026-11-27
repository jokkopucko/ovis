import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement, useRef, useState } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import { useSelectPane } from "./useSelection.ts";

describe("selectPane", () => {
  let page: Page;
  let select: (paneId: string, focusInput?: boolean) => void;
  let picks: number;
  let note: string | null;

  beforeEach(() => {
    page = openPage();
    picks = 0;
  });

  afterEach(async () => {
    await page.close();
  });

  async function mount(first: "pane-closed" | "copied" = "pane-closed"): Promise<void> {
    function Probe() {
      const pendingLink = useRef(null);
      const pendingFile = useRef(null);
      const selectionHint = useRef(null);
      const [, setLinkLanded] = useState(true);
      const [selectedPaneId, setSelectedPaneId] = useState<string | null>("w1:p1");
      const [, setNotificationViewTarget] = useState(null);
      const [, setTerminalPeek] = useState(null);
      const [, setAutoSelected] = useState(false);
      const [, setDrawerOpen] = useState(false);
      const [headerNote, setHeaderNote] = useState<"pane-closed" | "copied" | null>(first);
      note = headerNote;
      select = useSelectPane({ pendingLink, pendingFile, setLinkLanded, selectionHint, selectedPaneId, setSelectedPaneId, setNotificationViewTarget, setTerminalPeek, setAutoSelected, setDrawerOpen, setHeaderNote, onPick: () => { picks += 1; } } as Parameters<typeof useSelectPane>[0]).selectPane;
      return null;
    }
    await page.render(createElement(Probe));
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

  it("takes away the note an earlier link's landing left in the header", async () => {
    await mount();
    expect(note).toBe("pane-closed");
    await act(async () => { select("w1:p2"); });
    expect(note).toBeNull();
  });

  it("lets Link copied run its own short time", async () => {
    await mount("copied");
    await act(async () => { select("w1:p2"); });
    expect(note).toBe("copied");
  });

  it("keeps the note when the pick is the pane already shown", async () => {
    await mount();
    await act(async () => { select("w1:p1"); });
    expect(note).toBe("pane-closed");
    await act(async () => { select("w1:p2"); });
    expect(note).toBeNull();
  });
});
