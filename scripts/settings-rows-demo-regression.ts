import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp, buildDevelopmentDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { openSettingsFolds, openSettingsPage, themeSide } from "./settings-page.ts";
import { SETTINGS, closeSettings, dialogOf, historyHolds, openPalette, openSettings } from "./settings-pages-harness.ts";
import { DEFAULT_SETTINGS } from "../src/lib/settings.ts";

// What Settings' pages hold, on the unmodified app over the demo's fixture transport: the dialog's
// own search, the folded groups, the rows that merge or put back settings, the account's PCs and
// sign-in, and About. One landing is checked on React's development build too. All files and HTTP
// traffic stay in these disposable, loopback-only apps; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-settings-demo-"));
const devApp = mkdtempSync(join(tmpdir(), "herdr-settings-dev-"));

/**
 * Loaded after the demo's transport in the development app: the voice status the Voice input page
 * asks for is held until the page releases it, and the observers made on the OpenAI key's group are
 * counted, live and made.
 */
const HOLD_VOICE = `(() => {
  const fetch = window.fetch, held = [];
  let holding = true, asked = 0, made = 0;
  window.voiceAsked = () => asked;
  window.releaseVoice = () => { holding = false; for (const go of held.splice(0)) go(); };
  window.fetch = (input, init) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
    if (!holding || path !== "/api/voice") return fetch(input, init);
    asked += 1;
    return new Promise((resolve) => held.push(() => resolve(fetch(input, init))));
  };
  const Native = window.ResizeObserver, live = new Set();
  window.groupObservers = () => ({ made, live: live.size });
  window.ResizeObserver = class extends Native {
    observe(node, options) { if (node.dataset && node.dataset.section === "openai-key") { made += 1; live.add(this); } return super.observe(node, options); }
    disconnect() { live.delete(this); return super.disconnect(); }
  };
})();
`;
interface HeldVoice { voiceAsked: () => number; releaseVoice: () => void; groupObservers: () => { made: number; live: number } }

/**
 * The OpenAI key's group, whose form waits for the server's answer, on React's development build:
 * StrictMode runs the landing's effect, its cleanup and the effect again, and the group is still
 * followed into view when the held answer comes. A reader who scrolled before it came stays where
 * they scrolled.
 */
async function heldGroupLanding(browser: import("playwright-core").Browser, url: string): Promise<void> {
  // short enough that the OpenAI key's group starts below the fold, so a landing has to scroll to it
  const context = await browser.newContext({ viewport: { width: 390, height: 480 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const body = page.locator(".settings-body:not([hidden])");
    const observers = () => page.evaluate(() => (window as unknown as HeldVoice).groupObservers());
    const land = async (): Promise<void> => {
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      const asked = await page.evaluate(() => (window as unknown as HeldVoice).voiceAsked());
      await openPalette(page, "OpenAI API key");
      await page.locator(".palette-section[data-section='settings-pages'] [role='option']").first().click();
      await page.waitForFunction((asked) => (document.activeElement as HTMLElement | null)?.dataset.section === "openai-key" && (window as unknown as HeldVoice).voiceAsked() > asked, asked);
      assert.equal(await page.locator(".voice-key").count(), 0, "the key's form waits for the held answer");
    };
    await land();
    const replayed = await observers();
    assert.equal(replayed.live, 1, `one observer still follows the group after StrictMode's cleanup of the landing (${JSON.stringify(replayed)})`);
    assert.ok(replayed.made >= 2, `the follow was set up again after the replay's cleanup (${replayed.made} observers made)`);
    await page.evaluate(() => (window as unknown as HeldVoice).releaseVoice());
    await page.locator(".voice-key input").waitFor();
    await page.waitForFunction(() => {
      const body = document.querySelector(".settings-body:not([hidden])")?.getBoundingClientRect();
      const control = document.querySelector("[data-section='openai-key'] input")?.getBoundingClientRect();
      return body !== undefined && control !== undefined && control.top >= body.top - 1 && control.bottom <= body.bottom + 1;
    });

    await land();
    assert.ok(await body.evaluate((node) => node.scrollTop) > 0, "the landing scrolled to the group");
    // the reader goes back to the page's top with the hardware keyboard before the answer comes
    await page.keyboard.press("Home");
    await page.waitForFunction(() => document.querySelector(".settings-body:not([hidden])")?.scrollTop === 0);
    await page.evaluate(() => (window as unknown as HeldVoice).releaseVoice());
    await page.locator(".voice-key input").waitFor();
    // the frames after the form arrives, when an observer still following would have scrolled to it
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
    assert.equal(await body.evaluate((node) => node.scrollTop), 0, "a reader who scrolled away is not pulled back");
    assert.equal((await observers()).live, 0, "the reader's scroll ended the follow");
    assert.deepEqual(errors, []);
    console.log("PASS under development StrictMode the OpenAI key's group is followed into view when its held form arrives, and a reader's scroll ends it");
  } finally {
    await context.close();
  }
}

/**
 * At 1440: a press on the page already open leaves nothing that takes Back from the key bar editor
 * away from Edit key bar; a search result whose group the server fills in (Also send to) is landed on
 * once the group comes; the OpenAI key's field drawn again empty by a search keeps Save waiting for a
 * key; and Check again keeps the focus its press gave it while it reads and after.
 */
async function focusAndLandings(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await openSettings(page);
    const dialog = dialogOf(page);
    const focusedOn = (selector: string) => page.evaluate((selector) => document.activeElement?.matches(selector) ?? false, selector);

    await openSettingsPage(page, "Terminal");
    await dialog.getByRole("tab", { name: "Terminal", exact: true }).click();
    await dialog.getByRole("button", { name: "Edit key bar", exact: true }).click();
    await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
    await page.locator(".settings-dialog").getByRole("button", { name: "Back to settings", exact: true }).click();
    await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Edit key bar", "after a press on the open page's tab, Back from the key bar editor returns to Edit key bar");

    const search = dialog.getByRole("searchbox", { name: "Search settings", exact: true });
    const results = dialog.getByRole("region", { name: "Search results", exact: true });
    await search.fill("webhook");
    await results.locator("[data-section='alert-webhook']").waitFor();
    await results.getByRole("button", { name: "Open Alerts", exact: true }).click();
    await dialog.getByRole("tabpanel", { name: "Alerts", exact: true }).waitFor();
    await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.section === "alert-webhook", undefined, { timeout: 10_000 });

    await search.fill("openai api key");
    const key = results.locator('input[aria-label="OpenAI API key"]');
    const save = results.getByRole("button", { name: "Save key", exact: true });
    await key.fill("sk-fixture");
    assert.equal(await save.isEnabled(), true, "a typed key can be saved");
    await search.fill("zzqxv nothing");
    await dialog.getByRole("status").filter({ hasText: "No settings match." }).waitFor();
    await search.fill("openai api key");
    await key.waitFor();
    assert.equal(await key.inputValue(), "", "the key's field comes back empty");
    assert.equal(await save.isDisabled(), true, "Save waits for a key typed again");

    await search.fill("");
    await openSettingsPage(page, "Agents");
    await page.evaluate(() => {
      const passing = window.fetch, held: (() => void)[] = [];
      (window as unknown as { releaseCatalog: () => void }).releaseCatalog = () => { window.fetch = passing; for (const go of held.splice(0)) go(); };
      window.fetch = (input, init) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname === "/api/agent-catalog"
        ? new Promise<Response>((resolve) => held.push(() => resolve(passing(input, init))))
        : passing(input, init);
    });
    await dialog.getByRole("button", { name: "Check again", exact: true }).focus();
    await page.keyboard.press("Enter");
    await dialog.getByRole("button", { name: "Checking…", exact: true }).waitFor();
    assert.equal(await focusedOn(".agents-check-again"), true, "a pressed Check again keeps the focus while it reads");
    await page.evaluate(() => (window as unknown as { releaseCatalog: () => void }).releaseCatalog());
    await dialog.getByRole("button", { name: "Check again", exact: true }).waitFor();
    assert.equal(await focusedOn(".agents-check-again"), true, "and once the read lands");
    assert.deepEqual(errors, []);
    console.log("PASS at 1440 a no-op tab press, a group the server fills in, a key field drawn again and Check again keep the focus and Save where they belong");
  } finally {
    await context.close();
  }
}

