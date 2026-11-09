import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright-core";
import type { UpdateNotes, UpdateStatus } from "../shared/update.ts";
import { KO } from "../src/lib/i18n.ko.ts";
import { buildDemoApp } from "./demo-build.ts";
import { DEMO_FILE_PREVIEW_SCRIPT } from "./demo-file-preview.ts";
import { openSettingsPage } from "./settings-page.ts";

// Update consent on the unmodified app over the demo's fixture transport: Settings' Update and
// restart and the header's Update send the revision of the offer they were drawn with, a release
// that moves under them installs nothing and is checked first, and a server that cannot install by
// revision is sent no install. The demo itself is unmanaged; the managed status, notes and install
// answers come from this script, through a fetch of its own layered over the demo's, so nothing is
// built, installed or restarted. All files and HTTP traffic stay in this disposable, loopback-only
// app; no herdr session is opened.
// REVISION_UPDATE_RECEIPTS: a JSON file for the install requests and status receipts seen.
// UPDATE_CONSENT_SHOTS: a directory for the capture matrix (phone and desktop, light and dark,
// Korean), with its manifest and measurements. VISUAL_QA_CHECKLIST: a checklist path the manifest
// names, when set.
const app = mkdtempSync(join(tmpdir(), "herdr-revision-update-demo-"));
const repo = join(import.meta.dir, "..");
const A = "a1".repeat(20), B = "b2".repeat(20);
const LONG = "f".repeat(64);
// the running version is this build's, so no line says the tab runs another one
const RUNNING = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string }).version;
const MOVED = "A newer release was published after you chose this update, so nothing was installed. Check again to review it.";
const RESTART = "Restart Ovis on this PC to update from here: the server running now cannot install exactly the release shown.";

const offer = (revision = A, version = "9.9.9", patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
  managed: true, auto_update: false, phase: "idle", current_revision: null, latest_revision: revision, current_version: RUNNING,
  latest_version: version, available: true, checked_at: new Date().toISOString(), blocked_reason: null, error: null, step: null,
  revision_bound_install: true, ...patch,
});
const notesFor = (revision: string, version: string, count = 1): UpdateNotes => ({
  revision, omitted: 0,
  releases: Array.from({ length: count }, (_, index) => ({ version: index === 0 ? version : `9.9.${9 - index}`, date: "2026-10-21",
    notes: `### Fixed\n- Release ${index === 0 ? version : `9.9.${9 - index}`} fixes ${index + 1}.`,
    summary: { en: { fixed: [`What ${index === 0 ? version : `9.9.${9 - index}`} fixes, line ${index + 1}.`] }, ko: { fixed: [`${index + 1}번째 수정 사항입니다.`] } } })),
});

interface Post { tab: string; path: string; body: unknown; status: number; code: string | null }
/**
 * The server, as this script plays it: one status (what a supervisor last told), the notes of its
 * offer, and the bridge's rules for an install. A tab can be held on the status it last read, as
 * a tab whose next poll has not come yet is.
 */
class Fixture {
  status: UpdateStatus = offer();
  notes: UpdateNotes = notesFor(A, "9.9.9");
  /** what a held tab keeps reading */
  held = new Map<string, UpdateStatus>();
  posts: Post[] = [];
  /** `watch`: a device paired to watch only, which the server refuses every mutation (server/index.ts) */
  role: "drive" | "watch" = "drive";
  /** the status cannot be fetched at all, as with the server out of reach */
  unreachable = false;
  private waiters: Array<{ path: string; resolve: (post: Post) => void }> = [];
  private reads: Array<() => void> = [];

  /** Resolves once a tab has been answered (or failed) its next status read: asked for before the load. */
  nextRead(): Promise<void> {
    return new Promise((resolve) => this.reads.push(resolve));
  }

  /** Resolves with the next POST to `path`: asked for before the press that sends it. */
  next(path: string): Promise<Post> {
    return new Promise((resolve) => this.waiters.push({ path, resolve }));
  }

