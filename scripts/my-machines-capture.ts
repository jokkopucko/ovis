/**
 * The "My machines" screens in a real browser, drawn from fixtures (scripts/my-machines-fixture.tsx),
 * for scripts/my-machines-screens-qa.ts, which passes one
 * list of scripts/my-machines-states.ts: every state of it at 390 and 1440 px, light and dark, in
 * English, and in Korean at 390 light and 1440 dark. Each capture is <state>-<width>-<theme>.png (Korean:
 * <state>-ko-<width>-<theme>.png) with the text the page drew beside it as .txt; a screen that
 * scrolls also gets its end as -end.png, with the same text. No herdr, no account service and no
 * network: a request that leaves the fixture's loopback server fails the capture.
 *
 * Checked on every capture: no page error, no sideways scroll, none of the words these screens may
 * not use, and every control's hit area (its box, or the area around it that answers for it) is 44 px
 * or more in both directions on a phone's width and 24 px elsewhere. At 1440 px Tab is walked through
 * each English light screen: every stop shows a focus ring inside the window with nothing over it, and
 * the order is saved as <state>-1440.focus.txt.
 *
 *   bun scripts/my-machines-screens-qa.ts                       # into evidence/my-machines
 *   RA16_CAPTURES=1 UI_EVIDENCE_DIR=<dir> bun scripts/my-machines-screens-qa.ts # en and ko at 390 and 1280, light only
 *   WIDTHS=320,768 ...          # other widths, English only: 320 is the narrowest a page must reflow to
 *   SPACING=1 ...               # with WCAG 1.4.12's text spacing applied: nothing it did not cut before may be cut
 *   PALETTE=codex ...           # another theme's light and dark
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { startFixtureServer } from "./my-machines-fixture-server.ts";
import type { FixtureServer } from "./my-machines-fixture-server.ts";
import { isPhone, openShot, settled } from "./my-machines-states.ts";
import type { MyMachinesState, Shot } from "./my-machines-states.ts";

const evidence = process.env["UI_EVIDENCE_DIR"] || join(import.meta.dir, "../evidence/my-machines");
const only = process.env["ONLY"] ? new RegExp(process.env["ONLY"]) : null;
const palette = process.env["PALETTE"] || "amber";
const otherWidths = process.env["WIDTHS"]?.split(",").map(Number).filter((width) => Number.isInteger(width) && width >= 240) ?? null;
const deliver = process.env["RA16_CAPTURES"] === "1";
const spacing = process.env["SPACING"] === "1";
/** The text spacing a page must take without losing content (WCAG 2.2, 1.4.12). */
const TEXT_SPACING = "* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }";
const FORBIDDEN = /controller|fleet|컨트롤러|플릿|함대/i;

const shotsOf = (states: readonly MyMachinesState[]): Shot[] => states.filter((state) => only === null || only.test(state.name)).flatMap((state): Shot[] => deliver
  ? [390, 1280].flatMap((width): Shot[] => (["en", "ko"] as const).map((language) => ({ state, width, theme: "light", language, palette })))
  : otherWidths !== null
  ? otherWidths.flatMap((width): Shot[] => [{ state, width, theme: "light", language: "en", palette }, { state, width, theme: "dark", language: "en", palette }])
  : [
    { state, width: 390, theme: "light", language: "en", palette }, { state, width: 390, theme: "dark", language: "en", palette },
    { state, width: 1440, theme: "light", language: "en", palette }, { state, width: 1440, theme: "dark", language: "en", palette },
    { state, width: 390, theme: "light", language: "ko", palette }, { state, width: 1440, theme: "dark", language: "ko", palette },
  ]);
const fileOf = ({ state, width, theme, language }: Shot): string => `${state.name}${language === "ko" ? "-ko" : ""}-${width}-${theme}`;

/** What the page says: the text it draws, then the names a screen reader or a tooltip gives. */
const drawnText = (page: Page): Promise<string> => page.evaluate(() => {
  const names = [...document.querySelectorAll("[aria-label], [title], [placeholder], [alt]")]
    .flatMap((element) => ["aria-label", "title", "placeholder", "alt"].map((name) => element.getAttribute(name) ?? "")).filter((text) => text !== "");
  return `${document.body.innerText}\n\n[names]\n${[...new Set(names)].join("\n")}\n`;
});

