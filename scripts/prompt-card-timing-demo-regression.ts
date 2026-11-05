/**
 * The prompt card stays on screen while its prompt does: a chat drawn again (back from the Terminal
 * lens) and a socket that reconnects keep the card in every painted frame, as the conversation keeps
 * its turns. A card answered in the terminal is not drawn again, and the card comes and goes with
 * herdr's blocked status, not at the next 2 s poll. On the unmodified app over the demo's fixture
 * transport, whose "web" pane has an approval open; the screen read (GET /api/pane/prompt) takes
 * PROMPT_READ_MS, as the server's does. Loopback only; no herdr session is opened.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const PROMPT_READ_MS = 150;
// the chat's prompt poll (src/components/ChatView.tsx PROMPT_POLL_MS): a status change must not wait for it
const PROMPT_POLL_MS = 2000;
const app = mkdtempSync(join(tmpdir(), "herdr-prompt-card-timing-"));

// every painted frame of the web pane: whether its composer and its card are drawn (sampled in a
// task posted from rAF, after the rendering step); the socket kept so the script can drop it; the
// prompt reads answered, counted
const HOOKS = `<script>(() => {
  const demo = window.fetch;
  window.promptReads = 0;
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname !== "/api/pane/prompt") return demo(input, init);
    // answered in the terminal: the screen asks nothing any more
    const read = () => window.promptGone ? demo(input, init).then((response) => response.json()).then((body) => new Response(JSON.stringify({ ...body, prompt: null }), { headers: { "content-type": "application/json" } })) : demo(input, init);
    return new Promise((done) => setTimeout(done, ${PROMPT_READ_MS})).then(read).finally(() => { window.promptReads += 1; });
  };
  const Demo = window.WebSocket;
  window.keptSockets = [];
  const Kept = function (url, protocols) { const socket = new Demo(url, protocols); window.keptSockets.push(socket); return socket; };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Kept, name, { value: Demo[name] });
  window.WebSocket = Kept;
  window.paints = [];
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const pane = document.querySelector('.pane-frame[data-layout-pane="${panes.web}"]');
    window.paints.push({ at: performance.now(), composer: pane?.querySelector(".composer-text") != null, card: pane?.querySelector(".prompt-card") != null });
    requestAnimationFrame(() => channel.port2.postMessage(0));
  };
  requestAnimationFrame(() => channel.port2.postMessage(0));
})();</script>`;

/** How long, from the first painted frame without the card to the next one with it, the composer stood alone (ms; 0: never). */
const cardlessPaints = (page: Page, from: number): Promise<number> => page.evaluate((start) => {
  const paints = (window as unknown as { paints: { at: number; composer: boolean; card: boolean }[] }).paints.slice(start);
  const first = paints.findIndex((paint) => paint.composer && !paint.card);
  if (first < 0) return 0;
  const back = paints.slice(first).find((paint) => paint.card);
  return Math.round((back ?? paints.at(-1)!).at - paints[first]!.at) || 1;
}, from);
const paintCount = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { paints: unknown[] }).paints.length);

/**
 * herdr reports the web pane blocked (its prompt open) or working (answered in the terminal) just
 * after a prompt read answered, so the next poll is about PROMPT_POLL_MS away: the ms from that
 * report to the first painted frame whose card is `shown` (or not).
 */
