/**
 * Purpose: the sidebar's label filter on the real client over the demo's fixture transport, with two
 * connected PCs: what a query keeps (matches, their ancestors and descendants, the selection as context),
 * in the roster's order with its pins and folds; that nothing is typed into a terminal, focused in herdr,
 * moved, stored or sent; that a live roster change and an offline PC show through it; and the screenshots
 * of every state at 390 and 1440, light and dark, Korean at 390 (UI_EVIDENCE_DIR).
 * Usage: UI_EVIDENCE_DIR=<dir> bun scripts/sidebar-filter-demo-regression.ts   (SIDEBAR_FILTER_CASE=en|ko runs one half)
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";
import { sheetRisen } from "./settings-page.ts";

// No live session is read, and nothing leaves the loopback server below.
const evidence = process.env["UI_EVIDENCE_DIR"];
const LONG_LABEL = "release-candidate-verification-pipeline-with-an-unbroken-name-that-keeps-going";
const LONG_TITLE = "Investigate_the_intermittent_timeout_in_the_nightly_settlement_reconciliation_job";
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource, SocketDemo = window.WebSocket;
  const params = new URLSearchParams(location.search);
  const calls = window.sidebarFilterCalls = { requests: [], frames: [], focus: 0, moves: 0 };
  const sources = new Set();
  let last = null;
  const edits = { labels: {}, paneLabels: {}, removed: {}, offline: {} };
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const NAMES = { local: "Laptop", build: "Build PC", loading: "Old PC", error: "Rack PC" };
  const roster = (original) => {
    const base = original.find((item) => item.id === "local");
    const ids = ["local", "build", ...(params.has("loading") ? ["loading"] : []), ...(params.has("error") ? ["error"] : [])];
    return ids.map((id) => {
      const machine = structuredClone(base);
      machine.id = id; machine.kind = id === "local" ? "local" : "ssh"; machine.name = NAMES[id];
      if (id === "loading") { machine.state = "connecting"; machine.snapshot = null; return machine; }
      if (id === "error") { machine.state = "error"; machine.error = "ssh: connect to host rack.invalid port 22: Connection refused"; machine.snapshot = null; return machine; }
      const snap = machine.snapshot;
      if (id === "build") {
        // the build PC's own names, so one word reaches both PCs and the rows still tell them apart
        for (const workspace of snap.workspaces) {
          if (workspace.label === "cli-tools") workspace.label = "ops-tools";
          if (workspace.label === "export-guard") workspace.label = "export-audit";
        }
        for (const pane of snap.panes) {
          if (pane.pane_id === ${JSON.stringify(panes.api)}) pane.label = "Remote migration";
          if (pane.pane_id === ${JSON.stringify(panes.omp)}) pane.label = "Plan the deploy file";
        }
      }
      if (params.has("long") && id === "local") {
        for (const workspace of snap.workspaces) if (workspace.label === "changelog") workspace.label = ${JSON.stringify(LONG_LABEL)};
        for (const pane of snap.panes) if (pane.pane_id === ${JSON.stringify(panes.omp)}) pane.label = ${JSON.stringify(LONG_TITLE)};
      }
      for (const [workspaceId, label] of Object.entries(edits.labels[id] ?? {})) for (const workspace of snap.workspaces) if (workspace.workspace_id === workspaceId) workspace.label = label;
      for (const [paneId, label] of Object.entries(edits.paneLabels[id] ?? {})) for (const pane of snap.panes) if (pane.pane_id === paneId) pane.label = label;
      for (const paneId of edits.removed[id] ?? []) {
        const pane = snap.panes.find((candidate) => candidate.pane_id === paneId);
        if (!pane) continue;
        snap.panes = snap.panes.filter((candidate) => candidate.pane_id !== paneId);
        snap.agents = snap.agents.filter((candidate) => candidate.pane_id !== paneId);
        if (!snap.panes.some((candidate) => candidate.tab_id === pane.tab_id)) { snap.tabs = snap.tabs.filter((candidate) => candidate.tab_id !== pane.tab_id); snap.layouts = snap.layouts.filter((candidate) => candidate.tab_id !== pane.tab_id); }
        if (!snap.panes.some((candidate) => candidate.workspace_id === pane.workspace_id)) snap.workspaces = snap.workspaces.filter((candidate) => candidate.workspace_id !== pane.workspace_id);
      }
      if (edits.offline[id]) { machine.state = "disconnected"; machine.error = null; }
      return machine;
    });
  };
  const broadcast = () => { for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: roster(last) }) })); };
  window.sidebarFilterFixture = {
    relabelWorkspace(machine, id, label) { (edits.labels[machine] ??= {})[id] = label; broadcast(); },
    relabelPane(machine, id, label) { (edits.paneLabels[machine] ??= {})[id] = label; broadcast(); },
    removePane(machine, id) { (edits.removed[machine] ??= []).push(id); broadcast(); },
    disconnect(machine) { edits.offline[machine] = true; broadcast(); },
    roster: () => roster(last),
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
        // the build PC is the laptop's roster under other names: a pane's own status change reaches both, as a roster does,
        // and stays in the roster this fixture sends again after an edit
        if (message.machine_id === "local" && message.message?.type === "pane-status") {
          const { pane_id, agent_status, finish_id } = message.message;
          const snap = last?.find((item) => item.id === "local")?.snapshot;
          for (const entry of [...(snap?.panes ?? []), ...(snap?.agents ?? [])]) if (entry.pane_id === pane_id) Object.assign(entry, { agent_status, ...(finish_id === undefined ? {} : { finish_id }) });
          this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ...message, machine_id: "build" }) }));
        }
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { sources.delete(this); this.inner.close(); this.readyState = 2; }
  };
  window.WebSocket = class extends SocketDemo {
    constructor(url, protocols) {
      super(url, protocols);
      const send = this.send.bind(this);
      this.send = (raw) => { calls.frames.push(String(raw)); send(raw); };
    }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    calls.requests.push({ method, url: url.pathname + url.search, body: typeof init?.body === "string" ? init.body : null });
    if (url.pathname === "/api/health") {
      const value = await (await fetchDemo(input, init)).json();
      if (params.has("watch") && value.auth) value.auth = { ...value.auth, role: "watch" };
      return json(value);
    }
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ machines: roster(last) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (path === "/api/pane/focus") { calls.focus++; return json({ ok: true }); }
    if (path === "/api/workspace/move") { calls.moves++; return json({ ok: true }); }
    if (match && (machine === "loading" || machine === "error")) return json({ error: { code: "unavailable", message: "fixture PC is away" } }, 503);
    if (match && path === "/api/session") return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

type Theme = "dark" | "light";
type Language = "en" | "ko";
interface Shot { file: string; width: number; height: number; theme: Theme; language: Language; viewport: 390 | 1440; state: string; sha256: string; capturedAt: string }
const manifest: Shot[] = [];

const WEB = panes.web;
const workspaceRows = (page: Page): Locator => page.locator(".machine-list .workspace-group");
const agentRows = (page: Page): Locator => page.locator(".agents-sidebar .agent-item");
const filterInput = (page: Page): Locator => page.locator(".sidebar-filter-input");
const clearButton = (page: Page): Locator => page.locator(".sidebar-filter-clear");

async function rosterView(page: Page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll<HTMLElement>(".machine-list .machine-group:not([hidden])")].map((group) => ({
      name: group.querySelector(".machine-name")?.textContent ?? "",
      offline: group.classList.contains("is-offline"),
      context: group.classList.contains("is-filter-context"),
      folded: group.querySelector<HTMLElement>(".machine-toggle")?.getAttribute("aria-expanded") === "false",
      workspaces: [...group.querySelectorAll<HTMLElement>(".workspace-group")].filter((row) => !row.closest("[hidden]")).map((row) => ({
        id: row.dataset["workspace"] ?? "",
        name: row.querySelector(".workspace-name")?.textContent ?? "",
        pinned: row.closest(".workspace-list-pinned") !== null,
        nested: row.closest(".worktree-children") !== null,
        selected: row.classList.contains("is-selected"),
        context: row.classList.contains("is-filter-context"),
        note: row.querySelector(".sidebar-filter-note")?.textContent ?? null,
        folded: row.querySelector<HTMLElement>(":scope > .workspace-header .workspace-toggle")?.getAttribute("aria-expanded") === "false",
        foldCount: row.querySelector(".workspace-fold-count")?.textContent ?? null,
        draggable: row.querySelector<HTMLElement>(".workspace-select")?.getAttribute("draggable"),
        shortcuts: row.querySelector<HTMLElement>(".workspace-select")?.getAttribute("aria-keyshortcuts"),
      })),
    }));
    const agents = [...document.querySelectorAll<HTMLElement>(".agents-sidebar .agent-item")].map((row) => ({
      machine: row.dataset["machine"] ?? "",
      pane: row.dataset["pane"] ?? "",
      title: row.querySelector(".agent-title")?.textContent ?? "",
      pinned: row.closest(".agent-list-pinned") !== null,
      selected: row.classList.contains("is-selected"),
      context: row.classList.contains("is-filter-context"),
      offline: row.classList.contains("is-offline"),
      note: row.querySelector(".sidebar-filter-note")?.textContent ?? null,
      visible: row.getClientRects().length > 0,
    }));
    const agentsExpanded = document.querySelector(".agent-section-toggle")?.getAttribute("aria-expanded") === "true";
    return { groups, agents, agentsExpanded, empty: document.querySelector(".sidebar-filter-empty")?.textContent ?? null, selectedPane: document.querySelector<HTMLElement>('.workspace-select[aria-current="true"]')?.dataset["pane"] ?? null, activeIsFilter: document.activeElement?.classList.contains("sidebar-filter-input") ?? false };
  });
}

/** Everything this page keeps: folds, pins and the rest, to prove a filter writes none of it and the query is nowhere. */
const storageView = (page: Page) => page.evaluate(() => {
  const apart = new Set(["ovis:chat-positions", "ovis:agent-state-since"]);
  const read = (store: Storage) => Object.fromEntries(Object.keys(store).filter((key) => !apart.has(key)).sort().map((key) => [key, store.getItem(key)]));
  return { local: read(localStorage), session: read(sessionStorage) };
});

