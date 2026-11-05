/**
 * A note on one line of a file's diff (#1603) on the unmodified app over the demo's fixture transport
 * (Files → Changes → src/money.ts). With a mouse the + beside a hovered row begins a note; with the
 * keys the arrow keys pick a line in the focused diff and Enter begins one, Escape closing it while
 * empty; on a touch screen a tap picks the line and the bar's Add a note (a full touch target) begins
 * one. Saved, it waits with the reply comments in the diff's own pane, one chip over the input card
 * once the viewer is closed, and goes first in the next message as a quote (where the line is, the
 * comparison as captured, the line fenced) with `agent_only`. A note that would take the message past
 * the composer's limit is refused with a message and nothing changes, and a pane with no agent offers
 * none and says why. At 1280 with a mouse and keys and at 390 on a touch screen, dark and light,
 * Korean on the phone. With UI_EVIDENCE_DIR set, each state is captured in the Codex palette as
 * `diff-line-notes-<shape>-<theme>[-ko]-<state>.png`. Nothing leaves this loopback-only app.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const PANE = panes.api;
const WAIT = { timeout: 15_000 } as const;
const COMPOSER_LIMIT = 20_000;
interface Submit { text: string; agent_only?: true }
type Language = "en" | "ko";
const WORDS = {
  en: { added: "Added line 5", removed: "Removed line 4", unchanged: "Unchanged line 1", add: "Add a note", save: "Add to next message", done: "Note added. It goes first in the next message you send from this pane's Chat (not with a slash command, a ! line or an answer to a question)." },
  ko: { added: "추가된 줄 5", removed: "삭제된 줄 4", unchanged: "변경 없는 줄 1", add: "메모 추가", save: "다음 메시지에 추가", done: "메모를 추가했습니다. 이 패널의 채팅에서 보내는 다음 메시지 맨 앞에 들어갑니다(슬래시 명령, ! 줄, 질문에 대한 답변에는 들어가지 않습니다)." },
} as const;

async function shot(page: Page, name: string, state: string): Promise<void> {
  if (!evidence) return;
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
  await page.screenshot({ path: join(evidence, `diff-line-notes-${name}-${state}.png`), animations: "disabled" });
}

/** Files → Changes → a file's diff, from the header on a computer or More on a phone, its rows drawn. */
async function openDiff(page: Page, phone: boolean, path: string): Promise<void> {
  if (phone) {
    await page.locator(".header-more-button").tap();
    await page.getByRole("dialog", { name: /^(More|더 보기)$/ }).locator("button").filter({ hasText: /^(Browse files|파일 찾아보기)$/ }).first().tap();
  } else await page.locator(".header-files-button").click();
  await page.locator(".files-dialog, [role='dialog']").first().waitFor();
  await page.locator("button").filter({ hasText: /^(Changes|변경 사항)$/ }).first().click();
  await page.locator(".repo-changes:not([aria-busy='true']) .repo-change").first().waitFor();
  await page.locator(".repo-change").filter({ has: page.locator(".repo-change-path", { hasText: path }) }).first().click();
  await page.locator(".repo-diff-viewer").waitFor();
  await page.waitForFunction(() => (document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll("[data-line]").length ?? 0) > 0);
}

/** Closing the viewer returns to the Files list: it closes too, so the pane's composer is in reach. */
async function closeFiles(page: Page): Promise<void> {
  await page.locator(".repo-diff-viewer").waitFor({ state: "detached" });
  const files = page.getByRole("dialog", { name: /^(Files|파일)$/ });
  if (await files.count() === 0) return;
  await page.keyboard.press("Escape");
  await files.waitFor({ state: "detached" });
  // a closed sheet's last frame stays, on an inert host at the end of <body>, until its slide ends (lib/sheets.ts `leave`)
  await page.waitForFunction(() => ![...document.body.children].some((node) => node instanceof HTMLElement && node.inert && node.getAttribute("aria-hidden") === "true"));
}

/** The middle of a drawn row, in the page's coordinates. */
async function rowPoint(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate((selector) => {
    const row = document.querySelector(".repo-diff diffs-container")!.shadowRoot!.querySelector<HTMLElement>(selector)!;
    const box = row.getBoundingClientRect();
    return { x: box.left + Math.min(box.width / 2, 200), y: box.top + box.height / 2 };
  }, selector);
}

