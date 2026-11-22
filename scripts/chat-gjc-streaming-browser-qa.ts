import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { forgetTranscriptState, HistoryChanged, transcriptPage } from "../server/conversation.ts";
import type {} from "./chat-virtual-fixture.tsx";

const root = mkdtempSync(join(tmpdir(), "herdr-chat-gjc-"));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const transcript = join(root, "session.jsonl");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let seq = 0;
let parent: string | null = null;
let clock = 0;

function entry(message: Record<string, unknown>): string {
  const id = `e${++seq}`;
  const line = JSON.stringify({ type: "message", id, parentId: parent, timestamp: new Date(clock += 1000).toISOString(), message });
  parent = id;
  return `${line}\n`;
}
const lines = (label: string, count: number) => Array.from({ length: count }, (_, index) => `${label} line ${index + 1}: const value${index} = compute(${index});`).join("\n");
const call = (id: string, path: string) => entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "read", arguments: { path } }] });
const result = (id: string, label: string, count: number) => entry({ role: "toolResult", toolCallId: id, toolName: "read", isError: false, content: [{ type: "text", text: lines(label, count) }] });
// gjc's todo_write: operations on one list, answered with the whole list as it now stands
const TODO = ["Read the fixture files", "Patch the parser", "Run the tests"];
const todoCall = (id: string, ops: unknown[]) => entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id, name: "todo_write", arguments: { ops } }] });
const todoResult = (id: string, done: number) => entry({ role: "toolResult", toolCallId: id, toolName: "todo_write", isError: false, content: [{ type: "text", text:
  `Overall: ${done}/${TODO.length} done.\n  Fix:\n${TODO.map((item, index) => `    - [${index < done ? "X" : " "}] ${item}${index === done ? " (in progress)" : ""}`).join("\n")}` }] });

function reset(earlier: number): void {
  seq = 0; parent = null; clock = Date.parse("2026-10-24T00:00:00.000Z");
  forgetTranscriptState();
  let text = `${JSON.stringify({ type: "session", version: 5, id: "synthetic-gjc", timestamp: new Date(clock).toISOString(), cwd: "/tmp/fixture" })}\n`;
  for (let turn = 1; turn <= earlier; turn++) {
    text += entry({ role: "user", content: [{ type: "text", text: `Earlier question ${turn}` }] });
    text += entry({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: Array.from({ length: 4 }, (_, index) => `Earlier answer ${turn}, paragraph ${index + 1}. ${"Some words to wrap. ".repeat(12)}`).join("\n\n") }] });
  }
  text += entry({ role: "user", content: [{ type: "text", text: "Read the fixture files one by one." }] });
  text += entry({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Reading the files." }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/alpha.ts" } }] });
  text += result("c1", "alpha", 30);
  text += call("c2", "src/beta.ts");
  writeFileSync(transcript, text);
}

/** gjc's full rewrite (`#rewriteFile`): every record again plus the new one, written beside the file and renamed over it. */
function write(record: string, rewrite: boolean): number {
  if (rewrite) {
    const temporary = join(root, ".session.jsonl.tmp");
    writeFileSync(temporary, readFileSync(transcript, "utf8") + record);
    renameSync(temporary, transcript);
  } else appendFileSync(transcript, record);
  return statSync(transcript).size;
}

interface Frame { y: number | null; expanded: string | null; bottom: number }
interface Track { head?: string; key?: string; group?: boolean }

function sampleScript(track: Track): Frame {
  const node = document.querySelector<HTMLElement>(".chat-view")!;
  const grouped = track.group ? document.querySelector<HTMLElement>("[data-todo-group] > .work-row-head") ?? undefined : undefined;
  const head = grouped ?? (track.head === undefined ? undefined : [...document.querySelectorAll<HTMLElement>(".work-row-head")].find((button) => button.textContent?.includes(track.head!)));
  const row = track.key === undefined ? undefined : [...document.querySelectorAll<HTMLElement>("[data-chat-row]")].find((candidate) => candidate.dataset.chatRow === track.key);
  const element = head ?? row;
  return { y: element ? element.getBoundingClientRect().top : null, expanded: head?.getAttribute("aria-expanded") ?? null, bottom: node.scrollHeight - node.clientHeight - node.scrollTop };
}