const transportText = (page: Page) => page.evaluate(() => {
  const calls = (window as unknown as { sidebarFilterCalls: { requests: { method: string; url: string; body: string | null }[]; frames: string[]; focus: number; moves: number } }).sidebarFilterCalls;
  return { text: JSON.stringify(calls.requests) + calls.frames.join("\n") + location.href, focus: calls.focus, moves: calls.moves };
});

const fixture = (page: Page, call: string) => page.evaluate((expression) => {
  const run = new Function("fixture", `return fixture.${expression};`);
  return run((window as unknown as { sidebarFilterFixture: unknown }).sidebarFilterFixture);
}, call);

const DRAWER_LABEL: Record<Language, { open: string }> = {
  en: { open: "Open workspace list" },
  ko: { open: "워크스페이스 목록 열기" },
};

async function openDrawer(page: Page, language: Language = "en"): Promise<void> {
  await page.getByRole("button", { name: DRAWER_LABEL[language].open, exact: true }).click();
  await page.locator(".sidebar.is-open").waitFor();
}

async function closeDrawer(page: Page): Promise<void> {
  await page.mouse.click(page.viewportSize()!.width - 8, page.viewportSize()!.height / 2);
  await page.locator(".sidebar.is-open").waitFor({ state: "detached" });
}

const shownIds = (page: Page) => page.evaluate(() => ({
  ids: [...document.querySelectorAll<HTMLElement>(".machine-list .workspace-group")].filter((row) => !row.closest("[hidden]")).map((row) => row.dataset["workspace"]),
  agents: [...document.querySelectorAll<HTMLElement>(".agents-sidebar .agent-item")].map((row) => `${row.dataset["machine"]}:${row.dataset["pane"]}`),
}));

async function waitWorkspaceIds(page: Page, predicate: string): Promise<void> {
  try {
    await page.waitForFunction((body) => {
      const ids = [...document.querySelectorAll<HTMLElement>(".machine-list .workspace-group")].filter((row) => !row.closest("[hidden]")).map((row) => row.dataset["workspace"]);
      const agents = [...document.querySelectorAll<HTMLElement>(".agents-sidebar .agent-item")].map((row) => `${row.dataset["machine"]}:${row.dataset["pane"]}`);
      return new Function("ids", "agents", `return ${body};`)(ids, agents);
    }, predicate, { timeout: 10_000 });
  } catch (error) {
    throw new Error(`the rows never became ${predicate}: ${JSON.stringify(await shownIds(page))}`, { cause: error });
  }
}

interface Scene { phone: boolean; theme: Theme; language: Language }
/**
 * The demo ends the api pane's turn 4.5 s after each load (site/demo/transport.ts), on both PCs' rows (the fixture
 * passes its status to the build PC's copy too) or already in the first roster when that comes later, and both rows
 * leave for the resting part. Every roster a step compares with another is taken after that, never across it.
 */
async function turnEnded(page: Page): Promise<void> {
  await page.waitForFunction((api) => ["local", "build"].every((machine) =>
    document.querySelector(`.agents-sidebar .agent-item[data-machine="${machine}"][data-pane="${api}"] [data-status="done"]`) !== null), panes.api);
}

async function newPage(browser: Browser, scene: Scene, search: string, stored: Record<string, string> = {}): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await appContext(browser, scene.phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: scene.language === "ko" ? "ko-KR" : "en-US", colorScheme: scene.theme }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: scene.theme });
  await context.addInitScript(({ settings, stored }) => {
    localStorage.setItem("ovis:settings", JSON.stringify(settings));
    for (const [key, value] of Object.entries(stored)) localStorage.setItem(key, value);
    // the Filter field is off until chosen (Settings → Sidebar filter); this check is of the field itself
  }, { settings: { language: scene.language, theme: scene.theme, defaultView: "chat" }, stored: { "ovis:sidebar-filter-shown": "true", ...stored } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}?${search}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  if (scene.phone) await openDrawer(page, scene.language);
  await agentRows(page).first().waitFor({ state: "attached" });
  await page.waitForFunction(() => document.querySelectorAll(".machine-list .machine-group").length >= 2);
  await turnEnded(page);
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors };
}

function pngSize(file: string): { width: number; height: number } {
  const bytes = readFileSync(file);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const DROPLET_HIDDEN = ".droplet { visibility: hidden !important; }";

async function capture(page: Page, scene: Scene, state: string): Promise<void> {
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  const file = `sidebar-filter-${scene.phone ? 390 : 1440}-${scene.theme}${scene.language === "ko" ? "-ko" : ""}-${state}.png`;
  const path = join(evidence, file);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
  // a touch device's emulated pointer is drawn into the screenshot where the last tap left it: it leaves the page first
  // (a held button keeps its :active state), and the shot waits for the frame that draws it gone
  if (scene.phone) {
    await page.mouse.move(-50, -50);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path, style: DROPLET_HIDDEN });
  }
  else await page.locator(".sidebar").screenshot({ path, style: DROPLET_HIDDEN });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(readFileSync(path));
  manifest.push({ file, ...pngSize(path), theme: scene.theme, language: scene.language, viewport: scene.phone ? 390 : 1440, state, sha256: hasher.digest("hex"), capturedAt: new Date().toISOString() });
}

