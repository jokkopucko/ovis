import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { contextMenuKey } from "./context-menu-key.ts";
import type { Machine } from "../shared/machines.ts";
import type { AgentStatus, ConversationResponse, ServerMessage } from "../shared/protocol.ts";
import { openLens } from "./header-lens.ts";
import { serveDemo } from "./demo-server.ts";

declare global {
  interface Window {
    sidebarFixture: {
      finish(paneId: string, status: AgentStatus, seq: number): Promise<void>;
      zoom(paneId: string, focusedId: string): Promise<void>;
      split(paneId: string, focusedId: string): Promise<void>;
      block(paneId: string, kind: "loading" | "failed" | "held" | "unattached" | "files"): void;
      unblock(): void;
      blockedReads: number;
      reads: Record<string, number>;
      pad(paneId: string, turns: number): void;
      frame(message: ServerMessage): void;
      conversation(paneId: string, response: ConversationResponse): void;
      replay(paneId: string, ready: boolean, data: string, readyAfter?: boolean): void;
      recoveringReplay(paneId: string, data: string): void;
      hold(paneId: string): void;
      attaches: Record<string, number>;
      replaceTerminal(paneId: string): Promise<void>;
      unrestored(paneId: string | null): Promise<void>;
    };
  }
}

function installSidebarFixture(): void {
  const key = "sidebar-regression:roster";
  const stored = sessionStorage.getItem(key);
  const state: { finishes: Record<string, { status: AgentStatus; seq: number }>; zoom: { paneId: string; focusedId: string; split?: boolean } | null; blocked?: { paneId: string; kind: string }; padded?: Record<string, number>; terminals?: Record<string, string>; unrestored?: string | null } =
    stored ? JSON.parse(stored) : { finishes: {}, zoom: null };
  const sources = new Set<EventSource>();
  const sockets = new Set<WebSocket>();
  const conversations = new Map<string, { response: ConversationResponse; etag: string }>();
  let conversationRevision = 0;
  const replays = new Map<string, { ready: boolean; data: string; readyAfter: boolean; recovering?: boolean; held?: boolean }>();
  const patch = (machines: Machine[]): Machine[] => {
    for (const machine of machines) {
      const snapshot = machine.snapshot;
      if (!snapshot) continue;
      snapshot.finish_epoch = `sidebar-fixture:${machine.id}:1`;
      for (const pane of snapshot.panes) {
        const finish = state.finishes[pane.pane_id];
        if (finish) { pane.agent_status = finish.status; pane.finish_id = finish.seq; }
        const terminal = state.terminals?.[pane.pane_id];
        if (terminal) pane.terminal_id = terminal;
        if (pane.pane_id === state.unrestored) pane.restore_error = "held by the fixture";
      }
      for (const agent of snapshot.agents) {
        const finish = state.finishes[agent.pane_id];
        if (finish) { agent.agent_status = finish.status; agent.state_change_seq = finish.seq; }
        const terminal = state.terminals?.[agent.pane_id];
        if (terminal) agent.terminal_id = terminal;
      }
      if (state.zoom) {
        const target = snapshot.panes.find((pane) => pane.pane_id === state.zoom?.paneId);
        const focused = snapshot.panes.find((pane) => pane.pane_id === state.zoom?.focusedId);
        const layout = snapshot.layouts.find((item) => item.tab_id === focused?.tab_id);
        if (target && focused && layout) {
          target.workspace_id = focused.workspace_id;
          target.tab_id = focused.tab_id;
          layout.zoomed = !state.zoom.split;
          layout.focused_pane_id = focused.pane_id;
          if (!layout.panes.some((pane) => pane.pane_id === target.pane_id)) {
            layout.panes.push({ pane_id: target.pane_id, focused: false, rect: { ...layout.area } });
          }
        }
      }
    }
    return machines;
  };
  const fetchDemo = window.fetch;
  const pendingReads: (() => void)[] = [];
  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    const finish = state.finishes[url.searchParams.get("pane_id") ?? ""];
    let response = await fetchDemo(input, init);
    if (url.pathname === "/api/pane/conversation") {
      const id = url.searchParams.get("pane_id") ?? "";
      const conversation = conversations.get(id);
      if (conversation) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        response = headers.get("if-none-match") === conversation.etag
          ? new Response(null, { status: 304, headers: { etag: conversation.etag } })
          : Response.json(conversation.response, { headers: { etag: conversation.etag } });
      } else if (finish?.status === "done" && response.ok) {
        const body = await response.json() as ConversationResponse;
        const last = body.turns.at(-1);
        if (last?.role === "assistant") {
          last.ts = new Date((Date.parse(last.ts ?? "") || 0) + finish.seq * 1000).toISOString();
          if (last.end_ts) last.end_ts = new Date(Date.parse(last.end_ts) + finish.seq * 1000).toISOString();
        }
        response = Response.json(body);
      }
      const padding = state.padded?.[id] ?? 0;
      if (padding > 0 && response.ok) {
        const body = await response.json();
        const turns = body.turns as { parts: unknown[] }[];
        if (turns.length > 0) {
          body.turns = [...Array.from({ length: padding }, (_, index) => ({ ...turns[index % turns.length], parts: [
            { kind: "text", text: `Earlier note ${index + 1}: ${"a line of fixture text that fills the screen. ".repeat(4)}` },
          ] })), ...turns];
        }
        response = Response.json(body);
      }
      window.sidebarFixture.reads[id] = (window.sidebarFixture.reads[id] ?? 0) + 1;
    }
    if (url.searchParams.get("pane_id") === state.blocked?.paneId) {
      if (url.pathname === "/api/pane/conversation" && ["loading", "failed"].includes(state.blocked.kind)) {
        window.sidebarFixture.blockedReads++;
        if (state.blocked.kind === "loading") await new Promise<void>((resolve) => pendingReads.push(resolve));
        else return Response.json({ error: { code: "fixture_failure", message: "Fixture conversation failed" } }, { status: 500 });
      }
      if (url.pathname === "/api/pane/files" && state.blocked.kind === "files") {
        return Response.json({ error: { code: "fixture_failure", message: "Fixture suggestions failed" } }, { status: 500 });
      }
    }
    if (url.pathname === "/api/machines") {
      const body = await response.json();
      return Response.json({ ...body, machines: patch(body.machines) });
    }
    return response;
  }, fetchDemo);
  const DemoSocket = window.WebSocket;
  window.WebSocket = class extends DemoSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.add(this);
      // The demo constructor returns its own EventTarget object, so wrap that instance's
      // method instead of overriding a subclass prototype that the returned object never uses.
      const send = this.send.bind(this);
      this.send = (raw) => {
        const message = JSON.parse(String(raw));
        const replay = replays.get(message.pane_id);
        if (message.type === "attach") window.sidebarFixture.attaches[message.pane_id] = (window.sidebarFixture.attaches[message.pane_id] ?? 0) + 1;
        if (message.type === "attach" && replay?.held) return;
        if (message.type === "attach" && replay?.recovering) {
          for (const frame of [{ type: "output-recovering", pane_id: message.pane_id }, { type: "pty-data", pane_id: message.pane_id, data: replay.data, replay: true }]) {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
          }
          return;
        }
        if (message.type === "attach" && replay) {
          const frames = [
            { type: "input-ready", pane_id: message.pane_id, ready: replay.ready },
            { type: "pty-data", pane_id: message.pane_id, data: replay.data },
          ];
          for (const frame of replay.readyAfter ? frames.reverse() : frames) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) }));
          return;
        }
        const blocked = state.blocked;
        if (message.type === "attach" && blocked && message.pane_id === blocked.paneId
          && ["held", "unattached"].includes(blocked.kind)) {
          if (blocked.kind === "held") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
            type: "error", pane_id: message.pane_id, code: "attach_held", message: "Fixture attach held",
          }) })));
          return;
        }
        send(raw);
      };
    }
  };
  const DemoSource = window.EventSource;
  window.EventSource = class extends DemoSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url, init);
      sources.add(this);
      let receive: EventSource["onmessage"] = null;
      Object.defineProperty(this, "onmessage", {
        get: () => (event: MessageEvent<string>) => {
          const body = JSON.parse(event.data);
          if (body.type === "machines") body.machines = patch(body.machines);
          if (body.type === "machine-message" && body.message.type === "pane-status") {
            body.message.finish_epoch = `sidebar-fixture:${body.machine_id}:1`;
            const forced = state.finishes[body.message.pane_id];
            if (forced) {
              body.message.agent_status = forced.status;
              body.message.finish_id = forced.seq;
            }
          }
          receive?.call(this, new MessageEvent("message", { data: JSON.stringify(body) }));
        },
        set: (handler: EventSource["onmessage"]) => { receive = handler; },
      });
    }
    close(): void { sources.delete(this); super.close(); }
  };
  const publish = async (): Promise<void> => {
    sessionStorage.setItem(key, JSON.stringify(state));
    const { machines } = await (await fetch("/api/machines")).json();
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines }) }));
  };
  window.sidebarFixture = {
    blockedReads: 0,
    reads: {},
    block(paneId, kind) { state.blocked = { paneId, kind }; sessionStorage.setItem(key, JSON.stringify(state)); },
    unblock() { delete state.blocked; sessionStorage.setItem(key, JSON.stringify(state)); for (const resolve of pendingReads.splice(0)) resolve(); },
    async finish(paneId, status, seq) { state.finishes[paneId] = { status, seq }; await publish(); },
    async zoom(paneId, focusedId) { state.zoom = { paneId, focusedId }; await publish(); },
    async split(paneId, focusedId) { state.zoom = { paneId, focusedId, split: true }; await publish(); },
    pad(paneId, turns) { state.padded = { ...state.padded, [paneId]: turns }; sessionStorage.setItem(key, JSON.stringify(state)); },
    frame(message) {
      for (const socket of sockets) if (socket.readyState === 1) socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    },
    conversation(paneId, response) { conversations.set(paneId, { response, etag: `"fixture-${++conversationRevision}"` }); },
    replay(paneId, ready, data, readyAfter = false) { replays.set(paneId, { ready, data, readyAfter }); },
    recoveringReplay(paneId, data) { replays.set(paneId, { ready: false, data, readyAfter: false, recovering: true }); },
    hold(paneId) { replays.set(paneId, { ready: false, data: "", readyAfter: false, held: true }); },
    attaches: {},
    async replaceTerminal(paneId) { state.terminals = { ...state.terminals, [paneId]: `${paneId}:replaced` }; await publish(); },
    async unrestored(paneId) { state.unrestored = paneId; await publish(); },
  };
}

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-activity-demo-"));