/**
 * Hovers a row until its + stands beside it: the rows are drawn again when their colors arrive from
 * the worker, which drops the hovered row until the pointer moves, as a hand's pointer always does.
 */
async function hoverRow(page: Page, selector: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const point = await rowPoint(page, selector);
    await page.mouse.move(point.x + attempt, point.y);
    try {
      await page.locator(".repo-diff-line-note-plus").waitFor({ state: "visible", timeout: 1_000 });
      return;
    } catch { /* drawn again under the pointer: move once more */ }
  }
  throw new Error(`no + beside ${selector}`);
}

/** Hovers a row and presses its + at the pointer, again if the rows were drawn again under it; with `opens`, until the editor opens. */
async function pressPlus(page: Page, selector: string, opens: boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    await hoverRow(page, selector);
    const box = await page.locator(".repo-diff-line-note-plus").boundingBox();
    if (box === null) continue;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    if (!opens) return;
    try {
      await page.locator(".repo-diff-line-note-form").waitFor({ timeout: 1_000 });
      return;
    } catch { /* the + went with a redraw before the press: hover again */ }
  }
  throw new Error(`the + beside ${selector} never opened the editor`);
}

/** The parts of a note's quote an agent reads (lib/diffLineNotes.ts): its JSON-named path, side, line and kind, and the fenced text. */
function noteParts(quote: string): { path: string; machine: string; repository: string; side: string | undefined; kind: string | undefined; line: number; text: string } {
  const lines = quote.split("\n");
  const open = lines.findIndex((line) => /^`{3,}$/.test(line));
  const close = open < 0 ? -1 : lines.indexOf(lines[open]!, open + 1);
  if (close !== lines.length - 1) throw new Error(`no fence closes the quote: ${quote}`);
  // the names are the JSON strings before the fence, in order: path, PC, repository
  const strings = /"(?:[^"\\]|\\.)*"/g;
  const names = [...lines.slice(0, open).join("\n").matchAll(strings)].map((match) => JSON.parse(match[0]) as string);
  // the first line's values once its name is taken out: the side, the kind and the one-based line
  const head = lines[0]!.replace(strings, "");
  const fenced = lines.slice(open + 1, close).join("\n");
  // a whitespace-only line goes as a JSON string
  let text = fenced;
  if (/^".*"$/.test(fenced)) { const parsed = JSON.parse(fenced) as string; if (/^[\s\u0085]*$/.test(parsed)) text = parsed; }
  return {
    path: names[0]!, machine: names[1]!, repository: names[2]!,
    side: /\b(old|new)\b/.exec(head)?.[1], kind: /\b(added|removed|unchanged)\b/.exec(head)?.[1], line: Number(/\d+/.exec(head)?.[0]),
    text,
  };
}

const pick = ({ path, side, line, kind, text }: ReturnType<typeof noteParts>) => ({ path, side, line, kind, text });

const ringed = (page: Page): Promise<string[]> => page.evaluate(() => [...(document.querySelector(".repo-diff diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line][data-find-active]") ?? [])].map((row) => `${row.dataset["lineType"]} ${row.dataset["line"]}`));
const stored = (page: Page): Promise<{ quote: string; comment: string; source?: string }[]> => page.evaluate((id) => JSON.parse(localStorage.getItem(`ovis:reply-comments:${id}`) ?? "[]"), PANE);
const place = (page: Page): Promise<string> => page.locator(".repo-diff-line-place").innerText();
const submits = (page: Page): Promise<Submit[]> => page.evaluate(() => (window as unknown as { noteLab: { submits: Submit[] } }).noteLab.submits);

async function setup(browser: Browser, origin: string, phone: boolean, theme: "dark" | "light", language: Language, pane = PANE) {
  const context = await browser.newContext({ viewport: { width: phone ? 390 : 1280, height: phone ? 844 : 800 }, deviceScaleFactor: evidence ? 2 : 1, isMobile: phone, hasTouch: phone, colorScheme: theme, locale: language === "ko" ? "ko-KR" : "en-US" });
  await context.addInitScript(([id, scheme, language]) => {
    if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language, theme: scheme, palette: "codex" }));
    localStorage.setItem(`ovis:view:${id}`, "chat");
  }, [pane, theme, language] as const);
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT.timeout);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}?pane=${encodeURIComponent(pane)}`);
  await page.getByRole("textbox", { name: language === "ko" ? "메시지" : "Message", exact: true }).waitFor();
  return { context, page, errors };
}