async function still(page: Page, track: Track): Promise<Frame> {
  return page.evaluate(async ({ track, sample }) => {
    const read = new Function("track", `return (${sample})(track)`) as (track: Track) => Frame;
    let last = read(track), count = 0;
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline && count < 10) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const frame = read(track);
      count = frame.y === last.y && frame.bottom === last.bottom ? count + 1 : 0;
      last = frame;
    }
    return last;
  }, { track, sample: sampleScript.toString() });
}

async function step(page: Page, bytes: number, track: Track): Promise<Frame[]> {
  return page.evaluate(async ({ bytes, track, sample }) => {
    const read = new Function("track", `return (${sample})(track)`) as (track: Track) => Frame;
    const frames = [read(track)];
    window.chatQa.refresh();
    const deadline = performance.now() + 8000;
    let count = 0;
    while (performance.now() < deadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const frame = read(track);
      const last = frames.at(-1)!;
      frames.push(frame);
      const served = (window as unknown as { qaBytes: number }).qaBytes >= bytes;
      count = served && frame.y === last.y && frame.bottom === last.bottom ? count + 1 : 0;
      if (count >= 10) return frames;
    }
    throw new Error(`never settled on ${bytes} bytes: ${JSON.stringify(frames.slice(-3))}`);
  }, { bytes, track, sample: sampleScript.toString() });
}

const RECORDS = (): Array<[string, string]> => [
  ["result beta", result("c2", "beta", 40)],
  ["call gamma", entry({ role: "assistant", stopReason: "toolUse", content: [
    { type: "text", text: Array.from({ length: 12 }, (_, index) => `Beta read, note ${index + 1}. ${"The next file decides it. ".repeat(8)}`).join("\n\n") },
    { type: "toolCall", id: "c3", name: "read", arguments: { path: "src/gamma.ts" } },
  ] })],
  ["result gamma", result("c3", "gamma", 25)],
  ["call delta", call("c4", "src/delta.ts")],
];
const TODO_RECORDS = (): Array<[string, string]> => [
  ["call todo 2", todoCall("t2", [{ op: "done", task: TODO[0] }])],
  ["result todo 2", todoResult("t2", 1)],
  ["call delta", call("c4", "src/delta.ts")],
];
const failures: string[] = [];
const report: Record<string, unknown> = {};
function expect(ok: boolean, message: string): void {
  if (!ok) failures.push(message);
}

