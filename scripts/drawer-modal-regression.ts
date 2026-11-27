import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { appContext } from "./app-context.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { SHEET_HISTORY_KEY } from "../src/lib/historyKeys.ts";
import { SECOND_TAP_MS } from "../src/lib/useSidebarLayout.ts";

declare global {
  interface Window {
    toggleClicks: number[];
    nativeCalls: string[];
  }
}


const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ovis-drawer-modal-"));
const app = join(root, "app");
await buildDemoApp(app);
const index = (await Bun.file(join(app, "index.html")).text()).replace(
  '<script type="module"',
  '<script src="/demo-transport.js"></script><script type="module"',
);
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(index, { headers: { "content-type": "text/html" } });
  const file = Bun.file(join(app, path));
  return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
} });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] }).catch((error: unknown) => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
  throw error;
});
const openPane = async (page: Page): Promise<void> => {
  // Once the document commits, the pane's connection is the readiness signal.
  await page.goto(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=chat`, { waitUntil: "commit" });
  await page.locator(".conn-live").first().waitFor();
};
try {
  const context = await appContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // The demo returns its own socket class, so capture each instance before the app attaches.
  // This records real client input without sending anything to a user's terminal.
  await context.addInitScript(() => {
    const probe = { wheels: 0, ends: 0, claims: 0, inputs: [] as string[], holdReceipts: new URL(location.href).searchParams.has("drawer_receipt"), receipts: [] as unknown[], socket: null as unknown as WebSocket & { push(message: unknown): void } };
    Object.assign(window, { drawerInputProbe: probe });
    if (probe.holdReceipts) {
      let fetchDemo = window.fetch;
      Object.defineProperty(window, "fetch", { configurable: true, get: () => fetchDemo, set: (next: typeof fetch) => {
        fetchDemo = (async (input, init) => {
          const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
          if (url.pathname.endsWith("/pane/conversation")) return Response.json({ source: "scrollback", turns: [] });
          if (url.pathname.endsWith("/pane/read")) return Response.json({ read: {
            text: Array.from({ length: 160 }, (_, index) => `Receipt fixture line ${index}: a long transcript line above the latest output.`).join("\n"), truncated: false,
          } });
          return next.call(window, input, init);
        }) as typeof fetch;
      } });
    }
    let Constructor = window.WebSocket;
    Object.defineProperty(window, "WebSocket", { configurable: true, get: () => Constructor, set: (Demo: typeof WebSocket) => {
      Constructor = function (url: string | URL, protocols?: string | string[]) {
        const socket = new Demo(url, protocols);
        probe.socket = socket as typeof probe.socket;
        const push = probe.socket.push.bind(probe.socket);
        probe.socket.push = (message: unknown) => {
          if (probe.holdReceipts && (message as { type?: string }).type === "submit-result") probe.receipts.push(message);
          else push(message);
        };
        const send = socket.send.bind(socket);
        socket.send = (raw) => {
          if (typeof raw === "string") {
            try {
              const message = JSON.parse(raw) as { type?: string; text?: string };
              if (message.type === "input" && typeof message.text === "string") probe.inputs.push(message.text);
            } catch { /* binary terminal frames are not input messages */ }
          }
          return send(raw);
        };
        return socket;
      } as unknown as typeof WebSocket;
    } });
    document.addEventListener("wheel", (event) => { if (!event.isTrusted) probe.wheels++; }, { capture: true, passive: true });
    document.addEventListener("ovis:touch-stroke-claimed", () => probe.claims++, { capture: true, passive: true });
  });
  let page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await openPane(page);
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  let drawer = page.locator("#workspace-drawer");
  await drawer.waitFor({ state: "visible" });
  assert.equal(await drawer.getAttribute("role"), "dialog", "the phone drawer exposes dialog semantics");
  assert.equal(await drawer.getAttribute("aria-modal"), "true", "the trapped phone drawer is modal");
  const owned = (await drawer.getAttribute("aria-owns"))?.split(" ") ?? [];
  assert.deepEqual(owned, ["drawer-toggle"], "the open drawer owns the header's toggle");
  for (const id of owned) assert.equal(await page.locator(`.app-header #${id}`).count(), 1, `the owned ${id} is the header's own control`);
  assert.equal(await page.locator(".app-header .new-workspace-button").count(), 0, "the header draws no + over the open drawer");
  const mark = page.locator(".app-header #drawer-toggle");
  assert.deepEqual(await mark.evaluate((node) => [node.getAttribute("aria-label"), node.getAttribute("aria-expanded"), node.querySelector("img") !== null]),
    ["Close workspace list", "true", true], "the open drawer's head is the Ovis mark, the toggle that closes it, not a way into the inbox");
  assert.equal(await page.locator(".app-header").getByRole("button", { name: "Open agent inbox" }).count(), 0, "the header over the open drawer offers no inbox");
  const headTitle = page.locator(".app-header .drawer-head-title");
  const pcName = await page.evaluate(async () => ((await (await fetch("/api/machines")).json()) as { machines: { id: string; name: string }[] }).machines.find((machine) => machine.id === "local")?.name ?? null);
  assert.deepEqual([await page.locator(".app-header .context-title svg").count(), (await headTitle.locator(".context-title-text").textContent())?.trim()], [0, pcName],
    "the header over the open drawer names the PC, with no agent mark or pane name");
  assert.deepEqual(await drawer.locator(".sidebar-footer-row > button").evaluateAll((nodes) => nodes.map((node) => [node.className.split(" ").at(-1), node.getAttribute("aria-label")?.split(" \u00b7 ")[0] ?? null])),
    [["sidebar-footer-settings", "Settings"], ["sidebar-footer-inbox", "Inbox"]], "the drawer's foot holds the gear and Inbox beside it");
  const namedClose = drawer.getByRole("button", { name: "Close workspace list", exact: true });
  assert.equal(await namedClose.count(), 1, "the drawer holds a named close for a screen reader");
  assert.deepEqual(await drawer.locator(".sidebar-footer > *").evaluateAll((nodes) => nodes.filter((node) => node.getClientRects().length > 0).map((node) => node.className)),
    ["sidebar-footer-row"], "the drawer's foot is the gear's row alone");
  const ringless = () => page.evaluate(() => document.activeElement?.id === "workspace-drawer" && document.querySelector(":focus-visible:not(#workspace-drawer)") === null);
  assert.equal(await ringless(), true, "the opened drawer holds the focus itself, with no control's ring");
  assert.equal(await page.locator(".pane-column").getAttribute("inert"), "", "the pane behind the drawer is inert");
  const drawerButtons = drawer.locator("button:visible");
  assert.ok(await drawerButtons.count() > 0, "the drawer has focusable controls");
  await drawerButtons.last().focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => {
    const active = document.activeElement;
    return active !== null && (active.matches(".drawer-toggle") || active.closest("#workspace-drawer") !== null);
  }), true, "Tab stays within the drawer and the header's toggle");
  const closed = async (): Promise<void> => {
    await page.locator("#workspace-drawer:not(.is-open)").waitFor({ state: "attached" });
    await page.waitForFunction((key) => history.state?.[key] === undefined, SHEET_HISTORY_KEY, { timeout: 5_000 });
  };
  await page.keyboard.press("Escape");
  await closed();
  await page.getByRole("button", { name: "Open workspace list", exact: true }).waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a closed drawer is not modal");
  const openByTap = async (): Promise<void> => {
    await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await page.locator("#workspace-drawer.is-open").waitFor();
    await page.waitForFunction((key) => typeof (history.state as Record<string, unknown> | null)?.[key] === "string", SHEET_HISTORY_KEY, { timeout: 5_000 });
  };
  await openByTap();
  await page.touchscreen.tap(380, 420);
  await closed();
  const here = page.url();
  await openByTap();
  await page.goBack();
  await closed();
  assert.equal(page.url(), here, "Back closes the drawer and stays on the pane");
  await openByTap();
  for (let step = 0; step < 3 && !await namedClose.evaluate((node) => node === document.activeElement); step++) await page.keyboard.press("Tab");
  assert.ok(((await namedClose.boundingBox())?.width ?? 0) > 1, "the named close is drawn while the keyboard is on it");
  await page.keyboard.press("Enter");
  await closed();
  await page.waitForFunction(() => document.activeElement?.id === "drawer-toggle", undefined, { timeout: 5_000 });
  // modal or not, the drawer follows the finger: a swipe in from the left edge opens it, a swipe back closes it
  let cdp = await context.newCDPSession(page);
  // Closing a drawer schedules history.back(). A following goto on the same page can race
  // that traversal and abort. Each subsequent fixture gets its own page and history instead.
  // Keep the context so its init scripts and device settings still apply to every fixture.
  const openFixture = async (url: string): Promise<void> => {
    await page.close();
    page = await context.newPage();
    page.setDefaultTimeout(10_000);
    drawer = page.locator("#workspace-drawer");
    cdp = await context.newCDPSession(page);
    await page.goto(url);
  };
  const swipe = async (from: number, to: number, fromY = 420, toY = fromY, durationMs = 0): Promise<void> => {
    await page.waitForFunction(() => {
      const drawer = document.getElementById("workspace-drawer")!;
      const box = drawer.getBoundingClientRect();
      return drawer.classList.contains("is-open") ? box.left >= -0.5 : box.right <= 0.5;
    });
    const at = Date.now() / 1000;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from, y: fromY }], ...(durationMs ? { timestamp: at } : {}) });
    for (let step = 1; step <= 12; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from + ((to - from) * step) / 12, y: fromY + ((toY - fromY) * step) / 12 }], ...(durationMs ? { timestamp: at + durationMs * step / 12000 } : {}) });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], ...(durationMs ? { timestamp: at + (durationMs + 150) / 1000 } : {}) });
  };
  console.log("PASS modal focus checks");
  await swipe(6, 300);
  await page.locator("#workspace-drawer.is-open[aria-modal='true']").waitFor();
  assert.equal(await ringless(), true, "a drawer swiped open shows no control's focus ring");
  await swipe(300, 10);
  await closed();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a drawer swiped closed is not modal");
  assert.equal(await drawer.getAttribute("aria-owns"), null, "a closed drawer owns nothing of the header");
  // Observe the browser's real events after the drawer's capture listener: a claimed move is
  // cancelled before it reaches the pane. A diagonal stroke must remain the browser's to scroll.
  const observeMoves = () => page.evaluate(() => {
    const moves: { trusted: boolean; cancelled: boolean; drawerMoved: boolean; x: number }[] = [];
    Object.assign(window, { drawerTouchMoves: moves });
    document.addEventListener("touchmove", (event) => {
      moves.push({ trusted: event.isTrusted, cancelled: event.defaultPrevented, x: event.touches[0]?.clientX ?? 0,
        drawerMoved: (document.getElementById("workspace-drawer")?.style.transform ?? "") !== "" });
    }, { capture: true, passive: true });
  });
  await observeMoves();
  const moves = () => page.evaluate(() => (window as unknown as { drawerTouchMoves: { trusted: boolean; cancelled: boolean; drawerMoved: boolean; x: number }[] }).drawerTouchMoves.splice(0));
  console.log("PASS edge opening and closing");
  await swipe(170, 370);
  await page.locator("#workspace-drawer.is-open[aria-modal='true']").waitFor();
  assert.equal(await ringless(), true, "a drawer opened from mid-screen keeps its modal focus");
  const openingMoves = await moves();
  assert.ok(openingMoves.some((move) => move.trusted && move.drawerMoved), "a decided native interior swipe takes hold of the drawer");
  const undecidedMoves = openingMoves.filter((move) => move.x - 170 < 56);
  assert.ok(undecidedMoves.length > 0, "the browser delivered an interior move before the opening threshold");
  assert.ok(undecidedMoves.every((move) => !move.cancelled && !move.drawerMoved), "the undecided interior moves remain uncancelled");
  await swipe(300, 10);
  await page.locator("#workspace-drawer:not(.is-open)").waitFor({ state: "attached" });
  await moves();
  await page.waitForFunction(() => (document.querySelector(".chat-view")?.scrollTop ?? 0) > 0);
  const scrollBefore = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
  assert.ok(scrollBefore > 0, "the demo transcript has earlier content to scroll to");
  await page.waitForFunction(() => document.getElementById("workspace-drawer")!.getBoundingClientRect().right <= 0.5);
  // A flat first move must not steal a later vertical scroll (maintainer review point 1).
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 240 }] });
  for (const [x, y] of [[190, 242], [192, 300], [195, 360], [200, 430]] as const) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const turningMoves = await moves();
  assert.ok(turningMoves.some((move) => move.trusted), "the turning stroke produces native moves");
  assert.ok(turningMoves.every((move) => !move.cancelled && !move.drawerMoved), "a flat-to-vertical stroke never belongs to the drawer");
  await page.waitForFunction((before) => (document.querySelector(".chat-view")?.scrollTop ?? before) < before, scrollBefore);
  assert.equal(await drawer.getAttribute("aria-modal"), null, "the turning stroke leaves the drawer closed");
  await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const diagonalBefore = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
  await swipe(170, 240, 240, 420);
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a diagonal mid-screen stroke leaves the drawer closed");
  const diagonalMoves = await moves();
  assert.ok(diagonalMoves.some((move) => move.trusted), "the diagonal test dispatched native touch moves");
  assert.ok(diagonalMoves.every((move) => !move.cancelled), "a diagonal stroke is not cancelled by the drawer");
  await page.waitForFunction((before) => (document.querySelector(".chat-view")?.scrollTop ?? before) < before, diagonalBefore);
  console.log("PASS native direction changes and chat scrolling");
  // A delayed successful send receipt follows a scrollback chat with asynchronous smooth
  // scrolling. Once the touch ended, that automatic movement must not close the drawer.
  await openFixture(`http://127.0.0.1:${server.port}/?pane=w1J%3Ap1&view=chat&drawer_receipt=1`);
  await page.locator(".conn-live").first().waitFor();
  await page.locator(".chat-terminal-fallback > summary").click();
  await page.waitForFunction(() => document.querySelector(".chat-terminal-snapshot pre")?.textContent?.includes("Receipt fixture line 159"));
  await page.locator(".chat-view:not(.chat-view-virtual)").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.waitForFunction(() => (document.querySelector(".chat-view:not(.chat-view-virtual)")?.scrollTop ?? 0) > 0);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Drawer delayed receipt regression");
  await page.locator(".chat-view").evaluate((node) => {
    node.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
    node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  type ReceiptProbe = { holdReceipts: boolean; receipts: unknown[]; socket: { push(message: unknown): void } };
  await page.waitForFunction(() => (window as unknown as { drawerInputProbe: ReceiptProbe }).drawerInputProbe.receipts.length > 0);
  assert.equal(await page.evaluate(() => {
    const probe = (window as unknown as { drawerInputProbe: ReceiptProbe }).drawerInputProbe;
    return probe.receipts.every((message) => (message as { ok?: boolean; pending?: unknown }).ok === true && (message as { pending?: unknown }).pending === undefined);
  }), true, "the held receipt is a successful immediate send, not a queued message");
  const receiptBefore = await page.locator(".chat-view").evaluate((node) => {
    return { top: node.scrollTop, gap: node.scrollHeight - node.clientHeight - node.scrollTop };
  });
  assert.ok(receiptBefore.gap > 100, "the reader remains above the end before the receipt");
  await swipe(170, 300, 400);
  await page.locator("#workspace-drawer.is-open").waitFor();
  await page.evaluate(() => {
    const tops: number[] = [];
    Object.assign(window, { receiptScrollTops: tops });
    document.querySelector(".chat-view")!.addEventListener("scroll", (event) => tops.push((event.target as HTMLElement).scrollTop));
    const probe = (window as unknown as { drawerInputProbe: ReceiptProbe }).drawerInputProbe;
    probe.holdReceipts = false;
    for (const message of probe.receipts.splice(0)) probe.socket.push(message);
  });
  await page.waitForFunction(() => {
    const node = document.querySelector(".chat-view")!;
    return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
  });
  assert.ok(await page.locator(".chat-view").evaluate((node) => node.scrollTop) > receiptBefore.top, "the delayed receipt actually moved the scrollback chat to its end");
  assert.ok(await page.evaluate(() => new Set((window as unknown as { receiptScrollTops: number[] }).receiptScrollTops).size) > 1, "the receipt exercised asynchronous smooth-scroll updates");
  assert.equal(await drawer.getAttribute("aria-modal"), "true", "a late successful send receipt leaves the settled drawer open");
  console.log("PASS a late send receipt smoothly follows scrollback without closing the settled drawer");
  // A turn upward after the opening threshold belongs to the held drawer, not to native chat
  // scrolling. Start in the middle: at the end an unlocked upward stroke could not scroll either.
  for (const ending of ["touchEnd", "touchCancel"] as const) {
    await openFixture(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=chat`);
    await page.locator(".conn-live").first().waitFor();
    await page.waitForFunction(() => (document.querySelector(".chat-view")?.scrollTop ?? 0) > 0);
    await page.waitForFunction(() => document.getElementById("workspace-drawer")!.getBoundingClientRect().right <= 0.5);
    const original = await page.locator(".chat-view").evaluate((node) => {
      const style = (node as HTMLElement).style;
      style.overflow = "auto";
      style.setProperty("overflow-y", "scroll", "important");
      node.scrollTop = (node.scrollHeight - node.clientHeight) / 2;
      return ["overflow-x", "overflow-y"].map((property) => [style.getPropertyValue(property), style.getPropertyPriority(property)]);
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const before = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 420 }] });
    for (const x of [190, 220, 240]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 420 }] });
    await page.locator("#workspace-drawer.is-open").waitFor();
    assert.equal(await page.locator(".chat-view").evaluate((node) => getComputedStyle(node).overflowY), "hidden", "the claimed origin is locked before the upward turn");
    for (const [x, y] of [[245, 390], [250, 330], [260, 260]] as const) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    }
    assert.equal(await page.locator(".chat-view").evaluate((node) => node.scrollTop), before, "bending upward after 56px cannot scroll behind the held drawer");
    assert.equal(await drawer.getAttribute("aria-modal"), "true", "the held drawer does not disappear under the finger");
    await cdp.send("Input.dispatchTouchEvent", { type: ending, touchPoints: [] });
    assert.deepEqual(await page.locator(".chat-view").evaluate((node) => {
      const style = (node as HTMLElement).style;
      return ["overflow-x", "overflow-y"].map((property) => [style.getPropertyValue(property), style.getPropertyPriority(property)]);
    }), original, `${ending} restores the exact inline overflow values and priorities`);
    await page.locator("#workspace-drawer.is-open").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("workspace-drawer")!.getBoundingClientRect().right <= 0.5);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 500 }] });
    for (const y of [470, 420, 350, 280]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 170, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction((top) => document.querySelector(".chat-view")!.scrollTop > top, before);
    assert.equal(await drawer.getAttribute("aria-modal"), null, "after restoration an ordinary upward stroke scrolls instead of opening");
  }
  console.log("PASS claimed upward turns hold the drawer without scrolling; end/cancel restore scrolling");
  // Streaming auto-follow grows the scroll range and moves to its new end. That is not
  // a user scroll and must neither prevent nor undo the same interior opening.
  for (const committed of [false, true]) {
    // A fresh page prevents the preceding vertical control's momentum from entering this stroke.
    await openFixture(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=chat`);
    await page.locator(".conn-live").first().waitFor();
    await page.waitForFunction(() => (document.querySelector(".chat-view")?.scrollTop ?? 0) > 0);
    await page.waitForFunction(() => document.getElementById("workspace-drawer")!.getBoundingClientRect().right <= 0.5);
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 240 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 190, y: 240 }] });
    if (committed) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 240, y: 240 }] });
      await page.locator("#workspace-drawer.is-open").waitFor();
    }
    const oldRange = await page.locator(".chat-view").evaluate((node) => {
      const marker = document.createElement("div");
      marker.dataset.drawerGrowth = "";
      marker.style.cssText = `position:absolute;top:${node.scrollHeight + 64}px;left:0;width:1px;height:1px;pointer-events:none`;
      const previous = node.scrollHeight - node.clientHeight;
      node.appendChild(marker);
      node.dispatchEvent(new Event("ovis:layout-scroll-start", { bubbles: true }));
      node.scrollTop = node.scrollHeight;
      node.dispatchEvent(new Event("ovis:layout-scroll-end", { bubbles: true }));
      return previous;
    });
    await page.waitForFunction((before) => {
      const chat = document.querySelector(".chat-view")!;
      return chat.scrollHeight - chat.clientHeight > before && chat.scrollTop >= chat.scrollHeight - chat.clientHeight - 1;
    }, oldRange);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 270, y: 240 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.locator("#workspace-drawer.is-open").waitFor();
    await page.keyboard.press("Escape");
    await page.locator("[data-drawer-growth]").evaluate((node) => node.remove());
  }
  console.log("PASS transcript range changes during the stroke");
  // Deterministic scroll-race checks: inject the compositor's scroll between native touch
  // moves. These complement native scrolling above; they do not claim to reproduce Safari.
  for (const phase of ["early", "held", "released"] as const) {
    const late = phase !== "early";
    // A fresh page prevents the preceding vertical control's momentum from entering this stroke.
    await openFixture(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=chat`);
    await page.locator(".conn-live").first().waitFor();
    await page.waitForFunction(() => (document.querySelector(".chat-view")?.scrollTop ?? 0) > 0);
    await page.waitForFunction(() => document.getElementById("workspace-drawer")!.getBoundingClientRect().right <= 0.5);
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 240 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 190, y: 242 }] });
    if (late) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 240, y: 250 }] });
      await page.locator("#workspace-drawer.is-open").waitFor();
    }
    if (phase === "released") await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const previous = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop -= 10; });
    await page.waitForFunction((before) => document.querySelector(".chat-view")!.scrollTop < before, previous);
    if (phase !== "released") {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 270, y: 260 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    }
    if (phase === "released") {
      await page.locator("#workspace-drawer.is-open").waitFor();
      assert.equal(await drawer.getAttribute("aria-modal"), "true", "post-lift automatic scrolling is outside the ended touch stroke");
      await page.keyboard.press("Escape");
    } else {
      await page.locator("#workspace-drawer:not(.is-open)").waitFor({ state: "attached" });
    }
    assert.equal(await drawer.evaluate((node) => (node as HTMLElement).style.transform), "", `${phase} scrolling releases the finger's inline transform`);
  }
  // Exercise the real conversation fetch -> React -> measured list -> automatic follow path.
  // Each update grows the same assistant row while native CDP touches remain down.
  for (const vertical of [false, true]) {
    await openFixture(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=chat`);
    await page.locator(".conn-live").first().waitFor();
    await page.waitForFunction(() => document.getElementById("workspace-drawer")!.getBoundingClientRect().right <= 0.5);
    await page.evaluate(() => {
      const original = window.fetch;
      const stream = { ticks: 1, timer: 0 };
      Object.assign(window, { drawerStream: stream });
      window.fetch = (async (input, init) => {
        const response = await original(input, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (!new URL(url, location.href).pathname.endsWith("/pane/conversation")) return response;
        const body = await response.json() as { turns: unknown[] };
        body.turns.push({ role: "assistant", ts: "2026-11-15T00:00:00Z", parts: [{ kind: "text", phase: "final_answer",
          text: Array.from({ length: 25 + stream.ticks }, (_, index) => `Drawer streaming fixture line ${index}`).join("\n\n") }] });
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const tick = () => {
        stream.ticks++;
        (window as unknown as { drawerInputProbe: { socket: { push(message: unknown): void } } }).drawerInputProbe.socket.push({
          type: "conversation-changed", pane_id: "w1C:p1", signature: `drawer-stream:${stream.ticks}`,
        });
      };
      tick();
      stream.timer = window.setInterval(tick, 50);
    });
    await page.getByText("Drawer streaming fixture line 0", { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const node = document.querySelector(".chat-view")!;
      return node.scrollTop > 0 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
    });
    const before = await page.locator(".chat-view").evaluate((node) => ({ top: node.scrollTop, height: node.scrollHeight }));
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 400 }] });
    for (const [x, y] of vertical ? ([[190, 402], [192, 465], [195, 530], [200, 590]] as const) : ([[190, 400], [220, 400], [260, 400], [300, 400]] as const)) {
      const tick = await page.evaluate(() => (window as unknown as { drawerStream: { ticks: number } }).drawerStream.ticks);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
      await page.waitForFunction((beforeTick) => (window as unknown as { drawerStream: { ticks: number } }).drawerStream.ticks > beforeTick, tick);
    }
    if (!vertical) {
      await page.locator("#workspace-drawer.is-open").waitFor();
      // More measured-row updates after ownership changes must not close the held drawer.
      const tick = await page.evaluate(() => (window as unknown as { drawerStream: { ticks: number } }).drawerStream.ticks);
      await page.waitForFunction((beforeTick) => (window as unknown as { drawerStream: { ticks: number } }).drawerStream.ticks >= beforeTick + 3, tick);
    }
    if (!vertical) await page.waitForFunction((height) => document.querySelector(".chat-view")!.scrollHeight > height, before.height);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    console.log("PASS streaming observed", { vertical, before, after: await page.locator(".chat-view").evaluate(node => ({top:node.scrollTop,height:node.scrollHeight})), ticks: await page.evaluate(() => (window as unknown as {drawerStream:{ticks:number}}).drawerStream.ticks) });
    await page.evaluate(() => clearInterval((window as unknown as { drawerStream: { timer: number } }).drawerStream.timer));
    if (vertical) {
      await page.waitForFunction((top) => document.querySelector(".chat-view")!.scrollTop < top, before.top);
      assert.equal(await drawer.getAttribute("aria-modal"), null, "a real reader scroll still wins during streaming");
    } else {
      await page.locator("#workspace-drawer.is-open").waitFor();
      assert.ok(await page.locator(".chat-view").evaluate((node) => node.scrollHeight) > before.height, "the real assistant row grew while the drawer opened");
      await page.keyboard.press("Escape");
    }
  }
  console.log("PASS real streaming row growth preserves opening; native reader scrolling still wins");
  await observeMoves();
  await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector("#workspace-drawer")?.getBoundingClientRect().left ?? -1) >= -0.5);
  const divider = page.getByRole("separator", { name: "Resize PCs and Agents", exact: true });
  const box = await divider.boundingBox();
  assert.ok(box, "the real sidebar split divider is visible");
  await moves();
  await swipe(box.x + box.width - 20, box.x + 20, box.y + box.height / 2);
  await page.locator("#workspace-drawer:not(.is-open)").waitFor({ state: "attached" });
  assert.equal(await drawer.getAttribute("aria-modal"), null, "a leftward swipe from the divider closes an open drawer");
  const dividerMoves = await moves();
  assert.ok(dividerMoves.some((move) => move.trusted && move.drawerMoved), "the open drawer still follows a divider-started closing swipe");
  await page.waitForFunction(() => (document.querySelector("#workspace-drawer")?.getBoundingClientRect().right ?? 1) <= 0.5);
  await swipe(300, 380, 420, 420, 600);
  await page.locator("#workspace-drawer.is-open[aria-modal='true']").waitFor();
  await page.waitForFunction(() => (document.querySelector("#workspace-drawer")?.getBoundingClientRect().left ?? -1) >= -0.5);
  assert.equal(await drawer.getAttribute("aria-modal"), "true", "a slow short swipe from the right half stays open after release");
  await page.keyboard.press("Escape");
  await page.locator("#workspace-drawer:not(.is-open)").waitFor({ state: "attached" });
  await page.waitForFunction(() => document.getElementById("workspace-drawer")!.getBoundingClientRect().right <= 0.5);
  // A diagonal drift before interior ownership must not become a terminal wheel on lift.
  // Enable SGR mouse reporting in the fixture so the actual input path is observable too.
  type InputProbe = { wheels: number; ends: number; claims: number; inputs: string[]; socket: { push(message: unknown): void } };
  const inputProbe = () => page.evaluate(() => {
    const p = (window as unknown as { drawerInputProbe: InputProbe }).drawerInputProbe;
    return { wheels: p.wheels, ends: p.ends, claims: p.claims, inputs: [...p.inputs] };
  });
  for (const ending of ["touchEnd", "touchCancel"] as const) {
    await openFixture(`http://127.0.0.1:${server.port}/?pane=w1C%3Ap1&view=terminal`);
    await page.waitForFunction(() => {
      const host = document.querySelector(".pane-terminal") as HTMLElement & { outputProbe?(): { writes: number } };
      return host?.outputProbe?.().writes;
    });
    await page.waitForFunction(() => document.getElementById("workspace-drawer")!.getBoundingClientRect().right <= 0.5);
    await page.evaluate(() => {
      const p = (window as unknown as { drawerInputProbe: InputProbe }).drawerInputProbe;
      p.socket.push({ type: "pty-data", pane_id: "w1C:p1", data: "\x1b[?1000h\x1b[?1006h" });
      document.querySelector(".pane-terminal")!.addEventListener("touchend", () => p.ends++, { capture: true, passive: true });
      document.querySelector(".pane-terminal")!.addEventListener("touchcancel", () => p.ends++, { capture: true, passive: true });
    });
    await page.waitForFunction(() => {
      const host = document.querySelector(".pane-terminal") as HTMLElement & { outputProbe(): { inFlight: number; written: string } };
      const p = host.outputProbe();
      return p.inFlight === 0 && p.written.includes("\x1b[?1006h");
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 400 }] });
    for (const [x, y] of [[190, 410], [210, 420], [224, 426], [240, 432], [280, 436], [320, 440]] as const) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    }
    await page.locator("#workspace-drawer.is-open").waitFor();
    assert.equal((await inputProbe()).wheels, 0, `${ending}: no pending wheel before lift`);
    await cdp.send("Input.dispatchTouchEvent", { type: ending, touchPoints: [] });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const claimed = await inputProbe();
    assert.equal(claimed.claims, 1, `${ending}: exactly one ownership handoff`);
    assert.equal(claimed.ends, 1, `${ending}: terminal still receives the ending for cleanup`);
    assert.equal(claimed.wheels, 0, `${ending}: no wheel escapes after ownership changes`);
    assert.deepEqual(claimed.inputs, [], `${ending}: no input reaches the fixture TUI`);
    assert.equal(await page.locator(".pane-terminal").evaluate((node) => node.hasAttribute("data-touch-fling")), false, "a claimed drawer stroke never starts the terminal's glide");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => (document.querySelector("#workspace-drawer")?.getBoundingClientRect().right ?? 1) <= 0.5);
    // Positive control: the next ordinary vertical stroke must still send terminal wheels.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 170, y: 240 }] });
    for (const y of [270, 300, 330, 360]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 170, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForFunction(() => (window as unknown as { drawerInputProbe: InputProbe }).drawerInputProbe.wheels > 0);
    assert.ok((await inputProbe()).inputs.some((text) => /\x1b\[<6[45];/.test(text)), "the next vertical stroke still sends a TUI mouse wheel");
    assert.equal(await drawer.getAttribute("aria-modal"), null, "ordinary vertical scrolling never opens the drawer");
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 150, y: 400, id: 1 }, { x: 210, y: 400, id: 2 }] });
  // A positive control may still glide before this new touch. Measure only after touchdown stops it.
  const beforePinch = await inputProbe();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 130, y: 400, id: 1 }, { x: 230, y: 400, id: 2 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize > 13);
  const afterPinch = await inputProbe();
  assert.equal(afterPinch.wheels, beforePinch.wheels, "pinch still finishes without a wheel");
  assert.equal(afterPinch.claims, beforePinch.claims, "the drawer never owns a pinch");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator("#workspace-drawer:not([role])").waitFor();
  assert.equal(await drawer.getAttribute("aria-modal"), null, "the desktop sidebar is not modal");
  await context.close();
  console.log("PASS phone drawer is a modal focus-trapped surface; interior swipes wait for direction, flat-to-vertical strokes scroll, divider-started closing and slow right-half opening work");
  console.log("PASS phone drawer is a modal focus-trapped surface, headed by the Ovis mark and the PC's name with Inbox beside the gear at its foot, closed by a tap outside, a swipe, Back, Escape and its named close");

  {
    const guarded = await appContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await guarded.newPage();
    await openPane(page);
    await page.evaluate((limit) => {
      window.toggleClicks = [];
      const first = 1_000;
      document.addEventListener("click", (event) => {
        if (!(event.target instanceof Element) || !event.target.closest("#drawer-toggle")) return;
        // Keep the taps real; fix the timestamps seen by the guard independently of browser load.
        const at = first + ([0, limit - 1, limit][window.toggleClicks.length] ?? limit);
        Object.defineProperty(event, "timeStamp", { value: at });
        window.toggleClicks.push(at);
      }, true);
    }, SECOND_TAP_MS);
    const toggle = page.locator(".app-header #drawer-toggle");
    await toggle.tap();
    await page.locator("#workspace-drawer.is-open").waitFor();
    await toggle.tap();
    await page.waitForFunction(() => window.toggleClicks.length === 2);
    const [opened, second] = await page.evaluate(() => window.toggleClicks) as [number, number];
    // the click's own handlers ran in its dispatch; the render a way in would cause is drawn by the next frame
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.ok(second - opened < SECOND_TAP_MS, `the two taps landed ${Math.round(second - opened)} ms apart, not a double tap: the guard was not exercised`);
    assert.equal(await page.locator("#workspace-drawer.is-open").count(), 1, `the second tap of a double tap (${Math.round(second - opened)} ms apart) on the mark's spot leaves the drawer open`);
    await toggle.tap();
    await page.locator("#workspace-drawer:not(.is-open)").waitFor({ state: "attached" });
    assert.equal(await page.locator(".mode-inbox").count(), 0, "a tap on the mark past the double tap closes the drawer and opens no inbox");
    await toggle.tap();
    await page.locator("#workspace-drawer.is-open .sidebar-footer-inbox").tap();
    await page.locator(".mode-inbox").waitFor();
    assert.equal(new URL(page.url()).searchParams.get("app"), "inbox", "Inbox beside the drawer's gear opens the agent inbox");
    await guarded.close();
    console.log(`PASS a double tap on the menu button (${Math.round(second - opened)} ms apart) opens the drawer and keeps it open; the mark closes it after ${SECOND_TAP_MS} ms, and Inbox at the drawer's foot opens the inbox`);
  }

  {
    const app = await appContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await app.addInitScript(() => {
      window.nativeCalls = [];
      (window as unknown as { Capacitor: unknown }).Capacitor = {
        isNativePlatform: () => true, getPlatform: () => "ios",
        nativePromise: async (plugin: string, method: string) => { window.nativeCalls.push(`${plugin}.${method}`); return {}; },
      };
    });
    const page = await app.newPage();
    await openPane(page);
    await page.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await page.locator("#workspace-drawer.is-open").waitFor();
    assert.equal(await page.locator("#workspace-drawer .sidebar-footer-pc").count(), 0, "a phone's drawer has no Change PC row");
    await page.locator("#workspace-drawer .sidebar-footer-settings").tap();
    await page.locator(".settings-dialog .settings-tabs").waitFor();
    assert.equal(await page.getByRole("button", { name: "Change PC", exact: true }).count(), 0, "Settings' list has no Change PC: the sidebar lists every PC");
    const tablet = await app.newPage();
    await tablet.setViewportSize({ width: 700, height: 1000 });
    await openPane(tablet);
    await tablet.getByRole("button", { name: "Open workspace list", exact: true }).tap();
    await tablet.locator("#workspace-drawer.is-open").waitFor();
    assert.equal(await tablet.locator("#workspace-drawer .sidebar-footer-pc").count(), 0, "at 700px the drawer has no Change PC row");
    const wide = await app.newPage();
    await wide.setViewportSize({ width: 1440, height: 900 });
    await openPane(wide);
    await wide.locator("#workspace-drawer .sidebar-footer-settings").waitFor();
    assert.equal(await wide.locator("#workspace-drawer .sidebar-footer-pc").count(), 0, "a wide window has no Change PC row either");
    await app.close();
    console.log("PASS in the phone app the sidebar's foot is the gear alone and Settings' list ends without Change PC, at 390, 700 and 1440: the sidebar lists every PC");
  }
} finally {
  await browser.close();
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
}