/**
 * Settings' own search, at 1440 and 390: the settings of every page that hold all the words typed,
 * each under its page's name and changed right there; a group named by the words shows its settings;
 * a page's name opens it; no match says so; and Escape empties the search before it closes Settings.
 */
async function dialogSearch(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: "en" } : { viewport: { width, height: 900 }, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettings(page);
      const dialog = dialogOf(page);
      const search = dialog.getByRole("searchbox", { name: "Search settings", exact: true });
      const results = dialog.getByRole("region", { name: "Search results", exact: true });
      // the pages drawn with what each shows: its name and the labels of the settings in sight
      const shown = () => results.evaluate((region) => [...region.querySelectorAll<HTMLElement>(".settings-search-page")].filter((section) => section.checkVisibility())
        .map((section) => [section.getAttribute("aria-label"), [...section.querySelectorAll<HTMLElement>("[data-setting]")].filter((row) => row.checkVisibility()).map((row) => row.querySelector(".settings-label")?.textContent ?? "")] as const));

      await search.fill("Font SIZE");
      const found = await shown();
      // every font row is on Appearance: the terminal's and the chat's are found by their sizes' words
      assert.deepEqual(found.map(([name]) => name), ["Appearance"], `${width}px: "font size" finds settings on Appearance only`);
      for (const [name, label] of [["Appearance", "Interface font size"], ["Appearance", "Chat font"], ["Appearance", "Terminal font"]] as const) {
        assert.ok(found.find(([page]) => page === name)?.[1].includes(label), `${width}px: ${label} is found under ${name}`);
      }
      assert.equal(await dialog.getByRole("tablist").isVisible(), width !== 390, `${width}px: a phone's results take the list's place`);

      // a setting found is changed where it is shown
      await results.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 14);
      const typedSize = results.getByRole("group", { name: "Terminal font size", exact: true }).getByRole("textbox", { name: "Terminal font size", exact: true });
      assert.equal(await typedSize.inputValue(), "14");
      // the -/+ buttons still have the new size read out
      assert.equal(await results.getByRole("group", { name: "Terminal font size", exact: true }).locator('[aria-live="polite"]').textContent(), "14px", `${width}px: a stepped size is announced`);
      // a finger's field is read at --fs-input or larger, so iOS does not zoom into it
      if (width === 390) assert.ok(await typedSize.evaluate((input) => {
        const probe = document.createElement("span");
        probe.style.fontSize = "var(--fs-input)";
        document.body.append(probe);
        const least = Number.parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return Number.parseFloat(getComputedStyle(input).fontSize) >= least;
      }), `${width}px: the typed size is read at --fs-input or larger`);
      // the number is typed in its place too: one out of range is refused and the field goes back (G-179)
      await typedSize.fill("30");
      await typedSize.press("Enter");
      assert.equal(await typedSize.inputValue(), "14", `${width}px: a size out of range is refused`);
      // the refusal names the range under the field until the next edit, and the field is described by it all along
      const rangeLine = results.locator(`[id="${await typedSize.getAttribute("aria-describedby")}"]`);
      assert.equal(await rangeLine.textContent(), "Enter 10–22px", `${width}px: the field is described by its range`);
      assert.equal(await rangeLine.isVisible(), true, `${width}px: a refused size shows the range`);
      // a pasted number is read whole: 200 is refused, never cut to 20
      await typedSize.focus();
      await typedSize.selectText();
      await page.keyboard.insertText("200");
      assert.equal(await typedSize.inputValue(), "200", `${width}px: a pasted number is kept whole`);
      assert.equal(await rangeLine.evaluate((node) => node.classList.contains("visually-hidden")), true, `${width}px: the next edit hides the range line`);
      await typedSize.press("Enter");
      assert.equal(await typedSize.inputValue(), "14", `${width}px: a pasted size out of range is refused`);
      assert.equal(await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize)))), 14, `${width}px: a refused paste saves nothing`);
      await typedSize.fill("16");
      await typedSize.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 16);
      // an IME's full-width digits are the number too, and the field shows it in plain digits once it is taken (#3487)
      await typedSize.fill("１８");
      assert.equal(await typedSize.inputValue(), "１８", `${width}px: the typed full-width digits stay as typed until they are taken`);
      await typedSize.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 18);
      assert.equal(await typedSize.inputValue(), "18", `${width}px: a full-width size is shown in plain digits`);
      await typedSize.fill("14");
      await typedSize.press("Enter");
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").terminalFontSize === 14);

      // a group named by the words shows each of its settings, and one with a form but no setting row shows the form
      await search.fill("quick replies");
      assert.deepEqual(await shown(), [["Chat", ["Show above the message box"]]], `${width}px: the Quick replies group's setting is found by the group's name`);
      await search.fill("openai api key");
      await results.locator('input[aria-label="OpenAI API key"]').waitFor();

      // Escape empties a search from a result too, not only from the field
      await search.fill("sound");
      await results.getByRole("switch", { name: "Play sounds", exact: true }).focus();
      await page.keyboard.press("Escape");
      assert.equal(await search.inputValue(), "", `${width}px: Escape on a result empties the search`);
      assert.equal(await search.evaluate((field) => field === document.activeElement), true, `${width}px: the field takes the focus back`);

      // a row a found row opens is found with it: Custom from a description match shows its field
      await search.fill("menus dialogs");
      await results.getByRole("combobox", { name: "Interface font", exact: true }).selectOption("custom");
      await results.getByRole("textbox", { name: "Custom interface font", exact: true }).waitFor();
      await results.getByRole("combobox", { name: "Interface font", exact: true }).selectOption("default");
      assert.equal(await page.locator(".settings-dialog").count(), 1, `${width}px: and keeps Settings open`);

      // the key bar editor opened from a search sits over the Terminal page: Back steps out to it, not out of Settings
      if (width === 390) {
        await search.fill("key bar");
        await results.getByRole("button", { name: "Edit key bar", exact: true }).click();
        await page.getByRole("dialog", { name: "Key bar", exact: true }).waitFor();
        await historyHolds(page, "the key bar opened from a search", () => (history.state as { "ovis:settings"?: { page: string | null; keyBar: boolean } } | null)?.["ovis:settings"]?.keyBar === true);
        await page.goBack();
        await dialog.getByRole("tabpanel", { name: "Terminal", exact: true }).waitFor();
        await page.goBack();
        await dialog.getByRole("tablist").waitFor();
        assert.equal(await page.locator(".settings-dialog").count(), 1, "390px: Back from the key bar opened by a search leaves Settings open");
      }

      await search.fill("zzqxv nothing");
      await dialog.getByRole("status").filter({ hasText: "No settings match." }).waitFor();
      assert.deepEqual(await shown(), [], `${width}px: no page is drawn when nothing matches`);

      // the first Escape empties the search and keeps Settings; the next one closes it
      await search.press("Escape");
      assert.equal(await search.inputValue(), "");
      assert.equal(await results.count(), 0);
      assert.equal(await dialog.getByRole("tablist").isVisible(), true, `${width}px: the list of pages is back`);
      assert.equal(await page.locator(".settings-dialog").count(), 1, `${width}px: Escape on a search does not close Settings`);

      // a page's name opens the page and ends the search
      await search.fill("sound");
      await results.getByRole("button", { name: "Open Alerts", exact: true }).click();
      await dialog.getByRole("tabpanel", { name: "Alerts", exact: true }).waitFor();
      assert.equal(await search.count() === 0 || await search.inputValue() === "", true, `${width}px: opening a page ends the search`);
      if (width === 1440) {
        await search.press("Escape");
        await page.locator(".settings-dialog").waitFor({ state: "detached" });
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS Settings' search at 1440 and 390px: settings of every page found and changed in place, groups by name, pages opened, nothing matching said, Escape empties first");
}

