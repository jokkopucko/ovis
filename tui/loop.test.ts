import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRAME_AUTOMATIC_INPUT, FRAME_CLOSE, FRAME_CREDIT, FRAME_DATA, FRAME_RESIZE, HcConnection, HcError, HcReplyError } from "../server/herdr-core/connection.ts";
import { CREDIT_WINDOW, FakeHcCore } from "../server/herdr-core/core.fake.ts";
import { type OvisLayout, OVIS_LAYOUT_DOC, OVIS_LAYOUT_SCHEMA } from "../server/herdr-core/layout-doc.ts";
import { WORKSPACE_NAME_LABEL } from "../server/herdr-core/snapshot.ts";
import { REATTACH_DEADLINE } from "./core/pane.ts";
import { type LoopEnd, startLoop } from "./loop.ts";
import { ending, EXIT_FAILED } from "./start.ts";
import { BEHIND_WRITE_BYTES, BEHIND_WRITE_EVENTS, FIRST_CLAIM_MS, FRAME_PASS_MS, HOLD_RELEASE_MS, LAYOUT_SHOWN_WAIT_MS, NOTICE_SHOW_MS, PASS_CREDIT_BYTES, PASTE_ABANDON_MS, PASTE_LIMIT_BYTES, QUIT_BOUND_MS, RECONNECT_MOST_MS, RESIZE_SETTLE_MS } from "./model/deadlines.ts";
import { focused } from "./model/focus.ts";
import { demo } from "./testing/fixtures/demo.ts";
import { place } from "./testing/fixtures/fixture.ts";
import { SCALE_LARGEST_TAB, SCALE_TERMINALS, SCALE_WORKSPACES, scale } from "./testing/fixtures/scale.ts";
import { HeadlessHost } from "./testing/headless-host.ts";
import { ManualClock, Run, type RunOptions } from "./testing/run.ts";
import { ViewStore } from "./view-store.ts";

/** every test drives the loop on the injected clock; only the socket's own turns are real */
const TEST_MS = 120_000;
const SOAK_MS = 600_000;
/** the most the screen's own heap may grow over the soak's last 480 simulated seconds (measured: well under 1 MB) */
const OWN_HEAP_GROWTH_BYTES = 2 * 1024 * 1024;
/** the link's code once its line was cut and a retry found no core listening (tui/core/link.ts) */
const OFFLINE_CODE = "no_core";
/** the most event-loop turns a test waits for the socket's own work, as tui/testing/run.ts settles */
const SETTLE_TURNS = 2_000;

const runs: Run[] = [];
afterEach(async () => {
  for (const run of runs.splice(0)) await run.close();
});

async function start(options: RunOptions): Promise<Run> {
  const run = await Run.start(options);
  runs.push(run);
  return run;
}

/** A core with `count` terminals in one tab (split side by side), the first zoomed when `zoomed`. */
function oneTab(count: number, zoomed = false): FakeHcCore {
  const core = new FakeHcCore();
  const panes: string[] = [];
  for (let n = 0; n < count; n++) panes.push(place(core, { space: "w", spaceName: "w", tab: "t", tabName: "t" }, `pane ${n}\r\n`));
  if (zoomed) {
    const root = panes.slice(1).reduce<unknown>((tree, leaf) => ({ split: "right", ratio: 0.5, first: tree, second: { leaf } }), { leaf: panes[0] });
    core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: panes[0] }] }] }, version: 1 });
  }
  return core;
}

/** Two agents side by side in one tab, neither with a read turn yet. */
function agentPair(): FakeHcCore {
  const core = oneTab(2);
  for (const terminal of ["t1", "t2"]) core.reportStatus(terminal, { state: "idle", app: "claude" });
  return core;
}

/** One pane in workspace a (t1) and, in workspace b, t2 beside t3 with the zoom on t2; t3's agent needs the user. */
function zoomedElsewhere(): FakeHcCore {
  const core = new FakeHcCore();
  place(core, { space: "a", spaceName: "a", tab: "atab", tabName: "atab" }, "a\r\n");
  for (const n of [0, 1]) place(core, { space: "b", spaceName: "b", tab: "btab", tabName: "btab" }, `b ${n}\r\n`);
  core.reportStatus("t3", { state: "blocked", app: "claude" });
  const beside = { split: "right", ratio: 0.5, first: { leaf: "t2" }, second: { leaf: "t3" } };
  core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: 1, workspaces: [{ id: "a", tabs: [{ id: "atab", root: { leaf: "t1" }, zoomed: null }] }, { id: "b", tabs: [{ id: "btab", root: beside, zoomed: "t2" }] }] }, version: 1 });
  return core;
}

/** The agent in `terminal` works, then rests: its turn ends. */
async function endTurn(run: Run, terminal: string): Promise<void> {
  run.core.reportStatus(terminal, { state: "working", app: "claude" });
  run.core.reportStatus(terminal, { state: "idle", app: "claude" });
  await run.advance(20);
}

/** Each terminal's `herdr.seen` as any client of the core reads it (null: no label). */
async function seenLabels(run: Run): Promise<Record<string, string | null>> {
  const client = new HcConnection(() => run.core.transport());
  try {
    const { terminals } = await client.call("terminal.list", { all: true });
    return Object.fromEntries(terminals.map((terminal) => [terminal.address, terminal.labels?.["herdr.seen"] ?? null]));
  } finally {
    client.close();
  }
}

const channelOf = (run: Run, terminal: string): number => run.core.viewers(terminal).at(-1)!.channel;
/** every byte the screen sent a terminal's program, as hex, read from the fake's log: kept after the terminal is removed */
const sentTo = (run: Run, terminal: string): string => Buffer.concat(run.core.log.flatMap((entry) =>
  entry.what === "frame" && entry.from === "viewer" && entry.terminal === terminal && (entry.kind === FRAME_DATA || entry.kind === FRAME_AUTOMATIC_INPUT) ? [entry.payload] : [])).toString("hex");

it("a refused picker jump under another tab's zoom does not become the last pane", async () => {
  const run = await start({ core: zoomedElsewhere() });
  await run.live();
  run.loop.dispatch({ type: "keys", keys: { last_pane: "prefix+y" }, at: run.clock.current });
  await run.advance(1);
  run.core.conflictNext(2);
  run.type("\x02g/claude\r\r");
  await run.settle();
  const refused = run.loop.model();
  expect(refused.notices.map(({ code }) => code)).toContain("layout_conflict");
  expect(focused(refused.world, refused.focus).pane?.id).toBe("t2");
  expect(refused.focus.previous).toBeNull();
  await run.advance(1);
  await run.keys("ctrl+b,y");
  const after = run.loop.model();
  expect(focused(after.world, after.focus).pane?.id).toBe("t2");
}, TEST_MS);

it("a refused picker jump preserves the previous pane even when the destination zoom shows it", async () => {
  const run = await start({ core: zoomedElsewhere() });
  await run.live();
  for (const id of ["t2", "t1"]) {
    run.loop.dispatch({ type: "select", target: { kind: "pane", id }, at: run.clock.current });
    await run.settle();
  }
  expect(run.loop.model().focus.previous).toBe("t2");
  run.core.conflictNext(2);
  run.type("\x02g/claude\r\r");
  await run.settle();
  const refused = run.loop.model();
  expect(refused.notices.map(({ code }) => code)).toContain("layout_conflict");
  expect(focused(refused.world, refused.focus).pane?.id).toBe("t2");
  expect(refused.focus.previous).toBe("t2");
}, TEST_MS);

/** what the screen sent each terminal's program, by terminal, for every terminal it sent anything (one a split or a new
 * tab made too), so a destination outside the fixture's own terminals is seen */
const received = (run: Run): Record<string, string> => Object.fromEntries([...new Set(run.core.log.flatMap((entry) =>
  entry.what === "frame" && entry.from === "viewer" && (entry.kind === FRAME_DATA || entry.kind === FRAME_AUTOMATIC_INPUT) && entry.terminal !== null ? [entry.terminal] : []))].sort().map((terminal) => [terminal, sentTo(run, terminal)]));
/** each read once the screen settled from the one before: the core answers a write, then tells of what it did, and the
 * screen draws it over its own clock; a read after the instant a pane went live */
async function settled(run: Run): Promise<void> {
  await run.advance(200);
  await run.settle();
  // and every shown pane has its picture, with no attach again still due (a pane a zoom uncovered at another rectangle
  // attaches again at it REATTACH_SETTLE_MS later, unless typing took the terminal first), within a bound
  const drawn = () => !run.loop.panes.deadlines().has(REATTACH_DEADLINE) &&
    run.loop.panes.views().filter((view) => !view.covered).every((view) => view.state.kind !== "Opening" && view.state.kind !== "Painting");
  for (let waited = 0; !drawn() && waited < 2_000; waited += FRAME_PASS_MS) {
    await run.advance(FRAME_PASS_MS);
    await run.settle();
  }
  expect(drawn()).toBe(true);
  await run.advance(FRAME_PASS_MS);
  await run.settle();
  await run.advance(1);
}
/** what the screen copied to the host's clipboard (OSC 52), in order */
const clipsOf = (run: Run): string[] => [...run.host.output().matchAll(/\x1b]52;c;([A-Za-z0-9+/=]+)\x1b\\/g)].map((match) => Buffer.from(match[1]!, "base64").toString());
const framesOf = (run: Run, kind: number, from = 0) => run.sent.slice(from).filter((frame) => frame.kind === kind && frame.channel !== 0);
const megabyte = (fill: string) => fill.repeat(1024 * 1024 / fill.length);