async function measure(page: Page): Promise<Record<string, unknown>> {
  return await page.evaluate(() => {
    const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    const rgba = (color: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data; return [r!, g!, b!, a! / 255];
    };
    const over = (top: [number, number, number, number], under: [number, number, number]): [number, number, number] =>
      [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as [number, number, number];
    const background = (el: Element): [number, number, number] => {
      const layers: [number, number, number, number][] = [];
      for (let node: Element | null = el; node; node = node.parentElement) {
        const layer = rgba(getComputedStyle(node).backgroundColor);
        if (layer[3] > 0) { layers.push(layer); if (layer[3] >= 1) break; }
      }
      let base: [number, number, number] = [255, 255, 255];
      for (const layer of layers.reverse()) base = over(layer, base);
      return base;
    };
    const luminance = (c: [number, number, number]) => { const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
    const contrast = (a: [number, number, number], b: [number, number, number]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return Math.round(((x! + 0.05) / (y! + 0.05)) * 100) / 100; };
    const opacity = (el: Element): number => { let value = 1; for (let node: Element | null = el; node; node = node.parentElement) value *= parseFloat(getComputedStyle(node).opacity); return value; };
    const text = (el: Element | null, colorOf: (style: CSSStyleDeclaration) => string = (style) => style.color) => {
      if (!el) return null;
      const style = getComputedStyle(el), bg = background(el), [r, g, b, a] = rgba(colorOf(style)), fg = over([r, g, b, a * opacity(el)], bg), box = el.getBoundingClientRect();
      return { text: (el.textContent ?? "").trim().slice(0, 60), fontSizePx: parseFloat(style.fontSize), contrast: contrast(fg, bg), userSelect: style.userSelect || style.webkitUserSelect, width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10 };
    };
    const edge = (el: Element | null) => {
      if (!el) return null;
      const style = getComputedStyle(el), around = el.parentElement ? background(el.parentElement) : [255, 255, 255] as [number, number, number], fill = background(el), line = over(rgba(style.borderTopColor), around);
      return { borderColor: style.borderTopColor, borderWidthPx: parseFloat(style.borderTopWidth), againstPanel: contrast(line, around), againstFill: contrast(line, fill) };
    };
    const input = document.querySelector<HTMLInputElement>(".sidebar-filter-input")!;
    const clear = document.querySelector<HTMLButtonElement>(".sidebar-filter-clear");
    const inputBox = input.getBoundingClientRect(), clearBox = clear?.getBoundingClientRect();
    const svg = clear?.querySelector("svg") ?? null;
    return {
      input: { ...text(input), placeholder: input.value === "" ? text(input, () => getComputedStyle(input, "::placeholder").color) : null, accessibleName: input.getAttribute("aria-label") ?? input.labels?.[0]?.textContent ?? null, placeholderText: input.placeholder, type: input.type, width: inputBox.width, height: inputBox.height, suggestions: input.list?.options.length ?? 0 },
      glass: (() => {
        const glass = document.querySelector(".sidebar-filter-glass");
        if (!glass) return null;
        const box = glass.getBoundingClientRect();
        return { width: box.width, insideField: box.left >= inputBox.left && box.right <= inputBox.right && box.top >= inputBox.top && box.bottom <= inputBox.bottom, label: document.querySelector(".sidebar-filter label") !== null };
      })(),
      clear: clear ? { accessibleName: clear.getAttribute("aria-label"), width: clearBox!.width, height: clearBox!.height, glyphContrast: svg ? contrast(over(rgba(getComputedStyle(svg).color), background(clear)), background(clear)) : null } : null,
      selectedNote: [...document.querySelectorAll(".sidebar-filter-note")].map((el) => text(el)),
      contextWorkspace: [...document.querySelectorAll(".workspace-group.is-filter-context > .workspace-header .workspace-name")].slice(0, 3).map((el) => text(el)),
      contextAgent: [...document.querySelectorAll(".agent-item.is-filter-context .agent-title")].slice(0, 3).map((el) => text(el)),
      matchedWorkspace: [...document.querySelectorAll(".workspace-group:not(.is-filter-context) > .workspace-header .workspace-name")].slice(0, 3).map((el) => text(el)),
      noMatch: text(document.querySelector(".sidebar-filter-empty")),
      agentNoteGap: [...document.querySelectorAll(".agent-item .sidebar-filter-note")].map((note) => Math.round((note.getBoundingClientRect().left - note.closest(".agent-item")!.querySelector(".agent-title")!.getBoundingClientRect().right) * 10) / 10),
      inputEdge: edge(input),
      rosterWorkspace: text(document.querySelector(".machine-group:not([hidden]) .workspace-group > .workspace-header .workspace-name")),
      rosterAgent: text(document.querySelector(".agents-sidebar .agent-item .agent-title")),
      offlineWorkspace: text(document.querySelector(".machine-group.is-offline:not([hidden]) .workspace-name")),
      offlineAgent: text(document.querySelector(".agent-item.is-offline .agent-title")),
      noSavedSessions: text(document.querySelector(".machine-group:not([hidden]) .machine-empty")),
      stateWord: text(document.querySelector(".machine-group:not([hidden]) .machine-state:not(.visually-hidden) .machine-state-word")),
      noMatchRole: document.querySelector(".sidebar-filter-empty")?.getAttribute("role") ?? null,
      search: document.querySelector(".sidebar-filter")?.getAttribute("role") ?? null,
    };
  });
}

/**
 * Whether the browser draws its suggestions picker arrow in the focused field: the arrow is an element of the
 * input's user-agent shadow tree (pierced by CDP), and a box model exists only for one that is drawn.
 */
async function pickerArrowDrawn(page: Page): Promise<boolean> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
    type DomNode = { nodeId: number; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[]; contentDocument?: DomNode };
    const found: number[] = [];
    const walk = (node: DomNode, inField: boolean): void => {
      const attributes = node.attributes ?? [];
      const field = inField || attributes.some((value) => value.split(" ").includes("sidebar-filter-input"));
      if (field && attributes.includes("-webkit-calendar-picker-indicator")) found.push(node.nodeId);
      for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child, field);
    };
    walk(root as DomNode, false);
    assert.ok(found.length > 0, "the field's picker arrow element is in its shadow tree, so its absence from the layout can be checked");
    for (const nodeId of found) {
      try { await session.send("DOM.getBoxModel", { nodeId }); return true; } catch { /* no box: not drawn */ }
    }
    return false;
  } finally { await session.detach(); }
}

/** AA for the filter's own words (4.5:1 for text, 3:1 for the clear's glyph) and a finger's 44 px clear on a phone */
function assertMeasured(m: Record<string, any>, phone: boolean, name: string): void {
  const texts = [m["input"], m["input"]?.placeholder, ...m["selectedNote"], ...m["contextWorkspace"], ...m["contextAgent"], m["noMatch"]].filter(Boolean);
  for (const t of texts) assert.ok(t.contrast >= 4.5, `${name}: "${t.text}" has contrast ${t.contrast}, below 4.5:1`);
  if (m["clear"]) {
    assert.ok(m["clear"].glyphContrast >= 3, `${name}: the clear's glyph has contrast ${m["clear"].glyphContrast}, below 3:1`);
    if (phone) assert.ok(m["clear"].width >= 44 && m["clear"].height >= 44, `${name}: the clear is ${m["clear"].width}x${m["clear"].height}, under 44 px`);
  }
  assert.ok(m["input"].accessibleName, `${name}: the field has an accessible name`);
  assert.ok(m["glass"]?.insideField && m["glass"].width > 0, `${name}: the field's glass sits inside it`);
  assert.equal(m["glass"].label, false, `${name}: no word labels the field beside it`);
  assert.equal(m["input"].placeholderText, m["input"].accessibleName, `${name}: the placeholder says what the field's name does`);
  assert.ok(m["input"].suggestions > 0, `${name}: the field offers the rows' names as suggestions`);
  for (const gap of m["agentNoteGap"]) assert.ok(gap >= 4, `${name}: an agent row's Selected tag stands ${gap} px from its title`);
}

