/**
 * Settings → Terminal → Follow herdr's focus (#311) against a real herdr: a tab herdr opens and
 * brings to the front by itself (`herdr tab create --focus`, as a script does) is opened here only
 * once this device asked for it, and herdr's focus moving back brings this device back too. It
 * never takes the view while this window is in front and someone types into it or has a dialog
 * open, and a split this device opens itself stays its own pick when herdr's frame for it comes
 * first (#1470). Imported by ui-regression.ts, with Settings closed; it ends on the pane selected
 * when it began and with the setting off, also when it fails.
 */
import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { herdrRpc, tabClose } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

export interface FollowFocusFixture {
  /** a workspace to open the check's tabs in: they are closed again, its own panes are left alone */
  workspaceId: string;
}

/** how long a focus change that must not move the selection gets to move it */
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
    // Settings may still be open when a check that stopped partway turns the setting back off
    if (!(await page.locator(".settings-dialog").isVisible())) await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Terminal");
    // "herdr window": Follow its focus, or Separate to leave herdr's focus alone
    const choice = page.getByRole("group", { name: "herdr window", exact: true }).getByRole("button", { name: on ? "Follow its focus" : "Separate", exact: true });
    if ((await choice.getAttribute("aria-pressed")) !== "true") await choice.click();
    assert.equal(await choice.getAttribute("aria-pressed"), "true");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  // `herdr tab create --focus`: herdr opens the tab and moves its own focus there, past this app
  const focusedTab = (label: string) => herdrRpc<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>(
    "tab.create", { workspace_id: fixture.workspaceId, label, focus: true });

  // the tab herdr opened is listed here: its pane-focused frame, sent before that, has been handled
  const listed = (label: string) => page.locator(".tab-strip").getByRole("tab").filter({ hasText: label }).first().waitFor();

  const before = await selectedPaneId();
  assert.ok(before, "a pane is selected before the check");
  const tabs: string[] = [];
  let following = false;
  let releaseSplit = (): void => undefined;
  try {
    // off, as it starts: herdr's focus is herdr's, and this device stays where it is
    const ignored = await focusedTab("follow focus off");
    tabs.push(ignored.tab.tab_id);
    // fixed wait: proving that the selection does not move
    await page.waitForTimeout(NO_FOLLOW_WAIT_MS);
    assert.equal(await selectedPaneId(), before, "a device that did not ask to follow herdr's focus keeps its pane");

    // the cleanup below owns the setting from here on, even if turning it on stops halfway
    following = true;
    await follow(true);
    // nobody types here: Settings handed the keyboard back to the terminal, and a terminal with the
    // keyboard in a window in front is someone at it (#1470)
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const followed = await focusedTab("follow focus on");
    tabs.push(followed.tab.tab_id);
    await until(async () => await selectedPaneId() === followed.root_pane.pane_id, "the tab herdr brought to the front opens here");
    // a pane the roster had not listed yet stays open once it does, its tab the one shown
    await until(async () => (await shownTab())?.includes("follow focus on") === true, "the new tab is the one shown");
    assert.equal(await selectedPaneId(), followed.root_pane.pane_id, "the followed pane stays selected once the roster lists it");

    // typing here: herdr's focus moving elsewhere leaves this device's pane, keyboard and all
    await page.bringToFront();
    await page.locator(".xterm-helper-textarea").first().focus();
    assert.ok(await page.evaluate(() => document.hasFocus()), "this window is in front while typing");
    const typing = await focusedTab("follow focus typing");
    tabs.push(typing.tab.tab_id);
    await listed("follow focus typing");
    assert.equal(await selectedPaneId(), followed.root_pane.pane_id, "herdr's focus does not take the view while this device types");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // a dialog open here: the same
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await page.locator('[aria-modal="true"]').first().waitFor();
    const dialog = await focusedTab("follow focus dialog");
    tabs.push(dialog.tab.tab_id);
    await listed("follow focus dialog");
    assert.equal(await selectedPaneId(), followed.root_pane.pane_id, "herdr's focus does not take the view while a dialog is open here");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // a split this device opens itself: herdr's frame for the new pane comes before the split's
    // answer, held here until that frame has been handled. The pane is still this device's own pick,
    // with the keyboard in it and a Back entry to the pane it was split from
    const splitFrom = followed.root_pane.pane_id;
    let made: string | undefined;
    const answerHeld = new Promise<void>((resolve) => { releaseSplit = () => resolve(); });
    await page.route("**/api/pane/split", async (route) => {
      // nobody types here and no dialog is open when herdr's frame comes
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
    // a tab made after the split is listed here: herdr's frame for the split, sent before it, has been handled
    const marker = await herdrRpc<{ tab: { tab_id: string } }>("tab.create", { workspace_id: fixture.workspaceId, label: "follow focus split marker", focus: false });
    tabs.push(marker.tab.tab_id);
    await listed("follow focus split marker");
    assert.equal(await selectedPaneId(), splitFrom, "herdr's frame for this device's own split is left to the split's answer");
    releaseSplit();
    await until(async () => await selectedPaneId() === made, "the split's answer opens its new pane");
    const keyboardIn = (paneId: string) => page.evaluate((paneId) => document.activeElement?.closest("[data-layout-pane]")?.getAttribute("data-layout-pane") === paneId, paneId);
    await until(() => keyboardIn(made!), "the keyboard is in the pane this device split off");
    await page.unroute("**/api/pane/split");
    await page.goBack();
    await until(async () => await selectedPaneId() === splitFrom && await keyboardIn(splitFrom), "Back opens the pane it was split from");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // herdr's focus goes back where this device was: so does this device
    await herdrRpc("pane.focus", { pane_id: before });
    await until(async () => await selectedPaneId() === before, "herdr's focus moving back brings this device back");
    await follow(false);
    following = false;
    console.log("PASS herdr's focus is followed only once this device asks for it, to a new tab and back, never while this device types or has a dialog open, and a split this device opens stays its own pick");
  } finally {
    releaseSplit();
    await page.unroute("**/api/pane/split").catch(() => undefined);
    for (const tab of tabs) await tabClose(tab).catch(() => undefined);
    // a check that stopped partway leaves the setting as it found it, for the checks after it
    if (following) await follow(false).catch(() => undefined);
  }
}
