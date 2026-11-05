import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import type { ConversationTurn } from "../shared/protocol.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// The chat's Working line, on the unmodified app over the demo's fixture transport: the demo's
// "api" Claude pane works, and the "flaky" one rests on a finished turn, to which the script adds
// turns as a transcript gains them. All files and HTTP traffic stay in this disposable,
// loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-working-line-demo-"));

interface Frame {
  loading: boolean;
  /** "Working…" heads and lines under the rows, outside any turn */
  footer: string[];
  rows: number;
  /** the last row's work blocks: live or done, open or folded, and their title */
  lastBlocks: string[];
  lastRow: string;
}

/** Records one pane's chat, from now and at each frame where it changed, until `stop` returns the frames. */
const record = (page: Page, pane: string): Promise<void> => page.evaluate((id) => {
  const frames: Frame[] = [];
  const shown = (node: Element): boolean => (node as HTMLElement).getClientRects().length > 0;
  let last = "";
  const tick = (): void => {
    const root = document.querySelector(`.pane-frame[data-layout-pane="${id}"]`);
    const rows = root === null ? [] : [...root.querySelectorAll("[data-chat-row]")].filter(shown);
    const frame: Frame = {
      loading: root !== null && [...root.querySelectorAll(".chat-inline-state")].some((node) => shown(node) && node.textContent === "Loading conversation…"),
      footer: root === null ? [] : [...root.querySelectorAll(".chat-activity")].filter((node) => shown(node) && node.closest("[data-chat-row]") === null).map((node) => node.textContent ?? ""),
      rows: rows.length,
      lastBlocks: [...rows.at(-1)?.querySelectorAll(".work-block") ?? []].map((block) =>
        `${block.classList.contains("is-live") ? "live" : "done"}/${block.querySelector('.work-block-head[aria-expanded="true"]') === null ? "folded" : "open"}:${block.querySelector(".work-block-title")?.textContent ?? ""}`),
      lastRow: rows.at(-1)?.textContent ?? "",
    };
    if (JSON.stringify(frame) !== last) { last = JSON.stringify(frame); frames.push(frame); }
    if ((window as unknown as { workingFrames?: Frame[] }).workingFrames === frames) requestAnimationFrame(tick);
  };
  (window as unknown as { workingFrames?: Frame[] }).workingFrames = frames;
  tick();
}, pane);
const stop = (page: Page): Promise<Frame[]> => page.evaluate(() => {
  const w = window as unknown as { workingFrames?: Frame[] };
  const frames = w.workingFrames ?? [];
  delete w.workingFrames;
  return frames;
});
/** two painted frames: whatever a state change draws is on screen by then */
const painted = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const status = (page: Page, pane: string, value: "working" | "idle" | "done"): Promise<void> => page.evaluate(([id, next]) =>
  (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder.status(id!, next!), [pane, value]);
/** The pane's transcript gains these turns after its own, and the app is told it changed. */
const addTurns = (page: Page, pane: string, turns: ConversationTurn[]): Promise<void> => page.evaluate(([id, added]) => {
  const w = window as unknown as { addedTurns: Record<string, unknown>; conversationChanged(pane: string): void };
  w.addedTurns[id as string] = added;
  w.conversationChanged(id as string);
}, [pane, turns] as const);

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Holds one pane's conversation reads until the script releases them, as a slow first read would.
  // Adds turns to a pane's conversation, and tells the app of the change as the server's socket does.
  const hold = `<script>(() => {
    const demo = window.fetch;
    const held = [];
    window.holdConversation = null;
    window.releaseConversation = () => { window.holdConversation = null; for (const go of held.splice(0)) go(); };
    window.addedTurns = {};
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (!url.pathname.endsWith("/api/pane/conversation")) return demo(input, init);
      const pane = url.searchParams.get("pane_id");
      if (pane === window.holdConversation) await new Promise((go) => held.push(go));
      const response = await demo(input, init);
      const added = window.addedTurns[pane];
      if (added === undefined || !response.ok) return response;
      const body = await response.json();
      return Response.json({ ...body, turns: [...body.turns, ...added] });
    };
    const Demo = window.WebSocket;
    const sockets = [];
    const Watched = function (url, protocols) {
      const socket = new Demo(url, protocols);
      sockets.push(socket);
      return socket;
    };
    for (const name of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) Object.defineProperty(Watched, name, { value: Demo[name] });
    window.WebSocket = Watched;
    let change = 0;
    window.conversationChanged = (pane) => { for (const socket of sockets) socket.push({ type: "conversation-changed", pane_id: pane, signature: "added:" + ++change }); };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${hold}\n    <script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = (pane: string): string => `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(pane)}&view=chat`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      await context.addInitScript((ids) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
        for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
      }, [panes.api, panes.flaky, panes.omp]);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));

      // A pane switch to a working Claude pane, whose first read is slow: the chat is loading, and
      // the running turn's own head comes with its rows. A head drawn before them goes when they land.
      await page.goto(url(panes.omp));
      await page.locator(`.pane-frame[data-layout-pane="${panes.omp}"] [data-chat-row]`).first().waitFor();
      await page.evaluate((id) => { (window as unknown as { holdConversation: string }).holdConversation = id; }, panes.api);
      await record(page, panes.api);
      await page.locator(`.pane-select[data-pane="${panes.api}"], .agent-item[data-pane="${panes.api}"] .agent-select`).first().click();
      await page.locator(`.pane-frame[data-layout-pane="${panes.api}"] .chat-inline-state`, { hasText: "Loading conversation…" }).waitFor();
      await painted(page);
      await page.evaluate(() => (window as unknown as { releaseConversation(): void }).releaseConversation());
      await page.locator(`.pane-frame[data-layout-pane="${panes.api}"] [data-chat-row] .work-block.is-live`).first().waitFor();
      await painted(page);
      const switched = await stop(page);
      const loading = switched.filter((frame) => frame.rows === 0);
      assert.ok(loading.some((frame) => frame.loading), "the slow first read shows Loading conversation…");
      assert.deepEqual(loading.filter((frame) => frame.footer.length > 0), [], "no Working head stands in for the turn while its rows are read");
      const settled = switched.at(-1)!;
      assert.deepEqual(settled.footer, [], "the running turn's own head says Working, with none under it");
      assert.ok(settled.lastBlocks.some((block) => block.startsWith("live/open:Working…")), `the running turn's block is open and working: ${JSON.stringify(settled.lastBlocks)}`);
      console.log("PASS a working pane's first read shows Loading conversation…, then the running turn's own Working head");

      // Claude starts a turn by itself (a background task ended): herdr says working before the
      // transcript has the new turn. The finished turn stays finished; the Working head is the new one's.
      await page.goto(url(panes.flaky));
      const flaky = page.locator(`.pane-frame[data-layout-pane="${panes.flaky}"]`);
      await flaky.locator("[data-chat-row] .work-block-title", { hasText: "Worked for" }).last().waitFor();
      await painted(page);
      await record(page, panes.flaky);
      await status(page, panes.flaky, "working");
      await flaky.locator(".work-block.is-live").first().waitFor();
      await painted(page);
      await status(page, panes.flaky, "done");
      await flaky.locator(".work-block.is-live").first().waitFor({ state: "detached" });
      await painted(page);
      const reopened = await stop(page);
      const before = reopened[0]!.lastBlocks;
      assert.ok(before.length > 0 && before.every((block) => block.startsWith("done/folded:Worked for")), `the finished turn is folded: ${JSON.stringify(before)}`);
      assert.deepEqual(reopened.filter((frame) => JSON.stringify(frame.lastBlocks) !== JSON.stringify(before)).map((frame) => frame.lastBlocks), [],
        "the finished turn is never titled Working… or opened again");
      assert.ok(reopened.some((frame) => frame.footer.includes("Working…")), "the turn the agent began has its Working head under the rows");
      console.log("PASS a turn the agent begins by itself leaves the finished turn folded, with the Working head under it");

      // A turn ends: its answer is drawn while herdr still says working, and the pane rests 300 ms
      // later, as herdr's status trails the transcript (100–400 ms at the turn ends measured). No
      // head of a next turn shows under the answer in that time.
      await page.goto(url(panes.flaky));
      await flaky.locator("[data-chat-row] .work-block-title", { hasText: "Worked for" }).last().waitFor();
      // Claude stamps a turn by its first entry; two turns read in one poll can share that stamp
      const answeredAt = "2026-11-04T09:00:00.000Z";
      const asked: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "Count the shelves." }] };
      await addTurns(page, panes.flaky, [asked]);
      await status(page, panes.flaky, "working");
      await flaky.getByText("Count the shelves.", { exact: true }).waitFor();
      await painted(page);
      await record(page, panes.flaky);
      // the pane rests 300 ms after the frame that paints the answer, timed in the page
      const rested = page.evaluate(([id, answer]) => new Promise<void>((done) => {
        const drawn = (): void => {
          if (!document.querySelector(`.pane-frame[data-layout-pane="${id}"]`)?.textContent?.includes(answer!)) { requestAnimationFrame(drawn); return; }
          // fixed wait: the lag of herdr's status behind the drawn answer
          setTimeout(() => {
            (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder.status(id!, "idle");
            done();
          }, 300);
        };
        requestAnimationFrame(drawn);
      }), [panes.flaky, "There are three shelves."]);
      await addTurns(page, panes.flaky, [asked, { role: "assistant", ts: answeredAt, parts: [
        { kind: "tool", name: "Bash", summary: "ls shelves", input: JSON.stringify({ command: "ls shelves" }), output: "a b c", call_id: "shelves", state: "ok" },
        { kind: "text", text: "There are three shelves.", phase: "final_answer" },
      ] }]);
      await rested;
      await flaky.locator(".chat-activity").waitFor({ state: "detached" });
      await painted(page);
      const ended = await stop(page);
      const answered = ended.filter((frame) => frame.lastRow.includes("There are three shelves."));
      assert.ok(answered.length > 0, "the answer is drawn");
      assert.deepEqual(answered.filter((frame) => frame.footer.length > 0).map((frame) => frame.footer), [],
        "no Working head stands under the answer while the status catches up with it");
      console.log("PASS a turn's answer drawn 300 ms before the pane rests has no Working head under it");

      // The agent works on by itself long enough for its head to show, and its next turn is read in
      // already finished, while herdr still says working. The wait runs again for that new turn: no
      // head stands under its answer either.
      const answeredTurns: ConversationTurn[] = [asked, { role: "assistant", ts: answeredAt, parts: [
        { kind: "tool", name: "Bash", summary: "ls shelves", input: JSON.stringify({ command: "ls shelves" }), output: "a b c", call_id: "shelves", state: "ok" },
        { kind: "text", text: "There are three shelves.", phase: "final_answer" },
      ] }];
      await status(page, panes.flaky, "working");
      await flaky.locator(".chat-activity", { hasText: "Working…" }).waitFor();
      await painted(page);
      await record(page, panes.flaky);
      const restedAgain = page.evaluate(([id, answer]) => new Promise<void>((done) => {
        const drawn = (): void => {
          if (!document.querySelector(`.pane-frame[data-layout-pane="${id}"]`)?.textContent?.includes(answer!)) { requestAnimationFrame(drawn); return; }
          setTimeout(() => {
            (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder.status(id!, "idle");
            done();
          }, 300);
        };
        requestAnimationFrame(drawn);
      }), [panes.flaky, "Shelf b holds the atlas."]);
      const atlasTurns: ConversationTurn[] = [...answeredTurns,
        { role: "user", ts: null, parts: [{ kind: "text", text: "Which shelf holds the atlas?" }] },
        { role: "assistant", ts: answeredAt, parts: [{ kind: "text", text: "Shelf b holds the atlas.", phase: "final_answer" }] },
      ];
      await addTurns(page, panes.flaky, atlasTurns);
      await restedAgain;
      await flaky.locator(".chat-activity").waitFor({ state: "detached" });
      await painted(page);
      const next = (await stop(page)).filter((frame) => frame.lastRow.includes("Shelf b holds the atlas."));
      assert.ok(next.length > 0, "the next answer is drawn");
      assert.deepEqual(next.filter((frame) => frame.footer.length > 0).map((frame) => frame.footer), [],
        "no Working head stands under a turn read in already finished, after the last one's wait ran out");
      console.log("PASS a turn read in already finished, stamped like the last one, has no Working head under its answer");

      // herdr's status can trail the answer by more than the head's wait (a slow PC, a busy herdr):
      // the pane rests 1.5 s after the answer is drawn. Still no head of a next turn under it.
      const dusted: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "Dust shelf c." }] };
      await addTurns(page, panes.flaky, [...atlasTurns, dusted]);
      await status(page, panes.flaky, "working");
      await flaky.getByText("Dust shelf c.", { exact: true }).waitFor();
      await painted(page);
      await record(page, panes.flaky);
      const restedLate = page.evaluate(([id, answer]) => new Promise<void>((done) => {
        const drawn = (): void => {
          if (!document.querySelector(`.pane-frame[data-layout-pane="${id}"]`)?.textContent?.includes(answer!)) { requestAnimationFrame(drawn); return; }
          // fixed wait: a status lag longer than the head's 800 ms wait
          setTimeout(() => {
            (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder.status(id!, "idle");
            done();
          }, 1500);
        };
        requestAnimationFrame(drawn);
      }), [panes.flaky, "Shelf c is dusted."]);
      await addTurns(page, panes.flaky, [...atlasTurns, dusted,
        { role: "assistant", ts: "2026-11-04T09:01:00.000Z", parts: [{ kind: "text", text: "Shelf c is dusted.", phase: "final_answer" }] },
      ]);
      await restedLate;
      await flaky.locator(".chat-activity").waitFor({ state: "detached" });
      await painted(page);
      const late = (await stop(page)).filter((frame) => frame.lastRow.includes("Shelf c is dusted."));
      assert.ok(late.length > 0, "the late-rested answer is drawn");
      assert.deepEqual(late.filter((frame) => frame.footer.length > 0).map((frame) => frame.footer), [],
        "no Working head stands under an answer while a status lag outlasts the wait");
      console.log("PASS an answer drawn 1.5 s before the pane rests has no Working head under it");

      // An approval answered: the turn's answer is drawn while herdr still says blocked, then working
      // for longer than the head's wait, then the pane rests. Waiting on the user is no rest under the
      // answer, so no head of a next turn shows under it.
      const shelved: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "Shelve the atlas." }] };
      const shelvedBefore = [...atlasTurns, dusted, { role: "assistant" as const, ts: "2026-11-04T09:01:00.000Z", parts: [{ kind: "text" as const, text: "Shelf c is dusted.", phase: "final_answer" as const }] }];
      await addTurns(page, panes.flaky, [...shelvedBefore, shelved]);
      await status(page, panes.flaky, "working");
      await flaky.getByText("Shelve the atlas.", { exact: true }).waitFor();
      await page.evaluate((id) => (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder.status(id, "blocked"), panes.flaky);
      await painted(page);
      await record(page, panes.flaky);
      await addTurns(page, panes.flaky, [...shelvedBefore, shelved,
        { role: "assistant", ts: "2026-11-04T09:02:00.000Z", parts: [{ kind: "text", text: "The atlas is shelved.", phase: "final_answer" }] },
      ]);
      await flaky.getByText("The atlas is shelved.", { exact: true }).waitFor();
      await painted(page);
      await status(page, panes.flaky, "working");
      const restedAfterBlock = page.evaluate((id) => new Promise<void>((done) => {
        // fixed wait: a working status after the approval, longer than the head's 800 ms wait
        setTimeout(() => {
          (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder.status(id, "idle");
          done();
        }, 1500);
      }), panes.flaky);
      await restedAfterBlock;
      await flaky.locator(".chat-activity").waitFor({ state: "detached" });
      await painted(page);
      const approved = (await stop(page)).filter((frame) => frame.lastRow.includes("The atlas is shelved."));
      assert.ok(approved.length > 0, "the answer after the approval is drawn");
      assert.deepEqual(approved.filter((frame) => frame.footer.length > 0).map((frame) => frame.footer), [],
        "no Working head stands under an answer drawn while the pane was blocked");
      console.log("PASS an answer drawn while blocked has no Working head under it when the status catches up");

      // herdr rests before a read holds the turn's answer (#2550, about 1 s live): the turn stays at
      // work until the answer is drawn, never shown ended with no answer, also over a read between
      // that brings only more of the turn's work
      const books: ConversationTurn = { role: "user", ts: null, parts: [{ kind: "text", text: "How many books?" }] };
      const bookTurns: ConversationTurn[] = [...shelvedBefore, shelved,
        { role: "assistant", ts: "2026-11-04T09:02:00.000Z", parts: [{ kind: "text", text: "The atlas is shelved.", phase: "final_answer" }] },
        books,
      ];
      await addTurns(page, panes.flaky, bookTurns);
      await status(page, panes.flaky, "working");
      await flaky.getByText("How many books?", { exact: true }).waitFor();
      await flaky.locator(".chat-activity", { hasText: "Working" }).waitFor();
      await painted(page);
      await record(page, panes.flaky);
      const counting: ConversationTurn = { role: "assistant", ts: null, parts: [
        { kind: "tool", name: "Bash", summary: "ls books", input: JSON.stringify({ command: "ls books" }), output: "40", call_id: "books", state: "ok" },
      ] };
      await status(page, panes.flaky, "done");
      await painted(page);
      await addTurns(page, panes.flaky, [...bookTurns, counting]);
      // the new turn's row, open or folded: its header counts the command
      await page.waitForFunction((id) => [...document.querySelectorAll(`.pane-frame[data-layout-pane="${id}"] [data-chat-row]`)].at(-1)?.textContent?.includes("1 command") === true, panes.flaky);
      await painted(page);
      await addTurns(page, panes.flaky, [...bookTurns, { ...counting, parts: [...counting.parts, { kind: "text", text: "There are forty books.", phase: "final_answer" }] }]);
      await flaky.getByText("There are forty books.", { exact: true }).waitFor();
      await painted(page);
      const lagged = await stop(page);
      assert.deepEqual(lagged.filter((frame) => !frame.lastRow.includes("There are forty books.") && frame.footer.length === 0 && !frame.lastBlocks.some((block) => block.startsWith("live/"))), [],
        "the turn stays at work until its answer is drawn");
      console.log("PASS a turn whose answer is read after herdr rests stays at work until the answer is drawn");

      // a rest with no answer to come (a turn stopped from the terminal): the turn ends within the wait
      await addTurns(page, panes.flaky, [...bookTurns.slice(0, -1), { role: "user", ts: null, parts: [{ kind: "text", text: "Stop here." }] }]);
      await status(page, panes.flaky, "working");
      await flaky.getByText("Stop here.", { exact: true }).waitFor();
      await flaky.locator(".chat-activity", { hasText: "Working" }).waitFor();
      await status(page, panes.flaky, "done");
      await flaky.locator(".chat-activity").waitFor({ state: "detached", timeout: 5_000 });
      console.log("PASS a turn that gets no answer after herdr rests ends within the wait");

      // a /clear in an empty chat reports working for a moment, with no turn: the greeting stays
      const blank = await page.evaluate(async () => {
        const response = await fetch("/api/workspace/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/home/demo/cleared", agent: { kind: "claude" } }) });
        return ((await response.json()) as { pane_id: string }).pane_id;
      });
      const row = page.locator(`.pane-select[title^="${blank} \u2014"]`).first();
      await row.waitFor({ state: "attached" });
      await row.evaluate((node: HTMLElement) => node.click());
      await page.locator(`.pane-select[title^="${blank} \u2014"][aria-current="true"]`).first().waitFor({ state: "attached" });
      await page.getByTitle("Chat transcript (\u2318\u21e7J)", { exact: true }).click();
      const greeting = page.locator(".pane-frame.is-current .composer-greeting");
      // the demo's new agent works for a moment first: it is greeted once it rests
      await greeting.waitFor({ timeout: 8_000 });
      await page.locator('.pane-frame.is-current .composer-status[data-status="idle"]').waitFor({ state: "attached", timeout: 8_000 });
      await painted(page);
      await record(page, blank);
      const greeted = page.evaluate(() => {
        const seen: boolean[] = [];
        const tick = (): void => {
          seen.push(document.querySelector(".pane-frame.is-current .composer-greeting") !== null);
          if ((window as unknown as { greetingFrames?: boolean[] }).greetingFrames === seen) requestAnimationFrame(tick);
        };
        (window as unknown as { greetingFrames?: boolean[] }).greetingFrames = seen;
        tick();
      });
      await greeted;
      await page.evaluate((id) => new Promise<void>((settled) => {
        const order = (window as unknown as { __herdrDemoOrder: { status(pane: string, status: string): void } }).__herdrDemoOrder;
        order.status(id, "working");
        const shown = (): void => {
          if (document.querySelector('.pane-frame.is-current .composer-status[data-status="working"]') === null) { requestAnimationFrame(shown); return; }
          // fixed wait: how long a /clear's working status lasted live (241\u2013549 ms)
          setTimeout(() => { order.status(id, "idle"); settled(); }, 400);
        };
        shown();
      }), blank);
      await painted(page);
      const cleared = await stop(page);
      const greetingFrames = await page.evaluate(() => {
        const w = window as unknown as { greetingFrames?: boolean[] };
        const seen = w.greetingFrames ?? [];
        delete w.greetingFrames;
        return seen;
      });
      assert.ok(greetingFrames.length > 0 && greetingFrames.every(Boolean), "the greeting stays through a /clear's working status");
      assert.deepEqual(cleared.filter((frame) => frame.footer.length > 0).map((frame) => frame.footer), [], "no Working head stands under the greeting");
      assert.deepEqual(errors, []);
      console.log("PASS a short working status over an empty chat keeps its greeting");
      await context.close();
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
