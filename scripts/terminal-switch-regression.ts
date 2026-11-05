/** Recent terminal switches against owned panes, with click-to-painted-content measurements. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type WebSocket } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, tabCreate, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";

declare global {
  interface Window {
    switchResult: Promise<{ contentMs: number; readyMs: number }>;
  }
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-terminal-switch-")));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
const baseline = process.env["SWITCH_BASELINE"] === "1";
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
let workspace: string | null = null;
try {
  const made = await workspaceCreate({ cwd: root, label: "terminal-switch-fixture" });
  workspace = made.workspace.workspace_id;
  const panes = [made.root_pane.pane_id];
  const tabs = new Map([[made.root_pane.pane_id, made.root_pane.tab_id]]);
  for (let i = 1; i < 5; i++) {
    const tab = await tabCreate({ workspaceId: workspace, label: `switch-${i}` });
    panes.push(tab.root_pane.pane_id);
    tabs.set(tab.root_pane.pane_id, tab.tab.tab_id);
  }
  for (let i = 0; i < panes.length; i++) {
    await paneSendText(panes[i]!, `printf '\\033[2J\\033[HOVIS-SWITCH-${i}\\n'\\n`.replace(/\\n$/, "\n"));
  }
  for (const width of [1440, 390]) for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390, colorScheme: theme });
    try {
      await context.addInitScript(({ panes, theme }) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme, releasePaneAway: false }));
        for (const id of panes) localStorage.setItem(`ovis:view:${id}`, "terminal");
      }, { panes, theme });
      const page = await context.newPage();
      const frames: { type: string; pane_id?: string; keep_size?: boolean }[] = [];
      const sockets: WebSocket[] = [];
      page.on("websocket", (ws) => {
        sockets.push(ws);
        ws.on("framesent", ({ payload }) => { frames.push(JSON.parse(String(payload))); });
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes[0]!)}`);
      const frame = (id: string) => page.locator(`[data-layout-pane="${id}"]`);
      const ready = (id: string) => frame(id).locator("[data-pane-content]").waitFor();
      const select = async (id: string) => {
        await page.locator(`.tab-strip [role="tab"][data-tab-id="${tabs.get(id)}"]`).click();
        await ready(id);
      };
      await ready(panes[0]!);
      // A cold switch: the tab left behind starts its view only after the selected pane's attach
      const cold = frames.length;
      const viewStarted = Promise.withResolvers<void>();
      const viewTimeout = setTimeout(() => viewStarted.reject(new Error("the tab left behind never watched its pane")), 10_000);
      const onViewStart = ({ payload }: { payload: string | Buffer }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "watch" && message.pane_id === panes[0]) viewStarted.resolve();
      };
      for (const socket of sockets) socket.on("framesent", onViewStart);
      try {
        await select(panes[1]!);
        await viewStarted.promise;
      } finally {
        clearTimeout(viewTimeout);
        for (const socket of sockets) socket.off("framesent", onViewStart);
      }
      const order = frames.slice(cold).map((sent) => `${sent.type}:${sent.pane_id}`);
      assert.ok(order.indexOf(`attach:${panes[1]}`) !== -1 && order.indexOf(`attach:${panes[1]}`) < order.indexOf(`watch:${panes[0]}`),
        `a cold switch attaches the selected pane before the left tab watches: ${order.join(", ")}`);
      await select(panes[0]!);
      const start = frames.length;
      const samples: { contentMs: number; readyMs: number }[] = [];
      for (let i = 0; i < 10; i++) {
        const index = i % 2 === 0 ? 1 : 0;
        const id = panes[index]!;
        await page.evaluate(({ id, marker }) => {
          window.switchResult = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("switch did not paint")), 10_000);
            document.addEventListener("pointerdown", () => {
              const start = performance.now();
              let contentMs: number | null = null;
              const check = () => {
                const frame = document.querySelector(`[data-layout-pane="${id}"]`);
                const rows = frame?.querySelector(".xterm-rows");
                const visible = frame && getComputedStyle(frame).visibility === "visible";
                if (visible && rows?.textContent?.includes(marker)) contentMs ??= performance.now() - start;
                if (contentMs !== null && frame?.querySelector("[data-pane-content]")) {
                  clearTimeout(timeout);
                  resolve({ contentMs, readyMs: performance.now() - start });
                } else requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            }, { once: true, capture: true });
          });
        }, { id, marker: `OVIS-SWITCH-${index}` });
        await select(id);
        samples.push(await page.evaluate(() => window.switchResult));
      }
      const warm = frames.slice(start);
      console.log(JSON.stringify({ width, theme, baseline, samples, attaches: warm.filter((frame) => frame.type === "attach").length, detaches: warm.filter((frame) => frame.type === "detach").length }));
      if (!baseline) {
        // A hidden tab holds no attach, and so no input: only the tab on screen is attached.
        const attached = new Set<string>();
        for (const sent of frames) {
          if (sent.type === "attach" && sent.pane_id) attached.add(sent.pane_id);
          if (sent.type === "detach" && sent.pane_id) attached.delete(sent.pane_id);
        }
        assert.deepEqual([...attached], [panes[0]], "only the tab on screen holds the pane's attach");
        // its screen stays current through herdr's read-only view instead
        assert.ok(warm.some((sent) => sent.type === "watch" && sent.pane_id === panes[1]), "a hidden recent tab watches its pane");
      }
      if (evidence) await page.screenshot({ path: join(evidence, `terminal-switch-${width}-${theme}.png`) });
      if (!baseline) {
        // Output a hidden tab's view receives is kept unparsed while hidden and is on screen on its return.
        const hidden = `OVIS-HIDDEN-${width}-${theme}`;
        const delivered = Promise.withResolvers<void>();
        const deliveredTimeout = setTimeout(() => delivered.reject(new Error("the hidden tab's view never received the output")), 10_000);
        const onView = ({ payload }: { payload: string | Buffer }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "watch-data" && message.pane_id === panes[1] && String(message.data).includes(hidden)) delivered.resolve();
        };
        for (const socket of sockets) socket.on("framereceived", onView);
        try {
          await paneSendText(panes[1]!, `printf 'OVIS-HIDDEN-%s\\n' ${width}-${theme}\n`);
          await delivered.promise;
        } finally {
          clearTimeout(deliveredTimeout);
          for (const socket of sockets) socket.off("framereceived", onView);
        }
        assert.equal(await frame(panes[1]!).locator(".xterm-rows", { hasText: hidden }).count(), 0, "a hidden tab does not parse its view");
        await select(panes[1]!);
        await frame(panes[1]!).locator(".xterm-rows", { hasText: hidden }).waitFor({ state: "attached" });
        await select(panes[0]!);
        const evicting = frames.length;
        for (const id of panes.slice(2)) await select(id);
        await frame(panes[1]!).waitFor({ state: "detached" });
        assert.ok(frames.slice(evicting).some((frame) => frame.type === "unwatch" && frame.pane_id === panes[1]), "eviction stops the tab's view");
        assert.equal(await page.locator("[data-layout-pane]").count(), 4, "the existing four-tab bound holds");
        // every recent tab keeps its screen, but a phone watches only the tab before the current one
        const watching = new Set<string>();
        for (const sent of frames) {
          if (sent.type === "watch" && sent.pane_id) watching.add(sent.pane_id);
          if (sent.type === "unwatch" && sent.pane_id) watching.delete(sent.pane_id);
        }
        const phone = width === 390;
        assert.deepEqual([...watching].sort(), (phone ? [panes[3]!] : [panes[0]!, panes[2]!, panes[3]!]).sort(), "only the most recent hidden tabs watch");
        // Leaving the window stops the cached tabs' views even with releasePaneAway off.
        const away = new Set(panes.slice(phone ? 3 : 2, 4));
        const released = Promise.withResolvers<void>();
        const timeout = setTimeout(() => released.reject(new Error("cached views were not stopped")), 5000);
        const observe = ({ payload }: { payload: string | Buffer }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "unwatch") away.delete(message.pane_id);
          if (away.size === 0) released.resolve();
        };
        // Subscribe before blur, including already-open sockets.
        for (const socket of sockets) socket.on("framesent", observe);
        try {
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
            window.dispatchEvent(new Event("blur"));
          });
          await released.promise;
        } finally {
          clearTimeout(timeout);
          for (const socket of sockets) socket.off("framesent", observe);
        }
        // Coming back to the window watches the recent tabs again.
        const watched = new Set(panes.slice(phone ? 3 : 2, 4));
        const rewatched = Promise.withResolvers<void>();
        const rewatchTimeout = setTimeout(() => rewatched.reject(new Error("cached views did not start again on focus")), 5000);
        const onWatch = ({ payload }: { payload: string | Buffer }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "watch") watched.delete(message.pane_id);
          if (watched.size === 0) rewatched.resolve();
        };
        for (const socket of sockets) socket.on("framesent", onWatch);
        try {
          await page.evaluate(() => {
            Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
            window.dispatchEvent(new Event("focus"));
          });
          await rewatched.promise;
        } finally {
          clearTimeout(rewatchTimeout);
          for (const socket of sockets) socket.off("framesent", onWatch);
        }
      }
      assert.deepEqual(errors, [], "no browser errors");
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  server.stop();
  if (workspace !== null) await workspaceClose(workspace);
  rmSync(root, { recursive: true, force: true });
}
