import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CatalogPane } from "./catalog-sources.ts";
import { mergeCatalogSources } from "./catalog-sources.ts";
import { closeCodexDaemonSources, createCodexDaemonSource, DaemonConnection, paneDaemonHome } from "./codex-daemon.ts";
import { processEnviron } from "./omo.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const pane = {} as CatalogPane;
const ALLOWED = new Set(["initialize", "initialized", "skills/list"]);

interface Fake {
  home: string;
  methods: string[];
  listed: Promise<void>;
  release(): void;
  releaseInit(): void;
  connections: { opened: number; closed: number };
  raw: string[];
  params: unknown[];
  changed(): void;
}

function fakeDaemon(options: { userAgent?: string; refuse?: boolean; skills?: unknown[]; entries?: unknown[]; hold?: boolean; holdInit?: boolean; refuseFirst?: boolean; byCwd?: Record<string, unknown[]>; at?: string; home?: string } = {}): Fake {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "codex-daemon-"));
  if (options.home === undefined) cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "app-server-control"), { recursive: true });
  const advertised = join(home, "app-server-control", "app-server-control.sock");
  if (options.at !== undefined) symlinkSync(options.at, advertised);
  const methods: string[] = [];
  const raw: string[] = [];
  const connections = { opened: 0, closed: 0 };
  let listed!: () => void;
  const listedPromise = new Promise<void>((resolve) => { listed = resolve; });
  const held: (() => void)[] = [];
  const heldInit: (() => void)[] = [];
  const params: unknown[] = [];
  const sockets = new Set<{ send(data: string): void }>();
  const server = Bun.serve({
    unix: options.at ?? advertised,
    fetch(request, bun) { return bun.upgrade(request) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      open(socket) { sockets.add(socket); connections.opened++; },
      close(socket) { sockets.delete(socket); connections.closed++; },
      message(socket, data) {
        raw.push(String(data));
        const message = JSON.parse(String(data)) as { id?: number; method: string; params?: unknown };
        methods.push(message.method);
        params.push(message.params);
        if (message.id === undefined) return;
        if (message.method === "initialize") {
          const reply = () => socket.send(JSON.stringify({ id: message.id, result: { userAgent: options.userAgent ?? "codex_cli_rs/0.163.0 (Linux)" } }));
          if (options.holdInit) heldInit.push(reply); else reply();
        }
        else if (options.refuse) socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: "requires experimentalApi" } }));
        else if (options.refuseFirst && methods.filter((method) => method === "skills/list").length === 1) {
          socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: "requires experimentalApi" } }));
        } else if (options.byCwd) {
          const cwd = (message.params as { cwds: string[] }).cwds[0]!;
          socket.send(JSON.stringify({ id: message.id, result: { data: [{ cwd, skills: options.byCwd[cwd] ?? [], errors: [] }] } }));
        } else if (options.hold) {
          const reply = () => socket.send(JSON.stringify({ id: message.id, result: { data: options.entries ?? [{ cwd: "/w", skills: options.skills ?? [], errors: [] }] } }));
          held.push(reply);
          listed();
        } else socket.send(JSON.stringify({ id: message.id, result: { data: options.entries ?? [{ cwd: "/w", skills: options.skills ?? [], errors: [] }] } }));
      },
    },
  });
  cleanups.push(() => void server.stop(true));
  return { home, methods, listed: listedPromise, releaseInit: () => heldInit.splice(0).forEach((reply) => { try { reply(); } catch {} }),
    release: () => held.splice(0).forEach((reply) => { try { reply(); } catch {} }), connections, raw, params, changed: () => sockets.forEach((socket) => socket.send(JSON.stringify({ method: "skills/changed", params: {} }))) };
}

