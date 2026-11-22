/** Real ChatView over controlled HTTP; no live panes or provider calls. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import type { ConversationTurn } from "../shared/protocol.ts";
import type {} from "./chat-virtual-fixture.tsx";

const root = mkdtempSync(join(tmpdir(), "herdr-chat-virtual-"));
const evidence = process.env.UI_EVIDENCE_DIR;
/** CPU_THROTTLE=2 slows each page as a loaded GitHub-hosted runner is slowed (Chrome's CPU throttling) */
const throttle = Number(process.env.CPU_THROTTLE ?? 1);
if (!Number.isFinite(throttle) || throttle < 1) throw new Error(`CPU_THROTTLE must be a rate of 1 or more: ${process.env.CPU_THROTTLE}`);
async function throttled(page: Page) {
  if (throttle > 1) await (await page.context().newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: throttle });
}
if (evidence) mkdirSync(evidence, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let activePage: Page | undefined;
let revision = 0;
let epoch = 1;
let holdOlder = false;
let olderReads = 0;
let wholeReads = 0;
let newestStart = 0;
let beginsAtOrigin = false;
let slideReads = 0;
let streamedParagraphs: number | null = null;
const STREAMED_PARAGRAPHS = 40;
let longRead = { asked: Promise.withResolvers<void>(), answer: Promise.withResolvers<void>() };
const WHOLE_OUTPUT = `FULL TOOL OUTPUT\n${Array.from({ length: 98 }, (_, n) => `detail line ${n + 1} ${"detail ".repeat(20)}`).join("\n")}\nFULL OUTPUT END`;
/** few lines but very long ones (one 100 KB line of JSON): no line count folds it, its length does */
const LONG_LINE_OUTPUT = JSON.stringify({ items: Array.from({ length: 2500 }, (_, n) => ({ id: n, name: `item-${n}` })) }).padEnd(100_000, " ");
function foldChat(): ConversationTurn[] {
  const say = (role: ConversationTurn["role"], text: string): ConversationTurn => ({ role, ts: "2026-10-12T00:00:00.000Z", parts: [{ kind: "text", text }] });
  return [
    ...Array.from({ length: 6 }, (_, n) => say(n % 2 ? "assistant" : "user", `Fold turn ${n + 1}. ${"A line of text. ".repeat(8)}`)),
    say("user", "Run the tests."),
    { role: "assistant", ts: "2026-10-12T00:00:00.000Z", parts: [
      { kind: "tool", name: "Bash", summary: "bun test", input: JSON.stringify({ command: "bun test" }), output: Array.from({ length: 100 }, (_, n) => `(pass) test ${n + 1}`).join("\n") },
      { kind: "tool", name: "Bash", summary: "cat big.json", input: JSON.stringify({ command: "cat big.json" }), output: LONG_LINE_OUTPUT, output_ref: "fold-output", output_size: WHOLE_OUTPUT.length },
      { kind: "text", text: "FOLD-CHAT-END" },
    ] },
  ];
}
const olderEvents = new EventTarget();
const olderReleases: Array<() => void> = [];
function turn(index: number, machine: string): ConversationTurn {
  const text = `${machine} E${epoch} ROW-${index}\n\n${"Variable height paragraph. ".repeat(Math.abs(index) % 5 + 1)}${index === 999 ? `\n\nREVISION-${revision}` : ""}${index === 999 && streamedParagraphs !== null ? Array.from({ length: streamedParagraphs }, (_, n) => `\n\nRendered paragraph ${n + 1}: ${"streamed words grow the rendered row while the reader follows. ".repeat(3)}`).join("") : ""}`;
  const parts: ConversationTurn["parts"] = [{ kind: "text", text }];
  if (index === 497) parts.unshift({ kind: "tool", name: "Read", summary: "fixture tool", input: "{}", output: "preview only", output_ref: "fixture-output", output_size: WHOLE_OUTPUT.length });
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    ts: index % 3 === 0 ? null : "2026-10-12T00:00:00.000Z",
    parts,
  };
}
function longChat(): ConversationTurn[] {
  const say = (role: ConversationTurn["role"], text: string): ConversationTurn => ({ role, ts: "2026-10-12T00:00:00.000Z", parts: [{ kind: "text", text }] });
  const table = `| n | squared | cubed |\n|---|---|---|\n${Array.from({ length: 80 }, (_, n) => `| ${n + 1} | ${(n + 1) ** 2} | ${(n + 1) ** 3} |`).join("\n")}`;
  return [
    say("user", "Print the numbers from 1 to 400."),
    say("assistant", Array.from({ length: 400 }, (_, n) => String(n + 1)).join("\n")),
    ...Array.from({ length: 11 }, (_, n) => say(n % 2 ? "assistant" : "user", `Turn ${n + 2}. ${"A short line of text. ".repeat(n % 2 ? 3 : 1)}`)),
    say("assistant", `The table has 80 rows.\n\n${table}`),
    say("user", "Print the 24 Greek letter names."),
    say("user", "Now end with the marker."),
    say("assistant", `${Array.from({ length: 24 }, (_, n) => `Letter ${n + 1}`).join("\n\n")}\n\nLONG-CHAT-END`),
  ];
}
async function metrics(page: Page) {
  return page.locator(".chat-view").evaluate((element) => {
    const root = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>("[data-chat-row]")];
    const visible = rows.filter((row) => {
      const box = row.getBoundingClientRect();
      return box.bottom > root.top && box.top < root.bottom;
    }).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const first = visible[0];
    return {
      mounted: rows.length,
      keys: rows.map((row) => row.dataset.chatRow),
      bottom: element.scrollHeight - element.clientHeight - element.scrollTop,
      top: element.scrollTop,
      anchor: first ? { key: first.dataset.chatRow, y: first.getBoundingClientRect().top, text: first.textContent } : null,
    };
  });
}
async function settleBottom(page: Page) {
  await page.waitForFunction(() => {
    const node = document.querySelector(".chat-view");
    return node && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
  });
}
/**
 * The reader scrolls to the end until they are there. One jump from far up, with a row held (a selection or a
 * focused button pins it), can land short: the rows it brings into view are measured after it, and on a phone's
 * narrow rows the end then lay 6642 px further on, with nothing moving the view in the 15 s that followed (seen
 * locally once in 18 runs, as in CI). A reader scrolls again from there, as this does each frame.
 */
