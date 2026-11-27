/** Usage: bun scripts/sidebar-heads-demo-regression.ts [--only=<words in a check's name>] */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, errors, type Page } from "playwright-core";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { chromePath } from "./chrome-path.ts";
import { SUPPORTED_ENTRIES } from "../src/lib/themes.ts";

// the demo's one PC as two, each with the demo's own roster: only this disposable fixture rewrites it (as
// scripts/sidebar-spacing-demo-regression.ts does)
const TWO_PCS = String.raw`(() => {
  if (localStorage.getItem("heads-fixture:two-pcs") !== "1") return;
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let last = null;
  const roster = (original) => ["local", "work"].map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = id === "local" ? "Laptop" : "Work PC";
    machine.runtime = id === "local" ? "herdr" : "herdr-core";
    machine.state = id === "work" && localStorage.getItem("heads-fixture:work-offline") === "1" ? "disconnected" : "connected";
    return machine;
  });
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname.endsWith("/api/machines")) { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ ...value, machines: roster(last) }); }
    const match = url.pathname.match(/\/api\/machines\/([^/]+)(\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (match && path === "/api/session" && last) return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

interface Scene {
  width: number;
  mode: "light" | "dark";
  twoPcs?: boolean;
  workOffline?: boolean;
  grouped?: boolean;
  height?: number;
  forcedColors?: boolean;
  hybrid?: boolean;
  storage?: Record<string, string>;
}

/** Chromium's own pointer and hover media for a hybrid device, so its stylesheet answers as on one (Blink's
 *  pointer types: coarse 2, fine 4; hover types: none 1, hover 2). Playwright's hasTouch would make the primary
 *  pointer coarse instead. */
const HYBRID = "--blink-settings=primaryPointerType=4,availablePointerTypes=6,primaryHoverType=2,availableHoverTypes=3";

const evidence = process.env["UI_EVIDENCE_DIR"];
const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);

const heads = (page: Page) => page.evaluate(() => {
  const shown = (element: Element | null) => element !== null && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && Number(getComputedStyle(element).opacity) > 0.99;
  const number = (count: Element | null) => shown(count) ? (count!.querySelector('[aria-hidden="true"]') ?? count)!.textContent!.trim() : null;
  const pcs = document.querySelector(".pcs-sidebar")!, agents = document.querySelector(".agents-sidebar")!;
  return {
    pcsHead: pcs.querySelectorAll(":scope > :not(.machine-list)").length,
    agentsFolded: agents.classList.contains("is-collapsed"),
    agentsCaret: shown(agents.querySelector(".agent-section-toggle .agent-section-caret")),
    agentsCount: number(agents.querySelector(".agent-section-toggle .agent-section-count")),
    machines: document.querySelectorAll(".machine-list .machine-group:not([hidden])").length,
    agentRows: document.querySelectorAll(".agents-sidebar .agent-item").length,
  };
});

const pcHeader = (page: Page, pc: string) => page.evaluate((pc) => {
  const group = document.querySelector<HTMLElement>(`section.machine-group[aria-label="PC ${pc}"]`)!;
  const header = group.querySelector(".machine-header")!;
  const painted = (element: Element | null) => element !== null && element.getClientRects().length > 0 && Number(getComputedStyle(element).opacity) > 0.99;
  const box = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height } : null; };
  const count = header.querySelector(".machine-agent-count");
  return {
    count: painted(count) ? (count!.querySelector('[aria-hidden="true"]') ?? count)!.textContent!.trim() : null,
    countWords: count?.querySelector(".visually-hidden")?.textContent ?? null,
    countTitle: count?.getAttribute("title") ?? null,
    countBox: box(count),
    toggle: painted(header.querySelector(".machine-toggle")),
    add: painted(header.querySelector(".machine-new")),
    toggleBox: box(header.querySelector(".machine-toggle")),
    addBox: box(header.querySelector(".machine-new")),
    name: box(header.querySelector(".machine-name")),
    expanded: header.querySelector(".machine-toggle")!.getAttribute("aria-expanded") === "true",
  };
}, pc);

const readPcTrailing = ({ pc, waitFor }: { readonly pc: string; readonly waitFor?: "both" | "add" }) => {
  const group = document.querySelector<HTMLElement>(`section.machine-group[aria-label="PC ${pc}"]`)!;
  const header = group.querySelector<HTMLElement>(".machine-header")!;
  const box = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height } : null; };
  const centre = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r ? r.left + r.width / 2 : null; };
  const hit = (element: Element | null) => { const r = element?.getBoundingClientRect(); return r && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); };
  const add = header.querySelector<HTMLButtonElement>(".machine-new"), fold = header.querySelector<HTMLElement>(".machine-toggle");
  const addHit = hit(add), foldHit = hit(fold);
  const addTakesTap = add?.contains(addHit ?? null), foldTakesTap = fold?.contains(foldHit ?? null);
  if (waitFor && (!addTakesTap || (waitFor === "both" && !foldTakesTap))) return null;
  const row = group.querySelector(".workspace-header");
  return {
    add: { box: box(add)!, glyph: centre(add?.querySelector("svg") ?? null)!, takesTap: addTakesTap, hit: addHit?.getAttribute("class") ?? addHit?.tagName, disabled: add?.disabled ?? null },
    fold: { box: box(fold)!, glyph: centre(fold?.querySelector("svg") ?? null)!, takesTap: foldTakesTap, hit: foldHit?.getAttribute("class") ?? foldHit?.tagName },
    title: box(header.querySelector(".machine-title"))!,
    menuColumn: centre(row?.querySelector(".row-menu-toggle svg") ?? null),
    stateColumn: centre(row?.querySelector(".sidebar-pane-meta") ?? null),
    drawerRight: document.querySelector(".sidebar")!.getBoundingClientRect().right,
  };
};

async function pcTrailing(page: Page, pc: string, waitFor: "both" | "add" = "both") {
  // Scrolling the list (including its clamp after a fold) can leave the header clipped until the next paint.
  let at;
  try {
    const snapshot = await page.waitForFunction(readPcTrailing, { pc, waitFor });
    at = await snapshot.jsonValue();
  } catch (error) {
    if (!(error instanceof errors.TimeoutError)) throw error;
    at = await page.evaluate(readPcTrailing, { pc });
  }
  assert.ok(at);
  return at;
}

const addContrast = (page: Page, pc: string) => page.evaluate((pc) => {
  const rgb = (color: string): number[] => {
    const srgb = /^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)/.exec(color);
    if (srgb) return [Number(srgb[1]) * 255, Number(srgb[2]) * 255, Number(srgb[3]) * 255];
    const parts = color.match(/[\d.]+/g)?.map(Number);
    if (!color.startsWith("rgb") || !parts || parts.length < 3) throw new Error(`unexpected computed color ${color}`);
    return parts.slice(0, 3);
  };
  const luminance = (color: number[]) => color.reduce((sum, channel, index) => {
    const c = channel / 255;
    return sum + [0.2126, 0.7152, 0.0722][index]! * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  }, 0);
  const add = document.querySelector<HTMLElement>(`section.machine-group[aria-label="PC ${pc}"] .machine-new`)!;
  const style = getComputedStyle(add), alpha = Number(style.opacity);
  const surface = rgb(getComputedStyle(document.querySelector(".sidebar-shell")!).backgroundColor);
  const drawn = rgb(style.color).map((channel, index) => channel * alpha + surface[index]! * (1 - alpha));
  const [hi, lo] = [luminance(drawn), luminance(surface)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}, pc);

const agentRowsOn = (page: Page, machine: string) => page.locator(`.agents-sidebar .agent-item[data-machine="${machine}"]`).count();

const fades = (page: Page, list: string) => page.locator(list).evaluate((element) => {
  const style = getComputedStyle(element);
  const masked = style.maskImage !== "none" && style.maskImage !== "";
  return {
    top: masked ? parseFloat(style.getPropertyValue("--fade-top")) || 0 : 0,
    bottom: masked ? parseFloat(style.getPropertyValue("--fade-bottom")) || 0 : 0,
    scroll: element.scrollTop,
    max: element.scrollHeight - element.clientHeight,
  };
});

async function expectFades(page: Page, list: string, at: number | null, want: { top: boolean; bottom: boolean }, message: string): Promise<void> {
  if (at !== null) await page.locator(list).evaluate((element, at) => { element.scrollTop = (element.scrollHeight - element.clientHeight) * at; }, at);
  try {
    await page.waitForFunction(({ list, want }) => {
      const element = document.querySelector(list)!;
      const style = getComputedStyle(element);
      const edge = (name: string) => style.maskImage !== "none" && (parseFloat(style.getPropertyValue(name)) || 0) > 0;
      return edge("--fade-top") === want.top && edge("--fade-bottom") === want.bottom;
    }, { list, want }, { timeout: 2_000 });
  } catch {
    assert.fail(`${message}: wanted ${JSON.stringify(want)}, painted ${JSON.stringify(await fades(page, list))}`);
  }
}

await withDemoBrowser({ tempPrefix: "ovis-sidebar-heads-", prefix: "/", afterTransport: '<script src="./two-pcs.js"></script>' }, async ({ app, browser, baseUrl }) => {
  writeFileSync(join(app, "two-pcs.js"), TWO_PCS);
  let hybridBrowser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    const check = async (name: string, scene: Scene, run: (page: Page, label: string) => Promise<void>) => {
      if (only !== undefined && !name.includes(only)) return;
      const phone = scene.width <= 768;
      const label = `${name} ${scene.width}/${scene.mode}${scene.twoPcs ? "/two-pcs" : ""}${scene.grouped ? "/agents-first" : ""}${scene.forcedColors ? "/forced-colors" : ""}${scene.hybrid ? "/hybrid" : ""}`;
      if (scene.hybrid) hybridBrowser ??= await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", HYBRID] });
      const context = await appContext(scene.hybrid ? hybridBrowser! : browser, { viewport: { width: scene.width, height: scene.height ?? 844 }, colorScheme: scene.mode, hasTouch: phone && !scene.hybrid, isMobile: phone && !scene.hybrid, deviceScaleFactor: 1, forcedColors: scene.forcedColors ? "active" : "none" });
      try {
        await context.addInitScript((scene) => {
          if (localStorage.getItem("heads-fixture:ready") === "1") return;
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: scene.mode, palette: "codex", defaultView: "chat" }));
          localStorage.setItem("ovis:agents-collapsed", "0");
          localStorage.setItem("ovis:agent-groups", String(scene.grouped === true));
          if (scene.twoPcs) localStorage.setItem("heads-fixture:two-pcs", "1");
          if (scene.workOffline) localStorage.setItem("heads-fixture:work-offline", "1");
          for (const [key, value] of Object.entries(scene.storage ?? {})) localStorage.setItem(key, value);
          localStorage.setItem("heads-fixture:ready", "1");
        }, scene);
        const page = await context.newPage();
        page.setDefaultTimeout(10_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${baseUrl}`);
        await page.locator(".agents-sidebar .agent-item").first().waitFor({ state: "attached" });
        if (phone) {
          await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          // CDP touch dispatch has no actionability wait: wait for the drawer's slide to reach the screen
          await page.waitForFunction(() => (document.querySelector(".sidebar.is-open")?.getBoundingClientRect().left ?? -1) >= -0.5);
        }
        if (scene.twoPcs) await page.waitForFunction((offline) => document.querySelectorAll(".machine-list .machine-group .machine-workspaces").length === 2 && document.querySelectorAll(".machine-list .machine-group.is-offline").length === offline, scene.workOffline ? 1 : 0);
        await page.evaluate(() => document.fonts.ready);
        await run(page, label);
        assert.deepEqual(errors, [], `${label}: no browser errors`);
        console.log(`PASS ${label}`);
      } finally { await context.close(); }
    };
    const shot = async (page: Page, name: string, scene: Scene) => {
      if (!evidence) return;
      mkdirSync(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `heads-${scene.width}-${scene.mode}-${name}.png`), animations: "disabled" });
    };

    for (const width of [1280, 390]) for (const mode of ["light", "dark"] as const) {
      for (const grouped of [false, true]) {
        const scene: Scene = { width, mode, twoPcs: true, grouped };
        await check("section heads show their carets, with no count", scene, async (page, label) => {
          const agentsToggle = page.locator(".agent-section-toggle");
          if (await agentsToggle.getAttribute("aria-expanded") !== "true") await agentsToggle.click();
          const open = await heads(page);
          assert.ok(open.agentRows > 0 && open.machines === 2, `${label}: the fixture shows two PCs and agents`);
          assert.equal(open.pcsHead, 0, `${label}: the PCs have no head, no caret and no count`);
          assert.equal(open.agentsCaret, true, `${label}: the open Agents head shows its caret at rest`);
          assert.equal(open.agentsCount, null, `${label}: the open Agents head says no count`);
          if (!grouped) await shot(page, "open", scene);
          await agentsToggle.click();
          const folded = await heads(page);
          assert.ok(folded.agentsFolded, `${label}: the Agents head folds`);
          assert.equal(folded.machines, 2, `${label}: the PCs stay listed`);
          assert.equal(folded.agentsCaret, true, `${label}: the folded Agents head shows its caret`);
          assert.equal(folded.agentsCount, null, `${label}: the folded Agents head says no count either`);
        });
      }
      await check("a PC header trades its agent count for its actions", { width, mode, twoPcs: true }, async (page, label) => {
        const phone = width <= 768;
        const agentsOnWork = await agentRowsOn(page, "work");
        assert.ok(agentsOnWork > 0, `${label}: Work PC runs agents`);
        await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-header').scrollIntoViewIfNeeded();
        if (!phone) await page.mouse.move(width - 8, 600);
        const rest = await pcHeader(page, "Work PC");
        assert.equal(rest.countWords, `${agentsOnWork} agents`, `${label}: the count's words say what it counts`);
        assert.equal(rest.countTitle, null, `${label}: the count claims no tooltip a pointer cannot reach`);
        if (phone) {
          assert.equal(rest.count, null, `${label}: no count in view under a finger`);
          assert.ok(rest.toggle && rest.add, `${label}: the fold and the + show under a finger`);
          for (const [control, box] of [["fold", rest.toggleBox!], ["+", rest.addBox!]] as const) assert.ok(box.width >= 44 && box.height >= 44, `${label}: the ${control} is a finger's 44 px (${box.width}x${box.height})`);
          assert.equal(await page.locator(".app-header .new-workspace-button").count(), 0, `${label}: the top row over the drawer draws no +`);
        } else {
          assert.equal(rest.count, String(agentsOnWork), `${label}: at rest the header counts its PC's agents`);
          assert.ok(!rest.toggle && !rest.add, `${label}: at rest the fold and + are out of sight`);
          assert.ok(rest.toggleBox!.width > 0 && rest.addBox!.width > 0, `${label}: the unseen fold and + keep their cells`);
          assert.ok(Math.abs((rest.countBox!.left + rest.countBox!.width / 2) - (rest.addBox!.left + rest.addBox!.width / 2)) <= 1, `${label}: the count sits in the +'s cell`);
          const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest(".machine-new, .machine-agent-count")?.className ?? null, { x: rest.countBox!.left + rest.countBox!.width / 2, y: rest.countBox!.top + rest.countBox!.height / 2 });
          assert.match(hit ?? "", /\bmachine-new\b/, `${label}: a press on the count lands on the + under it (${hit})`);
          await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-name').hover();
          const hovered = await pcHeader(page, "Work PC");
          assert.equal(hovered.count, null, `${label}: a hover takes the count away`);
          assert.ok(hovered.toggle && hovered.add, `${label}: a hover shows the fold and +`);
          assert.deepEqual(hovered.name, rest.name, `${label}: the name never moves`);
          await page.mouse.move(width - 8, 600);
          assert.equal((await pcHeader(page, "Work PC")).count, String(agentsOnWork), `${label}: the count comes back when the pointer leaves`);
          await page.locator('section.machine-group[aria-label="PC Laptop"] .machine-header').locator(':is(button, [role="button"][tabindex="0"])').first().focus();
          assert.equal(await page.evaluate(() => document.activeElement?.closest("section.machine-group")?.getAttribute("aria-label")), "PC Laptop", `${label}: the focus is in the first PC's header`);
          const focused = await pcHeader(page, "Laptop");
          assert.equal(focused.count, null, `${label}: the focus in a header takes its count away`);
          assert.ok(focused.toggle && focused.add, `${label}: the focus in a header shows its fold and +`);
          await shot(page, "pc-header-focus", { width, mode });
          await page.keyboard.press("Shift+Tab");
          assert.equal((await pcHeader(page, "Laptop")).count, String(await agentRowsOn(page, "local")), `${label}: the count comes back when the focus leaves`);
        }
        await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-name').click();
        assert.equal((await pcHeader(page, "Work PC")).expanded, false, `${label}: a press on the name folds the PC`);
        await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-name').click();
        assert.equal((await pcHeader(page, "Work PC")).expanded, true, `${label}: a second press opens it again`);
      });
      await check("a folded PC is one row, an open one ends with a short gap", { width, mode, twoPcs: true }, async (page, label) => {
        const rows = () => page.evaluate(() => {
          const box = (element: Element) => element.getBoundingClientRect();
          const [laptop, work] = [...document.querySelectorAll(".machine-list section.machine-group")];
          const lastRow = laptop!.querySelector(".machine-workspaces");
          return {
            head: box(document.querySelector(".machine-list")!).top,
            first: box(laptop!).top,
            laptop: { top: box(laptop!).top, bottom: box(laptop!).bottom, header: box(laptop!.querySelector(".machine-header")!).height, lastRow: lastRow ? box(lastRow).bottom : null },
            work: { top: box(work!).top, bottom: box(work!).bottom, header: box(work!.querySelector(".machine-header")!).height },
            clippedState: Math.max(...[...document.querySelectorAll(".machine-list .machine-state.visually-hidden")].map((line) => box(line).height)),
          };
        });
        const open = await rows();
        assert.ok(Math.abs(open.first - open.head) <= 1, `${label}: the first PC starts the list, with no PCs head above it (${open.first - open.head}px)`);
        assert.ok(open.clippedState <= 1, `${label}: a clipped state line is ${open.clippedState}px tall`);
        assert.ok(open.laptop.lastRow !== null && Math.abs(open.work.top - open.laptop.lastRow - 8) <= 1, `${label}: an open PC ends a --space-2 gap before the next PC (${open.laptop.lastRow === null ? "no rows" : open.work.top - open.laptop.lastRow}px)`);
        for (const pc of ["Laptop", "Work PC"]) await page.getByRole("button", { name: `Collapse ${pc}`, exact: true }).click();
        await page.waitForFunction(() => !document.querySelector(".machine-list .machine-workspaces"));
        const folded = await rows();
        assert.ok(Math.abs(folded.laptop.bottom - folded.laptop.top - folded.laptop.header) <= 1, `${label}: a folded PC is one row (${folded.laptop.bottom - folded.laptop.top}px for a ${folded.laptop.header}px header)`);
        assert.ok(Math.abs(folded.work.top - folded.laptop.bottom) <= 1, `${label}: no gap between folded PCs (${folded.work.top - folded.laptop.bottom}px)`);
        await shot(page, "pcs-folded", { width, mode });
      });
      await check("each list fades only at an edge with rows past it", { width, mode, twoPcs: true, height: 640 }, async (page, label) => {
        const agentsToggle = page.locator(".agent-section-toggle");
        if (await agentsToggle.getAttribute("aria-expanded") !== "true") await agentsToggle.click();
        await page.locator(".agent-resting-label button").click();
        assert.equal(await page.locator(".agent-resting-label button").getAttribute("aria-expanded"), "true");
        for (const list of [".machine-list", ".agent-list-contents"]) {
          const start = await fades(page, list);
          assert.ok(start.max > 40, `${label}: ${list} holds more rows than it shows (${start.max}px to scroll)`);
          await expectFades(page, list, 0, { top: false, bottom: true }, `${label}: ${list} at its top fades its foot alone`);
          await expectFades(page, list, 0.5, { top: true, bottom: true }, `${label}: ${list} in its middle fades both edges`);
          if (list === ".agent-list-contents") await shot(page, "fades-middle", { width, mode });
          await expectFades(page, list, 1, { top: true, bottom: false }, `${label}: ${list} at its end fades its head alone`);
        }
        await page.locator(".machine-list").evaluate((element) => { element.scrollTop = 0; });
        for (const pc of ["Laptop", "Work PC"]) await page.getByRole("button", { name: `Collapse ${pc}`, exact: true }).click();
        await page.waitForFunction(() => !document.querySelector(".machine-list .machine-workspaces"));
        await page.setViewportSize({ width, height: 900 });
        await page.waitForFunction(() => { const list = document.querySelector(".machine-list")!; return list.scrollHeight - list.clientHeight <= 1; });
        await expectFades(page, ".machine-list", null, { top: false, bottom: false }, `${label}: a PC list that holds all its rows fades neither edge`);
      });
      await check("a short Agents list fades neither edge", { width, mode, height: 1000 }, async (page, label) => {
        const agentsToggle = page.locator(".agent-section-toggle");
        if (await agentsToggle.getAttribute("aria-expanded") !== "true") await agentsToggle.click();
        assert.ok((await fades(page, ".agent-list-contents")).max <= 1, `${label}: the demo's agents fit their list`);
        await expectFades(page, ".agent-list-contents", null, { top: false, bottom: false }, `${label}: an Agents list that holds all its rows fades neither edge`);
      });
      await check("a disconnected PC's disabled + stays dimmed when shown", { width, mode, twoPcs: true, workOffline: true }, async (page, label) => {
        const header = page.locator('section.machine-group[aria-label="PC Work PC"] .machine-header');
        const add = header.locator(".machine-new");
        await header.scrollIntoViewIfNeeded();
        assert.equal(await add.isDisabled(), true, `${label}: the offline PC's + is disabled`);
        assert.equal((await pcHeader(page, "Work PC")).countWords, null, `${label}: a disconnected PC says no agents running`);
        if (width > 768) {
          await page.mouse.move(width - 8, 600);
          assert.equal((await pcHeader(page, "Work PC")).count, null, `${label}: at rest a disconnected PC shows no agent count`);
          assert.equal(await add.evaluate((element) => getComputedStyle(element).opacity), "0", `${label}: at rest the + is out of sight`);
          await header.locator(".machine-name").hover();
          const opacity = Number(await add.evaluate((element) => getComputedStyle(element).opacity));
          assert.ok(opacity > 0.3 && opacity < 0.9, `${label}: the shown disabled + keeps its dim (${opacity})`);
        } else {
          const opacity = Number(await add.evaluate((element) => getComputedStyle(element).opacity));
          assert.ok(opacity > 0.3 && opacity < 0.9, `${label}: the phone drawer's disabled + keeps its dim (${opacity})`);
        }
      });
      await check("a lone Host has no head at all", { width, mode }, async (page, label) => {
        const lone = await heads(page);
        assert.equal(await page.locator(".machine-group .machine-header").count(), 0, `${label}: the lone Host has no header`);
        assert.equal(lone.pcsHead, 0, `${label}: and no PCs head above it`);
      });
    }
    for (const width of [360, 390]) for (const mode of ["light", "dark"] as const) await check("a phone's drawer has each PC's + on its own row", { width, mode, twoPcs: true }, async (page, label) => {
      const header = (pc: string) => page.locator(`section.machine-group[aria-label="PC ${pc}"] .machine-header`);
      assert.equal(await page.locator(".app-header .new-workspace-button").count(), 0, `${label}: the top row over the drawer draws no +`);
      const open: Record<string, Awaited<ReturnType<typeof pcTrailing>>> = {};
      for (const pc of ["Laptop", "Work PC"]) {
        await header(pc).scrollIntoViewIfNeeded();
        const add = header(pc).getByRole("button").last();
        assert.equal(await add.evaluate((button) => button.classList.contains("machine-new")), true, `${label}: ${pc}'s last control is its +`);
        assert.ok((await add.getAttribute("aria-label") ?? "").includes(pc), `${label}: ${pc}'s + names the PC it makes the workspace on`);
        assert.equal(await add.isEnabled(), true, `${label}: a connected PC's + is enabled`);
        const at = open[pc] = await pcTrailing(page, pc);
        assert.ok(at.menuColumn !== null && at.stateColumn !== null, `${label}: ${pc} draws rows under its header`);
        assert.ok(Math.abs(at.add.glyph - at.stateColumn!) <= 1, `${label}: ${pc}'s + is on the column of its rows' state (${at.add.glyph} vs ${at.stateColumn})`);
        assert.ok(Math.abs(at.fold.glyph - at.menuColumn!) <= 1, `${label}: ${pc}'s fold is on the column of its rows' ⋯ (${at.fold.glyph} vs ${at.menuColumn})`);
        for (const [control, box] of [["fold", at.fold.box], ["+", at.add.box]] as const) assert.ok(box.width >= 44 && box.height >= 44, `${label}: ${pc}'s ${control} is a finger's 44 px (${box.width}x${box.height})`);
        assert.ok(Math.abs(at.add.box.left - at.fold.box.right) <= 0.5, `${label}: ${pc}'s fold ends where its + starts, so the two share no tap (${at.fold.box.right} vs ${at.add.box.left})`);
        assert.ok(at.add.takesTap && at.fold.takesTap, `${label}: a tap on the middle of ${pc}'s + and of its fold lands on each (hit ${at.add.hit} and ${at.fold.hit})`);
        assert.ok(at.add.box.right <= at.drawerRight + 0.5, `${label}: ${pc}'s + ends inside the drawer (${at.add.box.right} of ${at.drawerRight})`);
      }
      for (const pc of ["Laptop", "Work PC"]) await page.getByRole("button", { name: `Collapse ${pc}`, exact: true }).click();
      await page.waitForFunction(() => !document.querySelector(".machine-list .machine-workspaces"));
      for (const pc of ["Laptop", "Work PC"]) {
        await header(pc).scrollIntoViewIfNeeded();
        const folded = await pcTrailing(page, pc, "add");
        assert.ok(folded.add.takesTap, `${label}: folded, ${pc} still offers its + (hit ${folded.add.hit})`);
        assert.ok(Math.abs(folded.add.box.left - open[pc]!.add.box.left) <= 0.5 && Math.abs(folded.title.right - open[pc]!.title.right) <= 0.5, `${label}: folding ${pc} moves neither its + nor its name's room`);
      }
      for (const pc of ["Work PC", "Laptop"]) {
        await header(pc).getByRole("button").last().tap();
        const dialog = page.locator(".new-session-modal");
        await dialog.waitFor();
        assert.ok((await dialog.getByRole("heading").first().innerText()).includes(pc), `${label}: ${pc}'s + opens New workspace for ${pc}`);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
        await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await page.waitForFunction(() => (document.querySelector(".sidebar.is-open")?.getBoundingClientRect().left ?? -1) >= -0.5);
      }
    });
    for (const hybrid of [false, true]) await check("a phone's drawer keeps a + that is off readable in every theme", { width: 390, mode: "dark", twoPcs: true, workOffline: true, hybrid }, async (page, label) => {
      assert.deepEqual(await page.evaluate(() => [matchMedia("(pointer: fine)").matches, matchMedia("(any-pointer: coarse)").matches]), [hybrid, true], `${label}: the browser answers as ${hybrid ? "a hybrid device" : "a phone"}`);
      assert.equal(await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-new').isDisabled(), true, `${label}: the PC that is away has its + off`);
      for (const mode of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: mode });
        for (const { id } of SUPPORTED_ENTRIES.filter((entry) => entry.mode === mode)) {
          await page.evaluate(({ id, mode }) => { const root = document.documentElement; root.dataset["theme"] = mode; root.dataset["palette"] = id; root.style.colorScheme = mode; }, { id, mode });
          const off = await addContrast(page, "Work PC"), on = await addContrast(page, "Laptop");
          assert.ok(off >= 3, `${label}: ${id}/${mode} draws the + that is off at ${off.toFixed(2)}:1, under 3:1`);
          assert.ok(off < on, `${label}: ${id}/${mode} draws the + that is off (${off.toFixed(2)}:1) dimmer than one that is on (${on.toFixed(2)}:1)`);
        }
      }
    });
    for (const mode of ["light", "dark"] as const) await check("a hybrid device always shows a PC's actions", { width: 1280, mode, twoPcs: true, hybrid: true }, async (page, label) => {
      assert.deepEqual(await page.evaluate(() => [matchMedia("(hover: hover) and (pointer: fine)").matches, matchMedia("(any-pointer: coarse)").matches]), [true, true], `${label}: the browser answers as a hybrid device`);
      await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-header').scrollIntoViewIfNeeded();
      await page.mouse.move(1272, 600);
      const rest = await pcHeader(page, "Work PC");
      assert.ok(rest.toggle && rest.add, `${label}: at rest the fold and + show`);
      const manage = await page.locator('section.machine-group[aria-label="PC Work PC"] .machine-manage').evaluate((button) => { const box = button.getBoundingClientRect(); return { width: box.width, opacity: getComputedStyle(button).opacity }; });
      assert.ok(manage.width > 0 && manage.opacity === "1", `${label}: at rest Manage shows too: ${JSON.stringify(manage)}`);
      assert.equal(rest.count, null, `${label}: no count in view over the actions`);
      assert.equal(rest.countWords, `${await agentRowsOn(page, "work")} agents`, `${label}: a screen reader still hears the count`);
    });
    await check("forced colors fade no edge", { width: 1280, mode: "dark", twoPcs: true, height: 640, forcedColors: true }, async (page, label) => {
      await page.locator(".machine-list").evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
      await page.waitForFunction(() => document.querySelector(".machine-list")!.scrollTop > 0);
      for (const list of [".machine-list", ".agent-list-contents"]) {
        assert.equal(await page.locator(list).evaluate((element) => getComputedStyle(element).maskImage), "none", `${label}: ${list} has no mask`);
      }
    });
  } finally { await hybridBrowser?.close(); }
});
