/**
 * The server runs in a child process (`createServer`, port 0, a mkdtemp state folder, no token)
 * against a stand-in herdr socket that answers `pane.get` alone, so nothing touches a real herdr.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROBE_EVERY_MS = 5;
const LAG_EVERY_MS = 5;

if (!Bun.isMainThread) probeWorker();
else if (process.argv[2] === "--serve") await serve();
else await bench();

/**
 * The prober, on its own thread: the bench's main thread takes in the file requests' bodies (half
 * a gigabyte for one case), which would otherwise delay the probes it sends and receives.
 */
function probeWorker(): void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let latencies: number[] = [];
  let waiting: Promise<void> | null = null;
  self.onmessage = async (event: MessageEvent<{ start?: string }>) => {
    if (event.data.start !== undefined) {
      const base = event.data.start;
      latencies = [];
      // one probe at a time: a stalled server answers the one waiting, not a growing queue of them
      timer = setInterval(() => {
        if (waiting !== null) return;
        waiting = probeOnce(base).then((ms) => { latencies.push(ms); }).finally(() => { waiting = null; });
      }, PROBE_EVERY_MS);
      postMessage({ started: true });
      return;
    }
    clearInterval(timer);
    await waiting;
    postMessage({ latencies });
  };
}

async function serve(): Promise<void> {
  const { createServer } = await import("../server/index.ts");
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-bench-state-"));
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, token: "", machines: false, sidecar: false });
  let maxLag = 0;
  let expected = performance.now() + LAG_EVERY_MS;
  setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - expected);
    expected = now + LAG_EVERY_MS;
  }, LAG_EVERY_MS);
  const lag = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { const answer = Response.json({ maxLag }); maxLag = 0; return answer; } });
  process.on("SIGTERM", () => { server.stop(true); void lag.stop(true); rmSync(stateDir, { recursive: true, force: true }); process.exit(0); });
  console.log(`PORTS ${server.port} ${lag.port}`);
}

interface Sample { heavyMs: number; probeP50: number; probeP99: number; probeMax: number; loopLagMax: number; probes: number }

async function bench(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1] ?? null; };
  const runs = Number(flag("--runs") ?? 7);
  const slowRoot = flag("--slow-root");
  const out = flag("--json");
  const only = flag("--cases");
  const root = mkdtempSync(join(tmpdir(), "ovis-bench-files-"));
  const fixtures = makeFixtures(root);
  const cwds = new Map<string, string>();
  const agents = new Map<string, string>();
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const slowProject = slowRoot === null ? null : join(slowRoot, "project");
  if (slowProject !== null && existsSync(join(slowProject, ".claude", "skills"))) {
    symlinkSync(join(slowProject, ".claude", "skills"), join(home, ".claude", "skills"));
    symlinkSync(join(slowProject, ".claude", "commands"), join(home, ".claude", "commands"));
  }
  let lookup = 0;
  /** a pane whose folder is `folder` under a name no lookup used before, so the 5 s listing cache never answers */
  const paneIn = (folder: string) => {
    const link = join(root, `cwd-${lookup}`);
    symlinkSync(folder, link);
    const pane = `w1:p${lookup++}`;
    cwds.set(pane, link);
    return pane;
  };
  const socket = join(root, "herdr.sock");
  const herdr = Bun.listen<undefined>({
    unix: socket,
    socket: {
      data(sock, chunk) {
        const { id, method, params } = JSON.parse(chunk.toString().split("\n")[0]!) as { id: string; method: string; params: { pane_id?: string } };
        const cwd = method === "pane.get" ? cwds.get(params.pane_id ?? "") : undefined;
        sock.end(`${JSON.stringify(cwd === undefined
          ? { id, error: { code: "unsupported", message: `bench herdr answers pane.get alone, not ${method}` } }
          : { id, result: { pane: { pane_id: params.pane_id, workspace_id: "w1", tab_id: "w1:t1", cwd, agent_status: "idle", ...(agents.has(params.pane_id ?? "") ? { agent: agents.get(params.pane_id ?? "") } : {}) } } })}\n`);
      },
    },
  });
  const child = Bun.spawn([process.execPath, import.meta.path, "--serve"], { stdout: "pipe", stderr: "ignore", env: { ...process.env, HERDR_SOCKET: socket, HOME: home } });
  const [port, lagPort] = await childPorts(child.stdout);
  const base = `http://127.0.0.1:${port}`;
  const q = encodeURIComponent;
  const cases: { name: string; concurrency: number; url: () => string }[] = [
    { name: "render page with 28 MB of local files", concurrency: 2, url: () => `/api/fs/file?path=${q(fixtures.page)}&render=1` },
    { name: "find a name in a 5,000-file folder", concurrency: 2, url: () => `/api/fs/stat?pane_id=${q(paneIn(fixtures.tree))}&path=missing.txt` },
    { name: "stream a 512 MB file", concurrency: 2, url: () => `/api/fs/file?path=${q(fixtures.big)}` },
    { name: "stat a file", concurrency: 4, url: () => `/api/fs/stat?path=${q(fixtures.small)}` },
  ];
  if (slowRoot !== null) {
    cases.push({ name: "stat a file on a slow mount", concurrency: 4, url: () => `/api/fs/stat?path=${q(join(slowRoot, "notes"))}` });
    cases.push({ name: "find a name in a slow mount", concurrency: 2, url: () => `/api/fs/stat?pane_id=${q(paneIn(join(slowRoot, "tree")))}&path=missing.txt` });
    cases.push({ name: "look for a project icon on a slow mount", concurrency: 2, url: () => `/api/fs/favicon?root=${q(join(slowRoot, "tree"))}` });
    cases.push({ name: "stream a 2 MB file on a slow mount", concurrency: 2, url: () => `/api/fs/file?path=${q(join(slowRoot, "clip.bin"))}` });
  }
  if (slowProject !== null && existsSync(join(slowProject, ".claude", "skills"))) {
    cases.push({ name: "list a Claude pane's commands, skills on a slow mount", concurrency: 1, url: () => {
      const pane = `w1:p${lookup++}`;
      cwds.set(pane, slowProject);
      agents.set(pane, "claude");
      return `/api/pane/commands?pane_id=${q(pane)}`;
    } });
  }
  if (only !== null) cases.splice(0, cases.length, ...cases.filter((item) => new RegExp(only).test(item.name)));
  const report: Record<string, Sample[]> = {};
  const prober = new Worker(import.meta.url);
  try {
    await probeOnce(base);
    for (const item of cases) {
      report[item.name] = [];
      for (let run = 0; run < runs; run++) report[item.name]!.push(await measure(prober, base, lagPort, item.url, item.concurrency));
    }
  } finally {
    prober.terminate();
    child.kill("SIGTERM");
    await child.exited;
    herdr.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
  const rows = Object.entries(report).map(([name, samples]) => ({ name, ...summarize(samples) }));
  console.log(`runs per case: ${runs}; median [min-max] in ms`);
  console.table(Object.fromEntries(rows.map(({ name, ...row }) => [name, Object.fromEntries(Object.entries(row).map(([key, [median, min, max]]) => [key, `${median} [${min}-${max}]`]))])));
  if (out !== null) writeFileSync(out, `${JSON.stringify({ runs, report }, null, 2)}\n`);
}

