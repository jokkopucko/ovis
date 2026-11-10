import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paneRead, paneSendKeys } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, label);
    await Bun.sleep(25);
  }
}

/** Mac keyboard events, then real readline cursor positions in an owned test pane. */
export async function checkCommandArrows(browser: Browser, origin: string, paneId: string): Promise<void> {
  for (const platform of ["MacIntel", "Linux x86_64", "Win32"]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 650 } });
    await context.addInitScript(({ platform, paneId }) => {
      Object.defineProperty(navigator, "platform", { get: () => platform });
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`ovis:view:${paneId}`, "terminal");
    }, { platform, paneId });
    try {
      const page = await context.newPage();
      const inputs: Array<{ pane_id: string; text: string }> = [];
      let ready = false;
      page.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "input-ready" && message.pane_id === paneId) ready = message.ready !== false;
        });
        socket.on("framesent", ({ payload }) => {
          const message = JSON.parse(String(payload));
          if (message.type === "input") inputs.push({ pane_id: message.pane_id, text: message.text });
        });
      });
      await page.goto(`${origin}/?pane=${encodeURIComponent(paneId)}`);
      await until(() => ready, "owned terminal must accept input");
      const input = page.locator(".xterm-helper-textarea");
      // Let deferred IME sends run, then use a WS marker to bound both positive and negative assertions.
      const check = async (action: () => Promise<unknown>, expected: string[], label: string) => {
        const before = inputs.length;
        await action();
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await input.press("Control+g");
        await until(() => inputs.slice(before).some(({ text }) => text === "\x07"), "input marker must arrive");
        assert.deepEqual(inputs.slice(before), [...expected, "\x07"].map((text) => ({ pane_id: paneId, text })), label);
      };
      const mac = platform === "MacIntel";
      for (const [key, code, sequence] of [["ArrowLeft", 37, "\x01"], ["ArrowRight", 39, "\x05"]] as const) {
        const final = key === "ArrowLeft" ? "D" : "C";
        await check(() => input.press(`Meta+${key}`), mac ? [sequence] : [], `${platform} Cmd+${key}`);
        // Ctrl+arrow is the pane's own key on every platform: tmux and editors bind it
        await check(() => input.press(`Control+${key}`), [`\x1b[1;5${final}`], `${platform} Ctrl+${key} reaches the pane as itself`);
        if (!mac) continue;
        for (const modifier of ["Shift", "Alt", "Control"]) {
          await check(() => input.press(`Meta+${modifier}+${key}`), [], `Cmd+${modifier}+${key} stays native`);
        }
        for (const [modifier, modifiers] of [["Shift", 6], ["Alt", 7]] as const) {
          await check(() => input.press(`Control+${modifier}+${key}`), [`\x1b[1;${modifiers}${final}`], `Ctrl+${modifier}+${key} stays native`);
        }
        for (const composition of [{ isComposing: true, keyCode: code }, { isComposing: false, keyCode: 229 }]) {
          await check(() => input.dispatchEvent("keydown", {
            key, code: key, metaKey: true, ...composition, bubbles: true, cancelable: true,
          }), [], "active IME keys retain xterm's behavior without remapping");
        }
        await check(() => input.evaluate(async (element, { key, code }) => {
          const textarea = element as HTMLTextAreaElement;
          textarea.value = "";
          textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
          textarea.value = "한";
          textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "한", bubbles: true }));
          const event = { key, code: key, keyCode: code, which: code, metaKey: true, bubbles: true, cancelable: true };
          textarea.dispatchEvent(new KeyboardEvent("keydown", event));
          textarea.dispatchEvent(new KeyboardEvent("keyup", event));
        }, { key, code }), ["한", sequence], "pending IME text must precede cursor movement exactly once");
        await check(() => input.evaluate((element, { key, code }) => {
          const event = new KeyboardEvent("keydown", {
            key, code: key, keyCode: code, which: code, metaKey: true, repeat: true, bubbles: true, cancelable: true,
          });
          element.dispatchEvent(event);
          if (!event.defaultPrevented) throw new Error("Cmd+arrow must prevent the browser's navigation default");
        }, { key, code }), [sequence], "held Cmd+arrow repeats once per keydown");
      }
      if (!mac) { console.log(`PASS ${platform} Meta/Ctrl+arrows stay native`); continue; }

      const fixture = mkdtempSync(join(tmpdir(), "herdr-command-arrows-"));
      const result = join(fixture, "cursor.json");
      const script = join(fixture, "readline.cjs");
      writeFileSync(script, `const fs = require("node:fs");
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => process.exit(0));
process.stdout.write("\\x1b[2J\\x1b[HOwned macOS Cmd+Left / Cmd+Right test\\r\\n");
process.stdin.on("data", (data) => {
  if (data.includes(7)) fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ line: rl.line, cursor: rl.cursor }));
});
`);
      try {
        // Keep cleanup and launch behind the earlier browser keystrokes on the same input stream.
        // Those left text on the prompt line: Cmd+Right and Cmd+Backspace (Ctrl+E, Ctrl+U) empty it as
        // keys, read in order with the command. Ctrl+C is a signal: when the command is there before
        // bash handles it, bash runs the line without its first byte.
        await input.press("Meta+ArrowRight");
        await input.press("Meta+Backspace");
        await input.pressSequentially(`node '${script.replaceAll("'", "'\\''")}'`);
        await input.press("Enter");
        await until(async () => (await paneRead({ paneId, source: "visible" })).text.includes("Owned macOS Cmd+Left"), "readline fixture must start");
        const probe = async (line: string, cursor: number) => {
          await input.press("Control+g");
          await until(() => {
            if (!existsSync(result)) return false;
            try { const actual = JSON.parse(readFileSync(result, "utf8")); return actual.line === line && actual.cursor === cursor; }
            catch { return false; }
          }, `readline must contain ${JSON.stringify(line)} with cursor ${cursor}`);
        };
        await input.pressSequentially("middle");
        await probe("middle", 6);
        await input.press("Meta+ArrowLeft");
        await probe("middle", 0);
        await input.pressSequentially("start ");
        await probe("start middle", 6);
        await input.press("Meta+ArrowRight");
        await probe("start middle", 12);
        await input.pressSequentially(" end");
        await probe("start middle end", 16);
        if (process.env.UI_EVIDENCE_DIR) {
          mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
          await page.locator(shownRows(), { hasText: "start middle end" }).waitFor();
          await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "macos-command-arrows.png") });
        }
        // Normal arrows, Option word movement and Ctrl+arrows as xterm sends them work in DECCKM mode.
        await input.press("ArrowLeft"); await probe("start middle end", 15);
        await input.press("ArrowRight"); await probe("start middle end", 16);
        await input.press("Alt+ArrowLeft"); await probe("start middle end", 13);
        await input.press("Alt+ArrowRight"); await probe("start middle end", 16);
        await input.press("Control+ArrowLeft"); await probe("start middle end", 13);
        await input.press("Control+ArrowLeft"); await probe("start middle end", 6);
        await input.press("Control+ArrowLeft"); await probe("start middle end", 0);
        await input.press("Control+ArrowRight"); await probe("start middle end", 6);
        await input.press("Control+ArrowRight"); await probe("start middle end", 13);
        await input.press("Control+ArrowRight"); await probe("start middle end", 16);
      } finally {
        await paneSendKeys(paneId, ["ctrl+c"]);
        rmSync(fixture, { recursive: true, force: true });
      }
      console.log("PASS macOS Cmd+Left/Right moves to readline boundaries; normal and word arrows still work");
      console.log("PASS Cmd+arrows preserve IME order and modifiers, suppress browser navigation and handle repeats; Ctrl+arrows reach the pane unchanged");
    } finally { await context.close(); }
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { UsageService } = await import("../server/usage.ts");
  const { chromium } = await import("playwright-core");
  const root = mkdtempSync(join(tmpdir(), "herdr-command-arrows-qa-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", usage: new UsageService(undefined, []) });
  let browser: Browser | undefined;
  let workspace: string | undefined;
  try {
    const made = await workspaceCreate({ cwd: root, label: "ovis-test-command-arrows" });
    workspace = made.workspace.workspace_id;
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    await checkCommandArrows(browser, `http://127.0.0.1:${server.port}`, made.root_pane.pane_id);
  } finally {
    await browser?.close(); server.stop();
    if (workspace) await workspaceClose(workspace);
    rmSync(root, { recursive: true, force: true });
  }
}
