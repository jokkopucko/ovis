/**
 * Real ChatView and PromptCard over a loopback fixture server (#2590):
 * 1. a pane that comes back on another session, or moves to one while shown, shows no card from the session before, also while reads fail;
 * 2. an answer typed into the card while offline, or before the Terminal lens, survives as the composer's draft once the question is gone;
 * 3. after herdr's blocked edge, a question drawn just after the first read shows well before the 2 s poll.
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { build as viteBuild } from "vite";
import { CONTENT_SECURITY_POLICY } from "../server/static.ts";
import { chromePath } from "./chrome-path.ts";
import type { InteractivePrompt } from "../shared/protocol.ts";

const question = (id: string, text: string): InteractivePrompt => ({
  id, agent: "claude", kind: "question", title: "Question", question: text, body: null,
  options: [{ label: "Yes", description: null }, { label: "No", description: null }, { label: "Type something.", description: null }],
  multi_select: false, custom_option_index: 2,
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-prompt-lifetime-")));
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
// what the prompt endpoint answers now, and a wake-up for each read it answers
let answer: { prompt: InteractivePrompt | null } | "fail" = { prompt: null };
let readWaiters: Array<() => void> = [];
const nextRead = (): Promise<void> => new Promise((resolve) => { readWaiters.push(resolve); });
// an answer the server holds open, as it does while it re-reads the screen to confirm it
let heldAnswer: { arrived: () => void; release: Promise<void>; refuse?: boolean } | null = null;
try {
  const repo = join(import.meta.dir, ".."), output = join(root, "dist");
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  symlinkSync(join(repo, "scripts/prompt-card-lifetime-fixture.tsx"), join(root, "fixture.tsx"));
  writeFileSync(join(root, "index.html"), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
  await viteBuild({ configFile: join(repo, "vite.config.ts"), root, publicDir: false, logLevel: "warn", build: { outDir: output, emptyOutDir: true } });
  const turns = [{ role: "assistant", ts: new Date(Date.now() - 60_000).toISOString(), parts: [{ kind: "text", text: "Let me ask first." }] }];
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/pane/prompt") {
      const response = answer === "fail" ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ ...answer, outcomes: [] });
      const waiters = readWaiters; readWaiters = [];
      queueMicrotask(() => { for (const wake of waiters) wake(); });
      return response;
    }
    if (url.pathname === "/api/pane/conversation") return Response.json({ source: "claude-transcript", cursor: null, turns });
    if (url.pathname === "/api/pane/prompt/answer" && heldAnswer !== null) {
      const held = heldAnswer; heldAnswer = null; held.arrived();
      return held.release.then(() => held.refuse ? Response.json({ error: { code: "prompt_changed", message: "changed" } }, { status: 409 }) : Response.json({ ok: true }));
    }
    if (url.pathname === "/api/pane/commands") return Response.json({ commands: [] });
    if (url.pathname.startsWith("/api/")) return Response.json({ error: "not_found" }, { status: 404 });
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    return new Response(Bun.file(join(output, url.pathname === "/" ? "index.html" : url.pathname.slice(1))), { headers: { "content-security-policy": CONTENT_SECURITY_POLICY } });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const chrome = browser, url = `http://127.0.0.1:${server.port}`;
  const open = async (query = ""): Promise<{ page: Page; close: () => Promise<void>; errors: string[] }> => {
    const context = await chrome.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url + query);
    return { page, errors, close: () => context.close() };
  };
  const setChat = (page: Page, props: Record<string, unknown>) => page.evaluate((next) => (window as unknown as { setChat: (p: unknown) => void }).setChat(next), props);
  const card = (page: Page) => page.locator(".prompt-card");
  // the Terminal lens: the chat is gone before anything else changes (two prop changes in a row could render as one)
  const unmount = async (page: Page): Promise<void> => { await setChat(page, { mounted: false }); await card(page).waitFor({ state: "detached" }); };
  // every scenario runs, and the run fails with each that did
  const failed: string[] = [];
  const scenario = async (name: string, run: () => Promise<void>): Promise<void> => {
    try { await run(); } catch (error) { failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); console.log(`FAIL ${name}`); }
  };

  await scenario("another session's card", async () => {
    answer = { prompt: question("a", "SESSION-A: deploy the old branch?") };
    const { page, close, errors } = await open();
    try {
      await card(page).getByText("SESSION-A: deploy the old branch?").waitFor();
      await unmount(page);
      answer = "fail";
      const twoReads = nextRead().then(nextRead);
      await setChat(page, { mounted: true, agentSession: "session-b" });
      assert.equal(await card(page).count(), 0, "no card from the session before at mount");
      await twoReads;
      assert.equal(await card(page).count(), 0, "still no card from the session before after 2 failed reads");
      // the same session back: its question is still drawn before the first read answers
      answer = { prompt: question("b", "SESSION-B: run the tests?") };
      await card(page).getByText("SESSION-B: run the tests?").waitFor();
      await unmount(page);
      answer = "fail";
      await setChat(page, { mounted: true });
      assert.equal(await card(page).getByText("SESSION-B: run the tests?").count(), 1, "the same session's card draws again at mount");
      // the pane moves to another session while the chat is shown: the card goes, reads failing or not
      const reread = nextRead();
      await setChat(page, { agentSession: "session-c" });
      await reread;
      assert.equal(await card(page).count(), 0, "no card from the session before after a session change while shown");
      assert.deepEqual(errors, []);
      console.log("PASS a pane back on another session shows no card from the session before");
    } finally { await close(); }
  });

  await scenario("typed offline", async () => {
    answer = { prompt: question("c", "Which branch?") };
    const { page, close, errors } = await open();
    try {
      await card(page).getByText("Which branch?").waitFor();
      await setChat(page, { connected: false });
      await card(page).locator(".prompt-card-custom input").fill("my offline answer");
      answer = { prompt: null };
      await setChat(page, { connected: true });
      await card(page).waitFor({ state: "detached" });
      const draft = await page.evaluate(() => (window as unknown as { composerDraft: () => string }).composerDraft());
      assert.equal(draft, "my offline answer", "the typed answer is the composer's draft");
      assert.deepEqual(errors, []);
      console.log("PASS an answer typed offline survives as the composer's draft");
    } finally { await close(); }
  });

  await scenario("typed before the Terminal lens", async () => {
    answer = { prompt: question("e", "Which remote?") };
    const { page, close, errors } = await open();
    try {
      await card(page).getByText("Which remote?").waitFor();
      await card(page).locator(".prompt-card-custom input").fill("upstream please");
      // back from the Terminal lens with the question still asked: the card shows what was typed
      await unmount(page);
      await setChat(page, { mounted: true });
      assert.equal(await card(page).locator(".prompt-card-custom input").inputValue(), "upstream please", "the card drawn again keeps the typed text");
      await unmount(page);
      answer = { prompt: null };
      const read = nextRead();
      await setChat(page, { mounted: true });
      await read;
      await page.waitForFunction(() => (window as unknown as { composerDraft: () => string }).composerDraft() === "upstream please");
      assert.equal(await card(page).count(), 0);
      assert.deepEqual(errors, []);
      console.log("PASS an answer typed before the Terminal lens survives as the composer's draft");
    } finally { await close(); }
  });

  await scenario("answer sent while the question goes", async () => {
    answer = { prompt: question("f", "Which feature branch?") };
    const { page, close, errors } = await open();
    try {
      await card(page).getByText("Which feature branch?").waitFor();
      let release = (): void => {};
      const arrived = new Promise<void>((resolve) => { heldAnswer = { arrived: resolve, release: new Promise((done) => { release = done; }) }; });
      const input = card(page).locator(".prompt-card-custom input");
      await input.fill("feature-x");
      await input.press("Enter");
      await arrived;
      answer = { prompt: null };
      await nextRead();
      await card(page).waitFor({ state: "detached" });
      release();
      await page.waitForFunction(() => !document.querySelector(".prompt-card"));
      const draft = await page.evaluate(() => (window as unknown as { composerDraft: () => string }).composerDraft());
      assert.equal(draft, "", "a sent answer does not come back as a draft");
      assert.deepEqual(errors, []);
      console.log("PASS an answer sent while its question goes is not put back as a draft");
    } finally { await close(); }
  });

  await scenario("same question in another session", async () => {
    answer = { prompt: question("g", "Which branch?") };
    const { page, close, errors } = await open();
    try {
      const input = card(page).locator(".prompt-card-custom input");
      await card(page).getByText("Which branch?").waitFor();
      await input.fill("session A answer");
      await unmount(page);
      await setChat(page, { mounted: true, agentSession: "session-b" });
      await card(page).getByText("Which branch?").waitFor();
      assert.equal(await input.inputValue(), "", "session B's card does not get session A's text");
      await page.waitForFunction(() => (window as unknown as { composerDraft: () => string }).composerDraft() === "session A answer");
      assert.deepEqual(errors, []);
      console.log("PASS text typed in one session goes to the draft, not to the same question in another");
    } finally { await close(); }
  });

  await scenario("refused late", async () => {
    answer = { prompt: question("h", "Which tag?") };
    const { page, close, errors } = await open();
    try {
      const input = card(page).locator(".prompt-card-custom input");
      await card(page).getByText("Which tag?").waitFor();
      let release = (): void => {};
      const arrived = new Promise<void>((resolve) => { heldAnswer = { arrived: resolve, refuse: true, release: new Promise((done) => { release = done; }) }; });
      await input.fill("old answer");
      await input.press("Enter");
      await arrived;
      // to the Terminal lens and back while the answer is on its way, and a new answer typed
      await unmount(page);
      await setChat(page, { mounted: true });
      await input.fill("new answer");
      release();
      const read = nextRead();
      answer = { prompt: null };
      await read;
      await page.waitForFunction(() => (window as unknown as { composerDraft: () => string }).composerDraft().includes("new answer"));
      const draft = await page.evaluate(() => (window as unknown as { composerDraft: () => string }).composerDraft());
      assert.ok(draft.includes("old answer") && draft.includes("new answer"), `both texts are kept (${JSON.stringify(draft)})`);
      assert.deepEqual(errors, []);
      console.log("PASS a refused answer that comes back late keeps both its text and the newer one");
    } finally { await close(); }
  });

  await scenario("blocked edge", async () => {
    answer = { prompt: null };
    const mounted = nextRead();
    const { page, close, errors } = await open("?status=working");
    try {
      await mounted;
      const first = nextRead();
      const edge = Date.now();
      await setChat(page, { agentStatus: "blocked" });
      await first;
      answer = { prompt: question("d", "Deploy now?") };
      await card(page).getByText("Deploy now?").waitFor();
      const after = Date.now() - edge;
      assert.ok(after < 1000, `the card follows the blocked edge promptly (${after} ms)`);
      assert.deepEqual(errors, []);
      console.log(`PASS the card shows ${after} ms after the blocked edge`);
    } finally { await close(); }
  });
  assert.deepEqual(failed, [], "every scenario passes");
} finally {
  await browser?.close();
  server?.stop();
  rmSync(root, { recursive: true, force: true });
}
