import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Page, Route, WebSocket } from "playwright-core";
import { herdrRpc, paneFocus, paneRead, paneSplit, sessionSnapshot, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import type { TabMovedToWorkspace } from "../shared/protocol.ts";

/**
 * The split view's edges (lib/split.ts), each on a browser context of its own: the other half's
 * connection is a second socket, which the main browser run would take for the page's own.
 * Every wait is on a condition: a check that something did not happen waits first for a later
 * event that the same path would have shown after it.
 */
export async function checkSplitView(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-split-"));
  const workspaces: string[] = [];
  const contexts: BrowserContext[] = [];
  const panesFor = async (...suffixes: string[]): Promise<string[]> => {
    const ids: string[] = [];
    for (const suffix of suffixes) {
      const cwd = join(root, suffix);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `ovis-test-split-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      ids.push(created.root_pane.pane_id);
      await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "idle" });
    }
    return ids;
  };
  const open = async (panes: string[], view: "chat" | "terminal", before?: (context: BrowserContext) => Promise<unknown>, options: { blockViewWrites?: boolean; platform?: string } = {}): Promise<{ page: Page; errors: string[] }> => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    contexts.push(context);
    await context.addInitScript(([ids, lens, blockViewWrites, platform]) => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertDone: "off" }));
      for (const id of ids as string[]) localStorage.setItem(`ovis:view:${id}`, lens as string);
      if (blockViewWrites) {
        const setItem = Storage.prototype.setItem;
        Object.defineProperty(Storage.prototype, "setItem", {
          configurable: true,
          value(this: Storage, key: string, value: string) {
            if (this === localStorage && key.startsWith("ovis:view:")) throw new DOMException("Storage disabled", "SecurityError");
            setItem.call(this, key, value);
          },
        });
      }
      if (platform !== null) Object.defineProperty(navigator, "platform", { configurable: true, get: () => platform });
    }, [panes, view, options.blockViewWrites === true, options.platform ?? null] as const);
    await before?.(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(panes[0]!)}`);
    await page.locator(".conn-live").waitFor();
    return { page, errors };
  };
  const half = (page: Page, side: string) => page.locator(`.pane-slot[data-side="${side}"]`);
  const isActive = (page: Page, side: string) => page.waitForFunction((which) => document.querySelector(`.pane-slot[data-side="${which}"]`)?.classList.contains("is-active") === true, side);
  /** the pane dropped on the right half, which is then the active one */
  const splitRight = async (page: Page, pane: string, options: { newTargetAtDrop?: boolean } = {}): Promise<void> => {
    const area = page.locator(".pane-split");
    const source = page.locator(`.pane-select[title^="${pane} —"]`);
    await source.waitFor({ state: "visible" });
    await source.scrollIntoViewIfNeeded();
    const from = (await source.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    // Cross the browser's native drag threshold, then wait until App has observed dragstart
    // before measuring the destination or moving into it (the area can still be settling).
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
    await page.waitForFunction(() => document.querySelector(".split-drop")?.classList.contains("is-visible") === true);
    const box = (await area.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 });
    // Crossing xterm's row spans can produce only dragenter/dragleave. Moving again on the
    // same final element emits dragover, which must accept the pane before the drop.
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.waitForFunction(() => {
      const guide = document.querySelector(".split-drop");
      return guide?.classList.contains("is-visible") === true && guide.getAttribute("data-side") === "right";
    });
    if (options.newTargetAtDrop) {
      // The node under the pointer is replaced between the last dragover and the drop (xterm redraws
      // a row, a transcript renders again): the drop's own hit test then meets a new node and sends
      // it a dragenter, and Chromium refuses a drop whose last drag event nobody accepted. The cover
      // is the test's own node, so React never sees the swap.
      await page.evaluate(() => {
        const cover = document.querySelector("#split-drop-cover")!;
        cover.replaceWith(cover.cloneNode());
      });
    }
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
    await isActive(page, "right");
  };
  /** two frames: what a render commits, and the effects after it, have run */
  const settled = (page: Page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  /** polls a condition held outside the page, with a bound */
  const until = async (page: Page, check: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
  };

  try {
    // 1. An alert is skipped for the pane in the other half only while that half is drawn.
    {
      const [openPane, otherPane, probe] = await panesFor("open", "other", "probe") as [string, string, string];
      const { page, errors } = await open([openPane, otherPane, probe], "chat");
      const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
      const row = (pane: string, status: string) => page.locator(`.pane-item:has(.pane-select[title^="${pane} —"]) [data-status="${status}"]`).first();
      const block = async (pane: string) => {
        await report(pane, "working");
        await row(pane, "working").waitFor({ state: "attached" });
        await report(pane, "blocked");
        await row(pane, "blocked").waitFor({ state: "attached" });
      };
      const unblock = async (pane: string) => {
        await report(pane, "idle");
        await row(pane, "blocked").waitFor({ state: "detached" });
      };
      // a later status the app shows only after it has handled the block: no card by then is none at all
      const handled = async () => {
        await report(probe, "working");
        await row(probe, "working").waitFor({ state: "attached" });
        await settled(page);
        await report(probe, "idle");
      };
      const card = page.locator(".droplet-card");

      await splitRight(page, otherPane);
      await half(page, "left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "left");
      await block(otherPane);
      await handled();
      assert.equal(await card.count(), 0, "no in-app alert for the pane drawn in the other half");
      await unblock(otherPane);

      // a window too narrow for the split shows the active half alone: the other pane alerts again
      await page.setViewportSize({ width: 700, height: 800 });
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);
      await block(otherPane);
      await card.waitFor({ state: "visible" });
      assert.match((await card.getAttribute("aria-label")) ?? "", /Needs input/);
      await unblock(otherPane);
      console.log("PASS the other half's pane is spared alerts only while that half is drawn");

      // 2. A Tab onto a control of the inactive half makes the half active and keeps the focus there.
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForFunction(() => document.querySelector('.pane-slot[data-side="right"]')?.classList.contains("is-inactive") === true);
      // a focus right after a key, as a Tab gives one: the key and the focus in one task, so the
      // focus is the user's own however slow the run (KEY_FOCUS_MS)
      const attach = half(page, "right").getByRole("button", { name: "Attach files", exact: true });
      await attach.evaluate((button) => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
        (button as HTMLElement).focus();
      });
      await isActive(page, "right");
      await settled(page);
      assert.equal(await attach.evaluate((button) => button === document.activeElement), true, "the focus stays on the control it went to");
      console.log("PASS a Tab into the inactive half makes it active and keeps the focus where it went");
      assert.deepEqual(errors, []);
    }

    // 3. An upload that finishes in the half the user left does not take the keyboard back.
    {
      const [left, right] = await panesFor("upload-left", "upload-right") as [string, string];
      let held: Route | null = null;
      const { page, errors } = await open([left, right], "terminal", (context) => context.route("**/api/pane/image**", (route) => { held = route; }));
      await splitRight(page, right);
      await half(page, "left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "left");
      // a file dropped on the left terminal; its upload is held in flight
      await half(page, "left").locator(".pane-terminal").evaluate((host) => {
        const data = new DataTransfer();
        data.items.add(new File(["split view"], "split-note.txt", { type: "text/plain" }));
        host.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      });
      await until(page, () => held !== null, "the upload starts");
      // the user moves to the right half, then the upload finishes
      await half(page, "right").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "right");
      const uploaded = page.waitForResponse((response) => response.url().includes("/api/pane/image"));
      await (held as unknown as Route).continue();
      await uploaded;
      await settled(page);
      assert.equal(await half(page, "right").evaluate((slot) => slot.classList.contains("is-active")), true, "the right half stays active");
      assert.equal(await page.evaluate(() => document.activeElement?.closest('.pane-slot[data-side="right"]') !== null), true, "the keyboard stays in the right half");
      console.log("PASS an upload finishing in the half the user left does not take the keyboard back");
      assert.deepEqual(errors, []);
    }

    // 4. Closing the other half leaves the active half's pane mounted, on its own connection.
    {
      const [left, right] = await panesFor("keep-left", "keep-right") as [string, string];
      const sockets: WebSocket[] = [];
      const { page, errors } = await open([left, right], "chat", async (context) => {
        context.on("page", (opened) => opened.on("websocket", (socket) => sockets.push(socket)));
      });
      await splitRight(page, right);
      const kept = (await half(page, "right").locator(".pane-terminal").elementHandle())!;
      await half(page, "right").locator(`.pane-frame[data-layout-pane="${right}"]`).getByRole("log").waitFor();
      // the half dropped on the right is slot b, which draws on a connection of its own (App's SlotSessions)
      assert.equal(sockets.length, 2, "the second half opens a second socket to the PC");
      // the right half is active: closing the left one must not mount its pane again
      await half(page, "left").getByRole("button", { name: "Close this half", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);
      await settled(page);
      assert.equal(await kept.evaluate((element) => element.isConnected), true, "the active half's terminal stays mounted");
      assert.equal(sockets[1]!.isClosed(), false, "the active half's connection stays open");
      await page.locator(`.pane-frame[data-layout-pane="${right}"]`).getByRole("log").waitFor();
      console.log("PASS closing the other half leaves the active pane mounted on its connection");
      assert.deepEqual(errors, []);
    }

    // 5. The guide starts with the pane drag, keeps a stable side around the centre, and leaves
    //    the pane alone when cancelled. Synthetic events let the check visit exact pixel edges.
    {
      const [opened, dragged] = await panesFor("preview-open", "preview-dragged") as [string, string];
      const { page, errors } = await open([opened, dragged], "chat");
      const area = page.locator(".pane-split");
      const guide = page.locator(".split-drop");
      const source = page.locator(`.pane-select[title^="${dragged} —"]`);
      await source.waitFor();
      await guide.waitFor({ state: "attached" });
      const box = (await area.boundingBox())!;
      const middle = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const data = await page.evaluateHandle(() => new DataTransfer());
      const preview = async (visible: boolean, side: "left" | "right" | null): Promise<void> => {
        await settled(page);
        await page.waitForFunction(([shown, target]) => {
          const element = document.querySelector(".split-drop");
          return element?.classList.contains("is-visible") === shown && element.getAttribute("data-side") === target;
        }, [visible, side] as const);
      };
      const start = async (): Promise<void> => {
        // The sidebar's own handler fills the transfer before App's window listener reads it.
        await source.dispatchEvent("dragstart", { dataTransfer: data });
        await preview(true, null);
      };
      const hover = async (x: number, side: "left" | "right"): Promise<void> => {
        await area.dispatchEvent("dragover", { dataTransfer: data, clientX: x, clientY: y });
        await preview(true, side);
      };
      const unchanged = async (): Promise<void> => {
        await preview(false, null);
        assert.equal(await page.locator(".pane-slot").count(), 1, "cancelling does not create a half");
        await page.locator(`.pane-frame[data-layout-pane="${opened}"]`).getByRole("log").waitFor();
        assert.equal(await page.evaluate(() => sessionStorage.getItem("ovis:split")), null, "cancelling does not save a split");
      };

      await preview(false, null);
      assert.equal(await guide.locator(".split-drop-half").count(), 2, "both drop guides stay mounted");
      assert.equal(await guide.locator(".split-drop-target").count(), 1, "one indicator moves between the guides");
      const indicator = (await guide.locator(".split-drop-target").elementHandle())!;
      await start();
      await hover(middle + 40, "right");
      await area.locator(".pane-slot").first().dispatchEvent("dragleave", {
        dataTransfer: data, relatedTarget: null, clientX: middle + 40, clientY: y,
      });
      await preview(true, "right");
      await area.dispatchEvent("dragleave", { dataTransfer: data, relatedTarget: null, clientX: box.x - 1, clientY: y });
      await preview(true, null);
      await hover(middle - 40, "left");
      assert.equal(await indicator.evaluate((element) => element.isConnected), true, "the indicator is not replaced when the side changes");
      await source.dispatchEvent("dragend", { dataTransfer: data });
      await unchanged();

      for (const cancel of ["outside-drop", "blur", "Escape"] as const) {
        await start();
        await hover(middle + 40, "right");
        if (cancel === "outside-drop") await page.locator("body").dispatchEvent("drop", { dataTransfer: data });
        else if (cancel === "blur") await page.evaluate(() => window.dispatchEvent(new Event("blur")));
        else await page.keyboard.press("Escape");
        await unchanged();
      }

      // Text and files still belong to their existing input handlers, not the split guide.
      for (const kind of ["text", "file"] as const) {
        const otherData = await page.evaluateHandle((type) => {
          const transfer = new DataTransfer();
          if (type === "text") transfer.setData("text/plain", "selected text");
          else transfer.items.add(new File(["preview"], "preview.txt", { type: "text/plain" }));
          return transfer;
        }, kind);
        await page.locator("body").dispatchEvent("dragstart", { dataTransfer: otherData });
        await area.dispatchEvent("dragover", { dataTransfer: otherData, clientX: middle + 40, clientY: y });
        await unchanged();
        await page.locator("body").dispatchEvent("dragend", { dataTransfer: otherData });
        await otherData.dispose();
      }

      await page.setViewportSize({ width: 768, height: 800 });
      await settled(page); // the layout follows the media query a render later
      await source.dispatchEvent("dragstart", { dataTransfer: data });
      await area.dispatchEvent("dragover", { dataTransfer: data, clientX: 500, clientY: y });
      await unchanged();
      await source.dispatchEvent("dragend", { dataTransfer: data });
      await page.setViewportSize({ width: 1280, height: 800 });
      // the wide layout's drag listeners are registered by an effect after the render that follows the media query
      await page.waitForFunction(() => document.querySelector(".pane-slot") !== null);
      await settled(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await start();
      await hover(middle - 40, "left");
      const durations = await guide.evaluate((element) => [element, element.querySelector(".split-drop-target")!]
        .flatMap((node) => getComputedStyle(node).transitionDuration.split(",").map((value) => Number.parseFloat(value))));
      assert.equal(durations.every((duration) => duration === 0), true, "reduced motion removes guide and indicator transitions");
      await source.dispatchEvent("dragend", { dataTransfer: data });
      await unchanged();
      await page.emulateMedia({ reducedMotion: "no-preference" });

      await start();
      await hover(middle - 40, "left");
      await hover(middle + 1, "left");
      await hover(middle + 40, "right");
      await hover(middle - 1, "right");
      // Drop just to the left of the centre while the stable preview still points right.
      await area.dispatchEvent("drop", { dataTransfer: data, clientX: middle - 1, clientY: y });
      await preview(false, null);
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await half(page, "right").locator(`.pane-frame[data-layout-pane="${dragged}"]`).getByRole("log").waitFor();
      await isActive(page, "right");
      await data.dispose();
      console.log("PASS split preview starts early, survives child leaves, cancels cleanly and matches the drop side");
      assert.deepEqual(errors, []);
    }

    // 6. A tab dragged down out of its strip opens in a half; the strip keeps its sideways reorder.
    //    Each half draws its tab at herdr's own layout, and a half may draw the other half's tab too.
    {
      const [first] = await panesFor("tabs") as [string];
      const workspaceId = workspaces[workspaces.length - 1]!;
      const second = (await tabCreate({ workspaceId })).root_pane.pane_id;
      await herdrRpc("pane.report_agent", { pane_id: second, source: "manual", agent: "claude", state: "idle" });
      const beside = (await paneSplit(first, "right", false)).pane_id;
      const { page, errors } = await open([first, second, beside], "terminal");
      const area = page.locator(".pane-split");
      await page.waitForFunction(() => document.querySelectorAll(".pane-split .pane-terminal").length === 2);
      const tabs = page.locator(".tab-strip [role=tab]");
      await tabs.nth(1).waitFor();
      const box = (await area.boundingBox())!;
      const tab = (await tabs.nth(1).boundingBox())!;
      await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2);
      await page.mouse.down();
      await page.mouse.move(tab.x + tab.width / 2 + 8, tab.y + tab.height / 2 + 4, { steps: 2 });
      // the guide shows as soon as the drag starts, with no half chosen over the strip
      await page.waitForFunction(() => { const guide = document.querySelector(".split-drop"); return guide?.classList.contains("is-visible") && !guide.hasAttribute("data-side"); });
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 });
      await page.waitForFunction(() => document.querySelector(".split-drop")?.getAttribute("data-side") === "right");
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await isActive(page, "right");
      assert.equal(await half(page, "left").locator(".pane-terminal").count(), 2, "the left half draws herdr's split of its tab");
      assert.equal(await half(page, "right").locator(".pane-terminal").count(), 1);
      // the other half's tab, picked in the active half's strip, opens in the active half as well
      await half(page, "right").locator(".tab-strip [role=tab]").nth(0).click();
      // (a canvas keeps tabs it showed mounted, inert: only the frames drawn count)
      await page.waitForFunction((pane) => document.querySelector(`.pane-slot[data-side="right"] [data-layout-pane="${pane}"]:not([inert])`) !== null, first);
      await isActive(page, "right");
      assert.equal(await page.locator(".pane-slot").count(), 2);
      assert.equal(await half(page, "right").locator("[data-layout-pane]:not([inert]) .pane-terminal").count(), 2, "the right half draws the left half's tab too");
      assert.equal(await half(page, "left").locator("[data-layout-pane]:not([inert]) .pane-terminal").count(), 2, "the left half keeps its tab");
      // Escape drops a tab drag (from the other half's strip) with nothing changed
      const again = (await half(page, "right").locator(".tab-strip [role=tab]").nth(1).boundingBox())!;
      await page.mouse.move(again.x + again.width / 2, again.y + again.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 8 });
      await page.waitForFunction(() => document.querySelector(".split-drop")?.getAttribute("data-side") === "left");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector(".split-drop")?.classList.contains("is-visible") === false);
      await page.mouse.up();
      await settled(page);
      // the press made its half active, as any press in the other half does; the drag changed nothing
      await isActive(page, "right");
      assert.equal(await page.locator(".pane-slot").count(), 2);
      assert.equal(await half(page, "left").locator(".pane-terminal").count(), 2, "a cancelled drag leaves the halves alone");
      console.log("PASS a tab dragged out of its strip opens in a half, at herdr's layout, and in both when picked there");
      // a press on the other half's sibling pane (herdr's split) makes that half active with the sibling
      // selected, in one step: the halves stay two
      const sibling = half(page, "left").locator(".pane-frame:not(.is-current) .pane-terminal");
      await sibling.click({ position: { x: 40, y: 40 } });
      await isActive(page, "left");
      await settled(page);
      assert.equal(await page.locator(".pane-slot").count(), 2, "a sibling press keeps both halves");
      assert.equal(await page.locator(".pane-split [data-layout-pane]:not([inert]) .pane-terminal").count(), 4, "each half keeps drawing its tab");
      assert.equal(await half(page, "left").locator(".pane-frame.is-current .pane-terminal").count(), 1, "the pressed sibling is the selected pane");
      assert.equal(await half(page, "left").locator(".pane-frame").count(), 2);
      console.log("PASS a press on a sibling pane in the other half activates it with that pane selected");
      assert.deepEqual(errors, []);
    }

    // A real title drag must survive the frame's click-to-focus handler.
    {
      const [first] = await panesFor("title-drag") as [string];
      const beside = (await paneSplit(first, "right", false)).pane_id;
      const { page, errors } = await open([first, beside], "terminal");
      const title = page.locator(`[data-layout-pane="${beside}"] .pane-frame-title`);
      await title.click();
      assert.equal(await page.evaluate((pane) => document.activeElement?.closest("[data-layout-pane]")?.getAttribute("data-layout-pane") === pane, beside), true,
        "a title click still focuses its pane's input");
      const from = (await title.boundingBox())!;
      const area = (await page.locator(".pane-split").boundingBox())!;
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
      await page.waitForFunction(() => document.querySelector(".split-drop")?.classList.contains("is-visible"));
      await page.mouse.move(area.x + area.width * 0.2, area.y + area.height / 2, { steps: 8 });
      await page.mouse.move(area.x + area.width * 0.2, area.y + area.height / 2);
      await page.waitForFunction(() => document.querySelector(".split-drop")?.getAttribute("data-side") === "left");
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await isActive(page, "left");
      assert.equal(await half(page, "left").locator(".pane-frame.is-current").getAttribute("data-layout-pane"), beside,
        "the destination half selects the pane dragged by its title");
      assert.deepEqual(errors, []);
      console.log("PASS a real mouse drag from a two-pane tab's title opens that pane in the other half");
    }

    // A title dropped on another pane's title of its tab: the two trade places (herdr's pane.swap),
    // with that title marked while over it, no half chosen, and no split view opened.
    {
      const [first, elsewhere] = await panesFor("title-swap", "title-swap-focus") as [string, string];
      const beside = (await paneSplit(first, "right", false)).pane_id;
      await paneFocus(elsewhere);
      const { page, errors } = await open([first, beside], "terminal", (context) => context.addInitScript(() => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertDone: "off", followHerdrFocus: true }));
      }));
      const swapApplied = Promise.withResolvers<void>();
      const releaseSwap = Promise.withResolvers<void>();
      await page.route("**/api/pane/swap", async (route) => {
        // Hold the HTTP answer while the source and restored focus events reach this browser.
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        const response = await route.fetch();
        swapApplied.resolve();
        await releaseSwap.promise;
        await route.fulfill({ response });
      });
      const head = (pane: string) => page.locator(`[data-layout-pane="${pane}"] > .pane-frame-head`);
      await head(beside).waitFor();
      const left = () => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".pane-frame:not(.is-hidden)")]
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0]?.getAttribute("data-layout-pane"));
      assert.equal(await left(), first);
      const focused = await sessionSnapshot();
      const from = (await head(first).boundingBox())!;
      const to = (await head(beside).boundingBox())!;
      await page.mouse.move(from.x + 30, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + 38, from.y + from.height / 2 + 4, { steps: 2 });
      await page.mouse.move(to.x + 60, to.y + to.height / 2, { steps: 8 });
      await page.mouse.move(to.x + 61, to.y + to.height / 2);
      await page.waitForFunction((pane) => document.querySelector(`[data-layout-pane="${pane}"] > .pane-frame-head`)?.classList.contains("is-swap-target") === true, beside);
      assert.equal(await page.locator(".split-drop.is-visible").count(), 0, "no half is offered over a title it would swap with");
      const swapped = page.waitForResponse((response) => response.url().endsWith("/api/pane/swap") && response.request().method() === "POST");
      await page.mouse.up();
      try {
        await Promise.race([swapApplied.promise, swapped]);
        const workspaceId = focused.panes.find((pane) => pane.pane_id === first)!.workspace_id;
        await tabCreate({ workspaceId, label: "swap focus event marker" });
        // This later roster event proves the preceding focus events were handled, without a sleep.
        await page.locator(".tab-strip").getByRole("tab").filter({ hasText: "swap focus event marker" }).waitFor();
        assert.ok(await head(beside).isVisible(), "following herdr focus leaves this browser on the rearranged tab");
      } finally {
        releaseSwap.resolve();
      }
      await (await swapped).finished();
      await page.unroute("**/api/pane/swap");
      await page.waitForFunction((pane) => {
        const frames = [...document.querySelectorAll<HTMLElement>(".pane-frame:not(.is-hidden)")].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return frames[0]?.getAttribute("data-layout-pane") === pane;
      }, beside);
      const x = (await sessionSnapshot()).layouts.flatMap((layout) => layout.panes);
      assert.ok(x.find((pane) => pane.pane_id === beside)!.rect.x < x.find((pane) => pane.pane_id === first)!.rect.x, "herdr swapped the two");
      assert.equal(await page.locator(".is-swap-target").count(), 0, "the mark is cleared");
      assert.equal(await page.locator(".pane-slot").count(), 1, "a swap opens no split view");
      const afterSwap = await sessionSnapshot();
      assert.equal(afterSwap.focused_pane_id, focused.focused_pane_id, "title swapping preserves herdr's focused pane elsewhere");
      assert.equal(afterSwap.focused_tab_id, focused.focused_tab_id, "title swapping preserves herdr's active tab");
      assert.equal(afterSwap.focused_workspace_id, focused.focused_workspace_id, "title swapping preserves herdr's active workspace");
      console.log("PASS a title dropped on another title of its tab trades the two panes' places");
      // A refusal is an HTTP success with changed:false, not a successful layout change.
      await page.route("**/api/pane/swap", (route) => route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, changed: false, reason: "cross_tab", target_pane_id: beside }),
      }));
      const refusedFrom = (await head(first).boundingBox())!;
      const refusedTo = (await head(beside).boundingBox())!;
      await page.mouse.move(refusedFrom.x + 30, refusedFrom.y + refusedFrom.height / 2);
      await page.mouse.down();
      await page.mouse.move(refusedFrom.x + 38, refusedFrom.y + refusedFrom.height / 2 + 4, { steps: 2 });
      await page.mouse.move(refusedTo.x + 60, refusedTo.y + refusedTo.height / 2, { steps: 8 });
      await page.mouse.move(refusedTo.x + 61, refusedTo.y + refusedTo.height / 2);
      await page.waitForFunction((pane) => document.querySelector(`[data-layout-pane="${pane}"] > .pane-frame-head`)?.classList.contains("is-swap-target") === true, beside);
      await page.mouse.up();
      await page.locator(".pane-notice[role='alert']").filter({ hasText: "The panes are in different tabs." }).waitFor();
      assert.equal(await left(), beside, "a refused swap leaves the layout intact");
      await page.unroute("**/api/pane/swap");
      console.log("PASS a refused title swap shows herdr's reason");
      // the workspace's sidebar row dropped on a title of that tab opens its pane in a half, as before:
      // only a drag from a pane's own title swaps. The title is the pane the row does not carry
      const snapshot = await sessionSnapshot();
      const tabId = snapshot.panes.find((pane) => pane.pane_id === first)!.tab_id;
      const carried = snapshot.layouts.find((layout) => layout.tab_id === tabId)!.focused_pane_id;
      const other = carried === first ? beside : first;
      const row = page.locator("[draggable='true']", { hasText: "ovis-test-split-title-swap" }).first();
      const rowBox = (await row.boundingBox())!;
      const title = (await head(other).boundingBox())!;
      await page.mouse.move(rowBox.x + 20, rowBox.y + rowBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(rowBox.x + 28, rowBox.y + rowBox.height / 2 + 4, { steps: 2 });
      await page.mouse.move(title.x + 60, title.y + title.height / 2, { steps: 8 });
      await page.mouse.move(title.x + 61, title.y + title.height / 2);
      await page.waitForFunction(() => document.querySelector(".split-drop")?.getAttribute("data-side") !== null);
      assert.equal(await page.locator(".is-swap-target").count(), 0, "a sidebar row never marks a title");
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      const after = (await sessionSnapshot()).layouts.flatMap((layout) => layout.panes);
      assert.ok(after.find((pane) => pane.pane_id === beside)!.rect.x < after.find((pane) => pane.pane_id === first)!.rect.x, "the row's drop swapped nothing");
      assert.deepEqual(errors, []);
      console.log("PASS a sidebar row dropped on a title of its tab still opens a half");
    }

    // 6b. A narrow window shows the active half alone; picking the hidden half's pane opens it in the
    //     shown half, and the hidden half keeps its own: the wide window shows both again.
    {
      const [shown, hidden] = await panesFor("narrow-shown", "narrow-hidden") as [string, string];
      const { page, errors } = await open([shown, hidden], "chat");
      await splitRight(page, hidden);
      await half(page, "left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "left");
      await page.setViewportSize({ width: 700, height: 800 });
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);
      await page.locator(`.pane-frame[data-layout-pane="${shown}"]`).getByRole("log").waitFor();
      // the narrow window keeps the workspace list in a drawer
      await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.locator(`.pane-select[title^="${hidden} —"]`).click();
      await page.locator(`.pane-frame[data-layout-pane="${hidden}"]`).getByRole("log").waitFor();
      assert.notEqual(await page.evaluate(() => sessionStorage.getItem("ovis:split")), null, "the split is kept while the window is narrow");
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await isActive(page, "left");
      await half(page, "left").locator(`.pane-frame[data-layout-pane="${hidden}"]`).getByRole("log").waitFor();
      await half(page, "right").locator(`.pane-frame[data-layout-pane="${hidden}"]`).getByRole("log").waitFor();
      assert.deepEqual(errors, []);
      console.log("PASS a narrow window keeps the split, and a pick there changes the shown half alone");
    }

    // 6c. A saved split whose other half is the linked pane's own tab is drawn in both halves, each on its
    //     own socket: typing reaches the shell, and closing the duplicate leaves the survivor attached.
    {
      const [first] = await panesFor("overlap") as [string];
      const beside = (await paneSplit(first, "right", false)).pane_id;
      const frames: string[] = [];
      const { page, errors } = await open([first, beside], "terminal", async (context) => {
        await context.addInitScript(([other]) => {
          sessionStorage.setItem("ovis:split", JSON.stringify({ other: { machineId: "local", paneId: other }, bSide: "right", active: "a" }));
        }, [first] as const);
        // what the page asks of the PC's socket: attach/detach/input frames tell an attachment lost from one never made
        const note = (direction: string, payload: string | Buffer): void => {
          try {
            const message = JSON.parse(String(payload)) as { type?: string; pane_id?: string; text?: string };
            if (message.type === "attach" || message.type === "detach" || message.type === "input" || message.type === "input-ready") frames.push(`${direction} ${message.type} ${message.pane_id ?? ""} ${message.text ? JSON.stringify(message.text) : ""}`.trim());
          } catch { /* not JSON */ }
        };
        context.on("page", (opened) => opened.on("websocket", (socket) => {
          socket.on("framesent", ({ payload }) => note(">", payload));
          socket.on("framereceived", ({ payload }) => note("<", payload));
        }));
      });
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await page.waitForFunction(() => document.querySelectorAll(".pane-split .pane-terminal").length === 4);
      await settled(page);
      assert.equal(await half(page, "right").locator(".pane-terminal").count(), 2, "the other half draws the same tab");
      // the half that is not active draws the tab at the grid the active half gives it
      await page.waitForFunction(() => document.querySelector('.pane-slot[data-side="right"] [data-adopted-grid]') !== null);
      // Keep the shared grid from the wider terminal while both lenses show Chat, then make
      // only the inactive half show Terminal in a narrower viewport. No PTY resize can repair
      // a local fit here: the active half is still in Chat and the other half stays following.
      await half(page, "left").getByRole("button", { name: "Show the chat", exact: true }).click();
      await half(page, "right").getByRole("button", { name: "Show the terminal", exact: true }).waitFor();
      await page.setViewportSize({ width: 1000, height: 800 });
      await settled(page);
      await half(page, "right").getByRole("button", { name: "Show the terminal", exact: true }).click();
      await settled(page);
      await isActive(page, "left");
      const grids = await page.evaluate((pane) => [...document.querySelectorAll<HTMLElement>(`[data-layout-pane="${pane}"]`)].map((frame) => {
        const screen = frame.querySelector<HTMLElement>(".xterm-screen")!;
        const rows = frame.querySelector<HTMLElement>(".xterm-rows")!;
        const style = getComputedStyle(rows);
        const canvas = document.createElement("canvas");
        const measure = canvas.getContext("2d")!;
        measure.font = `${style.fontSize} ${style.fontFamily}`;
        return { cols: Math.round(parseFloat(screen.style.width) / measure.measureText("W").width), rows: rows.childElementCount };
      }), first);
      assert.equal(grids.length, 2);
      assert.ok(grids[0]!.cols > 0 && grids[0]!.rows > 0, "the active half has a measurable grid");
      assert.deepEqual(grids[1], grids[0], `the inactive Chat-to-Terminal lens keeps the active half's grid: ${JSON.stringify(grids)}`);
      console.log(`PASS an inactive Chat-to-Terminal lens keeps the shared xterm grid ${grids[0]!.cols}x${grids[0]!.rows}`);
      await half(page, "left").getByRole("button", { name: "Show the terminal", exact: true }).click();
      // the surviving terminal is still attached: a line typed into it reaches the shell
      const screen = async (): Promise<string> => (await paneRead({ paneId: first, source: "visible" })).text;
      const deadline = Date.now() + 15_000;
      while ((await screen()).trim() === "") { // the shell's prompt first
        if (Date.now() > deadline) throw new Error("Timed out: the pane drew no prompt");
        await page.waitForTimeout(100);
      }
      const current = half(page, "left").locator(".pane-frame.is-current .pane-terminal:not(.is-idle)");
      await current.waitFor();
      // typed before the PC says the pane takes input, a line is held for the user to send: wait for that word
      await until(page, () => frames.some((frame) => frame === `< input-ready ${first}`), "the surviving terminal's input-ready");
      await current.locator(".xterm-helper-textarea").focus();
      /** waits, with a bound, for a typed line to show in the pane */
      const reaches = async (text: string, when: string): Promise<void> => {
        const end = Date.now() + 15_000;
        let shown = await screen();
        while (!shown.includes(text)) {
          if (Date.now() > end) throw new Error(`Timed out: the typed line did not reach the pane ${when}; the pane shows:\n${shown}\nframes: ${frames.join(" | ")}`);
          await page.waitForTimeout(100);
          shown = await screen();
        }
      };
      await page.keyboard.type("echo split-ok-42\n");
      await reaches("split-ok-42", "drawn in both halves");
      // the duplicate closed: its socket's detach is its own, the left half's terminal still types
      await half(page, "right").getByRole("button", { name: "Close this half", exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);
      await settled(page);
      // one pane again: its slot has no side
      await page.locator(".pane-frame.is-current .pane-terminal:not(.is-idle) .xterm-helper-textarea").focus();
      await page.keyboard.type("echo split-ok-43\n");
      await reaches("split-ok-43", "after the duplicate half closed");
      assert.deepEqual(errors, []);
      console.log("PASS a split drawing one tab in both halves types into it, and closing the duplicate keeps the survivor attached");
    }

    // 7. A second page in the same browser context cannot replace this page's split.
    {
      const [first, firstOther, second, secondOther] = await panesFor("tab-one", "tab-one-other", "tab-two", "tab-two-other") as [string, string, string, string];
      const { page: firstPage, errors: firstErrors } = await open([first, firstOther, second, secondOther], "chat");
      const secondPage = await firstPage.context().newPage();
      const secondErrors: string[] = [];
      secondPage.on("pageerror", (error) => secondErrors.push(error.message));
      await secondPage.goto(`${origin}/?pane=${encodeURIComponent(second)}`);
      await secondPage.locator(".conn-live").waitFor();
      await secondPage.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1);

      // Both pages begin without a split; each then stores a different one in the same context.
      await splitRight(firstPage, firstOther);
      await settled(firstPage);
      await splitRight(secondPage, secondOther);
      await settled(secondPage);

      await firstPage.reload();
      await firstPage.locator(".conn-live").waitFor();
      await firstPage.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 2);
      await half(firstPage, "left").locator(`.pane-frame[data-layout-pane="${first}"]`).getByRole("log").waitFor();
      await half(firstPage, "right").locator(`.pane-frame[data-layout-pane="${firstOther}"]`).getByRole("log").waitFor();
      assert.equal(await firstPage.locator(`.pane-frame[data-layout-pane="${secondOther}"]`).getByRole("log").count(), 0,
        "reloading the first page restores its split instead of the second page's");
      assert.deepEqual(firstErrors, []);
      assert.deepEqual(secondErrors, []);
      console.log("PASS split state is isolated per page in a shared browser context");
    }

    // 8. Only a primary non-context press activates an inactive half, including on macOS.
    {
      const [left, right] = await panesFor("pointer-left", "pointer-right") as [string, string];
      const { page, errors } = await open([left, right], "terminal", undefined, { platform: "MacIntel" });
      await splitRight(page, right);
      for (const press of [
        { button: 2, ctrlKey: false, name: "right press" },
        { button: 1, ctrlKey: false, name: "middle press" },
        { button: 0, ctrlKey: true, name: "macOS Control-click" },
      ]) {
        await half(page, "left").locator(".terminal-host").dispatchEvent("pointerdown", {
          button: press.button, ctrlKey: press.ctrlKey, pointerId: 1, pointerType: "mouse", isPrimary: true,
        });
        await settled(page);
        assert.equal(await half(page, "right").evaluate((slot) => slot.classList.contains("is-active")), true,
          `${press.name} does not activate the inactive half`);
      }
      assert.deepEqual(errors, []);
      console.log("PASS right, middle and macOS Control-click presses leave the other half active");
    }

    // 9. An inactive-half lens choice is live in memory even when its storage write fails.
    {
      const [left, right] = await panesFor("lens-left", "lens-right") as [string, string];
      const { page, errors } = await open([left, right], "chat", undefined, { blockViewWrites: true });
      await splitRight(page, right);
      await half(page, "left").getByRole("button", { name: "Show the terminal", exact: true }).click();
      await settled(page);
      assert.equal(await half(page, "left").locator(".pane-slot-action").first().getAttribute("aria-label"), "Show the chat",
        "the inactive half reflects its explicit terminal choice");
      assert.equal(await page.evaluate((pane) => localStorage.getItem(`ovis:view:${pane}`), left), "chat",
        "the fixture's stored value remains unchanged after the blocked write");
      await half(page, "left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
      await isActive(page, "left");
      await settled(page);
      assert.equal(await page.locator('.view-switch button[aria-pressed="true"]').innerText(), "Terminal",
        "activating the half keeps the in-memory lens choice");
      assert.deepEqual(errors, []);
      console.log("PASS an inactive-half lens choice works and survives activation when storage writes fail");
    }

    // 9a. A half's row end, past its tabs, is its grip: its pane, dragged onto the other half, opens there too.
    {
      const [left, right] = await panesFor("grip-left", "grip-right") as [string, string];
      const { page, errors } = await open([left, right], "terminal");
      await splitRight(page, right);
      const grip = (await half(page, "right").locator(".pane-slot-grip").boundingBox())!;
      // the free end, left of the close
      const x = grip.x + 8;
      const y = grip.y + grip.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 8, y + 4, { steps: 2 });
      await page.waitForFunction(() => document.querySelector(".split-drop")?.classList.contains("is-visible") === true);
      const box = (await page.locator(".pane-split").boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 8 });
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
      await page.waitForFunction(() => {
        const guide = document.querySelector(".split-drop");
        return guide?.classList.contains("is-visible") === true && guide.getAttribute("data-side") === "left";
      });
      await page.mouse.up();
      await isActive(page, "left");
      await half(page, "left").locator(`.pane-frame[data-layout-pane="${right}"]`).waitFor();
      assert.equal(await page.locator(".pane-slot").count(), 2, "the split stays, both halves on the dragged pane");
      assert.deepEqual(errors, []);
      console.log("PASS a half's row end drags its pane into the other half");
    }

    // 9b. A drop just after the node under the pointer was replaced still opens the half.
    {
      const [left, right] = await panesFor("new-target-left", "new-target-right") as [string, string];
      const { page, errors } = await open([left, right], "terminal");
      await page.locator(".pane-split").evaluate((area) => {
        const cover = document.createElement("div");
        cover.id = "split-drop-cover";
        const box = area.getBoundingClientRect();
        cover.style.cssText = `position:fixed;left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;z-index:10`;
        area.append(cover);
      });
      await splitRight(page, right, { newTargetAtDrop: true });
      await page.locator("#split-drop-cover").evaluate((cover) => cover.remove());
      await half(page, "right").locator(".xterm").waitFor();
      assert.deepEqual(errors, []);
      console.log("PASS a drop on a node that replaced the hovered one still opens the half");
    }

    // 10. The phone's glass header follows the nested pane DOM, but never crosses a notice or tab row.
    {
      const [pane] = await panesFor("mobile-glass") as [string];
      const { page, errors } = await open([pane], "chat");
      await page.setViewportSize({ width: 700, height: 500 });
      await page.evaluate(() => {
        const app = document.createElement("div");
        app.id = "split-css-fixture";
        app.className = "app";
        app.style.cssText = "position:absolute;left:-2px;top:-2px;width:1px;height:1px;visibility:hidden;pointer-events:none";
        const header = document.createElement("header");
        header.className = "app-header";
        const body = document.createElement("div");
        body.className = "app-body";
        const column = document.createElement("div");
        column.className = "pane-column is-chat";
        const split = document.createElement("div");
        split.className = "pane-split";
        const slot = document.createElement("div");
        slot.className = "pane-slot";
        const host = document.createElement("main");
        host.className = "terminal-host";
        slot.append(host);
        split.append(slot);
        column.append(split);
        body.append(column);
        app.append(header, body);
        document.body.append(app);
      });
      const glassState = () => page.locator("#split-css-fixture").evaluate((app) => ({
        over: getComputedStyle(app).getPropertyValue("--header-over").trim(),
        margin: getComputedStyle(app.querySelector(".app-header")!).marginBottom,
      }));
      const initialGlass = await glassState();
      assert.notEqual(initialGlass.over, "", "the nested pane host enables phone glass-header overlap");
      assert.ok(Number.parseFloat(initialGlass.margin) < 0, "the header overlaps the chat when no row comes first");

      await page.locator("#split-css-fixture .pane-column").evaluate((column) => {
        const notice = document.createElement("p");
        notice.className = "pane-notice";
        notice.textContent = "Synthetic notice";
        column.insertBefore(notice, column.firstElementChild);
      });
      const noticeState = await glassState();
      assert.equal(noticeState.over, "", "a visible notice keeps the header in flow");
      assert.notEqual(await page.locator("#split-css-fixture .pane-notice").evaluate((notice) => getComputedStyle(notice).display), "none",
        "the notice remains visible");

      await page.locator("#split-css-fixture .pane-notice").evaluate((notice) => notice.remove());
      await page.locator("#split-css-fixture .pane-slot").evaluate((slot) => {
        const tabs = document.createElement("div");
        tabs.className = "tab-strip";
        slot.insertBefore(tabs, slot.firstElementChild);
      });
      const tabState = await glassState();
      assert.equal(tabState.over, "", "a visible tab strip keeps the header in flow");
      assert.notEqual(await page.locator("#split-css-fixture .tab-strip").evaluate((tabs) => getComputedStyle(tabs).display), "none",
        "the tab strip remains visible");
      assert.deepEqual(errors, []);
      console.log("PASS phone glass-header selectors follow pane-slot nesting without covering notices or tabs");
    }

    // A tab moved to another workspace goes as its pane, under a new ID: the half that showed it
    // follows it there, the inactive half as much as the active one, and the split stays.
    {
      const [left, right, , , probe] = await panesFor("move-left", "move-right", "move-target", "move-back", "move-probe") as [string, string, string, string, string];
      const { page, errors } = await open([left, right], "terminal");
      await splitRight(page, right);
      const shows = (side: string, pane: string) => page.waitForFunction(([which, id]) =>
        document.querySelector(`.pane-slot[data-side="${which}"] [data-layout-pane="${id}"]:not([inert])`) !== null, [side, pane] as const);
      const moveOut = async (side: string, to = "ovis-test-split-move-target"): Promise<string> => {
        // a right press on the half's open tab opens its menu without making the half the active one
        await half(page, side).locator('.tab-strip [role=tab][aria-selected="true"]').click({ button: "right" });
        await page.getByRole("menuitem", { name: "Move to workspace…", exact: true }).click();
        const answered = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/tab/move-to-workspace"));
        await page.getByRole("menuitem", { name: to, exact: true }).click();
        const response = await answered;
        assert.equal(response.status(), 200);
        return ((await response.json()) as TabMovedToWorkspace).pane_id;
      };
      await shows("left", left);

      const movedLeft = await moveOut("left");
      assert.notEqual(movedLeft, left, "herdr gives the moved pane a new ID");
      await shows("left", movedLeft);
      assert.equal(await page.locator(".pane-slot").count(), 2, "the split stays when the inactive half's tab moves");
      await isActive(page, "right");

      const movedRight = await moveOut("right");
      await shows("right", movedRight);
      await shows("left", movedLeft);
      assert.equal(await page.locator(".pane-slot").count(), 2, "the split stays when the active half's tab moves");
      await isActive(page, "right");
      // the lens picked for each pane went to its new ID with it (lib/paneMove.ts)
      assert.deepEqual(await page.evaluate((ids) => ids.map((id) => localStorage.getItem(`ovis:view:${id}`)), [left, right, movedLeft, movedRight]),
        [null, null, "terminal", "terminal"]);

      // herdr can drop the old ID from a roster before the move answers: until it does, neither half
      // falls back from its pane, and then each follows it. A later roster has come and gone before the
      // check, so a fallback would have shown by then
      const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
      for (const [side, pane] of [["left", movedLeft], ["right", movedRight]] as const) {
        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => { release = resolve; });
        await page.route("**/tab/move-to-workspace", async (route) => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
        // the page's roster without the pane: herdr moved it
        const dropped = page.waitForResponse(async (response) => new URL(response.url()).pathname === "/api/machines" && !(await response.text()).includes(`"${pane}"`));
        const moving = moveOut(side, "ovis-test-split-move-back");
        await dropped;
        await report(probe, "working");
        await page.locator(`.pane-item:has(.pane-select[title^="${probe} —"]) [data-status="working"]`).first().waitFor({ state: "attached" });
        await report(probe, "idle");
        await settled(page);
        assert.equal(await page.locator(".pane-slot").count(), 2, `the ${side} half stays while the move is answered`);
        release();
        await shows(side, await moving);
        await page.unroute("**/tab/move-to-workspace");
      }
      assert.equal(await page.locator(".pane-slot").count(), 2);
      await isActive(page, "right");
      assert.deepEqual(errors, []);
      console.log("PASS a tab moved to another workspace keeps its half of the split, active or not");
    }

    // A move made outside this browser (herdr's own window, another browser) reaches it as the server's
    // pane-moved: the half showing the pane follows it to its new ID, and what was typed there and the
    // lens picked for it go with it, sent nowhere (#1503).
    {
      const [left, right, , ] = await panesFor("tui-left", "tui-right", "tui-target") as [string, string, string];
      const target = workspaces.at(-1)!;
      const { page, errors } = await open([left, right], "chat");
      await splitRight(page, right);
      const shows = (side: string, pane: string) => page.waitForFunction(([which, id]) =>
        document.querySelector(`.pane-slot[data-side="${which}"] [data-layout-pane="${id}"]:not([inert])`) !== null, [side, pane] as const);
      await shows("left", left);
      const composer = half(page, "left").getByRole("textbox", { name: "Message", exact: true });
      await composer.fill("held across the move");
      await page.waitForFunction((id) => (localStorage.getItem(`ovis:composer-draft:${id}`) ?? "").includes("held across the move"), left);
      // the RPC behind `herdr pane move <pane> --new-tab --workspace <id>` in herdr's own window
      const { move_result } = await herdrRpc<{ move_result: { pane: { pane_id: string } } }>("pane.move", {
        pane_id: left, destination: { type: "new_tab", workspace_id: target }, focus: false,
      });
      const moved = move_result.pane.pane_id;
      assert.notEqual(moved, left, "herdr gives the moved pane a new ID");
      await shows("left", moved);
      await shows("right", right);
      assert.equal(await page.locator(".pane-slot").count(), 2, "the split stays when a pane moves elsewhere");
      assert.equal(await half(page, "left").getByRole("textbox", { name: "Message", exact: true }).inputValue(), "held across the move");
      assert.deepEqual(await page.evaluate((ids) => ids.map((id) => localStorage.getItem(`ovis:view:${id}`)), [left, moved]), [null, "chat"]);
      assert.equal(await page.evaluate((id) => localStorage.getItem(`ovis:composer-draft:${id}`), left), null);
      assert.deepEqual(errors, []);
      console.log("PASS a pane moved outside this browser keeps its half, its draft and its lens under the new ID");
    }

    // A saved partner on a removed PC is discarded only after the roster arrives.
    {
      const [pane] = await panesFor("removed-machine") as [string];
      const { page, errors } = await open([pane], "chat", (context) => context.addInitScript(() => {
        sessionStorage.setItem("ovis:split", JSON.stringify({
          other: { machineId: "removed-split-fixture", paneId: "missing-pane" },
          bSide: "right", active: "a",
        }));
      }));
      await page.waitForFunction(() => document.querySelectorAll(".pane-slot").length === 1
        && sessionStorage.getItem("ovis:split") === null);
      await page.locator(`.pane-frame[data-layout-pane="${pane}"]`).getByRole("log").waitFor();
      assert.deepEqual(errors, []);
      console.log("PASS a saved split on a removed PC closes after the roster arrives");
    }
  } finally {
    for (const context of contexts) await context.close();
    for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
