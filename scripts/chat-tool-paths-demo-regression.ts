import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-chat-tool-paths-demo-"));
const bare = mkdtempSync(join(tmpdir(), "herdr-chat-tool-paths-bare-"));
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
if (evidence !== null) mkdirSync(evidence, { recursive: true });

// playwright-core's bundle lazily requires packages the lockfile does not carry (chromium-bidi):
// fine at run time, unresolvable to `bun build` — so it is imported past the bundler's analysis
const playwrightCore = "playwright-core";
const { chromium } = (await import(playwrightCore)) as typeof import("playwright-core");

const ROOT = "/work/app";
const LONG = `${ROOT}/${"n".repeat(300)}.ts`;
const LABELS: Record<string, string> = {
  "/work/app/src/a.ts": "app/src/a.ts",
  "/work/app/src/b.ts": "app/src/b.ts",
  "/work/app-2/a.ts": "/work/app-2/a.ts",
  "/work/app/src/c.ts": "app/src/c.ts",
  "/work/app/docs/notes.md": "app/docs/notes.md",
  "/etc/hosts": "/etc/hosts",
  "src/relative.ts": "src/relative.ts",
  "C:\\work\\app\\win.ts": "C:\\work\\app\\win.ts",
  "\\\\server\\share\\app\\unc.ts": "\\\\server\\share\\app\\unc.ts",
  "//server/share/app/fwd.ts": "//server/share/app/fwd.ts",
  "/work/app/../etc/passwd": "/work/app/../etc/passwd",
  "/work/app/문서/설계 노트.md": "app/문서/설계 노트.md",
  [LONG]: `app/${"n".repeat(300)}.ts`,
};
const REPLY = "Tidied /work/app/src/a.ts and left /work/app-2/a.ts alone.";
const tool = (name: string, summary: string, input: unknown, output = "ok") =>
  ({ kind: "tool", name, summary, input: typeof input === "string" ? input : JSON.stringify(input), output });
const read = (path: string) => tool("Read", path, { file_path: path });
const TURNS = [
  { role: "user", ts: "2026-10-21T10:00:00.000Z", parts: [{ kind: "text", text: "Tidy the app" }] },
  { role: "assistant", ts: "2026-10-21T10:00:05.000Z", parts: [
    tool("Edit", "/work/app/src/a.ts", { file_path: "/work/app/src/a.ts", old_string: "let a = 1;", new_string: "const a = 1;" }),
    tool("apply_patch", "2 files", "*** Begin Patch\n*** Update File: /work/app/src/b.ts\n@@\n-let b = 1;\n+const b = 1;\n*** Add File: /work/app-2/a.ts\n+export {};\n*** End Patch\n"),
    tool("MultiEdit", "/work/app/src/c.ts", { file_path: "/work/app/src/c.ts", edits: [{ old_string: "var c", new_string: "let c" }, { old_string: "c = 2", new_string: "c = 3" }] }),
    tool("SendUserFile", "2 files", { caption: "The notes", files: ["/work/app/docs/notes.md", "/etc/hosts"] }),
    read("src/relative.ts"),
    read("C:\\work\\app\\win.ts"),
    read("\\\\server\\share\\app\\unc.ts"),
    read("//server/share/app/fwd.ts"),
    read("/work/app/../etc/passwd"),
    read("/work/app/문서/설계 노트.md"),
    read(LONG),
    { kind: "text", text: REPLY },
  ] },
];
const ORDER = ["/work/app/src/a.ts", "/work/app/src/b.ts", "/work/app-2/a.ts", "/work/app/src/c.ts", "/work/app/docs/notes.md", "/etc/hosts", "src/relative.ts", "C:\\work\\app\\win.ts", "\\\\server\\share\\app\\unc.ts", "//server/share/app/fwd.ts", "/work/app/../etc/passwd", "/work/app/문서/설계 노트.md", LONG];

const CWD: Record<string, string | null> = { [panes.omp]: ROOT, [panes.api]: null, [panes.cli]: "C:\\work\\app" };
const results: Record<string, unknown[]> = { "relative-tool-target": [], "unknown-or-outside-root": [] };
const record = (scenario: string, check: string, detail: unknown): void => {
  results[scenario]!.push({ check, result: "PASS", detail });
  console.log(`PASS ${scenario}: ${check}`);
};

