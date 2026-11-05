import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";
import { MAX_ATTACHMENT_BYTES } from "../shared/attachments.ts";
import { SUPPORTED_ENTRIES } from "../src/lib/themes.ts";

// The model label in the input card's last row, fitted to what is measured there, on the
// unmodified app over the demo's fixture transport. The demo's panes name no context window and
// run no task, so the page's data is patched here, in the test only: the pane is a Claude or Codex one with
// two background tasks, in the state a case asks for, and its conversation names that case's
// model, the level xhigh and a context window; an upload never answers, so its sentence stays.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-composer-fit-demo-"));
// an id the composer cannot name is drawn as received, in the mono face: the widest label there is
const LONG_MODEL = "gpt-5.6-sol-codex-preview-2026-10";
// ids it names: "GPT-5.6" and "Opus 5.5"; null: the conversation names no model
const NAMED = ["gpt-5.6", "claude-opus-5-5"] as const;

interface Case { model: string | null; agent?: "claude" | "codex" | "pi" | "omo"; pending?: boolean; effort?: string | null; status?: "working" | "idle"; mic?: boolean; ring?: boolean; chatFontSize?: number | null; showUsage?: boolean; weeklyOnly?: boolean; suggestion?: string | null; contextUsed?: number; stream?: number; freezeConversation?: boolean; language?: "en" | "ko" | "ja" | "zh"; theme?: "light" | "dark"; scale?: number }
type Draw = "full" | "no-effort" | "out";
interface ComposerScrollGeometry {
  height: number;
  viewport: number;
  gap: number;
  spacing: number;
}

const measure = (page: Page) => page.evaluate(() => {
  const status = document.querySelector<HTMLElement>(".composer-status")!;
  const part = (selector: string) => {
    const item = document.querySelector<HTMLElement>(selector);
    if (!item) return null;
    const box = item.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, width: box.width, clipped: item.scrollWidth > item.clientWidth };
  };
  // everything drawn in the last row: no two of them may share a pixel
  const drawn = [...document.querySelectorAll<HTMLElement>(".composer-controls-left > *:not(input), .composer-status-meta > *, .composer-status-hint, .composer-controls-right > *")]
    // the pill and what it holds: its parts are compared with each other too, in every draw (a
    // pill without a box, the label out or no model, has no size and is filtered out below)
    .flatMap((item) => item.classList.contains("composer-pill") ? [item, ...item.children] as HTMLElement[] : [item])
    .flatMap((item) => item.classList.contains("composer-model-info") && getComputedStyle(item).display === "contents" ? [...item.children] as HTMLElement[] : [item])
    .filter((item) => item.getBoundingClientRect().width > 1.5 && item.getBoundingClientRect().height > 1.5);
  const overlaps: string[] = [];
  for (const [index, one] of drawn.entries()) for (const other of drawn.slice(index + 1)) {
    // the pill is around its own parts
    if (one.classList.contains("composer-pill") && one.contains(other)) continue;
    const a = one.getBoundingClientRect(), b = other.getBoundingClientRect();
    if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5) overlaps.push(`${one.className} | ${other.className}`);
  }
  const surface = document.querySelector(".composer-surface")!.getBoundingClientRect();
  return {
    draw: status.getAttribute("data-model") ?? "full", hintAlone: status.hasAttribute("data-hint-alone"),
    card: { width: surface.width, height: surface.height }, status: status.getBoundingClientRect().height,
    pill: (() => {
      const pill = document.querySelector<HTMLElement>(".composer-pill")!;
      const box = pill.getBoundingClientRect(), row = status.getBoundingClientRect();
      const inside = (selector: string): boolean => {
        const item = pill.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
        return item !== undefined && item.left >= box.left - 0.5 && item.right <= box.right + 0.5 && item.top >= box.top - 0.5 && item.bottom <= box.bottom + 0.5;
      };
      const style = getComputedStyle(pill);
      return {
        width: box.width, height: box.height, inRow: box.left >= row.left - 0.5 && box.right <= row.right + 0.5,
        holds: inside(".agent-mark") && inside(".composer-model") && (pill.querySelector(".composer-context") === null || inside(".composer-context"))
          // the level too, wherever it is drawn (stepped out or not recorded it is a 1px box that is only read)
          && ((pill.querySelector<HTMLElement>(".composer-reasoning")?.getBoundingClientRect().width ?? 0) <= 1.5 || inside(".composer-reasoning")),
        // it only shows: nothing about it says it can be pressed
        inert: pill.tagName === "SPAN" && !pill.hasAttribute("role") && !pill.hasAttribute("tabindex") && style.cursor === "auto",
      };
    })(),
    name: document.querySelector<HTMLElement>(".composer-model")?.textContent ?? null, named: !document.querySelector(".composer-model")?.classList.contains("is-id"),
    label: part(".composer-model-info"), model: part(".composer-model"), effort: part(".composer-reasoning"), ring: part(".composer-context"), ringText: part(".composer-context-text"),
    // the ring's track, and the two tokens it can be: the bare ring's and the one on the pill's fill
    track: (() => {
      const track = document.querySelector(".composer-context-track");
      const token = (name: string): string => {
        const probe = document.body.appendChild(document.createElement("span"));
        probe.style.color = `var(${name})`;
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      };
      return track ? { stroke: getComputedStyle(track).stroke, bare: token("--border"), onFill: token("--border-strong") } : null;
    })(),
    hint: part(".composer-status-hint"), queue: document.querySelector(".composer-queue-button") !== null,
    send: document.querySelector(".composer-controls-right .composer-send") !== null,
    sendOptions: document.querySelector(".composer-send-options") !== null,
    stop: document.querySelector(".composer-controls-right .composer-stop") !== null,
    chip: document.querySelector(".bg-tasks-toggle") !== null, mic: document.querySelector(".composer-controls-left .voice-mic") !== null,
    overlaps, overflowing: document.documentElement.scrollWidth > window.innerWidth,
  };
});
type Row = Awaited<ReturnType<typeof measure>>;

/** The fit answers after the commit, a resize a frame later: wait for the mark, never a fixed time. */
const drawn = async (page: Page, draw: Draw, what: string): Promise<Row> => {
  await page.waitForFunction((want) => (document.querySelector(".composer-status")?.getAttribute("data-model") ?? "full") === want, draw, { timeout: 5_000 })
    .catch(async () => assert.fail(`${what}: the model label is drawn "${(await measure(page)).draw}", not "${draw}": ${JSON.stringify(await measure(page))}`));
  const row = await measure(page);
  // a label that is drawn whole is whole; with Queue it is never drawn in part
  if (draw === "full" || row.queue) assert.ok(!row.model?.clipped && !row.effort?.clipped, `${what}: no word of the model label is cut: ${JSON.stringify(row)}`);
  if (draw === "no-effort") assert.ok((row.effort?.width ?? 0) <= 1, `${what}: the level is read, not drawn: ${JSON.stringify(row)}`);
  if (draw === "out") assert.ok((row.label?.width ?? 0) <= 1, `${what}: the name and the level are read, not drawn: ${JSON.stringify(row)}`);
  // the pill goes with the label: no empty pill is left around the ring. Drawn, it holds the mark, the name and the ring
  if (draw === "out") assert.equal(row.pill.width, 0, `${what}: no pill is drawn without its label: ${JSON.stringify(row)}`);
  else assert.ok(row.pill.width > 1 && row.pill.inRow && row.pill.holds && row.pill.inert, `${what}: the mark, the name and the ring sit in one pill that is not a control: ${JSON.stringify(row)}`);
  // the ring's track is the stronger one only on the pill's fill: bare on the card it is the bare ring's
  if (row.track) assert.equal(row.track.stroke, draw === "out" ? row.track.bare : row.track.onFill, `${what}: the ring's track is the one for where it stands: ${JSON.stringify(row.track)}`);
  assert.deepEqual(row.overlaps, [], `${what}: nothing overlaps its neighbour`);
  assert.equal(row.overflowing, false, `${what}: the page does not scroll sideways`);
  return row;
};

const ring = (page: Page) => page.locator(".composer-context");
/**
 * Opens or closes the context number and answers how the label is drawn in that same task: React
 * commits a click in a microtask, and the label is fitted with that commit, not by whatever
 * renders the composer next (a poll, a status change), which no wait here would tell apart.
 */
