/** Input lifecycle adversarial cases, using an owned pane and intercepted submits. */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";

export async function checkTerminalInput(browser: Browser, origin: string, pane: string, otherPane: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await context.addInitScript(() => {
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
  });
  const sent: any[] = [];
  const resizes: any[] = [];
  let acknowledge: (() => void) | undefined;
  let refuse: (() => void) | undefined;
  // an Insert held here like a submit: the bridge's insert-result goes to the page only when the test says
  let acknowledgeInsert: (() => void) | undefined;
  let ready: (() => void) | undefined;
  let delayReady = false;
  let refuseConnections = false;
  let currentSocket: { close: () => Promise<void> } | undefined;
  // the page's latest connection, to play output the pane did not write (a keyboard mode it asks for)
  let toPage: ((frame: unknown) => void) | undefined;
  // liveness pings held back from the server, so a probe stays in flight until they are let through
  let holdPings = false;
  const heldPings: string[] = [];
  let toServer: ((raw: string) => void) | undefined;
  // the snapshot names what the bridge answers, pings among it; it can follow input-ready by a few ms
  let snapshotSent = false;
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    if (refuseConnections) { void socket.close(); return; }
    currentSocket = socket;
    toPage = (frame) => socket.send(JSON.stringify(frame));
    const server = socket.connectToServer();
    toServer = (raw) => server.send(raw);
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (delayReady && frame.type === "input-ready") ready = () => socket.send(raw);
      else socket.send(raw);
      if (frame.type === "snapshot") snapshotSent = true;
    });
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "submit") {
        sent.push(frame);
        acknowledge = () => socket.send(JSON.stringify({ type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok: true }));
        refuse = () => socket.send(JSON.stringify({ type: "submit-result", id: frame.id, pane_id: frame.pane_id, ok: false, code: "agent_blocked", message: "" }));
      } else if (frame.type === "insert") {
        sent.push(frame);
        acknowledgeInsert = () => socket.send(JSON.stringify({ type: "insert-result", id: frame.id, pane_id: frame.pane_id, ok: true }));
      } else if (frame.type === "input") sent.push(frame);
      else if (frame.type === "ping" && holdPings) heldPings.push(String(raw));
      else {
        if (frame.type === "resize") resizes.push(frame);
        server.send(raw);
      }
    });
  });
  const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
  // A desktop has no key bar: the input mode is a Settings choice there.
  const setMode = async (mode: "line" | "direct") => {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Terminal");
    await page.getByRole("combobox", { name: "Terminal input mode", exact: true }).selectOption(mode);
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
  };
  const remountLine = async () => { await setMode("direct"); await setMode("line"); };
  const until = async (check: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) { assert(Date.now() < deadline, "input regression timed out"); await new Promise((r) => setTimeout(r, 25)); }
  };
  try {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    assert.equal(await page.locator(".key-bar").isVisible(), false, "a desktop shows no key bar under the terminal");
    // a phone keyboard's autocorrect would swap a flag or path for a dictionary word before Send
    assert.deepEqual(await line.evaluate((box) => [box.getAttribute("autocorrect"), box.getAttribute("spellcheck"), box.getAttribute("autocapitalize")]), ["off", "false", "off"]);
    assert.equal(await page.getByRole("button", { name: "Input line", exact: true }).count(), 0);
    await page.locator(".pane-frame.is-current").focus();
    const beforeFocus = sent.length;
    await page.keyboard.press("ControlOrMeta+Shift+E");
    assert.equal(await line.evaluate(node => node === document.activeElement), true, "the input shortcut focuses the terminal line");
    assert.equal(sent.length, beforeFocus, "focus does not submit or send terminal input");

    // A liveness probe refuses input without a frame to say so: on a quiet pane the 1 s poll reads
    // it, so the terminal shows it waits instead of looking ready while typing goes to the draft.
    const waiting = page.locator(".terminal-banner", { hasText: "Waiting for terminal input…" });
    // the banner is drawn only on a connected pane: before the socket opens it is absent too, and
    // a wake then finds nothing to probe
    await page.locator(".conn-live").waitFor();
    await waiting.waitFor({ state: "hidden" });
    // nor does a wake probe before the snapshot has said the bridge answers pings
    await until(() => snapshotSent);
    holdPings = true;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await until(() => heldPings.length > 0);
    const probeAt = Date.now();
    await waiting.waitFor({ timeout: 2_000 });
    assert(Date.now() - probeAt < 1_800, "the poll reads the refused input within about a second");
    // the pong ends the probe: input reads ready again
    holdPings = false;
    for (const raw of heldPings.splice(0)) toServer!(raw);
    await waiting.waitFor({ state: "hidden", timeout: 2_000 });

    // The line grows over the grid's last rows: neither its growth nor its collapse after Send
    // changes the grid's height, which is the shared pty's size.
    await line.waitFor();
    const gridHeight = () => page.locator(".pane-terminal").evaluate((element) => element.getBoundingClientRect().height);
    const height = (selector: string) => page.locator(selector).evaluate((element) => element.getBoundingClientRect().height);
    const frame = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await page.evaluate(() => {
      const grid = document.querySelector(".pane-terminal")!;
      (window as any).gridResized = 0;
      let first = true;
      new ResizeObserver(() => { if (first) first = false; else (window as any).gridResized += 1; }).observe(grid);
    });
    await frame();
    const restingGrid = await gridHeight();
    const resizesBefore = resizes.length;
    const restingLine = await height(".terminal-input");
    await line.click();
    await page.keyboard.type("first line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("second line");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("third line");
    await until(async () => (await line.getAttribute("rows")) === "3");
    await frame();
    assert(await height(".terminal-input") > restingLine + 20, "three lines grow the line");
    if (process.env.UI_EVIDENCE_DIR) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-input-grown.png` });
    }
    assert.equal(await gridHeight(), restingGrid, "a growing input line keeps the grid's height");
    const submitsBefore = sent.length;
    await page.getByRole("button", { name: "Send to the terminal", exact: true }).click();
    await until(() => sent.length > submitsBefore && !!acknowledge);
    assert.equal(sent.at(-1).text, "first line\nsecond line\nthird line");
    const sentPane = sent.at(-1).pane_id;
    acknowledge!();
    await until(async () => (await line.inputValue()) === "" && (await line.getAttribute("rows")) === "1");
    await frame();
    assert.equal(await gridHeight(), restingGrid, "the line's collapse after Send keeps the grid's height");
    assert.equal(await page.evaluate(() => (window as any).gridResized), 0, "the grid's observer never fired");
    assert(Math.abs(await height(".terminal-input") - await height(".terminal-input-slot")) < 1, "a one-row line covers no grid row");
    // what PaneTerminal's observer would have sent comes 120 ms after a change, and none happened
    assert.equal(resizes.length, resizesBefore, "typing three lines and Send send no resize");

    // Insert beside Send, in the still grid Send just used: the line typed with no Enter, in its own
    // frame, and cleared only on the bridge's answer; what replaced it meanwhile stays, as after Send
    const insertButton = page.getByRole("button", { name: "Insert text without Enter", exact: true });
    await line.fill("cd");
    await until(async () => !(await insertButton.isDisabled()));
    await line.fill("");
    await until(() => insertButton.isDisabled());
    await line.fill("cd src/lib");
    sent.length = 0;
    acknowledgeInsert = undefined;
    const resizesBeforeInsert = resizes.length;
    await insertButton.click();
    await until(() => sent.length === 1 && !!acknowledgeInsert);
    assert.deepEqual([sent[0].type, sent[0].text, sent[0].pane_id], ["insert", "cd src/lib", sentPane], "Insert sends the line as one insert frame, no Enter");
    assert.equal(await insertButton.isDisabled(), true, "Insert waits for the answer");
    assert.equal(await page.getByRole("button", { name: "Send to the terminal", exact: true }).isDisabled(), true, "so does Send");
    assert.equal(await line.inputValue(), "cd src/lib", "the line keeps its text until the bridge answers");
    await line.fill("");
    await line.fill("cd src/components");
    acknowledgeInsert!();
    await until(async () => !(await insertButton.isDisabled()));
    assert.equal(await line.inputValue(), "cd src/components", "a late insert acknowledgement cannot erase replacement text");
    assert.equal(sent.length, 1, "nothing but the insert frame went: no input, no submit, no Enter");
    // in the same still grid as the Send above (its observer never fired): any resize now would be Insert's
    assert.equal(await page.evaluate(() => (window as any).gridResized), 0, "the grid stayed still through Insert");
    assert.equal(resizes.length, resizesBeforeInsert, "Insert takes no grid back: no resize went with it");
    await line.fill("");
    sent.length = 0;
    acknowledgeInsert = undefined;

    sent.length = 0;
    acknowledge = undefined;

    // a note under the one-row line (a refused send) floats too, and so does its going
    await line.fill("refused");
    await page.getByRole("button", { name: "Send to the terminal", exact: true }).click();
    await until(() => !!refuse);
    refuse!();
    const note = page.locator(".terminal-input-note");
    await note.waitFor();
    await frame();
    assert.equal(await gridHeight(), restingGrid, "a note under the line keeps the grid's height");
    await line.fill("");
    await note.waitFor({ state: "detached" });
    await frame();
    assert.equal(await gridHeight(), restingGrid, "the note's going keeps the grid's height");
    assert.equal(await page.evaluate(() => (window as any).gridResized), 0, "the grid's observer never fired for the note");
    sent.length = 0;
    acknowledge = refuse = undefined;

    // the slot's row is a hand-made calc of the line's metrics: it must match at either density
    const density = await page.evaluate(() => document.documentElement.getAttribute("data-density"));
    await page.evaluate(() => document.documentElement.setAttribute("data-density", "compact"));
    await frame();
    assert(Math.abs(await height(".terminal-input") - await height(".terminal-input-slot")) < 1, "a one-row line covers no grid row at the compact density");
    await page.evaluate((density) => { if (density === null) document.documentElement.removeAttribute("data-density"); else document.documentElement.setAttribute("data-density", density); }, density);

    // a short pane: the grown line reaches the grid's top at most, and its text scrolls past that
    await page.setViewportSize({ width: 1280, height: 160 });
    await frame();
    const surfaceTop = () => page.locator(".terminal-surface").evaluate((element) => element.getBoundingClientRect().top);
    const shortSurface = await height(".terminal-surface");
    assert(shortSurface < 100, `the pane is shorter than a grown line (${shortSurface}px)`);
    await line.fill("one\ntwo\nthree\nfour");
    await until(async () => (await line.getAttribute("rows")) === "4");
    await frame();
    const lineTop = await page.locator(".terminal-input").evaluate((element) => element.getBoundingClientRect().top);
    assert(lineTop >= await surfaceTop() - 1, `the grown line stays under the grid's top (${lineTop} < ${await surfaceTop()})`);
    assert(await line.evaluate((element) => element.scrollHeight > element.clientHeight), "the capped line scrolls its text");
    // the banners stay over the capped line, where it reaches the grid's top: their buttons take the tap
    toPage!({ type: "error", code: "input_failed", pane_id: sentPane, message: "Not sent: test banner" });
    const dismiss = page.locator(".terminal-banners").getByRole("button", { name: "Dismiss", exact: true });
    await dismiss.waitFor();
    const box = (await dismiss.boundingBox())!;
    const lineBox = (await page.locator(".terminal-input").boundingBox())!;
    assert(box.y + box.height / 2 > lineBox.y, "the banner lies within the grown line's box");
    assert(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest(".terminal-banners"), [box.x + box.width / 2, box.y + box.height / 2]),
      "a banner's button stays above the grown input line");
    await dismiss.click();
    await dismiss.waitFor({ state: "detached" });
    await line.fill("");
    await page.setViewportSize({ width: 1280, height: 800 });
    await until(async () => (await line.getAttribute("rows")) === "1");

    await line.fill("draft 한글 😀");
    await remountLine();
    assert.equal(await line.inputValue(), "draft 한글 😀");
    await page.reload();
    await line.waitFor();
    assert.equal(await line.inputValue(), "draft 한글 😀");
    await page.goto(`${origin}/?pane=${encodeURIComponent(otherPane)}`);
    if (!(await line.isVisible())) await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    assert.equal(await line.inputValue(), "");
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await line.waitFor();
    assert.equal(await line.inputValue(), "draft 한글 😀");

    // `note` is the input line's note locator declared above
    // one read: a note that goes between a count and a textContent would wait out the timeout
    const noteText = () => note.evaluateAll((elements) => elements[0]?.textContent ?? null);
    const sendButton = page.getByRole("button", { name: "Send to the terminal", exact: true });
    // A real composition (Chrome's IME path, as Gboard composes every word): the Send keeps focus,
    // so the tap itself must finish the word, and it sends the committed line at once.
    await line.fill("real 한");
    await line.focus();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "글", selectionStart: 1, selectionEnd: 1 });
    await until(async () => (await line.inputValue()) === "real 한글");
    // a word committed inside the tap sends with no "Finishing the word…" alert ever mounted
    await page.evaluate(() => {
      (window as any).noteAdded = 0;
      (window as any).noteObserver = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element && (node.matches(".terminal-input-note") || node.querySelector(".terminal-input-note"))) (window as any).noteAdded += 1;
        }
      });
      (window as any).noteObserver.observe(document.body, { childList: true, subtree: true });
    });
    await sendButton.click();
    await until(async () => sent.length === 1 || (await noteText()) === "Finish the word, then send.");
    assert.equal(sent.length, 1, "a Send during a real composition finishes the word and sends");
    assert.equal(sent[0].text, "real 한글");
    assert.equal(await line.evaluate((element) => element === document.activeElement), true, "the line keeps focus, so the keyboard stays up");
    await page.waitForTimeout(50); // fixed wait: a committed word may add no note
    assert.equal(await page.evaluate(() => { (window as any).noteObserver.disconnect(); return (window as any).noteAdded; }), 0, "a word committed inside the tap mounts no note");
    await cdp.detach();
    acknowledge!();
    await until(async () => (await line.inputValue()) === "");
    acknowledge = undefined;
    // A keyboard that commits on its own within the wait: the line as committed is sent, once,
    // even when the committing input lands in the same task as compositionend.
    await line.fill("commit 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finishing the word…");
    assert.equal(sent.length, 1, "unfinished composition must not submit via button");
    await line.evaluate((element: HTMLTextAreaElement) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "글" }));
      setValue.call(element, "commit 한글");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "글", inputType: "insertFromComposition" }));
    });
    await until(() => sent.length === 2);
    assert.equal(sent[1].text, "commit 한글", "the Send tapped during composition sends the committed line");
    acknowledge!();
    await until(async () => (await line.inputValue()) === "");
    acknowledge = undefined;
    // The preedit is deleted (or the keyboard cancels it) before it commits: the text Send sends
    // nothing, and above all no bare Enter that could accept a prompt's default.
    await line.fill("한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await noteText()) === "Finishing the word…");
    await line.evaluate((element: HTMLTextAreaElement) => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "" }));
      setValue.call(element, "");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteCompositionText" }));
    });
    await page.waitForTimeout(400); // fixed wait: an empty commit may send no Enter
    assert.equal(sent.length, 2, "an empty commit after a text Send sends no Enter");
    assert.equal(await line.inputValue(), "");
    // Compositions that keep chaining after the tap cannot stretch its wait past the deadline.
    await line.fill("chain 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await noteText()) === "Finishing the word…");
    const chainStart = Date.now();
    while (Date.now() - chainStart < 450) {
      await line.evaluate((element: HTMLTextAreaElement) => {
        element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
        element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      });
      await page.waitForTimeout(40);
    }
    // already withdrawn when the chain ends: a wait re-armed per composition would still be open
    assert.equal(await noteText(), "Finish the word, then send.", "the tap's deadline holds through a chain of compositions");
    await line.dispatchEvent("compositionend", { data: "한" });
    await page.waitForTimeout(100); // fixed wait: a chain of compositions past the deadline may send nothing
    assert.equal(sent.length, 2, "a chain of compositions past the deadline sends nothing");
    assert.equal(await noteText(), "Finish the word, then send.");
    // A drop and a quick reconnect while the word is still open withdraw the tap: the later
    // commit sends nothing and the note says why.
    await line.fill("drop 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await noteText()) === "Finishing the word…");
    refuseConnections = true;
    await currentSocket!.close();
    await until(() => sendButton.isDisabled());
    // the withdrawal runs in an effect after the disabled button paints
    await until(async () => (await noteText()) === "Not sent: the terminal is disconnected.");
    refuseConnections = false;
    await until(async () => !(await sendButton.isDisabled()));
    await line.dispatchEvent("compositionend", { data: "한" });
    await page.waitForTimeout(100); // fixed wait: a commit after reconnect may not send the withdrawn tap
    assert.equal(sent.length, 2, "a commit after a drop and reconnect does not send the withdrawn tap");
    assert.equal(await noteText(), "Not sent: the terminal is disconnected.");
    // The terminal drops while the word is still being finished: the commit says so instead of
    // leaving "Finishing the word…" up for good.
    await line.fill("offline 한");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finishing the word…");
    refuseConnections = true;
    await currentSocket!.close();
    await until(() => sendButton.isDisabled());
    await line.dispatchEvent("compositionend", { data: "한" });
    await until(async () => (await noteText()) !== "Finishing the word…");
    assert.equal(await note.textContent(), "Not sent: the terminal is disconnected.");
    assert.equal(sent.length, 2);
    refuseConnections = false;
    await until(async () => !(await sendButton.isDisabled()));
    // No commit within the wait: the tap is withdrawn with a note, and a later commit sends nothing.
    await line.fill("draft 한글 😀");
    await line.dispatchEvent("compositionstart", { data: "" });
    await sendButton.click();
    await until(async () => (await note.textContent()) === "Finish the word, then send.");
    await line.dispatchEvent("compositionend", { data: "😀" });
    // past a deferred send's tick and a whole commit window
    await page.waitForTimeout(400);
    assert.equal(sent.length, 2, "a commit after the withdrawn tap does not send");
    assert.equal(await note.textContent(), "Finish the word, then send.");
    await line.dispatchEvent("compositionstart", { data: "" });
    // Leaving during composition must not leave the composition guard stuck.
    await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await remountLine();
    await line.waitFor();
    await page.getByRole("button", { name: "Send to the terminal", exact: true }).click();
    await until(() => !!acknowledge);
    await remountLine();
    assert.equal(await page.getByRole("button", { name: "Send to the terminal", exact: true }).isDisabled(), true, "pending send survives remount");
    await line.fill("");
    await line.fill("draft 한글 😀");
    acknowledge!();
    await until(async () => !(await page.getByRole("button", { name: "Send to the terminal", exact: true }).isDisabled()));
    assert.equal(await line.inputValue(), "draft 한글 😀", "late ack cannot erase replacement text");
    assert.equal(sent.length, 3);

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    const shortcut = page.getByRole("combobox", { name: "Command palette", exact: true });
    await shortcut.selectOption("p");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    await shortcut.selectOption("off");
    await page.getByRole("combobox", { name: "Next pane", exact: true }).selectOption("p");
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await line.focus();
    const selectionBefore = await page.evaluate(() => localStorage.getItem("ovis:selection"));
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await until(async () => (await page.evaluate(() => localStorage.getItem("ovis:selection"))) !== selectionBefore);
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await line.waitFor();
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    await page.getByRole("button", { name: "Reset shortcuts", exact: true }).click();
    if (process.env.UI_EVIDENCE_DIR) {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await shortcut.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-input-settings-desktop.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: `${process.env.UI_EVIDENCE_DIR}/terminal-input-settings-phone.png` });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "settings must fit phone width");
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    await page.getByRole("button", { name: "Close settings", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Shift+k");
    await page.getByRole("dialog", { name: "Command palette", exact: true }).waitFor();
    await page.keyboard.press("Escape");

    // A screen can arrive before attachment readiness; do not send or auto-replay typing.
    delayReady = true;
    await setMode("direct");
    await page.reload();
    await page.locator(".xterm-helper-textarea").waitFor();
    await until(() => !!ready);
    const before = sent.length;
    await page.locator(".pane-frame.is-current").focus();
    await page.keyboard.press("ControlOrMeta+Shift+E");
    assert.equal(await page.locator(".xterm-helper-textarea").evaluate(node => node === document.activeElement), true, "the input shortcut also focuses direct terminal input before readiness");
    assert.equal(sent.length, before, "focus sends no input before readiness");
    // the held-input row: the command and its two controls, no sentence (todo 27)
    const heldNotice = page.locator(".pane-frame.is-current .terminal-banner-draft");
    const leftOut = page.getByText("An Enter or line break was left out: Send never presses Enter.", { exact: true });
    // Enter on a terminal that is not ready, with nothing held, separates nothing: no notice.
    // The "a" landing after it proves the Enter was handled first.
    await page.locator(".xterm-helper-textarea").press("Enter");
    await page.locator(".xterm-helper-textarea").press("a");
    await until(async () => (await page.locator(".draft-text").textContent()) === "a");
    assert.equal(await leftOut.count(), 0);
    // Backspace edits what is held; an Enter is never held, but it is told
    await page.locator(".xterm-helper-textarea").press("b");
    await until(async () => (await page.locator(".draft-text").textContent()) === "ab");
    await page.locator(".xterm-helper-textarea").press("Backspace");
    await until(async () => (await page.locator(".draft-text").textContent()) === "a");
    assert.equal(await leftOut.count(), 0);
    await page.locator(".xterm-helper-textarea").press("Enter");
    await leftOut.waitFor();
    await until(async () => (await page.locator(".draft-text").textContent()) === "a ");
    assert.equal(sent.length, before);
    // Exactly the held text must survive reload, not merely later edits, and so must the left-out notice.
    ready = undefined;
    await page.reload();
    await page.locator(".draft-text").waitFor();
    assert.equal(await page.locator(".draft-text").textContent(), "a ");
    await leftOut.waitFor();
    assert.equal(await heldNotice.count(), 1);
    await until(() => !!ready);
    ready!();
    await page.waitForTimeout(150); // fixed wait: ready may not replay the draft
    assert.equal(sent.length, before, "ready does not replay the draft");
    // Held input keeps later typing until Send or Discard, on a ready terminal too: a key sent beside
    // it would reach the pty without the held start, and an Enter would run that partial line. The
    // "b" landing after the Enter proves the Enter was handled first (the Enter folds into the held space).
    await page.locator(".xterm-helper-textarea").press("Enter");
    await page.locator(".xterm-helper-textarea").press("b");
    await until(async () => (await page.locator(".draft-text").textContent()) === "a b");
    assert.equal(sent.length, before, "typing beside a held draft reaches nothing");
    // an interrupt is not typing: it still reaches the program while the draft waits
    await page.locator(".xterm-helper-textarea").press("Escape");
    await until(() => sent.length > before);
    assert.equal(sent.at(-1).text, "\x1b");
    assert.equal(await page.locator(".draft-text").textContent(), "a b");
    const heldNote = "Not sent: send or discard the held input first.";
    const banner = page.locator(".terminal-banner", { hasText: heldNote });
    const dismissBanner = async () => { await banner.getByRole("button", { name: "Dismiss", exact: true }).click(); await banner.waitFor({ state: "hidden" }); };
    const afterEscape = sent.length;
    // Ctrl+Enter under modifyOtherKeys (Claude Code's "send now") carries no line break once encoded:
    // it must still be refused, not run the pty's partial line
    toPage!({ type: "pty-data", pane_id: pane, data: "\x1b[>4;1m" });
    await page.waitForTimeout(100);
    await page.locator(".xterm-helper-textarea").press("Control+Enter");
    await banner.waitFor();
    assert.equal(sent.length, afterEscape, "Ctrl+Enter beside a held draft reaches nothing");
    await dismissBanner();
    toPage!({ type: "pty-data", pane_id: pane, data: "\x1b[>4;0m" });
    // a paste beside a held draft is never sent ahead of the held start: one the draft cannot take is
    // refused with the note, a bracketed one (the shell asks for it) holds its tab as a space
    const pasteIntoTerminal = (text: string) => page.locator(".xterm-helper-textarea").evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    const draftText = () => page.locator(".draft-text").textContent();
    await pasteIntoTerminal("a\tb");
    await until(async () => (await banner.isVisible()) || (await draftText()) === "a ba b");
    assert.equal(sent.length, afterEscape, "a paste with a tab beside a held draft reaches nothing");
    if (await banner.isVisible()) {
      assert.equal(await draftText(), "a b");
      await dismissBanner();
    }
    const beforeMultiLine = await draftText();
    await pasteIntoTerminal("x\ny");
    await until(async () => (await banner.isVisible()) || (await draftText()) !== beforeMultiLine);
    assert.equal(sent.length, afterEscape, "a multi-line paste beside a held draft reaches nothing");
    // never a silent drop: refused with the note, or taken into the draft (a draft that folds line breaks)
    const multiLineNoted = await banner.isVisible();
    assert(multiLineNoted || (await draftText()) !== beforeMultiLine, "a multi-line paste is told or held, never dropped in silence");
    if (multiLineNoted) await dismissBanner();
    // the input line is refused beside a held draft too, with the held-input reason, not "disconnected"
    await setMode("line");
    const lineNote = page.locator(".terminal-input-note");
    await line.fill("");
    await line.press("Enter");
    await until(async () => (await lineNote.textContent()) === heldNote);
    await line.fill("ls");
    await line.press("Enter");
    await until(async () => (await lineNote.textContent()) === heldNote);
    assert.equal(await line.inputValue(), "ls", "a refused line keeps its text");
    assert.equal(sent.length, afterEscape, "the input line beside a held draft reaches nothing");
    await line.fill("");
    await setMode("direct");
    // a draft that takes pastes holds more than "a b" by now: Send types what it holds
    const heldText = await page.locator(".draft-text").textContent();
    await page.getByRole("button", { name: "Send held input", exact: true }).click();
    await until(() => sent.length > before + 1);
    assert.equal(sent.at(-1).text, heldText);
    assert.equal(sent.length, before + 2, "Send types the held text once, with no Enter");
    // Real xterm handling: an IME's provisional syllable stays local until commit.
    const imeBefore = sent.length;
    const input = page.locator(".xterm-helper-textarea");
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      box.value = "한";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
    });
    await page.waitForTimeout(50); // fixed wait: nothing may be sent mid-composition
    assert.equal(sent.length, imeBefore);
    await input.dispatchEvent("compositionend", { data: "한" });
    await until(() => sent.length > imeBefore);
    assert.equal(sent.slice(imeBefore).map((frame) => frame.text).join(""), "한");
    // Native Gboard emits Backspace while xterm retains the previous DOM text. The
    // next IME session must start with a fresh scratch editor, not that stale context.
    await input.evaluate((element) => { const box = element as HTMLTextAreaElement; box.value = "가나다 "; box.setSelectionRange(4, 4); });
    const deletionBefore = sent.length;
    await input.press("Backspace");
    assert.equal(await input.inputValue(), "", "non-composing Backspace resets stale IME context");
    assert.equal(sent.slice(deletionBefore).map((frame) => frame.text).join(""), "\x7f");
    const burstBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "니";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "니" }));
    });
    await page.waitForTimeout(25);
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "니" }));
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "니다";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "다" }));
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "다" }));
      box.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: ".", code: "Period", keyCode: 190, which: 190 }));
    });
    await page.waitForTimeout(75);
    assert.equal(sent.slice(burstBefore).map((frame) => frame.text).join(""), "니다.", "queued compositions must drain before punctuation (#6089)");

    const movedBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "핫";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "핫" }));
    });
    await page.waitForTimeout(25);
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      // The IME's event can report 핫 even though its final consonant moved to 세.
      box.value = "하";
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "핫" }));
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "하세";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "세" }));
    });
    await page.waitForTimeout(25);
    await input.dispatchEvent("compositionend", { data: "세" });
    await page.waitForTimeout(75);
    assert.equal(sent.slice(movedBefore).map((frame) => frame.text).join(""), "하세", "read corrected DOM text, not stale compositionend.data");
    const switchBefore = sent.length;
    await input.evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      box.value = "";
      box.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      box.value = "한";
      box.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "한" }));
    });
    await page.waitForTimeout(25);
    await page.evaluate((target) => {
      const box = document.querySelector(".xterm-helper-textarea")!;
      box.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "한" }));
      const row = [...document.querySelectorAll<HTMLElement>(".pane-select")].find((row) => row.title.startsWith(target + " —"));
      if (!row) throw new Error("owned destination pane missing");
      row.click();
    }, otherPane);
    await until(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem("ovis:selection")!).pane_id)) === otherPane);
    await page.waitForTimeout(75); // fixed wait: the old composition may not send across a pane reset
    assert.equal(sent.length, switchBefore, "old composition cannot cross a pane reset");
    assert.equal(await page.locator(".draft-text").count(), 0, "old commit cannot enter the new pane's held draft");
    // A late end after reset is stale, not a second attempt to send the abandoned input.
    await page.locator(".pane-frame.is-current .xterm-helper-textarea").dispatchEvent("compositionend", { data: "한" });
    await page.waitForTimeout(75); // fixed wait: a late compositionend after the reset may send nothing
    assert.equal(sent.length, switchBefore);
    console.log("PASS xterm composition: local preedit, delayed multi-commit burst, punctuation order, Korean final-consonant movement, pane-reset cancellation");
    assert.deepEqual(errors, []);
    console.log("PASS terminal input: desktop mode, owner drafts, reload, IME button, late ack, shortcuts, readiness, explicit send");
  } finally { await context.close(); }
  await checkKeyBarWhileLineComposes(browser, origin, pane);
  await checkLineImagePaste(browser, origin, pane);
  await checkCanonicalSubmit(browser);
}