async function readToBottom(page: Page) {
  await page.waitForFunction(() => {
    const node = document.querySelector<HTMLElement>(".chat-view");
    if (!node) return false;
    // the rows a scroll brings in are measured a frame or more after it: the end counts once the view has stayed
    // at it through ten frames in a row, not on the first frame that reads it there
    const atEnd = node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
    const qa = window as { qaAtEnd?: number };
    if (!atEnd) { node.scrollTop = node.scrollHeight; qa.qaAtEnd = 0; return false; }
    qa.qaAtEnd = (qa.qaAtEnd ?? 0) + 1;
    if (qa.qaAtEnd < 10) return false;
    qa.qaAtEnd = 0;
    return true;
  }, undefined, { polling: "raf" });
}
async function settled(page: Page): Promise<number> {
  return await page.evaluate(() => new Promise<number>((resolve) => {
    let last = "", same = 0;
    const sample = () => {
      const node = document.querySelector<HTMLElement>(".chat-view")!;
      const now = `${node.scrollTop}:${node.scrollHeight}`;
      same = now === last ? same + 1 : 0;
      last = now;
      if (same >= 20) resolve(node.scrollTop);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }));
}
async function toFollowedEnd(page: Page, jump: Locator) {
  await jump.click();
  await jump.waitFor({ state: "detached" });
  // the list's own scroll to its end can stop short by less than the layout allowance, which the chat
  // follows from: the reader, following now, scrolls the rest of the way
  await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await settleBottom(page);
  await page.waitForFunction(() => (JSON.parse(sessionStorage.getItem("ovis:chat-positions") ?? "[]") as [string, { atEnd: boolean }][]).some(([id, place]) => id === "same-pane" && place.atEnd));
}
async function update(page: Page) {
  const response = page.waitForResponse((response) => response.url().includes("/conversation?") && !new URL(response.url()).searchParams.has("before"));
  await page.evaluate(() => window.chatQa.refresh());
  await (await response).finished();
}
async function shot(page: Page, name: string) {
  if (evidence) await page.screenshot({ path: join(evidence, `chat-virtual-${name}.png`) });
}
async function visibleMessage(page: Page, text: string) {
  await page.waitForFunction((text) => {
    const root = document.querySelector(".chat-view")?.getBoundingClientRect();
    return root && [...document.querySelectorAll(".chat-view p")].some((node) => {
      const box = node.getBoundingClientRect();
      return node.textContent === text && box.top >= root.top - 1 && box.bottom <= root.bottom + 1;
    });
  }, text);
}
async function reveal(page: Page, text: string) {
  const target = Number(/ROW-(-?\d+)$/.exec(text)?.[1]);
  const deadline = Date.now() + 15_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const found = await page.locator(".chat-view").evaluate((node, { text, target }) => {
      const hit = [...node.querySelectorAll("p")].find((p) => p.textContent === text);
      if (hit) { hit.scrollIntoView({ block: "center" }); return true; }
      const view = node.getBoundingClientRect();
      const shown = [...node.querySelectorAll("p")].filter((p) => {
        const box = p.getBoundingClientRect();
        return box.bottom > view.top && box.top < view.bottom;
      }).map((p) => Number(/ROW-(-?\d+)$/.exec(p.textContent ?? "")?.[1])).filter(Number.isFinite);
      if (!shown.length) { node.scrollTop -= node.clientHeight / 2; return false; }
      const low = Math.min(...shown), high = Math.max(...shown);
      const rowHeight = node.clientHeight / Math.max(1, high - low + 1);
      const rows = target < low ? target - low : target - high;
      node.scrollTop = Math.max(0, node.scrollTop + Math.sign(rows) * Math.max(rowHeight, Math.abs(rows) * rowHeight * 0.7));
      return { low, high, top: node.scrollTop };
    }, { text, target });
    if (found === true) return visibleMessage(page, text);
    last = found;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  throw new Error(`Row never mounted: ${text} ${JSON.stringify(last)}`);
}
async function selectionState(page: Page) {
  return page.evaluate(() => {
    const selection = getSelection();
    const row = (node: Node | null | undefined) => (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>("[data-chat-row]")?.dataset.chatRow;
    return {
      text: selection?.toString(),
      anchor: { row: row(selection?.anchorNode), text: selection?.anchorNode?.textContent?.slice(0, 80), offset: selection?.anchorOffset },
      focus: { row: row(selection?.focusNode), text: selection?.focusNode?.textContent?.slice(0, 80), offset: selection?.focusOffset },
    };
  });
}
try {
  const build = await Bun.build({
    entrypoints: ["scripts/chat-virtual-fixture.tsx"], outdir: root, target: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/pane/conversation/tool-output")) { wholeReads++; return new Response(WHOLE_OUTPUT); }
    if (url.pathname.endsWith("/pane/commands")) return Response.json({ commands: [] });
    if (url.pathname.endsWith("/pane/conversation") && url.pathname.includes("/machines/fold/")) {
      return Response.json({ source: "claude-transcript", history_id: "fold:1", cursor: null, turns: foldChat() });
    }
    if (url.pathname.endsWith("/pane/conversation") && url.pathname.includes("/machines/long/")) {
      longRead.asked.resolve();
      await longRead.answer.promise;
      return Response.json({ source: "claude-transcript", history_id: "long:1", cursor: null, turns: longChat() });
    }
    if (url.pathname.endsWith("/pane/conversation")) {
      const machine = url.pathname.includes("/machines/remote/") ? "remote" : "local";
      const older = url.searchParams.has("before");
      if (url.searchParams.get("before") === "window:2") {
        slideReads++;
        assert.equal(url.searchParams.get("since"), beginsAtOrigin ? null : "older:0");
        return Response.json({
          source: "omp-transcript", history_id: `${machine}:${epoch}`,
          cursor: beginsAtOrigin ? null : "older:0",
          turns: [turn(0, machine), turn(1, machine)],
        });
      }
      const page = Number(url.searchParams.get("before")?.split(":")[1] ?? 0);
      if (!older && streamedParagraphs !== null && streamedParagraphs < STREAMED_PARAGRAPHS) streamedParagraphs++;
      if (older) {
        olderReads++;
      }
      if (older && holdOlder) await new Promise<void>((resolve) => {
        olderReleases.push(resolve);
        olderEvents.dispatchEvent(new Event("requested"));
      });
      return Response.json({
        source: "omp-transcript", history_id: `${machine}:${epoch}`, cursor: older ? page === 0 ? "older:1" : null : newestStart ? "window:2" : beginsAtOrigin ? null : "older:0",
        turns: Array.from({ length: older ? 20 : 1000 }, (_, index) => turn(older ? index - (page + 1) * 20 : index + newestStart, machine)),
      });
    }
    if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat virtualization QA</title><link rel="stylesheet" href="/chat-virtual-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-virtual-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, url.pathname.slice(1))));
  } });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const [width, status, reducedMotion] of [[1440, "idle", "no-preference"], [390, "idle", "no-preference"], [1440, "working", "no-preference"], [390, "working", "no-preference"], [1440, "working", "reduce"], [390, "working", "reduce"]] as const) {
    longRead = { asked: Promise.withResolvers<void>(), answer: Promise.withResolvers<void>() };
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: "en-US", reducedMotion });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15_000);
    await throttled(page);
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByText("REVISION-0", { exact: true }).waitFor();
    await page.evaluate((narrow) => window.chatQa.resize(543, narrow ? 478 : undefined), width > 478);
    await page.evaluate((status) => { window.chatQa.status(status); window.chatQa.machine("long"); }, status);
    const unasked = setTimeout(() => longRead.asked.reject(new Error("the long chat never asked for its conversation")), 15_000);
    await longRead.asked.promise;
    clearTimeout(unasked);
    await page.evaluate(async () => {
      const frames: { gap: number; newestInView: boolean }[] = [];
      Object.assign(window, { longLanding: new Promise((resolve) => {
        let last = "", same = 0, ticks = 0;
        const sample = () => {
          ticks++;
          const node = document.querySelector<HTMLElement>(".chat-view");
          const end = [...node?.querySelectorAll("p") ?? []].find((p) => p.textContent === "LONG-CHAT-END");
          if (node && node.querySelector("[data-chat-row]")) {
            const view = node.getBoundingClientRect(), box = end?.getBoundingClientRect();
            frames.push({ gap: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop), newestInView: box !== undefined && box.top >= view.top - 1 && box.bottom <= view.bottom + 1 });
            const now = `${node.scrollTop}:${node.scrollHeight}`;
            same = now === last ? same + 1 : 0;
            last = now;
          }
          if (same >= 20 || ticks >= 600) resolve(frames);
          else requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }) });
      for (let frame = 0; frame < 3; frame++) await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    longRead.answer.resolve();
    const landing = await page.evaluate(() => (window as unknown as { longLanding: Promise<{ gap: number; newestInView: boolean }[]> }).longLanding);
    const short = landing.filter((frame) => frame.gap > 1 || !frame.newestInView);
    assert.ok(landing.length > 0 && short.length === 0, `a long chat's first open (${status}, ${reducedMotion} motion) shows its newest message in every frame until it settles: ${short.length} of ${landing.length} frames short, last ${JSON.stringify(landing.at(-1))}`);
    console.log(`PASS ${width} ${status} ${reducedMotion}: a long chat's first open shows its newest message in all ${landing.length} frames until it settles`);
    await context.close();
  }
  {
    longRead = { asked: Promise.withResolvers<void>(), answer: Promise.withResolvers<void>() };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15_000);
    await throttled(page);
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByText("REVISION-0", { exact: true }).waitFor();
    await page.evaluate(() => window.chatQa.resize(543, 478));
    await page.evaluate(() => { window.chatQa.status("idle"); window.chatQa.machine("long"); });
    const unasked = setTimeout(() => longRead.asked.reject(new Error("the long chat never asked for its conversation")), 15_000);
    await longRead.asked.promise;
    clearTimeout(unasked);
    await page.evaluate(() => {
      const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
      const state = { wheeled: false };
      Object.assign(window, { wheelDuringJump: state });
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true, get() { return scrollTop.get!.call(this); },
        set(this: Element, value: number) {
          scrollTop.set!.call(this, value);
          if (state.wheeled || !this.classList.contains("chat-view") || this.scrollHeight <= this.clientHeight || value !== this.scrollHeight) return;
          state.wheeled = true;
          Object.defineProperty(Element.prototype, "scrollTop", scrollTop);
          // the wheel comes as the next task, as input does, before the frame that sends the write's scroll event
          const input = new MessageChannel();
          input.port1.onmessage = () => {
            (this.querySelector("[data-chat-row]") ?? this).dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
            scrollTop.set!.call(this, scrollTop.get!.call(this) - 120);
          };
          input.port2.postMessage(null);
        },
      });
    });
    longRead.answer.resolve();
    await page.waitForFunction(() => (window as unknown as { wheelDuringJump: { wheeled: boolean } }).wheelDuringJump.wheeled);
    const gap = await page.evaluate(() => new Promise<number>((resolve) => {
      let last = "", same = 0;
      const sample = () => {
        const node = document.querySelector<HTMLElement>(".chat-view")!;
        const now = `${node.scrollTop}:${node.scrollHeight}`;
        same = now === last ? same + 1 : 0;
        last = now;
        if (same >= 20) resolve(Math.round(node.scrollHeight - node.clientHeight - node.scrollTop));
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    assert.ok(gap >= 100, `a wheel up during a long chat's first-open jump to the end is kept: the view settled ${gap}px from the end`);
    assert.ok(await page.getByRole("button", { name: "Jump to latest" }).isVisible(), "a reader who wheeled up during the first-open jump is no longer following the end");
    console.log(`PASS a wheel up during a long chat's first-open jump keeps the reader ${gap}px from the end`);
    await context.close();
  }
  for (const width of [1440, 390] as const) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: "en-US" });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" })));
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15_000);
    await throttled(page);
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByText("REVISION-0", { exact: true }).waitFor();
    await page.evaluate(() => { window.chatQa.status("idle"); window.chatQa.machine("fold"); });
    await page.getByText("FOLD-CHAT-END", { exact: true }).waitFor();
    const newest = page.locator("[data-chat-row]").filter({ hasText: "FOLD-CHAT-END" });
    const block = newest.locator(".work-block-head");
    if (await block.getAttribute("aria-expanded") === "false") await block.click();
    const testRow = newest.locator(".work-row").filter({ has: page.locator(".work-row-head", { hasText: "bun test" }) });
    await testRow.locator(".work-row-head").click();
    const more = testRow.locator(".chat-tool-result-more");
    await more.waitFor();
    const jump = page.locator(".chat-virtual-jump");
    if (await jump.count() > 0) { await jump.click(); await jump.waitFor({ state: "detached" }); }
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await settleBottom(page);
    assert.equal(await jump.count(), 0, "the reader follows the end before unfolding");
    const before = await page.locator(".chat-view").evaluate((node) => node.scrollTop);
    await more.click();
    await testRow.locator(".chat-tool-result-more[aria-expanded=true]").waitFor();
    const after = await settled(page);
    assert.ok(Math.abs(after - before) <= 1, `unfolding the newest output keeps a following reader where they were: ${before} -> ${after}`);
    console.log(`PASS ${width}: unfolding the newest tool output at the end stops following and keeps the view`);
    // The list's own scroll to the end is not over once it has moved the view: for 100 ms more it
    // keeps that end in view as rows change size. A reader who unfolds the output within that time
    // reads it too, and is not scrolled past it. The output is folded again where the reader
    // stands, which leaves the view at the end: Jump to latest then moves nothing, so no scroll
    // event ends the list's scroll early, and the unfold comes in the frame after that scroll starts.
    await testRow.locator(".chat-tool-result-more[aria-expanded=true]").dispatchEvent("click");
    await testRow.locator(".chat-tool-result-more[aria-expanded=false]").waitFor();
    await settled(page);
    await more.evaluate((button) => {
      const view = button.closest(".chat-view")!;
      const unfold: { from: number | null } = { from: null };
      Object.assign(window, { unfoldDuringListScroll: unfold });
      const scrollTo = Element.prototype.scrollTo;
      Element.prototype.scrollTo = function (this: Element, ...args: [ScrollToOptions?] | [number, number]) {
        (scrollTo as (this: Element, ...args: unknown[]) => void).apply(this, args);
        // the list scrolls the chat with behavior "auto"
        const [options] = args;
        if (this !== view || typeof options !== "object" || options.behavior !== "auto") return;
        Element.prototype.scrollTo = scrollTo;
        requestAnimationFrame(() => {
          unfold.from = view.scrollTop;
          button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
        });
      };
    });
    await jump.click();
    await testRow.locator(".chat-tool-result-more[aria-expanded=true]").waitFor();
    const rested = await settled(page);
    const from = await page.evaluate(() => (window as unknown as { unfoldDuringListScroll: { from: number | null } }).unfoldDuringListScroll.from);
    assert.ok(from !== null && Math.abs(rested - from) <= 1, `unfolding an output while the list's own scroll to the end is on its way keeps the reader where they were: ${from} -> ${rested}`);
    assert.ok(await jump.count() > 0, "a reader who unfolded an output while the list's scroll to the end was on its way is no longer following it");
    console.log(`PASS ${width}: unfolding an output while the list's own scroll to the end is on its way keeps the view`);
    await jump.click();
    await jump.waitFor({ state: "detached" });
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await settleBottom(page);
    const less = testRow.locator(".chat-tool-result-more[aria-expanded=true]");
    assert.ok(await less.evaluate((node) => {
      const box = node.getBoundingClientRect(), view = document.querySelector(".chat-view")!.getBoundingClientRect();
      return box.top >= view.top && box.bottom <= view.bottom;
    }), "Show less is in view at the end, so its click scrolls nothing first");
    await less.click();
    await testRow.locator(".chat-tool-result-more[aria-expanded=false]").waitFor();
    await settled(page);
    const folded = { away: await page.locator(".chat-view").evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop > 1), jump: await jump.count() > 0 };
    assert.deepEqual(folded, { away: false, jump: false }, "a following reader who folds an output stays at the end, following");
    console.log(`PASS ${width}: folding an output while following the end keeps the reader at the end, following`);
    // the folded tail stays in the page, drawn as nothing, so the browser's find reaches it; a match
    // there (the browser's beforematch) unfolds the output
    const testOutput = testRow.locator(".chat-tool-result");
    const tail = testOutput.locator(".chat-tool-result-tail");
    assert.equal(await tail.getAttribute("hidden"), "until-found");
    assert.ok((await testOutput.textContent())?.endsWith("(pass) test 100"), "the folded tail is in the page");
    assert.ok(!(await testOutput.evaluate((node) => (node as HTMLElement).innerText)).includes("(pass) test 100"), "the folded tail is not drawn");
    assert.equal(await tail.evaluate((node) => node.getBoundingClientRect().height), 0, "the folded tail takes no room");
    await tail.evaluate((node) => node.dispatchEvent(new Event("beforematch")));
    await testRow.locator(".chat-tool-result-more[aria-expanded=true]").waitFor();
    assert.ok((await testOutput.evaluate((node) => (node as HTMLElement).innerText)).includes("(pass) test 100"), "a find match in the tail unfolds the output");
    console.log(`PASS ${width}: a folded output's tail stays findable and a match unfolds it`);
    const longLine = newest.locator(".work-row").filter({ has: page.locator(".work-row-head", { hasText: "cat big.json" }) });
    await longLine.locator(".work-row-head").click();
    const longMore = longLine.locator(".chat-tool-result-more");
    await longMore.waitFor();
    const shown = await longLine.locator(".chat-tool-result").evaluate((node) => ({ length: (node as HTMLElement).innerText.length, height: node.getBoundingClientRect().height }));
    assert.ok(shown.length < 5_000 && shown.height < 900, `a 100 KB single-line output shows a capped preview: ${JSON.stringify(shown)}`);
    await longMore.focus();
    await page.keyboard.press("Enter");
    await longLine.locator(".chat-tool-result-more[aria-expanded=true]").waitFor();
    assert.equal(await longLine.locator(".chat-tool-result").evaluate((node) => node.textContent?.length), LONG_LINE_OUTPUT.length);
    const focused = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const view = document.querySelector(".chat-view")!.getBoundingClientRect();
      const box = active?.getBoundingClientRect();
      return { output: active?.classList.contains("chat-tool-result") ?? false, inView: box !== undefined && box.top < view.bottom && box.bottom > view.top };
    });
    assert.deepEqual(focused, { output: true, inView: true }, "a keyboard unfold moves the focus to the output it reveals, in view");
    await page.keyboard.press("Tab");
    assert.ok(await longLine.locator(".chat-tool-result-more[aria-expanded=true]").evaluate((node) => node === document.activeElement), "Tab from the revealed output reaches the button that folds it");
    await longLine.locator(".chat-tool-more").click();
    await longLine.locator(".chat-tool-io.is-whole").waitFor();
    assert.equal(await longLine.locator(".chat-tool-result-more").getAttribute("aria-expanded"), "false", "the whole output opens folded, whatever the preview was");
    console.log(`PASS ${width}: a single 100 KB line folds by its length; a keyboard unfold keeps the focus in view; its whole output opens folded`);
    await context.close();
  }
  for (const [width, theme] of [[1440, "dark"], [1440, "light"], [390, "dark"], [390, "light"]] as const) {
    revision = 0; epoch = 1; holdOlder = false; olderReads = 0; wholeReads = 0;
    newestStart = 0; beginsAtOrigin = false; slideReads = 0;
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, colorScheme: theme, locale: "en-US" });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await context.addInitScript((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })), theme);
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message); console.error(error.message); });
    await throttled(page);
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByText("REVISION-0", { exact: true }).waitFor();
    await settleBottom(page);
    const initial = await metrics(page);
    assert.ok(initial.mounted > 0 && initial.mounted < 80, JSON.stringify(initial));
    assert.equal(new Set(initial.keys).size, initial.keys.length, "duplicate/null timestamps do not collide");
    await shot(page, `latest-${width}-${theme}`);
    console.log(`PASS ${width} ${theme}: 1000 logical rows initially mount ${initial.mounted}, at latest`);

    for (const input of ["down-wheel", "horizontal-wheel", "click", "typing", "down-key", "body-composing-up-key", "body-composing-home", "body-229-up-key", "body-229-home", "scrollbar-released", "scrollbar-unseen-release", "scrollbar-held-still", "scrollbar-blurred", "up-wheel", "body-up-key", "body-page-up", "body-home", "body-shift-space", "drag", "scrollbar-held", "scrollbar-held-released-first"] as const) {
      const upward = ["up-wheel", "body-up-key", "body-page-up", "body-home", "body-shift-space", "drag", "scrollbar-held", "scrollbar-held-released-first"].includes(input);
      await page.locator(".chat-view").evaluate(async (node, input) => {
        if (!(node instanceof HTMLElement)) throw new Error("Missing chat scroller");
        const text = node.querySelector("p");
        if (!text) throw new Error("Missing transcript text");
        const bar = node.getBoundingClientRect();
        const pressed = { clientX: bar.left + node.clientWidth, clientY: bar.bottom - 20 };
        const letGo = (dragged: boolean) => node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: pressed.clientX, clientY: pressed.clientY - (dragged ? 20 : 0) }));
        // The list hands a scroll to the chat at once only while it settles a data change (its anchor
        // lock lasts 300 ms), otherwise in an animation frame it asks for first: awaiting the next
        // frame awaits that delivery. A loaded runner gets here after the lock has lapsed.
        const delivered = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        node.dispatchEvent(new Event("scroll"));
        await delivered();
        if (input.endsWith("wheel")) text.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: input === "up-wheel" ? -20 : input === "down-wheel" ? 20 : 0, deltaX: input === "horizontal-wheel" ? 20 : 0 }));
        else if (input === "click" || input === "drag") {
          text.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1, clientY: 100 }));
          if (input === "drag") text.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 1, clientY: 110 }));
          if (input === "click") text.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        } else if (input.startsWith("scrollbar-")) {
          node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1, ...pressed }));
          if (input === "scrollbar-released") letGo(false);
          // released outside the window: no pointerup, and the next pointer event has no button down
          if (input === "scrollbar-unseen-release") document.body.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, buttons: 0 }));
          if (input === "scrollbar-blurred") window.dispatchEvent(new Event("blur"));
        } else {
          const key = input.endsWith("up-key") ? "ArrowUp" : input === "body-page-up" ? "PageUp" : input.endsWith("home") ? "Home" : input === "body-shift-space" ? " " : input === "down-key" ? "ArrowDown" : "a";
          const target = input.startsWith("body-") ? document.body : text;
          target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key, shiftKey: input === "body-shift-space", isComposing: input.includes("composing"), keyCode: input.includes("229") ? 229 : 0 }));
        }
        // a dragged thumb sends no pointermove: the move comes after the 500 ms input window
        const now = performance.now.bind(performance);
        if (input.startsWith("scrollbar-")) Object.defineProperty(performance, "now", { configurable: true, value: () => now() + 600 });
        node.scrollTop -= 20;
        // the thumb let go before the browser delivered the scroll its drag made
        if (input === "scrollbar-held-released-first") letGo(true);
        node.dispatchEvent(new Event("scroll"));
        // the chat reads the clock when the scroll reaches it: the rest lasts until then
        await delivered();
        Reflect.deleteProperty(performance, "now");
        if (input === "drag") text.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        if (input === "scrollbar-held" || input === "scrollbar-blurred") letGo(true);
        if (input === "scrollbar-held-still") letGo(false);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }, input);
      revision++;
      await update(page);
      await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "New messages" }).count(), upward ? 1 : 0, `${input}: only upward input stops following`);
      if (upward) {
        assert.ok((await metrics(page)).bottom > 1, `${input}: output leaves the reader away from the end`);
        await page.getByRole("button", { name: "New messages" }).click();
      }
      await settleBottom(page);
    }
    console.log(`PASS ${width} ${theme}: upward wheel, document navigation and dragging stop follow; downward input and clicks do not`);

    for (revision = 1; revision <= 100; revision++) {
      await update(page);
      await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
      await settleBottom(page);
    }
    console.log(`PASS ${width} ${theme}: 100 immutable streaming revisions retain bottom`);

    for (const change of ["fold-above", "grow-above", "fold-together", "wheel-up"] as const) {
      const reading = change === "wheel-up";
      const landed = await page.locator(".chat-view").evaluate(async (node, change) => {
        if (!(node instanceof HTMLElement)) throw new Error("Missing chat scroller");
        const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const gap = () => node.scrollHeight - node.clientHeight - node.scrollTop;
        const scrolled = () => new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { node.removeEventListener("scroll", seen); resolve(false); }, 2_000);
          const seen = () => { clearTimeout(timer); resolve(true); };
          node.addEventListener("scroll", seen, { once: true });
        });
        const moves: string[] = [];
        const note = () => moves.push(`${Math.round(node.scrollTop)}/${Math.round(gap())}`);
        node.addEventListener("scroll", note);
        const fail = (what: string) => new Error(`${change}: ${what}: ${JSON.stringify({ gap: Math.round(gap()), moves: moves.slice(-12) })}`);
        const view = node.getBoundingClientRect();
        const rows = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        const above = rows.filter((row) => row.getBoundingClientRect().bottom < view.top).at(-1);
        const last = rows.at(-1);
        if (!above || !last) throw fail("rows above the view and at the end are missing");
        const block = document.createElement("div");
        block.className = "qa-row-height";
        const folds = change === "fold-above" || change === "fold-together";
        block.style.height = folds ? "400px" : "0px";
        if (folds) {
          const moved = scrolled();
          above.append(block);
          if (!await moved) throw fail("the list did not hold the view for a taller row above");
        } else above.append(block);
        for (let i = 0; i < 120 && gap() > 1; i++) await frame();
        if (gap() > 1) throw fail("not at the end before the last row grows");
        if (change === "fold-together") {
          const work = document.createElement("div");
          work.className = "qa-row-height";
          work.style.height = "600px";
          last.append(work);
          for (let i = 0; i < 300 && (gap() > 1 || last.getBoundingClientRect().bottom > node.getBoundingClientRect().bottom + 1); i++) await frame();
          if (gap() > 1) throw fail("not at the end of the grown last row");
          block.style.height = "0px";
          work.style.height = "0px";
          for (let i = 0; i < 300 && gap() > 1 && !document.querySelector(".chat-new-messages"); i++) await frame();
          node.removeEventListener("scroll", note);
          return { gap: Math.round(gap()), stopped: document.querySelector(".chat-new-messages") !== null, moves: moves.slice(-12) };
        }
        const growth = document.createElement("div");
        growth.className = "qa-row-height";
        growth.style.height = "600px";
        const moved = scrolled();
        last.append(growth);
        if (!await moved && (gap() > 1 || last.getBoundingClientRect().bottom > node.getBoundingClientRect().bottom + 1)) throw fail("the grown last row was not followed");
        await frame();
        if (change === "wheel-up") {
          node.removeEventListener("scroll", note);
          return { gap: Math.round(gap()), stopped: false, moves: moves.slice(-12) };
        }
        block.style.height = change === "fold-above" ? "0px" : "400px";
        for (let i = 0; i < 300 && gap() > 1 && !document.querySelector(".chat-new-messages"); i++) await frame();
        node.removeEventListener("scroll", note);
        return { gap: Math.round(gap()), stopped: document.querySelector(".chat-new-messages") !== null, moves: moves.slice(-12) };
      }, change);
      if (reading) {
        await settleBottom(page);
        const box = await page.locator(".chat-view").boundingBox();
        assert.ok(box);
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, -300);
        await page.getByRole("button", { name: "Jump to latest" }).waitFor();
      } else {
        assert.equal(landed.stopped, false, `${change}: following goes on: ${JSON.stringify(landed)}`);
        assert.ok(landed.gap <= 1, `${change}: following reached the end: ${JSON.stringify(landed)}`);
      }
      revision++;
      await update(page);
      await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "New messages" }).count(), reading ? 1 : 0, `${change}: the next output ${reading ? "leaves the reader where they went" : "is followed"}`);
      if (reading) assert.ok((await metrics(page)).bottom > 1, `${change}: output leaves the reader away from the end`);
      else await settleBottom(page);
      await page.evaluate(() => document.querySelectorAll(".qa-row-height").forEach((block) => block.remove()));
      if (reading) {
        const back = page.getByRole("button", { name: "New messages" });
        if (await back.count()) await back.click({ timeout: 2_000 }).catch(async (error: unknown) => { if (await back.count()) throw error; });
      }
      await settleBottom(page);
    }
    console.log(`PASS ${width} ${theme}: a grown last row is followed; a row above folding or growing then keeps following, as does a fold at the end; an upward wheel stops it`);

    // A screen reader or Firefox scrollbar can scroll without delivering input to ChatView.
    // On an unchanged transcript, even small steps stop following once they pass 48 px (#1902).
    await page.locator(".chat-view").evaluate(async (node) => {
      const delivered = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      for (const step of [30, 30]) {
        node.scrollTop -= step;
        node.dispatchEvent(new Event("scroll"));
        await delivered();
      }
    });
    await page.getByRole("button", { name: "Jump to latest" }).waitFor();
    revision++;
    await update(page);
    await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "New messages" }).count(), 1, "small steps without input past the allowance stop following");
    assert.ok((await metrics(page)).bottom > 48, "output leaves the reader where the steps took them");
    await page.getByRole("button", { name: "New messages" }).click();
    await settleBottom(page);
    console.log(`PASS ${width} ${theme}: small upward steps without input past the layout allowance stop following (#1902)`);

    const height = width === 390 ? 844 : 900;
    await page.evaluate((height) => window.chatQa.resize(height - 180), height);
    await page.waitForFunction((height) => document.querySelector(".terminal-stack")?.getBoundingClientRect().height === height - 180, height);
    await settleBottom(page);
    await page.evaluate((height) => window.chatQa.resize(height), height);
    await settleBottom(page);
    // #1205: a composer that grows a line shrinks the view; the frame painted next is already at
    // the end. An observer made after ChatView's runs after it, before that paint.
    const painted = await page.evaluate(async (height) => {
      const node = document.querySelector(".chat-view")!;
      const offsets: number[] = [];
      const observer = new ResizeObserver(() => offsets.push(Math.round(node.scrollHeight - node.clientHeight - node.scrollTop)));
      observer.observe(node);
      // waits until the observer has delivered `count` sizes; its first is the size it started with
      const observed = async (count: number) => {
        const deadline = performance.now() + 5_000;
        while (offsets.length < count) {
          if (performance.now() > deadline) throw new Error(`no resize observed: ${JSON.stringify(offsets)}`);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      };
      await observed(1);
      const start = offsets.length;
      for (const line of [1, 2, 3]) {
        window.chatQa.resize(height - 22 * line);
        await observed(start + line);
      }
      observer.disconnect();
      return offsets.slice(start);
    }, height);
    assert.ok(painted.length === 3 && painted.every((offset) => offset <= 1), `a growing composer keeps the painted frame at the end: ${JSON.stringify(painted)}`);
    await page.evaluate((height) => window.chatQa.resize(height), height);
    await settleBottom(page);
    console.log(`PASS ${width} ${theme}: a composer growing a line paints no frame off the end`);
    assert.ok(await page.locator(".chat-view").evaluate((node) => node.scrollWidth <= node.clientWidth), "production terminal hierarchy has no horizontal overflow");

    await page.evaluate(() => window.chatQa.page(-1));
    // The reader's place is read once the list has drawn the rows the PageUp uncovered: on a loaded
    // runner it draws them a frame or more after the scroll, and until then the view's top is blank.
    // Those rows come in at their estimated heights and the list holds them, so the first row drawn
    // before them is not a place it keeps.
    await page.waitForFunction(() => {
      const view = document.querySelector<HTMLElement>(".chat-view")!;
      const top = view.getBoundingClientRect().top;
      return [...view.querySelectorAll<HTMLElement>("[data-chat-row]")].some((row) => { const box = row.getBoundingClientRect(); return box.top <= top + 1 && box.bottom > top; });
    });
    const away = await metrics(page);
    assert.ok(away.bottom > 1 && away.anchor);
    revision = 101;
    await update(page);
    await page.getByRole("button", { name: "New messages" }).waitFor();
    const after = await metrics(page);
    const anchorY = await page.evaluate((key) => [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.dataset.chatRow === key)?.getBoundingClientRect().top, away.anchor.key);
    assert.ok(anchorY !== undefined && Math.abs(anchorY - away.anchor.y) <= 1, JSON.stringify({ away, after, anchorY }));
    await page.evaluate((height) => window.chatQa.resize(height - 180), height);
    await page.waitForFunction((height) => document.querySelector(".terminal-stack")?.getBoundingClientRect().height === height - 180, height);
    const resizedY = await page.evaluate((key) => [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.dataset.chatRow === key)?.getBoundingClientRect().top, away.anchor.key);
    assert.ok(resizedY !== undefined && Math.abs(resizedY - away.anchor.y) <= 1, "composer-height change preserves the reading anchor");
    await page.evaluate((height) => window.chatQa.resize(height), height);
    await page.getByRole("button", { name: "New messages" }).click();
    await settleBottom(page);
    console.log(`PASS ${width} ${theme}: PageUp stays at its anchor through output and explicit latest rearms follow`);

    holdOlder = true;
    const requested = new Promise<void>((resolve, reject) => {
      const received = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { olderEvents.removeEventListener("requested", received); reject(new Error("Older request missing")); }, 10_000);
      olderEvents.addEventListener("requested", received, { once: true });
    });
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = 0; });
    await requested;
    await page.getByText("local E1 ROW-0", { exact: true }).waitFor();
    const beforePrepend = await metrics(page);
    assert.ok(beforePrepend.anchor);
    holdOlder = false;
    olderReleases.splice(0).forEach((release) => release());
    await page.getByRole("button", { name: "Earlier messages", exact: true }).waitFor();
    await page.waitForFunction(({ key, y }) => {
      const row = [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.dataset.chatRow === key);
      return row !== undefined && Math.abs(row.getBoundingClientRect().top - y) <= 1;
    }, beforePrepend.anchor, { timeout: 2000 });
    const prependY = await page.evaluate((key) => [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((row) => row.dataset.chatRow === key)?.getBoundingClientRect().top, beforePrepend.anchor.key);
    assert.ok(prependY !== undefined && Math.abs(prependY - beforePrepend.anchor.y) <= 1, JSON.stringify({ beforePrepend, prependY, now: await metrics(page) }));
    console.log(`PASS ${width} ${theme}: an accepted older page retains the same row and pixel offset`);

    const points = await page.evaluate(() => {
      const paragraph = (text: string) => [...document.querySelectorAll(".chat-view p")].find((node) => node.textContent === text);
      const edge = (paragraph: Element | undefined, last: boolean) => {
        if (!paragraph) return null;
        const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
        const nodes: Node[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.length) nodes.push(node);
        return last ? nodes.at(-1) ?? null : nodes[0] ?? null;
      };
      const start = edge(paragraph("local E1 ROW-0"), false);
      const end = edge(paragraph("local E1 ROW-1"), true);
      if (!start || !end) throw new Error("Selection paragraphs missing");
      const a = document.createRange(), b = document.createRange();
      a.setStart(start, 0); a.collapse(true);
      b.setStart(end, end.textContent?.length ?? 0); b.collapse(true);
      const first = a.getBoundingClientRect(), last = b.getBoundingClientRect();
      if (!first.height || !last.height) throw new Error(`Invisible drag endpoints: ${JSON.stringify({ first: first.toJSON(), last: last.toJSON(), start: start.textContent, end: end.textContent })}`);
      const points = { a: { x: first.left + 1, y: first.top + first.height / 2 }, b: { x: last.left + 1, y: last.top + last.height / 2 } };
      const hit = (point: { x: number; y: number }) => {
        const element = document.elementFromPoint(point.x, point.y);
        return { element: element?.outerHTML.slice(0, 300), userSelect: element ? getComputedStyle(element).userSelect : null };
      };
      return { ...points, from: hit(points.a), to: hit(points.b) };
    });
    await page.mouse.move(points.a.x, points.a.y);
    await page.mouse.down();
    const down = await selectionState(page);
    await page.mouse.move(points.b.x, points.b.y, { steps: 8 });
    const moved = await selectionState(page);
    await page.mouse.up();
    const selected = await page.evaluate(() => getSelection()?.toString() ?? "");
    assert.ok(selected.includes("ROW-0") && selected.includes("ROW-1") && selected.includes("\n\n"), `native selection includes both rows and blank lines: ${JSON.stringify({ selected, points, down, moved, up: await selectionState(page) })}`);
    assert.deepEqual(selected.split(/\n+/).map((line) => line.trim()).filter(Boolean), ["local E1 ROW-0", "Variable height paragraph.", "local E1 ROW-1"], "the visual range contains exactly its logical rows, not pool-slot order");
    await page.waitForFunction(() => Number(document.querySelector(".chat-view")?.getAttribute("data-chat-pinned")) >= 2);
    await page.locator(".chat-view").evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await page.getByText("REVISION-101", { exact: true }).waitFor();
    await settleBottom(page);
    revision = 102;
    await update(page);
    await page.getByText("REVISION-102", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => getSelection()?.toString()), selected, "offscreen selected rows survive immutable output");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+c" : "Control+c");
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), selected, "real copy preserves the native multi-row selection");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "0");
    assert.ok((await metrics(page)).mounted < 80);
    console.log(`PASS ${width} ${theme}: native drag selection and real copy survive eviction and streaming; pins release`);

    await reveal(page, "local E1 ROW-123");
    assert.ok((await metrics(page)).mounted < 80);
    await reveal(page, "local E1 ROW--40");
    await shot(page, `reveal-${width}-${theme}`);
    console.log(`PASS ${width} ${theme}: an offscreen row and an unloaded older page are reached by scrolling`);

    const boundarySelection = await page.evaluate(() => {
      const header = document.querySelector(".chat-virtual-header");
      const first = [...document.querySelectorAll(".chat-view p")].find((node) => node.textContent === "local E1 ROW--40");
      if (!header || !first) throw new Error("Boundary selection elements missing");
      const range = document.createRange();
      range.setStart(header, 0); range.setEnd(first, first.childNodes.length);
      getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
      return getSelection()?.toString();
    });
    assert.ok(boundarySelection?.includes("ROW--40"));
    await page.waitForFunction(() => Number(document.querySelector(".chat-view")?.getAttribute("data-chat-pinned")) > 0);
    await readToBottom(page);
    assert.equal(await page.evaluate(() => getSelection()?.toString()), boundarySelection, "selection with an endpoint outside a row survives scrolling");
    await page.evaluate(() => getSelection()?.removeAllRanges());
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "0");

    await reveal(page, "local E1 ROW-497");
    const work = page.locator("[data-chat-row]").filter({ hasText: "local E1 ROW-497" });
    await work.locator(".work-block-head").click();
    await work.locator(".work-row-head").click();
    // A click first scrolls its target into view, and rows above measured late can leave this button
    // just below the fold: that scroll is the click's, not the output's.
    await work.locator(".chat-tool-more").scrollIntoViewIfNeeded();
    const beforeOutput = await work.evaluate((row) => row.getBoundingClientRect().top);
    await work.locator(".chat-tool-more").click();
    await work.locator(".chat-tool-io.is-whole").waitFor();
    assert.notEqual(await work.locator(".chat-tool-io.is-whole").evaluate((node) => (node as HTMLElement).innerText), WHOLE_OUTPUT);
    assert.ok(Math.abs(await work.evaluate((row) => row.getBoundingClientRect().top) - beforeOutput) <= 1, "opening output does not skip past the expanded work");
    await work.locator(".chat-tool-result-more").click();
    assert.equal(await work.locator(".chat-tool-io.is-whole").textContent(), WHOLE_OUTPUT);
    assert.equal(wholeReads, 1);
    const focusButton = work.locator(".work-row-head");
    await focusButton.focus();
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "1");
    await readToBottom(page);
    assert.ok(await focusButton.evaluate((button) => button === document.activeElement), "offscreen focused button stays focused");
    await focusButton.evaluate((button) => button.blur());
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "0");

    // Make the viewport need more containers than the spare pool, so this checks
    // restoration after actual eviction rather than a cached offscreen DOM node.
    await page.setViewportSize({ width, height: 5000 });
    await page.evaluate(() => window.chatQa.resize(5000));
    await page.locator(".chat-view").evaluate((node) => {
      node.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -node.scrollTop }));
      node.scrollTop = 0;
    });
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-chat-row]")].some((row) => row.textContent?.includes("local E1 ROW-497")));
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate((height) => window.chatQa.resize(height), width === 390 ? 844 : 900);
    await reveal(page, "local E1 ROW-497");
    assert.equal(await work.locator(".work-block-head").getAttribute("aria-expanded"), "true");
    assert.equal(await work.locator(".work-row-head").getAttribute("aria-expanded"), "true");
    assert.equal(await work.locator(".chat-tool-io.is-whole").textContent(), WHOLE_OUTPUT, "an output the reader unfolded comes back unfolded");
    assert.equal(wholeReads, 1, "restored output is not fetched again");
    await shot(page, `restored-work-${width}-${theme}`);
    console.log(`PASS ${width} ${theme}: outside-row selection, focused row, disclosures and the whole output survive eviction`);

    // the reload below is a reader's who follows the end: one scrolled up gets their place back
    // (chatScrollMemory). The view at its end is not yet the chat's word that the reader follows it (a
    // reader who opened work stays away there, and a later scroll remembers a row): Jump to latest is,
    // and the place it remembers
    await toFollowedEnd(page, page.locator(".chat-virtual-jump"));
    await page.reload();
    await page.getByText("REVISION-102", { exact: true }).waitFor();
    await settleBottom(page);
    // A reopened chat's list has not measured all of its transcript yet (its footer, rows drawn taller
    // than estimated): its own scroll to the end aims short of the end the browser shows, and while
    // that scroll is on its way it holds the view there. Neither may leave a reader who follows the
    // end short of it, or take them for one who scrolled away. A box the list never measures makes its
    // end lag by more than the layout allowance, drawn after the footer or, as a row drawn taller than
    // measured reaches, past the bottom of the rows' wrapper; a view a pixel shorter has the chat
    // follow its end and the list scroll to its own.
    const chatHeight = width === 390 ? 844 : 900;
    for (const where of ["after the footer", "past the rows"] as const) {
      await page.locator(".chat-transcript-virtual").evaluate((content, where) => {
        const unmeasured = document.createElement("div");
        unmeasured.className = "qa-unmeasured";
        unmeasured.style.height = "100px";
        const rows = [...content.children].find((child) => child.querySelector("[data-chat-row]"));
        if (where === "past the rows" && rows instanceof HTMLElement) {
          Object.assign(unmeasured.style, { position: "absolute", left: "0", width: "1px", top: `${rows.offsetHeight}px` });
          rows.append(unmeasured);
        } else content.append(unmeasured);
      }, where);
      await page.evaluate((height) => window.chatQa.resize(height - 1), chatHeight);
      const lagging = await page.evaluate(() => new Promise<{ gaps: number[]; away: boolean }>((resolve) => {
        const node = document.querySelector<HTMLElement>(".chat-view")!;
        const gaps: number[] = [];
        let away = false, settled = 0;
        const frame = () => {
          const gap = Math.round(node.scrollHeight - node.clientHeight - node.scrollTop);
          gaps.push(gap);
          away ||= document.querySelector(".chat-virtual-jump") !== null;
          settled = gap <= 1 ? settled + 1 : 0;
          if (settled >= 3 || away || gaps.length >= 600) resolve({ gaps: gaps.slice(-12), away });
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }));
      assert.ok(!lagging.away && lagging.gaps.at(-1)! <= 1, `a scroll to the end the list measured short (${where}) still ends at the transcript's end, following: ${JSON.stringify(lagging)}`);
      await page.locator(".qa-unmeasured").evaluate((unmeasured) => unmeasured.remove());
      await page.evaluate((height) => window.chatQa.resize(height), chatHeight);
      await settleBottom(page);
    }
    console.log(`PASS ${width} ${theme}: a reopened chat whose list measured its end short lands at the end, following`);
    await page.evaluate(() => window.chatQa.machine("remote"));
    await page.getByText("remote E1 ROW-999", { exact: true }).waitFor();
    assert.ok((await metrics(page)).keys.every((key) => key?.includes('"remote"')), "same-pane remote rows have a separate identity scope");
    console.log(`PASS ${width} ${theme}: another PC does not inherit rows`);
    const remoteRow = page.locator("[data-chat-row]").filter({ hasText: "remote E1 ROW-999" });
    await remoteRow.evaluate((row) => {
      const range = document.createRange(); range.selectNodeContents(row);
      getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
    });
    await page.waitForFunction(() => Number(document.querySelector(".chat-view")?.getAttribute("data-chat-pinned")) > 0);
    epoch = 2;
    await update(page);
    await page.getByText("remote E2 ROW-999", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".chat-view")?.getAttribute("data-chat-pinned") === "0");
    assert.equal(await page.getByText("remote E1 ROW-999", { exact: true }).count(), 0);
    console.log(`PASS ${width} ${theme}: history replacement releases selected old rows`);
    for (const origin of [false, true]) {
      newestStart = 0; beginsAtOrigin = origin; epoch = 1;
      await page.reload();
      await settleBottom(page);
      await reveal(page, "local E1 ROW-497");
      const retained = page.locator("[data-chat-row]").filter({ hasText: "local E1 ROW-497" });
      await retained.locator(".work-block-head").click();
      await retained.locator(".work-row-head").click();
      const identity = await retained.getAttribute("data-chat-row");
      const selectedText = await retained.evaluate((row) => {
        const paragraph = [...row.querySelectorAll("p")].find((p) => p.textContent === "local E1 ROW-497");
        if (!paragraph) throw new Error("Sliding-page selection target missing");
        const range = document.createRange(); range.selectNodeContents(paragraph);
        getSelection()?.removeAllRanges(); getSelection()?.addRange(range);
        return getSelection()?.toString();
      });
      await page.waitForFunction(() => Number(document.querySelector(".chat-view")?.getAttribute("data-chat-pinned")) > 0);
      const y = await retained.evaluate((row) => row.getBoundingClientRect().top);
      const beforeSlide = slideReads;
      newestStart = 2;
      await update(page);
      await page.getByRole("button", { name: "New messages" }).waitFor();
      assert.equal(slideReads, beforeSlide + 1, "a moving newest cursor fills the dropped prefix even before older history was requested");
      assert.equal(await retained.getAttribute("data-chat-row"), identity);
      assert.equal(await page.evaluate(() => getSelection()?.toString()), selectedText);
      assert.equal(await retained.locator(".work-block-head").getAttribute("aria-expanded"), "true");
      assert.equal(await retained.locator(".work-row-head").getAttribute("aria-expanded"), "true");
      assert.ok(Math.abs(await retained.evaluate((row) => row.getBoundingClientRect().top) - y) <= 1, "sliding latest page preserves the logical reading anchor");
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await toFollowedEnd(page, page.getByRole("button", { name: "New messages" }));
      console.log(`PASS ${width} ${theme}: unheld newest cursor slides from ${origin ? "origin" : "a page"} without moving row identity, selection, disclosure or reading anchor`);
    }
    if (theme === "dark") {
      epoch = 3; newestStart = 0; beginsAtOrigin = true;
      await page.reload();
      await page.getByText("local E3 ROW-999", { exact: true }).waitFor();
      await settleBottom(page);
      const stream = await page.evaluate(() => new Promise<{ gaps: number[]; painted: number[]; atPaint: number[]; updates: number; maxGrowth: number }>((resolve, reject) => {
        const node = document.querySelector(".chat-view")!;
        const row = [...node.querySelectorAll("[data-chat-row]")].at(-1)!;
        const content = document.createElement("div"); content.className = "markdown";
        row.append(content);
        const started = performance.now(), gaps: number[] = [], painted: number[] = [], atPaint: number[] = [];
        // This observer was made after the list's own: in each frame the row grew, it runs after the
        // list measured it and the chat followed, after layout and before that frame is painted. What it
        // reads is what that frame shows, whatever ran between frames.
        const observer = new ResizeObserver(() => atPaint.push(node.scrollHeight - node.clientHeight - node.scrollTop));
        observer.observe(content);
        let seq = 0, maxGrowth = 0;
        const tick = () => {
          if (!content.isConnected) { reject(new Error("The streaming row was unmounted")); return; }
          painted.push(node.scrollHeight - node.clientHeight - node.scrollTop);
          const elapsed = performance.now() - started;
          // A frame the machine held up lands every change that came meanwhile at once, as a stream's
          // backlog does: one change per frame after a stall would be the check's own burst
          while (seq < 70 && elapsed >= seq * 110) {
            seq++;
            const paragraph = document.createElement("p");
            paragraph.textContent = `Continuous paragraph ${seq}: ${"streamed words grow the measured row while the reader follows. ".repeat(3)}`;
            const before = content.getBoundingClientRect().height;
            content.append(paragraph);
            maxGrowth = Math.max(maxGrowth, content.getBoundingClientRect().height - before);
          }
          gaps.push(node.scrollHeight - node.clientHeight - node.scrollTop);
          if (seq === 70 && elapsed > 70 * 110 + 300) { observer.disconnect(); resolve({ gaps, painted, atPaint, updates: content.children.length, maxGrowth }); }
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }));
      assert.equal(stream.updates, 70);
      const gaps = stream.gaps.slice().sort((a, b) => a - b);
      const longestRun = (samples: number[]) => {
        let run = 0, longest = 0;
        for (const gap of samples) { run = gap > 2 ? run + 1 : 0; longest = Math.max(longest, run); }
        return longest;
      };
      // A gap is sampled right after each append, before any layout: every frame that carries a change
      // counts behind there, whatever is painted. On a machine slow enough that several frames in a row
      // take a change's 110 ms each, that run grows with the machine and not the follow, so it is
      // logged. What the reader sees is counted twice: in each frame the row grew, as it is painted (a
      // follow that lands after its measurement's frame paints every change behind), and as each next
      // frame starts, for a run of frames left behind.
      const unlaidOut = longestRun(stream.gaps);
      const longest = longestRun(stream.painted);
      const p95 = gaps[Math.floor(gaps.length * 0.95)]!;
      const lagFrames = stream.gaps.filter((gap) => gap > 2).length;
      const paintedLag = stream.atPaint.filter((gap) => gap > 2).length;
      console.log(`Continuous content ${width}: p95 gap ${p95}, max growth ${stream.maxGrowth}, consecutive lag frames before layout ${unlaidOut}, lag frames ${lagFrames}/${stream.gaps.length}, painted behind ${paintedLag} of ${stream.atPaint.length} grown frames, consecutive behind at frame start ${longest}, behind at frame start ${stream.painted.filter((gap) => gap > 2).length}`);
      assert.ok(stream.atPaint.length >= stream.updates / 2, `the row's growth was seen as it was painted: ${stream.atPaint.length} frames`);
      assert.ok(p95 <= stream.maxGrowth + 24, `continuous content p95 follow gap exceeds one measured growth step: ${p95}`);
      assert.ok(longest <= 2, `continuous content left the reader behind for ${longest} consecutive frames`);
      assert.ok(paintedLag <= stream.updates / 10, `continuous content painted ${paintedLag} frames behind the end for ${stream.updates} changes`);
      await settleBottom(page);
      console.log(`PASS ${width}: 70 continuous content changes without per-change settling, p95 gap ${p95}`);
      await shot(page, `continuous-content-${width}`);

      streamedParagraphs = 0;
      revision++;
      await update(page);
      await page.getByText(`REVISION-${revision}`, { exact: true }).waitFor();
      await settleBottom(page);
      const rendered = await page.evaluate((total) => new Promise<{ behind: number[]; changes: number }>((resolve, reject) => {
        const node = document.querySelector(".chat-view")!;
        const row = [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).at(-1)!;
        // React commits each read between frames, so a frame callback would see the row grown and not
        // yet laid out. This observer was made after the list's own: in the frame the row grew it runs
        // after the list measured it and the chat followed, before that frame is painted.
        const behind: number[] = [];
        let changes = 0, height = row.getBoundingClientRect().height;
        const observer = new ResizeObserver(() => {
          const next = row.getBoundingClientRect().height;
          if (next <= height) return;
          height = next;
          changes++;
          const gap = node.scrollHeight - node.clientHeight - node.scrollTop;
          if (gap > 2) behind.push(Math.round(gap));
        });
        observer.observe(row);
        const started = performance.now();
        let asked = 0;
        const tick = () => {
          const elapsed = performance.now() - started;
          // a read still on its way takes the next ask with it: ask until the last paragraph lands
          if (elapsed >= asked * 110) { asked++; window.chatQa.refresh(); }
          if ([...node.querySelectorAll("p")].some((p) => p.textContent?.startsWith(`Rendered paragraph ${total}:`))) {
            observer.disconnect();
            resolve({ behind, changes });
          } else if (!row.isConnected) { observer.disconnect(); reject(new Error("the rendered row was unmounted")); }
          else if (elapsed > 60_000) { observer.disconnect(); reject(new Error(`the rendered stream never reached paragraph ${total}`)); }
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }), STREAMED_PARAGRAPHS);
      streamedParagraphs = null;
      console.log(`Rendered content ${width}: ${rendered.changes} changes, ${rendered.behind.length} laid out behind the end ${JSON.stringify(rendered.behind.slice(0, 8))}`);
      assert.ok(rendered.changes >= STREAMED_PARAGRAPHS / 2, `the rendered stream grew the row: ${rendered.changes} changes`);
      assert.ok(rendered.behind.length <= rendered.changes / 10, `rendered content was behind the end in ${rendered.behind.length} of ${rendered.changes} frames it grew: ${JSON.stringify(rendered.behind)}`);
      await settleBottom(page);
      console.log(`PASS ${width}: ${rendered.changes} rendered content changes are painted at the end`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("chat virtual: initial, streaming, manual follow and row restoration OK");
} catch (error) {
  if (evidence && activePage && !activePage.isClosed()) {
    try { await activePage.screenshot({ path: join(evidence, "chat-virtual-failed.png") }); }
    catch (captureError) { console.error("Chat failure capture:", String(captureError)); }
  }
  throw error;
} finally {
  olderReleases.forEach((release) => release());
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
