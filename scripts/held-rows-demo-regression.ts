import assert from "node:assert/strict";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");

let batch = 0;
const stored = (texts: string[]): string => {
  batch += 1;
  return JSON.stringify({ version: 1, messages: texts.map((text, index) => ({ id: `b${batch}m${index}`, text })) });
};

interface Held {
  toggle: boolean;
  expanded: string | null;
  toggleText: string | null;
  heading: string;
  rows: number;
  listHeight: number;
  errors: string[];
  active: string | null;
}

const heldOf = (page: Page): Promise<Held> => page.evaluate(() => {
  const toggle = document.querySelector(".composer-queue-toggle");
  const active = document.activeElement;
  return {
    toggle: toggle !== null,
    expanded: toggle?.getAttribute("aria-expanded") ?? null,
    toggleText: toggle?.textContent ?? null,
    heading: document.querySelector(".composer-queue-heading")?.textContent ?? "",
    rows: document.querySelectorAll(".composer-queue-text").length,
    listHeight: document.querySelector<HTMLElement>(".composer-queue-list")?.offsetHeight ?? -1,
    errors: [...document.querySelectorAll(".composer-queue-item .composer-queue-error")].map((node) => node.textContent ?? ""),
    active: active === null ? null : active.className,
  };
});

const select = async (page: Page, pane: string): Promise<void> => {
  const row = page.locator(`.pane-select[title^="${pane} —"]`).first();
  await row.waitFor({ state: "attached" });
  await row.evaluate((node: HTMLElement) => node.click());
  await page.locator(`.pane-select[title^="${pane} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
};

const writeQueue = (page: Page, pane: string, value: string): Promise<void> => page.evaluate(([key, next]) => {
  localStorage.setItem(key, next);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: next, storageArea: localStorage }));
}, [`ovis:queue:${pane}`, value] as const);

const refuse = `<script>(() => {
  const Demo = window.WebSocket;
  window.refuseSubmits = false;
  const Refusing = function (url, protocols) {
    const socket = new Demo(url, protocols);
    const send = socket.send.bind(socket);
    socket.send = (data) => {
      const message = typeof data === "string" ? JSON.parse(data) : null;
      if (window.refuseSubmits && message !== null && message.type === "submit") {
        setTimeout(() => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "submit-result", id: message.id, pane_id: message.pane_id, ok: false, code: "submit_failed", message: "refused by the test" }) })), 20);
      } else send(data);
    };
    return socket;
  };
  for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Refusing, name, { value: Demo[name] });
  window.WebSocket = Refusing;
})();</script>`;

await withDemoBrowser({ tempPrefix: "herdr-held-rows-demo-", afterTransport: `\n    ${refuse}` }, async ({ newContext, baseUrl }) => {
  const url = (pane: string): string => `${baseUrl}?pane=${encodeURIComponent(pane)}`;
  const open = async (seed: Record<string, string>, pane: string, touch = false): Promise<{ page: Page; errors: string[]; close: () => Promise<void> }> => {
    const context = await newContext({ viewport: { width: 1440, height: 900 }, hasTouch: touch });
    await context.addInitScript((queues) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      // the rows were kept under the demo's herdr (site/demo/transport.ts): with no record they would
      // be an earlier release's, whose herdr nothing proves, and go to Recover unsent text
      localStorage.setItem("ovis:pane-lifetime:local", "demo-local");
      for (const [owner, value] of Object.entries(queues)) localStorage.setItem(`ovis:queue:${owner}`, value);
    }, seed);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url(pane));
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".terminal-stack.is-chat").waitFor();
    await page.locator(".composer-queue").waitFor();
    await appFaces(page);
    return { page, errors, close: () => context.close() };
  };

  {
    const { page, errors, close } = await open({ [panes.web]: stored(["first held", "second held"]), [panes.omp]: stored(["infra held"]) }, panes.web);
    try {
      const toggle = page.locator(".composer-queue-toggle");
      await toggle.waitFor();
      const folded = await heldOf(page);
      assert.equal(folded.expanded, "false");
      assert.equal(folded.rows, 2, "folded rows stay mounted");
      assert.equal(folded.listHeight, 0);
      assert.equal(folded.toggleText, "Held until the agent is ready · 2 messages");
      assert.match(folded.heading, /^Queued messages \(2\)/);
      console.log("PASS an open approval card folds the held rows into a button named by the caption alone");

      await toggle.click();
      assert.equal((await heldOf(page)).expanded, "true");
      await page.evaluate(() => { (window as unknown as { refuseSubmits: boolean }).refuseSubmits = true; });
      await page.getByRole("button", { name: "Send now" }).first().click();
      await page.locator(".composer-queue-item .composer-queue-error").waitFor();
      const failed = await heldOf(page);
      assert.equal(failed.toggle, false, "while a row's error holds the rows open the caption is no button");
      assert.ok(failed.listHeight > 0);
      assert.equal(failed.rows, 2, "a refused message stays held");
      await page.evaluate(() => { (window as unknown as { refuseSubmits: boolean }).refuseSubmits = false; });
      console.log("PASS a refused Send now keeps the message, shows its error and leaves no inert button");

      await page.getByRole("button", { name: "Discard" }).first().click();
      await toggle.waitFor();
      assert.equal((await heldOf(page)).errors.length, 0);
      assert.equal((await heldOf(page)).expanded, "true", "the rows stay as the user left them");
      await toggle.click();
      const closed = await heldOf(page);
      assert.equal(closed.expanded, "false", "the button closes the rows again");
      assert.equal(closed.listHeight, 0);
      console.log("PASS discarding the failed message lets the rows fold again");

      await toggle.click();
      await page.getByRole("button", { name: "Discard" }).first().click();
      await page.locator(".composer-queue").waitFor({ state: "detached" });
      await writeQueue(page, panes.web, stored(["queued again", "and another"]));
      await toggle.waitFor();
      assert.equal((await heldOf(page)).expanded, "false", "a new list under the same prompt starts folded");
      console.log("PASS a list that was emptied and filled again starts folded");

      await select(page, panes.omp);
      await page.locator(".composer-queue-text").first().focus();
      assert.equal((await heldOf(page)).toggle, false, "a ready list is never folded");
      await select(page, panes.web);
      await toggle.waitFor();
      assert.equal((await heldOf(page)).expanded, "false");
      console.log("PASS switching panes from a held row does not open the other pane's rows");

      await toggle.focus();
      await page.evaluate(async (pane) => {
        const prompt = ((await (await fetch(`/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { id: string } }).prompt;
        await fetch("/api/pane/prompt/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: pane, prompt_id: prompt.id, option_index: 0 }) });
      }, panes.web);
      await toggle.waitFor({ state: "detached", timeout: 15_000 });
      await page.waitForFunction(() => document.activeElement?.classList.contains("composer-queue-list") === true, undefined, { timeout: 3_000 });
      await page.keyboard.press("Tab");
      assert.equal((await heldOf(page)).active, "composer-queue-text", "Tab goes on to the first held message");
      assert.equal(await page.locator(".conn-live").count(), 1);
      assert.deepEqual(errors, []);
      console.log("PASS focus on the button moves to the list when the fold ends");
    } finally { await close(); }
  }

  {
    const { page, errors, close } = await open({ [panes.web]: stored(["first held", "second held"]), [panes.omp]: stored(["infra held"]) }, panes.web);
    try {
      const toggle = page.locator(".composer-queue-toggle");
      await toggle.waitFor();
      await page.evaluate(() => { (window as unknown as { refuseSubmits: boolean }).refuseSubmits = true; });
      await toggle.click();
      await page.getByRole("button", { name: "Send now" }).first().click();
      await page.locator(".composer-queue-item .composer-queue-error").waitFor();
      await page.evaluate(() => { (window as unknown as { refuseSubmits: boolean }).refuseSubmits = false; });
      await select(page, panes.omp);
      await page.locator(".composer-queue.is-ready").waitFor();
      await select(page, panes.web);
      await page.locator(".composer-queue-item .composer-queue-error").waitFor();
      assert.equal((await heldOf(page)).toggle, false);
      const second = page.locator(".composer-queue-text").nth(1);
      await second.focus();
      await page.keyboard.type("edited ");
      await page.evaluate((key) => {
        const queue = JSON.parse(localStorage.getItem(key)!) as { version: number; messages: { id: string; text: string }[] };
        const next = JSON.stringify({ ...queue, messages: queue.messages.slice(1) });
        localStorage.setItem(key, next);
        window.dispatchEvent(new StorageEvent("storage", { key, newValue: next, storageArea: localStorage }));
      }, `ovis:queue:${panes.web}`);
      await toggle.waitFor();
      const edited = await heldOf(page);
      assert.equal(edited.rows, 1);
      assert.equal(edited.expanded, "true", "the row the user is in keeps the rows open once the error is gone");
      assert.ok(edited.listHeight > 0);
      assert.equal(edited.active, "composer-queue-text");
      assert.equal(await page.locator(".composer-queue-text").inputValue(), "edited second held");
      console.log("PASS a row being edited stays in sight when another tab discards the failed message");

      await toggle.focus();
      await select(page, panes.omp);
      await page.locator(".composer-queue.is-ready").waitFor();
      await page.waitForFunction(() => document.activeElement?.classList.contains("composer-text") === true, undefined, { timeout: 3_000 });
      await page.keyboard.type("typed here");
      assert.equal(await page.locator(".composer-text").inputValue(), "typed here");
      assert.equal(await page.locator(".composer-queue-text").inputValue(), "infra held");
      assert.deepEqual(errors, []);
      console.log("PASS leaving a pane from its folded caption leaves the next pane's message box the typing");
    } finally { await close(); }
  }

  {
    const { page, errors, close } = await open({ [panes.web]: stored(["first held"]), [panes.omp]: stored(["infra held"]) }, panes.web, true);
    try {
      assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true);
      const toggle = page.locator(".composer-queue-toggle");
      await toggle.waitFor();
      await toggle.focus();
      await select(page, panes.omp);
      await page.locator(".composer-queue.is-ready").waitFor();
      assert.equal(await page.locator(".composer-queue-text").inputValue(), "infra held");
      assert.notEqual((await heldOf(page)).active, "composer-queue-list", "the other pane's list is not the one the button stood for");
      assert.deepEqual(errors, []);
      console.log("PASS on a touch screen, leaving a pane from its folded caption puts no focus in the next pane's list");
    } finally { await close(); }
  }

  {
    // watch-only access (the bridge says so before the socket answers in observe mode): a held message offers no Send now
    const context = await newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await context.addInitScript((queue) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
        localStorage.setItem("ovis:pane-lifetime:local", "demo-local");
        localStorage.setItem(queue[0], queue[1]);
      }, [`ovis:queue:${panes.web}`, stored(["held while watching"])] as const);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url(panes.web)}&demo_security=watch`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".terminal-stack.is-chat").waitFor();
      await page.locator(".composer-text[disabled]").waitFor({ state: "attached" });
      assert.equal(await page.getByRole("button", { name: "Send now" }).count(), 0, "a watch-only view offers no Send now for a held message");
      assert.equal(await page.locator(".composer-queue").count(), 0, "nor the held rows, as an acknowledged observe mode shows them");
      assert.deepEqual(errors, []);
      console.log("PASS a watch-only view offers no Send now for a held message");
    } finally { await context.close(); }
  }

  {
    const { page, errors, close } = await open({ [panes.omp]: stored(Array.from({ length: 30 }, (_, index) => `held ${index + 1}`)) }, panes.omp);
    try {
      assert.equal(await page.locator(".composer-queue-text").count(), 30);
      const host = await page.evaluate(() => { const node = document.querySelector(".terminal-host")!; return { scroll: node.scrollHeight, client: node.clientHeight }; });
      assert.equal(host.scroll, host.client, "thirty held rows do not make the pane scrollable");
      assert.deepEqual(errors, []);
      console.log("PASS a long held list scrolls in itself and leaves the pane's box alone");
    } finally { await close(); }
  }
});