/**
 * An image pasted into the phone's input line (#801): the long-press Paste hands the line a
 * file-only clipboard, and the key bar's Paste reads one with clipboard.read(). Either way the
 * image goes up the same route as a paste into the grid, and its quoted path lands in the line at
 * the caret, to send or edit. A text paste stays the browser's own. A browser that can read only
 * text says where an image can be pasted instead of calling the clipboard empty.
 */
export async function checkLineImagePaste(browser: Browser, origin: string, pane: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await context.addInitScript((pane) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
  }, pane);
  const uploads: { pane_id?: string; content_type?: string }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/pane/image") uploads.push(JSON.parse(request.postData() ?? "{}"));
  });
  const uploaded = () => page.waitForResponse((response) => new URL(response.url()).pathname === "/api/pane/image")
    .then(async (response) => { assert.equal(response.status(), 200, "the upload is stored"); return ((await response.json()) as { path: string }).path; });
  const quoted = (path: string) => `'${path.replaceAll("'", "'\\''")}' `;
  // a paste lands in two steps: the path is written, then the next frame puts the caret behind it
  // (TerminalInput's place). The line's frame was asked for before the path showed, so one frame
  // asked for after it runs later: past it, the next fill's select-all is not collapsed to the end
  // (under load the fill then added to the line instead of replacing it)
  const landed = async (value: string): Promise<void> => {
    await page.waitForFunction((expected) => document.querySelector<HTMLTextAreaElement>(".terminal-input-text")?.value === expected, value);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  };
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  try {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    const line = page.locator(".terminal-input-text");
    const note = page.locator(".terminal-input-note[role=alert]");
    const paste = page.locator('.key-bar [data-key="paste"]');
    await line.waitFor();
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('.key-bar [data-key="paste"]')?.disabled === false);

    // a text paste is the browser's own: nothing uploaded, nothing taken from it
    const textPaste = await line.evaluate((element) => {
      const data = new DataTransfer();
      data.setData("text/plain", "ls -la");
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(textPaste, false, "a text paste is left to the browser");

    // the long-press Paste of a screenshot: a file-only clipboard, uploaded and its path put at the caret
    await line.fill("look at ");
    const first = uploaded();
    const filePaste = await line.evaluate((element, png) => {
      const box = element as HTMLTextAreaElement;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      box.dispatchEvent(event);
      // Chrome on Android reports a selectionchange just after the paste, the caret where it was
      document.dispatchEvent(new Event("selectionchange"));
      return event.defaultPrevented;
    }, PNG);
    assert.equal(filePaste, true, "a file-only paste is the line's to handle");
    const firstPath = await first;
    assert.match(firstPath, /\.ovis\/paste-[^/]+\.png$/, "the image is stored beside the pane");
    await landed(`look at ${quoted(firstPath)}`);
    assert.deepEqual(uploads.map((upload) => [upload.pane_id, upload.content_type]), [[pane, "image/png"]], "one upload, for this pane");
    console.log(`PASS input line: a pasted screenshot is uploaded and its path inserted (${firstPath})`);

    // a screenshot pasted over a selected word replaces it, though Chrome on Android collapses the
    // selection to its end just after the paste
    await line.fill("look at this");
    const ranged = uploaded();
    await line.evaluate((element, png) => {
      const box = element as HTMLTextAreaElement;
      box.focus();
      box.setSelectionRange(8, 12);
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      box.setSelectionRange(12, 12);
      document.dispatchEvent(new Event("selectionchange"));
    }, PNG);
    const rangedPath = await ranged;
    await landed(`look at ${quoted(rangedPath)}`);
    console.log("PASS input line: a screenshot pasted over a selected word replaces it");

    // the key bar's Paste with an image on the clipboard: read with clipboard.read(), the same upload
    await line.fill("");
    await page.evaluate((png) => {
      const blob = new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: "image/png" });
      Object.assign(navigator.clipboard, {
        // an empty text beside the image, as some apps copy one: the image is what is there
        read: () => Promise.resolve([new ClipboardItem({ "text/plain": new Blob([""], { type: "text/plain" }), "image/png": blob })]),
        readText: () => Promise.resolve(""),
      });
    }, PNG);
    const second = uploaded();
    await paste.tap();
    const secondPath = await second;
    await landed(quoted(secondPath));
    assert.equal(uploads.length, 3, "the key bar's Paste uploaded the image once");
    assert.equal(await note.count(), 0, "no note: the image was pasted");
    console.log("PASS key bar Paste: an image read with clipboard.read() is uploaded and its path inserted");

    // a browser with only readText cannot see an image: it says where one can be pasted
    await line.fill("");
    await page.evaluate(() => { Object.assign(navigator.clipboard, { read: undefined, readText: () => Promise.resolve("") }); });
    await paste.tap();
    await note.waitFor();
    assert.equal(await note.textContent(), "No text on the clipboard. To paste an image, press and hold the input line, then choose Paste.");
    assert.equal(uploads.length, 3, "nothing uploaded");
    console.log("PASS key bar Paste without clipboard.read(): an empty text read says how to paste an image");

    // a path that would be cut at the line's limit names no file: the line stays as it was
    const full = "x".repeat(await line.evaluate((element) => (element as HTMLTextAreaElement).maxLength) - 4);
    await line.fill(full);
    const third = uploaded();
    await line.evaluate((element, png) => {
      const box = element as HTMLTextAreaElement;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      const data = new DataTransfer();
      data.items.add(new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, PNG);
    await third;
    await page.waitForFunction(() => document.querySelector(".terminal-input-note[role=alert]")?.textContent?.startsWith("Not pasted: the line has no room") === true);
    assert.equal(await line.inputValue(), full, "no half path in the line");
    assert.deepEqual(errors, []);
    console.log("PASS input line: a path that would not fit whole is not cut into the line");
  } finally { await context.close(); }
}