interface Shown { text: string; title: string | null; button: boolean }
const shownFiles = (scope: Locator): Promise<Shown[]> => scope.locator(".chat-tool-file").evaluateAll((nodes) => nodes.map((node) => {
  const button = node.querySelector("button");
  return button !== null
    ? { text: button.textContent ?? "", title: button.getAttribute("title"), button: true }
    : { text: (node.textContent ?? "").replace(/ \((add|delete)\)$/, ""), title: node.getAttribute("title"), button: false };
}));

async function expandCards(scope: Locator): Promise<void> {
  await scope.getByText(REPLY).waitFor();
  // the block folds by itself when its turn settles, which may land at any moment; a click is the
  // reader's choice, which it keeps from then on: one click pins it, a second opens it when the
  // first folded it
  const head = scope.locator("button.work-block-head");
  await head.waitFor();
  await head.click();
  if (await head.getAttribute("aria-expanded") === "false") await head.click();
  await scope.locator('button.work-block-head[aria-expanded="true"]').waitFor();
  const rows = scope.locator(".work-row-head");
  await rows.first().waitFor();
  // a single pass over the rows left the last one folded on a busy run (a click that did not take,
  // or a row drawn again after its state was read): open whatever is folded until every file shows
  const files = scope.locator(".chat-tool-file");
  const folded = scope.locator('.work-row-head[aria-expanded="false"]');
  const lastFile = files.nth(ORDER.length - 1);
  for (let pass = 0; !(await lastFile.isVisible()); pass += 1) {
    assert.ok(pass < 3 * ORDER.length, `every tool row opens: ${JSON.stringify(await rows.evaluateAll((heads) => heads.map((head) => head.getAttribute("aria-expanded"))))}`);
    await folded.or(lastFile).first().waitFor();
    if (await folded.count() > 0) await folded.first().click();
  }
  assert.equal(await files.count(), ORDER.length);
}

const shownPane = (page: Page, paneId: string): Locator => page.locator(`[data-layout-pane=${JSON.stringify(paneId)}].is-current`);
const bareChat = (page: Page): Locator => page.locator(".terminal-stack");

const expected = (root: string | null, button: boolean, title: (path: string) => string): Shown[] =>
  ORDER.map((path) => ({ text: root === ROOT ? LABELS[path]! : path, title: title(path), button }));

