/** Arrows and clicks reach a full-screen program: browser → WS → herdr → a raw-mode PTY that logs its stdin (#621). */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { workspaceCreate, workspaceClose, paneSendText, paneSendKeys, paneRead, herdrRpc } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "herdr-arrows-clicks-"));
const owned: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];
let launched: Browser | undefined;
const errors: string[] = [];
const evidence = process.env.UI_EVIDENCE_DIR;
if (evidence) mkdirSync(evidence, { recursive: true });
const probe = resolve("scripts/fixtures/modifier-probe.py");

async function until(check: () => boolean | Promise<boolean>, label: string | (() => string)): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `timed out: ${typeof label === "string" ? label : label()}`);
    await Bun.sleep(20);
  }
}

interface Session {
  page: Page;
  pane: string;
  frames: Array<{ type: string; text?: string; keys?: string[] }>;
  /** what the program in the pane has read since the last call */
  received: () => string;
  /** a point of the grid, in page pixels from its top left corner */
  point: (x: number, y: number) => Promise<{ x: number; y: number }>;
  close: () => Promise<void>;
}

/**
 * Waits until xterm reports the mouse, as herdr's attach asks it to: until then a press is a plain
 * selection that the page never hands on as a click. The attach's first output can be parsed after
 * the pane says it takes input.
 */
async function mouseReporting(s: Session): Promise<void> {
  await s.page.locator(".xterm.enable-mouse-events").waitFor();
}

/** the letter `mark` types: no step below types it otherwise */
const MARK = "z";

/**
 * Proves what an action sent, nothing included, without waiting a set time for what must not come:
 * types a letter after it and waits until the program has read the letter and its frame is reported.
 * Anything the action sent went out first, on the same socket and through the same pty (or, on a
 * mirror, the same queue of herdr writes), so the program read it first and its frame came first.
 * `frames` are the ones reported from index `from` up to the mark's.
 */
async function mark(s: Session, label: string, from = s.frames.length): Promise<{ read: string; frames: Session["frames"] }> {
  await s.page.locator(".xterm-helper-textarea").focus();
  await s.page.keyboard.press(MARK);
  let read = "";
  await until(() => (read += s.received()).includes(MARK), () => `${label}: the mark received (read ${JSON.stringify(read)})`);
  assert.equal(read.slice(read.indexOf(MARK)), MARK, `${label}: nothing read after the mark`);
  const at = () => s.frames.findIndex((frame, i) => i >= from && frame.type === "input" && frame.text === MARK);
  await until(() => at() >= 0, `${label}: the mark's frame reported`);
  return { read: read.slice(0, -MARK.length), frames: s.frames.slice(from, at()) };
}

/** A pane of its own running the stdin logger after `modes` were set, shown in a desktop browser; herdr reports `agent` in it. */
async function open(browser: Browser, server: ReturnType<typeof createServer>, name: string, modes: string, agent?: string): Promise<Session> {
  const cwd = join(root, name);
  mkdirSync(cwd);
  const made = await workspaceCreate({ cwd, label: `ovis-test-arrows-clicks-${name}` });
  owned.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const log = join(root, `${name}.hex`);
  await paneSendText(pane, `clear; printf '${modes}'; python3 -u '${probe}' '${log}' plain`);
  await paneSendKeys(pane, ["Enter"]);
  await until(async () => (await paneRead({ paneId: pane, source: "visible" })).text.includes("PROBE READY plain"), `${name}: raw probe ready`);
  if (agent) await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent, state: "idle" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ pane }) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
  }, { pane });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  const frames: Session["frames"] = [];
  let ready = false;
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.pane_id === pane && (message.type === "input" || message.type === "keys")) frames.push(message);
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "error") console.log(`${name}: terminal error`, message);
      if (message.type === "input-ready" && message.pane_id === pane) ready = message.ready !== false;
    });
  });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  await until(() => ready, `${name}: terminal accepts input`);
  await page.locator(".xterm-screen").waitFor();
  let read = 0;
  return {
    page, pane, frames,
    received: () => {
      const all = existsSync(log) ? readFileSync(log, "utf8") : "";
      const fresh = all.slice(read);
      read = all.length;
      return Buffer.from(fresh, "hex").toString("latin1");
    },
    point: async (x, y) => {
      const box = (await page.locator(".xterm-screen").boundingBox())!;
      return { x: box.x + x, y: box.y + y };
    },
    close: () => context.close(),
  };
}