try {
  const build = await Bun.build({
    entrypoints: ["scripts/chat-virtual-fixture.tsx"], outdir: root, target: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/pane/commands")) return Response.json({ commands: [] });
    if (url.pathname.endsWith("/pane/conversation")) {
      const size = statSync(transcript).size;
      try {
        const { version: _version, ...answer } = transcriptPage("gjc-transcript", transcript, {
          before: url.searchParams.get("before") ?? undefined, since: url.searchParams.get("since") ?? undefined, from: url.searchParams.get("from") ?? undefined,
        });
        return Response.json(answer, { headers: { "x-qa-bytes": String(size) } });
      } catch (error) {
        if (error instanceof HistoryChanged) return Response.json({ error: { code: "history_changed", message: error.message } }, { status: 409 });
        throw error;
      }
    }
    if (url.pathname === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>GJC streaming QA</title><link rel="stylesheet" href="/chat-virtual-fixture.css"></head><body><div id="root"></div><script type="module" src="/chat-virtual-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    return new Response(Bun.file(join(root, url.pathname.slice(1))));
  } });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const width of [1440, 390] as const) {
    for (const scenario of ["reading", "short", "following", "scrolled", "todo", "jump"] as const) {
      for (const rewrite of [false, true]) {
        if (scenario === "jump" && rewrite) continue;
        const name = `${width} ${scenario} ${rewrite ? "rewrite" : "append"}`;
        const opens = scenario === "reading" || scenario === "short" || scenario === "todo" || scenario === "jump";
        reset(scenario === "short" ? 0 : 6);
        if (scenario === "todo") write(result("c2", "beta", 40) + todoCall("t1", [{ op: "init", list: [{ phase: "Fix", items: TODO }] }]) + todoResult("t1", 0), false);
        const records = scenario === "todo" ? TODO_RECORDS() : RECORDS();
        const rewriteAt = scenario === "todo" ? "call todo 2" : "call gamma";
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: "en-US" });
        await context.addInitScript(() => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "dark" }));
          const qa = window as unknown as { qaBytes: number; fetch: (...args: Parameters<typeof fetch>) => Promise<Response> };
          // A transcript size counts as served once the chat has shown that very answer (its metadata
          // object comes back through onMetadata) and React has committed after it: not when its
          // headers arrive, nor when an answer the chat dropped was read.
          qa.qaBytes = 0;
          const sizes = new WeakMap<object, number>();
          let shown = 0;
          const original = window.fetch.bind(window);
          qa.fetch = async (...args) => {
            const response = await original(...args);
            const bytes = Number(response.headers.get("x-qa-bytes") ?? 0);
            if (bytes > 0) {
              const json = response.json.bind(response);
              response.json = async () => {
                const body = await json() as { metadata?: unknown };
                if (typeof body.metadata === "object" && body.metadata !== null) sizes.set(body.metadata, bytes);
                return body;
              };
            }
            return response;
          };
          window.addEventListener("chat-qa-answer", (event) => {
            const detail = (event as CustomEvent<unknown>).detail;
            const bytes = typeof detail === "object" && detail !== null ? sizes.get(detail) : undefined;
            if (bytes !== undefined && bytes > shown) shown = bytes;
          });
          window.addEventListener("chat-qa-commit", () => { if (shown > qa.qaBytes) qa.qaBytes = shown; });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15_000);
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/`);
        await page.locator(".work-row-head", { hasText: "beta.ts" }).waitFor();
        await page.waitForFunction(() => { const node = document.querySelector(".chat-view"); return node !== null && node.scrollHeight - node.clientHeight - node.scrollTop <= 1; });
        await still(page, {});
        let track: Track = {};
        if (opens) {
          track = scenario === "todo" ? { head: "plan ·", group: true } : { head: "beta.ts" };
          await page.locator(".work-row-head", { hasText: track.head }).click();
        } else if (scenario === "scrolled") {
          const box = (await page.locator(".chat-view").boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, -160);
          await still(page, {});
          const key = await page.locator(".chat-view").evaluate((node) => {
            const top = node.getBoundingClientRect().top;
            return [...node.querySelectorAll<HTMLElement>("[data-chat-row]")].filter((row) => row.getBoundingClientRect().bottom > top + 40)
              .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]?.dataset.chatRow;
          });
          assert.ok(key !== undefined, `${name}: a row is in view`);
          track = { key };
        }
        if (scenario === "jump") {
          const jump = page.locator(".chat-virtual-jump");
          const atEnd = async (step: string) => {
            try { await page.waitForFunction(() => { const node = document.querySelector(".chat-view"); return node !== null && node.scrollHeight - node.clientHeight - node.scrollTop <= 1; }, undefined, { timeout: 5000 }); return true; }
            catch { expect(false, `${name}: ${step} reaches the end (bottom ${(await still(page, {})).bottom})`); return false; }
          };
          await jump.click();
          await atEnd("the first Jump");
          await still(page, {});
          const head = page.locator(".work-row-head", { hasText: "beta.ts" });
          await head.evaluate((button: HTMLElement) => button.click());
          await still(page, {});
          await head.evaluate((button: HTMLElement) => button.click());
          expect(await head.getAttribute("aria-expanded") === "true", `${name}: the tool opens again`);
          await jump.click();
          await atEnd("Jump after reopening");
          await still(page, {});
          const grow = () => page.locator(".chat-view [data-chat-row]").last().evaluate((row) => { const block = document.createElement("div"); block.style.height = "240px"; row.append(block); });
          await grow();
          const end = await still(page, {});
          expect(end.bottom <= 1, `${name}: after Jump to latest, a row that grows with no new record is followed (bottom ${end.bottom})`);
          await head.evaluate((button: HTMLElement) => button.click());
          await still(page, {});
          const box = (await page.locator(".chat-view").boundingBox())!;
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.wheel(0, -400);
          await still(page, {});
          expect(await jump.count() === 1, `${name}: scrolled away after closing, the way back is offered`);
          if (await jump.count() === 1) {
            await jump.click();
            await atEnd("Jump after closing and scrolling away");
            await still(page, {});
            await grow();
            const back = await still(page, {});
            expect(back.bottom <= 1, `${name}: after closing, scrolling away and Jump to latest, a row that grows is followed (bottom ${back.bottom})`);
            await head.evaluate((button: HTMLElement) => button.click());
            await jump.click();
            await atEnd("Jump after opening again");
            await still(page, {});
            await head.evaluate((button: HTMLElement) => button.click());
            await still(page, {});
            await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3);
            await page.mouse.wheel(0, -400);
            await still(page, {});
            await page.mouse.wheel(0, 4000);
            await atEnd("scrolling back by hand");
            await still(page, {});
            await grow();
            const scrolled = await still(page, {});
            expect(scrolled.bottom <= 1, `${name}: after closing, scrolling away and scrolling back to the end, a row that grows is followed (bottom ${scrolled.bottom})`);
          }
          if (evidence) await page.screenshot({ path: join(evidence, `gjc-${width}-jump.png`) });
          expect(errors.length === 0, `${name}: page errors ${JSON.stringify(errors)}`);
          report[name] = { end, errors };
          console.log(name, JSON.stringify({ end }));
          await context.close();
          continue;
        }
        const start = await still(page, track);
        const steps: Array<{ record: string; minDy: number | null; maxDy: number | null; missing: number; expanded: string | null; bottom: number }> = [];
        for (const [label, record] of records) {
          const bytes = write(record, rewrite && label === rewriteAt);
          const frames = await step(page, bytes, track);
          const ys = frames.map((frame) => frame.y).filter((y): y is number => y !== null);
          const end = frames.at(-1)!;
          const summary = { record: label, minDy: ys.length > 0 && start.y !== null ? Math.round((Math.min(...ys) - start.y) * 100) / 100 : null, maxDy: ys.length > 0 && start.y !== null ? Math.round((Math.max(...ys) - start.y) * 100) / 100 : null, missing: frames.length - ys.length, expanded: end.expanded, bottom: Math.round(end.bottom * 100) / 100 };
          steps.push(summary);
          if (scenario === "following") expect(end.bottom <= 1, `${name} after ${label}: a reader at the end stays at the end (bottom ${end.bottom})`);
          else {
            expect(summary.missing === 0 && summary.minDy !== null && summary.maxDy !== null && summary.minDy >= -1 && summary.maxDy <= 1, `${name} after ${label}: the reader's ${opens ? "opened tool" : "row"} stays put in every frame (${JSON.stringify(summary)})`);
            if (opens) expect(end.expanded === "true", `${name} after ${label}: the opened tool stays open (${end.expanded})`);
          }
        }
        if (scenario === "short") expect(steps.at(-1)!.bottom > 1, `${name}: the records outgrew a chat that fit the screen when the tool was opened (bottom ${steps.at(-1)!.bottom})`);
        if (scenario === "todo") {
          const attempts = await page.locator("[data-todo-group] .work-todo-attempts .work-row-head").evaluateAll((heads) => heads.map((head) => head.getAttribute("aria-expanded")));
          expect(JSON.stringify(attempts) === JSON.stringify(["true", "false"]), `${name}: the opened update stays open inside its Plan row (${JSON.stringify(attempts)})`);
          const focused = await page.evaluate(() => document.activeElement === document.querySelector("[data-todo-group] .work-todo-attempts .work-row-head") ? "attempt" : document.activeElement?.tagName ?? "none");
          expect(focused === "attempt", `${name}: the focus stays on the update the reader opened (${focused})`);
        }
        let resumed: number | null = null;
        if (scenario !== "following") {
          const jump = page.locator(".chat-virtual-jump");
          expect(await jump.count() === 1, `${name}: a reader away from the end is offered the way back`);
          if (await jump.count() === 1) {
            await jump.click();
            await page.waitForFunction(() => { const node = document.querySelector(".chat-view"); return node !== null && node.scrollHeight - node.clientHeight - node.scrollTop <= 1; });
            const frames = await step(page, write(result("c4", "delta", 12), false), {});
            resumed = Math.round(frames.at(-1)!.bottom * 100) / 100;
            expect(resumed <= 1, `${name}: back at the end, the next record is followed (bottom ${resumed})`);
          }
        }
        if (evidence) await page.screenshot({ path: join(evidence, `gjc-${width}-${scenario}-${rewrite ? "rewrite" : "append"}.png`) });
        expect(errors.length === 0, `${name}: page errors ${JSON.stringify(errors)}`);
        report[name] = { start, steps, resumed, errors };
        console.log(name, JSON.stringify({ start, steps, resumed }));
        await context.close();
      }
    }
  }
  if (evidence) writeFileSync(join(evidence, "gjc-streaming.json"), JSON.stringify({ report, failures }, null, 2));
  assert.deepEqual(failures, [], `GJC streaming:\n${failures.join("\n")}`);
  console.log("chat GJC streaming: opened tools, readers away and followers keep their place OK");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
