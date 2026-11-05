import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// An empty chat's greeting, on the unmodified app over the demo's fixture transport: a workspace
// the demo creates starts with a conversation of no turns. All files and HTTP traffic stay in
// this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-greeting-demo-"));
const LONG_FOLDER = "a-very-long-folder-name-that-never-breaks_with_underscores_and_more_text_2026";

interface Geometry {
  stack: { top: number; bottom: number };
  composer: { top: number; bottom: number };
  greeting: { top: number; bottom: number; left: number; right: number } | null;
  mount: { width: number; height: number };
  transform: string;
  animations: number;
  viewport: number;
  scrollWidth: number;
  overflowing: boolean;
}

const geometryOf = (page: Page): Promise<Geometry> => page.evaluate(() => {
  const rect = (selector: string) => document.querySelector(`.pane-frame.is-current ${selector}`)!.getBoundingClientRect();
  const composer = document.querySelector<HTMLElement>(".pane-frame.is-current .composer")!;
  const greeting = document.querySelector(".pane-frame.is-current .composer-greeting")?.getBoundingClientRect() ?? null;
  const lines = [...document.querySelectorAll<HTMLElement>(".pane-frame.is-current .composer-greeting p")];
  return {
    stack: { top: rect(".terminal-stack").top, bottom: rect(".terminal-stack").bottom },
    composer: { top: rect(".composer").top, bottom: rect(".composer").bottom },
    greeting: greeting && { top: greeting.top, bottom: greeting.bottom, left: greeting.left, right: greeting.right },
    mount: { width: rect(".pane-terminal").width, height: rect(".pane-terminal").height },
    transform: getComputedStyle(composer).transform,
    animations: composer.getAnimations().length,
    viewport: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: lines.some((line) => line.scrollWidth > line.clientWidth),
  };
});

/** The demo's own "New workspace": an agent pane whose conversation holds no turn yet. */
const newWorkspace = (page: Page, cwd: string): Promise<string> => page.evaluate(async (dir) => {
  const response = await fetch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: dir, agent: { kind: "claude" } }) });
  return ((await response.json()) as { pane_id: string }).pane_id;
}, cwd);

/** The greeting and the composer, as one block, at the stack's vertical centre (the observer that places them answers a frame after a resize). */
const centred = (page: Page): Promise<unknown> => page.waitForFunction(() => {
  const greeting = document.querySelector(".pane-frame.is-current .composer-greeting")?.getBoundingClientRect();
  const composer = document.querySelector(".pane-frame.is-current .composer")?.getBoundingClientRect();
  const stack = document.querySelector(".pane-frame.is-current .terminal-stack")?.getBoundingClientRect();
  return greeting !== undefined && composer !== undefined && stack !== undefined
    && Math.abs((greeting.top + composer.bottom) / 2 - (stack.top + stack.bottom) / 2) <= 2;
}, undefined, { timeout: 5_000 });

