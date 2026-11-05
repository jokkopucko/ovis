import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A message the reader sends from this browser's composer brings the chat back to its end once
// the bridge has accepted it (an immediate submit-result with ok and no pending), unless the reader
// scrolls, pages or jumps before the receipt or before the transcript shows the turn. Remote
// sends, queued and Send now deliveries, refusals, uncertain receipts, a pane switch and a reconnect
// keep the reader's place. Run on the unmodified app over the demo's fixture transport, with the
// submit receipts and the transcript reads gated so each ordering is forced rather than timed.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-local-follow-demo-"));
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const results: { name: string; ok: boolean; detail: Record<string, unknown> }[] = [];
/** the step under way, named in the failure so a timeout says what it waited for */
let step = "";

const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const PANE = panes.omp;
const OTHER = panes.api;
const REPLY = "This is the demo, so nothing ran.";
const WAIT = { timeout: 10_000 } as const;

interface Lab {
  holdReceipts: boolean; holdReads: boolean; refuse: string | null; uncertain: string | null;
  held: (() => void)[]; reads: (() => void)[]; receipts: number; delivered: number; submits: number;
  readsServed: number; status: string | null;
  releaseReceipts: () => number; releaseReads: () => number; remoteSend: (text: string) => Promise<void>; dropConnection: () => number;
}

/** What the chat's own geometry says: the end gap, the latest rendered row and the reader's anchor row. */
interface Geometry {
  gap: number; scrollTop: number; scrollHeight: number;
  last: { key: string; top: number; bottom: number; text: string } | null;
  anchor: { text: string; offset: number } | null;
  viewTop: number; viewBottom: number; composerFocused: boolean; newMessages: boolean; away: boolean;
}

const geometry = (page: Page): Promise<Geometry> => page.evaluate(() => {
  const view = document.querySelector<HTMLElement>(".chat-view")!;
  const box = view.getBoundingClientRect();
  const rows = [...view.querySelectorAll<HTMLElement>("[data-chat-row]")].map((row) => ({ key: row.dataset.chatRow ?? "", rect: row.getBoundingClientRect(), text: (row.textContent ?? "").replace(/\s+/g, " ").trim() }));
  const last = rows.reduce<(typeof rows)[number] | null>((best, row) => best === null || row.rect.bottom > best.rect.bottom ? row : best, null);
  const top = rows.filter((row) => row.rect.bottom > box.top).sort((a, b) => a.rect.top - b.rect.top)[0];
  const composer = document.querySelector(".composer-text");
  const jump = document.querySelector<HTMLElement>(".chat-new-messages");
  return {
    gap: view.scrollHeight - view.clientHeight - view.scrollTop, scrollTop: view.scrollTop, scrollHeight: view.scrollHeight,
    last: last === null ? null : { key: last.key, top: last.rect.top, bottom: last.rect.bottom, text: last.text.slice(0, 160) },
    anchor: top === undefined ? null : { text: top.text.slice(0, 80), offset: top.rect.top - box.top },
    viewTop: box.top, viewBottom: box.bottom, composerFocused: composer !== null && document.activeElement === composer,
    newMessages: jump !== null && !jump.classList.contains("is-icon"), away: jump !== null,
  };
});

/** The latest row says `text` and sits wholly on screen at the chat's end. */
const latestShows = (page: Page, text: string): Promise<unknown> => page.waitForFunction((words) => {
  const view = document.querySelector<HTMLElement>(".chat-view");
  if (!view) return false;
  const box = view.getBoundingClientRect();
  const rows = [...view.querySelectorAll<HTMLElement>("[data-chat-row]")];
  const last = rows.reduce<HTMLElement | null>((best, row) => best === null || row.getBoundingClientRect().bottom > best.getBoundingClientRect().bottom ? row : best, null);
  if (last === null || !(last.textContent ?? "").includes(words)) return false;
  const rect = last.getBoundingClientRect();
  return view.scrollHeight - view.clientHeight - view.scrollTop <= 1 && rect.bottom <= box.bottom + 1 && rect.bottom > box.top;
}, text, WAIT);

