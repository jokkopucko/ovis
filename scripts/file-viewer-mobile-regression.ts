import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { sheetsSettled } from "./sheets-settled.ts";
import { chromePath } from "./chrome-path.ts";

async function checkLayout(): Promise<void> {
  const fixture = mkdtempSync(join(tmpdir(), "ovis-viewer-layout-"));
  const repo = join(import.meta.dir, "..");
  const sharedCss = readFileSync(join(repo, "src/styles.css"), "utf8");
  const viewerCss = readFileSync(process.env.FILE_VIEWER_CSS ?? join(repo, "src/components/FileViewer.css"), "utf8");
  const entry = join(fixture, "entry.ts");
  writeFileSync(entry, `
    import React from ${JSON.stringify(join(repo, "node_modules/react/index.js"))};
    import { createRoot } from ${JSON.stringify(join(repo, "node_modules/react-dom/client.js"))};
    import { FileViewer } from ${JSON.stringify(join(repo, "src/components/FileViewer.tsx"))};
    import { SettingsProvider } from ${JSON.stringify(join(repo, "src/lib/settings.ts"))};
    const query = new URLSearchParams(location.search);
    const name = query.get("kind") === "text" ? "notes-" + "very-long-unbroken-name-".repeat(30) + ".ts" : "image-" + "very-long-unbroken-name-".repeat(30) + ".svg";
    const path = "/workspace/" + "long-directory/".repeat(40) + name;
    const height = query.get("height");
    if (height) document.documentElement.style.setProperty("--app-height", height + "px");
    /** The viewer as the app mounts it, so Close unmounts it as it would there. */
    function Demo() {
      const [open, setOpen] = React.useState(true);
      return React.createElement(SettingsProvider, null, open
        ? React.createElement(FileViewer, { path, paneId: query.get("kind") === "mutable" ? "fixture-pane" : null, onClose: () => setOpen(false) })
        : React.createElement("div", null, React.createElement("p", { id: "closed" }, "Viewer closed"), React.createElement("button", { onClick: () => setOpen(true) }, "Reopen image")));
    }
    createRoot(document.getElementById("root")).render(React.createElement(Demo));
  `);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let imageRevision = 1;
  try {
    const bundle = await Bun.build({
      entrypoints: [entry], target: "browser", define: { "process.env.NODE_ENV": JSON.stringify("development") },
      plugins: [{ name: "fixture-styles", setup(build) {
        build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }));
      } }],
    });
    assert.ok(bundle.success, String(bundle.logs));
    const js = bundle.outputs.find((output) => output.path.endsWith(".js"));
    assert.ok(js, "fixture bundle contains JavaScript");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/entry.js") return new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (url.pathname === "/styles.css") {
        const insets = url.searchParams.get("safe") === "portrait"
          ? { top: 59, right: 0, bottom: 34, left: 0 }
          : url.searchParams.get("safe") === "landscape"
            ? { top: 0, right: 59, bottom: 21, left: 59 }
            : { top: 0, right: 0, bottom: 0, left: 0 };
        const css = `${sharedCss}\n${viewerCss}`.replace(/env\(safe-area-inset-(top|right|bottom|left),\s*0px\)/g,
          (_, side: keyof typeof insets) => `${insets[side]}px`);
        return new Response(css, { headers: { "content-type": "text/css" } });
      }
      if (url.pathname === "/api/fs/stat") {
        const path = url.searchParams.get("path")!;
        if (new URL(request.headers.get("referer")!).searchParams.get("kind") === "text") return Response.json({ path, name: path.split("/").pop(), kind: "text", mime: "text/plain", size: 650 });
        return Response.json({ path, name: path.split("/").pop(), kind: "image", mime: "image/svg+xml", size: 2048, modified: `2026-01-01T00:00:0${imageRevision}.000Z` });
      }
      if (url.pathname === "/api/fs/file") {
        if (new URL(request.headers.get("referer")!).searchParams.get("kind") === "text") return new Response("const x = 1;\n".repeat(50), { headers: { "content-type": "text/plain" } });
        if (new URL(request.headers.get("referer")!).searchParams.get("kind") === "mutable") {
          return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="${imageRevision * 64}" height="32"><rect width="100%" height="100%" fill="teal"/></svg>`,
            { headers: { "content-type": "image/svg+xml", "cache-control": "private, no-store" } });
        }
        const wide = new URL(request.headers.get("referer")!).searchParams.get("image") === "wide";
        const [width, height] = wide ? [6000, 400] : [400, 6000];
        return new Response(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
          { headers: { "content-type": "image/svg+xml" } });
      }
      // A module script: the bundle is ESM, and FileViewer reaches `new URL(…, import.meta.url)` for its
      // workers, which a classic script cannot parse. The fixture's text is short enough to be
      // highlighted on the page, so no worker is ever started here.
      return new Response(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/styles.css?safe=${url.searchParams.get("safe") ?? "none"}"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } });
    } });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    const cases = [
      { name: "portrait", width: 393, height: 852, touch: true, safe: "none", top: 0, side: 0, bottom: 0 },
      { name: "portrait-notch", width: 393, height: 852, touch: true, safe: "portrait", top: 59, side: 0, bottom: 34 },
      { name: "landscape", width: 852, height: 393, touch: true, safe: "none", top: 0, side: 0, bottom: 0 },
      { name: "landscape-notch", width: 852, height: 393, touch: true, safe: "landscape", top: 0, side: 59, bottom: 21 },
      { name: "portrait-keyboard", width: 393, height: 852, appHeight: 300, touch: true, safe: "portrait", top: 59, side: 0, bottom: 34 },
      { name: "landscape-keyboard", width: 852, height: 393, appHeight: 200, touch: true, safe: "landscape", top: 0, side: 59, bottom: 21 },
      { name: "desktop", width: 1440, height: 900, touch: false, safe: "none", top: 0, side: 0, bottom: 0 },
      { name: "desktop-short", width: 1024, height: 240, touch: false, safe: "none", top: 0, side: 0, bottom: 0 },
    ];
    for (const scenario of cases.filter((item) => !process.env.FILE_VIEWER_CASE || item.name === process.env.FILE_VIEWER_CASE)) {
      const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, isMobile: scenario.touch, hasTouch: scenario.touch, locale: "en-US" });
      try {
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.setDefaultTimeout(10_000);
        for (const image of ["tall", "wide"]) {
          const label = `${scenario.name}/${image}`;
          const limit = "appHeight" in scenario ? scenario.appHeight! : scenario.height;
          await page.goto(`http://127.0.0.1:${server.port}/?safe=${scenario.safe}&image=${image}&height=${"appHeight" in scenario ? scenario.appHeight : ""}`);
          await page.waitForFunction(() => {
            const image = document.querySelector<HTMLImageElement>(".file-viewer-media");
            return image?.complete && image.naturalWidth > 0;
          });
          // a phone's viewer rises into place (styles.css): measure where it comes to rest
          await sheetsSettled(page);
          const geometry = await page.evaluate(() => {
            const rect = (element: Element) => {
              const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
              return { x, y, width, height, right, bottom };
            };
            const dialog = document.querySelector<HTMLElement>(".file-viewer")!;
            const header = document.querySelector<HTMLElement>(".file-viewer-header")!;
            const body = document.querySelector<HTMLElement>(".file-viewer-body")!;
            const title = document.querySelector<HTMLElement>(".file-viewer-title .file-viewer-stem")!;
            const controls = [...header.querySelectorAll<HTMLElement>(".icon-button")].filter((element) => element.getClientRects().length > 0).map((element) => {
              const bounds = rect(element);
              const points = [[bounds.x + 8, bounds.y + 8], [bounds.right - 8, bounds.y + 8], [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2], [bounds.x + 8, bounds.bottom - 8], [bounds.right - 8, bounds.bottom - 8]];
              const hits = points.map(([x, y]) => document.elementFromPoint(x!, y!));
              return { ...bounds, unobstructed: hits.every((hit) => element.contains(hit)) };
            });
            return { dialog: rect(dialog), header: rect(header), body: rect(body), controls,
              title: { ...rect(title), scrollWidth: title.scrollWidth, clientWidth: title.clientWidth, overflow: getComputedStyle(title).textOverflow },
              documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight };
          });
          // an image opens in a new tab, downloads (a new tab in an installed app need not save it) and
          // closes; up to 600px the first two are in More
          assert.equal(geometry.controls.length, scenario.width <= 600 ? 2 : 3, label);
          assert.ok(geometry.dialog.x >= -1 && geometry.dialog.right <= scenario.width + 1, `${label}: dialog fits width`);
          assert.ok(geometry.dialog.y >= -1 && geometry.dialog.bottom <= limit + 1, `${label}: dialog fits usable height`);
          for (const control of geometry.controls) {
            assert.ok(control.x >= scenario.side && control.right <= scenario.width - scenario.side, `${label}: full control inside safe width ${JSON.stringify(control)}`);
            assert.ok(control.y >= scenario.top && control.bottom <= limit - scenario.bottom, `${label}: full control inside safe height ${JSON.stringify(control)}`);
            assert.ok(control.unobstructed, `${label}: control hit-test inside rounded corners and center ${JSON.stringify(control)}`);
            if (scenario.touch) assert.ok(control.width >= 44 && control.height >= 44, `${label}: tappable target`);
            assert.ok(control.y >= geometry.header.y && control.bottom <= geometry.header.bottom + 1, `${label}: header cannot collapse around controls`);
          }
          assert.equal(geometry.title.overflow, "ellipsis", `${label}: title truncation`);
          assert.ok(geometry.title.scrollWidth > geometry.title.clientWidth, `${label}: long title is constrained`);
          assert.ok((await page.locator(".file-viewer-title .modal-title").innerText()).endsWith(".svg"), `${label}: the extension stays in the title`);
          assert.ok(geometry.documentWidth <= scenario.width && geometry.documentHeight <= scenario.height, `${label}: no document scrolling`);
          await page.locator(".file-viewer-media").evaluate((element) => {
            (element as HTMLElement).style.height = "4000px";
            (element as HTMLElement).style.maxHeight = "none";
          });
          const scrolling = await page.locator(".file-viewer-body").evaluate((element) => {
            const header = document.querySelector(".file-viewer-header")!;
            const before = header.getBoundingClientRect().y;
            element.scrollTop = 2000;
            return { scrollTop: element.scrollTop, headerMoved: header.getBoundingClientRect().y !== before, documentTop: document.documentElement.scrollTop, pageHeight: document.documentElement.scrollHeight };
          });
          assert.ok(scrolling.scrollTop > 0, `${label}: tall content scrolls in body`);
          assert.equal(scrolling.headerMoved, false, `${label}: header remains fixed`);
          assert.equal(scrolling.documentTop, 0, `${label}: page does not scroll`);
          assert.ok(scrolling.pageHeight <= scenario.height, `${label}: oversized content cannot grow page`);
          const close = page.getByRole("button", { name: "Close file", exact: true });
          if (scenario.touch) await close.tap(); else await close.click();
          await page.locator("#closed").waitFor();
          assert.equal(await page.getByRole("dialog").count(), 0, `${label}: actual close callback removes dialog`);
          assert.deepEqual(errors, [], label);
          console.log(`PASS ${label}: safe, tappable controls; body-only scroll; actual close`);
        }
      } finally { await context.close(); }
    }
    const mutableContext = await browser.newContext({ locale: "en-US" });
    try {
      const page = await mutableContext.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/?kind=mutable`);
      const image = page.locator("img.file-viewer-media");
      await page.waitForFunction(() => document.querySelector<HTMLImageElement>("img.file-viewer-media")?.naturalWidth === 64);
      const original = new URL(await image.getAttribute("src") ?? "", page.url());
      imageRevision = 2;
      await page.getByRole("button", { name: "Close file", exact: true }).click();
      await page.getByRole("button", { name: "Reopen image", exact: true }).click();
      await image.waitFor();
      const updated = new URL(await image.getAttribute("src") ?? "", page.url());
      assert.notEqual(updated.href, original.href, "changed metadata changes the image identity, including same-size overwrites");
      assert.equal(updated.pathname, original.pathname, "versioning keeps the existing API route");
      assert.equal(updated.searchParams.get("path"), original.searchParams.get("path"), "versioning preserves the file path");
      assert.equal(updated.searchParams.get("pane_id"), "fixture-pane", "versioning preserves pane-scoped resolution");
      await page.waitForFunction(() => document.querySelector<HTMLImageElement>("img.file-viewer-media")?.naturalWidth === 128);
      await page.getByRole("button", { name: "Close file", exact: true }).click();
      await page.getByRole("button", { name: "Reopen image", exact: true }).click();
      await image.waitFor();
      assert.equal(new URL(await image.getAttribute("src") ?? "", page.url()).href, updated.href, "unchanged metadata keeps the same image identity");
      console.log("PASS same-path image overwrite: reopening uses the latest revision, unchanged metadata keeps its URL");
    } finally { await mutableContext.close(); }
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
    try {
      const page = await phone.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(10_000);
      await page.goto(`http://127.0.0.1:${server.port}/?kind=text`);
      await page.locator(".file-viewer-text").waitFor();
      await page.getByRole("button", { name: "Copy file", exact: true }).waitFor();
      // Main's sheet entrance moves every header element; compare their settled positions.
      await sheetsSettled(page);
      const dialog = await page.locator(".file-viewer").boundingBox();
      assert.ok(dialog, "text: dialog is laid out");
      const buttons = page.locator(".file-viewer-actions .icon-button:visible");
      assert.deepEqual(await buttons.evaluateAll((all) => all.map((button) => button.getAttribute("aria-label"))), ["Copy file", "More"], "text: Copy and More; new tab and download wait in More");
      const title = (await page.locator(".file-viewer-title").boundingBox())!;
      const close = (await page.getByRole("button", { name: "Close file", exact: true }).boundingBox())!;
      const middle = (box: { y: number; height: number }) => box.y + box.height / 2;
      assert.ok(Math.abs(middle(close) - middle(title)) < 4, "text: Close shares the name's row");
      assert.ok(close.x + close.width >= dialog.x + dialog.width - 32, "text: Close sits in the right corner");
      for (let index = 0; index < 2; index++) {
        const box = await buttons.nth(index).boundingBox();
        assert.ok(box, `text: button ${index} is laid out`);
        assert.ok(Math.abs(middle(box) - middle(title)) < 4, `text: button ${index} shares the name's row`);
        assert.ok(box.x >= title.x + title.width - 1 && box.x + box.width <= close.x + 1, `text: button ${index} between the name and Close`);
      }
      assert.ok((await page.locator(".file-viewer-title .modal-title").innerText()).endsWith(".ts"), "text: the extension stays in the title");
      await page.getByRole("button", { name: "More", exact: true }).tap();
      assert.deepEqual((await page.getByRole("menuitem").allTextContents()).map((item) => item.trim()), ["Open in a new tab", "Download"], "text: More holds new tab and download");
      assert.deepEqual(errors, []);
      console.log("PASS text: the name, Copy, More and Close on one row at 390px; new tab and download in More");
    } finally { await phone.close(); }
  } finally {
    await browser?.close();
    server?.stop();
    rmSync(fixture, { recursive: true, force: true });
  }
}

await checkLayout();
