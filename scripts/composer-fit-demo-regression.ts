import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { composerFitDemo, draft, drawn, LONG_MODEL, measure, upload, type Case, type Draw } from "./composer-fit-harness.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";

// The message box's status row and its controls, on the demo app as scripts/composer-fit-harness.ts
// patches it: the model label fitted to what is measured there, one Stop or Send control, the
// follow-ups sent while the agent works, and the quota in that row.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-composer-fit-demo-"));
try {
  const { server, withCard } = await composerFitDemo(app);
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      await withCard(browser, 390, { agent: "claude", model: "claude-opus-5-5", status: "working" }, async (page) => {
        await page.evaluate(() => { (window as any).fitHoldSend = true; });
        await draft(page);
        await page.locator(".composer-send").click();
        await page.waitForFunction(() => document.querySelector(".composer-send")?.getAttribute("aria-busy") === "true");
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
        assert.equal(await page.locator('.composer-send[aria-busy="true"]').count(), 1, "editing a working send to empty does not replace progress with Stop");
        await page.evaluate(() => (window as any).fitReply(true));
        await page.locator(".composer-stop").waitFor();
      });
      // Typography is applied by SettingsProvider after the render. At this fixed card width,
      // the larger interface font must step effort out without needing a viewport resize.
      await withCard(browser, 1075, { agent: "codex", model: LONG_MODEL }, async (page) => {
        const before = await measure(page);
        assert.equal(before.draw, "full");
        assert.equal(before.model?.clipped, false);
        const chooseSize = async (size: number) => {
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await openSettingsPage(page, "Appearance");
          const current = Number.parseInt(await page.locator('.settings-stepper[aria-label="Interface font size"] output').innerText(), 10);
          const button = page.getByRole("button", { name: size > current ? "Increase interface font size" : "Decrease interface font size", exact: true });
          for (let step = 0; step < Math.abs(size - current); step++) await button.click();
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        };
        await chooseSize(20);
        const large = await measure(page);
        assert.equal(large.card.width, before.card.width, "the card did not resize to trigger a width observer");
        assert.equal(large.draw, "no-effort", "interface font changes refit after the new typography is applied");
        assert.equal(large.model?.clipped, false, "the model stays whole at the larger font size");
        await chooseSize(14);
        const restored = await measure(page);
        assert.equal(restored.draw, "full", "shrinking the interface font restores the effort label");
        assert.equal(restored.effort?.clipped, false);
      });
      console.log("PASS live interface typography changes refit status labels at a fixed card width");

      for (const width of [390, 1440]) await withCard(browser, width, { model: LONG_MODEL }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill("Keep the draft at its insertion point.\n".repeat(80));
        await upload(page);
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const before = await box.evaluate((node) => {
          node.focus(); node.setSelectionRange(600, 600); node.scrollTop = 300;
          return { value: node.value, start: node.selectionStart, end: node.selectionEnd, scroll: node.scrollTop, height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top, offsetTop: node.offsetTop };
        });
        await box.evaluate((node) => {
          const remove = Element.prototype.removeAttribute;
          const samples: number[] = [];
          Object.assign(window, { draftTopSamples: samples });
          Element.prototype.removeAttribute = function(name) {
            remove.call(this, name);
            if (this.classList.contains("composer-status")) samples.push(node.getBoundingClientRect().top);
          };
        });
        await page.evaluate((paneId) => {
          const fixture = window as unknown as { fitCase: Case; fitSocket: { push(message: unknown): void } };
          fixture.fitCase.contextUsed = 160_000;
          fixture.fitCase.stream = 1;
          fixture.fitSocket.push({ type: "conversation-changed", pane_id: paneId, signature: "composer-stream-update" });
        }, panes.api);
        await page.waitForFunction(() => { const ring = document.querySelector(".composer-context"); return `${ring?.getAttribute("aria-label")} ${ring?.textContent}`.includes("160k"); }, undefined, { timeout: 5_000 });
        await page.getByText("Streamed update 1", { exact: true }).waitFor({ state: "attached" });
        await page.evaluate((paneId) => {
          const fixture = window as unknown as { fitCase: Case; fitSocket: { push(message: unknown): void } };
          fixture.fitCase.effort = "high";
          fixture.fitSocket.push({ type: "conversation-changed", pane_id: paneId, signature: "composer-model-update" });
        }, panes.api);
        await page.waitForFunction(() => document.querySelector(".composer-reasoning-short")?.textContent === "high", undefined, { timeout: 5_000 });
        const samples = await page.evaluate(() => (window as unknown as { draftTopSamples: number[] }).draftTopSamples);
        assert.ok(samples.every((top) => Math.abs(top - before.top) <= 1), `${width}px: streaming context updates never move the focused textarea during status fitting: ${before.top} -> ${samples.join(", ")}`);
        const after = await box.evaluate((node) => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, scroll: node.scrollTop, height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top, offsetTop: node.offsetTop }));
        assert.deepEqual(after, before);
      });
      console.log("PASS streaming context updates preserve draft geometry and selection while an upload hint is visible");

      // Prompt suggestions update independently while an agent works. A populated draft keeps
      // its own viewport and insertion point when only the unused placeholder changes.
      for (const width of [390, 1440]) await withCard(browser, width, { model: LONG_MODEL, suggestion: null }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill(Array.from({ length: 80 }, (_, i) => `Draft line ${i}: keep this text while the agent works.`).join("\n"));
        await box.evaluate((node) => {
          node.focus();
          node.setSelectionRange(Math.floor(node.value.length / 2), Math.floor(node.value.length / 2));
          node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
        });
        const snapshot = () => box.evaluate((node) => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, scroll: node.scrollTop, height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top, offsetTop: node.offsetTop, focused: document.activeElement === node }));
        const before = await snapshot();
        // Record the real DOM geometry at height writes as well as after the update. Reading
        // scrollHeight in auto-sizing forces this intermediate layout before the next paint;
        // a final snapshot alone misses the collapse that native caret scrolling can react to.
        await box.evaluate((node) => {
          const prototype = CSSStyleDeclaration.prototype;
          const samples: number[] = [];
          Object.assign(window, { draftHeightSamples: samples });
          Object.defineProperty(prototype, "height", { configurable: true, get() { return this.getPropertyValue("height"); }, set(value: string) {
            this.setProperty("height", value);
            if (this === node.style) samples.push(node.getBoundingClientRect().height);
          } });
        });
        assert.ok(before.scroll > 0 && before.start > 0 && before.start < before.value.length);
        await page.evaluate(() => { (window as unknown as { fitCase: Case }).fitCase.suggestion = "A new suggestion from the agent"; });
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.placeholder === "A new suggestion from the agent", undefined, { timeout: 5_000 });
        const heightSamples = await page.evaluate(() => (window as unknown as { draftHeightSamples: number[] }).draftHeightSamples);
        assert.ok(heightSamples.every((height) => Math.abs(height - before.height) <= 1), `${width}px: an agent prompt update never collapses the populated textarea: ${before.height} -> ${heightSamples.join(", ")}`);
        assert.deepEqual(await snapshot(), before, `${width}px: an agent prompt update preserves the focused draft's geometry, scroll and selection`);
      });
      console.log("PASS prompt updates preserve a focused, internally scrolled draft and its mid-text caret at 390 and 1440px");

      // One primary control across agents: Stop with an empty working draft, Send with text.
      for (const agent of ["claude", "codex"] as const) for (const width of [350, 390, 800, 1440]) for (const mic of [false, true]) await withCard(browser, width, { agent, model: "gpt-5.6", mic }, async (page) => {
        const rest = await measure(page);
        assert.ok(rest.stop && !rest.send && !rest.sendOptions && !rest.queue, JSON.stringify(rest));
        // the ring only shows: a span with its number in a tooltip, nothing to press, open or focus
        assert.equal(await page.locator(".composer-context").evaluate((node) =>
          node.tagName === "SPAN" && node.getAttribute("title")?.includes("%") === true && !node.hasAttribute("aria-expanded") && !node.hasAttribute("tabindex")), true, "the context ring is display-only");
        await draft(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${agent} ${width}px, a written follow-up`);
        assert.ok(row.send && !row.stop && !row.sendOptions && !row.queue && row.ring, JSON.stringify(row));
        assert.equal(row.card.height, rest.card.height, "Send replaces Stop on the same row");
        if (width >= 800) {
          // a press on the ring does nothing: no number opens and the row is drawn as before
          await page.locator(".composer-context").click();
          const pressed = await measure(page);
          assert.equal(pressed.draw, row.draw, `${agent} ${width}px: a press on the ring leaves the row as drawn`);
          assert.equal(pressed.card.height, row.card.height);
          assert.equal(await page.locator(".composer-context-text").count(), 0, "a press opens no context number");
        }
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
        assert.equal((await measure(page)).stop, true);
      });
      for (const agent of ["pi", "omo"] as const) await withCard(browser, 390, { agent, model: LONG_MODEL, mic: true }, async (page) => {
        await draft(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${agent}, a long model identifier`);
        assert.ok(row.send && !row.queue && !row.sendOptions);
      });
      console.log("PASS agents at 350, 390, 800 and 1440px use one Stop/Send control with no Queue or dropdown");

      for (const width of [320, 330, 350, 390]) await withCard(browser, width, { agent: "codex", model: LONG_MODEL, mic: true }, async (page) => {
        await draft(page);
        await upload(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${width}px, a pending upload`);
        assert.ok(row.send && !row.queue && !row.sendOptions && row.hint && !row.hint.clipped, JSON.stringify(row));
        assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true, "an upload cannot enqueue an incomplete mention");
        assert.equal(await page.locator(".pending-message-bubble").count(), 0);
      });

      // Queued text is not a transcript turn. Its selectable bubble has no action: the explicit
      // Send now button acts on the ID, and X discards it. The current fixture turn keeps running.
      for (const agent of ["claude", "codex"] as const) for (const width of [350, 390, 1440]) await withCard(browser, width, { agent, model: "gpt-5.6" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill("check the first pending change");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const strip = page.locator(".pending-messages");
        await strip.waitFor();
        assert.equal(await box.inputValue(), "", "an accepted pending request clears its acknowledged draft");
        assert.equal(await page.locator(".pending-message-bubble").first().textContent(), "check the first pending change");
        const before = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(before).includes("check the first pending change"), "pending text has not been typed");
        await box.fill("discard this second pending change");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pending-message-bubble").length === 2);
        const geometry = await strip.evaluate((node) => {
          const edge = node.getBoundingClientRect();
          return { width: edge.width, height: edge.height, fits: edge.left >= 0 && edge.right <= innerWidth,
            actionsFit: !matchMedia("(pointer: coarse)").matches || [...node.querySelectorAll(".pending-message-action")].every((item) => { const r = item.getBoundingClientRect(), size = parseFloat(getComputedStyle(item).getPropertyValue("--touch-target")); return r.width >= size && r.height >= size; }),
            bubblesFit: [...node.querySelectorAll(".pending-message-bubble")].every((item) => { const r = item.getBoundingClientRect(); return r.left >= edge.left && r.right <= edge.right + 0.5; }) };
        });
        assert.ok(geometry.fits && geometry.bubblesFit && geometry.actionsFit && geometry.height <= 844 * 0.2 + 0.5, JSON.stringify(geometry));
        const bubbles = page.locator(".pending-message-bubble");
        assert.equal(await bubbles.first().evaluate((node) => node.tagName), "DIV", "pending text is selectable, without a click action");
        await bubbles.first().click();
        assert.equal(await bubbles.count(), 2, "clicking message text does not send it");
        const untouched = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(untouched).includes("check the first pending change"));
        await strip.getByRole("button", { name: "Send now: check the first pending change", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pending-message-bubble").length === 1);
        const after = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.equal(JSON.stringify(after).split("check the first pending change").length - 1, 1, "Send now delivers this ID once");
        await strip.getByRole("button", { name: "Discard", exact: true }).click();
        await strip.waitFor({ state: "hidden" });
        const discarded = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(discarded).includes("discard this second pending change"));
      });
      console.log("PASS selectable pending bubbles fit phones; explicit Send now and Discard act on IDs");

      // With automatic sending turned off, a follow-up sent while the agent works is held by the PC at once:
      // a reconnect leaves it held and sends nothing, and only Send now delivers it.
      await withCard(browser, 390, { agent: "codex", model: "gpt-5.6", autoSend: false }, async (page) => {
        const text = "held at once follow-up";
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator('.pending-message[data-state="held"]').waitFor();
        await page.evaluate(() => (window as unknown as { fitSocket: { close: () => void } }).fitSocket.close());
        await page.waitForFunction(() => (window as unknown as { fitSocket?: { readyState: number } }).fitSocket?.readyState === 1);
        await page.waitForFunction(() => !(document.querySelector(".pending-message-send") as HTMLButtonElement | null)?.disabled);
        assert.equal(await page.locator(".pending-message").getAttribute("data-state"), "held", "a reconnect leaves a held follow-up held");
        const notSent = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(notSent).includes(text), "a held follow-up is not sent by the reconnect");
        await page.getByRole("button", { name: `Send now: ${text}`, exact: true }).click();
        await page.locator(".pending-message-bubble").waitFor({ state: "hidden" });
        const sent = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.equal(JSON.stringify(sent).split(text).length - 1, 1, "Send now delivers it once");
      });
      // With automatic sending on, a follow-up is queued: a confirmed hold can be sent explicitly on a new
      // connection, and an unconfirmed queued request becomes uncertain and never offers an automatic or explicit retry.
      for (const held of [false, true]) await withCard(browser, 390, { agent: "codex", model: "gpt-5.6", autoSend: true }, async (page) => {
        const text = held ? "confirmed held follow-up" : "unconfirmed follow-up";
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator(".pending-message-bubble").waitFor();
        await page.evaluate(({ held, paneId }) => {
          const socket = (window as unknown as { fitSocket: { holdPending: (pane: string) => void; close: () => void } }).fitSocket;
          if (held) socket.holdPending(paneId);
          socket.close();
        }, { held, paneId: panes.api });
        await page.waitForFunction(() => (window as unknown as { fitSocket?: { readyState: number } }).fitSocket?.readyState === 1);
        const bubble = page.locator(".pending-message-bubble");
        await page.waitForFunction((state) => document.querySelector(".pending-message")?.getAttribute("data-state") === state, held ? "held" : "uncertain");
        const notSent = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(notSent).includes(text), "reconnection never sends a stored copy");
        if (held) {
          await page.waitForFunction(() => !(document.querySelector(".pending-message-send") as HTMLButtonElement).disabled);
          await page.getByRole("button", { name: `Send now: ${text}`, exact: true }).click();
          await bubble.waitFor({ state: "hidden" });
          const sent = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
          assert.equal(JSON.stringify(sent).split(text).length - 1, 1);
        } else {
          assert.equal(await page.locator(".pending-message-send").count(), 0, "uncertain text has no Send now action");
          assert.equal(await page.locator(".pending-message-action").evaluateAll((items) => items.every((item) => {
            const r = item.getBoundingClientRect(), size = parseFloat(getComputedStyle(item).getPropertyValue("--touch-target"));
            return r.width >= size && r.height >= size;
          })), true, "Copy and Discard keep the full touch target");
          await page.getByRole("button", { name: "Discard saved copy", exact: true }).click();
          await bubble.waitFor({ state: "hidden" });
        }
      });
      await withCard(browser, 800, { agent: "codex", pending: false, model: "gpt-5.6" }, async (page) => {
        await draft(page);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator(".composer-note").waitFor();
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "hold this");
        assert.equal(await page.locator(".pending-message-bubble").count(), 0);
        assert.match(await page.locator(".composer-note").textContent() ?? "", /Update this PC/);
        // the reason sits on the box's top edge, the box's width, not under it
        const [noteBox, surfaceBox] = await Promise.all([page.locator(".composer-note").boundingBox(), page.locator(".composer-surface").boundingBox()]);
        assert.ok(noteBox && surfaceBox && noteBox.y + noteBox.height <= surfaceBox.y + 1, "the note is above the message box");
        assert.ok(noteBox && surfaceBox && Math.abs(noteBox.width - surfaceBox.width) <= 1 && Math.abs(noteBox.x - surfaceBox.x) <= 1, "and as wide as it");
      });
      console.log("PASS connection loss suspends pending items, confirmed holds need Send now, and old bridges keep the draft");

      for (const weeklyOnly of [false, true]) await withCard(browser, 1440, { agent: "codex", model: "gpt-5.6", showUsage: true, weeklyOnly }, async (page) => {
        const usage = page.locator(".composer-status .composer-usage");
        await usage.waitFor();
        assert.equal(await usage.evaluate((node) => node.tagName === "SPAN" && !node.hasAttribute("tabindex")), true, "desktop quota is a read-only glance");
        assert.equal(await usage.locator('span[aria-hidden="true"]').textContent(), weeklyOnly ? "Weekly 84%" : "5h 22%", "the session precedes the tighter week; no session falls back to the week");
        assert.equal(await usage.evaluate((node) => node.classList.contains("is-high")), weeklyOnly);
        assert.match(await usage.getAttribute("title") ?? "", /sam@work\.example/);
      });
      await withCard(browser, 390, { agent: "codex", model: "gpt-5.6", showUsage: true }, async (page) => {
        assert.equal(await page.locator(".composer-status .composer-usage").count(), 0, "mobile omits the desktop quota even when sidebar limits are enabled");
        assert.equal(await page.locator(".composer-context").evaluate((node) => node.tagName === "SPAN" && !node.hasAttribute("aria-expanded")), true);
      });
      // a pi pane draws on the plan of the provider its conversation runs at, and on none without one
      for (const [agent, provider, text, account] of [["pi", "openai-codex", "5h 22%", /sam@work\.example/], ["omo", "anthropic-subscription", "5h 38%", /Claude · sam@example\.com/]] as const) {
        await withCard(browser, 1440, { agent, model: "gpt-5.6", provider, showUsage: true }, async (page) => {
          const usage = page.locator(".composer-status .composer-usage");
          await usage.waitFor();
          assert.equal(await usage.locator('span[aria-hidden="true"]').textContent(), text);
          assert.match(await usage.getAttribute("title") ?? "", account);
        });
      }
      // a plain `anthropic` is recorded the same for a Claude sign-in and an API key
      for (const provider of [undefined, "zai", "anthropic"]) await withCard(browser, 1440, { agent: "pi", model: "gpt-5.6", ...(provider ? { provider } : {}), showUsage: true }, async (page) => {
        await page.locator(".composer-status").waitFor();
        assert.equal(await page.locator(".composer-status .composer-usage").count(), 0, "no plan without a provider that names one");
      });
      console.log("PASS desktop quota is read-only and session-first with weekly fallback; mobile keeps only the inert context ring; a pi pane follows its provider's plan");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