const measurements: Record<string, unknown> = {};

function report(name: string, body: unknown): void {
  if (name.startsWith("measurements-")) measurements[name.slice("measurements-".length)] = body;
  if (!evidence) return;
  mkdirSync(evidence, { recursive: true });
  writeFileSync(join(evidence, `sidebar-filter-${name}.json`), JSON.stringify(body, null, 2));
}

const subsequence = <T>(shown: readonly T[], original: readonly T[]): boolean => {
  let at = 0;
  for (const item of shown) {
    at = original.indexOf(item, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
};

const repoKeyOf = (page: Page, workspaceId: string) => page.evaluate((id) => {
  const roster = (window as unknown as { sidebarFilterFixture: { roster(): { snapshot: { workspaces: { workspace_id: string; worktree?: { repo_key: string } | null }[] } }[] } }).sidebarFilterFixture.roster();
  return roster[0]!.snapshot.workspaces.find((workspace) => workspace.workspace_id === id)?.worktree?.repo_key ?? null;
}, workspaceId);

/**
 * A phone is a touch screen: its shot hides the pointer by moving it away, and a held pointer moved over a list
 * that scrolls is a pan, which a touch screen never turns into a tap; so the pressed look is the browser's own
 * :active, forced on the clear for the shot, and the clear is then tapped.
 */
async function pressClear(page: Page, scene: Scene): Promise<void> {
  const box = (await clearButton(page).boundingBox())!;
  if (!scene.phone) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await capture(page, scene, "pressed-clear");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.up();
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".sidebar-filter-clear" });
    await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["active"] });
    await capture(page, scene, "pressed-clear");
    await session.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
  } finally { await session.detach(); }
  await clearButton(page).tap();
}

async function happyPath(browser: Browser, scene: Scene): Promise<void> {
  const name = `${scene.phone ? "phone" : "desktop"} ${scene.theme}`;
  const pins = JSON.stringify([`local:workspace:w1H`, `build:${panes.omp}`]);
  const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`, { "ovis:sidebar-agent-pins": pins });
  try {
    const before = await rosterView(page);
    const storageBefore = await storageView(page);
    assert.equal(before.groups.map((group) => group.name).join(","), "Laptop,Build PC", `${name}: two connected PCs`);
    assert.ok(before.groups[0]!.workspaces.some((row) => row.id === "w1H" && row.pinned), `${name}: the flaky worktree is pinned on the laptop`);
    assert.ok(before.agents.some((row) => row.machine === "build" && row.pane === panes.omp && row.pinned), `${name}: the build PC's omp agent is pinned`);
    assert.equal(before.selectedPane, WEB, `${name}: the web pane is selected`);
    await capture(page, scene, "rest");
    report(`measurements-rest-${scene.phone ? 390 : 1440}-${scene.theme}`, await measure(page));
    if (!scene.phone) {
      await workspaceRows(page).first().hover();
      await capture(page, scene, "hover-row");
    }
    const input = filterInput(page);
    assert.equal(await input.inputValue(), "", `${name}: the filter starts empty`);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("sidebar-filter-input") ?? false), false, `${name}: opening the list does not focus the filter`);
    await input.click();
    await capture(page, scene, "focus-visible");
    await input.pressSequentially("flky");
    await waitWorkspaceIds(page, 'ids.join(",") === "w1H,w1C,w1D,w1C,w1H" && agents.length === 3');
    const during = await rosterView(page);
    assert.ok(during.activeIsFilter, `${name}: typing keeps the focus in the field`);
    assert.equal(during.selectedPane, WEB, `${name}: filtering changes no selection`);
    const laptop = during.groups[0]!, build = during.groups[1]!;
    assert.equal(laptop.name, "Laptop"); assert.equal(build.name, "Build PC");
    assert.deepEqual(laptop.workspaces.map((row) => [row.id, row.pinned, row.nested, row.context, row.note]), [["w1H", true, false, false, null], ["w1C", false, false, true, null], ["w1D", false, true, true, "Selected"]], `${name}: laptop rows under the filter`);
    assert.deepEqual(build.workspaces.map((row) => [row.id, row.nested, row.context]), [["w1C", false, true], ["w1H", true, false]], `${name}: build PC rows under the filter`);
    assert.deepEqual(during.agents.map((row) => [row.machine, row.pane, row.pinned, row.context, row.note]), [["local", WEB, false, true, "Selected"], ["local", panes.flaky, false, false, null], ["build", panes.flaky, false, false, null]], `${name}: agent rows under the filter`);
    assert.ok(subsequence(laptop.workspaces.filter((row) => !row.pinned).map((row) => row.id), before.groups[0]!.workspaces.filter((row) => !row.pinned).map((row) => row.id)), `${name}: laptop rows keep their order`);
    assert.ok(subsequence(during.agents.map((row) => `${row.machine}:${row.pane}`), before.agents.map((row) => `${row.machine}:${row.pane}`)), `${name}: agent rows keep their order`);
    assert.ok(laptop.workspaces.every((row) => row.draggable !== "true" && row.shortcuts === null), `${name}: no row can be moved while the filter is on`);
    assert.ok(during.agentsExpanded && during.agents.every((row) => row.visible), `${name}: every kept agent row is visible: ${JSON.stringify(during.agents)}`);
    if (scene.phone) assert.equal(before.agentsExpanded, false, `${name}: a phone's Agents list starts folded`);
    assert.equal(await pickerArrowDrawn(page), false, `${name}: the browser's suggestions arrow is not drawn beside the clear`);
    await capture(page, scene, "typing");
    const measured = await measure(page);
    assertMeasured(measured, scene.phone, name);
    report(`measurements-typing-${scene.phone ? 390 : 1440}-${scene.theme}`, measured);
    if (!scene.phone) { await clearButton(page).hover(); await capture(page, scene, "hover-clear"); }
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("sidebar-filter-clear")), true, `${name}: Tab reaches the clear`);
    await capture(page, scene, "focus-visible-clear");
    const clearBox = await clearButton(page).boundingBox();
    assert.ok(clearBox && (!scene.phone || (clearBox.width >= 44 && clearBox.height >= 44)), `${name}: the clear is a finger's size on a phone: ${JSON.stringify(clearBox)}`);
    await pressClear(page, scene);
    await waitWorkspaceIds(page, `ids.length === ${before.groups.reduce((sum, group) => sum + group.workspaces.length, 0)}`);
    const after = await rosterView(page);
    assert.deepEqual(after, { ...before, activeIsFilter: true }, `${name}: clearing brings every row, fold and pin back as it was`);
    assert.equal(await input.inputValue(), "", `${name}: the clear empties the field`);
    assert.ok(after.activeIsFilter, `${name}: the clear hands the focus back to the field`);
    await capture(page, scene, "empty-query");
    await input.pressSequentially("opstl");
    await waitWorkspaceIds(page, 'ids.length < 11 && ids.includes("w1J")');
    await page.keyboard.press("Escape");
    await waitWorkspaceIds(page, `ids.length === ${before.groups.reduce((sum, group) => sum + group.workspaces.length, 0)}`);
    assert.equal(await input.inputValue(), "", `${name}: Escape clears the field`);
    assert.deepEqual(await rosterView(page), { ...before, activeIsFilter: true }, `${name}: Escape brings the roster back too`);
    if (scene.phone) {
      assert.equal(await page.locator(".sidebar.is-open").count(), 1, `${name}: Escape in a field with words leaves the drawer open`);
      await page.keyboard.press("Escape");
      await page.locator(".sidebar.is-open").waitFor({ state: "detached" });
      await openDrawer(page, scene.language);
    }
    const storageAfter = await storageView(page);
    assert.deepEqual(storageAfter, storageBefore, `${name}: a filter writes nothing to storage`);
    const transport = await transportText(page);
    assert.ok(!transport.text.includes("flky") && !transport.text.includes("opstl"), `${name}: the query never leaves the page`);
    assert.equal(transport.focus, 0, `${name}: nothing called pane.focus`);
    assert.equal(transport.moves, 0, `${name}: nothing moved a workspace`);
    assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    report(`temporary-roster-filter-${scene.phone ? 390 : 1440}-${scene.theme}`, { scene, before, during, after, storageUnchanged: true, transport: { focus: transport.focus, moves: transport.moves, carriesQuery: false } });
    console.log(`PASS ${name}: a fuzzy query keeps matching rows, their ancestors and the selection on both PCs, in order with pins; clear and Escape bring the roster back`);
  } finally { await context.close(); }
}

