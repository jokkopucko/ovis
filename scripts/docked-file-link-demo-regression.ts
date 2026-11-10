import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A file link in a pane that is not the selected one, pressed while a file is docked beside the
// panes (#3368): the press selects that pane, which closes the docked file and widens the panes
// under the pointer before the button is released. The file the link names must still open in the
// panel, and the pane it was pressed in must be the selected one. Runs the unmodified app over the
// demo's fixture transport at a desktop's width; no herdr session is opened.
// The same holds for a web link, and for a finger's tap. Every press records where the browser sent
// its click: a click that landed on the pressed link proves nothing, as nothing moved under it. A
// press that never makes a click (a long press, a release outside the window) must not hand a later
// click on to the link it pressed.
// Screenshots go to UI_EVIDENCE_DIR when it is set.
const app = mkdtempSync(join(tmpdir(), "ovis-docked-file-link-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;

// the demo has no files: its folders list README.md, and every path reads as a short text file
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

const server = await (async () => {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${FILES_SCRIPT}\n    <script type="module"`));
  return Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
})();

try {
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    if (evidence) mkdirSync(evidence, { recursive: true });
    const chatPane = panes.api;
    const errors: string[] = [];

    // the demo's chat in a tab split in two; returns the shell pane opened beside it
    const open = async (touch: boolean) => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", hasTouch: touch });
      await context.addInitScript(() => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", fileOpen: "panel" }));
        // every click as the window sees it first, and whether it got past the window
        const clicks: { event: MouseEvent; reached: boolean }[] = [];
        Object.assign(window, { pressClicks: clicks });
        window.addEventListener("click", (event) => { clicks.push({ event, reached: false }); }, true);
        document.addEventListener("click", (event) => { const seen = clicks.find((click) => click.event === event); if (seen) seen.reached = true; });
        // what the last press landed on
        window.addEventListener("pointerdown", (event) => { Object.assign(window, { pressedOn: event.target }); }, true);
      });
      // the web link's site, so a tab it opens has a page to show
      await context.route("https://datatracker.ietf.org/**", (route) => route.fulfill({ contentType: "text/html", body: "<title>draft</title>" }));
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(chatPane)}&view=chat`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
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

    // the shell pane is selected and opens a file from Files, which docks beside the panes; the press starts from here
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

    // the clicks since the dock: the browser's own, and the ones handed on to `selector`
    const clicksOn = (page: Opened["page"], selector: string) => page.evaluate((selector) => {
      const pressed = document.querySelector(selector);
      return (window as unknown as { pressClicks: { event: MouseEvent; reached: boolean }[] }).pressClicks.map(({ event, reached }) => ({
        trusted: event.isTrusted, onPressed: event.target instanceof Node && pressed !== null && pressed.contains(event.target),
        cancelled: event.defaultPrevented, reached, ctrl: event.ctrlKey,
      }));
    }, selector);

    // the browser's click left the pressed control (the press moved it), was cancelled and reached
    // nothing else, and the control alone got the click
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

      // a real press and release on the chat's file link, as a mouse makes them
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

      // a press on the link dragged off it before the release is no click, as on a link that stayed put
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

      // a press that makes no click (a long press, a release outside the window), then an unrelated
      // click where the link was: the link is not clicked, whether the next press or a lost focus ends the watch
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

      // a web link in the same answer, pressed with Ctrl: its click keeps the key, so the browser opens a tab
      const webLink = 'a[href^="https://datatracker.ietf.org/"]';
      await dock(desktop);
      await inView(desktop, chatFrame.locator(webLink));
      const tab = desktop.context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
      await chatFrame.locator(webLink).click({ modifiers: ["Control"] });
      await selected(page, chatPane);
      const handed = await handedOn(page, webLink, "a Ctrl press on a web link");
      assert.equal(handed.ctrl, true, "the click handed on to the web link keeps Ctrl");
      const opened = await tab;
      assert.ok(opened, "the web link opens its page in a tab");
      await opened.waitForURL(/datatracker\.ietf\.org/);
      console.log("PASS a web link pressed with Ctrl in a pane that is not selected opens its page, keeping the key");
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
  } finally { await browser.close(); }
} finally {
  await server.stop(true);
  rmSync(app, { recursive: true, force: true });
}
