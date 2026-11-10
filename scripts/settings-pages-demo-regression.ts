import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { openSettingsFolds, openSettingsPage, themeSide } from "./settings-page.ts";
import { PAGES, SETTINGS, closeSettings, dialogOf, historyHolds, openSettings } from "./settings-pages-harness.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { JA } from "../src/lib/i18n.ja.ts";
import { ZH } from "../src/lib/i18n.zh.ts";
import { terminalTheme } from "../src/lib/settings.ts";
import { rowFor, THEME_IDS, type ThemeId } from "../src/lib/themes.ts";
import baseline from "../src/lib/themes.legacy-baseline.json";
import { comboKey, LEGACY_COMBOS } from "./theme-baseline.ts";

// Settings on the unmodified app over the demo's fixture transport: every page fits a phone, and
// the browser's Back button steps out of the dialog instead of out of the app. All files and
// HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-demo-"));

/** The Settings entry of the current history state, as the app wrote it. */
const entryOf = (page: Page): Promise<{ page: string | null; keyBar: boolean; depth: number } | null> =>
  page.evaluate(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] as never ?? null);
/** Controls and text that reach past their card, and cards past the page's box: a row wider than its card is cut there. */
const cutOff = (page: Page): Promise<string[]> => page.locator(".settings-body:not([hidden]), .settings-key-bar-body").evaluate((body) => {
  const edge = body.getBoundingClientRect();
  const out = [...body.querySelectorAll<HTMLElement>("button, input, select, a, .settings-card, .settings-row, .theme-cards")]
    .filter((node) => {
      const box = node.getBoundingClientRect();
      // a control is held by its card, where it has one; a card by the page
      const card = node.classList.contains("settings-card") ? null : node.closest<HTMLElement>(".settings-card");
      // a theme card is held by the row of cards that scrolls sideways on purpose; the row itself is checked against its card
      if (!node.classList.contains("theme-cards") && node.closest(".theme-cards")) return false;
      const within = card ? card.getBoundingClientRect() : edge;
      return box.width > 0 && (box.right > within.right + 0.5 || box.left < within.left - 0.5);
    })
    .map((node) => `${node.tagName.toLowerCase()}.${node.className} ${node.getAttribute("aria-label") ?? node.textContent?.trim().slice(0, 30) ?? ""}`);
  return body.scrollWidth > body.clientWidth ? [`the page scrolls sideways (${body.scrollWidth} > ${body.clientWidth})`, ...out] : out;
});

interface HeldSteps { holdSteps: (timers?: boolean) => void; releaseSteps: () => void; releaseTimers: () => void; heldSteps: () => number; landed: number }

/**
 * Settings closed and opened again before the browser lands the step back off the closed one's entry,
 * as on a slow phone or a loaded runner (#2000): the app's address bar writes its address on that
 * entry meanwhile, and the step is still Settings' own when it lands. The dialog stays open, and its
 * entry is made again. The step is held here until Settings is open again, and the timers the page
 * sets meanwhile start only once it has landed: a step that lands after Settings' landing deadline is
 * no longer known for its own, and a slow runner must not reach that deadline before the step lands.
 */
async function lateCloseStep(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width, height: 900 } });
    try {
      await context.addInitScript((settings) => {
        localStorage.setItem("ovis:settings", settings);
        const go = history.go.bind(history), back = history.back.bind(history);
        const held: (() => void)[] = [];
        let holding = false;
        const setTimer = window.setTimeout.bind(window), clearTimer = window.clearTimeout.bind(window);
        // a timer set while held: its arguments until it starts, then the id it started with
        const timers = new Map<number, Parameters<typeof setTimeout> | number>();
        let holdingTimers = false, heldId = 0;
        window.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
          if (!holdingTimers) return setTimer(...args);
          timers.set(--heldId, args);
          return heldId;
        }) as typeof setTimeout;
        window.clearTimeout = (id?: number) => {
          const timer = id === undefined ? undefined : timers.get(id);
          if (timer === undefined) clearTimer(id);
          else { timers.delete(id!); if (typeof timer === "number") clearTimer(timer); }
        };
        const steps = window as unknown as HeldSteps;
        steps.holdSteps = (timers = true) => { holding = true; holdingTimers = timers; };
        steps.releaseSteps = () => { holding = false; for (const step of held.splice(0)) step(); };
        steps.releaseTimers = () => {
          holdingTimers = false;
          for (const [id, timer] of timers) if (typeof timer !== "number") timers.set(id, setTimer(...timer));
        };
        steps.heldSteps = () => held.length;
        steps.landed = 0;
        addEventListener("popstate", () => { steps.landed += 1; });
        // a browser picks a traversal's entry when it is asked for, and lands on it later: the held
        // step goes to the entry it named then, whatever was pushed meanwhile
        const navigation = (window as unknown as { navigation: { currentEntry: { index: number } | null; entries: () => { key: string }[]; traverseTo: (key: string) => { committed: Promise<unknown>; finished: Promise<unknown> } } }).navigation;
        const later = (delta: number): void => {
          const target = navigation.entries()[(navigation.currentEntry?.index ?? 0) + delta];
          if (target) held.push(() => { const step = navigation.traverseTo(target.key); step.committed.catch(() => undefined); step.finished.catch(() => undefined); });
        };
        history.go = (delta?: number) => { if (holding) later(delta ?? 0); else go(delta); };
        history.back = () => { if (holding) later(-1); else back(); };
      }, JSON.stringify(SETTINGS));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".composer-text").focus();
      await openSettings(page);
      await page.evaluate(() => (window as unknown as HeldSteps).holdSteps());
      await page.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.locator(".settings-dialog").waitFor({ state: "detached" });
      await page.waitForFunction(() => (window as unknown as HeldSteps).heldSteps() === 1);
      await openSettings(page);
      const landed = await page.evaluate(() => (window as unknown as HeldSteps).landed);
      await page.evaluate(() => (window as unknown as HeldSteps).releaseSteps());
      await page.waitForFunction((before) => (window as unknown as HeldSteps).landed > before, landed);
      await historyHolds(page, `the late step back at ${width}px`, () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 1);
      assert.equal(await page.locator(".settings-dialog").count(), 1, `a Settings opened before the step back landed stays open (${width}px)`);
      await page.evaluate(() => (window as unknown as HeldSteps).releaseTimers());
      await closeSettings(page);
      if (width === 390) {
        // a phone's palette is a sheet: closed, it steps back off its own entry, and Settings opened
        // before that step lands is no Back of the user's either
        await page.keyboard.press("ControlOrMeta+Shift+K");
        await page.locator(".command-palette input[type='search']").waitFor();
        await page.evaluate(() => (window as unknown as HeldSteps).holdSteps(false));
        await page.keyboard.press("Escape");
        await page.locator(".command-palette").waitFor({ state: "detached" });
        await page.waitForFunction(() => (window as unknown as HeldSteps).heldSteps() === 1);
        await openSettings(page);
        const before = await page.evaluate(() => (window as unknown as HeldSteps).landed);
        await page.evaluate(() => (window as unknown as HeldSteps).releaseSteps());
        await page.waitForFunction((count) => (window as unknown as HeldSteps).landed > count, before);
        await historyHolds(page, "the palette's late step back", () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 1);
        assert.equal(await page.locator(".settings-dialog").count(), 1, "a Settings opened before the palette's step back landed stays open");
        await closeSettings(page);
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS a Settings opened again before its closing step back lands stays open, at 1440 and 390px");
}

