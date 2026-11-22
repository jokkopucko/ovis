import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

type KeyboardQA = Window & { keyboardQA: (height: number | null) => void };

export async function checkTerminalInputSpacing(browser: Browser, origin: string, evidence?: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-input-spacing-")));
  let workspaceId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-input-spacing" });
    workspaceId = created.workspace.workspace_id;
    for (const size of [
      { label: "folded 412x915", width: 412, height: 915, inset: 0, keyboard: 0 },
      { label: "gesture bar 412x915", width: 412, height: 915, inset: 24, keyboard: 0 },
      { label: "keyboard up 412x915", width: 412, height: 915, inset: 0, keyboard: 420 },
      { label: "unfolded 720x870", width: 720, height: 870, inset: 0, keyboard: 0 },
      { label: "landscape 915x412", width: 915, height: 412, inset: 16, keyboard: 0 },
    ]) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "en-US" });
      try {
        await context.addInitScript(() => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
          const viewport = window.visualViewport!;
          let height: number | null = null;
          Object.defineProperty(viewport, "height", { get: () => height ?? window.innerHeight });
          (window as unknown as KeyboardQA).keyboardQA = (value) => { height = value; viewport.dispatchEvent(new Event("resize")); };
        });
        const page = await context.newPage();
        if (size.inset > 0) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: 0, topMax: 0, left: 0, leftMax: 0, bottom: size.inset, bottomMax: size.inset, right: 0, rightMax: 0 } } as never);
        }
        await page.goto(`${origin}/?pane=${encodeURIComponent(created.root_pane.pane_id)}`);
        await page.locator(".terminal-input").waitFor();
        if (size.keyboard > 0) {
          await page.locator(".terminal-input-text").focus();
          await page.evaluate((height) => (window as unknown as KeyboardQA).keyboardQA(height), size.height - size.keyboard);
          await page.waitForFunction((bottom) => (document.querySelector(".key-bar")?.getBoundingClientRect().bottom ?? 0) <= bottom + 1, size.height - size.keyboard);
        }
        const geometry = await page.evaluate(() => {
          const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
          const line = box(".terminal-input");
          const keyBar = document.querySelector(".key-bar")!;
          const bar = keyBar.getBoundingClientRect();
          const barPadding = parseFloat(getComputedStyle(keyBar).paddingBottom);
          const target = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--touch-target"));
          const keys = [...keyBar.querySelectorAll<HTMLElement>(".key")].map((key) => {
            const own = key.getBoundingClientRect();
            const middle = (own.top + own.bottom) / 2;
            const x = (own.left + own.right) / 2;
            // a finger half a pixel inside the touch target's band, above and below the key's middle
            // column: the tap must land on the key (through its expander), not on the bar behind it.
            // Chromium's hit test reaches up to a pixel past a box's top edge but not its bottom, so a
            // 42px expander fails below. A key scrolled out of the bar's view cannot be hit, so only
            // the ones in view are tried
            // the row's own box, not the bar's: a key scrolled under the pinned More keys toggle beside the
            // row cannot be hit either (on the narrowest screens the whole bar scrolls, KeyBar.css)
            const scroller = key.closest<HTMLElement>(".key-bar-row");
            const clip = scroller && getComputedStyle(scroller).display !== "contents" ? scroller.getBoundingClientRect() : bar;
            const inView = x > clip.left + 1 && x < Math.min(clip.right, window.innerWidth) - 1;
            const lands = (y: number) => document.elementFromPoint(x, y)?.closest(".key") === key;
            const tapTop = middle - target / 2;
            const tapBottom = middle + target / 2;
            return { name: key.dataset["key"], top: own.top, bottom: own.bottom, tapTop, tapBottom, inView, landsAbove: inView && lands(tapTop + 0.5), landsBelow: inView && lands(tapBottom - 0.5) };
          });
          return {
            line: { top: line.top + 1, bottom: line.bottom }, text: { top: box(".terminal-input-label").top, bottom: box(".terminal-input-text").bottom }, send: box(".terminal-input-send"),
            bar: { top: bar.top, bottom: bar.bottom - barPadding }, keys, target, barPadding, screenBottom: window.visualViewport!.height,
          };
        });
        // the home indicator's room is the bar's own padding (KeyBar.css: the safe area less --space-2),
        // checked before the spacing below measures the bar without it: a bar that lost it would put
        // its keys at the screen's edge and still look evenly spaced
        assert.ok(Math.abs(geometry.barPadding - Math.max(0, size.inset - 8)) <= 0.5, `${size.label}: the key bar keeps the gesture bar's room (${geometry.barPadding}px for a ${size.inset}px inset)`);
        if (size.keyboard === 0) {
          const clear = geometry.screenBottom - Math.max(...geometry.keys.map((key) => key.bottom));
          assert.ok(clear >= Math.max(4, size.inset - 8), `${size.label}: the keys stand ${clear}px clear of the screen's bottom edge`);
        }
        for (const [name, control] of [["field", geometry.text], ["send button", geometry.send]] as const) {
          const above = control.top - geometry.line.top;
          const below = geometry.line.bottom - control.bottom;
          assert.ok(below >= 3.5 && Math.abs(above - below) <= 1.5, `${size.label}: the ${name} has as much room below as above (${above} / ${below})`);
        }
        assert.ok(geometry.keys.length > 0, `${size.label}: the key bar shows keys`);
        assert.equal(geometry.target, 44, `${size.label}: the touch target is 44px`);
        assert.ok(geometry.keys.some((key) => key.inView), `${size.label}: a key is in view to tap`);
        for (const key of geometry.keys) {
          const above = key.top - geometry.bar.top;
          const below = geometry.bar.bottom - key.bottom;
          assert.ok(above >= 4 && below >= 4 && Math.abs(above - below) <= 1.5, `${size.label}: a key sits in the middle of the bar (${above} / ${below})`);
          assert.ok(key.tapTop >= geometry.bar.top - 0.5 && key.tapBottom <= geometry.bar.bottom + 0.5, `${size.label}: a key's touch target stays inside the bar (${key.tapTop - geometry.bar.top} / ${geometry.bar.bottom - key.tapBottom})`);
          if (!key.inView) continue;
          assert.ok(key.landsAbove && key.landsBelow, `${size.label}: a tap just inside ${key.name}'s 44px touch target lands on the key (above ${key.landsAbove}, below ${key.landsBelow})`);
        }
        if (evidence) await page.screenshot({ path: join(evidence, `input-spacing-${size.label.replace(/\s+/g, "-")}.png`) });
      } finally { await context.close(); }
    }
    console.log("PASS the phone's terminal input line and key bar are evenly spaced (field and send button, keys with 44px targets) folded, unfolded, over a gesture bar, with the keyboard up and in landscape");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-input-spacing-state-"));
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) mkdirSync(evidence, { recursive: true });
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkTerminalInputSpacing(browser, `http://127.0.0.1:${server.port}`, evidence);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
