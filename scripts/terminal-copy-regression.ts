import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { herdrRpc, paneRead, paneSendText, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { shownRow } from "./shown-rows.ts";

export async function checkTerminalCopy(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-copy-ui-"));
  const prompt = "copy-fixture$ ";
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-copy-ui", env: { PS1: prompt } });
  const pane = created.root_pane.pane_id;
  const script = join(root, "show.cjs");
  writeFileSync(script, `
process.stdout.write("\\x1b[2J\\x1b[H");
process.stdout.write("DRAGCOPY-first-line\\r\\n");
process.stdout.write("DRAGCOPY-second-line\\r\\n");
process.stdout.write("LONG-" + "x".repeat(${300}) + "-END\\r\\n");
setInterval(() => {}, 1000);
`);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await context.addInitScript((id) => {
      localStorage.setItem(`ovis:view:${id}`, "terminal");
      // WebKit requires the write to start in the gesture, even when its text is
      // fetched later. Record this boundary without granting Chromium a free pass
      // through its persistent clipboard-write permission.
      let releasing = false;
      window.addEventListener("mouseup", () => {
        releasing = true;
        setTimeout(() => { releasing = false; }, 0);
      }, { capture: true });
      const state = { checking: false, writes: [] as boolean[], pending: 0, positions: { asked: 0, open: 0 }, scrollWrites: 0 };
      (window as any).clipboardGesture = state;
      const fetchPage = window.fetch.bind(window);
      (window as any).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const url = new URL(input instanceof Request ? input.url : String(input), location.href);
        if (!url.pathname.endsWith("/pane/scroll")) return fetchPage(input, init);
        if (method === "GET") {
          state.positions.asked++;
          state.positions.open++;
        } else if (method === "POST") state.scrollWrites++;
        else return fetchPage(input, init);
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          if (method === "GET") state.positions.open--;
          else {
            // The drag queues its next write in the current write's promise
            // continuation. Keep the current one counted through that handoff.
            requestAnimationFrame(() => { state.scrollWrites--; });
          }
        };
        try {
          const response = await fetchPage(input, init);
          if (!response.ok) close();
          const json = response.json.bind(response);
          response.json = () => json().finally(close);
          return response;
        } catch (error) {
          close();
          throw error;
        }
      };
      for (const method of ["write", "writeText"] as const) {
        const original = navigator.clipboard[method].bind(navigator.clipboard);
        (navigator.clipboard as any)[method] = (value: any) => {
          if (state.checking) state.writes.push(releasing);
          state.pending++;
          return original(value).finally(() => { state.pending--; });
        };
      }
    }, pane);
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const inputs: string[] = [];
    page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "input") inputs.push(message.text);
    }));
    // letting go copies once herdr's copy_on_select is known: on here, as herdr's default with no config
    const preference = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/herdr-ui");
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(shownRow(), { hasText: prompt.trimEnd() }).waitFor();
    assert.equal((await (await preference).json()).copy_on_select, true, "no herdr config: herdr's default copies on release");
    await paneSendText(pane, `clear; node ${script}\r`);
    const first = page.locator(shownRow(), { hasText: "DRAGCOPY-first-line" });
    await first.waitFor();

    const press = async (): Promise<void> => {
      const before = await page.evaluate(() => (window as any).clipboardGesture.positions.asked as number);
      await page.mouse.down();
      await page.waitForFunction((count) => {
        const { asked, open } = (window as any).clipboardGesture.positions;
        return asked > count && open === 0;
      }, before);
    };
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }): Promise<string[]> => {
      await page.mouse.move(from.x, from.y);
      await page.waitForTimeout(100);
      const before = inputs.length;
      await press();
      await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
      await page.mouse.move(to.x, to.y, { steps: 4 });
      await page.mouse.up();
      await page.waitForTimeout(100);
      return inputs.slice(before);
    };
    const clipboard = (page: Page): Promise<string> => page.evaluate(() => navigator.clipboard.readText());
    const settled = () => page.waitForFunction(() => (window as any).clipboardGesture.pending === 0);

    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.evaluate(() => { (window as any).clipboardGesture.checking = true; });
    const box = (await first.boundingBox())!;
    const dragged = await drag({ x: box.x + 1, y: box.y + box.height / 2 }, { x: box.x + 400, y: box.y + box.height / 2 });
    await page.locator(".terminal-banner", { hasText: "copied to clipboard" }).waitFor();
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-drag-copy.png") });
    }
    assert.match(await clipboard(page), /^DRAGCOPY-first-line/, "a plain drag must copy the selected text");
    assert.deepEqual(dragged, [], "a selecting drag must not reach the pane as mouse reports");
    assert.deepEqual(await page.evaluate(() => (window as any).clipboardGesture.writes), [true],
      "drag copy must begin inside mouseup, before timers or server responses lose the gesture");
    await page.evaluate(() => { (window as any).clipboardGesture.checking = false; });

    await page.mouse.dblclick(box.x + 20, box.y + box.height / 2);
    await page.waitForTimeout(100);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const beforeCopy = inputs.length;
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(300);
    assert.equal(await clipboard(page), "DRAGCOPY-first-line", "Ctrl+C must copy the double-clicked word");
    assert.equal(inputs.length, beforeCopy, "Ctrl+C with a selection must not send ^C");
    await page.keyboard.press("Control+c");
    await page.waitForTimeout(300);
    assert.equal(inputs.at(-1), "\x03", "Ctrl+C without a selection still interrupts");

    await page.mouse.dblclick(box.x + 20, box.y + box.height / 2);
    await page.waitForTimeout(100);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const beforeHangul = inputs.length;
    const cdp = await context.newCDPSession(page);
    const hangulC = { key: "ㅊ", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 2 };
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...hangulC });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...hangulC });
    await page.waitForTimeout(300);
    assert.equal(await clipboard(page), "DRAGCOPY-first-line", "Ctrl+C on a Korean layout must copy the selection");
    assert.equal(inputs.length, beforeHangul, "Ctrl+C on a Korean layout with a selection must not send ^C");

    // A Chromium site (including an installed PWA) may deny the async API while
    // the user's native Copy gesture remains available.
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    await cdp.send("Browser.setPermission", {
      origin, browserContextId: targetInfo.browserContextId,
      permission: { name: "clipboard-write" }, setting: "denied",
    });
    assert.equal(await page.evaluate(async () => {
      try { await navigator.clipboard.writeText("must be blocked"); return false; } catch { return true; }
    }), true, "the async clipboard permission is actually denied");
    const secondBox = (await page.locator(shownRow(), { hasText: "DRAGCOPY-second-line" }).boundingBox())!;
    await drag({ x: secondBox.x + 1, y: secondBox.y + secondBox.height / 2 }, { x: secondBox.x + 400, y: secondBox.y + secondBox.height / 2 });
    await settled();
    assert.match(await clipboard(page), /^DRAGCOPY-second-line/, "drag still copies when the async clipboard is denied");
    if (process.env.UI_EVIDENCE_DIR) {
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-copy-permission-blocked.png") });
    }
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });

    let releaseOld!: () => void;
    const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
    let held = false;
    let delivered = false;
    await page.route("**/api/pane/selection?*", async (route) => {
      const response = await route.fetch();
      if (!held) {
        held = true;
        await oldResponse;
        await route.fulfill({ response });
        delivered = true;
      } else await route.fulfill({ response });
    });
    try {
      await drag({ x: box.x + 1, y: box.y + box.height / 2 }, { x: box.x + 400, y: box.y + box.height / 2 });
      const deadline = Date.now() + 5000;
      while (!held && Date.now() < deadline) await page.waitForTimeout(20);
      assert.equal(held, true, "first selection response held");
      await drag({ x: secondBox.x + 1, y: secondBox.y + secondBox.height / 2 }, { x: secondBox.x + 400, y: secondBox.y + secondBox.height / 2 });
      releaseOld();
      while (!delivered && Date.now() < deadline) await page.waitForTimeout(20);
      assert.equal(delivered, true);
      await settled();
      assert.match(await clipboard(page), /^DRAGCOPY-second-line/, "an old selection response never overwrites the newer copy");
      await page.evaluate(() => navigator.clipboard.writeText(""));
      await page.keyboard.press("Control+c");
      await settled();
      const copyDeadline = Date.now() + 5_000;
      while (!(await clipboard(page)) && Date.now() < copyDeadline) await page.waitForTimeout(50);
      assert.match(await clipboard(page), /^DRAGCOPY-second-line/, "the cached selection also belongs to the newer drag");
    } finally {
      releaseOld();
      await page.unroute("**/api/pane/selection?*");
    }

    // Output can erase the server range before it is read; the visible snapshot
    // must not be replaced by an empty clipboard.
    await page.route("**/api/pane/selection?*", (route) => route.fulfill({ json: { text: "" } }));
    await drag({ x: box.x + 1, y: box.y + box.height / 2 }, { x: box.x + 400, y: box.y + box.height / 2 });
    await settled();
    assert.match(await clipboard(page), /^DRAGCOPY-first-line/, "an empty server range preserves the visible selection");
    await page.unroute("**/api/pane/selection?*");

    const long = page.locator(shownRow(), { hasText: "LONG-" });
    const longBox = (await long.boundingBox())!;
    const endRow = page.locator(shownRow(), { hasText: "-END" });
    const endBox = (await endRow.boundingBox())!;
    await drag({ x: longBox.x + 1, y: longBox.y + longBox.height / 2 }, { x: endBox.x + 600, y: endBox.y + endBox.height / 2 });
    await page.waitForTimeout(300);
    assert.equal(await clipboard(page), `LONG-${"x".repeat(300)}-END`, "a soft-wrapped line must copy without line breaks");

    // plain HTTP (no navigator.clipboard): the copy command takes over
    const insecure = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await insecure.addInitScript((id) => {
        localStorage.setItem(`ovis:view:${id}`, "terminal");
        Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined });
        document.addEventListener("copy", (event) => {
          (window as any).copied = event.clipboardData?.getData("text/plain");
        });
      }, pane);
      const plain = await insecure.newPage();
      plain.setDefaultTimeout(10_000);
      const sent: string[] = [];
      plain.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
        const message = JSON.parse(String(payload));
        if (message.type === "input") sent.push(message.text);
      }));
      await plain.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
      const row = plain.locator(shownRow(), { hasText: "DRAGCOPY-first-line" });
      await row.waitFor();
      const rowBox = (await row.boundingBox())!;
      await plain.mouse.move(rowBox.x + 1, rowBox.y + rowBox.height / 2);
      await plain.mouse.down();
      await plain.mouse.move(rowBox.x + 400, rowBox.y + rowBox.height / 2, { steps: 6 });
      await plain.mouse.up();
      await plain.locator(".terminal-banner", { hasText: "copied to clipboard" }).waitFor();
      assert.match(await plain.evaluate(() => (window as any).copied as string), /^DRAGCOPY-first-line/, "plain HTTP drag must copy");
      await plain.evaluate(() => { (window as any).copied = undefined; });
      await plain.mouse.dblclick(rowBox.x + 20, rowBox.y + rowBox.height / 2);
      await plain.waitForTimeout(100);
      await plain.evaluate(() => { (window as any).copied = undefined; });
      const beforeKey = sent.length;
      await plain.keyboard.press("Control+c");
      await plain.waitForTimeout(300);
      assert.equal(await plain.evaluate(() => (window as any).copied as string), "DRAGCOPY-first-line", "plain HTTP Ctrl+C must copy");
      assert.equal(sent.length, beforeKey, "plain HTTP Ctrl+C with a selection must not send ^C");
    } finally {
      await insecure.close();
    }

    const numbered = join(root, "numbered.cjs");
    writeFileSync(numbered, `
for (let i = 0; i < 300; i++) process.stdout.write("S" + String(i).padStart(3, "0") + "\\r\\n");
setInterval(() => {}, 1000);
`);
    await paneSendText(pane, `\x03`);
    await paneSendText(pane, `clear; node ${numbered}\r`);
    const rowWith = (text: string) => page.locator(shownRow(), { hasText: new RegExp(`^${text}\\s*$`) });
    await rowWith("S299").waitFor();
    const topRow = (): Promise<number> => page.evaluate((row) => {
      const first = document.querySelector(row)?.textContent ?? "";
      return Number(first.trim().slice(1));
    }, shownRow());
    const lines = (text: string): number[] => text.split("\n").map((line) => Number(line.trim().slice(1)));
    const consecutive = (numbers: number[]): boolean => numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1);
    const filled = async (): Promise<string> => {
      await settled();
      const deadline = Date.now() + 5_000;
      for (;;) {
        const text = await clipboard(page);
        if (text || Date.now() > deadline) return text;
        await page.waitForTimeout(50);
      }
    };

    const screen = (await page.locator(".pane-terminal .xterm-screen").boundingBox())!;
    const lineHeight = screen.height / (await page.locator(shownRow()).count());
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.mouse.move(screen.x + 1, screen.y + screen.height / 2);
    await press();
    await page.mouse.move(screen.x + 1, screen.y + screen.height + 20, { steps: 1 });
    await page.mouse.up();
    assert.equal(lines(await filled()).at(-1), 299, "a drag past the bottom edge takes the last line");
    await page.mouse.wheel(0, lineHeight);
    await page.waitForTimeout(2600); // the copy note fades before the evidence below

    const herdrTop = async (): Promise<number> => Number((await paneRead({ paneId: pane, source: "visible", stripAnsi: true })).text.split("\n")[0]!.trim().slice(1));
    const syncedTop = async (): Promise<number> => {
      const deadline = Date.now() + 10_000;
      await page.waitForFunction(() => (window as Window & { clipboardGesture?: { scrollWrites: number } }).clipboardGesture?.scrollWrites === 0);
      const herdr = await herdrTop();
      assert.ok(Number.isFinite(herdr), "herdr shows a numbered line");
      await page.waitForFunction(([selector, line]) => {
        const row = document.querySelector(selector);
        return Number(row?.textContent?.trim().slice(1)) === line;
      }, [shownRow(), herdr] as const, { timeout: Math.max(1, deadline - Date.now()) });
      return herdr;
    };
    const firstTop = await syncedTop();
    const pressAt = { x: screen.x + 200, y: screen.y + lineHeight * 5.5 };
    await page.evaluate(() => navigator.clipboard.writeText(""));
    await page.mouse.move(pressAt.x, pressAt.y);
    await page.waitForTimeout(100);
    const beforeWheel = inputs.length;
    await press();
    await page.mouse.move(screen.x + 1, pressAt.y + lineHeight * 3, { steps: 3 });
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, -lineHeight * 10);
      await page.waitForTimeout(80);
    }
    await page.mouse.move(screen.x + 1, pressAt.y + lineHeight * 2, { steps: 3 });
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-scroll-select.png") });
    await page.mouse.up();
    let copied = lines(await filled());
    assert.ok(copied.length > 1 && consecutive(copied), `a wheel-scrolled drag copies whole consecutive lines: ${copied.slice(0, 3)}`);
    assert.equal(copied.at(-1), firstTop + 5, `the wheel drag ends at the pressed line (${copied.slice(-2)})`);
    assert.ok(copied[0]! < firstTop, `lines above the first screen are included (first ${copied[0]}, screen top ${firstTop})`);
    assert.deepEqual(inputs.slice(beforeWheel), [], "a selecting drag's wheel scrolls herdr through the API, never as input");
    assert.ok(await topRow() < firstTop, "herdr's viewport followed the drag");

    await page.evaluate(() => navigator.clipboard.writeText(""));
    const edgeStartTop = await syncedTop();
    const bottomAt = { x: screen.x + 200, y: screen.y + screen.height - lineHeight * 1.5 };
    await page.mouse.move(bottomAt.x, bottomAt.y);
    await press();
    await page.mouse.move(screen.x + 1, screen.y - 20, { steps: 5 });
    await page.waitForTimeout(600);
    await page.mouse.move(screen.x + 1, screen.y + lineHeight / 2, { steps: 2 });
    await page.mouse.up();
    copied = lines(await filled());
    const rows = await page.locator(shownRow()).count();
    assert.ok(consecutive(copied), "an edge-scrolled drag copies consecutive lines");
    assert.equal(copied.at(-1), edgeStartTop + rows - 2, `the edge drag ends at the pressed line (${copied.slice(0, 2)}..${copied.slice(-2)}, top ${edgeStartTop}, rows ${rows})`);
    assert.ok(copied.length > rows, `the edge scrolled past one screen (${copied.length} lines, ${rows} rows)`);

    const edgeText = await clipboard(page);
    await page.evaluate(() => navigator.clipboard.writeText(""));
    const beforeKey = inputs.length;
    await page.keyboard.press("Control+c");
    assert.equal(await filled(), edgeText, "Ctrl+C copies the whole scrolled range");
    assert.deepEqual(inputs.slice(beforeKey), [], "Ctrl+C over a selection sends no ^C");

    await page.mouse.wheel(0, lineHeight * 3);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.querySelector(".pane-terminal .xterm-selection div") !== null), false, "a wheel after a copy clears the highlight");
    await herdrRpc("pane.scroll", { pane_id: pane, offset_from_bottom: 0 });

    console.log("PASS plain drag copies terminal text; Ctrl+C copies a selection (also without the async clipboard)");
    console.log("PASS a selecting drag scrolls herdr by wheel and edge, and copies herdr's text for the whole range");
    console.log("PASS drag copy starts in the gesture, survives denied clipboard permission, and ignores stale or empty selection responses");
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}
