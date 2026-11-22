/**
 * Arrows on herdr-core: browser → WS → hc's attach → a raw-mode PTY that logs its stdin. A current
 * pty parse of `CSI ? 1 h/l` witnesses DECCKM; only then is a physical arrow typed as xterm encodes it.
 * Earlier or logical type-ahead arrows use named keys. The ordinary fast path avoids hc's `terminal.keys` quiet wait of about 3 s,
 * also for an arrow pressed while output is still on its way to xterm (#4123).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneRead, paneSendKeys, paneSendText, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { setRuntime, startRuntime } from "../server/herdr-core/runtime.ts";
import { chromePath } from "./chrome-path.ts";
import { isolatedHcEnv, stopIsolatedCore } from "./test-hc.ts";

const bin = process.env["OVIS_TEST_HC_BIN"];
if (!bin || process.platform === "win32") {
  console.log("terminal arrows on herdr-core: skipped (set OVIS_TEST_HC_BIN to an hc; not on Windows)");
  process.exit(0);
}

/** hc's quiet rule holds terminal.keys until nobody typed for ~3 s: an arrow typed as text never waits on it */
const NO_QUIET_WAIT_MS = 1_500;
const probe = resolve("scripts/fixtures/modifier-probe.py");
// short: hc's socket path under the root must stay within the OS's limit
const root = realpathSync(mkdtempSync(join("/tmp", "hca-")));
for (const sub of ["state", "config", "run", "home", "ovis-state"]) mkdirSync(join(root, sub), { mode: 0o700 });
const env = isolatedHcEnv(root, { SHELL: "/bin/sh" });
const owned: string[] = [];
const errors: string[] = [];
let browser: Browser | undefined;
let adapter: Awaited<ReturnType<typeof startRuntime>> = null;
let server: ReturnType<typeof createServer> | undefined;

async function until(check: () => boolean | Promise<boolean>, label: string | (() => string)): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    assert(Date.now() < deadline, `timed out: ${typeof label === "string" ? label : label()}`);
    await Bun.sleep(5);
  }
}

interface Session {
  page: Page;
  pane: string;
  workspaceId: string;
  frames: Array<{ pane_id: string; type: string; text?: string; keys?: string[]; automatic?: boolean }>;
  framesHeard: () => number;
  sentByPage: () => Promise<number>;
  isReady: (pane: string) => boolean;
  /** what the program in the pane has read since the last call */
  received: () => string;
  /** the probe's stdin log, which its command line names */
  log: string;
}

const readProbe = (log: string): (() => string) => {
  let read = 0;
  return () => {
    const all = existsSync(log) ? readFileSync(log, "utf8") : "";
    const fresh = all.slice(read);
    read = all.length;
    return Buffer.from(fresh, "hex").toString("latin1");
  };
};