async function selectedNonMatch(browser: Browser, scene: Scene): Promise<void> {
  const name = `${scene.phone ? "phone" : "desktop"} ${scene.theme}${scene.language === "ko" ? " ko" : ""}`;
  const probe = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`);
  const repoKey = await repoKeyOf(probe.page, "w1C");
  await probe.context.close();
  assert.ok(repoKey, `${name}: the demo's checkout-api is a repository`);
  const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`, { [`ovis:worktree-group-collapsed:local:${repoKey}`]: "1" });
  try {
    const before = await rosterView(page);
    const storageBefore = await storageView(page);
    const head = before.groups[0]!.workspaces.find((row) => row.id === "w1C")!;
    assert.ok(head.folded, `${name}: the checkout-api group starts folded`);
    assert.deepEqual(before.groups[0]!.workspaces.filter((row) => row.nested && (row.id === "w1D" || row.id === "w1H")).map((row) => row.id), ["w1D"], `${name}: only the selected worktree shows under the fold`);
    const input = filterInput(page);
    await input.click();
    await input.pressSequentially("zzqx");
    await page.locator(".sidebar-filter-empty").waitFor();
    const during = await rosterView(page);
    assert.equal(during.empty, scene.language === "ko" ? "일치하는 워크스페이스나 에이전트가 없습니다\n다른 단어로 찾거나 필터를 지우세요." : "No workspaces or agents match\nTry other words, or clear the filter.", `${name}: the lists say nothing matched`);
    assert.deepEqual(during.groups.map((group) => [group.name, group.context]), [["Laptop", true]], `${name}: only the selected PC stays, as context`);
    assert.deepEqual(during.groups[0]!.workspaces.map((row) => [row.id, row.nested, row.selected, row.context, row.note]), [["w1C", false, false, true, null], ["w1D", true, true, true, scene.language === "ko" ? "선택됨" : "Selected"]], `${name}: the selected worktree and its head stay, the selected one said in words`);
    assert.deepEqual(during.agents.map((row) => [row.pane, row.selected, row.context, row.note, row.visible]), [[WEB, true, true, scene.language === "ko" ? "선택됨" : "Selected", true]], `${name}: the selected agent row stays, said in words, and is drawn`);
    assert.ok(await page.locator(".workspace-group.is-selected").evaluate((row) => row.getClientRects().length > 0), `${name}: the selected workspace row is drawn`);
    assert.equal(during.selectedPane, WEB, `${name}: the selection is unchanged`);
    assert.ok(during.activeIsFilter, `${name}: the focus stays in the field`);
    assert.ok(during.groups[0]!.workspaces[0]!.folded, `${name}: the fold itself is not written open`);
    await capture(page, scene, "zero-matches");
    const measured = await measure(page);
    assertMeasured(measured, scene.phone, name);
    report(`measurements-zero-matches-${scene.phone ? 390 : 1440}-${scene.theme}${scene.language === "ko" ? "-ko" : ""}`, measured);
    await clearButton(page).click();
    await input.pressSequentially("flaky");
    await waitWorkspaceIds(page, 'ids.join(",") === "w1C,w1D,w1H,w1C,w1H"');
    const revealed = await rosterView(page);
    assert.equal(revealed.groups[0]!.workspaces.find((row) => row.id === "w1C")!.folded, false, `${name}: a match in a folded group opens it for the filter's time`);
    assert.deepEqual(revealed.groups[0]!.workspaces.filter((row) => row.selected).map((row) => [row.id, row.context, row.note]), [["w1D", true, scene.language === "ko" ? "선택됨" : "Selected"]], `${name}: among matches the selected non-match is said in words`);
    if (scene.language === "ko") await capture(page, scene, "retained-selection");
    assert.deepEqual(await storageView(page), storageBefore, `${name}: the fold and everything else in storage stay as they were`);
    if (scene.phone) {
      await closeDrawer(page);
      await openDrawer(page, scene.language);
      assert.equal(await input.inputValue(), "", `${name}: closing the drawer clears the filter`);
      await waitWorkspaceIds(page, `ids.length === ${before.groups.reduce((sum, group) => sum + group.workspaces.length, 0)}`);
      assert.deepEqual(await rosterView(page), before, `${name}: the roster is back after the drawer closed`);
      await input.click();
      await input.pressSequentially("zzqx");
      await page.locator(".sidebar-filter-empty").waitFor();
    }
    const transport = await transportText(page);
    assert.ok(!transport.text.includes("zzqx") && !transport.text.includes("flaky"), `${name}: the query is in no request, frame or address`);
    const stored = await storageView(page);
    assert.ok(!JSON.stringify(stored).includes("zzqx"), `${name}: the query is in no storage`);
    await page.reload();
    await page.locator(".conn-live").waitFor({ state: "attached" });
    if (scene.phone) await openDrawer(page, scene.language);
    await agentRows(page).first().waitFor({ state: "attached" });
    await page.waitForFunction(() => document.querySelectorAll(".machine-list .machine-group").length >= 2);
    await turnEnded(page);
    assert.equal(await filterInput(page).inputValue(), "", `${name}: a reload starts with an empty filter`);
    assert.equal(await page.locator(".sidebar-filter-empty").count(), 0, `${name}: nothing says no match after a reload`);
    assert.deepEqual(await rosterView(page), before, `${name}: the roster is back after a reload`);
    assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    report(`selected-nonmatch-${scene.phone ? 390 : 1440}-${scene.theme}${scene.language === "ko" ? "-ko" : ""}`, { scene, repoKey, before, during, revealed, storageUnchanged: true, queryInTransport: false, queryInStorage: false, reloadEmpty: true });
    console.log(`PASS ${name}: a query with no match keeps the selected row and its head, said in words, and the query dies with the drawer and the page`);
  } finally { await context.close(); }
}

