import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { herdrRpc, tabClose } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

export interface FollowFocusFixture {
  workspaceId: string;
}

const NO_FOLLOW_WAIT_MS = 600;

export async function checkFollowHerdrFocus(page: Page, fixture: FollowFocusFixture): Promise<void> {
  const until = async (check: () => Promise<boolean>, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, `Timed out: ${label}`);
      await page.waitForTimeout(50);
    }
  };
  const selectedPaneId = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id as string | undefined);
  const shownTab = () => page.locator(".tab-strip").getByRole("tab", { selected: true }).textContent();
  const follow = async (on: boolean): Promise<void> => {
    if (!(await page.locator(".settings-dialog").isVisible())) await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Terminal");
    const choice = page.getByRole("group", { name: "herdr window", exact: true }).getByRole("button", { name: on ? "Follow its focus" : "Separate", exact: true });
    if ((await choice.getAttribute("aria-pressed")) !== "true") await choice.click();
    assert.equal(await choice.getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  // `herdr tab create --focus`: herdr opens the tab and moves its own focus there, past this app
  const focusedTab = (label: string) => herdrRpc<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>(
    "tab.create", { workspace_id: fixture.workspaceId, label, focus: true });

  const before = await selectedPaneId();
  assert.ok(before, "a pane is selected before the check");
  // herdr sends its focus on a connection of its own, apart from its tab and pane events
  // (server/collector.ts), so a tab listed here says nothing of the focus frame for it, which may
  // come later.
  await page.evaluate(() => {
    const read: string[] = [];
    (window as unknown as { __focusFramesRead?: string[] }).__focusFramesRead = read;
    (window as unknown as { __rewriteMachinesFrame?: (data: string) => string }).__rewriteMachinesFrame = (data) => {
      let event: { type?: string; message?: { type?: string; pane_id?: string } };
      try { event = JSON.parse(data); } catch { return data; }
      if (event.type === "machine-message" && event.message?.type === "pane-focused" && event.message.pane_id) read.push(event.message.pane_id);
      return data;
    };
  });
  // A wrong follow is only a React update scheduled in that call: the selection read here is stored
  // by an effect after the render, so the read waits two frames and a task past the frame for both
  const focusRead = async (paneId: string, label: string): Promise<void> => {
    await until(() => page.evaluate(
      (paneId) => (window as unknown as { __focusFramesRead?: string[] }).__focusFramesRead?.includes(paneId) === true, paneId), label);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
  };
  const tabs: string[] = [];
  let following = false;
  let releaseSplit = (): void => undefined;
  try {
    const ignored = await focusedTab("follow focus off");
    tabs.push(ignored.tab.tab_id);
    await focusRead(ignored.root_pane.pane_id, "herdr's focus frame for the tab opened while off is read");
    // a wrong follow is only a scheduled render when the frame is read, and no later step would show it
    // fixed wait: the selection gets the time to move before it is read
    await page.waitForTimeout(NO_FOLLOW_WAIT_MS);
    assert.equal(await selectedPaneId(), before, "a device that did not ask to follow herdr's focus keeps its pane");

    following = true;
    await follow(true);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const followed = await focusedTab("follow focus on");
    tabs.push(followed.tab.tab_id);
    await until(async () => await selectedPaneId() === followed.root_pane.pane_id, "the tab herdr brought to the front opens here");
    await until(async () => (await shownTab())?.includes("follow focus on") === true, "the new tab is the one shown");
    assert.equal(await selectedPaneId(), followed.root_pane.pane_id, "the followed pane stays selected once the roster lists it");

    await page.bringToFront();
    await page.locator(".xterm-helper-textarea").first().focus();
    assert.ok(await page.evaluate(() => document.hasFocus()), "this window is in front while typing");
    const typing = await focusedTab("follow focus typing");
    tabs.push(typing.tab.tab_id);
    await focusRead(typing.root_pane.pane_id, "herdr's focus frame for the tab opened while typing is read");
    assert.equal(await selectedPaneId(), followed.root_pane.pane_id, "herdr's focus does not take the view while this device types");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await page.locator('[aria-modal="true"]').first().waitFor();
    const dialog = await focusedTab("follow focus dialog");
    tabs.push(dialog.tab.tab_id);
    await focusRead(dialog.root_pane.pane_id, "herdr's focus frame for the tab opened under a dialog is read");
    assert.equal(await selectedPaneId(), followed.root_pane.pane_id, "herdr's focus does not take the view while a dialog is open here");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    const splitFrom = followed.root_pane.pane_id;
    let made: string | undefined;
    const answerHeld = new Promise<void>((resolve) => { releaseSplit = () => resolve(); });
    await page.route("**/api/pane/split", async (route) => {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const response = await route.fetch();
      made = ((await response.json()) as { pane: { pane_id: string } }).pane.pane_id;
      await answerHeld;
      await route.fulfill({ response });
    });
    await page.keyboard.press("ControlOrMeta+Shift+k");
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    await palette.getByRole("searchbox", { name: "Search panes and actions", exact: true }).fill("Split pane right and open it");
    await palette.getByRole("option", { name: "Split pane right and open it", exact: true }).click();
    await until(async () => made !== undefined, "herdr made the split");
    await focusRead(made!, "herdr's focus frame for the split is read");
    assert.equal(await selectedPaneId(), splitFrom, "herdr's frame for this device's own split is left to the split's answer");
    releaseSplit();
    await until(async () => await selectedPaneId() === made, "the split's answer opens its new pane");
    const keyboardIn = (paneId: string) => page.evaluate((paneId) => document.activeElement?.closest("[data-layout-pane]")?.getAttribute("data-layout-pane") === paneId, paneId);
    await until(() => keyboardIn(made!), "the keyboard is in the pane this device split off");
    await page.unroute("**/api/pane/split");
    await page.goBack();
    await until(async () => await selectedPaneId() === splitFrom && await keyboardIn(splitFrom), "Back opens the pane it was split from");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    await herdrRpc("pane.focus", { pane_id: before });
    await until(async () => await selectedPaneId() === before, "herdr's focus moving back brings this device back");
    await follow(false);
    following = false;
    console.log("PASS herdr's focus is followed only once this device asks for it, to a new tab and back, never while this device types or has a dialog open, and a split this device opens stays its own pick");
  } finally {
    await page.evaluate(() => { delete (window as unknown as { __rewriteMachinesFrame?: unknown }).__rewriteMachinesFrame; }).catch(() => undefined);
    releaseSplit();
    await page.unroute("**/api/pane/split").catch(() => undefined);
    for (const tab of tabs) await tabClose(tab).catch(() => undefined);
    if (following) await follow(false).catch(() => undefined);
  }
}
