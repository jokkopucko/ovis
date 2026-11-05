import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// A cancelled send the agent put back in its input box (`restored` on GET /api/pane/prompt), on
// the unmodified app over the demo's fixture transport: the composer takes the text back without
// taking the focus, the chat keeps the turn that send made out of view while they match, and
// typing or editing over the fill is never replaced or cleared. A message sent over the fill keeps
// that turn out too, until a read brings the new turn. All files and HTTP traffic stay in this
// disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-restored-draft-demo-"));

// playwright-core's bundle lazily requires packages the lockfile does not carry (chromium-bidi):
// fine at run time, unresolvable to `bun build` — so it is imported past the bundler's analysis
const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

/** what the transcript's trailing turn says — whitespace differs from the restored text on purpose */
const TURN_TEXT = "Rename the backup job\nand rerun it";
/** what the agent's input box holds again, as one line */
const RESTORED = "Rename the backup job and rerun it";

const extraTurn = (): unknown => ({ role: "user", ts: new Date().toISOString(), parts: [{ kind: "text", text: TURN_TEXT }] });

/** A transcript write, announced as a bridge with "conversation-watch" does: the chat reads on it. */
const announce = (page: Page): Promise<void> => page.evaluate(() => (window as unknown as { announceConversation: () => void }).announceConversation());

/** What the infra pane's prompt and conversation reads answer with from here on, announced as a transcript change. */
const feed = async (page: Page, restored: string | null, turn: unknown | null): Promise<void> => {
  await page.evaluate(([text, extra]) => {
    const view = window as unknown as { restoredText: string | null; extraTurn: unknown };
    view.restoredText = text;
    view.extraTurn = extra;
  }, [restored, turn] as const);
  await announce(page);
};

/** The composer box's value, waited for: the fills and clears under test are a poll away. */
const boxValue = (page: Page, expected: string): Promise<unknown> => page.waitForFunction(
  (value) => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === value,
  expected, { timeout: 10_000 },
);

/** How many prompt reads the page has asked for so far. */
const promptReads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { promptReads: number }).promptReads);

/**
 * Waits until the page asked for a prompt read after read `n`: the reads go one after another, so
 * by then read `n`'s answer has been applied. Counted after a feed, read count + 1 is the first one
 * asked for after it.
 */
const promptReadsPast = (page: Page, n: number): Promise<unknown> => page.waitForFunction(
  (count) => (window as unknown as { promptReads: number }).promptReads > count, n, { timeout: 10_000 },
);

