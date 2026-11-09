import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openMoreGroup } from "./header-more.ts";

// Search conversation (#2018) in the unmodified app over the demo's fixture transport: offered in
// the pane's menu and the palette where the PC's bridge searches, opened there, a pick opening the
// chat at its message, also one whose message changed since it was searched (#2958); and nowhere
// for a bridge that does not list `conversation-search`. All files
// and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "ovis-search-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });

/**
 * The pane's menu: a mouse right-clicks the pane; a phone's header, which lists the tabs, has More carry the pane's actions,
 * its find items under Find… when there are two of them (G-143).
 */
const paneMenu = async (page: Page, width: number): Promise<void> => {
  if (width >= 640) {
    await page.locator(".pane-frame.is-current .chat-view").click({ button: "right", position: { x: 300, y: 200 } });
    await page.getByText("Close pane", { exact: true }).first().waitFor();
    return;
  }
  await page.locator(".header-more-button").click();
  await page.locator(".row-sheet").waitFor();
  await openMoreGroup(page, "find");
  await page.getByText("Find in terminal", { exact: true }).waitFor();
};
const paletteActions = async (page: Page): Promise<string[]> => {
  await page.keyboard.press("Control+Shift+K");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("searchbox").fill(">search");
  await palette.getByRole("option").first().waitFor();
  return palette.locator('[role="option"] .menu-item-main').allTextContents();
};

/** The last match picked: the search closes, and the turn that holds the answer starts at the top of the view. */
const pickOpensAnswer = async (page: Page): Promise<void> => {
  const dialog = page.getByRole("dialog", { name: "Search conversation" });
  await dialog.getByRole("option").last().click();
  await dialog.waitFor({ state: "detached", timeout: 5_000 });
  await page.waitForFunction(() => {
    const view = document.querySelector(".pane-frame.is-current .chat-view")?.getBoundingClientRect();
    const row = [...document.querySelectorAll<HTMLElement>(".pane-frame.is-current [data-chat-row]")].find((node) => node.textContent?.includes("I'll look at how payments are created"));
    return view !== undefined && row !== undefined && Math.abs(row.getBoundingClientRect().top - view.top) <= 2;
  }, undefined, { timeout: 5_000 });
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  // `older` serves the app as a PC whose bridge predates the search: its features leave it out
  const older = `<script>(() => {
    if (!location.search.includes("older=1")) return;
    const Demo = window.WebSocket;
    const Older = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const push = socket.push?.bind(socket);
      if (push) socket.push = (message) => push(Array.isArray(message?.features) ? { ...message, features: message.features.filter((feature) => feature !== "conversation-search") } : message);
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Older, name, { value: Demo[name] });
    window.WebSocket = Older;
  })();</script>`;
  // `changed` names every match as its turn was named before it changed (an answer that went on,
  // a tool's output that came): no row has that name any more
  const changed = `<script>(() => {
    if (!location.search.includes("changed=1")) return;
    const demo = window.fetch;
    window.fetch = async (input, init) => {
      const answer = await demo(input, init);
      if (!new URL(input instanceof Request ? input.url : String(input), location.href).pathname.endsWith("/api/pane/conversation/search")) return answer;
      const body = await answer.json();
      return new Response(JSON.stringify({ ...body, matches: body.matches.map((match) => ({ ...match, turn: match.turn.slice(0, -1) })) }), { status: answer.status, headers: answer.headers });
    };
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${older}\n    ${changed}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
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
  const url = (query = "") => `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}${query}`;
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const [width, height] of [[1280, 800], [390, 844]] as const) {
      const context = await browser.newContext({ viewport: { width, height }, locale: "en-US", hasTouch: width < 640, isMobile: width < 640 });
      await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url());
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".pane-frame.is-current .chat-turn").first().waitFor();

      await paneMenu(page, width);
      if (evidence) await page.screenshot({ path: join(evidence, `conversation-search-menu-${width}.png`) });
      await page.getByText("Search conversation", { exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Search conversation" });
      await dialog.getByRole("searchbox").fill("replay");
      await dialog.getByText("Searched the whole conversation.").waitFor();
      // the agent's answers and the user's message; the commentary before the tools is work, and no tool's output counts
      assert.deepEqual(await dialog.locator(".conversation-search-snippet").allTextContents(), [
        "Adding a payments_idempotent_replays_total counter next to the existing request metrics.",
        "Nice. Now add a metric for replayed requests.",
        "…colliding. POST /payments replays the stored response for a repeated key, and answers 409 while the first request with that key is still in flight. A repeated key with a different body is…",
      ]);
      if (evidence) await page.screenshot({ path: join(evidence, `conversation-search-dialog-${width}.png`) });
      await pickOpensAnswer(page);
      console.log(`PASS ${width}: the pane's menu opens the search, and a pick opens the chat at its message`);

      // the answer changed since it was searched: the one turn that still holds the match opens
      await page.goto(url("&changed=1"));
      await page.locator(".pane-frame.is-current .chat-turn").first().waitFor();
      await paneMenu(page, width);
      await page.getByText("Search conversation", { exact: true }).click();
      await dialog.getByRole("searchbox").fill("replay");
      await dialog.getByText("Searched the whole conversation.").waitFor();
      await pickOpensAnswer(page);
      console.log(`PASS ${width}: a pick opens a message that changed since it was searched`);

      if (width >= 640) {
        assert.ok((await paletteActions(page)).includes("Search conversation"), "the palette offers the search for the selected chat");
        await page.keyboard.press("Enter");
        await dialog.waitFor();
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        console.log(`PASS ${width}: the palette opens it too`);
      }

      // a bridge that does not search: no menu item, no palette action
      await page.goto(url("&older=1"));
      await page.locator(".pane-frame.is-current .chat-turn").first().waitFor();
      await paneMenu(page, width);
      assert.equal(await page.getByText("Search conversation", { exact: true }).count(), 0, "no search where the PC's bridge has none");
      await page.keyboard.press("Escape");
      if (width >= 640) assert.ok(!(await paletteActions(page)).includes("Search conversation"));
      console.log(`PASS ${width}: a PC whose bridge does not search offers none`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