describe("the loop", () => {
  it("nothing in, nothing out: an idle screen writes nothing and keeps only the line's silence watch", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1_000);
    const written = run.host.bytes().length;
    // the event stream credits hc's heartbeats back (the link's flow control): the panes' channels carry nothing
    const panes = new Set(run.core.viewers().map((viewer) => viewer.channel));
    const frames = run.sent.filter((frame) => panes.has(frame.channel)).length;
    await run.advance(10 * 60_000);
    expect(run.host.bytes().length).toBe(written);
    expect(run.sent.filter((frame) => panes.has(frame.channel)).length).toBe(frames);
    expect(run.clock.armed()).toBe(1);
    expect(run.loop.report().due).toEqual(["link:silence"]);
    expect(run.clock.maxArmed).toBe(1);
  }, TEST_MS);

  it("nothing in, nothing out: with no core it ends at once, with no timer and nothing written", async () => {
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "loop-"));
    try {
      const host = new HeadlessHost();
      const clock = new ManualClock();
      const loop = startLoop({ host, clock, socket: join(folder, "none.sock"), keys: undefined });
      const end = await loop.done;
      expect(end).toMatchObject({ kind: "no_core", code: "no_core" });
      expect(clock.armed()).toBe(0);
      expect(clock.maxArmed).toBe(0);
      expect(host.log()).toEqual([]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }, TEST_MS);

  it("rate: a pane that never stops writing gets a frame pass at most every 8 ms", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const from = run.writeTimes.length;
    const passes = run.loop.report().passes;
    for (let n = 0; n < 200; n++) {
      run.core.program("t1").output(`line ${n}\r\n`);
      await run.advance(1);
    }
    const times = run.writeTimes.slice(from);
    expect(times.length).toBeGreaterThan(10);
    for (let at = 1; at < times.length; at++) expect(times[at]! - times[at - 1]!).toBeGreaterThanOrEqual(FRAME_PASS_MS);
    expect(run.loop.report().passes - passes).toBeLessThanOrEqual(Math.ceil(200 / FRAME_PASS_MS) + 1);
    expect(run.clock.maxArmed).toBe(1);
    // the row's numbers: a pass at most every 8 ms, 512 KiB of credit a pass, quit within 2 s
    expect([FRAME_PASS_MS, PASS_CREDIT_BYTES, QUIT_BOUND_MS]).toEqual([8, 512 * 1024, 2_000]);
  }, TEST_MS);

  it("credit follows passes: none between passes, none past the window, then at most 512 KiB a pass", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const credited = run.core.credited("t1");
    const received = run.core.dataTo("t1").join("").length;
    run.core.program("t1").output(megabyte("abcdefgh\r\n"));
    await run.settle();
    expect(run.core.credited("t1")).toBe(credited);
    expect(run.core.dataTo("t1").join("").length - received).toBeLessThanOrEqual(CREDIT_WINDOW);
    for (let pass = 0; pass < 8; pass++) {
      const before = run.core.credited("t1");
      const sent = run.sent.length;
      await run.advance(FRAME_PASS_MS);
      expect(framesOf(run, FRAME_CREDIT, sent).length).toBeLessThanOrEqual(1);
      expect(run.core.credited("t1") - before).toBeLessThanOrEqual(PASS_CREDIT_BYTES);
    }
    expect(run.core.credited("t1")).toBeGreaterThan(credited);
  }, TEST_MS);

  it("credit follows passes: the focused pane first, and no pass hands out more than 512 KiB", async () => {
    const run = await start({ core: oneTab(3) });
    await run.live();
    // the LAST pane in tree order has focus, so tree order alone would credit another first
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t3" }, at: run.clock.current });
    await run.advance(1);
    for (const terminal of ["t1", "t2", "t3"]) run.core.program(terminal).output(megabyte("0123456789abcde\n"));
    await run.settle();
    const focused = channelOf(run, "t3");
    const sent = run.sent.length;
    await run.advance(FRAME_PASS_MS);
    const credits = framesOf(run, FRAME_CREDIT, sent);
    expect(credits[0]?.channel).toBe(focused);
    expect(credits.reduce((sum, frame) => sum + Buffer.from(frame.payload).readUInt32LE(0), 0)).toBeLessThanOrEqual(PASS_CREDIT_BYTES);
    expect(credits.length).toBeLessThan(3);
  }, TEST_MS);

  it("credit follows passes: a pane covered by a zoom gets none, and none leaves while the frame's write is in progress", async () => {
    const run = await start({ core: oneTab(2, true) });
    await run.live();
    expect(run.loop.panes.view("t2")?.covered).toBe(true);
    run.core.program("t2").output(megabyte("covered!\r\n"));
    run.core.program("t1").output("shown\r\n");
    await run.advance(100);
    expect(run.core.credited("t2")).toBe(0);
    let during = -1;
    const before = run.core.credited("t1");
    run.host.duringNextWrite(() => { during = framesOf(run, FRAME_CREDIT).length; });
    const credits = framesOf(run, FRAME_CREDIT).length;
    run.core.program("t1").output("more\r\n");
    await run.advance(FRAME_PASS_MS * 2);
    expect(during).toBe(credits);
    expect(run.core.credited("t1")).toBeGreaterThan(before);
  }, TEST_MS);

  it("hold: a pane inside its program's synchronized update keeps its picture until the hold ends or 1 s passed; others draw; credit flows", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const credited = run.core.credited("t1");
    run.core.program("t1").output("\x1b[?2026hHELD-A");
    run.core.program("t2").output("FREE-B");
    await run.advance(50);
    expect(run.grid().join("\n")).toContain("FREE-B");
    expect(run.grid().join("\n")).not.toContain("HELD-A");
    expect(run.core.credited("t1")).toBeGreaterThan(credited);
    await run.advance(HOLD_RELEASE_MS);
    expect(run.grid().join("\n")).toContain("HELD-A");
    run.core.program("t2").output("\x1b[?2026hHELD-B");
    await run.advance(50);
    expect(run.grid().join("\n")).not.toContain("HELD-B");
    run.core.program("t2").output("\x1b[?2026l");
    await run.advance(50);
    expect(run.grid().join("\n")).toContain("HELD-B");
  }, TEST_MS);

  it("a paste over the limit is refused; the input layer is reset only once no read brought an event for the named wait", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    run.type(`\x1b[200~${"a".repeat(PASTE_LIMIT_BYTES + 10)}`);
    await run.settle();
    expect(run.loop.model().notices.map((notice) => notice.code)).toContain("paste_refused");
    // a slow paste keeps arriving, each piece within the wait: none of it is typed as keys
    for (let piece = 0; piece < 3; piece++) {
      await run.advance(PASTE_ABANDON_MS - 500);
      run.type("bbbb");
      await run.settle();
    }
    await run.advance(PASTE_ABANDON_MS - 1);
    expect(run.loop.report().actions).not.toContain("paste_reset");
    expect(run.core.program("t1").receivedHex()).toBe("");
    await run.advance(1);
    expect(run.loop.report().actions).toContain("paste_reset");
    await run.keys("k");
    await run.advance(20);
    expect(run.core.program("t1").receivedHex()).toBe(Buffer.from("k").toString("hex"));
  }, TEST_MS);

  it("a paste begun in the read that ends a refused paste is framed whole, however long it pauses", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    run.type(`\x1b[200~${"a".repeat(PASTE_LIMIT_BYTES + 10)}`);
    await run.settle();
    expect(run.loop.model().notices.map((notice) => notice.code)).toContain("paste_refused");
    // one read: the refused paste's last bytes and end mark, then a new paste that pauses past the wait
    run.type("aaa\x1b[201~\x1b[200~first ");
    await run.advance(PASTE_ABANDON_MS * 2);
    run.type("second\x1b[201~");
    await run.advance(20);
    expect([run.loop.report().actions.includes("paste_reset"), Buffer.from(run.core.program("t1").receivedHex(), "hex").toString()]).toEqual([false, "first second"]);
  }, TEST_MS);

  it("the loop draws for the host's colour depth: an RGB cell leaves as RGB on a truecolour host, as a palette colour on a 256-colour one", async () => {
    for (const [colorTerm, written, never] of [["truecolor", "38;2;95;135;175", "38;5;67"], ["", "38;5;67", "38;2;"]] as const) {
      const run = await start({ fixture: demo, colorTerm });
      await run.live();
      const from = run.host.output().length;
      run.core.program("t1").output("\x1b[38;2;95;135;175mRGB-CELL\x1b[0m\r\n");
      await run.advance(50);
      const frame = run.host.output().slice(from);
      expect([colorTerm, frame.includes("RGB-CELL"), frame.includes(written), frame.includes(never)]).toEqual([colorTerm, true, true, false]);
      // a host resize makes the painter anew: it still draws for the host's depth
      run.host.resize(100, 30);
      await run.advance(1_000);
      await run.live();
      const resized = run.host.output().length;
      run.core.program("t1").output("\x1b[38;2;95;135;175mRGB-AGAIN\x1b[0m\r\n");
      await run.advance(50);
      const after = run.host.output().slice(resized);
      expect([colorTerm, "after a resize", after.includes("RGB-AGAIN"), after.includes(written), after.includes(never)]).toEqual([colorTerm, "after a resize", true, true, false]);
    }
  }, TEST_MS);

  it("quit detaches: CLOSE on every channel, no terminal killed or removed, the terminal given back", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,q");
    await run.advance(100);
    expect(await run.loop.done).toEqual({ kind: "quit" });
    const closes = run.core.log.filter((entry) => entry.what === "frame" && entry.from === "viewer" && entry.kind === FRAME_CLOSE);
    // both panes of the shown tab and the event stream
    expect(closes.length).toBe(3);
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
    for (const terminal of ["t1", "t2", "t3", "t4"]) expect(run.core.terminal(terminal).state).toBe("live");
    expect(run.host.log().at(-1)).toBe("raw off");
  }, TEST_MS);

  it("a refused clipboard write ends the screen as gone without recording or drawing a copied notice", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("press@27:2,drag@30:2");
    await run.advance(FRAME_PASS_MS);
    const writes = run.host.writeAttempts();
    const drawn = run.host.output();
    run.host.failWrites("EIO");
    await run.keys("release@30:2");
    await run.advance(QUIT_BOUND_MS);

    expect(await run.loop.done).toEqual({ kind: "gone", why: "write-failed" });
    expect(run.host.writeAttempts()).toBe(writes + 1);
    expect(run.host.output()).toBe(drawn);
    expect(run.loop.model().notices.map(({ code }) => code)).not.toContain("copied");
  }, TEST_MS);

  it("quit detaches when giving the terminal back fails: done settles within the bound, a quit with the write's code", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const ended: { how: Awaited<typeof run.loop.done> | null } = { how: null };
    void run.loop.done.then((how) => { ended.how = how; });
    run.host.failWrites("EBADF");
    // the prefix and the detach key in one read: the quit starts before any frame could be written
    run.type("\x02q");
    await run.advance(QUIT_BOUND_MS);
    expect(ended.how).toEqual({ kind: "quit", leaveError: "EBADF" });
    expect(run.loop.report().leaveError).toBe("EBADF");
    expect(run.sent.filter((frame) => frame.kind === FRAME_CLOSE).length).toBe(3);
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
    for (const terminal of ["t1", "t2", "t3", "t4"]) expect(run.core.terminal(terminal).state).toBe("live");
  }, TEST_MS);

  it("a detach behind a layout write leaves within the quit bound: with the core silent mid-close, the prefix and q", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    run.muted = true;
    let ended = false;
    void run.loop.done.then(() => { ended = true; });
    // a close: its write waits on a core that answers nothing, and typing waits behind it
    run.type("\x02x");
    await run.advance(20);
    run.type("\x02q");
    await run.advance(QUIT_BOUND_MS + 100);
    expect(ended).toBe(true);
    expect(await run.loop.done).toEqual({ kind: "quit" });
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
  }, TEST_MS);

  it("a detach behind an action in the same read leaves within the quit bound behind a layout write too", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    // a printable prefix: a zoom and the detach after it are one text run, so the detach is the rest of that run
    run.loop.dispatch({ type: "keys", keys: { prefix: "-" }, at: run.clock.current });
    await run.advance(1);
    run.muted = true;
    let ended = false;
    void run.loop.done.then(() => { ended = true; });
    run.type("-x");
    await run.advance(20);
    run.type("-z-q");
    await run.advance(QUIT_BOUND_MS + 100);
    expect(ended).toBe(true);
    expect(await run.loop.done).toEqual({ kind: "quit" });
  }, TEST_MS);

  it("a menu choice passes the rest of its read on: an entry chosen by Enter, then text and Enter, alike read whole, split and a byte at a time", async () => {
    const outcome = async (reads: string[]) => {
      const run = await Run.start({ fixture: demo });
      try {
        await run.live();
        await run.advance(1);
        for (const read of reads) {
          run.type(read);
          await run.advance(200);
          await run.settle();
          await run.advance(FRAME_PASS_MS);
          await run.settle();
          await run.advance(1);
        }
        const model = run.loop.model();
        return { focus: model.focus, overlays: model.overlays.map((overlay) => overlay.kind), received: ["t1", "t2", "t3", "t4"].map((terminal) => run.core.program(terminal).receivedHex()) };
      } finally {
        await run.close();
      }
    };
    // the prefix and Enter open herdr's menu; Enter chooses its first entry (settings) and closes it; z and Enter go to
    // the focused pane after it
    const bytes = "\x02\r\rz\r";
    const joined = await outcome([bytes]);
    expect(joined.received).toEqual([Buffer.from("z\r").toString("hex"), "", "", ""]);
    expect({ outcome: await outcome([...bytes]) }).toEqual({ outcome: joined });
    for (let cut = 1; cut < bytes.length; cut++) expect({ cut, outcome: await outcome([bytes.slice(0, cut), bytes.slice(cut)]) }).toEqual({ cut, outcome: joined });
  }, TEST_MS);

  it("a second layout action read while one is under way is refused as busy: a close pressed twice ends only the pane it was pressed on", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    // two reads before the first close's write could be answered: the second meets the layout the user saw too
    run.type("\x02x");
    run.type("\x02x");
    await settled(run);
    expect(run.core.calls().filter(({ method }) => method === "terminal.kill").map(({ params }) => params["terminal"])).toEqual(["t1"]);
    expect(run.core.terminal("t2").state).toBe("live");
    expect(run.loop.model().notices.map(({ code, data }) => [code, data["action"]])).toEqual([["layout_busy", "close_pane"]]);
  }, TEST_MS);

  it("a refused layout action's keys are taken, not replayed: with two panes, close twice, then Enter reaches the survivor", async () => {
    // the second press in the same read as the first, and in a read of its own; the core telling of the close before
    // it answers, or answering first
    for (const [reads, answerFirst] of [[["\x02x\x02x"], false], [["\x02x", "\x02x"], false], [["\x02x\x02x"], true], [["\x02x", "\x02x"], true]] as const) {
      const run = await start({ core: oneTab(2) });
      await run.live();
      await run.advance(1);
      run.core.holdingEvents = answerFirst;
      for (const read of reads) run.type(read);
      await settled(run);
      run.core.releaseEvents();
      await settled(run);
      // once t1 is gone, the same keys replayed would open the close-workspace dialog, and Enter would end t2
      run.type("\r");
      await settled(run);
      expect([reads, run.core.calls().filter(({ method }) => method === "terminal.kill").map(({ params }) => params["terminal"]), run.loop.report().mode.overlays, sentTo(run, "t2")])
        .toEqual([reads, ["t1"], [], Buffer.from("\r").toString("hex")]);
      expect(run.loop.model().notices.map(({ code }) => code)).toContain("layout_busy");
    }
  }, TEST_MS);

  it("refusing a dialog or mode opener leaves its plain tail for the survivor", async () => {
    // No dialog, navigate mode or copy mode opens during the hold, so y and m remain plain pane input (in copy mode y
    // would copy); each opener is refused with the one notice.
    for (const [keys, tail, refused] of [[["\x02Dy"], "y", "close_workspace"], [["\x02D", "y"], "y", "close_workspace"], [["\x02wm"], "m", "workspace_picker"], [["\x02w", "m"], "m", "workspace_picker"],
      [["\x02[y"], "y", "copy_mode"], [["\x02[", "y"], "y", "copy_mode"]] as const) {
      for (const answerFirst of [false, true]) {
        const label = { keys, answerFirst };
        const run = await start({ core: oneTab(2) });
        await run.live();
        await run.advance(1);
        run.core.holdingEvents = answerFirst;
        run.type("\x02x");
        for (const key of keys) run.type(key);
        await settled(run);
        run.core.releaseEvents();
        await settled(run);
        expect([label, run.loop.report().mode.overlays, run.loop.model().mode.name, run.loop.model().notices.filter(({ code }) => code === "layout_busy").map(({ data }) => data["action"])])
          .toEqual([label, [], "terminal", [refused]]);
        run.type("\r");
        await settled(run);
        expect([label, run.core.calls().filter(({ method }) => method === "terminal.kill").map(({ params }) => params["terminal"]), sentTo(run, "t2")])
          .toEqual([label, ["t1"], Buffer.from(tail + "\r").toString("hex")]);
        await run.close();
      }
    }
  }, TEST_MS);

  it("input behind a close goes to the pane focus moves to once the closed pane left the world, whichever came first", async () => {
    // two and three panes; the core tells of the close before it answers, or answers first; the text in the close's
    // own read or in a read of its own
    for (const panes of [2, 3]) {
      for (const answerFirst of [false, true]) {
        for (const reads of [["\x02xabc"], ["\x02x", "abc"]]) {
          const run = await start({ core: oneTab(panes) });
          await run.live();
          await run.advance(1);
          const label = { panes, answerFirst, reads };
          run.core.holdingEvents = answerFirst;
          for (const read of reads) run.type(read);
          await settled(run);
          expect([label, run.core.calls().filter(({ method }) => method === "terminal.rm").length, sentTo(run, "t1")]).toEqual([label, 1, ""]);
          run.core.releaseEvents();
          await settled(run);
          const state = run.loop.model();
          expect([label, state.focus.panes["t"], sentTo(run, "t1"), sentTo(run, "t2"), state.notices.map(({ code }) => code)])
            .toEqual([label, "t2", "", Buffer.from("abc").toString("hex"), []]);
          await run.close();
        }
      }
    }
  }, TEST_MS);

  it("input behind a close whose pane never leaves the world is refused once the wait ends, and reaches no pane", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    await run.advance(1);
    run.core.holdingEvents = true;
    run.type("\x02xabc");
    await settled(run);
    await run.advance(LAYOUT_SHOWN_WAIT_MS);
    expect([sentTo(run, "t1"), sentTo(run, "t2"), run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])]).toEqual(["", "", [["input_dropped", "not_closed"]]]);
    run.core.releaseEvents();
    await settled(run);
    // the screen catches up, and what comes after goes to the survivor as usual
    run.type("d");
    await settled(run);
    expect([sentTo(run, "t1"), sentTo(run, "t2")]).toEqual(["", Buffer.from("d").toString("hex")]);
  }, TEST_MS);

  it("a close preflight timeout releases held text to the original pane without ending any terminal", async () => {
    for (const reads of [["\x02xabc"], ["\x02x", "abc"]]) {
      const run = await start({ core: oneTab(2) });
      await run.live();
      await run.advance(1);
      const call = run.loop.link.call.bind(run.loop.link);
      run.loop.link.call = async (method, params, timeout) => {
        if (method === "terminal.list") {
          run.loop.link.call = call;
          throw new HcError("timeout", "no answer to the preflight read");
        }
        return call(method, params, timeout);
      };
      for (const read of reads) run.type(read);
      await settled(run);
      expect(run.core.calls().filter(({ method }) => method === "terminal.kill" || method === "terminal.rm")).toEqual([]);
      expect(received(run)).toEqual({ t1: Buffer.from("abc").toString("hex") });
      expect(run.loop.link.state.kind).toBe("Online");
      expect(run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])).toEqual([["layout_refused", "timeout"]]);
      await run.close();
    }
  }, TEST_MS);

  it.each(["removed", "already gone", "rm refused", "answer lost", "remote timeout"] as const)("a partial close with a sibling %s routes held input independently of event order", async (third) => {
    for (const answerFirst of [false, true]) {
      const run = await start({ core: oneTab(3) });
      await run.live();
      await run.advance(1);
      run.core.holdingEvents = answerFirst;
      const call = run.loop.link.call.bind(run.loop.link);
      run.loop.link.call = async (method, params, timeout) => {
        if ("terminal" in params) {
          if (method === "terminal.kill" && params.terminal === "t2") throw new HcReplyError("blocked", "kill refused");
          if (method === "terminal.kill" && params.terminal === "t3" && third === "remote timeout") throw new HcReplyError("timeout", "machine did not answer");
          if (method === "terminal.rm" && params.terminal === "t3") {
            if (third === "rm refused") throw new HcReplyError("blocked", "remove refused");
            if (third === "already gone") await call(method, params, timeout); // the record is gone when our call arrives
            if (third === "answer lost") {
              await call(method, params, timeout); // it ran, but this client cannot know that
              throw new HcError("timeout", "no answer");
            }
          }
        }
        return call(method, params, timeout);
      };
      run.type("\x02Dyabc");
      await settled(run);
      if (answerFirst) expect(received(run)).toEqual({});
      run.core.releaseEvents();
      await settled(run);
      const reason = third === "answer lost" || third === "remote timeout" ? "layout_unknown" : third === "rm refused" ? "not_closed" : null;
      expect(received(run)).toEqual(reason ? {} : { t2: Buffer.from("abc").toString("hex") });
      expect(run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])).toEqual([
        reason === "layout_unknown" ? ["layout_unknown", undefined] : ["layout_refused", "blocked"],
        ...(reason ? [["input_dropped", reason]] : []),
      ]);
      await run.close();
    }
  }, TEST_MS);

  it("input behind a write that makes a pane waits until the screen shows that pane, and never reaches the pane before", async () => {
    const focusOf = (run: Run) => { const state = run.loop.model(); return state.focus.panes[state.focus.tabs[state.focus.workspace!]!]; };
    const notices = (run: Run) => run.loop.model().notices.map(({ code, data }) => [code, data["reason"]]);
    for (const shown of [true, false]) {
      const run = await start({ fixture: demo });
      await run.live();
      await run.advance(1);
      run.type("\x02c");
      await settled(run);
      // the core answers the new tab's write before it tells of the new pane
      run.core.holdingEvents = true;
      // the name, Enter and text in one read: the text waits behind the new tab's write
      run.type("logs\rabc");
      await settled(run);
      expect([shown, "answered", run.core.calls().some(({ method }) => method === "terminal.run"), focusOf(run), sentTo(run, "t1")]).toEqual([shown, "answered", true, "t1", ""]);
      // never shown in time: the text is refused; shown in time: it goes to the new pane (which refuses it while it opens)
      if (!shown) await run.advance(LAYOUT_SHOWN_WAIT_MS);
      run.core.releaseEvents();
      await settled(run);
      expect([shown, focusOf(run), sentTo(run, "t1"), sentTo(run, "t5"), notices(run)])
        .toEqual([shown, "t5", "", "", [shown ? ["input_refused", "opening"] : ["input_dropped", "not_shown"]]]);
    }
  }, TEST_MS);

  /** herdr's new workspace key after the prefix (prefix+shift+n). */
  const NEW_WORKSPACE = "\x02N";
  /**
   * An empty core this screen leaves empty: its layout document holds another screen's claim to open the first workspace
   * (tui/core/layout.ts `claimFirst`), so the user's own new workspace is the first pane there.
   */
  const claimedEmpty = (): FakeHcCore => {
    const core = new FakeHcCore();
    core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: OVIS_LAYOUT_SCHEMA, workspaces: [], first_workspace: { opening: true, until: FIRST_CLAIM_MS } }, version: 1 });
    return core;
  };

  it.each([[true, "joined"], [true, "split"], [false, "joined"], [false, "split"]] as const)(
    "empty-core creation classifies pane input before any pane exists: shown=%s, %s", async (shown, ordering) => {
      const run = await start({ core: claimedEmpty() });
      // the screen's own look at the empty core is a layout write: the frame after it ends its hold
      await run.advance(FRAME_PASS_MS);
      expect(run.loop.model().world.workspaces).toEqual([]);
      run.core.holdingEvents = true;
      if (ordering === "joined") run.type(NEW_WORKSPACE + "abc");
      else { run.type(NEW_WORKSPACE); run.type("abc"); }
      await settled(run);
      expect(run.core.calls().some((call) => call.method === "terminal.run")).toBe(true);
      expect(run.loop.model().focus.workspace).toBeNull();
      expect(received(run)).toEqual({});
      if (!shown) await run.advance(LAYOUT_SHOWN_WAIT_MS);
      run.core.releaseEvents();
      await settled(run);
      expect(received(run)).toEqual({});
      expect(run.loop.model().notices.map(({ code, data }) => [code, data["reason"]]))
        .toEqual([[shown ? "input_refused" : "input_dropped", shown ? "opening" : "not_shown"]]);
      await run.live();
      run.type("z");
      await settled(run);
      expect(received(run)).toEqual({ t1: "7a" });
    }, TEST_MS);

  it.each([
    ["refused", "joined"], ["refused", "split"], ["unknown", "joined"], ["unknown", "split"],
    ["success", "joined"], ["success", "split"],
  ] as const)("empty-core input belongs to its creation when another client arrives first: %s, %s", async (outcome, ordering) => {
    const run = await start({ core: claimedEmpty() });
    await run.advance(FRAME_PASS_MS);
    const entered = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const call = run.loop.link.call.bind(run.loop.link);
    let requests = 0;
    let created: string | null = null;
    // Observe the real pane-input boundary without bypassing its opening/attachment checks.
    const focusPane = run.loop.panes.focus.bind(run.loop.panes);
    const inputPane = run.loop.panes.input.bind(run.loop.panes);
    let destination: string | null = null;
    const attempts: (string | null)[] = [];
    run.loop.panes.focus = (pane) => { destination = pane; focusPane(pane); };
    run.loop.panes.input = (input) => {
      if (input.type === "text" && input.text === "abc") attempts.push(destination);
      return inputPane(input);
    };
    run.loop.link.call = async (method, params, timeout) => {
      if (method === "terminal.run") {
        run.loop.link.call = call;
        requests++;
        entered.resolve();
        await answer.promise;
        if (outcome === "refused") throw new HcReplyError("blocked", "create refused");
        if (outcome === "unknown") throw new HcError("timeout", "create answer lost");
        const result = await call(method, params, timeout);
        if (!("address" in result) || typeof result.address !== "string") throw new Error("creation returned no address");
        created = result.address;
        return result;
      }
      return call(method, params, timeout);
    };
    try {
      if (ordering === "joined") run.type(NEW_WORKSPACE + "abc");
      else { run.type(NEW_WORKSPACE); run.type("abc"); }
      await entered.promise;
      expect(run.loop.model().focus.workspace).toBeNull();
      const rival = place(run.core, { space: "rival", spaceName: "rival", tab: "rival-tab", tabName: "rival" }, "$ ");
      await run.live();
      await settled(run);
      expect(run.loop.model().focus.panes["rival-tab"]).toBe(rival);
      expect(run.core.program(rival).receivedHex()).toBe("");
      answer.resolve();
      await settled(run);
      expect(requests).toBe(1);
      expect(run.core.program(rival).receivedHex()).toBe("");
      expect(attempts).toEqual(outcome === "success" ? [created] : []);
      const notices = run.loop.model().notices.map(({ code, data }) => [code, data["reason"]]);
      if (outcome === "success") {
        expect(created).not.toBeNull();
        expect(created).not.toBe(rival);
        expect(notices).toEqual([["input_refused", "opening"]]);
      } else {
        expect(notices).toEqual(outcome === "unknown"
          ? [["layout_unknown", undefined], ["input_dropped", "layout_unknown"]]
          : [["layout_refused", "blocked"], ["input_dropped", "not_shown"]]);
      }
      await run.live();
      run.type("z");
      await settled(run);
      expect(received(run)).toEqual({ [outcome === "success" ? created! : rival]: "7a" });
    } finally {
      answer.resolve();
    }
  }, TEST_MS);

  it("what waits behind a layout write is bounded: past its bytes or events nothing more waits, no paste is cut, and a detach still leaves", async () => {
    const hex = (text: string) => Buffer.from(text).toString("hex");
    const dropped = (run: Run) => run.loop.model().notices.filter(({ code }) => code === "input_dropped").map(({ data }) => data["reason"]);
    // bytes: a paste that would pass the bound is refused whole, and what follows it waits no more
    const bytes = await start({ fixture: demo });
    await bytes.live();
    await bytes.advance(1);
    // every read before the close's write could be answered
    bytes.type("\x02x");
    bytes.type("xyz");
    bytes.type(`\x1b[200~${"a".repeat(BEHIND_WRITE_BYTES - 2)}\x1b[201~`);
    bytes.type("b");
    await settled(bytes);
    expect([sentTo(bytes, "t1"), sentTo(bytes, "t2"), dropped(bytes)]).toEqual(["", hex("xyz"), ["full"]]);
    // events: the one past the bound and all after it go nowhere
    const events = await start({ fixture: demo });
    await events.live();
    await events.advance(1);
    events.type("\x02x");
    for (let n = 0; n < BEHIND_WRITE_EVENTS; n++) events.type("a");
    events.type("c");
    await settled(events);
    expect([sentTo(events, "t1"), sentTo(events, "t2") === hex("a".repeat(BEHIND_WRITE_EVENTS)), dropped(events)]).toEqual(["", true, ["full"]]);
    // full, with a core that never answers: the prefix and q still leave at once
    for (const overflow of ["events", "first text"]) {
      const full = await start({ fixture: demo });
      await full.live();
      await full.advance(1);
      full.muted = true;
      let ended = false;
      void full.loop.done.then(() => { ended = true; });
      full.type("\x02x");
      if (overflow === "events") for (let n = 0; n <= BEHIND_WRITE_EVENTS; n++) full.type("a");
      else full.type("a".repeat(BEHIND_WRITE_BYTES + 1));
      full.type("\x02");
      full.type("q");
      await full.advance(QUIT_BOUND_MS + 100);
      expect([overflow, dropped(full), ended]).toEqual([overflow, ["full"], true]);
    }
  }, TEST_MS);

  it("a key's own text counts against the bytes that wait: a paste at the bound fits, a kitty key with text after it does not", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    // every read before the close's write could be answered; the kitty key reports the text it typed (CSI code;mods;text u)
    run.type("\x02x");
    run.type(`\x1b[200~${"a".repeat(BEHIND_WRITE_BYTES)}\x1b[201~`);
    run.type("\x1b[98;1;98u");
    await settled(run);
    const sent = sentTo(run, "t2");
    expect([sent.length / 2, sent.endsWith(Buffer.from("b").toString("hex")), run.loop.model().notices.filter(({ code }) => code === "input_dropped").map(({ data }) => data["reason"])])
      .toEqual([BEHIND_WRITE_BYTES, false, ["full"]]);
  }, TEST_MS);

  it("a prefix read once the queue is full leaves no prefix armed: alone, before a focus loss or before a refused key, and q after the release is typed", async () => {
    // the prefix takes no place in what waits; what waits is past its bound, so the key it waited for may be gone
    for (const after of ["", "\x1b[O", "z"]) {
      const run = await start({ core: oneTab(2) });
      await run.live();
      await run.advance(1);
      let ended = false;
      void run.loop.done.then(() => { ended = true; });
      // every read before the close's write could be answered: the last a goes past the bound
      run.type("\x02x");
      for (let n = 0; n <= BEHIND_WRITE_EVENTS; n++) run.type("a");
      run.type("\x02");
      if (after !== "") run.type(after);
      await settled(run);
      expect([after, run.loop.model().armed, run.loop.model().notices.filter(({ code }) => code === "input_dropped").map(({ data }) => data["reason"])]).toEqual([after, false, ["full"]]);
      // after the release: q is typed into the survivor, not a detach
      run.type("q");
      await settled(run);
      expect([after, ended, sentTo(run, "t2") === Buffer.from(`${"a".repeat(BEHIND_WRITE_EVENTS)}q`).toString("hex")]).toEqual([after, false, true]);
    }
  }, TEST_MS);

  it("a focus loss behind a layout write disarms the prefix in order: q after it is typed, not a detach; without it, q detaches", async () => {
    for (const focus of [true, false]) {
      const run = await start({ fixture: demo });
      await run.live();
      await run.advance(1);
      let ended = false;
      void run.loop.done.then(() => { ended = true; });
      // every read before the close's write could be answered
      run.type("\x02x");
      run.type("\x02");
      if (focus) {
        run.type("\x1b[O");
        run.type("\x1b[I");
      }
      run.type("q");
      await settled(run);
      expect([focus, ended]).toEqual([focus, !focus]);
      if (focus) expect([sentTo(run, "t1"), sentTo(run, "t2")]).toEqual(["", Buffer.from("q").toString("hex")]);
    }
  }, TEST_MS);

  it("random key sequences route alike read whole, split at every byte, and a byte at a time", async () => {
    // prefix actions (moves, zoom, close, help, the workspace picker, resize mode, rename, a new tab's name, detach), text
    // with combining marks, a ZWJ emoji, CJK and wide characters, and Enter; with the default prefix (a key of its own)
    // and with a printable one (one text run holds the actions and what follows them)
    // copy mode (prefix+[), its search box (/) and its hint labels (f, then a digit: the second pane shows a path) too
    const ACTIONS = ["l", "h", "z", "x", "?", "q", "w", "r", "P", "c", "["];
    const TEXT = ["a", "q", "/", "f", "1", "e\u0301", "\u0301", "\u{1F469}\u200D\u{1F4BB}", "한", "中", "\uFF21", "\r"];
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    /** Where a sequence is read: the core, what happened on the screen before its first read, and what is typed once it settled. */
    interface Scene { readonly options: () => RunOptions; readonly given?: (run: Run) => Promise<void>; readonly then?: string }
    const DEMO: Scene = { options: () => ({ fixture: demo }) };
    const ZOOMED: Scene = { options: () => ({ core: oneTab(3, true) }) };
    // one pane with sixty rows, most of them history
    const history = Array.from({ length: 60 }, (_, n) => `https://example.org/${n}`).join("\r\n") + "\r";
    const HISTORY: Scene = { options: () => ({ fixture: { build: (core: FakeHcCore) => void place(core, { space: "w", spaceName: "w", tab: "t", tabName: "t" }, history) } }) };
    // `glued`: byte offsets inside a mouse report; a read cut there is followed at once by the rest, as a terminal writes
    // whole reports (one cut 200 ms apart would be an Escape key and text)
    const outcome = async (prefix: string, reads: Uint8Array[], scene = DEMO, settleBetween = scene === DEMO, glued: ReadonlySet<number> = new Set()) => {
      const run = await Run.start(scene.options());
      try {
        await run.live();
        if (prefix !== "\x02") run.loop.dispatch({ type: "keys", keys: { prefix }, at: run.clock.current });
        await run.advance(1);
        await scene.given?.(run);
        let ended = false;
        void run.loop.done.then(() => { ended = true; });
        let offset = 0;
        for (const [at, read] of reads.entries()) {
          run.host.feed(read);
          offset += read.length;
          // a read cut inside a character is followed at once by the rest of it, as a terminal writes whole characters:
          // the framer stamps a character with the time of its first byte, and a pane refuses what was read before its
          // picture, so a character's halves read 200 ms apart would meet a newer picture; any other read comes once the
          // screen settled
          const inside = (reads[at + 1]?.[0] ?? 0) >> 6 === 0b10 || glued.has(offset);
          if (settleBetween || at === reads.length - 1) {
            if (inside) await run.advance(1);
            else await settled(run);
          }
        }
        if (scene.then !== undefined) {
          run.type(scene.then);
          await settled(run);
        }
        const model = run.loop.model();
        const layout = run.core.docs.get(OVIS_LAYOUT_DOC)?.value as OvisLayout | undefined;
        // a new tab's id is made at random: such ids are named by where they first appear, so equal outcomes compare equal
        const made = new Map<string, string>();
        const named = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(/ovis-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, (id) => {
          if (!made.has(id)) made.set(id, `made-${made.size}`);
          return made.get(id)!;
        }));
        return named({
          ended, busy: model.notices.some((notice) => notice.code === "layout_busy"), focus: model.focus, shown: focused(model.world, model.focus).pane?.id ?? null, mode: model.mode.name, panes: model.world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes.map((pane) => pane.id))).sort(), zoomed: layout?.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => tab.zoomed)) ?? [],
          clips: clipsOf(run),
          // where each pane's view rests in its history: copy mode gives back the offset it was entered at
          tops: Object.fromEntries(run.loop.panes.views().map((view) => {
            const shown = view.emulator?.history();
            return [view.terminal, shown?.ok ? shown.value.viewportTop : null];
          })),
          overlays: model.overlays.map((overlay) => ("field" in overlay ? `${overlay.kind}:${overlay.field.graphemes.join("|")}` : overlay.kind)),
          received: received(run),
          // the read state every Herdr client shares: who looked at what must not depend on the cut either
          seen: await seenLabels(run),
        });
      } finally {
        await run.close();
      }
    };
    // A detach never waits for a layout write (it leaves at once), so a write still under way when the screen left may
    // or may not have landed: for a run that detached, only that it left and what each program was sent are compared.
    // Reads with the screen settled between them are each followed by a frame, so a person saw every pane the focus
    // stopped on, and read whole they saw only the last: who looked at what is compared where no frame came between.
    type Outcome = Awaited<ReturnType<typeof outcome>>;
    const compared = (seen: Outcome, framesBetween = false) => (seen.ended ? { ended: true, received: seen.received } : framesBetween ? { ...seen, seen: null } : seen);
    // mouse reports (SGR, 1-based) on the demo at 120x40: a right-click on the first pane, two left clicks and a move where
    // the menu it opens lists its first entries, and a click in the sidebar
    const report = (code: number, col: number, row: number, press = true) => `\x1b[<${code};${col};${row}${press ? "M" : "m"}`;
    const click = (code: number, col: number, row: number) => report(code, col, row) + report(code, col, row, false);
    const MOUSE = { right: click(2, 51, 6), first: click(0, 52, 7), second: click(0, 52, 8), hover: report(35, 53, 8), sidebar: click(0, 5, 4) };
    const pointer = (token: string) => token.startsWith("\x1b[<");
    /** the byte offsets inside each mouse report of `tokens` joined (every report is ASCII: one byte a character) */
    const gluedIn = (tokens: readonly string[]): Set<number> => {
      const glued = new Set<number>();
      let at = 0;
      for (const token of tokens) {
        // a click is two reports: each is whole, the cut between them is a read boundary like any other
        if (!pointer(token)) {
          at += new TextEncoder().encode(token).length;
          continue;
        }
        for (const one of token.match(/\x1b\[<[^Mm]*[Mm]/g)!) {
          for (let inner = 1; inner < one.length; inner++) glued.add(at + inner);
          at += one.length;
        }
      }
      return glued;
    };
    // A hold refuses every action except detach, and every overlay or mode input, so a read with one after a possible
    // layout write differs by design from split reads, where the write may finish first. Such a sequence is marked
    // generously from tokens: any possible write followed by a non-detach action or a pointer report (a press on an
    // overlay's cells is refused in a hold too). A right-click menu's entries write (the second clears the pane's name),
    // so a click where they lie once the menu may be open counts as a write. Any other must never be refused.
    // A click in the sidebar shows another workspace, whose pane refuses what was read before its picture: what follows
    // it in the same read differs from the same input read after that picture, by the pane's own rule, and is marked too.
    const refusesInHold = (picked: readonly string[], prefix: string) => {
      let resize = false;
      let wrote = false;
      let menu = false;
      let shown = false;
      return picked.some((token) => {
        if (shown) return true;
        shown = token === MOUSE.sidebar;
        if (wrote && ((token.startsWith(prefix) && token !== `${prefix}q`) || pointer(token))) return true;
        if (token === `${prefix}r`) resize = true;
        menu ||= token === MOUSE.right;
        wrote ||= token === `${prefix}z` || token === `${prefix}x` || token === "\r" || (resize && (token === `${prefix}h` || token === `${prefix}l`)) ||
          (menu && (token === MOUSE.first || token === MOUSE.second));
        return false;
      });
    };
    const FOCUS_IN = "\x1b[I";
    const FOCUS_OUT = "\x1b[O";
    const hostFocus = async (run: Run, report: string) => {
      run.type(report);
      await run.advance(20);
    };
    /** Another client marks `terminal`'s turn unread. */
    const markUnread = async (run: Run, terminal: string) => {
      const other = new HcConnection(() => run.core.transport());
      await other.call("terminal.label", { terminal, labels: { "herdr.seen": "0" } });
      other.close();
      await run.advance(20);
    };
    /** Two agents side by side, and what happened on the screen before the reads. */
    const agents = (given: (run: Run) => Promise<void>): Scene => ({ options: () => ({ core: agentPair() }), given });
    // under a host that reports its focus, t2 with a turn nobody read, in navigate mode: every read comes with no frame between
    const UNREAD = agents(async (run) => { await hostFocus(run, FOCUS_IN); await endTurn(run, "t2"); await run.keys("ctrl+b,w"); });
    const variants: [prefix: string, scene: Scene, runs: number, tokens: string[]][] = [
      ["\x02", DEMO, 10, [...ACTIONS.map((action) => "\x02" + action), ...TEXT]],
      ["-", DEMO, 10, [...ACTIONS.map((action) => "-" + action), ...TEXT]],
      ["\x02", ZOOMED, 30, ["\x02w", "\x02l", "\x02h", "\x02z", "\x02x", "l", "h", "a", "Z", "\r"]],
      // moves there and back in navigate mode, the mode left and entered again, the help (which covers the panes) opened and closed
      ["\x02", UNREAD, 15, ["l", "h", "l", "h", "\x02?", "q", "\r", "\x02w", "a"]],
      // copy mode over a pane with history, with a printable prefix: left and entered again in one read, moved, scrolled,
      // searched, selected and yanked, its hints chosen, and text after it; the view it gives back is compared. Nothing
      // here writes a layout, so a frame follows every read
      ["-", HISTORY, 30, ["-[", "q", "g", "k", "j", "f", "1", "v", "y", "/", "e", "\r", "Z"]],
      // the pointer: a right-click on a pane opens its menu, clicks and a hover over where its entries lie, a click in the
      // sidebar, herdr's menu, Enter and text, so a click meets an overlay opened earlier in the same read
      ["\x02", DEMO, 30, [MOUSE.right, MOUSE.first, MOUSE.second, MOUSE.hover, MOUSE.sidebar, "\x02\r", "\r", "a", "\x02w"]],
    ];
    for (const [prefix, scene, runs, tokens] of variants) {
      for (let n = 0; n < runs; n++) {
        const picked = Array.from({ length: 3 + Math.floor(random() * 4) }, () => tokens[Math.floor(random() * tokens.length)]!);
        const text = picked.join("");
        const settleBetween = (scene === DEMO || scene === HISTORY) && !refusesInHold(picked, prefix);
        const bytes = new TextEncoder().encode(text);
        const glued = gluedIn(picked);
        const whole = await outcome(prefix, [bytes], scene, undefined, glued);
        if (settleBetween) expect({ text, busy: whole.busy }).toEqual({ text, busy: false });
        const joined = compared(whole, settleBetween);
        expect({ text, outcome: compared(await outcome(prefix, [...bytes].map((byte) => Uint8Array.of(byte)), scene, settleBetween, glued), settleBetween) }).toEqual({ text, outcome: joined });
        for (let cut = 1; cut < bytes.length; cut++) {
          expect({ text, cut, outcome: compared(await outcome(prefix, [bytes.slice(0, cut), bytes.slice(cut)], scene, settleBetween, glued), settleBetween) }).toEqual({ text, cut, outcome: joined });
        }
      }
    }
    // Keep the write pending across the cuts: splitting bytes must not turn a refused move, close, or zoom into a later command.
    for (const pinned of ["\x02wll\rZ", "\x02l\x02lZ", "\x02ll\x02lh", "\x02lab\x02hcd", "\x02l\x02xZ", "\x02l\x02zZ"]) {
      const gate = new TextEncoder().encode(pinned);
      const result = await outcome("\x02", [gate], ZOOMED);
      expect({ pinned, busy: result.busy }).toEqual({ pinned, busy: true });
      const whole = compared(result);
      expect({ pinned, outcome: compared(await outcome("\x02", [...gate].map((byte) => Uint8Array.of(byte)), ZOOMED)) }).toEqual({ pinned, outcome: whole });
      for (let cut = 1; cut < gate.length; cut++) expect({ pinned, cut, outcome: compared(await outcome("\x02", [gate.slice(0, cut), gate.slice(cut)], ZOOMED)) }).toEqual({ pinned, cut, outcome: whole });
    }
    // the gate's copy case: with a printable prefix, copy mode entered and moved to the oldest row, then left, entered
    // again, a hint chosen, and text after it in one read: the first session gives its view back before the second one
    // starts, as when read apart (the same hint copied, the view back where it was entered)
    // what copy mode must give back: the view before it was entered, and the hint the first label numbers at that view
    const rested = await outcome("-", [], HISTORY, true);
    const atBottom = await outcome("-", [new TextEncoder().encode("-[f1")], HISTORY, true);
    expect(atBottom.clips).toHaveLength(1);
    for (const pinned of ["-[gq-[f1", "-[gq-[f1Z", "-[gqZ"]) {
      const gate = new TextEncoder().encode(pinned);
      const seen = await outcome("-", [gate], HISTORY, true);
      expect({ pinned, tops: seen.tops, clips: seen.clips }).toEqual({ pinned, tops: rested.tops, clips: pinned.includes("f1") ? atBottom.clips : [] });
      const whole = compared(seen, true);
      expect({ pinned, outcome: compared(await outcome("-", [...gate].map((byte) => Uint8Array.of(byte)), HISTORY, true), true) }).toEqual({ pinned, outcome: whole });
      for (let cut = 1; cut < gate.length; cut++) expect({ pinned, cut, outcome: compared(await outcome("-", [gate.slice(0, cut), gate.slice(cut)], HISTORY, true), true) }).toEqual({ pinned, cut, outcome: whole });
    }
    // What a person was shown and what the document confirmed are named, not only compared: reads that all agree on a
    // turn nobody saw being read, or on the wrong pane to go back to, fail too. No frame comes between the reads.
    const told: [name: string, scene: Scene, typed: string, leaves: Record<string, unknown>][] = [
      ["a pane passed over in navigate mode was never shown focused: its turn stays unread", UNREAD, "lh", { shown: "t1", mode: "navigate", seen: { t1: "0", t2: null } }],
      ["the help closed and opened again uncovered nothing: the turn that ended under it stays unread",
        agents(async (run) => { await hostFocus(run, FOCUS_IN); await run.keys("ctrl+b,?"); await endTurn(run, "t1"); }),
        "\r\x02?", { overlays: ["help"], seen: { t1: "0", t2: null } }],
      ["a look neither ends nor begins again between two frames: a turn another client marked unread stays unread through a move away and back",
        agents(async (run) => { await hostFocus(run, FOCUS_IN); await endTurn(run, "t1"); await markUnread(run, "t1"); await run.keys("ctrl+b,w"); }),
        "lh", { shown: "t1", seen: { t1: "0", t2: null } }],
      ["the host's focus coming back between the help's close and its reopening finds the help still on the screen",
        agents(async (run) => { await hostFocus(run, FOCUS_IN); await run.keys("ctrl+b,?"); await hostFocus(run, FOCUS_OUT); await endTurn(run, "t1"); }),
        `\r${FOCUS_IN}\x02?`, { overlays: ["help"], seen: { t1: "0", t2: null } }],
      ["the host's focus coming back between a move and the move back finds the pane moved to not on the screen",
        agents(async (run) => { await hostFocus(run, FOCUS_OUT); await endTurn(run, "t2"); await run.keys("ctrl+b,w"); }),
        `l${FOCUS_IN}h`, { shown: "t1", seen: { t1: "0", t2: null } }],
      ["a jump onto a pane another tab's zoom covers, then the last pane: back to the pane it left, the zoom where the jump put it",
        { options: () => ({ core: zoomedElsewhere() }), given: async (run) => { run.loop.dispatch({ type: "keys", keys: { last_pane: "prefix+y" }, at: run.clock.current }); await run.advance(1); }, then: "\x02y" },
        // herdr's picker: / starts its search, Enter keeps it, Enter opens the match
        "\x02g/claude\r\r", { shown: "t1", focus: { previous: "t3" }, zoomed: [null, "t3"] }],
      ["copy mode entered on a pane and a copy made there, between two frames, show that pane to nobody and end no look: its turn stays unread, and so does the turn marked unread on the pane left and come back to",
        agents(async (run) => { await hostFocus(run, FOCUS_IN); await endTurn(run, "t1"); await markUnread(run, "t1"); await endTurn(run, "t2"); }),
        "\x02l\x02[gvly\x02h", { shown: "t1", mode: "terminal", clips: ["pa"], seen: { t1: "0", t2: null } }],
    ];
    for (const [name, scene, typed, leaves] of told) {
      const bytes = new TextEncoder().encode(typed);
      const whole = await outcome("\x02", [bytes], scene, false);
      expect({ name, outcome: whole }).toMatchObject({ name, outcome: leaves });
      expect({ name, outcome: await outcome("\x02", [...bytes].map((byte) => Uint8Array.of(byte)), scene, false) }).toEqual({ name, outcome: whole });
      for (let cut = 1; cut < bytes.length; cut++) expect({ name, cut, outcome: await outcome("\x02", [bytes.slice(0, cut), bytes.slice(cut)], scene, false) }).toEqual({ name, cut, outcome: whole });
    }
    // the gate's pointer case: a right-click on a pane and a click on its menu's first entry (Rename) in one read open the
    // rename field, as read apart; a hover onto the second entry and Enter choose it alike; and text after the choice
    for (const tokens of [[MOUSE.right, MOUSE.first], [MOUSE.right, MOUSE.hover, "\r"], [MOUSE.right, MOUSE.first, "a"]]) {
      const gate = new TextEncoder().encode(tokens.join(""));
      const glued = gluedIn(tokens);
      // a frame follows every read: the click read with the right-click meets the menu no frame showed yet
      const whole = compared(await outcome("\x02", [gate], DEMO, true, glued), true);
      expect({ tokens, outcome: compared(await outcome("\x02", [...gate].map((byte) => Uint8Array.of(byte)), DEMO, true, glued), true) }).toEqual({ tokens, outcome: whole });
      for (let cut = 1; cut < gate.length; cut++) expect({ tokens, cut, outcome: compared(await outcome("\x02", [gate.slice(0, cut), gate.slice(cut)], DEMO, true, glued), true) }).toEqual({ tokens, cut, outcome: whole });
    }
    const renamed = await outcome("\x02", [new TextEncoder().encode(MOUSE.right + MOUSE.first)], DEMO, true, gluedIn([MOUSE.right, MOUSE.first]));
    expect(renamed.overlays.map((overlay) => overlay.split(":")[0])).toEqual(["text"]);
  }, SOAK_MS);

  it("copy mode's search box takes text alike read whole, split at every byte, and a byte at a time, and text after its choice goes on", async () => {
    const search = async (reads: Uint8Array[]) => {
      const run = await Run.start({ fixture: demo });
      try {
        await run.live();
        await run.advance(1);
        for (const [at, read] of reads.entries()) {
          run.host.feed(read);
          if ((reads[at + 1]?.[0] ?? 0) >> 6 === 0b10) await run.advance(1);
          else await settled(run);
        }
        const model = run.loop.model();
        const mode = model.mode;
        return { mode: mode.name === "copy" ? `copy:${mode.phase}:${"field" in mode ? mode.field.graphemes.join("|") : ""}` : mode.name, received: ["t1", "t2"].map((terminal) => sentTo(run, terminal)) };
      } finally {
        await run.close();
      }
    };
    // copy mode, the search box, text with a mark, a ZWJ emoji and CJK; then the search chosen by Enter, and text after it
    for (const text of ["\x02[/e\u0301\u{1F469}\u200D\u{1F4BB}中", "\x02[/ab\rq"]) {
      const bytes = new TextEncoder().encode(text);
      const joined = await search([bytes]);
      expect({ text, outcome: await search([...bytes].map((byte) => Uint8Array.of(byte))) }).toEqual({ text, outcome: joined });
      for (let cut = 1; cut < bytes.length; cut++) expect({ text, cut, outcome: await search([bytes.slice(0, cut), bytes.slice(cut)]) }).toEqual({ text, cut, outcome: joined });
    }
  }, TEST_MS);

  it("a hint label read with hint mode copies its target as when read apart: f then 1, and after scrolling back", async () => {
    const urls = Array.from({ length: 30 }, (_, n) => `https://example.org/${n} 한글 e\u0301\r\n`).join("");
    const hint = async (reads: Uint8Array[]) => {
      const run = await Run.start({ cols: 60, rows: 14, fixture: { build: (core) => place(core, { space: "w", spaceName: "w", tab: "t", tabName: "t" }, urls) } });
      try {
        await run.live();
        await run.advance(1);
        for (const read of reads) {
          run.host.feed(read);
          await settled(run);
        }
        return { mode: run.loop.model().mode, clips: clipsOf(run), received: sentTo(run, "t1") };
      } finally {
        await run.close();
      }
    };
    // hint mode and its label; then the same after moving the copy cursor up past the top (the history scrolls back), and
    // text after the copy closed copy mode
    for (const text of ["\x02[f1", `\x02[${"k".repeat(16)}f2Z`]) {
      const bytes = new TextEncoder().encode(text);
      const joined = await hint([bytes]);
      expect(joined.clips).toHaveLength(1);
      expect(joined.mode).toEqual({ name: "terminal" });
      expect({ text, outcome: await hint([...bytes].map((byte) => Uint8Array.of(byte))) }).toEqual({ text, outcome: joined });
      for (let cut = 1; cut < bytes.length; cut++) expect({ text, cut, outcome: await hint([bytes.slice(0, cut), bytes.slice(cut)]) }).toEqual({ text, cut, outcome: joined });
    }
  }, TEST_MS);

  it("a text field keeps whole graphemes however the reads split them: 129 decomposed letters, a mark read apart, a ZWJ emoji", async () => {
    const field = async (reads: (string | Uint8Array)[]) => {
      const run = await Run.start({ fixture: demo });
      try {
        await run.live();
        await run.advance(1);
        // rename the focused pane: a one-line field that opens with the pane's name, as herdr's; what the reads add is compared
        run.type("\x02P");
        await settled(run);
        const fieldOf = () => {
          const top = run.loop.model().overlays.at(-1);
          return top && "field" in top ? top.field.graphemes : null;
        };
        const opened = fieldOf()?.length ?? 0;
        for (const read of reads) {
          run.host.feed(read);
          await settled(run);
        }
        return fieldOf()?.slice(opened) ?? null;
      } finally {
        await run.close();
      }
    };
    const accented = "e\u0301".repeat(129);
    expect((await field([accented]))?.length).toBe(129);
    expect((await field([...accented]))?.length).toBe(129);
    // the mark in a read of its own joins its letter, and one Backspace takes both
    expect(await field(["e", "\u0301"])).toEqual(["e\u0301"]);
    expect(await field(["e", "\u0301", "\x7f"])).toEqual([]);
    const emoji = new TextEncoder().encode("\u{1F469}\u200D\u{1F4BB}");
    expect(await field([...emoji].map((byte) => Uint8Array.of(byte)))).toEqual(["\u{1F469}\u200D\u{1F4BB}"]);
  }, TEST_MS);

  it("quit detaches within its bound when the core never answers", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.muted = true;
    let ended = false;
    void run.loop.done.then(() => { ended = true; });
    await run.keys("ctrl+b,q");
    await run.advance(QUIT_BOUND_MS - 100);
    expect(ended).toBe(false);
    await run.advance(200);
    expect(ended).toBe(true);
    expect(await run.loop.done).toEqual({ kind: "quit" });
    expect(run.sent.filter((frame) => frame.kind === FRAME_CLOSE).length).toBeGreaterThanOrEqual(3);
  }, TEST_MS);

  it("hang-up exits: CLOSE on every channel, the process ends within its bound, nothing is written after", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    // a frame pass is owed at the hang-up, and the core answers no CLOSE: the end comes by the bound, still drawing nothing
    run.core.program("t1").output("drawn\r\n");
    await run.settle();
    run.core.program("t1").output("owed\r\n");
    await run.settle();
    run.muted = true;
    run.host.hangUp();
    const attempts = run.host.writeAttempts();
    const writes = run.loop.report().writes;
    await run.advance(3_000);
    expect(await run.loop.done).toEqual({ kind: "gone", why: "hangup" });
    expect(run.host.exitCode).toBe(129);
    expect(run.host.writeAttempts()).toBe(attempts);
    expect(run.loop.report().writes).toBe(writes);
    expect(run.sent.filter((frame) => frame.kind === FRAME_CLOSE).length).toBe(3);
  }, TEST_MS);

  it("a terminal gone at the entry's first write: the screen goes no further, ends as gone, and the entry gives the terminal back", async () => {
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "loop-"));
    const socket = join(folder, "hc.sock");
    const listener = await oneTab(1).listen(socket);
    try {
      const host = new HeadlessHost();
      host.failWrites("EIO");
      const clock = new ManualClock();
      const loop = startLoop({ host, clock, socket, keys: undefined });
      const ended: { how: LoopEnd | null } = { how: null };
      void loop.done.then((how) => { ended.how = how; });
      /** turns of the event loop (the socket's own) until `done` holds, at most SETTLE_TURNS */
      const turns = async (done: () => boolean) => {
        for (let turn = 0; turn < SETTLE_TURNS && !done(); turn++) await new Promise<void>((resolve) => setImmediate(resolve));
      };
      await turns(() => host.writeAttempts() > 0);
      expect(host.log()).toEqual(["raw on"]);
      // the closing is bounded on the loop's clock
      clock.current = QUIT_BOUND_MS;
      clock.fireDue();
      await turns(() => ended.how !== null);
      const how = ended.how;
      expect(how).toEqual({ kind: "gone", why: "write-failed" });
      if (how?.kind !== "gone") return;
      const said = ending(how, { path: socket, session: "test" });
      expect([said.leave, said.exit]).toEqual([true, EXIT_FAILED]);
      host.leave();
      expect([host.log(), host.writeAttempts(), loop.report().passes, clock.armed()]).toEqual([["raw on", "raw off"], 1, 0, 0]);
    } finally {
      await listener.close();
      rmSync(folder, { recursive: true, force: true });
    }
  }, TEST_MS);

  it("another pane's first paint delays nothing typed: a key read while that pane drains reaches the focused live pane at once, and stays there", async () => {
    const core = oneTab(2);
    const run = await start({ core });
    await run.live();
    await run.advance(1);
    // a third pane joins the shown tab: once its first paint is drawn, the loop reads stdin before that pane goes live
    place(core, { space: "w", spaceName: "w", tab: "t", tabName: "t" }, "pane 2\r\n");
    for (let waited = 0; run.host.timers() === 0 && waited < 1_000; waited++) await run.advance(1);
    expect(run.host.timers()).toBe(1);
    run.type("k");
    await run.settle();
    expect(run.core.program("t1").receivedHex()).toBe("6b");
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(100);
    await run.live();
    expect(["t1", "t2", "t3"].map((terminal) => run.core.program(terminal).receivedHex())).toEqual(["6b", "", ""]);
  }, TEST_MS);

  it("flood does not delay input: a key typed into one pane leaves in its read's turn while another pane floods", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(1);
    run.core.program("t1").output(megabyte("flooding\r\n"));
    await run.advance(1);
    const passes = run.loop.report().passes;
    const sent = run.sent.length;
    run.type("k");
    const data = framesOf(run, FRAME_DATA, sent);
    expect(data.map((frame) => [frame.channel, Buffer.from(frame.payload).toString()])).toEqual([[channelOf(run, "t2"), "k"]]);
    expect(run.loop.report().passes).toBe(passes);
  }, TEST_MS);

  it("directional focus: the prefix and l move to the pane on that side of the drawn tree, and the next key goes there", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,l");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t2");
    await run.keys("ctrl+b,l");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t2");
    await run.keys("z");
    await run.advance(20);
    expect([run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()]).toEqual(["", Buffer.from("z").toString("hex")]);
    await run.keys("ctrl+b,h");
    expect(run.loop.model().focus.panes["t-main"]).toBe("t1");
  }, TEST_MS);

  it("zoom: a zoom of a pane without the focus moves the focus to it, and what is typed reaches only that pane", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    expect(run.loop.model().focus.panes["t"] ?? "t1").toBe("t1");
    const root = { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } };
    await run.loop.link.call("doc.set", { name: OVIS_LAYOUT_DOC, value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: "t2" }] }] }, version: 0 });
    await run.advance(1_000);
    expect([run.loop.panes.view("t1")?.covered, run.loop.panes.view("t2")?.covered]).toEqual([true, false]);
    await run.live();
    await run.advance(1);
    await run.keys("k");
    await run.advance(20);
    expect([run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()]).toEqual(["", Buffer.from("k").toString("hex")]);
    expect(run.loop.model().notices.map((notice) => notice.code)).not.toContain("input_refused");
  }, TEST_MS);

  it("zoom: text after a focus move under a zoom reaches the newly zoomed live pane, in one read as in two", async () => {
    /** what each program received after `reads`, with t2 zoomed and cycle_pane_next on prefix+y */
    const outcome = async (reads: string[]) => {
      const core = oneTab(2);
      const root = { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } };

      const run = await Run.start({ core });
      try {
        await run.live();
        await run.loop.link.call("doc.set", { name: OVIS_LAYOUT_DOC, value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: "t2" }] }] }, version: 0 });
        await settled(run);
        run.loop.dispatch({ type: "keys", keys: { cycle_pane_next: "prefix+y" }, at: run.clock.current });
        await run.advance(1);
        for (const read of reads) {
          run.type(read);
          await run.advance(20);
        }
        return { reads, received: [run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()] };
      } finally {
        await run.close();
      }
    };
    const received = [Buffer.from("k").toString("hex"), ""];
    expect(await outcome(["\x02yk"])).toEqual({ reads: ["\x02yk"], received });
    expect(await outcome(["\x02y", "k"])).toEqual({ reads: ["\x02y", "k"], received });
  }, TEST_MS);

  it("zoom: a program that asked for focus reports hears the focus leave when a zoom covers its pane and come back when it ends, and keeps its size", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    for (const terminal of ["t1", "t2"]) run.core.program(terminal).output("\x1b[?1004h");
    await run.advance(50);
    const heard = { t1: run.core.program("t1").receivedHex().length, t2: run.core.program("t2").receivedHex().length };
    const since = (terminal: "t1" | "t2") => run.core.program(terminal).receivedHex().slice(heard[terminal]);
    const channel = channelOf(run, "t1");
    const size = run.core.size("t1");
    const sent = run.sent.length;
    const root = { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } };
    const zoom = async (zoomed: string | null, version: number) => {
      await run.loop.link.call("doc.set", { name: OVIS_LAYOUT_DOC, value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed }] }] }, version });
      await run.advance(1_000);
      await run.live();
    };
    await zoom("t2", 0);
    expect([since("t1"), since("t2")]).toEqual(["1b5b4f", "1b5b49"]);
    // t2 attached again at the zoom's rectangle, and the fake's first paint does not replay its mode 1004: only t1 is followed
    await zoom(null, 1);
    expect(since("t1")).toBe("1b5b4f1b5b49");
    expect([channelOf(run, "t1"), run.core.size("t1"), framesOf(run, FRAME_RESIZE, sent).filter((frame) => frame.channel === channel)]).toEqual([channel, size, []]);
  }, TEST_MS);

  it("zoom and unzoom route held bytes against the confirmed document, whichever comes first: doc event or write reply", async () => {
    for (const unzoom of [false, true]) for (const eventFirst of [false, true]) {
      const run = await start({ core: oneTab(2) });
      await run.live();
      await run.advance(1);
      if (unzoom) {
        // Remember t1, but show t2. Both terminals already have live attachments.
        const root = { split: "right", ratio: 0.5, first: { leaf: "t1" }, second: { leaf: "t2" } };
        await run.loop.link.call("doc.set", { name: OVIS_LAYOUT_DOC, value: { schema: 1, workspaces: [{ id: "w", tabs: [{ id: "t", root, zoomed: "t2" }] }] }, version: 0 });
        await run.settle();
        expect(run.loop.panes.view("t1")?.covered).toBe(true);
      } else await run.keys("ctrl+b,l"); // zoom t2
      const answer = Promise.withResolvers<void>();
      const call = run.loop.link.call.bind(run.loop.link);
      run.loop.link.call = async (method, params, timeout) => {
        const result = await call(method, params, timeout);
        if (method === "doc.set") await answer.promise;
        return result;
      };
      run.core.holdingEvents = !eventFirst;
      run.type("\x02zabc");
      await run.settle();
      expect(run.loop.panes.view("t1")?.covered).toBe(eventFirst ? !unzoom : unzoom);
      expect(received(run)).toEqual({});
      answer.resolve();
      await run.settle();
      expect(run.loop.panes.view("t1")?.covered).toBe(!unzoom);
      expect(received(run)).toEqual({});
      await run.advance(FRAME_PASS_MS);
      expect(received(run)).toEqual({ [unzoom ? "t1" : "t2"]: "616263" });
      run.core.releaseEvents();
      await settled(run);
      expect(received(run)).toEqual({ [unzoom ? "t1" : "t2"]: "616263" });
      await run.close();
    }
  }, TEST_MS);

  it("a late zoom confirmation cannot replay expired bytes or release the next zoom's input", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    await run.advance(1);
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    const refresh = run.loop.link.refreshLayout.bind(run.loop.link);
    run.loop.link.refreshLayout = () => first.promise;
    run.type("\x02za");
    await settled(run);
    await run.advance(LAYOUT_SHOWN_WAIT_MS);
    expect(run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])).toContainEqual(["input_dropped", "not_shown"]);
    run.loop.link.refreshLayout = () => second.promise;
    run.type("\x02zb");
    await run.settle();
    first.resolve(true);
    await run.settle();
    expect(received(run)).toEqual({});
    second.resolve(await refresh());
    await settled(run);
    expect(received(run)).toEqual({ t1: "62" });
  }, TEST_MS);

  it("a size no emulator takes fails that pane alone: drawn as failed, no grid at the refused size, the other pane still typed into", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    const drawn = run.loop.report().grids.find((grid) => grid.pane === "t1");
    expect(drawn).toBeDefined();
    // another viewer sizes t1 past what an emulator takes (1000 columns)
    const rival = new HcConnection(() => run.core.transport());
    await rival.open("terminal.attach", { terminal: "t1", cols: 1200, rows: 50 }, { onData: () => {}, onClose: () => {} });
    await run.advance(1_000);
    expect(run.loop.panes.view("t1")?.state).toMatchObject({ kind: "Failed", code: "size" });
    expect(run.loop.report().grids.find((grid) => grid.pane === "t1")).toEqual(drawn);
    expect(run.grid().join("\n")).toContain("failed: size");
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(1);
    await run.keys("k");
    await run.advance(20);
    expect([run.core.program("t1").receivedHex(), run.core.program("t2").receivedHex()]).toEqual(["", Buffer.from("k").toString("hex")]);
    rival.close();
  }, TEST_MS);

  it("one read routes as the same bytes split across reads: an action and the text after it in one read", async () => {
    /** the focus, the mode and what every program received after `reads`, each read followed by a turn */
    const outcome = async (reads: string[]) => {
      const run = await Run.start({ fixture: demo });
      try {
        await run.live();
        // a read after the panes went live: what was read at the instant they did is refused as early, by design
        await run.advance(1);
        for (const read of reads) {
          run.type(read);
          await run.advance(20);
        }
        const model = run.loop.model();
        return { focus: model.focus, mode: model.mode.name, received: received(run) };
      } finally {
        await run.close();
      }
    };
    // a directional focus, two of them, the workspace picker and a key of its mode, resize mode, a zoom and a close,
    // each followed by text in the same read
    // the help's close key with a combining mark after it: read apart, q closes the help and the mark goes on to the pane,
    // so one read must give the overlay code points too (a text field joins a mark to its letter itself)
    // each with where its text lands: the pane moved to, the zoomed one, the one a close focuses, none in a mode
    const hex = (text: string) => Buffer.from(text).toString("hex");
    const lands: [string, Record<string, string>][] = [
      ["\x02lzy\r", { t2: hex("zy\r") }], ["\x02l\x02hab", { t1: hex("ab") }], ["\x02wlab", {}], ["\x02rhab", {}], ["\x02zab", { t1: hex("ab") }],
      ["\x02xab", { t2: hex("ab") }], ["\x02?\rab", { t1: hex("ab") }], ["\x02?\r\u0301ab", { t1: hex("\u0301ab") }],
    ];
    for (const [bytes, destination] of lands) {
      const joined = await outcome([bytes]);
      expect({ bytes, received: joined.received }).toEqual({ bytes, received: destination });
      expect({ bytes, outcome: await outcome([...bytes]) }).toEqual({ bytes, outcome: joined });
      for (let cut = 1; cut < bytes.length; cut++) {
        expect({ bytes, cut, outcome: await outcome([bytes.slice(0, cut), bytes.slice(cut)]) }).toEqual({ bytes, cut, outcome: joined });
      }
    }
    // the gate's case: the text after the move reaches the pane moved to, and nothing reaches the one left
    const moved = await outcome(["\x02lzy\r"]);
    expect([moved.focus.panes["t-main"], moved.received]).toEqual(["t2", { t2: hex("zy\r") }]);
  }, TEST_MS);

  it("bounded memory: tabs visited at one host size leave no grid behind, only the shown tab's panes have one", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    const visits: [tab: string, panes: string[]][] = [["t-logs", ["t3"]], ["t-notes", ["t4"]], ["t-main", ["t1", "t2"]], ["t-notes", ["t4"]]];
    for (const [tab, panes] of visits) {
      run.loop.dispatch({ type: "select", target: { kind: "tab", id: tab }, at: run.clock.current });
      await run.advance(100);
      await run.live();
      await run.advance(FRAME_PASS_MS);
      expect([tab, run.loop.report().grids.map((grid) => grid.pane).sort()]).toEqual([tab, panes]);
    }
    expect(run.loop.report().actions).not.toContain("painter_rebuilt");
  }, TEST_MS);

  it("scale: 200 terminals in 50 workspaces draw a frame, and only the shown tab's 16 panes are attached", async () => {
    const run = await start({ fixture: scale });
    await run.live(20_000);
    expect(run.loop.model().world.workspaces.length).toBe(SCALE_WORKSPACES);
    expect(run.loop.model().world.workspaces.flatMap((workspace) => workspace.tabs.flatMap((tab) => tab.panes)).length).toBe(SCALE_TERMINALS);
    const viewers = run.core.viewers();
    expect(viewers.length).toBe(SCALE_LARGEST_TAB);
    expect(new Set(viewers.map((viewer) => viewer.terminal)).size).toBe(SCALE_LARGEST_TAB);
    expect(run.loop.report().writes).toBeGreaterThan(0);
    expect(run.grid().join("\n")).toContain("│pane 0 ");
  }, TEST_MS);
});