/** A pane of its own that runs `before` and then the stdin logger, shown in a desktop browser. */
async function open(name: string, before: string, probeBeforeAttach = false, holdOutput = false): Promise<Session> {
  const cwd = join(root, name);
  mkdirSync(cwd);
  const made = await workspaceCreate({ cwd, label: `ovis-test-core-arrows-${name}` });
  owned.push(made.workspace.workspace_id);
  const pane = made.root_pane.pane_id;
  const log = join(root, `${name}.hex`);
  await paneSendText(pane, `clear; ${before} python3 -u '${probe}' '${log}' plain`);
  await paneSendKeys(pane, ["Enter"]);
  // The pre-attach case proves the mode change happened before this browser creates its terminal.
  if (probeBeforeAttach) await probeReady(pane);
  const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ pane, holdOutput }) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false }));
    localStorage.setItem(`ovis:view:${pane}`, "terminal");
    localStorage.setItem("ovis:sidebar-filter-shown", "true");
    const qa = window as unknown as {
      terminalArrowSentByPage: number;
      delayedTerminalOutput: { pending: () => number; held: () => string; queryDelivered: () => number; release: () => void; hold: () => void; releaseOnKeyDown: (key: string) => void };
    };
    qa.terminalArrowSentByPage = 0;
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (this: WebSocket, data: Parameters<typeof send>[0]) {
      const open = this.readyState === WebSocket.OPEN;
      const result = send.call(this, data);
      if (open && typeof data === "string") {
        try {
          const type = (JSON.parse(data) as { type?: string }).type;
          if (type === "input" || type === "keys") qa.terminalArrowSentByPage += 1;
        } catch { /* not JSON */ }
      }
      return result;
    };
    {
      let holding = holdOutput;
      let queryDelivered = 0;
      const queued: Array<() => void> = [];
      let held = "";
      const release = () => { holding = false; held = ""; for (const deliver of queued.splice(0)) deliver(); };
      qa.delayedTerminalOutput = {
        pending: () => queued.length,
        held: () => held,
        queryDelivered: () => queryDelivered,
        release,
        hold: () => { holding = true; },
        // the held output reaches the page right before xterm reads the key, so xterm is still parsing it then
        releaseOnKeyDown: (key) => {
          const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== key) return;
            window.removeEventListener("keydown", onKeyDown, true);
            release();
          };
          window.addEventListener("keydown", onKeyDown, true);
        },
      };
      const prototype = WebSocket.prototype as unknown as {
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => void;
      };
      const add = prototype.addEventListener;
      prototype.addEventListener = function (this: WebSocket, type, listener, options) {
        if (type !== "message" || listener === null) { add.call(this, type, listener, options); return; }
        const socket = this as WebSocket;
        const deliver: EventListener = (event) => {
          const messageEvent = event as MessageEvent;
          let message: { type?: string; pane_id?: string; data?: string };
          try { message = JSON.parse(String(messageEvent.data)); }
          catch {
            if (typeof listener === "function") listener.call(socket, event);
            else listener.handleEvent(event);
            return;
          }
          const invoke = (delivered: Event = event) => {
            if (typeof listener === "function") listener.call(socket, delivered);
            else listener.handleEvent(delivered);
          };
          const queryOnly = /^(?:\x1b\[\?1004h)?\x1b\]10;\?\x1b\\\x1b\]11;\?\x1b\\\x1b\]12;\?\x1b\\\x1b\[16t\x1b\[c$/.test(message.data ?? "");
          if (holding && message.type === "pty-data" && message.pane_id === pane && !queryOnly) {
            queued.push(invoke);
            held += message.data ?? "";
          }
          else {
            if (holding && message.type === "pty-data" && message.pane_id === pane && queryOnly) {
              queryDelivered++;
              // A subparameter 1 belongs to mode 1004, not DECCKM. Feed it through the real parser
              // before the held first paint: neither this nor the display queries proves cursor mode.
              invoke(new MessageEvent("message", { data: JSON.stringify({ ...message, data: `\x1b[?1004:1h\x1b[?1004:1l${message.data}` }) }));
            } else invoke();
          }
        };
        add.call(socket, type, deliver, options);
      };
    }
  }, { pane, holdOutput });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  const frames: Session["frames"] = [];
  let framesHeard = 0;
  const ready = new Set<string>();
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const { id: _receipt, ...message } = JSON.parse(String(payload));
      if (message.type === "input" || message.type === "keys") { frames.push(message); framesHeard += 1; }
    });
    socket.on("framereceived", ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === "error") console.log(`${name}: terminal error`, message);
      if (message.type === "input-ready" && typeof message.pane_id === "string") {
        if (message.ready === false) ready.delete(message.pane_id);
        else ready.add(message.pane_id);
      }
    });
  });
  await page.goto(`http://127.0.0.1:${server!.port}/?pane=${encodeURIComponent(pane)}`);
  await until(() => ready.has(pane), `${name}: terminal accepts input`);
  await page.locator(".xterm-screen").waitFor();
  const received = readProbe(log);
  return {
    page, pane, workspaceId: made.workspace.workspace_id, frames,
    framesHeard: () => framesHeard,
    sentByPage: () => page.evaluate(() => (window as unknown as { terminalArrowSentByPage: number }).terminalArrowSentByPage),
    isReady: (current) => ready.has(current),
    received,
    log,
  };
}

