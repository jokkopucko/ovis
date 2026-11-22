/**
 * How long a phone takes to open a PC through the relay: the phone's own code (src/lib/relay/channel.ts) in
 * Bun, against a PC (`createServer` + RelayService) in a child process with its own mkdtemp state dir and HOME,
 * port 0, and HERDR_SOCKET at a path that does not exist (no herdr is touched). The relay is the real one
 * (wss://relay.ovis.sh) unless --relay names another.
 *
 *   bun scripts/relay-open-bench.ts --arms A,B,B,A --rounds 8 [--a-dir <tree with the A files>] [--files a,b] [--relay wss://...]
 *
 * Arm A copies each of --files from --a-dir over this tree before its PC starts, arm B restores this tree's own.
 *
 * --emulate <rtt ms>: instead of the real relay, this tree's Bun relay (relay/bun.ts) behind a TCP proxy that
 * holds every chunk rtt/2 each way, for the phone's and the PC's sockets alike (plain ws, so no TLS round trips).
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";

const SERVE = "--serve";
if (process.argv[2] === SERVE) await serve(process.argv[3]!);
else await bench();

async function serve(stateDir: string): Promise<void> {
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const { RelayService } = await import("../server/relay/service.ts");
  const local = process.env["BENCH_RELAY_WS"];
  const relay = new RelayService({
    stateDir, ...(process.env["BENCH_RELAY"] ? { relay: process.env["BENCH_RELAY"] } : {}),
    ...(local ? { relay: "wss://relay.bench", connect: (url: string) => { const target = new URL(url); return new WebSocket(`${local}${target.pathname}${target.search}`); } } : {}),
  });
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir, tailscaleOwner: null, usage: new UsageService(undefined, []), relay });
  console.log(`BENCH-PORT ${server.port}`);
  process.on("SIGTERM", () => { server.stop(); process.exit(0); });
}

async function bench(): Promise<void> {
  const { openRelayChannel } = await import("../src/lib/relay/channel.ts");
  const { decodeOffer } = await import("../shared/relay-offer.ts");
  type Store = import("../src/lib/relay/device.ts").RelayDeviceStore;
  type Device = import("../src/lib/relay/device.ts").RelayDevice;

  const option = (name: string, fallback: string): string => {
    const at = process.argv.indexOf(`--${name}`);
    return at > 0 && process.argv[at + 1] !== undefined ? process.argv[at + 1]! : fallback;
  };
  const ARMS = option("arms", "B").split(",");
  const ROUNDS = Number(option("rounds", "8"));
  const A_DIR = option("a-dir", "");
  const FILES = option("files", "").split(",").filter(Boolean);
  const RELAY = option("relay", "");
  const OUT = option("out", "");
  const EMULATE = Number(option("emulate", "0"));
  const root = join(import.meta.dir, "..");
  let localWs = "";
  if (EMULATE > 0) {
    const { startBunRelay } = await import("../relay/bun.ts");
    // every socket comes from 127.0.0.1: a long run would pass production's per-address budget
    const relayed = startBunRelay({ port: 0, limits: { perAddressPerMinute: 10_000, globalPerMinute: 10_000 } });
    type Pipe = { peer?: import("bun").Socket<Pipe>; queue: { at: number; data: Uint8Array }[]; timer?: ReturnType<typeof setTimeout>; early: Uint8Array[] };
    const forward = (from: Pipe, data: Uint8Array) => {
      from.queue.push({ at: performance.now() + EMULATE / 2, data: data.slice() });
      const drain = () => {
        from.timer = undefined;
        while (from.queue.length && from.queue[0]!.at <= performance.now()) {
          const chunk = from.queue.shift()!.data;
          if (from.peer) from.peer.write(chunk); else from.early.push(chunk);
        }
        if (from.queue.length) from.timer = setTimeout(drain, from.queue[0]!.at - performance.now());
      };
      if (!from.timer) from.timer = setTimeout(drain, EMULATE / 2);
    };
    const proxy = Bun.listen<Pipe>({
      hostname: "127.0.0.1", port: 0,
      socket: {
        open(client) {
          client.data = { queue: [], early: [] };
          const up: Pipe = { queue: [], early: [], peer: client };
          void Bun.connect<Pipe>({ hostname: "127.0.0.1", port: relayed.port, socket: {
            open(server) { server.data = up; client.data.peer = server; for (const chunk of client.data.early.splice(0)) server.write(chunk); },
            data(_server, data) { forward(up, data); },
            close() { client.end(); },
            error() { client.end(); },
          } });
        },
        data(client, data) { forward(client.data, data); },
        close(client) { client.data.peer?.end(); },
        error(client) { client.data.peer?.end(); },
      },
    });
    localWs = `ws://127.0.0.1:${proxy.port}`;
  }
  const own = new Map(FILES.map((file) => [file, readFileSync(join(root, file))]));

  const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2; };
  type Sample = { arm: string; run: number; round: number; open: number; assigned: number; pc: number; admitted: number; first: number };
  const samples: Sample[] = [];
  const restore = () => { for (const [file, bytes] of own) writeFileSync(join(root, file), bytes); };
  process.on("exit", restore);
  // a signal with no listener ends the process without "exit": arm A's files would stay in the tree
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { restore(); process.exit(130); });

  for (const [run, arm] of ARMS.entries()) {
    restore();
    if (arm === "A") for (const file of FILES) copyFileSync(join(A_DIR, file), join(root, file));
    const dir = mkdtempSync(join(tmpdir(), "ovis-relay-open-bench-"));
    const child: Subprocess = Bun.spawn(["bun", import.meta.path, SERVE, join(dir, "state")], {
      cwd: root, stdout: "pipe", stderr: "inherit",
      env: { ...process.env, HOME: join(dir, "home"), HERDR_SOCKET: join(dir, "no-herdr.sock"), ...(RELAY ? { BENCH_RELAY: RELAY } : {}), ...(localWs ? { BENCH_RELAY_WS: localWs } : {}) },
    });
    try {
      const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
      let text = "";
      while (!/BENCH-PORT (\d+)/.test(text)) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("PC child exited before it listened");
        text += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      restore();
      const base = `http://127.0.0.1:${/BENCH-PORT (\d+)/.exec(text)![1]}`;
      const post = (path: string) => fetch(`${base}/api/relay${path}`, { method: "POST", headers: { origin: base, "x-herdr-update": "1" } });
      if ((await post("/start")).status !== 200) throw new Error("relay start failed");
      for (const deadline = Date.now() + 30_000; ;) {
        const status = await (await fetch(`${base}/api/relay`)).json() as { phase: string };
        if (status.phase === "online") break;
        if (Date.now() > deadline) throw new Error(`relay never came up: ${JSON.stringify(status)}`);
        await Bun.sleep(200);
      }
      const { url } = await (await post("/offer")).json() as { url: string };
      const offer = decodeOffer(url);
      if (!offer) throw new Error(`bad offer ${url}`);
      const devices = new Map<string, Device>();
      const store: Store = {
        get: async (id) => devices.get(id),
        update: async (id, change) => { const next = change(devices.get(id)); devices.set(id, next); return next; },
        list: async () => [...devices.values()],
        remove: async (id) => { devices.delete(id); },
      };
      const socket = localWs ? (address: string) => { const target = new URL(address); return new WebSocket(`${localWs}${target.pathname}${target.search}`); } : undefined;
      const paired = await openRelayChannel(offer, { store, label: "bench", ...(socket ? { socket } : {}) });
      paired.close();
      const { code: _code, ...saved } = offer;
      for (let round = 0; round < ROUNDS; round++) {
        const at = { open: 0, assigned: 0, pc: 0 };
        let messages = 0;
        const start = performance.now();
        const channel = await openRelayChannel(saved, {
          store,
          socket: (address) => {
            const target = new URL(address);
            const socket = new WebSocket(localWs ? `${localWs}${target.pathname}${target.search}` : address);
            socket.addEventListener("open", () => { at.open = performance.now() - start; });
            socket.addEventListener("message", () => {
              messages++;
              if (messages === 1) at.assigned = performance.now() - start;
              if (messages === 2) at.pc = performance.now() - start;
            });
            return socket;
          },
        });
        const admitted = performance.now() - start;
        const stream = channel.mux.openHttp({ method: "GET", target: "/api/health", headers: [], body: "none" });
        await new Promise<void>((resolve, reject) => {
          stream.onHeaders = () => resolve();
          stream.onDispose = (error) => { if (error) reject(error); };
        });
        const first = performance.now() - start;
        channel.close();
        const sample = { arm, run, round, open: Math.round(at.open), assigned: Math.round(at.assigned), pc: Math.round(at.pc), admitted: Math.round(admitted), first: Math.round(first) };
        samples.push(sample);
        console.log(JSON.stringify(sample));
        await Bun.sleep(500);
      }
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  restore();
  const summary: Record<string, Record<string, number>> = {};
  for (const arm of new Set(ARMS)) {
    const mine = samples.filter((sample) => sample.arm === arm);
    summary[arm] = { n: mine.length };
    for (const key of ["open", "assigned", "pc", "admitted", "first"] as const) summary[arm]![key] = median(mine.map((sample) => sample[key]));
  }
  const result = { at: new Date().toISOString(), relay: EMULATE ? `local Bun relay, emulated RTT ${EMULATE} ms per leg` : RELAY || "wss://relay.ovis.sh", arms: ARMS, rounds: ROUNDS, files: FILES, load: loadavg(), summary, samples };
  console.log(`BENCH-RESULT ${JSON.stringify({ ...result, samples: undefined })}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
  // the emulated relay and its proxy would keep this process alive
  process.exit(0);
}