try {
  const attached = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state-attached"), token: "" });
  servers.push(attached);
  // a PC without Node for the PTY sidecar: the pane is mirrored, and xterm never learns a mouse mode
  const mirrored = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "state-mirrored"), token: "", sidecar: false });
  servers.push(mirrored);
  const browser = launched = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });

  // 1. Application cursor keys: less, git log and vim ask for them, and herdr's attach stream
  // never says so to the browser. The program must read SS3 (ESC O A), not CSI (ESC [ A).
  {
    const s = await open(browser, attached, "decckm", "\\033[?1049h\\033[?1h");
    const input = s.page.locator(".xterm-helper-textarea");
    await input.focus();
    const arrows = [["ArrowUp", "A", "up"], ["ArrowDown", "B", "down"], ["ArrowRight", "C", "right"], ["ArrowLeft", "D", "left"]] as const;
    const before = s.frames.length;
    for (const [key, final] of arrows) {
      let got = "";
      await s.page.keyboard.press(key);
      await until(() => (got += s.received()).length >= 3, `decckm ${key} received`);
      assert.equal(got, `\x1bO${final}`, `${key} in application cursor mode`);
    }
    // Playwright reports a sent frame some time after it left, even after the program has read it:
    // the mark's frame comes after every arrow's, a duplicate's included
    const after = await mark(s, "decckm", before);
    assert.equal(after.read, "", "no arrow arrives twice");
    assert.deepEqual(after.frames, arrows.map(([, , name]) => ({ type: "keys", pane_id: s.pane, keys: [name] })), "each arrow is one named key, sent once");
    if (evidence) await s.page.screenshot({ path: join(evidence, "arrows-decckm.png") });
    await s.close();
  }

  // 2. Normal cursor mode (a shell's line editor), and typing around an arrow keeps its order:
  // the arrow goes through herdr, the letters would otherwise overtake it on the pty.
  {
    const s = await open(browser, attached, "normal", "\\033[?1049h");
    const input = s.page.locator(".xterm-helper-textarea");
    await input.focus();
    // An arrow goes through herdr's RPC, around the attach pty the letter before it was typed into.
    // herdr has no barrier for bytes in that pty, so the server holds the arrow KEY_SETTLE_MS after the
    // letter (TYPED_SETTLE_MS after an ESC, which herdr holds ~150ms): a margin, not an
    // acknowledgement (#634), which a stall on a busy PC outlasts. server/core/key-settle.test.ts
    // proves the hold with the shipped settle values; here the letter is read before its arrow is
    // pressed. A letter typed while the arrow waits goes behind it in the pane's queue, which is order
    // by construction: pressed at once.
    let got = "";
    for (let round = 0; round < 5; round += 1) {
      await s.page.keyboard.press("a");
      await until(() => (got += s.received()).length >= round * 5 + 1, "a letter received");
      await s.page.keyboard.press("ArrowLeft");
      await s.page.keyboard.press("b");
      await until(() => (got += s.received()).length >= round * 5 + 5, "an arrow and the letter after it received");
    }
    assert.equal(got, "a\x1b[Db".repeat(5), "an arrow between two letters arrives between them");
    // Diagnostic only: a letter, an arrow and a letter pressed at once, where only the settle margin
    // keeps the arrow behind the first letter. Logged, not asserted. The first letter goes through the
    // attach pty and the rest may go through herdr, so no mark typed after them can vouch for it: all
    // five bytes are read, in whatever order, before the next step.
    let together = "";
    await s.page.keyboard.press("a");
    await s.page.keyboard.press("ArrowLeft");
    await s.page.keyboard.press("b");
    await until(() => (together += s.received()).length >= 5, () => `a, ArrowLeft and b at once received (read ${JSON.stringify(together)})`);
    console.log(`a, ArrowLeft and b pressed at once arrived ${together === "a\x1b[Db" ? "in order" : `as ${JSON.stringify(together)}: the arrow outran the settle margin`}`);
    got = "";
    await s.page.keyboard.press("Escape");
    await until(() => (got += s.received()).length >= 1, "Escape received");
    await s.page.keyboard.press("ArrowUp");
    await until(() => (got += s.received()).length >= 4, "ArrowUp received");
    assert.equal(got, "\x1b\x1b[A", "an arrow after an Escape arrives after it");
    // Ctrl+arrow and Shift+arrow were never plain arrows: they keep the path they had. The earlier
    // keys' frames, which Playwright may report late, are all reported once a mark's is.
    assert.equal((await mark(s, "the keys before Ctrl+ArrowLeft")).read, "", "nothing more after the Escape and ArrowUp");
    const before = s.frames.length;
    await s.page.keyboard.press("Control+ArrowLeft");
    const chord = await mark(s, "Ctrl+ArrowLeft", before);
    assert.equal(chord.read, "\x1b[1;5D", "Ctrl+ArrowLeft received once");
    assert.deepEqual(chord.frames, [{ type: "input", pane_id: s.pane, text: "\x1b[1;5D" }]);
    // Alt+arrow moves a word as Ctrl+arrow does off a Mac (ESC b on one): xterm.js 5.5's mapping,
    // which 6.0 dropped (xterm.js #5346) and the patch keeps
    const altBefore = s.frames.length;
    // xterm's own platform test (navigator.platform), not the host's
    const altLeft = await s.page.evaluate(() => /Mac/.test(navigator.platform)) ? "\x1bb" : "\x1b[1;5D";
    await s.page.keyboard.press("Alt+ArrowLeft");
    assert.equal((await mark(s, "Alt+ArrowLeft", altBefore)).read, altLeft, "Alt+ArrowLeft moves a word");

    // A held arrow: keyboard autorepeat (~30/s) with letters typed between some of the repeats.
    // Every key must arrive in order within the bounded delivery wait below. The repeat after a
    // letter waits for the letter to be read, as the arrow after a letter does above.
    // Keep the autorepeat pacing; shared-runner latency is diagnostic, not a correctness threshold.
    const tokens: Array<{ text: string; sent: number; arrived?: number }> = [];
    let buffer = "";
    const poll = setInterval(() => {
      buffer += s.received();
      let done = tokens.findIndex((token) => token.arrived === undefined);
      while (done >= 0 && done < tokens.length && buffer.startsWith(tokens[done]!.text)) {
        buffer = buffer.slice(tokens[done]!.text.length);
        tokens[done]!.arrived = performance.now();
        done += 1;
      }
    }, 2);
    const REPEAT_MS = 33;
    try {
      // ArrowDown stays down: each further keydown is an autorepeat; a letter is typed between some repeats
      let due = performance.now();
      for (let i = 0; i < 60; i += 1) {
        // fixed wait: the autorepeat rate is the input under test
        while (performance.now() < due) await Bun.sleep(1);
        due += REPEAT_MS;
        tokens.push({ text: "\x1b[B", sent: performance.now() });
        await s.page.keyboard.down("ArrowDown");
        if (i % 7 === 3) {
          const letter = tokens.push({ text: "x", sent: performance.now() }) - 1;
          await s.page.keyboard.press("x");
          await until(() => tokens[letter]!.arrived !== undefined, () => `a letter between held repeats received in order (left over ${JSON.stringify(buffer)})`);
          due = Math.max(due, performance.now());
        }
      }
      await s.page.keyboard.up("ArrowDown");
      // a key out of order stops the matching above, so this times out with the rest still waiting
      await until(() => tokens.every((token) => token.arrived !== undefined), "every held key received in order").catch((error) => {
        console.log("held keys received:", tokens.filter((token) => token.arrived !== undefined).length, "of", tokens.length, "left over:", JSON.stringify(buffer));
        throw error;
      });
      assert.equal(buffer, "", "nothing out of order or extra");
    } finally {
      clearInterval(poll);
    }
    const latencies = tokens.map((token) => token.arrived! - token.sent).sort((a, b) => a - b);
    const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]!;
    console.log(`held arrow (60 keys at ${REPEAT_MS} ms, letters between): key to program p50 ${at(0.5).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${latencies.at(-1)!.toFixed(1)} ms`);

    // Repeats far faster than herdr answers: 200 keydowns in one burst. They arrive complete and in
    // order, a letter between them included, and the keys still waiting join one RPC instead of each
    // queueing its own, so the burst drains in about as long as a few RPCs take.
    let burst = "";
    const burstStart = performance.now();
    await s.page.locator(".xterm-helper-textarea").evaluate((element) => {
      for (let i = 0; i < 200; i += 1) {
        element.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, repeat: i > 0, bubbles: true, cancelable: true }));
        // a keypress alone: a synthetic keydown would type the letter a second time
        if (i === 100) element.dispatchEvent(new KeyboardEvent("keypress", { key: "y", code: "KeyY", charCode: 121, keyCode: 121, bubbles: true, cancelable: true }));
      }
    });
    const expected = "\x1b[B".repeat(101) + "y" + "\x1b[B".repeat(99);
    await until(() => (burst += s.received()).length >= expected.length, "the burst arrives");
    console.log(`burst of 200 repeats: drained in ${(performance.now() - burstStart).toFixed(1)} ms; letter after arrow ${burst.slice(0, burst.indexOf("y")).split("\x1b[B").length - 1}, arrows ${burst.split("\x1b[B").length - 1}, other ${JSON.stringify(burst.replaceAll("\x1b[B", ""))}`);
    burst += (await mark(s, "the burst")).read;
    assert.equal(burst, expected, "the burst arrives complete and in order");

    // a program that did not ask for the mouse gets nothing from a click (herdr keeps it)
    await mouseReporting(s);
    const box = (await s.page.locator(".xterm-screen").boundingBox())!;
    await s.page.mouse.click(box.x + 120, box.y + 90);
    assert.equal((await mark(s, "a click without mouse mode")).read, "", "a click reaches no program that did not turn the mouse on");
    await s.close();
  }

  // 3. A click reaches a program that reads the mouse; a drag and a modifier-click still select.
  {
    const s = await open(browser, attached, "mouse", "\\033[?1049h\\033[?1000h\\033[?1006hhttps://example.test/621 notes.md\\r\\n");
    writeFileSync(join(root, "mouse", "notes.md"), "# Notes\n");
    const at = await s.point(100, 70);
    await mouseReporting(s);
    let got = "";
    const click = /\x1b\[<0;(\d+);(\d+)M[\s\S]*\x1b\[<0;(\d+);(\d+)m/;
    await s.page.mouse.click(at.x, at.y);
    await until(() => click.test(got += s.received()), "left click received as press and release");
    const first = click.exec(got)!;
    assert.deepEqual([first[3], first[4]], [first[1], first[2]], "the release is at the press's cell");
    assert.equal((got.match(/\x1b\[<0;\d+;\d+M/g) ?? []).length, 1, "one press for one click");
    assert.equal((got.match(/\x1b\[<0;\d+;\d+m/g) ?? []).length, 1, "one release for one click");
    if (evidence) await s.page.screenshot({ path: join(evidence, "click-mouse-reporting.png") });

    // a link opens and is not clicked in the program as well
    await s.page.evaluate(() => {
      const opened: unknown[] = [];
      (window as unknown as { opened: unknown[] }).opened = opened;
      window.open = (url, target, features) => { opened.push(["window.open", String(url), target, features]); return null; };
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { opened.push(["link", this.href, this.target, this.rel]); };
    });
    const link = await s.point(40, 6);
    await s.page.mouse.move(link.x, link.y);
    await until(async () => (await s.page.locator(".xterm-screen.xterm-cursor-pointer").count()) === 1, "the link is under the pointer");
    await s.page.mouse.click(link.x, link.y);
    assert.doesNotMatch((await mark(s, "a link click")).read, /\x1b\[<0;/, "a click on a link sends the program no button");
    // in a new tab, as a chat link: window.open with a features string ("noopener" too) opens a popup window
    assert.deepEqual(await s.page.evaluate(() => (window as unknown as { opened: unknown[] }).opened), [["link", "https://example.test/621", "_blank", "noopener noreferrer"]], "and opens the link once, in a new tab with no opener or referrer");

    // A bare file name follows the same rule, for its own click only (#1168). herdr's attach reports
    // the mouse for every pane, so nothing tells a program that wants Cmd/Ctrl+click from a shell:
    // a plain click on the name is the program's, as on any text, and Cmd+click (Ctrl+click off a
    // Mac), the key that draws the name as a link, opens it and sends the program no button.
    const name = await s.page.evaluate(() => {
      const row = document.querySelector(".xterm-rows > div")!;
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node as Text).data.indexOf("notes.md");
        if (at === -1) continue;
        const range = document.createRange();
        range.setStart(node, at + 2);
        range.setEnd(node, at + 3);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      throw new Error("notes.md is not on the first row");
    });
    await s.page.mouse.move(name.x, name.y);
    await until(async () => (await s.page.locator(".xterm-screen.xterm-cursor-pointer").count()) === 0, "a bare name is no link without the key");
    got = "";
    await s.page.mouse.click(name.x, name.y);
    await until(() => click.test(got += s.received()), "a plain click on a bare name received by the program");
    assert.equal(await s.page.locator(".file-viewer").count(), 0, "a plain click on a bare name opens nothing");
    const key = process.platform === "darwin" ? "Meta" : "Control";
    await s.page.keyboard.down(key);
    await until(async () => (await s.page.locator(".xterm-screen.xterm-cursor-pointer").count()) === 1, "the bare name is a link with the key held");
    await s.page.mouse.click(name.x, name.y);
    await s.page.keyboard.up(key);
    await s.page.locator(".modal.file-viewer").waitFor();
    await s.page.waitForFunction(() => document.querySelector(".file-viewer-header")?.textContent?.includes("notes.md"));
    await s.page.locator(".file-viewer-header button").last().click();
    await s.page.locator(".file-viewer").waitFor({ state: "hidden" });
    assert.doesNotMatch((await mark(s, "a key-click on a bare name")).read, /\x1b\[<\d+;/, "a key-click on a bare name sends the program no button");

    // the keys held with a click go with it: Ctrl adds 16 to the button
    await s.page.keyboard.down("Control");
    await s.page.mouse.click(at.x, at.y);
    await s.page.keyboard.up("Control");
    got = "";
    if (process.platform === "darwin") {
      // macOS emits a contextmenu for Control-click: it follows the pane menu's rules.
      const menu = s.page.getByRole("menu", { name: /^Pane actions for / });
      await menu.waitFor();
      await s.page.keyboard.press("Escape");
      await menu.waitFor({ state: "detached" });
      assert.doesNotMatch((await mark(s, "Mac Control-click")).read, /\x1b\[<(?:0|16);/, "Mac Control-click opens the menu without sending a button");
    } else {
      await until(() => /\x1b\[<16;\d+;\d+M[\s\S]*\x1b\[<16;\d+;\d+m/.test(got += s.received()), "Ctrl+click received with Ctrl");
    }

    // a later click still arrives at its own cell: none of the above left a drag behind
    const second = await s.point(400, 200);
    got = "";
    await s.page.mouse.click(second.x, second.y);
    await until(() => click.test(got += s.received()), "a later click received");
    const later = click.exec(got)!;
    assert.ok(Number(later[1]) > Number(first[1]) && Number(later[2]) > Number(first[2]), "at its own cell, right of and below the first");

    // the top right cell, under a lone pane's floating head: a program's control there (Claude Code's
    // diff panel close) takes the click, not the head around the hidden ellipsis
    const grid = (await s.page.locator(".xterm-screen").boundingBox())!;
    got = "";
    await s.page.mouse.click(grid.x + grid.width - 3, grid.y + 3);
    await until(() => click.test(got += s.received()), "a click on the top right cell received");
    const corner = click.exec(got)!;
    assert.equal(corner[2], "1", "on the top row");
    assert.ok(Number(corner[1]) > Number(later[1]), "in the rightmost column");

    // a drag is a selection, as before: no button report, and the dragged cells are selected
    const to = await s.point(300, 70);
    await s.page.mouse.move(at.x, at.y);
    await s.page.mouse.down();
    await s.page.mouse.move((at.x + to.x) / 2, at.y, { steps: 4 });
    await s.page.mouse.move(to.x, to.y, { steps: 4 });
    await s.page.mouse.up();
    await until(async () => (await s.page.locator(".xterm-selection div").count()) > 0, "a drag selects");
    assert.doesNotMatch((await mark(s, "a drag")).read, /\x1b\[<0;/, "a drag sends the program no button");

    // the selection modifier held by the user: a click that asks for selection is not the program's
    await s.page.keyboard.down("Shift");
    await s.page.mouse.click(at.x, at.y);
    await s.page.keyboard.up("Shift");
    assert.doesNotMatch((await mark(s, "Shift+click")).read, /\x1b\[<0;/, "Shift+click sends the program no button");

    await s.close();
  }

  // 4. OpenCode reads the mouse and selects inside the panel a drag starts in (#2362): a plain drag is
  // its own, as a click is, and the selection modifier still asks for the selection here.
  {
    const s = await open(browser, attached, "opencode", "\\033[?1049h\\033[?1000h\\033[?1002h\\033[?1006hchat column text | side panel\\r\\n", "opencode");
    // the page knows the pane's agent once its row is in the sidebar
    await s.page.locator(`.agent-item[data-pane="${s.pane}"]`).waitFor();
    await mouseReporting(s);
    const from = await s.point(20, 6);
    const to = await s.point(300, 60);
    /** a press where the pointer already is, dragged to `end` */
    const dragFromHere = async (start: { x: number; y: number }, end: { x: number; y: number }): Promise<void> => {
      await s.page.mouse.down();
      await s.page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 4 });
      await s.page.mouse.move(end.x, end.y, { steps: 4 });
      await s.page.mouse.up();
    };
    const dragged = async (): Promise<void> => {
      await s.page.mouse.move(from.x, from.y);
      await dragFromHere(from, to);
    };
    const drag = /\x1b\[<0;\d+;\d+M(?:[\s\S]*?\x1b\[<32;\d+;\d+M)+[\s\S]*?\x1b\[<0;(\d+);(\d+)m/;
    let got = "";
    await dragged();
    await until(() => drag.test(got += s.received()), () => `a plain drag received as press, moves and release (read ${JSON.stringify(got)})`);
    assert.equal(await s.page.locator(".xterm-selection div").count(), 0, "a plain drag selects nothing here");
    if (evidence) await s.page.screenshot({ path: join(evidence, "opencode-plain-drag.png") });

    // the selection modifier held by the user: the drag selects here and the program reads no button
    assert.equal((await mark(s, "the plain drag")).read, "", "nothing more after the plain drag");
    const selecting = await s.page.evaluate(() => /Mac/.test(navigator.platform)) ? "Alt" : "Shift";
    got = "";
    await s.page.keyboard.down(selecting);
    await dragged();
    await s.page.keyboard.up(selecting);
    await until(async () => (await s.page.locator(".xterm-selection div").count()) > 0, `${selecting}+drag selects`);
    if (evidence) await s.page.screenshot({ path: join(evidence, "opencode-modifier-drag.png") });

    // a plain drag over that selection is the program's again and the highlight goes. Nothing reaches
    // xterm in between: a key, or a buttonless move (a hover report), would clear the selection first,
    // so the press is where the modifier drag let go. The mark after it shows the modifier drag sent nothing.
    assert.ok((await s.page.locator(".xterm-selection div").count()) > 0, "the selection is still up when the plain drag starts");
    await dragFromHere(to, from);
    await until(() => drag.test(got += s.received()), () => `a plain drag after a selection received (read ${JSON.stringify(got)})`);
    await until(async () => (await s.page.locator(".xterm-selection div").count()) === 0, "the earlier selection is cleared");
    got += (await mark(s, `${selecting}+drag, then a plain drag`)).read;
    assert.equal((got.match(/\x1b\[<\d+;\d+;\d+M/g) ?? []).filter((report) => !report.startsWith("\x1b[<32;")).length, 1, `one press: the plain drag's, none from the ${selecting}+drag`);
    assert.equal((got.match(/\x1b\[<\d+;\d+;\d+m/g) ?? []).length, 1, `one release: the plain drag's, none from the ${selecting}+drag`);
    await s.close();
  }

  // 5. A mirrored pane: arrows are named keys there too, and a click sends nothing, since the
  // browser was never told the program reads the mouse and herdr has no pty to report it to.
  {
    const s = await open(browser, mirrored, "mirror", "\\033[?1049h\\033[?1h\\033[?1000h\\033[?1006h");
    const input = s.page.locator(".xterm-helper-textarea");
    await input.focus();
    let got = "";
    await s.page.keyboard.press("ArrowDown");
    await until(() => (got += s.received()).length >= 3, "mirrored ArrowDown received");
    assert.equal(got, "\x1bOB", "a mirrored pane's program reads the arrow in its own mode");
    const before = s.frames.length;
    const box = await s.page.locator(".xterm-screen").boundingBox();
    await s.page.mouse.click(box!.x + 80, box!.y + 60);
    const after = await mark(s, "a mirrored click", before);
    assert.deepEqual(after.frames.filter((frame) => frame.text?.startsWith("\x1b[<")), [], "a click on a mirrored pane sends nothing");
    assert.equal(after.read, "", "and the program reads nothing");
    await s.close();
  }

  assert.deepEqual(errors, [], "no page errors");
  console.log("terminal arrows and clicks: PASS");
} finally {
  // each step on its own: one that fails must not leave the rest behind
  await launched?.close().catch((error) => console.log("browser close failed", error));
  for (const server of servers) await Promise.resolve().then(() => server.stop()).catch((error) => console.log("server stop failed", error));
  for (const id of owned) await workspaceClose(id).catch((error) => console.log("workspace close failed", id, error));
  rmSync(root, { recursive: true, force: true });
}
