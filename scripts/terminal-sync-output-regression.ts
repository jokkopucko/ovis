/**
 * Synchronized output (`CSI ? 2026 h` … `CSI ? 2026 l`) from a pane program to the pixels (#1617).
 *
 * A real herdr pane in the test session runs a step-by-step producer: each step is a file the
 * script writes, each answer a file the producer writes once its bytes are out, so every chunk of a
 * frame is written only after the one before it, with no sleeps. Frames are drawn inside 2026
 * blocks and split over several chunks. The bytes are recorded at each hop:
 *
 * - A: herdr's `terminal attach` stream as the server reads it (each PtySession read);
 * - B: the `pty-data` frames as the browser's WebSocket receives them;
 * - C: the client's `pty-ack` for each frame, sent from xterm's write callback in the task that
 *   parsed it, so a frame not yet acked has not been parsed whole;
 * - D: every render of the rows the pane shows (a MutationObserver on `shownRows`: libghostty's
 *   while it draws, xterm's otherwise), decoded back to the frame each row belongs to.
 *
 * A render is `torn` when xterm had parsed a herdr block's open but not its close, and `mixed` when
 * its rows are not all one frame. xterm 5.5 did not honour mode 2026, so a herdr block split over
 * two frames could render half (26 to 46 mixed renders a run, #1617); xterm 6 holds the drawing
 * until the close, so none is.
 *
 * Asserts the brackets pass every hop intact (hop B's bytes are hop A's, every open is closed, at
 * least one block split), no render is mixed or drawn inside an open block, a block left open
 * recovers at the next whole frame, and every frame is rendered whole in the end. What herdr does
 * with a block the pane leaves open (herdr 0.9.5 sends nothing of it until it closes) is herdr's to
 * decide, so it is recorded, not asserted. SYNC_OUTPUT_REPORT=<file> writes the counts as JSON.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { PtySession, type PtySessionOptions } from "../server/pty/session.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { STARTUP_PROBES } from "../server/attach-output.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

type Variant = "plain" | "heavy" | "korean";

function rowText(variant: string, n: number, r: number, cols: number): string {
  const head = String(n % 10000).padStart(4, "0") + "|";
  const set = variant === "korean" ? "가나다라마바사아자차카타파하" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const count = variant === "korean" ? Math.floor((cols - head.length) / 2) : cols - head.length;
  let body = "";
  for (let i = 0; i < count; i++) body += set[(n + r + i) % set.length];
  return head + body + (variant === "korean" && (cols - head.length) % 2 === 1 ? " " : "");
}

const PRODUCER = (dir: string): string => `
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const dir = ${JSON.stringify(dir)};
const rowText = ${rowText.toString()};
const color = (n, r, i) => "\\x1b[38;2;" + ((n * 7 + i * 13) % 256) + ";" + ((r * 29 + i) % 256) + ";" + ((n + i * 5) % 256) + "m";
let rows = [];
process.stdout.write("\\x1b[?7l\\x1b[?25lPRODUCER_READY\\r\\n");
for (let step = 1; ; step++) {
  const file = dir + "/step-" + step;
  for (const deadline = Date.now() + 60000; !existsSync(file);) {
    if (Date.now() > deadline) process.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  const message = JSON.parse(readFileSync(file, "utf8"));
  const cols = process.stdout.columns, height = process.stdout.rows;
  let data = "";
  if (message.kind === "raw") data = message.data;
  else {
    if (message.part === 1) {
      rows = [];
      for (let r = 0; r < height; r++) {
        const text = rowText(message.variant, message.n, r, cols);
        const cells = message.variant === "plain" ? text : [...text].map((c, i) => color(message.n, r, i) + c).join("") + "\\x1b[0m";
        rows.push("\\x1b[" + (r + 1) + ";1H" + cells);
      }
    }
    const from = Math.floor(rows.length * (message.part - 1) / message.parts);
    const to = Math.floor(rows.length * message.part / message.parts);
    data = (message.part === 1 ? "\\x1b[?2026h" : "") + rows.slice(from, to).join("") + (message.part === message.parts && !message.open ? "\\x1b[?2026l" : "");
  }
  await new Promise((resolve) => process.stdout.write(data, resolve));
  writeFileSync(dir + "/answer", JSON.stringify({ cols, rows: height, bytes: Buffer.byteLength(data) }));
  renameSync(dir + "/answer", dir + "/ack-" + step);
}
`;

interface HopChunk { t: number; data: string }

interface HopSummary {
  chunks: number;
  bytes: number;
  opens: number;
  closes: number;
  /** blocks opened and closed (an open inside an open block is herdr's, counted once) */
  blocks: number;
  split: number;
  maxSpan: number;
  maxBlock: number;
  openAtEnd: boolean;
}

