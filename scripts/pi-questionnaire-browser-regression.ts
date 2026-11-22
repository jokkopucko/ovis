import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import fixture from "../server/fixtures/pi-questionnaire.json";
import { parsePiQuestionnaire, piQuestionnaireOf } from "../server/dialogs/pi-questionnaire.ts";
import { publicPrompt } from "../server/dialogs/shared.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { appFaces } from "./app-faces.ts";

const app = mkdtempSync(join(tmpdir(), "ovis-questionnaire-browser-"));
const shots = process.env.PI_QUESTIONNAIRE_SHOTS;
const single = piQuestionnaireOf("single", fixture.single)!;
const multi = piQuestionnaireOf("multi", fixture.multi)!;
const cards = [
  publicPrompt(parsePiQuestionnaire(fixture.screens["single-narrow"], single)!),
  publicPrompt(parsePiQuestionnaire(fixture.screens["multi-first-narrow"], multi)!),
  publicPrompt(parsePiQuestionnaire(fixture.screens["multi-second"], multi)!),
  publicPrompt(parsePiQuestionnaire(fixture.screens["review-missing"], multi)!),
  publicPrompt(parsePiQuestionnaire(fixture.screens["review-narrow"], multi)!),
];
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const transport = `<script>(() => {
    const demo = window.fetch;
    window.questionnaireCard = ${JSON.stringify(cards[0])};
    window.questionnaireAnswers = [];
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.url || input.href, location.href);
      if (url.pathname === "/api/pane/prompt" && url.searchParams.get("pane_id") === ${JSON.stringify(panes.web)})
        return Response.json({ prompt: window.questionnaireCard, suggestion: null });
      if (url.pathname === "/api/pane/prompt/answer") {
        window.questionnaireAnswers.push(JSON.parse(init.body));
        window.questionnaireCard = null;
        return Response.json({ ok: true });
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `<script src="./demo-transport.js"></script>${transport}<script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname.replace(/^\/herdr-web-ui\/demo\/app\//, "");
    if (path.includes("..")) return new Response(null, { status: 404 });
    return new Response(Bun.file(join(app, path || "index.html")));
  } });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    if (shots) mkdirSync(shots, { recursive: true });
    for (const width of [390, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      try {
        await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.goto(`${server.url.origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.web)}`);
        const card = page.locator(".prompt-card");
        await card.waitFor();
        await appFaces(page);
        const mount = async (at: number) => {
          await card.waitFor({ state: "hidden" });
          await page.evaluate(next => { (window as unknown as { questionnaireCard: unknown }).questionnaireCard = next; }, cards[at]);
          await card.waitFor();
        };
        const sent = async (count: number) => {
          await page.waitForFunction(n => (window as unknown as { questionnaireAnswers: unknown[] }).questionnaireAnswers.length === n, count);
          return page.evaluate(n => (window as unknown as { questionnaireAnswers: Record<string, unknown>[] }).questionnaireAnswers[n - 1]!, count);
        };
        assert.equal(await card.locator(".prompt-card-option").count(), 2);
        assert.match(await card.locator(".prompt-card-option-description").first().innerText(), /Reuse the existing/);
        await card.locator(".prompt-card-option").nth(1).click();
        assert.equal((await sent(1)).option_index, 1);
        await mount(0);
        await card.locator(".prompt-card-custom input").fill("A mobile custom answer");
        if (shots) await page.screenshot({ path: join(shots, `${width}-custom.png`) });
        await card.locator(".prompt-card-custom button").click();
        assert.equal((await sent(2)).custom_text, "A mobile custom answer");
        await mount(1);
        await card.locator(".prompt-card-step-button", { hasText: "Verification" }).click();
        assert.equal((await sent(3)).step_index, 1);
        await mount(2);
        assert.equal(await card.locator(".prompt-card-custom").count(), 0, "allowOther false has no free-text field");
        await card.locator(".prompt-card-option").first().click();
        assert.equal((await sent(4)).option_index, 0);
        await mount(3);
        assert.equal(await card.locator(".prompt-card-option").count(), 1);
        assert.match(await card.locator(".prompt-card-option").innerText(), /Cancel/);
        assert.equal(await card.locator(".prompt-card-answers dt").count(), 2);
        await card.locator(".prompt-card-step-button", { hasText: "Scope" }).click();
        assert.equal((await sent(5)).step_index, 0);
        await mount(4);
        assert.equal(await card.locator(".prompt-card-answers dd").count(), 2);
        assert.match(await card.locator(".prompt-card-answers").innerText(), /Small compatibility fix/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (shots) await page.screenshot({ path: join(shots, `${width}-review.png`) });
        await card.locator(".prompt-card-option").first().click();
        assert.equal((await sent(6)).option_index, 0);
        assert.deepEqual(errors, []);
        console.log(`PASS questionnaire options, custom input, tabs, allowOther=false and review at ${width}px`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); server.stop(true); }
} finally { rmSync(app, { recursive: true, force: true }); }