async function desktop(browser: Browser, origin: string, theme: "dark" | "light"): Promise<void> {
  const name = `desktop-1280-${theme}`;
  const { context, page, errors } = await setup(browser, origin, false, theme, "en");
  try {
    const words = WORDS.en;
    await openDiff(page, false, "src/money.ts");
    assert.equal(await place(page), "Click or tap a line, or use the arrow keys, to add a note on it.", `${name}: the bar says how to pick a line`);
    await shot(page, name, "rest");

    // the mouse: hovering the removed row shows its +, which begins a note on that line at once
    await hoverRow(page, '[data-line="4"][data-line-type="change-deletion"]');
    const plus = page.locator(".repo-diff-line-note-plus");
    assert.equal(await plus.getAttribute("aria-label"), "Add a note on this line", `${name}: the + names its action`);
    await shot(page, name, "hover-plus");
    await pressPlus(page, '[data-line="4"][data-line-type="change-deletion"]', true);
    const form = page.locator(".repo-diff-line-note-form");
    await form.waitFor();
    const field = form.getByRole("textbox", { name: "Note", exact: true });
    assert.equal(await field.evaluate((box) => box === document.activeElement), true, `${name}: the note has the focus`);
    assert.equal(await form.locator(".repo-diff-line-note-place span").first().innerText(), words.removed, `${name}: the editor names the removed line`);
    await field.fill("Keep the rounding of negative amounts.");
    await shot(page, name, "editor");
    await page.keyboard.press("ControlOrMeta+Enter");
    await form.waitFor({ state: "detached" });
    assert.equal(await place(page), words.done, `${name}: the bar says where the note went`);
    let notes = await stored(page);
    assert.equal(notes.length, 1, `${name}: one note waits in the diff's own pane`);
    assert.equal(notes[0]!.source, "diff");
    assert.deepEqual(pick(noteParts(notes[0]!.quote)), { path: "src/money.ts", side: "old", line: 4, kind: "removed", text: "  return amount * 100;" }, `${name}: the quote holds the place and the fenced line`);
    await shot(page, name, "added");

    // the keys: the focused diff picks lines with the arrows, Enter begins a note, Escape closes it while empty
    await page.locator(".repo-diff-body").focus();
    // the + picked the removed line: the next logical line is the first added after it
    await page.keyboard.press("ArrowDown");
    await page.locator(".repo-diff-line-place", { hasText: words.added }).waitFor();
    assert.deepEqual(await ringed(page), ["change-addition 5"], `${name}: ArrowDown walks from the picked line`);
    for (let step = 0; step < 12; step++) await page.keyboard.press("ArrowUp");
    await page.locator(".repo-diff-line-place", { hasText: words.unchanged }).waitFor();
    assert.deepEqual(await ringed(page), ["context 1"], `${name}: ArrowUp stops at the first line`);
    for (let step = 0; step < 5; step++) await page.keyboard.press("ArrowDown");
    await page.locator(".repo-diff-line-place", { hasText: words.added }).waitFor();
    assert.deepEqual(await ringed(page), ["change-addition 5"], `${name}: ArrowDown walks every logical line, the removed one included`);
    await shot(page, name, "keyboard-line");
    await page.keyboard.press("Enter");
    await form.waitFor();
    await shot(page, name, "keyboard-editor");
    await page.keyboard.press("Escape");
    await form.waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("repo-diff-body") === true), true, `${name}: Escape gives the focus back to the diff`);
    await page.locator(".repo-diff-viewer").waitFor();
    // a typed note is never lost to Escape, nor to another line's +
    await page.keyboard.press("Enter");
    await field.fill("draft");
    await page.keyboard.press("Escape");
    assert.equal(await form.isVisible(), true, `${name}: Escape keeps a written note`);
    await pressPlus(page, '[data-line="7"][data-line-type="change-addition"]', false);
    assert.equal(await field.inputValue(), "draft", `${name}: another line's + keeps the written note`);
    assert.equal(await form.locator(".repo-diff-line-note-place span").first().innerText(), words.added, `${name}: and its line`);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();

    // a line clicked while Find is open is the one the note goes on, not Find's match
    await page.keyboard.press("ControlOrMeta+f");
    await page.locator(".repo-diff-find input").fill("amount");
    await page.locator(".repo-diff-line-place", { hasText: "Unchanged line 4" }).waitFor();
    const six = await rowPoint(page, '[data-line="6"][data-line-type="change-addition"]');
    await page.mouse.click(six.x, six.y);
    await page.locator(".repo-diff-line-place", { hasText: "Added line 6" }).waitFor();
    assert.deepEqual(await ringed(page), ["change-addition 6"], `${name}: the clicked line is ringed, not the match`);
    // a drag that selects code picks no line
    const seven = await rowPoint(page, '[data-line="7"][data-line-type="change-addition"]');
    await page.mouse.move(seven.x - 60, seven.y);
    await page.mouse.down();
    await page.mouse.move(seven.x + 60, seven.y, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => getSelection()?.type), "Range", `${name}: the drag selected text`);
    assert.equal(await place(page), "Added line 6", `${name}: selecting code keeps the picked line`);
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.locator(".repo-diff-find input").focus();
    await page.keyboard.press("Escape");
    await page.locator(".repo-diff-find").waitFor({ state: "detached" });

    // closed, the viewer leaves the note in the chip; the next message carries it first, for an agent alone
    await page.keyboard.press("Escape");
    await closeFiles(page);
    const chip = page.locator(".reply-comments-open");
    assert.equal(await chip.innerText(), "1 comment", `${name}: one chip counts the note`);
    await shot(page, name, "chip");

    // a note past the composer's limit: refused with a message, the draft and the waiting note unchanged
    const composer = page.getByRole("textbox", { name: "Message", exact: true });
    const long = "x".repeat(COMPOSER_LIMIT - 400);
    await composer.fill(long);
    await openDiff(page, false, "src/money.ts");
    await pressPlus(page, '[data-line="5"][data-line-type="change-addition"]', true);
    await field.fill("y".repeat(300));
    await form.getByRole("button", { name: "Add to next message", exact: true }).click();
    await form.locator(".repo-diff-line-note-error").filter({ hasText: "This note would make your next message too long." }).waitFor();
    notes = await stored(page);
    assert.equal(notes.length, 1, `${name}: the refused note was not added`);
    await shot(page, name, "too-long");
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.keyboard.press("Escape");
    await closeFiles(page);
    assert.equal((await composer.inputValue()).length, long.length, `${name}: the draft is unchanged`);

    const before = (await submits(page)).length;
    await composer.fill("Go ahead.");
    await composer.press("Enter");
    await page.waitForFunction((count) => (window as unknown as { noteLab: { submits: Submit[] } }).noteLab.submits.length > count, before, WAIT);
    const message = (await submits(page)).at(-1)!;
    // the note first, as quote lines, then its comment, then the typed text
    const [carried, typed] = message.text.split("\n\n");
    const quoted = carried!.split("\n");
    assert.equal(quoted.at(-1), "Keep the rounding of negative amounts.", `${name}: the note's comment follows its quote`);
    assert.ok(quoted.slice(0, -1).every((line) => line.startsWith(">")), `${name}: the quote goes as quote lines`);
    assert.deepEqual(pick(noteParts(quoted.slice(0, -1).map((line) => line.replace(/^> ?/, "")).join("\n"))), { path: "src/money.ts", side: "old", line: 4, kind: "removed", text: "  return amount * 100;" }, `${name}: the message carries the note first`);
    assert.equal(typed, "Go ahead.", `${name}: then the typed text`);
    assert.equal(message.agent_only, true, `${name}: for an agent alone`);
    await page.locator(".reply-comments").waitFor({ state: "detached" });
    assert.deepEqual(await stored(page), [], `${name}: the sent note left storage`);
    assert.deepEqual(errors, [], `${name}: no page errors`);
    console.log(`PASS ${name}: hover +, keys, Escape, chip, length refusal, agent-only send`);
  } finally {
    await context.close();
  }
}