/**
 * The folded part of a page (SettingsFold), at 1440 and 390: closed on opening, with the count of what this
 * device changed in it on its line; a link to a group inside opens it on that group; a search finds its rows.
 */
async function foldedGroups(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext(width === 390 ? { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, locale: "en" } : { viewport: { width, height: 900 }, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, sidebarPeek: true }));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettings(page);
      const dialog = dialogOf(page);
      await dialog.getByRole("tab", { name: "Appearance", exact: true }).click();
      const panel = dialog.getByRole("tabpanel", { name: "Appearance", exact: true });
      const more = panel.locator("details.settings-fold[data-fold='more']");
      assert.equal(await more.evaluate((fold) => (fold as HTMLDetailsElement).open), false, `${width}px: More settings starts folded`);
      assert.equal(await panel.getByRole("switch", { name: "Show the sidebar on hover", exact: true }).isVisible(), false, `${width}px: its rows are out of the first view`);
      assert.equal(await more.locator(".settings-fold-changed").textContent(), "1 changed", `${width}px: the line counts what this device changed inside`);
      await more.locator("> summary").click();
      await panel.getByRole("switch", { name: "Show the sidebar on hover", exact: true }).waitFor();

      // a search finds a folded row with the rest
      await closeSettings(page);
      await openSettings(page);
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("sidebar on hover");
      await dialog.getByRole("region", { name: "Search results", exact: true }).getByRole("switch", { name: "Show the sidebar on hover", exact: true }).waitFor();
      // an agent's own setting is found with its agent's row shut, in a group named after it
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("sandbox");
      await dialog.getByRole("region", { name: "Search results", exact: true }).getByLabel("Sandbox and approvals", { exact: true }).waitFor();
      // Model and Effort are alike for every agent: each found group says whose it is
      await dialog.getByRole("searchbox", { name: "Search settings", exact: true }).fill("effort");
      const found = dialog.getByRole("region", { name: "Search results", exact: true });
      await found.locator("[data-section='agent-codex']").waitFor();
      assert.deepEqual(await found.locator("[data-section='agent-claude'] > h3, [data-section='agent-codex'] > h3").allTextContents(), ["Claude Code", "Codex"], `${width}px: a found agent's rows sit under its name`);
      await closeSettings(page);

      // an old link to the Chat page's folded Chat group lands on Conversation, where its row went
      await page.goto(`${url}?settings=chat&section=chat-more`);
      await page.getByRole("switch", { name: "Collapse work", exact: true }).waitFor();
      assert.equal(await page.locator(".settings-body:not([hidden]) [data-section='conversation']").evaluate((group) => document.activeElement === group), true, `${width}px: chat-more lands on Conversation`);
      await closeSettings(page);

      // a link to a group inside a fold opens it on that group
      await page.goto(`${url}?settings=chat&section=composer-more`);
      const queued = page.getByRole("switch", { name: "Send queued messages automatically", exact: true });
      await queued.waitFor();
      assert.equal(await page.locator(".settings-body:not([hidden]) [data-section='composer-more']").evaluate((group) => group.closest("details")?.open === true && document.activeElement === group), true, `${width}px: the link opened the fold and focused its group`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS folded groups at 1440 and 390px: closed on opening with a count of what changed, opened by a click, a link to a group inside and a search");
}