const checkSelectArrows = async (page: Page): Promise<void> => {
  const controls = await page.locator(".settings-select").evaluateAll((nodes) => nodes.map((select) => {
    const arrow = select.parentElement?.querySelector("svg");
    if (!arrow) return { arrow: false };
    const field = select.getBoundingClientRect();
    const glyph = arrow.getBoundingClientRect();
    const style = getComputedStyle(select);
    return {
      arrow: true,
      inset: field.right - glyph.right,
      expectedInset: parseFloat(style.paddingLeft),
      centered: Math.abs((field.top + field.bottom) / 2 - (glyph.top + glyph.bottom) / 2) < 1,
      textClear: parseFloat(style.paddingRight) > field.right - glyph.left,
      nativeArrowHidden: style.appearance === "none",
      clickThrough: getComputedStyle(arrow).pointerEvents === "none",
      decorative: arrow.getAttribute("aria-hidden") === "true",
    };
  }));
  for (const control of controls) {
    assert.equal(control.arrow, true, "each Settings select has an inset chevron");
    assert.ok(Math.abs(control.inset! - control.expectedInset!) < 1, "the chevron matches the text inset");
    for (const key of ["centered", "textClear", "nativeArrowHidden", "clickThrough", "decorative"] as const) assert.equal(control[key], true, key);
  }
};

