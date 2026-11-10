/** Connection-owned pending messages survive navigation, but never a lost connection. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type WebSocket as BrowserSocket, type WebSocketRoute } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneSplit, tabCreate, tabRename, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import type { ClientMessage, PendingMessage, ServerMessage } from "../shared/protocol.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-pending-switch-")));
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await Bun.sleep(25);
  }
}
const paste = (text: string) => `\u001b[200~${text}\u001b[201~\r`;
try {
  const owner = await workspaceCreate({ cwd: root, label: "ovis-test-pending-owner" });
  workspaces.push(owner.workspace.workspace_id);
  const away = await workspaceCreate({ cwd: root, label: "ovis-test-pending-away" });
  workspaces.push(away.workspace.workspace_id);
  const pane = owner.root_pane.pane_id;
  await tabRename(owner.root_pane.tab_id, "Pending owner");
  const tab = await tabCreate({ workspaceId: owner.workspace.workspace_id, label: "Other tab" });
  const program = join(root, "claude");
  const script = join(root, "record.cjs");
  const log = join(root, "input.jsonl");
  copyFileSync(process.execPath, program); chmodSync(program, 0o755);
  writeFileSync(script, `const fs=require("node:fs");const out=process.argv[2];process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write("\\x1b[?2004h\\n› Message\\n",()=>fs.writeFileSync(out,""));process.stdin.on("data",c=>fs.appendFileSync(out,JSON.stringify(c.toString("utf8"))+"\\n"));`);
  await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${program}' '${script}' '${log}'\n` });
  await until(() => existsSync(log), "the owned foreground agent records input");
  const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
  // An explicit observation interval, bounded and checked throughout, proves a negative:
  // no automatic delivery is permitted after the pane's native status becomes ready.
  const noBytes = async (expected: string, label: string): Promise<void> => {
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) { assert.equal(bytes(), expected, label); await Bun.sleep(25); }
    assert.equal(bytes(), expected, label);
  };
  await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "working" });
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false })));
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent: Array<{ socket: BrowserSocket; frame: ClientMessage }> = [];
  const received: Array<{ socket: BrowserSocket; frame: ServerMessage }> = [];
  const sockets: BrowserSocket[] = [];
  const ready = new Map<string, BrowserSocket>();
  const statuses = new Map<string, string>();
  let admit = true;
  let routed: WebSocketRoute | undefined;
  let holdDiscard = false, delayedDiscard: (() => void) | undefined;
  // a Send now that left the page but whose fate the page never learns
  let swallowResend = false, swallowedResend = false;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    if (!admit) { void socket.close(); return; }
    const upstream = socket.connectToServer(); routed = socket;
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data)) as ClientMessage;
      if (holdDiscard && frame.type === "pending-action" && frame.action === "discard") {
        delayedDiscard = () => upstream.send(data);
      } else if (swallowResend && frame.type === "submit" && frame.resend_id !== undefined) {
        swallowedResend = true;
      } else upstream.send(data);
    });
  });
  page.on("websocket", (socket) => {
    sockets.push(socket);
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as ClientMessage;
      sent.push({ socket, frame });
      if (frame.type === "attach" || frame.type === "detach") ready.delete(frame.pane_id);
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload)) as ServerMessage;
      received.push({ socket, frame });
      if (frame.type === "snapshot") for (const item of frame.snapshot.panes) statuses.set(item.pane_id, item.agent_status);
      if (frame.type === "pane-status") statuses.set(frame.pane_id, frame.agent_status);
      if (frame.type === "input-ready") {
        if (frame.ready !== false) ready.set(frame.pane_id, socket); else ready.delete(frame.pane_id);
      }
    });
  });
  const frame = (id: string) => page.locator(`[data-layout-pane=${JSON.stringify(id)}]`);
  const current = (id: string) => frame(id).and(page.locator(".is-current"));
  const composer = () => current(pane).getByRole("textbox", { name: "Message", exact: true });
  const rows = () => current(pane).locator(".pending-message");
  const inputReady = (id: string) => until(() => {
    const connection = ready.get(id);
    return !!connection && !connection.isClosed();
  }, `${id} has its live input lease`);
  const selectWorkspace = async (id: string, selectedPane: string): Promise<void> => {
    await page.locator(`.workspace-group[data-workspace=${JSON.stringify(id)}] .pane-select`).click();
    await current(selectedPane).waitFor();
    await inputReady(selectedPane);
  };
  const report = async (state: "working" | "idle"): Promise<void> => {
    await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await until(() => state === "idle" ? ["idle", "done"].includes(statuses.get(pane) ?? "") : statuses.get(pane) === state, `the bridge reports ${state}`);
  };
  const queue = async (text: string, state = "queued"): Promise<PendingMessage> => {
    await current(pane).locator('.composer-status[data-status="working"]').waitFor();
    await inputReady(pane);
    const after = received.length;
    await composer().fill(text);
    await current(pane).getByRole("button", { name: "Send message", exact: true }).click();
    await until(() => received.slice(after).some(({ frame }) => frame.type === "submit-result" && frame.pane_id === pane && frame.ok && frame.pending?.text === text), "the server accepts one pending ID");
    const result = received.slice(after).find(({ frame }) => frame.type === "submit-result" && frame.pane_id === pane && frame.pending?.text === text)!.frame;
    assert.ok(result.type === "submit-result" && result.pending);
    await rows().filter({ hasText: text }).waitFor();
    assert.equal(await rows().filter({ hasText: text }).getAttribute("data-state"), state);
    return result.pending;
  };
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await current(pane).waitFor(); await inputReady(pane);
  const originalSocket = ready.get(pane)!;
  assert.equal(sockets.length, 1, "one PC uses one terminal connection");
  const capture = async (name: string): Promise<void> => {
    if (!process.env.UI_EVIDENCE_DIR) return;
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await current(pane).screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${name}.png`) });
  };
  let delivered = "";
  const automatic = async (enabled: boolean): Promise<void> => {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    await page.getByRole("switch", { name: "Send queued messages automatically", exact: true }).setChecked(enabled);
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  for (const destination of ["tab", "workspace"] as const) {
    await report("working");
    const pending = await queue(`automatic across ${destination}`);
    await capture(`queued-before-${destination}`);
    const sentAt = sent.length;
    if (destination === "tab") {
      await page.getByRole("tab", { name: "Other tab", exact: true }).click();
      await current(tab.root_pane.pane_id).waitFor(); await inputReady(tab.root_pane.pane_id);
    } else await selectWorkspace(away.workspace.workspace_id, away.root_pane.pane_id);
    assert.equal(originalSocket.isClosed(), false, "navigation keeps the original connection");
    assert.equal(sockets.length, 1, "navigation shares one PC connection");
    await report("idle");
    delivered += paste(pending.text);
    await until(() => bytes() === delivered, "the original pane receives its queued message while another pane is selected");
    assert.equal(sent.slice(sentAt).some(({ frame }) => frame.type === "pending-action" || frame.type === "submit"), false, "automatic delivery needs no browser replay or Send now");
    await report("working"); await report("idle");
    await noBytes(delivered, "a later turn never duplicates automatic delivery");
    await until(() => !ready.has(pane), "the outgoing pane releases its input lease after its queue settles");
    if (destination === "workspace") await selectWorkspace(owner.workspace.workspace_id, pane);
    else {
      await page.getByRole("tab", { name: "Pending owner", exact: true }).click();
      await current(pane).waitFor(); await inputReady(pane);
    }
    assert.equal(await rows().filter({ hasText: pending.text }).count(), 0, "the sent message is removed on return");
    await capture(`delivered-after-${destination}`);
  }
  console.log("PASS tab and workspace switches deliver queued messages once to the original pane without browser replay");

  await automatic(false);
  {
    await report("working");
    const first = await queue("edit this exact row", "held");
    const other = await queue("leave this other row", "held");
    await composer().fill("@/tmp/attachment.png existing draft");
    const actionAt = sent.length;
    const row = rows().filter({ hasText: first.text });
    await row.getByRole("button", { name: /^Edit queued message:/ }).click();
    await row.waitFor({ state: "detached" });
    await until(async () => await composer().inputValue() === "@/tmp/attachment.png existing draft\n\nedit this exact row", "Edit joins the existing draft");
    assert.equal(await composer().evaluate((element) => element === document.activeElement), true, "Edit restores composer focus");
    assert.equal(await rows().filter({ hasText: other.text }).count(), 1, "Edit keeps other queued IDs");
    const actions = sent.slice(actionAt).filter(({ frame }) => frame.type === "pending-action");
    assert.deepEqual(actions.map(({ frame }) => frame.type === "pending-action" ? [frame.pending_id, frame.action] : []), [[first.id, "discard"]]);
    await report("idle");
    await noBytes(delivered, "Edit never sends or replays the withdrawn row");
    await rows().filter({ hasText: other.text }).getByRole("button", { name: "Discard", exact: true }).click();
    await composer().fill("");
  }
  console.log("PASS Edit withdraws one exact ID, preserves the existing draft and other rows, focuses composer and types nothing");
  for (const destination of ["tab", "workspace"] as const) {
    await report("working");
    const pending = await queue(`pending across ${destination}`, "held");
    const sentAt = sent.length;
    if (destination === "tab") {
      await page.getByRole("tab", { name: "Other tab", exact: true }).click();
      await current(tab.root_pane.pane_id).waitFor();
      await inputReady(tab.root_pane.pane_id);
    } else await selectWorkspace(away.workspace.workspace_id, away.root_pane.pane_id);
    assert.ok(sent.slice(sentAt).some(({ socket, frame }) => socket === originalSocket && frame.type === "detach" && frame.pane_id === pane), "navigation gives up the old pane's input lease");
    assert.equal(originalSocket.isClosed(), false, "navigation keeps the receipt-owning connection alive");
    assert.equal(sockets.length, 1, "changing tabs and workspaces does not open another PC connection");
    await report("idle");
    await noBytes(delivered, "a ready agent cannot auto-send a held message while away");
    if (destination === "workspace") await selectWorkspace(owner.workspace.workspace_id, pane);
    else {
      await page.getByRole("tab", { name: "Pending owner", exact: true }).click();
      await current(pane).waitFor(); await inputReady(pane);
    }
    const row = rows().filter({ hasText: pending.text });
    await until(async () => await row.getAttribute("data-state") === "held", "the pending row returns as held, not uncertain");
    assert.equal(await row.getByRole("button", { name: /^Send now:/ }).isEnabled(), true);
    await noBytes(delivered, "returning to a ready agent does not resume automatic delivery");
    const actionAt = sent.length;
    await row.getByRole("button", { name: /^Send now:/ }).click();
    delivered += paste(pending.text);
    await until(() => bytes() === delivered, "Send now delivers the same pending ID exactly once");
    await row.waitFor({ state: "detached" });
    const actions = sent.slice(actionAt).filter(({ frame }) => frame.type === "pending-action");
    assert.equal(actions.length, 1);
    assert.deepEqual(actions.map(({ frame }) => frame.type === "pending-action" ? [frame.pane_id, frame.pending_id, frame.action] : []), [[pane, pending.id, "steer"]]);
    await report("working"); await report("idle");
    await noBytes(delivered, "a later ready turn never replays the completed pending ID");
  }
  console.log("PASS tab and workspace navigation retain pending ownership, release the old lease and permit one explicit Send now");
  await automatic(true);
  {
    await report("working");
    const pending = await queue("delivery wins edit race");
    await composer().fill("keep this draft");
    holdDiscard = true;
    const resultAt = received.length;
    await rows().filter({ hasText: pending.text }).getByRole("button", { name: /^Edit queued message:/ }).click();
    await until(() => delayedDiscard !== undefined, "the Edit withdrawal waits at the transport boundary");
    await report("idle");
    delivered += paste(pending.text);
    await until(() => bytes() === delivered, "automatic delivery wins before withdrawal");
    await rows().filter({ hasText: pending.text }).waitFor({ state: "detached" });
    holdDiscard = false; delayedDiscard!(); delayedDiscard = undefined;
    await until(() => received.slice(resultAt).some(({ frame }) => frame.type === "pending-result" && frame.pending_id === pending.id), "the raced withdrawal settles");
    assert.equal(await composer().inputValue(), "keep this draft", "a replayed sent receipt cannot restore delivered text");
    await composer().fill("");
  }
  console.log("PASS delivery winning the Edit race does not duplicate its text in the draft");

  // A held terminal draft blocks Send now on a server-owned row: the server pastes the text and
  // sends Enter, so keys left in the draft (or a partial line in the pty) would run with it.
  {
    await report("working");
    const pending = await queue("never beside a held draft");
    // the lens buttons' titles name the shortcut as the platform writes it (⌘⇧J on a Mac, Ctrl+Shift+J elsewhere)
    const toggle = (title: RegExp) => page.getByTitle(title).click();
    // keys typed while the terminal is not ready for input are held as a draft
    routed!.send(JSON.stringify({ type: "input-ready", pane_id: pane, ready: false }));
    await toggle(/^Live terminal \(.+\)$/);
    const waiting = current(pane).locator(".terminal-banner", { hasText: "Waiting for terminal input…" });
    await waiting.waitFor();
    await current(pane).locator(".xterm-helper-textarea").pressSequentially("abc");
    await until(async () => await current(pane).locator(".draft-text").textContent() === "abc", "the typing is held as a draft");
    // ready again: the draft still waits for Send or Discard
    routed!.send(JSON.stringify({ type: "input-ready", pane_id: pane, ready: true }));
    await waiting.waitFor({ state: "hidden" });
    await toggle(/^Chat transcript \(.+\)$/);
    const row = rows().filter({ hasText: pending.text });
    const actionAt = sent.length;
    await row.getByRole("button", { name: /^Send now:/ }).click();
    await row.locator(".pending-message-note", { hasText: "Not sent: send or discard the held input first." }).waitFor();
    assert.equal(sent.slice(actionAt).some(({ frame }) => frame.type === "pending-action"), false, "Send now beside a held draft sends no pending action");
    await noBytes(delivered, "Send now beside a held draft types nothing");
    // the message box is refused beside a held draft too: its Enter would run the pty's partial line
    const heldNote = "Not sent: send or discard the held input first.";
    const submitAt = sent.length;
    await composer().fill("ls");
    await current(pane).getByRole("button", { name: "Send message", exact: true }).click();
    await until(async () => await current(pane).getByText(heldNote, { exact: true }).count() >= 2, "the message box says the held draft comes first");
    assert.equal(sent.slice(submitAt).some(({ frame }) => frame.type === "submit"), false, "a message box send beside a held draft sends no submit");
    assert.equal(await composer().inputValue(), "ls", "a refused message keeps its text");
    await composer().fill("");
    await noBytes(delivered, "a message box send beside a held draft types nothing");
    // the row is not marked unconfirmed: once the draft is discarded, Send now delivers it
    await toggle(/^Live terminal \(.+\)$/);
    await current(pane).locator(".draft-discard").click();
    await current(pane).locator(".terminal-banner-draft").waitFor({ state: "detached" });
    await toggle(/^Chat transcript \(.+\)$/);
    await row.getByRole("button", { name: /^Send now:/ }).click();
    delivered += paste(pending.text);
    await until(() => bytes() === delivered, "Send now after the draft is discarded delivers the message once");
    await row.waitFor({ state: "detached" });
    await report("idle");
  }
  console.log("PASS a held terminal draft refuses Send now on a server-owned row until it is settled");

  // Visible split siblings keep their leases. They still share the same PC connection;
  // neither the other pane's input-ready nor its output can advance this agent's queue.
  const sibling = await paneSplit(pane, "right", false);
  await frame(sibling.pane_id).waitFor(); await inputReady(sibling.pane_id);
  assert.equal(ready.get(sibling.pane_id), originalSocket, "split panes share their PC connection");
  await report("working");
  const splitPending = await queue("pending while a sibling is selected");
  const splitSent = sent.length;
  await frame(sibling.pane_id).locator(".pane-frame-title").click();
  await current(sibling.pane_id).waitFor();
  assert.equal(sent.slice(splitSent).some(({ frame }) => frame.type === "detach" && frame.pane_id === pane), false, "selecting another visible split keeps the original pane attached");
  assert.equal(sockets.length, 1, "two visible panes use one PC connection");
  assert.equal(await current(sibling.pane_id).locator(".pending-message").count(), 0, "a sibling never shows the owner's pending message");
  await frame(pane).locator(".pane-frame-title").click(); await current(pane).waitFor();
  const splitRow = rows().filter({ hasText: splitPending.text });
  assert.equal(await splitRow.getAttribute("data-state"), "queued");
  await splitRow.getByRole("button", { name: "Discard", exact: true }).click();
  await splitRow.waitFor({ state: "detached" });
  assert.equal(bytes(), delivered);

  // A real lost WebSocket is different from component navigation: ownership ends. Only the bridge's
  // receipt that it holds the message untyped, for this browser, brings the copy back, held for an
  // explicit Send now; nothing is ever sent without one.
  const lostConnection = async (): Promise<void> => {
    admit = false; await routed!.close();
    await page.locator(".conn-live").waitFor({ state: "hidden" });
    admit = true;
    await page.locator(".conn-live").waitFor(); await inputReady(pane);
  };
  const reload = async (): Promise<void> => {
    await page.reload(); await page.locator(".conn-live").waitFor(); await current(pane).waitFor(); await inputReady(pane);
  };
  const heldReceipt = (id: string, since: number): boolean => received.slice(since).some(({ frame }) =>
    frame.type === "pending-messages" && frame.pane_id === pane && frame.held?.includes(id) === true);
  const provenHeld = async (pending: PendingMessage, since: number, label: string): Promise<void> => {
    const text = pending.text;
    const row = rows().filter({ hasText: text });
    await until(async () => await row.getAttribute("data-state") === "held", `${label}: the bridge's held receipt brings the copy back held`);
    assert.equal(heldReceipt(pending.id, since), true, `${label}: the copy is held on the bridge's receipt for its exact ID, not on a saved state`);
    assert.equal(await row.locator(".pending-message-send").count(), 1, `${label}: a proven held copy offers Send now`);
    await report("idle"); await noBytes(delivered, `${label}: readiness never sends a held copy without Send now`);
    await row.getByRole("button", { name: /^Send now:/ }).click();
    delivered += paste(text);
    await until(() => bytes() === delivered, `${label}: Send now delivers the held copy once`);
    await row.waitFor({ state: "detached" });
    await noBytes(delivered, `${label}: Send now delivers the held copy once`);
    await report("working");
  };
  const unproven = async (text: string, label: string): Promise<void> => {
    const row = rows().filter({ hasText: text });
    await row.waitFor();
    // checked again after readiness, so a held receipt arriving late would be caught too
    assert.equal(await row.getAttribute("data-state"), "uncertain", `${label}: an unproven copy stays uncertain`);
    assert.equal(await row.locator(".pending-message-send").count(), 0, `${label}: an unproven copy never offers Send now`);
    await report("idle"); await noBytes(delivered, `${label}: readiness never replays an unproven copy`);
    assert.equal(await row.getAttribute("data-state"), "uncertain", `${label}: an unproven copy stays uncertain`);
    assert.equal(await row.locator(".pending-message-send").count(), 0, `${label}: an unproven copy never offers Send now`);
    await row.getByRole("button", { name: "Discard saved copy", exact: true }).click();
    await row.waitFor({ state: "detached" });
    await report("working");
  };

  const disconnected = await queue("held after a lost connection");
  let since = received.length;
  await lostConnection();
  await provenHeld(disconnected, since, "lost connection");

  const reloaded = await queue("held after reload");
  since = received.length;
  await reload();
  await provenHeld(reloaded, since, "reload");

  // (a) another browser session: its saved copy, but none of this browser's receipts
  const otherBrowser = await queue("unproven in another browser session");
  await page.evaluate(() => localStorage.setItem("ovis:pi-receipt-resume", crypto.randomUUID()));
  await reload();
  await unproven(otherBrowser.text, "another browser session");

  // (d) a copy proven held on this page proves nothing to another browser session: the proof is never saved
  const provenThenMoved = await queue("proven here, unproven in another browser session");
  await lostConnection();
  await until(async () => await rows().filter({ hasText: provenThenMoved.text }).getAttribute("data-state") === "held", "the copy is proven held on this page first");
  await page.evaluate(() => localStorage.setItem("ovis:pi-receipt-resume", crypto.randomUUID()));
  await reload();
  await unproven(provenThenMoved.text, "proven on another page");

  // (b) past the ten minutes the bridge keeps a held receipt. A witness tab with this browser's resume
  // ID but storage of its own is told the receipt once the bridge kept it: only then does the clock move.
  const expired = await queue("unproven after the receipt expired");
  const resumeId = await page.evaluate(() => localStorage.getItem("ovis:pi-receipt-resume"));
  assert.ok(resumeId, "this browser has a resume ID");
  const witness = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await witness.addInitScript((id) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", alertsOn: false }));
    localStorage.setItem("ovis:pi-receipt-resume", id);
  }, resumeId);
  const witnessPage = await witness.newPage();
  let witnessAttached = false, witnessTold = false;
  witnessPage.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
    const message = JSON.parse(String(payload)) as ServerMessage;
    if (message.type === "input-ready" && message.pane_id === pane) witnessAttached = true;
    if (message.type === "pending-messages" && message.pane_id === pane && message.held?.includes(expired.id)) witnessTold = true;
  }));
  await witnessPage.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await until(() => witnessAttached, "the witness tab attached the pane");
  admit = false; await routed!.close();
  await page.locator(".conn-live").waitFor({ state: "hidden" });
  await until(() => witnessTold, "the bridge kept the held receipt as the connection closed");
  await witness.close();
  // the bridge times its receipts by the time that passed (a clock that only moves forward), not by the PC's clock:
  // both move here, as when ten minutes really pass
  const ambient = Date.now, running = performance.now.bind(performance);
  try {
    Date.now = () => ambient() + 10 * 60 * 1000 + 1000;
    performance.now = () => running() + 10 * 60 * 1000 + 1000;
    admit = true;
    await page.locator(".conn-live").waitFor(); await inputReady(pane);
    await unproven(expired.text, "expired receipt");
  } finally { Date.now = ambient; performance.now = running; }

  // (c) an ambiguous send: Send now left the page and the connection dropped before any answer
  const ambiguous = await queue("unproven after an ambiguous send");
  await lostConnection();
  const ambiguousRow = rows().filter({ hasText: ambiguous.text });
  await until(async () => await ambiguousRow.getAttribute("data-state") === "held", "the ambiguous case starts from a proven held copy");
  swallowResend = true;
  await ambiguousRow.getByRole("button", { name: /^Send now:/ }).click();
  await until(() => swallowedResend, "the Send now left the page");
  await lostConnection();
  swallowResend = false;
  await unproven(ambiguous.text, "ambiguous send");

  // (e) a page left open past the bridge's receipt window: its proven copy is uncertain again. The page's clock moves
  // (a tab that slept, or a clock that jumped): no timer has to fire, the next render reads the row past its time.
  const leftOpen = await queue("held, then the page stays open past its window");
  since = received.length;
  await lostConnection();
  const openRow = rows().filter({ hasText: leftOpen.text });
  await until(async () => await openRow.getAttribute("data-state") === "held", "the copy is proven held while the page is open");
  assert.equal(heldReceipt(leftOpen.id, since), true, "held on the bridge's receipt");
  assert.equal(await openRow.locator(".pending-message-send").count(), 1, "a proven copy offers Send now within its window");
  await page.clock.setSystemTime(await page.evaluate(() => Date.now()) + 10 * 60 * 1000 + 1000);
  await report("idle");
  await until(async () => await openRow.getAttribute("data-state") === "uncertain", "past the bridge's window the page's proof has ended");
  await unproven(leftOpen.text, "a page left open past the window");

  await report("idle"); await noBytes(delivered, "no unproven copy was ever typed");
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS split panes share one connection; a proven held copy comes back held for an explicit Send now, and every unproven copy stays uncertain without automatic or explicit replay");
} finally {
  await browser?.close(); server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace).catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
