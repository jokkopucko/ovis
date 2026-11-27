/**
 * The desktop app's built-in browser in the demo, with the desktop bridge (app/electron/src/preload.ts
 * ovisBrowser) stood in by the page: the sidebar's Browser group, a tab beside the pane where the app
 * would draw it, taking control of an agent's tab, a new tab of one's own, the tab stepping aside for
 * a dialog, and the settings rows that only the desktop app offers. UI_EVIDENCE_DIR keeps captures.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";

const EVIDENCE = process.env.UI_EVIDENCE_DIR;

type Call = [string, ...unknown[]];

/** the bridge the desktop app's preload gives its own page, kept in the page; `show` paints where the app would draw the tab */
function standInBridge(): void {
  const tab = (id: number, profile: "mine" | "agent", address: string, title: string) => ({ id, profile, address, title, loading: false, canGoBack: false, canGoForward: false, held: false });
  const state = {
    calls: [] as Call[],
    tabs: [tab(1, "agent", "https://mobbin.com/screens/notion", "Notion 로그인"), tab(2, "mine", "http://localhost:5173/", "localhost:5173")],
    listeners: [] as ((browser: unknown) => void)[],
    next: 3,
    /** while set, open() answers only when release() is called: a slow main */
    held: null as null | (() => void),
    holdOpen: false,
  };
  const emit = () => { for (const listener of state.listeners) listener({ tabs: state.tabs.map((entry) => ({ ...entry })) }); };
  const drawn = () => {
    let view = document.getElementById("stand-in-view");
    if (view === null) {
      view = document.createElement("div");
      view.id = "stand-in-view";
      view.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:#fff;border-top:1px solid #e5e5e5;font:14px system-ui;color:#555;padding:24px;box-sizing:border-box";
      document.body.append(view);
    }
    return view;
  };
  (window as unknown as { __browser: typeof state }).__browser = state;
  (window as unknown as { ovisBrowser: unknown }).ovisBrowser = {
    current: async () => ({ tabs: state.tabs.map((entry) => ({ ...entry })) }),
    onChange: (listener: (browser: unknown) => void) => { state.listeners.push(listener); return () => { state.listeners = state.listeners.filter((other) => other !== listener); }; },
    open: async (url: string) => {
      state.calls.push(["open", url]);
      if (state.holdOpen) await new Promise<void>((done) => { state.held = done; });
      const id = state.next++;
      state.tabs.push(tab(id, "mine", url, new URL(url).host));
      emit();
      return id;
    },
    show: (id: number, bounds: { x: number; y: number; width: number; height: number }) => {
      state.calls.push(["show", id, bounds]);
      const view = drawn();
      Object.assign(view.style, { display: "block", left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
      view.textContent = state.tabs.find((entry) => entry.id === id)?.title ?? "";
    },
    hide: () => {
      state.calls.push(["hide"]);
      const view = document.getElementById("stand-in-view");
      if (view) view.style.display = "none";
    },
    close: (id: number) => { state.calls.push(["close", id]); state.tabs = state.tabs.filter((entry) => entry.id !== id); emit(); },
    navigate: async (id: number, url: string) => { state.calls.push(["navigate", id, url]); return true; },
    go: (id: number, step: string) => state.calls.push(["go", id, step]),
    hold: (id: number, held: boolean) => {
      state.calls.push(["hold", id, held]);
      const found = state.tabs.find((entry) => entry.id === id);
      if (found) found.held = held;
      emit();
    },
  };
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __browser: { calls: Call[] } }).__browser.calls.splice(0));