/** A rendered turn saying the send's words: the transcript's own answer, when it stands. */
const turnShown = (page: Page): Promise<unknown> => page.waitForFunction(
  () => [...document.querySelectorAll(".chat-turn")].some((turn) => turn.textContent?.includes("Rename the backup job")),
  undefined, { timeout: 10_000 },
);

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // Over the demo's own fetch: the infra pane's prompt read answers `restored` as
  // window.restoredText names it, and its conversation read appends window.extraTurn while set —
  // the send the restored text belongs to, which herdr's transcript still holds. window.extraServed
  // counts the reads that carried the turn and window.promptReads the prompt reads, so a check can
  // wait for an answer to have landed. Everything else is the demo's.
  const restoredRead = `<script>(() => {
    const demo = window.fetch;
    const infra = ${JSON.stringify(panes.omp)};
    window.restoredText = null;
    window.promptOutcomes = [];
    window.extraTurn = null;
    window.extraServed = 0;
    window.promptReads = 0;
    // while set, a conversation read waits for window.releaseReads, then is served as the transcript is then
    window.holdReads = false;
    const heldReads = [];
    window.releaseReads = () => { window.holdReads = false; for (const release of heldReads.splice(0)) release(); };
    // the demo's sockets, so a transcript change can be announced on them as the bridge does
    const DemoSocket = window.WebSocket;
    const sockets = new Set();
    // a held row this check lists itself (window.heldRow), as the bridge would: its Send now goes out at
    // once (\`sending\`), and its receipt waits for window.answerSendNow
    window.heldRow = null;
    window.sendNowAsked = null;
    window.pushPending = (messages, removed) => { for (const socket of sockets) socket.push({ type: "pending-messages", pane_id: infra, messages, ...(removed ? { removed } : {}) }); };
    window.answerSendNow = () => {
      window.pushPending([], [{ id: window.heldRow.id, outcome: "sent" }]);
      for (const socket of sockets) socket.push({ type: "pending-result", id: window.sendNowAsked.id, pane_id: infra, pending_id: window.heldRow.id, ok: true });
    };
    const Socket = function (...args) {
      const socket = new DemoSocket(...args);
      sockets.add(socket);
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        let frame = null;
        try { frame = JSON.parse(raw); } catch { /* no frame of this check's */ }
        if (frame?.type !== "pending-action" || window.heldRow === null || frame.pending_id !== window.heldRow.id) return send(raw);
        window.sendNowAsked = frame;
        window.pushPending([{ ...window.heldRow, state: "sending" }]);
      };
      return socket;
    };
    Socket.prototype = DemoSocket.prototype;
    Object.setPrototypeOf(Socket, DemoSocket);
    window.WebSocket = Socket;
    let signature = 0;
    window.announceConversation = () => {
      signature += 1;
      for (const socket of sockets) socket.push({ type: "conversation-changed", pane_id: infra, signature: "restored:" + signature });
    };
    const json = (body) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    window.imageUploads = 0;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname === "/api/pane/image") {
        window.imageUploads += 1;
        return json({ path: "/tmp/notes.txt" });
      }
      if (url.searchParams.get("pane_id") !== infra) return demo(input, init);
      if (url.pathname === "/api/pane/prompt") {
        window.promptReads += 1;
        return json({ prompt: null, suggestion: null, restored: window.restoredText, outcomes: window.promptOutcomes });
      }
      if (url.pathname === "/api/pane/conversation" && window.holdReads) return new Promise((resolve) => heldReads.push(() => resolve(window.fetch(input, init))));
      if (url.pathname === "/api/pane/conversation" && window.extraTurn !== null && !url.searchParams.has("before") && !url.searchParams.has("from")) {
        return Promise.resolve(demo(input, init)).then(async (response) => {
          if (!response.ok) return response;
          const body = await response.json();
          if (Array.isArray(body.turns)) {
            body.turns.push(window.extraTurn);
            window.extraServed += 1;
          }
          return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
        });
      }
      return demo(input, init);
    };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `<script src="./demo-transport.js"></script>\n    ${restoredRead}\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.omp)}`;
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
      try {
        await desktop.addInitScript((paneId) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          localStorage.setItem(`ovis:view:${paneId}`, "chat");
        }, panes.omp);
        const page = await desktop.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".terminal-stack.is-chat").waitFor();
        // the fixture's own two turns, before the send's turn joins them
        await page.waitForFunction(() => document.querySelectorAll(".chat-turn").length === 2, undefined, { timeout: 10_000 });
        await appFaces(page);
        const composer = page.getByRole("textbox", { name: "Message", exact: true });

        // a send the agent restored fills an empty composer — without the focus, which would raise
        // a phone's keyboard — and the chat keeps the turn that send made out of view while the
        // read still carries it (whitespace differs on purpose, as a terminal wrapped it). A desktop
        // composer takes the focus when the pane opens: put it away so the fill is what is checked
        await composer.evaluate((node) => (node as HTMLElement).blur());
        await feed(page, RESTORED, extraTurn());
        await boxValue(page, RESTORED);
        // the reads run one after another: a second read served means the first one's answer was drawn
        await page.waitForFunction(() => (window as unknown as { extraServed: number }).extraServed >= 1, undefined, { timeout: 10_000 });
        await announce(page);
        await page.waitForFunction(() => (window as unknown as { extraServed: number }).extraServed >= 2, undefined, { timeout: 10_000 });
        assert.equal(await page.locator(".chat-turn").count(), 2, "the transcript read carried the send's turn; it is not rendered");
        const shown = await page.locator(".chat-turn").allTextContents();
        assert.ok(shown.every((text) => !text.includes("Rename the backup job")), `no turn shows the restored send: ${JSON.stringify(shown)}`);
        assert.equal(await composer.evaluate((node) => document.activeElement === node), false, "a restored fill does not take the focus");
        console.log("PASS a send the agent restored fills an empty composer without focus, and the chat keeps that send's turn out");

        // gone from the agent's box: the untouched fill is cleared, never kept as a draft — and
        // the transcript settles back to what the reads answer
        await feed(page, null, null);
        await boxValue(page, "");
        await page.waitForFunction(() => document.querySelectorAll(".chat-turn").length === 2, undefined, { timeout: 10_000 });
        console.log("PASS the fill goes with the restored send once the agent's box no longer holds it");

        // the same send restored again, then edited: the fill became the user's words, so the
        // send going away leaves them alone (its turn stands again in the transcript, which is
        // how the poll's landing is seen)
        await feed(page, RESTORED, extraTurn());
        await boxValue(page, RESTORED);
        const edited = `${RESTORED} twice`;
        await composer.fill(edited);
        await boxValue(page, edited);
        await feed(page, null, extraTurn());
        const after = await promptReads(page);
        await turnShown(page);
        await promptReadsPast(page, after + 1);
        assert.equal(await composer.inputValue(), edited, "an edited fill is never cleared");
        console.log("PASS a fill the user edited is theirs and stays when the restored send goes away");

        // a box already holding the user's own words is never overwritten by a restored send
        const own = "my own words";
        await composer.fill(own);
        await boxValue(page, own);
        await feed(page, "something else restored", extraTurn());
        await promptReadsPast(page, await promptReads(page) + 1);
        assert.equal(await composer.inputValue(), own, "the user's own draft is never replaced");
        console.log("PASS a composer holding the user's own words is never overwritten by a restored send");

        // an upload that finished while the box held only a restored `/command` waits on it, and
        // its path goes in once the fill is cleared
        await composer.fill("");
        await boxValue(page, "");
        await feed(page, "/compact", null);
        await boxValue(page, "/compact");
        await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
        await page.waitForFunction(() => (window as unknown as { imageUploads: number }).imageUploads === 1, undefined, { timeout: 10_000 });
        await page.waitForTimeout(300); // fixed wait: the upload may not replace the restored /compact command
        assert.equal(await composer.inputValue(), "/compact", "the path waits on the restored command");
        await feed(page, null, null);
        await boxValue(page, "@/tmp/notes.txt ");
        console.log("PASS a path that waited on a restored /command goes in once the fill is cleared");

        // the fill replaced by a new message and sent: the send empties the agent's box, so the next
        // prompt read answers no restored send while the transcript still ends with the cancelled
        // turn (the agent has not written the new one yet). That turn stays out until a read brings
        // the new one, which leaves it off the transcript's active chain
        await composer.fill("");
        const served = await page.evaluate(() => (window as unknown as { extraServed: number }).extraServed);
        await feed(page, RESTORED, extraTurn());
        await boxValue(page, RESTORED);
        await page.waitForFunction((count) => (window as unknown as { extraServed: number }).extraServed > count, served, { timeout: 10_000 });
        await announce(page);
        await page.waitForFunction((count) => (window as unknown as { extraServed: number }).extraServed > count + 1, served, { timeout: 10_000 });
        // the cancelled send's turn, or its outcome drawn as a sent row (.chat-turn-sent)
        const cancelledShown = (): Promise<number> => page.locator(".chat-turn", { hasText: "Rename the backup job" }).count();
        assert.equal(await cancelledShown(), 0, "the restored send's turn is out of view");
        // the bridge lists the cancelled send's outcome too: it gets no sent row while its turn is out
        await page.evaluate((text) => {
          const at = new Date(Date.now() - 1000).toISOString();
          Object.assign(window, { promptOutcomes: [{ id: "cancelled", pane_id: "", text, state: "accepted", evidence: [], created_at: at, updated_at: at }] });
        }, RESTORED);
        await promptReadsPast(page, await promptReads(page) + 1);
        assert.equal(await cancelledShown(), 0, "the restored send's outcome is out of view");
        /** a message from the composer, once the agent is at rest (Stop gives way to Send) */
        const sendAtRest = async (text: string): Promise<void> => {
          await page.locator(".composer-stop").waitFor({ state: "detached", timeout: 10_000 });
          await composer.fill(text);
          await page.getByRole("button", { name: "Send message", exact: true }).click();
          await page.locator(".chat-sent-waiting-list", { hasText: text }).waitFor({ timeout: 10_000 });
        };
        const release = async (text: string): Promise<void> => {
          await page.evaluate(() => { const view = window as unknown as { extraTurn: unknown; releaseReads: () => void }; view.extraTurn = null; view.releaseReads(); });
          await page.locator("[data-chat-row] .chat-turn", { hasText: text }).waitFor({ timeout: 10_000 });
        };
        const next = "Reply with one word";
        await composer.fill(next);
        // the box empties as the message goes, in one task: no prompt read answers between the two
        await page.evaluate(() => {
          Object.assign(window, { holdReads: true, restoredText: null });
          document.querySelector<HTMLButtonElement>(".composer-send")!.click();
        });
        await page.locator(".chat-sent-waiting-list", { hasText: next }).waitFor({ timeout: 10_000 });
        await promptReadsPast(page, await promptReads(page) + 1);
        assert.equal(await cancelledShown(), 0, "the cancelled turn and its outcome stay out after the send");
        // a second message before the transcript has the first: the box was empty at its send
        await sendAtRest("And a second one");
        await promptReadsPast(page, await promptReads(page) + 1);
        assert.equal(await cancelledShown(), 0, "a second send keeps the cancelled turn out while the transcript is unchanged");
        await page.evaluate(() => { Object.assign(window, { promptOutcomes: [] }); });
        await promptReadsPast(page, await promptReads(page) + 1);
        await release("And a second one");
        assert.equal(await cancelledShown(), 0, "the new turns' read leaves the cancelled one out");
        console.log("PASS a message sent over a restored send keeps that send's turn and outcome out until the new turn is read");

        // A Send now empties the box before its receipt: a prompt read between the two answers no
        // copy before the send counts. Here that read comes first: the turn stands again, as for a
        // copy cleared in the terminal, and the send that follows on the same turns takes it out
        const servedAgain = await page.evaluate(() => (window as unknown as { extraServed: number }).extraServed);
        await feed(page, RESTORED, extraTurn());
        await boxValue(page, RESTORED);
        await page.waitForFunction((count) => (window as unknown as { extraServed: number }).extraServed > count, servedAgain, { timeout: 10_000 });
        await announce(page);
        await page.waitForFunction((count) => (window as unknown as { extraServed: number }).extraServed > count + 1, servedAgain, { timeout: 10_000 });
        assert.equal(await cancelledShown(), 0, "restored again, the turn is out of view");
        await page.evaluate(() => { Object.assign(window, { holdReads: true, restoredText: null }); });
        await boxValue(page, "");
        await page.locator(".chat-turn", { hasText: "Rename the backup job" }).waitFor({ timeout: 10_000 });
        await sendAtRest("A third one");
        await promptReadsPast(page, await promptReads(page) + 1);
        assert.equal(await cancelledShown(), 0, "a send after the copy left the box keeps its turn out while the turns are unchanged");
        await release("A third one");
        assert.equal(await cancelledShown(), 0, "the new turn's read leaves the cancelled one out");
        console.log("PASS a send after the restored copy left the box keeps that send's turn out until the new turn is read");

        // Send now of a held row (a follow-up held over a stopped send's copy): the bridge empties the box
        // as the row starts going out, long before its receipt. The receipt waits here until a prompt read
        // answered the box empty: no painted frame meanwhile shows the cancelled turn. A row that went
        // out and came back held, never typed, leaves the copy as it was
        const servedLast = await page.evaluate(() => (window as unknown as { extraServed: number }).extraServed);
        await feed(page, RESTORED, extraTurn());
        await boxValue(page, RESTORED);
        await page.waitForFunction((count) => (window as unknown as { extraServed: number }).extraServed > count, servedLast, { timeout: 10_000 });
        await announce(page);
        await page.waitForFunction((count) => (window as unknown as { extraServed: number }).extraServed > count + 1, servedLast, { timeout: 10_000 });
        assert.equal(await cancelledShown(), 0, "restored once more, the turn is out of view");
        const follow = "Then reply PONG";
        type HeldRowCheck = { heldRow: { id: string } | null; holdReads: boolean; restoredText: string | null; pushPending: (messages: unknown[]) => void; answerSendNow: () => void; sendNowAsked: unknown; extraTurn: unknown; releaseReads: () => void; shownFrames: number; sampling: boolean };
        await page.evaluate((text) => {
          const view = window as unknown as HeldRowCheck;
          view.heldRow = { id: "held-follow-up", request_id: 901, text, state: "held", created_at: new Date().toISOString() } as HeldRowCheck["heldRow"];
          view.holdReads = true;
          view.pushPending([view.heldRow]);
        }, follow);
        const row = page.locator(".pending-message", { hasText: follow });
        await row.waitFor({ timeout: 10_000 });
        const painted = (): Promise<unknown> => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
        await page.evaluate(() => { const view = window as unknown as HeldRowCheck; view.pushPending([{ ...view.heldRow, state: "sending" }]); });
        await page.locator('.pending-message[data-state="sending"]').waitFor({ timeout: 10_000 });
        await painted();
        await page.evaluate(() => { const view = window as unknown as HeldRowCheck; view.pushPending([view.heldRow]); });
        await page.locator('.pending-message[data-state="held"]', { hasText: follow }).waitFor({ timeout: 10_000 });
        await page.evaluate(() => { Object.assign(window, { restoredText: null }); });
        await page.locator(".chat-turn", { hasText: "Rename the backup job" }).waitFor({ timeout: 10_000 });
        console.log("PASS a held row that went out and came back, never typed, leaves the cancelled turn as the copy left it");

        await page.evaluate((text) => { Object.assign(window, { restoredText: text }); }, RESTORED);
        await boxValue(page, RESTORED);
        await page.waitForFunction(() => ![...document.querySelectorAll(".chat-turn")].some((turn) => turn.textContent?.includes("Rename the backup job")), undefined, { timeout: 10_000 });
        await page.evaluate(() => {
          const view = window as unknown as HeldRowCheck;
          view.shownFrames = 0;
          view.sampling = true;
          const frame = (): void => {
            if ([...document.querySelectorAll(".chat-turn")].some((turn) => turn.textContent?.includes("Rename the backup job"))) view.shownFrames += 1;
            if (view.sampling) requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        });
        await row.getByRole("button", { name: /^Send now:/ }).click();
        await page.waitForFunction(() => (window as unknown as HeldRowCheck).sendNowAsked !== null, undefined, { timeout: 10_000 });
        await page.locator('.pending-message[data-state="sending"]').waitFor({ timeout: 10_000 });
        // the bridge emptied the box: a prompt read answers no copy, before the receipt
        await page.evaluate(() => { Object.assign(window, { restoredText: null }); });
        await promptReadsPast(page, await promptReads(page) + 1);
        await page.evaluate(() => (window as unknown as HeldRowCheck).answerSendNow());
        await page.locator(".chat-sent-waiting-list", { hasText: follow }).waitFor({ timeout: 10_000 });
        await promptReadsPast(page, await promptReads(page) + 1);
        const shownFrames = await page.evaluate(() => { const view = window as unknown as HeldRowCheck; view.sampling = false; return view.shownFrames; });
        assert.equal(shownFrames, 0, "no painted frame shows the cancelled turn between the empty box and the receipt");
        // the agent writes the follow-up's turn: the read leaves the cancelled one off its chain
        await page.evaluate((text) => {
          const view = window as unknown as HeldRowCheck;
          view.extraTurn = { role: "user", ts: new Date().toISOString(), parts: [{ kind: "text", text }] };
          view.releaseReads();
        }, follow);
        await page.locator("[data-chat-row] .chat-turn", { hasText: follow }).waitFor({ timeout: 10_000 });
        assert.equal(await cancelledShown(), 0, "the follow-up's read leaves the cancelled turn out");
        console.log("PASS Send now of a held row keeps the cancelled turn out from its start, with no frame until its receipt");

        assert.deepEqual(errors, []);
      } finally { await desktop.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
