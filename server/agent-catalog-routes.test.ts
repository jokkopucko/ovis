import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_CATALOG, catalogPlatform, type AgentCatalogResponse } from "../shared/agent-catalog.ts";
import { AgentDetector, catalogLocator, runVersion } from "./agent-catalog-detect.ts";
import { createServer } from "./index.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

const BROWSER_TOKEN = "catalog-browser-token";
const BRIDGE_TOKEN = "c".repeat(64);
const WATCH_TOKEN = "w".repeat(64);

describe("GET /api/agent-catalog", () => {
  let server: ReturnType<typeof createServer>;
  let root: string;
  let bin: string;
  const savedPath = process.env["PATH"];
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ovis-catalog-route-"));
    bin = join(root, "bin");
    mkdirSync(bin);
    const state = join(root, "state");
    mkdirSync(state);
    // one paired device that may only watch
    writeFileSync(join(state, "devices.json"), JSON.stringify({ gate_closed_at: new Date().toISOString(), devices: [{ id: "0123456789abcdef", label: "Watch fixture", role: "watch", token_hash: createHash("sha256").update(WATCH_TOKEN).digest("hex"), created_at: new Date().toISOString(), last_seen_at: null }] }), { mode: 0o600 });
    // installer folders are looked for in an empty home, never this PC's own
    const home = join(root, "home");
    mkdirSync(home);
    const agentDetector = new AgentDetector({ locate: catalogLocator({ probe: null }), home, env: {} });
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: state, token: BROWSER_TOKEN, bridgeToken: BRIDGE_TOKEN, machines: false, sidecar: false, tailscaleOwner: null, agentDetector });
  });
  afterEach(() => { process.env["PATH"] = savedPath; });
  afterAll(() => {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")("lists every catalog agent with this platform's commands and what is installed here", async () => {
    writeFileSync(join(bin, "claude"), "#!/bin/sh\necho '2.1.311 (Claude Code)'\n");
    chmodSync(join(bin, "claude"), 0o755);
    process.env["PATH"] = bin;
    const response = await fetch(url("/api/agent-catalog"), { headers: bearer(BROWSER_TOKEN) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as AgentCatalogResponse;
    const platform = catalogPlatform(process.platform)!;
    expect(body.platform).toBe(platform);
    expect(body.agents.map((agent) => agent.id)).toEqual(AGENT_CATALOG.map((entry) => entry.id));
    const claude = body.agents.find((agent) => agent.id === "claude")!;
    expect(claude.install).toEqual(AGENT_CATALOG.find((entry) => entry.id === "claude")!.install[platform]);
    expect(claude.state).toEqual({ installed: true, binary: "claude", on_path: true, version: "2.1.311", version_error: null, meets_min_version: true });
    expect(body.agents.find((agent) => agent.id === "grok")!.state.installed).toBe(false);
    const muse = body.agents.find((agent) => agent.id === "muse")!;
    expect([muse.install, typeof muse.no_install]).toEqual([null, "string"]);
  });

  it("answers a watch device and the connection server's bridge token, and refuses no credential and a write", async () => {
    process.env["PATH"] = bin;
    expect((await fetch(url("/api/agent-catalog"))).status).toBe(401);
    const watched = await fetch(url("/api/agent-catalog"), { headers: { cookie: `ovis_device=${WATCH_TOKEN}`, "x-forwarded-for": "100.64.0.9" } });
    expect(watched.status).toBe(200);
    expect((await fetch(url("/api/agent-catalog"), { headers: bearer(BRIDGE_TOKEN) })).status).toBe(200);
    const watchPost = await fetch(url("/api/agent-catalog"), { method: "POST", headers: { cookie: `ovis_device=${WATCH_TOKEN}`, "x-forwarded-for": "100.64.0.9", origin: url("") } });
    expect([watchPost.status, ((await watchPost.json()) as { error: { code: string } }).error.code]).toEqual([403, "read_only"]);
    const post = await fetch(url("/api/agent-catalog"), { method: "POST", headers: { ...bearer(BROWSER_TOKEN), origin: url("") } });
    expect([post.status, ((await post.json()) as { error: { code: string } }).error.code]).toEqual([400, "method_not_allowed"]);
  });

  it("reaches another PC's catalog through the PC proxy with that PC's bridge token", async () => {
    process.env["PATH"] = bin;
    const manager = { endpoint: (id: string) => id === "remote" ? { url: url(""), token: BRIDGE_TOKEN } : null, trackTerminal: () => () => {} } as unknown as MachineManager;
    const response = await handleMachineRequest(new Request("http://127.0.0.1/api/machines/remote/agent-catalog"), manager);
    expect(response.status).toBe(200);
    const direct = await (await fetch(url("/api/agent-catalog"), { headers: bearer(BROWSER_TOKEN) })).json();
    expect(await response.json()).toEqual(direct);
  });
});

