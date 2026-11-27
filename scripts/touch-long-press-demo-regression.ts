import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// A long press on a pane on a touch screen is the phone's own (select text, copy): it does not
// open the pane menu. A right-click still does. On the unmodified app over the demo's fixture
// transport: no herdr session is opened.

/**
 * Fires a contextmenu on the chat as `pointerType` would, and says whether the page took it.
 * "legacy-touch": a browser whose contextmenu carries no pointer type, after a touch;
 * "keyboard": Shift+F10 after that touch, a contextmenu with no pointer type either;
 * "drag-select": Android Chrome after a dragged selection, a contextmenu typed "mouse" with no press of its own.
 */
const press = (page: Page, how: "touch" | "mouse" | "legacy-touch" | "keyboard" | "drag-select"): Promise<boolean> => page.locator(".pane-frame.is-current .pane-frame-body").evaluate((body, how) => {
  const target = body.querySelector(".chat-view, .terminal-stack") ?? body;
  const rect = target.getBoundingClientRect();
  const type = how === "mouse" ? "mouse" : "touch";
  const at = { bubbles: true, cancelable: true, composed: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 3, pointerType: type, isPrimary: true };
  target.dispatchEvent(new PointerEvent("pointerdown", { ...at, button: type === "mouse" ? 2 : 0, buttons: type === "mouse" ? 2 : 1 }));
  target.dispatchEvent(new PointerEvent("pointerup", { ...at, button: type === "mouse" ? 2 : 0, buttons: 0 }));
  if (how === "keyboard") target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, composed: true, key: "F10", shiftKey: true }));
  const event = how === "drag-select" ? new PointerEvent("contextmenu", { ...at, pointerType: "mouse", button: -1 })
    : how === "touch" || how === "mouse" ? new PointerEvent("contextmenu", { ...at, button: 2 }) : new MouseEvent("contextmenu", { ...at, button: 2 });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}, how);

await withDemoBrowser({ tempPrefix: "herdr-touch-long-press-demo-" }, async ({ newContext, baseUrl }) => {
  const context = await newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat" })));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.omp)}&view=chat`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".pane-frame.is-current").waitFor();
  const paneMenu = page.getByRole("dialog", { name: /^Pane actions for / });

  assert.equal(await press(page, "touch"), false, "a touch long press keeps the phone's own selection and copy");
  assert.equal(await press(page, "drag-select"), false, "the contextmenu typed mouse that ends a dragged selection is the touch's");
  await page.waitForTimeout(300); // fixed wait: a touch long press may open no pane menu
  assert.equal(await paneMenu.count(), 0, "a touch long press opens no pane menu");

  assert.equal(await press(page, "legacy-touch"), false, "a contextmenu with no pointer type right after a touch is the touch's");
  await page.waitForTimeout(300); // fixed wait: a legacy touch contextmenu may open no pane menu
  assert.equal(await paneMenu.count(), 0, "it opens no pane menu either");

  assert.equal(await press(page, "keyboard"), true, "a menu asked for from the keyboard after a touch is the app's");
  await paneMenu.waitFor();
  await page.keyboard.press("Escape");
  await paneMenu.waitFor({ state: "detached" });

  assert.equal(await press(page, "mouse"), true, "a right-click is still the app's");
  await paneMenu.waitFor();
  assert.deepEqual(errors, []);
  console.log("PASS a touch long press on a pane is the phone's own; the keyboard and a right-click still open the pane menu");
});