/** Controls in view whose hit area is under `min` px: the box, or what the page answers half of `min` off its middle. */
const smallTargets = (page: Page, min: number): Promise<string[]> => page.evaluate((least) => {
  const controls = [...document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [role="radio"]')]
    .filter((element) => !element.matches(":disabled") && element.closest("[inert]") === null && element.checkVisibility());
  const reach = least / 2 - 1;
  return controls.flatMap((element) => {
    // a radio or a checkbox answers for its whole label, as a press on the label sets it
    const target = element.matches('input[type="radio"], input[type="checkbox"]') ? element.closest("label") ?? element : element;
    const box = target.getBoundingClientRect();
    if (box.bottom <= 0 || box.top >= innerHeight) return [];
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const answers = (dx: number, dy: number): boolean => { const hit = document.elementFromPoint(x + dx, y + dy); return hit !== null && (target.contains(hit) || hit.contains(target)); };
    const wide = box.width >= least - 0.5 || (answers(-reach, 0) && answers(reach, 0));
    const tall = box.height >= least - 0.5 || (answers(0, -reach) && answers(0, reach));
    return wide && tall ? [] : [`${target.tagName.toLowerCase()}.${target.className} "${(target.getAttribute("aria-label") ?? target.textContent ?? "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`];
  });
}, min);

/**
 * Text that its own box cuts off (it hides overflow and holds more than it shows) and that was not cut
 * at the last call: text hidden from sight for a screen reader and a line cut on purpose stay as they were.
 */
const newlyCutText = (page: Page): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll<HTMLElement>("body *")]
  .filter((element) => element.checkVisibility() && element.closest("[inert]") === null && element.childElementCount === 0 && (element.textContent ?? "").trim() !== "")
  .flatMap((element) => {
    const style = getComputedStyle(element);
    const hides = (value: string): boolean => value === "hidden" || value === "clip";
    const cutAcross = hides(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
    const cutDown = hides(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    if (!cutAcross && !cutDown) return [];
    const known = element.dataset["qaCut"] !== undefined;
    element.dataset["qaCut"] = "";
    return known ? [] : [`${element.tagName.toLowerCase()}.${element.className} "${(element.textContent ?? "").trim().slice(0, 40)}"`];
  }));

/** Scrolls what scrolls here to its end (an open sheet's scroller, else the document); false when nothing scrolls. */
const scrollToEnd = (page: Page): Promise<boolean> => page.evaluate(() => {
  const sheet = [...document.querySelectorAll<HTMLElement>(".modal-scrim .modal-body")].find((scroller) => scroller.scrollHeight > scroller.clientHeight + 1);
  if (sheet) { sheet.scrollTop = sheet.scrollHeight; return true; }
  if (document.querySelector(".modal-scrim") !== null || document.documentElement.scrollHeight <= innerHeight + 1) return false;
  window.scrollTo(0, document.documentElement.scrollHeight);
  return true;
});

interface Stop { readonly name: string; readonly ring: boolean; readonly inView: boolean; readonly covered: boolean }
/** Tab from the top (or round a dialog's trap) until the focus leaves the page or comes back to its first stop. */
async function tabStops(page: Page): Promise<Stop[]> {
  // without a dialog the walk starts at the top of the page: Tab goes on from where a focused node was, also once it is gone
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    if (document.querySelector(".modal-scrim") !== null) return;
    const top = document.createElement("span");
    top.tabIndex = -1;
    document.body.prepend(top);
    top.focus();
    top.remove();
  });
  const stops: Stop[] = [];
  for (let press = 0; press < 120; press++) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement) || element === document.body) return null;
      const first = element.dataset["qaStop"] === undefined;
      element.dataset["qaStop"] = "";
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      // what shows the focus: the control, or the label a radio or checkbox is drawn as
      const shown = element.matches('input[type="radio"], input[type="checkbox"]') ? element.closest("label") ?? element : element;
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return {
        first, name: `${element.tagName.toLowerCase()} "${(element.getAttribute("aria-label") ?? (element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : null) ?? element.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60)}"`,
        ring: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0, inView: box.top >= -1 && box.bottom <= innerHeight + 1 && box.left >= -1 && box.right <= innerWidth + 1,
        // where it is when it is not in view, so a failure says by how much: a scroll lands on whole pixels and a
        // box's edge need not, so an edge less than a pixel past the window is in view
        box: `${box.top.toFixed(1)}..${box.bottom.toFixed(1)} of ${innerHeight}, scrolled ${scrollY.toFixed(1)}`,
        // its middle answers to something else when another layer is over it or its scroller has it out of sight
        covered: hit === null || !shown.contains(hit),
      };
    });
    if (at === null || !at.first) break;
    stops.push({ name: at.inView ? at.name : `${at.name} (${at.box})`, ring: at.ring, inView: at.inView, covered: at.covered });
  }
  return stops;
}

