import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement } from "react";
import { useMoreMenu, type MoreMenu } from "./moreMenu.ts";
import { openPage, type Page } from "./page.fixture.ts";

describe("useMoreMenu", () => {
  let page: Page;
  let menu: MoreMenu;

  beforeEach(() => {
    page = openPage();
  });

  afterEach(async () => {
    await page.close();
  });

  function Probe({ pane, folded }: { pane: string; folded: boolean }) {
    menu = useMoreMenu(pane, folded, true);
    return null;
  }
  const draw = async (pane = "local:p1", folded = false): Promise<void> => {
    await page.render(createElement(Probe, { pane, folded }));
  };
  const addAnchor = (): HTMLElement => {
    const button = page.container.ownerDocument.createElement("button");
    page.container.ownerDocument.body.append(button);
    return button;
  };

  it("closes a More whose button left the document, and keeps one whose button stands", async () => {
    const anchor = addAnchor();
    await draw();
    await act(async () => { menu.toggleMore(anchor); });

    await draw();

    expect(menu.more?.anchor).toBe(anchor);

    anchor.remove();
    await draw();

    expect(menu.more).toBeNull();
  });

  it("keeps pane actions in an open group when the tab row comes back", async () => {
    const anchor = addAnchor();
    await draw("local:p1", true);
    await act(async () => { menu.openGroup("pane", anchor); });

    await draw("local:p1", false);

    expect(menu.paneActionsInMore).toBe(true);
    await act(async () => { menu.closeGroup(); });
    expect(menu.paneActionsInMore).toBe(false);
  });

  it("does not carry an open pane group to another pane, even when the row stays folded", async () => {
    const anchor = addAnchor();
    await draw("local:p1", true);
    await act(async () => { menu.openGroup("pane", anchor); });

    await draw("desk:p1", true);

    expect(menu.group).toBeNull();
    expect(menu.paneActionsInMore).toBe(true);
  });

  it.each(["closing", "changing panes"] as const)("drops the held tab actions from More after %s", async (exit) => {
    const anchor = addAnchor();
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