const SYNC = /\x1b\[\?2026([hl])/g;

function summarizeHop(chunks: readonly HopChunk[]): HopSummary {
  const summary: HopSummary = { chunks: chunks.length, bytes: 0, opens: 0, closes: 0, blocks: 0, split: 0, maxSpan: 0, maxBlock: 0, openAtEnd: false };
  const text = chunks.map((chunk) => chunk.data).join("");
  const ends: number[] = [];
  let at = 0;
  for (const chunk of chunks) {
    at += chunk.data.length;
    ends.push(at);
    summary.bytes += Buffer.byteLength(chunk.data);
  }
  const chunkOf = (index: number): number => {
    let low = 0, high = ends.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ends[middle]! > index) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  let openedAt = -1;
  for (const match of text.matchAll(SYNC)) {
    if (match[1] === "h") {
      summary.opens++;
      if (openedAt < 0) openedAt = match.index;
    } else {
      summary.closes++;
      if (openedAt < 0) continue;
      const closeEnd = match.index + match[0].length;
      const span = chunkOf(closeEnd - 1) - chunkOf(openedAt) + 1;
      summary.blocks++;
      if (span > 1) summary.split++;
      summary.maxSpan = Math.max(summary.maxSpan, span);
      summary.maxBlock = Math.max(summary.maxBlock, closeEnd - openedAt);
      openedAt = -1;
    }
  }
  summary.openAtEnd = openedAt >= 0;
  return summary;
}

interface PageTap {
  messages: Array<{ t: number; stream: string; offset: number; data: string; replay: boolean; openAfter: boolean }>;
  acks: Array<{ t: number; stream: string; offset: number }>;
  renders: Array<{ t: number; torn: boolean; frame: string | null; rows?: string[] }>;
  expect: { variants: string[]; cols: number } | null;
  keepRows: boolean;
  last: string | null;
  current?: () => string | null;
}

function installSyncTap({ rowSource, shown }: { rowSource: string; shown: string }): void {
  // the one generator the producer draws with; the context bypasses the app's CSP for it
  const rowText = new Function(`return ${rowSource}`)() as (variant: string, n: number, r: number, cols: number) => string;
  const sync = /\x1b\[\?2026([hl])/g;
  const tap: PageTap = { messages: [], acks: [], renders: [], expect: null, keepRows: true, last: null };
  (window as unknown as { __syncTap: PageTap }).__syncTap = tap;
  const openAfter = new Map<string, boolean>();
  let open = false;
  let carry = "";
  const Native = window.WebSocket;
  const send = Native.prototype.send;
  Native.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (typeof data === "string" && data.includes("\"pty-ack\"")) {
      const message = JSON.parse(data) as { stream_id: string; offset: number };
      tap.acks.push({ t: Date.now(), stream: message.stream_id, offset: message.offset });
    }
    return send.call(this, data);
  };
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      // listeners run in the order added: this one sees each frame before the app writes it
      this.addEventListener("message", (event) => {
        if (typeof event.data !== "string" || !event.data.includes("\"pty-data\"")) return;
        const message = JSON.parse(event.data) as { type: string; data: string; replay?: boolean; flow?: { stream_id: string; offset: number } };
        if (message.type !== "pty-data") return;
        const text = carry + message.data;
        for (const match of text.matchAll(sync)) open = match[1] === "h";
        const escape = text.lastIndexOf("\x1b");
        carry = escape >= 0 && text.length - escape < 8 && !/^\x1b\[\?2026[hl]/.test(text.slice(escape)) ? text.slice(escape) : "";
        const stream = message.flow?.stream_id ?? "";
        const offset = message.flow?.offset ?? -1;
        openAfter.set(`${stream}:${offset}`, open);
        tap.messages.push({ t: Date.now(), stream, offset, data: message.data, replay: message.replay === true, openAfter: open });
      });
    }
  };
  const decode = (rows: string[]): string | null => {
    const expect = tap.expect;
    if (!expect) return null;
    let frame: string | null = null;
    for (let r = 0; r < rows.length; r++) {
      const n = Number(rows[r]!.slice(0, 4));
      const variant = expect.variants.find((v) => rows[r] === rowText(v, n, r, expect.cols).trimEnd());
      if (!variant || /\D/.test(rows[r]!.slice(0, 4))) return "mixed";
      const key = String(n);
      if (frame !== null && frame !== key) return "mixed";
      frame = key;
    }
    return frame;
  };
  tap.current = () => {
    const container = document.querySelector(shown);
    return container ? decode([...container.children].map((row) => (row.textContent ?? "").trimEnd())) : null;
  };
  let shownText: string | null = null;
  new MutationObserver((records) => {
    const target = records.find((record) => (record.target instanceof Element ? record.target : record.target.parentElement)?.closest(shown));
    if (!target) return;
    const container = (target.target instanceof Element ? target.target : target.target.parentElement)!.closest(shown)!;
    const ack = tap.acks.at(-1);
    const rows = [...container.children].map((row) => (row.textContent ?? "").trimEnd());
    // a render of the same text drew nothing of an open block: libghostty redraws the shown rows when a late font
    // face (the first Hangul) loads, whenever that is. Every cell changes from frame to frame, so a block's rows never
    // come out as the text already shown
    const text = rows.join("\n");
    const torn = text !== shownText && (ack ? openAfter.get(`${ack.stream}:${ack.offset}`) === true : false);
    shownText = text;
    const frame = decode(rows);
    tap.last = frame;
    tap.renders.push({ t: Date.now(), torn, frame, ...(tap.keepRows && frame === "mixed" ? { rows } : {}) });
  }).observe(document, { subtree: true, childList: true, characterData: true });
}

