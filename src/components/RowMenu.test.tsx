import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement, useState } from "react";
import { Pencil } from "lucide-react";

import { openPage, type Page } from "../lib/page.fixture.ts";
import { SettingsProvider } from "../lib/settings.ts";
import { SHEET_QUERY } from "../lib/sheets.ts";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";

describe("how the row menu closes from outside it", () => {
  let page: Page;
  let frames: FrameRequestCallback[];
  let closes: number;
  let menuHeight: number;

  beforeEach(() => {
    page = openPage();
    document.body.style.overflowX = "visible";
    document.body.style.overflowY = "visible";
    menuHeight = 100;
  });
  afterEach(async () => { await page.close(); });

  const node = (parent: HTMLElement = document.body) => parent.appendChild(document.createElement("div"));
  async function draw(phone: boolean, anchor = node(), { point, useItems }: { readonly point?: { x: number; y: number }; readonly useItems?: () => RowMenuItem[] } = {}): Promise<void> {
    frames = [];
    closes = 0;
    page.window.innerWidth = phone ? 390 : 1280;
    page.window.innerHeight = 800;
    const matchMedia = page.window.matchMedia.bind(page.window);
    Object.defineProperty(page.window, "matchMedia", { configurable: true, value: (query: string) => {
      const media = matchMedia(query);
      Object.defineProperty(media, "matches", { value: phone && query === SHEET_QUERY });
      return media;
    } });
    window.requestAnimationFrame = (run) => frames.push(run);
    window.cancelAnimationFrame = () => {};
    if (!phone) {
      // The popover measures its div in a layout effect, before draw returns. The page restores the prototype.
      const { HTMLDivElement, HTMLElement } = page.window;
      const owner = document;
      for (const metric of ["offsetWidth", "offsetHeight", "clientHeight", "scrollHeight"] as const) {
        Object.defineProperty(HTMLDivElement.prototype, metric, { configurable: true, get(this: HTMLDivElement) {
          if (this.ownerDocument === owner && this.matches(".row-menu")) return metric === "offsetWidth" ? 200 : menuHeight;
          return Reflect.get(HTMLElement.prototype, metric, this);
        } });
      }
    }
    function OpenMenu() {
      const [open, setOpen] = useState(true);
      const items = useItems?.() ?? [{ id: "rename", label: "Rename", icon: Pencil, run() {} }];
      return open ? createElement(RowMenu, { anchor, point, title: "w1", items, onClose: () => { closes++; setOpen(false); } }) : null;
    }
    await page.render(createElement(SettingsProvider, null, createElement(OpenMenu)));
  }

  const frame = () => act(async () => { for (const run of frames.splice(0)) run(0); });
  const scrim = () => document.querySelector<HTMLElement>(".modal-scrim")!;
  const outside = () => act(async () => { document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); });
  const press = async (on: "scrim" | "sheet", then: "click" | "none"): Promise<void> => {
    const target = on === "scrim" ? scrim() : scrim().querySelector<HTMLElement>(".row-sheet")!;
    await act(async () => { target.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true })); });
    if (then === "click") await act(async () => target.click());
  };

  it("keeps a phone's sheet through the press of a tap outside it, and closes it on the tap's click on the dimmed page", async () => {
    await draw(true);
    await outside();
    expect(closes).toBe(0);
    await press("scrim", "none");
    expect(closes).toBe(0);
    await press("scrim", "click");
    expect(closes).toBe(1);
  });

  it("keeps the sheet when a press begun in it is let go over the dimmed page", async () => {
    await draw(true);
    await outside();
    expect(closes).toBe(0);
    await press("sheet", "click");
    await act(async () => scrim().click());
    expect(closes).toBe(0);
    await press("scrim", "click");
    expect(closes).toBe(1);
  });

  it("closes a desktop's popover on a press outside it", async () => {
    await draw(false);
    expect(document.querySelectorAll(".modal-scrim")).toHaveLength(0);
    await outside();
    expect(closes).toBe(1);
  });

  it("follows a shifted desktop row through a chat scroll, then closes when the row scrolls out of view", async () => {
    const list = node();
    list.style.overflowX = "visible";
    list.style.overflowY = "auto";
    Object.defineProperty(list, "clientHeight", { value: 300 });
    list.getBoundingClientRect = () => new page.window.DOMRect(0, 80);
    let top = 100, left = 212;
    const anchor = node(list);
    anchor.getBoundingClientRect = () => new page.window.DOMRect(left, top, 120, 20);
    await draw(false, anchor, { point: { x: 240, y: 110 } });
    const menu = () => [...document.querySelectorAll<HTMLElement>('[role="menu"]')];
    const scroll = (target: HTMLElement) => act(async () => {
      target.dispatchEvent(new window.Event("scroll"));
    });
    expect(menu()[0]?.style).toMatchObject({ top: "110px", left: "240px" });

    top = 132;
    left = 224;
    await scroll(node());
    await frame();
    expect(closes).toBe(0);
    expect(menu()[0]?.style).toMatchObject({ top: "142px", left: "252px" });

    top = 140;
    await frame();
    expect(menu()[0]?.style.top).toBe("150px");

    top = 48; // Still in the viewport, but above the scrolling list's visible area.
    await scroll(list);
    await frame();
    expect(menu()).toHaveLength(0);
    expect(closes).toBe(1);
  });

  it("stays open on a Show more item and hands the focus to the item that takes its place", async () => {
    const focused: string[] = [];
    function useGrowingItems(): RowMenuItem[] {
      const [count, setCount] = useState(1);
      const folders = Array.from({ length: count }, (_, index) => ({ id: `folder-${index}`, label: `folder ${index}`, icon: Pencil, run() {} }));
      return count < 3 ? [...folders, { id: "more", label: "Show more", icon: Pencil, keepOpen: true, run: () => setCount((shown) => shown + 1) }] : folders;
    }
    await draw(false, node(), { useItems: useGrowingItems });
    const menu = document.querySelector('[role="menu"]');
    if (!menu) throw new Error("Expected a desktop row menu");
    menu.addEventListener("focusin", (event) => {
      if (!(event.target instanceof page.window.HTMLButtonElement)) return;
      const id = event.target.getAttribute("data-item");
      if (id !== null) focused.push(id);
    });
    const press = (id: string) => act(async () => {
      const button = menu.querySelector<HTMLButtonElement>(`button[data-item="${id}"]`);
      if (!button) throw new Error(`Expected a row menu button for ${id}`);
      button.click();
    });

    await press("more");
    expect(closes).toBe(0);
    expect(focused).toEqual(["folder-1"]);
    await press("more");
    expect(closes).toBe(0);
    expect([...menu.querySelectorAll("button[data-item]")].map((button) => button.getAttribute("data-item"))).toEqual(["folder-0", "folder-1", "folder-2"]);
    expect(focused).toEqual(["folder-1", "folder-2"]);
    await press("folder-0");
    expect(closes).toBe(1);
  });

  it("repositions an open desktop menu that grows near the bottom of the viewport", async () => {
    const anchor = node();
    anchor.getBoundingClientRect = () => new page.window.DOMRect(212, 600, 120, 20);
    menuHeight = 250;
    await draw(false, anchor);
    const top = () => document.querySelector<HTMLElement>('[role="menu"]')?.style.top;
    expect(top()).toBe("346px");

    menuHeight = 500;
    await frame();
    expect(top()).toBe("96px");
  });
});