const lab = <T,>(page: Page, fn: (lab: Lab) => T | Promise<T>): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.followLab)`) as Promise<T>;
const until = (page: Page, condition: string): Promise<unknown> => page.waitForFunction(`(() => { const lab = window.followLab; return ${condition}; })()`, undefined, WAIT);
/** Two painted frames: a state update the page already took has been committed and laid out. */
const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
/** The agent took the last turn and answered it: the next send from the box goes out at once. */
/** The chat proved its end is presented (no follow still pending in the list): a wheel now is the reader's alone. */
const settled = (page: Page): Promise<void> => page.locator(".chat-frame[data-pane-content]").waitFor({ state: "attached", ...WAIT });
const idle = (page: Page): Promise<unknown> => until(page, `lab.status !== "working"`);

/** Scrolls the transcript up with the reader's own wheel, a notch at a time, as a mouse does. */
const wheelUp = async (page: Page, by = 900): Promise<void> => {
  const view = await page.locator(".chat-view").boundingBox();
  assert.ok(view !== null);
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  for (let moved = 0; moved < by; moved += 120) {
    // Measured as the distance from the end: rows above the view that the list measures meanwhile
    // raise scrollTop by their growth to keep the reader's rows in place, which can undo a notch's
    // move in scrollTop but never in that distance.
    const before = (await geometry(page)).gap;
    await page.mouse.wheel(0, -120);
    await page.waitForFunction((gap) => {
      const node = document.querySelector<HTMLElement>(".chat-view");
      return node !== null && node.scrollHeight - node.clientHeight - node.scrollTop > gap + 20;
    }, before, WAIT);
  }
  await frames(page);
};

const sameAnchor = (before: Geometry, after: Geometry, label: string): void => {
  assert.ok(before.anchor !== null && after.anchor !== null, `${label}: an anchor row is on screen`);
  assert.equal(after.anchor.text, before.anchor.text, `${label}: the reader's top row stays the same`);
  assert.ok(Math.abs(after.anchor.offset - before.anchor.offset) <= 2, `${label}: the top row stays within 2px (${before.anchor.offset} -> ${after.anchor.offset})`);
  assert.ok(after.gap > 200, `${label}: the view stays away from the end (gap ${after.gap})`);
};

/** Waits until a transcript read carrying more than before was committed and laid out. */
const committed = async (page: Page, height: number): Promise<void> => {
  await page.waitForFunction((before) => (document.querySelector<HTMLElement>(".chat-view")?.scrollHeight ?? 0) > before, height, WAIT);
  await frames(page);
};

const record = (name: string, detail: Record<string, unknown>): void => {
  results.push({ name, ok: true, detail });
  console.log(`PASS ${name}`);
};

