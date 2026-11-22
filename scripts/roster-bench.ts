/**
 * Needs a built client (`dist/`) and the isolated herdr of a check run:
 *
 *   bun run check run --build bun scripts/roster-bench.ts --panes 20,100,300 --runs 5 --out <file.json>
 *
 * Never point it at the herdr you work in: it opens and closes hundreds of panes.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join } from "node:path";

type Phase = "working" | "idle";
interface ServerStats { cpu_ms: number; rss: number; heap: number }

const SERVE = "--serve";

if (process.argv[2] === SERVE) await serve(process.argv[3] ?? "");
else await bench();

/** The server under test, in a process of its own so its CPU time is its own. */
async function serve(stateDir: string): Promise<void> {
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, usage: new UsageService(undefined, []) });
  const stats = (): ServerStats => {
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    return { cpu_ms: (cpu.user + cpu.system) / 1000, rss: memory.rss, heap: memory.heapUsed };
  };
  process.on("message", (message: { id: number; ask: "stats" | "gc" | "stop" }) => {
    if (message.ask === "gc") Bun.gc(true);
    if (message.ask === "stop") {
      server.stop();
      process.send?.({ id: message.id, stats: stats() });
      process.exit(0);
    }
    process.send?.({ id: message.id, stats: stats() });
  });
  process.send?.({ port: server.port });
}