async function openWorktreeUnderFilter(browser: Browser, scene: Scene): Promise<void> {
  const name = `${scene.phone ? "phone" : "desktop"} ${scene.theme}`;
  const probe = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`);
  const repoKey = await repoKeyOf(probe.page, "w1C");
  await probe.context.close();
  const foldKey = `ovis:worktree-group-collapsed:local:${repoKey}`;
  const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`, { [foldKey]: "1" });
  try {
    const input = filterInput(page);
    await input.click();
    await input.pressSequentially("checkout-api");
    await page.waitForFunction(() => document.querySelector('.workspace-group[data-workspace="w1C"]') !== null);
    const head = page.getByRole("region", { name: "PC Laptop" }).locator('.workspace-group[data-workspace="w1C"] > .workspace-header').first();
    if (scene.phone) {
      await head.locator(".row-menu-toggle").tap();
      await sheetRisen(page, ".row-sheet");
      await page.locator(".row-sheet").getByRole("button", { name: "Open worktree…", exact: true }).tap();
    } else {
      await head.locator(".workspace-select").click({ button: "right" });
      await page.getByRole("menu").getByRole("menuitem", { name: "Open worktree…", exact: true }).click();
    }
    const dialog = page.locator(".worktree-modal");
    await sheetRisen(page, ".worktree-modal");
    await dialog.locator(".worktree-row:not([disabled])").first().click();
    await dialog.waitFor({ state: "detached" });
    assert.equal((await storageView(page)).local[foldKey], "1", `${name}: opening a checkout under the filter writes no fold`);
    if (scene.phone && await page.locator(".sidebar.is-open").count() === 0) await openDrawer(page);
    if (await input.inputValue() !== "") await clearButton(page).click();
    await waitRoster(page, "the group folded again as saved", (view) => view.groups[0]!.workspaces.find((row) => row.id === "w1C")?.folded === true);
    assert.equal((await storageView(page)).local[foldKey], "1", `${name}: cleared, the saved fold is still there`);
    assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    console.log(`PASS ${name}: a checkout opened from its dialog under the filter leaves the saved fold, which is back when the filter is cleared`);
  } finally { await context.close(); }
}

async function liveOfflineRoster(browser: Browser, scene: Scene): Promise<void> {
  const name = `${scene.phone ? "phone" : "desktop"} ${scene.theme}`;
  const pins = JSON.stringify([`local:workspace:w1K`, `build:${panes.omp}`]);
  const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}&long=1&loading=1&error=1`, { "ovis:sidebar-agent-pins": pins });
  try {
    const before = await rosterView(page);
    const storageBefore = await storageView(page);
    assert.deepEqual(before.groups.map((group) => group.name), ["Laptop", "Build PC", "Old PC", "Rack PC"], `${name}: two connected PCs, one loading, one in error`);
    await page.locator(".machine-list .workspace-group", { hasText: LONG_LABEL }).first().scrollIntoViewIfNeeded();
    await capture(page, scene, "long-labels");
    await machineGroup(page, "Old PC").evaluate((group) => group.scrollIntoView({ block: "start" }));
    await capture(page, scene, "loading-pc");
    await machineGroup(page, "Rack PC").evaluate((group) => group.scrollIntoView({ block: "start" }));
    await capture(page, scene, "error-pc");
    report(`measurements-error-pc-${scene.phone ? 390 : 1440}-${scene.theme}`, await measure(page));
    await page.evaluate(() => { const list = document.querySelector<HTMLElement>(".machine-list"); if (list) list.scrollTop = 0; });
    const input = filterInput(page);
    await input.click();
    await input.pressSequentially("tols");
    await waitWorkspaceIds(page, 'ids.join(",") === "w1K,w1C,w1D,w1J,w1L,w1J,w1K,w1L"');
    const filtered = await rosterView(page);
    assert.deepEqual(filtered.groups.map((group) => [group.name, group.context]), [["Laptop", false], ["Build PC", false], ["Old PC", true], ["Rack PC", true]], `${name}: the PCs that have not answered stay as context`);
    assert.ok(filtered.agents[0]!.machine === "build" && filtered.agents[0]!.pane === panes.omp && filtered.agents[0]!.pinned, `${name}: the pinned build agent keeps its card, first`);
    assert.deepEqual(filtered.agents.map((row) => `${row.machine}:${row.pane}`), [`build:${panes.omp}`, `local:${WEB}`, `local:${panes.omp}`, `local:${panes.cli}`, `local:${panes.hermes}`, `build:${panes.cli}`, `build:${panes.hermes}`], `${name}: the selected agent and the agents of the matched repositories, in order`);
    await capture(page, scene, "retained-selection");
    await page.locator(".machine-group", { has: page.locator(".machine-name", { hasText: "Rack PC" }) }).scrollIntoViewIfNeeded();
    await capture(page, scene, "pending-pcs-filtered");
    await page.evaluate(() => { const list = document.querySelector<HTMLElement>(".machine-list"); if (list) list.scrollTop = 0; });
    await fixture(page, `relabelPane("build", ${JSON.stringify(panes.api)}, "Toolsmith review")`);
    await waitWorkspaceIds(page, 'agents.includes("build:' + panes.api + '")');
    await fixture(page, `relabelWorkspace("build", "w1J", "ops-kit")`);
    await waitWorkspaceIds(page, 'ids.join(",") === "w1K,w1C,w1D,w1J,w1L,w1C"');
    const relabelled = await rosterView(page);
    assert.ok(relabelled.agents.some((row) => row.machine === "build" && row.pane === panes.api && row.title === "Toolsmith review"), `${name}: a relabelled pane is listed by its new label`);
    assert.deepEqual(relabelled.groups[1]!.workspaces.map((row) => [row.id, row.context]), [["w1C", true]], `${name}: the build PC shows the new match's head as context and nothing of the renamed repository`);
    await fixture(page, `removePane("local", ${JSON.stringify(panes.hermes)})`);
    await waitWorkspaceIds(page, 'ids.join(",") === "w1K,w1C,w1D,w1J,w1C"');
    const removed = await rosterView(page);
    assert.ok(!removed.agents.some((row) => row.machine === "local" && row.pane === panes.hermes), `${name}: a removed pane's agent row is gone too`);
    assert.deepEqual(await storageView(page), storageBefore, `${name}: the removal prunes no pin and writes no fold`);
    await fixture(page, `disconnect("build")`);
    const buildGroup = machineGroup(page, "Build PC");
    await page.locator(".machine-list .machine-group.is-offline", { has: page.locator(".machine-name", { hasText: "Build PC" }) }).waitFor();
    const offline = await rosterView(page);
    const build = offline.groups.find((group) => group.name === "Build PC")!;
    assert.ok(build.offline, `${name}: the build PC's group says it is offline`);
    assert.ok(build.workspaces.length > 0, `${name}: its cached rows are still listed under the filter`);
    assert.ok(offline.agents.filter((row) => row.machine === "build").every((row) => row.offline), `${name}: its agent rows are drawn offline`);
    assert.equal(await buildGroup.locator(".machine-state-word").textContent(), "Disconnected", `${name}: the state word says Disconnected`);
    assert.ok(await buildGroup.locator(".machine-offline[inert]").count() >= 1, `${name}: its workspace rows are inert`);
    await capture(page, scene, "offline-pc");
    report(`measurements-offline-pc-${scene.phone ? 390 : 1440}-${scene.theme}`, await measure(page));
    await clearButton(page).click();
    await input.pressSequentially("home/demo");
    await page.locator(".sidebar-filter-empty").waitFor();
    const pathOnly = await rosterView(page);
    assert.deepEqual(pathOnly.groups.map((group) => group.name), ["Laptop", "Old PC", "Rack PC"], `${name}: a path's words reach no row; the selected PC and the PCs that have not answered stay`);
    assert.equal(pathOnly.empty, "No workspaces or agents match on the PCs that answered\nTry other words, or clear the filter.", `${name}: the line says only the PCs that answered were searched`);
    await clearButton(page).click();
    await waitWorkspaceIds(page, 'ids.includes("w1C") && ids.length >= 6');
    assert.deepEqual(await storageView(page), storageBefore, `${name}: nothing in storage changed through all of it`);
    const transport = await transportText(page);
    assert.equal(transport.focus, 0, `${name}: nothing called pane.focus`);
    assert.equal(transport.moves, 0, `${name}: nothing moved a workspace`);
    assert.ok(!transport.text.includes("tols"), `${name}: no query left the page`);
    await input.pressSequentially("e");
    await page.locator(".sidebar-filter-clear").waitFor();
    await page.evaluate(() => { const list = document.querySelector<HTMLElement>(".machine-list"); if (list) list.scrollTop = list.scrollHeight; });
    if (!scene.phone) await page.mouse.move(1400, 880);
    await capture(page, scene, "list-end");
    if (await page.locator(".agent-section-toggle[aria-expanded=\"false\"]").count() > 0) await page.locator(".agent-section-toggle").click();
    await page.locator(".agent-list-contents:not([hidden]) .agent-item").first().waitFor();
    await page.evaluate(() => { const list = document.querySelector<HTMLElement>(".agent-list-contents"); if (list) list.scrollTop = list.scrollHeight; });
    await capture(page, scene, "agents-end");
    const fieldBox = await input.boundingBox();
    await input.fill(LONG_LABEL + LONG_TITLE);
    assert.deepEqual(await input.boundingBox(), fieldBox, `${name}: a long query does not resize the field`);
    await capture(page, scene, "long-query");
    assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    report(`live-offline-roster-${scene.phone ? 390 : 1440}-${scene.theme}`, { scene, before, filtered, relabelled, removed, offline, storageUnchanged: true, transport: { focus: transport.focus, moves: transport.moves, carriesQuery: false } });
    console.log(`PASS ${name}: live label changes, a removed row and a PC gone offline show through the filter; folds and pins stay; a path never matches`);
  } finally { await context.close(); }
}