/**
 * The terminal input line's multiline Unicode text, sent for real to a program that records its raw input: with
 * bracketed paste on it gets one paste, with it off only the lines, and on a mirror (no PTY sidecar, so the browser
 * never learns the mode) an agent's pane gets one paste the bridge adds, a plain one the lines; each time exactly
 * one Enter of the bridge's own after them. The submit frames go to the bridge unchanged, which checks their framing.
 */
async function checkCanonicalSubmit(browser: Browser): Promise<void> {
  const { createServer } = await import("../server/index.ts");
  const { herdrRpc, workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "herdr-canonical-submit-"));
  const script = join(root, "record.cjs");
  // the recorder asks for its mode, then names its pid once that is written; SIGUSR2 has it ask again (after the
  // browser attached) and draw "ready$"; every byte it reads goes to its log as one JSON string per chunk
  writeFileSync(script, `const fs=require("node:fs");const [out,mode]=process.argv.slice(2);const seq=mode==="on"?"\\x1b[?2004h":"\\x1b[?2004l";process.stdin.setRawMode(true);process.stdin.resume();process.on("SIGUSR2",()=>process.stdout.write(seq+"\\r\\nready$ "));process.stdin.on("data",c=>fs.appendFileSync(out,JSON.stringify(c.toString("utf8"))+"\\n"));process.stdout.write(seq+"$ ",()=>{fs.writeFileSync(out,"");fs.writeFileSync(out+".pid",String(process.pid))});`);
  /** Settles once `ready()` holds, checked now and on every change under `path` (subscribed at the call); throws at the deadline. */
  const whenChanged = (path: string, ready: () => boolean, what: string, ms = 10_000): Promise<void> => new Promise((resolve, reject) => {
    let settled = false;
    const settle = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); watcher.close();
      if (error) reject(error); else resolve();
    };
    const check = () => { try { if (ready()) settle(); } catch (error) { settle(error); } };
    const watcher = watch(path, check);
    const timer = setTimeout(() => settle(new Error(`${what}: not within ${ms} ms`)), ms);
    check();
  });
  const servers = { attached: createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "attached") }), mirror: createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "mirror"), terminalAttach: false }) };
  const owned: string[] = [];
  const text = "check canonical commit 한글\tcolumn\nsecond line ✓ 🙂";
  const lines = text.replace(/\n/g, "\r");
  const paste = `\u001b[200~${lines}\u001b[201~`;
  const cases = [
    { name: "attached, bracketed paste on", server: "attached", mode: "on", agent: false, bytes: paste },
    // herdr's attach reports bracketed paste on when it starts, whatever the program asked for (measured, herdr 0.9.5):
    // the program asks for off again once the browser is attached, and the browser must see that before it sends
    { name: "attached, bracketed paste off", server: "attached", mode: "off", agent: false, bytes: lines },
    { name: "mirror fallback, agent pane", server: "mirror", mode: "on", agent: true, bytes: paste },
    { name: "mirror fallback, plain pane", server: "mirror", mode: "off", agent: false, bytes: lines },
  ] as const;
  try {
    for (const item of cases) {
      const made = await workspaceCreate({ cwd: root, label: "herdr-web-ui-test-canonical-submit" });
      owned.push(made.workspace.workspace_id);
      const pane = made.root_pane.pane_id;
      const log = join(root, `${owned.length}.jsonl`);
      const pidFile = `${log}.pid`;
      const started = whenChanged(root, () => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", `${item.name}: the recorder started`);
      await herdrRpc("pane.send_text", { pane_id: pane, text: `exec '${process.execPath}' '${script}' '${log}' ${item.mode}\n` });
      await started;
      const recorder = Number(readFileSync(pidFile, "utf8"));
      if (item.agent) await herdrRpc("pane.report_agent", { pane_id: pane, source: "manual", agent: "claude", state: "idle" });
      const bytes = () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string).join("");
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await context.addInitScript((pane) => {
        localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
        localStorage.setItem(`ovis:view:${pane}`, "terminal");
      }, pane);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.setDefaultTimeout(10_000);
      const submits: Array<{ text: string; payload: string; typed?: boolean }> = [];
      page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "submit") submits.push(frame);
      }));
      const results: Array<{ ok: boolean; code?: string }> = [];
      let resultArrived = () => {};
      const resultSeen = new Promise<void>((resolve) => { resultArrived = resolve; });
      // the attach stream as the browser's terminal got it: the last bracketed-paste request in it is the mode it holds
      let drawn = "";
      page.on("websocket", (socket) => socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "submit-result") { results.push(frame); resultArrived(); }
        if (frame.type === "pty-data" && frame.pane_id === pane) drawn += frame.data;
      }));
      const browserMode = () => {
        const on = drawn.lastIndexOf("\u001b[?2004h");
        const off = drawn.lastIndexOf("\u001b[?2004l");
        return on < 0 && off < 0 ? "none" : on > off ? "on" : "off";
      };
      try {
        await page.goto(`http://127.0.0.1:${servers[item.server].port}/?pane=${encodeURIComponent(pane)}`);
        await page.locator(".conn-live").waitFor();
        const line = page.getByRole("textbox", { name: "Terminal input line", exact: true });
        await line.waitFor();
        // the input line holds the program's prompt once the pane is drawn: the mode the program asked for came before it
        await page.locator(".xterm-rows", { hasText: "$" }).waitFor();
        await page.waitForFunction(() => document.querySelector(".terminal-banner") === null);
        // with the browser attached, the program asks for its mode again; its "ready$" comes after that request
        process.kill(recorder, "SIGUSR2");
        await page.locator(".xterm-rows", { hasText: "ready$" }).waitFor();
        if (item.server === "attached") {
          const mode = browserMode();
          if (mode !== item.mode) {
            // the scenario cannot be shown here: the browser's terminal never learned the program's mode
            assert.equal(item.mode, "off", `${item.name}: the browser holds bracketed paste ${mode}`);
            console.log(`BLOCKED canonical multiline submit, ${item.name}: the program asked for bracketed paste off after the attach, but the attach stream left the browser's terminal ${mode} (requests seen: ${JSON.stringify(drawn.match(/\u001b\[\?2004[hl]/g) ?? [])}); nothing was sent`);
            assert.deepEqual(errors, []);
            continue;
          }
        }
        const expected = `${item.bytes}\r`;
        const landed = whenChanged(log, () => {
          const got = bytes();
          assert(expected.startsWith(got), `${item.name}: the pane got ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`);
          return got === expected;
        }, `${item.name}: the pane got ${JSON.stringify(expected)}`, 15_000);
        landed.catch(() => {});
        await line.fill(text);
        await page.getByRole("button", { name: "Send to the terminal", exact: true }).click();
        let resultDeadline: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([resultSeen, new Promise<never>((_, reject) => {
          resultDeadline = setTimeout(() => reject(new Error(`${item.name}: no submit-result within 10000 ms`)), 10_000);
        })]).finally(() => clearTimeout(resultDeadline));
        assert.deepEqual(results, [{ ...results[0], ok: true }], `${item.name}: the bridge took the submit`);
        assert.equal(submits.length, 1, `${item.name}: one submit`);
        assert.equal(submits[0]!.text, text, `${item.name}: the text as written`);
        // an attached pane's browser shapes the payload by the mode it saw; a mirror's always sends the bare lines
        assert.equal(submits[0]!.payload, item.server === "attached" && item.mode === "on" ? paste : lines, `${item.name}: the canonical payload for the mode`);
        await landed;
        assert.deepEqual(errors, []);
        console.log(`PASS canonical multiline submit, ${item.name}: browser mode ${item.server === "attached" ? browserMode() : "n/a (mirror)"}, frame ${JSON.stringify({ text: submits[0]!.text, payload: submits[0]!.payload })} -> pane ${JSON.stringify(bytes())}`);
      } finally { await context.close(); }
    }
  } finally {
    servers.attached.stop(); servers.mirror.stop();
    for (const id of owned) await workspaceClose(id).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

/** A composition in the input line must not grey out the phone key bar: Esc and ^C go to the pane at once. */
async function checkKeyBarWhileLineComposes(browser: Browser, origin: string, pane: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  await context.addInitScript((pane) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", terminalInputMode: "line" }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
  }, pane);
  const frames: any[] = [];
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => socket.send(raw));
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      // intercepted: the assertions are about what the browser sends, not the PTY
      if (frame.type === "input" || frame.type === "keys" || frame.type === "submit") frames.push(frame);
      else server.send(raw);
    });
  });
  const until = async (check: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 10_000;
    while (!(await check())) { assert(Date.now() < deadline, `timed out: ${label}`); await new Promise((r) => setTimeout(r, 25)); }
  };
  try {
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    const line = page.locator(".terminal-input-text");
    const esc = page.locator('.key-bar [data-key="Escape"]');
    const interrupt = page.locator('.key-bar [data-key="ctrl-c"]');
    await line.waitFor();
    await until(async () => !(await esc.isDisabled()), "key bar ready");
    await line.fill("fix the");
    await line.dispatchEvent("compositionstart", { data: "" });
    await line.dispatchEvent("compositionupdate", { data: "the" });
    // let React commit any state the composition would set before reading the bar
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await esc.isDisabled(), false, "Esc stays live while the input line composes");
    assert.equal(await interrupt.isDisabled(), false, "^C stays live while the input line composes");
    assert.equal(await page.locator('.key-bar [data-key="Control"]').isDisabled(), false, "Ctrl stays live while the input line composes");
    const before = frames.length;
    await esc.tap();
    await until(() => frames.length > before, "Esc frame");
    await interrupt.tap();
    await until(() => frames.length > before + 1, "^C frame");
    assert.deepEqual(frames.slice(before).map((frame) => [frame.type, frame.text ?? frame.keys]), [["input", "\x1b"], ["input", "\x03"]]);
    assert.equal(await line.inputValue(), "fix the", "the composing line keeps its text");
    // the switch to direct typing would unmount the line mid-composition: it waits
    const direct = page.locator('.key-bar [data-key="direct"]');
    assert.equal(await direct.isDisabled(), true, "the direct-typing toggle waits for the line's composition");
    const sent = frames.length;
    await direct.tap({ force: true });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await line.isVisible(), true, "the input line stays while it composes");
    assert.equal(await line.inputValue(), "fix the", "the composing line keeps its text after the direct tap");
    assert.equal(frames.length, sent, "nothing reaches the pane from the direct tap");
    await line.dispatchEvent("compositionend", { data: "the" });
    await until(async () => !(await direct.isDisabled()), "direct toggle live after the composition");
    assert.deepEqual(errors, []);
    console.log("PASS key bar while the input line composes: Esc and ^C sent, direct toggle waits, line text kept");
  } finally { await context.close(); }
}


if (import.meta.main) {
  await import("./test-herdr.ts");
  const { createServer } = await import("../server/index.ts");
  const { workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "herdr-input-qa-"));
  const owned: string[] = [];
  const server = createServer({ port: 0, stateDir: root, token: "" });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const panes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const made = await workspaceCreate({ cwd: root, label: "ovis-test-input" });
      owned.push(made.workspace.workspace_id); panes.push(made.root_pane.pane_id);
    }
    await checkTerminalInput(browser, `http://127.0.0.1:${server.port}`, panes[0]!, panes[1]!);
  } finally {
    await browser.close(); server.stop();
    for (const id of owned) await workspaceClose(id);
    rmSync(root, { recursive: true, force: true });
  }
}
