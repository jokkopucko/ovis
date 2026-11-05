/**
 * The session list and Resume (#1314) over a fictional bridge, in the real React components: the
 * workspace menu's item, newest-first rows, one tab/create per Resume however often the button is
 * clicked (the body carries the row's argv), no second Resume in the window before herdr reports the
 * resumed pane's session (App's RecentResume record), a session a pane already shows selected instead of
 * started, a row without a verified resume listed with no button, the keyboard along the rows,
 * the agent picker (each agent with its mark, no Shell, its open list taking Escape alone, also with the
 * focus off its button and when the sessions arrive while it is open, disabled while a resume is in
 * flight), a PC whose bridge answers 404 for the route, whose menu has no item, and
 * Claude's store-bound Resume: the list asked for from a pane of the workspace, one POST sessions/resume
 * per double click (never tab/create), the same UUID reported by a pane on another store left to Resume, a
 * store that changed read again, and a bridge from before store-bound Resume (rows without a source, no
 * resume route) offering no Resume rather than an unbound one. No herdr pane is touched; every request
 * stays on this loopback server.
 */
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import type { SessionHistoryResponse, SessionResumeResponse, TabCreated } from "../shared/protocol.ts";
import type {} from "./session-history-fixture.tsx";
import { CLAUDE_OTHER, CLAUDE_ROWS, CLAUDE_SHARED, CLAUDE_STORE_KEY, OLDER_SESSION, SESSION_ROWS } from "./session-history-fixture-data.ts";
import { chromePath } from "./chrome-path.ts";
import { contextMenuKey } from "./context-menu-key.ts";
import { listSessions, piSessionFolder } from "../server/session-history.ts";
import { PiSessionReader } from "../server/pi-session-metadata.ts";
const repo = join(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "herdr-session-history-browser-"));
const evidence = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "session-history");
mkdirSync(evidence, { recursive: true });
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
/** every POST tab/create body the page sent, in order */
const tabCreates: Array<Record<string, unknown>> = [];
let holdTabCreate = false;
const releases: Array<() => void> = [];
const probes: string[] = [];
/** every Claude list's query and every POST sessions/resume body, in order */
const claudeLists: string[] = [];
const resumes: Array<Record<string, unknown>> = [];
const resumeRequests = new EventEmitter();
let holdResume = false;
/** true: the next Claude lists wait for a release, as a list read again after a changed store does */
let holdList = false;
/** "held" each time a Claude list starts waiting for its release */
const heldLists = new EventEmitter();
/** how the bridge answers the next resumes: start it, name a pane already showing it, refuse a changed store or one a new tab would not keep, or have no route */
let resumeAnswer: "created" | "opened" | "stale" | "unsupported" | "changed" | "missing" = "created";
const closedSources = new Set<string>();
const piReader = new PiSessionReader();
const piStore = join(root, "pi-sessions");
const piFolder = join(piStore, piSessionFolder("/fixture/w1"));
mkdirSync(piFolder, { recursive: true });
const piNamed = join(piFolder, "named.jsonl");
const piLine = (value: unknown) => `${JSON.stringify(value)}\n`;
const piHeader = (id: string) => piLine({ type: "session", version: 3, id, cwd: "/fixture/w1" });
const piSystem = piLine({ type: "message", message: { role: "system", content: "s".repeat(100 * 1024) } });
writeFileSync(piNamed, piHeader("pi-named") + piSystem + piLine({ type: "message", message: { role: "user", content: "Named Pi first prompt" } }) + piLine({ type: "session_info", name: "Deep Pi name" }) + piSystem);
utimesSync(piNamed, 1_790_000_002, 1_790_000_002);
const piUnnamed = join(piFolder, "unnamed.jsonl");
writeFileSync(piUnnamed, piHeader("pi-unnamed") + piSystem + piLine({ type: "message", message: { role: "user", content: [{ type: "text", text: "Late Pi" }, { type: "text", text: "prompt" }] } }));
utimesSync(piUnnamed, 1_790_000_001, 1_790_000_001);
let piBusy = 0;
let piLists = 0;
const piRetry = "Pi sessions could not be read right now. Try again.";
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const refusal = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
/** every bounded animation (the sheet's rise) over, then two frames; a looping one (a breathing status dot) never finishes and is not waited for */
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))).then(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))));
try {
  const build = await Bun.build({ entrypoints: ["scripts/session-history-fixture.tsx"], outdir: root, target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/ws") return new Response(null, { status: 404 });
    if (path === "/api/connection-diagnostics") return new Response(null, { status: 204 });
    // another PC's bridge, from before the route: the local server passes its not_found through
    if (path.startsWith("/api/machines/old-pc/")) {
      if (path.endsWith("/sessions/history")) probes.push(url.search);
      return refusal("not_found", `unknown endpoint ${path}`, 404);
    }
    if (path === "/api/sessions/history") {
      if (!url.searchParams.get("workspace_id")) return refusal("missing_workspace_id", "workspace_id is required", 400);
      const agent = url.searchParams.get("agent") ?? "";
      const workspaceId = url.searchParams.get("workspace_id")!;
      if (agent === "claude" && (workspaceId === "w3" || workspaceId === "w4")) {
        claudeLists.push(url.search);
        if (holdList) await new Promise<void>((resolve) => { releases.push(resolve); heldLists.emit("held"); });
        const paneId = url.searchParams.get("pane_id");
        if (paneId && closedSources.has(paneId)) return refusal("stale_source", "source pane no longer exists", 409);
        // w4's bridge is from before store-bound Resume: it ignores pane_id and gives no source
        const sessions = CLAUDE_ROWS.map((row) => workspaceId === "w3" && paneId !== null && row.resume ? { ...row, resume: { ...row.resume, source: { pane_id: paneId, store_key: CLAUDE_STORE_KEY } } } : row);
        return json({ workspace_id: workspaceId, agent: "claude", cwd: `/fixture/${workspaceId}`, sessions } satisfies SessionHistoryResponse);
      }
      if (agent === "pi") piLists++;
      if (agent === "pi" && piBusy > 0) {
        piBusy--;
        const response = refusal("session_history_busy", piRetry, 503);
        response.headers.set("retry-after", "1");
        return response;
      }
      const sessions = agent === "pi" ? await listSessions("pi", `/fixture/${workspaceId}`, { home: root, env: { PI_CODING_AGENT_SESSION_DIR: piStore }, piReader }) : agent === "codex" ? SESSION_ROWS : [];
      const answer: SessionHistoryResponse = { workspace_id: workspaceId, agent: agent as SessionHistoryResponse["agent"], cwd: `/fixture/${workspaceId}`, sessions };
      return json(answer);
    }
    if (path === "/api/sessions/resume") {
      const body = await request.json() as Record<string, unknown>;
      resumes.push(body);
      resumeRequests.emit("received");
      if (holdResume) await new Promise<void>((resolve) => releases.push(resolve));
      if (resumeAnswer === "missing") return refusal("not_found", `unknown endpoint ${path}`, 404);
      if (resumeAnswer === "unsupported") return refusal("launch_unsupported", "a new tab here would not start Claude in the same store", 409);
      if (resumeAnswer === "changed") return refusal("launch_store_changed", "qa-launch-store-changed", 409);
      if (resumeAnswer === "stale") return refusal("stale_source", "the pane's Claude store changed since the list: list the sessions again", 409);
      if (resumeAnswer === "opened") return json({ action: "opened", workspace_id: String(body["workspace_id"]), pane_id: "p4" } satisfies SessionResumeResponse);
      return json({ action: "created", workspace_id: String(body["workspace_id"]), pane_id: `p-claude-${resumes.length}`, agent_started: true } satisfies SessionResumeResponse);
    }
    if (path === "/api/agents") return json({ agents: [{ kind: "codex", label: "Codex", installed: true }, { kind: "claude", label: "Claude Code", installed: true }] });
    if (path === "/api/worktree/list") return refusal("not_a_repository", "no git repository here", 409);
    if (path === "/api/tab/create") {
      const body = await request.json() as Record<string, unknown>;
      tabCreates.push(body);
      if (holdTabCreate) await new Promise<void>((resolve) => releases.push(resolve));
      return json({ workspace_id: String(body["workspace_id"]), pane_id: `p-new-${tabCreates.length}`, agent_started: true } satisfies TabCreated);
    }
    if (path.startsWith("/api/")) return refusal("not_found", `unknown endpoint ${path}`, 404);
    if (path === "/") return new Response('<html><head><link rel="stylesheet" href="/session-history-fixture.css"></head><body><div id="root"></div><script type="module" src="/session-history-fixture.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    const file = Bun.file(join(root, path.slice(1)));
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  await page.goto(`http://127.0.0.1:${server.port}/`);
  const row = (workspaceId: string) => page.locator(`.workspace-group[data-workspace="${workspaceId}"] .workspace-select`);
  await row("w1").waitFor();
  const openMenu = async (workspaceId: string) => {
    await row(workspaceId).click({ button: "right" });
    const menu = page.getByRole("menu");
    await menu.waitFor();
    return menu;
  };
  const dialog = page.getByRole("dialog", { name: /^Earlier sessions/ });
  const openHistory = async (workspaceId: string) => {
    const menu = await openMenu(workspaceId);
    await menu.getByRole("menuitem", { name: "Earlier sessions…", exact: true }).click();
    await dialog.waitFor();
    await dialog.locator(".session-row").first().waitFor();
    await settled(page);
  };
  // the workspace menu lists the item beside Rename workspace, and it opens the folder's sessions newest first
  const menu = await openMenu("w1");
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Earlier sessions…", "Close workspace"]);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await openHistory("w1");
  const picker = dialog.getByRole("combobox", { name: "Agent" });
  assert.equal(await picker.locator(".agent-picker-label").textContent(), "Codex", "the row's agent is listed first");
  assert.equal(await picker.locator(".agent-mark.codex").count(), 1, "the agent's mark beside its name, as the New tab dialog's picker shows it");
  assert.deepEqual(await dialog.locator(".session-title").allTextContents(), ["Retry budget for the payment client", "Flaky export test", "A session whose resume syntax is not verified."], "newest first; a row without a title shows its first prompt");
  assert.equal(await dialog.getByRole("button", { name: /^Resume / }).count(), 2, "a row without a verified resume has no Resume button");
  assert.equal(await dialog.locator(".session-row").nth(2).locator("button").count(), 0);
  await page.screenshot({ path: join(evidence, "happy-list.png") });
  console.log("PASS workspace menu item, newest-first rows, no button without a verified resume");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  // Real Pi metadata from synthetic transcripts, not hand-picked titles: late names, a prompt
  // after a huge system record, freshly read renames/clears and automatic busy recovery.
  const capturePi = async (state: string) => {
    const previous = await page.evaluate(() => document.documentElement.dataset.theme);
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await settled(page);
        await page.screenshot({ path: join(evidence, `pi-${state}-${width}-${theme}.png`) });
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate((value) => {
      if (value === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = value;
    }, previous);
  };
  // StrictMode discards its first mount's read: refuse that probe and the active mount once each,
  // so only an automatic retry (not the second mount's initial read) can produce the rows.
  piBusy = 2;
  const busyOnce = page.waitForResponse((response) => response.url().includes("/sessions/history?") && response.status() === 503);
  await page.evaluate(() => window.qa.openHistory("w1", "pi", "p1"));
  await busyOnce;
  await dialog.getByRole("status").waitFor();
  assert.equal(await dialog.getByRole("alert").count(), 0);
  assert.equal(await dialog.locator(".session-empty").count(), 0);
  await dialog.locator('[data-session-id="pi-named"]').waitFor();
  assert.equal(piLists, 3, "the active listing recovers from one busy answer without a click");
  assert.equal(await dialog.locator(".session-error").count(), 0);
  await capturePi("busy-recovered");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  piBusy = 100;
  const beforeBusy = piLists;
  await page.evaluate(() => window.qa.openHistory("w1", "pi", "p1"));
  await dialog.locator(".session-error[role=status]").waitFor({ timeout: 75_000 });
  assert.equal(piLists - beforeBusy, 7, "one discarded StrictMode probe plus an active read and five retries");
  assert.equal(await dialog.getByRole("alert").count(), 0);
  assert.equal(await dialog.locator(".session-empty").count(), 0);
  assert.equal(await dialog.locator(".session-row").count(), 0);
  assert.ok((await dialog.locator(".session-error").textContent())?.trim());
  await capturePi("busy-retry");
  piBusy = 0;
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await dialog.locator('[data-session-id="pi-named"]').waitFor();
  assert.equal(await dialog.locator(".session-error").count(), 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  const openPi = async () => {
    await page.evaluate(() => window.qa.openHistory("w1", "pi", "p1"));
    await dialog.locator(".session-row").first().waitFor();
  };
  await openPi();
  assert.deepEqual(await dialog.locator(".session-title").allTextContents(), ["Deep Pi name", "Late Pi prompt"]);
  assert.equal(await dialog.locator(".session-id").count(), 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  appendFileSync(piNamed, piLine({ type: "session_info", name: "Renamed Pi" }));
  utimesSync(piNamed, 1_790_000_003, 1_790_000_003);
  await openPi();
  assert.equal(await dialog.locator(".session-title").first().textContent(), "Renamed Pi");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  appendFileSync(piNamed, piLine({ type: "session_info", name: " " }));
  utimesSync(piNamed, 1_790_000_004, 1_790_000_004);
  await openPi();
  assert.deepEqual(await dialog.locator(".session-title").allTextContents(), ["Named Pi first prompt", "Late Pi prompt"]);
  assert.equal(await dialog.locator(".session-id").count(), 0);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  console.log("PASS Pi busy-once automatic recovery, bounded persistent busy with Retry, late labels and fresh rename/clear");
  // the keyboard alone: the row's context-menu key, the item, the first row's button focused, arrows
  // along the rows, Tab inside, Escape closing with the focus back on the row
  await row("w1").focus();
  await contextMenuKey(page);
  const keyMenu = page.getByRole("menu");
  await keyMenu.waitFor();
  // RowMenu places its initial focus in an animation frame; let it finish before choosing another item.
  await settled(page);
  await keyMenu.getByRole("menuitem", { name: "Earlier sessions…", exact: true }).focus();
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await dialog.locator(".session-row").first().waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Resume Retry budget for the payment client");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resume Flaky export test");
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resume Flaky export test", "the last row holds the focus");
  await page.keyboard.press("ArrowUp");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resume Retry budget for the payment client");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Resume Flaky export test");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => document.activeElement?.closest('.workspace-group[data-workspace="w1"]') !== null);
  console.log("PASS arrows move along the rows, Tab stays inside, Escape closes and the focus returns to the row");
  // Resume the older one: exactly one tab/create however often the button is clicked while it is in flight
  await openHistory("w1");
  // the roster lags the answer, as it does until load() brings the new pane: the next scenario needs that window
  await page.evaluate(() => { window.qa.holdRoster = true; });
  holdTabCreate = true;
  const resume = dialog.getByRole("button", { name: "Resume Flaky export test", exact: true });
  await resume.dblclick();
  await page.waitForFunction(() => document.querySelector(".session-row.is-pending") !== null);
  await resume.click({ force: true }).catch(() => undefined);
  await page.getByRole("status").filter({ hasText: "Resuming…" }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: /^Resume / }).evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled)), true, "every Resume is disabled while one is in flight");
  assert.equal(await picker.isDisabled(), true, "the agent picker is disabled while a resume is in flight");
  await settled(page);
  await page.screenshot({ path: join(evidence, "happy-pending.png") });
  assert.equal(tabCreates.length, 1, `a double click sends one tab/create, not ${tabCreates.length}`);
  assert.deepEqual(tabCreates[0], { workspace_id: "w1", cwd: "/fixture/w1", label: null, agent: { kind: "codex", args: ["resume", OLDER_SESSION] } });
  holdTabCreate = false;
  releases.splice(0).forEach((release) => release());
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.qa.resumed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.qa.resumed), [{ workspace_id: "w1", pane_id: "p-new-1", agent_started: true }]);
  assert.equal(tabCreates.length, 1, "nothing more was sent once the first answer came");
  console.log("PASS Resume sends one tab/create with the row's argv; a double click sends no second one");
  // the reopen window (T31-AV-1): the list opened again before herdr has reported the new pane's session, even
  // before the roster lists the pane, offers no second Resume; once the pane is listed, Open selects it, and once
  // herdr reports the session the pane's own report says it; the pane closed, the session can be resumed again
  await openHistory("w1");
  const older = dialog.locator(".session-row").nth(1);
  await older.locator(".pill", { hasText: "Already open" }).waitFor();
  assert.equal(await older.getByRole("button", { name: /^Resume / }).count(), 0, "no second Resume while the record stands");
  assert.equal(await older.getByRole("button", { name: "Open the pane showing Flaky export test", exact: true }).isDisabled(), true, "nothing to open until the roster lists the new pane");
  assert.equal(await dialog.getByRole("button", { name: /^Resume / }).count(), 1, "the other row still offers Resume");
  await page.evaluate(() => { window.qa.holdRoster = false; window.qa.rosterCatchUp(); });
  await older.getByRole("button", { name: "Open the pane showing Flaky export test", exact: true, disabled: false }).waitFor();
  await settled(page);
  await page.screenshot({ path: join(evidence, "reopen-window.png") });
  await older.getByRole("button", { name: "Open the pane showing Flaky export test", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.qa.selected === "p-new-1");
  assert.equal(tabCreates.length, 1, "reopening the list and Open start nothing");
  await page.evaluate((id) => window.qa.reportSession("p-new-1", id), OLDER_SESSION);
  await openHistory("w1");
  await older.locator(".pill", { hasText: "Already open" }).waitFor();
  assert.equal(await older.getByRole("button", { name: /^Resume / }).count(), 0, "the pane's own report keeps Open");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.evaluate(() => window.qa.closePane("p-new-1"));
  await openHistory("w1");
  await older.getByRole("button", { name: "Resume Flaky export test", exact: true }).waitFor();
  assert.equal(await older.locator(".pill").count(), 0, "a closed pane shows nothing: Resume is back");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(tabCreates.length, 1);
  console.log("PASS the list reopened before herdr reports the new pane's session offers Open, not Resume; Resume returns once the pane closes");
  // a session a pane of the workspace already shows: Open selects that pane, nothing is started
  await openHistory("w2");
  const shown = dialog.locator(".session-row").first();
  await shown.locator(".pill", { hasText: "Already open" }).waitFor();
  assert.equal(await shown.getByRole("button", { name: /^Resume / }).count(), 0);
  await page.screenshot({ path: join(evidence, "already-open.png") });
  await shown.getByRole("button", { name: "Open the pane showing Retry budget for the payment client", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.qa.selected === "p2");
  assert.equal(tabCreates.length, 1, "selecting the pane that shows the session creates no tab");
  console.log("PASS a session already shown by a pane is opened by selecting that pane");
  // another agent: the picker lists the PC's agents with their marks and no Shell, its open list takes
  // Escape alone (the dialog stays), the keys choose one, and its (empty) list is said in words
  await openHistory("w1");
  await picker.click();
  const agentList = page.getByRole("listbox", { name: "Agent" });
  await agentList.waitFor();
  assert.deepEqual(await agentList.getByRole("option").allTextContents(), ["Codex", "Claude Code"], "the agents as /api/agents lists them, no Shell");
  assert.equal(await agentList.locator(".agent-mark").count(), 2, "each row carries its agent's mark");
  await settled(page);
  await page.screenshot({ path: join(evidence, "agent-list.png") });
  await page.keyboard.press("Escape");
  await agentList.waitFor({ state: "detached" });
  assert.equal(await dialog.isVisible(), true, "Escape on the open list closes the list, not the dialog");
  assert.equal(await picker.evaluate((node) => node === document.activeElement), true, "the trigger keeps the focus");
  await page.keyboard.press("ArrowDown");
  await agentList.waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await agentList.waitFor({ state: "detached" });
  await picker.locator(".agent-mark.claude").waitFor();
  assert.equal(await picker.locator(".agent-picker-label").textContent(), "Claude Code");
  await dialog.locator(".session-empty").waitFor();
  assert.equal(await dialog.locator(".session-empty").textContent(), "No earlier Claude Code sessions in this folder.");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  console.log("PASS the agent picker lists the agents with their marks, closes its list alone on Escape and takes the keys; an empty store is said in words");
  // the sessions arrive while the agent list is open: the list keeps the focus, so its keys and Escape stay
  // the list's, not the first Resume's and the dialog's
  holdList = true;
  const listHeld = once(heldLists, "held", { signal: AbortSignal.timeout(10_000) });
  await (await openMenu("w3")).getByRole("menuitem", { name: "Earlier sessions…", exact: true }).click();
  await dialog.waitFor();
  await listHeld;
  assert.equal(await dialog.locator(".session-row").count(), 0, "the sessions are still on their way");
  await picker.click();
  await agentList.waitFor();
  holdList = false;
  releases.splice(0).forEach((release) => release());
  await dialog.locator(".session-row").first().waitFor();
  await settled(page);
  assert.equal(await agentList.isVisible(), true, "the open list stays open when the sessions arrive");
  assert.equal(await picker.evaluate((node) => node === document.activeElement), true, "the open list keeps the focus when the sessions arrive");
  await page.keyboard.press("Escape");
  await agentList.waitFor({ state: "detached" });
  assert.equal(await dialog.isVisible(), true, "Escape after the sessions arrived closes the list, not the dialog");
  console.log("PASS sessions arriving while the agent list is open leave it the focus and its Escape");
  // Safari leaves the focus off a button a click opened: the open list still takes Escape alone
  await picker.click();
  await agentList.waitFor();
  await picker.evaluate((node) => (node as HTMLElement).blur());
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "the focus is off the picker, as Safari leaves it");
  await page.keyboard.press("Escape");
  await agentList.waitFor({ state: "detached" });
  assert.equal(await dialog.isVisible(), true, "Escape with the focus off the open list closes the list, not the dialog");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  console.log("PASS an open agent list takes Escape alone with the focus off its button; the next Escape closes the dialog");
  // an overlay opened over the dialog keeps its own Escape while the agent list stays open under it:
  // a native modal (Add PC from the palette), and an overlay holding the focus outside the dialog
  await openHistory("w1");
  await picker.click();
  await agentList.waitFor();
  await page.evaluate(() => {
    const modal = document.createElement("dialog");
    modal.id = "qa-native-modal";
    modal.innerHTML = '<button type="button">Add PC</button>';
    document.body.append(modal);
    modal.showModal();
    // the focus on body, as Safari leaves it after a click in the modal: only the modal check keeps this Escape the modal's
    modal.querySelector("button")!.focus();
    modal.querySelector("button")!.blur();
  });
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true, "the focus is on body under the native modal");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !(document.getElementById("qa-native-modal") as HTMLDialogElement).open);
  assert.equal(await agentList.isVisible(), true, "Escape in a native modal over the dialog closes that modal, not the agent list under it");
  await page.evaluate(() => document.getElementById("qa-native-modal")!.remove());
  const outside = await page.evaluate(() => {
    const field = document.createElement("input");
    field.setAttribute("aria-label", "qa overlay field");
    // fixed, as the palette is: focusing a field below #root scrolls the page, and the list closes on that scroll
    field.style.cssText = "position: fixed; top: 0; left: 0";
    document.body.append(field);
    field.focus();
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    field.dispatchEvent(escape);
    field.remove();
    return escape.defaultPrevented;
  });
  assert.equal(outside, false, "an Escape from an overlay outside the dialog is left to that overlay");
  assert.equal(await agentList.isVisible(), true, "the agent list under that overlay stays open");
  console.log("PASS an overlay over the dialog keeps its own Escape while the agent list stays open under it");
  // with the overlay gone the focus is nowhere: the list takes the next Escape, the dialog the one after
  await page.keyboard.press("Escape");
  await agentList.waitFor({ state: "detached" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  // Claude: the list is asked for from a pane of the workspace (its store's), and the same UUID reported by a
  // pane on another store is not that row's session: Resume, not Open
  await openHistory("w3");
  assert.equal(await picker.locator(".agent-picker-label").textContent(), "Claude Code");
  assert.ok(claudeLists.length >= 1 && claudeLists.every((query) => new URLSearchParams(query).get("pane_id") === "p3"), `the list names its source pane: ${JSON.stringify(claudeLists)}`);
  const shared = dialog.locator(".session-row").first();
  assert.equal(await shared.locator(".pill").count(), 0, "p4 reports the same id from another store: no Already open");
  await shared.getByRole("button", { name: /^Resume / }).waitFor();
  await settled(page);
  await page.screenshot({ path: join(evidence, "claude-store-rows.png") });
  // one store-bound request per double click, never the argv-only tab/create
  const tabsBefore = tabCreates.length;
  holdResume = true;
  const receivedResume = once(resumeRequests, "received", { signal: AbortSignal.timeout(10_000) });
  await shared.getByRole("button", { name: /^Resume / }).dblclick();
  await receivedResume;
  await page.waitForFunction(() => document.querySelector(".session-row.is-pending") !== null);
  await page.getByRole("status").filter({ hasText: "Resuming…" }).waitFor();
  assert.equal(resumes.length, 1, `a double click sends one sessions/resume, not ${resumes.length}`);
  assert.deepEqual(resumes[0], { workspace_id: "w3", pane_id: "p3", agent: "claude", session_id: CLAUDE_SHARED, store_key: CLAUDE_STORE_KEY });
  holdResume = false;
  releases.splice(0).forEach((release) => release());
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.qa.resumed.some((opened) => opened.pane_id === "p-claude-1"));
  assert.equal(tabCreates.length, tabsBefore, "Claude's Resume sends no tab/create");
  console.log("PASS a Claude list names its source pane; one store-bound resume per double click, no tab/create, and a pane on another store is not Open");
  // switching a shell/Codex request to Claude re-picks the pane running Claude
  await page.evaluate(() => window.qa.openHistory("w3", "codex", "p-shell"));
  await dialog.locator(".session-row").first().waitFor();
  await settled(page);
  await picker.click();
  const pickedList = page.waitForResponse((response) => response.url().includes("/sessions/history?") && new URL(response.url()).searchParams.get("agent") === "claude");
  await agentList.getByRole("option").filter({ hasText: "Claude Code" }).click();
  await pickedList;
  await picker.locator(".agent-mark.claude").waitFor();
  await shared.waitFor();
  assert.equal(new URLSearchParams(claudeLists.at(-1)).get("pane_id"), "p3");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  // a store that changed since the list: read again and said so, nothing started elsewhere
  resumeAnswer = "stale";
  await openHistory("w3");
  const listsBefore = claudeLists.length;
  const asked = dialog.getByRole("button", { name: /^Resume / }).last();
  const askedLabel = await asked.getAttribute("aria-label");
  const geometry = () => dialog.evaluate((element) => { const box = element.getBoundingClientRect(); return [box.top, box.height]; });
  const before = await geometry();
  holdList = true;
  await asked.click();
  // read again: the rows stay where they were, without their buttons, until the new ones come
  await page.getByRole("status").filter({ hasText: "Reading sessions…" }).waitFor();
  assert.equal(await dialog.locator(".session-row").count(), CLAUDE_ROWS.length, "the rows stay while the list is read again");
  assert.equal(await dialog.getByRole("button", { name: /^Resume / }).evaluateAll((buttons) => buttons.every((button) => (button as HTMLButtonElement).disabled)), true, "no Resume while the list is read again");
  assert.deepEqual(await geometry(), before, "nothing moves while the list is read again");
  holdList = false;
  releases.splice(0).forEach((release) => release());
  await page.getByRole("status").filter({ hasText: "Claude's store changed; the list was read again." }).waitFor();
  await page.waitForFunction((label) => document.activeElement?.getAttribute("aria-label") === label, askedLabel);
  await settled(page);
  assert.deepEqual(await geometry(), before, "the list read again sits where it was");
  assert.ok(claudeLists.length > listsBefore, "the list was read again");
  assert.equal(resumes.at(-1)?.["session_id"], CLAUDE_OTHER);
  await settled(page);
  await page.screenshot({ path: join(evidence, "claude-store-relisted.png") });
  // the bridge names the pane already showing it on that store: selected, as Open does, nothing made
  resumeAnswer = "opened";
  await dialog.getByRole("button", { name: /^Resume / }).last().click();
  await dialog.waitFor({ state: "detached" });
  await page.waitForFunction(() => window.qa.selected === "p4");
  // a bridge with source rows but no resume route: said so, and never an unbound tab/create instead
  resumeAnswer = "missing";
  await openHistory("w3");
  await dialog.getByRole("button", { name: /^Resume / }).last().click();
  await dialog.locator(".session-error").filter({ hasText: "This PC's bridge does not offer this yet" }).waitFor();
  assert.equal(tabCreates.length, tabsBefore, "a 404 resume route falls back to no tab/create");
  // a store a new tab would not keep: said in the user's words, nothing started
  resumeAnswer = "unsupported";
  await dialog.getByRole("button", { name: /^Resume / }).last().click();
  await dialog.locator(".session-error").filter({ hasText: "This PC can't start this session in the store it was listed from" }).waitFor();
  assert.equal(tabCreates.length, tabsBefore, "an unsupported launch falls back to no tab/create");
  const unsupportedMessage = await dialog.locator(".session-error").textContent();
  resumeAnswer = "changed";
  await dialog.getByRole("button", { name: /^Resume / }).last().click();
  await page.waitForFunction((previous) => {
    const alert = document.querySelector(".session-error");
    return alert !== null && alert.textContent !== previous;
  }, unsupportedMessage);
  assert.ok(!(await dialog.locator(".session-error").textContent())?.includes("qa-launch-store-changed"));
  assert.equal(tabCreates.length, tabsBefore, "a changed launch store starts no fallback tab");
  // a closed source: stale Resume re-lists from the current roster, never the departed pane
  resumeAnswer = "stale";
  holdResume = true;
  const closingResume = once(resumeRequests, "received", { signal: AbortSignal.timeout(10_000) });
  await dialog.getByRole("button", { name: /^Resume / }).last().click();
  await closingResume;
  await dialog.locator(".session-row.is-pending").waitFor();
  closedSources.add("p3");
  closedSources.add("p4");
  await page.evaluate(() => { window.qa.closePane("p3"); window.qa.closePane("p4"); });
  holdResume = false;
  releases.splice(0).forEach((release) => release());
  await page.getByRole("status").filter({ hasText: "Claude's store changed; the list was read again." }).waitFor();
  assert.equal(new URLSearchParams(claudeLists.at(-1)).get("pane_id"), "p-claude-1");
  assert.equal(await dialog.locator(".session-error").count(), 0);
  // a stale GET arriving before the roster catches up is translated, then recovers on the roster
  closedSources.add("p-claude-1");
  await dialog.getByRole("button", { name: /^Resume / }).last().click();
  await dialog.locator(".session-error").waitFor();
  await page.evaluate(() => window.qa.closePane("p-claude-1"));
  await dialog.locator(".session-error").waitFor({ state: "detached" });
  await dialog.locator(".session-row").first().waitFor();
  assert.equal(new URLSearchParams(claudeLists.at(-1)).get("pane_id"), "p-shell");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  resumeAnswer = "created";
  console.log("PASS a changed store is read again in place with the focus kept, an already shown session is selected, and a missing route or unsupported launch never falls back to tab/create");
  // an older bridge: rows without a store source offer no Resume at all
  const resumesBefore = resumes.length;
  await openHistory("w4");
  assert.equal(await dialog.getByRole("button", { name: /^Resume / }).count(), 0, "no Resume for a row its bridge bound to no store");
  assert.equal(await dialog.locator(".pill", { hasText: "Resume unavailable" }).count(), CLAUDE_ROWS.length);
  await settled(page);
  await page.screenshot({ path: join(evidence, "claude-older-bridge.png") });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(resumes.length, resumesBefore, "nothing is sent for an older bridge's rows");
  assert.equal(tabCreates.length, tabsBefore);
  console.log("PASS an older bridge's Claude rows show Resume unavailable and send nothing");
  // a PC whose bridge is from before the route: asked once without listing anything, and the item stays away
  const probed = page.waitForResponse((response) => response.url().includes("/api/machines/old-pc/sessions/history"));
  await page.evaluate(() => window.qa.machine("old-pc"));
  await probed;
  await row("w1").waitFor();
  // StrictMode mounts the sidebar's effect twice in this development bundle: each probe is query-less
  assert.ok(probes.length >= 1 && probes.every((query) => query === ""), `the probe carries no workspace and lists no session: ${JSON.stringify(probes)}`);
  const remoteMenu = await openMenu("w1");
  assert.deepEqual(await remoteMenu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Close workspace"], "no Earlier sessions on a PC whose bridge cannot list them");
  await settled(page);
  await page.screenshot({ path: join(evidence, "remote-404.png") });
  await page.keyboard.press("Escape");
  console.log("PASS a bridge answering 404 hides the menu item");
  // a device that only watches is refused the list on its own PC too: the menu does not offer it
  await page.evaluate(() => { window.qa.machine("local"); window.qa.watch(true); });
  await row("w1").waitFor();
  const watchMenu = await openMenu("w1");
  assert.ok(!(await watchMenu.getByRole("menuitem").allTextContents()).includes("Earlier sessions…"), "no Earlier sessions for a device that only watches");
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.qa.watch(false));
  console.log("PASS a device that only watches is not offered the list");
  writeFileSync(join(evidence, "request-log.txt"), [
    "POST /api/tab/create bodies, in order (the double click on Resume sent the one below):",
    ...tabCreates.map((body, index) => `${index + 1}. ${JSON.stringify(body)}`),
    `old-pc probes: ${JSON.stringify(probes)}`,
    "Claude list queries, in order:",
    ...claudeLists.map((query, index) => `${index + 1}. ${query}`),
    "POST /api/sessions/resume bodies, in order:",
    ...resumes.map((body, index) => `${index + 1}. ${JSON.stringify(body)}`),
  ].join("\n") + "\n");
  assert.deepEqual(errors, []);
  console.log("PASS no browser errors");
} finally {
  releases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  piReader.close();
  await piReader.idle();
  rmSync(root, { recursive: true, force: true });
}