/** A screen brought to a state it can rest in: the run, and what arrives each simulated second while it rests. */
interface Resting { run: Run; each?: () => void }

/** One terminal a viewer of its own already sized past what an emulator takes (1000 columns): the screen's pane fails with `size`. */
async function failedPane(): Promise<Resting> {
  const core = oneTab(1);
  const rival = new HcConnection(() => core.transport());
  await rival.open("terminal.attach", { terminal: "t1", cols: 1200, rows: 50 }, { onData: () => {}, onClose: () => {} });
  const run = await start({ core });
  await run.advance(1_000);
  expect(run.loop.panes.view("t1")?.state).toMatchObject({ kind: "Failed", code: "size" });
  // it never showed a picture: its grid is its rectangle, never the refused size
  expect(run.loop.report().grids.filter((grid) => grid.cols > 1_000)).toEqual([]);
  return { run };
}

/** Every state the screen can rest in, each brought about through the screen's own inputs or the core. */
const RESTING: [state: string, enter: () => Promise<Resting>][] = [
  ["a plain tab", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    return { run };
  }],
  ["a zoomed tab with bytes owed behind its zoom", async () => {
    const run = await start({ core: oneTab(2, true) });
    await run.live();
    run.core.program("t2").output(megabyte("covered!\r\n"));
    await run.advance(1_000);
    expect(run.loop.panes.view("t2")?.owed).toBeGreaterThan(0);
    return { run };
  }],
  ["a hidden tab's panes with output arriving", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    return { run, each: () => { for (const terminal of ["t3", "t4"]) run.core.program(terminal).output("hidden\r\n"); } };
  }],
  ["an overlay open", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "action", action: "help", at: run.clock.current });
    expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["help"]);
    return { run };
  }],
  ["the lock on", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "action", action: "lock", at: run.clock.current });
    expect(run.loop.model().locked).toBe(true);
    return { run };
  }],
  ["a pane waiting for its lost terminal's new shell", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.core.lose("t1");
    await run.advance(1_000);
    expect(run.loop.panes.view("t1")?.state).toEqual({ kind: "Waiting", why: "lost" });
    return { run };
  }],
  ["a pane failed", failedPane],
  ["a refused paste abandoned", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.type(`\x1b[200~${"a".repeat(PASTE_LIMIT_BYTES + 10)}`);
    await run.advance(PASTE_ABANDON_MS + 1);
    expect(run.loop.report().actions).toContain("paste_reset");
    return { run };
  }],
  ["after a notice expired", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.loop.dispatch({ type: "notice", code: "test_notice", at: run.clock.current });
    await run.advance(NOTICE_SHOW_MS + 1);
    expect(run.loop.model().notices).toEqual([]);
    return { run };
  }],
  ["an armed prefix", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b");
    expect(run.loop.model().armed).toBe(true);
    return { run };
  }],
  ["navigate mode", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,w");
    expect(run.loop.model().mode.name).toBe("navigate");
    return { run };
  }],
  ["navigate mode in a zoomed tab, the zoom moved after the focus", async () => {
    const run = await start({ core: oneTab(3, true) });
    await run.live();
    await run.keys("ctrl+b,w,l");
    await run.live();
    expect([run.loop.model().mode.name, run.loop.model().world.workspaces[0]?.tabs[0]?.zoomed]).toEqual(["navigate", "t2"]);
    return { run };
  }],
  ["navigate mode after refusing the second of two zoom moves", async () => {
    const run = await start({ core: oneTab(3, true) });
    await run.live();
    await run.keys("ctrl+b,w");
    run.type("ll");
    await run.settle();
    await run.live();
    expect([run.loop.model().mode.name, run.loop.model().focus.panes["t"], run.loop.model().world.workspaces[0]?.tabs[0]?.zoomed])
      .toEqual(["navigate", "t2", "t2"]);
    return { run };
  }],
  ["navigate mode after a zoom conflict notice expires", async () => {
    const run = await start({ core: oneTab(3, true) });
    await run.live();
    await run.keys("ctrl+b,w");
    run.core.conflictNext(2);
    await run.keys("l");
    expect(run.loop.model().notices.map(({ code }) => code)).toEqual(["layout_conflict"]);
    await run.advance(NOTICE_SHOW_MS + 1);
    expect([run.loop.model().mode.name, run.loop.model().focus.panes["t"], run.loop.model().notices])
      .toEqual(["navigate", "t1", []]);
    return { run };
  }],
  ["the picker open with a query typed", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,g,o");
    expect(run.loop.model().overlays.map((overlay) => overlay.kind)).toEqual(["goto"]);
    return { run };
  }],
  ["resize mode", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,r");
    expect(run.loop.model().mode.name).toBe("resize");
    return { run };
  }],
  ["copy mode", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,[");
    expect(run.loop.model().mode.name).toBe("copy");
    return { run };
  }],
  ...([
    ["copy character selection", "v,l"],
    ["copy line selection", "V"],
    ["copy search prompt", "/,echo"],
    ["copy search result", "/,echo,enter"],
    ["copy search without a match", "/,not-in-the-fixture,enter"],
    ["copy hints choosing a label", "f"],
  ] as const).map(([name, keys]): [string, () => Promise<Resting>] => [name, async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.core.program("t1").output("\r\nhttps://example.org/a\r");
    await run.advance(16);
    await run.keys(`ctrl+b,[,${keys}`);
    expect(run.loop.model().mode.name).toBe("copy");
    return { run };
  }]),
  ["the sidebar collapsed", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("ctrl+b,b");
    expect(run.loop.model().sidebarCollapsed).toBe(true);
    return { run };
  }],
  ["a selection dropped by its copy", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("press@29:2,drag@32:2,release@32:2");
    expect(run.host.output()).toContain(`\x1b]52;c;${Buffer.from("echo").toString("base64")}\x1b\\`);
    return { run };
  }],
  ["a pane scrolled back with the wheel", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    run.core.program("t1").output(Array.from({ length: 60 }, (_, n) => `row-${n}`).join("\r\n"));
    await run.advance(20);
    await run.keys("wheelup@40:20");
    // t1's grid has 37 rows: its screen shows the rows three above its newest
    const history = run.loop.panes.view("t1")?.emulator?.history();
    expect(history?.ok && history.value.total - 37 - history.value.viewportTop).toBe(3);
    return { run };
  }],
  ["a divider drag ended", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("press@72:10,drag@61:10,release@61:10");
    await run.advance(20);
    expect(run.loop.report().actions).toContain("divider:done");
    return { run };
  }],
  ["the close-workspace dialog open", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,D");
    expect(run.loop.report().mode.overlays).toEqual(["confirm"]);
    return { run };
  }],
  ["a rename field open", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,T,x");
    expect(run.loop.report().mode.overlays).toEqual(["text"]);
    return { run };
  }],
  ["after a split, the new pane focused", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,v");
    await run.live();
    const state = run.loop.model();
    expect([run.loop.panes.views().map((view) => view.terminal).sort(), state.focus.panes[state.focus.tabs[state.focus.workspace!]!]]).toEqual([["t1", "t2", "t5"], "t5"]);
    return { run };
  }],
  ["after a layout write that changed nothing", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,H");
    await run.advance(20);
    expect(run.loop.model().notices.map((notice) => [notice.code, notice.calm])).toEqual([["layout_unchanged", true]]);
    return { run };
  }],
  ["the narrow layout, the other pane of the tab focused", async () => {
    const run = await start({ fixture: demo, cols: 45, rows: 30 });
    await run.live();
    await run.advance(1);
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.live();
    expect(run.loop.panes.views().map((view) => view.terminal).sort()).toEqual(["t1", "t2"]);
    return { run };
  }],
  ["the switcher open on a narrow screen", async () => {
    const run = await start({ fixture: demo, cols: 45, rows: 30 });
    await run.live();
    await run.advance(1);
    await run.keys("ctrl+b,enter,down,down");
    expect(run.loop.report().mode.overlays).toEqual(["switcher"]);
    return { run };
  }],


  ["a pane looked at, its finished turn marked seen", async () => {
    const run = await start({ core: oneTab(2) });
    await run.live();
    await run.advance(1);
    run.type("\x1b[I");
    run.core.reportStatus("t1", { state: "working", app: "claude" });
    run.core.reportStatus("t1", { state: "idle", app: "claude" });
    await run.advance(20);
    // the look began at turn 0, which had no label yet, then turn 1 ended in front of the person: each write marks its own turn
    expect(run.core.calls().filter((call) => call.method === "terminal.label").map((call) => call.params["labels"])).toEqual([{ "herdr.seen": "0" }, { "herdr.seen": "1" }]);
    return { run };
  }],
  ["a view kept by an earlier run restored", async () => {
    const folder = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "loop-view-"));
    const core = new FakeHcCore();
    demo.build(core);
    const first = await start({ core, views: new ViewStore(folder) });
    await first.live();
    await first.advance(1);
    await first.keys("ctrl+b,n");
    await first.close();
    runs.splice(runs.indexOf(first), 1);
    const run = await start({ core, views: new ViewStore(folder) });
    await run.live();
    rmSync(folder, { recursive: true, force: true });
    expect(run.loop.panes.views().map((view) => view.terminal)).toEqual(["t3"]);
    return { run };
  }],
];