const shot = async (page: Page, name: string): Promise<void> => {
  if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) });
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Over the demo's own transport: the omp pane's transcript reads answer forty-eight long filler
  // turns ahead of its own, so the chat scrolls; each socket's submit-result can be held and
  // released (window.followLab), refused before anything is typed, or answered as uncertain; and
  // the pane's transcript reads can be held until released. A second demo socket stands for
  // another browser on the same bridge. Everything else is the demo's.
  const gates = `<script>(() => {
    const target = ${JSON.stringify(PANE)};
    const demo = window.fetch;
    const fillers = Array.from({ length: 48 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant", ts: "2026-10-12T00:00:00.000Z", ...(i % 2 === 0 ? {} : { end_ts: "2026-10-12T00:00:01.000Z" }),
      parts: [{ kind: "text", ...(i % 2 === 0 ? {} : { phase: "final_answer" }), text: "Filler " + i + ". " + "A longer line that wraps across the chat column so the transcript scrolls. ".repeat(3 + (i % 4)) }],
    }));
    const lab = window.followLab = { holdReceipts: false, holdReads: false, refuse: null, uncertain: null, held: [], reads: [], receipts: 0, delivered: 0, submits: 0, readsServed: 0, status: null };
    const DemoSocket = window.WebSocket;
    const sockets = new Set();
    const Socket = function (...args) {
      const socket = new DemoSocket(...args);
      sockets.add(socket);
      const push = socket.push.bind(socket);
      const send = socket.send.bind(socket);
      socket.push = (message) => {
        if (message && message.type === "pane-status" && message.pane_id === target) lab.status = message.agent_status;
        if (!message || message.type !== "submit-result" || message.pane_id !== target) { push(message); return; }
        lab.receipts += 1;
        const reply = lab.uncertain ? { type: "submit-result", id: message.id, pane_id: message.pane_id, ok: false, code: lab.uncertain, message: "The demo could not confirm this message." } : message;
        if (lab.holdReceipts) { lab.held.push(() => push(reply)); return; }
        push(reply); lab.delivered += 1;
      };
      socket.send = (raw) => {
        let message = null;
        try { message = JSON.parse(raw); } catch {}
        if (message && message.type === "submit" && message.pane_id === target) {
          lab.submits += 1;
          if (lab.refuse) {
            const code = lab.refuse;
            queueMicrotask(() => socket.push({ type: "submit-result", id: message.id, pane_id: message.pane_id, ok: false, code, message: "The demo agent is not ready." }));
            return;
          }
        }
        send(raw);
      };
      return socket;
    };
    Socket.prototype = DemoSocket.prototype;
    Object.setPrototypeOf(Socket, DemoSocket);
    window.WebSocket = Socket;
    lab.releaseReceipts = () => { const held = lab.held.splice(0); for (const deliver of held) { deliver(); lab.delivered += 1; } return held.length; };
    lab.releaseReads = () => { lab.holdReads = false; const held = lab.reads.splice(0); for (const serve of held) serve(); return held.length; };
    lab.dropConnection = () => { let dropped = 0; for (const socket of sockets) if (socket.readyState === 1) { socket.close(4000, "demo drop"); dropped += 1; } return dropped; };
    // another browser on the same bridge: its own socket, its own receipt
    lab.remoteSend = (text) => new Promise((resolve) => {
      const other = new DemoSocket(location.origin.replace(/^http/, "ws") + "/ws");
      other.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "submit-result" && message.id === 9001) { other.close(); resolve(); }
      });
      other.addEventListener("open", () => other.send(JSON.stringify({ type: "submit", id: 9001, pane_id: target, text, payload: text })));
    });
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname !== "/api/pane/conversation" || url.searchParams.get("pane_id") !== target) return demo(input, init);
      const serve = () => Promise.resolve(demo(input, init)).then(async (response) => {
        if (!response.ok) return response;
        const body = await response.json();
        if (Array.isArray(body.turns)) body.turns = [...fillers, ...body.turns];
        lab.readsServed += 1;
        return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
      });
      if (!lab.holdReads) return serve();
      return new Promise((resolve) => { lab.reads.push(() => resolve(serve())); });
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${gates}\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      try {
        await desktop.addInitScript((ids) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
        }, [PANE, OTHER]);
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".terminal-stack.is-chat").waitFor();
        await page.waitForFunction(() => document.querySelectorAll("[data-chat-row]").length > 3, undefined, WAIT);
        await appFaces(page);
        const composer = page.getByRole("textbox", { name: "Message", exact: true });
        const send = async (text: string): Promise<void> => {
          await composer.fill(text);
          await composer.press("Enter");
        };
        // gates are always released, so a failed assertion never leaves a held read behind it
        const releaseAll = (): Promise<unknown> => lab(page, (l) => { l.holdReceipts = false; l.refuse = null; l.uncertain = null; return [l.releaseReceipts(), l.releaseReads()]; });

        // 0. a reader at the end sends: the faded bubble is painted at the end, wholly above the
        // composer, until its turn is read. The bubble is the chat's footer, no row, and the list's
        // scroll to the end is aimed at the footer it measured before the bubble came.
        try {
          step = "a sent message's bubble is painted at the end: the reader follows the end";
          await settled(page);
          await lab(page, (l) => { l.holdReads = true; });
          // Each painted frame as its requestAnimationFrame saw it, or as a ResizeObserver callback
          // of that frame left it (rAF, layout, ResizeObserver, paint). This observer is made after
          // the chat's own, so it runs after them.
          await page.evaluate(() => {
            const view = document.querySelector<HTMLElement>(".chat-view")!;
            const look = () => {
              const bubble = view.querySelector(".chat-sent-waiting-list");
              return { gap: Math.round(view.scrollHeight - view.clientHeight - view.scrollTop), below: bubble === null ? null : Math.round(bubble.getBoundingClientRect().bottom - view.getBoundingClientRect().bottom) };
            };
            const painted: { gap: number; below: number | null }[] = [];
            let frame = look();
            const observer = new ResizeObserver(() => { frame = look(); });
            observer.observe(view.querySelector(".chat-virtual-footer")!);
            let id = 0;
            const tick = () => { painted.push(frame); frame = look(); id = requestAnimationFrame(tick); };
            id = requestAnimationFrame(tick);
            Object.assign(window, { paintedFrames: painted, stopPainted: () => { cancelAnimationFrame(id); observer.disconnect(); painted.push(frame); } });
          });
          const text = "Local follow: the bubble at the end";
          await send(text);
          await page.locator(".chat-sent-waiting-list").waitFor(WAIT);
          await page.waitForFunction(() => (window as unknown as { paintedFrames: { below: number | null }[] }).paintedFrames.filter((frame) => frame.below !== null).length >= 10, undefined, WAIT);
          const painted = await page.evaluate(() => {
            const w = window as unknown as { paintedFrames: { gap: number; below: number | null }[]; stopPainted: () => void };
            w.stopPainted();
            return w.paintedFrames.filter((frame) => frame.below !== null);
          });
          const short = painted.filter((frame) => frame.gap > 1 || frame.below! > 1);
          assert.deepEqual(short, [], `no frame paints the bubble short of the end or under the composer (${JSON.stringify(painted)})`);
          await shot(page, "local-follow-1280-dark-bubble");
          step = "a sent message's bubble is painted at the end: its turn takes its place";
          await lab(page, (l) => l.releaseReads());
          await latestShows(page, text);
          await latestShows(page, REPLY);
          record("a sent message's bubble is painted at the end, wholly above the composer", { frames: painted.length, gaps: [...new Set(painted.map((frame) => frame.gap))] });
        } finally { await releaseAll(); }
        await idle(page);

        // 1. accepted immediate local send resumes follow
        try {
          step = "accepted immediate local send resumes follow: the reader moves away";
          await settled(page);
          await wheelUp(page, 2400);
          const away = await geometry(page);
          assert.ok(away.gap > 400 && away.away, `the reader is away from the end (gap ${away.gap})`);
          await shot(page, "local-follow-1280-dark-away");
          await lab(page, (l) => { l.holdReceipts = true; l.holdReads = true; });
          const text = "Local follow: accepted send";
          await send(text);
          await until(page, "lab.held.length === 1");
          const pending = await geometry(page);
          assert.ok(pending.gap > 400, "nothing moves before the bridge accepted the message");
          step = "accepted immediate local send resumes follow: the accepted receipt brings the view to the end";
          await lab(page, (l) => { l.holdReceipts = false; return l.releaseReceipts(); });
          // the follow is engaged at once: the end of what the transcript holds so far
          await page.waitForFunction(() => { const node = document.querySelector<HTMLElement>(".chat-view"); return node !== null && node.scrollHeight - node.clientHeight - node.scrollTop <= 1; }, undefined, WAIT);
          await lab(page, (l) => l.releaseReads());
          step = "accepted immediate local send resumes follow: the published turn is the latest row on screen";
          await latestShows(page, text);
          const latest = await geometry(page);
          // the agent's answer arrives later and is followed too, with the focus left in the box
          await latestShows(page, REPLY);
          const answered = await geometry(page);
          assert.ok(answered.last !== null && latest.last !== null && answered.last.key !== latest.last.key, "the answer is a newer row than the send");
          assert.ok(answered.composerFocused, "the message box keeps the focus");
          await shot(page, "local-follow-1280-dark-latest");
          record("accepted immediate local send resumes follow", { away: away.gap, beforeReceipt: pending.gap, latest: latest.last, answered: answered.last, gap: answered.gap, composerFocused: answered.composerFocused });
        } finally { await releaseAll(); }
        await idle(page);

        // 2. navigation before receipt cancels follow
        try {
          step = "navigation before receipt cancels follow";
          await settled(page);
          await wheelUp(page, 2400);
          await lab(page, (l) => { l.holdReceipts = true; l.holdReads = true; });
          const text = "Local follow: navigated before receipt";
          await send(text);
          await until(page, "lab.held.length === 1");
          await wheelUp(page, 600);
          const chosen = await geometry(page);
          await lab(page, (l) => { l.holdReceipts = false; return l.releaseReceipts(); });
          await lab(page, (l) => l.releaseReads());
          await committed(page, chosen.scrollHeight);
          await page.locator(".chat-new-messages:not(.is-icon)").waitFor(WAIT);
          const after = await geometry(page);
          sameAnchor(chosen, after, "navigation before receipt");
          assert.ok(after.newMessages, "the way back says new messages arrived");
          await shot(page, "local-follow-1280-dark-cancelled");
          record("navigation before receipt cancels follow", { chosen: chosen.anchor, after: after.anchor, gap: after.gap });
        } finally { await releaseAll(); }
        await idle(page);

        // 2b. a scrollbar thumb held past the input window, then dragged up before the receipt, cancels follow:
        // a small drag (inside the layout allowance) and a large one (past it), with the drag's scroll
        // delivered before the thumb is let go and after it
        for (const [distance, scrollFirst] of [[30, true], [30, false], [200, true], [200, false]] as const) {
          const label = `held thumb dragged ${distance}px, scroll ${scrollFirst ? "before" : "after"} release, cancels follow`;
          try {
            step = label;
            // back at the end and following before the send, as the previous step left the reader away
            await page.locator(".chat-new-messages").click();
            await latestShows(page, REPLY);
            await settled(page);
            await lab(page, (l) => { l.holdReceipts = true; l.holdReads = true; });
            await send(`Local follow: thumb ${distance} ${scrollFirst ? "scrolled" : "released"} first`);
            await until(page, "lab.held.length === 1");
            await page.locator(".chat-view").evaluate(async (node, [by, scrolledFirst]) => {
              if (!(node instanceof HTMLElement)) throw new Error("Missing chat scroller");
              node.dispatchEvent(new Event("scroll"));
              // a press on the scrollbar: the scroller itself, right of its content box
              const bar = node.getBoundingClientRect();
              const pressed = { clientX: bar.left + node.clientWidth, clientY: bar.bottom - 20 };
              node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1, ...pressed }));
              const letGo = () => node.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: pressed.clientX, clientY: pressed.clientY - by }));
              // the thumb rests past the 500 ms input window before it is dragged: no pointermove comes
              const now = performance.now.bind(performance);
              Object.defineProperty(performance, "now", { configurable: true, value: () => now() + 600 });
              node.scrollTop -= by;
              if (scrolledFirst) { node.dispatchEvent(new Event("scroll")); letGo(); } else { letGo(); node.dispatchEvent(new Event("scroll")); }
              Reflect.deleteProperty(performance, "now");
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }, [distance, scrollFirst] as const);
            await frames(page);
            const chosen = await geometry(page);
            assert.ok(chosen.gap > 1, `${label}: the drag left the end (gap ${chosen.gap})`);
            await lab(page, (l) => { l.holdReceipts = false; return l.releaseReceipts(); });
            await lab(page, (l) => l.releaseReads());
            await committed(page, chosen.scrollHeight);
            await frames(page);
            const after = await geometry(page);
            assert.ok(after.gap >= chosen.gap - 2, `${label}: the receipt does not take the reader back to the end (gap ${chosen.gap} -> ${after.gap})`);
            record(label, { chosen: chosen.gap, after: after.gap });
          } finally { await releaseAll(); }
          await idle(page);
        }

        // 3. navigation before transcript publication cancels follow
        try {
          step = "navigation before transcript publication cancels follow";
          await page.locator(".chat-new-messages").click();
          await latestShows(page, REPLY);
          await settled(page);
          await wheelUp(page, 2400);
          await lab(page, (l) => { l.holdReceipts = true; l.holdReads = true; });
          const text = "Local follow: navigated before publication";
          await send(text);
          await until(page, "lab.held.length === 1");
          await lab(page, (l) => { l.holdReceipts = false; return l.releaseReceipts(); });
          await page.waitForFunction(() => { const node = document.querySelector<HTMLElement>(".chat-view"); return node !== null && node.scrollHeight - node.clientHeight - node.scrollTop <= 1; }, undefined, WAIT);
          await wheelUp(page, 900);
          const chosen = await geometry(page);
          await lab(page, (l) => l.releaseReads());
          await committed(page, chosen.scrollHeight);
          await page.locator(".chat-new-messages:not(.is-icon)").waitFor(WAIT);
          const after = await geometry(page);
          sameAnchor(chosen, after, "navigation before publication");
          record("navigation before transcript publication cancels follow", { chosen: chosen.anchor, after: after.anchor, gap: after.gap });
        } finally { await releaseAll(); }
        await idle(page);

        // 4. remote pending refused and hydrated sends preserve place
        const kept: Record<string, unknown> = {};
        try {
          step = "remote pending refused and hydrated sends preserve place: refused";
          await page.locator(".chat-new-messages").click();
          await latestShows(page, REPLY);
          await settled(page);
          await wheelUp(page, 2400);
          // refused before anything was typed: the words stay in the box with the reason
          let before = await geometry(page);
          await lab(page, (l) => { l.refuse = "agent_not_ready"; });
          await send("Local follow: refused");
          await page.locator(".composer-note").waitFor(WAIT);
          await until(page, "lab.receipts >= 1 && lab.held.length === 0");
          await frames(page);
          sameAnchor(before, await geometry(page), "refused send");
          assert.equal(await composer.inputValue(), "Local follow: refused", "a refused message stays in the box");
          await lab(page, (l) => { l.refuse = null; });
          kept.refused = true;
          step = "remote pending refused and hydrated sends preserve place: uncertain";

          // uncertain: the bridge could not say whether it was typed. The demo did take it, so the
          // transcript moves; the view does not, and nothing is sent again
          await composer.fill("");
          before = await geometry(page);
          const submits = await lab(page, (l) => l.submits);
          await lab(page, (l) => { l.uncertain = "submit_failed"; });
          await send("Local follow: uncertain");
          await committed(page, before.scrollHeight);
          await page.locator(".composer-note").waitFor(WAIT);
          sameAnchor(before, await geometry(page), "uncertain send");
          assert.equal(await lab(page, (l) => l.submits), submits + 1, "an uncertain message is never sent again by itself");
          await lab(page, (l) => { l.uncertain = null; });
          await idle(page);
          kept.uncertain = true;
          step = "remote pending refused and hydrated sends preserve place: remote";

          // another browser's message (a remote prompt) moves the transcript, not this reader
          await composer.fill("");
          before = await geometry(page);
          await lab(page, (l) => l.remoteSend("Local follow: from another browser"));
          await committed(page, before.scrollHeight);
          sameAnchor(before, await geometry(page), "remote send");
          kept.remote = true;
          step = "remote pending refused and hydrated sends preserve place: queued and Send now";

          // while the agent works the box queues: an accepted pending receipt is no local follow,
          // and neither is its Send now delivery
          await until(page, `lab.status === "working"`);
          before = await geometry(page);
          const delivered = await lab(page, (l) => l.delivered);
          await send("Local follow: queued");
          await until(page, `lab.delivered > ${delivered}`);
          const sendNow = page.getByRole("button", { name: /^Send now: Local follow: queued/ });
          await sendNow.waitFor(WAIT);
          await frames(page);
          sameAnchor(before, await geometry(page), "queued send");
          await sendNow.click();
          await committed(page, before.scrollHeight);
          sameAnchor(before, await geometry(page), "Send now");
          await idle(page);
          kept.queued = true;
          step = "remote pending refused and hydrated sends preserve place: pane switch";

          // a pane switch before the receipt: the receipt lands on no chat, the other pane is not
          // repinned, and coming back hydrates the remembered place rather than the end
          before = await geometry(page);
          await lab(page, (l) => { l.holdReceipts = true; });
          await send("Local follow: switched away");
          await until(page, "lab.held.length === 1");
          await page.locator(`[data-pane="${OTHER}"]`).first().click();
          await page.waitForFunction((id) => new URL(location.href).searchParams.get("pane") === id, OTHER, WAIT);
          await page.waitForFunction(() => document.querySelectorAll("[data-chat-row]").length > 0, undefined, WAIT);
          await frames(page);
          const other = await geometry(page);
          await lab(page, (l) => { l.holdReceipts = false; return l.releaseReceipts(); });
          await frames(page);
          const otherAfter = await geometry(page);
          assert.equal(otherAfter.scrollTop, other.scrollTop, "the other pane is not moved by an earlier pane's receipt");
          const served = await lab(page, (l) => l.readsServed);
          await page.locator(`[data-pane="${PANE}"]`).first().click();
          await page.waitForFunction((id) => new URL(location.href).searchParams.get("pane") === id, PANE, WAIT);
          await page.waitForFunction(() => document.querySelectorAll("[data-chat-row]").length > 3, undefined, WAIT);
          await until(page, `lab.readsServed > ${served}`);
          await frames(page);
          const back = await geometry(page);
          assert.ok(back.gap > 200, `the remembered place is hydrated, not the end (gap ${back.gap})`);
          assert.equal(back.anchor?.text, before.anchor?.text, "the remembered top row comes back");
          await idle(page);
          kept.paneSwitch = { other: other.scrollTop, otherAfter: otherAfter.scrollTop, back: back.anchor };
          step = "remote pending refused and hydrated sends preserve place: reconnect";

          // a reconnect before the receipt: the old connection's answer never arrives, nothing is
          // sent again by itself, and the view stays
          await composer.fill("");
          before = await geometry(page);
          const sentBefore = await lab(page, (l) => l.submits);
          await lab(page, (l) => { l.holdReceipts = true; });
          await send("Local follow: reconnect");
          await until(page, "lab.held.length === 1");
          await lab(page, (l) => l.dropConnection());
          await page.locator(".conn-live").waitFor({ state: "attached", ...WAIT });
          await lab(page, (l) => { l.holdReceipts = false; return l.releaseReceipts(); });
          await frames(page);
          sameAnchor(before, await geometry(page), "reconnect");
          assert.equal(await lab(page, (l) => l.submits), sentBefore + 1, "nothing is sent again after the reconnect");
          kept.reconnect = true;
          await shot(page, "local-follow-1280-dark-kept");
          record("remote pending refused and hydrated sends preserve place", kept);
        } finally { await releaseAll(); }

        assert.deepEqual(errors, []);
      } finally { await desktop.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} catch (error) {
  console.error(`FAIL at step: ${step}`);
  throw error;
} finally {
  rmSync(app, { recursive: true, force: true });
  if (evidence) writeFileSync(join(evidence, "chat-local-send-follow.json"), `${JSON.stringify({ results }, null, 2)}\n`);
}
