import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";

// The model label in the input card's last row, fitted to what is measured there, on the
// unmodified app over the demo's fixture transport. The demo's panes name no context window and
// run no task, so the page's data is patched here, in the test only: the pane is a Claude or Codex one with
// two background tasks, in the state a case asks for, and its conversation names that case's
// model, the level xhigh and a context window; an upload never answers, so its sentence stays.
// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.

// an id the composer cannot name is drawn as received, in the mono face: the widest label there is
const LONG_MODEL = "gpt-5.6-sol-codex-preview-2026-10";
// ids it names: "GPT-5.6" and "Opus 5.5"; null: the conversation names no model
const NAMED = ["gpt-5.6", "claude-opus-5-5"] as const;

interface Case { model: string | null; agent?: "claude" | "codex" | "pi" | "omo"; provider?: string; pending?: boolean; effort?: string | null; status?: "working" | "idle"; mic?: boolean; ring?: boolean; chatFontSize?: number | null; showUsage?: boolean; weeklyOnly?: boolean; suggestion?: string | null; suggestionChip?: boolean; contextUsed?: number; stream?: number; freezeConversation?: boolean; language?: "en" | "ko" | "ja" | "zh"; theme?: "light" | "dark"; scale?: number; autoSend?: boolean }
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
    label: part(".composer-model-info"), model: part(".composer-model"), effort: part(".composer-reasoning"), ring: part(".composer-context"),
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

const draft = async (page: Page): Promise<void> => {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("hold this");
  await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
};
const upload = async (page: Page): Promise<void> => {
  await page.locator('.composer-controls-left input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  await page.locator(".composer-status-hint").waitFor();
  assert.equal(await page.locator(".composer-status-hint").textContent(), "· Uploading file…");
};

/**
 * The demo app built into `app` with its page's data patched as described above, served on 127.0.0.1
 * at a free port: `url` opens the patched pane, and `withCard` runs one check on a fresh page of it.
 * The composer scripts (composer-fit-, composer-send- and composer-draft-demo-regression.ts) all
 * start here, so the patch and the case a card defaults to are the same in each.
 */
export async function composerFitDemo(app: string) {
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
      if (Array.isArray(value.turns) && value.metadata) value.metadata = { model: window.fitCase.model, reasoning_effort: window.fitCase.effort, ...(window.fitCase.provider ? { provider: window.fitCase.provider } : {}), ...(window.fitCase.ring ? { context: { used: window.fitCase.contextUsed ?? 151000, window: 272000 } } : {}) };
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
        if (frame.type === "submit") window.fitSubmitCount = (window.fitSubmitCount ?? 0) + 1;
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
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: fitCase.language ?? "en", voiceInput: fitCase.mic ? "on" : "off", suggestionChip: fitCase.suggestionChip ?? false, chatFontSize: fitCase.chatFontSize ?? null, showUsage: fitCase.showUsage ?? false, usageCount: "used", ...(fitCase.theme ? { theme: fitCase.theme } : {}), ...(fitCase.autoSend === undefined ? {} : { autoSendQueued: fitCase.autoSend }) }));
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
  return { server, url, withCard };
}

export { LONG_MODEL, draft, drawn, measure, upload, type Case, type ComposerScrollGeometry, type Draw };