it("serves the first agent catalog GET from the startup warm cache without another version read", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-catalog-warm-"));
  const executable = join(root, "claude");
  writeFileSync(executable, "fixture executable");
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const warmed = Promise.withResolvers<void>();
  const overlapping = Promise.withResolvers<void>();
  let reads = 0;
  let claudeCalls = 0;
  class Detector extends AgentDetector {
    override async state(...args: Parameters<AgentDetector["state"]>) {
      const pending = super.state(...args);
      if (args[0].id === "claude" && ++claudeCalls === 2) overlapping.resolve();
      const state = await pending;
      if (args[0].id === "claude") warmed.resolve();
      return state;
    }
  }
  const agentDetector = new Detector({
    locate: async (binary) => binary === "claude" ? executable : null,
    home: root,
    env: {},
    run: async () => {
      reads++;
      started.resolve();
      await release.promise;
      return { stdout: "2.1.311", stderr: "", exitCode: 0, timedOut: false };
    },
  });
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", machines: false, sidecar: false, tailscaleOwner: null, agentDetector });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("startup catalog signal did not arrive")), 2_000);
  });
  try {
    server.warmAgentCatalog();
    await Promise.race([started.promise, deadline]);
    // Startup and unrelated requests do not wait for the held version probe.
    expect((await fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`)).status).toBe(200);
    const duringWarmup = fetch(`http://127.0.0.1:${server.port}/api/agent-catalog`);
    await Promise.race([overlapping.promise, deadline]);
    release.resolve();
    const overlappingResponse = await Promise.race([duringWarmup, deadline]);
    expect(overlappingResponse.status).toBe(200);
    const overlappingBody: AgentCatalogResponse = await overlappingResponse.json();
    expect(overlappingBody.agents.find((agent) => agent.id === "claude")?.state.version).toBe("2.1.311");
    await Promise.race([warmed.promise, deadline]);
    expect(reads).toBe(1);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/agent-catalog`);
    const body: AgentCatalogResponse = await response.json();
    expect(response.status).toBe(200);
    expect(body.agents.find((agent) => agent.id === "claude")?.state.version).toBe("2.1.311");
    expect(reads).toBe(1);
  } finally {
    clearTimeout(timer);
    release.resolve();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

it("a GET during the warm-up joins its version reads: no agent's --version runs twice, queued ones included", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-catalog-warm-join-"));
  // more agents than run at once, so some of the warm-up's reads still wait in its queue when the GET comes
  const ids = ["claude", "codex", "copilot", "opencode", "grok", "pi"];
  const executables = new Map(ids.map((id) => [id, join(root, id)]));
  for (const path of executables.values()) writeFileSync(path, "fixture executable");
  const runs = new Map<string, number>();
  const release = Promise.withResolvers<void>();
  const first = Promise.withResolvers<void>();
  // every agent asked twice (the warm-up, then the GET) while no read has finished
  const asked = new Map<string, number>();
  const bothAsked = Promise.withResolvers<void>();
  class Detector extends AgentDetector {
    override async state(...args: Parameters<AgentDetector["state"]>) {
      const pending = super.state(...args);
      if (ids.includes(args[0].id)) {
        asked.set(args[0].id, (asked.get(args[0].id) ?? 0) + 1);
        if (ids.every((id) => (asked.get(id) ?? 0) >= 2)) bothAsked.resolve();
      }
      return pending;
    }
  }
  const agentDetector = new Detector({
    locate: async (binary) => executables.get(binary) ?? null,
    home: root,
    env: {},
    run: async (executable) => {
      runs.set(executable, (runs.get(executable) ?? 0) + 1);
      first.resolve();
      await release.promise;
      return { stdout: "1.0.0", stderr: "", exitCode: 0, timedOut: false };
    },
  });
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", machines: false, sidecar: false, tailscaleOwner: null, agentDetector });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("the catalog did not answer")), 3_000); });
  try {
    server.warmAgentCatalog();
    await Promise.race([first.promise, deadline]);
    const during = fetch(`http://127.0.0.1:${server.port}/api/agent-catalog`);
    // the GET has asked for every agent before any read of the warm-up finished
    await Promise.race([bothAsked.promise, deadline]);
    release.resolve();
    const response = await Promise.race([during, deadline]);
    const body: AgentCatalogResponse = await response.json();
    expect(body.agents.filter((agent) => ids.includes(agent.id)).map((agent) => agent.state.version)).toEqual(ids.map(() => "1.0.0"));
    expect([...runs.values()].every((count) => count === 1)).toBe(true);
    expect(runs.size).toBe(ids.length);
  } finally {
    clearTimeout(timer);
    release.resolve();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 5_000);

it("does not warm the agent catalog until explicitly requested", () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-catalog-no-warm-"));
  const agentDetector = new AgentDetector({ locate: async () => null, home: root, env: {} });
  const state = spyOn(agentDetector, "state");
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", machines: false, sidecar: false, tailscaleOwner: null, agentDetector });
  try {
    expect(state).not.toHaveBeenCalled();
  } finally {
    server.stop();
    state.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it("logs a failed startup catalog warm-up and keeps serving requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-catalog-warm-error-"));
  const logged = Promise.withResolvers<void>();
  const log = spyOn(console, "error").mockImplementation((message: unknown) => {
    if (typeof message === "string" && message.includes("agent catalog warm-up failed: fixture lookup failed")) logged.resolve();
  });
  const agentDetector = new AgentDetector({ locate: async () => { throw new Error("fixture lookup failed"); }, home: root, env: {} });
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", machines: false, sidecar: false, tailscaleOwner: null, agentDetector });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("warm-up failure was not logged")), 2_000);
  });
  try {
    server.warmAgentCatalog();
    await Promise.race([logged.promise, deadline]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("agent catalog warm-up failed: fixture lookup failed"));
    expect((await fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`)).status).toBe(200);
  } finally {
    clearTimeout(timer);
    server.stop();
    log.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform === "win32")("kills held warm-up processes on stop without launching queued or new probes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ovis-catalog-warm-stop-"));
  const started = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  let launches = 0;
  let versionRuns = 0;
  let exits = 0;
  // Each real version process holds a connection; its close is the process-death signal.
  const listener = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: {
      open() { if (++launches === 4) started.resolve(); },
      data() {},
      close() { if (++exits === 4) ended.resolve(); },
    },
  });
  const binaries = new Set(AGENT_CATALOG.flatMap((entry) => entry.detect.binaries));
  for (const binary of binaries) {
    const executable = join(root, binary);
    writeFileSync(executable, `#!${process.execPath}\nawait Bun.connect({ hostname: "127.0.0.1", port: ${listener.port}, socket: { data() {}, close() {} } });\nsetInterval(() => {}, 60000);\n`);
    chmodSync(executable, 0o755);
  }
  const pending: Promise<unknown>[] = [];
  class Detector extends AgentDetector {
    override state(...args: Parameters<AgentDetector["state"]>) {
      const state = super.state(...args);
      pending.push(state);
      return state;
    }
  }
  const agentDetector = new Detector({
    locate: async (binary) => binaries.has(binary) ? join(root, binary) : null, home: root, env: {},
    run: (...args) => { versionRuns++; return runVersion(...args); },
  });
  const server = createServer({ port: 0, hostname: "127.0.0.1", stateDir: root, token: "", machines: false, sidecar: false, tailscaleOwner: null, agentDetector });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("warm-up processes did not start or stop")), 5_000);
  });
  try {
    server.warmAgentCatalog();
    await Promise.race([started.promise, deadline]);
    expect(pending.length).toBeGreaterThan(launches);
    server.stop();
    await Promise.race([Promise.all([ended.promise, ...pending]), deadline]);
    expect(exits).toBe(4);
    expect(launches).toBe(4);
    expect(versionRuns).toBe(4);
    const fresh = AGENT_CATALOG.find((entry) => entry.id === "claude");
    if (!fresh) throw new Error("fixture agent missing");
    writeFileSync(join(root, "claude"), "changed executable");
    await Promise.race([agentDetector.state(fresh, "linux"), deadline]);
    expect(versionRuns).toBe(4);
  } finally {
    clearTimeout(timer);
    server.stop();
    listener.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
