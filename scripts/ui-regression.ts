/** Real-browser regressions against owned herdr panes. Run after `bun run build`. */
import "./test-herdr.ts"; // a herdr session of its own: nothing shows in the user's
import assert from "node:assert/strict";
import { copyFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";
import type { BrowserContext, Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import type { SessionSnapshot, WorkspaceCreated, WorktreeOpened } from "../shared/protocol.ts";
import type { Machine } from "../shared/machines.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments.ts";
import { alertsOffMarked, alertsState, runMoreItem } from "./header-more.ts";
import { routeDrained } from "./drained-route.ts";
import { contextMenuKey } from "./context-menu-key.ts";
import { checkTerminalFileInput } from "./terminal-file-input-regression.ts";
import { checkTerminalInput } from "./terminal-input-regression.ts";
import { checkSafariIme } from "./terminal-safari-ime-regression.ts";
import { checkIpadIme } from "./terminal-ipad-ime-regression.ts";
import { checkLinuxIme } from "./terminal-linux-ime-regression.ts";
import { checkHeldDraftPaneSwitch } from "./terminal-draft-regression.ts";
import { checkCommandBackspace } from "./terminal-command-backspace-regression.ts";
import { checkCtrlEnter } from "./terminal-ctrl-enter-regression.ts";
import { checkCommandArrows } from "./terminal-command-arrows-regression.ts";
import { checkFolderFilter, checkNewFolder } from "./folder-filter-regression.ts";
import { checkPaletteKeys } from "./palette-keys-regression.ts";
import { checkFollowHerdrFocus } from "./follow-focus-regression.ts";
import { checkRelayPanel } from "./relay-panel-regression.ts";
import { systemUsageContext, UsageService } from "../server/usage.ts";
import { openSettingsPage } from "./settings-page.ts";
import { assertCspClean, watchCsp } from "./csp-violations.ts";
import type { CspWatch } from "./csp-violations.ts";
import { browserEvidencePage, browserEvidenceTracing, startBrowserEvidence } from "./browser-evidence.ts";
import type { BrowserEvidenceSession } from "./browser-evidence.ts";
import { chromePath } from "./chrome-path.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-browser-")));
const workspaces: string[] = [];
const worktreeWorkspaces: string[] = [];
// the repository the worktree step makes, for the cleanup to find what the step made
let repo: string | null = null;
const releases: Array<() => void> = [];
const errors: string[] = [];
/** One entry per page that loaded the app through the real server, and so saw the real policy. */
const csp: CspWatch[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const evidenceSessions: BrowserEvidenceSession[] = [];
const evidenceDirectory = process.env.CHECK_BROWSER_EVIDENCE_DIR;
const evidenceTrace = process.env.CHECK_BROWSER_EVIDENCE_TRACE === "1";
async function watchBrowserEvidence(context: BrowserContext, page: Page, scenario: string): Promise<BrowserEvidenceSession | undefined> {
  if (!evidenceDirectory) return undefined;
  const evidence = await startBrowserEvidence({
    page: browserEvidencePage(page),
    tracing: browserEvidenceTracing(context),
    directory: evidenceDirectory,
    script: "ui-regression",
    scenario,
    trace: evidenceTrace,
  });
  evidenceSessions.push(evidence);
  return evidence;
}
/** WebKit's IME commit: an Enter keydown after compositionend, isComposing false, key code 229 */
const IME_ENTER = { key: "Enter", code: "Enter", keyCode: 229, which: 229, bubbles: true, cancelable: true };
/** how long a send that should not happen gets to show up */
const NO_SEND_WAIT_MS = 400;

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(50);
  }
}