function makeFixtures(root: string) {
  const site = join(root, "site");
  mkdirSync(site);
  const images = Array.from({ length: 4 }, (_, index) => {
    const name = `shot-${index}.png`;
    writeFileSync(join(site, name), Buffer.alloc(7 * 1024 * 1024, index + 1));
    return name;
  });
  const page = join(site, "report.html");
  writeFileSync(page, `<!doctype html><title>report</title>${images.map((name) => `<img src="${name}">`).join("")}`);
  const big = join(root, "big.bin");
  writeFileSync(big, Buffer.alloc(512 * 1024 * 1024, 7));
  const small = join(root, "notes");
  writeFileSync(small, "hello\n");
  // 50 folders of 100 files: the walk's whole budget of 5,000 entries
  const tree = join(root, "tree");
  for (let folder = 0; folder < 50; folder++) {
    mkdirSync(join(tree, `dir-${folder}`), { recursive: true });
    for (let file = 0; file < 100; file++) writeFileSync(join(tree, `dir-${folder}`, `file-${file}.txt`), "");
  }
  return { page, big, small, tree };
}

async function childPorts(stdout: ReadableStream<Uint8Array>): Promise<[number, number]> {
  let text = "";
  for await (const chunk of stdout) {
    text += new TextDecoder().decode(chunk);
    const match = /PORTS (\d+) (\d+)/.exec(text);
    if (match) return [Number(match[1]), Number(match[2])];
  }
  throw new Error(`the bench server exited before it listened: ${text}`);
}

async function probeOnce(base: string): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${base}/api/health?scope=bridge`);
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`health answered ${response.status}`);
  return performance.now() - started;
}

function answer<T>(worker: Worker): Promise<T> {
  return new Promise((done) => worker.addEventListener("message", (event) => done(event.data as T), { once: true }));
}

async function measure(prober: Worker, base: string, lagPort: number, url: () => string, concurrency: number): Promise<Sample> {
  await fetch(`http://127.0.0.1:${lagPort}/`).then((response) => response.arrayBuffer());
  const started = answer(prober);
  prober.postMessage({ start: base });
  await started;
  const begun = performance.now();
  const heavy = await Promise.all(Array.from({ length: concurrency }, async () => {
    const response = await fetch(`${base}${url()}`);
    for await (const _chunk of response.body!) {}
    if (!response.ok && response.status !== 404) throw new Error(`file request answered ${response.status}`);
    return performance.now() - begun;
  }));
  const stopped = answer<{ latencies: number[] }>(prober);
  prober.postMessage({});
  const { latencies } = await stopped;
  const { maxLag } = await fetch(`http://127.0.0.1:${lagPort}/`).then((response) => response.json() as Promise<{ maxLag: number }>);
  const sorted = latencies.toSorted((left, right) => left - right);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
  return { heavyMs: Math.max(...heavy), probeP50: at(0.5), probeP99: at(0.99), probeMax: sorted.at(-1) ?? 0, loopLagMax: maxLag, probes: sorted.length };
}

function summarize(samples: Sample[]): Record<keyof Sample, [number, number, number]> {
  const keys = Object.keys(samples[0]!) as (keyof Sample)[];
  return Object.fromEntries(keys.map((key) => {
    const values = samples.map((sample) => sample[key]).toSorted((left, right) => left - right);
    const round = (value: number) => Math.round(value * 10) / 10;
    return [key, [round(values[Math.floor(values.length / 2)]!), round(values[0]!), round(values.at(-1)!)]];
  })) as Record<keyof Sample, [number, number, number]>;
}
