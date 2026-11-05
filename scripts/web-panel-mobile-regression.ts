/** The actual same-host web panel in a mobile popup and on desktop, without a live herdr session. */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { contentSecurityPolicy } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-web-panel-")));
const repo = realpathSync(join(import.meta.dir, ".."));
const entry = join(root, "entry.ts");
const react = fileURLToPath(import.meta.resolve("react"));
const reactDom = fileURLToPath(import.meta.resolve("react-dom/client"));
writeFileSync(entry, `
  import React from ${JSON.stringify(react)};
  import { createRoot } from ${JSON.stringify(reactDom)};
  import { WebPanel } from ${JSON.stringify(join(repo, "src/components/WebPanel.tsx"))};
  import { MachineContext } from ${JSON.stringify(join(repo, "src/lib/machineContext.tsx"))};
  import { shouldOpenWebPage, WebPanelContext } from ${JSON.stringify(join(repo, "src/lib/webPanel.ts"))};
  import { SettingsProvider, useSettings } from ${JSON.stringify(join(repo, "src/lib/settings.ts"))};
  import { useWebPanel } from ${JSON.stringify(join(repo, "src/lib/useWebPanel.ts"))};
  import { FILE_PANEL_DOCK_QUERY } from ${JSON.stringify(join(repo, "src/lib/filePanelWidth.ts"))};
  import { useMediaQuery } from ${JSON.stringify(join(repo, "src/lib/useMediaQuery.ts"))};

  function WebLink({ href, label }) {
    const openWebPage = React.useContext(WebPanelContext);
    return React.createElement("a", {
      href, target: "_blank", rel: "noopener noreferrer",
      onClick: (event) => { if (shouldOpenWebPage(event, href, openWebPage, "local")) event.preventDefault(); },
    }, label);
  }

  function Demo() {
    const { settings } = useSettings();
    const docked = useMediaQuery(FILE_PANEL_DOCK_QUERY);
    const panels = useWebPanel({ settings, filePanelAvailable: docked });
    const report = new URLSearchParams(location.search).get("report") ?? "";
    return React.createElement(MachineContext.Provider, { value: "local" },
      React.createElement(WebPanelContext.Provider, { value: panels.openWebPage },
        React.createElement("main", { id: "conversation" },
          React.createElement("p", { id: "conversation-state" }, "Conversation remains open"),
          React.createElement(WebLink, { href: report, label: "same-host report" }),
          React.createElement(WebLink, { href: "https://external.example/report", label: "external page" }),
          React.createElement("button", { id: "unsafe", onClick: () => { (window as any).__unsafeOpened = panels.openWebPage("javascript:alert(1)", false, "local"); } }, "Try unsafe URL")),
        panels.webPage === null ? null : React.createElement(WebPanel, { key: panels.webPage, url: panels.webPage, docked, onClose: panels.closeWebPage })));
  }
  createRoot(document.getElementById("root")!).render(React.createElement(SettingsProvider, null, React.createElement(Demo)));
`);

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let appServer: ReturnType<typeof Bun.serve> | undefined;
let reportServer: ReturnType<typeof Bun.serve> | undefined;
const errors: string[] = [];