async function prepareDemo(): Promise<string> {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  const override = `<script>(() => {
    const demo = window.fetch;
    const cwd = ${JSON.stringify(CWD)};
    const turns = ${JSON.stringify(TURNS)};
    window.fsRequests = [];
    const heldFiles = [];
    window.heldFiles = () => heldFiles.length;
    window.releaseFile = () => { for (const release of heldFiles.splice(0)) release(); };
    const rewrite = (value) => {
      if (Array.isArray(value)) { value.forEach(rewrite); return value; }
      if (value === null || typeof value !== "object") return value;
      if (typeof value.pane_id === "string" && Object.prototype.hasOwnProperty.call(cwd, value.pane_id) && "cwd" in value) {
        value.cwd = cwd[value.pane_id];
        if ("foreground_cwd" in value) value.foreground_cwd = cwd[value.pane_id];
      }
      for (const key of Object.keys(value)) rewrite(value[key]);
      return value;
    };
    const DemoSocket = window.WebSocket;
    const Socket = function (...args) {
      const socket = new DemoSocket(...args);
      const push = socket.push.bind(socket);
      socket.push = (message) => push(rewrite(message));
      return socket;
    };
    Socket.prototype = DemoSocket.prototype;
    Object.setPrototypeOf(Socket, DemoSocket);
    window.WebSocket = Socket;
    // the PC roster (its pane snapshot included) arrives on /api/machines/events too
    const DemoEventSource = window.EventSource;
    window.EventSource = function (...args) {
      const source = new DemoEventSource(...args);
      let handler = null;
      Object.defineProperty(source, "onmessage", {
        configurable: true,
        get: () => handler === null ? null : (event) => handler(new MessageEvent("message", { data: JSON.stringify(rewrite(JSON.parse(event.data))) })),
        set: (next) => { handler = next; },
      });
      return source;
    };
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (url.pathname.startsWith("/api/fs/")) {
        window.fsRequests.push({ endpoint: url.pathname, path: url.searchParams.get("path"), pane_id: url.searchParams.get("pane_id") });
        if (url.searchParams.get("path") === "/work/app/src/a.ts") {
          if (url.pathname === "/api/fs/stat") return json({ path: "/work/app/src/a.ts", name: "a.ts", size: 27, modified: "2026-10-21T10:00:05.000Z", mime: "text/plain", kind: "text" });
          if (url.pathname === "/api/fs/file") return Promise.resolve(new Response("export const viewed = true;\\n", { headers: { "content-type": "text/plain" } }));
        }
        if (url.searchParams.get("path") === "/work/app/src/c.ts") {
          if (url.pathname === "/api/fs/stat") return json({ path: "/work/app/src/c.ts", name: "c.ts", size: 16, modified: "2026-10-21T10:00:05.000Z", mime: "text/plain", kind: "text" });
          if (url.pathname === "/api/fs/file") return new Promise((resolve) => heldFiles.push(() => resolve(new Response("export let c = 3;\\n", { headers: { "content-type": "text/plain" } }))));
        }
        // a file the PC cannot read: the viewer's existing error state
        if (url.pathname === "/api/fs/stat" && url.searchParams.get("path") === "/work/app/src/b.ts") return json({ error: { code: "unreadable", message: "permission denied" } }, 500);
      }
      if (url.pathname === "/api/pane/conversation" && Object.prototype.hasOwnProperty.call(cwd, url.searchParams.get("pane_id") ?? "")) {
        return json({ source: "claude-transcript", history_id: "tool-paths-" + url.searchParams.get("pane_id"), cursor: null, turns: url.searchParams.has("before") ? [] : turns });
      }
      if (url.pathname === "/api/session" || url.pathname === "/api/machines") {
        return Promise.resolve(demo(input, init)).then(async (response) => response.ok ? new Response(JSON.stringify(rewrite(await response.json())), { headers: { "content-type": "application/json" } }) : response);
      }
      return demo(input, init);
    };
  })();</script>`;
  // The demo ends the Claude pane's turn (panes.api, the one with no folder here) 4500 ms after it
  // loads: that timer, set while the transport loads, is kept in window.heldDemoTurns and never run,
  // so the pane stays mid-turn through every check and capture instead of racing them.
  const hold = `<script>(() => {
    const later = window.setTimeout;
    window.heldDemoTurns = [];
    window.setTimeout = (callback, ms, ...args) => ms === 4500 ? (window.heldDemoTurns.push(callback), 0) : later(callback, ms, ...args);
    window.endTurnHold = () => { window.setTimeout = later; };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `${hold}\n    <script src="./demo-transport.js"></script>\n    <script>window.endTurnHold();</script>\n    ${override}\n    <script type="module"`));
  return app;
}

async function prepareBare(): Promise<void> {
  const entry = `
import "./src/styles.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "./src/components/ChatView.tsx";
import { MachineContext } from "./src/lib/machineContext.tsx";
import { SettingsProvider } from "./src/lib/settings.ts";
const FOLDERS = { local: "${ROOT}", remote: "/srv/other", unknown: null, unc: "//server/share/app" };
function Fixture() {
  const [machine, setMachine] = useState("local");
  const [second, setSecond] = useState(false);
  window.toolPathsQa = { machine: setMachine, second: setSecond };
  return <div className="terminal-host"><div className="terminal-stack is-chat" style={{ position: "relative", height: second ? "50vh" : "100vh", width: "100%" }}>
    <MachineContext.Provider value={machine}>
      <ChatView key={machine} paneId="same-pane" refreshKey={0} connected ended={false} agent="claude" agentStatus="done" cwd={FOLDERS[machine]} />
    </MachineContext.Provider>
  </div>
  {second && <div className="tool-paths-second is-chat" style={{ position: "relative", height: "50vh", width: "100%" }}>
    <MachineContext.Provider value="local">
      <ChatView paneId="second-pane" refreshKey={0} connected ended={false} agent="claude" agentStatus="done" cwd={FOLDERS.local} />
    </MachineContext.Provider>
  </div>}</div>;
}
createRoot(document.getElementById("root")).render(<SettingsProvider><Fixture /></SettingsProvider>);
`;
  const build = await Bun.build({
    entrypoints: ["tool-paths-bare.tsx"], outdir: bare, target: "browser", define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "tool-paths-bare", setup(builder) {
      builder.onResolve({ filter: /^tool-paths-bare\.tsx$/ }, () => ({ path: "tool-paths-bare.tsx", namespace: "tool-paths-bare" }));
      builder.onLoad({ filter: /.*/, namespace: "tool-paths-bare" }, () => ({ contents: entry, loader: "tsx", resolveDir: repo }));
    } }],
  });
  assert.ok(build.success, String(build.logs));
}

// the demo's other agents finish turns now and then: their in-app alerts stay off over the cards
const settingsOf = (theme: string, language: string) => JSON.stringify({ language, theme, alertsOn: false });
let shots = 0;
const captures: string[] = [];
const settled = (page: Page): Promise<unknown> => page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation.playState === "running" && animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined))));
async function shot(page: Page, name: string, pointer = false): Promise<void> {
  if (evidence === null) return;
  const viewport = page.viewportSize();
  if (!pointer && viewport !== null && viewport.width > 390) await page.mouse.move(viewport.width - 4, viewport.height / 2);
  const file = `tool-paths-${name}.png`;
  await settled(page);
  await page.screenshot({ path: join(evidence, file) });
  captures.push(file);
  shots += 1;
}

async function noPageScroll(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }));
  assert.ok(overflow.scroll <= overflow.width, `${label}: the page scrolls sideways (${overflow.scroll} > ${overflow.width})`);
}

interface Copied { text: string; html: string; selection: string; labels: string[]; claimed: boolean | null }
async function copyOf(page: Page, scope: Locator, select: (labels: Element[]) => void): Promise<Copied> {
  await page.evaluate(() => {
    const qa = window as unknown as { copyClaimed: boolean | null };
    qa.copyClaimed = null;
    // on the window, after every handler of the page
    window.addEventListener("copy", (event) => { qa.copyClaimed = event.defaultPrevented; }, { once: true });
    return navigator.clipboard.writeText("");
  });
  await scope.locator(".chat-tool-file").evaluateAll(select);
  await page.keyboard.press("ControlOrMeta+c");
  return await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const html = item?.types.includes("text/html") ? await (await item.getType("text/html")).text() : "";
    return {
      text: await navigator.clipboard.readText(), html, selection: getSelection()?.toString() ?? "",
      labels: [...document.querySelectorAll("[data-raw-path]")].map((label) => label.textContent ?? ""),
      claimed: (window as unknown as { copyClaimed: boolean | null }).copyClaimed,
    };
  });
}

async function copyChecks(page: Page, scope: Locator, form: string): Promise<void> {
  const before = (await shownFiles(scope)).map((file) => file.text);
  const whole = await copyOf(page, scope, (labels) => {
    const range = document.createRange();
    range.selectNodeContents(labels[0]!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  assert.equal(whole.text, "/work/app/src/a.ts", `${form}: a copy of the whole label takes the path as written`);
  assert.equal(whole.selection, "app/src/a.ts");
  assert.deepEqual((await shownFiles(scope)).map((file) => file.text), before);
  const dragged = await copyOf(page, scope, (labels) => {
    const text = labels[0]!.querySelector("[data-raw-path]")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent!.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  assert.equal(dragged.text, "/work/app/src/a.ts", `${form}: a selection of the label's text alone copies the path as written`);
  const part = await copyOf(page, scope, (labels) => {
    const text = labels[0]!.querySelector("[data-raw-path]")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, "app/".length);
    range.setEnd(text, text.textContent!.length);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  assert.equal(part.text, "src/a.ts", `${form}: a part of a label copies that part`);
  const cards = await copyOf(page, scope, (labels) => {
    const range = document.createRange();
    range.setStartBefore(labels[0]!);
    range.setEndAfter(labels.at(-1)!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  for (const path of ORDER) assert.ok(cards.text.includes(path), `${form}: a copy of every card keeps ${path}: ${JSON.stringify(cards.text)}`);
  assert.ok(!cards.text.split("\n").some((line) => line.trim().startsWith("app/")), `${form}: no shortened label is copied: ${JSON.stringify(cards.text)}`);
  assert.deepEqual((await shownFiles(scope)).map((file) => file.text), before);
  const reaching: Record<string, (labels: Element[]) => void> = {
    "Select All": () => getSelection()!.selectAllChildren(document.body),
    "a drag from the first card past the chat": (labels) => {
      const range = document.createRange();
      range.setStartBefore(labels[0]!);
      range.setEnd(document.body, document.body.childNodes.length);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    },
  };
  for (const [reach, select] of Object.entries(reaching)) {
    const copy = await copyOf(page, scope, select);
    for (const path of ORDER) assert.ok(copy.text.includes(path), `${form}, ${reach}: the copy keeps ${path}: ${JSON.stringify(copy.text)}`);
    assert.ok(!copy.text.split("\n").some((line) => line.trim().startsWith("app/")), `${form}, ${reach}: no shortened label is copied: ${JSON.stringify(copy.text)}`);
    assert.equal(copy.claimed, true, `${form}, ${reach}: the page takes the copy`);
    assert.equal(copy.html, "", `${form}, ${reach}: no HTML is rebuilt from the page`);
    assert.deepEqual((await shownFiles(scope)).map((file) => file.text), before);
  }
  const native = await copyOf(page, scope, (labels) => {
    const range = document.createRange();
    range.setStart(document.body, 0);
    range.setEndBefore(labels[0]!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  assert.equal(native.claimed, false, `${form}: a selection past the chat with no shortened label keeps native copy`);
  await page.evaluate(() => getSelection()?.removeAllRanges());
  record("relative-tool-target", `${form}: copying a whole label, or every card, copies the paths as written; a part of a label copies that part; the selection and the labels stay as shown`, {
    whole: { text: whole.text, html: whole.html, selection: whole.selection }, dragged: dragged.text, part: part.text, cardsHasEveryRawPath: true,
    reachingPastTheChat: Object.keys(reaching), nativeWithoutLabel: native.claimed === false,
  });
}

async function viewerLoading(page: Page, pane: Locator, label: string, capture: string | null): Promise<void> {
  await pane.getByRole("button", { name: "app/src/c.ts", exact: true }).click();
  const opening = page.locator('.file-viewer-note[role="status"]').filter({ hasText: "Opening…" });
  await opening.waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { heldFiles: () => number }).heldFiles()), 1, `${label}: the file's content is held`);
  await settled(page);
  const box = (await opening.boundingBox())!;
  const viewport = page.viewportSize()!;
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, `${label}: the loading note fits the page: ${JSON.stringify(box)}`);
  await noPageScroll(page, `${label} loading`);
  if (capture !== null) await shot(page, capture);
  await page.evaluate(() => (window as unknown as { releaseFile: () => void }).releaseFile());
  await page.getByText("export let c = 3;").first().waitFor();
  await opening.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Close file", exact: true }).click();
  await page.getByText("export let c = 3;").first().waitFor({ state: "detached" });
  record("relative-tool-target", `${label}: the viewer shows its loading state on the held file inside the page, then the file once released`, { box, viewport });
}

async function demoContext(browser: Browser, width: number, theme: string, language: string): Promise<BrowserContext> {
  const touch = width === 390;
  const context = await browser.newContext(touch
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] }
    : { viewport: { width: 1440, height: 900 }, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
  await context.addInitScript(([settings, ids]) => {
    localStorage.setItem("ovis:settings", settings);
    for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
  }, [settingsOf(theme, language), Object.keys(CWD)] as const);
  return context;
}

async function openPane(page: Page, base: string, paneId: string): Promise<Locator> {
  await page.goto(`${base}?pane=${encodeURIComponent(paneId)}`);
  await page.locator(".conn-live").waitFor({ state: "attached" });
  const scope = shownPane(page, paneId);
  await scope.locator(".terminal-stack.is-chat").waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { heldDemoTurns: unknown[] }).heldDemoTurns.length), 1, "the demo's turn timer is held");
  await appFaces(page);
  await expandCards(scope);
  return scope;
}

