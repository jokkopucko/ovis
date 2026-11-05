import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

import panes from "../site/demo/fixtures/panes.json";
import { JA } from "../src/lib/i18n.ja.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { ZH } from "../src/lib/i18n.zh.ts";
import { appFaces } from "./app-faces.ts";
import { chromePath } from "./chrome-path.ts";
import { buildDemoApp } from "./demo-build.ts";

// Only the demo transport and fictional question cards; never a user's OpenCode session.
const app = mkdtempSync(join(tmpdir(), "opencode-prompt-browser-"));
const shots = process.env.OPENCODE_PROMPT_SHOTS;
const unconfirmedKey = "OpenCode did not confirm the answer. Check the question before sending again.";
const translations: Record<string, Record<string, string>> = { en: {}, ko: KO, ja: JA, zh: ZH };
const prompt = {
  id: "native-second", agent: "opencode", kind: "question", title: "Tools",
  question: "Which tools should the fictional project use?", body: null,
  options: [{ label: "Formatter", description: null }, { label: "Linter", description: null }, { label: "Your answer", description: null }],
  multi_select: true, custom_option_index: 2, can_step_back: true,
  steps: [{ label: "Project", answered: true, current: false }, { label: "Tools", answered: false, current: true }],
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const transport = `<script>(() => {
    const demo = window.fetch;
    window.nativePrompt = ${JSON.stringify(prompt)};
    window.nativeAnswers = [];
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url || input.href, location.href);
      if (url.pathname === "/api/pane/prompt" && url.searchParams.get("pane_id") === ${JSON.stringify(panes.web)})
        return Response.json({ prompt: window.nativePrompt, suggestion: null });
      if (url.pathname === "/api/pane/prompt/answer") {
        window.nativeAnswers.push(JSON.parse(init.body));
        if (window.nativeUnconfirmed) return Response.json({ error: { code: "reply_unconfirmed", message: "fixture_delivery_unconfirmed" } }, { status: 504 });
        window.nativePrompt = null;
        return Response.json({ ok: true });
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `<script src="./demo-transport.js"></script>${transport}<script type="module"`));
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname.replace(/^\/herdr-web-ui\/demo\/app\//, "");
      if (path.includes("..")) return new Response(null, { status: 404 });
      return new Response(Bun.file(join(app, path || "index.html")));
    },
  });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    if (shots) mkdirSync(shots, { recursive: true });
    if (!process.env.OPENCODE_FOLLOWUP) for (const width of [390, 1440]) for (const theme of ["light", "dark"]) for (const navigation of ["back", "chip"]) {
      const language = width === 390 ? (theme === "light" ? "ko" : "ja") : (theme === "light" ? "zh" : "en");
      const context = await browser.newContext({
        viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390, deviceScaleFactor: width === 390 ? 3 : 1,
      });
      try {
        await context.addInitScript((settings) => localStorage.setItem("ovis:settings", JSON.stringify(settings)), { language, theme });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${server.url.origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}`);
        await page.locator(".prompt-card").waitFor();
        await appFaces(page);
        await page.locator('.prompt-card input[type="checkbox"]').first().check();
        await page.locator(".prompt-card-custom input").fill("A custom tool");
        if (shots) await page.screenshot({ path: join(shots, `${width}-${theme}-${navigation}-edited.png`) });
        const submitted = page.waitForFunction(() => (window as unknown as { nativeAnswers: unknown[] }).nativeAnswers.length === 1);
        await page.locator(navigation === "back" ? ".prompt-card-back" : ".prompt-card-step-button").click();
        await submitted;
        const answer = await page.evaluate(() => (window as unknown as { nativeAnswers: { draft?: unknown }[] }).nativeAnswers[0]);
        assert.deepEqual(answer?.draft, { option_indices: [0], custom_text: "A custom tool" }, "navigation must carry the current edits");
        await page.locator(".prompt-card").waitFor({ state: "hidden" });
        // The backend's navigation round trip is covered by opencode-answer.test.ts. Remount
        // this real component with its returned defaults to check both input controls.
        await page.evaluate((next) => {
          (window as unknown as { nativePrompt: unknown }).nativePrompt = { ...next, id: "native-returned", default_option_indices: [0], default_custom_text: "A custom tool" };
        }, prompt);
        await page.locator(".prompt-card").waitFor();
        assert.equal(await page.locator('.prompt-card input[type="checkbox"]').first().isChecked(), true);
        assert.equal(await page.locator(".prompt-card-custom input").inputValue(), "A custom tool");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        assert.deepEqual(errors, []);
        if (shots) await page.screenshot({ path: join(shots, `${width}-${theme}-${navigation}-restored.png`) });
        const sent = page.waitForFunction(() => (window as unknown as { nativeAnswers: unknown[] }).nativeAnswers.length === 2);
        await page.locator(navigation === "back" ? ".prompt-card-submit" : ".prompt-card-custom button").click();
        await sent;
        const combined = await page.evaluate(() => (window as unknown as { nativeAnswers: { option_indices?: number[]; custom_text?: string }[] }).nativeAnswers[1]);
        assert.deepEqual(combined?.option_indices, [0], "both submission actions keep checked options");
        assert.equal(combined?.custom_text, "A custom tool", "both submission actions keep custom text");
        await page.locator(".prompt-card").waitFor({ state: "hidden" });
        await page.evaluate((next) => {
          Object.assign(window, { nativeUnconfirmed: true, nativePrompt: { ...next, id: "native-unconfirmed", default_option_indices: [0], default_custom_text: "A custom tool" } });
        }, prompt);
        await page.locator(".prompt-card").waitFor();
        await page.locator(".prompt-card-submit").click();
        await page.locator(".prompt-card-error").waitFor();
        assert.equal(await page.locator(".prompt-card-error").textContent(), translations[language]?.[unconfirmedKey] ?? unconfirmedKey, "show the shipped translation rather than the server's detail");
        if (shots) await page.screenshot({ path: join(shots, `${width}-${theme}-${navigation}-${language}-unconfirmed.png`) });
        console.log(`PASS ${width} ${theme} ${navigation} ${language}: drafts, combined answers and localized delivery advice`);
      } finally { await context.close(); }
    }
    for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
      const language = "ko";
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      try {
        await context.addInitScript((settings) => localStorage.setItem("ovis:settings", JSON.stringify(settings)), { language, theme });
        const page = await context.newPage();
        await page.goto(`${server.url.origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}`);
        await page.locator(".prompt-card").waitFor();
        await appFaces(page);
        if (process.env.OPENCODE_FOLLOWUP !== "optional") {
          await page.evaluate(() => { Object.assign(window, { nativeUnconfirmed: true }); });
          await page.locator(".composer-text").fill("A composer answer");
          // the send key: a phone's Return breaks the line by default, its hardware Mod+Enter sends
          await page.locator(".composer-text").press(width === 390 ? "ControlOrMeta+Enter" : "Enter");
          await page.locator(".composer-note").waitFor();
          assert.equal(await page.locator(".composer-note").textContent(), KO[unconfirmedKey], "composer must show the shipped unconfirmed translation");
          if (shots) await page.screenshot({ path: join(shots, `${width}-${theme}-composer-unconfirmed.png`) });
        }
        if (process.env.OPENCODE_FOLLOWUP !== "composer") {
          for (const type of ["multiselect", "select", "string"]) {
            await page.evaluate(({ next, type }) => {
              Object.assign(window, { nativeUnconfirmed: false, nativeAnswers: [], nativePrompt: {
                ...next, id: `optional-${type}`, title: `optional-${type}`, optional: true, multi_select: type === "multiselect",
                custom_option_index: type === "string" ? 0 : null,
                options: type === "string" ? [{ label: "Your answer", description: null }] : next.options.slice(0, 2),
              } });
            }, { next: prompt, type });
            await page.getByRole("heading", { name: `optional-${type}`, exact: true }).waitFor();
            await page.locator(type === "multiselect" ? ".prompt-card-submit" : ".prompt-card-skip").waitFor();
            const submit = page.locator(type === "multiselect" ? ".prompt-card-submit" : ".prompt-card-skip");
            assert.equal(await submit.isEnabled(), true, `optional ${type} must allow an empty answer`);
            if (shots) await page.screenshot({ path: join(shots, `${width}-${theme}-optional-${type}.png`) });
            const sent = page.waitForFunction(() => (window as unknown as { nativeAnswers: unknown[] }).nativeAnswers.length === 1);
            await submit.click();
            await sent;
            const answer = await page.evaluate(() => (window as unknown as { nativeAnswers: { option_indices?: number[]; custom_text?: string }[] }).nativeAnswers[0]);
            assert.deepEqual(answer, type === "multiselect"
              ? { pane_id: panes.web, prompt_id: `optional-${type}`, option_indices: [] }
              : { pane_id: panes.web, prompt_id: `optional-${type}`, custom_text: "" });
            await page.locator(".prompt-card").waitFor({ state: "hidden" });
          }
        }
        console.log(`PASS followups ${width} ${theme}: ${process.env.OPENCODE_FOLLOWUP ?? "composer and optional questions"}`);
      } finally { await context.close(); }
    }
  } finally {
    await browser.close();
    server.stop(true);
  }
} finally { rmSync(app, { recursive: true, force: true }); }
