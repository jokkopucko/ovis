import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Locator } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";
import { DEMO_PREFIX, serveDemo } from "./demo-server.ts";

const evidence = process.env.UI_EVIDENCE_DIR;

const FILES_SCRIPT = `<script>(${(() => {
  const demoFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname.endsWith("/workspace/directories") && (init?.method ?? "GET") === "GET") {
      const listing = await (await demoFetch(input, init)).json();
      return Response.json({ ...listing, files: [{ name: "README.md", size: 64 }] });
    }
    const path = url.searchParams.get("path") ?? "";
    const text = `# ${path}\n\nShown for ${path}.\n`;
    const name = path.split("/").pop() ?? path;
    if (url.pathname.endsWith("/fs/stat")) return Response.json({ path, name, kind: "text", mime: "text/markdown", size: text.length });
    if (url.pathname.endsWith("/fs/file")) return new Response(text, { headers: { "content-type": "text/markdown" } });
    return demoFetch(input, init);
  };
}).toString()})();</script>`;

await withDemoBrowser({ tempPrefix: "ovis-docked-file-link-demo-", afterTransport: FILES_SCRIPT }, async ({ app, newContext, baseUrl }) => {
  // a second origin for the same files: the page a link leaves the app for
  const draftServer = serveDemo(app);
  try {
    const draftPath = "doc/draft-ietf-httpapi-idempotency-key-header.html";
    const draftUrl = new URL(`${DEMO_PREFIX}${draftPath}`, draftServer.url).href;
    mkdirSync(join(app, "doc"));
    writeFileSync(join(app, draftPath), "<title>draft</title><h1>Idempotency-Key draft</h1>");
    // The first navigation of a background tab must reach the fixture even before
    // Playwright can attach to the tab and intercept requests.
    const transport = join(app, "demo-transport.js");
    const demo = readFileSync(transport, "utf8");
    const ietf = "https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/";
    assert.ok(demo.includes(ietf), "the conversation has the draft link");
    writeFileSync(transport, demo.replace(ietf, draftUrl));
    const chatPane = panes.api;
    const errors: string[] = [];

    const open = async (touch: boolean) => {
      const context = await newContext({ viewport: { width: 1280, height: 800 }, hasTouch: touch });
      await context.addInitScript(() => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", fileOpen: "panel" }));
        const clicks: { event: MouseEvent; reached: boolean }[] = [];
        Object.assign(window, { pressClicks: clicks });
        window.addEventListener("click", (event) => { clicks.push({ event, reached: false }); }, true);
        document.addEventListener("click", (event) => { const seen = clicks.find((click) => click.event === event); if (seen) seen.reached = true; });
        window.addEventListener("pointerdown", (event) => { Object.assign(window, { pressedOn: event.target }); }, true);
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(chatPane)}&view=chat`);
      const chatFrame = page.locator(`section.pane-frame[data-layout-pane=${JSON.stringify(chatPane)}]`);
      await chatFrame.locator("button.markdown-file", { hasText: "src/lib/idempotency.ts" }).waitFor();
      const shellPane = await page.evaluate(async (pane_id) => {
        const response = await window.fetch("/api/pane/split", { method: "POST", body: JSON.stringify({ pane_id, direction: "right" }) });
        return ((await response.json()) as { pane: { pane_id: string } }).pane.pane_id;
      }, chatPane);
      return { context, page, chatFrame, shellFrame: page.locator(`section.pane-frame[data-layout-pane=${JSON.stringify(shellPane)}]`), shellPane };
    };
    type Opened = Awaited<ReturnType<typeof open>>;
    const panelOf = (page: Opened["page"]) => page.locator("aside.file-panel:not(.files-panel)");
    const selected = (page: Opened["page"], pane: string) => page.waitForFunction((id) => new URLSearchParams(location.search).get("pane") === id, pane);

    const dock = async ({ page, shellFrame, shellPane }: Opened, touch = false) => {
      const head = shellFrame.locator(".pane-frame-head");
      await (touch ? head.tap() : head.click());
      await selected(page, shellPane);
      await panelOf(page).waitFor({ state: "detached" });
      const files = page.locator(".header-files-button");
      await (touch ? files.tap() : files.click());
      const readme = page.locator(".files-dialog").getByText("README.md", { exact: true });
      await (touch ? readme.tap() : readme.click());
      await panelOf(page).getByText("Shown for", { exact: false }).waitFor();
      assert.match((await panelOf(page).getAttribute("aria-label")) ?? "", /README\.md$/, "the shell pane's file docks beside the panes");
      await page.evaluate(() => { (window as unknown as { pressClicks: unknown[] }).pressClicks.length = 0; });
    };

    // The chat follows its end while its pane is laid out again beside the docked file, and a scroll
    // that no reader's input made is the layout's to it: it goes back to its end, and the link with
    // it. A press aimed at where the link was scrolled to then lands on another row, or outside the
    // window, where it selects no pane. Jump to latest says the chat follows its end no more: from
    // then on the link stays where it is scrolled to.
    const inView = async ({ chatFrame }: Opened, link: Locator) => {
      const away = chatFrame.locator(".chat-virtual-jump");
      const deadline = Date.now() + 10_000;
      for (;;) {
        await link.scrollIntoViewIfNeeded();
        await away.waitFor({ timeout: 250 }).catch(() => {});
        const rests = (await away.isVisible()) && await link.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
        });
        if (rests) return;
        if (Date.now() > deadline) throw new Error("the chat never left its end with the link in view");
      }
    };
    const pressedOn = (control: Locator) => control.evaluate((element) => {
      const pressed = (window as unknown as { pressedOn: EventTarget | null }).pressedOn;
      return pressed instanceof Node && element.contains(pressed);
    });

    const clicksOn = (page: Opened["page"], selector: string) => page.evaluate((selector) => {
      const pressed = document.querySelector(selector);
      return (window as unknown as { pressClicks: { event: MouseEvent; reached: boolean }[] }).pressClicks.map(({ event, reached }) => ({
        trusted: event.isTrusted, onPressed: event.target instanceof Node && pressed !== null && pressed.contains(event.target),
        cancelled: event.defaultPrevented, reached, ctrl: event.ctrlKey,
      }));
    }, selector);

    const handedOn = async (page: Opened["page"], selector: string, what: string) => {
      const clicks = await clicksOn(page, selector);
      const own = clicks.filter((click) => click.trusted);
      const handed = clicks.filter((click) => !click.trusted && click.onPressed);
      assert.equal(own.length, 1, `${what}: the press made one click`);
      assert.equal(own[0]!.onPressed, false, `${what}: the browser's click landed off the pressed control, so the press moved it and the hand-off ran`);
      assert.equal(own[0]!.cancelled, true, `${what}: the browser's own click is cancelled`);
      assert.equal(own[0]!.reached, false, `${what}: the browser's own click reaches nothing past the window`);
      assert.equal(handed.length, 1, `${what}: the pressed control gets the click`);
      return handed[0]!;
    };

    const fileLink = 'button.markdown-file';
    const desktop = await open(false);
    {
      const { page, chatFrame } = desktop;
      const panel = panelOf(page);
      const link = chatFrame.locator(fileLink, { hasText: "src/lib/idempotency.ts" });
      await dock(desktop);

      await inView(desktop, link);
      await link.click();
      await selected(page, chatPane);
      await panel.getByText("Shown for src/lib/idempotency.ts", { exact: false }).waitFor({ timeout: 5_000 }).catch(() => {});
      if (evidence) await page.screenshot({ path: join(evidence, "docked-file-link-other-pane-1280.png") });
      assert.equal(await panel.count(), 1, "the file the link names opens in the panel");
      assert.match((await panel.getAttribute("aria-label")) ?? "", /idempotency\.ts$/, "the panel shows the file of the pressed link");
      assert.equal(new URLSearchParams(new URL(page.url()).search).get("pane"), chatPane, "the pressed pane is the selected one");
      await handedOn(page, fileLink, "a mouse press on a file link");
      console.log("PASS a file link pressed in a pane that is not selected opens its file in the panel while another file is docked");

      await dock(desktop);
      await inView(desktop, link);
      const box = await link.boundingBox();
      const shellBox = await desktop.shellFrame.boundingBox();
      assert.ok(box && shellBox, "the link and the shell pane are laid out");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      assert.equal(await pressedOn(link), true, "the press landed on the link");
      await selected(page, chatPane);
      await page.mouse.move(shellBox.x + shellBox.width / 2, shellBox.y + shellBox.height / 2, { steps: 4 });
      await page.mouse.up();
      await panel.waitFor({ state: "attached", timeout: 1_000 }).catch(() => {});
      assert.equal(await panel.count(), 0, "a press dragged off the link opens nothing");
      console.log("PASS a press on that link dragged off it before the release opens nothing");

      for (const end of ["press", "blur"] as const) {
        await dock(desktop);
        await inView(desktop, link);
        const was = await link.boundingBox();
        assert.ok(was, "the link is laid out");
        const at = { x: was.x + was.width / 2, y: was.y + was.height / 2 };
        await link.evaluate((element, at) => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1, isPrimary: true, pointerType: "mouse", clientX: at.x, clientY: at.y })), at);
        await selected(page, chatPane);
        assert.equal(await link.evaluate((element, at) => element.contains(document.elementFromPoint(at.x, at.y)), at), false, "the press moved the link from under the pointer");
        if (end === "press") await page.mouse.click(at.x, at.y);
        else await page.evaluate((at) => {
          window.dispatchEvent(new Event("blur"));
          document.elementFromPoint(at.x, at.y)?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, clientX: at.x, clientY: at.y }));
        }, at);
        const clicks = await clicksOn(page, fileLink);
        assert.deepEqual(clicks.filter((click) => click.onPressed), [], `a later click where the link was, after ${end === "press" ? "a new press" : "the window lost focus"}, does not click the link`);
        assert.equal(await panel.count(), 0, "and opens nothing");
      }
      console.log("PASS a press that made no click hands no later click on to its link, after a new press or a lost focus");

      const webLink = `a[href=${JSON.stringify(draftUrl)}]`;
      await dock(desktop);
      const web = chatFrame.locator(webLink);
      await inView(desktop, web);
      const bounds = await web.boundingBox();
      assert.ok(bounds, "the web link is laid out");
      const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      await page.mouse.move(point.x, point.y);
      await page.keyboard.down("Control");
      await page.mouse.down();
      assert.equal(await pressedOn(web), true, "the Ctrl press landed on the web link");
      await selected(page, chatPane);
      // The release must hit the old point after the dock has moved the link.
      await page.waitForFunction(({ selector, x, y }) => {
        const link = document.querySelector(selector);
        return link !== null && !link.contains(document.elementFromPoint(x, y));
      }, { selector: webLink, ...point });
      const [opened] = await Promise.all([
        desktop.context.waitForEvent("page", { timeout: 5_000 }).catch(() => null),
        page.mouse.up(),
      ]);
      await page.keyboard.up("Control");
      const handed = await handedOn(page, webLink, "a Ctrl press on a web link");
      assert.equal(handed.ctrl, true, "the click handed on to the web link keeps Ctrl");
      assert.ok(opened, "the web link opens its page in a tab");
      await opened.waitForURL(draftUrl, { waitUntil: "commit" });
      await opened.getByRole("heading", { name: "Idempotency-Key draft", exact: true }).waitFor({ timeout: 10_000 });
      console.log("PASS a web link pressed with Ctrl in a pane that is not selected opens its page, keeping the key");
      await desktop.context.close();
    }

    // a finger's tap: the browser makes its click from a new hit test, which must not click what moved under the finger as well
    const touch = await open(true);
    {
      const { page, chatFrame } = touch;
      const link = chatFrame.locator(fileLink, { hasText: "src/lib/idempotency.ts" });
      await dock(touch, true);
      await inView(touch, link);
      await link.tap();
      await selected(page, chatPane);
      await panelOf(page).getByText("Shown for src/lib/idempotency.ts", { exact: false }).waitFor();
      await handedOn(page, fileLink, "a tap on a file link");
      console.log("PASS a tap on a file link in a pane that is not selected opens its file, and the tap clicks nothing else");
    }
    assert.deepEqual(errors, []);
  } finally { await draftServer.stop(true); }
});
