import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { composerFitDemo, type ComposerScrollGeometry } from "./composer-fit-harness.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";
import { MAX_COMPOSER_CHARS } from "../src/lib/compose.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments.ts";

// The draft in the message box, on the demo app as scripts/composer-fit-harness.ts patches it: an
// upload that fails, the agent's suggestion and skill completion, and the box's size, wrapping and
// scrolling as the draft, the font size and the zoom change.
const app = mkdtempSync(join(tmpdir(), "herdr-composer-fit-demo-"));
try {
  const { server, withCard } = await composerFitDemo(app);
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", model: "gpt-5.6" }, async (page) => {
        await page.evaluate(() => {
          const fetchDemo = window.fetch;
          let uploads = 0;
          Object.assign(window, { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input), location.href).pathname;
            if (path.endsWith("/pane/files") || (path.endsWith("/pane/image") && ++uploads === 1)) {
              return Promise.resolve(new Response(JSON.stringify({ error: "fixture_failure", message: "fixture upload failed" }), { status: 500 }));
            }
            if (path.endsWith("/pane/image")) return Promise.resolve(new Response(JSON.stringify({ path: "/fixture/retry.txt" })));
            return fetchDemo(input, init);
          } });
        });
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const failureAlert = page.locator('.composer-surface > [role="alert"]');
        const persistent = await failureAlert.elementHandle();
        assert.ok(persistent, "file-list failure alert is mounted before any request");
        assert.equal(await failureAlert.textContent(), "");
        await page.locator('.composer-controls-left input[type="file"]').setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
        const note = page.locator(".composer-note");
        await note.getByRole("button", { name: "Try again", exact: true }).waitFor();
        assert.ok((await note.textContent())?.includes("retry.txt"), "the upload alert identifies the failed file");
        assert.equal(await page.locator('.composer-surface > [aria-live="polite"]').textContent(), "", "failure is not also sent to the success live region");
        await box.fill("Keep editing this draft");
        await note.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".composer-attachment.is-ready").waitFor();
        assert.ok((await box.inputValue()).includes("Keep editing this draft"), "retry preserves edits");
        assert.ok((await page.locator('.composer-surface > [aria-live="polite"]').textContent())?.includes("retry.txt"), "success is announced");

        const success = await page.locator('.composer-surface > [aria-live="polite"]').textContent();
        // A file on disk, not a buffer: Playwright sends a buffer to the page as base64 (some 45 MB
        // here), which on a loaded CI host outlasted setInputFiles' 30 s; Chromium reads a path's
        // size without its bytes, and the app refuses by size before reading.
        const tooLarge = join(app, "too-large.bin");
        writeFileSync(tooLarge, "");
        truncateSync(tooLarge, MAX_ATTACHMENT_BYTES + 1);
        await page.locator('.composer-controls-left input[type="file"]').setInputFiles(tooLarge);
        await note.filter({ hasText: "too-large.bin" }).waitFor();
        assert.equal(await note.getAttribute("role"), "alert");
        assert.equal(await page.locator('.composer-surface > [aria-live="polite"]').textContent(), success, "oversize failure is not also announced politely");

        await box.fill("@missing");
        await page.locator(".composer-menu .chat-inline-error").waitFor();
        assert.ok(await persistent.evaluate((node) => node.isConnected && node.textContent !== ""), "the initially empty alert receives the listing failure");
        assert.equal(await page.locator(".composer-menu [role=status]").count(), 0, "the visible failure is not a second live region");
        await box.press("Escape");
        await page.locator(".composer-menu .chat-inline-error").waitFor({ state: "detached" });
        assert.equal(await failureAlert.textContent(), "", "dismissing suggestions clears the announcement");
        await persistent.dispose();
      });
      console.log("PASS phone and desktop upload failure has one named alert, retry survives edits, success is announced, and file-list failures use a persistent alert");

      // by default a tap on the grey words only focuses the box: typing there writes the user's own reply
      await withCard(browser, 390, { model: "gpt-5.6", status: "idle", pending: false, freezeConversation: true, suggestion: "Review the changes" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.placeholder === "Review the changes");
        assert.equal(await page.locator(".composer-inline-suggestion").count(), 0);
        assert.equal(await box.evaluate((node) => getComputedStyle(node, "::placeholder").color === "rgba(0, 0, 0, 0)"), false, "the placeholder itself shows the suggestion");
        const bounds = await box.boundingBox();
        assert.ok(bounds);
        await box.tap({ position: { x: 40, y: Math.min(bounds.height / 2, 20) } });
        assert.equal(await box.inputValue(), "", "a tap on the suggestion does not take it unless Settings asks");
        await page.keyboard.type("My own reply");
        assert.equal(await box.inputValue(), "My own reply");
      });
      console.log("PASS by default a tap on the grey suggestion focuses the box without taking it");

      for (const width of [390, 1440]) await withCard(browser, width, { model: "gpt-5.6", status: "idle", pending: false, freezeConversation: true, suggestion: "Review the changes", suggestionChip: true }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.placeholder === "Review the changes");
        await page.evaluate(() => Object.assign(window, { fitSubmitCount: 0 }));
        const suggestion = page.locator(".composer-inline-suggestion > span");
        if (width === 390) {
          // Padding is still the textarea, not an acceptance button.
          await box.tap({ position: { x: 4, y: 4 } });
          assert.equal(await box.inputValue(), "");
          await page.keyboard.type("My own reply");
          assert.equal(await box.inputValue(), "My own reply");
          assert.equal(await page.locator(".composer-inline-suggestion").count(), 0);
          await box.fill("");
          const bounds = await suggestion.boundingBox();
          assert.ok(bounds);
          const session = await page.context().newCDPSession(page);
          const x = bounds.x + 8, y = bounds.y + bounds.height / 2;
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - 60 }] });
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          await session.detach();
          assert.equal(await box.inputValue(), "", "a swipe across the suggestion does not accept it");
          await box.dispatchEvent("compositionstart", { data: "" });
          await suggestion.tap();
          assert.equal(await box.inputValue(), "", "an active composition blocks suggestion acceptance");
          await box.dispatchEvent("compositionend", { data: "" });
          await suggestion.tap();
        } else {
          assert.equal(await suggestion.isVisible(), false);
          await box.click();
          await box.press("Shift+Tab");
          assert.equal(await box.inputValue(), "");
          await box.focus();
          await box.press("Tab");
        }
        assert.equal(await box.inputValue(), "Review the changes");
        assert.equal(await box.evaluate((node: HTMLTextAreaElement) => document.activeElement === node && node.selectionStart === node.value.length && node.selectionEnd === node.value.length), true);
        await page.keyboard.type(" please");
        assert.equal(await box.inputValue(), "Review the changes please");
        assert.equal(await page.locator(".composer-inline-suggestion").count(), 0);
        await box.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(0, 0));
        await page.keyboard.type("Now ");
        assert.equal(await box.inputValue(), "Now Review the changes please");
        assert.equal(await page.evaluate(() => (window as unknown as { fitSubmitCount: number }).fitSubmitCount), 0, "accepting and editing never sends a message");
      });
      console.log("PASS touch suggestion acceptance and desktop Tab preserve focus, caret and editing without sending");

      // the grey words sit in the textarea's row: an attachment strip above keeps its own taps
      await withCard(browser, 390, { model: "gpt-5.6", status: "idle", freezeConversation: true, suggestion: "Review the changes", suggestionChip: true }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await page.locator('.composer-controls-left input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
        const attachment = page.locator(".composer-attachment").first();
        await attachment.waitFor();
        const words = await page.locator(".composer-inline-suggestion > span").boundingBox();
        const input = await box.boundingBox();
        const strip = await attachment.boundingBox();
        assert.ok(words && input && strip);
        assert.ok(words.y >= input.y && words.y + words.height <= input.y + input.height, "the words are drawn inside the message box");
        assert.ok(words.y >= strip.y + strip.height, "the words do not cover the attachment strip");
        assert.equal(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest(".composer-inline-suggestion")), [strip.x + strip.width / 2, strip.y + strip.height / 2]), false, "a tap on the attachment reaches the attachment");
      });
      console.log("PASS the inline suggestion stays in the message row below an attachment");

      for (const key of ["Enter", " "]) await withCard(browser, 390, { model: "gpt-5.6", status: "idle", freezeConversation: true, suggestion: "Review the changes", suggestionChip: true }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const suggestion = page.getByRole("button", { name: "Use the suggestion", exact: true });
        await suggestion.waitFor();
        await page.evaluate(() => Object.assign(window, { fitSubmitCount: 0 }));
        await suggestion.focus();
        await suggestion.press(key);
        assert.equal(await box.inputValue(), "Review the changes");
        assert.equal(await box.evaluate((node: HTMLTextAreaElement) => document.activeElement === node && node.selectionStart === node.value.length && node.selectionEnd === node.value.length), true);
        assert.equal(await page.evaluate(() => (window as unknown as { fitSubmitCount: number }).fitSubmitCount), 0);
      });
      console.log("PASS Enter and Space activate the focused inline suggestion without sending");

      await withCard(browser, 390, { model: "gpt-5.6", status: "idle", freezeConversation: true, suggestion: "Review the changes", suggestionChip: true }, async (page) => {
        await page.evaluate(() => Object.assign(window, { fitSubmitCount: 0 }));
        await page.locator(".composer-suggestion").tap();
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "Review the changes");
        assert.equal(await page.evaluate(() => (window as unknown as { fitSubmitCount: number }).fitSubmitCount), 0, "the suggestion chip never submits");
      });
      console.log("PASS the optional suggestion chip accepts a draft without sending");

      for (const width of [390, 1440]) for (const length of [MAX_COMPOSER_CHARS, MAX_COMPOSER_CHARS + 1]) await withCard(browser, width, { model: "gpt-5.6", status: "idle", freezeConversation: true, suggestion: "x".repeat(length), suggestionChip: true }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await page.waitForFunction((length) => document.querySelector<HTMLTextAreaElement>(".composer-text")?.placeholder.length === length, length);
        await page.evaluate(() => Object.assign(window, { fitSubmitCount: 0 }));
        if (width === 390) await page.locator(".composer-inline-suggestion > span").tap({ position: { x: 4, y: 4 } });
        else { await box.focus(); await box.press("Tab"); }
        if (length > MAX_COMPOSER_CHARS) {
          assert.equal(await box.inputValue(), "", "an oversized suggestion leaves the draft unchanged");
          assert.match(await page.locator(".composer-note[role=alert]").innerText(), /20,000-character limit · 1 over/);
        } else {
          assert.equal(await box.inputValue(), "x".repeat(length), "a suggestion at the limit is accepted in full");
        }
        assert.equal(await page.evaluate(() => (window as unknown as { fitSubmitCount: number }).fitSubmitCount), 0);
      });
      console.log("PASS touch and Tab accept the exact limit and reject oversized suggestions with an alert and no submit");

      for (const agent of ["claude", "codex", "pi"] as const) for (const width of [320, 1280]) await withCard(browser, width, { agent, model: "gpt-5.6", status: "idle" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const menu = page.getByRole("listbox", { name: "Slash commands", exact: true });
        await box.fill("/");
        await menu.getByRole("option").filter({ hasText: "/clear" }).waitFor();
        for (const text of ["a/b", "http://", "see https://example.test/path", "run tests then /clear"]) {
          await box.fill(text);
          await menu.waitFor({ state: "hidden" });
        }
        for (const text of ["run tests then /", "run tests\n/", "run tests\t/"]) {
          await box.fill(text);
          if (agent === "pi") { await menu.waitFor({ state: "hidden" }); continue; }
          await menu.getByRole("option").first().waitFor();
          const prefix = agent === "codex" ? "$" : "/";
          assert.deepEqual(await menu.locator(".menu-item-main").allTextContents(), [prefix + "delegate", prefix + "template-creator"]);
        }
        if (agent !== "pi") {
          await box.fill("run tests then /del afterwards");
          for (let i = 0; i < 11; i++) await box.press("ArrowLeft");
          assert.equal(await box.evaluate((node: HTMLTextAreaElement) => node.selectionStart), 19);
          await menu.getByRole("option").first().waitFor();
          assert.equal(await menu.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
          }), true, "the picker fits the viewport");
          if (process.env.UI_EVIDENCE_DIR) {
            mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `slash-${agent}-${width}.png`), fullPage: true });
          }
          // A committing IME Enter belongs to the input method, even while a skill is offered.
          await box.evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
          assert.equal(await box.inputValue(), "run tests then /del afterwards");
          await box.press("Tab");
          const expected = `run tests then ${agent === "codex" ? "$" : "/"}delegate afterwards`;
          assert.equal(await box.inputValue(), expected);
          assert.equal(await box.evaluate((node: HTMLTextAreaElement) => node.selectionStart), 25);
          await page.keyboard.type("next");
          assert.equal(await box.inputValue(), expected.slice(0, 25) + "next" + expected.slice(25));
          await box.fill("run tests then /del");
          await menu.getByRole("option").first().waitFor();
          await menu.getByRole("option").first().click();
          assert.equal(await box.inputValue(), `run tests then ${agent === "codex" ? "$" : "/"}delegate `);
          if (agent === "codex") {
            await box.fill("use $del");
            await menu.getByRole("option").first().waitFor();
            await box.press("Enter");
            assert.equal(await box.inputValue(), "use $delegate ");
            await box.fill("look at $tmp");
            await menu.waitFor({ state: "hidden" });
          }
          const prefix = agent === "codex" ? "$" : "/";
          for (const text of [prefix + "tmp", "look\n" + prefix + "tmp", "use " + prefix + "creator"]) {
            await box.fill(text);
            await menu.getByRole("option").filter({ hasText: prefix + "template-creator" }).waitFor();
          }
        }
        await box.fill("see @src");
        await page.getByRole("listbox", { name: "Files", exact: true }).waitFor();
        await box.fill("look at /tmp");
        // the send key: a phone's Return breaks the line by default, its hardware Mod+Enter sends
        await box.press(width <= 480 ? "ControlOrMeta+Enter" : "Enter");
        // the send is claimed in the pane's cross-tab lock (#2369), a moment after the key: the box empties then
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea.composer-text")?.value === "");
        await page.getByText("look at /tmp", { exact: true }).waitFor();
        assert.equal(await box.inputValue(), "", "the send key sends a path verbatim instead of accepting a fuzzy skill");
        console.log(`PASS skill completion at word boundaries (${agent}, ${width}px)`);
      });

      // The message box is typed at the transcript's size (Settings → Chat font size): with a mouse
      // exactly, on a phone never under 16px, the smallest size iOS does not zoom the page for
      for (const width of [390, 1440]) for (const chatFontSize of [null, 20]) await withCard(browser, width, { model: "claude-opus-5-5", chatFontSize }, async (page) => {
        const [box, body] = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.fontSize = "var(--chat-fs-body)";
          document.querySelector(".chat-view")!.append(probe);
          const sizes = [document.querySelector(".composer-text")!, probe].map((node) => parseFloat(getComputedStyle(node).fontSize));
          probe.remove();
          return sizes;
        });
        const want = width <= 480 ? Math.max(16, body!) : body!;
        assert.ok(Math.abs(box! - want) < 0.05, `${width}px, chat size ${chatFontSize ?? "default"}: the box is ${box}px, the transcript ${body}px`);
        if (chatFontSize === null) assert.equal(box, width <= 480 ? 16 : 15, "with no size chosen the box keeps its size");
      });
      console.log("PASS the message box follows Chat font size: with a mouse at the transcript's size, on a phone never under 16px");

      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true }, async (page) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        // A compact viewport supplies scrollable history without changing disclosure state.
        await page.setViewportSize({ width, height: 600 });
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const draft = "An unsent draft.";
        await page.locator(".chat-virtual-row").last().waitFor();
        await box.fill(draft);
        await page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight > 120 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        });
        await page.locator(".chat-view").hover();
        await page.mouse.wheel(0, -120);
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        const reading = await page.evaluate(() => {
          const node = document.querySelector(".chat-view")!;
          const view = node.getBoundingClientRect();
          const paragraph = [...node.querySelectorAll(".markdown p")].find((item) =>
            item.getBoundingClientRect().bottom > view.top && item.getBoundingClientRect().top < view.bottom);
          if (!paragraph) throw new Error("The reader's paragraph is not rendered");
          return { text: paragraph.textContent!, offset: paragraph.getBoundingClientRect().top - view.top, gap: node.scrollHeight - node.clientHeight - node.scrollTop };
        });
        assert.ok(reading.gap > 48, "the reader is away from the end before changing lenses");
        await page.locator(".view-switch .is-terminal").click();
        await page.locator(".view-switch .is-chat").click();
        await page.waitForFunction((saved) => {
          const node = document.querySelector(".chat-view");
          if (!node) return false;
          const paragraph = [...node.querySelectorAll(".markdown p")].find((item) => item.textContent === saved.text);
          return paragraph !== undefined && Math.abs(paragraph.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset) <= 1
            && node.scrollHeight - node.clientHeight - node.scrollTop > 48;
        }, reading);
        assert.equal(await box.inputValue(), draft, "the unsent draft survives the terminal/chat round trip");
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        // Leave in the same task: the list's deferred scroll cannot update memory first.
        await page.evaluate(() => {
          document.querySelector<HTMLButtonElement>('button[title="Jump to latest"]')!.click();
          document.querySelector<HTMLButtonElement>('.view-switch .is-terminal')!.click();
        });
        await page.locator(".view-switch .is-chat").click();
        await page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        }, undefined, { timeout: 5_000 });
        await page.locator(".view-switch .is-terminal").click();
        await page.locator(".view-switch .is-chat").click();
        await page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        }, undefined, { timeout: 5_000 });
      });
      console.log("PASS terminal/chat return preserves the reader's paragraph and one-line draft, and remembers Jump-to-latest intent before a deferred scroll");

      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await page.locator(".chat-virtual-row").last().waitFor();
        const atBottom = () => page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        }, undefined, { timeout: 5_000 });
        await box.fill("Short draft.");
        await atBottom();
        const samples = await page.evaluateHandle(() => {
          const node = document.querySelector(".chat-view")!;
          const box = document.querySelector(".composer-text")!;
          const geometry = () => {
            const last = [...node.querySelectorAll("[data-chat-row]")].at(-1)!;
            return {
              height: box.clientHeight,
              viewport: node.clientHeight,
              gap: node.scrollHeight - node.clientHeight - node.scrollTop,
              spacing: document.querySelector(".composer-surface")!.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
            };
          };
          const resizeFrames: ComposerScrollGeometry[] = [];
          const inputFrames: ComposerScrollGeometry[] = [];
          const observer = new ResizeObserver(() => resizeFrames.push(geometry()));
          // React's delegated input handler has run before this document listener. Read its
          // commit in the same task, before a later frame could repair a displaced transcript.
          const onInput = (event: Event) => {
            if (event.target === box) queueMicrotask(() => inputFrames.push(geometry()));
          };
          document.addEventListener("input", onInput);
          observer.observe(node);
          return { geometry, resizeFrames, inputFrames, observer, onInput };
        });
        try {
          const geometry = () => samples.evaluate(({ geometry }) => geometry());
          const initial = await geometry();
          const sameLineEdit = async (key: string, height: number, what: string) => {
            const count = await samples.evaluate(({ inputFrames }) => inputFrames.length);
            await box.press(key);
            const frames = await samples.evaluate(({ inputFrames }, count) => inputFrames.slice(count), count);
            assert.equal(frames.length, 1, `${what}: one native input edit was sampled`);
            const edited = frames[0]!;
            assert.equal(edited.height, height, `${what}: an edit within the same line keeps the input height`);
            assert.ok(edited.gap <= 1 && Math.abs(edited.spacing - initial.spacing) <= 1, `${what}: the multiline draft keeps bottom spacing without a delayed repair: ${JSON.stringify(edited)}`);
          };
          const wrapped = "A draft that wraps onto the next line. ".repeat(width === 390 ? 12 : 48);
          for (const [kind, text] of [["soft-wrapped", wrapped], ["explicit-newline", "First line\nSecond line\nThird line"]] as const) {
            await box.fill(text);
            await page.waitForFunction((height) => document.querySelector(".composer-text")!.clientHeight > height, initial.height);
            await atBottom();
            const grown = await geometry();
            assert.ok(grown.viewport < initial.viewport, `${kind}: a taller draft reduces the transcript viewport`);
            assert.ok(Math.abs(grown.spacing - initial.spacing) <= 1, `${kind}: growth preserves the output/input gap`);
            await sameLineEdit("x", grown.height, `${kind} typing`);
            await sameLineEdit("Backspace", grown.height, `${kind} backspacing`);
            await box.fill("Short draft.");
            await page.waitForFunction((height) => document.querySelector(".composer-text")!.clientHeight === height, initial.height);
            await atBottom();
            const shrunk = await geometry();
            assert.equal(shrunk.viewport, initial.viewport, `${kind}: shrinking restores the transcript viewport`);
            assert.ok(Math.abs(shrunk.spacing - initial.spacing) <= 1, `${kind}: shrinking preserves the output/input gap`);
          }
          const frames = await samples.evaluate(({ resizeFrames }) => resizeFrames);
          assert.ok(frames.some((frame) => frame.viewport < initial.viewport), "resize samples include the reduced transcript viewport");
          assert.ok(frames.every((frame) => frame.gap <= 1 && Math.abs(frame.spacing - initial.spacing) <= 1), `resize frames keep bottom spacing before paint: ${JSON.stringify(frames)}`);
        } finally {
          await samples.evaluate(({ observer, onInput }) => {
            observer.disconnect();
            document.removeEventListener("input", onInput);
          });
          await samples.dispose();
        }
      });
      console.log("PASS wrapped and multiline drafts keep bottom spacing through growth, shrinkage and same-line edits on phone and desktop");

      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const draft = "An unsent draft.\n".repeat(6);
        await box.fill(draft);
        await page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        });
        const initialHeight = await box.evaluate((node) => node.clientHeight);
        await page.locator(".chat-view").hover();
        await page.mouse.wheel(0, -120);
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        const paragraph = (text: string | null = null) => page.evaluate((text) => {
          const node = document.querySelector(".chat-view")!;
          const view = node.getBoundingClientRect();
          const paragraph = [...node.querySelectorAll(".markdown p")].find((item) => text === null
            ? item.getBoundingClientRect().bottom > view.top && item.getBoundingClientRect().top < view.bottom
            : item.textContent === text);
          if (!paragraph) throw new Error("The reader's paragraph is not rendered");
          return { text: paragraph.textContent!, offset: paragraph.getBoundingClientRect().top - view.top, gap: node.scrollHeight - node.clientHeight - node.scrollTop };
        }, text);
        const reading = await paragraph();
        assert.ok(reading.gap > 48, "the reader is away from the end before editing");
        for (const text of ["An edited unsent draft.\n".repeat(9), draft]) {
          await box.fill(text);
          await page.waitForFunction(({ initialHeight, growing }) => {
            const height = document.querySelector(".composer-text")!.clientHeight;
            return growing ? height > initialHeight : height === initialHeight;
          }, { initialHeight, growing: text !== draft });
          // Let layout observers finish, without waiting for the paragraph to be repaired.
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const after = await paragraph(reading.text);
          assert.ok(Math.abs(after.offset - reading.offset) <= 1 && after.gap > 48, `editing keeps the reader on the same paragraph: ${JSON.stringify({ reading, after })}`);
        }
      });
      console.log("PASS editing drafts preserves the reader's paragraph on phone and desktop");

      for (const width of [320, 1440]) for (const [language, text] of [
        ["ko", "가나다라마바사 ".repeat(5)],
        ["ja", "あいうえおゃゅょ。".repeat(4)],
        ["zh", "天地玄黄，宇宙洪荒。".repeat(4)],
      ] as const) await withCard(browser, width, { language, status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true, suggestion: text }, async (page) => {
        const box = page.locator(".composer-text");
        await page.waitForFunction((text) => document.querySelector<HTMLTextAreaElement>(".composer-text")!.placeholder === text, text);
        for (const value of [text, ""]) {
          await box.fill(value);
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const size = await box.evaluate((box: HTMLTextAreaElement) => {
            // Let the browser size a copy of the visible field's own wrapping rules,
            // independently of the measurement field's styles, without moving the transcript.
            const probe = box.cloneNode() as HTMLTextAreaElement;
            probe.removeAttribute("aria-label");
            probe.setAttribute("aria-hidden", "true");
            probe.tabIndex = -1;
            Object.assign(probe.style, { position: "absolute", visibility: "hidden", height: "0px", minHeight: "0px", width: `${box.getBoundingClientRect().width}px` });
            box.after(probe);
            try {
              const required = probe.scrollHeight;
              probe.style.minHeight = getComputedStyle(box).minHeight;
              probe.style.height = `${required}px`;
              return { actual: box.clientHeight, expected: probe.clientHeight };
            } finally { probe.remove(); }
          });
          assert.ok(Math.abs(size.actual - size.expected) <= 1, `${language}/${width}px: ${value ? "draft" : "placeholder"} uses the visible field's natural height: ${JSON.stringify(size)}`);
        }
      });
      console.log("PASS Korean, Japanese and Chinese drafts and wrapped placeholders fit their native text height on phone and desktop");

      // Korean typed in the box keeps each word whole, as the rest of the app and the box's own placeholder do (#3374):
      // a word that fits a line alone moves to the next line whole instead of being split after a short first word, so
      // "가 <word> 나" takes three lines, not two, and the box grows to all three.
      for (const width of [390, 1440]) await withCard(browser, width, { language: "ko", status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true }, async (page) => {
        const box = page.locator(".composer-text");
        const word = await box.evaluate(async (node: HTMLTextAreaElement) => {
          const style = getComputedStyle(node);
          const syllables = "가나다라마바사아자차카타파하";
          await document.fonts.load(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`, syllables);
          const probe = document.body.appendChild(document.createElement("span"));
          Object.assign(probe.style, { position: "absolute", visibility: "hidden", whiteSpace: "pre", font: style.font, letterSpacing: style.letterSpacing });
          const line = node.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
          // the longest word that still fits one line of the box
          let longest = "";
          try {
            for (let index = 0; ; index += 1) {
              probe.textContent = longest + syllables[index % syllables.length];
              if (probe.getBoundingClientRect().width > line) break;
              longest = probe.textContent;
            }
          } finally { probe.remove(); }
          return longest;
        });
        await box.fill(`가 ${word} 나`);
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const drawn = await box.evaluate((node: HTMLTextAreaElement) => {
          const style = getComputedStyle(node);
          const lines = Math.round((node.scrollHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)) / Number.parseFloat(style.lineHeight));
          return { lines, fits: node.scrollHeight <= node.clientHeight + 1 };
        });
        assert.equal(drawn.lines, 3, `${width}px: "가 ${word} 나" keeps the ${word.length}-syllable word whole on a line of its own`);
        assert.ok(drawn.fits, `${width}px: the box grows to the three lines its words take`);
      });
      console.log("PASS Korean typed in the message box keeps its words whole on phone and desktop");

      // Changing the setting in an already-open chat rewraps the existing draft: an automatic
      // box grows and shrinks with it.
      for (const width of [390, 1440]) await withCard(browser, width, { model: "claude-opus-5-5" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        assert.equal(await page.getByRole("separator", { name: "Resize message box", exact: true }).count(), 0, "the message box has no resize grip");
        const text = "An unsent draft changes size with the transcript.\nIts second line stays visible.\nThe third line stays visible too.";
        const height = () => box.evaluate((node) => node.clientHeight);
        const chooseSize = async (size: number) => {
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await openSettingsPage(page, "Appearance");
          const current = Number.parseInt(await page.locator('.settings-stepper[aria-label="Chat font size"] input').inputValue(), 10);
          const button = page.getByRole("button", { name: size > current ? "Increase chat font size" : "Decrease chat font size", exact: true });
          for (let step = 0; step < Math.abs(size - current); step++) await button.click();
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
        };
        await box.fill(text);
        const initial = await height();
        await chooseSize(20);
        await page.waitForFunction((before) => {
          const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return box.clientHeight > before && box.scrollHeight <= box.clientHeight + 1;
        }, initial);
        const large = await height();
        assert.equal(await box.inputValue(), text, "resizing keeps the draft whole");
        await chooseSize(11);
        await page.waitForFunction((before) => document.querySelector(".composer-text")!.clientHeight < before, large);
        assert.equal(await box.inputValue(), text, "shrinking keeps the draft whole");
      });
      console.log("PASS changing Chat font size grows and shrinks an existing draft's automatic box");

      // CSS layout zoom exercises fractional geometry and rewrapping; it is not native browser
      // zoom or mobile pinch zoom. Keep one draft mounted while changing each scale.
      for (const width of [390, 1440]) await withCard(browser, width, { model: "gpt-5.6-sol", status: "idle" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const drafts = ["", "A short message. 짧은 메시지", "long_unbroken_text_".repeat(100), Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: a long draft`).join("\n")];
        for (const text of drafts) {
          await box.fill(text);
          for (const zoom of [0.8, 1, 1.25, 1.5, 2, 1]) {
            await page.evaluate((scale) => { document.documentElement.style.zoom = String(scale); }, zoom);
            await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            // The width observer commits the automatic height after layout zoom rewraps text.
            await page.waitForFunction((short) => {
              const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
              return node.scrollWidth <= node.clientWidth + 1 && (!short || node.scrollHeight <= node.clientHeight + 1);
            }, text === drafts[0] || text === drafts[1], { timeout: 5_000 });
            const metrics = await box.evaluate((node) => {
              const style = getComputedStyle(node);
              const probe = document.body.appendChild(document.createElement("span"));
              probe.style.color = "var(--border-strong)";
              const thumb = getComputedStyle(probe).color;
              probe.remove();
              return { scrollbar: style.scrollbarWidth, color: style.scrollbarColor, thumb, gutter: style.scrollbarGutter, overflowY: style.overflowY, height: node.clientHeight, scrollHeight: node.scrollHeight };
            });
            // a token that does not exist drops the whole declaration: the colour is then "auto"
            assert.equal(metrics.color, `${metrics.thumb} rgba(0, 0, 0, 0)`, "the scroll cue is drawn in the theme's border colour on the card's own fill");
            assert.equal(metrics.scrollbar, "thin", `${width}px at ${zoom}: long drafts keep a narrow scroll cue`);
            assert.equal(metrics.gutter, "stable", "the scroll cue keeps reserved room beside the draft");
            assert.equal(metrics.overflowY, "auto", "long drafts remain scrollable");
            assert.equal(await box.inputValue(), text, "changing zoom preserves the draft");
            if (text === drafts[0] || text === drafts[1]) assert.ok(metrics.scrollHeight <= metrics.height + 1, "empty and short drafts fit without vertical clipping");
          }
        }
        const endKey = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
        await box.press(endKey);
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === node.value.length && node.scrollTop > 0;
        }, undefined, { timeout: 5_000 });
        const endScroll = await box.evaluate((node) => node.scrollTop);
        await box.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
        // Native caret scrolling trims different amounts of padding/leading across platforms.
        // Check keyboard movement independently from reaching the absolute wheel boundary.
        await page.waitForFunction((end) => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === 0 && node.scrollTop < end;
        }, endScroll, { timeout: 5_000 });
        await box.hover();
        await page.mouse.wheel(0, -2000);
        await page.waitForFunction(() => document.querySelector(".composer-text")!.scrollTop <= 1, undefined, { timeout: 5_000 });
        await page.mouse.wheel(0, 400);
        await page.waitForFunction(() => document.querySelector(".composer-text")!.scrollTop > 1, undefined, { timeout: 5_000 });
        const wheelScroll = await box.evaluate((node) => node.scrollTop);
        await box.press(endKey);
        await page.waitForFunction((before) => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === node.value.length && node.scrollTop > before;
        }, wheelScroll, { timeout: 5_000 });
        assert.equal(await box.inputValue(), drafts[3], "wheel and keyboard scrolling preserve the draft");
        if (width === 1440 && process.env.COMPOSER_FIT_SCREENSHOT) await page.locator(".composer").screenshot({ path: process.env.COMPOSER_FIT_SCREENSHOT });
      });
      console.log("PASS stable thin scrollbars, wrapped drafts and wheel/keyboard scrolling at 80–200% CSS layout zoom");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
