import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { HERDR, HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { AcpChildren, AcpStartFailed, AcpUnavailable, type AcpHc } from "./children.ts";
import { KeeperClient } from "./client.ts";
import { FAKE_AGENT, KEEPER_BUILD, keeperBuilt, startKeeper, until } from "./keeper.fake.ts";

describe.skipIf(!keeperBuilt)("AcpChildren with a fake core running the real keeper", () => {
  let fake: FakeHcCore;
  let connection: HcConnection;
  let hc: AcpHc;
  let dir: string;
  let children: AcpChildren;
  let killFailure: Error | undefined;
  /** what the fake core "runs": the keeper, started for real, ended when the core is asked to kill its terminal */
  const programs = new Map<string, Subprocess>();
  const cleanups: (() => Promise<void> | void)[] = [];

  beforeAll(() => serveRuntime(HERDR_CORE));
  afterAll(() => serveRuntime(null));

  function setUp() {
    killFailure = undefined;
    fake = new FakeHcCore();
    fake.onStart = (program) => {
      if (program.argv[0] === KEEPER_BUILD) programs.set(program.address, Bun.spawn([...program.argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
    };
    connection = new HcConnection(() => fake.transport());
    hc = {
      call: (method, params) => {
        if (method === "terminal.kill" && "terminal" in params && typeof params.terminal === "string") {
          if (killFailure !== undefined) return Promise.reject(killFailure);
          programs.get(params.terminal)?.kill("SIGTERM");
        }
        return connection.call(method, params);
      },
    };
    dir = join(mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "acpc-")), "acp");
    children = new AcpChildren(dir, { hc, keeperBin: () => KEEPER_BUILD, sessionMs: 2_000 });
    cleanups.push(async () => {
      children.close();
      for (const program of programs.values()) {
        program.kill("SIGTERM");
        await program.exited;
      }
      programs.clear();
      connection.close();
      rmSync(join(dir, ".."), { recursive: true, force: true });
    });
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  const runs = () => fake.calls().filter((call) => call.method === "terminal.run").map((call) => call.params);
  const kills = () => fake.calls().filter((call) => call.method === "terminal.kill").map((call) => call.params["terminal"]);

  it("runs the keeper in a terminal under its parent, labelled, with the agent's argv untouched, and opens its session", async () => {
    setUp();
    const argv = [FAKE_AGENT, "--no-load", "a b", "$HOME"];
    const child = await children.start({ harness: "fake", argv, cwd: dir, parentPane: "t42", sessionMeta: { model: "m2" }, env: { OVIS_X: "1" } });
    expect(runs()).toEqual([{
      argv: [KEEPER_BUILD, child.root, "--cwd", dir, "--name", "fake", "--session-meta", "{\"model\":\"m2\"}", "--", ...argv],
      cwd: dir, parent: "t42", labels: { "ovis.acp": child.id }, env: { OVIS_X: "1" },
    }]);
    expect(child.root).toBe(join(dir, child.id));
    expect(statSync(child.root).mode & 0o777).toBe(0o700);
    expect(child.client.session).toMatch(/^fake-\d+$/);
    expect(children.forPane(child.terminal)).toBe(child);
    expect(children.forPane("t999")).toBeUndefined();
  });

  /**
   * A loaded runner can read rows the replay holds before the watermark that ends it: holds the watermark back until
   * `seen` holds for the client, and lets it go one event-loop turn later.
   */
  function holdWatermarkUntil(seen: (client: KeeperClient) => boolean) {
    const client = KeeperClient.prototype as unknown as { receive(this: KeeperClient, chunk: string): void };
    const receive = client.receive;
    let pending = "";
    const spy = spyOn(client, "receive").mockImplementation(function (this: KeeperClient, chunk: string) {
      pending += chunk;
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const line = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        if (!("through" in JSON.parse(line))) receive.call(this, line);
        else if (seen(this)) setImmediate(() => receive.call(this, line));
        else {
          const off = this.onChange(() => {
            if (!seen(this)) return;
            off();
            setImmediate(() => receive.call(this, line));
          });
        }
      }
    });
    cleanups.push(() => spy.mockRestore());
  }

  it("hands a child over only once its client has replayed the keeper's log, ready for its first prompt", async () => {
    setUp();
    holdWatermarkUntil(client => client.session !== null);
    const child = await children.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir });
    expect(child.client.connected).toBe(true);
    expect(child.client.status).toBe("idle");
  });

  it("reports a child as opening if it becomes ready while Stop waits for terminal.list", async () => {
    setUp();
    const terminalRan = Promise.withResolvers<void>();
    const finishRun = Promise.withResolvers<void>();
    const terminalsListed = Promise.withResolvers<void>();
    const finishList = Promise.withResolvers<void>();
    children = new AcpChildren(dir, { keeperBin: () => KEEPER_BUILD, hc: { call: async (method, params) => {
      const reply = await hc.call(method, params);
      if (method === "terminal.run") {
        terminalRan.resolve();
        await finishRun.promise;
      }
      if (method === "terminal.list") {
        terminalsListed.resolve();
        await finishList.promise;
      }
      return reply;
    } } });
    const starting = children.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir, parentPane: "t42" });
    const stopping = terminalRan.promise.then(() => children.childrenOf("t42"));
    try {
      await Promise.race([terminalsListed.promise, stopping, starting]);
      finishRun.resolve();
      const child = await starting;
      finishList.resolve();
      const { ready, opening } = await stopping;
      expect({ ready: ready.map(({ terminal }) => terminal), opening }).toEqual({ ready: [], opening: [child.terminal] });
    } finally {
      terminalRan.resolve();
      finishRun.resolve();
      finishList.resolve();
      await Promise.allSettled([starting, stopping]);
    }
  });

  it("fails to start an agent whose exit the replay already showed after its session, and leaves nothing behind", async () => {
    setUp();
    // in a terminal, as hc runs it, the keeper outlives its agent (until Ctrl+Q)
    fake.onStart = (program) => {
      programs.set(program.address, Bun.spawn([...program.argv], { terminal: { cols: 80, rows: 24, data() {} } }));
    };
    // a core slow to answer: the client attaches once the keeper's log already holds the session and the agent's exit
    const exited = async (root: string) => {
      const socket = Promise.withResolvers<void>();
      const watcher = watch(root, () => { if (existsSync(join(root, "acp.sock"))) socket.resolve(); });
      if (existsSync(join(root, "acp.sock"))) socket.resolve();
      await socket.promise;
      watcher.close();
      const observer = new KeeperClient(root);
      await until(observer, "the agent's exit", () => observer.agentGone);
      observer.close();
    };
    children = new AcpChildren(dir, { keeperBin: () => KEEPER_BUILD, sessionMs: 2_000, hc: { call: async (method, params) => {
      const reply = await hc.call(method, params);
      const root = method === "terminal.run" && "argv" in params ? params.argv?.[1] : undefined;
      if (root !== undefined) await exited(root);
      return reply;
    } } });
    const started = children.start({ harness: "fake", argv: [FAKE_AGENT, "--exit-after-session"], cwd: dir });
    expect(await started.catch((error: unknown) => error)).toMatchObject({ reason: "agent_exited" });
    const id = (runs()[0]!["labels"] as Record<string, string>)["ovis.acp"]!;
    expect(kills()).toHaveLength(1);
    expect(existsSync(join(dir, id))).toBe(false);
  });

  it("tells its listeners when a person holds a child and hands it back, and finds it under its parent", async () => {
    setUp();
    const child = await children.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir, parentPane: "t42" });
    const seen: (number | null)[] = [];
    const off = children.onStatus((changed) => { if (changed === child) seen.push(changed.client.holdGeneration); });
    try {
      const generation = await child.client.hold(child.client.session!);
      await until(child.client, "the hold", () => child.client.holdGeneration === generation);
      expect(seen).toContain(generation);
      await child.client.request("_keeper/release", { sessionId: child.client.session, generation });
      await until(child.client, "the release", () => child.client.holdGeneration === null);
      expect(seen.at(-1)).toBeNull();
      expect((await children.childrenOf("t42")).ready.map((found) => found.id)).toEqual([child.id]);
    } finally {
      off();
    }
  });

  it("starts with no parent when none is given, never under the server's own terminal", async () => {
    setUp();
    await children.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir });
    expect(runs()[0]).toMatchObject({ no_parent: true });
    expect(runs()[0]).not.toHaveProperty("parent");
  });

  it("opens a tool child under its caller with its MCP server and without a mode override", async () => {
    setUp();
    const server = { name: "ovis-agent", command: "/test/relay", args: ["--token-file", "/test/token"], env: [] };
    const child = await children.start({ harness: "gjc", argv: [FAKE_AGENT], cwd: dir, parentPane: "t42", runId: "run", mcpServers: [server] });
    const log = await Bun.file(join(child.root, "archive.jsonl")).text();
    const messages = log.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.dir === "to-agent").map(row => JSON.parse(row.raw));
    expect(messages.find(m => m.method === "initialize")?.params.clientCapabilities.elicitation).toEqual({ form: {} });
    expect(messages.find(m => m.method === "session/new")?.params).toEqual({ cwd: dir, mcpServers: [server] });
    expect(runs()[0]).toMatchObject({ parent: "t42", labels: { "ovis.run": "run" } });
  });
  it("sends a launch's session options and _meta on session/new", async () => {
    setUp();
    const configOptions = [{ configId: "mode", value: "default" }], sessionMeta = { claudeCode: { options: { settingSources: [] } } };
    const child = await children.start({ harness: "claude", argv: [FAKE_AGENT], cwd: dir, configOptions, sessionMeta });
    const log = await Bun.file(join(child.root, "archive.jsonl")).text();
    const messages = log.trim().split("\n").map(line => JSON.parse(line)).filter(row => row.dir === "to-agent").map(row => JSON.parse(row.raw));
    expect(messages.find(m => m.method === "session/new")?.params).toEqual({ cwd: dir, mcpServers: [], _meta: sessionMeta, configOptions });
  });
  it("offers no reusable approval for a delegated child", async () => {
    setUp();
    const child = await children.start({ harness:"fixture", argv:[FAKE_AGENT], cwd:dir, askEveryTime:true });
    await child.client.submit("widen");
    await until(child.client, "approval", () => child.client.pending().length === 1);
    const [card] = child.client.pending();
    if (!card) throw new Error("No card");
    expect(card.options.map(o=>o.kind)).toEqual(["allow_once","reject_once"]);
  });

  for (const lookup of ["available", "unavailable"]) {
    it(`reconciles a lost launch reply with terminal lookup ${lookup}`, async () => {
      setUp();
      fake.onStart = () => {};
      const unrelated = fake.spawn({ argv: ["example"], labels: { "ovis.acp": "unrelated" } }).address;
      const lost = new Error("launch reply lost");
      const flaky: AcpHc = { call: async (method, params) => {
        if (method === "terminal.list" && lookup === "unavailable") throw new Error("core offline");
        const reply = await hc.call(method, params);
        if (method === "terminal.run") throw lost;
        return reply;
      } };
      children = new AcpChildren(dir, { hc: flaky, keeperBin: () => KEEPER_BUILD });
      expect(await children.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir }).catch((error: unknown) => error)).toBe(lost);
      expect(fake.terminal(unrelated).state).toBe("live");
      if (lookup === "available") {
        expect(kills()).toHaveLength(1);
        expect(readdirSync(dir)).toEqual([]);
      } else {
        expect(kills()).toEqual([]);
        const [id] = readdirSync(dir);
        expect(id && existsSync(join(dir, id, "child.json"))).toBe(true);
      }
    });
  }

  it("fails to start an agent that never answers initialize: its terminal is killed and its ROOT removed", async () => {
    setUp();
    const started = children.start({ harness: "mute", argv: ["sleep", "600"], cwd: dir });
    expect(await started.catch((error: unknown) => error)).toBeInstanceOf(AcpStartFailed);
    const [run] = runs();
    const id = (run!["labels"] as Record<string, string>)["ovis.acp"]!;
    const terminal = fake.calls().find((call) => call.method === "terminal.kill")?.params["terminal"];
    expect(terminal).toBeString();
    expect(fake.terminal(terminal as string).state).not.toBe("live");
    expect(existsSync(join(dir, id))).toBe(false);
    expect(children.forPane(terminal as string)).toBeUndefined();
  });

  it("reports a session refusal from the adapter instead of waiting for the handshake deadline", async () => {
    setUp();
    const err = await children.start({ harness: "test", cwd: dir, argv: [FAKE_AGENT, "--refuse-session", "-32000"] }).catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: "refused", agentCode: -32000 });
    expect(kills()).toHaveLength(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("stops a child: its terminal is killed, its ROOT removed, and it is forgotten", async () => {
    setUp();
    const child = await children.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir });
    void child.client.request("session/prompt", { sessionId: child.client.session, prompt: [{ type: "text", text: "hold" }] }).catch(() => undefined);
    await until(child.client, "the running turn", () => child.client.turn?.running === true);
    const program = programs.get(child.terminal)!;
    await children.stop(child.id);
    expect(kills()).toEqual([child.terminal]);
    expect(existsSync(child.root)).toBe(false);
    expect(children.forPane(child.terminal)).toBeUndefined();
    expect(await program.exited).toBe(0);
  });

  it("can retry stopping a child when the core refuses the first kill", async () => {
    setUp();
    const child = await children.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir });
    const failure = new Error("core offline");
    killFailure = failure;
    await expect(children.stop(child.id)).rejects.toBe(failure);
    expect(fake.terminal(child.terminal).state).toBe("live");
    expect(children.forPane(child.terminal)).toBe(child);
    expect(existsSync(child.root)).toBe(true);

    killFailure = undefined;
    await children.stop(child.id);
    expect(fake.terminal(child.terminal).state).not.toBe("live");
    expect(children.forPane(child.terminal)).toBeUndefined();
    expect(existsSync(child.root)).toBe(false);
  });

  it("refuses to start anywhere but this PC's herdr-core", async () => {
    setUp();
    serveRuntime(HERDR);
    try {
      expect(await children.start({ harness: "fake", argv: [FAKE_AGENT], cwd: dir }).catch((error: unknown) => error)).toBeInstanceOf(AcpUnavailable);
    } finally {
      serveRuntime(HERDR_CORE);
    }
    expect(runs()).toEqual([]);
  });

  it("does not consult the core for a linked ACP state directory", async () => {
    setUp();
    const empty = join(dir, "..", "empty");
    mkdirSync(empty);
    symlinkSync(empty, dir, "dir");
    await children.restore();
    expect(fake.calls().filter((call) => call.method === "terminal.list")).toEqual([]);
  });

  it("restores at the server's start: re-attaches its labelled live terminals, deletes only stale ROOTs", async () => {
    setUp();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const made = (id: string) => {
      mkdirSync(join(dir, id), { mode: 0o700 });
      return join(dir, id);
    };
    // a child of an earlier run: its keeper still runs in its terminal
    const live = made("aaaaaaaaaaaa");
    writeFileSync(join(live, "child.json"), JSON.stringify({ harness: "fake" }));
    const keeper = await startKeeper(live);
    cleanups.push(keeper.stop);
    const terminal = fake.spawn({ argv: [KEEPER_BUILD, live], labels: { "ovis.acp": "aaaaaaaaaaaa" } }).address;
    // a ROOT whose keeper is dead and whose terminal is gone
    const dead = Bun.spawn(["true"]);
    await dead.exited;
    writeFileSync(join(made("bbbbbbbbbbbb"), "process.json"), JSON.stringify({ keeper: dead.pid }));
    writeFileSync(join(dir, "bbbbbbbbbbbb", "child.json"), JSON.stringify({ harness: "fake" }));
    const unmarked = made("eeeeeeeeeeee");
    const ambiguous = made("111111111111");
    writeFileSync(join(ambiguous, "child.json"), JSON.stringify({ harness: "fake" }));
    const duplicates = [1, 2].map(() => fake.spawn({ argv: ["example"], labels: { "ovis.acp": "111111111111" } }).address);
    // a ROOT with no terminal whose keeper still runs: not touched
    writeFileSync(join(made("cccccccccccc"), "process.json"), JSON.stringify({ keeper: process.pid }));
    writeFileSync(join(dir, "cccccccccccc", "child.json"), JSON.stringify({ harness: "fake" }));
    // another server's child on the same core: not this server's ROOT, never touched
    const foreign = fake.spawn({ argv: ["sh"], labels: { "ovis.acp": "dddddddddddd" } }).address;

    await children.restore();
    expect(duplicates.map(address => children.forPane(address)?.terminal)).toEqual([undefined, undefined]);
    expect(existsSync(ambiguous)).toBe(true);
    const restored = children.forPane(terminal);
    expect(restored).toMatchObject({ id: "aaaaaaaaaaaa", harness: "fake", root: live, terminal });
    await until(restored!.client, "the session from the replay", () => restored!.client.session !== null);
    expect(existsSync(join(dir, "bbbbbbbbbbbb"))).toBe(false);
    expect(existsSync(join(dir, "cccccccccccc"))).toBe(true);
    expect(existsSync(unmarked)).toBe(true);
    expect(children.forPane(foreign)).toBeUndefined();
    expect(fake.terminal(foreign).state).toBe("live");
    expect(kills()).toEqual([]);
  });
});