const machineGroup = (page: Page, pc: string): Locator => page.locator(".machine-list .machine-group", { has: page.locator(".machine-name", { hasText: pc }) });
const groupRows = (view: Awaited<ReturnType<typeof rosterView>>, pc: string) => view.groups.find((group) => group.name === pc)?.workspaces.map((row) => row.id) ?? null;

async function waitRoster(page: Page, what: string, predicate: (view: Awaited<ReturnType<typeof rosterView>>) => boolean): Promise<Awaited<ReturnType<typeof rosterView>>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const view = await rosterView(page);
    if (predicate(view)) return view;
    if (Date.now() > deadline) throw new Error(`the roster never showed ${what}: ${JSON.stringify(view)}`);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  }
}

async function foldTransitions(browser: Browser, scene: Scene): Promise<void> {
  const name = `${scene.phone ? "phone" : "desktop"} ${scene.theme}`;
  const results: Record<string, unknown> = {};
  {
    const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`);
    try {
      const input = filterInput(page);
      await page.waitForFunction(() => document.querySelectorAll('.machine-list .machine-group .workspace-group[data-branch="docs/changelog"]').length >= 2);
      await input.fill("docs/changelog");
      const first = await waitRoster(page, "docs/changelog on both PCs", (view) => (groupRows(view, "Build PC") ?? []).includes("w1L") && (groupRows(view, "Laptop") ?? []).includes("w1L"));
      await input.fill("zzqx");
      const none = await waitRoster(page, "only the selected PC", (view) => view.groups.map((group) => group.name).join(",") === "Laptop" && view.empty !== null);
      await input.fill("docs/changelog");
      const again = await waitRoster(page, "docs/changelog on both PCs again", (view) => (groupRows(view, "Build PC") ?? []).includes("w1L") && (groupRows(view, "Laptop") ?? []).includes("w1L"));
      assert.deepEqual(groupRows(again, "Build PC"), groupRows(first, "Build PC"), `${name}: a PC hidden by one query is found by its branch in the next`);
      results["branchAfterNoMatch"] = { first, none, again };
      await clearButton(page).click();
      const storageBefore = await storageView(page);
      await machineGroup(page, "Laptop").getByRole("button", { name: "Collapse worktrees of checkout-api", exact: true }).click();
      const foldedRest = await waitRoster(page, "checkout-api folded", (view) => view.groups[0]!.workspaces.find((row) => row.id === "w1C")?.folded === true);
      assert.ok(!(groupRows(foldedRest, "Laptop") ?? []).includes("w1H"), `${name}: the folded group hides its other worktree`);
      const storageFolded = await storageView(page);
      await input.fill("checkout-api");
      const parentMatch = await waitRoster(page, "flaky-retry-test under the matched head", (view) => (groupRows(view, "Laptop") ?? []).includes("w1H") && (groupRows(view, "Build PC") ?? []).includes("w1H"));
      assert.equal(parentMatch.groups[0]!.workspaces.find((row) => row.id === "w1C")!.folded, false, `${name}: a matching parent opens its fold`);
      await machineGroup(page, "Laptop").getByRole("button", { name: "Collapse worktrees of checkout-api", exact: true }).click();
      const heldFold = await waitRoster(page, "checkout-api folded by its caret", (view) => view.groups[0]!.workspaces.find((row) => row.id === "w1C")?.folded === true);
      assert.ok(!(groupRows(heldFold, "Laptop") ?? []).includes("w1H"), `${name}: the caret folds the group while filtering`);
      assert.deepEqual(await storageView(page), storageFolded, `${name}: folding under the filter writes nothing`);
      await clearButton(page).click();
      const cleared = await waitRoster(page, "the saved fold back", (view) => view.groups[0]!.workspaces.find((row) => row.id === "w1C")?.folded === true && view.groups.length === 2);
      assert.deepEqual(groupRows(cleared, "Laptop"), groupRows(foldedRest, "Laptop"), `${name}: clearing brings the saved fold back`);
      await machineGroup(page, "Laptop").getByRole("button", { name: "Expand worktrees of checkout-api", exact: true }).click();
      await waitRoster(page, "checkout-api open", (view) => view.groups[0]!.workspaces.find((row) => row.id === "w1C")?.folded === false);
      assert.deepEqual(await storageView(page), storageBefore, `${name}: the unfiltered caret writes and clears its fold as before`);
      results["parentMatch"] = { foldedRest, parentMatch, heldFold, cleared };
      assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`, { "ovis:pc-collapsed:local": "1" });
    try {
      const folds = async () => Object.fromEntries(Object.entries((await storageView(page)).local).filter(([key]) => key.includes("collapsed")));
      const foldsBefore = await folds();
      assert.equal(foldsBefore["ovis:pc-collapsed:local"], "1", `${name}: the laptop's fold is saved`);
      const rest = await rosterView(page);
      assert.ok(rest.groups[0]!.folded && rest.groups[0]!.workspaces.length === 0, `${name}: the laptop starts folded`);
      const input = filterInput(page);
      await input.fill("zzqx");
      const selection = await waitRoster(page, "the selected context under the folded laptop", (view) => view.empty !== null && (groupRows(view, "Laptop") ?? []).join(",") === "w1C,w1D");
      assert.equal(selection.groups[0]!.folded, false, `${name}: a folded PC opens for the selection it holds`);
      assert.ok(await page.locator(".workspace-group.is-selected").evaluate((row) => row.getClientRects().length > 0), `${name}: the selected workspace is drawn`);
      await input.fill("flaky");
      const matched = await waitRoster(page, "flaky under the laptop", (view) => (groupRows(view, "Laptop") ?? []).includes("w1H"));
      await machineGroup(page, "Laptop").locator(".machine-toggle").click();
      const caretFolded = await waitRoster(page, "the laptop folded by its caret", (view) => view.groups[0]!.folded && view.groups[0]!.workspaces.length === 0);
      await machineGroup(page, "Laptop").locator(".machine-toggle").click();
      const caretOpened = await waitRoster(page, "the laptop opened by its caret", (view) => !view.groups[0]!.folded && (groupRows(view, "Laptop") ?? []).includes("w1H"));
      await page.locator(".agent-section-toggle").click();
      const agentsFolded = await waitRoster(page, "the Agents list folded", (view) => !view.agentsExpanded && view.agents.every((row) => !row.visible));
      await page.locator(".agent-section-toggle").click();
      await waitRoster(page, "the Agents list open", (view) => view.agentsExpanded && view.agents.every((row) => row.visible));
      assert.deepEqual(await folds(), foldsBefore, `${name}: no caret under the filter wrote a fold`);
      await clearButton(page).click();
      const cleared = await waitRoster(page, "the saved PC fold back", (view) => view.groups.length === 2 && view.groups[0]!.folded);
      assert.deepEqual(cleared, { ...rest, activeIsFilter: true }, `${name}: clearing brings every saved fold back`);
      results["foldedSelectedPc"] = { rest, selection, matched, caretFolded, caretOpened, agentsFolded, cleared };
      assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    } finally { await context.close(); }
  }
  {
    const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`, { "ovis:pc-collapsed:build": "1" });
    try {
      const rest = await rosterView(page);
      assert.ok(rest.groups[1]!.folded && rest.groups[1]!.workspaces.length === 0, `${name}: the build PC starts folded`);
      await filterInput(page).fill("docs/changelog");
      const found = await waitRoster(page, "docs/changelog on the folded build PC", (view) => (groupRows(view, "Build PC") ?? []).includes("w1L"));
      assert.equal(found.groups[1]!.folded, false, `${name}: a branch match opens a PC folded since the page loaded`);
      await clearButton(page).click();
      const cleared = await waitRoster(page, "the build PC folded again", (view) => view.groups.length === 2 && view.groups[1]!.folded);
      assert.equal((await storageView(page)).local["ovis:pc-collapsed:build"], "1", `${name}: its saved fold is untouched`);
      results["branchOnFoldedPc"] = { rest, found, cleared };
      assert.deepEqual(errors, [], `${name}: no uncaught browser errors`);
    } finally { await context.close(); }
  }
  report(`fold-transitions-${scene.phone ? 390 : 1440}-${scene.theme}`, { scene, ...results, storageUnchanged: true });
  console.log(`PASS ${name}: a branch match comes back after a no-match query; parent matches and the selection open folds; carets under the filter fold what is drawn and never the saved fold`);
}

async function observeOnly(browser: Browser, scene: Scene): Promise<void> {
  const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}&watch=1`);
  try {
    const input = filterInput(page);
    await input.click();
    await input.pressSequentially("flaky");
    await waitWorkspaceIds(page, 'ids.join(",") === "w1C,w1D,w1H,w1C,w1H"');
    await capture(page, scene, "observe-only");
    assert.deepEqual(errors, []);
    console.log(`PASS ${scene.phone ? "phone" : "desktop"} ${scene.theme}: the filter works for a device that only watches`);
  } finally { await context.close(); }
}