describe("nothing in, nothing out, in every state the screen rests in", () => {
  for (const [state, enter] of RESTING) {
    it(`nothing in, nothing out: ${state}`, async () => {
      const { run, each } = await enter();
      // past the last deadline any of these states names: the notice (5 s), the paste (3 s), a reattach, a paint's quiet
      await run.advance(NOTICE_SHOW_MS + 1_000);
      const passes = run.loop.report().passes;
      const written = run.host.bytes().length;
      for (let second = 0; second < 10; second++) {
        each?.();
        await run.advance(1_000);
      }
      expect([state, run.loop.report().passes - passes, run.host.bytes().length - written, run.loop.report().due, run.clock.maxArmed])
        .toEqual([state, 0, 0, ["link:silence"], 1]);
    }, TEST_MS);
  }

  it("nothing in, nothing out: with the core's line gone, only the link's retry wakes the screen, and nothing is written", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.cutLine();
    await run.advance(30_000);
    expect(run.loop.panes.views().map((view) => view.state)).toEqual([{ kind: "Waiting", why: "offline" }, { kind: "Waiting", why: "offline" }]);
    const passes = run.loop.report().passes;
    const written = run.host.bytes().length;
    await run.advance(10 * RECONNECT_MOST_MS);
    expect(run.host.bytes().length - written).toBe(0);
    expect(run.loop.report().due).toEqual(["link:reconnect"]);
    // a retry changes the link's state twice (Connecting, then Offline again): at most a pass each, writing nothing
    expect(run.loop.report().passes - passes).toBeLessThanOrEqual(2 * 10);
  }, TEST_MS);
});