  answer(tab: string, path: string, method: string, body: string | null): { status: number; body: unknown } {
    if (method === "GET") {
      if (path === "/api/updates") {
        for (const resolve of this.reads.splice(0)) resolve();
        // status 0: the page's fetch rejects, as a network failure does
        return this.unreachable ? { status: 0, body: null } : { status: 200, body: this.held.get(tab) ?? this.status };
      }
      if (path === "/api/updates/notes") return { status: 200, body: this.notes };
      if (path === "/api/updates/installed") return { status: 200, body: { revision: null, version: null, previous_version: null, installed_at: null, releases: [], omitted: 0 } };
      return { status: 405, body: { error: { code: "method_not_allowed", message: "fixture" } } };
    }
    let parsed: unknown = null;
    try { parsed = body === null ? null : JSON.parse(body); } catch { parsed = body; }
    const refuse = (status: number, code: string) => ({ status, body: { error: { code, message: `fixture ${code}` } } });
    let reply: { status: number; body: unknown };
    // as the server answers a watching device, before any update route is reached: nothing changes
    if (this.role === "watch") reply = { status: 403, body: { error: { code: "read_only", message: "this device can only watch" } } };
    else if (path === "/api/updates/check") {
      reply = { status: 202, body: { accepted: true } };
      this.status = { ...this.status, phase: "idle", error: null, error_code: null };
    } else {
      const expected = (parsed as { expected_revision?: unknown } | null)?.expected_revision;
      if (typeof expected !== "string" || !/^[0-9a-f]{40,64}$/.test(expected)) reply = refuse(400, "invalid_update_install");
      else if (this.status.revision_bound_install !== true) reply = refuse(409, "update_restart_required");
      else if (!this.status.available) reply = refuse(409, "update_unavailable");
      else if (expected !== this.status.latest_revision) reply = refuse(409, "update_offer_changed");
      else {
        reply = { status: 202, body: { accepted: true } };
        // as the updater does: an install starts with a check, which reports nothing available yet
        this.status = { ...this.status, phase: "checking", available: false };
      }
    }
    const post: Post = { tab, path, body: parsed, status: reply.status, code: (reply.body as { error?: { code?: string } }).error?.code ?? null };
    this.posts.push(post);
    const waiter = this.waiters.findIndex((each) => each.path === path);
    if (waiter >= 0) this.waiters.splice(waiter, 1)[0]!.resolve(post);
    return reply;
  }
}

/** Layered over the demo's fetch: the update endpoints are this script's. */
const UPDATE_FETCH = `<script>(() => {
  const demo = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const at = url.pathname.indexOf("/api/updates");
    if (at < 0) return demo(input, init);
    const answer = await window.__updateFixture(url.pathname.slice(at), (init && init.method) || "GET", init && typeof init.body === "string" ? init.body : null);
    if (answer.status === 0) throw new TypeError("Failed to fetch");
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  };
})();</script>`;

async function open(browser: Browser, fixture: Fixture, options: { width: number; theme: "light" | "dark"; language: "en" | "ko" }): Promise<BrowserContext> {
  const device = options.width === 390 ? devices["iPhone 14"] : null;
  const context = await browser.newContext(device
    ? { ...device, viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: options.language }
    : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: options.language });
  await context.addInitScript((settings) => { localStorage.setItem("ovis:settings", settings); }, JSON.stringify({ language: options.language, theme: options.theme }));
  let tabs = 0;
  const names = new WeakMap<Page, string>();
  await context.exposeBinding("__updateFixture", (source, path: string, method: string, body: string | null) => {
    if (!names.has(source.page)) names.set(source.page, `tab-${++tabs}`);
    return fixture.answer(names.get(source.page)!, path, method, body);
  });
  return context;
}

const label = (language: "en" | "ko", text: string) => language === "ko" ? KO[text] ?? text : text;
/**
 * Nothing overflows sideways: not the page, and not inside the update line, the Updates section or
 * its notes, where a box that clips its overflow would hide a long word without widening the page.
 */