const cardAfterStatus = async (page: Page, status: "blocked" | "working"): Promise<number> => {
  const reads = await page.evaluate(() => (window as unknown as { promptReads: number }).promptReads);
  await page.waitForFunction((count) => (window as unknown as { promptReads: number }).promptReads > count, reads, { timeout: PROMPT_POLL_MS * 2 });
  const start = await page.evaluate(([pane, next]) => {
    const hooks = window as unknown as { promptGone: boolean; paints: unknown[]; __herdrDemoOrder: { status: (pane: string, status: string) => void } };
    hooks.promptGone = next !== "blocked";
    hooks.__herdrDemoOrder.status(pane, next);
    return { at: performance.now(), from: hooks.paints.length };
  }, [panes.web, status] as const);
  const shown = status === "blocked";
  await page.waitForFunction(([from, card]) => (window as unknown as { paints: { composer: boolean; card: boolean }[] }).paints.slice(from as number).some((paint) => paint.composer && paint.card === card), [start.from, shown] as const, { timeout: PROMPT_POLL_MS * 3 });
  return page.evaluate(([from, card, at]) => Math.round((window as unknown as { paints: { at: number; composer: boolean; card: boolean }[] }).paints.slice(from as number).find((paint) => paint.composer && paint.card === card)!.at - (at as number)), [start.from, shown, start.at] as const);
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${HOOKS}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    let file = decodeURIComponent(new URL(request.url).pathname.replace(/^\/app\//, ""));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    await context.addInitScript(() => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat" }));
      localStorage.setItem("ovis:pane-lifetime:local", "demo-local");
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}/app/?pane=${encodeURIComponent(panes.web)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".prompt-card").waitFor();

    // back from the Terminal lens: the chat is drawn again, and so is the card the screen still shows
    await page.locator(".view-switch button", { hasText: "Terminal" }).click();
    await page.locator(".terminal-stack.is-chat").waitFor({ state: "detached" });
    let from = await paintCount(page);
    await page.locator(".view-switch button", { hasText: "Chat" }).click();
    await page.locator(".prompt-card").waitFor();
    // fixed wait: the frames painted after the chat is back are watched for a card that goes, which nothing announces
    await page.waitForTimeout(500);
    const afterLens = await cardlessPaints(page, from);

    // a socket that drops and reconnects: the screen did not change, the card stays
    from = await paintCount(page);
    await page.evaluate(() => { (window as unknown as { keptSockets: WebSocket[] }).keptSockets.at(-1)!.close(); });
    await page.locator(".conn-reconnecting").waitFor({ state: "attached" });
    await page.locator(".conn-live").waitFor({ state: "attached", timeout: 15_000 });
    // fixed wait: the frames after the reconnect are watched for a card that goes, which nothing announces
    await page.waitForTimeout(PROMPT_READ_MS * 3);
    const afterReconnect = await cardlessPaints(page, from);

    // the approval answered in the Terminal lens: back in Chat, its card is not drawn again
    await page.locator(".view-switch button", { hasText: "Terminal" }).click();
    await page.locator(".terminal-stack.is-chat").waitFor({ state: "detached" });
    // the answer sets the agent to work again, as herdr reports it
    await page.evaluate((pane) => {
      (window as unknown as { promptGone: boolean }).promptGone = true;
      (window as unknown as { __herdrDemoOrder: { status: (pane: string, status: string) => void } }).__herdrDemoOrder.status(pane, "working");
    }, panes.web);
    from = await paintCount(page);
    await page.locator(".view-switch button", { hasText: "Chat" }).click();
    await page.locator(".composer-text").first().waitFor();
    // fixed wait: the frames after the chat is back are watched for the old card, which nothing announces
    await page.waitForTimeout(PROMPT_READ_MS * 4);
    const staleCard = await page.evaluate((start) => {
      const paints = (window as unknown as { paints: { at: number; composer: boolean; card: boolean }[] }).paints.slice(start).filter((paint) => paint.composer);
      const shown = paints.filter((paint) => paint.card);
      return shown.length === 0 ? 0 : Math.round(shown.at(-1)!.at - shown[0]!.at) || 1;
    }, from);

    // the agent asks again, then the question is answered in the terminal: the card follows herdr's status at once
    const shownAfterBlocked = await cardAfterStatus(page, "blocked");
    const goneAfterWorking = await cardAfterStatus(page, "working");

    console.log(`answered in the terminal: the old card drawn ${staleCard} ms back in Chat`);
    console.log(`composer drawn without the card: ${afterLens} ms back from the Terminal lens, ${afterReconnect} ms across a socket reconnect`);
    console.log(`the card shown ${shownAfterBlocked} ms after herdr says blocked, gone ${goneAfterWorking} ms after it says working (poll every ${PROMPT_POLL_MS} ms)`);
    assert.deepEqual(errors, []);
    assert.equal(afterLens, 0, `back from the Terminal lens, ${afterLens} ms the composer was drawn without the open approval's card`);
    assert.equal(afterReconnect, 0, `across a socket reconnect, ${afterReconnect} ms the composer was drawn without the open approval's card`);
    assert.equal(staleCard, 0, `answered in the terminal, the old card was drawn ${staleCard} ms back in Chat`);
    assert.ok(shownAfterBlocked < PROMPT_POLL_MS / 2, `the card was shown ${shownAfterBlocked} ms after herdr said blocked: it waited for the next poll`);
    assert.ok(goneAfterWorking < PROMPT_POLL_MS / 2, `the card answered in the terminal went ${goneAfterWorking} ms after herdr said working: it waited for the next poll`);
    console.log("PASS the approval card stays drawn back from the Terminal lens and across a socket reconnect, is not drawn again once answered in the terminal, and follows herdr's blocked status at once");
    await context.close();
  } finally {
    await browser.close();
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