async function demoChecks(browser: Browser, base: string): Promise<void> {
  const context = await demoContext(browser, 1440, "dark", "en");
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let pane = await openPane(page, base, panes.omp);
    const inRoot = expected(ROOT, true, (path) => `Open ${path}`);
    assert.deepEqual(await shownFiles(pane), inRoot);
    record("relative-tool-target", "edit, patch, multi-edit and sent-file cards under /work/app read from the folder; titles keep the whole path", { labels: inRoot });
    const sibling = (await shownFiles(pane))[ORDER.indexOf("/work/app-2/a.ts")]!;
    assert.equal(sibling.text, "/work/app-2/a.ts");
    const outside = (await shownFiles(pane))[ORDER.indexOf("/etc/hosts")]!;
    assert.equal(outside.text, "/etc/hosts");
    record("unknown-or-outside-root", "a sibling folder's file and a file outside the folder read as written", { sibling, outside });
    for (const path of ["src/relative.ts", "C:\\work\\app\\win.ts", "\\\\server\\share\\app\\unc.ts", "//server/share/app/fwd.ts"]) assert.equal((await shownFiles(pane))[ORDER.indexOf(path)]!.text, path);
    record("unknown-or-outside-root", "a relative path, a Windows drive path and a UNC path read as written", ORDER.filter((path) => !path.startsWith("/")));
    // `..` under the folder resolves outside it: never a label that looks inside
    assert.equal((await shownFiles(pane))[ORDER.indexOf("/work/app/../etc/passwd")]!.text, "/work/app/../etc/passwd");
    record("unknown-or-outside-root", "a path whose .. leaves the folder reads as written", "/work/app/../etc/passwd");
    assert.equal((await shownFiles(pane))[ORDER.indexOf("/work/app/문서/설계 노트.md")]!.text, "app/문서/설계 노트.md");
    assert.equal((await shownFiles(pane))[ORDER.indexOf(LONG)]!.text.length, 4 + 300 + 3);
    await noPageScroll(page, "desktop");
    record("unknown-or-outside-root", "a Unicode path and a 300-character file name read from the folder, and the page never scrolls sideways", { unicode: "app/문서/설계 노트.md", long: LONG.length });

    const link = pane.getByRole("button", { name: "app/src/a.ts", exact: true });
    await link.hover();
    assert.equal(await link.getAttribute("title"), "Open /work/app/src/a.ts");
    await link.click();
    await page.waitForFunction(() => (window as unknown as { fsRequests: { path: string }[] }).fsRequests.some((request) => request.path === "/work/app/src/a.ts"), undefined, { timeout: 10_000 });
    await page.getByText("export const viewed = true;").first().waitFor();
    const requests = (await page.evaluate(() => (window as unknown as { fsRequests: { endpoint: string; path: string | null }[] }).fsRequests)).filter((request) => request.path !== null);
    assert.deepEqual(requests.map((request) => request.endpoint), ["/api/fs/stat", "/api/fs/file"]);
    assert.ok(requests.every((request) => request.path === "/work/app/src/a.ts"), `the viewer asked only for the whole path: ${JSON.stringify(requests)}`);
    record("relative-tool-target", "hovering shows the whole path, and the viewer requests exactly /work/app/src/a.ts", { title: "Open /work/app/src/a.ts", requests });
    await page.getByRole("button", { name: "Close file", exact: true }).click();
    await page.getByText("export const viewed = true;").first().waitFor({ state: "detached" });
    await viewerLoading(page, pane, "desktop", null);
    await copyChecks(page, pane, "the link");

    const copied: Record<string, string> = {};
    for (const label of ["Copy as markdown", "Copy as plain text"]) {
      await pane.getByRole("button", { name: label, exact: true }).last().click();
      copied[label] = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(copied[label]!.includes(REPLY), `${label} copies the reply as written: ${JSON.stringify(copied[label])}`);
    }
    const transcript = await page.evaluate(async (paneId) => await (await fetch(`/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`)).text(), panes.omp);
    assert.ok(transcript.includes("/work/app/src/a.ts") && !transcript.includes("\"app/src/a.ts\""), "the transcript is unchanged");
    record("relative-tool-target", "the reply's MD and TXT copies and the transcript read keep the raw paths", { copied, transcriptHasRaw: true });

    for (const [paneId, root] of [[panes.api, null], [panes.cli, null], [panes.omp, ROOT]] as const) {
      const workspace = paneId.split(":")[0]!;
      await page.locator(`.workspace-group[data-workspace=${JSON.stringify(workspace)}] .pane-select`).first().click();
      await page.waitForURL((url) => url.searchParams.get("pane") === paneId);
      pane = shownPane(page, paneId);
      await expandCards(pane);
      assert.deepEqual(await shownFiles(pane), expected(root, true, (path) => `Open ${path}`), `pane ${paneId} (folder ${String(CWD[paneId])})`);
    }
    record("unknown-or-outside-root", "switching to a pane with no folder, then one on a Windows folder, shows every path as written; back, the first pane reads from its own folder", { panes: CWD });
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function mobileChecks(browser: Browser, base: string): Promise<void> {
  const context = await demoContext(browser, 390, "light", "en");
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const pane = await openPane(page, base, panes.omp);
    const targets = await pane.locator(".chat-tool-file-link").evaluateAll((nodes) => nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { label: (node.textContent ?? "").slice(0, 40), width: box.width, height: box.height, top: box.top, bottom: box.bottom };
    }));
    assert.equal(targets.length, ORDER.length);
    for (const target of targets) assert.ok(target.width >= 44 && target.height >= 44, `a file link is a finger's size: ${JSON.stringify(target)}`);
    for (let index = 1; index < targets.length; index += 1) assert.ok(targets[index - 1]!.bottom <= targets[index]!.top, `two file links share a hit area: ${JSON.stringify(targets.slice(index - 1, index + 1))}`);
    await noPageScroll(page, "390");
    record("relative-tool-target", "at 390 (iphone-14, touch) every file link is at least 44x44 CSS px and no two overlap", { targets: targets.map(({ label, width, height }) => ({ label, width, height })) });
    await copyChecks(page, pane, "the phone link");
    await viewerLoading(page, pane, "390", null);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function bareChecks(browser: Browser, base: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US", permissions: ["clipboard-read", "clipboard-write"] });
  try {
    await context.addInitScript((settings) => localStorage.setItem("ovis:settings", settings), settingsOf("dark", "en"));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    const chat = bareChat(page);
    await expandCards(chat);
    assert.deepEqual(await shownFiles(chat), expected(ROOT, false, (path) => path));
    assert.equal(await chat.locator(".chat-tool-file button").count(), 0);
    record("unknown-or-outside-root", "with nothing to open a file in, the label is text with the whole path as its title and no button", { labels: await shownFiles(chat) });
    await copyChecks(page, chat, "the label as text");
    for (const [machine, root] of [["remote", null], ["unknown", null], ["unc", null], ["local", ROOT]] as const) {
      await page.evaluate((next) => (window as unknown as { toolPathsQa: { machine: (id: string) => void } }).toolPathsQa.machine(next), machine);
      await expandCards(chat);
      assert.deepEqual(await shownFiles(chat), expected(root, false, (path) => path), `machine ${machine}`);
    }
    record("unknown-or-outside-root", "the same pane id on another PC (folder /srv/other), on one with no folder and on a UNC folder written //server/share/app reads every path as written; back, the first PC's folder again", { machines: { local: ROOT, remote: "/srv/other", unknown: null, unc: "//server/share/app" } });
    await page.evaluate(() => (window as unknown as { toolPathsQa: { second: (on: boolean) => void } }).toolPathsQa.second(true));
    const second = page.locator(".tool-paths-second");
    await expandCards(second);
    const twoChats: Record<string, { claimed: boolean | null; hasHtml: boolean }> = {};
    for (const [name, scope] of [["the second chat", second], ["the first chat", chat]] as const) {
      const copy = await copyOf(page, scope, (labels) => {
        const replies = labels[0]!.closest(".chat-view")!.querySelectorAll(".markdown");
        const range = document.createRange();
        range.setStartBefore(labels[0]!);
        range.setEndAfter(replies[replies.length - 1]!);
        getSelection()!.removeAllRanges();
        getSelection()!.addRange(range);
      });
      assert.equal(copy.claimed, true, `${name}: the chat takes a copy wholly inside it`);
      assert.ok(copy.text.includes("/work/app/docs/notes.md") && !copy.text.split("\n").some((line) => line.trim().startsWith("app/")), `${name}: the copy keeps the paths as written: ${JSON.stringify(copy.text)}`);
      assert.ok(copy.html.includes("<p>") && copy.html.includes("Tidied"), `${name}: the copy keeps the chat's rich HTML: ${JSON.stringify(copy.html)}`);
      twoChats[name] = { claimed: copy.claimed, hasHtml: true };
    }
    record("relative-tool-target", "with two chats mounted, a copy wholly inside either keeps its whole paths and its rich HTML", twoChats);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function captureSet(browser: Browser, base: string, bareBase: string, width: number, theme: string, language: string): Promise<void> {
  const name = (state: string) => `${width}-${theme}${language === "ko" ? "-ko" : ""}-${state}`;
  const context = await demoContext(browser, width, theme, language);
  try {
    const page = await context.newPage();
    const pane = await openPane(page, base, panes.omp);
    await noPageScroll(page, name("rest"));
    const first = pane.locator(".chat-tool-file").first();
    await first.scrollIntoViewIfNeeded();
    await shot(page, name("rest"));
    if (language === "ko") return;
    const link = first.locator("button");
    if (width === 1440) {
      await link.hover();
      await shot(page, name("hover"), true);
      await page.mouse.move(0, 0);
    }
    await link.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    assert.ok(await link.evaluate((node) => node.matches(":focus-visible")), "the link takes keyboard focus");
    await shot(page, name("focus"));
    await link.evaluate((node) => (node as HTMLElement).blur());
    const box = (await link.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await shot(page, name("pressed"), true);
    await page.mouse.move(0, 0);
    await page.mouse.up();
    await pane.locator(".chat-tool-file").nth(ORDER.indexOf("src/relative.ts")).scrollIntoViewIfNeeded();
    await shot(page, name("outside"));
    await pane.locator(".chat-tool-file").nth(ORDER.indexOf(LONG)).scrollIntoViewIfNeeded();
    await shot(page, name("long"));
    await pane.getByText(REPLY).scrollIntoViewIfNeeded();
    await shot(page, name("end"));
    await pane.getByRole("button", { name: "app/src/a.ts", exact: true }).click();
    await page.getByText("export const viewed = true;").first().waitFor();
    await noPageScroll(page, name("viewer"));
    await shot(page, name("viewer"));
    await page.getByRole("button", { name: "Close file", exact: true }).click();
    await page.getByText("export const viewed = true;").first().waitFor({ state: "detached" });
    await pane.getByRole("button", { name: "app/src/b.ts", exact: true }).click();
    const failure = page.getByRole("alert").filter({ hasText: "The PC could not read the file. Reopen it to try again." });
    await failure.waitFor();
    assert.equal(await failure.textContent(), "The PC could not read the file. Reopen it to try again.");
    await shot(page, name("viewer-error"));
    await page.getByRole("button", { name: "Close file", exact: true }).click();
    await failure.waitFor({ state: "detached" });
    await viewerLoading(page, pane, name("viewer-loading"), name("viewer-loading"));
    const empty = await openPane(page, base, panes.api);
    await empty.locator(".chat-tool-file").first().scrollIntoViewIfNeeded();
    await shot(page, name("emptycwd"));
    await page.goto(bareBase);
    const chat = bareChat(page);
    await expandCards(chat);
    await chat.locator(".chat-tool-file").first().scrollIntoViewIfNeeded();
    await shot(page, name("noclick"));
  } finally { await context.close(); }
}

const serveDir = (dir: string, prefix: string, index: string) => Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/pane/conversation")) return Response.json({ source: "claude-transcript", history_id: "tool-paths-bare", cursor: null, turns: TURNS });
  if (path.endsWith("/pane/commands")) return Response.json({ commands: [] });
  if (!path.startsWith(prefix)) return new Response("not found", { status: 404 });
  let file: string;
  try { file = decodeURIComponent(path.slice(prefix.length)); }
  catch { return new Response("bad path", { status: 400 }); }
  if (!file || file.endsWith("/")) return index === "index.html" ? new Response(Bun.file(join(dir, "index.html"))) : new Response(index, { headers: { "content-type": "text/html" } });
  if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
  const body = Bun.file(join(dir, file));
  return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
} });