const select = async (page: Page, pane: string): Promise<void> => {
  // a phone's drawer rows can be offscreen: dispatch the same row click
  const row = page.locator(`.pane-select[title^="${pane} —"]`).first();
  await row.waitFor({ state: "attached" });
  await row.evaluate((node: HTMLElement) => node.click());
  await page.locator(`.pane-select[title^="${pane} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
  await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await page.locator(".pane-frame.is-current .terminal-stack.is-chat").waitFor();
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // The demo answers a sent message in the same task: its user turn and the agent's "working".
  // Either alone ends a greeting. This holds a submit frame on its way out, as a slow connection
  // would, so that the app is seen with a message sent and nothing heard back yet.
  const hold = `<script>(() => {
    const Demo = window.WebSocket;
    window.heldSubmits = null;
    const Held = function (url, protocols) {
      const socket = new Demo(url, protocols);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (window.heldSubmits !== null && typeof data === "string" && JSON.parse(data).type === "submit") window.heldSubmits.push(() => send(data));
        else send(data);
      };
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Held, name, { value: Demo[name] });
    window.WebSocket = Held;
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${hold}\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.omp)}`;
  const settings = (): void => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })); };
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      // a mouse-driven window: the greeting and the input card sit at the pane's vertical centre
      const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
      try {
        await desktop.addInitScript(settings);
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".pane-frame.is-current .chat-turn").first().waitFor();
        await appFaces(page);
        assert.equal(await page.locator(".pane-frame.is-current .composer-greeting").count(), 0, "a conversation with turns is not greeted");
        const docked = await geometryOf(page);
        assert.equal(docked.transform, "none");
        console.log("PASS a pane with a conversation keeps its composer docked and shows no greeting");

        const pane = await newWorkspace(page, "/home/demo/new-project");
        await select(page, pane);
        const greeting = page.locator(".pane-frame.is-current .composer-greeting");
        // the demo's new agent works for a moment first: a status at work alone leaves the greeting
        // (#2550), and the steps below start from an agent at rest
        await greeting.waitFor({ timeout: 8_000 });
        await page.locator('.pane-frame.is-current .composer-status[data-status="idle"]').waitFor({ state: "attached", timeout: 8_000 });
        assert.equal(await greeting.locator(".composer-greeting-title").textContent(), "What should Claude do in new-project?");
        assert.equal(await greeting.locator(".composer-greeting-where").textContent(), "workstation · /home/demo/new-project");
        assert.equal(await page.locator(".pane-frame.is-current .chat-empty").count(), 0, "the greeting stands in for the chat's own empty line");
        assert.equal(await page.locator(".pane-frame.is-current .chat-turn").count(), 0);
        assert.equal(await page.locator(".conn-live").count(), 1);
        await centred(page);
        const lifted = await geometryOf(page);
        assert.ok(lifted.composer.bottom < lifted.stack.bottom - 100, `the composer left the bottom: ${JSON.stringify(lifted)}`);
        assert.ok(Math.abs(lifted.greeting!.bottom - lifted.composer.top) <= 1, "the greeting sits on the composer");
        assert.deepEqual(lifted.mount, docked.mount, "the xterm mount keeps its size under a greeting");
        console.log("PASS an empty chat shows one greeting line, centred with the composer, over an unchanged terminal mount");

        // a draft of several lines grows the box: the pair stays centred
        const message = page.getByRole("textbox", { name: "Message", exact: true });
        await message.fill("one\ntwo\nthree\nfour");
        await page.waitForFunction((before) => document.querySelector(".pane-frame.is-current .composer")!.getBoundingClientRect().height > before, lifted.composer.bottom - lifted.composer.top);
        await centred(page);
        await page.setViewportSize({ width: 1000, height: 620 });
        await centred(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await centred(page);
        console.log("PASS the pair stays centred as the draft grows and the window resizes");

        // a completion menu opens upward from the lifted card: in a short window it scrolls in the
        // room left over it and is not cut off by the pane's edge
        await page.setViewportSize({ width: 1440, height: 450 });
        await centred(page);
        await message.fill("/");
        const menu = page.locator(".pane-frame.is-current .composer-menu");
        await menu.waitFor();
        const room = await page.evaluate(() => {
          const box = document.querySelector(".pane-frame.is-current .composer-menu")!.getBoundingClientRect();
          const stack = document.querySelector(".pane-frame.is-current .terminal-stack")!.getBoundingClientRect();
          const menu = document.querySelector(".pane-frame.is-current .composer-menu")!;
          return { top: box.top, stack: stack.top, scrolls: menu.scrollHeight > menu.clientHeight, rows: menu.querySelectorAll(".menu-item").length };
        });
        assert.ok(room.top >= room.stack, `the menu stays inside the pane: ${JSON.stringify(room)}`);
        assert.ok(room.rows > 3 && room.scrolls, `the menu scrolls where it has no room: ${JSON.stringify(room)}`);
        await message.fill("");
        await menu.waitFor({ state: "detached" });
        console.log("PASS in a short window the completion menu scrolls over the lifted composer and is not clipped");

        // a stack too short for the composer and the greeting: the greeting stays out, with the
        // chat's own empty line in its place, and comes back when there is room. 140px: with the
        // one-line 46px header (#461) a 200px window still held the card and the greeting
        await page.setViewportSize({ width: 1440, height: 140 });
        await page.locator(".pane-frame.is-current .composer-greeting.is-out").waitFor({ state: "attached" });
        assert.equal(await page.locator(".pane-frame.is-current .composer-greeting").evaluate((node) => getComputedStyle(node).visibility), "hidden");
        assert.equal(await page.locator(".pane-frame.is-current .composer-greeting").getAttribute("aria-hidden"), "true");
        assert.equal(await page.locator(".pane-frame.is-current .chat-empty").count(), 1, "the chat's own empty line stands in");
        const short = await geometryOf(page);
        assert.equal(short.transform, "none", "a composer with no room over it stays docked");
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.locator(".pane-frame.is-current .composer-greeting:not(.is-out)").waitFor();
        await centred(page);
        assert.equal(await page.locator(".pane-frame.is-current .chat-empty").count(), 0);
        console.log("PASS a pane too short for the greeting keeps the chat's empty line and a docked composer");

        // The first message puts the composer back at the bottom, with no animation, before
        // anything is heard back: the submit frame is held, so no turn and no "working" end it.
        // A send is claimed in the pane's cross-tab Web Lock (#2369), granted in a later task; here
        // another tab's acknowledgement holds that lock over the click, so the grant always comes
        // after the click's frame: the greeting goes with the press, not with the grant.
        await page.evaluate(() => { (window as unknown as { heldSubmits: (() => void)[] | null }).heldSubmits = []; });
        await message.fill("Start with the README");
        await page.waitForFunction(() => Object.keys(localStorage).some((key) => key.startsWith("ovis:composer-draft:") && localStorage.getItem(key) === "Start with the README"));
        const holdSendLock = (): Promise<void> => page.evaluate(() => new Promise<void>((granted, refused) => {
          const key = Object.keys(localStorage).find((name) => name.startsWith("ovis:composer-draft:") && localStorage.getItem(name) === "Start with the README")!;
          navigator.locks.request(`ovis-send:${key}`, () => new Promise<void>((release) => {
            (window as unknown as { releaseSendLock: () => void }).releaseSendLock = release;
            granted();
          })).catch(refused);
        }));
        const pressSend = (): Promise<void> => page.evaluate(() => { document.querySelector<HTMLElement>('.pane-frame.is-current button[aria-label="Send message"]')!.click(); });

        // a press whose claim the composer leaves behind (another lens) sends nothing: the greeting
        // comes back with the chat, and does not wait for the other tab's lock
        await holdSendLock();
        await pressSend();
        await greeting.waitFor({ state: "detached" });
        await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
        await page.locator(".pane-frame.is-current .terminal-stack:not(.is-chat)").waitFor();
        await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
        await greeting.waitFor({ timeout: 5_000 });
        await page.evaluate(() => (window as unknown as { releaseSendLock: () => void }).releaseSendLock());
        // the lock taken after it queues behind the left claim: once it is granted, that claim has run (and sent nothing)
        await holdSendLock();
        assert.equal(await page.evaluate(() => (window as unknown as { heldSubmits: unknown[] }).heldSubmits.length), 0, "a claim left behind sends nothing");
        await page.evaluate(() => (window as unknown as { releaseSendLock: () => void }).releaseSendLock());
        await greeting.waitFor();
        await message.fill("Start with the README");
        console.log("PASS a send left waiting for another tab's lock gives the greeting back when its composer goes");

        await holdSendLock();
        const sent = await page.evaluate(async () => {
          document.querySelector<HTMLElement>('.pane-frame.is-current button[aria-label="Send message"]')!.click();
          // the frame the click is painted in, and nothing later
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
          const composer = document.querySelector<HTMLElement>(".pane-frame.is-current .composer")!;
          return {
            held: (window as unknown as { heldSubmits: unknown[] }).heldSubmits.length,
            greetings: document.querySelectorAll(".pane-frame.is-current .composer-greeting").length,
            transform: getComputedStyle(composer).transform,
            animations: composer.getAnimations().length,
            gap: Math.abs(composer.getBoundingClientRect().bottom - document.querySelector(".pane-frame.is-current .terminal-stack")!.getBoundingClientRect().bottom),
            turns: document.querySelectorAll(".pane-frame.is-current .chat-turn").length,
            empty: document.querySelectorAll(".pane-frame.is-current .chat-empty").length,
            status: document.querySelector(".pane-frame.is-current .composer-status")!.getAttribute("data-status"),
          };
        });
        assert.equal(sent.held, 0, "the claim waits for the other tab's lock");
        assert.equal(sent.turns, 0);
        assert.notEqual(sent.status, "working");
        assert.equal(sent.greetings, 0, `the greeting goes with the send itself: ${JSON.stringify(sent)}`);
        assert.equal(sent.empty, 0, `"No conversation yet" does not stand in for the greeting while the message is on its way: ${JSON.stringify(sent)}`);
        assert.equal(sent.transform, "none");
        assert.equal(sent.animations, 0, "the composer snaps: nothing animates");
        assert.ok(sent.gap <= 1, `composer docked in the frame of the first send: ${JSON.stringify(sent)}`);
        assert.deepEqual((await geometryOf(page)).mount, docked.mount, "the xterm mount keeps its size when the greeting goes");
        // the lock goes free: the claim runs and the message is on its way, still docked and ungreeted
        await page.evaluate(() => (window as unknown as { releaseSendLock: () => void }).releaseSendLock());
        await page.waitForFunction(() => (window as unknown as { heldSubmits: unknown[] }).heldSubmits.length === 1, undefined, { timeout: 5_000 });
        assert.equal(await page.locator(".pane-frame.is-current .composer-greeting").count(), 0, "the greeting stays away once the claim ran");
        assert.equal(await page.locator(".pane-frame.is-current .chat-empty").count(), 0);
        assert.equal((await geometryOf(page)).transform, "none");
        console.log("PASS the first message sent docks the composer in the same frame, before any turn or status arrives");

        // still nothing heard back: another lens and back, and a conversation read again, do not
        // bring the greeting back over a message already sent
        await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
        await page.locator(".pane-frame.is-current .terminal-stack:not(.is-chat)").waitFor();
        await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
        await page.locator(".pane-frame.is-current .terminal-stack.is-chat").waitFor();
        // the conversation was read again and is presented
        await page.locator(".pane-frame.is-current .chat-frame[data-pane-content]").waitFor({ state: "attached" });
        assert.equal(await page.locator(".pane-frame.is-current .chat-turn").count(), 0);
        assert.equal(await page.locator(".pane-frame.is-current .composer-greeting").count(), 0, "the greeting does not return after a send");
        assert.equal(await page.locator(".pane-frame.is-current .chat-empty").count(), 0, "nor does the empty line stand in for it");
        assert.equal((await geometryOf(page)).transform, "none");
        console.log("PASS the greeting does not return when the chat is left and shown again after a send");

        await page.evaluate(() => {
          const page = window as unknown as { heldSubmits: (() => void)[] | null };
          const held = page.heldSubmits ?? [];
          page.heldSubmits = null;
          for (const send of held) send();
        });
        await page.locator(".pane-frame.is-current .chat-turn").first().waitFor({ timeout: 8_000 });
        assert.equal(await page.locator(".pane-frame.is-current .composer-greeting").count(), 0);
        assert.deepEqual(errors, []);
        console.log("PASS the message arrives and the conversation shows it, with no greeting");
      } finally { await desktop.close(); }

      // a phone: the composer stays docked on the keyboard, the greeting above it; long names wrap
      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await phone.addInitScript(settings);
        // a soft keyboard the script raises: lib/viewport.ts reads its height (headless has none)
        await phone.addInitScript(() => {
          const keyboard = Object.assign(new EventTarget(), { height: 0 });
          Object.defineProperty(keyboard, "boundingRect", { get: () => new DOMRect(0, 0, 390, keyboard.height) });
          Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: keyboard });
        });
        const page = await phone.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const pane = await newWorkspace(page, `/home/demo/projects/${LONG_FOLDER}`);
        await select(page, pane);
        await page.locator(".pane-frame.is-current .composer-greeting").waitFor({ timeout: 8_000 });
        await appFaces(page);
        assert.equal(await page.locator(".pane-frame.is-current .composer-greeting-title").textContent(), `What should Claude do in ${LONG_FOLDER}?`);
        const geometry = await geometryOf(page);
        assert.equal(geometry.transform, "none", "a phone does not lift the composer");
        assert.ok(Math.abs(geometry.composer.bottom - geometry.stack.bottom) <= 1, `composer docked on a phone: ${JSON.stringify(geometry)}`);
        assert.ok(Math.abs(geometry.greeting!.bottom - geometry.composer.top) <= 1, "the greeting sits on the composer");
        assert.ok(geometry.greeting!.top >= geometry.stack.top, "the greeting stays inside the pane");
        assert.ok(geometry.greeting!.left >= 0 && geometry.greeting!.right <= geometry.viewport, `greeting inside the screen: ${JSON.stringify(geometry)}`);
        assert.ok(geometry.scrollWidth <= geometry.viewport, "no horizontal page scroll");
        assert.equal(geometry.overflowing, false, "long agent and folder names wrap");
        console.log("PASS on a phone the greeting sits over the docked composer and a long folder name wraps");

        // the greeting covers the chat's lower part: a tap on it reaches the chat, which puts the
        // keyboard away, as a tap on the old empty line did
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.focus();
        await page.evaluate(() => {
          const keyboard = (navigator as unknown as { virtualKeyboard: EventTarget & { height: number } }).virtualKeyboard;
          keyboard.height = 300;
          keyboard.dispatchEvent(new Event("geometrychange"));
        });
        await page.waitForFunction(() => document.documentElement.hasAttribute("data-keyboard"));
        assert.equal(await box.evaluate((node) => document.activeElement === node), true);
        const title = (await page.locator(".pane-frame.is-current .composer-greeting-title").boundingBox())!;
        // Chromium blurs a field on any tap outside it and iOS does not, so the blur alone proves
        // nothing here: what counts is that the touch lands on the chat, whose handler iOS needs
        const hit = await page.evaluate(({ x, y }) => {
          // which of the two the touch reaches, whatever other classes it carries (a virtualized chat has one more)
          const surface = document.elementFromPoint(x, y)?.closest(".chat-view, .composer");
          return surface == null ? null : surface.matches(".chat-view") ? "chat-view" : "composer";
        }, { x: title.x + title.width / 2, y: title.y + title.height / 2 });
        assert.equal(hit, "chat-view", "a touch on the greeting lands on the chat under it");
        await page.touchscreen.tap(title.x + title.width / 2, title.y + title.height / 2);
        await page.waitForFunction(() => !(document.activeElement instanceof HTMLTextAreaElement), undefined, { timeout: 3_000 });
        assert.deepEqual(errors, []);
        console.log("PASS on a phone a tap on the greeting puts the keyboard away");
      } finally { await phone.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
