import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";
import { openSettingsPage } from "./settings-page.ts";

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await Bun.sleep(25);
  }
}

/** Real phone touch events: live font and badge while pinching, one resize and saved size on release, restore on cancel. */
export async function checkTerminalPinch(browser: Browser, origin: string, paneId: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
  await context.addInitScript(({ paneId }) => {
    // Keep the size saved by the gesture when this same page reloads.
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ovis:view:${paneId}`, "terminal");
    const touchWindow = window as Window & { wheels_: number; wheelModes_: number[]; remaining_: number[] };
    touchWindow.wheels_ = 0;
    touchWindow.wheelModes_ = [];
    touchWindow.remaining_ = [];
    document.addEventListener("touchend", (event) => {
      touchWindow.remaining_ = Array.from(event.touches, (touch) => touch.identifier);
    }, { capture: true });
    document.addEventListener("wheel", (event) => {
      touchWindow.wheels_++;
      touchWindow.wheelModes_.push(event.deltaMode);
    }, { capture: true });
  }, { paneId });
  try {
    const page = await context.newPage();
    const badge = page.locator(".terminal-font-size");
    const errors: string[] = [];
    let ready = false;
    let resizes = 0;
    let lastResize: { cols: number; rows: number } | undefined;
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input-ready" && message.pane_id === paneId) ready = message.ready !== false;
      });
      socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "resize") {
          resizes++;
          lastResize = { cols: message.cols, rows: message.rows };
        }
      });
    });
    const probe = () => page.evaluate(() => ({
      fontPx: parseFloat(getComputedStyle(document.querySelector(".pane-terminal .xterm-rows")!).fontSize),
      rows: document.querySelectorAll(".pane-terminal .xterm-rows > div").length,
      saved: JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize as number | undefined,
      transform: (document.querySelector(".pane-terminal .xterm") as HTMLElement).style.transform,
      computedTransform: getComputedStyle(document.querySelector(".pane-terminal .xterm")!).transform,
      wheels: (window as Window & { wheels_: number }).wheels_,
      wheelModes: (window as Window & { wheelModes_: number[] }).wheelModes_.slice(),
      cell: document.querySelector(".pane-terminal .xterm-screen")!.getBoundingClientRect().height
        / document.querySelectorAll(".pane-terminal .xterm-rows > div").length,
      remaining: (window as Window & { remaining_: number[] }).remaining_,
      scale: visualViewport!.scale,
      focused: document.hasFocus(),
    }));
    await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
    await page.locator(shownRows()).first().waitFor();
    await until(() => ready, "owned terminal must accept input");
    // The 120 ms resize settle plus margin bounds the negative resize assertions.
    await Bun.sleep(400);
    const box = (await page.locator(".pane-terminal").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const pair = (distance: number) => [{ x: cx - distance / 2, y: cy, id: 1 }, { x: cx + distance / 2, y: cy, id: 2 }];
    const spreadTo = async (from: number, to: number): Promise<void> => {
      const startSize = (await probe()).fontPx;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pair(from) });
      assert(await badge.isVisible(), "pinch start shows the size badge");
      assert.equal(await badge.textContent(), `${startSize}px`, "pinch start shows the current font size");
      for (let step = 1; step <= 8; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pair(from + (to - from) * step / 8) });
      }
    };
    const release = () => cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    // a wheel report per three rows of travel: 150 px is more than that even at the largest cell the 22 px font makes;
    // the drag ends at cy, where a following pinch puts this finger, so that jump is no vertical travel
    const dragOne = async (): Promise<void> => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy - 150, id: 1 }] });
      for (let step = 1; step <= 5; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: cy - 150 + 150 * step / 5, id: 1 }] });
      }
    };

    /** one finger drags `distance` px down in `moves` touchmoves; resolves to the wheels it sent, each line mode (1) */
    const swipe = async (distance: number, moves: number): Promise<number> => {
      const before = await probe();
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: cx, y: cy - distance / 2, id: 1 }] });
      for (let step = 1; step <= moves; step++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx, y: cy - distance / 2 + distance * step / moves, id: 1 }] });
      }
      await release();
      // an attached swipe's reports go out a few per animation frame (lib/touchWheelPacer.ts), and the
      // pacer sends in every frame while any wait: a frame that sends none means the swipe has drained
      await page.evaluate(() => new Promise<void>((resolve) => {
        const sent = () => (window as Window & { wheels_: number }).wheels_;
        let last = sent();
        const check = (): void => {
          const now = sent();
          if (now === last) resolve();
          else { last = now; requestAnimationFrame(check); }
        };
        requestAnimationFrame(check);
      }));
      const after = await probe();
      assert(after.wheelModes.slice(before.wheelModes.length).every((mode) => mode === 1),
        `a ${moves}-move swipe sends line-mode wheels only`);
      return after.wheels - before.wheels;
    };

    const baseline = await probe();
    assert.equal(baseline.fontPx, 13, "baseline font is 13 px");
    assert(!(await badge.isVisible()), "badge is hidden before pinching");
    // a quick swipe scrolls as far as a slow drag over the same travel: one wheel report per three rows
    const fast = await swipe(300, 2);
    const slow = await swipe(300, 30);
    const expected = 300 / (3 * baseline.cell);
    assert(fast >= Math.floor(expected) - 1 && fast <= Math.ceil(expected), `a 300 px swipe sends about ${expected.toFixed(1)} wheels (sent ${fast})`);
    assert.equal(fast, slow, "a 2-move swipe and a 30-move drag over 300 px send the same wheel count");
    // a flick shorter than one step still scrolls once it reaches half a step when the finger lifts
    const step = 3 * baseline.cell;
    assert.equal(await swipe(Math.round(step * 0.7), 4), 1, `a flick of 0.7 step (${Math.round(step * 0.7)} px) sends one wheel`);
    assert.equal(await swipe(Math.round(step * 0.3), 4), 0, `a flick of 0.3 step (${Math.round(step * 0.3)} px) sends none`);
    const r0 = resizes;
    const w0 = (await probe()).wheels;
    await spreadTo(100, 154);
    await until(async () => (await probe()).fontPx === 20, "pinch out renders 20 px before release");
    await until(async () => (await probe()).rows < baseline.rows, "pinch out refits fewer local rows before release");
    const moving = await probe();
    assert.equal(moving.transform, "", "pinch applies no inline transform to the terminal");
    assert.equal(moving.computedTransform, "none", "pinch leaves the terminal visually unscaled");
    assert.equal(moving.fontPx, 20, "pinch changes the rendered font live before release");
    assert(await badge.isVisible(), "pinch keeps the size badge visible");
    assert.equal(await badge.textContent(), "20px", "badge shows the target font size during the 13 to 20 px pinch");
    assert.equal(resizes, r0, "pinch sends no resize frames before release");
    assert.equal(moving.wheels, w0, "pinch sends no wheel events");
    assert(moving.rows < baseline.rows, "live larger font fits fewer rows than the baseline");
    await release();
    await until(async () => (await probe()).saved === 20, "pinch out commits and saves 20 px");
    const enlarged = await probe();
    assert.equal(enlarged.fontPx, 20, "release keeps the live 20 px font");
    assert.equal(enlarged.transform, "", "release leaves the terminal untransformed");
    assert(!(await badge.isVisible()), "release hides the size badge");
    await Bun.sleep(400);
    const settled = await probe();
    assert.equal(settled.saved, 20, "pinch out saves 20 px after settling");
    assert.equal(resizes - r0, settled.focused ? 1 : 0, "release resizes once only when the terminal is in use");
    if (resizes > r0) assert.equal(lastResize?.rows, settled.rows, "release resize rows match the live local grid");
    assert.equal(settled.wheels, w0, "release sends no wheel events");
    assert.equal(settled.scale, 1, "pinch leaves browser zoom unchanged");

    const rBack = resizes;
    await spreadTo(154, 100);
    await until(async () => (await probe()).fontPx === 13, "pinch in renders 13 px before release");
    assert.equal(resizes, rBack, "pinch in sends no resize frames before release");
    await release();
    await until(async () => (await probe()).saved === 13, "pinch in commits and saves 13 px");
    await Bun.sleep(400);
    const reduced = await probe();
    assert.equal(reduced.saved, 13, "pinch in saves 13 px after settling");
    assert.equal(resizes - rBack, reduced.focused ? 1 : 0, "pinch in release resizes exactly once only when the terminal is in use");
    for (const [from, to, size] of [[100, 240, 22], [240, 60, 10], [100, 130, 13]] as const) {
      const rClamp = resizes;
      await spreadTo(from, to);
      await until(async () => (await probe()).fontPx === size, `pinch ${from} to ${to} renders ${size} px before release`);
      if (size === 22) assert.equal(await badge.textContent(), "22px", "badge shows the clamped upper limit");
      assert.equal(resizes, rClamp, `pinch ${from} to ${to} sends no resize frames before release`);
      await release();
      await until(async () => (await probe()).saved === size, `pinch ${from} to ${to} commits and saves ${size} px`);
      await Bun.sleep(400);
      const clamped = await probe();
      assert.equal(clamped.saved, size, `pinch ${from} to ${to} saves ${size} px after settling`);
      assert.equal(resizes - rClamp, clamped.focused ? 1 : 0, `pinch ${from} to ${to} release resizes exactly once only when the terminal is in use`);
    }

    const r1 = resizes;
    await spreadTo(100, 154);
    await until(async () => (await probe()).fontPx === 20, "cancelled pinch renders 20 px before cancellation");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await until(async () => (await probe()).fontPx === 13, "cancel restores the 13 px font");
    assert.equal((await probe()).transform, "", "cancel leaves the terminal untransformed");
    assert(!(await badge.isVisible()), "cancel hides the size badge");
    await Bun.sleep(400);
    const cancelled = await probe();
    assert.equal(cancelled.fontPx, 13, "cancel restores the rendered font");
    assert.equal(cancelled.rows, baseline.rows, "cancel restores the baseline local row count");
    assert.equal(cancelled.saved, 13, "cancel keeps the saved size");
    assert.equal(resizes, r1, "cancel sends no resize frames");

    await dragOne();
    const w1 = (await probe()).wheels;
    assert(w1 > w0, "a one-finger drag scrolls before pinching");
    await spreadTo(100, 154);
    // Chrome's CDP touchEnd points name the fingers to lift, not those left on screen.
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: cx + 77, y: cy, id: 2 }] });
    assert.deepEqual((await probe()).remaining, [1], "partial release really leaves the original first finger down");
    await until(async () => (await probe()).saved === 20, "first lifted finger commits and saves 20 px");
    assert.equal((await probe()).fontPx, 20, "partial release keeps the live 20 px font");
    assert.equal((await probe()).saved, 20, "partial release saves 20 px");
    assert(!(await badge.isVisible()), "the first lifted finger hides the size badge");
    // three wheel steps of travel at the 20 px cell: a broken pinch-stroke guard would send wheels here
    const leftover = 3 * 3 * (await probe()).cell;
    for (let step = 1; step <= 5; step++) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: cx - 77, y: cy + leftover * step / 5, id: 1 }] });
    }
    assert.equal((await probe()).wheels, w1, "the finger remaining after a pinch does not scroll");
    await release();
    await dragOne();
    assert((await probe()).wheels > w1, "a fresh one-finger drag scrolls again");
    await release();

    // Settings can restore the size that led to the previous announcement: the next pinch must
    // clear and restore the same words, rather than silently assigning unchanged text.
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Appearance");
    await page.getByRole("button", { name: "Decrease terminal font size", exact: true }).click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.evaluate(() => {
      const status = document.querySelector(".terminal-font-size")!.nextElementSibling!;
      const changes: string[] = [];
      new MutationObserver(() => {
        changes.push(status.textContent ?? "");
        status.setAttribute("data-announcements", JSON.stringify(changes));
      }).observe(status, { childList: true });
    });
    await spreadTo(100, 105);
    await release();
    await page.waitForFunction(() => {
      const changes: string[] = JSON.parse(document.querySelector(".terminal-font-size")!.nextElementSibling!.getAttribute("data-announcements") ?? "[]");
      return changes.includes("") && changes.some((text) => text !== "");
    }, undefined, { timeout: 5_000 });
    const repeated = await page.evaluate(() => JSON.parse(document.querySelector(".terminal-font-size")!.nextElementSibling!.getAttribute("data-announcements") ?? "[]"));
    assert.deepEqual(repeated, ["", "Terminal text size 20 px"], "an identical pinch result changes the live region twice");

    // Dispatch both gestures in one task, so the newer one necessarily starts before the old
    // announcement's animation frame. No clock race or artificial delay can make this pass.
    await page.evaluate(async () => {
      const host = document.querySelector(".pane-terminal")!;
      const status = document.querySelector(".terminal-font-size")!.nextElementSibling!;
      const touch = (id: number, x: number) => new Touch({ identifier: id, target: host, clientX: x, clientY: 200 });
      const fire = (type: string, distance: number | null) => host.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true, touches: distance === null ? [] : [touch(1, 100), touch(2, 100 + distance)],
      }));
      fire("touchstart", 100);
      fire("touchmove", 90);
      fire("touchend", null);
      fire("touchstart", 100);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (status.textContent !== "") throw new Error("a newer pinch must cancel the stale announcement");
      fire("touchcancel", null);
    });
    await spreadTo(90, 100);
    await release();
    console.log("PASS repeated pinch result is re-announced and a newer pinch cancels a pending restore");

    ready = false;
    await page.reload();
    await page.locator(shownRows()).first().waitFor();
    await until(() => ready, "reloaded terminal must accept input");
    await until(async () => (await probe()).fontPx === 20, "saved font survives reload");
    assert.deepEqual(errors, [], "pinch regression has no page errors");
    console.log("PASS terminal pinch: live font and badge while pinching, no resize until release, exactly one on release, clamps 10–22, cancel restores, no scroll during or after a pinch, kept after reload");
  } finally { await context.close(); }
}

if (import.meta.main) {
  // Importing the reusable check must not start herdr; bootstrap only the standalone fixture.
  await import("./test-herdr.ts");
  const root = mkdtempSync(join(tmpdir(), "herdr-terminal-pinch-qa-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", usage: new UsageService(undefined, []) });
  let browser: Browser | undefined;
  let workspace: string | undefined;
  try {
    const made = await workspaceCreate({ cwd: root, label: "ovis-test-terminal-pinch", focus: false });
    workspace = made.workspace.workspace_id;
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkTerminalPinch(browser, `http://127.0.0.1:${server.port}`, made.root_pane.pane_id);
  } finally {
    await browser?.close(); server.stop();
    if (workspace) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}