async function open(browser: Browser, origin: string, width: number, theme: "light" | "dark", on: boolean, bridge = true): Promise<Page> {
  const phone = width === 390;
  const context = await appContext(browser, { viewport: { width, height: phone ? 844 : 820 }, ...(phone ? { deviceScaleFactor: 3, isMobile: true, hasTouch: true } : {}), locale: "ko-KR", colorScheme: theme });
  await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), JSON.stringify({ language: "ko", theme, builtInBrowser: on }));
  if (bridge) await context.addInitScript(standInBridge);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?pane=${encodeURIComponent(panes.api)}`);
  await page.locator(".conn-live").waitFor();
  assert.deepEqual(errors, [], `${width} ${theme}: no page errors`);
  return page;
}

async function wide(browser: Browser, origin: string, theme: "light" | "dark"): Promise<void> {
  const tag = `1280 ${theme}`;
  const shot = async (page: Page, name: string) => { if (EVIDENCE && theme === "light") await page.screenshot({ path: join(EVIDENCE, `built-in-browser-${name}-1280-${theme}.png`) }); };

  const before = await open(browser, origin, 1280, theme, false, false);
  assert.equal(await before.getByRole("region", { name: "브라우저", exact: true }).count(), 0, `${tag}: a browser without the desktop app shows no Browser group`);
  await shot(before, "before");
  await before.context().close();

  const page = await open(browser, origin, 1280, theme, true);
  const group = page.getByRole("region", { name: "브라우저", exact: true });
  await group.waitFor();
  assert.deepEqual(await group.locator(".browser-tab").allInnerTexts(), ["Notion 로그인", "localhost:5173"], `${tag}: the group lists the tabs`);

  await group.getByRole("button", { name: /Notion 로그인/ }).click();
  const holder = page.locator(".browser-panel-holder");
  await holder.getByText("에이전트가 쓰는 중", { exact: true }).waitFor();
  const address = page.getByRole("textbox", { name: "주소", exact: true });
  assert.equal(await address.inputValue(), "https://mobbin.com/screens/notion", `${tag}: the panel shows the tab's address`);
  assert.equal(await address.getAttribute("readonly"), "", `${tag}: an agent's tab is only watched until taken`);
  const body = await page.locator(".browser-panel-body").boundingBox();
  const shown = (await calls(page)).filter(([name]) => name === "show").at(-1);
  assert.ok(body && shown, `${tag}: the panel asks the app to draw the tab`);
  const bounds = shown[2] as { x: number; y: number; width: number; height: number };
  assert.equal(shown[1], 1);
  for (const key of ["x", "y", "width", "height"] as const) assert.ok(Math.abs(bounds[key] - body[key]) < 1, `${tag}: the tab is drawn over the panel's body (${key})`);
  await shot(page, "agent-tab");
  await address.press("Enter");
  assert.deepEqual((await calls(page)).filter(([name]) => name === "navigate" || name === "open"), [], `${tag}: Enter in a watched tab's address asks nothing`);
  assert.equal(await page.locator(".browser-panel [aria-invalid=true]").count(), 0, `${tag}: and says nothing is refused`);

  await holder.getByRole("button", { name: "제어 가져오기", exact: true }).click();
  await holder.getByText("내가 제어 중 · 에이전트는 멈춤", { exact: true }).waitFor();
  assert.deepEqual((await calls(page)).filter(([name]) => name === "hold"), [["hold", 1, true]], `${tag}: taking control asks the app once`);
  assert.equal(await address.getAttribute("readonly"), null, `${tag}: a held tab takes an address`);
  await shot(page, "held");
  await holder.getByRole("button", { name: "중지", exact: true }).click();
  await holder.getByText("에이전트가 쓰는 중", { exact: true }).waitFor();

  // the tab view's x goes back to the right panel and keeps the tab; a card there opens it again
  await page.locator(".browser-panel").getByRole("button", { name: "닫기", exact: true }).click();
  const side = page.getByRole("complementary", { name: "브라우저 패널", exact: true });
  await side.waitFor();
  assert.equal((await calls(page)).filter(([name]) => name === "close").length, 0, `${tag}: going back to the panel closes no tab`);
  assert.equal(await group.locator(".browser-tab").count(), 2, `${tag}: the tab stays in the sidebar`);
  await side.getByRole("button", { name: "Notion 로그인 열기", exact: true }).click();
  await holder.getByText("에이전트가 쓰는 중", { exact: true }).waitFor();
  assert.equal(await side.count(), 0, `${tag}: the open tab takes the panel's place`);

  await group.getByRole("button", { name: "새 탭", exact: true }).click();
  const typed = page.getByRole("textbox", { name: "주소", exact: true });
  await page.getByText("주소를 입력하면 내 탭으로 열립니다.", { exact: false }).waitFor();
  await typed.fill("localhost:3000/docs");
  await typed.press("Enter");
  await group.getByRole("button", { name: /localhost:3000/ }).waitFor();
  assert.deepEqual((await calls(page)).filter(([name]) => name === "open"), [["open", "http://localhost:3000/docs"]], `${tag}: a typed address opens a tab of one's own`);
  assert.equal(await group.getByRole("button", { name: /localhost:3000/ }).getAttribute("aria-current"), "true", `${tag}: the new tab is the one shown`);

  // a new tab's form closed before main answers, then another form opened: the late answer does not take it over
  await page.evaluate(() => { (window as unknown as { __browser: { holdOpen: boolean } }).__browser.holdOpen = true; });
  await group.getByRole("button", { name: "새 탭", exact: true }).click();
  await page.getByRole("textbox", { name: "주소", exact: true }).fill("first.example");
  await page.getByRole("textbox", { name: "주소", exact: true }).press("Enter");
  await page.waitForFunction(() => (window as unknown as { __browser: { held: unknown } }).__browser.held !== null);
  await page.locator(".browser-panel").getByRole("button", { name: "닫기", exact: true }).click();
  await group.getByRole("button", { name: "새 탭", exact: true }).click();
  const second = page.getByRole("textbox", { name: "주소", exact: true });
  await second.fill("second.example");
  await page.evaluate(() => { const bridge = (window as unknown as { __browser: { holdOpen: boolean; held: (() => void) | null } }).__browser; bridge.holdOpen = false; bridge.held?.(); });
  await group.getByRole("button", { name: /first\.example/ }).waitFor();
  assert.equal(await second.inputValue(), "second.example", `${tag}: the second form keeps what is typed in it`);
  assert.equal(await group.getByRole("button", { name: /first\.example/ }).getAttribute("aria-current"), null, `${tag}: the dismissed tab is not shown`);
  await group.getByRole("button", { name: /localhost:3000/ }).click();
  await page.getByRole("textbox", { name: "주소", exact: true }).waitFor();

  // a row's x closes that tab
  await group.locator(".browser-tab-row", { hasText: "localhost:5173" }).hover();
  await group.locator(".browser-tab-row", { hasText: "localhost:5173" }).getByRole("button", { name: "탭 닫기", exact: true }).click();
  assert.equal((await calls(page)).filter(([name]) => name === "close").length, 1, `${tag}: the row's x closes its tab`);

  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const settings = page.getByRole("dialog").first();
  await settings.waitFor();
  await page.waitForFunction(() => (window as unknown as { __browser: { calls: Call[] } }).__browser.calls.some(([name]) => name === "hide"));
  await settings.getByText("채팅", { exact: true }).first().click();
  await page.getByRole("switch", { name: "내장 브라우저", exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole("switch", { name: "내장 브라우저", exact: true }).isChecked(), true, `${tag}: the setting row is offered in the desktop app`);
  await page.getByRole("textbox", { name: "차단한 사이트", exact: true }).waitFor();
  await shot(page, "settings");
  // a site typed in and Settings closed with Escape (no blur first) is kept
  await page.getByRole("textbox", { name: "차단한 사이트", exact: true }).fill("tracker.example");
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "detached" });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.getByRole("dialog").first().getByText("채팅", { exact: true }).first().click();
  assert.equal(await page.getByRole("textbox", { name: "차단한 사이트", exact: true }).inputValue(), "tracker.example", `${tag}: a blocked site typed before Escape is kept`);
  // reset to the default empties it once, and Settings stays up
  await page.getByRole("button", { name: "기본값으로 되돌리기: 차단한 사이트", exact: true }).click();
  await page.waitForFunction(() => (document.querySelector('textarea[aria-label="차단한 사이트"]') as HTMLTextAreaElement | null)?.value === "");
  assert.equal(await page.getByText("설정을 표시할 수 없습니다", { exact: false }).count(), 0, `${tag}: Settings stays up after a reset`);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").browserBlockedSites ?? []), [], `${tag}: the reset is kept`);
  await page.context().close();
}