async function capture(browser: Browser, origin: string, shot: Shot): Promise<string[]> {
  const file = fileOf(shot);
  const phone = isPhone(shot);
  const { context, page, problems } = await openShot(browser, origin, shot);
  const least = phone ? 44 : 24;
  try {
    if (spacing) {
      await newlyCutText(page);
      await page.addStyleTag({ content: TEXT_SPACING });
      await settled(page);
      problems.push(...(await newlyCutText(page)).map((cut) => `text cut off by WCAG text spacing: ${cut}`));
    }
    const text = await drawnText(page);
    writeFileSync(join(evidence, `${file}.txt`), text);
    const word = FORBIDDEN.exec(text);
    if (word) problems.push(`the page says "${word[0]}"`);
    const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    if (size.scroll > size.client) problems.push(`sideways scroll: ${size.scroll} px of content in ${size.client} px`);
    problems.push(...(await smallTargets(page, least)).map((target) => `target under ${least} px: ${target}`));
    await page.screenshot({ path: join(evidence, `${file}.png`), scale: deliver ? "css" : "device" });

    if (await scrollToEnd(page)) {
      await settled(page);
      problems.push(...(await smallTargets(page, least)).map((target) => `target under ${least} px (end of the screen): ${target}`));
      await page.screenshot({ path: join(evidence, `${file}-end.png`), scale: deliver ? "css" : "device" });
      writeFileSync(join(evidence, `${file}-end.txt`), text);
    }

    if (shot.width === 1440 && shot.theme === "light" && shot.language === "en") {
      const stops = await tabStops(page);
      writeFileSync(join(evidence, `${shot.state.name}-1440.focus.txt`), `${stops.map((stop, index) => `${index + 1}. ${stop.name}${stop.ring ? "" : "  [NO RING]"}${stop.inView ? "" : "  [OUT OF VIEW]"}${stop.covered ? "  [COVERED]" : ""}`).join("\n")}\n`);
      if (stops.length === 0) problems.push("Tab reached no control");
      problems.push(...stops.filter((stop) => !stop.ring).map((stop) => `no focus ring on ${stop.name}`), ...stops.filter((stop) => !stop.inView).map((stop) => `focused out of view: ${stop.name}`),
        ...stops.filter((stop) => stop.covered).map((stop) => `focused under something else: ${stop.name}`));
    }
    return problems;
  } finally {
    await context.close();
  }
}

/** Captures and checks every shot of `states`, says how it went, and exits 1 on any problem. */
export async function runCaptures(states: readonly MyMachinesState[]): Promise<never> {
  const started = Date.now();
  const shots = shotsOf(states);
  if (shots.length === 0) throw new Error("no capture selected: check ONLY and WIDTHS");
  mkdirSync(evidence, { recursive: true });
  const failures: string[] = [];
  let browser: Browser | undefined;
  let server: FixtureServer | undefined;
  try {
    server = await startFixtureServer();
    const { origin } = server;
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    const launched = browser;
    const queue = [...shots];
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (let shot = queue.shift(); shot !== undefined; shot = queue.shift()) {
        const file = fileOf(shot);
        const problems = await capture(launched, origin, shot).catch((error: unknown) => [error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error)]);
        console.log(`${problems.length === 0 ? "PASS" : "FAIL"} ${file}${problems.length === 0 ? "" : `: ${problems.join("; ")}`}`);
        failures.push(...problems.map((problem) => `${file}: ${problem}`));
      }
    }));
  } finally {
    await browser?.close();
    await server?.stop();
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(failures.length === 0 ? `PASS ${shots.length} captures of the My machines screens in ${evidence}, ${seconds} s` : `FAIL ${failures.length} problems in ${seconds} s:\n  ${failures.join("\n  ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}