function tapAttachReads(): HopChunk[] {
  const reads: HopChunk[] = [];
  const proto = PtySession.prototype as unknown as { pump(this: { options: PtySessionOptions }): Promise<void> };
  const pump = proto.pump;
  proto.pump = function () {
    const onData = this.options.onData;
    this.options.onData = (data) => {
      reads.push({ t: Date.now(), data });
      onData(data);
    };
    return pump.call(this);
  };
  return reads;
}


async function openTerminalPage(browser: Browser, port: number, pane: string, viewport = { width: 1600, height: 1000 }): Promise<Page> {
  const context = await browser.newContext({ viewport, bypassCSP: true });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false })));
  await context.addInitScript(installSyncTap, { rowSource: rowText.toString(), shown: shownRows() });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`http://127.0.0.1:${port}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  return page;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function run(): Promise<void> {
  const state = mkdtempSync(join(tmpdir(), "terminal-sync-output-"));
  const dir = join(state, "steps");
  mkdirSync(dir);
  const workspaces: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Browser | undefined;
  const reads = tapAttachReads();
  let step = 0;
  const produce = async (message: Record<string, unknown>): Promise<{ cols: number; rows: number; bytes: number }> => {
    step++;
    writeFileSync(join(dir, "next"), JSON.stringify(message));
    renameSync(join(dir, "next"), join(dir, `step-${step}`));
    const ack = join(dir, `ack-${step}`);
    for (const deadline = Date.now() + 15000; !existsSync(ack);) {
      if (Date.now() > deadline) throw new Error(`the producer did not answer step ${step} (${JSON.stringify(message)})`);
      await Bun.sleep(2);
    }
    return JSON.parse(readFileSync(ack, "utf8"));
  };
  try {
    writeFileSync(join(state, "producer.mjs"), PRODUCER(dir));
    const made = await workspaceCreate({ cwd: state, label: "ovis-test-sync-output" });
    workspaces.push(made.workspace.workspace_id);
    const pane = made.root_pane.pane_id;
    const ready = herdrRpc("pane.wait_for_output", { pane_id: pane, source: "visible", match: { type: "substring", value: "PRODUCER_READY" }, timeout_ms: 10000 }, undefined, 12000)
      .then(() => null, (error: unknown) => error);
    await herdrRpc("pane.send_input", { pane_id: pane, text: `exec ${quote(process.execPath)} ${quote(join(state, "producer.mjs"))}`, keys: ["enter"] });
    const unready = await ready;
    if (unready !== null) throw new Error("the producer never started", { cause: unready });
    server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "server"), tailscaleOwner: null, usage: new UsageService(undefined, []) });
    browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    const page = await openTerminalPage(browser, server.port, pane);
    await page.locator(shownRows(), { hasText: "PRODUCER_READY" }).waitFor();
    const grid = await page.evaluate((shown) => {
      const rows = document.querySelector(shown)!.children.length;
      return { rows };
    }, shownRows());

    let n = 0;
    let whole = 0;
    let size = { cols: 0, rows: 0 };
    const results: Record<string, unknown> = {};
    const frame = async (variant: Variant, parts: number, options: { open?: boolean } = {}): Promise<number> => {
      n++;
      let bytes = 0;
      for (let part = 1; part <= parts; part++) {
        const ack = await produce({ kind: "frame", variant, n, part, parts, open: options.open === true });
        size = { cols: ack.cols, rows: ack.rows };
        bytes += ack.bytes;
      }
      if (!options.open) {
        whole++;
        await page.evaluate(({ cols }) => {
          const tap = (window as unknown as { __syncTap: PageTap }).__syncTap;
          tap.expect = { variants: ["plain", "korean"], cols };
        }, size);
        await page.waitForFunction((key) => (window as unknown as { __syncTap: PageTap }).__syncTap.current!() === key, String(n)).catch(async (error) => {
          const rows = await page.evaluate((shown) => [...document.querySelector(shown)!.children].map((row) => (row.textContent ?? "").trimEnd()), shownRows());
          throw new Error(`frame ${variant}:${n} (${size.cols}x${size.rows}) never showed whole; the rows:\n${rows.join("\n")}`, { cause: error });
        });
      }
      return bytes;
    };

    await frame("plain", 1);
    assert.equal(size.rows, grid.rows, `the producer draws ${size.rows} rows, xterm shows ${grid.rows}`);
    const { armed, messagesArmed } = await page.evaluate(() => {
      const tap = (window as unknown as { __syncTap: PageTap }).__syncTap;
      return { armed: tap.renders.length, messagesArmed: tap.messages.length };
    });
    const readsArmed = reads.length;
    const wholeArmed = whole;

    await produce({ kind: "raw", data: "\x1b[?2026h\x1b[1;1HSTALLMARK" });
    const parsed = await herdrRpc("pane.wait_for_output", { pane_id: pane, source: "visible", match: { type: "substring", value: "STALLMARK" }, timeout_ms: 3000 }, undefined, 5000)
      .then(() => true, () => false);
    const readsBeforeStall = reads.length;
    // fixed wait: proving that nothing of the open block arrives, over many of herdr's frame intervals
    await Bun.sleep(1000);
    const leaked = reads.slice(readsBeforeStall).some((read) => read.data.includes("STALLMARK"));
    results["stall"] = { herdrParsedInsideBlock: parsed, readsWhileOpen: reads.length - readsBeforeStall, leaked };
    await frame("plain", 1);

    const frames: Record<string, { frames: number; producerBytes: number }> = {};
    for (const [variant, parts, count] of [["plain", 3, 20], ["heavy", 4, 20], ["korean", 4, 20]] as const) {
      let producerBytes = 0;
      for (let i = 0; i < count; i++) producerBytes += await frame(variant, parts);
      frames[variant] = { frames: count, producerBytes };
    }
    results["frames"] = frames;

    await frame("heavy", 2, { open: true });
    await frame("plain", 2);
    const frameCount = whole - wholeArmed;

    const tap = await page.evaluate(() => (window as unknown as { __syncTap: PageTap }).__syncTap);
    const attachText = reads.map((read) => read.data).join("");
    // herdr's startup questions: the server answers them and keeps them off hop B
    const strip = (text: string) => STARTUP_PROBES.reduce((rest, [query]) => rest.replace(query, ""), text);
    const hopB = tap.messages.map((message) => message.data).join("");
    const judged = tap.renders.slice(armed);
    const hops = {
      A: summarizeHop(reads.slice(readsArmed)),
      B: summarizeHop(tap.messages.slice(messagesArmed)),
      Aall: summarizeHop(reads),
      Ball: summarizeHop(tap.messages),
      C: { acks: tap.acks.length, framesReceived: tap.messages.length },
      D: {
        renders: judged.length,
        whole: judged.filter((render) => render.frame !== null && render.frame !== "mixed").length,
        mixed: judged.filter((render) => render.frame === "mixed").length,
        torn: judged.filter((render) => render.torn).length,
        tornAndMixed: judged.filter((render) => render.torn && render.frame === "mixed").length,
      },
    };
    const report = { grid: size, results, hops, mixedExamples: judged.filter((render) => render.rows).slice(0, 3) };
    console.log(JSON.stringify({ grid: size, results, hops }, null, 1));
    const reportPath = process.env["SYNC_OUTPUT_REPORT"];
    if (reportPath) writeFileSync(reportPath, JSON.stringify({ ...report, attach: reads, page: tap }, null, 1));
    const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"];
    if (evidence) writeFileSync(join(evidence, "terminal-sync-output.json"), JSON.stringify(report, null, 1));

    assert.equal(strip(attachText), hopB, "the browser's bytes are not the attach stream's");
    // a frame over a pty read (64 KiB) always comes in pieces: without blocks, or without one split, nothing was tested
    assert.ok(hops.B.blocks >= frameCount, `the browser saw ${hops.B.blocks} blocks for ${frameCount} frames`);
    assert.ok(hops.B.split > 0, "no block was split over frames");
    assert.equal(hops.Ball.opens, hops.Aall.opens, "a block open was lost between herdr and the browser");
    assert.equal(hops.Ball.closes, hops.Aall.closes, "a block close was lost between herdr and the browser");
    assert.equal(hops.Ball.openAtEnd, false, "the browser's stream ends inside a block");
    // each frame acked by its flow identity, once: a count alone would let one ack stand in for another
    const identities = (rows: ReadonlyArray<{ stream: string; offset: number }>) => rows.map(({ stream, offset }) => `${stream}:${offset}`).sort();
    assert.deepEqual(identities(tap.acks), identities(tap.messages), "each frame was acked, once");
    // Then: herdr draws a pane's block only once it closes, and a block left open ends at the next frame.
    assert.equal(hops.A.opens, hops.A.closes, "herdr left one of its own blocks open");
    // Then: xterm draws no frame from a block it has not seen close.
    assert.equal(hops.D.torn, 0, `${hops.D.torn} of ${hops.D.renders} renders were drawn inside an open block`);
    assert.equal(hops.D.mixed, 0, `${hops.D.mixed} of ${hops.D.renders} renders mixed two frames`);
    console.log(`PASS synchronized output: ${hops.B.blocks} herdr blocks reached the browser intact, ${hops.B.split} split over frames; ${hops.D.mixed} of ${hops.D.renders} renders mixed, ${hops.D.torn} drawn inside an open block`);
  } finally {
    await browser?.close();
    server?.stop();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => {});
    rmSync(state, { recursive: true, force: true });
  }
}

await run();