const probeReady = (pane: string) => until(async () => (await paneRead({ paneId: pane, source: "visible" })).text.includes("PROBE READY plain"), `${pane}: raw probe ready`);
const browserProbeReady = (s: Session, label: string) => until(async () => s.page.locator(".xterm-screen").evaluate((screen) => screen.textContent?.includes("PROBE READY plain") === true), `${label}: browser parsed the probe's first paint`);

async function frameFence(s: Session, label: string): Promise<void> {
  const sent = await s.sentByPage();
  assert.equal(typeof sent, "number", `${label}: browser frame counter is installed`);
  await until(async () => s.framesHeard() === await s.sentByPage(), `${label}: all frames sent so far reached Playwright`);
}

const typeAheadState = (page: Page) => page.evaluate(() => {
  const describe = (element: Element) => ({ tag: element.tagName, className: (element as HTMLElement).className, placeholder: element.getAttribute("placeholder") });
  return {
    active: document.activeElement ? describe(document.activeElement) : null,
    catches: [...document.querySelectorAll(".type-ahead")].map((element) => ({ ...describe(element), focused: element === document.activeElement })),
  };
});

/** The arrows' frames are typed text, never named keys, and the program reads each in `final`'s form. */
async function arrowsAs(s: Session, label: string, form: (final: string) => string): Promise<void> {
  const before = s.frames.length;
  for (const [key, final] of [["ArrowUp", "A"], ["ArrowDown", "B"], ["ArrowRight", "C"], ["ArrowLeft", "D"]] as const) {
    let got = "";
    await s.page.keyboard.press(key);
    await until(() => (got += s.received()).length >= 3, `${label}: ${key} received`);
    assert.equal(got, form(final), `${label}: ${key}`);
  }
  await frameFence(s, label);
  assert.deepEqual(s.frames.slice(before).filter((frame) => frame.pane_id === s.pane).map((frame) => frame.type), ["input", "input", "input", "input"], `${label}: each arrow is typed, not a named key`);
}

