import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { composerFitDemo } from "./composer-fit-harness.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";
import { SUPPORTED_ENTRIES } from "../src/lib/themes.ts";

// Sending from the message box, on the demo app as scripts/composer-fit-harness.ts patches it: the
// send key, an immediate message's paste framing, a held receipt, and Send pressed while the
// keyboard still composes a word.
const app = mkdtempSync(join(tmpdir(), "herdr-composer-fit-demo-"));
try {
  const { server, url, withCard } = await composerFitDemo(app);
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
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
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