/**
 * The three merged rows keep both settings each stands for: Agents order's By state groups this device's list
 * (and shows Within a state), Show thinking's Expanded opens reasoning, and Tidy dictated text's Terminal tidies
 * the terminal alone; each choice is kept through a reload.
 */
/**
 * Signed in on a PC's own page, Settings > Devices and PCs lists the account's PCs in My devices, one
 * row each with a hairline under it and a PC pill, after this PC; the Account group lists none of its own. The sign-in is a fixture in this page's IndexedDB and the account service a route
 * of this context: nothing reaches GitHub or account.ovis.sh.
 */
/**
 * About's first line names the runtime this PC serves with its version. With herdr's TUI and the
 * Herdr app's core both installed (`?demo_runtime=both`) it is a choice between them, and picking
 * the other asks before switching; with one installed it is a plain fact.
 */
async function runtimeInUse(browser: import("playwright-core").Browser, url: string): Promise<void> {
  for (const width of [390, 1280]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${url}?settings=about`);
      const panel = dialogOf(page).getByRole("tabpanel", { name: "About", exact: true });
      const row = panel.locator(".settings-row").filter({ hasText: "In use" });
      await row.getByText("herdr 0.9.0", { exact: true }).waitFor();
      assert.equal(await row.getByRole("group", { name: "In use" }).count(), 0, `${width}px: one runtime installed, no switch`);
      await page.goto(`${url}?demo_runtime=both&settings=about`);
      const choice = row.getByRole("group", { name: "In use" });
      await choice.getByRole("button", { name: "herdr-core 0.1.17", exact: true }).waitFor();
      assert.equal(await choice.getByRole("button", { name: "herdr 0.9.0", exact: true }).getAttribute("aria-pressed"), "true", `${width}px: the runtime served is the one pressed`);
      await choice.getByRole("button", { name: "herdr-core 0.1.17", exact: true }).click();
      const confirm = page.getByRole("alertdialog", { name: "Show the Herdr app's terminals?" });
      await confirm.waitFor();
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.equal(await choice.getByRole("button", { name: "herdr 0.9.0", exact: true }).getAttribute("aria-pressed"), "true", `${width}px: cancelled, nothing switched`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS About names the runtime in use, and offers the switch only with two installed, asking first");
}

/**
 * About after an update: its compact Updates line keeps the notes of what the update brought (the
 * header's "What's new" opens them), the section's name and the running version.
 */
async function installedNotes(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en" });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify(SETTINGS));
    // the demo's transport answers /api in the page: these two answers go in over it. The running
    // revision is the build's own, so the app reads no reload and the notes are this release's.
    await context.addInitScript((revision) => {
      const answers: Record<string, unknown> = {
        "/api/updates": { managed: true, auto_update: false, phase: "idle", current_revision: revision, latest_revision: null, current_version: null, latest_version: null, available: false, checked_at: "2099-01-01T00:00:00Z", blocked_reason: null, error: null },
        "/api/updates/installed": { revision, version: "99.0.0", previous_version: "98.0.0", installed_at: "2099-01-01T00:00:00Z", omitted: 0, releases: [{ version: "99.0.0", date: "2099-01-01", notes: "- A fixture release note." }] },
      };
      let inner = window.fetch;
      const outer: typeof window.fetch = (input, init) => {
        // the demo app is served under a path of its own: its requests end in the API's path
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href).pathname;
        const answer = Object.keys(answers).find((key) => path.endsWith(key));
        return answer !== undefined ? Promise.resolve(new Response(JSON.stringify(answers[answer]), { headers: { "content-type": "application/json" } })) : inner(input, init);
      };
      // the transport's own assignment goes under these answers; a later wrapper (the file preview's)
      // reads them as its fetch and replaces the property as a plain value
      Object.defineProperty(window, "fetch", { configurable: true, get: () => outer, set: (next: typeof window.fetch) => {
        inner = next;
        Object.defineProperty(window, "fetch", { configurable: true, writable: true, value: outer });
      } });
    }, execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?settings=about`);
    const panel = dialogOf(page).getByRole("tabpanel", { name: "About", exact: true });
    await panel.getByRole("region", { name: "What the last update brought", exact: true }).getByText("A fixture release note.").waitFor();
    assert.equal(await panel.getByRole("heading", { name: "Updates", exact: true }).count(), 1, "the Updates section keeps its name");
    await panel.getByText(/^Running v/).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS About's compact Updates line keeps what the last update brought, its name and the running version");
}

/**
 * Alerts' one line of chips: Any turn finished lights Long turn finished too, and the row's ↺ puts
 * back all five, the two kept in the alert filters' own store included.
 */
