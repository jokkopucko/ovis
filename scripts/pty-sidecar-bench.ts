/**
 * Node vs Rust PTY host through the same PtySession (OVIS_PTY_SIDECAR picks the host at each spawn), on Linux:
 * startup, teardown (kill until `exited`), keystroke echo, sustained output with the host's own CPU and peak
 * RSS, idle hosts' memory and CPU, and a real `herdr terminal attach` in the isolated test session.
 *
 *   cargo build --release --manifest-path crates/pty-sidecar/Cargo.toml
 *   bun scripts/pty-sidecar-bench.ts [--rounds 30] [--echo 1000] [--mib 64] [--idle 16] [--attach 5] [--out file.json]
 *
 * Rounds alternate the hosts (node, rust, node, …) after warm-up rounds that are not counted.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { herdrRpc, herdrSocketPath } from "../server/herdr/client.ts";
import { RUST_SIDECAR_BUILD, rustSidecar } from "../server/pty/host.ts";
import { PtySession, type PtySessionOptions } from "../server/pty/session.ts";
import { testSocketPath } from "./test-herdr.ts";

type Host = "node" | "rust";
const HOSTS: Host[] = ["node", "rust"];

function option(name: string, fallback: number): number {
  const at = process.argv.indexOf(`--${name}`);
  const value = at === -1 ? fallback : Number(process.argv[at + 1]);
  assert.ok(Number.isInteger(value) && value >= 0, `--${name} takes a whole number`);
  return value;
}
const ROUNDS = option("rounds", 30);
const ECHOES = option("echo", 1000);
const MIB = option("mib", 64);
const IDLE = option("idle", 16);
const ATTACHES = option("attach", 5);
const outAt = process.argv.indexOf("--out");
const OUT = outAt === -1 ? null : process.argv[outAt + 1] ?? null;

assert.equal(process.platform, "linux", "the host's CPU and memory are read from /proc");
const RUST_HOST = rustSidecar({ ...process.env, OVIS_PTY_SIDECAR: "rust" }) ?? "";
assert.ok(RUST_HOST, `build the Rust host first (${RUST_SIDECAR_BUILD}) or set OVIS_PTY_SIDECAR_BIN`);
const TICK_MS = 1000 / Number(Bun.spawnSync(["getconf", "CLK_TCK"]).stdout.toString().trim() || 100);

function use(host: Host): void {
  process.env["OVIS_PTY_SIDECAR"] = host;
}

function stat(pid: number): string[] | null {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    // fields after the command name, which may hold spaces: [0] is the state, [1] the parent
    return text.slice(text.lastIndexOf(")") + 2).split(" ");
  } catch { return null; }
}
const cpuMs = (pid: number): number => {
  const fields = stat(pid);
  return fields ? (Number(fields[11]) + Number(fields[12])) * TICK_MS : NaN;
};
function statusKiB(pid: number, key: "VmRSS" | "VmHWM"): number {
  try {
    const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((row) => row.startsWith(`${key}:`));
    return line ? Number(line.split(/\s+/)[1]) : NaN;
  } catch { return NaN; }
}
function childrenOf(parent: number): number[] {
  return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => stat(pid)?.[1] === String(parent));
}
function hostPid(host: Host, known: Set<number>): number {
  const marker = host === "rust" ? RUST_HOST : "pty-host.mjs";
  const pid = childrenOf(process.pid).find((candidate) => !known.has(candidate) && readFileSync(`/proc/${candidate}/cmdline`, "utf8").includes(marker));
  assert.ok(pid, `no ${host} host process found`);
  return pid;
}

interface Bench {
  session: PtySession;
  host: number;
  output: () => string;
  chunks: () => number;
  until: (label: string, check: (output: string) => boolean, limitMs?: number) => Promise<void>;
}

function start(host: Host, options: Omit<PtySessionOptions, "onData" | "onExit">, onData?: (data: string) => void): Bench {
  use(host);
  const known = new Set(childrenOf(process.pid));
  let output = "";
  let chunks = 0;
  const waiters = new Set<() => void>();
  const session = new PtySession({
    ...options,
    onData: (data) => {
      chunks++;
      if (onData) onData(data);
      else output += data;
      for (const waiter of [...waiters]) waiter();
    },
    onExit: () => {},
  });
  assert.equal(session.host, host, `${host}: PTY host fell back`);
  const until = (label: string, check: (output: string) => boolean, limitMs = 15_000) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(test); reject(new Error(`${host}: no ${label} in ${limitMs} ms`)); }, limitMs);
    const test = () => {
      if (!check(output)) return;
      clearTimeout(timer);
      waiters.delete(test);
      resolve();
    };
    waiters.add(test);
    test();
  });
  return { session, host: hostPid(host, known), output: () => output, chunks: () => chunks, until };
}

async function stop(bench: Bench): Promise<number> {
  const started = performance.now();
  bench.session.kill();
  await bench.session.exited;
  return performance.now() - started;
}

function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { n: sorted.length, p50: round(at(50)), p95: round(at(95)), mean: round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length), min: round(sorted[0]!), max: round(sorted.at(-1)!) };
}

async function alternate<T>(rounds: number, warmups: number, once: (host: Host) => Promise<T>): Promise<Record<Host, T[]>> {
  const results: Record<Host, T[]> = { node: [], rust: [] };
  for (let round = 0; round < warmups + rounds; round++) {
    const order = round % 2 === 0 ? HOSTS : [...HOSTS].reverse();
    for (const host of order) {
      const result = await once(host);
      if (round >= warmups) results[host].push(result);
    }
  }
  return results;
}

const SH = ["sh", "-c"];

async function startupAndTeardown() {
  const raw = await alternate(ROUNDS, 3, async (host) => {
    const began = performance.now();
    const bench = start(host, { command: SH[0]!, args: [SH[1]!, "printf R; exec cat"], cols: 80, rows: 24 });
    await bench.until("first byte", (output) => output.includes("R"));
    const startup = performance.now() - began;
    return { startup, teardown: await stop(bench) };
  });
  return Object.fromEntries(HOSTS.map((host) => [host, {
    startupMs: summary(raw[host].map((row) => row.startup)),
    teardownMs: summary(raw[host].map((row) => row.teardown)),
  }]));
}

async function echo() {
  const result: Record<string, unknown> = {};
  for (const host of HOSTS) {
    const bench = start(host, { command: SH[0]!, args: [SH[1]!, "stty raw -echo; printf R; exec cat"], cols: 80, rows: 24 });
    try {
      await bench.until("ready", (output) => output.includes("R"));
      const samples: number[] = [];
      for (let i = 0; i < 50 + ECHOES; i++) {
        const key = String.fromCharCode(97 + (i % 26));
        const length = bench.output().length;
        const sent = performance.now();
        bench.session.write(key);
        await bench.until("echo", (output) => output.length > length && output.endsWith(key), 5000);
        if (i >= 50) samples.push(performance.now() - sent);
      }
      result[host] = { echoMs: summary(samples) };
    } finally { await stop(bench); }
  }
  return result;
}

function block(): Buffer {
  const line = "\x1b[32m✓\x1b[0m 한글 출력 🙂 emoji \x1b[1;34mbold blue\x1b[0m path/to/some/file.ts:123:45 ".repeat(3) + "\r\n";
  let text = "";
  while (Buffer.byteLength(text) < 1024 * 1024) text += line;
  let bytes = Buffer.from(text);
  let cut = 1024 * 1024;
  while ((bytes[cut]! & 0xc0) === 0x80) cut--;
  bytes = Buffer.concat([bytes.subarray(0, cut), Buffer.alloc(1024 * 1024 - cut, 0x2e)]);
  return bytes;
}

async function throughput(file: string, expected: string) {
  const raw = await alternate(3, 1, async (host) => {
    const hash = createHash("sha256");
    let tail = "";
    let bytes = 0;
    let first = 0;
    let bun0 = process.cpuUsage();
    const bench = start(host, {
      command: SH[0]!,
      args: [SH[1]!, `stty -opost -echo; printf R; read go; i=0; while [ $i -lt ${MIB} ]; do cat '${file}'; i=$((i+1)); done; read done`],
      cols: 200, rows: 50,
    }, (data) => {
      if (!first) return void (tail = (tail + data).slice(-8));
      bytes += Buffer.byteLength(data);
      hash.update(data);
    });
    try {
      for (const deadline = Date.now() + 10_000; !tail.includes("R");) {
        if (Date.now() > deadline) throw new Error(`${host}: no R`);
        await Bun.sleep(5);
      }
      const hostCpu0 = cpuMs(bench.host);
      bun0 = process.cpuUsage();
      first = performance.now();
      bench.session.write("\n");
      for (const deadline = Date.now() + 120_000; bytes < MIB * 1024 * 1024;) {
        if (Date.now() > deadline) throw new Error(`${host}: ${bytes} of ${MIB} MiB`);
        await Bun.sleep(2);
      }
      const elapsed = performance.now() - first;
      const bun = process.cpuUsage(bun0);
      const result = {
        elapsedMs: elapsed,
        mibPerS: MIB / (elapsed / 1000),
        hostCpuMs: cpuMs(bench.host) - hostCpu0,
        hostPeakRssKiB: statusKiB(bench.host, "VmHWM"),
        bunCpuMs: (bun.user + bun.system) / 1000,
        chunks: bench.chunks(),
        checksum: hash.digest("hex") === expected,
      };
      assert.equal(bytes, MIB * 1024 * 1024, `${host}: byte count`);
      return result;
    } finally { await stop(bench); }
  });
  return Object.fromEntries(HOSTS.map((host) => {
    const rows = raw[host];
    const mean = (pick: (row: (typeof rows)[number]) => number) => Math.round(rows.reduce((sum, row) => sum + pick(row), 0) / rows.length * 10) / 10;
    return [host, {
      runs: rows.length, checksumsMatched: rows.every((row) => row.checksum),
      elapsedMs: mean((row) => row.elapsedMs), mibPerS: mean((row) => row.mibPerS),
      hostCpuMs: mean((row) => row.hostCpuMs), hostCpuMsPerMiB: mean((row) => row.hostCpuMs / MIB),
      hostPeakRssKiB: mean((row) => row.hostPeakRssKiB), bunCpuMs: mean((row) => row.bunCpuMs),
      meanChunkKiB: mean((row) => (MIB * 1024) / row.chunks),
    }];
  }));
}

async function idle() {
  const result: Record<string, unknown> = {};
  for (const host of HOSTS) {
    const benches: Bench[] = [];
    try {
      for (let i = 0; i < IDLE; i++) benches.push(start(host, { command: SH[0]!, args: [SH[1]!, "printf R; exec cat"], cols: 80, rows: 24 }));
      await Promise.all(benches.map((bench) => bench.until("ready", (output) => output.includes("R"))));
      const rss = benches.map((bench) => statusKiB(bench.host, "VmRSS"));
      const cpu0 = benches.map((bench) => cpuMs(bench.host));
      await Bun.sleep(5000); // fixed wait: idle CPU is measured over a set window
      const cpu = benches.map((bench, i) => cpuMs(bench.host) - cpu0[i]!);
      result[host] = {
        hosts: IDLE,
        rssKiBPerHost: summary(rss),
        rssMiBTotal: Math.round(rss.reduce((sum, value) => sum + value, 0) / 1024 * 10) / 10,
        idleCpuMsPer5s: Math.round(cpu.reduce((sum, value) => sum + value, 0) * 10) / 10,
      };
    } finally { await Promise.all(benches.map(stop)); }
  }
  return result;
}

async function attach() {
  const socket = herdrSocketPath();
  if (socket !== testSocketPath()) return { skipped: `HERDR_SOCKET is not the isolated test session (${socket})` };
  const created = await herdrRpc<{ workspace: { workspace_id: string }; root_pane: { pane_id: string; terminal_id?: string } }>(
    "workspace.create", { label: `ovis-test-pty-bench-${process.pid}`, cwd: "/tmp", focus: false },
  );
  try {
    let terminalId = created.root_pane.terminal_id;
    if (!terminalId) {
      const { snapshot } = await herdrRpc<{ snapshot: { panes: Array<{ pane_id: string; terminal_id: string }> } }>("session.snapshot", {});
      terminalId = snapshot.panes.find((pane) => pane.pane_id === created.root_pane.pane_id)!.terminal_id;
    }
    const raw = await alternate(ATTACHES, 1, async (host) => {
      const began = performance.now();
      const bench = start(host, { command: "herdr", args: ["terminal", "attach", terminalId!], cols: 100, rows: 30, env: { HERDR_SOCKET_PATH: socket } });
      try {
        await bench.until("first paint", (output) => output.length > 0);
        const paint = performance.now() - began;
        const probe = `PROBE_${host}_${crypto.randomUUID().slice(0, 8)}`;
        for (let attempt = 0; attempt < 20 && !stripVTControlCharacters(bench.output()).includes(`${probe}_한글🙂`); attempt++) {
          bench.session.write(`printf '%s_%s\\n' ${probe} '한글🙂'\r`);
          await bench.until("probe", (output) => stripVTControlCharacters(output).includes(`${probe}_한글🙂`), 1000).catch(() => {});
        }
        assert.ok(stripVTControlCharacters(bench.output()).includes(`${probe}_한글🙂`), `${host}: typed input never reached the shell`);
        bench.session.resize(93, 37);
        return { paint, teardown: await stop(bench), attached: true };
      } catch (error) {
        await stop(bench);
        throw error;
      }
    });
    return Object.fromEntries(HOSTS.map((host) => [host, {
      attachesWorked: raw[host].every((row) => row.attached),
      firstPaintMs: summary(raw[host].map((row) => row.paint)),
      teardownMs: summary(raw[host].map((row) => row.teardown)),
    }]));
  } finally {
    await herdrRpc("workspace.close", { workspace_id: created.workspace.workspace_id });
  }
}

const versions = {
  cpu: readFileSync("/proc/cpuinfo", "utf8").match(/model name\s*:\s*(.*)/)?.[1],
  kernel: Bun.spawnSync(["uname", "-r"]).stdout.toString().trim(),
  bun: Bun.version,
  node: Bun.spawnSync(["node", "--version"]).stdout.toString().trim(),
  rustHost: RUST_HOST,
  rustHostBytes: Bun.file(RUST_HOST).size,
};
console.log(JSON.stringify({ versions, rounds: ROUNDS, echoes: ECHOES, mib: MIB, idle: IDLE, attaches: ATTACHES }));

const dir = mkdtempSync(join(tmpdir(), "ovis-pty-bench-"));
const results: Record<string, unknown> = { versions };
try {
  const data = block();
  const file = join(dir, "block.txt");
  writeFileSync(file, data);
  const expected = createHash("sha256");
  for (let i = 0; i < MIB; i++) expected.update(data);
  const digest = expected.digest("hex");
  for (const [name, run] of [
    ["startupAndTeardown", startupAndTeardown],
    ["echo", echo],
    ["throughput", () => throughput(file, digest)],
    ["idle", idle],
    ["attach", attach],
  ] as const) {
    results[name] = await run();
    console.log(JSON.stringify({ [name]: results[name] }));
  }
} finally {
  delete process.env["OVIS_PTY_SIDECAR"];
  rmSync(dir, { recursive: true, force: true });
}
if (OUT) writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
