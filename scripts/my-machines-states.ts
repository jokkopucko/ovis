/** The fixture states captured and checked by my-machines-screens-qa.ts. */
import type { Browser, BrowserContext, Page } from "playwright-core";

export interface MyMachinesState {
  readonly name: string;
  readonly query: string;
  /** what a person does to reach the state from the page the query opens */
  readonly reach?: (page: Page) => Promise<void>;
}

const visible = (page: Page, selector: string) => page.locator(`${selector}:visible`).first();
/** Fails the capture when the page shows `selector`: a control the contract took away must not come back. */
const absent = async (page: Page, selector: string, what: string): Promise<void> => {
  if (await page.locator(selector).count() !== 0) throw new Error(`the page shows ${what} (${selector})`);
};
const openAdd = async (page: Page): Promise<void> => { await visible(page, '[data-action="add-machine"]').click(); await page.locator('[data-add-step="choose"]').waitFor(); };
/** Makes the line, and checks the two boxes: a command, then the bare join line, which no command carries. */
const makeLine = async (page: Page): Promise<void> => {
  await openAdd(page);
  await page.locator('[data-action="make-line"]').click();
  await page.locator('[data-add-step="line"]').waitFor();
  const command = await page.locator("[data-join-command]").innerText();
  const line = await page.locator("[data-join-line]").innerText();
  if (!/^ovis-join:1:[A-Za-z0-9_-]+$/.test(line)) throw new Error(`the line box holds more than the line: ${line.slice(0, 40)}`);
  if (command.includes("ovis-join:")) throw new Error(`the command carries the line: ${command}`);
  const members = Object.keys(JSON.parse(atob(line.slice("ovis-join:1:".length).replaceAll("-", "+").replaceAll("_", "/"))) as object).sort().join(",");
  if (members !== "list,secret,service,v") throw new Error(`the line's members are ${members}`);
};
const rowOf = (page: Page, name: string) => page.locator(".acct-row").filter({ has: page.locator(".acct-name-btn", { hasText: new RegExp(`^${name}$`) }) });
const openDetails = async (page: Page, name = "build-01"): Promise<void> => { await rowOf(page, name).locator(".acct-name-btn").click(); await page.locator("[data-machine-details]").waitFor(); };
export const MY_MACHINES_SCREEN_STATES: readonly MyMachinesState[] = [
  // the machine behind is a row of its own that still opens (contract 1 v3, F3.5)
  { name: "machines", query: "account=mixed", reach: async (page) => { await page.locator('.acct-row[data-row-state="needs-update"] [data-row-action="open"]').waitFor(); } },
  { name: "machines-empty", query: "account=empty" },
  { name: "machines-offline", query: "account=offline" },
  { name: "machines-unreachable", query: "account=unreachable" },
  { name: "machines-needs-update", query: "account=needs-update" },
  { name: "machines-joining", query: "account=joining" },
  { name: "machines-today", query: "account=today" },
  { name: "add-terminal", query: "account=today", reach: async (page) => { await visible(page, '[data-action="add-machine"]').click(); await page.locator('[data-add-step="terminal"] [data-add-command]').waitFor(); } },
  { name: "machines-twenty", query: "account=twenty" },
  { name: "machines-watching", query: "account=mixed&viewer=watcher" },
  { name: "machines-behind", query: "account=behind", reach: async (page) => { await page.locator("[data-behind]").waitFor(); await absent(page, '[data-action="add-machine"]', "Add a machine"); } },
  { name: "add-choose", query: "account=mixed", reach: openAdd },
  { name: "add-reusable", query: "account=mixed", reach: async (page) => { await openAdd(page); await page.locator(".add-machine-sheet .segmented > button").nth(1).click(); await page.locator(".add-machine-limit").waitFor(); } },
  { name: "add-line", query: "account=mixed", reach: makeLine },
  { name: "add-line-no-ovis", query: "account=mixed", reach: async (page) => { await makeLine(page); await page.locator(".add-machine-sheet .segmented > button").nth(1).click(); await page.locator("[data-join-command]", { hasText: "--join" }).waitFor(); } },
  { name: "add-line-close", query: "account=mixed", reach: async (page) => { await makeLine(page); await page.locator(".add-machine-footer .btn").click(); await page.locator(".confirm-dialog").waitFor(); } },
  { name: "add-joined", query: "account=mixed", reach: async (page) => { await makeLine(page); await page.evaluate(() => window.qa.join()); await page.locator('[data-add-state="joined"]').waitFor(); } },
  { name: "details", query: "account=mixed", reach: (page) => openDetails(page) },
  { name: "details-needs-update", query: "account=mixed", reach: async (page) => { await openDetails(page, "backup-vault"); await page.locator('[data-action="open-machine"]').waitFor(); await page.locator("[data-machine-list]").waitFor(); } },
];

/** One page to draw: a state at a width, in a theme of a palette and a language. 480 px and under is a phone: touch, a finger for a pointer, two device pixels to one. */
export interface Shot {
  readonly state: MyMachinesState;
  readonly width: number;
  readonly theme: "light" | "dark";
  readonly language: "en" | "ko";
  readonly palette: string;
}

export const isPhone = (shot: Pick<Shot, "width">): boolean => shot.width <= 480;

/** Fonts in, every animation that ends over (a phone's sheet rising), then two frames. */
export const settled = (page: Page): Promise<void> => page.evaluate(() => Promise.all([
  document.fonts.ready,
  ...document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)),
]).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));

export interface OpenedShot {
  readonly context: BrowserContext;
  readonly page: Page;
  /** what went wrong while the page loaded and ran: page errors, console errors, requests that left the fixture server */
  readonly problems: string[];
}

/** Opens a shot's page in a context of its own, which the caller closes, and brings it to the shot's state. */
export async function openShot(browser: Browser, origin: string, shot: Shot): Promise<OpenedShot> {
  const phone = isPhone(shot);
  const context = await browser.newContext({
    viewport: phone ? { width: shot.width, height: 844 } : { width: shot.width, height: 900 }, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone,
    colorScheme: shot.theme, locale: shot.language === "ko" ? "ko-KR" : "en-US", timezoneId: "Asia/Seoul", serviceWorkers: "block",
  });
  const problems: string[] = [];
  try {
    await context.route("**/*", async (route) => {
      if (route.request().url().startsWith(`${origin}/`)) { await route.continue(); return; }
      problems.push(`a request left the fixture server: ${route.request().url()}`);
      await route.abort();
    });
    await context.routeWebSocket(/.*/, (ws) => {
      if (new URL(ws.url()).host === new URL(origin).host) { ws.connectToServer(); return; }
      problems.push(`a WebSocket left the fixture server: ${ws.url()}`);
      ws.close();
    });
    await context.addInitScript(({ language, theme, palette }) => localStorage.setItem("ovis:settings", JSON.stringify({ language, theme, darkTheme: palette, lightTheme: palette })), shot);
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
    page.on("console", (message) => { if (message.type() === "error") problems.push(`console error: ${message.text()}`); });
    await page.goto(`${origin}/?${shot.state.query}`);
    await page.locator(".relay-dash, .relay-shell").first().waitFor();
    await settled(page);
    await shot.state.reach?.(page);
    // the pointer that clicked leaves the page: a row the layout moved under it would show its hover tint
    if (!phone) await page.mouse.move(0, 0);
    await settled(page);
    return { context, page, problems };
  } catch (error) {
    await context.close();
    throw error;
  }
}
