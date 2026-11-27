import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";
import { appFaces } from "./app-faces.ts";
import { shownRows } from "./shown-rows.ts";
import { FLING_STOPPED_MS } from "../src/lib/touchFling.ts";

interface Frame { type: string; pane_id?: string; text?: string; mode?: string }
interface MirrorFixture {
  inputs: Frame[];
  offsets: number[];
  reads: number;
  offset: number;
  sockets: Array<WebSocket & { push(frame: Record<string, unknown>): void }>;
}
declare global { interface Window { mirrorFixture: MirrorFixture } }
type FixtureWindow = Window;

function installMirrorFixture(): void {
  const state: MirrorFixture = { inputs: [], offsets: [], reads: 0, offset: 0, sockets: [] };
  (window as FixtureWindow).mirrorFixture = state;
  const nativeHistory = new URL(location.href).searchParams.get("history") === "native";
  const max = nativeHistory ? 200 : 0;
  const fetchDemo = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.pathname !== "/api/pane/scroll") return fetchDemo(input, init);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { offset_from_bottom: number };
      state.offset = Math.max(0, Math.min(max, body.offset_from_bottom));
      state.offsets.push(state.offset);
    } else state.reads++;
    return new Response(JSON.stringify({ scroll: { offset_from_bottom: state.offset, max_offset_from_bottom: max, viewport_rows: 40 } }), { headers: { "content-type": "application/json" } });
  }) as typeof window.fetch;
  const Demo = window.WebSocket;
  const Recorded = function (url: string | URL, protocols?: string | string[]) {
    const socket = new Demo(url, protocols) as MirrorFixture["sockets"][number];
    state.sockets.push(socket);
    const push = socket.push.bind(socket);
    socket.push = (frame) => {
      if (frame.type === "pane-geometry") push({ ...frame, fixed: true });
      else if (frame.type === "pty-data" && typeof frame.data === "string") {
        if (frame.fixture !== "mirror") return;
        const { fixture: _, ...output } = frame;
        push({ ...output, data: frame.data.replace(/\x1b\[\?(?:1000|1002|1003|1006)[hl]/g, "") });
      }
      else push(frame);
    };
    const send = socket.send.bind(socket);
    socket.send = (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (["input", "keys", "submit"].includes(frame.type)) state.inputs.push(frame);
      send(raw);
      if (frame.type === "attach") {
        socket.push({ type: "pane-geometry", pane_id: frame.pane_id, cols: 120, rows: 40, fixed: true });
        socket.push({ type: "pty-data", fixture: "mirror", pane_id: frame.pane_id, data: "\x1b[2J\x1b[HMirror transcript fixture\r\n" });
      }
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"] as const) Object.defineProperty(Recorded, name, { value: Demo[name] });
  window.WebSocket = Recorded as unknown as typeof WebSocket;
}

const settled = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
const state = (page: Page) => page.evaluate(() => {
  const { inputs, offsets, reads, offset } = (window as FixtureWindow).mirrorFixture;
  return { inputs, offsets, reads, offset };
});

await withDemoBrowser({ tempPrefix: "herdr-mirror-scroll-demo-", afterTransport: `\n<script>(${installMirrorFixture.toString()})()</script>` }, async ({ newContext, baseUrl }) => {
  for (const kind of ["native", "pi", "other"] as const) {
    const pane = kind === "pi" ? panes.cli : kind === "native" ? panes.shell : panes.web;
    const context = await newContext({ viewport: { width: 1280, height: 1000 }, hasTouch: true });
    try {
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", terminalInputMode: "direct", terminalWheelSpeed: 2, alertsOn: false })));
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const waitForStep = async (step: string, action: () => Promise<unknown>): Promise<void> => {
        try { await action(); }
        catch (cause) {
          const diagnosticsMs = 1000;
          let timer: ReturnType<typeof setTimeout> | undefined;
          // This deadline runs outside the renderer: the timed-out page may not answer.
          const deadline = new Promise<string>((resolve) => {
            timer = setTimeout(() => resolve(`unavailable (page did not answer within ${diagnosticsMs} ms)`), diagnosticsMs);
          });
          const snapshot = page.evaluate(() => {
            const fixture = window.mirrorFixture;
            return {
              connected: !!document.querySelector(".conn-live"),
              viewport: { width: innerWidth, height: innerHeight },
              fonts: { status: document.fonts.status, loaded: [...document.fonts].filter(face => face.status === "loaded").map(face => face.family) },
              drawer: { open: document.getElementById("workspace-drawer")?.classList.contains("is-open"), modal: document.getElementById("workspace-drawer")?.getAttribute("aria-modal") },
              fixture: fixture ? { reads: fixture.reads, offset: fixture.offset, offsets: fixture.offsets, inputs: fixture.inputs,
                sockets: fixture.sockets.map(socket => ({ readyState: socket.readyState, url: socket.url })) } : null,
              panes: [...document.querySelectorAll<HTMLElement>(".pane-terminal")].map(host => ({
                pane: host.closest("[data-layout-pane]")?.getAttribute("data-layout-pane"),
                current: !!host.closest(".pane-frame.is-current"),
                adopted: host.hasAttribute("data-adopted-grid"),
                overflow: { x: getComputedStyle(host).overflowX, y: getComputedStyle(host).overflowY, inlineX: host.style.overflowX, inlineY: host.style.overflowY },
                inert: host.closest("[inert]") !== null,
                wheelHit: (() => {
                  const box = host.getBoundingClientRect();
                  const hit = document.elementFromPoint(box.x + box.width / 2, box.y + 100);
                  return { inside: hit !== null && host.contains(hit), tag: hit?.tagName, className: hit?.className };
                })(),
                scrollTop: host.scrollTop, scrollLeft: host.scrollLeft,
                scrollHeight: host.scrollHeight, clientHeight: host.clientHeight,
                localPanStart: host.textContent?.includes("LOCAL-PAN-START"),
                localPanChanged: host.textContent?.includes("LOCAL-PAN-CHANGED"),
              })),
            };
          }).then(value => JSON.stringify(value))
            .catch(error => JSON.stringify({ diagnosticsError: error instanceof Error ? error.message : String(error) }));
          const observed = await Promise.race([snapshot, deadline]).finally(() => clearTimeout(timer));
          const error = new Error(
            `${kind}: ${step}: ${cause instanceof Error ? cause.message : String(cause)}; observed=${observed}`,
            { cause },
          );
          // The browser lane recognizes TimeoutError when extracting its failure summary.
          if (cause instanceof Error) error.name = cause.name;
          throw error;
        }
      };
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(pane)}&view=terminal&history=${kind}`);
      await waitForStep("connection live", () => page.locator(".conn-live").waitFor());
      await waitForStep("app fonts loaded", () => appFaces(page));
      await waitForStep("initial scroll metrics read", () => page.waitForFunction(() => (window as FixtureWindow).mirrorFixture.reads > 0));
      await waitForStep("fixed grid adopted", () => page.locator(".pane-frame.is-current .pane-terminal[data-adopted-grid]").waitFor());
      await settled(page);
      const terminal = page.locator(".pane-frame.is-current .pane-terminal");
      const box = await terminal.boundingBox();
      assert.ok(box);
      // the 40-row grid must fit its pane here, or the wheel pans it locally instead (taller fonts need the height)
      assert.ok(await terminal.evaluate((node) => node.scrollHeight <= node.clientHeight + 1), "the desktop grid fits its pane");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
      await page.mouse.wheel(0, -120);
      if (kind === "native") {
        await waitForStep("native wheel up reaches offset 6", () => page.waitForFunction(() => (window as FixtureWindow).mirrorFixture.offset === 6));
        assert.deepEqual((await state(page)).inputs, [], "native history never sends typing");
        await page.mouse.wheel(0, 120);
        await waitForStep("native wheel down reaches offset 0", () => page.waitForFunction(() => (window as FixtureWindow).mirrorFixture.offset === 0));
      } else {
        // a mirror carries no mouse modes: nothing says the program reads wheel reports, Pi's included
        await settled(page);
        assert.deepEqual((await state(page)).inputs, [], `${kind}: a program's own screen receives no guessed input`);
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await settled(page);
      const phoneBox = await terminal.boundingBox();
      assert.ok(phoneBox);
      const beforeTouch = await state(page);
      const cdp = await context.newCDPSession(page);
      const x = phoneBox.x + phoneBox.width / 2, y = phoneBox.y + phoneBox.height / 3;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 150 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      if (kind === "native") {
        await waitForStep(`native phone touch increases offset from ${beforeTouch.offset}`, () => page.waitForFunction((offset) => (window as FixtureWindow).mirrorFixture.offset > offset, beforeTouch.offset));
        assert.ok((await state(page)).offset > beforeTouch.offset, "positive vertical touch still scrolls native history");
        assert.deepEqual((await state(page)).inputs, beforeTouch.inputs, "touch on native history never sends typing");
      } else {
        await settled(page);
        assert.deepEqual((await state(page)).inputs, [], "touch also leaves unknown applications alone");
      }
      await page.waitForFunction(() => document.querySelector("[data-touch-fling]") === null, undefined, { polling: 50, timeout: 15_000 });
      await settled(page);

      const touchGesture = async (dx: number, dy: number): Promise<void> => {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        if (dx !== 0 || dy !== 0) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + dx, y: y + dy }] });
          const moved = await page.evaluate(() => performance.now());
          await page.waitForFunction(([at, still]) => performance.now() - at > still, [moved, FLING_STOPPED_MS * 2] as const, { polling: 10 });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await settled(page);
      };
      const assertNoTouchScroll = async (dx: number, dy: number, label: string): Promise<void> => {
        const before = await state(page);
        await touchGesture(dx, dy);
        const after = await state(page);
        assert.deepEqual(after.offsets, before.offsets, `${label} sends no scroll POST`);
        assert.deepEqual(after.inputs, before.inputs, `${label} sends no application input`);
      };
      const shortMove = await terminal.evaluate((node) => node.querySelector<HTMLElement>(".xterm-screen")!.getBoundingClientRect().height / 40 * 1.5 - 1);
      assert.ok(shortMove > 0, "the touch fixture has a measurable sub-half-step drag");
      await assertNoTouchScroll(0, 0, "unmoved touch");
      const originalOverflow = await terminal.evaluate((node) => ["overflow-x", "overflow-y"].map((property) => [
        (node as HTMLElement).style.getPropertyValue(property), (node as HTMLElement).style.getPropertyPriority(property),
      ]));
      await assertNoTouchScroll(80, 0, "horizontal swipe");
      // Interior horizontal strokes now open the phone drawer. Finish that independent
      // gesture before testing terminal pans: an open modal correctly makes its pane inert.
      assert.equal(await page.locator("#workspace-drawer").getAttribute("aria-modal"), "true", "the horizontal stroke opens the phone drawer without terminal input");
      assert.deepEqual(await terminal.evaluate((node) => ["overflow-x", "overflow-y"].map((property) => [
        (node as HTMLElement).style.getPropertyValue(property), (node as HTMLElement).style.getPropertyPriority(property),
      ])), originalOverflow, "lifting the drawer stroke restores the terminal's inline overflow");
      await page.keyboard.press("Escape");
      await waitForStep("horizontal drawer closed before terminal pans", () => page.waitForFunction(() => {
        const drawer = document.getElementById("workspace-drawer")!;
        return !drawer.classList.contains("is-open") && drawer.getBoundingClientRect().right <= 0.5;
      }));
      assert.equal(await terminal.evaluate((node) => node.closest("[inert]") !== null), false, "the terminal is interactive again after closing the drawer");
      await assertNoTouchScroll(0, shortMove, "below-half-step vertical move");
      await cdp.detach();

      await page.evaluate((paneId) => (window as FixtureWindow).mirrorFixture.sockets.at(-1)!.push({
        type: "pty-data", fixture: "mirror", pane_id: paneId, data: "\x1b[40;1H\x1b[2KLOCAL-PAN-START",
      }), pane);
      await waitForStep("local pan start frame rendered", () => page.waitForFunction((rows) => document.querySelector(rows)?.textContent?.includes("LOCAL-PAN-START"), shownRows()));
      await terminal.evaluate((node: HTMLElement) => { node.style.height = "200px"; node.style.maxHeight = "200px"; node.style.flex = "none"; node.scrollTop = 80; });
      // ResizeObserver follows the cursor after its resize debounce, not after two paint frames.
      // Wait for that adjustment before placing the grid between its local edges for the wheel.
      await waitForStep("resize follows cursor away from scrollTop 80", () => page.waitForFunction(() => document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!.scrollTop !== 80));
      await terminal.evaluate((node) => { node.scrollTop = 80; });
      assert.equal(await terminal.evaluate((node) => node.scrollTop), 80, "the oversized grid starts between its local edges");
      const beforePan = await state(page);
      const panBox = await terminal.boundingBox();
      assert.ok(panBox);
      const panPoint = { x: panBox.x + panBox.width / 2, y: panBox.y + 100 };
      assert.equal(await terminal.evaluate((node, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit !== null && node.contains(hit);
      }, panPoint), true, "the local-pan wheel point hits the terminal, not a covering drawer");
      await page.mouse.move(panPoint.x, panPoint.y);
      await page.mouse.wheel(0, -30);
      await waitForStep("local wheel pans above scrollTop 80", () => page.waitForFunction(() => document.querySelector<HTMLElement>(".pane-frame.is-current .pane-terminal")!.scrollTop < 80));
      assert.deepEqual((await state(page)).inputs, beforePan.inputs, "local wheel pan sends no application input");
      assert.deepEqual((await state(page)).offsets, beforePan.offsets, "local wheel pan leaves shared history alone");
      const pannedTop = await terminal.evaluate((node) => node.scrollTop);
      await page.evaluate((paneId) => (window as FixtureWindow).mirrorFixture.sockets.at(-1)!.push({
        type: "pty-data", fixture: "mirror", pane_id: paneId, data: "\x1b[40;1H\x1b[2KLOCAL-PAN-CHANGED",
      }), pane);
      await waitForStep("local pan changed frame rendered", () => page.waitForFunction((rows) => document.querySelector(rows)?.textContent?.includes("LOCAL-PAN-CHANGED"), shownRows()));
      assert.equal(await terminal.evaluate((node) => node.scrollTop), pannedTop, "new output at the last row preserves the locally panned grid");
      assert.deepEqual((await state(page)).inputs, beforePan.inputs, "new mirror output sends no application input");
      assert.deepEqual((await state(page)).offsets, beforePan.offsets, "new mirror output does not request shared history scrolling");

      // A mirrored observer can pan its grid, but never changes the shared viewport or types.
      await page.evaluate(() => (window as FixtureWindow).mirrorFixture.sockets.at(-1)!.send(JSON.stringify({ type: "role", mode: "observe" })));
      await settled(page);
      const beforeObserve = await state(page);
      await terminal.dispatchEvent("wheel", { deltaY: -120, bubbles: true, cancelable: true });
      await settled(page);
      const observed = await state(page);
      assert.deepEqual(observed.inputs, beforeObserve.inputs, "observe wheel cannot send input");
      assert.deepEqual(observed.offsets, beforeObserve.offsets, "observe wheel cannot scroll the shared pane");
      assert.deepEqual(errors, []);
      console.log(`PASS mirror scroll: ${kind}, desktop wheel, phone touch, observe gate`);
    } finally { await context.close(); }
  }
});