try {
  const panes: string[] = [];
  for (const suffix of ["a", "b"]) {
    const cwd = join(root, suffix);
    mkdirSync(cwd);
    const result = await workspaceCreate({ cwd, label: `ovis-test-browser-${suffix}` });
    workspaces.push(result.workspace.workspace_id);
    panes.push(result.root_pane.pane_id);
  }
  const [paneA, paneB] = panes as [string, string];
  // no provider is asked with the test machine's own sign-ins
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "push"), usage: new UsageService({ ...systemUsageContext(), home: root, env: {} }, []) });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({
    executablePath: chromePath(),
    // English whatever the machine's own languages are (macOS Chrome takes them from the system)
    headless: true, args: ["--no-sandbox", "--accept-lang=en-US"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((ids) => {
    // only the first load: a reload must keep what Settings stored, such as the language
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
  }, panes);
  // A hook for a check that changes the roster on a page already loaded: a route cannot reach the
  // /api/machines/events stream the page has open, so `window.__rewriteMachinesFrame`, while set,
  // rewrites each frame's data before the app reads it (the plan check below).
  await context.addInitScript(() => {
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      override get onmessage() { return super.onmessage; }
      override set onmessage(handler) {
        super.onmessage = typeof handler !== "function" ? handler : (event: MessageEvent) => {
          const rewrite = (window as unknown as { __rewriteMachinesFrame?: (data: string) => string }).__rewriteMachinesFrame;
          handler.call(this, rewrite ? new MessageEvent("message", { data: rewrite(event.data) }) : event);
        };
      }
    };
  });

  const page = await context.newPage();
  const pageEvidence = evidenceDirectory ? await watchBrowserEvidence(context, page, "main-app") : undefined;
  const workspaceGroup = (workspaceId: string) => page.locator(`.workspace-group[data-workspace="${workspaceId}"]`);
  const workspaceHeader = (workspaceId: string) => workspaceGroup(workspaceId).locator(":scope > .workspace-header");
  const agentRow = (paneId: string) => page.locator(`.agents-sidebar .agent-item[data-machine="local"][data-pane="${paneId}"]`);
  // the header under test is the app's own (server/static.ts), so this is where a broken
  // directive shows up: every page below loads through this same server
  csp.push(await watchCsp(page));
  let holdSubmitResult = false;
  let releaseSubmitResult: (() => void) | null = null;
  // a connection's first frames held back: what the page does between a reconnect and the frame that
  // says what the bridge supports (features), and then its snapshot
  let holdSnapshot = false;
  let releaseFeatures: (() => void) | null = null;
  let releaseSnapshot: (() => void) | null = null;
  const routed: Array<{ close: () => Promise<void> }> = [];
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    routed.push(socket);
    const upstream = socket.connectToServer();
    upstream.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (holdSnapshot && message.type === "features") {
        const release = () => { socket.send(raw); releaseFeatures = null; };
        releaseFeatures = release;
        releases.push(release);
      } else if (holdSnapshot && message.type === "snapshot") {
        holdSnapshot = false;
        const release = () => { socket.send(raw); releaseSnapshot = null; };
        releaseSnapshot = release;
        releases.push(release);
      } else if (holdSubmitResult && message.type === "submit-result") {
        holdSubmitResult = false;
        const release = () => { socket.send(raw); releaseSubmitResult = null; };
        releaseSubmitResult = release;
        releases.push(release);
      } else socket.send(raw);
    });
  });
  page.setDefaultTimeout(10_000);
  page.on("pageerror", (error) => errors.push(error.message));
  const painted = new Set<string>();
  const sockets: import("playwright-core").WebSocket[] = [];
  const inputs: Array<{ type: "input" | "submit"; pane_id: string; text: string; delivery?: "immediate" | "queue"; stop?: true }> = [];
  const pendingActions: Array<{ pane_id: string; pending_id: string; action: string }> = [];
  // keyed by pane, with the connection that said so: an earlier connection's input-ready says nothing about the current one
  const inputStates = new Map<string, { ready: boolean; at: number; socket: import("playwright-core").WebSocket }>();
  const pendingReady = (pane: string) => until(() => {
    const state = inputStates.get(pane);
    return state?.ready === true && state.socket === sockets.at(-1) && !state.socket.isClosed() && Date.now() - state.at >= 500;
  }, `stable pending attachment of ${pane}`);
  page.on("websocket", (socket) => {
    sockets.push(socket);
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "pty-data") painted.add(message.pane_id);
      if (message.type === "input-ready") inputStates.set(message.pane_id, { ready: message.ready !== false, at: Date.now(), socket });
    });
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      // composer messages go out as "submit" on servers that list it (#15), keystrokes as "input"
      if (message.type === "input" || message.type === "submit") inputs.push(message);
      if (message.type === "pending-action") pendingActions.push(message);
      if (message.type === "attach" || message.type === "detach") inputStates.set(message.pane_id, { ready: false, at: Date.now(), socket });
    });
  });
  await page.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
  await page.locator(".conn-live").waitFor();
  await until(() => painted.has(paneA), "owned pane paint");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.waitFor();
  await page.locator(".composer .voice-mic").waitFor();
  console.log("PASS a desktop's chat offers the mic before Settings is asked");
  assert.equal(await workspaceHeader(workspaces[0]!).locator(".workspace-name").textContent(), "ovis-test-browser-a",
    "Spaces names the workspace rather than its current pane");
  assert.equal(await workspaceGroup(workspaces[0]!).locator(".pane-select").count(), 1, "a workspace has one representative selector");
  assert.equal(await page.locator(".workspace-contents, .sidebar-tab-heading, .sidebar-pane-item").count(), 0,
    "Spaces has no tab or pane tree");
  assert.equal(await agentRow(paneA).count(), 0, "a plain shell is absent from Agents");
  assert.equal(await agentRow(paneB).count(), 0, "another plain shell is absent from Agents");

  // The search owns arrow/Enter navigation. Tab still reaches real buttons: Enter on Close
  // must close without selecting the highlighted result, and Enter on a row runs that row.
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  const paletteSearch = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
  const selectedPane = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id as string | undefined);
  const openPalette = async (): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await palette.waitFor();
    await until(async () => await paletteSearch.evaluate((input) => document.activeElement === input), "palette search takes focus");
  };
  await openPalette();
  await paletteSearch.fill("ovis-test-browser-b");
  await until(async () => await palette.locator(".palette-pane").count() === 1, "the other pane is the palette's only result");
  await page.keyboard.press("Tab");
  assert.equal(await palette.getByRole("button", { name: "Close command palette", exact: true }).evaluate((button) => document.activeElement === button), true,
    "Tab reaches the close button from search");
  await page.keyboard.press("Enter");
  await palette.waitFor({ state: "hidden" });
  assert.equal(await selectedPane(), paneA, "Enter on Close leaves the pane selection alone");

  // A reopened palette starts from an empty search in its first render, the DOM its opening commit
  // leaves (sampled by the observer before any later task): a render of the last search's results lets
  // a Tab that lands before the next one focus a row at an index the full list then gives to another (#608).
  await page.evaluate(() => {
    const frames: string[] = [];
    (window as unknown as { paletteFirstFrame: string[] }).paletteFirstFrame = frames;
    new MutationObserver((_, observer) => {
      const search = document.querySelector<HTMLInputElement>(".command-palette input[type=search]");
      if (!search) return;
      frames.push(search.value);
      observer.disconnect();
    }).observe(document.body, { childList: true, subtree: true });
  });
  await openPalette();
  assert.deepEqual(await page.evaluate(() => (window as unknown as { paletteFirstFrame: string[] }).paletteFirstFrame), [""],
    "a reopened palette's first render shows none of the last search's results");
  // a row names its tab and folder; its workspace is the heading of its section
  const otherPalettePane = palette.locator(`.palette-section[data-section="${workspaces[1]}"] .palette-pane`);
  // Walk the actual tab order instead of clicking: pointer hover must not pick the row for us.
  for (const deadline = Date.now() + 5_000; ;) {
    await page.keyboard.press("Tab");
    if (await otherPalettePane.evaluate((button) => document.activeElement === button)) break;
    assert.ok(Date.now() < deadline, "Tab reaches the other pane's option");
  }
  // bounded: in #608's race the focused row never became the highlighted one, so this still fails there
  await until(async () => await otherPalettePane.evaluate((button) =>
    document.activeElement === button && button.getAttribute("aria-selected") === "true"), "the focused option is highlighted");
  await page.keyboard.press("Enter");
  await palette.waitFor({ state: "hidden" });
  await until(async () => await selectedPane() === paneB, "Enter on the focused option selects that pane");
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  await until(async () => await selectedPane() === paneA, "return to the first pane after palette selection");

  await openPalette();
  await paletteSearch.fill("ovis-test-browser-b");
  await until(async () => await palette.locator(".palette-pane").count() === 1, "IME check has a matching result to avoid activating");
  const paletteComposition = await paletteSearch.evaluate((input) => [
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "ArrowUp", isComposing: true },
    { key: "ArrowDown", isComposing: true },
    { key: "Escape", isComposing: true },
    { key: "Escape", keyCode: 229 },
  ].map((init) => input.dispatchEvent(new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }))));
  assert.deepEqual(paletteComposition, [true, true, true, true, true, true], "IME candidate, commit and cancel keys keep their default action");
  assert.equal(await palette.isVisible(), true, "IME Enter and Escape leave the palette open");
  assert.equal(await selectedPane(), paneA, "IME Enter never activates its matching pane");
  assert.equal(await paletteSearch.inputValue(), "ovis-test-browser-b", "IME cancellation leaves the query alone");
  await paletteSearch.press("Escape");
  await palette.waitFor({ state: "hidden" });

  // Short desktop and phone lists both overflow. Wrapping up from the first result and down
  // from the last keeps the active option visible while typing focus stays in search.
  const paletteViewport = page.viewportSize()!;
  for (const viewport of [{ width: 1280, height: 400 }, { width: 390, height: 600 }]) {
    await page.setViewportSize(viewport);
    await openPalette();
    await page.mouse.move(0, 0);
    assert.equal(await palette.locator(".palette-results").evaluate((list) => list.scrollHeight > list.clientHeight), true,
      "the short palette has a scrollable list");
    const optionCount = await palette.getByRole("option").count();
    const visibleActiveOption = () => palette.locator(".palette-results").evaluate((list) => {
      const option = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!option) return false;
      const row = option.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      return row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1;
    });
    await paletteSearch.press("ArrowUp");
    await until(async () => await paletteSearch.getAttribute("aria-activedescendant") === `palette-item-${optionCount - 1}` && await visibleActiveOption(),
      "ArrowUp wraps to the last visible palette option");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `palette-arrow-${viewport.width <= 640 ? "mobile" : "desktop"}.png`) });
    }
    await paletteSearch.press("ArrowDown");
    await until(async () => await paletteSearch.getAttribute("aria-activedescendant") === "palette-item-0" && await visibleActiveOption(),
      "ArrowDown wraps back to the first visible palette option");
    assert.equal(await paletteSearch.evaluate((input) => document.activeElement === input), true, "arrow navigation keeps typing focus in search");
    await paletteSearch.press("Escape");
    await palette.waitFor({ state: "hidden" });
  }
  // A pointer resting over the list keeps still while the arrow scrolls rows under it: the
  // browser's hover update after the scroll must not take the keyboard selection, and a real
  // pointer move still does.
  await page.setViewportSize({ width: 1280, height: 400 });
  await openPalette();
  const restingOptionCount = await palette.getByRole("option").count();
  const firstOption = (await palette.locator("#palette-item-0").boundingBox())!;
  await page.mouse.move(firstOption.x + firstOption.width / 2, firstOption.y + firstOption.height / 2);
  await until(async () => await paletteSearch.getAttribute("aria-activedescendant") === "palette-item-0", "the resting pointer is over the first option");
  await palette.locator(".palette-results").evaluate((list) => {
    const hovered: string[] = [];
    (window as unknown as { paletteHovered: string[] }).paletteHovered = hovered;
    list.addEventListener("mouseover", (event) => hovered.push((event.target as HTMLElement).closest("[role=option]")?.id ?? ""));
  });
  await paletteSearch.press("ArrowUp");
  await until(async () => await page.evaluate(() => (window as unknown as { paletteHovered: string[] }).paletteHovered.some((id) => id !== "" && id !== "palette-item-0")),
    "the scroll moves another option under the resting pointer");
  assert.equal(await paletteSearch.getAttribute("aria-activedescendant"), `palette-item-${restingOptionCount - 1}`,
    "a scroll under a resting pointer leaves the arrow's selection alone");
  const hoveredId = await page.evaluate(() => (window as unknown as { paletteHovered: string[] }).paletteHovered.findLast((id) => id !== "")!);
  const hoveredBox = (await palette.locator(`#${hoveredId}`).boundingBox())!;
  await page.mouse.move(hoveredBox.x + hoveredBox.width / 2 + 4, hoveredBox.y + hoveredBox.height / 2);
  await until(async () => await paletteSearch.getAttribute("aria-activedescendant") === hoveredId, "a real pointer move selects the option under it");
  await paletteSearch.press("Escape");
  await palette.waitFor({ state: "hidden" });
  await page.mouse.move(0, 0);
  await page.setViewportSize(paletteViewport);
  console.log("PASS palette buttons keep native Enter, IME keeps its keys, and arrow selection stays visible on short desktop and phone lists");
  await checkPaletteKeys(page, { workspaceId: workspaces[1]! });
  await checkFollowHerdrFocus(page, { workspaceId: workspaces[1]! });

  // Hold a real machines response, then deliver a newer status through herdr/SSE.
  const badge = page.locator(".pane-item.is-selected .badge");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "blocked" });
  await until(async () => await badge.getAttribute("data-status") === "blocked", "blocked baseline");
  await agentRow(paneA).locator('.badge[data-status="blocked"]').waitFor();
  assert.equal(await agentRow(paneA).locator('.agent-select[aria-current="true"]').count(), 1,
    "Agents independently marks its selected pane");
  assert.equal(await agentRow(paneA).locator('.sidebar-status[role="status"]').count(), 1,
    "Agents uses a compact accessible status");
  assert.ok((await agentRow(paneA).locator(".agent-title").textContent())?.trim(), "an agent has a task title");
  let releasePoll!: () => void;
  const heldPoll = new Promise<void>((resolve) => { releasePoll = resolve; });
  releases.push(releasePoll);
  let pollChosen = false;
  let pollCaptured = false;
  let pollFinished = false;
  const unrouteHeldPoll = await routeDrained(page, "**/api/machines", async (route) => {
    // Hold only the stale read; later refreshes pass through without pending route handlers.
    if (pollChosen) { await route.continue(); return; }
    pollChosen = true;
    const response = await route.fetch();
    pollCaptured = true;
    await heldPoll;
    await route.fulfill({ response });
    pollFinished = true;
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await until(() => pollCaptured, "held machines snapshot");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "working" });
  await until(async () => await badge.getAttribute("data-status") === "working", "working event before poll");
  await agentRow(paneA).locator('.badge[data-status="working"]').waitFor();
  // RUN is a working-coloured dot that breathes in opacity steps, no arc (Sidebar.css)
  const runDot = agentRow(paneA).locator('.badge[data-status="working"] .sidebar-status-dot');
  assert.equal(await runDot.count(), 1, "RUN draws a dot");
  assert.equal(await agentRow(paneA).locator('.badge[data-status="working"] svg').count(), 0, "RUN draws no arc");
  assert.equal(await runDot.evaluate((dot) => getComputedStyle(dot).animationName), "sidebar-breathe", "the dot breathes");
  releasePoll();
  await until(() => pollFinished, "stale machines response released");
  await page.waitForTimeout(300); // fixed wait: the stale poll may not revert the RUN badge
  assert.equal(await badge.getAttribute("data-status"), "working", "stale poll must not revert RUN to INPUT");
  assert.equal(await agentRow(paneA).locator(".badge").getAttribute("data-status"), "working",
    "a stale poll must not revert the separate Agents list either");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "pane-status-poll.png") });
  }
  await unrouteHeldPoll();
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "idle" });
  // This fixture only reports Claude to herdr; it has no native conversation. Selection of
  // its unavailable chat must keep DONE unread, then presenting real terminal output reads it.
  await page.locator(".pane-frame.is-current .chat-terminal-fallback").waitFor();
  await agentRow(paneA).locator('.badge[data-status="done"]').waitFor();
  const completionRoster = await (await context.request.get(`${origin}/api/machines`)).json() as { machines: Machine[] };
  const completionSnapshot = completionRoster.machines.find((machine) => machine.id === "local")?.snapshot;
  const completion = completionSnapshot?.panes.find((pane) => pane.pane_id === paneA);
  assert.equal(completion?.agent_status, "done", "the bridge retains the completed turn");
  assert.ok(completion?.finish_id && Number.isSafeInteger(completion.finish_id), "the completed turn has a server finish ID");
  assert.equal(typeof completionSnapshot?.finish_epoch, "string");
  const finishKey = `ovis:finish:local:${encodeURIComponent(completionSnapshot!.finish_epoch!)}:${encodeURIComponent(paneA)}`;
  assert.equal(await page.locator(".pane-frame.is-current [data-pane-content]").count(), 0, "an unavailable conversation is not presented content");
  assert.equal(await page.evaluate((key) => localStorage.getItem(key), finishKey), null, "an unavailable chat does not acknowledge its finish");
  await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
  await page.locator(".pane-frame.is-current .terminal-stack[data-pane-content]").waitFor();
  await agentRow(paneA).locator('.badge[data-status="idle"]').waitFor();
  assert.equal(await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null")?.id, finishKey), completion.finish_id,
    "presenting terminal output acknowledges exactly the bridge's completed turn");
  await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  console.log("PASS delayed machines poll preserves newer status; unavailable chat keeps DONE until terminal content is presented");

  // Agents is global to the sidebar: explicit pane selection from that list keeps its machine and pane target.
  // The test session's only PC is the Host, drawn without its header: no caret folds it, and its + is the New
  // workspace row under the workspaces. A PC's fold over Agents, with two PCs, is in sidebar-spacing-demo-regression.ts.
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "codex", state: "idle" });
  await agentRow(paneB).waitFor();
  assert.equal(await page.locator(".machine-group .machine-header").count(), 0, "the lone Host is drawn without its header");
  assert.equal(await page.locator(".machine-group .machine-new-row").count(), 1, "its + is the New workspace row");
  await agentRow(paneB).locator(".agent-select").click();
  await agentRow(paneB).locator('.agent-select[aria-current="true"]').waitFor();
  assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")),
    { machine_id: "local", pane_id: paneB }, "Agent selection retains its machine and pane target");
  painted.delete(paneA);
  await agentRow(paneA).locator(".agent-select").click();
  await agentRow(paneA).locator('.agent-select[aria-current="true"]').waitFor();
  await until(() => painted.has(paneA), "returning from Agents paints the current pane");
  await workspaceHeader(workspaces[0]!).locator('.workspace-select[aria-current="true"]').waitFor();

  // Reuse the real API roster as an offline cache in an isolated context. Its
  // native disabled buttons must leave selection unchanged when clicked.
  const cachedRoster = await (await context.request.get(`${origin}/api/machines`)).json() as { machines: Machine[] };
  // every cached pane keeps a plan, which nothing can read while its PC is offline
  const offlineMachines = cachedRoster.machines.map((machine) => ({
    ...machine,
    state: "disconnected" as const,
    snapshot: machine.snapshot && { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => ({ ...pane, plan: { done: 1, total: 4, current: "Writing the parser" } })) },
  }));
  const offlineContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  let offlineEvidence: BrowserEvidenceSession | undefined;
  try {
    await offlineContext.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false })));
    await offlineContext.route("**/api/machines", (route) => route.fulfill({ json: { machines: offlineMachines } }));
    await offlineContext.route("**/api/machines/events", (route) => route.fulfill({
      contentType: "text/event-stream", body: `retry: 60000\ndata: ${JSON.stringify({ type: "machines", machines: offlineMachines })}\n\n`,
    }));
    await offlineContext.routeWebSocket(/\/ws(?:\?|$)/, (socket) => socket.close({ code: 1000, reason: "Offline cached roster" }));
    const offlinePage = await offlineContext.newPage();
    offlineEvidence = evidenceDirectory ? await watchBrowserEvidence(offlineContext, offlinePage, "offline-cached-roster") : undefined;
    await offlinePage.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
    const offlineAgent = offlinePage.locator(`.agents-sidebar .agent-item[data-machine="local"][data-pane="${paneB}"] .agent-select`);
    await offlineAgent.waitFor();
    assert.equal(await offlineAgent.isDisabled(), true, "a cached offline agent cannot select its pane");
    const offlineWorkspace = offlinePage.locator('.machine-offline').first();
    assert.equal(await offlineWorkspace.evaluate((element) => element.inert), true,
      "offline workspace controls use native inert handling");
    assert.equal(await offlineWorkspace.evaluate((element) => {
      const button = element.querySelector<HTMLButtonElement>("button");
      button?.focus();
      return element.contains(document.activeElement);
    }), false, "offline workspace controls cannot take keyboard focus");
    const selectionBefore = await offlinePage.evaluate(() => sessionStorage.getItem("ovis:selection"));
    await offlineAgent.dispatchEvent("click");
    assert.equal(await offlinePage.evaluate(() => sessionStorage.getItem("ovis:selection")), selectionBefore,
      "offline Agent clicks leave the current selection unchanged");
    // the linked pane is shown from the cache, and offers no plan it could not read
    await offlinePage.locator(".view-switch").waitFor();
    assert.equal(await offlinePage.locator(".bg-tasks-plan").count(), 0, "an offline PC's cached plan offers no plan chip");
  } catch (error) {
    await offlineEvidence?.captureFailure(error);
    throw error;
  } finally {
    if (offlineEvidence) await offlineEvidence.finish();
    await offlineContext.close();
  }
  console.log("PASS Agents excludes shells, survives PC folds, selects its machine target and disables offline rows");

  // a turn that ended on work still running in the background reads BG, not DONE: drawn in the sidebar, and read in the composer
  let backgroundPeer: "working" | "done" | "blocked" | "idle" | null = null;
  const unrouteBackground = await routeDrained(page, "**/api/machines", async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { machines: { snapshot?: SessionSnapshot }[] };
    for (const machine of body.machines) {
      const pane = machine.snapshot?.panes.find((pane) => pane.pane_id === paneA);
      if (!pane || !machine.snapshot) continue;
      Object.assign(pane, { agent_status: "done", background_tasks: 1, background_wait: true });
      if (backgroundPeer) {
        const peer = { ...pane, pane_id: `${paneA}-background-peer`, agent_status: backgroundPeer, background_wait: undefined };
        machine.snapshot.panes.push(peer);
        const tab = machine.snapshot.tabs.find((tab) => tab.tab_id === pane.tab_id);
        if (tab) tab.agent_status = backgroundPeer === "blocked" ? "blocked" : "done";
      }
    }
    await route.fulfill({ response, json: body });
  });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const waitingBadge = agentRow(paneA).locator(".badge[data-status=waiting]");
  await waitingBadge.waitFor();
  assert.equal((await waitingBadge.textContent())?.trim(), "BG");
  assert.equal(await waitingBadge.getAttribute("title"), "Agent waiting on background work");
  // BG is a still ring in the working colour; RUN is a dot of it that breathes (Sidebar.css)
  assert.equal(await waitingBadge.locator("svg").count(), 0, "BG draws no arc any more");
  const ring = waitingBadge.locator(".sidebar-status-dot");
  assert.equal(await ring.count(), 1, "BG draws a ring");
  assert.deepEqual(await ring.evaluate((dot) => { const style = getComputedStyle(dot); return { hollow: style.backgroundColor === "rgba(0, 0, 0, 0)", bordered: parseFloat(style.borderTopWidth) > 0, animation: style.animationName }; }), { hollow: true, bordered: true, animation: "none" }, "the ring is hollow, bordered and still");
  await page.locator('.composer-status[data-status="waiting"] strong.visually-hidden', { hasText: "BG" }).waitFor();
  for (const peer of ["working", "done", "blocked", "idle"] as const) {
    backgroundPeer = peer;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const expected = peer === "idle" ? "waiting" : peer;
    await page.locator(`.tab-strip-tab[aria-selected="true"] .tab-strip-dot[data-status="${expected}"]`).waitFor();
  }
  backgroundPeer = null;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  if (process.env.UI_EVIDENCE_DIR) {
    const viewport = page.viewportSize()!;
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        await page.locator('.composer-status[data-status="waiting"]').waitFor();
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `background-wait-${width}-${theme}.png`), animations: "disabled" });
        if (width === 390) {
          const drawer = page.locator('button[aria-controls="workspace-drawer"]');
          await drawer.click();
          await waitingBadge.waitFor();
          await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `background-wait-${width}-${theme}-drawer.png`), animations: "disabled" });
          await drawer.click();
        }
      }
    }
    await page.setViewportSize(viewport);
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, themeBefore);
  }
  await unrouteBackground();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await waitingBadge.waitFor({ state: "detached" });
  console.log("PASS a pane whose turn ended on its background work reads BG in the sidebar and the composer, and its status again once it does not");
  // A pane's plan: the composer's chip (the one the background tasks have) says how far it got and
  // opens its steps in order, the running one with what it does now; the sidebar row carries the
  // same count. Reading it is the server's (server/session-plan.ts): its summary and steps are given here.
  const planSteps = [
    { id: "1", label: "Read the code", active: null, status: "completed", blocked_by: [], owner: null, started_at: "2026-10-07T00:00:00.000Z", ended_at: "2026-10-07T00:04:00.000Z" },
    { id: "2", label: "Write the parser", active: "Writing the parser", status: "in_progress", blocked_by: ["1"], owner: null, started_at: "2026-10-07T00:04:00.000Z", ended_at: null },
    { id: "3", label: "Write the panel", active: null, status: "pending", blocked_by: ["1"], owner: null, started_at: null, ended_at: null },
    { id: "4", label: "Ship it", active: null, status: "pending", blocked_by: ["2", "3"], owner: null, started_at: null, ended_at: null },
  ];
  type Roster = { machines: { snapshot?: { panes: { pane_id: string }[] } }[] };
  const withPlan = (body: Roster): Roster => {
    for (const machine of body.machines) for (const pane of machine.snapshot?.panes ?? []) if (pane.pane_id === paneA) Object.assign(pane, { plan: { done: 1, total: 4, current: "Writing the parser" } });
    return body;
  };
  // `events`: for a page not loaded yet. The roster also comes over /api/machines/events, whose
  // first frame (and every roster change after it) is the PC's own snapshot, with no plan: one that
  // lands after a poll takes the chip away again, and each one drops the poll in flight. That stream
  // then carries the planned roster once and stays quiet (a reconnect waits an hour), so the only
  // roster the page gets is the planned one. A page already loaded keeps the stream it has.
  const planned = async (target: typeof page, { events = false } = {}): Promise<() => Promise<void>> => {
    const unrouteMachines = await routeDrained(target, "**/api/machines", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: withPlan(await response.json() as Roster) });
    });
    if (events) {
      await target.route("**/api/machines/events", async (route) => {
        const response = await route.fetch({ url: `${origin}/api/machines` });
        const roster = withPlan(await response.json() as Roster);
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: `retry: 3600000\ndata: ${JSON.stringify({ type: "machines", machines: roster.machines })}\n\n` });
      });
    }
    await target.route(`**/api/pane/plan?pane_id=${encodeURIComponent(paneA)}`, (route) => route.fulfill({ json: { plan: { steps: planSteps }, server_time: new Date().toISOString() } }));
    return unrouteMachines;
  };
  const unroutePlanned = await planned(page);
  // this page keeps the stream it has: any roster it pushes now (a session or layout change on the
  // PC) carries the plan too, or that frame would take the chip away between waitFor and click
  await page.evaluate(([pane, plan]) => {
    (window as unknown as { __rewriteMachinesFrame?: (data: string) => string }).__rewriteMachinesFrame = (data) => {
      let payload: { type?: string; machines?: { snapshot?: { panes: { pane_id: string }[] } }[] };
      try { payload = JSON.parse(data); } catch { return data; }
      if (payload.type !== "machines") return data;
      for (const machine of payload.machines ?? []) for (const p of machine.snapshot?.panes ?? []) if (p.pane_id === pane) Object.assign(p, { plan });
      return JSON.stringify(payload);
    };
  }, [paneA, { done: 1, total: 4, current: "Writing the parser" }] as const);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const planChip = page.getByRole("button", { name: /^Plan: 1 of 4 done/ });
  await planChip.waitFor();
  assert.equal((await agentRow(paneA).locator("[data-testid=plan-progress]").textContent())?.trim(), "1/4");
  assert.equal(await page.locator(".plan-button").count(), 0, "the header carries no plan button");
  await planChip.click();
  const planList = page.getByRole("dialog", { name: /^Plan/ });
  await until(async () => await planList.locator(".bg-step").count() === 4, "the plan's steps");
  assert.deepEqual(await planList.locator(".bg-step .bg-task-title").allTextContents(), ["Read the code", "Write the parser", "Write the panel", "Ship it"]);
  assert.equal(await planList.locator(".bg-step.is-in_progress .bg-step-active").textContent(), "Writing the parser");
  assert.match(await planList.locator(".menu-heading").first().textContent() ?? "", /1 of 4 done/);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "plan-list.png") });
  await page.keyboard.press("Escape");
  await planList.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("bg-tasks-toggle")), true, "the focus goes back to the chip");
  // the plan is done with and emptied (Claude Code clears its task list) while the list is open:
  // nothing is left to list, so the list closes and the chip goes instead of standing empty
  await planChip.click();
  await until(async () => await planList.locator(".bg-step").count() === 4, "the plan's steps again");
  await unroutePlanned();
  await page.evaluate(() => { delete (window as unknown as { __rewriteMachinesFrame?: unknown }).__rewriteMachinesFrame; });
  await page.unroute(`**/api/pane/plan?pane_id=${encodeURIComponent(paneA)}`);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await planList.waitFor({ state: "detached" });
  await planChip.waitFor({ state: "detached" });
  console.log("PASS a pane's plan opens from the composer's chip as a list of its steps");

  // Use a real browser paste: keydown must not send Ctrl+V (0x16) to the agent,
  // where it can trigger image paste against the server's unrelated clipboard.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
  await pendingReady(paneA);
  const fileInputSocket = inputStates.get(paneA)?.socket;
  assert.ok(fileInputSocket, "the current pane has an input-ready attachment");
  await checkTerminalFileInput(page, fileInputSocket);
  const terminalInput = page.locator(".pane-frame.is-current .xterm-helper-textarea");
  // Chrome on macOS pastes with ⌘V alone: its Ctrl+V pastes nothing, and must send nothing either
  const mac = process.platform === "darwin";
  if (mac) {
    await terminalInput.focus();
    const beforeCtrlV = inputs.length;
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: Ctrl+V may send no control key
    assert.deepEqual(inputs.slice(beforeCtrlV), [], "Ctrl+V must never send the image-paste control key");
  }
  for (const [shortcut, text] of [
    [mac ? "Meta+v" : "Control+v", "# terminal paste 한글"],
    [mac ? "Meta+v" : "Control+v", "# first line\n# second line"],
    ...mac ? [] : [["Control+Shift+v", "# plain text paste"]],
  ]) {
    await page.evaluate((value) => navigator.clipboard.writeText(value), text!);
    await terminalInput.focus();
    const beforePaste = inputs.length;
    await page.keyboard.press(shortcut!);
    await until(() => inputs.length > beforePaste, `terminal ${shortcut}`);
    const pasted = inputs.slice(beforePaste);
    assert.equal(pasted.length, 1, "paste must send the text exactly once");
    assert.equal(pasted[0]!.pane_id, paneA);
    assert.equal(
      pasted[0]!.text.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, ""),
      text!.replace(/\n/g, "\r"),
      "paste must send clipboard text, never the image-paste control key",
    );
    const beforeCancel = inputs.length;
    await page.keyboard.press("Control+c");
    await until(() => inputs.length > beforeCancel, "terminal Ctrl+C");
    assert.equal(inputs.at(-1)?.text, "\x03", "other terminal control keys must still work");
  }
  // xterm collapses Shift+Enter into CR unless the terminal supplies a newline chord.
  // Check actual browser key events and the frames sent to an owned pane, including keyup.
  for (const [shortcut, expected] of [
    ["Enter", "\r"],
    ["Shift+Enter", "\x1b\r"],
    ["Alt+Enter", "\x1b\r"],
  ]) {
    await terminalInput.focus();
    const beforeEnter = inputs.length;
    await page.keyboard.press(shortcut!);
    await until(() => inputs.length > beforeEnter, `terminal ${shortcut}`);
    await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: no second copy of the shortcut sequence may arrive
    assert.deepEqual(inputs.slice(beforeEnter).map(({ pane_id, text }) => ({ pane_id, text })),
      [{ pane_id: paneA, text: expected }], `${shortcut} must send its sequence exactly once`);
  }
  // A composition commit belongs to xterm/IME; the custom binding must not replace it.
  for (const composition of [{ isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 }]) {
    const beforeIme = inputs.length;
    await terminalInput.dispatchEvent("keydown", {
      key: "Enter", code: "Enter", shiftKey: true, ...composition, bubbles: true, cancelable: true,
    });
    await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: no ESC-CR may be sent during composition
    assert.equal(inputs.slice(beforeIme).some(({ text }) => text === "\x1b\r"), false,
      "IME commits must not receive the custom Shift+Enter sequence");
  }
  // compositionend queues its send for the next timer. A following non-composing
  // Shift+Enter must let xterm flush that commit before sending the newline.
  await terminalInput.focus();
  const beforeCommittedIme = inputs.length;
  await terminalInput.evaluate(async (element) => {
    const textarea = element as HTMLTextAreaElement;
    textarea.value = "";
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value = "한";
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
    // An earlier composition update has established the committed span.
    await new Promise((resolve) => setTimeout(resolve, 0));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
    const enter = { key: "Enter", code: "Enter", keyCode: 13, which: 13,
      shiftKey: true, isComposing: false, bubbles: true, cancelable: true };
    textarea.dispatchEvent(new KeyboardEvent("keydown", enter));
    textarea.dispatchEvent(new KeyboardEvent("keyup", enter));
  });
  await until(() => inputs.length >= beforeCommittedIme + 2, "IME commit followed by Shift+Enter");
  await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: nothing beyond the commit and one Shift+Enter may arrive
  assert.deepEqual(inputs.slice(beforeCommittedIme).map(({ pane_id, text }) => ({ pane_id, text })),
    [{ pane_id: paneA, text: "한" }, { pane_id: paneA, text: "\x1b\r" }],
    "a pending IME commit must precede Shift+Enter without a delayed duplicate");
  console.log("PASS terminal Shift+Enter sends a newline chord once and preserves Enter, Alt+Enter and IME");
  console.log("PASS pending IME commit precedes Shift+Enter without duplicate text");
  await checkCommandBackspace(browser, origin, paneA);
  await checkCtrlEnter(browser, origin, paneA);
  await checkCommandArrows(browser, origin, paneA);
  // a pane shortcut switches panes and types nothing: xterm used to send ESC[1;6B / ESC[1;6A too
  const selectedTitle = () => page.locator(".pane-item.is-selected .pane-select").getAttribute("title");
  // A pane just picked shows the lens of the pane before it for a moment, and the message box
  // of that lens can take the focus back: the key waits until the terminal still has it two frames on.
  const focusTerminal = () => until(async () => {
    await terminalInput.focus();
    return page.evaluate(() => new Promise<boolean>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() =>
      resolve(document.activeElement?.classList.contains("xterm-helper-textarea") ?? false)))));
  }, "the terminal holds the focus");
  for (const key of ["ControlOrMeta+Shift+ArrowDown", "ControlOrMeta+Shift+ArrowUp"]) {
    await focusTerminal();
    const beforeSwitch = inputs.length;
    await page.keyboard.press(key);
    await until(async () => !(await selectedTitle())?.startsWith(`${paneA} —`), `${key} leaves the pane`);
    await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: the shortcut may reach no pane
    assert.deepEqual(inputs.slice(beforeSwitch), [], `${key} must not reach a pane`);
    await page.locator(`.pane-select[title^="${paneA} —"]`).click();
    await until(async () => (await selectedTitle())?.startsWith(`${paneA} —`) === true, "back on the first pane");
  }
  await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await composer.waitFor();
  // the empty message box has no text to select: the pane shortcut switches panes from it too
  await composer.focus();
  await page.keyboard.press("ControlOrMeta+Shift+ArrowDown");
  await until(async () => !(await selectedTitle())?.startsWith(`${paneA} —`), "the empty message box leaves the pane");
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  await until(async () => (await selectedTitle())?.startsWith(`${paneA} —`) === true, "back on the first pane");
  await composer.fill("draft");
  // the caret at the end of a draft: up selects the text first, and the pane stays
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: the shortcut may not switch pane while the draft has text that way
  assert.ok((await selectedTitle())?.startsWith(`${paneA} —`), "a draft keeps Mod+Shift+arrows while they select text");
  assert.deepEqual(await composer.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd]), [0, 5], "up selected the draft");
  // nothing is left to select that way: the next press switches panes, so a draft never stops the shortcut
  await page.keyboard.press("ControlOrMeta+Shift+ArrowUp");
  await until(async () => !(await selectedTitle())?.startsWith(`${paneA} —`), "a draft selected to its start lets the pane shortcut go");
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  await until(async () => (await selectedTitle())?.startsWith(`${paneA} —`) === true, "back on the first pane");
  await composer.fill("");
  console.log("PASS pane shortcut from the empty message box; a draft keeps text selection until none is left that way");
  console.log("PASS terminal clipboard paste sends text once and preserves Ctrl+C");

  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await page.getByRole("dialog", { name: "Settings" }).waitFor();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  console.log("PASS settings shortcut and theme");

  // Add PC lives in Settings → Remote PCs, not in the sidebar; opening it closes Settings behind it
  assert.equal(await page.locator(".sidebar").getByRole("button", { name: "Add PC", exact: true }).count(), 0, "the sidebar has no Add PC button");
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Remote PCs");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Add PC", exact: true }).click();
  await page.getByRole("dialog", { name: "Add PC", exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "Settings" }).count(), 0, "Add PC closes Settings");
  await page.getByRole("button", { name: "Close PC setup", exact: true }).click();
  await page.getByRole("dialog", { name: "Add PC", exact: true }).waitFor({ state: "hidden" });
  // its trigger went with Settings: focus lands on the header's workspace-list toggle instead of nowhere
  await until(async () => await page.evaluate(() => document.activeElement?.matches(".sidebar-toggle, .drawer-toggle") ?? false), "focus returns to the workspace-list toggle after Add PC closes");
  console.log("PASS Add PC opens from Settings, and the sidebar has no top bar");

  // the sidebar's right edge resizes it: its own top row in the header follows, the width is
  // kept on this device, the arrows move it from the keyboard and a double-click forgets it
  const sidebarWidths = () => page.evaluate(() => ({
    sidebar: Math.round(document.querySelector(".sidebar")!.getBoundingClientRect().width),
    header: Math.round(document.querySelector(".header-side")!.getBoundingClientRect().width),
    stored: localStorage.getItem("ovis:sidebar-width"),
  }));
  const defaultWidths = await sidebarWidths();
  assert.equal(defaultWidths.stored, null, "no sidebar width is stored before the edge is dragged");
  const resizer = page.getByRole("separator", { name: "Resize sidebar", exact: true });
  const edge = (await resizer.boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, 400);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 80, 400, { steps: 4 });
  await page.mouse.up();
  const dragged = await sidebarWidths();
  assert.equal(dragged.sidebar, defaultWidths.sidebar + 80, "the sidebar follows its dragged edge");
  assert.equal(dragged.header, dragged.sidebar, "the sidebar's top row in the header keeps the sidebar's width");
  assert.equal(dragged.stored, String(dragged.sidebar), "the dragged width is kept on this device");
  await resizer.focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal((await sidebarWidths()).sidebar, dragged.sidebar - 16, "an arrow key moves the focused edge one step");
  assert.equal(await resizer.getAttribute("aria-valuenow"), String(dragged.sidebar - 16));
  // half the window is the limit the keys enforce, and the edge reports it as the window changes
  const wide = page.viewportSize()!;
  await page.setViewportSize({ width: 900, height: wide.height });
  await until(async () => await resizer.getAttribute("aria-valuemax") === "450", "the edge's upper limit follows the window");
  await page.setViewportSize(wide);
  await until(async () => await resizer.getAttribute("aria-valuemax") !== "450", "the limit returns with the window");
  await resizer.dblclick();
  assert.deepEqual(await sidebarWidths(), defaultWidths, "a double-click goes back to the default width and forgets the stored one");
  console.log("PASS the sidebar's edge drags, steps from the keyboard, remembers its width and resets on a double-click");

  // Sidebar rows: a workspace row is its name until Settings → Sidebar rows → Two lines says
  // what its pane is doing over its place, on a taller row
  const oneLineHeight = await page.locator(".workspace-header").first().evaluate((row) => row.getBoundingClientRect().height);
  const oneLineAgentHeight = await page.locator(".agents-sidebar .agent-row").first().evaluate((row) => row.getBoundingClientRect().height);
  assert.equal(await page.locator(".workspace-copy.is-two-line").count(), 0, "rows are one line until two are chosen");
  assert.equal(await page.locator(".agents-sidebar.is-one-line").count(), 1, "agent rows follow the one-line choice");
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  const rowsSetting = page.locator('.settings-dialog .segmented[aria-label="Sidebar rows"]');
  await rowsSetting.getByRole("button", { name: "Two lines", exact: true }).click();
  await page.locator(".workspace-copy.is-two-line").first().waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").sidebarRows), "two");
  assert.ok(await page.locator(".workspace-header").first().evaluate((row) => row.getBoundingClientRect().height) > oneLineHeight, "a two-line row is taller");
  await page.locator(".agents-sidebar.is-one-line").waitFor({ state: "detached" });
  assert.ok(await page.locator(".agents-sidebar .agent-row").first().evaluate((row) => row.getBoundingClientRect().height) > oneLineAgentHeight, "a two-line agent row is taller");
  await rowsSetting.getByRole("button", { name: "One line", exact: true }).click();
  await page.locator(".workspace-copy.is-two-line").first().waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  console.log("PASS sidebar rows switch between one line and two");

  // An update request answered while the page is hidden (a phone app sent to the background) must
  // still release the buttons: the status poll stops with the page, the request does not.
  let releaseCheck!: () => void;
  const checkGate = new Promise<void>((resolve) => { releaseCheck = resolve; });
  const idleStatus = { managed: true, auto_update: false, phase: "idle", current_revision: null, latest_revision: null, current_version: "0.0.0", latest_version: "0.0.0", available: false, checked_at: new Date().toISOString(), blocked_reason: null, error: null };
  await page.route("**/api/updates", (route) => route.fulfill({ json: idleStatus }));
  await page.route("**/api/updates/check", async (route) => { await checkGate; await route.fulfill({ json: { ok: true } }); });
  const setPageHidden = (hidden: boolean) => page.evaluate((hidden) => {
    if (hidden) Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    else delete (document as unknown as Record<string, unknown>).visibilityState;
    document.dispatchEvent(new Event("visibilitychange"));
    // The app takes the change in a task it posts during the event. A hide and a show sent one
    // after the other both land before that task, and are one render in which nothing changed:
    // a task of the page's own, posted after the app's, has run once the app has taken it.
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  }, hidden);
  // the idle status poll runs every 30 s: a hide and a show restart it at once, onto the fake
  for (const deadline = Date.now() + 10_000; ;) {
    const restarted = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/updates", { timeout: 2_000 }).then(() => true, () => false);
    await setPageHidden(true);
    await setPageHidden(false);
    if (await restarted) break;
    assert.ok(Date.now() < deadline, "a hide and a show restart the update status poll");
  }
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "About");
  const checkUpdates = page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Check for updates", exact: true });
  await checkUpdates.waitFor();
  await checkUpdates.click();
  await until(() => checkUpdates.isDisabled(), "the check is pending");
  await setPageHidden(true);
  releaseCheck();
  await page.waitForTimeout(300);
  await setPageHidden(false);
  await until(async () => !(await checkUpdates.isDisabled()), "an answer that came while hidden releases the update buttons");
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await page.unroute("**/api/updates/check");
  await page.unroute("**/api/updates");
  console.log("PASS an update answer that arrives while the page is hidden releases the buttons");

  // the More menu's Alerts item turns this device's alerts on, and off again (it stayed disabled once on)
  // the header has no button of its own for it or for New tab; from 769px Files is the header's own
  // button and leaves the menu, a phone keeps it there (deep-link-demo-regression)
  assert.equal(await page.locator(".app-header .bell-button, .app-header .new-tab-button").count(), 0, "Alerts and New tab are not header buttons");
  const filesButton = page.locator(".app-header .header-files-button");
  assert.equal(await filesButton.getAttribute("aria-label"), "Browse files", "a computer's header has its own Files button");
  await page.locator(".header-more-button").click();
  await page.locator('.row-menu [role="menuitem"]').first().waitFor();
  assert.equal(await page.locator('.row-menu [role="menuitem"]', { hasText: "Browse files" }).count(), 0, "Files left the More menu on a computer");
  await page.keyboard.press("Escape");
  await page.locator(".row-menu").waitFor({ state: "detached" });
  await filesButton.click();
  await page.getByRole("dialog", { name: "Files", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close files", exact: true }).click();
  await page.getByRole("dialog", { name: "Files", exact: true }).waitFor({ state: "detached" });
  // before the permission question is answered the item already reads as on: in-app alerts show
  assert.equal(await alertsState(page), "On in the app");
  assert.equal(await alertsOffMarked(page), false, "alerts that are on leave the More button unmarked");
  await context.grantPermissions(["notifications"], { origin });
  await runMoreItem(page, "Alerts");
  await until(async () => await alertsState(page) !== "On in the app", "the item's tap takes the permission");
  assert.match(await alertsState(page), /^On[ ,]/);
  assert.equal(await alertsOffMarked(page), false);
  await runMoreItem(page, "Alerts");
  await until(async () => await alertsState(page) === "Off on this device", "alerts off");
  assert.equal(await alertsOffMarked(page), true, "alerts that are off mark the More button, in its dot and its name");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").alertsOn), false);
  assert.equal(await page.evaluate(async () => (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) ?? null), null, "turning alerts off drops the push subscription");
  await runMoreItem(page, "Alerts");
  await until(async () => /^On[ ,]/.test(await alertsState(page)), "alerts on again");
  assert.equal(await alertsOffMarked(page), false);
  console.log("PASS the Alerts item turns alerts off and on again");

  // where notifications are blocked the item is still there, and switches the in-app alerts
  const blocked = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await blocked.addInitScript(() => {
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    Object.defineProperty(Notification, "permission", { configurable: true, get: () => "denied" });
  });
  const blockedPage = await blocked.newPage();
  const blockedEvidence = evidenceDirectory ? await watchBrowserEvidence(blocked, blockedPage, "blocked-notifications") : undefined;
  csp.push(await watchCsp(blockedPage));
  await blockedPage.goto(origin);
  await blockedPage.locator(".header-more-button").waitFor();
  assert.equal(await alertsState(blockedPage), "On in the app");
  assert.equal(await alertsOffMarked(blockedPage), false);
  await runMoreItem(blockedPage, "Alerts");
  await until(async () => await alertsState(blockedPage) === "Off on this device", "blocked alerts off");
  assert.equal(await alertsOffMarked(blockedPage), true);
  assert.equal(await blockedPage.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").alertsOn), false);
  await runMoreItem(blockedPage, "Alerts");
  await until(async () => await alertsState(blockedPage) === "On in the app", "blocked alerts on again");
  assert.equal(await alertsOffMarked(blockedPage), false);
  if (blockedEvidence) await blockedEvidence.finish();
  await blocked.close();
  console.log("PASS a device that blocks notifications keeps the Alerts item as the switch for in-app alerts");

  // The pending protocol has a real foreground agent and an owned byte recorder: merely
  // reporting an idle shell as working would not prove that server-side queueing happened.
  const pendingCwd = join(root, "pending"); mkdirSync(pendingCwd);
  const pendingWorkspace = await workspaceCreate({ cwd: pendingCwd, label: "ovis-test-browser-pending" });
  workspaces.push(pendingWorkspace.workspace.workspace_id);
  const pendingPane = pendingWorkspace.root_pane.pane_id;
  const pendingProgram = join(root, "claude"); copyFileSync(process.execPath, pendingProgram); chmodSync(pendingProgram, 0o755);
  const pendingLog = join(root, "pending-input.jsonl");
  const pendingScreen = join(root, "pending-screen.txt"); writeFileSync(pendingScreen, "");
  const pendingScript = join(root, "pending-agent.cjs");
  writeFileSync(pendingScript, `const fs=require("node:fs");const log=process.argv[2],screen=process.argv[3];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h\\n› Message\\n",()=>fs.writeFileSync(log,""));process.stdin.on("data",c=>{if(c.includes(3))process.exit(0);fs.appendFileSync(log,JSON.stringify(c.toString("utf8"))+"\\n");});let shown="";setInterval(()=>{const next=fs.readFileSync(screen,"utf8");if(next!==shown){shown=next;process.stdout.write("\\x1b[2J\\x1b[H"+next);}},20);`);
  await herdrRpc("pane.send_text", { pane_id: pendingPane, text: `'${pendingProgram}' '${pendingScript}' '${pendingLog}' '${pendingScreen}'\n` });
  await until(() => existsSync(pendingLog), "pending byte recorder started");
  const pendingBytes = () => readFileSync(pendingLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  const reportPending = (state: string) => herdrRpc("pane.report_agent", { pane_id: pendingPane, source: "manual", agent: "claude", state });
  await reportPending("working");
  await page.locator(`.pane-select[title^="${pendingPane} —"]`).click();
  await page.getByRole("group", { name: "Pane view", exact: true }).getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await until(async () => await page.locator(".composer-agent-label").innerText() === "Claude", "foreground agent identity reached the composer");
  await pendingReady(pendingPane);
  const pendingRows = page.locator(".pending-messages .pending-message");
  const queuedTexts = ["first pending browser message", "# second pending message", "# third pending message"];
  for (const [index, text] of queuedTexts.entries()) {
    await composer.fill(text);
    assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 0, "typing replaces Stop with Send");
    assert.equal(await page.getByRole("button", { name: "Queue message", exact: true }).count(), 0, "there is no separate Queue control");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await until(async () => await pendingRows.count() === index + 1 && await composer.inputValue() === "", "server accepted pending input");
    assert.equal(inputs.at(-1)?.pane_id, pendingPane);
    assert.equal(inputs.at(-1)?.delivery, "queue");
  }
  assert.deepEqual(await pendingRows.locator(".pending-message-bubble").allTextContents(), queuedTexts);
  assert.equal(pendingBytes(), "", "accepted pending messages have not reached the pty");
  assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 1, "empty working composer returns to Stop");
  assert.equal(await page.locator(".composer-action").count(), 1, "one primary action");
  const actionsBeforeTextClick = pendingActions.length;
  await pendingRows.locator(".pending-message-bubble").first().click();
  await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: clicking pending text may trigger no action
  assert.equal(pendingActions.length, actionsBeforeTextClick, "pending message text is selectable, not a send action");
  assert.equal(pendingBytes(), "");
  await reportPending("blocked"); await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: blocked status may not advance pending input
  assert.equal(pendingBytes(), "", "blocked status never advances pending input");
  assert.equal(await pendingRows.count(), 3);
  await reportPending("working"); await page.locator('.composer-status[data-status="working"]').waitFor();
  await pendingRows.first().getByRole("button", { name: /^Send now:/ }).press("Enter");
  await until(async () => await pendingRows.count() === 2 && pendingBytes().endsWith("\r"), "explicit Send now delivered one item");
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r`);
  assert.equal(pendingActions.at(-1)?.pane_id, pendingPane);
  assert.equal(await pendingRows.first().getByRole("button", { name: /^Send now:/ }).evaluate((button) => button === document.activeElement), true, "a removed keyboard action hands focus to the next pending action");
  // a draft puts Send where Stop was: Escape in the box is still Stop, once a completion is put away, and keeps the draft
  await composer.fill("/he");
  await composer.press("Escape");
  await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: the first Escape may send nothing
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r`, "the first Escape on a command being completed only puts the completion away");
  await composer.fill("a draft while the agent works");
  assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 0);
  await composer.press("Escape");
  await until(() => pendingBytes() === `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`, "Escape with a draft stops the working agent");
  assert.deepEqual(inputs.at(-1), { type: "input", pane_id: pendingPane, text: "\u001b", stop: true }, "the composer's Stop goes out as a Stop");
  assert.equal(await composer.inputValue(), "a draft while the agent works", "Escape leaves the draft in the box");
  await composer.fill("");
  // a follow-up sent between a reconnect and its snapshot is the new connection's own row, not an unconfirmed copy
  const sentBeforeSnapshot = inputs.length;
  const socketsBeforeReconnect = sockets.length;
  holdSnapshot = true;
  await routed.at(-1)!.close();
  await until(() => releaseFeatures !== null && releaseSnapshot !== null, "the reconnect's features and snapshot were held back");
  // the server can send its snapshot before the page has even sent its attach: the pane is
  // ready only once the new connection says so, not by the closed one's last word
  await until(() => sockets.length > socketsBeforeReconnect, "the page opened its new connection");
  await pendingReady(pendingPane);
  assert.equal(await page.locator('.pending-message[data-state="uncertain"]').count(), 2, "the lost connection's rows are no longer its own");
  await composer.fill("sent before the snapshot");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.equal(inputs.length, sentBeforeSnapshot, "the message waits for the frame that says what the bridge supports");
  // that frame needs no herdr: once it is in, the message goes, with the snapshot (which waits on herdr) still held
  releaseFeatures!();
  await until(async () => await page.locator('.pending-message[data-state="queued"]').count() === 1, "the message sent before the snapshot is a live pending row");
  assert.notEqual(releaseSnapshot, null, "the snapshot was still held back when the message went");
  releaseSnapshot!();
  assert.equal(inputs.at(-1)?.delivery, "queue");
  assert.equal(await page.locator(".composer-note").count(), 0);
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await until(async () => await pendingRows.count() === 2, "the live row was discarded on the bridge");
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`);
  await page.reload(); await page.locator(".conn-live").waitFor();
  await until(async () => await pendingRows.count() === 2, "saved pending copies restored");
  assert.deepEqual(await pendingRows.locator(".pending-message-bubble").allTextContents(), queuedTexts.slice(1));
  assert.equal(await page.locator('.pending-message[data-state="uncertain"]').count(), 2, "reload removes connection proof");
  assert.equal(await page.locator(".pending-message-send").count(), 0, "unknown delivery cannot be resent");
  await reportPending("idle"); await page.locator('.composer-status:not([data-status="working"])').waitFor();
  await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: readiness may not replay saved pending input
  assert.equal(pendingBytes(), `\u001b[200~${queuedTexts[0]}\u001b[201~\r\u001b`, "reload and readiness never replay saved pending input");
  for (let left = 2; left > 0; left--) { await page.getByRole("button", { name: "Discard saved copy", exact: true }).first().click(); await until(async () => await pendingRows.count() === left - 1, "discard saved copy"); }
  console.log("PASS Send queues server-owned input, explicit Send now delivers once, and reload/readiness never replay uncertain copies");

  // Older releases saved editable held rows. Seed that documented storage format so the
  // recovery, editing and layout checks continue to cover existing users' retained text.
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  const report = (state: string) => herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state });
  await report("working");
  await page.evaluate(({ pane, texts }) => {
    localStorage.setItem(`ovis:queue:${pane}`, JSON.stringify({ version: 1, messages: texts.map((text, index) => ({ id: `legacy-browser-${index}`, text })) }));
  }, { pane: paneA, texts: ["printf 'browser-queue-ok\\n'", "# second queued message", "# third queued message"] });
  await page.reload(); await page.locator(".conn-live").waitFor();
  await until(async () => await page.locator(".composer-queue-text").count() === 3, "legacy held rows restored");
  assert.equal(await composer.inputValue(), "");
  // the reloaded page shows the last status it had until the server's "working" lands
  await page.locator('.composer-status[data-status="working"]').waitFor();
  assert.equal(await page.getByRole("button", { name: "Stop agent", exact: true }).count(), 1);
  assert.equal(await page.locator(".composer-action").count(), 1, "one primary action beside legacy recovery");
  // the held rows sit on the input card's column, under one caption that counts them
  const heldBox = await page.locator(".composer-queue").boundingBox();
  const cardBox = await page.locator(".composer-surface").boundingBox();
  assert.ok(heldBox && cardBox);
  assert.equal(Math.round(heldBox.x), Math.round(cardBox.x));
  assert.equal(Math.round(heldBox.width), Math.round(cardBox.width));
  assert.match(await page.locator(".composer-queue-heading").innerText(), /Held until the agent is ready · 3 messages/);
  assert.equal(await page.locator(".composer-queue-toggle").count(), 0, "no prompt and no short phone: the rows are not folded");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "multiple-queue.png") });
  // one column: the held list, the box and the conversation share their edges, and the status
  // line is the box's own last row, inside it.
  // The default Chat width follows the pane: min 820px, max 60rem (960px at this 16px root), 71% of the pane between. This
  // pane is under 1148px, so the lane is its 820px floor, as at Narrow; at Wide the lane is wider
  // than the pane and the column is the pane less its gutters. A larger window grows the lane
  const chatWidth = async (name: string): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    await page.getByRole("group", { name: "Chat width", exact: true }).getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  const laneColumn = async (): Promise<{ x: number; width: number; pane: number }> => {
    const pane = await page.locator(".terminal-stack.is-chat").boundingBox();
    const card = await page.locator(".composer-surface").boundingBox();
    assert.ok(pane && card);
    const [text, left, status, right] = await Promise.all([".composer-text", ".composer-controls-left", ".composer-status", ".composer-controls-right"]
      .map((selector) => page.locator(`.composer-surface > ${selector}`).boundingBox()));
    assert.ok(text && left && status && right, "the message box and the three cells of the controls row");
    // each row spans the card's inner width: inside its hairline border, a fraction of a px either way
    assert.ok(Math.abs(text.x - card.x) <= 2.5 && Math.abs(text.width - card.width) <= 4, `.composer-text spans the box: ${JSON.stringify({ text, card })}`);
    // the status content is the middle cell of the last row: add on its left, the round button on its right, no gap between the cells
    assert.ok(Math.abs(left.x - card.x) <= 2.5 && Math.abs(status.x - (left.x + left.width)) <= 1 && Math.abs(right.x - (status.x + status.width)) <= 1
      && Math.abs(right.x + right.width - left.x - card.width) <= 4, `the controls row spans the box: ${JSON.stringify({ left, status, right, card })}`);
    for (const selector of [".composer-queue", ".chat-transcript"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(box, selector);
      assert.equal(Math.round(box.x), Math.round(card.x), `${selector} starts on the box's edge`);
      assert.equal(Math.round(box.width), Math.round(card.width), `${selector} is as wide as the box`);
    }
    return { x: Math.round(card.x), width: Math.round(card.width), pane: Math.round(pane.width) };
  };
  const floor = await laneColumn();
  assert.ok(floor.pane < 1148, "71% of this pane is under the lane's floor");
  assert.equal(floor.width, 820);
  assert.ok(floor.width < floor.pane - 32, "the lane, not the pane, sets the column");
  await chatWidth("Narrow");
  assert.deepEqual(await laneColumn(), floor);
  await chatWidth("Wide");
  const gutters = await laneColumn();
  assert.equal(gutters.width, gutters.pane - 32, "the wide lane is wider than this pane: the column is the pane less its gutters");
  await chatWidth("Default");
  assert.deepEqual(await laneColumn(), floor);
  await page.setViewportSize({ width: 1920, height: 800 });
  await until(async () => Math.round((await page.locator(".composer-surface").boundingBox())?.width ?? 0) === 960, "the default lane grows to its 960px ceiling on a large window");
  assert.equal((await laneColumn()).width, 960);
  await page.setViewportSize({ width: 1280, height: 800 });
  await until(async () => Math.round((await page.locator(".composer-surface").boundingBox())?.width ?? 0) === 820, "the default lane returns to its floor");
  assert.deepEqual(await laneColumn(), floor);
  await page.locator(".composer-queue-text").nth(1).fill("# edited second message");
  await page.reload();
  await page.locator(".conn-live").waitFor();
  await until(async () => await page.locator(".composer-queue-text").count() === 3, "queue restored");
  assert.equal(await page.locator(".composer-queue-text").nth(1).inputValue(), "# edited second message");
  // the queue belongs to the chat lens: the terminal lens hides it and keeps it for the return
  const lens = page.getByRole("group", { name: "Pane view", exact: true });
  await lens.getByRole("button", { name: "Terminal", exact: true }).click();
  await until(async () => await page.locator(".composer-queue").count() === 0, "queue hidden in the terminal lens");
  await lens.getByRole("button", { name: "Chat", exact: true }).click();
  await until(async () => await page.locator(".composer-queue-text").count() === 3, "queue back in the chat lens");
  await page.locator(`.pane-select[title^="${paneB} —"]`).click();
  await until(async () => await page.locator(".composer-queue-text").count() === 0, "other pane has no queue");
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  await until(async () => await page.locator(".composer-queue-text").count() === 3, "owner queue restored");
  await page.getByRole("button", { name: "Discard", exact: true }).nth(2).click();
  const inputCount = inputs.length;
  await report("blocked");
  await page.locator('.composer-status[data-status="blocked"]').waitFor();
  await Bun.sleep(300);
  assert.equal(inputs.length, inputCount, "approval state must hold the queue");
  assert.equal(await page.locator(".composer-queue-text").count(), 2);
  await report("idle");
  await Bun.sleep(300);
  assert.equal(inputs.length, inputCount, "a status change must not dispatch held input");
  await page.getByRole("button", { name: "Send now", exact: true }).first().click();
  await until(() => inputs.length > inputCount, "explicit queue send");
  assert.equal(inputs.at(-1)?.pane_id, paneA);
  await until(async () => await page.locator(".composer-queue-text").count() === 1, "only sent item removed");
  assert.equal(await page.locator(".composer-queue-text").inputValue(), "# edited second message");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await page.locator(".composer-queue-text").waitFor({ state: "hidden" });
  console.log("PASS queue held through status changes and explicitly sent to its owner");

  // a quick reply goes out as typed, and leaves a draft in the box alone; the row shows only when
  // chosen in Settings, and the box has no button for it
  const quickRow = async (show: boolean): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    const toggle = page.getByRole("switch", { name: "Show above the message box", exact: true });
    if ((await toggle.getAttribute("aria-checked")) !== String(show)) await toggle.click();
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  assert.equal(await page.locator(".composer-quick").count(), 0);
  assert.equal(await page.locator(".composer-quick-toggle").count(), 0);
  await quickRow(true);
  // on a wide pane the row keeps the box's column instead of running to the pane's left edge.
  // Measured at the narrow Chat width, where the lane is narrower than this pane at any window
  // size: in a lane wider than the pane the row and the box would both simply fill the composer
  // whatever their own width rule said
  await chatWidth("Narrow");
  const quickBox = await page.locator(".composer-quick").boundingBox();
  const surfaceBox = await page.locator(".composer-surface").boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  assert.ok(quickBox && surfaceBox && composerBox);
  assert.ok(surfaceBox.width < composerBox.width - 32, "the box is held to the lane, narrower than the pane");
  assert.equal(Math.round(quickBox.x), Math.round(surfaceBox.x));
  assert.equal(Math.round(quickBox.width), Math.round(surfaceBox.width));
  await chatWidth("Default");
  await composer.fill("draft stays");
  const quickCount = inputs.length;
  await page.getByRole("group", { name: "Quick replies", exact: true }).getByRole("button", { name: "continue", exact: true }).click();
  await until(() => inputs.length > quickCount, "quick reply send");
  assert.equal(inputs.at(-1)?.pane_id, paneA);
  assert.match(inputs.at(-1)!.text, /^continue/);
  assert.equal(await composer.inputValue(), "draft stays");
  // Mid-turn it uses the same real server-owned pending path as Send, and still leaves the draft.
  await page.locator(`.pane-select[title^="${pendingPane} —"]`).click();
  await reportPending("working");
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await pendingReady(pendingPane);
  await composer.fill("draft stays");
  const beforeQuickQueue = pendingBytes();
  await page.getByRole("group", { name: "Quick replies", exact: true }).getByRole("button", { name: "retry", exact: true }).click();
  await until(async () => await pendingRows.count() === 1, "quick reply accepted as pending");
  assert.equal(await pendingRows.locator(".pending-message-bubble").textContent(), "retry");
  assert.equal(await composer.inputValue(), "draft stays");
  assert.equal(pendingBytes(), beforeQuickQueue, "working quick reply is not immediate input");
  await pendingRows.getByRole("button", { name: "Discard", exact: true }).click();
  await until(async () => await pendingRows.count() === 0, "quick reply discarded by id");
  await quickRow(false);
  assert.equal(await page.locator(".composer-quick").count(), 0);
  await composer.fill("");
  await reportPending("idle");
  await page.locator('.composer-status:not([data-status="working"])').waitFor();
  await page.locator(`.pane-select[title^="${paneA} —"]`).click();
  assert.equal(await composer.inputValue(), "draft stays", "the other pane's draft stayed with it");
  await composer.fill("");
  console.log("PASS quick replies send as typed, queue mid-turn, and leave the draft");

  // the Enter that commits an IME candidate is not a send: WebKit can deliver it after
  // compositionend, with isComposing false and key code 229
  await composer.fill("한글 조합");
  const imeInputs = inputs.length;
  await composer.dispatchEvent("keydown", IME_ENTER);
  await page.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: an IME Enter may send nothing
  assert.equal(inputs.length, imeInputs);
  assert.equal(await composer.inputValue(), "한글 조합");
  await composer.fill("");
  console.log("PASS the composer keeps an IME's committing Enter");

  // the status line holds the agent and its state: no report action
  assert.equal(await page.getByRole("button", { name: "Report a problem", exact: true }).count(), 0, "no report action");

  const selectPane = async (paneId: string) => {
    await page.locator(`.pane-select[title^="${paneId} —"]`).click();
    await page.locator(`.pane-frame[data-layout-pane="${paneId}"]`).getByRole("log").waitFor();
  };
  await composer.fill("draft for A");
  await selectPane(paneB);
  assert.equal(await composer.inputValue(), "");
  await composer.fill("draft for B");
  await selectPane(paneA);
  assert.equal(await composer.inputValue(), "draft for A");
  console.log("PASS drafts stay with their panes");


  // A real successful send waits on its acknowledgement while its composer unmounts.
  for (const returnBeforeAck of [false, true]) {
    await composer.fill("# confirmed draft");
    holdSubmitResult = true;
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    await until(() => releaseSubmitResult !== null, "held submit acknowledgement");
    await selectPane(paneB);
    assert.equal(await composer.inputValue(), "draft for B");
    if (returnBeforeAck) {
      await selectPane(paneA);
      assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
      await composer.fill("# confirmed draft plus unsent text");
    }
    releaseSubmitResult!();
    if (!returnBeforeAck) await selectPane(paneA);
    await until(async () => await composer.inputValue() === (returnBeforeAck ? " plus unsent text" : ""), "only acknowledged text leaves the draft");
  }
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "composer-acknowledged-draft.png") });
  await composer.fill("draft for A");
  console.log("PASS successful sends settle after switching panes and preserve edits made after returning");

  let releaseImage!: () => void;
  const imageGate = new Promise<void>((resolve) => { releaseImage = resolve; });
  releases.push(releaseImage);
  const uploads: string[] = [];
  await page.route("**/api/pane/image", async (route) => {
    uploads.push(route.request().postDataJSON().pane_id);
    await imageGate;
    await route.continue(); // Delay real traffic; no synthetic responses.
  });
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1kAAAAASUVORK5CYII=", "base64");
  await page.locator('input[type="file"]').setInputFiles(["first", "second", "third", "fourth"].map((name) => ({ name: `${name}.png`, mimeType: "image/png", buffer: png })));
  await until(() => uploads.length === 3, "three uploads started side by side");
  await Bun.sleep(300);
  assert.equal(uploads.length, 3, "no more than three uploads run at once");
  await selectPane(paneB);
  const imageResponse = page.waitForResponse((response) => response.url().endsWith("/api/pane/image"));
  releaseImage();
  assert.equal((await imageResponse).status(), 200);
  await Bun.sleep(300);
  assert.deepEqual(uploads, [paneA, paneA, paneA], "leaving a pane cancels the uploads not yet started");
  assert.equal(await composer.inputValue(), "draft for B");
  console.log("PASS upload batch cannot cross panes");

  // Each path goes to the start of the message as its upload finishes, in the order the files were
  // picked, and what the user types meanwhile stays where the caret is.
  await page.unroute("**/api/pane/image");
  const held = new Map<string, () => void>();
  await page.route("**/api/pane/image", async (route) => {
    const name = route.request().postDataJSON().name as string;
    await new Promise<void>((resolve) => { held.set(name, resolve); releases.push(resolve); });
    await route.continue();
  });
  await composer.fill("");
  await page.locator('input[type="file"]').setInputFiles(["first", "second"].map((name) => ({ name: `${name}.txt`, mimeType: "text/plain", buffer: Buffer.from(name) })));
  await until(() => held.size === 2, "both uploads in flight at once");
  await composer.pressSequentially("hello");
  held.get("second.txt")!();
  await until(async () => /^@\S*second-\S* hello$/.test(await composer.inputValue()), "the second file's path went to the start");
  await composer.pressSequentially(" there");
  held.get("first.txt")!();
  await until(async () => /^@\S*first-\S* @\S*second-\S* hello there$/.test(await composer.inputValue()), "the first file's path went before the second's");
  assert.equal(await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart === element.value.length), true, "the caret stays after what was typed");
  console.log("PASS uploads run side by side and put their paths at the start in pick order, away from the caret");

  // The limit holds across picks, and a later pick's path follows an earlier pick's path.
  const pickFiles = (...names: string[]) => page.locator('input[type="file"]').setInputFiles(names.map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from(name) })));
  const finish = async (name: string) => {
    const response = page.waitForResponse((response) => response.url().endsWith("/api/pane/image") && response.request().postDataJSON().name === name);
    held.get(name)!();
    assert.equal((await response).status(), 200);
  };
  held.clear();
  await composer.fill("");
  await pickFiles("third.txt", "fourth.txt");
  await pickFiles("fifth.txt", "sixth.txt");
  await until(() => held.size === 3, "three uploads in flight");
  await Bun.sleep(300);
  assert.equal(held.size, 3, "a second pick waits for the first pick's uploads");
  for (const name of ["third.txt", "fourth.txt", "fifth.txt"]) await finish(name);
  await until(() => held.has("sixth.txt"), "the queued upload starts once one finishes");
  await finish("sixth.txt");
  await until(async () => /^@\S*third-\S* @\S*fourth-\S* @\S*fifth-\S* @\S*sixth-\S* $/.test(await composer.inputValue()), "paths from both picks in pick order");
  held.clear();
  await composer.fill("");
  await pickFiles("seventh.txt");
  await until(() => held.has("seventh.txt"), "seventh upload in flight");
  await finish("seventh.txt");
  await pickFiles("eighth.txt");
  await until(() => held.has("eighth.txt"), "eighth upload in flight");
  await finish("eighth.txt");
  await until(async () => /^@\S*seventh-\S* @\S*eighth-\S* $/.test(await composer.inputValue()), "a later pick's path follows the earlier pick's path");
  console.log("PASS one upload limit spans picks, and later picks' paths follow earlier ones");

  // A path waits while the box holds a /command still being typed or an IME composition,
  // and a backward selection keeps its direction.
  held.clear();
  await composer.fill("");
  await composer.pressSequentially("/");
  await pickFiles("ninth.txt");
  await until(() => held.has("ninth.txt"), "ninth upload in flight");
  await finish("ninth.txt");
  await Bun.sleep(300);
  assert.equal(await composer.inputValue(), "/", "a lone slash is left to be typed on");
  await composer.pressSequentially("rev");
  assert.equal(await composer.inputValue(), "/rev", "the command keeps its letters together");
  await composer.pressSequentially(" ");
  await until(async () => /^\/rev @\S*ninth-\S* $/.test(await composer.inputValue()), "the path follows the finished command");
  assert.equal(await composer.evaluate((element: HTMLTextAreaElement) => element.selectionStart === element.value.length), true, "typing goes on after the path");
  held.clear();
  await composer.fill("");
  await composer.focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "한", selectionStart: 1, selectionEnd: 1 });
  await pickFiles("tenth.txt");
  await until(() => held.has("tenth.txt"), "tenth upload in flight");
  await finish("tenth.txt");
  await Bun.sleep(300);
  assert.equal(await composer.inputValue(), "한", "an IME composition is left alone");
  await cdp.send("Input.insertText", { text: "한" });
  await until(async () => /^@\S*tenth-\S* 한$/.test(await composer.inputValue()), "the path arrives once the composition ends");
  await cdp.detach();
  // WebKit ends the composition before the input that commits a candidate other than the one shown
  held.clear();
  await composer.fill("");
  await composer.focus();
  const compose = (phase: "start" | "commit") => composer.evaluate((element: HTMLTextAreaElement, phase) => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    if (phase === "start") {
      element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      setValue.call(element, "ㅎ");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true, data: "ㅎ", inputType: "insertCompositionText" }));
      return;
    }
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
    setValue.call(element, "한");
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "한", inputType: "insertFromComposition" }));
  }, phase);
  await compose("start");
  await pickFiles("twelfth.txt");
  await until(() => held.has("twelfth.txt"), "twelfth upload in flight");
  await finish("twelfth.txt");
  await Bun.sleep(300);
  assert.equal(await composer.inputValue(), "ㅎ", "the shown candidate is left alone");
  await compose("commit");
  await until(async () => /^@\S*twelfth-\S* 한$/.test(await composer.inputValue()), "the path joins the committed candidate");
  // dictation that turns a lone slash into a command lets a waiting path in;
  // the composer takes its speech engine when it mounts, so a pane round trip picks up the fake
  held.clear();
  await composer.fill("");
  await page.evaluate(() => {
    class FakeSpeech {
      lang = ""; continuous = false; interimResults = false;
      onaudiostart: (() => void) | null = null; onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null; onend: (() => void) | null = null;
      start() { (window as unknown as { fakeSpeech: FakeSpeech }).fakeSpeech = this; setTimeout(() => this.onaudiostart?.(), 0); }
      stop() { setTimeout(() => this.onend?.(), 0); }
      abort() { this.onend?.(); }
    }
    const speech = window as unknown as Record<string, unknown>;
    speech.realSpeech = { SpeechRecognition: speech.SpeechRecognition, webkitSpeechRecognition: speech.webkitSpeechRecognition };
    Object.assign(window, { SpeechRecognition: FakeSpeech, webkitSpeechRecognition: FakeSpeech });
  });
  await selectPane(paneA);
  await selectPane(paneB);
  await composer.pressSequentially("/");
  await pickFiles("thirteenth.txt");
  await until(() => held.has("thirteenth.txt"), "thirteenth upload in flight");
  await finish("thirteenth.txt");
  await Bun.sleep(300);
  assert.equal(await composer.inputValue(), "/", "the path waits on the lone slash");
  const mic = page.locator(".composer .voice-mic");
  await mic.focus();
  await page.keyboard.press("Enter");
  await until(() => page.evaluate(() => "fakeSpeech" in window), "dictation listening");
  await Bun.sleep(1200);
  await page.evaluate(() => (window as unknown as { fakeSpeech: { onresult: (event: unknown) => void } }).fakeSpeech.onresult({ results: { length: 1, 0: { isFinal: true, 0: { transcript: "review this" } } } }));
  await page.keyboard.press("Enter");
  await until(async () => /@\S*thirteenth-\S* /.test(await composer.inputValue()), "the path goes in once dictation ends the command");
  assert.match(await composer.inputValue(), /review this/);
  await page.evaluate(() => {
    const speech = window as unknown as Record<string, unknown>;
    Object.assign(window, speech.realSpeech as object);
    delete speech.realSpeech;
    delete speech.fakeSpeech;
  });
  await composer.fill("");
  await selectPane(paneA);
  await selectPane(paneB);
  held.clear();
  await composer.fill("hello");
  await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(1, 4, "backward"));
  await pickFiles("eleventh.txt");
  await until(() => held.has("eleventh.txt"), "eleventh upload in flight");
  await finish("eleventh.txt");
  await until(async () => /^@\S*eleventh-\S* hello$/.test(await composer.inputValue()), "the path went to the start");
  const selection = await composer.evaluate((element: HTMLTextAreaElement) => ({ text: element.value.slice(element.selectionStart, element.selectionEnd), direction: element.selectionDirection }));
  assert.deepEqual(selection, { text: "ell", direction: "backward" }, "the selection keeps its text and direction");
  await composer.fill("");
  console.log("PASS paths wait for a /command, typed or dictated, or an IME composition to finish, and selections keep their direction");

  // A path that does not fit whole is never cut: it waits, its chip shows a warning glyph (its words
  // for assistive tech) and the status line says the limit and how many characters over, Send is
  // off, and the path goes in once there is room. The count of characters left shows only near the limit.
  const MAX_COMPOSER_CHARS = 20_000; // src/lib/compose.ts; importing it would load the app's modules here
  const statusHint = page.locator(".composer-status-hint");
  const sendButton = page.getByRole("button", { name: "Send message", exact: true });
  held.clear();
  await composer.fill("x".repeat(MAX_COMPOSER_CHARS - 201));
  assert.equal(await statusHint.count(), 0, "no count far from the limit");
  await composer.fill("x".repeat(MAX_COMPOSER_CHARS - 5));
  await until(async () => (await statusHint.textContent())?.includes("5 characters left") === true, "the count near the limit");
  await pickFiles("fourteenth.txt");
  await until(() => held.has("fourteenth.txt"), "fourteenth upload in flight");
  await finish("fourteenth.txt");
  const roomless = page.locator(".composer-attachment.is-no-room");
  await roomless.waitFor();
  assert.equal(await roomless.locator(".composer-attachment-state svg").count(), 1, "the tile's badge is a glyph");
  assert.equal(await roomless.locator(".composer-attachment-state .visually-hidden").innerText(), "No room", "its words are for assistive tech");
  await until(async () => /20,000-character limit · \d+ over/.test(await statusHint.textContent() ?? ""), "the status line says the limit and how much over");
  const short = Number(/· (\d+) over/.exec(await statusHint.textContent() ?? "")![1]);
  assert.equal(await sendButton.isDisabled(), true, "Send waits for the path");
  assert.equal(await composer.inputValue(), "x".repeat(MAX_COMPOSER_CHARS - 5), "no part of the path went in");
  await composer.fill("x".repeat(MAX_COMPOSER_CHARS - 200));
  await until(async () => /^@\S*fourteenth-\S* x+$/.test(await composer.inputValue()), "the path goes in once there is room");
  assert.equal(short, /^@\S+ /.exec(await composer.inputValue())![0].length - 5, "the count was what the path needed");
  assert.equal(await roomless.count(), 0, "the chip is attached again");
  // Removing the file with no room lets the paths waiting behind it in, with no edit of the text.
  const mentionLength = /^@\S+ /.exec(await composer.inputValue())![0].length - "fourteenth.txt".length;
  const long = `fifteenth${"y".repeat(60)}.txt`;
  await composer.fill("x".repeat(MAX_COMPOSER_CHARS - mentionLength - "sixteenth.txt".length - 20));
  await pickFiles(long, "sixteenth.txt");
  await until(() => held.has(long) && held.has("sixteenth.txt"), "fifteenth and sixteenth uploads in flight");
  await finish(long);
  await roomless.waitFor();
  await finish("sixteenth.txt");
  assert.equal(await roomless.locator(".composer-attachment-state svg").count(), 1, "the long path's tile shows the glyph");
  assert.equal(await sendButton.isDisabled(), true, "the short path waits behind the long one");
  assert.doesNotMatch(await composer.inputValue(), /sixteenth/u);
  await page.getByRole("button", { name: `Remove ${long}`, exact: true }).click();
  await until(async () => /^@\S*sixteenth-\S* x+$/.test(await composer.inputValue()), "the short path goes in once the long one is removed");
  await until(async () => !(await sendButton.isDisabled()), "Send is back once every path is in");
  await composer.fill("");
  console.log("PASS a path that does not fit waits whole and says how much to cut, and the count shows only near the limit");
  // One pick takes up to 100 files, and says what it left out.
  await page.unroute("**/api/pane/image");
  const limitedUploads: string[] = [];
  await page.route("**/api/pane/image", async (route) => {
    limitedUploads.push(route.request().postDataJSON().pane_id);
    await route.continue();
  });
  const ready = page.locator(".composer-attachment.is-ready");
  const readyBefore = await ready.count();
  await page.locator('input[type="file"]').setInputFiles(["a", "b", "c", "d", "e", "f"].map((name) => ({ name: `${name}.png`, mimeType: "image/png", buffer: png })));
  await until(async () => (await ready.count()) === readyBefore + 6, "six attachments uploaded");
  assert.deepEqual(limitedUploads, Array(6).fill(paneB), "every picked file is uploaded");
  assert.equal(await page.getByRole("alert").filter({ hasText: /the first \d+ of \d+ files/ }).count(), 0, "nothing was left out");
  limitedUploads.length = 0;
  // the first file is over the size limit: its error and the count left out both stay in the note
  // Paths let Chromium pick the real files. A buffer sends 32 MB through Playwright's injected
  // base64 decoder on the page before the app can reject it by size, timing out on a busy runner.
  const hugeFile = join(root, "huge.bin");
  writeFileSync(hugeFile, "");
  truncateSync(hugeFile, MAX_ATTACHMENT_BYTES + 1);
  const manyFiles = Array.from({ length: 100 }, (_, index) => {
    const path = join(root, `many-${index}.png`);
    writeFileSync(path, png);
    return path;
  });
  await page.locator('input[type="file"]').setInputFiles([hugeFile, ...manyFiles]);
  await until(async () => (await ready.count()) === readyBefore + 6 + 99, "the files within both limits uploaded");
  const note = page.getByRole("alert").filter({ hasText: "Too large to attach: huge.bin" });
  await note.waitFor();
  assert.match(await note.innerText(), /the first 100 of 101 files were taken/);
  assert.deepEqual(limitedUploads, Array(99).fill(paneB), "only the files within the limit are uploaded");
  console.log("PASS one pick attaches up to 100 files and names what it left out");

  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  releases.push(releaseCreate);
  let createRequests = 0;
  let createCwd: string | null = null;
  await page.route("**/api/workspace/create", async (route) => {
    createRequests += 1;
    const body = route.request().postDataJSON() as { cwd?: string | null };
    createCwd = typeof body.cwd === "string" ? body.cwd : null;
    await createGate;
    await route.continue();
  });
  await page.locator(".machine-new-row").click();
  const dialog = page.getByRole("dialog", { name: /^New workspace/ });
  // opening Browse on home leaves Directory as typed, `~`, not the absolute path it lists
  await dialog.getByLabel(/^Directory/).fill("~");
  await dialog.getByRole("button", { name: "Browse", exact: true }).click();
  await dialog.locator(".dir-browser-item").first().waitFor();
  assert.equal(await dialog.getByLabel(/^Directory/).inputValue(), "~", "Browse keeps the home-relative form");
  await dialog.getByRole("button", { name: "Browse", exact: true }).click();
  await dialog.getByLabel(/^Directory/).fill(root);
  await checkFolderFilter(page, dialog, () => createRequests);
  // Browse into a child and Start without Use this folder: create must use that child (#1162).
  // root/a and root/b already exist from the owned panes at the top of this script.
  await dialog.getByRole("button", { name: "Browse", exact: true }).click();
  await dialog.getByRole("searchbox", { name: "Filter folders" }).waitFor();
  await dialog.locator(".dir-browser-item", { hasText: /^a$/ }).click();
  await until(async () => (await dialog.getByLabel(/^Directory/).inputValue()).endsWith("/a"), "Directory follows Browse into a");
  // New folder inside a: the workspace starts in the folder it made
  await checkNewFolder(page, dialog, () => createRequests, "made-here");
  await dialog.getByLabel(/^Name/).fill("ovis-test-browser-created");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await until(() => createRequests === 1, "creation started");
  assert.equal(createCwd, join(root, "a", "made-here"), "Start uses the folder Browse is showing");
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "in-flight creation cannot be dismissed");
  assert.equal(await dialog.getByRole("button", { name: "Close dialog" }).isDisabled(), true);
  const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/workspace/create"));
  releaseCreate();
  const created = await (await createdResponse).json() as WorkspaceCreated;
  workspaces.push(created.workspace_id);
  await dialog.waitFor({ state: "hidden" });
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "created pane selected");
  assert.equal(createRequests, 1);
  console.log("PASS session creation stays pending and opens one owned workspace");

  // Existing git worktrees are discovered through the list API. A new worktree from the row's
  // ⋯ menu appears under the same workspace, using its exact branch rather than its editable label.
  repo = join(root, `ovis-test-repo-${process.pid.toString(36)}`);
  mkdirSync(repo);
  const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=ovis test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo ?? undefined, stdout: "pipe", stderr: "pipe" });
  assert.equal(git("init", "-q", "-b", "main").exitCode, 0, "git init");
  writeFileSync(join(repo, "README.md"), "worktree fixture\n");
  assert.equal(git("add", "README.md").exitCode, 0);
  assert.equal(git("commit", "-q", "-m", "fixture").exitCode, 0, "git commit");
  const repoWorkspace = await workspaceCreate({ cwd: repo, label: "ovis-test-repo" });
  workspaces.push(repoWorkspace.workspace.workspace_id);
  const repoRow = workspaceHeader(repoWorkspace.workspace.workspace_id);
  await repoRow.waitFor();
  // herdr has not marked this workspace as a repository's yet: its row is where the first worktree starts
  await repoRow.locator(".workspace-select").click({ button: "right" });
  const unmarkedRepoMenu = page.getByRole("menu");
  await unmarkedRepoMenu.getByRole("menuitem", { name: "New worktree", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await unmarkedRepoMenu.waitFor({ state: "detached" });
  const initialResponse = await fetch(`${origin}/api/worktree/create`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: repoWorkspace.workspace.workspace_id, branch: "browser/initial", label: "Existing checkout" }),
  });
  assert.equal(initialResponse.status, 200, "an existing branch fixture is created through the owned workspace API");
  const initialWorktree = await initialResponse.json() as WorktreeOpened;
  worktreeWorkspaces.push(initialWorktree.workspace_id);
  const initialRow = page.locator(`.worktree-children .workspace-group[data-workspace="${initialWorktree.workspace_id}"]`);
  await until(async () => await initialRow.locator(".workspace-name").textContent() === "Existing checkout", "a named worktree's row is titled by its workspace name");
  assert.equal(await initialRow.locator(".worktree-workspace-label").textContent(), "browser/initial", "the list API discovers an existing worktree's exact branch, said after the name");
  assert.equal(await repoRow.locator(".workspace-name").textContent(), "ovis-test-repo", "the parent keeps its workspace name");
  // A list read from before creation must not erase the branch supplied by the create response.
  let releaseWorktreeList!: () => void;
  const heldWorktreeList = new Promise<void>((resolve) => { releaseWorktreeList = resolve; });
  releases.push(releaseWorktreeList);
  let worktreeListCaptured = false;
  let staleWorktreeListFinished = false;
  let freshWorktreeListFinished = false;
  await page.route("**/api/worktree/list?*", async (route) => {
    const response = await route.fetch();
    if (!worktreeListCaptured) {
      worktreeListCaptured = true;
      await heldWorktreeList;
      await route.fulfill({ response });
      staleWorktreeListFinished = true;
    } else {
      await route.fulfill({ response });
      freshWorktreeListFinished = true;
    }
  });
  await setPageHidden(true);
  await setPageHidden(false);
  await until(() => worktreeListCaptured, "a pre-create worktree inventory is held");
  await repoRow.locator(".workspace-select").click();
  await repoRow.locator(".workspace-toggle").click();
  await initialRow.waitFor({ state: "detached" });
  await repoRow.locator(".workspace-select").click({ button: "right" });
  const repoMenu = page.getByRole("menu");
  await repoMenu.waitFor();
  const repoActions = await repoMenu.getByRole("menuitem").allTextContents();
  assert.deepEqual(repoActions, ["Pin workspace", "Rename workspace", "Earlier sessions…", "Close group", "New worktree", "Open worktree…", "Expand"],
    "a folded repository group has native workspace and worktree actions");
  await page.keyboard.press("Escape");
  await repoMenu.waitFor({ state: "detached" });
  await repoRow.locator(".workspace-select").click({ button: "right" });
  await repoMenu.waitFor();
  assert.deepEqual(await repoMenu.getByRole("menuitem").allTextContents(), repoActions,
    "a repository group's explicit menu and right-click menu have identical actions");
  await page.getByRole("menuitem", { name: "New worktree", exact: true }).click();
  const newWorktree = page.getByRole("dialog", { name: /^New worktree/ });
  await newWorktree.waitFor();
  // the branch and the name arrive filled in, as herdr's own form fills them, and the name follows the branch
  const suggested = await newWorktree.getByLabel(/^Branch/).inputValue();
  assert.match(suggested, /^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assert.equal(await newWorktree.getByLabel(/^Name/).inputValue(), suggested.replace("/", "-"));
  await newWorktree.getByLabel(/^Branch/).fill("browser/sidebar");
  // the agent to start in the checkout is chosen here; the run takes a shell so nothing is launched
  const worktreeAgent = newWorktree.getByRole("combobox", { name: "Agent" });
  await worktreeAgent.click();
  await page.getByRole("option", { name: "Shell", exact: true }).click();
  assert.equal((await worktreeAgent.textContent())?.trim(), "Shell");
  assert.equal(await newWorktree.getByLabel(/^Name/).inputValue(), "browser-sidebar");
  await newWorktree.getByLabel(/^Name/).fill("Sidebar redesign");
  const worktreeResponse = page.waitForResponse((response) => response.url().endsWith("/api/worktree/create"));
  await newWorktree.getByRole("button", { name: "Create worktree", exact: true }).click();
  const worktree = await (await worktreeResponse).json() as WorktreeOpened;
  worktreeWorkspaces.push(worktree.workspace_id);
  assert.equal(worktree.branch, "browser/sidebar");
  await newWorktree.waitFor({ state: "detached" });
  await until(async () => (await page.locator(`.pane-select[title^="${worktree.pane_id} —"]`).getAttribute("aria-current")) === "true", "the worktree's pane is selected");
  const childRow = page.locator(`.worktree-children .workspace-group[data-workspace="${worktree.workspace_id}"]`);
  const childHeader = childRow.locator(":scope > .workspace-header");
  assert.equal(await repoRow.locator(".sidebar-drag-handle").count(), 0, "the parent workspace has no reorder grip column");
  assert.equal(await childHeader.locator(".sidebar-drag-handle").count(), 0, "the branch workspace has no reorder grip column");
  assert.equal(await repoRow.locator(".workspace-select").getAttribute("draggable"), "true", "the parent workspace row supports dragging");
  assert.equal(await childHeader.locator(".workspace-select").getAttribute("draggable"), "true", "the branch workspace row supports dragging");
  await until(async () => await childHeader.locator(".workspace-name").textContent() === "Sidebar redesign", "a newly created child is titled by the name it was given");
  assert.equal(await childHeader.locator(".worktree-workspace-label").textContent(), "browser/sidebar", "its exact branch, slash included, follows the name");
  assert.equal(await repoRow.locator(".workspace-toggle").getAttribute("aria-expanded"), "true", "creation expands a previously folded parent");
  assert.equal(await page.locator(`.workspace-group[data-workspace="${repoWorkspace.workspace.workspace_id}"] + .worktree-children > .workspace-list > .workspace-group`).count(), 2,
    "existing and newly created branches share their repository workspace");
  assert.equal(await childHeader.locator('.workspace-select[aria-current="true"]').count(), 1, "the created branch is selected");
  assert.equal(staleWorktreeListFinished, false, "the create response displays the branch before the pending list finishes");
  releaseWorktreeList();
  await until(() => staleWorktreeListFinished && freshWorktreeListFinished, "the stale inventory is followed by a fresh one");
  assert.equal(await childHeader.locator(".worktree-workspace-label").textContent(), "browser/sidebar", "a pre-create inventory cannot erase the new branch");
  assert.equal(await childHeader.locator(".workspace-name").textContent(), "Sidebar redesign", "nor the name it was given");
  await page.unroute("**/api/worktree/list?*");
  await childHeader.locator(".workspace-select").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename workspace", exact: true }).click();
  const worktreeRename = childHeader.getByRole("textbox", { name: "Workspace name", exact: true });
  assert.equal(await childHeader.locator(".workspace-select").getAttribute("draggable"), "false", "an editing field disables row dragging");
  await worktreeRename.fill("Sidebar renamed");
  await worktreeRename.press("Enter");
  await until(async () => await childHeader.locator(".workspace-name").textContent() === "Sidebar renamed", "the child workspace is renamed in its row title");
  assert.equal(await childHeader.locator(".workspace-select").getAttribute("draggable"), "true", "row dragging returns after editing finishes");
  assert.equal(await childHeader.locator(".worktree-workspace-label").textContent(), "browser/sidebar", "renaming a workspace preserves its actual git branch");
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "worktree-branches-sidebar.png") });
  // a workspace row's menu also opens from a right-click on the row
  await repoRow.locator(".workspace-select").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open worktree…", exact: true }).click();
  const openWorktree = page.getByRole("dialog", { name: /^Open worktree/ });
  await openWorktree.waitFor();
  const entry = openWorktree.locator(".worktree-row", { hasText: "browser/sidebar" });
  await entry.waitFor();
  assert.equal(await entry.locator(".pill").count(), 1, "the open checkout is marked as open");
  await page.keyboard.press("Escape");
  await openWorktree.waitFor({ state: "detached" });
  console.log("PASS existing and new branches sit under their workspace; creation expands the group and workspace renames preserve the branch");

  // Keep one child for the group-aware reorder check; clean up the initial API-created fixture.
  const removeInitial = await fetch(`${origin}/api/worktree/remove`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: initialWorktree.workspace_id }),
  });
  assert.equal(removeInitial.status, 200, "the initial owned checkout is removed");
  await initialRow.waitFor({ state: "detached" });
  worktreeWorkspaces.splice(worktreeWorkspaces.indexOf(initialWorktree.workspace_id), 1);

  // The worktree's row sits under its repository's, as herdr packs them.
  // Its menu deletes the checkout: a dirty one is refused in git's words first, then deleted anyway.
  const repoHeader = repoRow;
  await childRow.waitFor();
  assert.equal(await page.locator(".worktree-children").count(), 1, "one group of worktrees, under the repository's row");
  await herdrRpc("pane.report_agent", { pane_id: worktree.pane_id, source: "manual", agent: "codex", state: "idle" });
  await agentRow(worktree.pane_id).waitFor();
  await repoHeader.locator(".workspace-select").click();
  await repoHeader.locator('.workspace-select[aria-current="true"]').waitFor();
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id),
    repoWorkspace.root_pane.pane_id, "selecting the parent after its branch returns to the parent's own pane");
  const repoToggle = repoHeader.locator(".workspace-toggle");
  await repoToggle.click();
  await childRow.waitFor({ state: "detached" });
  // the folder that leads the row is the fold, and a closed one says how many checkouts it holds
  assert.equal(await repoHeader.evaluate((header) => header.firstElementChild?.classList.contains("workspace-toggle") ?? false), true, "the fold leads the row");
  assert.equal(await repoHeader.locator(".workspace-fold-count").textContent(), "+1");
  assert.equal(await agentRow(worktree.pane_id).isVisible(), true, "folding a worktree group preserves its independent agent");
  await agentRow(worktree.pane_id).locator(".agent-select").click();
  await childHeader.locator('.workspace-select[aria-current="true"]').waitFor();
  assert.equal(await repoToggle.getAttribute("aria-expanded"), "false", "an explicitly selected child remains visible within a folded group");
  await repoToggle.click();
  // reorder is group-aware: the repository's row moves up past the workspace above it with its
  // worktree (herdr moves only the workspace named), and its lone worktree has no sibling to move
  // among, so nothing is sent for it
  const moves: number[] = [];
  await page.route("**/api/workspace/move", async (route) => { moves.push(route.request().postDataJSON().insert_index as number); await route.continue(); });
  const herdrOrder = async () => (await herdrRpc<{ snapshot: { workspaces: { workspace_id: string }[] } }>("session.snapshot", {})).snapshot.workspaces.map((workspace) => workspace.workspace_id);
  const orderBefore = await herdrOrder();
  const repoId = repoWorkspace.workspace.workspace_id;
  const above = orderBefore[orderBefore.indexOf(repoId) - 1]!;
  await repoHeader.locator(".workspace-select").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await until(async () => {
    const order = await herdrOrder();
    return order[order.indexOf(repoId) + 1] === worktree.workspace_id && order.indexOf(above) > order.indexOf(worktree.workspace_id);
  }, "the repository's row and its worktree moved up past the workspace above them");
  const sent = moves.length;
  await childHeader.locator(".workspace-select").focus();
  await page.keyboard.press("Alt+ArrowDown");
  await page.waitForTimeout(400); // fixed wait: no worktree move may be sent
  assert.equal(moves.length, sent, "a lone worktree has nowhere to move");
  await page.unroute("**/api/workspace/move");
  writeFileSync(join(worktree.path, "unsaved.txt"), "dirty\n");
  // a desktop draws no row ⋯: the context-menu key opens the menu at the focused row
  await childHeader.locator(".workspace-select").focus();
  await contextMenuKey(page);
  const childMenu = page.getByRole("menu");
  await childMenu.waitFor();
  const childActions = await childMenu.getByRole("menuitem").allTextContents();
  assert.deepEqual(childActions, ["Pin workspace", "Rename workspace", "Earlier sessions…", "Close workspace", "Delete worktree checkout…"], "a worktree workspace's menu");
  await page.keyboard.press("Escape");
  await childMenu.waitFor({ state: "detached" });
  await childHeader.locator(".workspace-select").click({ button: "right" });
  await childMenu.waitFor();
  assert.deepEqual(await childMenu.getByRole("menuitem").allTextContents(), childActions,
    "a linked checkout's keyboard menu and right-click menu have identical actions");
  await page.keyboard.press("Escape");
  await childMenu.waitFor({ state: "detached" });
  // pinned, the worktree leaves its repository's group for the pinned card at the top; unpinned, it returns
  await childHeader.locator(".workspace-select").click({ button: "right" });
  await childMenu.getByRole("menuitem", { name: "Pin workspace", exact: true }).click();
  const pinnedCard = page.locator(".workspace-list-pinned");
  await pinnedCard.locator(`.workspace-group[data-workspace="${worktree.workspace_id}"]`).waitFor();
  assert.equal(await page.locator(`.worktree-children .workspace-group[data-workspace="${worktree.workspace_id}"]`).count(), 0, "a pinned worktree leaves its group");
  await pinnedCard.locator(`.workspace-group[data-workspace="${worktree.workspace_id}"] .workspace-select`).click({ button: "right" });
  await childMenu.getByRole("menuitem", { name: "Unpin workspace", exact: true }).click();
  await pinnedCard.waitFor({ state: "detached" });
  await childRow.waitFor();
  await childHeader.locator(".workspace-select").click({ button: "right" });
  await childMenu.waitFor();
  await childMenu.getByRole("menuitem", { name: "Delete worktree checkout…", exact: true }).click();
  const deleteConfirm = page.getByRole("alertdialog");
  await deleteConfirm.waitFor();
  await deleteConfirm.getByRole("button", { name: "Delete", exact: true }).click();
  await deleteConfirm.getByRole("button", { name: "Delete anyway", exact: true }).waitFor();
  assert.equal(await deleteConfirm.locator(".confirm-error").count(), 1, "git's refusal shows in the confirm");
  await deleteConfirm.getByRole("button", { name: "Delete anyway", exact: true }).click();
  await deleteConfirm.waitFor({ state: "detached" });
  await childRow.waitFor({ state: "detached" });
  assert.equal(existsSync(worktree.path), false, "the checkout is gone");
  worktreeWorkspaces.splice(worktreeWorkspaces.indexOf(worktree.workspace_id), 1);
  console.log("PASS a worktree row sits under its repository's row, and its menu deletes the checkout, asking twice for a dirty one");

  // A second tab from the tab's menu, New tab with agent…: the dialog is New tab, with the workspace's folder shown
  // and not asked for; the new pane opens, the workspace stays one row, and a strip over the pane
  // lists both tabs from then on.
  // The new pane's terminal takes the focus once it paints, which would close a menu opened before.
  await until(() => painted.has(created.pane_id), "created pane paint");
  await page.locator(`.pane-select[title^="${created.pane_id} —"]`).click();
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "the created workspace is selected again");
  const openAgentTab = async () => {
    await page.locator(".tab-strip").getByRole("tab", { selected: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "New tab with agent…", exact: true }).click();
  };
  await openAgentTab();
  const tabDialog = page.getByRole("dialog", { name: /^New tab · ovis-test-browser-created/ });
  await tabDialog.waitFor();
  assert.equal(await tabDialog.locator(".new-session-folder").textContent(), join(root, "a", "made-here"), "the folder is the workspace's, shown");
  assert.equal(await tabDialog.getByRole("button", { name: "Browse", exact: true }).count(), 0, "the folder is not asked for");
  const tabNameField = tabDialog.getByLabel(/^Name/);
  await tabNameField.fill("second");
  // The command palette takes the keyboard above a dialog. Escape closes only the palette,
  // preserving the dialog's draft so the same creation can continue.
  await page.keyboard.press("ControlOrMeta+Shift+K");
  const paletteOverDialog = page.getByRole("dialog", { name: "Command palette", exact: true });
  await paletteOverDialog.waitFor();
  await page.keyboard.press("Escape");
  await paletteOverDialog.waitFor({ state: "hidden" });
  assert.equal(await tabDialog.isVisible(), true, "Escape on the palette over the dialog closes the palette alone");
  assert.equal(await tabNameField.inputValue(), "second", "the dialog keeps its draft under the palette");
  const tabResponse = page.waitForResponse((response) => response.url().endsWith("/api/tab/create"));
  await tabDialog.getByRole("button", { name: "Start", exact: true }).click();
  const createdTab = await (await tabResponse).json() as WorkspaceCreated;
  assert.equal(createdTab.workspace_id, created.workspace_id, "the tab joins the workspace");
  await tabDialog.waitFor({ state: "hidden" });
  await until(async () => (await page.locator(`.pane-select[title^="${createdTab.pane_id} —"]`).getAttribute("aria-current")) === "true", "the new tab's pane is selected, and the row shows it");
  assert.equal(await page.locator(`.pane-select[title^="${created.pane_id} —"]`).count(), 0, "the workspace stays one row");
  assert.equal(await workspaceGroup(created.workspace_id).locator(".workspace-name").textContent(), "ovis-test-browser-created",
    "opening another tab preserves the workspace name in Spaces");
  assert.equal(await workspaceGroup(created.workspace_id).locator(".workspace-select").count(), 1,
    "all tabs share the workspace's representative row");
  assert.equal(await workspaceGroup(created.workspace_id).locator(".sidebar-tab-heading").count(), 0,
    "tab labels stay in the terminal tab strip");
  const strip = page.locator(".tab-strip");
  await strip.waitFor();
  assert.deepEqual(await strip.getByRole("tab").allTextContents(), ["Tab 1", "second"]);
  assert.equal(await strip.getByRole("tab", { selected: true }).textContent(), "second");
  assert.equal(await strip.locator(".tab-strip-close, .tab-strip-panes").count(), 0, "tab close buttons and chevrons are removed");
  assert.equal(await strip.locator(".tab-strip-menu:visible").count(), 0, "desktop tabs show no menu button at rest");
  // the selected tab's actions button waits hidden in its place: the pointer over the strip or the
  // tab's keyboard focus brings it into view, and no other tab draws one
  const stripMenu = strip.locator(".tab-strip-item.is-active .tab-strip-menu");
  const stripMenuOpacity = () => stripMenu.evaluate((node) => getComputedStyle(node).opacity);
  await strip.hover();
  await stripMenu.waitFor({ state: "visible" });
  await until(async () => await stripMenuOpacity() === "1", "the pointer over the strip reveals the selected tab's actions button");
  assert.equal(await strip.locator(".tab-strip-menu:visible").count(), 1, "only the selected tab shows an actions button");
  assert.equal(await stripMenu.getAttribute("aria-label"), "Actions for second");
  await page.mouse.move(640, 600);
  await stripMenu.waitFor({ state: "hidden" });
  await page.locator(".tab-strip-add").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await strip.getByRole("tab", { selected: true }).evaluate((node) => node === document.activeElement), true, "Shift+Tab from the + lands on the selected tab");
  await stripMenu.waitFor({ state: "visible" });
  await until(async () => await stripMenuOpacity() === "1", "keyboard focus on the selected tab reveals its actions button");
  assert.equal(await strip.locator(".tab-strip-menu:visible").count(), 1, "keyboard focus reveals the selected tab's button alone");
  await strip.getByRole("tab", { name: "Tab 1", exact: true }).click();
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "the first tab opens its pane again");
  assert.equal(await strip.getByRole("tab", { selected: true }).textContent(), "Tab 1");
  // reopened right after a creation: its fields are live and Escape puts it away at once
  // The menu restores this terminal on unmount. Record focus at the dialog's DOM commit,
  // before any animation frame can rescue it: Escape may arrive before that first paint.
  await page.locator(".pane-frame.is-current .xterm-helper-textarea").focus();
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const dialog = document.querySelector(".new-session-modal");
      if (!dialog) return;
      dialog.setAttribute("data-focus-at-open", String(dialog.contains(document.activeElement)));
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await openAgentTab();
  await tabDialog.waitFor();
  assert.equal(await tabDialog.getAttribute("data-focus-at-open"), "true", "the dialog owns focus before its first paint, not the terminal restored by its menu");
  assert.equal(await tabDialog.getByRole("button", { name: "Start", exact: true }).isDisabled(), false, "a reopened dialog is not left pending");
  await page.keyboard.press("Escape");
  await tabDialog.waitFor({ state: "hidden" });
  // A failed launch leaves its created pane available through Open. Closing instead must
  // not leave the next opening's agent picker disabled, with focus back in the terminal.
  await page.route("**/api/agents", (route) => route.fulfill({ json: { agents: [{ kind: "claude", label: "Claude", installed: true }] } }));
  await page.route("**/api/tab/create", (route) => route.fulfill({ json: {
    workspace_id: created.workspace_id, pane_id: created.pane_id, agent_started: false,
    error: { code: "agent_start_failed", message: "Agent could not start" },
  } satisfies WorkspaceCreated }));
  await openAgentTab();
  await tabDialog.getByRole("combobox", { name: "Agent", exact: true }).click();
  await tabDialog.getByRole("option").filter({ hasText: "Claude" }).click();
  await tabDialog.getByRole("button", { name: "Start", exact: true }).click();
  await tabDialog.getByRole("button", { name: "Open", exact: true }).waitFor();
  assert.equal(await tabDialog.getByRole("combobox", { name: "Agent", exact: true }).isDisabled(), true, "a failed launch keeps its created pane available, not a second Start");
  await page.keyboard.press("Escape");
  await tabDialog.waitFor({ state: "hidden" });
  await page.locator(".pane-frame.is-current .xterm-helper-textarea").focus();
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const dialog = document.querySelector(".new-session-modal");
      if (!dialog) return;
      dialog.setAttribute("data-focus-at-open", String(dialog.contains(document.activeElement)));
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await openAgentTab();
  await tabDialog.waitFor();
  assert.equal(await tabDialog.getAttribute("data-focus-at-open"), "true", "reopening after an agent start failure owns focus before paint");
  assert.equal(await tabDialog.getByRole("combobox", { name: "Agent", exact: true }).isDisabled(), false, "reopening after a failed launch enables the agent picker");
  await page.keyboard.press("Escape");
  await tabDialog.waitFor({ state: "hidden" });
  await page.unroute("**/api/tab/create");
  await page.unroute("**/api/agents");
  await page.evaluate(() => localStorage.removeItem("ovis:new-session-agent"));
  console.log("PASS reopening after a failed agent start owns focus before paint, enables its fields and closes with Escape");
  // the lone Host's New workspace row is New workspace again, not a tab in the workspace the last dialog was for
  await page.locator(".machine-new-row").click();
  await page.getByRole("dialog", { name: /^New workspace/ }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: /^New workspace/ }).waitFor({ state: "hidden" });
  console.log("PASS a second tab is made from the tab strip, listed over the pane, and opened from it");

  // The strip's + is herdr's own new tab: a shell tab in the workspace's folder at once, no dialog,
  // and its pane opens. It is closed again, so the tabs below stay the two named ones.
  const terminalResponse = page.waitForResponse((response) => response.url().endsWith("/api/tab/create"));
  await page.locator(".tab-strip-add").click();
  const terminalAnswer = await terminalResponse;
  assert.deepEqual(terminalAnswer.request().postDataJSON(), { workspace_id: created.workspace_id, cwd: join(root, "a", "made-here"), label: null, agent: null }, "the + asks for a shell tab in the workspace's folder");
  const terminalTab = await terminalAnswer.json() as WorkspaceCreated;
  assert.equal(terminalTab.workspace_id, created.workspace_id, "the shell tab joins the workspace");
  assert.equal(terminalTab.agent_started, false, "no agent is started");
  await until(async () => (await page.locator(`.pane-select[title^="${terminalTab.pane_id} —"]`).getAttribute("aria-current")) === "true", "the shell tab's pane is selected");
  assert.equal(await page.getByRole("dialog", { name: /^New tab/ }).count(), 0, "the + opens no dialog");
  assert.equal(await strip.getByRole("tab").count(), 3, "the strip lists the shell tab");
  const terminalTabId = (await sessionSnapshot()).panes.find((pane) => pane.pane_id === terminalTab.pane_id)?.tab_id;
  assert.ok(terminalTabId, "herdr has the shell tab's pane");
  await strip.getByRole("tab", { name: "Tab 1", exact: true }).click();
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "the first tab opens its pane again");
  await herdrRpc("tab.close", { tab_id: terminalTabId });
  await until(async () => (await strip.getByRole("tab").count()) === 2, "the shell tab is gone from the strip");
  console.log("PASS the strip's + opens a shell tab at once, with no dialog");

  // A tab is renamed and closed from the strip, as herdr's prefix+shift+t and prefix+shift+x.
  const tabsInHerdr = async () => (await sessionSnapshot()).tabs.filter((tab) => tab.workspace_id === created.workspace_id).map((tab) => tab.label);
  await strip.getByRole("tab", { name: "Tab 1", exact: true }).dblclick();
  const tabName = strip.getByLabel("Tab name", { exact: true });
  await tabName.waitFor();
  await tabName.fill("  first  ");
  await page.keyboard.press("Enter");
  await until(async () => (await tabsInHerdr()).join() === "first,second", "herdr has the tab's new name, trimmed");
  assert.deepEqual(await strip.getByRole("tab").allTextContents(), ["first", "second"]);
  assert.equal(await workspaceGroup(created.workspace_id).locator(".workspace-name").textContent(), "ovis-test-browser-created",
    "renaming a tab leaves the workspace name unchanged");
  await until(async () => await strip.getByRole("tab", { name: "first", exact: true }).evaluate((tab) => tab === document.activeElement), "the renamed tab has the focus back");
  // F2 opens the field on the focused tab; Escape leaves the name alone, and so does an empty one
  await page.keyboard.press("F2");
  await tabName.fill("discarded");
  // an IME's committing Enter is the composition's: the field stays, and nothing is sent
  await tabName.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
  assert.equal(await tabName.count(), 1, "an IME's Enter does not save the name");
  await page.keyboard.press("Escape");
  await tabName.waitFor({ state: "detached" });
  await page.keyboard.press("F2");
  await tabName.fill("   ");
  await page.keyboard.press("Enter");
  // a blank name is refused and said so: the field stays for another try, and Escape keeps the old name
  await page.locator(".tab-strip-error").getByText("A tab needs a name.", { exact: true }).waitFor();
  assert.equal(await tabName.count(), 1, "a blank name keeps the field open");
  await page.keyboard.press("Escape");
  await tabName.waitFor({ state: "detached" });
  assert.deepEqual(await strip.getByRole("tab").allTextContents(), ["first", "second"]);
  assert.equal((await tabsInHerdr()).join(), "first,second");
  // a right-click opens the tab's menu
  await strip.getByRole("tab", { name: "second", exact: true }).click({ button: "right" });
  const tabMenu = page.getByRole("menu", { name: "second", exact: true });
  await tabMenu.waitFor();
  assert.equal(await strip.getByRole("tab", { selected: true }).textContent(), "first", "opening another tab's context menu does not select it");
  // The tab menu keeps native tab scope; pane operations belong to the pane or header.
  assert.deepEqual(await tabMenu.getByRole("menuitem").allTextContents(), ["Move tab left", "Move to workspace…", "New tab with agent…", "Rename tab", "Close tab"], "the last tab offers only a move to the left, and a one-pane tab a move to another workspace");
  await tabMenu.getByRole("menuitem", { name: "Rename tab", exact: true }).click();
  await tabName.fill("build");
  await page.keyboard.press("Enter");
  await until(async () => (await tabsInHerdr()).join() === "first,build", "the menu's rename reaches herdr");
  // One new neighbour puts build between two tabs for both adjacent move actions.
  await herdrRpc("pane.focus", { pane_id: createdTab.pane_id });
  const neighbour = await herdrRpc<{ tab: { tab_id: string } }>("tab.create", { workspace_id: created.workspace_id, label: "neighbour", focus: false });
  await until(async () => (await tabsInHerdr()).length === 3, "build has two neighbours");
  const tabPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const tabPhonePage = await tabPhone.newPage();
  const tabPhoneEvidence = evidenceDirectory ? await watchBrowserEvidence(tabPhone, tabPhonePage, "touch-tab-menu") : undefined;
  csp.push(await watchCsp(tabPhonePage));
  tabPhonePage.on("pageerror", (error) => errors.push(error.message));
  await tabPhonePage.goto(`${origin}/?pane=${encodeURIComponent(createdTab.pane_id)}`);
  const phoneStrip = tabPhonePage.locator(".tab-strip");
  await phoneStrip.getByRole("tab", { name: "build", exact: true, selected: true }).waitFor();
  assert.equal(await phoneStrip.locator(".tab-strip-close, .tab-strip-panes").count(), 0, "no close button or chevron is rendered");
  assert.equal(await phoneStrip.locator(".tab-strip-menu:visible").count(), 1, "only the open tab has the touch menu button");
  await phoneStrip.getByRole("button", { name: "Actions for build", exact: true }).tap();
  const tabSheet = tabPhonePage.getByRole("dialog", { name: "build", exact: true });
  await tabSheet.waitFor();
  const touchTabItems = await tabSheet.locator(".row-sheet-item").allTextContents();
  assert.deepEqual(touchTabItems.slice(-6), ["Move tab left", "Move tab right", "Move to workspace…", "New tab with agent…", "Rename tab", "Close tab"], "a tab between siblings offers both adjacent moves on touch");
  assert.ok(touchTabItems.includes("Rename pane") && touchTabItems.includes("Close pane"), "the touch menu carries the open pane's actions");
  await tabSheet.getByRole("button", { name: "Cancel", exact: true }).tap();
  await tabSheet.waitFor({ state: "detached" });
  if (tabPhoneEvidence) await tabPhoneEvidence.finish();
  await tabPhone.close();
  await herdrRpc("tab.close", { tab_id: neighbour.tab.tab_id });
  await until(async () => (await tabsInHerdr()).join() === "first,build", "the extra neighbour is closed again");
  // a tab whose agent is at work asks before it closes; a no leaves it
  await herdrRpc("pane.report_agent", { pane_id: createdTab.pane_id, source: "manual", agent: "codex", state: "working" });
  await strip.locator('.tab-strip-dot[data-status="working"]').waitFor();
  await strip.getByRole("tab", { name: "build", exact: true }).click({ button: "right" });
  await page.getByRole("menu", { name: "build", exact: true }).getByRole("menuitem", { name: "Close tab", exact: true }).click();
  const closeTabDialog = page.getByRole("alertdialog", { name: "Close tab build?", exact: true });
  await closeTabDialog.waitFor();
  await closeTabDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await closeTabDialog.waitFor({ state: "detached" });
  assert.equal((await tabsInHerdr()).join(), "first,build");
  // A tab whose agent has finished closes at once from its menu, and the tab beside it opens.
  await herdrRpc("pane.report_agent", { pane_id: createdTab.pane_id, source: "manual", agent: "codex", state: "idle" });
  await strip.locator('.tab-strip-dot[data-status="working"]').waitFor({ state: "detached" });
  await herdrRpc("tab.create", { workspace_id: created.workspace_id, label: "third", focus: false });
  const third = strip.getByRole("tab", { name: "third", exact: true });
  await third.click();
  await until(async () => (await third.getAttribute("aria-selected")) === "true", "the third tab is open");
  // a held Delete is one press: its repeats close nothing
  await third.dispatchEvent("keydown", { key: "Delete", repeat: true, bubbles: true });
  await page.waitForTimeout(300); // fixed wait: a repeated Delete may close no tab
  assert.equal((await tabsInHerdr()).join(), "first,build,third");
  await third.click({ button: "right" });
  await page.getByRole("menu", { name: "third", exact: true }).getByRole("menuitem", { name: "Close tab", exact: true }).click();
  await until(async () => (await tabsInHerdr()).join() === "first,build", "the menu closed the tab");
  await until(async () => (await page.locator(`.pane-select[title^="${createdTab.pane_id} —"]`).getAttribute("aria-current")) === "true", "the tab beside the closed one is open");
  // Delete on a focused tab that is not the open one closes it; the last tab remains visible,
  // the open pane stays, and focus returns to the surviving tab.
  await strip.getByRole("tab", { name: "first", exact: true }).click();
  await until(async () => (await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current")) === "true", "the first tab is open");
  await strip.getByRole("tab", { name: "first", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await until(async () => await strip.getByRole("tab", { name: "build", exact: true }).evaluate((tab) => tab === document.activeElement), "the arrow moved the focus to the other tab");
  await page.keyboard.press("Delete");
  await until(async () => await strip.getByRole("tab").count() === 1, "the native strip keeps its last tab");
  assert.equal((await tabsInHerdr()).join(), "first", "herdr closed the tab and kept the other");
  assert.equal(await page.locator(`.pane-select[title^="${created.pane_id} —"]`).getAttribute("aria-current"), "true", "the open pane stays");
  await until(async () => await strip.getByRole("tab", { name: "first", exact: true }).evaluate((tab) => tab === document.activeElement), "the surviving tab receives focus");
  console.log("PASS a tab is renamed by a double-click, F2 and its menu, and closed from its menu and Delete, asking first while its agent works");

  // herdr 0.9.0 reports Codex's first directory-trust menu as idle. Exercise a
  // live, owned PTY menu so the chat controls cannot depend on a blocked badge.
  await selectPane(paneB);
  const paintStartupMenu = async (): Promise<void> => {
    await herdrRpc("pane.send_text", {
      pane_id: paneB,
      text: "printf '\\033[2J\\033[HDo you trust the contents of this directory?\\n\\n› 1. Yes, continue\\n  2. No, quit\\n\\n  Press enter to continue\\n'; read -r qa_answer",
    });
    await herdrRpc("pane.send_keys", { pane_id: paneB, keys: ["Enter"] });
    await until(async () => {
      const result = await herdrRpc<{ read: { text: string } }>("pane.read", {
        pane_id: paneB, source: "visible", format: "text",
      });
      return result.read.text.includes("Press enter to continue");
    }, "startup menu painted");
  };
  await paintStartupMenu();
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "codex", state: "idle" });
  await page.locator('.composer-status[data-status="idle"]').waitFor();
  const startupPrompt = page.locator(".prompt-card");
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).waitFor();
  // the card is docked on the composer's column, directly over it, and is no part of the transcript
  assert.deepEqual(await startupPrompt.evaluate((node) => ({
    inTranscript: node.closest(".chat-view") !== null,
    next: node.parentElement?.nextElementSibling?.classList.contains("composer") ?? false,
    over: node.getBoundingClientRect().bottom <= document.querySelector(".composer-surface")!.getBoundingClientRect().top,
  })), { inTranscript: false, next: true, over: true });
  assert.equal(await page.locator('.composer-status[data-status="idle"]').count(), 1);
  assert.equal(await page.locator(".chat-empty").count(), 0);
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).click();
  await startupPrompt.waitFor({ state: "hidden" });
  console.log("PASS startup prompt appears and accepts an answer while the agent status is idle");

  // A pick typed in the composer waits in the card for Confirm. Answered in the terminal
  // instead, it must not come back when the same menu (the same prompt id) is asked again.
  await paintStartupMenu();
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).waitFor();
  await composer.fill("1");
  await composer.press("Enter");
  await startupPrompt.locator(".prompt-card-confirm").waitFor();
  await herdrRpc("pane.send_keys", { pane_id: paneB, keys: ["Enter"] });
  await startupPrompt.waitFor({ state: "hidden" });
  await paintStartupMenu();
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).waitFor();
  await page.waitForTimeout(500); // fixed wait: no Confirm may appear on the startup menu
  assert.equal(await startupPrompt.locator(".prompt-card-confirm").count(), 0);
  await startupPrompt.getByRole("button", { name: "1. Yes, continue", exact: true }).click();
  await startupPrompt.waitFor({ state: "hidden" });
  console.log("PASS a typed pick answered in the terminal does not wait on the same menu asked again");

  // Claude's grey suggestion in its empty input box stands in the composer. A send drops it,
  // and the same text suggested again comes back; a pane switch never shows the last pane's.
  const paintSuggestion = async (pane: string, suggestion: string): Promise<void> => {
    await herdrRpc("pane.send_text", {
      pane_id: pane,
      text: `printf '\\033[2J\\033[H%s\\n\\342\\235\\257 \\033[2m%s\\033[0m\\n%s\\n' "$(printf '\\342\\224\\200%.0s' $(seq 40))" '${suggestion}' "$(printf '\\342\\224\\200%.0s' $(seq 40))"; read -r qa_suggest; clear`,
    });
    await herdrRpc("pane.send_keys", { pane_id: pane, keys: ["Enter"] });
    await until(async () => {
      const result = await herdrRpc<{ read: { text: string } }>("pane.read", { pane_id: pane, source: "visible", format: "text" });
      return result.read.text.includes(`❯ ${suggestion}`);
    }, "suggestion painted");
  };
  await selectPane(paneA);
  await composer.fill("");
  await herdrRpc("pane.report_agent", { pane_id: paneA, source: "manual", agent: "claude", state: "idle" });
  await paintSuggestion(paneA, "run the tests");
  await until(async () => await composer.getAttribute("placeholder") === "run the tests", "suggestion as placeholder");
  await composer.focus();
  await page.keyboard.press("Tab");
  assert.equal(await composer.inputValue(), "run the tests", "Tab takes the suggestion");
  // a prompt read made before the send answers after it: its suggestion was for the turn before
  let readBeforeSend = false;
  await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneA)}`, async (route) => {
    const response = await route.fetch();
    readBeforeSend = true;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ response });
  });
  await until(async () => readBeforeSend, "a prompt read in flight");
  await composer.press("Enter");
  await until(async () => await composer.getAttribute("placeholder") !== "run the tests", "a send drops the suggestion");
  await until(async () => await composer.inputValue() === "", "the sent box clears");
  for (let check = 0; check < 16; check++) {
    assert.notEqual(await composer.getAttribute("placeholder"), "run the tests", "a read from before the send does not bring the suggestion back");
    await page.waitForTimeout(150);
  }
  await page.unroute(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneA)}`);
  // the same text suggested again after the turn shows again
  await paintSuggestion(paneA, "run the tests");
  await until(async () => await composer.getAttribute("placeholder") === "run the tests", "the same suggestion again");
  // pane B answers its first prompt read late: meanwhile it must not show pane A's suggestion
  await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "claude", state: "idle" });
  await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneB)}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await selectPane(paneB);
  for (let check = 0; check < 8; check++) {
    assert.notEqual(await composer.getAttribute("placeholder"), "run the tests", "another pane's suggestion never shows");
    await page.waitForTimeout(150);
  }
  await page.unroute(`**/api/pane/prompt?pane_id=${encodeURIComponent(paneB)}`);
  await herdrRpc("pane.send_keys", { pane_id: paneA, keys: ["Enter"] });
  console.log("PASS Claude's suggestion fills the composer with Tab, returns after a send, and stays with its pane");

  // Server-owned Send now drops the old suggestion itself, before a delayed prompt read returns.
  await selectPane(pendingPane);
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Chat");
  await page.getByRole("switch", { name: "Send queued messages automatically", exact: true }).uncheck();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await reportPending("working");
  await page.locator('.composer-status[data-status="working"]').waitFor();
  await pendingReady(pendingPane);
  await composer.fill("# queued before the suggestion");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await until(async () => await pendingRows.count() === 1, "suggestion test pending input accepted");
  // Explicit hold keeps the suggestion beside a server-owned item without dispatching it.
  // Navigation preserves its held state and the same PC connection's recovery actions.
  await selectPane(paneA); await selectPane(pendingPane);
  await page.locator('.pending-message[data-state="held"]').waitFor();
  await pendingReady(pendingPane);
  await reportPending("idle");
  await page.locator('.composer-status:not([data-status="working"])').waitFor();
  const rule = "─".repeat(40);
  writeFileSync(pendingScreen, `${rule}\r\n❯ \u001b[2mcheck the diff\u001b[0m\r\n${rule}\r\n`);
  await until(async () => await composer.getAttribute("placeholder") === "check the diff", "suggestion beside a pending message");
  await page.route(`**/api/pane/prompt?pane_id=${encodeURIComponent(pendingPane)}`, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.continue().catch(() => {});
  });
  const sentAt = Date.now();
  await pendingRows.getByRole("button", { name: /^Send now:/ }).click();
  await until(async () => await composer.getAttribute("placeholder") !== "check the diff", "Send now drops the suggestion");
  assert.ok(Date.now() - sentAt < 2500, "the suggestion goes with the Send now, not with a later read");
  await pendingRows.waitFor({ state: "hidden" });
  await page.unroute(`**/api/pane/prompt?pane_id=${encodeURIComponent(pendingPane)}`);
  await herdrRpc("pane.send_text", { pane_id: pendingPane, text: "\u0003" });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Chat");
  await page.getByRole("switch", { name: "Send queued messages automatically", exact: true }).check();
  await page.getByRole("button", { name: "Close settings", exact: true }).click();
  await workspaceClose(pendingWorkspace.workspace.workspace_id);
  workspaces.splice(workspaces.indexOf(pendingWorkspace.workspace.workspace_id), 1);
  await selectPane(paneA);
  console.log("PASS Send now on a server-owned pending message drops Claude's suggestion");

  // Split view (lib/split.ts): a sidebar row dragged to the right half opens its pane there beside
  // the one open, each half with its own conversation; a press in the other half makes it the
  // active one without moving either pane, and closing a half leaves one pane
  // (after the steps that take the newest socket for the page's own: the other half opens one)
  {
    await selectPane(paneA);
    // The drag goes in steps, each waited on, as split-view-regression.ts drags. One dragTo jumps
    // from the row to the drop point in a single move and drops at once: the drop then rests on the
    // one dragover sent as the drag starts, and nothing checks that the page took it (on a busy
    // runner it left no split). Here the row crosses the native drag threshold, App shows its guide
    // (it saw the dragstart), the area is measured after that, and the drop waits for a dragover on
    // the drop point to take the pane for the right half.
    const area = page.locator(".pane-split");
    const source = page.locator(`.pane-select[title^="${paneB} —"]`);
    await source.scrollIntoViewIfNeeded();
    const from = (await source.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2 + 4, { steps: 2 });
    await page.waitForFunction(() => document.querySelector(".split-drop")?.classList.contains("is-visible") === true);
    const box = (await area.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2, { steps: 8 });
    // crossing the transcript's children can end on a dragenter alone: a move on the same element sends the dragover
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2);
    await page.waitForFunction(() => {
      const guide = document.querySelector(".split-drop");
      return guide?.classList.contains("is-visible") === true && guide.getAttribute("data-side") === "right";
    });
    await page.mouse.up();
    await until(async () => await page.locator(".pane-slot").count() === 2, "two halves after the drop");
    const half = (side: string) => page.locator(`.pane-slot[data-side="${side}"]`);
    await half("left").locator(`.pane-frame[data-layout-pane="${paneA}"]`).getByRole("log").waitFor();
    await half("right").locator(`.pane-frame[data-layout-pane="${paneB}"]`).getByRole("log").waitFor();
    assert.equal(await half("right").evaluate((slot) => slot.classList.contains("is-active")), true, "the dropped pane's half is active");
    assert.equal(await page.locator(".pane-select[aria-current=\"true\"]").getAttribute("title").then((title) => title?.startsWith(`${paneB} —`)), true, "and its pane is the selected one");
    const [left, right] = await Promise.all([half("left").boundingBox(), half("right").boundingBox()]);
    assert.ok(left && right && Math.abs(left.width - right.width) <= 2 && left.x + left.width <= right.x + 1, "the halves share the pane area side by side");
    await half("left").locator(".terminal-host").click({ position: { x: 40, y: 40 } });
    await until(async () => await half("left").evaluate((slot) => slot.classList.contains("is-active")), "a press makes the left half active");
    // the header speaks for the active half's connection, handed over by a terminal that was already connected
    await page.locator(".conn.conn-live").waitFor();
    await half("left").locator(`.pane-frame[data-layout-pane="${paneA}"]`).getByRole("log").waitFor();
    await half("right").locator(`.pane-frame[data-layout-pane="${paneB}"]`).getByRole("log").waitFor();
    assert.match(await page.evaluate(() => sessionStorage.getItem("ovis:split") ?? ""), /"active":"a"/, "the split is kept for a reload");
    await half("right").getByRole("button", { name: "Close this half", exact: true }).click();
    await until(async () => await page.locator(".pane-slot").count() === 1, "one pane after closing a half");
    assert.equal(await page.evaluate(() => sessionStorage.getItem("ovis:split")), null);
    await page.locator(`.pane-frame[data-layout-pane="${paneA}"]`).getByRole("log").waitFor();
  }
  console.log("PASS a dragged row opens its pane beside the open one; a press switches the active half; a half closes");

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await mobile.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException("Storage unavailable", "SecurityError"); };
  });
  const mobilePage = await mobile.newPage();
  const mobileEvidence = evidenceDirectory ? await watchBrowserEvidence(mobile, mobilePage, "mobile-storage-unavailable") : undefined;
  csp.push(await watchCsp(mobilePage));
  mobilePage.on("pageerror", (error) => errors.push(error.message));
  await mobilePage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}`);
  await mobilePage.locator(".conn-live").waitFor();
  const tapHighlight = await mobilePage.locator(".view-switch button").first().evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-tap-highlight-color"));
  assert.equal(tapHighlight, "rgba(0, 0, 0, 0)", "native tap overlays do not obscure selection");
  await mobilePage.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).fill("mobile draft");
  await mobilePage.locator(".chat-terminal-fallback").waitFor();
  assert.equal(await mobilePage.locator(".chat-terminal-fallback").getAttribute("open"), null, "missing native history is labeled, not presented as broken chat");
  assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // a phone's status line holds the agent and its state: no report action, and no keyboard button while typing
  await mobilePage.evaluate(() => document.documentElement.setAttribute("data-keyboard", ""));
  assert.equal(await mobilePage.getByRole("button", { name: "Report a problem", exact: true }).count(), 0, "no report action on a phone");
  assert.equal(await mobilePage.getByRole("button", { name: "Hide keyboard", exact: true }).count(), 0, "no keyboard button on a phone");
  await mobilePage.evaluate(() => document.documentElement.removeAttribute("data-keyboard"));
  assert.equal(errors.length, 0, errors.join("\n"));
  assertCspClean(csp, "the chat, the composer and the phone views load with no CSP violation");
  console.log("PASS mobile composer with unavailable storage and no horizontal overflow");

  // a phone: the composer's chip shows the plan's count on the status line's one row, and its steps
  // open above the card without making the page scroll sideways
  const planPhone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await planPhone.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat" })));
  const phone = await planPhone.newPage();
  phone.on("pageerror", (error) => errors.push(error.message));
  const unroutePhonePlanned = await planned(phone, { events: true });
  await phone.goto(`${origin}/?pane=${encodeURIComponent(paneA)}`);
  await phone.locator(".conn-live").waitFor();
  const phonePlan = phone.getByRole("button", { name: /^Plan: 1 of 4 done/ });
  await phonePlan.waitFor();
  const card = (await phone.locator(".composer-surface").first().boundingBox())!;
  const counted = (await phonePlan.boundingBox())!;
  assert.ok(counted.x >= card.x && counted.x + counted.width <= card.x + card.width, "the plan's chip fits a phone's card");
  assert.equal((await phonePlan.locator(".bg-tasks-plan").textContent())?.trim(), "1/4", "a phone keeps the count");
  await phonePlan.tap();
  const phoneList = phone.getByRole("dialog", { name: /^Plan/ });
  await until(async () => await phoneList.locator(".bg-step").count() === 4, "the plan on a phone");
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (process.env.UI_EVIDENCE_DIR) await phone.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "plan-phone.png") });
  await phonePlan.tap();
  await phoneList.waitFor({ state: "detached" });
  await unroutePhonePlanned();
  await planPhone.close();
  assert.deepEqual(errors, []);
  console.log("PASS a phone opens the plan from the composer's chip, which keeps its count on the card");

  // a phone reads a pane before it answers: a pane picked from the drawer raises no keyboard,
  // and a tap on the message box does
  const typing = (target: typeof mobilePage) => target.evaluate(() => document.activeElement?.matches("textarea, input, [contenteditable]") ?? false);
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).blur();
  await mobilePage.locator('button[aria-controls="workspace-drawer"]').click();
  await mobilePage.locator(`.pane-select[title^="${paneA} —"]`).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await mobilePage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await mobilePage.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: a picked pane may not take the keyboard
  assert.equal(await typing(mobilePage), false, "a pane picked on a phone does not take the keyboard");
  await mobilePage.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
  await mobilePage.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: switching the lens may not take the keyboard
  assert.equal(await typing(mobilePage), false, "nor does switching its lens");
  await mobilePage.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).tap();
  await until(() => typing(mobilePage), "a tap on the message box takes the keyboard");
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).blur();
  await mobilePage.locator('button[aria-controls="workspace-drawer"]').click();
  assert.equal(await mobilePage.locator(".agents-sidebar .agent-section-toggle").getAttribute("aria-expanded"), "false", "a phone's drawer opens with Agents folded");
  await mobilePage.locator(`.pane-select[title^="${paneB} —"]`).click();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  console.log("PASS a pane picked on a phone waits for a tap before raising the keyboard");

  // Escape with the drawer open closes it and reaches nothing else, wherever the focus is
  await mobilePage.evaluate(() => { (window as unknown as { escapes: number }).escapes = 0; window.addEventListener("keydown", (e) => { if (e.key === "Escape") (window as unknown as { escapes: number }).escapes++; }); });
  await mobilePage.locator('button[aria-controls="workspace-drawer"]').click();
  await mobilePage.locator("#workspace-drawer.is-open").waitFor();
  await mobilePage.getByRole("textbox", { name: "Message", exact: true }).focus();
  await mobilePage.keyboard.press("Escape");
  await mobilePage.locator("#workspace-drawer.is-open").waitFor({ state: "detached" });
  assert.equal(await mobilePage.evaluate(() => (window as unknown as { escapes: number }).escapes), 0, "Escape that closes the drawer does not reach the page");
  console.log("PASS Escape closes a phone's drawer and goes no further");

  // Claude's suggestion on a phone is the placeholder; the chip that fills the box waits until Settings turns it on
  const promptRoute = `**/api/pane/prompt?pane_id=${encodeURIComponent(paneB)}`;
  const suggest = { json: { prompt: null, suggestion: "run the tests" } };
  const mobileComposer = mobilePage.getByRole("textbox", { name: "Message", exact: true });
  await mobilePage.route(promptRoute, (route) => route.fulfill(suggest));
  await mobileComposer.fill("");
  await until(async () => await mobileComposer.getAttribute("placeholder") === "run the tests", "a phone shows the suggestion as the placeholder");
  assert.equal(await mobilePage.locator(".voice-mic").count(), 0, "a phone's chat has no mic until Settings asks for it");
  assert.equal(await mobilePage.getByTitle("Use the suggestion", { exact: true }).count(), 0, "a phone shows no suggestion chip by default");
  await mobilePage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}&settings=chat&section=composer`);
  await mobilePage.getByRole("switch", { name: "Suggestion chip", exact: true }).setChecked(true);
  await mobilePage.getByRole("button", { name: "Close settings", exact: true }).click();
  await mobileComposer.fill("");
  await mobilePage.getByTitle("Use the suggestion", { exact: true }).click();
  assert.equal(await mobileComposer.inputValue(), "run the tests", "the chip puts the suggestion in the box");
  await mobilePage.unroute(promptRoute);
  try { await mobileEvidence?.finish(); } finally { await mobile.close(); }
  assert.equal(errors.length, 0, errors.join("\n"));
  assertCspClean(csp, "the suggestion chip loads with no CSP violation");
  console.log("PASS a phone offers Claude's suggestion as a chip once Settings turns it on");

  await checkTerminalInput(browser, origin, paneA, paneB);
  await checkSafariIme(browser, origin, paneA, paneB);
  await checkIpadIme(browser, origin, paneA, paneB);
  await checkLinuxIme(browser, origin, paneA);
  await checkHeldDraftPaneSwitch(browser, origin, paneA, paneB);

  // the terminal lens on a touch screen starts in direct typing without raising the keyboard;
  // its input line sends whole lines, and there a tapped grid raises no keyboard
  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const touchPage = await touch.newPage();
  const touchEvidence = evidenceDirectory ? await watchBrowserEvidence(touch, touchPage, "touch-terminal-input") : undefined;
  csp.push(await watchCsp(touchPage));
  touchPage.on("pageerror", (error) => errors.push(error.message));
  const touchSent: Array<Record<string, unknown>> = [];
  touchPage.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const message = JSON.parse(String(payload)) as Record<string, unknown>;
    if (message.type === "input" || message.type === "submit") touchSent.push(message);
  }));
  await touchPage.goto(`${origin}/?pane=${encodeURIComponent(paneB)}`);
  await touchPage.locator(".conn-live").waitFor();
  await touchPage.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
  await touchPage.locator("[data-direct-typing]").waitFor();
  assert.equal(await touchPage.locator(".terminal-input").count(), 0, "a phone starts in direct typing");
  assert.equal(await touchPage.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false), false,
    "opening the terminal on a phone does not focus the grid, so the keyboard stays down until a tap");
  // the keyboard key is the input line's switch: lit while the line is shown, unlit in direct typing
  const lineKey = touchPage.getByRole("button", { name: "Input line", exact: true });
  assert.equal(await lineKey.getAttribute("aria-pressed"), "false", "direct typing leaves the input-line key unlit");
  await lineKey.click();
  const line = touchPage.getByRole("textbox", { name: "Terminal input line", exact: true });
  await line.waitFor();
  assert.equal(await lineKey.getAttribute("aria-pressed"), "true", "the shown input line lights its key");
  assert.equal(await touchPage.locator(".xterm-helper-textarea").getAttribute("inputmode"), "none");
  await line.fill("printf 'line-ok\\n'");
  await line.press("Enter");
  await until(() => touchSent.some((message) => message.type === "submit" && message.typed === true), "input line submit");
  const submitted = touchSent.find((message) => message.type === "submit")!;
  assert.equal(submitted.pane_id, paneB);
  assert.equal(submitted.text, "printf 'line-ok\\n'");
  // the line clears once the pane confirmed it
  await until(async () => (await line.inputValue()) === "", "input line cleared after send");
  // an IME's committing Enter (key code 229) stays in the line
  await line.fill("echo 한글");
  const imeSent = touchSent.length;
  await line.dispatchEvent("keydown", IME_ENTER);
  await touchPage.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: an IME Enter may send nothing
  assert.equal(touchSent.length, imeSent);
  assert.equal(await line.inputValue(), "echo 한글");
  await line.dispatchEvent("compositionstart", { data: "" });
  const beforeComposeSend = touchSent.length;
  await touchPage.getByRole("button", { name: "Send to the terminal", exact: true }).click();
  await touchPage.waitForTimeout(NO_SEND_WAIT_MS); // fixed wait: the Send button may send nothing mid-composition
  assert.equal(touchSent.length, beforeComposeSend, "button cannot submit an unfinished composition");
  await line.dispatchEvent("compositionend", { data: "한글" });
  await line.fill("");
  // an empty line's button is Enter alone
  const enters = touchSent.length;
  await touchPage.getByRole("button", { name: "Press Enter in the terminal", exact: true }).click();
  await until(() => touchSent.length > enters && touchSent.at(-1)?.type === "input" && touchSent.at(-1)?.text === "\r", "enter from the empty line");
  await line.fill("unsent 한글 😀");
  // typing straight into the grid is one tap away, and gives the keyboard back to it
  await touchPage.getByRole("button", { name: "Input line", exact: true }).click();
  assert.equal(await touchPage.locator(".terminal-input").count(), 0);
  assert.equal(await touchPage.locator(".xterm-helper-textarea").getAttribute("inputmode"), null);
  await touchPage.getByRole("button", { name: "Input line", exact: true }).click();
  await line.waitFor();
  assert.equal(await line.inputValue(), "unsent 한글 😀", "mode switches preserve the unsent line");
  await touchPage.reload();
  await line.waitFor();
  assert.equal(await line.inputValue(), "unsent 한글 😀", "reload preserves the unsent line");
  await line.fill("");
  assert.equal(await touchPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(errors.length, 0, errors.join("\n"));
  assertCspClean(csp, "touch terminal input loads with no CSP violation");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await touchPage.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-input-mobile.png") });
  }
  if (touchEvidence) await touchEvidence.finish();
  await touch.close();
  console.log("PASS touch terminal input line sends whole lines, Enter alone, and yields to direct typing");

  // A closed pane and an obsolete saved pane both yield to a live pane. Local access
  // is automatic, so it must not offer a sign-out action that cannot lock the app.
  assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
  await page.locator(`.pane-select[title^="${created.pane_id} —"]`).click();
  // closed from the row's menu, which a desktop opens with the context-menu key or a right-click
  // (it draws no row ⋯); the workspace's pane goes with it, so a confirm asks first
  const selectedRow = page.locator(".pane-item.is-selected .pane-select");
  assert.equal(await page.locator(".pane-item.is-selected .row-menu-toggle").isVisible(), false, "a desktop draws no row ⋯");
  await selectedRow.focus();
  await contextMenuKey(page);
  const rowMenu = page.getByRole("menu");
  await rowMenu.waitFor();
  const rowActions = await rowMenu.getByRole("menuitem").allTextContents();
  assert.deepEqual(rowActions, ["Pin workspace", "Rename workspace", "Earlier sessions…", "Close workspace"], "the workspace menu keeps workspace scope");
  // Escape puts the menu away and the focus back on the row
  await page.keyboard.press("Escape");
  await rowMenu.waitFor({ state: "detached" });
  assert.equal(await selectedRow.evaluate((row) => document.activeElement === row), true, "Escape returns focus to the row");
  // A right-click opens the same menu at the pointer without changing the selection.
  await selectedRow.click({ button: "right" });
  await rowMenu.waitFor();
  assert.equal(await page.locator(".pane-item.is-selected .row-menu-toggle").getAttribute("aria-expanded"), "true", "a right-click opens the row's own menu");
  assert.deepEqual(await rowMenu.getByRole("menuitem").allTextContents(), rowActions, "both workspace menu entry points have identical actions and order");
  // the press left the focus on the row; the menu takes it a frame later
  await until(async () => await page.evaluate(() => document.activeElement?.getAttribute("role") === "menuitem"), "the menu takes the focus");
  await page.keyboard.press("Escape");
  await rowMenu.waitFor({ state: "detached" });
  assert.equal(await selectedRow.evaluate((row) => document.activeElement === row), true, "Escape after a right-click returns focus to the row");
  await contextMenuKey(page);
  await rowMenu.getByRole("menuitem", { name: "Close workspace", exact: true }).click();
  const confirmClose = page.getByRole("alertdialog");
  await confirmClose.waitFor();
  await until(async () => await page.evaluate(() => document.activeElement?.textContent === "Cancel"), "the confirm starts on Cancel");
  // a no gives the focus back to the row; Tab stays inside the confirm
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Close", "Tab moves to the confirm's action");
  await page.keyboard.press("Escape");
  await confirmClose.waitFor({ state: "detached" });
  assert.equal(await selectedRow.evaluate((row) => document.activeElement === row), true, "cancelling the confirm returns focus to the row");
  await contextMenuKey(page);
  await rowMenu.getByRole("menuitem", { name: "Close workspace", exact: true }).click();
  await confirmClose.waitFor();
  await confirmClose.getByRole("button", { name: "Close", exact: true }).click();
  workspaces.splice(workspaces.indexOf(created.workspace_id), 1);
  await until(async () => {
    const selected = JSON.parse(await page.evaluate(() => sessionStorage.getItem("ovis:selection") ?? "null"));
    return selected?.pane_id && selected.pane_id !== created.pane_id;
  }, "closed pane selection recovered");
  // the pane selected in its place must not take the keyboard: a phone would raise it over
  // the drawer, in the way of closing the next pane. Its lens follows a frame later.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => document.activeElement?.matches("textarea, input, [contenteditable]") ?? false), false,
    "a pane selected after a close must not focus its input");
  // picking that same pane takes the keyboard, although neither the pane nor its lens changes
  await page.locator(".pane-item.is-selected .pane-select").click();
  await until(async () => await page.evaluate(() => document.activeElement?.matches("textarea, input, [contenteditable]") ?? false),
    "picking the auto-selected pane focuses its input");
  await page.evaluate(() => sessionStorage.setItem("ovis:selection", JSON.stringify({ machine_id: "local", pane_id: "obsolete-pane" })));
  await page.reload();
  await until(async () => {
    const selected = JSON.parse(await page.evaluate(() => sessionStorage.getItem("ovis:selection") ?? "null"));
    return selected?.pane_id && selected.pane_id !== "obsolete-pane";
  }, "obsolete saved selection recovered");
  console.log("PASS closed and obsolete saved panes recover their selection");
  // the desktop page ran past the phone steps above: close it on the same gate
  assertCspClean(csp, "the desktop shell, the file viewer and the pane close load with no CSP violation");
  if (pageEvidence) await pageEvidence.finish();
  await page.close();

  const secured = createServer({ port: 0, hostname: "127.0.0.1", token: "browser-test-token", stateDir: join(root, "secured"), tailscaleOwner: null });
  releases.push(() => secured.stop());
  const securedOrigin = `http://127.0.0.1:${secured.port}`;
  const securedContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Use a new pane so this bridge never competes with the first server's attachments.
  const securedWorkspace = await workspaceCreate({ cwd: root, label: "ovis-test-browser-signout" });
  workspaces.push(securedWorkspace.workspace.workspace_id);
  const securedPage = await securedContext.newPage();
  const securedEvidence = await watchBrowserEvidence(securedContext, securedPage, "token-gate-signout");
  csp.push(await watchCsp(securedPage));
  await securedContext.request.post(`${securedOrigin}/api/auth`, { data: { token: "browser-test-token" } });
  await securedPage.goto(`${securedOrigin}/?pane=${encodeURIComponent(securedWorkspace.root_pane.pane_id)}`);
  await securedPage.getByRole("button", { name: "Command palette", exact: true }).waitFor();
  assert.equal(await securedPage.getByRole("button", { name: "Sign out", exact: true }).count(), 0, "sign out is not in the header");
  await securedPage.keyboard.press("ControlOrMeta+Shift+K");
  await securedPage.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
  assert.equal(await securedPage.getByRole("option", { name: "Sign out", exact: true }).count(), 0, "the palette cannot bypass confirmation");
  // Simulate a late terminal focus change: Escape must still dismiss the modal.
  await securedPage.getByRole("button", { name: "Command palette", exact: true }).focus();
  await securedPage.keyboard.press("Escape");
  await securedPage.getByRole("dialog", { name: "Command palette", exact: true }).waitFor({ state: "hidden" });
  await securedPage.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(securedPage, "Phone & devices");
  const settingsSignOut = securedPage.getByRole("dialog", { name: "Settings", exact: true }).getByRole("button", { name: "Sign out", exact: true });
  const signOutConfirm = securedPage.getByRole("alertdialog", { name: "Sign out of this browser?", exact: true });
  await settingsSignOut.click();
  await signOutConfirm.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await securedContext.request.get(`${securedOrigin}/api/session`)).status(), 200, "cancel keeps the session");
  await settingsSignOut.click();
  // Fail only the sign-out request: health must still see the real authenticated cookie.
  await securedPage.route("**/api/auth", (route) => route.request().method() === "DELETE"
    ? route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "Sign-out test failure" } } })
    : route.continue());
  await signOutConfirm.getByRole("button", { name: "Sign out", exact: true }).click();
  await signOutConfirm.getByRole("alert").waitFor();
  assert.equal(await signOutConfirm.getByRole("button", { name: "Cancel", exact: true }).isEnabled(), true);
  assert.equal(await signOutConfirm.getByRole("button", { name: "Sign out", exact: true }).isEnabled(), true);
  assert.equal((await securedContext.request.get(`${securedOrigin}/api/session`)).status(), 200, "failed sign out keeps the session");
  await securedPage.unroute("**/api/auth");
  await signOutConfirm.getByRole("button", { name: "Sign out", exact: true }).click();
  await securedPage.getByTestId("token-gate").waitFor();
  assert.equal((await securedContext.request.get(`${securedOrigin}/api/session`)).status(), 401);
  const pairing = await securedContext.request.post(`${securedOrigin}/api/devices/pair/start`, { headers: { authorization: "Bearer browser-test-token", "x-herdr-machine": "1" } });
  const { code } = await pairing.json();
  await securedContext.request.post(`${securedOrigin}/api/devices/pair`, { data: { code, label: "Browser test device" } });
  await securedPage.setViewportSize({ width: 390, height: 844 });
  await securedPage.reload();
  await securedPage.locator(".app-header.is-zoned").waitFor();
  await securedPage.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(securedPage, "Phone & devices");
  await settingsSignOut.click();
  await signOutConfirm.getByRole("button", { name: "Sign out", exact: true }).click();
  await securedPage.getByTestId("token-gate").waitFor();
  assert.equal((await securedContext.request.get(`${securedOrigin}/api/session`)).status(), 401);
  if (securedEvidence) await securedEvidence.finish();
  await securedContext.close();
  assertCspClean(csp, "the token gate loads with no CSP violation");
  console.log("PASS Settings sign out: cancel preserves access, failure permits retry, token and paired-device sign out return to the access gate");

  await checkRelayPanel(browser);
} catch (error) {
  for (const evidence of evidenceSessions) {
    if (evidence.isOpen()) await evidence.captureFailure(error);
  }
  throw error;
} finally {
  for (const evidence of evidenceSessions) await evidence.finish();
  for (const release of releases) release();
  await browser?.close();
  server?.stop();
  // a worktree checkout the run made goes with it: herdr removes the checkout, then its workspace.
  // The roster says what was made, so a create whose answer never arrived is removed too.
  if (repo) {
    const repoRoot = realpathSync(repo);
    const snapshot = await sessionSnapshot().catch(() => null);
    for (const workspace of snapshot?.workspaces ?? []) {
      if (workspace.worktree?.is_linked_worktree && workspace.worktree.repo_root === repoRoot && !worktreeWorkspaces.includes(workspace.workspace_id)) worktreeWorkspaces.push(workspace.workspace_id);
    }
  }
  for (const id of worktreeWorkspaces) {
    await herdrRpc("worktree.remove", { workspace_id: id, force: true }).catch(() => undefined);
    await workspaceClose(id).catch(() => undefined);
  }
  // herdr keeps the repository's folder under its worktree directory once the checkout is gone: only an empty one is ours to drop
  if (repo) try { rmdirSync(join(homedir(), ".herdr", "worktrees", basename(repo))); } catch { /* not there, or not empty: not ours */ }
  for (const id of workspaces) await workspaceClose(id);
  rmSync(root, { recursive: true, force: true });
}