async function alertChipsReset(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en" });
  try {
    await context.addInitScript((settings) => {
      localStorage.setItem("ovis:settings", settings);
      localStorage.setItem("ovis:alert-filters", JSON.stringify({ permission: false, error: true, pcsOff: [] }));
    }, JSON.stringify({ ...SETTINGS, alertDone: "always" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${url}?settings=alerts`);
    const chips = dialogOf(page).getByRole("group", { name: "Alert me when", exact: true });
    const pressed = async () => Object.fromEntries(await Promise.all(["Needs input", "Needs permission", "Long turn finished", "Any turn finished", "Stopped on an error"]
      .map(async (name) => [name, await chips.getByRole("button", { name, exact: true }).getAttribute("aria-pressed")])));
    await chips.waitFor();
    assert.deepEqual(await pressed(), { "Needs input": "true", "Needs permission": "false", "Long turn finished": "true", "Any turn finished": "true", "Stopped on an error": "true" }, "every turn lights the long turns too");
    await dialogOf(page).getByRole("button", { name: "Restore defaults: Alert me when", exact: true }).click();
    await dialogOf(page).getByRole("button", { name: "Restore defaults: Alert me when", exact: true }).waitFor({ state: "detached" });
    assert.deepEqual(await pressed(), { "Needs input": "true", "Needs permission": "true", "Long turn finished": "true", "Any turn finished": "false", "Stopped on an error": "false" }, "↺ puts back all five");
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS Alerts' chips: every turn lights the long turns, and ↺ restores all five");
}

async function accountPcList(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const service = "https://account.ovis.sh";
  for (const [width, theme] of [[390, "light"], [390, "dark"], [1280, "light"], [1280, "dark"]] as const) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
    /** the PCs this context took out of the account's directory */
    const removed: string[] = [];
    try {
      await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, theme }));
      // the PC's server names the account service its page signs in with (server/static.ts)
      await context.route((address) => address.href.startsWith(url) && (address.pathname.endsWith("/") || address.pathname.endsWith("/index.html")), async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="ovis-pc-account-service" content="${service}" />\n</head>`) });
      });
      await context.route(`${service}/**`, (route) => {
        const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
        if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
        const path = new URL(route.request().url()).pathname;
        // the directory's own removal: the PC is gone from the next read
        if (route.request().method() === "DELETE" && path.startsWith("/v1/pcs/")) {
          removed.push(path.slice("/v1/pcs/".length));
          return route.fulfill({ status: 204, headers: cors });
        }
        if (path !== "/v1/pcs") return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
        return route.fulfill({ headers: cors, json: { pcs: [
          // heard from just now: in use
          { server_id: "a".repeat(32), label: "home-server", added_at: "2026-11-01T00:00:00Z", last_seen_at: new Date().toISOString() },
          // not heard from for longer than two days
          { server_id: "b".repeat(32), label: "office-mac", added_at: "2026-10-01T00:00:00Z", last_seen_at: new Date(Date.now() - 9 * 24 * 3_600_000).toISOString() },
        ].filter((pc) => !removed.includes(pc.server_id)) } });
      });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.evaluate((service) => new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("ovis-account", 1);
        request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const tx = request.result.transaction("account", "readwrite");
          tx.objectStore("account").put({ service, account: "fixture", provider: "github", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
          tx.oncomplete = () => { request.result.close(); resolve(); };
          tx.onabort = () => reject(tx.error);
        };
      }), service);
      await openSettings(page);
      await openSettingsPage(page, "Devices and PCs");
      const list = page.locator("[data-section='devices'] .my-pcs");
      const accountRows = list.locator(".devices-row").filter({ hasText: /home-server|office-mac/ });
      await accountRows.nth(1).waitFor();
      assert.deepEqual(await accountRows.locator(".devices-kind").allTextContents(), ["PC", "PC"], `each account PC is marked PC (${width}px, ${theme})`);
      const style = await list.evaluate((node) => {
        const row = node.querySelector(".devices-row:not([data-testid='this-pc'])")!;
        return { listStyle: getComputedStyle(node).listStyleType, display: getComputedStyle(row).display, border: getComputedStyle(row).borderBottomStyle };
      });
      assert.deepEqual(style, { listStyle: "none", display: "flex", border: "solid" }, `the account's PCs are styled rows in My devices (${width}px, ${theme})`);
      assert.equal(await page.locator("[data-section='account'] .relay-shell-pcs").count(), 0, "the Account group does not list the PCs a second time");
      // no row claims to open its PC: this page cannot tell whether the browser is paired with it at app.ovis.sh.
      // One link under the rows goes to the hosted app's front page, which is right for every browser.
      assert.equal(await list.getByRole("link", { name: "Open in browser" }).count(), 0, `no account PC row has an Open of its own (${width}px, ${theme})`);
      const open = list.locator(".account-pcs-open");
      assert.deepEqual(await open.getByRole("link").evaluateAll((links) => links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("target")])),
        [["Open app.ovis.sh", "https://app.ovis.sh/", "_blank"]], `one link under the account's PCs goes to the hosted app (${width}px, ${theme})`);
      assert.equal(await open.locator(".settings-description").textContent(), "To open a PC of your account in a browser, sign in to this account at app.ovis.sh.");
      // Remove only on the PC the account has not heard from for two days: one in use would be listed again
      assert.deepEqual(await accountRows.getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label"))), ["Remove office-mac from the list"], `only the PC not heard from is offered for removal (${width}px, ${theme})`);
      const fit = await list.locator(".devices-row").filter({ hasText: /home-server|office-mac|app\.ovis\.sh/ }).evaluateAll((rows) => rows.map((row) => {
        const box = row.getBoundingClientRect();
        const inside = [...row.querySelectorAll(".devices-name, .devices-actions > *, .settings-description, .btn")].every((part) => {
          const one = part.getBoundingClientRect();
          return one.width > 0 && one.left >= box.left - 0.5 && one.right <= box.right + 0.5;
        });
        return { inside, overflow: row.scrollWidth - row.clientWidth, inView: box.right <= document.documentElement.clientWidth + 0.5 };
      }));
      assert.deepEqual(fit, Array.from({ length: 3 }, () => ({ inside: true, overflow: 0, inView: true })), `the account's PC rows and the line under them fit the list (${width}px, ${theme})`);
      const accountTop = (await page.locator("[data-section='account']").boundingBox())!.y;
      assert.ok(accountTop < (await page.locator("[data-section='devices']").boundingBox())!.y, `the Account group sits above the device list (${width}px, ${theme})`);
      if (process.env.UI_EVIDENCE_DIR) {
        await list.scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `account-pcs-${width}-${theme}.png`), animations: "disabled" });
      }
      // the removal asks first, saying what it does not do; a no removes nothing
      await accountRows.getByRole("button", { name: "Remove office-mac from the list", exact: true }).click();
      const confirm = page.getByRole("alertdialog", { name: "Remove office-mac from the list?" });
      await confirm.getByText("It revokes nothing: devices paired with office-mac keep their access", { exact: false }).waitFor();
      await confirm.getByText("If office-mac is used again, it comes back on the list when a device of your account opens it.", { exact: false }).waitFor();
      if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `account-pc-remove-${width}-${theme}.png`), animations: "disabled" });
      await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.deepEqual(removed, [], `a cancelled removal removes nothing (${width}px, ${theme})`);
      // a yes takes it out of the directory, the list is read again without it, and the focus stays in the list's group
      await accountRows.getByRole("button", { name: "Remove office-mac from the list", exact: true }).click();
      await confirm.getByRole("button", { name: "Remove from list", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      await list.locator(".devices-row").filter({ hasText: "office-mac" }).waitFor({ state: "detached" });
      await list.locator(".devices-row").filter({ hasText: "home-server" }).waitFor();
      assert.deepEqual(removed, ["b".repeat(32)], `the removal is the directory's, once (${width}px, ${theme})`);
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-section")), "devices", `the focus goes to the list's group once the removed row is gone (${width}px, ${theme})`);
      assert.equal(await list.getByRole("button", { name: /from the list$/ }).count(), 0, `the PC in use has no Remove (${width}px, ${theme})`);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
  console.log("PASS the account's PCs are styled rows of My devices at 390 and 1280px, light and dark: one link to the hosted app, Remove only on a PC not heard from, behind a confirm");
}

/**
 * Continue with Google on a PC's own page: the button shows under GitHub's only while the account
 * service lists Google for a PC's page (`GET /v1/providers`), and once signed in the Account group
 * lists the account's ways to sign in, with Remove on every one but the one this page signed in
 * with. The account service is a route of this context: nothing reaches Google, GitHub or account.ovis.sh.
 */
async function accountGoogle(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const service = "https://account.ovis.sh";
  for (const width of [390, 1280] as const) {
    for (const offered of [["github", "google"], ["github"]] as const) {
      for (const signedIn of [false, true]) {
        if (signedIn && offered.length === 1) continue;
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
        try {
          await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ ...SETTINGS, theme: "light" }));
          await context.route((address) => address.href.startsWith(url) && (address.pathname.endsWith("/") || address.pathname.endsWith("/index.html")), async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="ovis-pc-account-service" content="${service}" />\n</head>`) });
          });
          await context.route(`${service}/**`, (route) => {
            const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
            if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
            switch (new URL(route.request().url()).pathname) {
              case "/v1/providers": return route.fulfill({ headers: cors, json: { providers: offered, device: offered } });
              case "/v1/pcs": return route.fulfill({ headers: cors, json: { pcs: [] } });
              case "/v1/identities": return route.fulfill({ headers: cors, json: { identities: [
                { provider: "github", added_at: "2026-11-01T00:00:00Z" },
                { provider: "google", added_at: "2026-11-06T00:00:00Z" },
              ] } });
              default: return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
            }
          });
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          if (signedIn) {
            await page.evaluate((service) => new Promise<void>((resolve, reject) => {
              const request = indexedDB.open("ovis-account", 1);
              request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const tx = request.result.transaction("account", "readwrite");
                tx.objectStore("account").put({ service, account: "fixture", provider: "google", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
                tx.oncomplete = () => { request.result.close(); resolve(); };
                tx.onabort = () => reject(tx.error);
              };
            }), service);
          }
          await openSettings(page);
          await openSettingsPage(page, "Devices and PCs");
          // the account is at the top of the page, outside More settings
          const account = page.locator("[data-section='account']");
          assert.equal(await account.evaluate((group) => group.closest("details") === null), true, "the Account group is not folded away");
          await openSettingsFolds(page);
          const shot = async (name: string) => {
            if (!process.env.UI_EVIDENCE_DIR) return;
            await account.scrollIntoViewIfNeeded();
            await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${name}-${width}.png`), animations: "disabled" });
          };
          if (!signedIn) {
            const buttons = account.locator(".account-provider");
            if (offered.length === 2) {
              await buttons.nth(1).waitFor();
              assert.deepEqual(await buttons.allTextContents(), ["Continue with GitHub", "Continue with Google"], `Google sits under GitHub (${width}px)`);
              assert.equal(await account.locator("[data-provider='google'] svg path").count(), 4, "Google's G keeps its four colours");
              await shot("account-google-signin");
            } else {
              // once the service's answer is on screen, GitHub stays alone
              await account.locator("[data-offer='service'] .account-provider").first().waitFor();
              assert.deepEqual(await buttons.allTextContents(), ["Continue with GitHub"], `no Google button while the service offers none (${width}px)`);
            }
          } else {
            const methods = account.locator(".account-method");
            await methods.nth(1).waitFor();
            assert.equal(await account.getByText("Signed in with Google").count(), 1, "the account row names Google");
            assert.deepEqual(await methods.evaluateAll((rows) => rows.map((row) => [row.getAttribute("data-provider"), row.querySelector("button") !== null])), [["github", true], ["google", false]],
              "every way to sign in can be removed but the one this page signed in with");
            await shot("account-google-methods");
          }
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log("PASS Continue with Google shows under GitHub only while the service offers it, and the account lists its ways to sign in, at 390 and 1280px");
}

/**
 * Sign-in on the first-run welcome (components/SetupGuide.tsx): Continue with each provider the account
 * service lists for this page (`GET /v1/providers`), none without an account service, Not now folds it
 * away and leaves the two choices, and a sign-in this page already holds is the one Settings shows.
 * The account service is a route of this context: nothing reaches GitHub, Google or account.ovis.sh.
 */
async function welcomeSignIn(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const service = "https://account.ovis.sh";
  const cases = [
    { offered: ["github", "google"], signedIn: false },
    { offered: ["github"], signedIn: false },
    { offered: ["google"], signedIn: false },
    { offered: null, signedIn: false },
    { offered: ["github", "google"], signedIn: true },
  ] as const;
  for (const width of [390, 1280] as const) {
    for (const { offered, signedIn } of cases) {
      const at = `(${width}px, ${offered === null ? "no account service" : offered.join("+")}${signedIn ? ", signed in" : ""})`;
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 }, isMobile: width === 390, hasTouch: width === 390, locale: "en" });
      try {
        await context.addInitScript((settings) => {
          localStorage.setItem("ovis:settings", settings);
          localStorage.setItem("ovis:setup-guide", JSON.stringify({ status: "open", state: { step: "welcome" } }));
        }, JSON.stringify({ ...SETTINGS, theme: "light" }));
        if (offered !== null) {
          await context.route((address) => address.href.startsWith(url) && (address.pathname.endsWith("/") || address.pathname.endsWith("/index.html")), async (route) => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()).replace("</head>", `<meta name="ovis-pc-account-service" content="${service}" />\n</head>`) });
          });
          await context.route(`${service}/**`, (route) => {
            const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, DELETE" };
            if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
            switch (new URL(route.request().url()).pathname) {
              case "/v1/providers": return route.fulfill({ headers: cors, json: { providers: offered, device: offered } });
              case "/v1/pcs": return route.fulfill({ headers: cors, json: { pcs: [] } });
              case "/v1/identities": return route.fulfill({ headers: cors, json: { identities: [{ provider: "google", added_at: "2026-11-06T00:00:00Z" }] } });
              // a device sign-in that stays pending: the code shows until someone approves it elsewhere
              case "/v1/signin/github/device": return route.fulfill({ headers: cors, json: { code_challenge_method: "S256", device_code: "fixture-device", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 } });
              case "/v1/token": return route.fulfill({ status: 400, headers: cors, json: { error: { code: "authorization_pending" } } });
              default: return route.fulfill({ status: 404, headers: cors, json: { error: { code: "not_found" } } });
            }
          });
        }
        if (signedIn) {
          await context.addInitScript((service) => {
            const request = indexedDB.open("ovis-account", 1);
            request.onupgradeneeded = () => { request.result.createObjectStore("account"); };
            request.onsuccess = () => {
              const tx = request.result.transaction("account", "readwrite");
              tx.objectStore("account").put({ service, account: "fixture", provider: "google", access_token: "fixture-access", refresh_token: "fixture-refresh", expires_at: Date.now() + 3_600_000 }, "session");
              tx.oncomplete = () => request.result.close();
            };
          }, service);
        }
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        const guide = page.getByRole("region", { name: "Setup guide", exact: true });
        await guide.getByRole("button", { name: /I've used Ovis before/ }).waitFor();
        const signIn = guide.locator(".setup-signin");
        const shot = async (name: string) => {
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${name}-${width}.png`), animations: "disabled" });
        };
        if (offered === null) {
          // whether this page has an account service is known on first render (its meta tag), with the welcome
          assert.equal(await signIn.count(), 0, `no sign-in without an account service ${at}`);
          assert.equal(await guide.locator(".account-provider").count(), 0, `no provider button without an account service ${at}`);
        } else if (!signedIn) {
          await signIn.locator("[data-offer='service'] .account-provider").first().waitFor();
          const expected = offered.map((provider) => provider === "github" ? "Continue with GitHub" : "Continue with Google");
          assert.deepEqual(await signIn.locator(".account-provider").allTextContents(), expected, `one button for each provider the service lists ${at}`);
          await shot(`welcome-signin-${offered.join("-")}`);
          if (offered.length === 1 && offered[0] === "github") {
            // a code on screen: only its Cancel ends it, Not now cannot fold it away unnoticed
            await signIn.getByRole("button", { name: "Continue with GitHub", exact: true }).click();
            await signIn.locator(".account-device-code").filter({ hasText: "ABCD-1234" }).waitFor();
            assert.equal(await signIn.getByRole("button", { name: "Not now", exact: true }).count(), 0, `no Not now while a device code waits ${at}`);
            await signIn.getByRole("button", { name: "Cancel", exact: true }).click();
            await signIn.locator("[data-offer='service'] .account-provider").first().waitFor();
          }
          // by keyboard: the box goes and the keyboard's place moves to the first choice, not the page
          await signIn.getByRole("button", { name: "Not now", exact: true }).focus();
          await page.keyboard.press("Enter");
          await signIn.waitFor({ state: "detached" });
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("setup-choice") ?? false), true, `Not now hands the keyboard to the first choice ${at}`);
          assert.equal(await guide.getByRole("button", { name: /I'm new to Ovis/ }).count(), 1, `Not now leaves the welcome's choices ${at}`);
          assert.equal(await guide.getByRole("button", { name: /I've used Ovis before/ }).count(), 1, `Not now leaves the welcome's choices ${at}`);
        } else {
          // the account's id is the service's own, never shown: the line names the way in, as Settings does
          await signIn.getByText("Signed in with Google", { exact: true }).waitFor();
          assert.equal(await signIn.getByRole("button", { name: "Not now", exact: true }).count(), 0, `no Not now once signed in ${at}`);
          assert.equal(await signIn.locator(".account-provider").count(), 0, `no provider buttons once signed in ${at}`);
          await shot("welcome-signin-signed-in");
          await guide.getByRole("button", { name: /I've used Ovis before/ }).click();
          await guide.waitFor({ state: "detached" });
          await openSettings(page);
          await openSettingsPage(page, "Devices and PCs");
          await openSettingsFolds(page);
          await page.locator("[data-section='account']").getByText("Signed in with Google", { exact: true }).waitFor();
        }
        assert.deepEqual(errors, [], `no page errors ${at}`);
      } finally {
        await context.close();
      }
    }
  }
  console.log("PASS the welcome offers Continue with each provider the account service lists, none without one, Not now keeps the choices, and its sign-in is the one Settings shows, at 390 and 1280px");
}

/**
 * Appearance's ↺ beside a changed row, and its theme cards by keyboard: ↺ shows only off the default,
 * puts back every key of its row (a font and its size; a theme and the palette it draws) and goes; the
 * arrows pick along the row as a radio group's do; the cards follow the Theme mode until a side is chosen.
 */
async function rowResets(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify(SETTINGS));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings")!) as Record<string, unknown>);
    const reset = (row: string) => page.getByRole("button", { name: `Restore defaults: ${row}`, exact: true });
    await page.goto(`${url}?settings=appearance`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".theme-cards").waitFor();
    // the cards follow the Theme mode while no side is chosen here
    const mode = page.getByRole("group", { name: "Theme", exact: true });
    await mode.getByRole("button", { name: "Light", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Light theme", exact: true }).waitFor();
    await mode.getByRole("button", { name: "Dark", exact: true }).click();
    await page.getByRole("radiogroup", { name: "Dark theme", exact: true }).waitFor();

    assert.equal(await reset("Terminal font").count(), 0, "no ↺ while the terminal font and size are the defaults");
    await page.getByRole("button", { name: "Increase terminal font size", exact: true }).click();
    await reset("Terminal font").waitFor();
    assert.equal((await saved())["terminalFontSize"], DEFAULT_SETTINGS.terminalFontSize + 1);
    await reset("Terminal font").focus();
    await page.keyboard.press("Enter");
    await reset("Terminal font").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.closest(".settings-row")?.querySelector(".settings-label")?.textContent), "Terminal font", "the row keeps the focus once its ↺ goes");
    const fonts = await saved();
    assert.deepEqual([fonts["terminalFontSize"], fonts["terminalFontFamily"] ?? DEFAULT_SETTINGS.terminalFontFamily], [DEFAULT_SETTINGS.terminalFontSize, DEFAULT_SETTINGS.terminalFontFamily], "↺ puts back the size and the font of its row");

    // a custom interface font put back: the field closes and the typed list is not saved again as it goes
    const uiFont = page.getByLabel("Interface font", { exact: true });
    await uiFont.selectOption("custom");
    const custom = page.getByRole("textbox", { name: "Custom interface font", exact: true });
    await custom.fill('"Noto Sans JP"');
    await custom.press("Enter");
    await reset("Interface font").click();
    await custom.waitFor({ state: "detached" });
    assert.equal(await uiFont.inputValue(), "default", "the select shows Default once the font is put back");
    // a reload closes Settings: open the page again from its address
    await page.goto(`${url}?settings=appearance`);
    await page.locator(".theme-cards").waitFor();
    assert.equal(await page.getByLabel("Interface font", { exact: true }).inputValue(), "default", "the font put back stays put back after a reload");

    const dark = themeSide(page, "dark");
    await dark.selectOption("dracula");
    await page.waitForFunction(() => document.documentElement.dataset.palette === "dracula");
    await reset("Dark theme").click();
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, DEFAULT_SETTINGS.darkTheme);
    assert.deepEqual([(await saved())["darkTheme"], (await saved())["palette"]], [DEFAULT_SETTINGS.darkTheme, DEFAULT_SETTINGS.darkTheme], "↺ puts back the dark theme and the palette it draws");
    assert.equal(await reset("Dark theme").count(), 0, "↺ goes once the theme is back");

    // the arrows pick along the row, Home goes to its first card
    const cards = page.getByRole("radiogroup", { name: "Dark theme", exact: true });
    const listed = await dark.listed();
    await cards.locator('[role="radio"][aria-checked="true"]').focus();
    await page.keyboard.press("ArrowRight");
    const next = listed[listed.indexOf(DEFAULT_SETTINGS.darkTheme) + 1]!;
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, next);
    assert.equal(await cards.locator('[role="radio"][aria-checked="true"]').getAttribute("data-theme-card"), next, "ArrowRight picks the next card");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["themeCard"]), next, "the picked card takes the focus");
    await page.keyboard.press("Home");
    await page.waitForFunction((id) => document.documentElement.dataset.palette === id, listed[0]!);

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS Appearance: ↺ shows only off the default and puts back its row's keys; theme cards pick by arrow and follow the Theme mode");
}

async function mergedRows(browser: import("playwright-core").Browser, url: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en" });
  try {
    await context.addInitScript((settings) => { if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings); }, JSON.stringify({ ...SETTINGS, voiceInput: "on", voiceEngine: "auto" }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const pick = async (pageName: string, group: string, option: string) => {
      await page.goto(`${url}?settings=${pageName}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettingsFolds(page);
      await page.getByRole("group", { name: group, exact: true }).getByRole("button", { name: option, exact: true }).click();
    };
    const pressed = async (pageName: string, group: string) => {
      await page.goto(`${url}?settings=${pageName}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await openSettingsFolds(page);
      return page.getByRole("group", { name: group, exact: true }).locator("button[aria-pressed='true']").textContent();
    };
    await pick("appearance", "Agents order", "By state");
    await page.getByRole("group", { name: "Within a state", exact: true }).waitFor();
    assert.equal(await pressed("appearance", "Agents order"), "By state");
    await pick("appearance", "Agents order", "Activity");
    assert.equal(await page.getByRole("group", { name: "Within a state", exact: true }).count(), 0, "Within a state goes with By state");
    assert.equal(await pressed("appearance", "Agents order"), "Activity");
    await pick("chat", "Show thinking", "Expanded");
    assert.equal(await pressed("chat", "Show thinking"), "Expanded");
    await pick("chat", "Show thinking", "Hidden");
    assert.equal(await pressed("chat", "Show thinking"), "Hidden");
    await pick("chat", "Tidy dictated text", "Terminal");
    assert.equal(await pressed("chat", "Tidy dictated text"), "Terminal");
    assert.deepEqual(await page.evaluate(() => { const saved = JSON.parse(localStorage.getItem("ovis:settings")!); return [saved.voicePolishChat, saved.voicePolishTerminal]; }), [false, true]);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
  console.log("PASS the merged rows (Agents order, Show thinking, Tidy dictated text) keep both settings each stands for, through a reload");
}

try {
  await buildDemoApp(app);
  await buildDevelopmentDemoApp(devApp);
  writeFileSync(join(devApp, "hold-voice.js"), HOLD_VOICE);
  for (const [dir, extra] of [[app, ""], [devApp, `<script src="./hold-voice.js"></script>`]] as const) {
    const index = join(dir, "index.html");
    writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${extra}${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  }
  const roots = { "/herdr-web-ui/demo/app/": app, "/herdr-web-ui/demo/dev/": devApp };
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
  const devUrl = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/dev/`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      await dialogSearch(browser, url);
      await foldedGroups(browser, url);
      await mergedRows(browser, url);
      await rowResets(browser, url);
      await accountPcList(browser, url);
      await accountGoogle(browser, url);
      await welcomeSignIn(browser, url);
      await runtimeInUse(browser, url);
      await alertChipsReset(browser, url);
      await installedNotes(browser, url);
      await focusAndLandings(browser, url);
      await heldGroupLanding(browser, devUrl);
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
  rmSync(devApp, { recursive: true, force: true });
  console.log("CLEANUP disposable demo apps removed");
}
