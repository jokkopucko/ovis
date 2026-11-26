import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useMoreMenu, type MoreMenu } from "./moreMenu.ts";

describe("useMoreMenu", () => {
  let renderer: ReactTestRenderer | undefined;
  let reactAct: PropertyDescriptor | undefined;
  let menu: MoreMenu;

  beforeEach(() => {
    reactAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    if (reactAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", reactAct);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  function Probe({ pane, folded }: { pane: string; folded: boolean }) {
    menu = useMoreMenu(pane, folded, true);
    return null;
  }
  const draw = async (pane = "local:p1", folded = false): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, { pane, folded }));
      else renderer = create(createElement(Probe, { pane, folded }));
    });
  };

  it("closes a More whose button left the document, and keeps one whose button stands", async () => {
    const button = { isConnected: true };
    const anchor = button as unknown as HTMLElement;
    await draw();
    await act(async () => { menu.toggleMore(anchor); });

    await draw();

    expect(menu.more?.anchor).toBe(anchor);

    button.isConnected = false;
    await draw();

    expect(menu.more).toBeNull();
  });

  it("keeps pane actions in an open group when the tab row comes back", async () => {
    const anchor = { isConnected: true } as unknown as HTMLElement;
    await draw("local:p1", true);
    await act(async () => { menu.openGroup("pane", anchor); });

    await draw("local:p1", false);

    expect(menu.paneActionsInMore).toBe(true);
    await act(async () => { menu.closeGroup(); });
    expect(menu.paneActionsInMore).toBe(false);
  });

  it("does not carry an open pane group to another pane, even when the row stays folded", async () => {
    const anchor = { isConnected: true } as unknown as HTMLElement;
    await draw("local:p1", true);
    await act(async () => { menu.openGroup("pane", anchor); });

    await draw("desk:p1", true);

    expect(menu.group).toBeNull();
    expect(menu.paneActionsInMore).toBe(true);
  });

  it.each(["closing", "changing panes"] as const)("drops the held tab actions from More after %s", async (exit) => {
    const anchor = { isConnected: true } as unknown as HTMLElement;
    await draw("local:p1", true);
    await act(async () => { menu.toggleMore(anchor); });
    await draw("local:p1", false);
    expect(menu.paneActionsInMore).toBe(true);

    if (exit === "closing") await act(async () => { menu.closeMore(); });
    else await draw("desk:p1", false);
    expect(menu.more).toBeNull();
    await act(async () => { menu.toggleMore(anchor); });
    expect(menu.paneActionsInMore).toBe(false);
  });
});