async function phone(browser: Browser, origin: string, theme: "dark" | "light", language: Language): Promise<void> {
  const name = `phone-390-${theme}${language === "ko" ? "-ko" : ""}`;
  const { context, page, errors } = await setup(browser, origin, true, theme, language);
  try {
    const words = WORDS[language];
    await openDiff(page, true, "src/money.ts");
    const added = await rowPoint(page, '[data-line="5"][data-line-type="change-addition"]');
    await page.touchscreen.tap(added.x, added.y);
    await page.locator(".repo-diff-line-place", { hasText: words.added }).waitFor();
    assert.deepEqual(await ringed(page), ["change-addition 5"], `${name}: the tapped line is ringed`);
    const open = page.locator(".repo-diff-line-note-open");
    assert.equal(await open.innerText(), words.add);
    const box = (await open.boundingBox())!;
    assert.ok(box.height >= 44, `${name}: Add a note is a full touch target (${box.height}px)`);
    await shot(page, name, "picked");
    await open.tap();
    const form = page.locator(".repo-diff-line-note-form");
    await form.waitFor();
    await form.locator("textarea").fill(language === "ko" ? "음수도 반올림을 유지하세요." : "Keep the rounding of negative amounts.");
    await shot(page, name, "editor");
    const save = form.getByRole("button", { name: words.save, exact: true });
    assert.ok(((await save.boundingBox())?.height ?? 0) >= 44, `${name}: the editor's button is a full touch target`);
    await save.tap();
    await form.waitFor({ state: "detached" });
    assert.equal(await place(page), words.done);
    const notes = await stored(page);
    assert.equal(notes.length, 1);
    assert.deepEqual({ ...pick(noteParts(notes[0]!.quote)), text: undefined }, { path: "src/money.ts", side: "new", line: 5, kind: "added", text: undefined }, `${name}: the note is on the added line`);
    await shot(page, name, "added");
    await page.locator(".repo-diff-close").tap();
    await closeFiles(page);
    await page.locator(".reply-comments-open").waitFor();
    await shot(page, name, "chip");
    assert.deepEqual(errors, [], `${name}: no page errors`);
    console.log(`PASS ${name}: tap picks the line, 44px targets, note waits in the chip`);
  } finally {
    await context.close();
  }
}