async function crowded(browser: Browser, origin: string): Promise<void> {
  // eight tabs in the Browser group, and the split taken to the PCs' minimum: the first PC row still shows
  const page = await open(browser, origin, 1280, "light", true);
  await page.getByRole("region", { name: "브라우저", exact: true }).waitFor();
  await page.evaluate(() => {
    const bridge = (window as unknown as { __browser: { tabs: Record<string, unknown>[]; listeners: ((view: unknown) => void)[] } }).__browser;
    for (let n = 0; n < 6; n++) bridge.tabs.push({ id: 100 + n, profile: "mine", address: `https://site${n}.example/`, title: `Site ${n}`, loading: false, canGoBack: false, canGoForward: false, held: false });
    for (const listener of bridge.listeners) listener({ tabs: bridge.tabs.map((entry) => ({ ...entry })) });
  });
  await page.locator(".browser-tab", { hasText: "Site 5" }).waitFor();
  const line = page.getByRole("separator", { name: "PC와 에이전트 높이 조절", exact: true });
  await line.focus();
  await page.keyboard.press("Home");
  const listHeight = await page.locator(".machine-list").evaluate((list) => list.getBoundingClientRect().height);
  assert.ok(listHeight >= 24, `1280 crowded: the PC list keeps a row at the split's minimum (${listHeight}px)`);
  assert.ok(await page.locator(".machine-list .workspace-group").first().isVisible(), "1280 crowded: a PC row stays in view");
  await page.context().close();
}

async function middle(browser: Browser, origin: string): Promise<void> {
  // too narrow for a panel beside the pane: no cards that could not open their tab, and no Browser group
  const page = await open(browser, origin, 1280, "light", true);
  const side = page.getByRole("complementary", { name: "브라우저 패널", exact: true });
  await side.waitFor();
  await page.setViewportSize({ width: 900, height: 820 });
  await side.waitFor({ state: "detached" });
  await page.getByRole("region", { name: "브라우저", exact: true }).waitFor({ state: "detached" });
  await page.context().close();
}

async function phone(browser: Browser, origin: string): Promise<void> {
  const page = await open(browser, origin, 390, "light", true);
  assert.equal(await page.getByRole("region", { name: "브라우저", exact: true }).count(), 0, "390: a narrow window has no place beside the pane, so no Browser group");
  await page.context().close();
}

await withDemoBrowser({ tempPrefix: "ovis-built-in-browser-demo-", prefix: "/" }, async ({ browser, baseUrl: origin }) => {
  for (const theme of ["light", "dark"] as const) await wide(browser, origin, theme);
  await crowded(browser, origin);
  await middle(browser, origin);
  await phone(browser, origin);
});
console.log("built-in browser demo regression passed");