async function composition(browser: Browser, scene: Scene): Promise<void> {
  const { context, page, errors } = await newPage(browser, scene, `pane=${encodeURIComponent(WEB)}`);
  try {
    const input = filterInput(page);
    await input.click();
    const session = await context.newCDPSession(page);
    try {
      await session.send("Input.imeSetComposition", { text: "플", selectionStart: 1, selectionEnd: 1 });
      await page.waitForFunction(() => (document.querySelector<HTMLInputElement>(".sidebar-filter-input")?.value ?? "") === "플");
      await capture(page, scene, "composition");
      await session.send("Input.insertText", { text: "플" });
    } finally { await session.detach(); }
    assert.deepEqual(errors, []);
    console.log(`PASS ${scene.phone ? "phone" : "desktop"} ${scene.theme}${scene.language === "ko" ? " ko" : ""}: a composition in the field is drawn as typed`);
  } finally { await context.close(); }
}

async function koreanShots(browser: Browser): Promise<void> {
  const scene: Scene = { phone: true, theme: "dark", language: "ko" };
  for (const theme of ["dark", "light"] as const) {
    const current = { ...scene, theme };
    const { context, page, errors } = await newPage(browser, current, `pane=${encodeURIComponent(WEB)}&long=1`);
    try {
      await capture(page, current, "rest");
      report(`measurements-rest-390-${theme}-ko`, await measure(page));
      const input = filterInput(page);
      assert.equal(await input.getAttribute("placeholder"), "워크스페이스와 에이전트 필터", "the field says what it filters in Korean");
      await input.click();
      await input.pressSequentially("flag");
      await waitWorkspaceIds(page, 'ids.includes("w1K") && ids.length < 11');
      report(`korean-typing-390-${theme}`, await rosterView(page));
      await capture(page, current, "typing");
      await page.keyboard.press("Tab");
      await capture(page, current, "focus-visible-clear");
      assert.equal(await clearButton(page).getAttribute("aria-label"), "필터 지우기", "the clear is named in Korean");
      await pressClear(page, current);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
    await selectedNonMatch(browser, current);
    {
      const pending = await newPage(browser, current, `pane=${encodeURIComponent(WEB)}&loading=1&error=1`);
      try {
        await filterInput(pending.page).click();
        await filterInput(pending.page).pressSequentially("zzqx");
        await pending.page.locator(".sidebar-filter-empty").waitFor();
        assert.equal((await rosterView(pending.page)).empty, "응답한 PC에는 일치하는 워크스페이스나 에이전트가\u00a0없습니다\n다른 단어로 찾거나 필터를 지우세요.", "the answered-PCs line in Korean");
        await capture(pending.page, current, "pending-pcs-filtered");
        assert.deepEqual(pending.errors, []);
      } finally { await pending.context.close(); }
    }
  }
}

let url = "";
await withDemoBrowser({ tempPrefix: "herdr-sidebar-filter-", prefix: "/", afterTransport: '<script src="./sidebar-filter.js"></script>' }, async ({ app, browser, baseUrl }) => {
  writeFileSync(join(app, "sidebar-filter.js"), patch);
  url = baseUrl;
  const only = process.env["SIDEBAR_FILTER_CASE"];
  if (!only || only === "en") for (const phone of [false, true]) for (const theme of ["dark", "light"] as const) {
    const scene: Scene = { phone, theme, language: "en" };
    await happyPath(browser, scene);
    await selectedNonMatch(browser, scene);
    await liveOfflineRoster(browser, scene);
    await foldTransitions(browser, scene);
    await openWorktreeUnderFilter(browser, scene);
    await observeOnly(browser, scene);
    await composition(browser, scene);
  }
  if (!only || only === "ko") await koreanShots(browser);
});
if (evidence) writeFileSync(join(evidence, "manifest.json"), JSON.stringify(manifest, null, 2));
if (evidence) writeFileSync(join(evidence, "measurements.json"), JSON.stringify(measurements, null, 2));