const skill = (name: string, extra: Record<string, unknown> = {}) => ({ name, description: `About ${name}`, path: `/s/${name}/SKILL.md`, scope: "user", enabled: true, ...extra });
const temp = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
function silentPeer(): { home: string; opened: Promise<void>; closed: Promise<void> } {
  const home = temp("codex-daemon-silent-");
  mkdirSync(join(home, "app-server-control"));
  let opened!: () => void;
  let closed!: () => void;
  const peer = { home, opened: new Promise<void>((resolve) => { opened = resolve; }), closed: new Promise<void>((resolve) => { closed = resolve; }) };
  const server = Bun.listen({ unix: join(home, "app-server-control", "app-server-control.sock"), socket: { open: () => opened(), data() {}, close: () => closed() } });
  cleanups.push(() => server.stop(true));
  return peer;
}
const until = async (ready: () => boolean): Promise<void> => {
  const deadline = performance.now() + 3000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error("the condition never held");
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const within = <T>(promise: Promise<T>, label: string): Promise<T> => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} did not happen`)), 3000))]);
const source = (home: string, warnings: string[] = []) => {
  const provider = createCodexDaemonSource({ codexHome: () => home, warn: (message) => warnings.push(message) });
  cleanups.push(() => provider.close());
  return provider;
};
const ask = (provider: ReturnType<typeof source>, cwd = "/w") => provider.rows(pane, cwd, new AbortController().signal);

describe("codex daemon skills", () => {
  it("asks each Codex home's own daemon, and closes every home's connection on stop", async () => {
    const first = fakeDaemon({ skills: [skill("from-first")] });
    const second = fakeDaemon({ skills: [skill("from-second")] });
    const names = async (codexHome: string) => (await mergeCatalogSources("codex", pane, "/w", [], undefined, { codexHome })).map((row) => row.name);
    try {
      expect(await names(first.home)).toEqual(["from-first"]);
      expect(await names(second.home)).toEqual(["from-second"]);
      expect(await names(first.home)).toEqual(["from-first"]);
      expect(first.connections.opened).toBe(1);
    } finally {
      closeCodexDaemonSources();
    }
    await until(() => first.connections.closed === first.connections.opened && second.connections.closed === second.connections.opened);
  });

  it("knows a pane's Codex home only from the server's setting or the pane's own process on Linux", async () => {
    expect(await paneDaemonHome("any-pane", "/configured/home", "darwin")).toBe("/configured/home");
    expect(await paneDaemonHome("any-pane", undefined, "darwin")).toBeNull();
    expect(await paneDaemonHome("any-pane", undefined, "win32")).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("uses the first CODEX_HOME when the Linux environment repeats it", async () => {
    const first = temp("codex-home-first-");
    const last = temp("codex-home-last-");
    const processFiles = {
      lookup: async () => ({ pid: process.pid }),
      environ: () => [`CODEX_HOME=${first}`, `CODEX_HOME=${last}`, "HOME=/fallback"],
    };
    const home = await paneDaemonHome("any-pane", undefined, "linux", processFiles);
    // Then it agrees with getenv's first occurrence.
    expect(home).toBe(realpathSync(first));
  });

  it.skipIf(process.platform !== "linux").each(["relative", "absolute"])("follows a symlink before its parent component in %s CODEX_HOME", async (kind) => {
    const cwd = temp("codex-home-parent-");
    const target = join(cwd, "other");
    mkdirSync(join(target, "child"), { recursive: true });
    symlinkSync(join(target, "child"), join(cwd, "link"));
    const processFiles = {
      lookup: async () => ({ pid: process.pid }),
      environ: () => [`CODEX_HOME=${kind === "relative" ? "link/.." : `${cwd}/link/..`}`],
      cwd: async () => cwd,
    };
    const home = await paneDaemonHome("any-pane", undefined, "linux", processFiles);
    // Then filesystem traversal selects the target's parent, not the cwd.
    expect(home).toBe(realpathSync(target));
  });

  it("uses the first HOME when the Linux environment repeats it", async () => {
    const processFiles = {
      lookup: async () => ({ pid: process.pid }),
      environ: () => ["HOME=/first/home", "HOME=/last/home"],
    };
    const home = await paneDaemonHome("any-pane", undefined, "linux", processFiles);
    expect(home).toBe("/first/home/.codex");
  });

  it.skipIf(process.platform !== "linux")("resolves a relative CODEX_HOME against the Linux process cwd", async () => {
    const cwd = temp("codex-home-cwd-");
    mkdirSync(join(cwd, "relative-codex"));
    const processFiles = {
      lookup: async () => ({ pid: 123 }),
      environ: () => ["CODEX_HOME=relative-codex", "HOME=/fallback"],
      cwd: async (pid: number) => {
        expect(pid).toBe(123);
        return cwd;
      },
    };
    const home = await paneDaemonHome("any-pane", undefined, "linux", processFiles);
    expect(home).toBe(join(realpathSync(cwd), "relative-codex"));
  });

  it.skipIf(process.platform !== "linux")("reads the Linux process cwd from proc for a relative CODEX_HOME", async () => {
    const processFiles = {
      lookup: async () => ({ pid: process.pid }),
      environ: () => ["CODEX_HOME=."],
    };
    const home = await paneDaemonHome("any-pane", undefined, "linux", processFiles);
    expect(home).toBe(realpathSync(`/proc/${process.pid}/cwd`));
  });

  it("returns null when a relative CODEX_HOME has an unreadable Linux process cwd", async () => {
    const processFiles = {
      lookup: async () => ({ pid: 0 }),
      environ: () => ["CODEX_HOME=relative-codex", "HOME=/fallback"],
    };
    const home = await paneDaemonHome("any-pane", undefined, "linux", processFiles);
    expect(home).toBeNull();
  });

  it.skipIf(process.platform !== "linux")("returns null when a live process's CODEX_HOME is its deleted cwd", async () => {
    const root = temp("codex-home-deleted-");
    const cwd = join(root, "gone");
    mkdirSync(cwd);
    // Read only once it is up: until its exec, a child spawned a moment ago still shows the parent's
    // environment in /proc, without this CODEX_HOME (most reads right after spawn, on this PC). The
    // shell that says so is the process read: it waits in a read, with no exec after it
    const child = Bun.spawn(["/bin/sh", "-c", "echo READY; read _"], {
      cwd, env: { ...process.env, CODEX_HOME: "." }, stdin: "pipe", stdout: "pipe", stderr: "ignore",
    });
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      for (let said = ""; !said.includes("READY\n");) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`the child exited before it was up: ${said}`);
        said += decoder.decode(chunk.value, { stream: true });
      }
      reader.releaseLock();
      rmSync(cwd, { recursive: true });
      expect(processEnviron(child.pid)).toContain("CODEX_HOME=.");
      const home = await paneDaemonHome("any-pane", undefined, "linux", {
        lookup: async () => ({ pid: child.pid }),
        environ: processEnviron,
      });
      expect(home).toBeNull();
    } finally {
      child.kill();
      await child.exited;
    }
  });

  it.each([
    { environ: ["CODEX_HOME=", "CODEX_HOME=/ignored", "HOME=/fallback"], expected: "/fallback/.codex" },
    { environ: ["HOME=", "HOME=/ignored"], expected: null },
    { environ: [], expected: null },
    { environ: null, expected: null },
  ])("uses Linux home $expected without reading cwd for $environ", async ({ environ, expected }) => {
    let cwdReads = 0;
    const processFiles = {
      lookup: async () => ({ pid: 0 }),
      environ: () => environ,
      cwd: async () => { cwdReads++; return "/unused"; },
    };
    const home = await paneDaemonHome("any-pane", undefined, "linux", processFiles);
    expect(home).toBe(expected);
    expect(cwdReads).toBe(0);
  });

  it.skipIf(process.platform !== "linux").each(["relative", "absolute"])("canonicalizes an existing %s CODEX_HOME through symlinks", async (kind) => {
    const cwd = temp("codex-home-link-");
    const target = join(cwd, "target");
    mkdirSync(target);
    symlinkSync(target, join(cwd, "link"));
    const own = kind === "relative" ? "link" : join(cwd, "link");
    const home = await paneDaemonHome("any-pane", undefined, "linux", {
      lookup: async () => ({ pid: process.pid }),
      environ: () => [`CODEX_HOME=${own}`],
      cwd: async () => cwd,
    });
    expect(home).toBe(realpathSync(target));
  });

  it.skipIf(process.platform !== "linux").each(["missing", "link/child", "file"])("returns null when CODEX_HOME %s is not a directory", async (own) => {
    const cwd = temp("codex-home-invalid-");
    symlinkSync(join(cwd, "absent"), join(cwd, "link"));
    symlinkSync(import.meta.path, join(cwd, "file"));
    const home = await paneDaemonHome("any-pane", undefined, "linux", {
      lookup: async () => ({ pid: process.pid }),
      environ: () => [`CODEX_HOME=${own}`, "HOME=/fallback"],
      cwd: async () => cwd,
    });
    expect(home).toBeNull();
  });

  it("gives native skill rows, enabled ones only, and sends nothing but initialize and skills/list", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha"), skill("off", { enabled: false }), skill("beta", { scope: "repo" }), skill("plug", { pluginId: "p@m" })] });
    const rows = await ask(source(fake.home));
    expect(rows?.map((row) => [row.name, row.origin, row.trigger, row.source, row.provenance])).toEqual([
      ["alpha", "user", "$", "skill", { transport: "native", verified: true }],
      ["beta", "project", "$", "skill", { transport: "native", verified: true }],
      ["plug", "plugin", "$", "skill", { transport: "native", verified: true }],
    ]);
    expect(rows?.[0]?.id).toBe("/s/alpha/SKILL.md");
    expect(fake.methods.every((method) => ALLOWED.has(method))).toBe(true);
    expect(fake.methods.filter((method) => method === "skills/list")).toHaveLength(1);
    expect(fake.params[0]).toMatchObject({ capabilities: { experimentalApi: false } });
    expect(fake.params[fake.methods.indexOf("skills/list")]).toEqual({ cwds: ["/w"] });
  });

  it("answers from its cache until skills/changed", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha")] });
    const provider = source(fake.home);
    await ask(provider);
    await ask(provider);
    expect(fake.methods.filter((method) => method === "skills/list")).toHaveLength(1);
    fake.changed();
    await ask(provider, "/elsewhere");
    await ask(provider);
    expect(fake.methods.filter((method) => method === "skills/list")).toHaveLength(3);
  });

  it("keeps the scan rows when there is no socket, and starts nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "codex-daemon-none-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    expect(await ask(source(home))).toBeNull();
    expect(readdirSync(home)).toEqual([]);
  });

  it("keeps the scan rows below 0.157.0, on Windows, without a cwd, and when skills/list is refused", async () => {
    const old = fakeDaemon({ userAgent: "codex_cli_rs/0.156.9 (Linux)", skills: [skill("alpha")] });
    expect(await ask(source(old.home))).toBeNull();
    expect(old.methods).not.toContain("skills/list");

    const fake = fakeDaemon({ skills: [skill("alpha")] });
    expect(await createCodexDaemonSource({ codexHome: () => fake.home, platform: "win32" }).rows(pane, "/w", new AbortController().signal)).toBeNull();
    expect(await ask(source(fake.home), "")).toBeNull();
    expect(fake.methods).toEqual([]);

    const refusing = fakeDaemon({ refuse: true });
    const warnings: string[] = [];
    const provider = source(refusing.home, warnings);
    expect(await ask(provider)).toBeNull();
    expect(await ask(provider)).toBeNull();
    expect(refusing.methods.filter((method) => method === "skills/list")).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(refusing.methods.every((method) => ALLOWED.has(method))).toBe(true);
  });

  it("returns null at once when the caller's budget is aborted", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha")] });
    const controller = new AbortController();
    controller.abort();
    expect(await source(fake.home).rows(pane, "/w", controller.signal)).toBeNull();
  });

  it("returns null, logging once, when an entry has errors or a skill lacks the protocol's fields", async () => {
    const withErrors = fakeDaemon({ entries: [{ cwd: "/w", skills: [skill("alpha")], errors: [{ path: "/s/x", message: "bad" }] }] });
    const warnings: string[] = [];
    const provider = source(withErrors.home, warnings);
    expect(await ask(provider)).toBeNull();
    expect(await ask(provider, "/other")).toBeNull();
    expect(warnings).toHaveLength(1);

    for (const bad of [{ name: "only-a-name" }, skill("x", { enabled: undefined }), skill("x", { scope: "galaxy" }), skill("x", { path: undefined }), skill("x", { description: 3 })]) {
      const fake = fakeDaemon({ skills: [skill("good"), bad] });
      expect(await ask(source(fake.home))).toBeNull();
    }
    expect(await ask(source(fakeDaemon({ entries: [] }).home))).toBeNull();
    expect(await ask(source(fakeDaemon({ entries: [{ cwd: "/w", skills: [skill("alpha")], errors: [] }] }).home))).not.toBeNull();
  });

  it("refuses any method but initialize, initialized and skills/list before a byte is sent", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha")] });
    const connection = await DaemonConnection.open(join(fake.home, "app-server-control", "app-server-control.sock"), () => undefined, () => undefined);
    cleanups.push(() => connection.close());
    for (const method of ["thread/resume", "turn/start", "item/commandExecution/requestApproval", "skills/config/write"]) {
      await expect(connection.request(method as "skills/list", {})).rejects.toThrow();
    }
    expect(() => connection.notify("thread/resume" as "initialized")).toThrow();
    await connection.request("skills/list", { cwds: ["/w"] });
    expect(fake.raw.map((frame) => (JSON.parse(frame) as { method: string }).method)).toEqual(["initialize", "initialized", "skills/list"]);
  });

  it("closes a half-open handshake when the read is aborted and when the provider closes", async () => {
    const peer = silentPeer();
    const controller = new AbortController();
    const provider = source(peer.home);
    const pending = provider.rows(pane, "/w", controller.signal);
    await within(peer.opened, "the connection");
    controller.abort();
    expect(await within(pending, "the answer")).toBeNull();
    await within(peer.closed, "the close after abort");

    const other = silentPeer();
    const second = source(other.home);
    const again = second.rows(pane, "/w", new AbortController().signal);
    await within(other.opened, "the connection");
    second.close();
    expect(await within(again, "the answer")).toBeNull();
    await within(other.closed, "the close after provider.close");
  });

  it("answers null to a call aborted while skills/list is pending, however late the reply, and drops a connection nobody waits on", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha")], hold: true });
    const controller = new AbortController();
    const provider = source(fake.home);
    const aborted = provider.rows(pane, "/w", controller.signal);
    await within(fake.listed, "the skills/list request");
    controller.abort();
    fake.release();
    expect(await within(aborted, "the answer")).toBeNull();
    await within(until(() => fake.connections.closed === fake.connections.opened), "the peer's close");
    expect(fake.connections.opened).toBe(1);
  });

  it("still gives a waiter that did not abort its rows, and keeps the connection for it", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha")], hold: true });
    const controller = new AbortController();
    const provider = source(fake.home);
    const aborted = provider.rows(pane, "/w", controller.signal);
    const waiting = provider.rows(pane, "/w", new AbortController().signal);
    await within(fake.listed, "the skills/list request");
    controller.abort();
    fake.release();
    expect(await within(aborted, "the aborted answer")).toBeNull();
    expect((await within(waiting, "the other answer"))?.map((row) => row.name)).toEqual(["alpha"]);
    expect(fake.connections.closed).toBe(0);
  });

  it("closes the connection when the last live waiter of every read has aborted, though the reads have not settled", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha")], hold: true });
    const first = new AbortController();
    const second = new AbortController();
    const provider = source(fake.home);
    const one = provider.rows(pane, "/w", first.signal);
    const two = provider.rows(pane, "/v", second.signal);
    await within(until(() => fake.methods.filter((method) => method === "skills/list").length === 2), "both requests");
    first.abort();
    second.abort();
    expect(await within(one, "the first answer")).toBeNull();
    expect(await within(two, "the second answer")).toBeNull();
    await within(until(() => fake.connections.closed === fake.connections.opened), "the peer's close");
    expect(fake.connections.opened).toBe(1);
  });

  it("keeps the connection for the read that has a live waiter, then follows the idle rule", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha")], hold: true });
    const aborting = new AbortController();
    const provider = source(fake.home);
    const gone = provider.rows(pane, "/w", aborting.signal);
    const stays = provider.rows(pane, "/v", new AbortController().signal);
    await within(until(() => fake.methods.filter((method) => method === "skills/list").length === 2), "both requests");
    aborting.abort();
    expect(await within(gone, "the aborted answer")).toBeNull();
    expect(fake.connections.closed).toBe(0);
    fake.release();
    expect((await within(stays, "the surviving answer"))?.map((row) => row.name)).toEqual(["alpha"]);
    expect(fake.connections.closed).toBe(0);
  });

  it("closes the connection after a read that ends in a fallback, and does not reconnect for the next one", async () => {
    const outcomes: [string, Parameters<typeof fakeDaemon>[0]][] = [
      ["an old version", { userAgent: "codex_cli_rs/0.156.9 (Linux)", skills: [skill("alpha")] }],
      ["a refusal", { refuse: true }],
      ["a malformed skill", { skills: [{ name: "only-a-name" }] }],
      ["an entry with errors", { entries: [{ cwd: "/w", skills: [skill("alpha")], errors: [{ path: "/s", message: "bad" }] }] }],
    ];
    for (const [label, options] of outcomes) {
      const fake = fakeDaemon(options);
      const provider = source(fake.home);
      expect(await ask(provider), label).toBeNull();
      await within(until(() => fake.connections.closed === fake.connections.opened), `${label}: the peer's close`);
      expect(await ask(provider), label).toBeNull();
      expect(fake.connections.opened, label).toBe(1);
    }
  });

  it("keeps the connection of a read that succeeded, under the idle timer", async () => {
    const fake = fakeDaemon({ skills: [skill("alpha")] });
    const provider = source(fake.home);
    expect(await ask(provider)).not.toBeNull();
    expect(fake.connections.closed).toBe(0);
  });

  it("closes the connection for everyone, and backs off, when two reads find an old or unknown version", async () => {
    for (const userAgent of ["codex_cli_rs/0.156.9 (Linux)", "something-else"]) {
      const fake = fakeDaemon({ userAgent, skills: [skill("alpha")], holdInit: true });
      const provider = source(fake.home);
      const one = provider.rows(pane, "/w", new AbortController().signal);
      const two = provider.rows(pane, "/v", new AbortController().signal);
      await within(until(() => fake.methods.includes("initialize")), `${userAgent}: the initialize request`);
      fake.releaseInit();
      expect(await within(one, "the first answer")).toBeNull();
      expect(await within(two, "the second answer")).toBeNull();
      await within(until(() => fake.connections.closed === fake.connections.opened), `${userAgent}: the peer's close`);
      expect(await ask(provider, "/u")).toBeNull();
      expect(fake.connections.opened).toBe(1);
      expect(fake.methods).not.toContain("skills/list");
    }
  });

  it("ends a read that is still waiting when another read finds the daemon refuses skills/list", async () => {
    const fake = fakeDaemon({ refuseFirst: true, hold: true, skills: [skill("alpha")] });
    const provider = source(fake.home);
    const refused = provider.rows(pane, "/w", new AbortController().signal);
    const waiting = provider.rows(pane, "/v", new AbortController().signal);
    expect(await within(refused, "the refused answer")).toBeNull();
    expect(await within(waiting, "the waiting answer")).toBeNull();
    await within(until(() => fake.connections.closed === fake.connections.opened), "the peer's close");
    expect(fake.connections.opened).toBe(1);
  });

  it("keeps the rows of a read that succeeded when another cwd's entry is malformed, and leaves the connection to the idle rule", async () => {
    const fake = fakeDaemon({ byCwd: { "/w": [skill("alpha")], "/v": [{ name: "only-a-name" }] } });
    const provider = source(fake.home);
    const [good, bad] = await Promise.all([ask(provider, "/w"), ask(provider, "/v")]);
    expect(good?.map((row) => row.name)).toEqual(["alpha"]);
    expect(bad).toBeNull();
    expect(fake.connections.closed).toBe(0);
    expect((await ask(provider, "/w"))?.map((row) => row.name)).toEqual(["alpha"]);
    expect(fake.methods.filter((method) => method === "skills/list")).toHaveLength(2);
    expect(fake.connections.opened).toBe(1);
  });

  it("closes the connection after two reads that both end malformed", async () => {
    const fake = fakeDaemon({ byCwd: { "/w": [{ name: "x" }], "/v": [{ name: "y" }] } });
    const provider = source(fake.home);
    expect(await Promise.all([ask(provider, "/w"), ask(provider, "/v")])).toEqual([null, null]);
    await within(until(() => fake.connections.closed === fake.connections.opened), "the peer's close");
  });

  describe("the failure backoff", () => {
    const clocked = (home: string) => {
      const clock = { at: 0 };
      const provider = createCodexDaemonSource({ codexHome: () => home, now: () => clock.at, warn: () => undefined });
      cleanups.push(() => provider.close());
      return { clock, provider };
    };
    const readAt = (setup: ReturnType<typeof clocked>, at: number) => {
      setup.clock.at = at;
      return ask(setup.provider);
    };

    it("is not restarted by reads it suppresses, so a repaired daemon is found 10 s after the failure", async () => {
      const home = temp("codex-daemon-backoff-");
      const setup = clocked(home);
      expect(await readAt(setup, 0)).toBeNull();
      const fake = fakeDaemon({ home, skills: [skill("alpha")] });
      for (const at of [1000, 5000, 9000]) expect(await readAt(setup, at)).toBeNull();
      expect(fake.connections.opened).toBe(0);
      expect((await readAt(setup, 10_001))?.map((row) => row.name)).toEqual(["alpha"]);
    });

    it("starts a new backoff when a real reconnect after the expiry fails", async () => {
      const home = temp("codex-daemon-backoff-again-");
      const setup = clocked(home);
      expect(await readAt(setup, 0)).toBeNull();
      expect(await readAt(setup, 10_001)).toBeNull();
      const fake = fakeDaemon({ home, skills: [skill("alpha")] });
      expect(await readAt(setup, 15_000)).toBeNull();
      expect(fake.connections.opened).toBe(0);
      expect((await readAt(setup, 20_002))?.map((row) => row.name)).toEqual(["alpha"]);
    });
  });

  it("opens no connection and sends nothing when closed or aborted while the socket path is still being checked", async () => {
    const closing = fakeDaemon({ skills: [skill("alpha")] });
    const provider = source(closing.home);
    const pending = provider.rows(pane, "/w", new AbortController().signal);
    provider.close();
    expect(await within(pending, "the answer")).toBeNull();
    expect(await ask(provider)).toBeNull();
    expect(closing.raw).toEqual([]);
    expect(closing.connections.opened).toBe(closing.connections.closed);

    const aborting = fakeDaemon({ skills: [skill("alpha")] });
    const controller = new AbortController();
    const other = source(aborting.home);
    const aborted = other.rows(pane, "/w", controller.signal);
    controller.abort();
    expect(await within(aborted, "the answer")).toBeNull();
    expect(aborting.raw).toEqual([]);
    expect(aborting.connections.opened).toBe(aborting.connections.closed);
  });

  describe("the control socket's location", () => {
    it("rejects a link to an arbitrary place", async () => {
      const elsewhere = temp("codex-daemon-evil-");
      const fake = fakeDaemon({ skills: [skill("alpha")], at: join(elsewhere, "evil.sock") });
      expect(await ask(source(fake.home))).toBeNull();
      expect(fake.raw).toEqual([]);
    });

    it("rejects a control directory that is itself a link", async () => {
      const real = temp("codex-daemon-real-");
      const fake = fakeDaemon({ skills: [skill("alpha")], home: real });
      const home = temp("codex-daemon-redirect-");
      symlinkSync(join(real, "app-server-control"), join(home, "app-server-control"));
      expect(await ask(source(home))).toBeNull();
      expect(fake.raw).toEqual([]);
    });

    const codexShaped = (mode: number, hash?: (advertised: string) => string) => {
      const root = temp("codex-daemon-root-");
      chmodSync(root, mode);
      const home = temp("codex-daemon-home-");
      mkdirSync(join(home, "app-server-control"));
      const advertised = join(realpathSync(join(home, "app-server-control")), "app-server-control.sock");
      const name = hash ? hash(advertised) : createHash("sha256").update(advertised).digest("hex");
      const fake = fakeDaemon({ skills: [skill("alpha")], at: join(root, name), home });
      const provider = createCodexDaemonSource({ codexHome: () => home, daemonRoot: () => root, warn: () => undefined });
      cleanups.push(() => provider.close());
      return { fake, provider };
    };

    it("accepts the rendezvous target the pinned Codex makes: a private directory, the path's hash", async () => {
      const { fake, provider } = codexShaped(0o700);
      expect((await ask(provider))?.map((row) => row.name)).toEqual(["alpha"]);
      expect(fake.methods).toContain("skills/list");
    });

    it("rejects a target in a directory that is not private, or named another way", async () => {
      const open = codexShaped(0o755);
      expect(await ask(open.provider)).toBeNull();
      expect(open.fake.raw).toEqual([]);
      const renamed = codexShaped(0o700, () => "not-the-hash");
      expect(await ask(renamed.provider)).toBeNull();
      expect(renamed.fake.raw).toEqual([]);
    });
  });
});
