import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import type { Browser, Page, Response } from "playwright-core";

const quoted = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;
const unbracket = (text: string): string => text.replace(/^\x1b\[200~/, "").replace(/\x1b\[201~$/, "");

async function openPhone(browser: Browser, origin: string, pane: string, attach: boolean) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(([id, on]) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ovis:view:${id}`, "terminal");
    if (on) localStorage.setItem("ovis:terminal-attach-button", "true");
  }, [pane, attach] as const);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const sent: Array<{ type: string; text?: string }> = [];
  const waiting: Array<() => void> = [];
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload)) as { type: string; text?: string };
    if (!["input", "submit", "insert", "keys"].includes(frame.type)) return;
    sent.push(frame);
    for (const wake of waiting.splice(0)) wake();
  }));
  const nextFrame = (): Promise<void> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no terminal input arrived")), 10_000);
    waiting.push(() => { clearTimeout(timer); resolve(); });
  });
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.locator("[data-direct-typing]").waitFor();
  return { context, page, errors, sent, nextFrame };
}

async function pick(page: Page, open: () => Promise<void>, files: Array<{ name: string; mimeType: string; buffer: Buffer }>): Promise<string[]> {
  const stored: string[] = [];
  // a wrong answer fails the pick where it is awaited, not the run from a handler; once every file is stored the
  // listener leaves, so no later answer (the next picks', the held upload's) is read as the page closes
  const responses = new Promise<void>((resolve, reject) => {
    const heard = async (response: Response): Promise<void> => {
      if (!response.url().endsWith("/api/pane/image") || response.request().method() !== "POST") return;
      try {
        assert.equal(response.status(), 200);
        stored.push(((await response.json()) as { path: string }).path);
      } catch (error) { page.off("response", heard); reject(error); return; }
      if (stored.length === files.length) { page.off("response", heard); resolve(); }
    };
    page.on("response", heard);
  });
  // a rejection is reported at `await responses` below, not as an unhandled one if it comes before that await
  responses.catch(() => {});
  const chooser = page.waitForEvent("filechooser");
  await open();
  const picker = await chooser;
  assert.equal(picker.isMultiple(), true, "the picker takes several files");
  await picker.setFiles(files);
  await responses;
  for (const [index, path] of stored.entries()) assert.deepEqual(readFileSync(path), files[index]!.buffer, `${files[index]!.name} is stored as picked`);
  return stored;
}

export async function checkTerminalAttach(browser: Browser, origin: string, pane: string): Promise<void> {
  const plain = await openPhone(browser, origin, pane, false);
  assert.equal(await plain.page.locator('.key-bar [data-key="attach"]').count(), 0, "no Attach key by default");
  await plain.page.getByRole("button", { name: "Input line", exact: true }).click();
  await plain.page.getByRole("textbox", { name: "Terminal input line", exact: true }).waitFor();
  assert.equal(await plain.page.getByRole("button", { name: "Attach files", exact: true }).count(), 0, "no Attach button in the input line by default");
  assert.deepEqual(plain.errors, []);
  await plain.context.close();

  const { context, page, errors, sent, nextFrame } = await openPhone(browser, origin, pane, true);
  const key = page.locator('.key-bar [data-key="attach"]');
  assert.equal(await key.getAttribute("aria-label"), "Attach files");
  assert.equal(await page.locator('.key-bar [data-key="keyboard"] + [data-key="attach"]').count(), 1, "the Attach key follows the keyboard control");
  const typed = sent.length;
  const files = [
    { name: "screen shot.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") },
    { name: "build's log.txt", mimeType: "text/plain", buffer: Buffer.from("error: one\n") },
  ];
  const typedPaths = nextFrame();
  const direct = await pick(page, () => key.click(), files);
  const expected = `${direct.map(quoted).join(" ")} `;
  await typedPaths;
  assert.deepEqual(sent.slice(typed).map((frame) => ({ type: frame.type, text: unbracket(frame.text ?? "") })), [{ type: "input", text: expected }], "the quoted paths alone, with no Enter");
  console.log("PASS the key bar's Attach key stores picked files beside the pane and types their paths without Enter");

  await page.getByRole("button", { name: "Input line", exact: true }).click();
  const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
  await line.fill("cat ");
  const button = page.getByRole("button", { name: "Attach files", exact: true });
  assert.equal(await page.locator(".terminal-input-actions > button").first().getAttribute("aria-label"), "Attach files", "Attach comes before Insert and Send");
  const before = sent.length;
  const [stored] = await pick(page, () => button.click(), [{ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# notes\n") }]);
  await page.waitForFunction((value) => document.querySelector<HTMLTextAreaElement>(".terminal-input-text")?.value === value, `cat ${quoted(stored!)} `);
  assert.deepEqual(sent.slice(before), [], "the line sends nothing until Send");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "the line still fits a 390 wide screen");
  await line.fill("");

  await line.fill("echo ");
  const opened = page.waitForEvent("filechooser");
  await button.click();
  const late = await opened;
  await line.fill("echo changed ");
  await late.setFiles([{ name: "late.md", mimeType: "text/markdown", buffer: Buffer.from("late\n") }]);
  await page.locator(".terminal-input-note", { hasText: "Not pasted: the line or the terminal changed meanwhile. Paste again." }).waitFor();
  assert.equal(await line.inputValue(), "echo changed ");

  await line.fill("");
  await page.getByRole("button", { name: "Input line", exact: true }).click();
  await page.locator(".terminal-input").waitFor({ state: "detached" });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let arrived: () => void = () => {};
  const reached = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route("**/api/pane/image", async (route) => { arrived(); await held; await route.continue(); });
  const chooser = page.waitForEvent("filechooser");
  await key.click();
  await (await chooser).setFiles([{ name: "slow.txt", mimeType: "text/plain", buffer: Buffer.from("slow\n") }]);
  await reached;
  await page.getByRole("button", { name: "Input line", exact: true }).click();
  await line.waitFor();
  const quiet = sent.length;
  const answered = page.waitForResponse((response) => response.url().endsWith("/api/pane/image"));
  release();
  const heldAnswer = await answered;
  await heldAnswer.finished();
  assert.equal(heldAnswer.status(), 200, "the held upload is stored");
  assert.equal(typeof ((await heldAnswer.json()) as { path?: unknown }).path, "string", "the held upload answers its stored path");
  await page.unroute("**/api/pane/image");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.deepEqual(sent.slice(quiet), [], "an upload for direct typing types nothing once the input line is up");
  assert.deepEqual(errors, []);
  await context.close();
  console.log("PASS the input line's Attach button puts picked files' paths at the caret and sends nothing, and a stale pick or upload types nothing");

  // a pane whose folder holds a line break: its stored path would reach the program as Enter, so nothing is typed
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-attach-")));
  const cwd = join(root, "two\nlines");
  mkdirSync(cwd);
  const workspace = await workspaceCreate({ cwd, label: "ovis-test-attach-newline" });
  try {
    const broken = await openPhone(browser, origin, workspace.root_pane.pane_id, true);
    const [path] = await pick(broken.page, () => broken.page.locator('.key-bar [data-key="attach"]').click(), [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a\n") }]);
    assert.match(path!, /\n/, "the stored path holds the folder's line break");
    await broken.page.locator(".terminal-banner", { hasText: "Not pasted: the file's path holds a line break, which the terminal would take as Enter." }).waitFor();
    assert.deepEqual(broken.sent, [], "nothing is typed");
    await broken.context.close();
  } finally {
    await workspaceClose(workspace.workspace.workspace_id).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
  console.log("PASS a stored path with a line break is refused with a note and types nothing");
}