/** A held new-tab request lets the real type-ahead field catch a logical arrow before the terminal exists. */
async function typeAheadArrow(name: string, mode: string, expected: string): Promise<void> {
  const s = await open(name, "printf '\\033[?1049h';", true);
  const log = join(root, `${name}-ahead.hex`);
  const received = readProbe(log);
  const catchStartedAt = Date.now();
  let create: Route | null = null;
  await s.page.route("**/api/**tab/create", (route) => { create = route; });
  await s.page.locator(".tab-strip-add").click();
  await until(() => create !== null, `${name}: new-tab request is held`);
  const routeHeldAt = Date.now();
  assert.equal(await s.page.evaluate(() => document.activeElement?.className), "type-ahead", `${name}: the new-tab catch owns the keyboard`);
  await s.page.keyboard.press("ArrowUp");
  // Create the server tab while keeping its response from the browser. Start and verify the probe
  // first, so the only caught item is the logical arrow for an already-modeled destination.
  const fetchStartedAt = Date.now();
  const response = await create!.fetch();
  const fetchDoneAt = Date.now();

  let pane: string | undefined;
  await until(async () => {
    pane = (await sessionSnapshot()).panes.find((candidate) => candidate.workspace_id === s.workspaceId && candidate.pane_id !== s.pane)?.pane_id;
    return pane !== undefined;
  }, `${name}: herdr created the new pane`);
  const paneFoundAt = Date.now();
  await paneSendText(pane!, `clear; printf '${mode}'; python3 -u '${probe}' '${log}' plain`);
  await paneSendKeys(pane!, ["Enter"]);
  await probeReady(pane!);
  const probeReadyAt = Date.now();
  const stateBeforeFulfill = await typeAheadState(s.page);
  await create!.fulfill({ response });
  const fulfilledAt = Date.now();
  await until(() => s.isReady(pane!), `${name}: new pane accepts input`);
  const inputReadyAt = Date.now();
  await probeReady(pane!);
  let got = "";
  try {
    await until(() => (got += received()).includes(expected), `${name}: the probe received the mode-correct type-ahead arrow`);
  } catch (error) {
    const evidence = {
      pane: pane!,
      expected,
      got,
      gotHex: Buffer.from(got, "latin1").toString("hex"),
      pageFrames: s.frames,
      targetFrames: s.frames.filter((frame) => frame.pane_id === pane),
      pageSentCount: await s.sentByPage(),
      playwrightFramesHeard: s.framesHeard(),
      stateBeforeFulfill,
      stateAfterFailure: await typeAheadState(s.page),
      timingsMs: {
        catchToRouteHeld: routeHeldAt - catchStartedAt,
        routeFetch: fetchDoneAt - fetchStartedAt,
        fetchToPaneFound: paneFoundAt - fetchDoneAt,
        probeSetup: probeReadyAt - paneFoundAt,
        catchToFulfill: fulfilledAt - catchStartedAt,
        fulfillToInputReady: inputReadyAt - fulfilledAt,
        catchToInputReady: inputReadyAt - catchStartedAt,
      },
    };
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}; diagnostics=${JSON.stringify(evidence)}`);
  }
  assert.equal(got, expected, `${name}: type-ahead arrow bytes`);
  await frameFence(s, name);
  const target = s.frames.filter((frame) => frame.pane_id === pane);
  assert.deepEqual(target.filter((frame) => frame.type === "keys").map((frame) => frame.keys), [["up"]], `${name}: logical arrow stays a named key`);
  assert.equal(target.some((frame) => frame.type === "input" && frame.text === "\x1b[A"), false, `${name}: no hard-coded CSI arrow is sent`);
}

/** Leaving a catch before its pane is made must not send the logical arrow later. */
async function abandonedTypeAheadArrow(): Promise<void> {
  const s = await open("ahead-abandoned", "printf '\\033[?1049h';", true);
  let create: Route | null = null;
  await s.page.route("**/api/**tab/create", (route) => { create = route; });
  await s.page.locator(".tab-strip-add").click();
  await until(() => create !== null, "abandoned arrow: new-tab request is held");
  await s.page.keyboard.press("ArrowUp");
  await s.page.getByPlaceholder("Filter workspaces and agents").click();
  await create!.continue();

  let pane: string | undefined;
  await until(async () => {
    pane = (await sessionSnapshot()).panes.find((candidate) => candidate.workspace_id === s.workspaceId && candidate.pane_id !== s.pane)?.pane_id;
    return pane !== undefined;
  }, "abandoned arrow: herdr created the new pane");
  await until(() => s.isReady(pane!), "abandoned arrow: new pane accepts input");
  await frameFence(s, "abandoned type-ahead arrow");
  assert.deepEqual(s.frames.filter((frame) => frame.pane_id === pane && !frame.automatic), [], "an abandoned type-ahead arrow is never sent to its new pane");
}

/**
 * An arrow pressed while the program's output is still on its way to xterm, as a shell's output after Enter is (#4123),
 * is typed too: named, it waited out hc's quiet period since the last key, and so did every key typed behind it. hc's
 * attach types it in the mode the program reads now, even when that output turns the mode xterm encoded it in off.
 */
async function arrowBehindOutput(): Promise<void> {
  const s = await open("behind-output", "printf '\\033[?1049h\\033[?1l';", true);
  await browserProbeReady(s, "arrow behind output");
  await s.page.locator(".xterm-helper-textarea").focus();
  const signal = async (name: "USR1" | "USR2"): Promise<void> => {
    const kill = Bun.spawn(["pkill", `-${name}`, "-f", s.log], { stderr: "pipe" });
    assert.equal(await kill.exited, 0, `pkill -${name}: ${await new Response(kill.stderr).text()}`);
  };
  type Delayed = { delayedTerminalOutput: { held: () => string; hold: () => void; releaseOnKeyDown: (key: string) => void } };
  let got = "";
  // a person typed: hc's quiet period for a named key runs from here
  await s.page.keyboard.press("a");
  await until(() => (got += s.received()) === "a", "arrow behind output: the letter reached the probe");
  await signal("USR1");
  await until(() => s.page.locator(".xterm-screen").evaluate((screen) => screen.textContent?.includes("CURSOR KEYS APPLICATION") === true), "arrow behind output: xterm parsed application cursor keys");
  await s.page.evaluate(() => (window as unknown as Delayed).delayedTerminalOutput.hold());
  await signal("USR2");
  await until(async () => (await s.page.evaluate(() => (window as unknown as Delayed).delayedTerminalOutput.held())).includes("\x1b[?1l"), "arrow behind output: the output leaving application cursor keys is held from xterm");
  await s.page.evaluate(() => (window as unknown as Delayed).delayedTerminalOutput.releaseOnKeyDown("ArrowUp"));
  const before = s.frames.length;
  const pressed = performance.now();
  await s.page.keyboard.press("ArrowUp");
  got = "";
  await until(() => (got += s.received()).length >= 3, () => `arrow behind output: ArrowUp received (read ${JSON.stringify(got)})`);
  const took = performance.now() - pressed;
  await frameFence(s, "arrow behind output");
  assert.deepEqual(s.frames.slice(before).filter((frame) => frame.pane_id === s.pane && !frame.automatic).map((frame) => [frame.type, frame.text]), [["input", "\x1bOA"]], "arrow behind output: typed as xterm encoded it, in the application mode it still believed in, not a named key");
  assert(took < NO_QUIET_WAIT_MS, `arrow behind output: ArrowUp took ${took.toFixed(0)} ms: exceeded the end-to-end latency budget`);
  assert.equal(got, "\x1b[A", "arrow behind output: the program reads the arrow in the normal cursor mode it is in now");
}

/** Input-ready alone is not the parser fence: delay first-paint output while a real key reaches DECCKM. */
async function delayedFirstPaint(): Promise<void> {
  const s = await open("delayed-first-paint", "printf '\\033[?1049h\\033[?1h';", true, true);
  const pendingOutput = () => s.page.evaluate(() => (window as unknown as { delayedTerminalOutput: { pending: () => number } }).delayedTerminalOutput.pending());
  const queryDelivered = () => s.page.evaluate(() => (window as unknown as { delayedTerminalOutput: { queryDelivered: () => number } }).delayedTerminalOutput.queryDelivered());
  await until(async () => (await pendingOutput()) > 0 && (await queryDelivered()) > 0, "query-only attach preamble is parsed while the mode-bearing first paint is withheld");
  await frameFence(s, "query-only attach preamble");
  const screenHasProbe = await s.page.locator(".xterm-screen").evaluate((screen) => screen.textContent?.includes("PROBE READY plain") === true);
  assert.equal(screenHasProbe, false, "input-ready preceded parsing the held first paint");

  await s.page.locator(".xterm-helper-textarea").focus();
  const before = s.frames.length;
  await s.page.keyboard.press("ArrowUp");
  let got = "";
  await until(() => (got += s.received()).length >= 3, "pre-parse ArrowUp reaches the probe");
  assert.equal(got, "\x1bOA", "the unsynchronized xterm's CSI is not sent; hc encodes the key in DECCKM");
  await frameFence(s, "pre-parse ArrowUp");
  assert.deepEqual(s.frames.slice(before).filter((frame) => frame.pane_id === s.pane && !frame.automatic).map((frame) => frame.type), ["keys"], "pre-parse arrow stays named");

  await s.page.evaluate(() => (window as unknown as { delayedTerminalOutput: { release: () => void } }).delayedTerminalOutput.release());
  await browserProbeReady(s, "released first paint");
  const after = s.frames.length;
  await s.page.keyboard.press("ArrowDown");
  got = "";
  await until(() => (got += s.received()).length >= 3, "post-parse ArrowDown reaches the probe");
  assert.equal(got, "\x1bOB", "after parsing DECCKM, xterm's encoded arrow is correct");
  await frameFence(s, "post-parse ArrowDown");
  assert.deepEqual(s.frames.slice(after).filter((frame) => frame.pane_id === s.pane && !frame.automatic).map((frame) => frame.type), ["input"], "synchronized arrow returns to the fast text path");
}

try {
  const started = Bun.spawn([bin, "run", "--bg", "--json"], { env, stdout: "ignore", stderr: "pipe" });
  assert.equal(await started.exited, 0, `hc run: ${await new Response(started.stderr).text()}`);
  process.env["OVIS_HC_ENV"] = JSON.stringify(env);
  process.env["OVIS_HC_BIN"] = bin;
  process.env["OVIS_RUNTIME"] = "herdr-core";
  setRuntime("herdr-core");
  adapter = await startRuntime(join(root, "ovis-state"), async () => ({ bin, version: "test" }));
  assert(adapter, "herdr-core runtime started");
  server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: join(root, "ovis-state"), token: "" });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });

  // 1. Application cursor keys set before the browser attached: hc's first paint tells xterm, and
  // less, git log and vim read SS3 (ESC O A)
  {
    const s = await open("decckm", "printf '\\033[?1049h\\033[?1h';", true);
    await browserProbeReady(s, "application cursor keys before attach");
    await s.page.locator(".xterm-helper-textarea").focus();
    await arrowsAs(s, "application cursor keys", (final) => `\x1bO${final}`);
  }

  // 2. Set while the browser watches: hc's live stream tells xterm
  {
    const s = await open("live", "printf '\\033[?1049h'; read go; printf '\\033[?1h';");
    await s.page.locator(".xterm-helper-textarea").focus();
    await s.page.keyboard.press("Enter");
    await probeReady(s.pane);
    await browserProbeReady(s, "application cursor keys set while attached");
    await arrowsAs(s, "application cursor keys set while attached", (final) => `\x1bO${final}`);
  }

  // 3. Normal cursor mode (a shell's line editor): CSI, in order with the letters typed around it,
  // and an arrow right after a letter stays within the end-to-end latency budget
  {
    const s = await open("normal", "printf '\\033[?1049h\\033[?1l';", true);
    await browserProbeReady(s, "normal cursor keys");
    await s.page.locator(".xterm-helper-textarea").focus();
    await arrowsAs(s, "normal cursor keys", (final) => `\x1b[${final}`);
    let together = "";
    for (let round = 0; round < 5; round += 1) {
      const pressed = performance.now();
      await s.page.keyboard.press("a");
      await s.page.keyboard.press("ArrowLeft");
      await s.page.keyboard.press("b");
      await until(() => (together += s.received()).length >= (round + 1) * 5, () => `a, ArrowLeft and b received (read ${JSON.stringify(together)})`);
      const took = performance.now() - pressed;
      assert(took < NO_QUIET_WAIT_MS, `a, ArrowLeft and b took ${took.toFixed(0)} ms: exceeded the end-to-end latency budget`);
    }
    assert.equal(together, "a\x1b[Db".repeat(5), "an arrow pressed between two letters arrives between them");
    let got = "";
    await s.page.keyboard.press("Escape");
    await s.page.keyboard.press("ArrowUp");
    await until(() => (got += s.received()).length >= 4, "Escape and ArrowUp received");
    assert.equal(got, "\x1b\x1b[A", "an arrow right after an Escape arrives after it");
    await frameFence(s, "normal mode ordering");
  }

  // 4. Logical arrows caught before a new tab exists stay named: xterm did not encode these bytes.
  await typeAheadArrow("ahead-decckm", "\\033[?1049h\\033[?1h", "\x1bOA");
  await typeAheadArrow("ahead-normal", "\\033[?1049h\\033[?1l", "\x1b[A");
  await abandonedTypeAheadArrow();

  // 5. input-ready is not the xterm parse fence: hold first-paint output, send before parse, then prove fast path returns.
  await delayedFirstPaint();

  // 6. An arrow pressed while output is still on its way to xterm (a shell's prompt after Enter) is typed, in the mode
  // the program reads now.
  await arrowBehindOutput();

  assert.deepEqual(errors, [], "no page errors");
  console.log("terminal arrows on herdr-core: PASS");
} finally {
  await browser?.close().catch((error) => console.log("browser close failed", error));
  await Promise.resolve().then(() => server?.stop()).catch((error) => console.log("server stop failed", error));
  for (const id of owned) await workspaceClose(id).catch((error) => console.log("workspace close failed", id, error));
  adapter?.stop();
  await stopIsolatedCore(bin, env);
  rmSync(root, { recursive: true, force: true });
}