async function bench(): Promise<void> {
  // the isolated herdr of a check run (or the `ovis-test` session): never the user's own
  const { testSocketPath } = await import("./test-herdr.ts");
  // test-herdr.ts leaves the inherited socket in place in live mode or with no herdr binary: refuse both
  if (process.env["HERDR_TEST_LIVE"] === "1" || process.env["HERDR_SOCKET"] !== testSocketPath()) {
    throw new Error("roster-bench: runs only on the isolated test herdr (`bun run check run ...`), never on a live session");
  }
  const { herdrRpc, workspaceCreate, workspaceClose } = await import("../server/herdr/client.ts");
  const { chromium } = await import("playwright-core");
  const { chromePath } = await import("./chrome-path.ts");

  const option = (name: string, fallback: string): string => {
    const at = process.argv.indexOf(name);
    return at >= 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
  };
  const sizes = option("--panes", "20,100,300").split(",").map(Number);
  const runs = Number(option("--runs", "5"));
  const warmups = Number(option("--warmups", "1"));
  const out = option("--out", "");
  const label = option("--label", "");
  const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "ovis-roster-bench-"));

  const pool = async <T>(items: readonly T[], width: number, work: (item: T) => Promise<unknown>): Promise<void> => {
    let next = 0, failed = false;
    // a failure stops new work and waits for the rest, so nothing is opened after the run has unwound
    const workers = await Promise.allSettled(Array.from({ length: Math.min(width, items.length) }, async () => {
      while (!failed && next < items.length) {
        try { await work(items[next++]!); } catch (error) { failed = true; throw error; }
      }
    }));
    const rejected = workers.find((worker) => worker.status === "rejected");
    if (rejected) throw rejected.reason;
  };
  const report = (paneId: string, state: Phase) => herdrRpc("pane.report_agent", { pane_id: paneId, source: "roster-bench", agent: "claude", state });
  const undo: (() => unknown)[] = [];
  const unwind = async (): Promise<void> => {
    for (let step = undo.pop(); step !== undefined; step = undo.pop()) await Promise.resolve().then(step).catch(() => undefined);
  };

  async function openPanes(count: number): Promise<{ workspaces: string[]; panes: string[] }> {
    const workspaces: string[] = [], panes: string[] = [];
    const groups = Array.from({ length: Math.ceil(count / 4) }, (_, index) => Math.min(4, count - index * 4));
    await pool(groups.map((size, index) => ({ size, index })), 8, async ({ size, index }) => {
      const created = await workspaceCreate({ cwd: root, label: `bench ${String(index + 1).padStart(3, "0")}` });
      workspaces.push(created.workspace.workspace_id);
      undo.push(() => workspaceClose(created.workspace.workspace_id));
      panes.push(created.root_pane.pane_id);
      let target = created.root_pane.pane_id;
      for (let split = 1; split < size; split++) {
        const made = await herdrRpc<{ pane: { pane_id: string } }>("pane.split", { target_pane_id: target, direction: split % 2 ? "right" : "down", cwd: root, focus: false });
        panes.push(made.pane.pane_id);
        target = made.pane.pane_id;
      }
    });
    return { workspaces, panes };
  }

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  };
  const round = (value: number): number => Math.round(value * 10) / 10;

  const results: Record<string, unknown>[] = [];
  const summary: Record<string, unknown>[] = [];
  const memory: Record<string, unknown>[] = [];
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const load = { before: loadavg(), cores: cpus().length };
  try {
    for (const size of sizes) {
      console.log(`roster-bench: ${size} panes`);
      const { panes } = await openPanes(size);
      const ours = new Set(panes);
      await pool(panes, 16, (paneId) => report(paneId, "idle"));

      const stateDir = join(root, `state-${size}`), home = join(root, `home-${size}`);
      mkdirSync(home, { recursive: true });
      const asked = new Map<number, (stats: ServerStats) => void>();
      let asks = 0;
      const port = Promise.withResolvers<number>();
      const child = Bun.spawn([process.execPath, import.meta.path, SERVE, stateDir], {
        env: { ...process.env, HOME: home }, stdout: "inherit", stderr: "inherit",
        ipc(message: { port?: number; id?: number; stats?: ServerStats }) {
          if (message.port !== undefined) port.resolve(message.port);
          if (message.id !== undefined && message.stats) asked.get(message.id)?.(message.stats);
        },
      });
      undo.push(async () => { child.kill(); await child.exited; });
      // a server that died or stopped answering answers nothing: every wait on it ends instead of hanging the run
      const unlessExited = <T>(wait: Promise<T>, what: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`roster-bench: the server did not answer ${what} within 60 s`)), 60_000); });
        return Promise.race([wait, deadline, child.exited.then((code) => { throw new Error(`roster-bench: the server exited (${code})`); })])
          .finally(() => clearTimeout(timer));
      };
      const ask = (what: "stats" | "gc" | "stop"): Promise<ServerStats> => {
        const id = ++asks;
        const answer = Promise.withResolvers<ServerStats>();
        asked.set(id, answer.resolve);
        child.send({ id, ask: what });
        return unlessExited(answer.promise, what);
      };
      const origin = `http://127.0.0.1:${await unlessExited(port.promise, "with its port")}`;

      // the working rows' spinners would otherwise fill every window with style work of their own
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      undo.push(() => context.close());
      await context.addInitScript(() => {
        const bench = { last: performance.now(), inflight: 0, frames: {} as Record<string, number>, longtasks: 0, longtaskMs: 0, opens: 0, drops: 0, deliveries: 0, pending: false, open: false };
        (window as unknown as { __bench: typeof bench }).__bench = bench;
        const Real = window.EventSource;
        window.EventSource = class extends Real {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            this.addEventListener("open", () => { bench.opens++; bench.open = true; bench.last = performance.now(); });
            this.addEventListener("error", () => { bench.drops++; bench.open = false; bench.last = performance.now(); });
            this.addEventListener("message", (event: MessageEvent<string>) => {
              bench.last = performance.now();
              // messages read from one network chunk are dispatched in one task: count the tasks they took
              if (!bench.pending) { bench.pending = true; bench.deliveries++; setTimeout(() => { bench.pending = false; }, 0); }
              const head = event.data.slice(0, 160);
              const kind = /"message":\{"type":"([^"]+)"/.exec(head)?.[1] ?? /"type":"([^"]+)"/.exec(head)?.[1] ?? "other";
              bench.frames[kind] = (bench.frames[kind] ?? 0) + 1;
            });
          }
        } as typeof EventSource;
        const realFetch = window.fetch.bind(window);
        window.fetch = async (...args: Parameters<typeof fetch>) => {
          bench.inflight++;
          try { return await realFetch(...args); } finally { bench.inflight--; bench.last = performance.now(); }
        };
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) { bench.longtasks++; bench.longtaskMs += entry.duration; }
        }).observe({ type: "longtask", buffered: true });
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send("Performance.enable");
      await page.goto(origin);

      const rows = (status: string | null) => page.evaluate(([ids, wanted]) => {
        let count = 0;
        for (const row of document.querySelectorAll<HTMLElement>(".agents-sidebar .agent-item[data-machine=\"local\"]")) {
          if (!(ids as string[]).includes(row.dataset["pane"] ?? "")) continue;
          if (wanted === null || row.querySelector(`.badge[data-status="${wanted}"]`)) count++;
        }
        return count;
      }, [[...ours], status] as const);
      const until = async (check: () => Promise<boolean>, what: string, limitMs = 60_000): Promise<number> => {
        const started = performance.now();
        for (const deadline = Date.now() + limitMs; !(await check());) {
          if (Date.now() > deadline) throw new Error(`roster-bench: timed out waiting for ${what}`);
          await Bun.sleep(25);
        }
        return performance.now() - started;
      };
      await until(async () => (await rows(null)) === size, `${size} agent rows`);
      const quiet = () => until(() => page.evaluate(() => {
        const bench = (window as unknown as { __bench: { last: number; inflight: number; open: boolean } }).__bench;
        // a dropped stream reconnects about 3 s later: its recovery belongs to this burst, not the next
        return bench.open && bench.inflight === 0 && performance.now() - bench.last > 750;
      }), "a quiet event stream");
      await quiet();

      const metrics = async (): Promise<Record<string, number>> => {
        const { metrics: list } = await cdp.send("Performance.getMetrics");
        const page_ = await page.evaluate(() => {
          const bench = (window as unknown as { __bench: { frames: Record<string, number>; longtasks: number; longtaskMs: number; opens: number; drops: number; deliveries: number } }).__bench;
          return { ...bench.frames, longtasks: bench.longtasks, longtaskMs: bench.longtaskMs, stream_opens: bench.opens, stream_drops: bench.drops, stream_deliveries: bench.deliveries };
        });
        return { ...Object.fromEntries(list.map((metric) => [metric.name, metric.value])), ...Object.fromEntries(Object.entries(page_).map(([key, value]) => [`page:${key}`, value])) };
      };
      const burst = async (run: number, phase: Phase): Promise<void> => {
        const [before, serverBefore] = await Promise.all([metrics(), ask("stats")]);
        const started = performance.now();
        await pool(panes, 32, (paneId) => report(paneId, phase));
        // "idle" after work is a finish: herdr and the rows say done until it is looked at
        const shown = phase === "working" ? ["working"] : ["done", "idle"];
        await until(async () => {
          let count = 0;
          for (const status of shown) count += await rows(status);
          return count === size;
        }, `${size} rows ${phase}`);
        const visible = performance.now() - started;
        await quiet();
        const [after, serverAfter] = await Promise.all([metrics(), ask("stats")]);
        const delta = (name: string) => (after[name] ?? 0) - (before[name] ?? 0);
        const frames = Object.fromEntries(Object.keys(after).filter((key) => key.startsWith("page:") && !key.includes("longtask") && !key.includes("stream_")).map((key) => [key.slice(5), delta(key)]).filter(([, value]) => value !== 0));
        const row = {
          size, run, phase, warmup: run < 0,
          visible_ms: round(visible),
          main_task_ms: round(delta("TaskDuration") * 1000),
          script_ms: round(delta("ScriptDuration") * 1000),
          layout_ms: round(delta("LayoutDuration") * 1000),
          style_ms: round(delta("RecalcStyleDuration") * 1000),
          longtasks: delta("page:longtasks"),
          longtask_ms: round(delta("page:longtaskMs")),
          stream_drops: delta("page:stream_drops"),
          stream_reopens: delta("page:stream_opens"),
          stream_deliveries: delta("page:stream_deliveries"),
          server_cpu_ms: round(serverAfter.cpu_ms - serverBefore.cpu_ms),
          frames,
        };
        results.push(row);
        console.log(JSON.stringify(row));
      };
      for (let run = -warmups; run < runs; run++) {
        await burst(run, "working");
        await burst(run, "idle");
      }
      const heap = await cdp.send("Performance.getMetrics");
      const settled = await ask("gc");
      const rosterBytes = (await (await fetch(`${origin}/api/machines`)).text()).length;
      memory.push({ size, roster_bytes: rosterBytes, server_rss_mb: round(settled.rss / 2 ** 20), server_heap_mb: round(settled.heap / 2 ** 20), browser_heap_mb: round((heap.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0) / 2 ** 20), browser_nodes: heap.metrics.find((metric) => metric.name === "Nodes")?.value ?? 0 });
      for (const phase of ["working", "idle"] as const) {
        const measured = results.filter((row) => row["size"] === size && row["phase"] === phase && row["warmup"] === false);
        const stat = (name: string) => {
          const values = measured.map((row) => row[name] as number);
          return { median: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) };
        };
        const line = { size, phase, runs: measured.length, stream_drops: stat("stream_drops"), main_task_ms: stat("main_task_ms"), script_ms: stat("script_ms"), visible_ms: stat("visible_ms"), longtask_ms: stat("longtask_ms"), server_cpu_ms: stat("server_cpu_ms") };
        summary.push(line);
        console.log(`summary ${JSON.stringify(line)}`);
      }

      await ask("stop").catch(() => undefined);
      await unwind();
    }
  } finally {
    await unwind();
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  }
  const document = { label, at: new Date().toISOString(), load: { ...load, after: loadavg() }, summary, memory, results };
  if (out) writeFileSync(out, JSON.stringify(document, null, 2));
  console.log(`memory ${JSON.stringify(memory)}`);
  console.log(`load ${JSON.stringify(document.load)}`);
}
