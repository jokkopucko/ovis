import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { openLens } from "./header-lens.ts";
import { serveDemo } from "./demo-server.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-command-outcome-demo-"));
const evidence = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "command-outcome");
const RUNS = [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const;
/** the demo answers a chat message, and settles a command's outcome, in 2.4 s; its outcome poll is 2 s */
const SETTLE_MS = 15_000;

const failures: string[] = [];

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    <script type="module"`));
  const server = serveDemo(app);
  const url = (pane: string): string => `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(pane)}`;
  mkdirSync(evidence, { recursive: true });

  const chatStack = (page: Page, pane: string): Locator => page.locator(`.terminal-stack.is-chat:not(.is-peek)[data-pane-owner="${pane}"]`);
  const peekStack = (page: Page, pane: string): Locator => page.locator(`.terminal-stack.is-chat.is-peek[data-pane-owner="${pane}"]`);
  const chatOf = async (page: Page, pane: string): Promise<Locator> => {
    const row = page.locator(`.pane-select[title^="${pane} —"]`).first();
    await row.waitFor({ state: "attached" });
    if (await row.getAttribute("aria-current") !== "true") {
      await row.evaluate((node: HTMLElement) => node.click());
      await page.locator(`.pane-select[title^="${pane} —"][aria-current="true"]`).first().waitFor({ state: "attached" });
    }
    const stack = chatStack(page, pane);
    if (await stack.count() === 0) await openLens(page, "chat");
    await stack.waitFor();
    return stack.getByRole("log");
  };
  const send = async (page: Page, text: string): Promise<void> => {
    const box = page.getByRole("textbox", { name: "Message", exact: true });
    await box.fill(text);
    await page.getByRole("button", { name: "Send message", exact: true }).click();
  };
  const chipFor = (log: Locator, text: string): Locator => log.locator(".chat-turn-user").filter({ has: log.page().locator(".chat-bubble-body", { hasText: text }) }).locator(".chat-outcome");

  const withPane = async (browser: Browser, width: number, scheme: "light" | "dark", run: (page: Page, errors: string[]) => Promise<void>): Promise<void> => {
    const touch = width <= 480;
    const context = await browser.newContext({ viewport: { width, height: touch ? 844 : 800 }, hasTouch: touch, isMobile: touch, colorScheme: scheme, locale: "en-US" });
    try {
      await context.addInitScript((theme) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme }));
        for (const pane of ["w1H:p1", "w1D:p1", "w1K:p1"]) localStorage.setItem(`ovis:view:${pane}`, "chat");
      }, scheme);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(SETTLE_MS);
      await page.goto(url(panes.flaky));
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await chatStack(page, panes.flaky).waitFor();
      await page.locator(".chat-turn-user").first().waitFor();
      await appFaces(page);
      await run(page, errors);
      assert.deepEqual(errors, [], `page errors at ${width}px (${scheme})`);
    } finally {
      await context.close();
    }
  };

  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    for (const [width, scheme] of RUNS) {
      const label = `${width}px ${scheme}`;
      const shot = (name: string) => join(evidence, `${width}-${scheme}-${name}.png`);
      try {
        await withPane(browser, width, scheme, async (page) => {
          const claude = await chatOf(page, panes.flaky);
          const turnsBefore = await claude.locator(".chat-turn-user").count();
          await send(page, "/context");
          const context = chipFor(claude, "/context");
          await context.and(page.locator('[data-outcome-state="accepted"]')).waitFor();
          assert.equal(await context.locator('.chat-outcome-state[role="status"]').count(), 1, "the chip's words are a live region");
          assert.equal(await claude.locator(".chat-bubble-body", { hasText: "/context" }).count(), 1, "one bubble for the send while its chip is accepted");
          await context.and(page.locator('[data-outcome-state="result-observed"]')).waitFor();
          assert.equal(await claude.locator(".chat-bubble-body", { hasText: "/context" }).count(), 1, "one bubble for the send once it is done");
          assert.equal(await claude.locator(".chat-turn-sent").count(), 0, "the transcript's own turn carries the chip; no provisional row stays");
          assert.equal(await claude.locator(".chat-turn-user").count(), turnsBefore + 1);
          assert.match(await context.locator(".chat-outcome-state").innerText(), /^Done/);
          await page.screenshot({ path: shot("context-done"), animations: "disabled" });
          console.log(`PASS ${label}: /context shows accepted, then done on the transcript, on one bubble`);

          // /btw is answered on the screen alone: one send opens a peek of the terminal over the
          // chat, and returning leaves one quiet command row, without an outcome chip or an
          // unconfirmed screen preview.
          await send(page, "/btw is the retry test flaky on CI too?");
          await peekStack(page, panes.flaky).waitFor();
          await page.locator(".terminal-banner-command").waitFor();
          await page.screenshot({ path: shot("btw-terminal"), animations: "disabled" });
          await page.getByRole("button", { name: "Back to Chat", exact: true }).click();
          const back = await chatOf(page, panes.flaky);
          const btw = back.locator(".chat-terminal-command", { hasText: "/btw" });
          await btw.waitFor();
          assert.equal(await btw.count(), 1);
          assert.equal(await btw.locator(".chat-outcome, .chat-bubble, details").count(), 0);
          assert.equal(await back.locator(".chat-turn-user:not(.chat-terminal-command)").count(), turnsBefore + 1);
          await page.screenshot({ path: shot("btw-returned"), animations: "disabled" });
          // the answer is still open in the terminal, where the next message would be typed and do
          // nothing: the composer says so (src/lib/inputRow.ts), and dismissing it there clears that
          const stillOpen = chatStack(page, panes.flaky).locator(".composer-notice", { hasText: "/btw is still open in the terminal" });
          await stillOpen.waitFor();
          await stillOpen.getByRole("button", { name: "Show terminal", exact: true }).click();
          await peekStack(page, panes.flaky).waitFor();
          if (width <= 480) {
            const escape = page.locator(`.terminal-stack[data-pane-owner="${panes.flaky}"] .key-bar .key[data-key="Escape"]`);
            await page.waitForFunction((pane) => document.querySelector<HTMLButtonElement>(`.terminal-stack[data-pane-owner="${pane}"] .key-bar .key[data-key="Escape"]`)?.disabled === false, panes.flaky);
            await escape.click();
          } else {
            await page.waitForFunction(() => document.activeElement?.classList.contains("xterm-helper-textarea") === true);
            await page.keyboard.press("Escape");
          }
          await page.getByRole("button", { name: "Back to Chat", exact: true }).click();
          await chatStack(page, panes.flaky).waitFor();
          await page.locator(".composer-notice", { hasText: "is still open in the terminal" }).waitFor({ state: "detached" });
          await send(page, "and one more question for the transcript");
          await back.locator(".chat-bubble-body", { hasText: "and one more question for the transcript" }).waitFor();
          await back.locator(".chat-turn-agent").last().getByText("This is the demo, so nothing ran", { exact: false }).waitFor();
          assert.equal(await btw.locator(".chat-outcome, details").count(), 0, "later preview updates cannot restore outcome UI");
          console.log(`PASS ${label}: /btw opens a peek and keeps one quiet row without outcome UI`);

          if (!(width <= 480)) {
            await btw.getByRole("button", { name: "Open Terminal", exact: true }).focus();
            await page.keyboard.press("Enter");
            await peekStack(page, panes.flaky).waitFor();
            await page.locator(".terminal-banner-command").getByText("/btw ran", { exact: true }).waitFor();
            assert.equal(await page.locator(".terminal-banner-command").getByText("Chat may come back when you close it", { exact: true }).count(), 0, "a row's peek is ended by hand");
            await page.getByRole("button", { name: "Back to Chat", exact: true }).click();
            const again = await chatOf(page, panes.flaky);
            assert.equal(await again.locator(".chat-terminal-command").count(), 1);
            console.log(`PASS ${label}: the row's keyboard action opens a peek that Back to Chat ends`);
          }

          await page.evaluate(async (pane) => {
            const prompt = ((await (await fetch(`/api/pane/prompt?pane_id=${encodeURIComponent(pane)}`)).json()) as { prompt: { id: string } | null }).prompt;
            if (prompt !== null) await fetch("/api/pane/prompt/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: pane, prompt_id: prompt.id, option_index: 0 }) });
          }, panes.web);
          const codex = await chatOf(page, panes.web);
          await page.locator(".prompt-card").waitFor({ state: "detached" });
          await codex.locator(".chat-turn-agent").last().getByText("Pushed", { exact: false }).waitFor();
          await send(page, "Please use $review now");
          const review = chipFor(codex, "use $review now");
          await review.waitFor();
          await review.and(page.locator('[data-outcome-state="result-observed"]')).waitFor();
          assert.equal(await codex.locator(".chat-bubble-body", { hasText: "use $review now" }).count(), 1);
          console.log(`PASS ${label}: an inline $review to the Codex pane shows its chip`);

          const pi = await chatOf(page, panes.cli);
          await send(page, "/myext run");
          const myext = chipFor(pi, "/myext run");
          await myext.and(page.locator('[data-outcome-state="unknown"]')).waitFor();
          assert.equal(await myext.locator(".chat-outcome-state").innerText(), "No result seen");
          assert.equal(await pi.locator(".chat-bubble-body", { hasText: "/myext run" }).count(), 1);
          await page.screenshot({ path: shot("myext-unknown"), animations: "disabled" });
          console.log(`PASS ${label}: an unlisted /myext run to the pi pane shows the unknown chip`);

          const hermes = await chatOf(page, panes.hermes);
          await send(page, "/status");
          const result = hermes.locator(".chat-outcome-result");
          await result.waitFor();
          assert.ok((await result.locator("pre").textContent())?.includes("Session"));
          assert.equal(await hermes.locator(".chat-terminal-command").count(), 0);
          assert.equal(await chatStack(page, panes.hermes).count(), 1);
          await page.screenshot({ path: shot("hermes-result"), animations: "disabled" });
          await result.getByRole("button", { name: "Dismiss", exact: true }).click();
          await result.waitFor({ state: "detached" });
          console.log(`PASS ${label}: Hermes informational result cards stay in Chat and dismiss normally`);
        });
      } catch (error) {
        failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await browser.close();
    server.stop();
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAIL command outcome chips:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
  process.exit(1);
}
console.log(`PASS command outcome chips: ${RUNS.length} runs; screenshots in ${evidence}`);