try {
  const bundle = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [{ name: "fixture-styles", setup(build) { build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" })); } }],
  });
  assert.ok(bundle.success, String(bundle.logs));
  const js = bundle.outputs.find((output) => output.path.endsWith(".js"));
  assert.ok(js, "fixture bundle contains JavaScript");
  const appCss = ["src/styles.css", "src/components/FileViewer.css", "src/components/ChatView.css"]
    .map((path) => Bun.file(join(repo, path)).text());
  const css = (await Promise.all(appCss)).join("\n");
  const script = await js.text();
  reportServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(
    `<!doctype html><html><body><h1>Report ready</h1><a href="#details">Details</a><section id="details">Report section</section></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  ) });
  appServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const url = new URL(request.url);
    const headers = { "content-security-policy": contentSecurityPolicy(url.origin) };
    if (url.pathname === "/entry.js") return new Response(script, { headers: { ...headers, "content-type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/styles.css") return new Response(css, { headers: { ...headers, "content-type": "text/css; charset=utf-8" } });
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/entry.js"></script></body></html>`,
      { headers: { ...headers, "content-type": "text/html; charset=utf-8" } },
    );
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const reportUrl = `http://127.0.0.1:${reportServer.port}/report`;
  const appUrl = `http://127.0.0.1:${appServer.port}/?report=${encodeURIComponent(reportUrl)}`;

  const defaultSettings = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    await defaultSettings.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    const page = await defaultSettings.newPage();
    await page.goto(appUrl);
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: "same-host report" }).tap();
    const popup = await popupPromise;
    await popup.waitForURL(reportUrl);
    await popup.getByRole("heading", { name: "Report ready" }).waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "the in-app popup requires opting in");
    await popup.close();
    console.log("PASS mobile default: web links remain in a new tab until the In the app option is chosen");
  } finally { await defaultSettings.close(); }

  const mobile = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, locale: "en-US" });
  try {
    await mobile.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", webLinks: "panel" })));
    await mobile.route("https://external.example/**", (route) => route.fulfill({ body: "<p>External page</p>", contentType: "text/html" }));
    const page = await mobile.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await page.goto(appUrl);
    const reportLink = page.getByRole("link", { name: "same-host report" });
    await reportLink.tap();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.ok(await page.evaluate(() => document.activeElement?.classList.contains("web-panel-body")), "opening focuses the page content");
    const reportFrame = page.frame({ url: (url) => url.href === reportUrl });
    assert.ok(reportFrame, "the report is loaded inside the popup frame");
    await reportFrame.getByRole("heading", { name: "Report ready" }).waitFor();
    await reportFrame.getByRole("link", { name: "Details" }).tap();
    await reportFrame.waitForURL(`${reportUrl}#details`);
    assert.equal(await page.getByRole("button", { name: "Close page" }).count(), 1, "mobile popup has a named close button");
    assert.equal(await page.locator("#conversation-state").innerText(), "Conversation remains open", "conversation stays mounted under the popup");
    await page.getByRole("button", { name: "Close page" }).tap();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await reportLink.evaluate((link) => document.activeElement === link), true, "closing returns focus to the report link");
    assert.equal(await page.locator("#conversation-state").innerText(), "Conversation remains open", "closing leaves the conversation intact");

    await reportLink.tap();
    await dialog.waitFor();
    await page.goBack();
    await dialog.waitFor({ state: "detached" });
    assert.equal(await page.locator("#conversation-state").count(), 1, "mobile browser Back closes the popup without navigating away");

    await page.evaluate(() => {
      const under = document.createElement("div");
      under.id = "under-dialog";
      under.setAttribute("role", "dialog");
      document.querySelector("#conversation")!.append(under);
    });
    await reportLink.tap();
    await page.locator(".web-panel-popup").waitFor();
    await page.keyboard.press("Escape");
    await page.locator(".web-panel-popup").waitFor({ state: "detached" });
    assert.equal(await page.locator("#under-dialog").count(), 1, "Escape closes the top report even with a dialog beneath it");
    await page.locator("#under-dialog").evaluate((node) => node.remove());

    const externalPopupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: "external page" }).tap();
    const externalPopup = await externalPopupPromise;
    await externalPopup.getByText("External page").waitFor();
    assert.equal(new URL(externalPopup.url()).hostname, "external.example", "other hosts still open in a new tab");
    await externalPopup.close();

    await page.getByRole("button", { name: "Try unsafe URL" }).tap();
    assert.equal(await page.evaluate(() => (window as any).__unsafeOpened), false, "unsafe schemes are refused by the in-app target gate");
    assert.equal(await page.getByRole("dialog").count(), 0, "unsafe schemes do not open an in-app popup");
    assert.deepEqual(errors, [], "mobile fixture has no page errors");
    console.log("PASS mobile: same-host report opens in a modal, closes with focus/history return, and leaves conversation mounted");
    console.log("PASS mobile: external and unsafe links retain their existing boundaries");
  } finally { await mobile.close(); }

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    await desktop.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", webLinks: "panel" })));
    const page = await desktop.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10_000);
    await page.goto(appUrl);
    await page.evaluate(() => history.pushState({ conversation: "kept" }, "", "#conversation"));
    await page.getByRole("link", { name: "same-host report" }).click();
    await page.locator(".web-panel").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "desktop still uses the docked panel");
    assert.equal(await page.evaluate(() => Object.hasOwn(window.history.state ?? {}, "ovis:web-panel")), false, "desktop panel does not add a popup history entry");
    assert.equal(await page.locator("#conversation-state").innerText(), "Conversation remains open", "desktop panel leaves the conversation in place");
    const conversationUrl = page.url();
    await page.setViewportSize({ width: 393, height: 800 });
    await page.getByRole("dialog").waitFor();
    await page.waitForFunction(() => history.state?.["ovis:web-panel"] !== undefined);
    await page.goBack();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(page.url(), conversationUrl, "Back after shrinking closes only the report");
    assert.equal(await page.evaluate(() => history.state?.conversation), "kept", "the existing conversation state is preserved");
    assert.equal(await page.locator("#conversation-state").count(), 1, "the conversation survives shrinking and Back");

    await page.getByRole("link", { name: "same-host report" }).click();
    await page.getByRole("dialog").waitFor();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(".web-panel").waitFor();
    await page.waitForFunction(() => history.state?.["ovis:web-panel"] === undefined);
    await page.goBack();
    await page.locator(".web-panel").waitFor({ state: "detached" });
    assert.equal(page.url(), conversationUrl, "Back after widening preserves the conversation entry");
    assert.equal(await page.evaluate(() => history.state?.conversation), "kept", "Back after widening consumes only the report's entry");
    await page.getByRole("link", { name: "same-host report" }).click();
    await page.locator(".web-panel").waitFor();
    await page.setViewportSize({ width: 393, height: 800 });
    await page.getByRole("dialog").waitFor();
    await page.waitForFunction(() => history.state?.["ovis:web-panel"] !== undefined);
    await page.goBack();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.equal(page.url(), conversationUrl, "a second shrink adds a working modal entry");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("link", { name: "same-host report" }).click();
    await page.locator(".web-panel").waitFor();
    const frame = page.frame({ url: (url) => url.href === reportUrl });
    assert.ok(frame, "docked report frame is loaded");
    await frame.getByRole("link", { name: "Details" }).click();
    await frame.waitForURL(`${reportUrl}#details`);
    for (let i = 0; i < 3; i++) {
      await page.setViewportSize({ width: 900, height: 800 });
      await page.locator(".web-panel-popup").waitFor();
      await page.waitForFunction(() => history.state?.["ovis:web-panel"] !== undefined);
      assert.equal(frame.url(), `${reportUrl}#details`, "shrinking keeps the same frame and its navigation");
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.locator(".web-panel").waitFor();
      await page.waitForFunction(() => history.state?.["ovis:web-panel-docked"] === true);
      assert.equal(frame.url(), `${reportUrl}#details`, "widening keeps the same frame and its navigation");
    }
    await page.getByRole("button", { name: "Close page" }).click();
    await page.locator(".web-panel").waitFor({ state: "detached" });
    await page.waitForFunction(() => history.state?.["ovis:web-panel-docked"] === undefined);

    const repeat = await desktop.newPage();
    await repeat.goto(appUrl);
    await repeat.evaluate(() => history.pushState({ conversation: "repeat" }, "", "#repeat"));
    await repeat.getByRole("link", { name: "same-host report" }).click();
    for (let i = 0; i < 3; i++) {
      await repeat.setViewportSize({ width: 900, height: 800 });
      await repeat.waitForFunction(() => history.state?.["ovis:web-panel"] !== undefined);
      await repeat.setViewportSize({ width: 1280, height: 800 });
      await repeat.waitForFunction(() => history.state?.["ovis:web-panel-docked"] === true);
    }
    await repeat.getByRole("button", { name: "Close page" }).click();
    await repeat.waitForFunction(() => history.state?.conversation === "repeat" && history.state?.["ovis:web-panel-docked"] === undefined);
    await repeat.goBack();
    assert.notEqual(new URL(repeat.url()).hash, "#repeat", "one Back after closing leaves the conversation without accumulated report entries");
    await repeat.close();

    const reportLink = page.getByRole("link", { name: "same-host report" });
    // Browser-native modifier openings have no page opener; observe the context's new page.
    const shiftPopupPromise = desktop.waitForEvent("page");
    await reportLink.click({ modifiers: ["Shift"] });
    const shiftPopup = await shiftPopupPromise;
    await shiftPopup.waitForURL(reportUrl);
    await shiftPopup.getByRole("heading", { name: "Report ready" }).waitFor();
    assert.equal(await page.locator(".web-panel").count(), 0, "desktop Shift-click does not open the docked panel");
    await shiftPopup.close();

    const modifiedPopupPromise = desktop.waitForEvent("page");
    await reportLink.click({ modifiers: ["Control"] });
    const modifiedPopup = await modifiedPopupPromise;
    await modifiedPopup.waitForURL(reportUrl);
    await modifiedPopup.getByRole("heading", { name: "Report ready" }).waitFor();
    assert.equal(await page.locator(".web-panel").count(), 0, "desktop Ctrl-click does not open the docked panel");
    await modifiedPopup.close();

    assert.deepEqual(errors, [], "desktop fixture has no page errors");
    console.log("PASS desktop: docked panel, close behavior, and modifier-click boundaries remain");
  } finally { await desktop.close(); }
} finally {
  await browser?.close();
  appServer?.stop(true);
  reportServer?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