describe("the sidebar's branch row", () => {
  it("a branch switched in a pane shows at the next key into it, or at a focus change, with no change in the core", async () => {
    const root = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "branch-row-"));
    try {
      const repo = join(root, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      const checkout = (branch: string) => writeFileSync(join(repo, ".git", "HEAD"), `ref: refs/heads/${branch}\n`);
      checkout("main");
      const core = new FakeHcCore();
      place(core, { space: "w-code", spaceName: "code", tab: "t-code", tabName: "code", pane: "CODE", cwd: repo }, "CODE-READY\r\n");
      place(core, { space: "w-docs", spaceName: "docs", tab: "t-docs", tabName: "docs", pane: "DOCS" }, "DOCS-READY\r\n");
      const run = await start({ core, cols: 120, rows: 40 });
      await run.live();
      const branchRow = () => run.grid()[3]!.slice(0, 25).trim();
      expect(branchRow()).toBe("main");
      // a first key: the screen marks the pane seen (a label, which the core echoes): that change is over before the checkout
      run.type("a");
      await run.advance(20);
      // a checkout typed in the pane: the core hears nothing of it; the next key into the pane reads git's files again
      checkout("other");
      const before = core.calls().length;
      run.type("x");
      await run.advance(20);
      expect(core.calls().slice(before).filter((call) => call.method.startsWith("terminal.")).map((call) => call.method)).toEqual([]);
      expect(branchRow()).toBe("other");
      // the same from a focus change: the other workspace comes to the front
      checkout("third");
      run.type("\x02w\x1b[B\r");
      await run.advance(20);
      expect(run.loop.model().focus.workspace).toBe("w-docs");
      expect(branchRow()).toBe("third");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, TEST_MS);
});

describe("the screen's own layout, as herdr's", () => {
  it("an empty core gets a first workspace in the folder the screen was started from, named after it, once a line, as herdr's server opens one", async () => {
    const run = await start({ core: new FakeHcCore(), cwd: "/work/project", home: "/home/user" });
    await run.advance(50);
    const made = run.core.calls().filter((call) => call.method === "terminal.run");
    expect(made.length).toBe(1);
    expect(made[0]!.params["cwd"]).toBe("/work/project");
    // no name of its own: the workspace is named after its folder, as any new workspace is
    expect((made[0]!.params["labels"] as Record<string, string>)[WORKSPACE_NAME_LABEL]).toBeUndefined();
    await run.advance(200);
    expect(run.loop.model().world.workspaces.map((workspace) => workspace.name)).toEqual(["project"]);
    expect(run.core.calls().filter((call) => call.method === "terminal.run").length).toBe(1);
  }, TEST_MS);

  it("started from the home, or from no folder, the first workspace is named ~, as herdr's server names the one it opens in its home", async () => {
    for (const where of [{ cwd: "/home/user", home: "/home/user" }, {}]) {
      const run = await start({ core: new FakeHcCore(), ...where });
      await run.advance(50);
      const made = run.core.calls().filter((call) => call.method === "terminal.run");
      expect({ where, made: made.map((call) => [call.params["cwd"], (call.params["labels"] as Record<string, string>)[WORKSPACE_NAME_LABEL]]) })
        .toEqual({ where, made: [["cwd" in where ? where.cwd : undefined, "~"]] });
      await run.advance(200);
      expect(run.loop.model().world.workspaces.map((workspace) => workspace.name)).toEqual(["~"]);
    }
  }, TEST_MS);

  it("a folder the core refuses gives the first workspace to the core's own folder, named ~, once, with a calm notice naming it", async () => {
    const core = new FakeHcCore();
    core.refuseFolder("/work/gone");
    const run = await start({ core, cwd: "/work/gone", home: "/home/user" });
    await run.advance(250);
    const made = core.calls().filter((call) => call.method === "terminal.run").map((call) => [call.params["cwd"], (call.params["labels"] as Record<string, string>)[WORKSPACE_NAME_LABEL]]);
    expect(made).toEqual([["/work/gone", undefined], [undefined, "~"]]);
    expect(run.loop.model().world.workspaces.map((workspace) => workspace.name)).toEqual(["~"]);
    expect(run.loop.model().notices.map(({ code, data, calm }) => [code, data, calm])).toEqual([["first_folder_unusable", { folder: "/work/gone" }, true]]);
    const claims = core.calls().filter((call) => call.method === "doc.set").map((call) => Object.keys((call.params["value"] ?? {}) as object).includes("first_workspace"));
    expect([claims.includes(true), claims.at(-1)]).toEqual([true, false]);
  }, TEST_MS);

  it("on a new line to a core emptied meanwhile, a folder removed since gives way to the core's own folder the same way", async () => {
    const core = new FakeHcCore();
    const run = await start({ core, cwd: "/work/p", home: "/home/user" });
    await run.advance(250);
    expect(run.loop.model().world.workspaces.map((workspace) => workspace.name)).toEqual(["p"]);
    core.remove("t1");
    core.refuseFolder("/work/p");
    core.restart();
    for (let turn = 0; turn < 20 && run.loop.model().world.workspaces.map((workspace) => workspace.name).join() !== "~"; turn++) await run.advance(250);
    const made = core.calls().filter((call) => call.method === "terminal.run").map((call) => [call.params["cwd"], (call.params["labels"] as Record<string, string>)[WORKSPACE_NAME_LABEL]]);
    expect(made).toEqual([["/work/p", undefined], ["/work/p", undefined], [undefined, "~"]]);
    expect(run.loop.model().world.workspaces.map((workspace) => workspace.name)).toEqual(["~"]);
    expect(run.loop.model().notices.map(({ code, data }) => [code, data])).toContainEqual(["first_folder_unusable", { folder: "/work/p" }]);
  }, TEST_MS);

  it("two screens from a folder the core refuses still open one first workspace between them", async () => {
    const core = new FakeHcCore();
    core.refuseFolder("/work/gone");
    const [a, b] = await Promise.all([start({ core, cwd: "/work/gone" }), start({ core, cwd: "/work/gone" })]);
    for (let turn = 0; turn < 10; turn++) {
      await a.advance(50);
      await b.advance(50);
    }
    const made = core.calls().filter((call) => call.method === "terminal.run").map((call) => call.params["cwd"]);
    expect(made).toEqual(["/work/gone", undefined]);
    for (const run of [a, b]) expect(run.loop.model().world.workspaces.map((workspace) => workspace.name)).toEqual(["~"]);
  }, TEST_MS);

  it("two screens that find the core empty at once open one first workspace between them: the layout document's claim decides which", async () => {
    const core = new FakeHcCore();
    const [a, b] = await Promise.all([start({ core, cwd: "/work/a" }), start({ core, cwd: "/work/b" })]);
    for (let turn = 0; turn < 10; turn++) {
      await a.advance(50);
      await b.advance(50);
    }
    const made = core.calls().filter((call) => call.method === "terminal.run");
    expect(made.length).toBe(1);
    // the one that won the claim opened it in its own folder; both show that one workspace
    const name = String(made[0]!.params["cwd"]).slice("/work/".length);
    expect(["a", "b"]).toContain(name);
    for (const run of [a, b]) expect(run.loop.model().world.workspaces.map((workspace) => workspace.name)).toEqual([name]);
    // the claim that decided it is gone again: the document holds what every reader knows
    const claims = core.calls().filter((call) => call.method === "doc.set").map((call) => Object.keys((call.params["value"] ?? {}) as object).includes("first_workspace"));
    expect([claims.includes(true), claims.at(-1)]).toEqual([true, false]);
  }, TEST_MS);

  const names = (run: Run) => run.loop.model().world.workspaces.map((workspace) => workspace.name);
  /** the folder of each shell started, null for one started in no folder (toEqual takes an undefined item at the end for none) */
  const started = (core: FakeHcCore) => core.calls().filter((call) => call.method === "terminal.run").map((call) => call.params["cwd"] ?? null);
  const claimIn = (core: FakeHcCore) => (core.docs.get(OVIS_LAYOUT_DOC)?.value as Record<string, unknown> | undefined)?.["first_workspace"];
  type LinkCall = Run["loop"]["link"]["call"];
  /**
   * A screen whose core was emptied after its first workspace and whose line was restarted: the new line opens a first
   * workspace again. `gate` is given each call of that line with the way to make it. Answers once `reached` says so.
   */
  async function emptiedAgain(cwd: string, gate: (method: string, params: Record<string, unknown>, forward: () => ReturnType<LinkCall>) => ReturnType<LinkCall>, reached: () => boolean): Promise<Run> {
    const run = await start({ core: new FakeHcCore(), cwd, home: "/home/user" });
    await run.advance(250);
    expect(names(run)).toEqual([cwd.slice(cwd.lastIndexOf("/") + 1)]);
    const call = run.loop.link.call.bind(run.loop.link);
    run.loop.link.call = ((method, params, timeout) => gate(method, { ...params }, () => call(method, params, timeout))) as LinkCall;
    run.core.remove("t1");
    run.core.restart();
    for (let turn = 0; turn < 40 && !reached(); turn++) await run.advance(250);
    expect(reached()).toBe(true);
    return run;
  }

  it("the first workspace's opening is a layout write: an overlay's key read meanwhile is refused once, and text read meanwhile is for the pane it makes", async () => {
    const answer = Promise.withResolvers<void>();
    let pending = false;
    const run = await emptiedAgain("/work/place", async (method, _params, forward) => {
      if (method === "terminal.run" && !pending) {
        pending = true;
        await answer.promise;
      }
      return forward();
    }, () => pending);
    try {
      expect(run.loop.model().world.workspaces).toEqual([]);
      run.type("abc\x02g");
      await run.settle();
      const told = () => run.loop.model().notices.map(({ code, data }) => [code, data["action"] ?? data["reason"]]);
      expect([run.loop.report().mode.overlays, told(), received(run)]).toEqual([[], [["layout_busy", "goto"]], {}]);
      // asked again, it says no more
      run.type("\x02g");
      await run.settle();
      expect([run.loop.report().mode.overlays, told()]).toEqual([[], [["layout_busy", "goto"]]]);
      answer.resolve();
      await settled(run);
      // what was typed went to the new pane and nowhere else: the pane, still painting its first picture at the frame that
      // ends the hold, refuses it, and that is said (main's rule for input read before a pane's picture)
      expect([run.loop.report().mode.overlays, names(run), focused(run.loop.model().world, run.loop.model().focus).pane?.id]).toEqual([[], ["place"], "t2"]);
      expect([told(), received(run)]).toEqual([[["layout_busy", "goto"], ["input_refused", "painting"]], {}]);
      await run.live();
      run.type("z\x02g");
      await settled(run);
      expect([run.loop.report().mode.overlays, received(run)]).toEqual([["goto"], { t2: "7a" }]);
    } finally {
      answer.resolve();
    }
  }, TEST_MS);

  it("text read while the first workspace is being opened goes to no pane another client opened meanwhile: it is dropped, and that is said", async () => {
    const release = Promise.withResolvers<void>();
    let waiting = false;
    // the opening's first read of the terminals, held: another client's terminal is there by the time it answers
    const run = await emptiedAgain("/work/place", async (method, params, forward) => {
      if (method === "terminal.list" && params["all"] !== true && !waiting) {
        waiting = true;
        await release.promise;
      }
      return forward();
    }, () => waiting);
    try {
      run.type("abc");
      const rival = place(run.core, { space: "rival", spaceName: "rival", tab: "rival-tab", tabName: "rival" }, "$ ");
      await run.live();
      await settled(run);
      expect([run.loop.model().focus.panes["rival-tab"], received(run)]).toEqual([rival, {}]);
      release.resolve();
      await settled(run);
      expect([started(run.core), received(run), run.loop.model().notices.map(({ code, data }) => [code, data["reason"]])]).toEqual([["/work/place"], {}, [["input_dropped", "not_shown"]]]);
      run.type("z");
      await settled(run);
      expect(received(run)).toEqual({ [rival]: "7a" });
    } finally {
      release.resolve();
    }
  }, TEST_MS);

  it("a screen that detaches while it holds the first workspace's claim lets it go: the next screen opens one at once", async () => {
    const release = Promise.withResolvers<void>();
    let claimed = false;
    let waiting = false;
    const run = await emptiedAgain("/work/place", async (method, params, forward) => {
      if (method === "doc.set" && Object.hasOwn((params["value"] ?? {}) as object, "first_workspace")) {
        const result = await forward();
        claimed = true;
        return result;
      }
      // the claim's own read of the terminals, which never answers while this screen is there
      if (claimed && method === "terminal.list" && params["all"] !== true) {
        waiting = true;
        await release.promise;
      }
      return forward();
    }, () => waiting);
    try {
      expect(claimIn(run.core)).toMatchObject({ opening: true });
      run.type("\x02q");
      expect(await run.loop.done).toMatchObject({ kind: "quit" });
      release.resolve();
      expect([claimIn(run.core), started(run.core)]).toEqual([undefined, ["/work/place"]]);
      const next = await start({ core: run.core, cwd: "/work/next", home: "/home/user" });
      await next.advance(250);
      expect([names(next), started(run.core), claimIn(run.core)]).toEqual([["next"], ["/work/place", "/work/next"], undefined]);
    } finally {
      release.resolve();
    }
  }, TEST_MS);

  it("a claim whose screen died holding it holds no longer than its time: a screen waiting on it opens the first workspace then, and one that finds it past its time at once", async () => {
    let wall = 1_700_000_000_000;
    const claimed = (claim: Record<string, unknown>): FakeHcCore => {
      const core = new FakeHcCore();
      core.docs.set(OVIS_LAYOUT_DOC, { value: { schema: OVIS_LAYOUT_SCHEMA, workspaces: [], first_workspace: claim }, version: 1 });
      return core;
    };
    const held = claimed({ opening: true, until: wall + FIRST_CLAIM_MS });
    const waiting = await start({ core: held, cwd: "/work/late", home: "/home/user", wall: () => wall });
    await waiting.advance(FIRST_CLAIM_MS - 1);
    expect([names(waiting), started(held)]).toEqual([[], []]);
    // its time passes and nothing took it out: the screen that waited takes it over and opens the workspace
    wall += FIRST_CLAIM_MS;
    await waiting.advance(250);
    expect([names(waiting), started(held), claimIn(held)]).toEqual([["late"], ["/work/late"], undefined]);
    // a core that got its workspace and empties later gets no other, however a look-again stood
    const watching = await start({ core: claimed({ opening: true, until: wall + FIRST_CLAIM_MS }), cwd: "/work/watch", home: "/home/user", wall: () => wall });
    const other = place(watching.core, { space: "o", spaceName: "other", tab: "ot", tabName: "ot" }, "$ ");
    await watching.advance(250);
    expect(names(watching)).toEqual(["other"]);
    watching.core.remove(other);
    wall += FIRST_CLAIM_MS;
    await watching.advance(FIRST_CLAIM_MS + 250);
    expect([names(watching), started(watching.core)]).toEqual([[], []]);
    // found already past its time, or written with no time at all (as a screen before this rule left it): taken at once
    for (const claim of [{ opening: true, until: wall - 1 }, { opening: true }]) {
      const stale = claimed(claim);
      const fresh = await start({ core: stale, cwd: "/work/fresh", home: "/home/user", wall: () => wall });
      await fresh.advance(250);
      expect([names(fresh), started(stale), claimIn(stale)]).toEqual([["fresh"], ["/work/fresh"], undefined]);
    }
  }, TEST_MS);

  it("a screen held up past its claim starts nothing once another screen took the claim over", async () => {
    const release = Promise.withResolvers<void>();
    let claimed = false;
    let waiting = false;
    const run = await emptiedAgain("/work/slow", async (method, params, forward) => {
      if (method === "doc.set" && Object.hasOwn((params["value"] ?? {}) as object, "first_workspace")) {
        const result = await forward();
        claimed = true;
        return result;
      }
      if (claimed && method === "terminal.list" && params["all"] !== true && !waiting) {
        waiting = true;
        await release.promise;
      }
      return forward();
    }, () => waiting);
    try {
      // another screen, finding the claim past its time, writes its own over it
      const doc = run.core.docs.get(OVIS_LAYOUT_DOC)!;
      const other = { opening: true, until: 2 * FIRST_CLAIM_MS };
      run.core.docs.set(OVIS_LAYOUT_DOC, { value: { ...(doc.value as object), first_workspace: other }, version: doc.version + 1 });
      release.resolve();
      await run.advance(250);
      expect([started(run.core), claimIn(run.core), names(run)]).toEqual([["/work/slow"], other, []]);
    } finally {
      release.resolve();
    }
  }, TEST_MS);

  it("a core with workspaces gets none", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    expect(run.core.calls().filter((call) => call.method === "terminal.run")).toEqual([]);
  }, TEST_MS);

  it("a program on the alternate screen gets its pane's scrollbar column, and gives it back when it leaves", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    expect(run.loop.panes.view("t1")?.wanted.cols).toBe(44);
    run.core.program("t1").output("\x1b[?1049h");
    // read inside the pane's resize wait, as before its attach again (on the fake core that attach's replay is not on the alternate screen)
    await run.advance(RESIZE_SETTLE_MS - 10);
    expect(run.loop.panes.view("t1")?.wanted.cols).toBe(45);
    run.core.program("t1").output("\x1b[?1049l");
    await run.advance(50);
    expect(run.loop.panes.view("t1")?.wanted.cols).toBe(44);
  }, TEST_MS);
});