const fits = async (page: Page, what: string) => assert.deepEqual(await page.evaluate(() => {
  const found: string[] = [];
  if (document.documentElement.scrollWidth > window.innerWidth) found.push(`page ${document.documentElement.scrollWidth} > ${window.innerWidth}`);
  for (const region of document.querySelectorAll(".update-notice, .settings-updates, .settings-updates .update-notes")) {
    const box = region.getBoundingClientRect();
    const name = region.className;
    if (region.scrollWidth > region.clientWidth + 1) found.push(`${name} scrolls sideways: ${region.scrollWidth} > ${region.clientWidth}`);
    for (const node of region.querySelectorAll("*")) {
      const rect = node.getBoundingClientRect();
      // a screen-reader-only clip is 1 px wide on purpose
      if (rect.width <= 1 || rect.height <= 1) continue;
      // what is read or pressed: text of its own, or a control. A progress bar's sliding fill has neither
      const text = [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent!.trim() !== "");
      if (!text && !node.matches("button, a, input")) continue;
      if (rect.left < box.left - 1 || rect.right > box.right + 1) found.push(`${name} > ${node.tagName.toLowerCase()}.${(node as HTMLElement).className}: ${Math.round(rect.left)}..${Math.round(rect.right)} outside ${Math.round(box.left)}..${Math.round(box.right)} ("${node.textContent?.slice(0, 40)}")`);
    }
  }
  return found;
}), [], `${what}: nothing overflows sideways`);
/** Where the browser broke each line of a text: what a Korean reader sees split. */
const lines = (page: Page, selector: string, text: string) => page.evaluate(({ selector, text }) => {
  const node = [...document.querySelectorAll(`${selector}, ${selector} *`)].find((each) => each.textContent?.includes(text) && ![...each.children].some((child) => child.textContent?.includes(text)));
  if (!node) return null;
  const rows: Array<{ top: number; words: string[] }> = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    const value = current.textContent ?? "";
    for (const match of value.matchAll(/\S+/g)) {
      const range = document.createRange();
      range.setStart(current, match.index!);
      range.setEnd(current, match.index! + match[0].length);
      const top = Math.round(range.getClientRects()[0]?.top ?? -1);
      const row = rows.find((each) => Math.abs(each.top - top) <= 2);
      if (row) row.words.push(match[0]); else rows.push({ top, words: [match[0]] });
    }
  }
  return rows.sort((a, b) => a.top - b.top).map((row) => row.words.join(" "));
}, { selector, text });
const settingsOpen = async (page: Page, language: "en" | "ko") => {
  // the shortcut is the app's once it has drawn: after a load or a reload, wait for it
  await page.locator(".conn-live").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, label(language, "About"), label(language, "Back to settings"));
  await page.locator(".settings-updates").scrollIntoViewIfNeeded();
};

/** Two animation frames: whatever the last answer set has been committed and painted. */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

