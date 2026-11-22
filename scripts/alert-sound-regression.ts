import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errors as browserErrors, type Browser, type Page } from "playwright-core";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";
// machine events stay on SSE here: the page watches its status events on /api/machines/events
// (the socket transport has its own checks), also when this script runs on its own
process.env["OVIS_MACHINE_EVENTS_WS"] = "0";

/**
 * The alert sound: real herdr status changes make the open tab chime, once a tap let the page
 * play audio, and never for the pane already open. The page's AudioContext is a recorder that
 * starts suspended like a real one, so what would have sounded is the notes it was asked for.
 */
export async function checkAlertSound(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-alert-sound-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const suffix of ["open", "other", "third"]) {
      const cwd = join(root, suffix);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `ovis-test-sound-${suffix}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [openPane, otherPane, thirdPane] = panes as [string, string, string];
    const report = (pane: string, state: string) => herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state });
    await report(openPane, "idle");
    await report(otherPane, "idle");
    await report(thirdPane, "idle");

    await context.addInitScript(() => {
      if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertDone: "off", alertSound: true }));
      const notes: number[] = [];
      const recorded = window as unknown as { chimes: number[]; chimeEnd: number };
      recorded.chimes = notes;
      recorded.chimeEnd = 0;
      class RecordingAudioContext {
        state = "suspended";
        // a real context's clock runs on its own: the app tells a chime still sounding by it
        get currentTime() { return performance.now() / 1000; }
        destination = {};
        async resume() { this.state = "running"; }
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node }; }
        createOscillator() {
          const oscillator = {
            type: "", frequency: { value: 0 }, connect: (node: unknown) => node,
            start() { notes.push(oscillator.frequency.value); },
            stop(at: number) { recorded.chimeEnd = Math.max(recorded.chimeEnd, at); },
          };
          return oscillator;
        }
      }
      Object.assign(window, { AudioContext: RecordingAudioContext });
      const post = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (message: unknown) {
        if ((window as unknown as { slowChimed?: boolean }).slowChimed && (message as { type?: string } | null)?.type === "chimed") {
          setTimeout(() => post.call(this, message), 1_000);
          return;
        }
        post.call(this, message);
      };
      // A visible working badge can come from a roster snapshot before the collector has
      // subscribed to these newly created panes. Observe a real status event before testing alerts.
      const statuses: Record<string, string> = {};
      const NativeEvents = window.EventSource;
      type Roster = { type: string; machines: { id: string; snapshot: { panes: { pane_id: string; agent_status: string }[] } | null }[] };
      class ObservedEvents extends NativeEvents {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          let handler: ((event: MessageEvent) => void) | null = null;
          Object.defineProperty(this, "onmessage", { get: () => handler, set: (next) => { handler = next; } });
          let roster: Roster | null = null;
          this.addEventListener("message", (event) => {
            const payload = JSON.parse(event.data);
            if (payload.type === "machines") roster = payload;
            const message = payload.message;
            if (message?.type === "pane-status") {
              statuses[message.pane_id] = message.agent_status;
              // The server reads the roster from herdr on its own, and now and then one shows a
              // status before the event that tells of it arrives. `rosterFirst` makes it every time.
              if ((window as unknown as { rosterFirst?: boolean }).rosterFirst && roster) {
                const ahead: Roster = { ...roster, machines: roster.machines.map((machine) => machine.id !== payload.machine_id || !machine.snapshot ? machine : { ...machine, snapshot: { ...machine.snapshot, panes: machine.snapshot.panes.map((pane) => pane.pane_id === message.pane_id ? { ...pane, agent_status: message.agent_status } : pane) } }) };
                handler?.call(this, new MessageEvent("message", { data: JSON.stringify(ahead) }));
              }
            }
            handler?.call(this, event);
          });
        }
      }
      Object.assign(window, { EventSource: ObservedEvents, soundStatuses: statuses });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
    await page.locator(".conn-live").waitFor();
    const chimes = (tab: Page = page) => tab.evaluate(() => [...(window as unknown as { chimes: number[] }).chimes]);
    const seen = (pane: string, status: string, tab: Page = page) => tab.locator(`.pane-item:has(.pane-select[title^="${pane} —"]) [data-status="${status}"]`).first().waitFor({ state: "attached" });
    const quiet = (tab: Page) => tab.waitForFunction(() => performance.now() / 1000 >= (window as unknown as { chimeEnd: number }).chimeEnd);
    // The card for a waiting pane leaves by itself after a few seconds, so nothing is awaited
    // between the report and the wait for the card. Only the pane in front, which gets no card,
    // is followed to `blocked` in the sidebar.
    const block = async (pane: string, inFront = false) => {
      await report(pane, "working");
      await seen(pane, "working");
      await report(pane, "blocked");
      if (inFront) await seen(pane, "blocked");
    };

    // The collector reopens its subscriptions after the pane set changes. Prime only owned
    // fixture statuses until working arrives as an event, not merely in a polled snapshot.
    // Each attempt waits (bounded) for its own event before reporting again, so setup does not
    // flood the subscription it is priming.
    for (const deadline = Date.now() + 10_000; !(await page.evaluate((pane) =>
      (window as unknown as { soundStatuses: Record<string, string> }).soundStatuses[pane] === "working", otherPane));) {
      assert.ok(Date.now() < deadline, "the status subscription includes the new panes");
      await report(otherPane, "idle");
      const received = page.waitForFunction((pane) =>
        (window as unknown as { soundStatuses: Record<string, string> }).soundStatuses[pane] === "working",
      otherPane, { timeout: Math.max(1, Math.min(1_000, deadline - Date.now())) }).catch((error) => {
        if (!(error instanceof browserErrors.TimeoutError)) throw error;
      });
      await report(otherPane, "working");
      await received;
    }
    // no tap yet: the page may not play, and nothing is kept to sound later
    await block(otherPane);
    await page.locator(".droplet-card").waitFor({ state: "visible" });
    assert.deepEqual(await chimes(), [], "no chime before a gesture");
    console.log("PASS no alert sound before the page was tapped");

    await page.locator(".droplet-card").click();
    await page.locator(".droplet").waitFor({ state: "detached" });
    await report(otherPane, "idle");
    await report(openPane, "idle");
    await block(otherPane, true);
    await block(openPane);
    // the pane in front was seen waiting before the other was reported, and the card drops in
    // with the chime: by the time the card for the pane behind shows, a chime for the pane in
    // front would have sounded already
    await page.locator(".droplet-card").waitFor({ state: "visible" });
    await page.waitForFunction(() => (window as unknown as { chimes: number[] }).chimes.length >= 2);
    assert.deepEqual(await chimes(), [660, 880], "one rising chime, for the pane not in front");
    console.log("PASS a pane that waits chimes, the one in front does not");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await openSettingsPage(page, "Alerts");
    const sound = page.getByRole("switch", { name: "Play sounds", exact: true });
    await sound.click();
    assert.equal(await sound.getAttribute("aria-checked"), "false");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:settings") ?? "{}").alertSound), false);
    await sound.click();
    await page.waitForFunction(() => (window as unknown as { chimes: number[] }).chimes.length >= 4);
    assert.deepEqual((await chimes()).slice(2), [880, 660], "turning it on plays a preview");
    await sound.scrollIntoViewIfNeeded();
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "alert-sound-settings.png") });
    console.log("PASS Settings turns the alert sound off and on, with a preview");
    await page.keyboard.press("Escape");
    await page.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });

    await quiet(page);
    const before = (await chimes()).length;
    await report(openPane, "idle");
    for (const pane of [openPane, thirdPane]) {
      await report(pane, "working");
      await seen(pane, "working");
    }
    await Promise.all([report(openPane, "blocked"), report(thirdPane, "blocked")]);
    for (const pane of [openPane, thirdPane]) await seen(pane, "blocked");
    // the chime for the two is asked for, and then it has ended: a second one, for the other
    // pane, would have been asked for while the first still sounded
    await page.waitForFunction((count) => (window as unknown as { chimes: number[] }).chimes.length >= count + 2, before);
    await quiet(page);
    assert.deepEqual((await chimes()).slice(before), [660, 880], "one chime for two panes that wait together");
    console.log("PASS two panes that wait together chime once");

    await quiet(page);
    await report(thirdPane, "idle");
    // at rest again, as the app heard it (a finish after work is told as `done`)
    await page.waitForFunction((pane) => !["working", "blocked"].includes((window as unknown as { soundStatuses: Record<string, string> }).soundStatuses[pane]!), thirdPane);
    const told = (await chimes()).length;
    await page.evaluate(() => { (window as unknown as { rosterFirst: boolean }).rosterFirst = true; });
    await block(thirdPane);
    await page.waitForFunction((count) => (window as unknown as { chimes: number[] }).chimes.length >= count + 2, told);
    assert.deepEqual((await chimes()).slice(told), [660, 880], "a wait the roster showed first still chimes");
    await page.evaluate(() => { (window as unknown as { rosterFirst: boolean }).rosterFirst = false; });
    console.log("PASS a wait the roster showed before its event still chimes");

    // Both pages share the origin and BroadcastChannel, not just the same browser process.
    const second = await context.newPage();
    second.on("pageerror", (error) => errors.push(error.message));
    await second.goto(`${origin}/?pane=${encodeURIComponent(openPane)}`);
    await second.locator(".conn-live").waitFor();
    // A header gesture unlocks audio without typing into any terminal.
    await second.getByRole("button", { name: "Settings", exact: true }).click();
    await second.keyboard.press("Escape");
    await second.getByRole("dialog", { name: "Settings" }).waitFor({ state: "detached" });
    const tabs = [page, second];
    const counts = () => Promise.all(tabs.map(async (tab) => (await chimes(tab)).length));
    const heard = async () => (await counts()).reduce((sum, count) => sum + count, 0);
    // Check continuously through the safety-net deadline, not just at the first note.
    // Time is the behaviour here: a duplicate must not arrive later in this turn.
    const noSecondChime = async (beforeCounts: number[]) => {
      await Promise.all(tabs.map(async (tab, index) => {
        const expected = (await chimes(tab)).length;
        assert.ok(expected <= beforeCounts[index]! + 2, "at most one new chime per tab");
        const deadline = await tab.evaluate(() => performance.now() + 1_200);
        await tab.waitForFunction(({ expected, deadline }) => {
          const recording = window as unknown as { chimes: number[]; chimeEnd: number };
          if (recording.chimes.length > expected) throw new Error("a second chime arrived");
          return performance.now() >= deadline && performance.now() / 1000 >= recording.chimeEnd;
        }, { expected, deadline }, { timeout: 5_000 });
      }));
    };
    await Promise.all(tabs.map(quiet));
    await report(thirdPane, "working");
    await Promise.all(tabs.map((tab) => seen(thirdPane, "working", tab)));
    const bothBefore = await counts();
    await report(thirdPane, "blocked");
    await Promise.all(tabs.map((tab) => seen(thirdPane, "blocked", tab)));
    await Promise.any(tabs.map((tab, index) => tab.waitForFunction((count) =>
      (window as unknown as { chimes: number[] }).chimes.length > count, bothBefore[index], { timeout: 5_000 })));
    await noSecondChime(bothBefore);
    const delta = (await heard()) - bothBefore.reduce((sum, count) => sum + count, 0);
    console.log(`two-tab shared alert: ${delta / 2} chimes (${delta} notes)`);
    assert.equal(delta, 2, "exactly one chime across two tabs for the same alert");
    console.log("PASS two open tabs chime once for a shared alert");

    await report(otherPane, "working");
    await Promise.all(tabs.map((tab) => seen(otherPane, "working", tab)));
    const frontBefore = await counts();
    assert.equal(await page.evaluate(() => document.visibilityState), "visible");
    await report(otherPane, "blocked");
    await Promise.all(tabs.map((tab) => seen(otherPane, "blocked", tab)));
    await second.waitForFunction((count) => (window as unknown as { chimes: number[] }).chimes.length >= count + 2, frontBefore[1]);
    await noSecondChime(frontBefore);
    assert.deepEqual(await counts(), [frontBefore[0], frontBefore[1]! + 2], "tab B tells a question in front of tab A");
    console.log("PASS the other tab tells a question in front of the first tab");

    await Promise.all(tabs.map(quiet));
    await report(thirdPane, "working");
    await Promise.all(tabs.map((tab) => seen(thirdPane, "working", tab)));
    await Promise.all(tabs.map((tab) => tab.evaluate(() => { (window as unknown as { slowChimed: boolean }).slowChimed = true; })));
    const slowBefore = await counts();
    await report(thirdPane, "blocked");
    await Promise.all(tabs.map((tab) => seen(thirdPane, "blocked", tab)));
    await Promise.any(tabs.map((tab, index) => tab.waitForFunction((count) =>
      (window as unknown as { chimes: number[] }).chimes.length > count, slowBefore[index], { timeout: 5_000 })));
    await noSecondChime(slowBefore);
    assert.equal((await heard()) - slowBefore.reduce((sum, count) => sum + count, 0), 2, "one chime when the winner confirms late");
    console.log("PASS a winner that confirms late is not chimed over by the other tab");

    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    // closing the last pane can already have removed the workspace; any other failure is reported
    for (const workspace of workspaces) await workspaceClose(workspace).catch((error) => { if (error?.code !== "workspace_not_found") throw error; });
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-sound-server-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true, args: ["--no-sandbox", "--accept-lang=en-US"],
  });
  try {
    await checkAlertSound(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