/** A pane with no agent takes no note: the bar says why, and its Add a note and the hovered + stay off. */
async function noAgent(browser: Browser, origin: string): Promise<void> {
  const { context, page, errors } = await setup(browser, origin, false, "dark", "en", panes.shell);
  try {
    await openDiff(page, false, "src/money.ts");
    assert.equal(await place(page), "No agent is running in the pane this diff came from.");
    assert.equal(await page.locator(".repo-diff-line-note-open").isDisabled(), true);
    await pressPlus(page, '[data-line="4"][data-line-type="change-deletion"]', false);
    const plus = page.locator(".repo-diff-line-note-plus");
    assert.equal(await page.locator(".repo-diff-line-note-form").count(), 0, "no-agent: the + begins no note");
    assert.equal(await plus.getAttribute("aria-disabled"), "true");
    await shot(page, "desktop-1280-dark", "no-agent");
    assert.deepEqual(errors, []);
    console.log("PASS no-agent: disabled with its reason");
  } finally {
    await context.close();
  }
}

const app = mkdtempSync(join(tmpdir(), "herdr-diff-line-notes-demo-"));
let server: ReturnType<typeof Bun.serve> | undefined;
let browser: Browser | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  // every submit frame the client sends is recorded (window.noteLab); everything else is the demo's
  const lab = `<script>(() => {
    const lab = window.noteLab = { submits: [] };
    const DemoSocket = window.WebSocket;
    const Socket = function (...args) {
      const socket = new DemoSocket(...args);
      const send = socket.send.bind(socket);
      socket.send = (raw) => { try { const message = JSON.parse(raw); if (message.type === "submit") lab.submits.push(message); } catch {} send(raw); };
      return socket;
    };
    Socket.prototype = DemoSocket.prototype;
    Object.setPrototypeOf(Socket, DemoSocket);
    window.WebSocket = Socket;
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${lab}\n    <script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const prefix = "/herdr-web-ui/demo/app/";
    if (!path.startsWith(prefix) && !path.startsWith("/icons/")) return new Response("not found", { status: 404 });
    let file = decodeURIComponent(path.startsWith("/icons/") ? path.slice(1) : path.slice(prefix.length));
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const origin = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
  for (const theme of ["dark", "light"] as const) await desktop(browser, origin, theme);
  for (const [theme, language] of [["dark", "en"], ["light", "en"], ["dark", "ko"], ["light", "ko"]] as const) await phone(browser, origin, theme, language);
  await noAgent(browser, origin);
  console.log("diff line notes: demo OK (hover +, keys, touch, chip, agent-only send, length refusal, no agent, Korean)");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(app, { recursive: true, force: true });
}