/** The functional checks, on a phone in English. */
async function behaviour(browser: Browser, url: string): Promise<Record<string, unknown>> {
  const fixture = new Fixture();
  const receipts: Record<string, unknown> = { offered_revision: A, moved_revision: B };
  const context = await open(browser, fixture, { width: 390, theme: "light", language: "en" });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    const line = page.locator(".update-notice");

    // the offer closed from the keyboard hands the focus to the header's More, never to the page (G-102); the
    // closed offer is then forgotten so the line comes back for the rest
    await line.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor();
    await line.filter({ hasText: "Ovis v9.9.9 is available." }).getByRole("button", { name: "Dismiss", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.matches(".header-more-button") ?? false), true, "closing the offer from the keyboard leaves the focus on the header's More");
    await page.evaluate(() => localStorage.removeItem("ovis:update-offer-closed"));
    await page.reload();
    await page.locator(".conn-live").waitFor({ state: "attached" });
    console.log("PASS the offer closes from the keyboard and the focus goes to the header's More");

    // happy: the header's Update names A, and the install's steps are shown as they are told
    await line.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor();
    await line.getByRole("button", { name: "What's new", exact: true }).waitFor();
    const statusReceipts: Array<{ surface: string; phase: string; shown: string }> = [];
    const deliver = async (surface: string, scope: Page | ReturnType<Page["locator"]>, status: Partial<UpdateStatus>, shown: string) => {
      fixture.status = { ...fixture.status, ...status };
      await scope.getByText(shown, { exact: true }).first().waitFor();
      statusReceipts.push({ surface, phase: fixture.status.phase, shown });
    };
    let sent = fixture.next("/api/updates/install");
    await line.getByRole("button", { name: "Update", exact: true }).click();
    const header = await sent;
    assert.deepEqual(header.body, { expected_revision: A }, "the header's Update names the offered revision");
    assert.equal(header.status, 202);
    await deliver("header", line, { phase: "checking", available: false }, "Starting the update…");
    await deliver("header", line, { phase: "building", step: "build" }, "Building the app");
    await deliver("header", line, { phase: "restarting", step: "restart" }, "Step 5 of 5");
    await deliver("header", page, { phase: "idle", step: null, current_revision: A, available: false }, "App updated. Save unsent drafts before reloading.");
    console.log("PASS the header's Update posts the offered revision and follows the install to its end");

    // happy: Settings' Update and restart names A too
    fixture.status = offer();
    await page.reload();
    await settingsOpen(page, "en");
    const settings = page.locator(".settings-updates");
    const install = settings.getByRole("button", { name: "Update and restart", exact: true });
    await settings.getByText("What 9.9.9 fixes, line 1.", { exact: true }).waitFor();
    assert.equal(await install.isEnabled(), true, "the offer can be installed");
    sent = fixture.next("/api/updates/install");
    await install.click();
    const fromSettings = await sent;
    assert.deepEqual(fromSettings.body, { expected_revision: A }, "Update and restart names the offered revision");
    assert.equal(fromSettings.status, 202);
    await deliver("settings", settings, { phase: "building", step: "dependencies" }, "Installing dependencies");
    await deliver("settings", settings, { phase: "restarting", step: "restart" }, "Restarting the app");
    await deliver("settings", page, { phase: "idle", step: null, current_revision: A, available: false }, "App updated. Save unsent drafts before reloading.");
    receipts["accepted"] = { header: header.body, settings: fromSettings.body, status_receipts: statusReceipts };
    console.log("PASS Update and restart posts the offered revision and follows the install to its end");

    // failure: a tab still showing A while the server offers B. Its Update posts A, which is
    // refused; it says so, asks for a check, and only the tab that shows B installs B
    fixture.status = offer();
    fixture.notes = notesFor(A, "9.9.9");
    await page.goto(url);
    await line.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor();
    const other = await context.newPage();
    await other.goto(url);
    fixture.held.set("tab-1", offer());
    fixture.status = offer(B, "9.9.10");
    fixture.notes = notesFor(B, "9.9.10");
    await other.locator(".update-notice").getByText("Ovis v9.9.10 is available.", { exact: true }).waitFor();
    const before = fixture.posts.length;
    sent = fixture.next("/api/updates/install");
    await line.getByRole("button", { name: "Update", exact: true }).click();
    const stale = await sent;
    assert.deepEqual([stale.tab, stale.body, stale.status, stale.code], ["tab-1", { expected_revision: A }, 409, "update_offer_changed"], "the tab showing A posts A, and it is refused");
    await line.getByText(MOVED, { exact: true }).waitFor();
    fixture.held.delete("tab-1");
    sent = fixture.next("/api/updates/check");
    await line.getByRole("button", { name: "Try again", exact: true }).click();
    assert.equal((await sent).path, "/api/updates/check", "Try again after a moved offer checks, never installs");
    await line.getByText("Ovis v9.9.10 is available.", { exact: true }).waitFor();
    sent = fixture.next("/api/updates/install");
    await other.locator(".update-notice").getByRole("button", { name: "Update", exact: true }).click();
    const fresh = await sent;
    assert.deepEqual([fresh.tab, fresh.body, fresh.status], ["tab-2", { expected_revision: B }, 202], "the tab showing B installs B, by name");
    const twoTabs = fixture.posts.slice(before).map(({ tab, path, body, status, code }) => ({ tab, path, body, status, code }));
    assert.equal(twoTabs.some((post) => post.status === 202 && (post.body as { expected_revision?: string } | null)?.expected_revision === A), false, "A never installs B");
    receipts["two_tabs"] = twoTabs;
    await other.close();
    console.log("PASS a tab showing an old offer posts its own revision, is refused, and checks before installing");

    // failure: the release moves after the install was accepted: Settings and the line say so, and
    // nothing installs until a check shows the new offer
    fixture.status = offer();
    fixture.notes = notesFor(A, "9.9.9");
    await page.goto(url);
    await line.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor();
    sent = fixture.next("/api/updates/install");
    await line.getByRole("button", { name: "Update", exact: true }).click();
    assert.deepEqual((await sent).body, { expected_revision: A });
    fixture.status = offer(B, "9.9.10", { phase: "error", error_code: "update_offer_changed", error: "A different release is on offer than the one asked for, so nothing was installed. Review it, then update again." });
    fixture.notes = notesFor(B, "9.9.10");
    await line.getByText(MOVED, { exact: true }).waitFor();
    await fits(page, "moved offer");
    await settingsOpen(page, "en");
    await settings.getByText(MOVED, { exact: true }).waitFor();
    assert.equal(await install.isDisabled(), true, "Update and restart waits for a check after a moved offer");
    assert.equal(await settings.getByRole("button", { name: "Check for updates", exact: true }).isEnabled(), true);
    const installsBefore = fixture.posts.filter((post) => post.path === "/api/updates/install").length;
    sent = fixture.next("/api/updates/check");
    await settings.getByRole("button", { name: "Check for updates", exact: true }).click();
    await sent;
    await settings.getByText(/^Version v9\.9\.10 \(b2b2b2b2b2b2\) is available\.$/).waitFor();
    assert.equal(await install.isEnabled(), true, "the checked offer can be installed");
    assert.equal(fixture.posts.filter((post) => post.path === "/api/updates/install").length, installsBefore, "nothing installed after the moved offer");
    receipts["moved_after_accept"] = { shown: MOVED, install_disabled_until_check: true, installs_after_move: 0 };
    console.log("PASS a release that moved after the install was accepted is shown, and installs nothing until it is checked");

    // failure: an older supervisor: no install is sent, and both places ask for a restart
    fixture.status = offer(A, "9.9.9", { revision_bound_install: undefined });
    fixture.notes = notesFor(A, "9.9.9");
    const posted = fixture.posts.length;
    await page.goto(url);
    await line.getByText(RESTART, { exact: true }).waitFor();
    assert.equal(await line.getByRole("button", { name: "Update", exact: true }).count(), 0, "the line offers no install");
    assert.match(await line.getByRole("link", { name: "How to restart", exact: true }).getAttribute("href") ?? "", /docs\/guide\.md#updates$/);
    await settingsOpen(page, "en");
    await settings.getByText(RESTART, { exact: true }).waitFor();
    assert.match(await settings.getByRole("link", { name: "How to restart", exact: true }).getAttribute("href") ?? "", /docs\/guide\.md#updates$/);
    assert.equal(await install.isDisabled(), true, "Update and restart is disabled under an older supervisor");
    await install.click({ force: true });
    assert.equal(fixture.posts.length, posted, "nothing is posted under an older supervisor");
    receipts["old_supervisor"] = { capability: false, header: RESTART, settings_install_disabled: true, posts: fixture.posts.length - posted };
    console.log("PASS under an older supervisor no install is sent, and both places ask for a restart");

    // failure, then recovery: the tab last read a server that installs by revision, which then
    // restarted under an older supervisor. Its Update is refused for want of the capability, and
    // the line asks for a restart. Once the server reports the capability again (restarted under a
    // supervisor that has it), the refusal is over and the offer installs from here again
    fixture.status = offer();
    fixture.notes = notesFor(A, "9.9.9");
    await page.goto(url);
    await line.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor();
    fixture.held.set("tab-1", offer());
    fixture.status = offer(A, "9.9.9", { revision_bound_install: undefined });
    sent = fixture.next("/api/updates/install");
    await line.getByRole("button", { name: "Update", exact: true }).click();
    const unbound = await sent;
    assert.deepEqual([unbound.tab, unbound.body, unbound.status, unbound.code], ["tab-1", { expected_revision: A }, 409, "update_restart_required"], "the server without the capability refuses the install");
    fixture.held.delete("tab-1");
    await line.getByText(RESTART, { exact: true }).waitFor();
    fixture.status = offer();
    await line.getByText(RESTART, { exact: true }).waitFor({ state: "detached" });
    sent = fixture.next("/api/updates/install");
    await line.getByRole("button", { name: "Try again", exact: true }).click();
    const recovered = await sent;
    assert.deepEqual([recovered.tab, recovered.body, recovered.status], ["tab-1", { expected_revision: A }, 202], "the restarted server installs the offer by its revision");
    receipts["restart_recovered"] = { refused: unbound.code, after_restart: { body: recovered.body, status: recovered.status } };
    console.log("PASS a refusal for want of the capability ends once the server reports it again");

    // observe-only: a watching device sees the offer, and its press changes nothing on the server
    fixture.status = offer();
    fixture.notes = notesFor(A, "9.9.9");
    fixture.role = "watch";
    await page.goto(url);
    await line.getByText("Ovis v9.9.9 is available.", { exact: true }).waitFor();
    const unchanged = JSON.stringify(fixture.status);
    sent = fixture.next("/api/updates/install");
    await line.getByRole("button", { name: "Update", exact: true }).click();
    const watched = await sent;
    assert.deepEqual([watched.body, watched.status, watched.code], [{ expected_revision: A }, 403, "read_only"], "a watching device's install is refused");
    await line.getByText("The update could not be installed.", { exact: true }).waitFor();
    await settingsOpen(page, "en");
    await settings.getByText("this device can only watch", { exact: false }).first().waitFor();
    assert.equal(JSON.stringify(fixture.status), unchanged, "the refused install changed no status");
    receipts["observe"] = { status: watched.status, code: watched.code, status_unchanged: true };
    fixture.role = "drive";
    console.log("PASS a watching device's install is refused and changes nothing");
    assert.deepEqual(errors, []);
    receipts["posts"] = fixture.posts;
    return receipts;
  } finally {
    await context.close();
  }
}

interface Shot { file: string; width: number; height: number; theme: string; language: string; state: string; sha256?: string; capturedAt?: string }

/** The capture matrix: every state of both surfaces, phone and desktop, light and dark, and Korean. */
async function captures(browser: Browser, url: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const shots: Shot[] = [];
  const measurements: Record<string, unknown>[] = [];
  const longError = `bun run build failed: /tmp/herdr-updates/release-${LONG}/node_modules/.cache/${"x".repeat(120)}`;
  const states: Array<{ state: string; status: () => UpdateStatus; notes?: () => UpdateNotes; only?: number }> = [
    { state: "offered", status: () => offer() },
    { state: "checking", status: () => offer(A, "9.9.9", { phase: "checking", available: false }) },
    { state: "building", status: () => offer(A, "9.9.9", { phase: "building", available: false, step: "build" }) },
    { state: "moved-offer", status: () => offer(B, "9.9.10", { phase: "error", error_code: "update_offer_changed", error: "A different release is on offer than the one asked for, so nothing was installed. Review it, then update again." }), notes: () => notesFor(B, "9.9.10") },
    { state: "restart-required", status: () => offer(A, "9.9.9", { revision_bound_install: undefined }) },
    { state: "retry", status: () => offer(A, "9.9.9", { phase: "error", error: "bun run build failed: fixture" }) },
    // a 64-hex revision and an unbroken path in the error: the updater offers only plain vX.Y.Z tags, so the version stays one
    { state: "long", status: () => offer(LONG, "9.9.9", { phase: "error", error: longError }), notes: () => notesFor(LONG, "9.9.9") },
    { state: "notes-end", status: () => offer(), notes: () => notesFor(A, "9.9.9", 8) },
    { state: "hover", status: () => offer(), only: 1440 },
    { state: "focus-visible", status: () => offer() },
    { state: "pressed", status: () => offer() },
    { state: "disabled", status: () => offer(A, "9.9.9", { phase: "checking", available: false }) },
    // nothing to install: the controls must offer none
    { state: "unmanaged", status: () => ({ ...offer(), managed: false, available: false, latest_revision: null, latest_version: null, revision_bound_install: undefined }) },
    { state: "up-to-date", status: () => offer(A, "9.9.9", { available: false, latest_revision: null, latest_version: null }) },
    { state: "unreachable", status: () => offer() },
    { state: "observe", status: () => offer() },
  ];
  const combos = [
    ...[390, 1440].flatMap((width) => (["light", "dark"] as const).map((theme) => ({ width, theme, language: "en" as const }))),
    { width: 390, theme: "light" as const, language: "ko" as const },
  ];
  for (const combo of combos) {
    const fixture = new Fixture();
    const context = await open(browser, fixture, combo);
    try {
      const page = await context.newPage();
      const t = (text: string) => label(combo.language, text);
      for (const { state, status, notes, only } of states) {
        if (only && only !== combo.width) continue;
        if (combo.language === "ko" && state !== "moved-offer" && state !== "restart-required") continue;
        for (const surface of ["header", "settings"] as const) {
          fixture.status = status();
          fixture.notes = notes?.() ?? notesFor(fixture.status.latest_revision ?? A, fixture.status.latest_version ?? "9.9.9");
          fixture.role = state === "observe" ? "watch" : "drive";
          fixture.unreachable = state === "unreachable";
          const read = fixture.nextRead();
          await page.goto(url);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const line = page.locator(".update-notice");
          let target: ReturnType<Page["locator"]> | null = null;
          if (surface === "header") {
            if (state === "checking" || state === "disabled") {
              // the line shows a check only once Update was pressed: pressed here, and the answer held
              fixture.status = offer();
              await line.getByRole("button", { name: t("Update"), exact: true }).waitFor();
              if (state === "disabled") continue;
              const sent = fixture.next("/api/updates/install");
              await line.getByRole("button", { name: t("Update"), exact: true }).click();
              await sent;
              await line.getByText(t("Starting the update…"), { exact: true }).waitFor();
            } else if (state === "moved-offer") await line.getByText(t(MOVED), { exact: true }).waitFor();
            else if (state === "restart-required") await line.getByText(t(RESTART), { exact: true }).waitFor();
            else if (state === "building") await line.getByText(t("Building the app"), { exact: true }).waitFor();
            else if (state === "retry") await line.getByRole("button", { name: t("Try again"), exact: true }).waitFor();
            else if (state === "notes-end" || state === "long") continue;
            else if (state === "unmanaged" || state === "up-to-date" || state === "unreachable") {
              // the status was answered (or failed) and drawn: the line must then be absent
              await read;
              await frames(page);
              assert.equal(await line.count(), 0, `${state}: the header offers no update`);
            } else if (state === "observe") {
              const sent = fixture.next("/api/updates/install");
              await line.getByRole("button", { name: t("Update"), exact: true }).click();
              assert.equal((await sent).status, 403);
              await line.getByText(t("The update could not be installed."), { exact: true }).waitFor();
            }
            else await line.getByRole("button", { name: t("What's new"), exact: true }).waitFor();
            const empty = state === "unmanaged" || state === "up-to-date" || state === "unreachable";
            target = empty ? null : line.getByRole("button", { name: t(state === "retry" || state === "observe" ? "Try again" : "Update"), exact: true });
          } else {
            await settingsOpen(page, combo.language);
            const section = page.locator(".settings-updates");
            if (state === "moved-offer") await section.getByText(t(MOVED), { exact: true }).waitFor();
            else if (state === "restart-required") await section.getByText(t(RESTART), { exact: true }).waitFor();
            else if (state === "checking" || state === "disabled") await section.getByText(t("Checking for updates…"), { exact: true }).waitFor();
            else if (state === "building") await section.getByText(t("Building the app"), { exact: true }).waitFor();
            else if (state === "retry") await section.getByText("bun run build failed: fixture", { exact: true }).waitFor();
            else if (state === "long") await section.getByText(longError, { exact: true }).waitFor();
            else if (state === "unmanaged" || state === "up-to-date" || state === "unreachable") {
              await read;
              await section.getByText(t(state === "unreachable" ? "Waiting for an update check…" : "Up to date."), { exact: true }).waitFor();
            } else await section.locator(".update-notes").waitFor();
            if (state === "observe") {
              const sent = fixture.next("/api/updates/install");
              await section.getByRole("button", { name: t("Update and restart"), exact: true }).click();
              assert.equal((await sent).status, 403);
              await section.getByText("this device can only watch", { exact: false }).first().waitFor();
            }
            if (state === "notes-end") {
              await section.locator(".update-notes").evaluate((notesBox) => { notesBox.scrollTop = notesBox.scrollHeight; });
              await page.waitForFunction(() => { const box = document.querySelector(".settings-updates .update-notes"); return !!box && Math.abs(box.scrollTop + box.clientHeight - box.scrollHeight) <= 1; });
            }
            target = section.getByRole("button", { name: t("Update and restart"), exact: true });
            if (state === "unmanaged" || state === "unreachable") {
              // no update is managed here, or none could be read: no control is drawn at all
              assert.equal(await target.count(), 0, `${state}: Settings offers no install`);
              assert.equal(await section.getByRole("button", { name: t("Check for updates"), exact: true }).count(), 0, `${state}: Settings offers no check`);
              target = null;
            } else if (state === "up-to-date") assert.equal(await target.isDisabled(), true, "nothing to install: Update and restart is disabled");
            if (target && state !== "building" && state !== "checking") await target.scrollIntoViewIfNeeded();
          }
          if (state === "hover") await target!.hover();
          if (state === "focus-visible") {
            await page.keyboard.press("Shift");
            await target!.focus();
            assert.equal(await target!.evaluate((node) => node.matches(":focus-visible")), true, `${surface} ${state}: the button shows its focus`);
          }
          let pressed = false;
          if (state === "pressed") {
            const box = await target!.boundingBox();
            assert.ok(box, `${surface}: the button is drawn`);
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
            pressed = true;
          }
          if (state === "disabled" && surface === "settings") assert.equal(await target!.isDisabled(), true, "Update and restart is disabled while a check runs");
          await fits(page, `${combo.width} ${combo.theme} ${combo.language} ${surface} ${state}`);
          const file = `update-consent-${combo.width}-${combo.theme}${combo.language === "ko" ? "-ko" : ""}-${surface}-${state}.png`;
          await page.screenshot({ path: join(dir, file) });
          if (pressed) {
            // released away from the button: a press, never a click that would install
            await page.mouse.move(0, 0);
            await page.mouse.up();
          }
          shots.push({ file, width: combo.width, height: combo.width === 390 ? 844 : 900, theme: combo.theme, language: combo.language, state: `${surface}-${state}` });
          if (["moved-offer", "restart-required", "offered", "observe", "unmanaged", "up-to-date", "unreachable"].includes(state)) {
            const selector = surface === "header" ? ".update-notice" : ".settings-updates";
            const korean = combo.language === "ko" ? { korean_lines: await lines(page, selector, t(state === "moved-offer" ? MOVED : RESTART)) } : {};
            measurements.push({ file, ...korean, ...await page.evaluate((selector) => {
              const parse = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
              const luminance = ([r, g, b]: number[]) => { const c = [r!, g!, b!].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
              const background = (node: Element | null): string => { for (let at = node; at; at = at.parentElement) { const color = getComputedStyle(at).backgroundColor; if (!/rgba\(.*, 0\)$/.test(color) && color !== "transparent") return color; } return "rgb(255, 255, 255)"; };
              const contrast = (node: Element) => { const a = luminance(parse(getComputedStyle(node).color)), b = luminance(parse(background(node))); return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100; };
              const root = document.querySelector(selector);
              const text = root?.querySelector(":scope > span, [role='status']");
              return {
                surface: selector,
                text: text ? { content: text.textContent, fontSizePx: parseFloat(getComputedStyle(text).fontSize), contrast: contrast(text) } : null,
                controls: [...(root?.querySelectorAll("button, a") ?? [])].map((node) => { const box = node.getBoundingClientRect(); return { name: node.textContent?.trim() || node.getAttribute("aria-label"), width: Math.round(box.width * 10) / 10, height: Math.round(box.height * 10) / 10, disabled: (node as HTMLButtonElement).disabled ?? false, contrast: contrast(node) }; }),
              };
            }, selector) });
          }
        }
      }
    } finally {
      await context.close();
    }
  }
  for (const shot of shots) {
    const path = join(dir, shot.file);
    shot.sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    shot.capturedAt = statSync(path).mtime.toISOString();
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  const notApplicable = {
    "header-notes-end": "the header line carries no notes; they are read in Settings (settings-notes-end)",
    "header-disabled": "the header line never draws a disabled Update: while an install or check runs it shows the progress instead, and under an older supervisor it shows How to restart",
    "hover@390": "hover is captured at 1440 only; a phone has no hover",
    "header-long": "the header line words every failure as the generic \"The update could not be installed.\" (src/components/UpdateControls.tsx, `failed ?` in UpdateNotice) and never shows the revision or the error itself; the long revision and unbroken error are captured in Settings (settings-long)",
    "remote-pc-offline": "the update controls are this server's own; a remote PC that is offline is drawn in its sidebar group (src/components/MachineSidebar.tsx .machine-offline), which this change does not touch, and the demo has no offline PC. The update states with no reachable status are captured as unreachable",
    "empty": "captured as unmanaged (no managed install: no control drawn), up-to-date (managed, nothing on offer: Update and restart disabled) and unreachable (status read fails: no control drawn)",
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ head, ...(process.env["VISUAL_QA_CHECKLIST"] ? { checklist_path: process.env["VISUAL_QA_CHECKLIST"] } : {}), not_applicable: notApplicable, shots }, null, 2));
  writeFileSync(join(dir, "measurements.json"), JSON.stringify({ head, measurements }, null, 2));
  console.log(`PASS captured ${shots.length} states into ${dir}`);
}

let failed = false;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>${UPDATE_FETCH}${DEMO_FILE_PREVIEW_SCRIPT}\n    <script type="module"`));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
    if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice(prefix.length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  console.log(`fixture server pid=${process.pid} port=${server.port}`);
  const port = server.port;
  const url = `http://127.0.0.1:${port}/herdr-web-ui/demo/app/`;
  try {
    const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const receipts = await behaviour(browser, url);
      if (process.env["REVISION_UPDATE_RECEIPTS"]) writeFileSync(process.env["REVISION_UPDATE_RECEIPTS"], JSON.stringify(receipts, null, 2));
      if (process.env["UPDATE_CONSENT_SHOTS"]) await captures(browser, url, process.env["UPDATE_CONSENT_SHOTS"]);
    } finally { await browser.close(); }
  } finally { server.stop(true); console.log(`fixture server stopped port=${port}`); }
} catch (error) {
  failed = true;
  console.error(error);
} finally {
  rmSync(app, { recursive: true, force: true });
  console.log(`removed ${app}`);
}
process.exit(failed ? 1 : 0);
