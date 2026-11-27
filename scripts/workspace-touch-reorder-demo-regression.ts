/// <reference types="bun" />
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.

const topRows = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace ?? ""));
const serverOrder = (page: Page) => page.evaluate(async () => ((await (await fetch("/api/session")).json()).snapshot as { workspaces: { workspace_id: string }[] }).workspaces.map((workspace) => workspace.workspace_id));
const centerOf = async (page: Page, id: string) => {
  const box = await page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`).boundingBox();
  assert.ok(box, `row ${id} is on screen`);
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
};
const touch = (cdp: CDPSession, type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", point?: { x: number; y: number }) =>
  cdp.send("Input.dispatchTouchEvent", { type, touchPoints: point ? [{ x: point.x, y: point.y }] : [] });

interface PressProbe { report(): unknown; stop(): void }

/**
 * What a long press that lifted no row met (#4343): what was under the finger and which overlays were open before
 * the press and at the timeout, and every touch, cancel, context menu and scroll in between with what it landed on.
 * It only reads the page.
 */
const armPressProbe = (page: Page, point: { x: number; y: number }) => page.evaluate(({ x, y }) => {
  const started = performance.now();
  const name = (node: EventTarget | null): string => {
    const path: string[] = [];
    for (let element = node instanceof Element ? node : null; element !== null && path.length < 3; element = element.parentElement) {
      path.push(`${element.tagName.toLowerCase()}${[...element.classList].slice(0, 3).map((part) => `.${part}`).join("")}${element instanceof HTMLElement && element.dataset["workspace"] ? `[${element.dataset["workspace"]}]` : ""}`);
    }
    return path.join(" < ") || "nothing";
  };
  const shown = () => ({
    hit: name(document.elementFromPoint(x, y)),
    overlays: [...document.querySelectorAll('.droplet, .modal-scrim, .row-sheet, .row-menu, [role="menu"]')].map((overlay) => `${name(overlay).split(" < ")[0]}${overlay.getAttribute("data-phase") ? `(${overlay.getAttribute("data-phase")})` : ""}`),
    lifted: [...document.querySelectorAll<HTMLElement>(".workspace-group.is-lifted")].map((row) => row.dataset["workspace"] ?? ""),
    scroll: document.querySelector(".machine-list")?.scrollTop ?? null,
  });
  const row = document.elementFromPoint(x, y)?.closest(".workspace-group") ?? null;
  const before = shown();
  const events: string[] = [];
  const note = (event: Event): void => {
    // the chat beside the list scrolls by itself as the demo's turn runs: only the list's own scroll moves a row
    if (event.type === "scroll" && !(event.target instanceof Element && event.target.matches(".machine-list"))) return;
    if (events.length < 40) events.push(`${Math.round(performance.now() - started)}ms ${event.type} ${name(event.target)}${event.defaultPrevented ? " prevented" : ""}`);
  };
  const types = ["touchstart", "touchmove", "touchend", "touchcancel", "pointercancel", "contextmenu", "scroll", "popstate"];
  for (const type of types) window.addEventListener(type, note, { capture: true, passive: true });
  const probe: PressProbe = {
    report: () => ({ point: `${x},${y}`, before, atTimeout: shown(), pressedRowStillInPage: row?.isConnected ?? null, events }),
    stop: () => { for (const type of types) window.removeEventListener(type, note, { capture: true }); },
  };
  (window as unknown as { pressProbe_?: PressProbe }).pressProbe_ = probe;
}, point);

const endPressProbe = (page: Page, failed: boolean) => page.evaluate((failed) => {
  const probe = (window as unknown as { pressProbe_?: PressProbe }).pressProbe_;
  const report = failed ? probe?.report() ?? null : null;
  probe?.stop();
  return report;
}, failed);

async function stroke(page: Page, cdp: CDPSession, from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number, during?: () => Promise<void>): Promise<void> {
  if (holdMs > 0) await armPressProbe(page, from);
  await touch(cdp, "touchStart", from);
  if (holdMs > 0) {
    const missed = await page.locator(".workspace.is-lifted").waitFor({ timeout: 5_000 }).then(() => null, (error: unknown) => error);
    const report = await endPressProbe(page, missed !== null).catch((why: unknown) => ({ unread: String(why) }));
    if (missed !== null) throw new Error(`a long press at ${from.x},${from.y} lifted no row: ${JSON.stringify(report)}`, { cause: missed });
  }
  const steps = 12;
  for (let step = 1; step <= steps; step += 1) {
    await touch(cdp, "touchMove", { x: Math.round(from.x + (to.x - from.x) * step / steps), y: Math.round(from.y + (to.y - from.y) * step / steps) });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  await during?.();
  await touch(cdp, "touchEnd");
}

const pinnedRows = (page: Page) => page.locator(".workspace-list-pinned > .workspace-group").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.workspace));

async function addScratchWorkspace(page: Page): Promise<string> {
  const scratch = await page.evaluate(async () => {
    const response = await fetch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/home/demo/scratch", label: "scratch" }) });
    if (!response.ok) throw new Error(`create demo workspace: ${response.status}`);
    return (await response.json() as { workspace_id: string }).workspace_id;
  });
  await page.locator(`.machine-workspaces .workspace-group[data-workspace="${scratch}"]`).waitFor();
  return scratch;
}

async function checkPinned(page: Page, cdp?: CDPSession): Promise<void> {
  if ((await topRows(page)).length < 3) await addScratchWorkspace(page);
  const before = await topRows(page);
  const ids = before.slice(0, 2);
  assert.equal(ids.length, 2);
  const child = await page.evaluate(async (workspaceId) => {
    const response = await fetch("/api/worktree/create", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, branch: "pinned-reorder-child" }),
    });
    if (!response.ok) throw new Error(`create demo worktree: ${response.status}`);
    return (await response.json() as { workspace_id: string }).workspace_id;
  }, ids[0]);
  await page.locator(`.worktree-children .workspace-group[data-workspace="${child}"]`).waitFor();
  const serverBefore = await serverOrder(page);
  const row = (id: string) => page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`);
  for (const id of ids) {
    if (cdp) await page.locator(`.workspace-group[data-workspace="${id}"] > .workspace-header .row-menu-toggle`).click();
    else await row(id!).click({ button: "right" });
    await page.getByRole(cdp ? "button" : "menuitem", { name: "Pin workspace", exact: true }).click();
  }
  assert.deepEqual(await pinnedRows(page), ids);
  const restRows = () => page.locator(".machine-workspaces .sidebar-list > .workspace-list:not(.workspace-list-pinned) > .workspace-group").evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.workspace));
  const restBefore = await restRows();
  const drag = async (source: string, target: string) => {
    if (cdp) await stroke(page, cdp, await centerOf(page, source), await centerOf(page, target), 1);
    else await row(source).dragTo(row(target));
  };
  await drag(ids[0]!, ids[1]!);
  const expected = [ids[1], ids[0]];
  assert.deepEqual(await pinnedRows(page), expected, "drag changes the pinned card order");
  assert.equal(await page.locator(".workspace-list-pinned .worktree-children").count(), 0, "pinned repository rows do not carry their worktrees into the card");
  const childRow = row(child);
  assert.equal(await childRow.evaluate((element) => element.closest(".sidebar-pinned, .worktree-children") === null), true, "the unpinned worktree stands alone outside the card");
  assert.equal(await childRow.getAttribute("draggable"), "false", "the unpinned worktree stays fixed");
  assert.deepEqual(await restRows(), restBefore, "reordering the pinned repository leaves its worktree at the original rest-list position");
  await row(ids[0]!).focus();
  await page.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await pinnedRows(page), ids, "Alt+Up reorders pinned rows within the card");
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await pinnedRows(page), expected, "Alt+Down restores the pinned order");
  await childRow.focus();
  await page.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await restRows(), restBefore, "Alt+Down cannot move the repository's unpinned worktree");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:sidebar-agent-pins") ?? "[]") as string[]);
  assert.deepEqual(stored.filter((key) => key.includes(":workspace:")).map((key) => key.split(":workspace:")[1]), expected, "the pin list holds the new order");
  const unpinned = before[2]!;
  await drag(ids[0]!, unpinned);
  await drag(unpinned, ids[0]!);
  assert.deepEqual(await pinnedRows(page), expected, "neither direction crosses the pin boundary");
  await drag(ids[0]!, child);
  assert.deepEqual(await pinnedRows(page), expected, "dropping onto the repository's own worktree cannot cross the card edge");
  assert.deepEqual(await restRows(), restBefore, "cross-card drops leave the rest list unchanged");
  assert.deepEqual(await serverOrder(page), serverBefore, "pinned drags never move herdr workspaces");
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, `pinned-reorder-${cdp ? "phone" : "desktop"}.png`) });
  }
  await page.reload();
  await page.locator(".conn-live").waitFor({ state: "attached" });
  const toggle = page.locator('#drawer-toggle');
  if (cdp && await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await page.locator(".workspace-list-pinned").waitFor();
  assert.deepEqual(await pinnedRows(page), expected, "pin order survives reload");
  console.log(`PASS ${cdp ? "touch long press" : "desktop drag"} and Alt+Up/Down reorder saved pins within the card, keep unpinned worktrees fixed outside, preserve herdr order and survive reload`);
}

