/**
 * Real ChatView for an OpenCode pane whose `@effect` send went as plain text: the outcome chip says
 * "Runs in the terminal", and under it the note names the skill that was not attached, at 1280 and 390 px, light and dark. All traffic stays on this loopback fixture server.
 * Then /compact and /clear: the new conversation shows no row of a send to the one it left.
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { build as viteBuild } from "vite";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import type { CommandOutcome, ConversationTurn } from "../shared/protocol.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-chat-outcome-note-")));
const evidence = join(process.env.UI_EVIDENCE_DIR || join(import.meta.dir, "..", "evidence"), "outcome-note");
const RUNS = [[1280, "light"], [1280, "dark"], [390, "light"], [390, "dark"]] as const;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/chat-outcome-note-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const sentAt = new Date(Date.now() - 60_000).toISOString();
  const ready: ConversationTurn[] = [{ role: "assistant", ts: new Date(Date.now() - 120_000).toISOString(), parts: [{ kind: "text", text: "Ready when you are." }] }];
  let turns = ready;
  const outcome: CommandOutcome = {
    id: "outcome-note-1", pane_id: "opencode-pane", text: "@effect apply it to the parser", state: "terminal-required", evidence: [],
    note: "OpenCode did not attach @effect; it was sent as plain text", unattached_skills: ["effect"], created_at: sentAt, updated_at: sentAt,
  };
  let outcomes = [outcome], history: string | undefined;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pane/prompt") return Response.json({ prompt: null, outcomes });
    if (url.pathname === "/api/pane/commands") return Response.json({ commands: [{ name: "effect", description: "Apply Effect", source: "skill", trigger: "@", provenance: { transport: "native", verified: true } }] });
    if (url.pathname === "/api/pane/conversation") return Response.json({ source: "opencode-transcript", history_id: history, cursor: null, turns });
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": CONTENT_SECURITY_POLICY } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  mkdirSync(evidence, { recursive: true });
  for (const [width, scheme] of RUNS) {
    const touch = width <= 480;
    const context = await browser.newContext({ viewport: { width, height: touch ? 844 : 800 }, hasTouch: touch, isMobile: touch, colorScheme: scheme, locale: "en-US" });
    try {
      await context.addInitScript((theme) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })), scheme);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${server.port}`);
      const chip = page.locator('.chat-outcome[data-outcome-state="terminal-required"]');
      await chip.waitFor();
      assert.equal(await chip.locator(".chat-outcome-state").innerText(), "Runs in the terminal");
      const note = chip.locator(".chat-outcome-note");
      await note.waitFor();
      assert.equal(await note.innerText(), "Not attached, sent as plain text: @effect");
      // inside the chat column: no sideways scroll at either width
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `no horizontal overflow at ${width}px (${overflow}px)`);
      const box = await note.boundingBox();
      assert.ok(box !== null && box.x >= 0 && box.x + box.width <= width, `the note fits the ${width}px viewport`);
      await page.screenshot({ path: join(evidence, `${width}-${scheme}-not-attached.png`), animations: "disabled" });
      assert.deepEqual(errors, [], `page errors at ${width}px (${scheme})`);
      console.log(`PASS ${width}px ${scheme}: the not-attached note names @effect under "Runs in the terminal"`);
    } finally {
      await context.close();
    }
  }
  console.log(`PASS outcome note: ${RUNS.length} runs; screenshots in ${evidence}`);

  // /compact, then /clear: the server lists the /compact send until herdr names the new session, which can be
  // after the chat has read the new, empty conversation. The chat held /compact's outcome when it saw the move,
  // or a poll lists it only after the move.
  const at = (seconds: number) => new Date(Date.now() - 50_000 + seconds * 1000).toISOString();
  const compact: CommandOutcome = { id: "compact-1", pane_id: "opencode-pane", text: "/compact", state: "result-observed", evidence: [{ kind: "transcript", at: at(1) }], created_at: at(0), updated_at: at(1) };
  const clear: CommandOutcome = { ...compact, id: "clear-1", text: "/clear", state: "accepted", evidence: [], created_at: at(5), updated_at: at(5) };
  const chrome = browser, url = `http://127.0.0.1:${server.port}`;
  for (const held of [true, false]) {
    turns = ready; history = "before-clear"; outcomes = held ? [compact] : [];
    const context = await chrome.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      const row = (text: string) => page.locator("[data-chat-row]", { hasText: text });
      const before = page.getByText("Ready when you are.", { exact: true });
      if (held) await row("/compact").waitFor();
      else await before.waitFor();
      turns = []; history = "after-clear";
      if (held) outcomes = [compact, clear];
      await before.waitFor({ state: "detached" });
      outcomes = [compact, clear];
      await row("/clear").waitFor();
      const when = held ? "held when the chat saw the move" : "listed only after the move";
      assert.equal(await row("/compact").count(), 0, `the cleared chat shows no /compact row (${when})`);
      assert.deepEqual(errors, [], "page errors after /clear");
      console.log(`PASS after /clear the new conversation shows no row of a send to the one it left (${when}), and /clear keeps its own`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