describe("AcpChildren without a keeper", () => {
  beforeAll(() => serveRuntime(HERDR_CORE));
  afterAll(() => serveRuntime(null));

  it("refuses to start when no keeper binary is found, before anything runs", async () => {
    const fake = new FakeHcCore();
    const connection = new HcConnection(() => fake.transport());
    const dir = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "acpc-"));
    try {
      const children = new AcpChildren(join(dir, "acp"), { hc: connection, keeperBin: () => null });
      expect(await children.start({ harness: "fake", argv: ["x"], cwd: dir }).catch((error: unknown) => error)).toBeInstanceOf(AcpUnavailable);
      expect(fake.calls().filter((call) => call.method === "terminal.run")).toEqual([]);
    } finally {
      connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("finds the children a pane started among its own, by the core's parent", async () => {
    const fake = new FakeHcCore();
    const connection = new HcConnection(() => fake.transport());
    const dir = mkdtempSync(join(process.env["TMPDIR"] || tmpdir(), "acpc-"));
    const children = new AcpChildren(join(dir, "acp"), { hc: connection, keeperBin: () => null });
    const own = (id: string, parent: string) => {
      mkdirSync(join(dir, "acp", id), { recursive: true, mode: 0o700 });
      writeFileSync(join(dir, "acp", id, "child.json"), JSON.stringify({ harness: "opencode" }));
      return fake.spawn({ argv: ["keeper"], labels: { "ovis.acp": id }, parent }).address;
    };
    try {
      const first = own("aaaaaaaaaaaa", "t1");
      const second = own("bbbbbbbbbbbb", "t1");
      own("cccccccccccc", "t2");
      fake.spawn({ argv: ["sh"], labels: { "ovis.acp": "dddddddddddd" }, parent: "t1" });
      await children.restore();
      expect((await children.childrenOf("t1")).ready.map((child) => child.terminal).sort()).toEqual([first, second].sort());
      expect(await children.childrenOf("t9")).toEqual({ ready: [], opening: [] });
    } finally {
      children.close();
      connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