type Hooks = Record<string, (...args: never[]) => unknown>;
const demo = <T = unknown>(page: Page, name: string, ...args: unknown[]) =>
  page.evaluate(([name, args]) => ((window as unknown as { __herdrDemoOrder: Hooks }).__herdrDemoOrder[name as string] as (...a: unknown[]) => unknown)(...(args as unknown[])), [name, args] as const) as Promise<T>;
const localTop = (page: Page) => page.evaluate(() => [...document.querySelector(".machine-workspaces")!.querySelectorAll<HTMLElement>(":scope .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace ?? ""));
const drawnOrders = (page: Page) => page.evaluate(() => (window as unknown as { __orderCommits: string[] }).__orderCommits.slice());
const waitOrder = (page: Page, want: readonly string[], label: string) => page.waitForFunction((want) =>
  [...document.querySelector(".machine-workspaces")!.querySelectorAll<HTMLElement>(":scope .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(), want, { timeout: 10_000 })
  .catch(async () => { throw new Error(`${label}: wanted ${want.join()} got ${(await localTop(page)).join()}`); });
const logCount = (page: Page, kind: string) => page.evaluate((kind) => ((window as unknown as { __herdrDemoOrder: { log(): { kind: string }[] } }).__herdrDemoOrder.log()).filter((entry) => entry.kind === kind).length, kind);
const waitLog = (page: Page, kind: string, count: number) => page.waitForFunction(([kind, count]) =>
  ((window as unknown as { __herdrDemoOrder: { log(): { kind: string }[] } }).__herdrDemoOrder.log()).filter((entry) => entry.kind === kind).length >= (count as number), [kind, count] as const, { timeout: 10_000 });
/**
 * The page reads the roster now and counts that read, as a tab coming back does (useMachineRoster's
 * visibilitychange). A case must not wait on a refetch it did not start: one debounced after an earlier
 * move may already have come, and with the stream open the next poll is 30 s away.
 */
async function readRoster(page: Page): Promise<void> {
  const reads = await logCount(page, "read-start");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitLog(page, "read-start", reads + 1);
}
let markerStatus: "working" | "idle" = "idle";
/**
 * A pane-status patch after a delivery: once its badge shows, every frame before it was drawn. The
 * marker is an agent pane alone in its workspace, so the row's badge is that pane's own status.
 */
async function drawn(page: Page): Promise<void> {
  const marker = await page.evaluate(async () => {
    const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: { pane_id: string; workspace_id: string; agent: string | null }[] } };
    const alone = snapshot.panes.find((pane) => pane.agent && snapshot.panes.filter((other) => other.workspace_id === pane.workspace_id).length === 1);
    return alone ? { pane: alone.pane_id, workspace: alone.workspace_id } : null;
  });
  assert.ok(marker, "the demo has an agent pane alone in its workspace");
  markerStatus = markerStatus === "idle" ? "working" : "idle";
  await demo(page, "status", marker.pane, markerStatus);
  await page.locator(`.machine-workspaces .workspace-group[data-workspace="${marker.workspace}"] > .workspace-header [data-status="${markerStatus}"]`).first().waitFor({ state: "attached", timeout: 10_000 });
}
async function stepUp(page: Page, id: string): Promise<void> {
  await page.locator(`.machine-workspaces .workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`).first().focus();
  await page.keyboard.press("Alt+ArrowUp");
}
const up = (order: readonly string[], id: string) => { const next = [...order]; const index = next.indexOf(id); [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; };
async function stepOne(page: Page, order: readonly string[], id: string): Promise<string[]> {
  const index = order.indexOf(id);
  await page.locator(`.machine-workspaces .workspace-group[data-workspace="${id}"] > .workspace-header .workspace-select`).first().focus();
  if (index > 0) {
    await page.keyboard.press("Alt+ArrowUp");
    return up(order, id);
  }
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForFunction(([id]) => [...document.querySelector(".machine-workspaces")!.querySelectorAll<HTMLElement>(":scope .sidebar-list > .workspace-list > .workspace-group")][0]?.dataset.workspace !== id, [id] as const, { timeout: 10_000 });
  const next = await localTop(page);
  assert.deepEqual([...next].sort(), [...order].sort(), "a step down keeps the same rows");
  return next;
}
const herdrTop = async (page: Page, rows: readonly string[]) => (await serverOrder(page)).filter((id) => rows.includes(id));
async function otherOrder(page: Page, rows: readonly string[], avoid: readonly (readonly string[])[]): Promise<string[]> {
  for (let attempt = 0; attempt < rows.length; attempt++) {
    const now = await herdrTop(page, rows);
    await demo(page, "otherClientMove", now.at(-1)!, 0);
    const next = await herdrTop(page, rows);
    if (!avoid.some((order) => order.join() === next.join())) return next;
  }
  throw new Error(`no other order avoids ${avoid.map((order) => order.join()).join(" | ")}`);
}
const drawnMark = async (page: Page) => (await drawnOrders(page)).length;
async function neverDrawnSince(page: Page, since: number, order: readonly string[], label: string): Promise<string[]> {
  const drawnNow = (await drawnOrders(page)).slice(since);
  assert.ok(!drawnNow.includes(order.join()), `${label}: ${order.join()} was drawn again (${drawnNow.join(" | ")})`);
  return drawnNow;
}

type Browser = Awaited<ReturnType<typeof chromium.launch>>;
async function openOrderPage(browser: Browser, url: string) {
  const context = await appContext(browser, { viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    const commits: string[] = [];
    (window as unknown as { __orderCommits: string[] }).__orderCommits = commits;
    new MutationObserver(() => {
      const list = document.querySelector(".machine-workspaces");
      if (!list) return;
      const order = [...list.querySelectorAll<HTMLElement>(":scope .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join();
      if (order && order !== commits.at(-1)) commits.push(order);
    }).observe(document, { subtree: true, childList: true });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".machine-workspaces .workspace-group").first().waitFor();
  return { context, page, errors };
}

async function checkEdgeHoldGrowth(browser: Browser, url: string): Promise<void> {
  const context = await appContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript(() => {
      Reflect.set(window, "__ovisDemoHoldTurn", true);
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator('button[aria-controls="workspace-drawer"]').click();
    await page.locator(".machine-workspaces .workspace-group").first().waitFor();
    await page.waitForFunction(() => (document.querySelector("#workspace-drawer.is-open")?.getBoundingClientRect().left ?? -1) >= 0);
    const rowCount = () => page.locator(".machine-workspaces .workspace-group[data-workspace]").count();
    const grow = async (prefix: string, count: number): Promise<string[]> => {
      const rows = await rowCount();
      const ids = await page.evaluate(async ({ prefix, count }) => {
        const created: string[] = [];
        for (let i = 0; i < count; i += 1) {
          const response = await fetch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: `/home/demo/${prefix}${i}`, label: `${prefix}${i}` }) });
          if (!response.ok) throw new Error(`create demo workspace: ${response.status}`);
          created.push((await response.json() as { workspace_id: string }).workspace_id);
        }
        return created;
      }, { prefix, count });
      await page.waitForFunction((want) => document.querySelectorAll(".machine-workspaces .workspace-group[data-workspace]").length >= want, rows + count);
      return ids;
    };
    const [source] = await grow("fill", 20);
    const scroller = page.locator(".machine-list");
    const scrollTop = () => scroller.evaluate((list) => list.scrollTop);
    const list = await scroller.evaluate((list) => ({ bottom: list.getBoundingClientRect().bottom, overflow: list.scrollHeight - list.clientHeight }));
    assert.ok(list.overflow > 100, `the filled list scrolls: ${list.overflow}px past its box`);
    const height = await page.locator(`.workspace-group[data-workspace="${source}"]`).evaluate((row) => row.getBoundingClientRect().height);
    const from = await centerOf(page, source!);
    const rest = Math.round(list.bottom - height / 2 - 12);
    assert.ok(rest > list.bottom - 48, `the finger rests in the bottom edge zone with the row inside the list: ${rest} for a list ending at ${list.bottom}`);
    const cdp = await context.newCDPSession(page);
    await stroke(page, cdp, from, { x: from.x, y: rest }, 600, async () => {
      await page.waitForFunction(() => { const list = document.querySelector(".machine-list")!; return list.scrollTop + list.clientHeight >= list.scrollHeight - 1; });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const held = await scrollTop();
      await grow("grow", 16);
      await page.waitForFunction((held) => document.querySelector(".machine-list")!.scrollTop > held + 20, held, { timeout: 5_000 })
        .catch(async () => { throw new Error(`a finger resting at the list's bottom edge scrolls on when the list grows: scrollTop stayed at ${await scrollTop()} from ${held}`); });
    });
    console.log("PASS a finger resting at the list's bottom edge keeps scrolling when a live update makes the list longer");
  } finally {
    await context.close();
  }
}

const reorderError = (page: Page) => page.locator(".machine-workspaces .sidebar-inline-error", { hasText: "Reorder failed" });

async function checkRefusedMoves(browser: Browser, url: string): Promise<unknown> {
  const single = await openOrderPage(browser, url);
  const lone = await addScratchWorkspace(single.page);
  const F0 = await localTop(single.page);
  await demo(single.page, "failMove", 0);
  const since = await drawnMark(single.page);
  const F = await stepOne(single.page, F0, lone);
  await reorderError(single.page).waitFor({ timeout: 10_000 });
  await waitOrder(single.page, F0, "a refused move rolls back to herdr's order");
  assert.ok((await drawnOrders(single.page)).slice(since).includes(F.join()), "the dragged order showed before the refusal");
  assert.equal(await logCount(single.page, "move-refused"), 1);
  assert.equal(await logCount(single.page, "move"), 0, "herdr moved nothing");
  assert.deepEqual(await herdrTop(single.page, F0), F0);
  assert.deepEqual(single.errors, []);
  await single.context.close();

  const { context, page, errors } = await openOrderPage(browser, url);
  const repos = await page.evaluate(async () => {
    const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { workspaces: { workspace_id: string; worktree?: { is_linked_worktree: boolean } | null }[] } };
    return snapshot.workspaces.filter((workspace) => workspace.worktree && !workspace.worktree.is_linked_worktree).map((workspace) => workspace.workspace_id);
  });
  assert.ok(repos.length >= 2, `two repositories in the demo: ${repos.join()}`);
  for (const [index, repo] of repos.slice(0, 2).entries()) {
    const child = await page.evaluate(async ([workspaceId, branch]) => {
      const response = await fetch("/api/worktree/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: workspaceId, branch }) });
      if (!response.ok) throw new Error(`create demo worktree: ${response.status}`);
      return (await response.json() as { workspace_id: string }).workspace_id;
    }, [repo, `partial-${index}`] as const);
    await page.locator(`.worktree-children .workspace-group[data-workspace="${child}"]`).waitFor();
  }
  const O = await localTop(page);
  const second = O.find((id, index) => index > 0 && repos.slice(0, 2).includes(id) && repos.slice(0, 2).includes(O[index - 1]!));
  assert.ok(second, `the two repositories are adjacent: ${O.join()}`);
  await demo(page, "holdSse", true);
  await demo(page, "holdGets", true);
  const stale = await demo<number>(page, "hold");
  await demo(page, "failMove", 1);
  const since2 = await drawnMark(page);
  const D = up(O, second);
  await stepUp(page, second);
  await reorderError(page).waitFor({ timeout: 10_000 });
  assert.equal(await logCount(page, "move"), 1, "the first move of the batch was confirmed");
  assert.equal(await logCount(page, "move-refused"), 1, "the second was refused");
  assert.ok((await drawnOrders(page)).slice(since2).includes(D.join()), "the dragged order showed while the batch ran");
  const P = await herdrTop(page, O);
  await demo(page, "publish");
  await waitOrder(page, P, "herdr's order after the partial batch shows on a qualifying roster");
  const settled = await drawnMark(page);
  await demo(page, "deliverSse", stale);
  await demo(page, "cacheNextGet", stale);
  await demo(page, "holdGets", false);
  await demo(page, "releaseAllGets");
  await readRoster(page);
  await drawn(page);
  assert.deepEqual(await localTop(page), P, "a pre-move roster by SSE and as a cached GET cannot undo the confirmed move");
  assert.deepEqual((await drawnOrders(page)).slice(settled), [], "nothing was drawn after herdr's order");
  await demo(page, "holdSse", false);
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS a refused move rolls back with its error; a partly refused batch keeps its confirmed move's floor against pre-move SSE and cached GET rosters");
  return { single: { F0, F }, partial: { O, D, P } };
}

async function checkProofGating(browser: Browser, url: string): Promise<unknown> {
  const { context, page, errors } = await openOrderPage(browser, url);
  const lone = await addScratchWorkspace(page);
  await demo(page, "holdGets", true);
  await demo(page, "holdSse", true);
  await demo(page, "verifyMode", "hold");
  const O = await localTop(page);
  const since = await drawnMark(page);
  const D1 = await stepOne(page, O, lone);
  await waitOrder(page, D1, "the first drag shows");
  await waitLog(page, "move", 1);
  const E1 = await demo<string>(page, "epoch");
  const E2 = await demo<string>(page, "restart");
  await demo(page, "proveSource");
  const starts = await logCount(page, "verify-start");
  await demo(page, "publish");
  await waitLog(page, "verify-start", starts + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), D1, "passive proof of another epoch changes no order");
  const D2 = await stepOne(page, D1, lone);
  await waitOrder(page, D2, "the newer drag shows");
  await waitLog(page, "move", 2);
  const E3 = await demo<string>(page, "restart");
  await demo(page, "proveSource");
  const staleAnswers = await logCount(page, "verify-answer");
  await demo(page, "releaseVerify", "answer");
  await waitLog(page, "verify-answer", staleAnswers + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), D2, "the stale answer applied nothing");
  const X = await otherOrder(page, D2, [O, D1, D2]);
  await demo(page, "advance", 1000);
  await demo(page, "publish");
  await waitLog(page, "verify-start", starts + 2);
  await drawn(page);
  assert.deepEqual(await localTop(page), D2, "the next roster of another epoch still waits for a fresh answer");
  await demo(page, "releaseVerify", "answer");
  await waitOrder(page, X, "the fresh correlated answer retires the receipt's epoch and applies its roster");
  await neverDrawnSince(page, since, O, "the pre-move order across the gated proof");
  await demo(page, "holdSse", false);
  await demo(page, "releaseAllGets");
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS a proof asked before a newer receipt retires nothing, passive proof changes nothing, and only the fresh correlated answer applies the new server's roster");
  return { O, D1, D2, X, epochs: { E1, E2, E3 } };
}

async function checkUnseenRetiredEra(browser: Browser, url: string): Promise<unknown> {
  const { context, page, errors } = await openOrderPage(browser, url);
  const lone = await addScratchWorkspace(page);
  await demo(page, "holdGets", true);
  await demo(page, "holdSse", true);
  const O = await localTop(page);
  const unseen = await demo<number>(page, "hold");
  const since = await drawnMark(page);
  await demo(page, "restart");
  await demo(page, "proveSource");
  const D = await stepOne(page, O, lone);
  await waitOrder(page, D, "the drag in the second server lifetime shows");
  await waitLog(page, "move", 1);
  await demo(page, "restart");
  await demo(page, "proveSource");
  const X = await otherOrder(page, D, [O, D]);
  await demo(page, "verifyMode", "answer");
  await demo(page, "publish");
  await waitOrder(page, X, "the third lifetime's proof and full roster apply");
  const guarded = await drawnMark(page);
  const starts = await logCount(page, "verify-start");
  await demo(page, "advance", 1000);
  await demo(page, "deliverSse", unseen);
  await waitLog(page, "verify-answer", 2);
  await drawn(page);
  assert.deepEqual(await localTop(page), X, "an unseen first-lifetime SSE roster cannot restore O; the current proof keeps the guard");
  assert.equal(await logCount(page, "verify-start"), starts + 1, "the mismatch asked once");
  await demo(page, "cacheNextGet", unseen);
  await demo(page, "holdGets", false);
  await demo(page, "releaseAllGets");
  await readRoster(page);
  await drawn(page);
  assert.deepEqual(await localTop(page), X, "an unseen first-lifetime cached GET cannot restore O");
  await demo(page, "holdMoves", true);
  await demo(page, "holdGets", true);
  const Y = await stepOne(page, X, lone);
  await waitOrder(page, Y, "a drag under the guard shows");
  assert.notDeepEqual(Y, O, "the drag under the guard is not the pre-move order");
  await waitLog(page, "move", 2);
  const Z = await otherOrder(page, Y, [Y]);
  const held = await demo<number>(page, "pendingGets");
  await demo(page, "releaseAllMoves");
  await page.waitForFunction((held) => (window as unknown as { __herdrDemoOrder: { pendingGets(): number } }).__herdrDemoOrder.pendingGets() > held, held, { timeout: 10_000 });
  await demo(page, "advance", 1000);
  await demo(page, "deliverSse", unseen);
  for (let i = 0; i <= held; i++) await demo(page, "releaseGet");
  await drawn(page);
  assert.deepEqual(await localTop(page), Y, "the invalidated load released nothing and the unseen roster restored nothing");
  await neverDrawnSince(page, since, O, "the pre-move order after the guard");
  assert.ok(!(await drawnOrders(page)).slice(guarded).includes(O.join()));
  await demo(page, "publish");
  await waitOrder(page, Z, "the next qualifying roster applies");
  await demo(page, "holdSse", false);
  await demo(page, "releaseAllGets");
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS unseen retired-era GET and SSE cannot restore pre-move order after the guard's first snapshot, including a settlement load the SSE invalidated");
  return { O, D, X, Y, Z };
}

/** The demo's verify_source_boot admission, as the manager's: one health call per PC, starts 1000 ms apart. */
async function checkAdmission(browser: Browser, url: string): Promise<unknown> {
  const { context, page, errors } = await openOrderPage(browser, url);
  await demo(page, "addPc");
  await demo(page, "verifyMode", "hold");
  const ask = (id: string, count: number) => page.evaluate(([id, count]) => Promise.all(Array.from({ length: count as number }, async () => {
    const response = await fetch(`/api/machines?verify_source_boot=${id}`);
    const body = await response.json() as { verified_source_boot?: { machine_id: string; boot_id: string } };
    return { status: response.status, retry: response.headers.get("retry-after"), proof: body.verified_source_boot ?? null };
  })), [id, count] as const);
  const starts = await logCount(page, "verify-start");
  const asked = ask("local", 32);
  await waitLog(page, "verify-request", 32);
  assert.equal(await logCount(page, "verify-start"), starts + 1, "32 simultaneous queries start one health call");
  await demo(page, "releaseVerify", "answer");
  const answers = await asked;
  const epoch = await demo<string>(page, "epoch");
  assert.deepEqual(answers.filter((answer) => answer.status === 200).map((answer) => answer.proof), [{ machine_id: "local", boot_id: epoch }], "one correlated proof");
  assert.equal(answers.filter((answer) => answer.status === 503).length, 31, "every joined query is refused");
  await demo(page, "verifyMode", "answer");
  assert.deepEqual((await ask("local", 1))[0], { status: 503, retry: "1", proof: null }, "a query right after is refused with Retry-After");
  await demo(page, "advance", 999);
  assert.equal((await ask("local", 1))[0]!.status, 503, "999 ms after the start is still inside the interval");
  assert.equal((await ask("laptop", 1))[0]!.status, 200, "another PC has its own budget");
  await demo(page, "advance", 1);
  assert.equal((await ask("local", 1))[0]!.status, 200, "at 1000 ms one new call is admitted");
  assert.equal(await logCount(page, "verify-start"), starts + 3);
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS concurrent verification queries start one health call, and sequential ones obey the per-PC start interval");
  return { answers: answers.map((answer) => answer.status) };
}

async function checkOrderEvidence(browser: Browser, url: string): Promise<{ happy: unknown; failure: unknown }> {
  const context = await appContext(browser, { viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    const commits: string[] = [];
    (window as unknown as { __orderCommits: string[] }).__orderCommits = commits;
    new MutationObserver(() => {
      const list = document.querySelector(".machine-workspaces");
      if (!list) return;
      const order = [...list.querySelectorAll<HTMLElement>(":scope .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join();
      if (order && order !== commits.at(-1)) commits.push(order);
    }).observe(document, { subtree: true, childList: true });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".machine-workspaces .workspace-group").first().waitFor();
  const single = await addScratchWorkspace(page);
  const happy: Record<string, unknown> = {};
  const failure: Record<string, unknown> = {};

  const O = await localTop(page);
  const epoch = await demo<string>(page, "epoch");
  await demo(page, "holdSse", true);
  const stale = await demo<number>(page, "hold");
  await demo(page, "cacheNextGet", stale);
  const reads = await logCount(page, "read-start");
  const A = up(O, O[1]!);
  const happySince = await drawnMark(page);
  await stepUp(page, O[1]!);
  await waitOrder(page, A, "the dragged order shows at once");
  await waitLog(page, "move", 1);
  await waitLog(page, "read-start", reads + 1);
  await demo(page, "deliverSse", stale);
  await drawn(page);
  assert.deepEqual(await localTop(page), A, "a pre-move read delivered after the receipt keeps the dragged order");
  const happyDrawn = await neverDrawnSince(page, happySince, O, "the pre-move order O after the drag");
  await demo(page, "otherClientMove", A[2]!, 1);
  const B = await herdrTop(page, A);
  await demo(page, "holdSse", false);
  await demo(page, "publish");
  await waitOrder(page, B, "B shows on the first qualifying SSE roster");
  await demo(page, "holdSse", true);
  await demo(page, "holdMoves", true);
  const C = up(B, B[1]!);
  const movesBeforeC = await logCount(page, "move");
  await stepUp(page, B[1]!);
  await waitOrder(page, C, "a second drag shows at once");
  await waitLog(page, "move", movesBeforeC + 1);
  await demo(page, "otherClientMove", C[2]!, 0);
  const B2 = await herdrTop(page, C);
  assert.notDeepEqual(B2, C, "the other client's order differs from the dragged one");
  const loadsBefore = await logCount(page, "read-start");
  const sseBefore = await logCount(page, "publication");
  await demo(page, "releaseAllMoves");
  await waitOrder(page, B2, "B2 shows on the first qualifying roster of a load");
  assert.ok(await logCount(page, "read-start") > loadsBefore, "a load read the roster");
  assert.equal(await logCount(page, "publication"), sseBefore, "no SSE roster was published meanwhile");
  await demo(page, "holdSse", false);
  Object.assign(happy, { epoch, O, A, B, C, B2, drawn_while_held: happyDrawn, log: await demo(page, "log") });
  console.log("PASS reorder-holds-through-snapshot: a pre-move SSE roster and cached GET keep the dragged order; another client's B shows on the first qualifying roster by SSE, and a distinct B2 by load");

  await demo(page, "addPc");
  await page.locator(".machine-workspaces").nth(1).waitFor({ state: "attached" });
  await demo(page, "holdSse", true);
  await page.evaluate(() => { const w = window as unknown as { __realNow: () => number }; w.__realNow = Date.now; Date.now = () => 2_000_000_000_000; });
  const frozen = await demo<number>(page, "hold");
  const D0 = await localTop(page);
  const D = up(D0, D0[2]!);
  const movesBeforeFrozen = await logCount(page, "move");
  const frozenSince = await drawnMark(page);
  await stepUp(page, D0[2]!);
  await waitOrder(page, D, "a drag under a frozen clock shows at once");
  await waitLog(page, "move", movesBeforeFrozen + 1);
  await page.evaluate(() => { Date.now = () => 1_000_000_000_000; });
  await demo(page, "deliverSse", frozen);
  await demo(page, "status", "w1C:p1", "blocked");
  await drawn(page);
  assert.deepEqual(await localTop(page), D, "a frozen then backward clock, a status patch and another PC's roster cannot release");
  await page.evaluate(() => { Date.now = (window as unknown as { __realNow: () => number }).__realNow; });
  await demo(page, "status", "w1C:p1", "working");
  failure["clock_status_other_pc"] = { before: D0, order: D, drawn_after_drag: await neverDrawnSince(page, frozenSince, D0, "the pre-move order under frozen clocks") };

  await demo(page, "holdMoves", true);
  const G1 = up(D, D[1]!);
  await stepUp(page, D[1]!);
  await waitOrder(page, G1, "the first generation shows");
  const G2 = up(G1, G1[2]!);
  await stepUp(page, G1[2]!);
  await waitOrder(page, G2, "the newer generation shows at once");
  await page.waitForFunction(() => (window as unknown as { __herdrDemoOrder: { pendingMoves(): number } }).__herdrDemoOrder.pendingMoves() > 0, undefined, { timeout: 10_000 });
  await demo(page, "releaseMove");
  await drawn(page);
  assert.deepEqual(await localTop(page), G2, "an older generation's answer does not replace the newer order");
  await demo(page, "releaseAllMoves");
  await demo(page, "holdSse", false);
  await demo(page, "publish");
  await waitOrder(page, G2, "the settled generations land where the newest drag put them");
  failure["generations"] = { G1, G2 };

  await demo(page, "verifyMode", "refuse");
  await demo(page, "holdSse", true);
  const beforeRestart = await demo<number>(page, "hold");
  const movesBeforeRestart = await logCount(page, "move");
  const restartSince = await drawnMark(page);
  const R = await stepOne(page, G2, single);
  await waitOrder(page, R, "the drag before the restart shows");
  await waitLog(page, "move", movesBeforeRestart + 1);
  const oldEpoch = await demo<string>(page, "epoch");
  const newEpoch = await demo<string>(page, "restart");
  await demo(page, "otherClientMove", R[2]!, 1);
  const S = await herdrTop(page, R);
  const refusals = await logCount(page, "verify-refuse");
  await demo(page, "proveSource");
  await demo(page, "publish");
  await waitLog(page, "verify-refuse", refusals + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), R, "another epoch's roster without proof cannot replace the order");
  const restartDrawn = await neverDrawnSince(page, restartSince, G2, "the pre-move order across the restart");
  await demo(page, "verifyMode", "answer");
  const answers = await logCount(page, "verify-answer");
  await demo(page, "advance", 1000);
  await demo(page, "publish");
  await waitLog(page, "verify-answer", answers + 1);
  await waitOrder(page, S, "the correlated proof retires the old epoch and applies the new server's roster");
  const settledMark = await drawnMark(page);
  await demo(page, "deliverSse", beforeRestart);
  await demo(page, "cacheNextGet", beforeRestart);
  await readRoster(page);
  await drawn(page);
  assert.deepEqual(await localTop(page), S, "a retired epoch's SSE roster and cached GET change nothing");
  assert.deepEqual((await drawnOrders(page)).slice(settledMark), [], "nothing was drawn after the new server's order");
  failure["restart"] = { before: G2, oldEpoch, newEpoch, R, S, drawn_while_held: restartDrawn };

  await demo(page, "verifyMode", "proof-only");
  const guardSince = await drawnMark(page);
  const movesBeforeGuard = await logCount(page, "move");
  const T = await stepOne(page, S, single);
  await waitOrder(page, T, "the drag after the restart shows");
  await waitLog(page, "move", movesBeforeGuard + 1);
  await demo(page, "restart");
  await demo(page, "proveSource");
  const proofs = await logCount(page, "verify-proof-only");
  await demo(page, "advance", 1000);
  await demo(page, "publish");
  await waitLog(page, "verify-proof-only", proofs + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), T, "proof alone applies no snapshot");
  const guardDrawn = await neverDrawnSince(page, guardSince, S, "the pre-move order across two restarts");
  await demo(page, "restart");
  await demo(page, "proveSource");
  await demo(page, "verifyMode", "answer");
  await demo(page, "otherClientMove", T[2]!, 1);
  const U = await herdrTop(page, T);
  const finalAnswers = await logCount(page, "verify-answer");
  await demo(page, "advance", 1000);
  await demo(page, "publish");
  await waitLog(page, "verify-answer", finalAnswers + 1);
  await waitOrder(page, U, "the guard alone verifies the second restart and applies its full roster");
  failure["successor_guard"] = { before: S, T, U, drawn_while_held: guardDrawn };

  assert.deepEqual(errors, []);
  Object.assign(failure, { drawn: await drawnOrders(page), log: await demo(page, "log") });
  await context.close();
  console.log("PASS superseded-reorder-failure: frozen/backward clocks, status patches, another PC, older generations, unproved and retired epochs, a proof-only successor and an older server's fallback never undo the newest order");
  return { happy, failure };
}

async function checkLegacyFallback(browser: Awaited<ReturnType<typeof chromium.launch>>, url: string): Promise<unknown> {
  const context = await appContext(browser, { viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  const page = await context.newPage();
  await page.goto(url);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator(".machine-workspaces .workspace-group").first().waitFor();
  await demo(page, "legacy", true);
  await addScratchWorkspace(page);
  const U = await localTop(page);
  await demo(page, "holdSse", true);
  await demo(page, "holdMoves", true);
  const legacyStale = await demo<number>(page, "hold");
  const V = up(U, U[1]!);
  await stepUp(page, U[1]!);
  await waitOrder(page, V, "an older server's drag shows at once");
  await page.waitForFunction(() => (window as unknown as { __herdrDemoOrder: { pendingMoves(): number } }).__herdrDemoOrder.pendingMoves() > 0, undefined, { timeout: 10_000 });
  await demo(page, "deliverSse", legacyStale);
  await drawn(page);
  assert.deepEqual(await localTop(page), V, "a roster delivered before settlement cannot release the fallback hold");
  const legacyLoads = await logCount(page, "read-start");
  await demo(page, "releaseAllMoves");
  await waitLog(page, "read-start", legacyLoads + 1);
  await drawn(page);
  assert.deepEqual(await localTop(page), V, "the load started after settlement shows herdr's order");
  await demo(page, "otherClientMove", V[2]!, 1);
  const W = await herdrTop(page, V);
  await demo(page, "holdSse", false);
  await demo(page, "publish");
  await waitOrder(page, W, "after the post-settlement load, an older server's roster applies as before");
  await context.close();
  console.log("PASS an older server's move falls back to the first load started after settlement");
  return { U, V, W };
}

await withDemoBrowser({ tempPrefix: "herdr-touch-reorder-demo-" }, async ({ browser, baseUrl }) => {
  const context = await appContext(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    // The demo's finish droplet can cover a pinned row between measuring it and pressing it.
    Reflect.set(window, "__ovisDemoHoldTurn", true);
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
  });
  await context.addInitScript(() => {
    const original = Element.prototype.getBoundingClientRect;
    (window as unknown as { __rowBoxReads: number }).__rowBoxReads = 0;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.matches?.(".workspace-group[data-workspace]")) (window as unknown as { __rowBoxReads: number }).__rowBoxReads += 1;
      return original.call(this);
    };
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.locator('#drawer-toggle').click();
  await page.locator(".machine-workspaces .workspace-group").first().waitFor();
  const cdp = await context.newCDPSession(page);

  assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the phone context has a coarse pointer");
  assert.equal(await page.locator(".machine-workspaces .workspace-select").first().getAttribute("draggable"), "false",
    "on a touch screen the browser's own drag is off, so iOS lifts no drag preview that drops nothing");

  await addScratchWorkspace(page);
  const before = await topRows(page);
  assert.ok(before.length >= 3, `three top-level workspaces: ${JSON.stringify(before)}`);
  assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), before, "the sidebar draws herdr's order");

  await stroke(page, cdp, await centerOf(page, before[0]!), await centerOf(page, before[2]!), 0, async () => {
    assert.equal(await page.locator(".workspace.is-lifted").count(), 0, "a stroke that moves at once lifts nothing");
  });
  assert.deepEqual(await topRows(page), before, "a quick stroke moves nothing");

  const target = await centerOf(page, before[2]!);
  await stroke(page, cdp, await centerOf(page, before[0]!), { x: target.x, y: target.y + 4 }, 600, async () => {
    assert.equal(await page.locator(`.workspace-group.is-lifted[data-workspace="${before[0]}"]`).count(), 1, "the held row is lifted");
    assert.ok(await page.locator(`.machine-workspaces [data-drop="after"]`).count() === 1, "a line shows where it lands");
    assert.notEqual(await page.locator(`.workspace-group[data-workspace="${before[0]}"]`).evaluate((row) => row.style.transform), "", "the row follows the finger");
  });
  const expected = [before[1]!, before[2]!, before[0]!, ...before.slice(3)];
  await page.waitForFunction((want) => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(),
    expected, { timeout: 5_000 });
  assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), expected, "herdr got the move");
  assert.equal(await page.locator(".workspace.is-lifted, [data-drop]").count(), 0, "nothing stays lifted or marked");
  assert.equal(await page.locator(`.workspace-group[data-workspace="${before[0]}"]`).evaluate((row) => row.style.transform), "", "the dropped row sits in the list");
  assert.equal(await page.locator('#drawer-toggle').getAttribute("aria-expanded"), "true", "the drag left the drawer open");
  console.log("PASS a long press lifts a workspace row on a touch screen, and a drag drops it where the line shows");

  const burstFrom = await centerOf(page, before[0]!);
  await touch(cdp, "touchStart", burstFrom);
  await page.locator(".workspace.is-lifted").waitFor({ timeout: 5_000 });
  const rowCount = await page.locator(".machine-workspaces .workspace-group[data-workspace]").count();
  const burst = await page.evaluate(({ x, y }) => new Promise<{ during: number; frame: number }>((resolve) => {
    const counter = window as unknown as { __rowBoxReads: number };
    counter.__rowBoxReads = 0;
    const target = document.elementFromPoint(x, y) ?? document.body;
    for (let i = 0; i < 8; i += 1) {
      const at = y + i * 4;
      const touch = new Touch({ identifier: 1, target, clientX: x, clientY: at, pageX: x, pageY: at, screenX: x, screenY: at });
      target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, cancelable: true, touches: [touch], targetTouches: [touch], changedTouches: [touch] }));
    }
    const during = counter.__rowBoxReads;
    requestAnimationFrame(() => resolve({ during, frame: counter.__rowBoxReads }));
  }), { x: burstFrom.x, y: burstFrom.y + 12 });
  assert.equal(burst.during, 0, `a burst of 8 touchmoves at 8 heights measures no row while it is dispatched: ${burst.during} reads`);
  assert.ok(burst.frame > 0 && burst.frame <= rowCount, `the next frame measures the rows once: ${burst.frame} reads for ${rowCount} rows`);
  await touch(cdp, "touchCancel");
  console.log("PASS a burst of touchmoves measures the rows once per frame, not once per event");

  const moved = before[0]!;
  const movedRow = page.locator(`.workspace-group[data-workspace="${moved}"]`);
  await movedRow.locator(".row-menu-toggle").click();
  const workspaceSheet = page.locator(".row-sheet");
  await workspaceSheet.waitFor();
  assert.deepEqual(await workspaceSheet.locator(".row-sheet-item").allTextContents(), ["Pin workspace", "New tab with agent…", "Rename workspace", "Earlier sessions…", "Close group", "New worktree", "Open worktree…", "Collapse"],
    "the touch menu of a repository contains its group's native actions, with no pane or reorder actions");
  await workspaceSheet.getByRole("button", { name: "Cancel", exact: true }).click();
  await workspaceSheet.waitFor({ state: "detached" });
  await movedRow.locator(".workspace-select").focus();
  await page.keyboard.press("Alt+ArrowUp");
  const stepped = [before[1]!, before[0]!, before[2]!, ...before.slice(3)];
  await page.waitForFunction((want) => [...document.querySelectorAll<HTMLElement>(".machine-workspaces .sidebar-list > .workspace-list > .workspace-group")].map((row) => row.dataset.workspace).join() === want.join(),
    stepped, { timeout: 5_000 });
  assert.deepEqual((await serverOrder(page)).filter((id) => before.includes(id)), stepped, "herdr got the keyboard move");
  console.log("PASS the touch menu keeps workspace scope and Alt+Up still moves a workspace one step");

  await checkPinned(page, cdp);
  assert.deepEqual(errors, []);
  await context.close();
  await checkEdgeHoldGrowth(browser, `${baseUrl}`);
  const desktop = await appContext(browser, { viewport: { width: 1440, height: 1000 } });
  await desktop.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
  const desktopPage = await desktop.newPage();
  await desktopPage.goto(`${baseUrl}`);
  await desktopPage.locator(".conn-live").waitFor({ state: "attached" });
  await desktopPage.locator(".machine-workspaces .workspace-group").first().waitFor();
  await checkPinned(desktopPage);
  await desktop.close();
  const demoUrl = `${baseUrl}`;
  const order = await checkOrderEvidence(browser, demoUrl);
  const failure = order.failure as Record<string, unknown>;
  failure["legacy_fallback"] = await checkLegacyFallback(browser, demoUrl);
  failure["refused_moves"] = await checkRefusedMoves(browser, demoUrl);
  failure["proof_gating"] = await checkProofGating(browser, demoUrl);
  failure["unseen_retired_era"] = await checkUnseenRetiredEra(browser, demoUrl);
  failure["admission"] = await checkAdmission(browser, demoUrl);
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(join(evidence, "reorder-holds-through-snapshot.json"), JSON.stringify(order.happy, null, 2));
    writeFileSync(join(evidence, "superseded-reorder-failure.json"), JSON.stringify(order.failure, null, 2));
  }
});