describe("the whole screen", () => {
  it("shows the demo's panes with their Korean text, and typed keys reach the focused pane once and in order while another floods", async () => {
    const run = await start({ fixture: demo, cols: 120, rows: 40 });
    await run.live();
    const grid = run.grid();
    expect(grid.some((row) => row.includes("안녕하세요, 헤르더 세계"))).toBe(true);
    expect(grid.some((row) => row.includes("README.md  한글.txt"))).toBe(true);
    run.loop.dispatch({ type: "select", target: { kind: "pane", id: "t2" }, at: run.clock.current });
    await run.advance(1);
    const typed = "echo 한글 ok\r";
    for (const char of typed) {
      run.core.program("t1").output(`flood ${char}\r\n`.repeat(200));
      await run.keys(char);
    }
    await run.advance(50);
    expect(Buffer.from(run.core.program("t2").receivedHex(), "hex").toString("utf8")).toBe(typed);
    expect(run.core.program("t1").receivedHex()).toBe("");
  }, TEST_MS);

  it("after the core's line is cut: offline, nothing typed is sent, and it recovers by itself with nothing replayed", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    await run.keys("a");
    await run.advance(20);
    const before = run.core.program("t1").receivedHex();
    await run.cutLine();
    await run.advance(1_000);
    expect(run.loop.link.state.kind).toBe("Offline");
    // the offline state as data and drawn on the screen
    expect(run.loop.report().link).toEqual({ kind: "Offline", code: OFFLINE_CODE });
    expect(run.grid().join("\n")).toContain("herdr-core is not answering");
    expect(run.grid().join("\n")).toContain("hc server start");
    expect(run.loop.panes.views().map((view) => view.state.kind)).toEqual(["Waiting", "Waiting"]);
    await run.keys("l,o,s,t,enter");
    const lines = run.core.viewers().length;
    expect(lines).toBe(0);
    await run.listen();
    await run.advance(10_000);
    expect(run.loop.link.state).toMatchObject({ kind: "Online", epoch: 2 });
    await run.live();
    expect(run.core.program("t1").receivedHex()).toBe(before);
    const viewers = run.core.viewers();
    expect(viewers.map((viewer) => viewer.terminal).sort()).toEqual(["t1", "t2"]);
    expect(new Set(viewers.map((viewer) => viewer.line)).size).toBe(1);
    expect(run.clock.armed()).toBeLessThanOrEqual(1);
    expect(run.clock.maxArmed).toBe(1);
  }, TEST_MS);

  it("soak: 10 simulated minutes of output, input, resizes, tab switches and two reconnects", async () => {
    const run = await start({ fixture: demo });
    await run.live();
    /** the heap after GC with the test tooling's kept lists emptied: what the screen itself holds */
    const ownHeap = () => {
      run.forget();
      Bun.gc(true);
      return process.memoryUsage().heapUsed;
    };
    /** what the loop itself keeps, as it exposes it: these counts must not grow with time */
    const kept = () => ({ actions: run.loop.report().actions.length, notices: run.loop.model().notices.length, deadlines: run.loop.model().deadlines.size });
    let keptMiddle = kept();
    const memory = { start: process.memoryUsage().rss, middle: 0, end: 0, heapMiddle: 0, heapEnd: 0 };
    const sizes = [[120, 40], [100, 30], [80, 24], [140, 45]] as const;
    for (let second = 0; second < 600; second++) {
      for (const terminal of ["t1", "t2", "t3", "t4"]) run.core.program(terminal).output(`s${second} ${terminal} 안녕 ${"x".repeat(second % 50)}\r\n`);
      if (second % 7 === 0) await run.keys(`k${second % 10}`);
      if (second % 50 === 25) {
        const [cols, rows] = sizes[(second / 50 | 0) % sizes.length]!;
        run.host.resize(cols, rows);
      }
      if (second % 30 === 15) run.loop.dispatch({ type: "action", action: "next_tab", at: run.clock.current });
      if (second % 90 === 45) run.loop.dispatch({ type: "action", action: "next_workspace", at: run.clock.current });
      if (second === 200 || second === 400) {
        await run.cutLine();
        await run.advance(2_000);
        await run.listen();
      }
      await run.advance(1_000);
      if (second === 120) {
        keptMiddle = kept();
        memory.heapMiddle = ownHeap();
        memory.middle = process.memoryUsage().rss;
      }
    }
    const keptEnd = kept();
    memory.heapEnd = ownHeap();
    memory.end = process.memoryUsage().rss;
    // the same place a fresh screen opens: the first workspace's first tab, at the first size
    run.loop.dispatch({ type: "select", target: { kind: "tab", id: "t-main" }, at: run.clock.current });
    run.host.resize(120, 40);
    await run.advance(5_000);
    await run.live();
    await run.advance(60_000);
    process.stderr.write(`soak memory: ${JSON.stringify(memory)} passes=${run.loop.report().passes} maxArmed=${run.clock.maxArmed}\n`);
    expect(run.clock.maxArmed).toBe(1);
    expect(run.clock.armed()).toBe(1);
    expect(run.loop.report().due).toEqual(["link:silence"]);
    expect(run.loop.report().actions.some((code) => code.startsWith("end:") || code === "crash")).toBe(false);
    // what the loop keeps at second 600 is what it kept at second 120, and its panes are the shown tab's at most
    expect(keptEnd).toEqual(keptMiddle);
    expect(run.loop.panes.views().length).toBeLessThanOrEqual(2);
    // the screen's own heap over the last 480 simulated seconds of output, input, resizes and a reconnect
    expect(memory.heapEnd - memory.heapMiddle).toBeLessThan(OWN_HEAP_GROWTH_BYTES);
    const fresh = await start({ core: run.core, cols: 120, rows: 40 });
    await fresh.live();
    expect(run.grid()).toEqual(fresh.grid());
  }, SOAK_MS);
});
