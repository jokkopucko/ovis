import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneRead, paneSendText, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

/** Only owned no-echo fixtures; assert delivery without storing the entered value. */
export async function checkSecretInput(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-secret-ui-"));
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-secret-ui" });
  const pane = created.root_pane.pane_id;
  const result = join(root, "accepted");
  const script = join(root, "ask.cjs");
  writeFileSync(script, `
const { writeFileSync } = require("node:fs");
process.stdin.setRawMode(true); process.stdin.resume();
let count = 0;
// after Ctrl+T: the answer is read and a line break printed, as git does before it signs in, and nothing more
let working = false;
process.stdout.write("\\x1b[2J\\x1b[HPassword:");
process.stdin.on("data", chunk => {
  const text = chunk.toString();
  if (text === "\\x10") { count = 0; process.stdout.write("\\x1b[2J\\x1b[HEnter passphrase for key '/tmp/my private key for testing':"); return; }
  if (text === "\\x0e") { count = 0; process.stdout.write("\\x1b[2J\\x1b[HPassword for 'https://alice@github.com':"); return; }
  if (text === "\\x0f") { count = 0; process.stdout.write("\\x1b[2J\\x1b[HEnter passphrase (empty for no passphrase):"); return; }
  if (text === "\\x14") { count = 0; working = true; process.stdout.write("\\x1b[2J\\x1b[HPassword for 'https://alice@github.com':"); return; }
  // a prompt whose colon fills the row's last column: the space after it wraps, and the cursor is on the next row
  if (text === "\\x15") { count = 0; process.stdout.write("\\x1b[2J\\x1b[HPassword for " + "a".repeat(process.stdout.columns - 14) + ": "); return; }
  // a script's prompt, printed with its line break and read below it (echo "Password:"; read -s)
  if (text === "\\x16") { count = 0; process.stdout.write("\\x1b[2J\\x1b[HPassword:\\r\\n"); return; }
  if (text === "\\x03") { count = 0; process.stdout.write("\\r\\nCancelled>"); return; }
  count += text.length;
  if (text.includes("\\r")) { writeFileSync(${JSON.stringify(result)}, String(count)); count = 0; process.stdout.write(working ? "\\r\\n" : "\\r\\nAccepted\\r\\nReady>"); working = false; }
});
`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await context.addInitScript((pane) => {
      localStorage.setItem(`ovis:view:${pane}`, "terminal");
      const Native = window.WebSocket;
      const sockets = new Set<WebSocket>();
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.add(this); }
      };
      (window as any).dropTestSockets = () => { for (const socket of sockets) socket.close(); };
    }, pane);
    await paneSendText(pane, `exec '${Bun.which("node")}' '${script}'\n`);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    const sent: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "secret-result" && !frame.ok) console.error("Secret fixture refusal:", frame.code);
      });
      socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (["secret", "submit", "input"].includes(frame.type)) sent.push(frame.type);
      // Never retain payloads in browser-test logs either.
      });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    const field = page.getByLabel("Password or PIN", { exact: true });
    await field.waitFor();
    assert.equal(await field.getAttribute("type"), "password");
    assert.equal(await page.locator(".terminal-input").count(), 0);
    await page.locator(".pane-frame.is-current").focus();
    await page.keyboard.press("ControlOrMeta+Shift+E");
    assert.equal(await field.evaluate(node => node === document.activeElement), true, "focus prefers the mounted masked-input field");
    assert.deepEqual(sent, [], "focusing masked input does not send a secret or terminal input");
    await field.fill("fixture-secret");
    assert.equal(await field.evaluate((element) => element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }))), false);
    assert.equal(await page.locator("body").innerText().then((text) => text.includes("fixture-secret")), false);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes("fixture-secret")), false);
    await page.getByTitle(/^Chat transcript \(.+\)$/).click();
    await field.waitFor();
    // the same field across the lens switch: a remount would have dropped what was typed
    assert.equal(await field.inputValue(), "fixture-secret", "switching lenses keeps the masked input mounted");
    await page.getByText("Loading conversation…", { exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("textbox", { name: "Message", exact: true }).count(), 0);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "secret-input-mobile.png") });
    }
    // A dropped connection must discard the DOM value even if it reconnects before the 1s poll.
    await page.evaluate(() => (window as any).dropTestSockets());
    await page.waitForFunction(() => (document.querySelector('.secret-input input') as HTMLInputElement | null)?.value === "");
    assert.deepEqual(sent, []);
    await field.fill("fixture-secret");
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      delete (document as any).hidden;
    });
    assert.equal(await field.inputValue(), "");
    await field.fill("fixture-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await field.waitFor({ state: "detached" });
    /** The fixture took one line of that many characters, Enter counted. */
    const accepted = async (value: string): Promise<void> => {
      const deadline = Date.now() + 5000;
      while (!existsSync(result)) { if (Date.now() > deadline) throw new Error("Masked input never reached fixture"); await Bun.sleep(25); }
      assert.equal(readFileSync(result, "utf8"), String(`${value}\r`.length));
    };
    await accepted("fixture-secret");
    assert.deepEqual(sent, ["secret"]);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes("fixture-secret")), false);
    assert.equal(await page.locator("body").innerText().then((text) => text.includes("fixture-secret")), false);
    // A new request is empty; Cancel sends only Ctrl+C.
    await paneSendText(pane, "\u0010");
    await field.waitFor();
    assert.equal(await field.inputValue(), "");
    await field.fill("wrapped-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await field.waitFor({ state: "detached" });
    assert.deepEqual(sent, ["secret", "secret"]);
    // git's HTTPS password, a prompt of the wider set (the server says secret-prompts-2): masked like the others,
    // the input line gone, and sent as a secret
    rmSync(result, { force: true });
    await paneSendText(pane, "\u000e");
    await field.waitFor();
    assert.equal(await page.locator(".terminal-input").count(), 0);
    await field.fill("git-token-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await field.waitFor({ state: "detached" });
    await accepted("git-token-secret");
    assert.deepEqual(sent, ["secret", "secret", "secret"]);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage }).includes("git-token-secret")), false);
    // ssh-keygen's offer of no passphrase: the empty field is an answer there, and the program gets Enter alone
    rmSync(result, { force: true });
    await paneSendText(pane, "\u000f");
    await field.waitFor();
    assert.equal(await field.inputValue(), "");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await field.waitFor({ state: "detached" });
    await accepted("");
    assert.deepEqual(sent, ["secret", "secret", "secret", "secret"]);
    // A program that read its answer and works on, its prompt still the last text on the screen, asks no more: the
    // field leaves, so a second Send cannot wait in the terminal for what comes next
    rmSync(result, { force: true });
    await paneSendText(pane, "\u0014");
    await field.waitFor();
    await field.fill("git-token-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await accepted("git-token-secret");
    await field.waitFor({ state: "detached" });
    assert.match((await paneRead({ paneId: pane, source: "visible", format: "text" })).text.trimEnd(), /Password for 'https:\/\/alice@github\.com':$/, "the prompt is still the last text");
    assert.deepEqual(sent, ["secret", "secret", "secret", "secret", "secret"]);
    // A prompt as wide as the pane, its last space wrapped onto the next row: herdr draws the two rows apart, and
    // the cursor past that space is still the prompt asking
    rmSync(result, { force: true });
    await paneSendText(pane, "\u0015");
    await field.waitFor();
    await field.fill("edge-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await field.waitFor({ state: "detached" });
    await accepted("edge-secret");
    assert.deepEqual(sent, ["secret", "secret", "secret", "secret", "secret", "secret"]);
    // A prompt printed with its line break and answered on the row below: the cursor was never on it, so it asks
    rmSync(result, { force: true });
    await paneSendText(pane, "\u0016");
    await field.waitFor();
    await field.fill("below-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Send", exact: true }).click();
    await field.waitFor({ state: "detached" });
    await accepted("below-secret");
    assert.deepEqual(sent, ["secret", "secret", "secret", "secret", "secret", "secret", "secret"]);
    await paneSendText(pane, "\u0010");
    await field.waitFor();
    await page.getByTitle(/^Live terminal \(.+\)$/).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "secret-input-desktop.png") });
    await field.fill("discarded-secret");
    await page.locator(".secret-input").getByRole("button", { name: "Cancel", exact: true }).click();
    await field.waitFor({ state: "detached" });
    assert.deepEqual(sent, ["secret", "secret", "secret", "secret", "secret", "secret", "secret", "input"]);
    assert.deepEqual(errors, []);
    // On a desktop (no key bar, which a touch screen hides while the masked input is up) the masked
    // input floats over the grid's last rows: its arrival leaves the grid's height, the shared pty's
    // size, alone, whether the pane types straight into the grid or through the input line.
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      await desktop.addInitScript((pane) => {
        localStorage.setItem(`ovis:view:${pane}`, "terminal");
        const Native = window.WebSocket;
        const sockets = new Set<WebSocket>();
        window.WebSocket = class extends Native {
          constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); sockets.add(this); }
        };
        (window as any).dropTestSockets = () => { for (const socket of sockets) socket.close(); };
      }, pane);
      for (const mode of ["direct", "line"] as const) {
        const view = await desktop.newPage();
        view.setDefaultTimeout(10_000);
        await view.addInitScript((mode) => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: mode })); }, mode);
        await view.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
        await view.locator(".pane-terminal .xterm-screen").waitFor();
        if (mode === "line") await view.getByRole("textbox", { name: "Terminal input line", exact: true }).waitFor();
        const frame = () => view.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const gridHeight = () => view.locator(".pane-terminal").evaluate((element) => element.getBoundingClientRect().height);
        await view.evaluate(() => {
          (window as any).gridResized = 0;
          let first = true;
          new ResizeObserver(() => { if (first) first = false; else (window as any).gridResized += 1; }).observe(document.querySelector(".pane-terminal")!);
        });
        await frame();
        const resting = await gridHeight();
        await paneSendText(pane, "\u0010");
        const masked = view.getByLabel("Password or PIN", { exact: true });
        await masked.waitFor();
        await frame();
        assert.equal(await gridHeight(), resting, `the masked input keeps the grid's height (${mode} input)`);
        assert.equal(await view.evaluate(() => (window as any).gridResized), 0, `the grid's observer never fired (${mode} input)`);
        if (mode === "direct") {
          // A desktop answers the prompt in the grid itself, as in any terminal (#1031): the keys go
          // to the program while the masked input stands by. Regression: on a build that disables
          // stdin for the prompt, the fixture never gets them.
          await view.locator(".pane-terminal .xterm-screen").click();
          await view.keyboard.type("typed-secret");
          await view.keyboard.press("Enter");
          const typedBy = Date.now() + 5000;
          while (readFileSync(result, "utf8") !== String("typed-secret\r".length)) {
            if (Date.now() > typedBy) throw new Error("regression: the grid did not take the typed secret while the masked input was up");
            await Bun.sleep(25);
          }
          await masked.waitFor({ state: "detached" });
          // control: typed into the pty only, never into a draft or the page
          assert.equal(await view.evaluate(() => JSON.stringify({ ...localStorage }).includes("typed-secret")), false);
          assert.equal(await view.locator("body").innerText().then((text) => text.includes("typed-secret")), false);
          assert.equal(await view.locator(".terminal-banner-draft").count(), 0);
          // Offline, a secret keystroke is refused with a note, never held for later like other
          // typing (regression: the note; control: nothing held, nothing delivered afterwards).
          await paneSendText(pane, "\u0010");
          await masked.waitFor();
          await desktop.setOffline(true);
          await view.evaluate(() => (window as any).dropTestSockets());
          await masked.waitFor({ state: "detached" });
          await view.locator(".pane-terminal .xterm-screen").click();
          await view.keyboard.type("offline-secret");
          await view.keyboard.press("Enter");
          await view.locator(".terminal-banner", { hasText: "Not sent: the terminal is not ready, and a password is never held for later." }).waitFor();
          assert.equal(await view.evaluate(() => JSON.stringify({ ...localStorage }).includes("offline-secret")), false);
          assert.equal(await view.locator(".terminal-banner-draft").count(), 0);
          assert.equal(await view.locator(".draft-held").count(), 0);
          await desktop.setOffline(false);
          await masked.waitFor();
          assert.equal(await view.locator(".terminal-banner-draft").count(), 0, "nothing typed offline is held for the reconnect");
          assert.equal(readFileSync(result, "utf8"), String("typed-secret\r".length), "nothing typed offline reached the program");
        }
        await view.locator(".secret-input").getByRole("button", { name: "Cancel", exact: true }).click();
        await masked.waitFor({ state: "detached" });
        await view.close();
      }
    } finally { await desktop.close(); }
    console.log("PASS masked secret input: both lenses, no drafts/queue/echo, disconnect, background and cancel");
  } finally { await context.close(); await workspaceClose(created.workspace.workspace_id); rmSync(root, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const root = mkdtempSync(join(tmpdir(), "herdr-secret-browser-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: root });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try { await checkSecretInput(browser, `http://127.0.0.1:${server.port}`); }
  finally { await browser.close(); server.stop(); rmSync(root, { recursive: true, force: true }); }
}