try {
  await prepareDemo();
  await prepareBare();
  const demoServer = serveDir(app, "/herdr-web-ui/demo/app/", "index.html");
  const bareServer = serveDir(bare, "/", '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tool-paths-bare.css"></head><body><div id="root"></div><script type="module" src="/tool-paths-bare.js"></script></body></html>');
  try {
    const base = `http://127.0.0.1:${demoServer.port}/herdr-web-ui/demo/app/`;
    const bareBase = `http://127.0.0.1:${bareServer.port}/`;
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      await demoChecks(browser, base);
      await mobileChecks(browser, base);
      await bareChecks(browser, bareBase);
      if (evidence !== null) {
        for (const width of [390, 1440]) for (const theme of ["light", "dark"]) await captureSet(browser, base, bareBase, width, theme, "en");
        for (const theme of ["light", "dark"]) await captureSet(browser, base, bareBase, 390, theme, "ko");
        writeFileSync(join(evidence, "tool-paths-captures.json"), JSON.stringify(captures, null, 2));
      }
    } finally { await browser.close(); }
  } finally { demoServer.stop(); bareServer.stop(); }
  for (const [scenario, checks] of Object.entries(results)) console.log(`RESULT ${scenario} ${JSON.stringify(checks)}`);
  console.log(`PASS tool-file labels read from the pane's folder${evidence !== null ? `: ${shots} screenshots in ${evidence}` : ""}`);
} finally {
  rmSync(app, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
}