const API = "Idempotent payments";
const WEB = "Guard the export button";
const INFRA = "Plan the config file";
const AGENTS_HERDR_ORDER = [API, WEB, "Fix the flaky retry test", INFRA, "Ship the retry flag", "Draft the changelog"];
const AGENTS_LIST_ORDER = [WEB, ...AGENTS_HERDR_ORDER.filter((title) => title !== WEB)];

const agents = (page: Page) => page.locator(".agents-sidebar .agent-item");
const agentTitles = (page: Page) => agents(page).locator(".agent-title").allTextContents();
const agent = (page: Page, title: string) => agents(page).filter({ has: page.locator(".agent-title", { hasText: title }) });
const outputParsed = (page: Page, text: string) => page.waitForFunction((expected) => {
  const host = document.querySelector(".pane-frame.is-current .pane-terminal");
  if (!host || !("outputProbe" in host) || typeof host.outputProbe !== "function") return false;
  const probe = host.outputProbe();
  return probe.written.includes(expected) && probe.inFlight === 0 && probe.queued === 0;
}, text);
const waitStatus = (page: Page, title: string, status: string) => agent(page, title).locator(`.sidebar-status[data-status="${status}"]`).waitFor({ timeout: 10_000 });
const waitAgentAt = (page: Page, index: number, title: string) => page.waitForFunction(([at, name]) =>
  [...document.querySelectorAll(".agents-sidebar .agent-item .agent-title")][at as number]?.textContent === name, [index, title] as const, { timeout: 5_000 });
const drawerAtRest = (page: Page) => page.waitForFunction(() => {
  const drawer = document.querySelector("#workspace-drawer.is-open");
  return drawer !== null && drawer.getBoundingClientRect().left === 0 && drawer.getAnimations().length === 0;
});

async function withPage(browser: Browser, settings: object, run: (page: Page) => Promise<void>, mobile = false): Promise<void> {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: mobile, hasTouch: mobile, locale: "en-US",
  });
  try {
    await context.addInitScript((stored) => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "chat", ...stored }));
      localStorage.setItem("ovis:agents-resting-open", "1");
    }, settings);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${url}?pane=${encodeURIComponent(panes.shell)}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await agents(page).first().waitFor({ state: "attached" });
      await run(page);
      assert.deepEqual(errors, []);
    } catch (error) {
      console.error("BROWSER_FIXTURE", errors, await page.locator("body").innerText());
      const evidence = process.env["UI_EVIDENCE_DIR"];
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, "sidebar-failure.png") });
      }
      throw error;
    }
  } finally {
    await context.close();
  }
}