try {
  await buildDemoApp(app);
  // the same loop as scripts/settings-rows-demo-regression.ts, which has a second root: each Settings demo script loads the same index.html
  for (const [dir, extra] of [[app, ""]] as const) {
    const index = join(dir, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${extra}${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  }
  const roots = { "/herdr-web-ui/demo/app/": app };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const [prefix, root] = Object.entries(roots).find(([prefix]) => path.startsWith(prefix)) ?? [];
    if (prefix === undefined || root === undefined) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(root, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const [width, language] of [[390, "en"], [320, "en"], [320, "ko"], [320, "ja"], [320, "zh"]] as const) {
        const started = performance.now();
        const strings: Record<string, string> = language === "ko" ? KO : language === "ja" ? JA : language === "zh" ? ZH : {};
        const label = (name: string): string => strings[name] ?? name;
        const context = await browser.newContext({ viewport: { width, height: 760 }, isMobile: true, hasTouch: true, locale: language });
        try {
          await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(url).origin });
          await context.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify({ ...SETTINGS, language }));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const terminal = page.locator(".pane-terminal");
          await terminal.waitFor({ state: "attached" });
          const lens = page.locator(".view-switch");
          await lens.getByRole("button", { name: label("Terminal"), exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), "region");
          assert.equal(await terminal.getAttribute("aria-roledescription"), label("Terminal"));
          assert.equal(await terminal.getAttribute("aria-label"), label("Terminal for {title}").replace("{title}", "Idempotent payments"));
          assert.equal(await terminal.getAttribute("tabindex"), null, "the wrapper adds no empty keyboard stop");
          await lens.getByRole("button", { name: label("Chat"), exact: true }).tap();
          assert.equal(await terminal.getAttribute("role"), null, "chat exposes no empty terminal landmark");
          assert.equal(await terminal.getAttribute("aria-label"), null);
          await openSettings(page);
          for (const name of PAGES) {
            await openSettingsPage(page, label(name), label("Back to settings"));
            // what a page asks the server for (devices, the phone address, the accounts) has arrived
            await page.waitForFunction((loading) => ![...document.querySelectorAll(".settings-body [role='status']")].some((node) => loading.includes(node.textContent?.trim() ?? "")),
              [label("Loading…")]);
            if (name === "Appearance" && process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `select-arrows-${width}-${language}.png`), animations: "disabled" });
            await checkSelectArrows(page);
            if (name === "Agents") await page.locator(".usage-accounts-row").first().waitFor();
            if (name === "Chat") {
              // Voice input is Chat's group; its OpenAI key is in Chat's More settings
              await openSettingsFolds(page);
              await page.locator(".voice-key").waitFor();
              const dictation = page.getByLabel(label("Dictation language"), { exact: true });
              await dictation.selectOption("hu-HU");
              await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings")!).voiceLanguage === "hu-HU");
              assert.equal(await dictation.inputValue(), "hu-HU");
              assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).language), language,
                "dictation selection does not change the display language");
              await dictation.selectOption("auto");
            }
            if (name === "Agents") {
              // the demo's PC has Claude Code, Codex, Oh My Pi, pi and Hermes; its accounts go under their
              // agent, and the rest (Cursor, OpenCode, whose agent is not on the PC) under Other accounts
              const body = page.locator(".settings-body:not([hidden])");
              await body.locator(".agents-item").first().waitFor();
              assert.equal(await body.locator("[role='alert']").count(), 0, "the Agents page shows no error");
              assert.deepEqual(await body.locator(".agents-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent"))), ["claude", "codex", "omp", "pi", "hermes"]);
              assert.deepEqual(await body.locator("[data-section='other-accounts'] .usage-provider-heading > span:not(.usage-account-count):not(.agent-mark)").allTextContents(), ["Cursor", "OpenCode"]);
              // herdr-app's rows: no group captions on this page
              assert.deepEqual(await body.locator("h3").allTextContents(), []);
              // an agent's own settings are in its row: Claude Code's permission mode for New tab
              await body.locator(".agents-item[data-agent='claude'] .agents-toggle").click();
              await body.locator(".agents-item[data-agent='claude']").getByLabel(label("Permission mode"), { exact: true }).waitFor();
              // and the model and effort New tab fills in for it: a name its --model takes is kept, any other is said why
              const claudeRow = body.locator(".agents-item[data-agent='claude']");
              const launchDefaults = () => page.evaluate(() => { const stored = JSON.parse(localStorage.getItem("ovis:settings") ?? "{}"); return [stored.claudeLaunchModel ?? "", stored.claudeLaunchEffort ?? ""]; });
              await claudeRow.getByLabel(label("Model"), { exact: true }).fill("opus");
              await claudeRow.getByLabel(label("Effort"), { exact: true }).selectOption("high");
              await page.waitForFunction(() => { const stored = JSON.parse(localStorage.getItem("ovis:settings")!); return stored.claudeLaunchModel === "opus" && stored.claudeLaunchEffort === "high"; });
              await claudeRow.getByLabel(label("Model"), { exact: true }).fill("opus --verbose");
              await claudeRow.locator("[role='alert']").filter({ hasText: label("One model name, without spaces.") }).waitFor();
              assert.deepEqual(await launchDefaults(), ["opus", "high"], "a name --model would refuse is not kept");
              await claudeRow.getByLabel(label("Model"), { exact: true }).fill("");
              await claudeRow.getByLabel(label("Effort"), { exact: true }).selectOption("");
              await page.waitForFunction(() => { const stored = JSON.parse(localStorage.getItem("ovis:settings")!); return stored.claudeLaunchModel === "" && stored.claudeLaunchEffort === ""; });
              await body.locator(".agents-item[data-agent='claude'] .agents-toggle").click();
              // herdr's integrations no row shows, each with its command; one with neither its agent nor its
              // hook on the PC (copilot, cursor, antigravity-cli) is not listed at all (#2738)
              assert.deepEqual(await body.locator("[data-section='integrations'] .settings-label").allTextContents(), ["opencode"]);
              assert.equal(await body.locator("[data-section='integrations-missing']").count(), 0);
              const install = (target: string): string => `herdr integration install ${target}`;
              const copyLabel = (target: string): string => label("Copy the command for {name}").replace("{name}", target);
              // a row opens on its accounts and herdr's session resume
              const codex = body.locator(".agents-item[data-agent='codex']");
              await codex.locator(".agents-toggle").tap();
              assert.equal(await codex.locator(".agents-toggle").getAttribute("aria-expanded"), "true");
              assert.equal(await codex.getByLabel(label("Sandbox and approvals"), { exact: true }).count(), 1, "Codex's row holds the mode New tab starts it in");
              assert.equal(await codex.getByLabel(label("Effort"), { exact: true }).count(), 1, "and the effort New tab fills in for it");
              assert.equal(await codex.locator(".usage-accounts-row").count(), 2, "Codex's two accounts are in its row");
              assert.equal(await codex.locator("code").textContent(), install("codex"));
              const copy = codex.getByRole("button", { name: copyLabel("codex"), exact: true });
              await copy.tap();
              await codex.getByRole("button", { name: copyLabel("codex"), exact: true }).filter({ hasText: label("Copied") }).waitFor();
              assert.equal(await page.evaluate(() => navigator.clipboard.readText()), install("codex"));
              // a move within Codex's row swaps its two accounts and leaves Claude's place in the meters' order
              const second = codex.locator(".usage-accounts-row").nth(1);
              const moved = await second.locator(".usage-accounts-account").textContent();
              await second.locator(".usage-accounts-actions .icon-button").first().tap();
              await page.waitForFunction(() => (JSON.parse(localStorage.getItem("ovis:settings")!).usageOrder as string[]).length > 0);
              const order = await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).usageOrder as string[]);
              assert.ok(order[0]!.startsWith("claude"), `Claude keeps the first place: ${order.join(", ")}`);
              assert.equal(await codex.locator(".usage-accounts-row").first().locator(".usage-accounts-account").textContent(), moved);
              // a Check again that fails after a good read keeps the rows it had, and says why beside them
              await page.evaluate(() => {
                const passing = window.fetch;
                (window as unknown as { restoreCatalog: () => void }).restoreCatalog = () => { window.fetch = passing; };
                window.fetch = (input, init) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname === "/api/agent-catalog"
                  ? Promise.resolve(Response.json({ error: { code: "fixture", message: "The catalog check failed (fixture)." } }, { status: 500 }))
                  : passing(input, init);
              });
              await body.getByRole("button", { name: label("Check again"), exact: true }).tap();
              await body.locator("[data-section='agents-installed'] [role='alert']").filter({ hasText: "The catalog check failed (fixture)." }).waitFor();
              assert.equal(await codex.locator(".usage-accounts-row").count(), 2, "Codex's accounts stay after a failed Check again");
              assert.deepEqual(await body.locator(".agents-item").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-agent"))), ["claude", "codex", "omp", "pi", "hermes"]);
              await page.evaluate(() => (window as unknown as { restoreCatalog: () => void }).restoreCatalog());
              await body.getByRole("button", { name: label("Check again"), exact: true }).tap();
              await body.locator("[data-section='agents-installed'] [role='alert']").waitFor({ state: "detached" });
              await codex.locator(".agents-toggle").tap();
            }
            if (name === "Appearance" && language === "en") {
              // each legacy palette-mode is written to the document and saved, and its blocks of styles.css
              // reach the page: every color token computes to the frozen baseline's used value
              // (src/lib/themes.legacy-baseline.json), and the --term-* tokens to the theme xterm is given.
              // The build minifies colors (rgba() to #rrggbbaa), so both sides are compared as the browser
              // computes them on a probe: a color, a box-shadow, or a border for `2px solid <color>`
              const themes = page.getByRole("group", { name: "Theme", exact: true });
              const pickers = { dark: themeSide(page, "dark"), light: themeSide(page, "light") };
              // both sides' cards offer every theme, the side's own kind first (Q1: any theme on either side)
              for (const side of ["dark", "light"] as const) {
                const listed = await pickers[side].listed();
                assert.deepEqual([...listed].sort(), [...THEME_IDS].sort(), `the ${side} cards list every theme once`);
                assert.ok(listed.includes("dracula"), `the ${side} cards offer Dracula`);
                const kinds = listed.map((id) => rowFor(id, side).mode === side);
                assert.deepEqual(kinds, [...kinds].sort((a, b) => Number(b) - Number(a)), `the ${side} cards list the side's own kind first`);
              }
              const drawn = (mode: string, id: string): Promise<unknown> => page.waitForFunction(([mode, id]) => document.documentElement.dataset.theme === mode && document.documentElement.dataset.palette === id && getComputedStyle(document.documentElement).colorScheme === mode, [mode, id]);
              /** The theme keys of the saved record and of the second key old code never touches. */
              const stored = () => page.evaluate(() => {
                const record = JSON.parse(localStorage.getItem("ovis:settings")!) as Record<string, string>;
                const themes = JSON.parse(localStorage.getItem("ovis:themes")!) as Record<string, string>;
                return { palette: record["palette"], darkTheme: record["darkTheme"], lightTheme: record["lightTheme"], second: { darkTheme: themes["darkTheme"], lightTheme: themes["lightTheme"] } };
              });
              const xtermTokens = (mode: "dark" | "light", id: ThemeId): (readonly [string, string])[] => {
                const xterm = terminalTheme(mode, id);
                return ([["--term-bg", xterm.background], ["--term-fg", xterm.foreground], ["--term-cursor", xterm.cursor], ["--term-selection", xterm.selectionBackground]] as const).map(([name, value]) => [`xterm ${name}`, value] as const);
              };
              /** The expected tokens the page computes differently, as `name: want -> got`. */
              const drift = (expected: (readonly [string, string])[]): Promise<string[]> => page.evaluate((expected) => {
                const root = getComputedStyle(document.documentElement);
                const probe = document.body.appendChild(document.createElement("div"));
                const used = (value: string): string => {
                  const kind = /\bsolid\b/.test(value) ? "border" : /\dpx\b/.test(value) ? "boxShadow" : "color";
                  probe.removeAttribute("style");
                  probe.style[kind] = value;
                  if (probe.style[kind] === "") return `invalid ${kind}: ${value}`;
                  const style = getComputedStyle(probe);
                  return kind === "border" ? `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}` : style[kind];
                };
                const out = expected.flatMap(([name, value]) => {
                  const [want, got] = [used(value), used(root.getPropertyValue(name.replace(/^xterm /, "")))];
                  return want === got ? [] : [`${name}: ${want} -> ${got}`];
                });
                probe.remove();
                return out;
              }, expected);
              const combos: Record<string, { resolved: Record<string, string> }> = baseline.combos;
              for (const { palette: id, mode } of LEGACY_COMBOS) {
                const key = comboKey(id, mode);
                await themes.getByRole("button", { name: mode === "dark" ? "Dark" : "Light", exact: true }).tap();
                await pickers[mode].selectOption(id);
                await drawn(mode, id);
                await checkSelectArrows(page);
                assert.equal((await stored()).palette, id);
                assert.deepEqual(await drift([...Object.entries(combos[key]!.resolved), ...xtermTokens(mode, id)]), [], `${key}: the page computes the frozen colors, and --term-* as the theme xterm is given`);
                if (key === "catppuccin/dark" && process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `catppuccin-palette-${width}.png`), fullPage: true });
              }
              // a herdr pair: Tokyo Night on the dark side fills the untouched light side with Tokyo Night Day, each
              // side draws its own row with its xterm colors, and the look follows the mode toggle
              await themes.getByRole("button", { name: "Dark", exact: true }).tap();
              await pickers.light.selectOption("amber");
              await pickers.dark.selectOption("tokyo-night");
              await drawn("dark", "tokyo-night");
              assert.deepEqual(await stored(), { palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night-day", second: { darkTheme: "tokyo-night", lightTheme: "tokyo-night-day" } }, "a paired dark theme fills the light side still at its default with its sibling");
              assert.equal(await pickers.light.inputValue(), "tokyo-night-day");
              assert.deepEqual(await drift(xtermTokens("dark", "tokyo-night")), [], "tokyo-night/dark: --term-* as the theme xterm is given");
              await themes.getByRole("button", { name: "Light", exact: true }).tap();
              await drawn("light", "tokyo-night-day");
              assert.equal((await stored()).palette, "tokyo-night-day", "the legacy palette mirrors the side the mode draws");
              assert.deepEqual(await drift(xtermTokens("light", "tokyo-night-day")), [], "tokyo-night-day/light: --term-* as the theme xterm is given");
              // any theme on either side (Q1): a dark theme picked for the light side draws dark in Light mode
              await pickers.light.selectOption("tokyo-night");
              await drawn("dark", "tokyo-night");
              assert.deepEqual(await stored(), { palette: "tokyo-night", darkTheme: "tokyo-night", lightTheme: "tokyo-night", second: { darkTheme: "tokyo-night", lightTheme: "tokyo-night" } }, "a dark theme on the light side is kept as chosen");
              assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).theme), "light", "the mode stays Light while the row drawn is dark");
              // a side chosen by hand keeps its theme when the other side picks a pair
              await themes.getByRole("button", { name: "Dark", exact: true }).tap();
              await pickers.dark.selectOption("gruvbox");
              await drawn("dark", "gruvbox");
              assert.deepEqual(await stored(), { palette: "gruvbox", darkTheme: "gruvbox", lightTheme: "tokyo-night", second: { darkTheme: "gruvbox", lightTheme: "tokyo-night" } }, "a light side chosen by hand is not filled with the pair's sibling");
              // the pages after this one are checked on the default theme
              await pickers.dark.selectOption("amber");
              await pickers.light.selectOption("amber");
              await drawn("dark", "amber");
            }
            assert.deepEqual(await cutOff(page), [], `${name} fits a ${width}px phone (${language})`);
          }
          await openSettingsPage(page, label("Terminal"), label("Back to settings"));
          await page.getByRole("button", { name: label("Edit key bar"), exact: true }).tap();
          await page.locator(".key-bar-settings").waitFor();
          assert.deepEqual(await cutOff(page), [], `Key bar fits a ${width}px phone (${language})`);
          await page.getByRole("button", { name: label("Back to settings"), exact: true }).tap();
          // the quick replies are text fields beside a Remove button each: both stay in the card
          if (language === "en") {
            await openSettingsPage(page, "Chat");
            const replies = page.locator(".quick-replies-list li");
            assert.ok(await replies.count() > 0);
            // the list is edited only while the replies show; off, the row stands alone
            const showReplies = page.getByRole("switch", { name: "Show above the message box", exact: true });
            await showReplies.tap();
            await page.locator(".quick-replies-list").waitFor({ state: "detached" });
            await showReplies.tap();
            await replies.first().waitFor();
            await page.getByRole("button", { name: "Remove quick reply 1", exact: true }).tap();
            assert.equal(await replies.count(), (JSON.parse(await page.evaluate(() => localStorage.getItem("ovis:settings")!)) as { quickReplies: string[] }).quickReplies.length);
            await page.getByRole("button", { name: "Restore defaults", exact: true }).tap();
          }
          assert.deepEqual(errors, []);
          await page.getByRole("button", { name: label("Close settings"), exact: true }).tap();
          if (language === "en") {
            const composer = page.locator(".composer-text");
            await composer.fill("/");
            const menu = page.getByRole("listbox", { name: "Slash commands" });
            await menu.getByRole("option").last().waitFor();
            await composer.press("ArrowUp");
            await page.waitForFunction(() => {
              const menu = document.querySelector(".composer-menu");
              const active = menu?.querySelector('[aria-selected="true"]');
              if (!menu || !active) return false;
              const box = menu.getBoundingClientRect(), row = active.getBoundingClientRect();
              // the terminal commands end the list, so the last row is the last of them
              return active === [...menu.querySelectorAll('[role="option"]')].at(-1) && active.textContent?.includes("terminal-setup") && row.top >= box.top && row.bottom <= box.bottom;
            });
            // Enter right after the keystroke that narrows the list, before React's next render, completes the row
            await page.evaluate(async () => {
              const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
              Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "/comments");
              box.selectionStart = box.selectionEnd = box.value.length;
              box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
              await Promise.resolve(); await Promise.resolve();
              box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
            });
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "/pr-comments ");
            await composer.fill("/comments");
            await menu.getByRole("option").filter({ hasText: "pr-comments" }).waitFor();
            assert.equal(await menu.getByRole("option").count(), 1);
            await composer.press("Tab");
            await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "/pr-comments ");
            assert.equal(await composer.inputValue(), "/pr-comments ");
            // a key typed after a completion, before the next frame (a busy phone), stays where it was typed
            await composer.fill("/comments");
            await menu.getByRole("option").filter({ hasText: "pr-comments" }).waitFor();
            await page.evaluate(() => {
              const real = window.requestAnimationFrame, held: FrameRequestCallback[] = [];
              window.requestAnimationFrame = (callback) => { held.push(callback); return 0; };
              addEventListener("release-frames", () => {
                window.requestAnimationFrame = real;
                for (const callback of held) callback(performance.now());
              }, { once: true });
            });
            await composer.press("Tab");
            await page.keyboard.type("a");
            await page.evaluate(() => dispatchEvent(new Event("release-frames")));
            await page.keyboard.type("b");
            assert.equal(await composer.inputValue(), "/pr-comments ab");
            await composer.fill("/rln");
            await menu.getByRole("option").filter({ hasText: "release-notes" }).waitFor();
            assert.equal(await menu.getByRole("option").count(), 1);
            await composer.fill("");
            console.log(`PASS fuzzy commands and offscreen keyboard selection (${width}px)`);
          }
          console.log(`PASS every Settings page and key bar fit a ${width}px phone (${language}); ${(performance.now() - started).toFixed(0)}ms`);
        } finally {
          await context.close();
        }
      }

      const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await phone.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
        // every move of the history, for historyHolds to tell when a step never lands
        await phone.addInitScript(() => {
          const trace: string[] = [];
          (window as unknown as { historyTrace: string[] }).historyTrace = trace;
          const note = (what: string): void => { trace.push(`${Math.round(performance.now())}ms ${what} ${JSON.stringify(history.state)} ${location.search}`); };
          for (const method of ["go", "back", "pushState", "replaceState"] as const) {
            const call = (history[method] as (...args: unknown[]) => void).bind(history);
            (history as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => { note(`before ${method}(${method === "go" ? String(args[0]) : ""})`); call(...args); note(`after ${method}`); };
          }
          addEventListener("popstate", () => note("popstate"), true);
          note("loaded");
        });
        // a load that was asked to hold its steps back keeps them until the app has drawn itself, as a
        // slow device does, and notes whether Settings was ever shown
        await phone.addInitScript(() => {
          if (sessionStorage.getItem("hold-steps-back") !== "1") return;
          sessionStorage.removeItem("hold-steps-back");
          const page = window as unknown as { releaseStepsBack: () => void; settingsShown: boolean };
          const go = history.go.bind(history);
          const held: Array<() => void> = [];
          history.go = (delta?: number) => { held.push(() => go(delta)); };
          page.releaseStepsBack = () => { history.go = go; for (const step of held.splice(0)) step(); };
          page.settingsShown = false;
          new MutationObserver(() => { if (document.querySelector(".settings-dialog") !== null) page.settingsShown = true; }).observe(document, { childList: true, subtree: true });
        });
        const page = await phone.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const dialog = dialogOf(page);
        const list = dialog.getByRole("tablist");

        // Back steps out one screen at a time: the key bar editor, the page, the list, and only then nothing.
        // The address names the pane shown (lib/deepLink.ts) once the roster is in: that is where Back returns
        await page.waitForFunction(() => new URLSearchParams(window.location.search).has("pane"));
        const before = page.url();
        await openSettings(page);
        assert.deepEqual(await entryOf(page), { page: null, keyBar: false, depth: 1 });
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        assert.deepEqual(await entryOf(page), { page: "terminal", keyBar: true, depth: 3 });
        await page.goBack();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        assert.equal(await page.locator(".key-bar-settings").count(), 0);
        await page.goBack();
        await list.waitFor();
        assert.equal(await dialog.getByRole("tabpanel").count(), 0, "Back from a page shows the list again");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        assert.equal(await entryOf(page), null);
        assert.equal(page.url(), before, "the last Back closes Settings and leaves the app where it was");
        await page.locator(".conn-live").waitFor({ state: "attached" });
        console.log("PASS Back on a phone leaves the key bar editor, then the page, then the list, and stays in the app");

        // the dialog's own Back control takes the same entry off: the next Back is not spent on it
        await openSettings(page);
        await openSettingsPage(page, "Chat");
        await dialog.getByRole("button", { name: "Back to settings", exact: true }).tap();
        await list.waitFor();
        await historyHolds(page, "the Back control to the list", () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 1);
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        console.log("PASS the Back control in the dialog and the system Back button share one history");

        // closing from the deepest screen leaves no entry behind, and Forward does not reopen what the X closed by itself
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("button", { name: "Close settings", exact: true }).tap();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await historyHolds(page, "the X from the key bar editor", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        // and a new opening starts on the list, with one entry
        await openSettings(page);
        await list.waitFor();
        await historyHolds(page, "a new opening", () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 1);
        // a reload keeps the history but not the dialog: its entries are stepped out of. The step lands
        // when the browser gets to it, which on a slow device is after the app has drawn itself from an
        // address that still names Settings: held back until then here, it must not show the dialog
        await openSettingsPage(page, "Alerts");
        await page.waitForFunction(() => new URLSearchParams(window.location.search).get("settings") === "alerts");
        await page.evaluate(() => sessionStorage.setItem("hold-steps-back", "1"));
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.evaluate(() => (window as unknown as { releaseStepsBack: () => void }).releaseStepsBack());
        await historyHolds(page, "the reload", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload does not reopen Settings");
        assert.equal(await page.evaluate(() => (window as unknown as { settingsShown: boolean }).settingsShown), false, "a reload never shows Settings, however late its step back lands");
        assert.deepEqual(errors, []);
        console.log("PASS the X from the key bar editor and a reload leave no Settings entry in the history");

        // a link to Settings opens it, and a reload there closes it as well: the entry the reload
        // steps back to is the one the link opened, whose address names Settings still
        await page.goto(`${url}?settings=about`);
        await dialog.getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await historyHolds(page, "a link to Settings", () => (history.state as Record<string, { page: string; depth: number }> | null)?.["ovis:settings"]?.page === "about");
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await historyHolds(page, "the reload on a linked Settings", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined && !new URLSearchParams(window.location.search).has("settings"));
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload closes the Settings a link opened");
        assert.deepEqual(errors, []);
        console.log("PASS a link to Settings opens it, and a reload there closes it");

        // another script's entries pushed while Settings is open bury its entries: Back out of them
        // closes Settings, and the next Back steps over the buried entries instead of opening them again
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialog.getByRole("button", { name: "Edit key bar", exact: true }).tap();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await historyHolds(page, "the key bar editor", () => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 3);
        await page.evaluate(() => { history.pushState({ route: "markerless" }, ""); history.pushState({ route: "after-markerless" }, ""); });
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.evaluate(() => {
          const seen = window as unknown as { settingsShown: boolean };
          seen.settingsShown = false;
          new MutationObserver(() => { if (document.querySelector(".settings-dialog") !== null) seen.settingsShown = true; }).observe(document, { childList: true, subtree: true });
        });
        await page.goBack();
        await historyHolds(page, "Back over the buried entries", () => {
          const state = history.state as Record<string, unknown> | null;
          return state?.["ovis:settings"] === undefined && state?.["route"] === undefined;
        });
        assert.equal(await page.locator(".settings-dialog").count(), 0, "Back under an unrelated entry does not reopen Settings");
        assert.equal(await page.evaluate(() => (window as unknown as { settingsShown: boolean }).settingsShown), false, "the buried entries are stepped over without showing Settings");
        assert.deepEqual(errors, []);
        console.log("PASS Back past an unrelated entry steps over the Settings entries it buried");
      } finally {
        await phone.close();
      }

      if (process.env.UI_EVIDENCE_DIR) {
        for (const width of [1280, 390]) {
          const context = await browser.newContext({
            viewport: { width, height: width === 390 ? 844 : 800 },
            isMobile: width === 390, hasTouch: width === 390, locale: "en-US",
          });
          try {
            await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
            const page = await context.newPage();
            await page.goto(url);
            await page.locator(".conn-live").waitFor({ state: "attached" });
            await openSettings(page);
            await openSettingsPage(page, "Appearance");
            for (const mode of ["light", "dark"]) {
              await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: mode === "dark" ? "Dark" : "Light", exact: true }).click();
              await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, mode);
              await checkSelectArrows(page);
              await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `select-arrows-${width}-${mode}.png`), animations: "disabled" });
            }
          } finally {
            await context.close();
          }
        }
      }

      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      try {
        await desktop.addInitScript((settings) => {
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings);
        }, JSON.stringify(SETTINGS));
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await openSettings(page);
        await openSettingsPage(page, "Appearance");
        await checkSelectArrows(page);
        if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "select-arrows-desktop.png"), animations: "disabled" });
        // a select on Appearance (the theme pickers are cards now): Interface font
        const themePicker = page.getByLabel("Interface font", { exact: true });
        await themePicker.focus();
        await page.keyboard.press("ArrowDown");
        assert.notEqual(await themePicker.inputValue(), "default", "the native select keeps keyboard selection");
        await themePicker.selectOption("default");
        await page.emulateMedia({ forcedColors: "active" });
        assert.equal(await themePicker.evaluate((select) => getComputedStyle(select).appearance), "auto", "forced colors restores the native indicator");
        assert.equal(await themePicker.locator("..").locator("svg").evaluate((arrow) => getComputedStyle(arrow).display), "none");
        await page.emulateMedia({ forcedColors: "none" });
        await checkSelectArrows(page);
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        // Settings is opened again below: its close's step back lands first, or, landing over a second late,
        // it is taken for a Back and closes the Settings opened meanwhile (settingsHistory's landing deadline)
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        for (const id of ["dracula", "nord", "vesper", "black"]) {
          await openSettings(page);
          await openSettingsPage(page, "Appearance");
          await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Dark", exact: true }).click();
          await themeSide(page, "dark").selectOption(id);
          await page.waitForFunction((id) => document.documentElement.dataset.palette === id && document.documentElement.dataset.theme === "dark", id);
          assert.equal(await themeSide(page, "light").inputValue(), "amber", `${id} has no sibling pre-fill`);
          const surfaces = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return ["--border", "--bg-elevated", "--bg-input"].map((role) => style.getPropertyValue(role).trim());
          });
          assert.notEqual(surfaces[0], surfaces[1], `${id} border differs from elevated surface`);
          assert.notEqual(surfaces[0], surfaces[2], `${id} border differs from input surface`);
          await checkSelectArrows(page);
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${id}-appearance-1280.png`), animations: "disabled" });
          await page.keyboard.press("Escape");
          await page.locator(".settings-dialog").waitFor({ state: "detached" });
          await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
          await page.locator(".composer-text").waitFor();
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${id}-chat-1280.png`), animations: "disabled" });
        }
        await openSettings(page);
        await openSettingsPage(page, "Appearance");
        await themeSide(page, "light").selectOption("dracula");
        await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
        await page.waitForFunction(() => document.documentElement.dataset.palette === "dracula" && document.documentElement.dataset.theme === "dark" && getComputedStyle(document.documentElement).colorScheme === "dark");
        assert.equal(await page.getByRole("group", { name: "Theme", exact: true }).getByRole("button", { name: "Light", exact: true }).getAttribute("aria-pressed"), "true");
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!).theme), "light");
        if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "dracula-light-side-1280.png"), animations: "disabled" });
        await page.evaluate(() => {
          const settings = JSON.parse(localStorage.getItem("ovis:settings")!);
          localStorage.setItem("ovis:settings", JSON.stringify({ ...settings, theme: "light", lightTheme: "not-a-theme" }));
          localStorage.setItem("ovis:themes", JSON.stringify({ darkTheme: "vesper", lightTheme: "not-a-theme" }));
        });
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.waitForFunction(() => document.documentElement.dataset.palette === "codex" && document.documentElement.dataset.theme === "light" && getComputedStyle(document.documentElement).colorScheme === "light");
        if (process.env.UI_EVIDENCE_DIR) writeFileSync(join(process.env.UI_EVIDENCE_DIR, "any-side.txt"), "PASS Light mode with lightTheme=dracula draws data-theme=dark, data-palette=dracula, color-scheme=dark.\nPASS injected lightTheme=not-a-theme reloads codex light, the default.\nPASS Dracula, Nord and Vesper do not pre-fill a sibling.\n");
        console.log("PASS dark-only themes on either side, distinct borders, no siblings, and unknown-id reload");
        // the reload was made with Settings open: its step out of Settings' entry lands before Settings opens again
        await historyHolds(page, "the reload with Settings open", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        await openSettings(page);
        // beside the list, turning pages is one step however many are turned
        for (const name of ["Chat", "Shortcuts", "About"]) await openSettingsPage(page, name);
        await page.waitForFunction(() => (history.state as Record<string, { page: string; depth: number }> | null)?.["ovis:settings"]?.page === "about");
        assert.equal((await entryOf(page))?.depth, 1);
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        // Forward opens it where it was
        await page.goForward();
        await dialogOf(page).getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await page.keyboard.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        assert.deepEqual(errors, []);
        console.log("PASS on a desktop Back closes Settings in one step, Forward reopens its page, Escape takes the entry off");

        // the window changes width with Settings open: the steps Back takes are the ones now shown
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForFunction(() => (history.state as Record<string, { depth: number }> | null)?.["ovis:settings"]?.depth === 2);
        await page.goBack();
        await dialogOf(page).getByRole("tablist").waitFor();
        assert.equal(await dialogOf(page).getByRole("tabpanel").count(), 0, "narrowed, Back from the page shows the list");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await openSettings(page);
        await openSettingsPage(page, "Terminal");
        await dialogOf(page).getByRole("button", { name: "Edit key bar", exact: true }).click();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await page.setViewportSize({ width: 1280, height: 800 });
        // the rebuilt stack, not the step the widening passes through
        await page.waitForFunction(() => { const entry = (history.state as Record<string, { page: string; keyBar: boolean; depth: number }> | null)?.["ovis:settings"]; return entry?.depth === 2 && entry.page === "terminal" && entry.keyBar === true; });
        await page.goBack();
        await dialogOf(page).getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        assert.equal(await page.locator(".key-bar-settings").count(), 0, "widened, Back from the editor shows the Terminal page");
        await page.goBack();
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        assert.deepEqual(errors, []);
        console.log("PASS a window that changes width with Settings open keeps Back to the steps it shows");

        // a link to a file and Settings opens the preview (a panel beside the pane at this width) under
        // Settings; a reload there closes Settings and keeps the file, and Back then steps out of both
        const infra = panes.omp;
        await page.goto(`${url}?ws=${infra.split(":")[0]}&pane=${encodeURIComponent(infra)}&file=README.md&settings=about`);
        await dialogOf(page).getByRole("tabpanel", { name: "About", exact: true }).waitFor();
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await historyHolds(page, "a link to a file and Settings", () => (history.state as Record<string, unknown> | null)?.["ovis:file-preview"] !== undefined);
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator("aside.file-panel .file-viewer").waitFor();
        await historyHolds(page, "the reload on a preview over Settings", () => {
          const address = new URLSearchParams(window.location.search);
          return address.get("file") === "README.md" && !address.has("settings") && (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined;
        });
        assert.equal(await page.locator(".settings-dialog").count(), 0, "a reload on a preview over Settings closes Settings");
        assert.equal(await page.locator("aside.file-panel .file-viewer").count(), 1, "a reload on a preview over Settings keeps the file open");
        await page.goBack();
        await page.locator("aside.file-panel .file-viewer").waitFor({ state: "detached" });
        await historyHolds(page, "Back from the reloaded preview", () => (history.state as Record<string, unknown> | null)?.["ovis:settings"] === undefined);
        assert.equal(await page.locator(".settings-dialog").count(), 0, "Back from the reloaded preview does not reopen Settings");
        assert.deepEqual(errors, []);
        console.log("PASS a reload on a preview opened over Settings closes Settings and keeps the file");
      } finally {
        await desktop.close();
      }

      await lateCloseStep(browser, url);
    } finally {
      await browser.close();
      console.log("CLEANUP browser closed");
    }
  } finally {
    server.stop(true);
    console.log("CLEANUP loopback demo server stopped");
  }
} finally {
  rmSync(app, { recursive: true, force: true });
  console.log("CLEANUP disposable demo apps removed");
}