const toggleRing = async (page: Page, open: boolean, draw?: Draw): Promise<void> => {
  const marked = await ring(page).evaluate(async (node: HTMLElement) => {
    node.click();
    await new Promise<void>((done) => queueMicrotask(done));
    return { open: node.getAttribute("aria-expanded"), draw: node.closest(".composer-status")!.getAttribute("data-model") ?? "full" };
  });
  assert.equal(marked.open, String(open));
  if (draw) assert.equal(marked.draw, draw, `the model label is fitted as the context number ${open ? "opens" : "closes"}`);
};
const draft = async (page: Page): Promise<void> => {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("hold this");
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
};
const upload = async (page: Page): Promise<void> => {
  await page.locator('.composer-controls-left input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await page.locator(".composer-status-hint").waitFor();
  assert.equal(await page.locator(".composer-status-hint").textContent(), "· Uploading file…");
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // What the demo answers, rewritten as it is read (`window.fitCase` is set per browser context).
  const patch = `<script>(() => {
    const TARGET = ${JSON.stringify(panes.api)};
    const fix = (value) => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) { value.forEach(fix); return value; }
      if (value.pane_id === TARGET && "agent_status" in value) {
        // the chip without its step in progress: this script measures the model label's room, which
        // the step (plan-chip-demo-regression.ts) is drawn after and may take from
        if ("agent" in value) Object.assign(value, { agent: window.fitCase.agent, background_tasks: 2, ...(value.plan ? { plan: { ...value.plan, current: null } } : {}) });
        value.agent_status = window.fitCase.status;
      }
      if ("prompt" in value && window.fitCase.suggestion !== undefined) value.suggestion = window.fitCase.suggestion;
      if (Array.isArray(value.features) && !window.fitCase.pending) value.features = value.features.filter((feature) => feature !== "pending-input");
      if (Array.isArray(value.commands) && !value.commands.some((command) => command.name === "delegate")) value.commands.push(
        { name: "delegate", description: "Delegate a task", source: "skill", ...(window.fitCase.agent === "codex" ? { trigger: "$" } : {}) },
        { name: "template-creator", description: "Create a reusable template", source: "skill", ...(window.fitCase.agent === "codex" ? { trigger: "$" } : {}) },
        { name: "deploy", description: "Deploy a project", source: "project" },
        { name: "plugin:deploy", description: "Deploy through a plugin", source: "plugin" }
      );
      if (window.fitCase.weeklyOnly && value.id === "codex" && Array.isArray(value.windows)) value.windows = value.windows.filter((limit) => limit.kind !== "session");
      if (Array.isArray(value.turns) && value.metadata) value.metadata = { model: window.fitCase.model, reasoning_effort: window.fitCase.effort, ...(window.fitCase.ring ? { context: { used: window.fitCase.contextUsed ?? 151000, window: 272000 } } : {}) };
      if (Array.isArray(value.turns) && window.fitCase.stream) {
        const turn = value.turns.findLast((turn) => turn.role === "assistant");
        const text = "Streamed update " + window.fitCase.stream;
        if (turn && !turn.parts.some((part) => part.kind === "text" && part.text === text)) turn.parts.push({ kind: "text", text });
      }
      for (const key of Object.keys(value)) fix(value[key]);
      return value;
    };
    window.fitHoldSend = false;
    // the browser's own socket, before the demo transport replaces it: an offline case connects nowhere with it
    window.fitNativeSocket = window.WebSocket;
    const clone = structuredClone;
    window.structuredClone = (value, options) => fix(clone(value, options));
    const later = window.setTimeout.bind(window);
    // Geometry-only cases keep idle behavior without the demo finishing its turn mid-measurement.
    window.setTimeout = (callback, ms, ...args) => (window.fitCase.status === "working" || window.fitCase.freezeConversation) && (ms === 4500 || ms === 2400) ? 0 : later(callback, ms, ...args);
    const parse = JSON.parse;
    JSON.parse = function (text, reviver) { return fix(parse.call(JSON, text, reviver)); };
    const json = Response.prototype.json;
    Response.prototype.json = async function () { return fix(await json.call(this)); };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `${patch}\n    <script src="./demo-transport.js"></script>\n    <script>(() => { const Socket = window.WebSocket; const Wrapped = function(...args) { if (window.fitOffline) return new window.fitNativeSocket("ws://127.0.0.1:9/offline"); const socket = new Socket(...args); window.fitSocket = socket;
      const send = socket.send.bind(socket);
      socket.send = (raw) => {
        const frame = JSON.parse(raw);
        if (!window.fitHoldSend || frame.type !== "submit") return send(raw);
        window.fitReply = (ok) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
          type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok,
          ...(ok ? {} : { code: "agent_not_ready", message: "The demo agent cannot take this submission." }),
        }) }));
      };
      return socket; }; Object.assign(Wrapped, { CONNECTING: Socket.CONNECTING, OPEN: Socket.OPEN, CLOSING: Socket.CLOSING, CLOSED: Socket.CLOSED }); window.WebSocket = Wrapped; const demoFetch = window.fetch; window.fetch = (input, init) => String(typeof input === "string" ? input : input.url ?? input).includes("/pane/image") ? new Promise(() => {}) : demoFetch(input, init); })();</script>\n    <script type="module"`));

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
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(panes.api)}`;

  /** One card: a phone (390px, touch) or a mouse-driven window of `width`. */
  const withCard = async (browser: Browser, width: number, state: Case, run: (page: Page) => Promise<void>): Promise<void> => {
    const touch = width <= 480;
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch, locale: state.language ?? "en-US", ...(state.scale ? { deviceScaleFactor: state.scale } : {}) });
    try {
      await context.addInitScript((fitCase) => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: fitCase.language ?? "en", voiceInput: fitCase.mic ? "on" : "off", chatFontSize: fitCase.chatFontSize ?? null, showUsage: fitCase.showUsage ?? false, usageCount: "used", ...(fitCase.theme ? { theme: fitCase.theme } : {}) }));
        Object.assign(window, { fitCase });
      }, { agent: "claude", pending: true, status: "working", effort: "xhigh", mic: false, ring: true, ...state });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error" && message.text().includes("ResizeObserver")) errors.push(message.text()); });
      await page.goto(`${url}&view=chat`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".terminal-stack.is-chat").waitFor();
      await page.locator(".composer-model").waitFor({ state: "attached" });
      await appFaces(page);
      await run(page);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  };

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", model: "gpt-5.6" }, async (page) => {
        await page.evaluate(() => {
          const fetchDemo = window.fetch;
          let uploads = 0;
          Object.assign(window, { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            const path = new URL(String(input), location.href).pathname;
            if (path.endsWith("/pane/files") || (path.endsWith("/pane/image") && ++uploads === 1)) {
              return Promise.resolve(new Response(JSON.stringify({ error: "fixture_failure", message: "fixture upload failed" }), { status: 500 }));
            }
            if (path.endsWith("/pane/image")) return Promise.resolve(new Response(JSON.stringify({ path: "/fixture/retry.txt" })));
            return fetchDemo(input, init);
          } });
        });
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const failureAlert = page.locator('.composer-surface > [role="alert"]');
        const persistent = await failureAlert.elementHandle();
        assert.ok(persistent, "file-list failure alert is mounted before any request");
        assert.equal(await failureAlert.textContent(), "");
        await page.locator('.composer-controls-left input[type="file"]').setInputFiles({ name: "retry.txt", mimeType: "text/plain", buffer: Buffer.from("fixture") });
        const note = page.locator(".composer-note");
        await note.getByRole("button", { name: "Try again", exact: true }).waitFor();
        assert.ok((await note.textContent())?.includes("retry.txt"), "the upload alert identifies the failed file");
        assert.equal(await page.locator('.composer-surface > [aria-live="polite"]').textContent(), "", "failure is not also sent to the success live region");
        await box.fill("Keep editing this draft");
        await note.getByRole("button", { name: "Try again", exact: true }).click();
        await page.locator(".composer-attachment.is-ready").waitFor();
        assert.ok((await box.inputValue()).includes("Keep editing this draft"), "retry preserves edits");
        assert.ok((await page.locator('.composer-surface > [aria-live="polite"]').textContent())?.includes("retry.txt"), "success is announced");

        const success = await page.locator('.composer-surface > [aria-live="polite"]').textContent();
        // A file on disk, not a buffer: Playwright sends a buffer to the page as base64 (some 45 MB
        // here), which on a loaded CI host outlasted setInputFiles' 30 s; Chromium reads a path's
        // size without its bytes, and the app refuses by size before reading.
        const tooLarge = join(app, "too-large.bin");
        writeFileSync(tooLarge, "");
        truncateSync(tooLarge, MAX_ATTACHMENT_BYTES + 1);
        await page.locator('.composer-controls-left input[type="file"]').setInputFiles(tooLarge);
        await note.filter({ hasText: "too-large.bin" }).waitFor();
        assert.equal(await note.getAttribute("role"), "alert");
        assert.equal(await page.locator('.composer-surface > [aria-live="polite"]').textContent(), success, "oversize failure is not also announced politely");

        await box.fill("@missing");
        await page.locator(".composer-menu .chat-inline-error").waitFor();
        assert.ok(await persistent.evaluate((node) => node.isConnected && node.textContent !== ""), "the initially empty alert receives the listing failure");
        assert.equal(await page.locator(".composer-menu [role=status]").count(), 0, "the visible failure is not a second live region");
        await box.press("Escape");
        await page.locator(".composer-menu .chat-inline-error").waitFor({ state: "detached" });
        assert.equal(await failureAlert.textContent(), "", "dismissing suggestions clears the announcement");
        await persistent.dispose();
      });
      console.log("PASS phone and desktop upload failure has one named alert, retry survives edits, success is announced, and file-list failures use a persistent alert");

      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", model: "gpt-5.6" }, async (page) => {
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const settings = async () => {
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await openSettingsPage(page, "Chat");
        };
        const close = () => page.getByRole("button", { name: "Close settings", exact: true }).click();
        const sent = async (text: string) => {
          await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "");
          await page.waitForFunction(async ({ paneId, text }) => {
            const conversation = await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json();
            return conversation.turns.some((turn: { role: string; parts: { kind: string; text?: string }[] }) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text === text));
          }, { paneId: panes.api, text }, { timeout: 5_000 });
        };
        const phone = width === 390;
        if (phone) {
          // a touch screen's Return breaks the line until this device chooses otherwise; Send sends
          await box.fill("First line");
          await box.press("Enter");
          await box.pressSequentially("second line");
          assert.equal(await box.inputValue(), "First line\nsecond line", "a touch screen's Return inserts a newline by default");
          const send = page.getByRole("button", { name: "Send message", exact: true });
          assert.ok(await send.isVisible(), "Send is drawn beside the draft");
          await send.click();
          await sent("First line\nsecond line");
          // a hardware keyboard on the phone still sends with Mod+Enter
          await box.fill("Phone hardware keyboard sends");
          await box.press("ControlOrMeta+Enter");
          await sent("Phone hardware keyboard sends");
        } else {
          await box.fill("Default Return sends");
          await box.press("Enter");
          await sent("Default Return sends");
        }
        await settings();
        const label = phone ? "Return inserts a new line" : "Enter sends";
        const toggle = page.getByRole("switch", { name: label, exact: true });
        assert.equal(await toggle.getAttribute("aria-checked"), "true", phone ? "a touch screen's Return inserts a new line by default" : "a desk's Enter sends by default");
        await toggle.click();
        await close();
        await page.reload();
        await box.waitFor();
        await settings();
        assert.equal(await toggle.getAttribute("aria-checked"), "false", "the choice survives reload on this device");
        if (width === 390 && process.env.UI_EVIDENCE_DIR) {
          const evidence = process.env.UI_EVIDENCE_DIR;
          mkdirSync(evidence, { recursive: true });
          for (const theme of ["dark", "light"] as const) {
            await openSettingsPage(page, "Appearance");
            await page.getByRole("button", { name: theme === "dark" ? "Dark" : "Light", exact: true }).click();
            await openSettingsPage(page, "Chat");
            await appFaces(page);
            await page.locator(".settings-row").filter({ has: toggle }).evaluate((row) => row.scrollIntoView({ block: "center", behavior: "instant" }));
            const capture = await toggle.evaluate((node) => {
              const row = node.closest(".settings-row")!.getBoundingClientRect();
              const body = node.closest(".settings-body")!.getBoundingClientRect();
              return { top: row.top, bottom: row.bottom, visibleTop: body.top, visibleBottom: Math.min(body.bottom, window.innerHeight) };
            });
            assert.ok(capture.top >= capture.visibleTop - 1 && capture.bottom <= capture.visibleBottom + 1, `the phone capture includes the whole Return setting and its explanation: ${JSON.stringify(capture)}`);
            await page.screenshot({ path: join(evidence, `return-newline-phone-${theme}.png`) });
          }
        }
        await close();
        if (phone) {
          // chosen: Return sends on this phone
          await box.fill("Return sends once chosen");
          await box.press("Enter");
          await sent("Return sends once chosen");
          return;
        }
        const pasted = "# Reply\n\n- first\n- second\n\n```ts\n  run();\n```";
        await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
        await box.focus();
        await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
        assert.equal(await box.inputValue(), pasted, "native paste keeps blank lines, Markdown and code indentation");
        await box.press("Enter");
        assert.equal(await box.inputValue(), pasted + "\n", "Return inserts a native newline without sending");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await sent(pasted);
        await box.fill("Hardware keyboard sends");
        await box.press("ControlOrMeta+Enter");
        await sent("Hardware keyboard sends");
      });
      console.log("PASS a phone's Return inserts a new line by default with Send and Mod+Enter sending, a chosen Return sends after reload, desktop Enter and Mod+Enter stay, and native multiline paste reaches chat through Send");

      // An immediate message's paste framing: a whole paste marker in the text is dropped before it is sent, so the
      // message arrives as written; any other escape byte is refused by the bridge (here the demo's answer), and the
      // draft stays with the reason. Observe-only and offline keep their own guards. With UI_EVIDENCE_DIR set, every
      // state is captured as submit-framing-<width>-<theme>[-ko]-<state>.png, and the measured numbers are written.
      // The conversation is frozen: the accepted send's reply never lands mid-capture, so every frame shows the same turns.
      const framingMeasures: Record<string, unknown>[] = [];
      for (const [width, language] of [[390, "en"], [1440, "en"], [390, "ko"]] as const) for (const theme of ["light", "dark"] as const) await withCard(browser, width, { agent: "claude", model: "claude-opus-5-5", status: "idle", freezeConversation: true, language, theme, ...(width === 390 ? { scale: 3 } : {}) }, async (page) => {
        const evidence = process.env.UI_EVIDENCE_DIR;
        const name = `submit-framing-${width}-${theme}${language === "ko" ? "-ko" : ""}`;
        const shot = async (state: string) => {
          if (!evidence) return;
          mkdirSync(evidence, { recursive: true });
          await appFaces(page);
          await page.screenshot({ path: join(evidence, `${name}-${state}.png`) });
        };
        const box = page.locator(".composer-text");
        const button = page.locator(".composer-send");
        const note = page.locator(".composer-note");
        const conversation = () => page.evaluate(async (paneId) => JSON.stringify(await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json()), panes.api);
        const noOverflow = async (state: string) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name} ${state}: no horizontal scroll`);
        const measure = async (state: string) => {
          const numbers = await page.evaluate(() => {
            const send = document.querySelector<HTMLElement>(".composer-send")!.getBoundingClientRect();
            const text = document.querySelector<HTMLElement>(".composer-text")!;
            const noteNode = document.querySelector<HTMLElement>(".composer-note");
            // a CSS colour as sRGB with alpha, through a canvas (it resolves oklch and color-mix too)
            const canvas = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
            const rgba = (value: string): number[] => { canvas.clearRect(0, 0, 1, 1); canvas.fillStyle = "#000"; canvas.fillStyle = value; canvas.fillRect(0, 0, 1, 1); const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data; return [r!, g!, b!, a! / 255]; };
            const over = (top: number[], below: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + below[i]! * (1 - top[3]!)).concat(1);
            // what is painted behind a node: its own and its ancestors' backgrounds, composited from the page down
            const backdrop = (node: HTMLElement): number[] => {
              const layers: number[][] = [];
              for (let at: HTMLElement | null = node; at; at = at.parentElement) layers.push(rgba(getComputedStyle(at).backgroundColor));
              return layers.reverse().reduce((below, layer) => over(layer, below), [255, 255, 255, 1]);
            };
            const lum = (c: number[]) => { const [r, g, b] = c.slice(0, 3).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };
            const ratio = (node: HTMLElement | null) => {
              if (!node) return null;
              const behind = backdrop(node);
              const a = lum(over(rgba(getComputedStyle(node).color), behind)), b = lum(behind);
              return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
            };
            return {
              send: { width: send.width, height: send.height }, messageFontPx: parseFloat(getComputedStyle(text).fontSize),
              textContrast: ratio(text), note: noteNode ? { text: noteNode.textContent, role: noteNode.getAttribute("role"), contrast: ratio(noteNode), selectable: getComputedStyle(noteNode).userSelect !== "none" } : null,
              sendName: document.querySelector<HTMLElement>(".composer-send")!.getAttribute("aria-label"),
            };
          });
          framingMeasures.push({ file: `${name}-${state}.png`, width, theme, language, state, ...numbers });
          return numbers;
        };
        await page.locator(".composer-surface").waitFor();
        // empty: nothing to send yet
        await shot("empty");
        assert.equal(await button.isDisabled(), true, "an empty message box has nothing to send");
        await shot("disabled");
        // ordinary multiline Unicode content
        const written = language === "ko" ? "첫 단계를 실행해\n그다음 두 번째 단계 ✓" : "Run step one\nthen step two ✓";
        await box.fill(written);
        await box.evaluate((node: HTMLTextAreaElement) => node.blur());
        await shot("multiline");
        await shot("rest");
        if (width === 1440) { await button.hover(); await shot("hover"); }
        // keyboard focus on Send shows the ring
        await box.focus();
        await page.keyboard.press("End");
        await button.focus();
        assert.equal(await button.evaluate((node) => node.matches(":focus-visible") && getComputedStyle(node).outlineStyle !== "none"), true, `${name}: Send shows a focus ring`);
        await shot("focus");
        const sendBox = (await button.boundingBox())!;
        // pressed and released away: nothing goes
        await page.mouse.move(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
        await page.mouse.down();
        await shot("pressed");
        await page.mouse.move(0, 0);
        await page.mouse.up();
        assert.equal(await box.inputValue(), written);
        // loading: the receipt is held
        await page.evaluate(() => { (window as any).fitHoldSend = true; });
        await button.click();
        await page.waitForFunction(() => document.querySelector(".composer-send")?.getAttribute("aria-busy") === "true");
        await shot("loading");
        await page.evaluate(() => { (window as any).fitHoldSend = false; (window as any).fitReply(false); });
        await page.waitForFunction(() => !document.querySelector(".composer-send")?.hasAttribute("aria-busy"));
        // sent for real with a whole paste marker pasted inside it: the marker is gone, the message is as written
        await note.waitFor();
        await box.fill(written.replace("\n", "\n\u001b[201~"));
        await button.click();
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "");
        await page.waitForFunction(async ({ paneId, text }) => {
          const turns = (await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json()).turns;
          return turns.some((turn: { role: string; parts: { kind: string; text?: string }[] }) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text === text));
        }, { paneId: panes.api, text: written }, { timeout: 5_000 });
        assert.ok(!(await conversation()).includes("\\u001b"), "no escape byte reached the conversation");
        // error: an escape byte that is no paste marker is refused, typed nowhere, and the draft stays with the reason
        const refused = language === "ko" ? "이 초안은 \u001b[31m남아야 합니다" : "keep \u001b[31mthis draft";
        await box.fill(refused);
        await button.click();
        await note.filter({ hasText: "paste markers" }).waitFor();
        assert.equal(await box.inputValue(), refused, "the refused draft stays as it was");
        assert.equal(await button.isEnabled(), true, "and can be edited and sent again");
        assert.ok(!(await conversation()).includes("31m"), "nothing of the refused message reached the agent");
        await noOverflow("error");
        await measure("error");
        await shot("error");
        // long unbroken content, scrolled to its end
        await box.fill(`${"unbroken".repeat(120)}END`);
        await box.evaluate((node: HTMLTextAreaElement) => { node.focus(); node.setSelectionRange(node.value.length, node.value.length); node.scrollTop = node.scrollHeight; });
        await noOverflow("long");
        await shot("long-end");
        await measure("long-end");
        // observe-only: the connection only watches, so it offers no message box; the draft is back once it interacts
        await box.fill(written);
        await page.evaluate(() => (window as any).fitSocket.send(JSON.stringify({ type: "role", mode: "observe" })));
        await box.waitFor({ state: "detached" });
        assert.equal(await page.locator(".composer-send").count(), 0, "an observer has no Send");
        await noOverflow("observe");
        await shot("observe");
        await page.evaluate(() => (window as any).fitSocket.send(JSON.stringify({ type: "role", mode: "interact" })));
        await box.waitFor();
        assert.equal(await box.inputValue(), written, "the draft is kept through observing");
        assert.equal((await conversation()).split(written.split("\n")[0]!).length, 2, "and was not sent while observing");
        // offline: Send waits for the connection, and the draft stays
        await page.evaluate(() => { (window as any).fitOffline = true; (window as any).fitSocket.close(); });
        await page.waitForFunction(() => document.querySelector(".conn-live") === null);
        await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".composer-send")?.disabled === true);
        assert.equal(await box.inputValue(), written, "an offline draft stays");
        await noOverflow("offline");
        await shot("offline");
        await measure("offline");
        // the terminal's input line, itself unchanged: the same framing, and the same refusal kept under the line
        await page.evaluate(() => {
          const settings = JSON.parse(localStorage.getItem("ovis:settings") ?? "{}");
          localStorage.setItem("ovis:settings", JSON.stringify({ ...settings, terminalInputMode: "line" }));
        });
        await page.goto(`${url}&view=terminal`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const line = page.locator(".terminal-input-text");
        await line.waitFor();
        await line.fill(written);
        await noOverflow("terminal-line");
        await shot("terminal-line");
        await line.fill(refused);
        await page.locator(".terminal-input-send").click();
        await page.locator(".terminal-input-note").filter({ hasText: "paste markers" }).waitFor();
        assert.equal(await line.inputValue(), refused, "the refused line stays as it was");
        await noOverflow("terminal-line-error");
        await shot("terminal-line-error");
      });
      if (process.env.UI_EVIDENCE_DIR) writeFileSync(join(process.env.UI_EVIDENCE_DIR, "submit-framing-measurements.json"), `${JSON.stringify(framingMeasures, null, 2)}\n`);
      console.log("PASS immediate submit framing: a pasted marker is dropped, any other escape is refused with the draft kept, observe-only and offline keep their guards, and the terminal input line refuses the same, on phone and desktop in both themes and Korean");

      // Only the transport receipt is held: the real composer and draft lifecycle stay intact.
      for (const agent of ["claude", "codex"] as const) for (const width of [390, 1440]) for (const theme of ["dark", "light"] as const) await withCard(browser, width, { agent, model: agent === "claude" ? "claude-opus-5-5" : "gpt-5.6", status: "idle" }, async (page) => {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
          (window as any).fitHoldSend = true;
        }, theme);
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const button = page.getByRole("button", { name: "Send message", exact: true });
        const geometry = () => button.evaluate((node) => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; });
        const empty = await geometry();
        assert.equal(await button.getAttribute("aria-busy"), null, "empty is not busy");
        await box.fill("Check the delivery feedback.");
        const before = await geometry();
        await button.click();
        await page.waitForFunction(() => typeof (window as any).fitReply === "function");
        assert.equal(await button.getAttribute("aria-busy"), "true", "a held receipt shows in-flight progress");
        assert.equal(await button.getAttribute("title"), "Sending…", "sending describes the stable Send action");
        assert.equal(await button.isDisabled(), true);
        assert.equal(await box.inputValue(), "Check the delivery feedback.", "text stays until acknowledged");
        assert.deepEqual(await geometry(), before, "sending does not move or resize the button");
        assert.equal(before.width, empty.width);
        assert.equal(before.height, empty.height);
        assert.equal(await button.locator("[aria-live], [role=status]").count(), 0, "no repeated live announcement");
        const progress = button.locator(".composer-send-progress");
        // every theme row of this mode, so each real block of styles.css is behind the button once
        for (const { id: palette } of SUPPORTED_ENTRIES.filter((entry) => entry.mode === theme)) {
          await page.evaluate((palette) => { document.documentElement.dataset.palette = palette; }, palette);
          assert.equal(await progress.evaluate((node) => getComputedStyle(node).animationTimingFunction), "steps(8)");
          assert.equal(await button.evaluate((node) => getComputedStyle(node).opacity), "1");
          assert.deepEqual(await geometry(), before, `${palette} does not change the button geometry`);
          const colors = await button.evaluate((node) => ({ ink: getComputedStyle(node).color, fill: getComputedStyle(node, "::before").backgroundColor }));
          assert.notEqual(colors.ink, colors.fill, `${palette} progress contrasts with its accent circle`);
        }
        await page.evaluate(() => { document.documentElement.dataset.palette = "amber"; });
        await page.emulateMedia({ reducedMotion: "reduce" });
        assert.equal(await progress.evaluate((node) => getComputedStyle(node).animationName), "none", "reduced motion retains a static ring");
        assert.equal(await progress.isVisible(), true);
        await page.emulateMedia({ reducedMotion: "no-preference" });
        if (process.env.UI_EVIDENCE_DIR) {
          mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `send-${agent}-${width}-${theme}.png`) });
        }
        await page.evaluate(() => (window as any).fitReply(true));
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")!.value === "");
        assert.equal(await button.getAttribute("aria-busy"), null);
        assert.equal(await button.getAttribute("aria-label"), "Send message");
        assert.deepEqual(await geometry(), before);
        await box.fill("Keep this draft after refusal.");
        await button.click();
        await page.waitForFunction(() => document.querySelector(".composer-send")?.getAttribute("aria-busy") === "true");
        await page.evaluate(() => (window as any).fitReply(false));
        await page.waitForFunction(() => !document.querySelector(".composer-send")?.hasAttribute("aria-busy"));
        assert.equal(await box.inputValue(), "Keep this draft after refusal.");
        assert.equal(await button.isEnabled(), true, "refusal returns to the existing retry path");
        await page.locator(".composer-note").waitFor();
      });
      console.log("PASS held Send receipts show progress without moving the button, retain drafts, settle and recover on Claude/Codex desktop/phone in both themes");
      await withCard(browser, 390, { agent: "claude", model: "claude-opus-5-5", status: "working" }, async (page) => {
        await page.evaluate(() => { (window as any).fitHoldSend = true; });
        await draft(page);
        await page.locator(".composer-send").click();
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
        assert.equal(await page.locator('.composer-send[aria-busy="true"]').count(), 1, "editing a working send to empty does not replace progress with Stop");
        await page.evaluate(() => (window as any).fitReply(true));
        await page.locator(".composer-stop").waitFor();
      });
      // Typography is applied by SettingsProvider after the render. At this fixed card width,
      // the larger interface font must step effort out without needing a viewport resize.
      await withCard(browser, 1075, { agent: "codex", model: LONG_MODEL }, async (page) => {
        const before = await measure(page);
        assert.equal(before.draw, "full");
        assert.equal(before.model?.clipped, false);
        const chooseSize = async (size: number) => {
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await openSettingsPage(page, "Appearance");
          const current = Number.parseInt(await page.locator('.settings-stepper[aria-label="Interface font size"] output').innerText(), 10);
          const button = page.getByRole("button", { name: size > current ? "Increase interface font size" : "Decrease interface font size", exact: true });
          for (let step = 0; step < Math.abs(size - current); step++) await button.click();
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        };
        await chooseSize(20);
        const large = await measure(page);
        assert.equal(large.card.width, before.card.width, "the card did not resize to trigger a width observer");
        assert.equal(large.draw, "no-effort", "interface font changes refit after the new typography is applied");
        assert.equal(large.model?.clipped, false, "the model stays whole at the larger font size");
        await chooseSize(14);
        const restored = await measure(page);
        assert.equal(restored.draw, "full", "shrinking the interface font restores the effort label");
        assert.equal(restored.effort?.clipped, false);
      });
      console.log("PASS live interface typography changes refit status labels at a fixed card width");

      for (const width of [390, 1440]) await withCard(browser, width, { model: LONG_MODEL }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill("Keep the draft at its insertion point.\n".repeat(80));
        await upload(page);
        await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
        const before = await box.evaluate((node) => {
          node.focus(); node.setSelectionRange(600, 600); node.scrollTop = 300;
          return { value: node.value, start: node.selectionStart, end: node.selectionEnd, scroll: node.scrollTop, height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top, offsetTop: node.offsetTop };
        });
        await box.evaluate((node) => {
          const remove = Element.prototype.removeAttribute;
          const samples: number[] = [];
          Object.assign(window, { draftTopSamples: samples });
          Element.prototype.removeAttribute = function(name) {
            remove.call(this, name);
            if (this.classList.contains("composer-status")) samples.push(node.getBoundingClientRect().top);
          };
        });
        await page.evaluate((paneId) => {
          const fixture = window as unknown as { fitCase: Case; fitSocket: { push(message: unknown): void } };
          fixture.fitCase.contextUsed = 160_000;
          fixture.fitCase.stream = 1;
          fixture.fitSocket.push({ type: "conversation-changed", pane_id: paneId, signature: "composer-stream-update" });
        }, panes.api);
        await page.waitForFunction(() => { const ring = document.querySelector(".composer-context"); return `${ring?.getAttribute("aria-label")} ${ring?.textContent}`.includes("160k"); }, undefined, { timeout: 5_000 });
        await page.getByText("Streamed update 1", { exact: true }).waitFor({ state: "attached" });
        await page.evaluate((paneId) => {
          const fixture = window as unknown as { fitCase: Case; fitSocket: { push(message: unknown): void } };
          fixture.fitCase.effort = "high";
          fixture.fitSocket.push({ type: "conversation-changed", pane_id: paneId, signature: "composer-model-update" });
        }, panes.api);
        await page.waitForFunction(() => document.querySelector(".composer-reasoning-short")?.textContent === "high", undefined, { timeout: 5_000 });
        const samples = await page.evaluate(() => (window as unknown as { draftTopSamples: number[] }).draftTopSamples);
        assert.ok(samples.every((top) => Math.abs(top - before.top) <= 1), `${width}px: streaming context updates never move the focused textarea during status fitting: ${before.top} -> ${samples.join(", ")}`);
        const after = await box.evaluate((node) => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, scroll: node.scrollTop, height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top, offsetTop: node.offsetTop }));
        assert.deepEqual(after, before);
      });
      console.log("PASS streaming context updates preserve draft geometry and selection while an upload hint is visible");

      // Prompt suggestions update independently while an agent works. A populated draft keeps
      // its own viewport and insertion point when only the unused placeholder changes.
      for (const width of [390, 1440]) await withCard(browser, width, { model: LONG_MODEL, suggestion: null }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill(Array.from({ length: 80 }, (_, i) => `Draft line ${i}: keep this text while the agent works.`).join("\n"));
        await box.evaluate((node) => {
          node.focus();
          node.setSelectionRange(Math.floor(node.value.length / 2), Math.floor(node.value.length / 2));
          node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
        });
        const snapshot = () => box.evaluate((node) => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, scroll: node.scrollTop, height: node.getBoundingClientRect().height, top: node.getBoundingClientRect().top, offsetTop: node.offsetTop, focused: document.activeElement === node }));
        const before = await snapshot();
        // Record the real DOM geometry at height writes as well as after the update. Reading
        // scrollHeight in auto-sizing forces this intermediate layout before the next paint;
        // a final snapshot alone misses the collapse that native caret scrolling can react to.
        await box.evaluate((node) => {
          const prototype = CSSStyleDeclaration.prototype;
          const samples: number[] = [];
          Object.assign(window, { draftHeightSamples: samples });
          Object.defineProperty(prototype, "height", { configurable: true, get() { return this.getPropertyValue("height"); }, set(value: string) {
            this.setProperty("height", value);
            if (this === node.style) samples.push(node.getBoundingClientRect().height);
          } });
        });
        assert.ok(before.scroll > 0 && before.start > 0 && before.start < before.value.length);
        await page.evaluate(() => { (window as unknown as { fitCase: Case }).fitCase.suggestion = "A new suggestion from the agent"; });
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.placeholder === "A new suggestion from the agent", undefined, { timeout: 5_000 });
        const heightSamples = await page.evaluate(() => (window as unknown as { draftHeightSamples: number[] }).draftHeightSamples);
        assert.ok(heightSamples.every((height) => Math.abs(height - before.height) <= 1), `${width}px: an agent prompt update never collapses the populated textarea: ${before.height} -> ${heightSamples.join(", ")}`);
        assert.deepEqual(await snapshot(), before, `${width}px: an agent prompt update preserves the focused draft's geometry, scroll and selection`);
      });
      console.log("PASS prompt updates preserve a focused, internally scrolled draft and its mid-text caret at 390 and 1440px");

      for (const agent of ["claude", "codex", "pi"] as const) for (const width of [320, 1280]) await withCard(browser, width, { agent, model: "gpt-5.6", status: "idle" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const menu = page.getByRole("listbox", { name: "Slash commands", exact: true });
        await box.fill("/");
        await menu.getByRole("option").filter({ hasText: "/clear" }).waitFor();
        for (const text of ["a/b", "http://", "see https://example.test/path", "run tests then /clear"]) {
          await box.fill(text);
          await menu.waitFor({ state: "hidden" });
        }
        for (const text of ["run tests then /", "run tests\n/", "run tests\t/"]) {
          await box.fill(text);
          if (agent === "pi") { await menu.waitFor({ state: "hidden" }); continue; }
          await menu.getByRole("option").first().waitFor();
          const prefix = agent === "codex" ? "$" : "/";
          assert.deepEqual(await menu.locator(".menu-item-main").allTextContents(), [prefix + "delegate", prefix + "template-creator"]);
        }
        if (agent !== "pi") {
          await box.fill("run tests then /del afterwards");
          for (let i = 0; i < 11; i++) await box.press("ArrowLeft");
          assert.equal(await box.evaluate((node: HTMLTextAreaElement) => node.selectionStart), 19);
          await menu.getByRole("option").first().waitFor();
          assert.equal(await menu.evaluate((node) => {
            const box = node.getBoundingClientRect();
            return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight;
          }), true, "the picker fits the viewport");
          if (process.env.UI_EVIDENCE_DIR) {
            mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `slash-${agent}-${width}.png`), fullPage: true });
          }
          // A committing IME Enter belongs to the input method, even while a skill is offered.
          await box.evaluate((node) => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
          assert.equal(await box.inputValue(), "run tests then /del afterwards");
          await box.press("Tab");
          const expected = `run tests then ${agent === "codex" ? "$" : "/"}delegate afterwards`;
          assert.equal(await box.inputValue(), expected);
          assert.equal(await box.evaluate((node: HTMLTextAreaElement) => node.selectionStart), 25);
          await page.keyboard.type("next");
          assert.equal(await box.inputValue(), expected.slice(0, 25) + "next" + expected.slice(25));
          await box.fill("run tests then /del");
          await menu.getByRole("option").first().waitFor();
          await menu.getByRole("option").first().click();
          assert.equal(await box.inputValue(), `run tests then ${agent === "codex" ? "$" : "/"}delegate `);
          if (agent === "codex") {
            await box.fill("use $del");
            await menu.getByRole("option").first().waitFor();
            await box.press("Enter");
            assert.equal(await box.inputValue(), "use $delegate ");
            await box.fill("look at $tmp");
            await menu.waitFor({ state: "hidden" });
          }
          const prefix = agent === "codex" ? "$" : "/";
          for (const text of [prefix + "tmp", "look\n" + prefix + "tmp", "use " + prefix + "creator"]) {
            await box.fill(text);
            await menu.getByRole("option").filter({ hasText: prefix + "template-creator" }).waitFor();
          }
        }
        await box.fill("see @src");
        await page.getByRole("listbox", { name: "Files", exact: true }).waitFor();
        await box.fill("look at /tmp");
        // the send key: a phone's Return breaks the line by default, its hardware Mod+Enter sends
        await box.press(width <= 480 ? "ControlOrMeta+Enter" : "Enter");
        // the send is claimed in the pane's cross-tab lock (#2369), a moment after the key: the box empties then
        await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("textarea.composer-text")?.value === "");
        await page.getByText("look at /tmp", { exact: true }).waitFor();
        assert.equal(await box.inputValue(), "", "the send key sends a path verbatim instead of accepting a fuzzy skill");
        console.log(`PASS skill completion at word boundaries (${agent}, ${width}px)`);
      });
      // One primary control across agents: Stop with an empty working draft, Send with text.
      for (const agent of ["claude", "codex"] as const) for (const width of [350, 390, 800, 1440]) for (const mic of [false, true]) await withCard(browser, width, { agent, model: "gpt-5.6", mic }, async (page) => {
        const rest = await measure(page);
        assert.ok(rest.stop && !rest.send && !rest.sendOptions && !rest.queue, JSON.stringify(rest));
        if (width <= 480) assert.equal(await page.locator(".composer-context").evaluate((node) =>
          node.tagName === "SPAN" && !node.hasAttribute("title") && !node.hasAttribute("aria-expanded") && !node.hasAttribute("tabindex")), true, "mobile context is a read-only ring");
        await draft(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${agent} ${width}px, a written follow-up`);
        assert.ok(row.send && !row.stop && !row.sendOptions && !row.queue && row.ring, JSON.stringify(row));
        assert.equal(row.card.height, rest.card.height, "Send replaces Stop on the same row");
        if (width >= 800) {
          await toggleRing(page, true);
          const opened = await measure(page);
          await drawn(page, opened.draw as Draw, `${agent} ${width}px, context opened`);
          assert.equal(opened.card.height, row.card.height);
          await toggleRing(page, false);
        }
        await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
        assert.equal((await measure(page)).stop, true);
      });
      for (const agent of ["pi", "omo"] as const) await withCard(browser, 390, { agent, model: LONG_MODEL, mic: true }, async (page) => {
        await draft(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${agent}, a long model identifier`);
        assert.ok(row.send && !row.queue && !row.sendOptions);
      });
      console.log("PASS agents at 350, 390, 800 and 1440px use one Stop/Send control with no Queue or dropdown");

      for (const width of [320, 330, 350, 390]) await withCard(browser, width, { agent: "codex", model: LONG_MODEL, mic: true }, async (page) => {
        await draft(page);
        await upload(page);
        const row = await measure(page);
        await drawn(page, row.draw as Draw, `${width}px, a pending upload`);
        assert.ok(row.send && !row.queue && !row.sendOptions && row.hint && !row.hint.clipped, JSON.stringify(row));
        assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true, "an upload cannot enqueue an incomplete mention");
        assert.equal(await page.locator(".pending-message-bubble").count(), 0);
      });

      // Queued text is not a transcript turn. Its selectable bubble has no action: the explicit
      // Send now button acts on the ID, and X discards it. The current fixture turn keeps running.
      for (const agent of ["claude", "codex"] as const) for (const width of [350, 390, 1440]) await withCard(browser, width, { agent, model: "gpt-5.6" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill("check the first pending change");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const strip = page.locator(".pending-messages");
        await strip.waitFor();
        assert.equal(await box.inputValue(), "", "an accepted pending request clears its acknowledged draft");
        assert.equal(await page.locator(".pending-message-bubble").first().textContent(), "check the first pending change");
        const before = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(before).includes("check the first pending change"), "pending text has not been typed");
        await box.fill("discard this second pending change");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pending-message-bubble").length === 2);
        const geometry = await strip.evaluate((node) => {
          const edge = node.getBoundingClientRect();
          return { width: edge.width, height: edge.height, fits: edge.left >= 0 && edge.right <= innerWidth,
            actionsFit: !matchMedia("(pointer: coarse)").matches || [...node.querySelectorAll(".pending-message-action")].every((item) => { const r = item.getBoundingClientRect(), size = parseFloat(getComputedStyle(item).getPropertyValue("--touch-target")); return r.width >= size && r.height >= size; }),
            bubblesFit: [...node.querySelectorAll(".pending-message-bubble")].every((item) => { const r = item.getBoundingClientRect(); return r.left >= edge.left && r.right <= edge.right + 0.5; }) };
        });
        assert.ok(geometry.fits && geometry.bubblesFit && geometry.actionsFit && geometry.height <= 844 * 0.2 + 0.5, JSON.stringify(geometry));
        const bubbles = page.locator(".pending-message-bubble");
        assert.equal(await bubbles.first().evaluate((node) => node.tagName), "DIV", "pending text is selectable, without a click action");
        await bubbles.first().click();
        assert.equal(await bubbles.count(), 2, "clicking message text does not send it");
        const untouched = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(untouched).includes("check the first pending change"));
        await strip.getByRole("button", { name: "Send now: check the first pending change", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pending-message-bubble").length === 1);
        const after = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.equal(JSON.stringify(after).split("check the first pending change").length - 1, 1, "Send now delivers this ID once");
        await strip.getByRole("button", { name: "Discard", exact: true }).click();
        await strip.waitFor({ state: "hidden" });
        const discarded = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(discarded).includes("discard this second pending change"));
      });
      console.log("PASS selectable pending bubbles fit phones; explicit Send now and Discard act on IDs");

      // A confirmed hold can be sent explicitly on a new connection. An unconfirmed queued
      // request instead becomes uncertain and never offers an automatic or explicit retry.
      for (const held of [false, true]) await withCard(browser, 390, { agent: "codex", model: "gpt-5.6" }, async (page) => {
        const text = held ? "confirmed held follow-up" : "unconfirmed follow-up";
        await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator(".pending-message-bubble").waitFor();
        await page.evaluate(({ held, paneId }) => {
          const socket = (window as unknown as { fitSocket: { holdPending: (pane: string) => void; close: () => void } }).fitSocket;
          if (held) socket.holdPending(paneId);
          socket.close();
        }, { held, paneId: panes.api });
        await page.waitForFunction(() => (window as unknown as { fitSocket?: { readyState: number } }).fitSocket?.readyState === 1);
        const bubble = page.locator(".pending-message-bubble");
        await page.waitForFunction((state) => document.querySelector(".pending-message")?.getAttribute("data-state") === state, held ? "held" : "uncertain");
        const notSent = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
        assert.ok(!JSON.stringify(notSent).includes(text), "reconnection never sends a stored copy");
        if (held) {
          await page.waitForFunction(() => !(document.querySelector(".pending-message-send") as HTMLButtonElement).disabled);
          await page.getByRole("button", { name: `Send now: ${text}`, exact: true }).click();
          await bubble.waitFor({ state: "hidden" });
          const sent = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).json(), panes.api);
          assert.equal(JSON.stringify(sent).split(text).length - 1, 1);
        } else {
          assert.equal(await page.locator(".pending-message-send").count(), 0, "uncertain text has no Send now action");
          assert.equal(await page.locator(".pending-message-action").evaluateAll((items) => items.every((item) => {
            const r = item.getBoundingClientRect(), size = parseFloat(getComputedStyle(item).getPropertyValue("--touch-target"));
            return r.width >= size && r.height >= size;
          })), true, "Copy and Discard keep the full touch target");
          await page.getByRole("button", { name: "Discard saved copy", exact: true }).click();
          await bubble.waitFor({ state: "hidden" });
        }
      });
      await withCard(browser, 800, { agent: "codex", pending: false, model: "gpt-5.6" }, async (page) => {
        await draft(page);
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.locator(".composer-note").waitFor();
        assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).inputValue(), "hold this");
        assert.equal(await page.locator(".pending-message-bubble").count(), 0);
        assert.match(await page.locator(".composer-note").textContent() ?? "", /Update this PC/);
        // the reason sits on the box's top edge, the box's width, not under it
        const [noteBox, surfaceBox] = await Promise.all([page.locator(".composer-note").boundingBox(), page.locator(".composer-surface").boundingBox()]);
        assert.ok(noteBox && surfaceBox && noteBox.y + noteBox.height <= surfaceBox.y + 1, "the note is above the message box");
        assert.ok(noteBox && surfaceBox && Math.abs(noteBox.width - surfaceBox.width) <= 1 && Math.abs(noteBox.x - surfaceBox.x) <= 1, "and as wide as it");
      });
      console.log("PASS connection loss suspends pending items, confirmed holds need Send now, and old bridges keep the draft");

      for (const weeklyOnly of [false, true]) await withCard(browser, 1440, { agent: "codex", model: "gpt-5.6", showUsage: true, weeklyOnly }, async (page) => {
        const usage = page.locator(".composer-status .composer-usage");
        await usage.waitFor();
        assert.equal(await usage.evaluate((node) => node.tagName === "SPAN" && !node.hasAttribute("tabindex")), true, "desktop quota is a read-only glance");
        assert.equal(await usage.locator('span[aria-hidden="true"]').textContent(), weeklyOnly ? "Weekly 84%" : "5h 22%", "the session precedes the tighter week; no session falls back to the week");
        assert.equal(await usage.evaluate((node) => node.classList.contains("is-high")), weeklyOnly);
        assert.match(await usage.getAttribute("title") ?? "", /sam@work\.example/);
      });
      await withCard(browser, 390, { agent: "codex", model: "gpt-5.6", showUsage: true }, async (page) => {
        assert.equal(await page.locator(".composer-status .composer-usage").count(), 0, "mobile omits the desktop quota even when sidebar limits are enabled");
        assert.equal(await page.locator(".composer-context").evaluate((node) => node.tagName === "SPAN" && !node.hasAttribute("aria-expanded")), true);
      });
      console.log("PASS desktop quota is read-only and session-first with weekly fallback; mobile keeps only the inert context ring");

      // The message box is typed at the transcript's size (Settings → Chat font size): with a mouse
      // exactly, on a phone never under 16px, the smallest size iOS does not zoom the page for
      for (const width of [390, 1440]) for (const chatFontSize of [null, 20]) await withCard(browser, width, { model: "claude-opus-5-5", chatFontSize }, async (page) => {
        const [box, body] = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.fontSize = "var(--chat-fs-body)";
          document.querySelector(".chat-view")!.append(probe);
          const sizes = [document.querySelector(".composer-text")!, probe].map((node) => parseFloat(getComputedStyle(node).fontSize));
          probe.remove();
          return sizes;
        });
        const want = width <= 480 ? Math.max(16, body!) : body!;
        assert.ok(Math.abs(box! - want) < 0.05, `${width}px, chat size ${chatFontSize ?? "default"}: the box is ${box}px, the transcript ${body}px`);
        if (chatFontSize === null) assert.equal(box, width <= 480 ? 16 : 15, "with no size chosen the box keeps its size");
      });
      console.log("PASS the message box follows Chat font size: with a mouse at the transcript's size, on a phone never under 16px");

      // Pressing Send leaves focus in the message box. On a phone, moving it closes the soft keyboard
      // and shifts the layout, so the tap never lands as a click. Press and release away from the
      // button, so nothing is sent.
      for (const width of [390, 1440]) await withCard(browser, width, { model: "claude-opus-5-5" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.fill("a draft that stays");
        const bounds = (await page.getByRole("button", { name: "Send message", exact: true }).boundingBox())!;
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        assert.equal(await box.evaluate((node) => node === document.activeElement), true, `${width}px: pressing Send keeps the message box focused`);
        await page.mouse.move(0, 0);
        await page.mouse.up();
        assert.equal(await box.inputValue(), "a draft that stays", "nothing was sent");
        // Stop too: once the turn stops it is a disabled Send in the same node, and a focused node that
        // is disabled drops focus to the page, where the next keys typed go nowhere
        await box.fill("");
        const stop = (await page.getByRole("button", { name: "Stop agent", exact: true }).boundingBox())!;
        await page.mouse.move(stop.x + stop.width / 2, stop.y + stop.height / 2);
        await page.mouse.down();
        assert.equal(await box.evaluate((node) => node === document.activeElement), true, `${width}px: pressing Stop keeps the message box focused`);
        await page.mouse.move(0, 0);
        await page.mouse.up();
      });
      console.log("PASS pressing Send or Stop keeps focus in the message box");

      // With focus kept, the tap does not end a composition (Gboard composes every word, a Korean
      // keyboard the open syllable): Send finishes the word itself and sends the box as shown.
      await withCard(browser, 390, { status: "idle", model: "claude-opus-5-5" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const holds = (value: string, label: string) => box.evaluate((node: HTMLTextAreaElement, value) => new Promise<void>((resolve, reject) => {
          const deadline = performance.now() + 5_000;
          const check = () => node.value === value ? resolve() : performance.now() > deadline ? reject(new Error(`value ${JSON.stringify(node.value)}`)) : requestAnimationFrame(check);
          check();
        }), value).catch((error) => { throw new Error(`${label}: ${error}`); });
        await box.tap();
        await box.fill("hello ");
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.imeSetComposition", { text: "안", selectionStart: 1, selectionEnd: 1 });
        await holds("hello 안", "the syllable is composing");
        await page.getByRole("button", { name: "Send message", exact: true }).tap();
        await holds("", "Send during a composition sends the message");
        assert.equal(await box.evaluate((node) => node === document.activeElement), true, "the message box keeps focus");
        await cdp.send("Input.imeSetComposition", { text: "나", selectionStart: 1, selectionEnd: 1 });
        await cdp.send("Input.insertText", { text: "나" });
        await holds("나", "the next syllable starts in an empty box");
        await cdp.detach();
      });
      console.log("PASS Send tapped mid-composition finishes the word and sends");

      // A keyboard that does not commit inside the tap leaves it waiting for the word. A drop inside
      // that wait withdraws it: the commit after a quick reconnect sends nothing on the new connection.
      await withCard(browser, 390, { status: "idle", model: "claude-opus-5-5" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await box.tap();
        await box.fill("dropped while composing ");
        await page.evaluate(() => {
          // the keyboard keeps composing through the tap's blur, and the tap's 300 ms deadline is held,
          // so only the drop can withdraw the tap, however long the reconnect takes
          document.querySelector<HTMLTextAreaElement>(".composer-text")!.blur = () => {};
          const later = window.setTimeout;
          window.setTimeout = ((callback: TimerHandler, ms?: number, ...args: unknown[]) => ms !== undefined && ms >= 280 && ms <= 300 ? 0 : later(callback, ms, ...args)) as typeof window.setTimeout;
        });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.imeSetComposition", { text: "안", selectionStart: 1, selectionEnd: 1 });
        await page.getByRole("button", { name: "Send message", exact: true }).tap();
        const note = page.locator(".composer-note");
        await note.filter({ hasText: "Finishing the word…" }).waitFor({ timeout: 5_000 });
        // drop the connection and wait, a frame at a time, until it went offline and came back
        await page.evaluate(() => new Promise<void>((resolve, reject) => {
          const fixture = window as unknown as { fitSocket: WebSocket };
          const dropped = fixture.fitSocket;
          const offline = () => document.querySelector(".composer-status")?.hasAttribute("data-offline") === true;
          const deadline = performance.now() + 10_000;
          let sawOffline = false;
          const check = () => {
            sawOffline ||= offline();
            if (sawOffline && !offline() && fixture.fitSocket !== dropped && fixture.fitSocket.readyState === WebSocket.OPEN) return resolve();
            if (performance.now() > deadline) return reject(new Error(`reconnect: sawOffline ${sawOffline}`));
            requestAnimationFrame(check);
          };
          dropped.close();
          check();
        }));
        // count the submits on the new connection, then let the keyboard commit the word
        await page.evaluate(() => {
          const fixture = window as unknown as { fitSocket: WebSocket; fitSubmits: number };
          fixture.fitSubmits = 0;
          const send = fixture.fitSocket.send.bind(fixture.fitSocket);
          fixture.fitSocket.send = (raw) => { if (typeof raw === "string" && JSON.parse(raw).type === "submit") fixture.fitSubmits += 1; send(raw); };
        });
        await cdp.send("Input.insertText", { text: "안" });
        // the committed word's send runs a task after compositionend: wait one task and a frame past it
        await page.evaluate(() => new Promise((resolve) => setTimeout(() => requestAnimationFrame(resolve))));
        assert.equal(await page.evaluate(() => (window as unknown as { fitSubmits: number }).fitSubmits), 0, "nothing is submitted on the new connection");
        assert.equal(await box.inputValue(), "dropped while composing 안", "the message stays in the box");
        assert.equal(await note.textContent(), "Not sent: the terminal is disconnected.");
        await cdp.detach();
      });
      console.log("PASS a drop while Send waits for the word withdraws it; the reconnect sends nothing");

      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true }, async (page) => {
        await page.emulateMedia({ reducedMotion: "reduce" });
        // A compact viewport supplies scrollable history without changing disclosure state.
        await page.setViewportSize({ width, height: 600 });
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const draft = "An unsent draft.";
        await page.locator(".chat-virtual-row").last().waitFor();
        await box.fill(draft);
        await page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight > 120 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        });
        await page.locator(".chat-view").hover();
        await page.mouse.wheel(0, -120);
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        const reading = await page.evaluate(() => {
          const node = document.querySelector(".chat-view")!;
          const view = node.getBoundingClientRect();
          const paragraph = [...node.querySelectorAll(".markdown p")].find((item) =>
            item.getBoundingClientRect().bottom > view.top && item.getBoundingClientRect().top < view.bottom);
          if (!paragraph) throw new Error("The reader's paragraph is not rendered");
          return { text: paragraph.textContent!, offset: paragraph.getBoundingClientRect().top - view.top, gap: node.scrollHeight - node.clientHeight - node.scrollTop };
        });
        assert.ok(reading.gap > 48, "the reader is away from the end before changing lenses");
        await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
        await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
        await page.waitForFunction((saved) => {
          const node = document.querySelector(".chat-view");
          if (!node) return false;
          const paragraph = [...node.querySelectorAll(".markdown p")].find((item) => item.textContent === saved.text);
          return paragraph !== undefined && Math.abs(paragraph.getBoundingClientRect().top - node.getBoundingClientRect().top - saved.offset) <= 1
            && node.scrollHeight - node.clientHeight - node.scrollTop > 48;
        }, reading);
        assert.equal(await box.inputValue(), draft, "the unsent draft survives the terminal/chat round trip");
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        // Leave in the same task: the list's deferred scroll cannot update memory first.
        await page.evaluate(() => {
          document.querySelector<HTMLButtonElement>('button[title="Jump to latest"]')!.click();
          document.querySelector<HTMLButtonElement>('button[title="Live terminal (⌘⇧J)"]')!.click();
        });
        await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
        await page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        }, undefined, { timeout: 5_000 });
        await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
        await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
        await page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        }, undefined, { timeout: 5_000 });
      });
      console.log("PASS terminal/chat return preserves the reader's paragraph and one-line draft, and remembers Jump-to-latest intent before a deferred scroll");

      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        await page.locator(".chat-virtual-row").last().waitFor();
        const atBottom = () => page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        }, undefined, { timeout: 5_000 });
        await box.fill("Short draft.");
        await atBottom();
        const samples = await page.evaluateHandle(() => {
          const node = document.querySelector(".chat-view")!;
          const box = document.querySelector(".composer-text")!;
          const geometry = () => {
            const last = [...node.querySelectorAll("[data-chat-row]")].at(-1)!;
            return {
              height: box.clientHeight,
              viewport: node.clientHeight,
              gap: node.scrollHeight - node.clientHeight - node.scrollTop,
              spacing: document.querySelector(".composer-surface")!.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
            };
          };
          const resizeFrames: ComposerScrollGeometry[] = [];
          const inputFrames: ComposerScrollGeometry[] = [];
          const observer = new ResizeObserver(() => resizeFrames.push(geometry()));
          // React's delegated input handler has run before this document listener. Read its
          // commit in the same task, before a later frame could repair a displaced transcript.
          const onInput = (event: Event) => {
            if (event.target === box) queueMicrotask(() => inputFrames.push(geometry()));
          };
          document.addEventListener("input", onInput);
          observer.observe(node);
          return { geometry, resizeFrames, inputFrames, observer, onInput };
        });
        try {
          const geometry = () => samples.evaluate(({ geometry }) => geometry());
          const initial = await geometry();
          const sameLineEdit = async (key: string, height: number, what: string) => {
            const count = await samples.evaluate(({ inputFrames }) => inputFrames.length);
            await box.press(key);
            const frames = await samples.evaluate(({ inputFrames }, count) => inputFrames.slice(count), count);
            assert.equal(frames.length, 1, `${what}: one native input edit was sampled`);
            const edited = frames[0]!;
            assert.equal(edited.height, height, `${what}: an edit within the same line keeps the input height`);
            assert.ok(edited.gap <= 1 && Math.abs(edited.spacing - initial.spacing) <= 1, `${what}: the multiline draft keeps bottom spacing without a delayed repair: ${JSON.stringify(edited)}`);
          };
          const wrapped = "A draft that wraps onto the next line. ".repeat(width === 390 ? 12 : 48);
          for (const [kind, text] of [["soft-wrapped", wrapped], ["explicit-newline", "First line\nSecond line\nThird line"]] as const) {
            await box.fill(text);
            await page.waitForFunction((height) => document.querySelector(".composer-text")!.clientHeight > height, initial.height);
            await atBottom();
            const grown = await geometry();
            assert.ok(grown.viewport < initial.viewport, `${kind}: a taller draft reduces the transcript viewport`);
            assert.ok(Math.abs(grown.spacing - initial.spacing) <= 1, `${kind}: growth preserves the output/input gap`);
            await sameLineEdit("x", grown.height, `${kind} typing`);
            await sameLineEdit("Backspace", grown.height, `${kind} backspacing`);
            await box.fill("Short draft.");
            await page.waitForFunction((height) => document.querySelector(".composer-text")!.clientHeight === height, initial.height);
            await atBottom();
            const shrunk = await geometry();
            assert.equal(shrunk.viewport, initial.viewport, `${kind}: shrinking restores the transcript viewport`);
            assert.ok(Math.abs(shrunk.spacing - initial.spacing) <= 1, `${kind}: shrinking preserves the output/input gap`);
          }
          const frames = await samples.evaluate(({ resizeFrames }) => resizeFrames);
          assert.ok(frames.some((frame) => frame.viewport < initial.viewport), "resize samples include the reduced transcript viewport");
          assert.ok(frames.every((frame) => frame.gap <= 1 && Math.abs(frame.spacing - initial.spacing) <= 1), `resize frames keep bottom spacing before paint: ${JSON.stringify(frames)}`);
        } finally {
          await samples.evaluate(({ observer, onInput }) => {
            observer.disconnect();
            document.removeEventListener("input", onInput);
          });
          await samples.dispose();
        }
      });
      console.log("PASS wrapped and multiline drafts keep bottom spacing through growth, shrinkage and same-line edits on phone and desktop");

      for (const width of [390, 1440]) await withCard(browser, width, { status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const draft = "An unsent draft.\n".repeat(6);
        await box.fill(draft);
        await page.waitForFunction(() => {
          const node = document.querySelector(".chat-view")!;
          return node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
        });
        const initialHeight = await box.evaluate((node) => node.clientHeight);
        await page.locator(".chat-view").hover();
        await page.mouse.wheel(0, -120);
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        const paragraph = (text: string | null = null) => page.evaluate((text) => {
          const node = document.querySelector(".chat-view")!;
          const view = node.getBoundingClientRect();
          const paragraph = [...node.querySelectorAll(".markdown p")].find((item) => text === null
            ? item.getBoundingClientRect().bottom > view.top && item.getBoundingClientRect().top < view.bottom
            : item.textContent === text);
          if (!paragraph) throw new Error("The reader's paragraph is not rendered");
          return { text: paragraph.textContent!, offset: paragraph.getBoundingClientRect().top - view.top, gap: node.scrollHeight - node.clientHeight - node.scrollTop };
        }, text);
        const reading = await paragraph();
        assert.ok(reading.gap > 48, "the reader is away from the end before editing");
        for (const text of ["An edited unsent draft.\n".repeat(9), draft]) {
          await box.fill(text);
          await page.waitForFunction(({ initialHeight, growing }) => {
            const height = document.querySelector(".composer-text")!.clientHeight;
            return growing ? height > initialHeight : height === initialHeight;
          }, { initialHeight, growing: text !== draft });
          // Let layout observers finish, without waiting for the paragraph to be repaired.
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const after = await paragraph(reading.text);
          assert.ok(Math.abs(after.offset - reading.offset) <= 1 && after.gap > 48, `editing keeps the reader on the same paragraph: ${JSON.stringify({ reading, after })}`);
        }
      });
      console.log("PASS editing drafts preserves the reader's paragraph on phone and desktop");

      for (const width of [320, 1440]) for (const [language, text] of [
        ["ko", "가나다라마바사 ".repeat(5)],
        ["ja", "あいうえおゃゅょ。".repeat(4)],
        ["zh", "天地玄黄，宇宙洪荒。".repeat(4)],
      ] as const) await withCard(browser, width, { language, status: "idle", pending: false, model: "gpt-5.6", freezeConversation: true, suggestion: text }, async (page) => {
        const box = page.locator(".composer-text");
        await page.waitForFunction((text) => document.querySelector<HTMLTextAreaElement>(".composer-text")!.placeholder === text, text);
        for (const value of [text, ""]) {
          await box.fill(value);
          await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
          const size = await box.evaluate((box: HTMLTextAreaElement) => {
            // Let the browser size a copy of the visible field's own wrapping rules,
            // independently of the measurement field's styles, without moving the transcript.
            const probe = box.cloneNode() as HTMLTextAreaElement;
            probe.removeAttribute("aria-label");
            probe.setAttribute("aria-hidden", "true");
            probe.tabIndex = -1;
            Object.assign(probe.style, { position: "absolute", visibility: "hidden", height: "0px", minHeight: "0px", width: `${box.getBoundingClientRect().width}px` });
            box.after(probe);
            try {
              const required = probe.scrollHeight;
              probe.style.minHeight = getComputedStyle(box).minHeight;
              probe.style.height = `${required}px`;
              return { actual: box.clientHeight, expected: probe.clientHeight };
            } finally { probe.remove(); }
          });
          assert.ok(Math.abs(size.actual - size.expected) <= 1, `${language}/${width}px: ${value ? "draft" : "placeholder"} uses the visible field's natural height: ${JSON.stringify(size)}`);
        }
      });
      console.log("PASS Korean, Japanese and Chinese drafts and wrapped placeholders fit their native text height on phone and desktop");

      // Changing the setting in an already-open chat rewraps the existing draft: an automatic
      // box grows and shrinks with it.
      for (const width of [390, 1440]) await withCard(browser, width, { model: "claude-opus-5-5" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        assert.equal(await page.getByRole("separator", { name: "Resize message box", exact: true }).count(), 0, "the message box has no resize grip");
        const text = "An unsent draft changes size with the transcript.\nIts second line stays visible.\nThe third line stays visible too.";
        const height = () => box.evaluate((node) => node.clientHeight);
        const chooseSize = async (size: number) => {
          await page.keyboard.press("ControlOrMeta+Shift+Comma");
          await openSettingsPage(page, "Chat");
          const current = Number.parseInt(await page.locator('.settings-stepper[aria-label="Chat font size"] output').innerText(), 10);
          const button = page.getByRole("button", { name: size > current ? "Increase chat font size" : "Decrease chat font size", exact: true });
          for (let step = 0; step < Math.abs(size - current); step++) await button.click();
          await page.getByRole("button", { name: "Close settings", exact: true }).click();
        };
        await box.fill(text);
        const initial = await height();
        await chooseSize(20);
        await page.waitForFunction((before) => {
          const box = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return box.clientHeight > before && box.scrollHeight <= box.clientHeight + 1;
        }, initial);
        const large = await height();
        assert.equal(await box.inputValue(), text, "resizing keeps the draft whole");
        await chooseSize(11);
        await page.waitForFunction((before) => document.querySelector(".composer-text")!.clientHeight < before, large);
        assert.equal(await box.inputValue(), text, "shrinking keeps the draft whole");
      });
      console.log("PASS changing Chat font size grows and shrinks an existing draft's automatic box");

      // CSS layout zoom exercises fractional geometry and rewrapping; it is not native browser
      // zoom or mobile pinch zoom. Keep one draft mounted while changing each scale.
      for (const width of [390, 1440]) await withCard(browser, width, { model: "gpt-5.6-sol", status: "idle" }, async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const drafts = ["", "A short message. 짧은 메시지", "long_unbroken_text_".repeat(100), Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: a long draft`).join("\n")];
        for (const text of drafts) {
          await box.fill(text);
          for (const zoom of [0.8, 1, 1.25, 1.5, 2, 1]) {
            await page.evaluate((scale) => { document.documentElement.style.zoom = String(scale); }, zoom);
            await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
            // The width observer commits the automatic height after layout zoom rewraps text.
            await page.waitForFunction((short) => {
              const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
              return node.scrollWidth <= node.clientWidth + 1 && (!short || node.scrollHeight <= node.clientHeight + 1);
            }, text === drafts[0] || text === drafts[1], { timeout: 5_000 });
            const metrics = await box.evaluate((node) => {
              const style = getComputedStyle(node);
              const probe = document.body.appendChild(document.createElement("span"));
              probe.style.color = "var(--border-strong)";
              const thumb = getComputedStyle(probe).color;
              probe.remove();
              return { scrollbar: style.scrollbarWidth, color: style.scrollbarColor, thumb, gutter: style.scrollbarGutter, overflowY: style.overflowY, height: node.clientHeight, scrollHeight: node.scrollHeight };
            });
            // a token that does not exist drops the whole declaration: the colour is then "auto"
            assert.equal(metrics.color, `${metrics.thumb} rgba(0, 0, 0, 0)`, "the scroll cue is drawn in the theme's border colour on the card's own fill");
            assert.equal(metrics.scrollbar, "thin", `${width}px at ${zoom}: long drafts keep a narrow scroll cue`);
            assert.equal(metrics.gutter, "stable", "the scroll cue keeps reserved room beside the draft");
            assert.equal(metrics.overflowY, "auto", "long drafts remain scrollable");
            assert.equal(await box.inputValue(), text, "changing zoom preserves the draft");
            if (text === drafts[0] || text === drafts[1]) assert.ok(metrics.scrollHeight <= metrics.height + 1, "empty and short drafts fit without vertical clipping");
          }
        }
        const endKey = process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End";
        await box.press(endKey);
        await page.waitForFunction(() => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === node.value.length && node.scrollTop > 0;
        }, undefined, { timeout: 5_000 });
        const endScroll = await box.evaluate((node) => node.scrollTop);
        await box.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
        // Native caret scrolling trims different amounts of padding/leading across platforms.
        // Check keyboard movement independently from reaching the absolute wheel boundary.
        await page.waitForFunction((end) => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === 0 && node.scrollTop < end;
        }, endScroll, { timeout: 5_000 });
        await box.hover();
        await page.mouse.wheel(0, -2000);
        await page.waitForFunction(() => document.querySelector(".composer-text")!.scrollTop <= 1, undefined, { timeout: 5_000 });
        await page.mouse.wheel(0, 400);
        await page.waitForFunction(() => document.querySelector(".composer-text")!.scrollTop > 1, undefined, { timeout: 5_000 });
        const wheelScroll = await box.evaluate((node) => node.scrollTop);
        await box.press(endKey);
        await page.waitForFunction((before) => {
          const node = document.querySelector<HTMLTextAreaElement>(".composer-text")!;
          return node.selectionStart === node.value.length && node.scrollTop > before;
        }, wheelScroll, { timeout: 5_000 });
        assert.equal(await box.inputValue(), drafts[3], "wheel and keyboard scrolling preserve the draft");
        if (width === 1440 && process.env.COMPOSER_FIT_SCREENSHOT) await page.locator(".composer").screenshot({ path: process.env.COMPOSER_FIT_SCREENSHOT });
      });
      console.log("PASS stable thin scrollbars, wrapped drafts and wheel/keyboard scrolling at 80–200% CSS layout zoom");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
