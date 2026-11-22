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

  function Probe(_: { drawn: number }) {
    menu = useMoreMenu();
    return null;
  }
  const draw = async (drawn: number): Promise<void> => {
    await act(async () => {
      if (renderer) renderer.update(createElement(Probe, { drawn }));
      else renderer = create(createElement(Probe, { drawn }));
    });
  };

  it("closes a More whose button left the document, and keeps one whose button stands", async () => {
    const button = { isConnected: true };
    const anchor = button as unknown as HTMLElement;
    await draw(0);
    await act(async () => { menu.setMore({ anchor }); });

    await draw(1);

    expect(menu.more?.anchor).toBe(anchor);

    button.isConnected = false;
    await draw(2);

    expect(menu.more).toBeNull();
  });
});