let url = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(join(app, "sidebar-fixture.js"), `(${installSidebarFixture.toString()})();`);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script src="./sidebar-fixture.js"></script>\n    <script type="module"'));

  const server = serveDemo(app);
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const finishCase = process.env["SIDEBAR_FINISH_CASE"];
      if (!finishCase || finishCase === "previous-answer") {
        for (const source of ["claude-transcript", "codex-transcript", "pi-transcript", "omp-transcript", "omo-transcript", "gjc-transcript", "opencode-transcript", "grok-transcript", "devin-transcript", "hermes-transcript", "agy-transcript"] as const) {
          await withPage(browser, {}, async (page) => {
            await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}`);
            await page.evaluate((id) => window.sidebarFixture.finish(id, "working", 100), panes.omp);
            const first: ConversationResponse = { source, history_id: "finish-proof", turns: [
              { role: "assistant", ts: "2026-10-19T00:00:00Z", parts: [{ kind: "text", text: "First completed answer", phase: "final_answer" }] },
            ] };
            await page.evaluate(({ id, first }) => window.sidebarFixture.conversation(id, first), { id: panes.omp, first });
            await page.evaluate((id) => window.sidebarFixture.frame({ type: "conversation-changed", pane_id: id, signature: "first-finish" }), panes.omp);
            await page.getByText("First completed answer", { exact: true }).waitFor();
            await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
            await waitStatus(page, INFRA, "idle");
            const count = await page.evaluate((id) => window.sidebarFixture.reads[id] ?? 0, panes.omp);
            await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 102), panes.omp);
            await page.waitForFunction(({ id, count }) => (window.sidebarFixture.reads[id] ?? 0) > count, { id: panes.omp, count });
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            assert.equal(await agent(page, INFRA).locator(".sidebar-status").getAttribute("data-status"), "done",
              `${source}: a previous completed answer cannot acknowledge the new finish`);
            const second = structuredClone(first);
            second.turns[0]!.ts = "2026-10-19T00:01:00Z";
            second.turns[0]!.parts = [{ kind: "text", text: "Second completed answer", phase: "final_answer" }];
            second.turns.push({ role: "user", ts: "2026-10-19T00:01:01Z", parts: [{ kind: "notice", text: "Informational notice", source: "informational" }] });
            await page.evaluate(({ id, second }) => {
              window.sidebarFixture.conversation(id, second);
              window.sidebarFixture.frame({ type: "conversation-changed", pane_id: id, signature: "second-finish" });
            }, { id: panes.omp, second });
            await page.getByText("Second completed answer", { exact: true }).waitFor();
            await waitStatus(page, INFRA, "idle");
          });
          console.log(`PASS ${source}: finish identity rejects the previous answer and accepts the new answer past notices`);
        }
      }
      if (!finishCase || finishCase === "resume-replay") {
        await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}&view=terminal`);
          await page.locator(".pane-frame.is-current .terminal-stack[data-pane-content]").waitFor();
          const retained = await page.locator(".pane-frame.is-current .terminal-stack").elementHandle();
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "input-ready", pane_id: id, ready: false }), panes.omp);
          await agent(page, API).locator(".agent-select").click();
          await page.evaluate((id) => {
            window.sidebarFixture.replay(id, true, "quiet recovered replay\r\n", true);
            window.sidebarFixture.block(id, "loading");
            return window.sidebarFixture.finish(id, "done", 103);
          }, panes.omp);
          await agent(page, INFRA).locator(".agent-select").click();
          await openLens(page, "terminal");
          await waitStatus(page, INFRA, "idle");
          await page.locator(".pane-frame.is-current .terminal-stack[data-pane-content]").waitFor();
          assert.equal(await page.locator(".pane-frame.is-current .terminal-stack").evaluate((node, previous) => node === previous, retained), true,
            "the replay recovers the retained renderer rather than mounting a clean replacement");
        });
        console.log("PASS a retained renderer re-arms from readiness then quiet recovered replay");
      }
      if (!finishCase || finishCase === "recovery") {
        for (const observing of [false, true]) await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}&view=terminal`);
          const content = page.locator(".pane-frame.is-current .terminal-stack[data-pane-content]");
          await content.waitFor();
          await page.evaluate(({ id, observing }) => {
            if (observing) window.sidebarFixture.frame({ type: "role-ack", mode: "observe" });
            window.sidebarFixture.frame({ type: "input-ready", pane_id: id, ready: false });
          }, { id: panes.omp, observing });
          await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
          await waitStatus(page, INFRA, "done");
          assert.equal(await content.count(), 0, "attachment loss revokes the old screen's presentation");
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "pty-data", pane_id: id, data: "old attachment tail\r\n" }), panes.omp);
          await outputParsed(page, "old attachment tail\r\n");
          assert.equal(await content.count(), 0, "output before recovery cannot re-arm presentation");
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "input-ready", pane_id: id }), panes.omp);
          assert.equal(await content.count(), 0, "recovery alone must wait for new output");
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "pty-data", pane_id: id, data: "recovered screen\r\n" }), panes.omp);
          await waitStatus(page, INFRA, "idle");
          await content.waitFor();
          await page.evaluate(async (id) => {
            window.sidebarFixture.frame({ type: "pty-data", pane_id: id, data: "queued before loss\r\n" });
            window.sidebarFixture.frame({ type: "input-ready", pane_id: id, ready: false });
            window.sidebarFixture.frame({ type: "input-ready", pane_id: id });
            await window.sidebarFixture.finish(id, "done", 102);
          }, panes.omp);
          await outputParsed(page, "queued before loss\r\n");
          await waitStatus(page, INFRA, "done");
          assert.equal(await content.count(), 0, "a pre-loss parse callback cannot re-arm a recovered attachment");
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "pty-data", pane_id: id, data: "fresh after queued parse\r\n" }), panes.omp);
          await waitStatus(page, INFRA, "idle");
        });
        console.log("PASS attachment recovery needs fresh output for owners and observers");
      }
      if (!finishCase || finishCase === "recovering-joiner") {
        await withPage(browser, {}, async (page) => {
          await page.evaluate((id) => {
            window.sidebarFixture.recoveringReplay(id, "previous answer\r\n");
            window.sidebarFixture.block(id, "loading");
            return window.sidebarFixture.finish(id, "done", 101);
          }, panes.omp);
          await waitStatus(page, INFRA, "done");
          await agent(page, INFRA).locator(".agent-select").click();
          await openLens(page, "terminal");
          const content = page.locator(".pane-frame.is-current .terminal-stack[data-pane-content]");
          await page.locator(".pane-frame.is-current .terminal-stack:not(.is-chat)").waitFor();
          await outputParsed(page, "previous answer\r\n");
          assert.equal(await content.count(), 0, "a recovering joiner's replay is not the current screen");
          await waitStatus(page, INFRA, "done");
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "input-ready", pane_id: id }), panes.omp);
          assert.equal(await content.count(), 0, "the attach taking again still waits for new output");
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "pty-data", pane_id: id, data: "current screen\r\n" }), panes.omp);
          await waitStatus(page, INFRA, "idle");
          await content.waitFor();
        });
        console.log("PASS a page joining a recovering attachment acknowledges only output after recovery");
      }
      if (!finishCase || finishCase === "recovering-restored") {
        await withPage(browser, {}, async (page) => {
          await page.evaluate((id) => {
            window.sidebarFixture.recoveringReplay(id, "previous answer\r\n");
            window.sidebarFixture.block(id, "loading");
          }, panes.omp);
          await agent(page, INFRA).locator(".agent-select").click();
          await openLens(page, "terminal");
          const content = page.locator(".pane-frame.is-current .terminal-stack[data-pane-content]");
          await page.locator(".pane-frame.is-current .terminal-stack:not(.is-chat)").waitFor();
          await outputParsed(page, "previous answer\r\n");
          assert.equal(await content.count(), 0, "the recovering pane's replay is not its current screen");
          await page.evaluate((id) => window.sidebarFixture.unrestored(id), panes.omp);
          await page.locator(".pane-frame.is-current").getByText("held by the fixture").waitFor();
          await page.evaluate(async (id) => {
            window.sidebarFixture.replay(id, true, "restored screen\r\n", true);
            await window.sidebarFixture.unrestored(null);
          }, panes.omp);
          await content.waitFor({ timeout: 10_000 });
        });
        console.log("PASS a pane restored after its attachment recovered shows its screen as current");
      }
      if (!finishCase || finishCase === "recovering-replaced") {
        await withPage(browser, {}, async (page) => {
          await page.evaluate((id) => {
            window.sidebarFixture.hold(id);
            window.sidebarFixture.block(id, "loading");
          }, panes.omp);
          await agent(page, INFRA).locator(".agent-select").click();
          await openLens(page, "terminal");
          const content = page.locator(".pane-frame.is-current .terminal-stack[data-pane-content]");
          await page.locator(".pane-frame.is-current .terminal-stack:not(.is-chat)").waitFor();
          await page.waitForFunction((id) => (window.sidebarFixture.attaches[id] ?? 0) > 0, panes.omp);
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "output-recovering", pane_id: id }), panes.omp);
          const attaches = await page.evaluate((id) => window.sidebarFixture.attaches[id] ?? 0, panes.omp);
          await page.evaluate((id) => window.sidebarFixture.replaceTerminal(id), panes.omp);
          await page.waitForFunction(([id, before]) => (window.sidebarFixture.attaches[id as string] ?? 0) > (before as number), [panes.omp, attaches] as const);
          await page.evaluate((id) => window.sidebarFixture.frame({ type: "pty-data", pane_id: id, data: "previous answer\r\n", replay: true }), panes.omp);
          await outputParsed(page, "previous answer\r\n");
          assert.equal(await content.count(), 0, "the recovering join's late replay is still the screen from before");
          await page.evaluate((id) => {
            window.sidebarFixture.frame({ type: "pty-data", pane_id: id, data: "current screen\r\n", replay: true });
            window.sidebarFixture.frame({ type: "input-ready", pane_id: id });
          }, panes.omp);
          await content.waitFor({ timeout: 10_000 });
        });
        console.log("PASS a replaced terminal of a recovering pane shows the replay of an attachment that recovered");
      }
      if (!finishCase || finishCase === "transcript-finish") {
        for (const source of ["claude-transcript", "codex-transcript"] as const) await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}`);
          const pending: ConversationResponse = { source, history_id: "pending-fixture", turns: [
            { role: "user", ts: "2026-10-19T01:00:00Z", parts: [{ kind: "text", text: "Current request" }] },
            { role: "assistant", ts: "2026-10-19T01:00:01Z", parts: [{ kind: "text", text: "Still working", phase: "commentary" }] },
          ] };
          await page.evaluate(({ id, pending }) => window.sidebarFixture.conversation(id, pending), { id: panes.omp, pending });
          await page.evaluate((id) => window.sidebarFixture.finish(id, "working", 100), panes.omp);
          await page.getByText("Still working", { exact: true }).waitFor({ state: "attached" });
          const before = await page.evaluate((id) => window.sidebarFixture.reads[id] ?? 0, panes.omp);
          await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
          await page.waitForFunction(({ id, before }) => (window.sidebarFixture.reads[id] ?? 0) > before, { id: panes.omp, before });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          assert.equal(await agent(page, INFRA).locator(".sidebar-status").getAttribute("data-status"), "done",
            "a read after DONE without the final answer is still unread");
          const finished = structuredClone(pending);
          finished.turns[1]!.parts.push({ kind: "text", text: "Final answer arrived", phase: "final_answer" });
          await page.evaluate(({ id, finished }) => {
            window.sidebarFixture.conversation(id, finished);
            window.sidebarFixture.frame({ type: "conversation-changed", pane_id: id, signature: "final-answer" });
          }, { id: panes.omp, finished });
          await page.getByText("Final answer arrived", { exact: true }).waitFor();
          await waitStatus(page, INFRA, "idle");
        });
        console.log("PASS hook-driven DONE waits for transcript final-answer evidence");
      }
      if (!finishCase || finishCase === "pending-older" || finishCase === "near-end") {
        for (const kind of ["pending-older", "near-end"] as const) {
          if (finishCase && finishCase !== kind) continue;
          await withPage(browser, {}, async (page) => {
            await page.emulateMedia({ reducedMotion: "reduce" });
            await page.evaluate((id) => window.sidebarFixture.pad(id, 30), panes.omp);
            await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}`);
            await page.evaluate((id) => window.sidebarFixture.finish(id, "working", 100), panes.omp);
            const log = page.getByRole("log");
            await page.evaluate(() => document.fonts.ready);
            await page.waitForFunction((id) => [...document.querySelectorAll("[data-pane-content]")].some((node) => {
              const key = JSON.parse(node.getAttribute("data-pane-content") ?? "null");
              return key?.[1] === id && key[5] === 100;
            }), panes.omp);
            await page.waitForFunction(() => {
              const node = document.querySelector('[role="log"]');
              return node && node.scrollHeight > node.clientHeight + 200 && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
            });
            if (kind === "pending-older") {
              await log.evaluate((node) => { node.scrollTo = () => {}; });
              await page.locator(".chat-minimap-tick").first().click();
              await log.evaluate((node: HTMLElement) => {
                node.firstElementChild?.setAttribute("style", `${node.firstElementChild.getAttribute("style") ?? ""};opacity:.99`);
                node.style.height = `${node.clientHeight - 1}px`;
                node.style.bottom = "auto";
              });
              await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
              assert.equal(await page.locator(".chat-new-messages").count(), 1, "a mutation at the old endpoint must respect the pending older jump");
              await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
              await waitStatus(page, INFRA, "done");
              assert.equal(await page.locator(".chat-frame[data-pane-content]").count(), 0);
              await log.evaluate((node) => { Reflect.deleteProperty(node, "scrollTo"); });
            } else {
              await log.hover();
              await page.mouse.wheel(0, -20);
              await page.locator(".chat-new-messages").waitFor();
              const gap = await log.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
              assert.ok(gap > 1, `the fixture remains away by ${gap}px`);
            }
          });
          console.log(`PASS ${kind}: end geometry and navigation intent stay distinct`);
        }
      }
      for (const kind of ["crash", "loading", "failed", "refresh", "held", "unattached"] as const) {
        if (finishCase && finishCase !== kind) continue;
        await withPage(browser, {}, async (page) => {
          const terminal = kind === "held" || kind === "unattached";
          await page.evaluate(({ id, kind }) => {
            if (kind !== "crash" && kind !== "refresh") window.sidebarFixture.block(id, kind);
          }, { id: panes.omp, kind });
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}&view=${terminal ? "terminal" : "chat"}${kind === "crash" ? "&crash=pane" : ""}`);
          if (kind !== "crash") await page.locator(".conn-live").waitFor({ state: "attached" });
          if (kind === "crash") await page.getByRole("alert").filter({ hasText: "This pane can't be shown." }).waitFor();
          if (kind === "loading") await page.waitForFunction(() => window.sidebarFixture.blockedReads > 0);
          if (kind === "failed") await page.locator(".chat-failure").waitFor();
          if (kind === "held") await page.getByText("Another app has this pane open.", { exact: false }).first().waitFor();
          if (kind === "refresh") {
            await page.locator(".chat-turn").first().waitFor();
            await page.evaluate((id) => window.sidebarFixture.block(id, "loading"), panes.omp);
          }
          await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
          await waitStatus(page, INFRA, "done");
          assert.equal(await page.evaluate((id) => Object.keys(localStorage).some((key) =>
            key.startsWith("ovis:finish:") && key.endsWith(`:${encodeURIComponent(id)}`)), panes.omp), false,
          `${kind}: content not presented must leave no seen record`);
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `finish-${kind}.png`) }); }
          if (kind === "loading" || kind === "failed" || kind === "refresh") {
            await page.evaluate(() => window.sidebarFixture.unblock());
            if (kind === "failed") await page.locator(".chat-failure-retry").click();
            await waitStatus(page, INFRA, "idle");
          }
        });
        console.log(`PASS ${kind}: only successfully presented content acknowledges the finish`);
      }
      for (const kind of ["composer", "composer-files-failed"] as const) {
        if (finishCase && finishCase !== kind) continue;
        await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const input = page.getByRole("textbox", { name: "Message", exact: true });
          if (kind === "composer-files-failed") await page.evaluate((id) => window.sidebarFixture.block(id, "files"), panes.omp);
          await input.fill(kind === "composer" ? "/" : "@missing");
          await page.locator(".menu.composer-menu").waitFor();
          await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
          // The answer has actually arrived for this finish. Otherwise readiness alone could
          // keep the dot briefly and let this test pass without the popup coverage gate.
          await page.waitForFunction((id) => [...document.querySelectorAll("[data-pane-content]")].some((node) => {
            const key = JSON.parse(node.getAttribute("data-pane-content") ?? "null");
            return key?.[1] === id && key[5] === 101;
          }), panes.omp);
          await agent(page, INFRA).locator('.sidebar-status[data-status="done"]').waitFor({ state: "attached" });
          assert.equal(await page.evaluate((id) => Object.keys(localStorage).some((key) =>
            key.startsWith("ovis:finish:") && key.endsWith(`:${encodeURIComponent(id)}`)), panes.omp), false);
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `finish-${kind}-phone.png`) }); }
          await input.fill("");
          await page.locator(".menu.composer-menu").waitFor({ state: "detached" });
          await agent(page, INFRA).locator('.sidebar-status[data-status="idle"]').waitFor({ state: "attached" });
        }, true);
        console.log(`PASS ${kind}: a phone suggestion popup keeps its underlying finish unread`);
      }
      if (!finishCase || finishCase === "drawer") {
        await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}&sidebar=shown`);
          await drawerAtRest(page);
          await page.locator(".agents-sidebar .agent-section-toggle").tap();
          await page.evaluate((id) => window.sidebarFixture.finish(id, "working", 100), panes.omp);
          await waitStatus(page, INFRA, "working");
          await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
          await waitStatus(page, INFRA, "done");
          assert.equal(await page.locator(`.workspace-select[data-pane="${panes.omp}"] .sidebar-status`).getAttribute("data-status"), "done",
            "a finish behind the phone drawer stays unread in the workspace roll-up");
          assert.equal(await page.locator(".sidebar.is-open").count(), 1);
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: join(evidence, "finish-drawer-phone.png") });
          }
          const scrim = page.locator(".scrim.is-open");
          const outside = await scrim.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return { x: rect.right - 8, y: rect.top + rect.height / 2 };
          });
          await page.waitForFunction(({ x, y }) => document.elementFromPoint(x, y)?.matches(".scrim.is-open"), outside);
          await page.touchscreen.tap(outside.x, outside.y);
          await page.locator("#workspace-drawer.is-open").waitFor({ state: "detached" });
          await agent(page, INFRA).locator('.sidebar-status[data-status="idle"]').waitFor({ state: "attached" });
        }, true);
        console.log("PASS a phone drawer covering the selected pane preserves both DONE dots until uncovered");
      }
      if (!finishCase || finishCase === "hidden-composer") {
        await withPage(browser, {}, async (page) => {
          await page.evaluate(({ a, b }) => window.sidebarFixture.split(b, a), { a: panes.omp, b: panes.api });
          // This case owns the sibling's finish. The demo's timed finish can claim it first.
          await page.addInitScript(() => Reflect.set(window, "__ovisDemoHoldTurn", true));
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}`);
          await page.getByRole("textbox", { name: "Message", exact: true }).fill("/");
          await page.locator(".menu.composer-menu").waitFor();
          // Selecting through its real sidebar handler avoids navigating/reloading, which would silently discard the popup.
          await agent(page, API).locator(".agent-select").evaluate((button: HTMLElement) => button.click());
          const hidden = page.locator(`[data-layout-pane="${panes.omp}"].is-hidden`);
          await hidden.waitFor({ state: "attached" });
          assert.equal(await hidden.locator(".menu.composer-menu").count(), 1);
          await page.locator(`[data-layout-pane="${panes.api}"]:not(.is-hidden)`).waitFor();
          const answer: ConversationResponse = { source: "claude-transcript", history_id: "visible-sibling", turns: [
            { role: "assistant", ts: "2026-10-19T00:00:00Z", parts: [{ kind: "text", text: "The visible sibling finished.", phase: "final_answer" }] },
          ] };
          await page.evaluate(({ id, answer }) => {
            window.sidebarFixture.conversation(id, answer);
            return window.sidebarFixture.finish(id, "done", 2);
          }, { id: panes.api, answer });
          await page.waitForFunction((id) => [...document.querySelectorAll("[data-pane-content]")].some((node) => {
            const key = JSON.parse(node.getAttribute("data-pane-content") ?? "null");
            return key?.[1] === id && key[5] === 2;
          }), panes.api);
          await agent(page, API).locator('.sidebar-status[data-status="idle"]').waitFor({ state: "attached", timeout: 10_000 });
          assert.equal(await hidden.locator(".menu.composer-menu").count(), 1, "the retained invisible popup cannot block its visible sibling");
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            for (const theme of ["dark", "light"]) {
              await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
              await page.screenshot({ path: join(evidence, `finish-hidden-sibling-phone-${theme}.png`) });
            }
          }
        }, true);
        console.log("PASS a hidden phone split sibling's retained suggestions do not cover the visible finish");
      }
      if (!finishCase || finishCase === "zoom") {
        await withPage(browser, {}, async (page) => {
          await page.evaluate(async ({ hidden, focused }) => {
            await window.sidebarFixture.finish(hidden, "done", 100);
            await window.sidebarFixture.zoom(hidden, focused);
          }, { hidden: panes.omp, focused: panes.api });
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}`);
          await page.locator(`[data-layout-pane="${panes.api}"]:not(.is-hidden)`).waitFor();
          await page.waitForFunction((id) => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "{}").pane_id === id, panes.api);
          assert.equal(await page.locator(`[data-layout-pane="${panes.omp}"].is-hidden`).count(), 1);
          await waitStatus(page, INFRA, "done");
          const recorded = await page.evaluate((id) => Object.keys(localStorage).some((key) =>
            key.startsWith("ovis:finish:local:") && key.endsWith(`:${encodeURIComponent(id)}`)), panes.omp);
          assert.equal(recorded, false, "a redirected deep link never acknowledges the hidden pane");
        });
        console.log("PASS a deep link into a zoomed tab acknowledges only the presented pane");
      }
      if (!finishCase || finishCase === "reload") {
        await withPage(browser, {}, async (page) => {
          await page.evaluate(async ({ opened, unread }) => {
            await window.sidebarFixture.finish(opened, "done", 100);
            await window.sidebarFixture.finish(unread, "done", 100);
          }, { opened: panes.omp, unread: panes.api });
          await waitStatus(page, INFRA, "done");
          await agent(page, INFRA).locator(".agent-select").click();
          await waitStatus(page, INFRA, "idle");
          await page.locator(`.workspace-select[data-pane="${panes.hermes}"]`).click();
          await page.waitForFunction((id) => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "{}").pane_id === id, panes.hermes);
          await waitStatus(page, INFRA, "idle");
          await waitStatus(page, API, "done");
          await page.reload();
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const raw = await page.evaluate(async (ids) => {
            const { machines } = await (await fetch("/api/machines")).json() as { machines: Machine[] };
            return machines[0]?.snapshot?.agents.filter((agent) => ids.includes(agent.pane_id))
              .map((agent) => [agent.pane_id, agent.agent_status, agent.state_change_seq]);
          }, [panes.omp, panes.api]);
          assert.deepEqual(raw?.sort(), [[panes.omp, "done", 100], [panes.api, "done", 100]].sort(),
            "reload preserves the same raw DONE and counter for both the opened pane and unread control");
          await waitStatus(page, INFRA, "idle");
          await waitStatus(page, API, "done");
          assert.equal(await agent(page, INFRA).locator(".agent-select").getAttribute("aria-current"), null,
            "reload does not reopen the finish to acknowledge it again");
          await page.evaluate(() => {
            for (const key of Object.keys(localStorage)) if (key.startsWith("ovis:finish:")) localStorage.removeItem(key);
          });
          await page.reload();
          await waitStatus(page, INFRA, "done");
          await waitStatus(page, API, "done");
        });
        console.log("PASS switching and reload preserve a read raw DONE; losing storage restores its dot");
      }
      if (!finishCase || finishCase === "overlay") {
        await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          await page.evaluate((id) => window.sidebarFixture.finish(id, "working", 100), panes.omp);
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}&file=${encodeURIComponent("/tmp/finish.txt")}`);
          await page.locator(".file-viewer").waitFor();
          await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
          await agent(page, INFRA).locator('.sidebar-status[data-status="done"]').waitFor({ state: "attached" });
          const key = `ovis:finish:local:${encodeURIComponent("sidebar-fixture:local:1")}:${encodeURIComponent(panes.omp)}`;
          assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null,
            "a phone file viewer does not acknowledge the finish underneath");
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: join(evidence, "finish-file-viewer-phone.png") });
          }
          await page.locator(".file-viewer").getByRole("button", { name: "Close file", exact: true }).click();
          await page.locator(".file-viewer").waitFor({ state: "detached" });
          await agent(page, INFRA).locator('.sidebar-status[data-status="idle"]').waitFor({ state: "attached" });
        }, true);
        console.log("PASS a phone file viewer preserves an underlying finish until the pane is uncovered");
      }
      if (!finishCase || finishCase === "scrolled") {
        for (const arrival of ["jump", "resize", "restore"] as const) {
        if (process.env["SIDEBAR_SCROLL_ARRIVAL"] && process.env["SIDEBAR_SCROLL_ARRIVAL"] !== arrival) continue;
        await withPage(browser, {}, async (page) => {
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.evaluate((id) => window.sidebarFixture.pad(id, 30), panes.omp);
          await page.goto(`${url}?pane=${encodeURIComponent(panes.omp)}`);
          await page.locator(".chat-turn").first().waitFor();
          const statusIs = (status: string) => agent(page, INFRA).locator(`.sidebar-status[data-status="${status}"]`).waitFor({ state: "attached", timeout: 10_000 });
          await page.evaluate((id) => window.sidebarFixture.finish(id, "working", 100), panes.omp);
          await statusIs("working");
          const log = page.getByRole("log");
          const room = await log.evaluate((node) => [node.scrollHeight, node.clientHeight, node.className, document.querySelectorAll(".chat-turn").length]);
          assert.ok((room[0] as number) - (room[1] as number) > 200, `the fixture chat must be long enough to scroll away: ${JSON.stringify(room)}`);
          await log.evaluate((node) => { node.scrollTop = 0; });
          await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
          if (arrival === "restore") {
            const height = await log.evaluate((node) => node.scrollHeight * 3 + 2000);
            await openLens(page, "terminal");
            await page.setViewportSize({ width: 390, height });
            await page.evaluate(() => document.addEventListener("scroll", (event) => {
              if (event.target instanceof Element && event.target.matches('[role="log"]')) event.stopImmediatePropagation();
            }, true));
            await openLens(page, "chat");
            await page.locator(".chat-turn").first().waitFor();
            await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
            await statusIs("idle");
            assert.equal(await log.evaluate((node) => node.scrollTop), 0);
            assert.ok(await log.evaluate((node) => node.scrollHeight <= node.clientHeight));
            assert.equal(await page.getByRole("button", { name: "Jump to latest", exact: true }).count(), 0,
              "restoring a saved non-end position does not leave a fully visible chat away");
            return;
          }
          const before = await page.evaluate((id) => window.sidebarFixture.reads[id] ?? 0, panes.omp);
          await page.evaluate((id) => window.sidebarFixture.finish(id, "done", 101), panes.omp);
          await statusIs("done");
          await page.waitForFunction(([id, count]) => (window.sidebarFixture.reads[id as string] ?? 0) > (count as number), [panes.omp, before] as const);
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          const key = `ovis:finish:local:${encodeURIComponent("sidebar-fixture:local:1")}:${encodeURIComponent(panes.omp)}`;
          assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null,
            "a finish whose end is scrolled out of view is not recorded as seen");
          assert.equal(await agent(page, INFRA).locator(".sidebar-status").getAttribute("data-status"), "done");
          if (arrival === "resize") {
            const height = await log.evaluate((node) => {
              // Browsers/list anchoring can emit a zero-offset scroll during resize.
              // Suppress delivery before React so this case must work without that signal.
              document.addEventListener("scroll", (event) => {
                if (event.target === node) event.stopImmediatePropagation();
              }, true);
              node.addEventListener("scroll", () => { node.dataset.unexpectedScroll = "true"; });
              // Virtual rows not drawn yet still have estimates; leave enough room for
              // their actual wrapped heights when the enlarged viewport renders them all.
              return node.scrollHeight * 3 + 2000;
            });
            await page.setViewportSize({ width: 390, height });
            await statusIs("idle");
            assert.equal(await log.evaluate((node) => node.scrollTop), 0);
            assert.equal(await log.getAttribute("data-unexpected-scroll"), null, "geometry alone proves the fully visible chat");
            return;
          }
          await log.evaluate((node) => {
            node.scrollTo({ top: 0, behavior: "instant" });
            node.dispatchEvent(new Event("scroll"));
            // Clipping holds the real viewport even if browser-native focus/scroll anchoring
            // bypasses JS scroll methods. Heights and rendered row geometry remain real.
            node.dataset.scrollOverflow = node.style.overflow;
            node.style.overflow = "clip";
            node.scrollTo = () => { node.dataset.deferredScroll = "true"; };
          });
          await page.getByRole("button", { name: "New messages", exact: true }).click();
          await page.waitForFunction(() => document.querySelector('[role="log"]')?.getAttribute("data-deferred-scroll") === "true");
          const pendingPosition = await log.evaluate((node) => ({
            height: node.clientHeight, content: node.scrollHeight, top: node.scrollTop,
            overflow: getComputedStyle(node).overflow,
          }));
          assert.ok(pendingPosition.content - pendingPosition.height - pendingPosition.top > 200,
            `the pending jump must still be away: ${JSON.stringify(pendingPosition)}`);
          assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null,
            "a pending jump cannot acknowledge an answer still outside the viewport");
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: join(evidence, "finish-deferred-jump-desktop.png") });
          }
          await page.locator(".chat-minimap-tick").first().click();
          await log.evaluate((node) => {
            Reflect.deleteProperty(node, "scrollTo");
            node.style.overflow = node.dataset.scrollOverflow ?? "";
            delete node.dataset.scrollOverflow;
          });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          assert.equal(await page.evaluate((key) => localStorage.getItem(key), key), null,
            "a superseded jump leaves the finish unread");
          await page.getByRole("button", { name: "New messages", exact: true }).click();
          await statusIs("idle");
          assert.ok(await log.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop <= 1),
            "READY requires the real endpoint, not just following intent");
          if (evidence) await page.screenshot({ path: join(evidence, "finish-presented-end-desktop.png") });
        }, arrival !== "jump");
        console.log(`PASS ${arrival}: finish acknowledgement follows actual end geometry`);
        }
        console.log("PASS a chat read away from its end keeps the finish unread until the end is in view");
      }
      if (!finishCase) {
      await withPage(browser, {}, async (page) => {
        assert.deepEqual(await agentTitles(page), AGENTS_LIST_ORDER);
        assert.match(await agent(page, API).locator(".agent-context").textContent() ?? "", /checkout-api/, "a row names its workspace");
        assert.equal(await agent(page, API).getByRole("button").count(), 1, "a desktop row is its selector alone");
        assert.equal(await page.locator(".row-menu-toggle:visible").count(), 0, "no row ⋯ on a desktop");
        assert.equal(await page.locator(".agents-sidebar .agent-list-pinned").count(), 0, "no pinned list without pins");
      });
      console.log("PASS the Agents list is flat, in herdr's order, each row a selector with no ⋯ on a desktop");

      for (const mobile of [false, true]) {
        await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.api)}`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const chip = page.locator(".composer .bg-tasks-toggle");
          await chip.waitFor();
          assert.match(await chip.getAttribute("aria-label") ?? "", /^Plan: 1 of \d+ done/, "the chip names the plan's progress");
          assert.match((await chip.locator(".bg-tasks-plan").textContent())?.trim() ?? "", /^1\/\d+$/);
          assert.equal(await page.locator(".plan-button").count(), 0, "no plan button in the header");
          await chip.click();
          const list = page.getByRole("dialog", { name: /^Plan/ });
          await list.locator(".bg-step").first().waitFor();
          assert.equal(await list.locator(".bg-step.is-in_progress").count(), 1, "the running step is marked");
          assert.equal(await list.locator(".plan-node, .plan-view-switch").count(), 0, "no flow of boxes");
          await page.keyboard.press("Escape");
          await list.waitFor({ state: "detached" });
        }, mobile);
      }
      console.log("PASS a pane's plan opens from the composer's chip, as a list of steps, on a desktop and a phone");

      for (const mobile of [false, true]) {
        await withPage(browser, {}, async (page) => {
          if (mobile) await page.locator('button[aria-controls="workspace-drawer"]').tap();
          const head = page.locator(`.workspace-group[data-workspace="${panes.api.split(":")[0]}"] > .workspace-header .workspace-select`);
          const headId = await head.evaluate((row) => row.closest(".workspace-group")?.getAttribute("data-workspace"));
          assert.ok(headId);
          const worktrees = await page.evaluate(async (workspaceId) => {
            const made: { workspace_id: string; pane_id: string }[] = [];
            for (const branch of ["pin-first", "pin-second"]) {
              const response = await fetch("/api/worktree/create", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ workspace_id: workspaceId, branch }),
              });
              if (!response.ok) throw new Error(`worktree fixture: ${response.status}`);
              made.push(await response.json());
            }
            return made;
          }, headId);
          for (const { pane_id } of worktrees) await page.locator(`.workspace-select[data-pane="${pane_id}"]`).waitFor();
          const titles = () => page.locator(".machine-workspaces .workspace-name").allTextContents();
          const groupedOrder = await titles();
          const headName = await head.locator(".workspace-name").textContent();
          const setPin = async (pin: boolean) => {
            if (mobile) await page.locator(`.workspace-group[data-workspace="${headId}"] > .workspace-header .row-menu-toggle`).tap();
            else await head.click({ button: "right" });
            const label = pin ? "Pin workspace" : "Unpin workspace";
            const panel = page.locator(mobile ? ".row-sheet" : ".row-menu");
            if (mobile) await panel.getByRole("button", { name: label, exact: true }).tap();
            else await panel.getByRole("menuitem", { name: label, exact: true }).click();
            await panel.waitFor({ state: "detached" });
          };
          await setPin(true);
          const card = page.locator(".machine-workspaces .sidebar-pinned");
          await card.waitFor();
          assert.deepEqual(await card.locator(".workspace-name").allTextContents(), [headName], "pinning a repository pins only its own row, not its worktrees");
          assert.equal(await head.getAttribute("aria-keyshortcuts"), "Alt+ArrowUp Alt+ArrowDown", "the pinned repository keeps its within-card reorder shortcuts");
          assert.equal(await head.getAttribute("draggable"), mobile ? "false" : "true", "the pinned repository supports desktop drag while touch uses long-press");
          assert.deepEqual(await titles(), [headName, ...groupedOrder.filter((name) => name !== headName)], "worktrees keep the repository's position and their order");
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await page.screenshot({ path: join(evidence, `pin-repository-${mobile ? "phone" : "desktop"}.png`) });
          }
          for (const { workspace_id, pane_id } of worktrees) {
            const row = page.locator(`.workspace-select[data-pane="${pane_id}"]`);
            assert.equal(await row.evaluate((element) => element.closest(".sidebar-pinned, .worktree-children") === null), true, "an unpinned worktree is a standalone row outside the card");
            assert.equal(await row.getAttribute("draggable"), "false", "an orphaned worktree cannot be dragged");
            assert.equal(await row.getAttribute("aria-keyshortcuts"), null, "an orphaned worktree offers no reorder shortcut");
            await row.focus();
            await page.keyboard.press("Alt+ArrowDown");
            assert.deepEqual(await titles(), [headName, ...groupedOrder.filter((name) => name !== headName)], "Alt+Down does not move an orphaned worktree");
            assert.equal(await page.locator(`.workspace-group[data-workspace="${workspace_id}"]`).count(), 1, "each worktree appears once");
          }
          await setPin(false);
          await card.waitFor({ state: "detached" });
          assert.deepEqual(await titles(), groupedOrder, "unpinning restores the repository group and order");
          for (const { pane_id } of worktrees) {
            assert.equal(await page.locator(`.worktree-children .workspace-select[data-pane="${pane_id}"]`).count(), 1, "unpinning nests the worktree under its repository again");
          }
        }, mobile);
      }
      console.log("PASS a repository pin keeps only its row in the card; its worktrees stay outside, fixed and ordered, and regroup on unpin, on desktop and phone");

      await withPage(browser, {}, async (page) => {
        const selected = await page.evaluate(() => sessionStorage.getItem("ovis:selection"));
        await page.locator(".header-more-button").focus();
        const workspace = page.locator(`.workspace-group[data-workspace="${panes.api.split(":")[0]}"] > .workspace-header .workspace-select`);
        const bounds = (await workspace.boundingBox())!;
        await workspace.click({ button: "right", position: { x: 32, y: bounds.height / 2 } });
        const menu = page.getByRole("menu", { name: "checkout-api", exact: true });
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "New tab with agent…", "Rename workspace", "Earlier sessions…", "Close group", "New worktree", "Open worktree…", "Collapse"], "right-click on a repository uses its group scope");
        const opened = (await menu.boundingBox())!;
        assert.ok(Math.abs(opened.x - bounds.x - 32) <= 1 && Math.abs(opened.y - bounds.y - bounds.height / 2) <= 1, "the menu opens at the pointer");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("ovis:selection")), selected, "right-click leaves the selected pane alone");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".header-more-button").evaluate((button) => document.activeElement === button), true, "dismissal returns the prior keyboard focus");
        await workspace.focus();
        await contextMenuKey(page);
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "New tab with agent…", "Rename workspace", "Earlier sessions…", "Close group", "New worktree", "Open worktree…", "Collapse"], "the context-menu key and right-click have identical items");
        await page.keyboard.press("Escape");
        const pins = () => page.evaluate(() => JSON.parse(localStorage.getItem("ovis:sidebar-agent-pins") ?? "[]") as string[]);
        const workspaceTitles = () => page.locator(".machine-workspaces .workspace-name").allTextContents();
        const herdrOrder = await workspaceTitles();
        const infraWorkspace = page.locator(`.workspace-select[data-pane="${panes.omp}"]`);
        await infraWorkspace.click({ button: "right" });
        const infraMenu = page.getByRole("menu");
        await infraMenu.getByRole("menuitem", { name: "Pin workspace", exact: true }).click();
        const pinnedWorkspaces = page.getByRole("list", { name: "Pinned", exact: true }).filter({ has: page.locator(".workspace-group") });
        await pinnedWorkspaces.waitFor();
        const infraName = await infraWorkspace.locator(".workspace-name").textContent();
        assert.deepEqual(await pinnedWorkspaces.locator(".workspace-name").allTextContents(), [infraName], "the pinned workspace stands in the card");
        assert.deepEqual(await workspaceTitles(), [infraName, ...herdrOrder.filter((title) => title !== infraName)], "the rest keep herdr's order");
        assert.equal(await infraWorkspace.getAttribute("draggable"), "true", "a pinned workspace can be dragged within its card");
        assert.ok((await pins()).includes(`local:workspace:${await infraWorkspace.evaluate((row) => row.closest(".workspace-group")?.getAttribute("data-workspace"))}`), "the pin is saved with the agents'");
        await infraWorkspace.click({ button: "right" });
        await infraMenu.getByRole("menuitem", { name: "Unpin workspace", exact: true }).click();
        await pinnedWorkspaces.waitFor({ state: "detached" });
        assert.deepEqual(await workspaceTitles(), herdrOrder, "unpinned, it returns to herdr's order");
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        const infraSelect = agent(page, INFRA).locator(".agent-select");
        await page.locator(".header-more-button").focus();
        await infraSelect.click({ button: "right" });
        const agentMenu = page.getByRole("menu", { name: INFRA, exact: true });
        await agentMenu.waitFor();
        assert.deepEqual(await agentMenu.getByRole("menuitem").allTextContents(), ["Pin agent"], "an agent's right-click menu offers its pin");
        await agentMenu.getByRole("menuitem", { name: "Pin agent" }).click();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("ovis:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.omp}`);
        assert.deepEqual(await agentTitles(page), [INFRA, ...AGENTS_LIST_ORDER.filter((title) => title !== INFRA)], "a pinned agent moves to the top, the rest keep the list's order");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("ovis:selection")), selected, "pinning does not select the agent");
        assert.equal(await page.locator(".header-more-button").evaluate((button) => document.activeElement === button), true, "the menu hands focus back where it was");
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await agents(page).first().waitFor({ state: "attached" });
        assert.equal((await agentTitles(page))[0], INFRA, "the pin survives a reload");
        await infraSelect.focus();
        await contextMenuKey(page);
        await agentMenu.waitFor();
        assert.deepEqual(await agentMenu.getByRole("menuitem").allTextContents(), ["Unpin agent"], "a pinned agent's menu offers Unpin");
        await page.waitForFunction(() => document.activeElement?.textContent === "Unpin agent", undefined, { timeout: 5_000 });
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:sidebar-agent-pins") ?? "[]").length === 0);
        assert.deepEqual(await pins(), []);
        assert.deepEqual(await agentTitles(page), AGENTS_LIST_ORDER, "unpin restores the source order");
        assert.equal(await infraSelect.evaluate((button) => document.activeElement === button), true, "focus returns to the row as it moves back");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "the menu closes after its item runs");
        await agentSelect.click({ button: "right" });
        const apiMenu = page.getByRole("menu", { name: API, exact: true });
        await apiMenu.waitFor();
        await apiMenu.getByRole("menuitem", { name: "Pin agent" }).click();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("ovis:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.api}`);
        assert.equal(await page.getByRole("list", { name: "Pinned", exact: true }).count(), 1, "the pinned list is named Pinned");
        assert.deepEqual(await page.locator(".agents-sidebar .agent-list-pinned .agent-title").allTextContents(), [API], "the pinned list holds the pinned agent");
        await agentSelect.click({ button: "right" });
        await apiMenu.getByRole("menuitem", { name: "Unpin agent" }).click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("ovis:sidebar-agent-pins") ?? "[]").length === 0);
        assert.equal(await page.locator(".agents-sidebar .agent-list-pinned").count(), 0, "the pinned list goes with the last pin");
        assert.deepEqual(await agentTitles(page), AGENTS_LIST_ORDER);
        console.log("PASS workspace right-click scope, pointer anchor and focus; the context-menu key opens the same menu; a workspace pins into a card and returns to herdr's order; an agent pins and unpins from its right-click menu and the key");
        await waitStatus(page, API, "done");
        assert.ok(await agent(page, API).locator('.sidebar-status[data-status="done"] .sidebar-status-dot').isVisible(), "an unread finish keeps its dot");
        assert.deepEqual(await agentTitles(page), AGENTS_LIST_ORDER, "a finish does not move an agent");
        await agentSelect.click();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "ordinary click still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "selecting the agent does not open a menu");
        await waitStatus(page, API, "idle");
        const rollUp = () => page.locator(`.workspace-select[data-pane="${panes.api}"] .sidebar-status`).getAttribute("data-status");
        assert.notEqual(await rollUp(), "done", "the workspace row's roll-up drops the opened finish too");
        assert.deepEqual(await agentTitles(page), AGENTS_LIST_ORDER, "reading a finish does not move an agent");
      });
      console.log("PASS the Agents list keeps herdr's order through a finish, and an opened DONE reads as ready");

      await withPage(browser, {}, async (page) => {
        const drawerToggle = page.locator("#drawer-toggle");
        await drawerToggle.tap();
        await drawerAtRest(page);
        const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
        assert.equal(await agentToggle.getAttribute("aria-expanded"), "false", "the phone's Agents section still starts folded");
        await agentToggle.tap();
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        await agentSelect.waitFor();
        const more = agentRow.getByRole("button", { name: `More for ${API}`, exact: true });
        assert.ok(await more.isVisible(), "the ⋯ is visible on touch");
        await more.tap();
        const sheet = page.getByRole("dialog", { name: API, exact: true });
        await page.waitForFunction(() => {
          const sheet = document.querySelector(".row-sheet");
          return sheet !== null && sheet.getAnimations().length === 0;
        });
        await sheet.getByRole("button", { name: "Pin agent" }).tap();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("ovis:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.api}`);
        await sheet.waitFor({ state: "detached" });
        const pinnedSelect = agentSelect.and(page.locator(".agent-list-pinned .agent-select"));
        await pinnedSelect.waitFor();
        assert.deepEqual(await page.locator(".agents-sidebar .agent-list-pinned .agent-title").allTextContents(), [API], "the pinned row stands in the pinned list");
        await pinnedSelect.tap();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "a tap still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "a tap opens no agent action sheet");
        assert.equal(await drawerToggle.getAttribute("aria-expanded"), "false", "selecting an agent closes the phone drawer");
      }, true);
      console.log("PASS on a phone the ⋯ pins an agent from its sheet; a tap on the row selects it and opens no menu");

      await withPage(browser, { agentOrder: "activity" }, async (page) => {
        assert.equal((await agentTitles(page))[0], WEB, "the blocked agent is pinned on top");
        assert.match(await agent(page, WEB).locator(".agent-context").textContent() ?? "", /export-guard/, "a row names its workspace");

        await waitStatus(page, API, "done");
        await waitAgentAt(page, 1, API);

        await agent(page, INFRA).locator(".agent-select").click();
        // Rows keep their order while the pointer is over Agents; leave it before checking activity order.
        await page.locator(".composer-text").click();
        await page.locator(".composer-text").fill("Check the plan again");
        await page.locator(".composer-text").press("Enter");
        await waitStatus(page, INFRA, "working");
        await waitAgentAt(page, 1, INFRA);
        await page.locator(".machine-workspaces .workspace-select", { hasText: "flaky-retry-test" }).first().click();
        await waitStatus(page, INFRA, "done");
        assert.equal((await agentTitles(page))[1], INFRA, "the agent just worked in stays on top after it finishes");

        await agent(page, INFRA).locator(".agent-select").click();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "{}").pane_id === paneId, panes.omp, { timeout: 5_000 });
        await waitStatus(page, INFRA, "idle");
        assert.equal((await agentTitles(page))[1], INFRA, "reading a finish does not move it");
        await page.locator(".machine-workspaces .workspace-select", { hasText: "flaky-retry-test" }).first().click();
        await waitStatus(page, INFRA, "idle");
        await agent(page, INFRA).locator(".agent-select").click();
        await page.locator(".composer-text").fill("One more check");
        await page.locator(".composer-text").press("Enter");
        await waitStatus(page, INFRA, "working");
        await page.locator(".machine-workspaces .workspace-select", { hasText: "flaky-retry-test" }).first().click();
        await waitStatus(page, INFRA, "done");
      });
      console.log("PASS Activity pins blocked and follows recency; an opened DONE reads as ready after switching until the next finish");

      await withPage(browser, { agentOrder: "activity" }, async (page) => {
        const made = await page.evaluate(async () => {
          const post = (path: string, body: object) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const session = async () => (await (await fetch("/api/session")).json()).snapshot as { workspaces: { workspace_id: string }[]; agents: { pane_id: string; state_change_seq?: number }[] };
          for (const { workspace_id } of (await session()).workspaces) await post("/api/workspace/close", { workspace_id, close_group: true });
          const created = await (await post("/api/workspace/create", { cwd: "/home/demo/fresh", agent: { kind: "claude" } })).json() as { pane_id: string };
          return { created: created.pane_id, agents: (await session()).agents };
        });
        const entry = made.agents.find((candidate) => candidate.pane_id === made.created);
        assert.ok(entry && Number.isSafeInteger(entry.state_change_seq), `the new agent carries a counter: ${JSON.stringify(made)}`);
        await agent(page, "fresh").waitFor();
      });
      console.log("PASS a workspace made after the demo's last agent closed is listed with herdr's counter");
      }
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
