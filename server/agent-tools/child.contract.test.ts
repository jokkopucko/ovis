import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CONTRACT, isRecord } from "../../shared/harness-tool.ts";
import { AGENT_CATALOG } from "../../shared/agent-catalog.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { AcpChildren, type AcpHc } from "../acp/children.ts";
import { KEEPER_BUILD, keeperBuilt, until } from "../acp/keeper.fake.ts";
import { lineCall } from "../line-call.ts";
import { AgentToolHub } from "./hub.ts";
import { resolveHarness } from "./harnesses.ts";

const REPLAY = join(import.meta.dir, "replay-agent.fake.ts");
interface Recorded { readonly harness: string; readonly fixture: string; readonly version: string; readonly mode: string; readonly kinds: readonly (string | null)[] }
/** Historical permission traces: verify the keeper shows what the adapter asks, regardless of its mode or settings.
 * These capture the earlier launch recipes, not what a default-mode launch will ask today. */
const RECORDED: readonly Recorded[] = [
  ...["0.110.0", "0.112.0"].map(adapter => ({ harness: "claude", fixture: `claude-agent-acp-${adapter}-ask`, version: "2.1.330 (Claude Code)", mode: "default", kinds: ["edit", "execute", "execute", "fetch", "fetch", "other"] })),
  ...["2.10.0", "2.11.0"].flatMap(adapter => ["ask", "own-rule"].map(run => ({ harness: "codex", fixture: `codex-acp-${adapter}-${run}`, version: "codex-cli 0.171.0", mode: "read-only",
    // the edit, mkdir, curl and MCP call; the rules allowing mkdir and curl leave the edit and the MCP call
    kinds: run === "ask" ? ["edit", "execute", "execute", "execute"] : ["edit", "execute"] }))),
  ...["ask", "own-rule"].map(run => ({ harness: "copilot", fixture: `copilot-1.0.109-${run}`, version: "GitHub Copilot CLI 1.0.109.\nRun 'copilot update' to check for updates.", mode: "https://agentclientprotocol.com/protocol/session-modes#agent",
    // the fetch, MCP call, mkdir and file write; the folder's hook allowing the write leaves the other three
    kinds: run === "ask" ? ["fetch", "other", "execute", "edit"] : ["fetch", "other", "execute"] })),
  // one recorded session per action, as agy ends a turn at the first rejection; its web search never asks, so none is
  // here. With the workspace hook allowing the write, the same prompt's mkdir and MCP call still came as cards
  ...([["ask-write", "edit"], ["ask-mkdir", "execute"], ["ask-mcp", "other"], ["own-rule-mkdir", "execute"], ["own-rule-mcp", "other"]] as const)
    .map(([run, kind]) => ({ harness: "agy", fixture: `agy-1.5.16-${run}`, version: "1.5.16", mode: "default", kinds: [kind] })),
  ...([["ask-write", "edit"], ["ask-mkdir", "execute"]] as const)
    .map(([run, kind]) => ({ harness: "gemini", fixture: `gemini-0.71.1-${run}`, version: "0.71.1", mode: "default", kinds: [kind] })),
  // Kiro's V3 engine names no kind on the request itself, only on the tool call it announced before it
  ...["ask-write", "ask-mkdir"].map(run => ({ harness: "kiro", fixture: `kiro-3.6.2-${run}`, version: "kiro-cli 3.6.2", mode: "vibe", kinds: [null] })),
  // as Kiro's, Kimi Code's request names no kind; the tool call it announced before it does
  ...["ask-write", "ask-mkdir"].map(run => ({ harness: "kimi", fixture: `kimi-2.8.1-${run}`, version: "2.8.1", mode: "default", kinds: [null] })),
  ...([["ask-write", "edit"], ["ask-mkdir", "execute"]] as const)
    .map(([run, kind]) => ({ harness: "qwen", fixture: `qwen-0.28.7-${run}`, version: "0.28.7", mode: "default", kinds: [kind] })),
];

describe.skipIf(!keeperBuilt).each([...RECORDED])("a $harness child replaying $fixture", ({ harness, fixture, version, mode, kinds }) => {
  const FIXTURE = join(import.meta.dir, "fixtures", `${fixture}.jsonl`);
  const requests = readFileSync(FIXTURE, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>)
    .filter(message => message.method === "session/request_permission");
  const asked = requests.map(message => String(message.params.toolCall.toolCallId));
  it("was recorded with a card for each action its run had to ask about", () => {
    expect(requests.map(message => message.params.toolCall.kind ?? null)).toEqual([...kinds]);
  });
  let dir: string, hub: AgentToolHub, acp: AcpChildren, token: string, connection: HcConnection;
  const programs = new Map<string, ReturnType<typeof Bun.spawn>>();
  beforeEach(() => {
    serveRuntime(HERDR_CORE);
    dir = mkdtempSync(join(tmpdir(), "cc-"));
    writeFileSync(join(dir, "version"), `${version}\n`);
    writeFileSync(join(dir, "scenario.json"), "{}");
    // the harness's own program: it answers `--version` and otherwise plays the recorded adapter
    const program = join(dir, AGENT_CATALOG.find(entry => entry.id === harness)!.detect.binaries[0]!);
    writeFileSync(program, `#!/bin/sh
if [ "$1" = --version ]; then
  if [ -f "${join(dir, "require-version-context")}" ]; then
    [ "$PWD" = "${dir}" ] && [ "$VERSION_CONTEXT" = "child" ] && [ "$CORE_VERSION_CONTEXT" = "core" ] || exit 1
  fi
  exec cat "${join(dir, "version")}"
fi
exec "${process.execPath}" "${REPLAY}" "${FIXTURE}" "${join(dir, "replay.jsonl")}" "${join(dir, "scenario.json")}"
`);
    chmodSync(program, 0o755);
    if (harness === "claude" || harness === "codex") symlinkSync(program, join(dir, harness === "claude" ? "claude-agent-acp" : "codex-acp"));
    const coreEnv = { ...process.env, CORE_VERSION_CONTEXT: "core" };
    const fake = new FakeHcCore({ exec: ({ argv, cwd, env }) => {
      if (argv?.[0] !== program || argv[1] !== "--version") throw new Error("Unexpected core exec");
      const probed = Bun.spawnSync(argv, { cwd: cwd ?? undefined, env: { ...coreEnv, ...env }, stdin: "ignore", stderr: "ignore", timeout: 500 });
      return { code: probed.exitCode, stdout: Buffer.from(probed.stdout).toString("base64"), stderr: "", ms: 0, timed_out: false, truncated: false };
    } });
    let paneEnv = coreEnv;
    fake.onStart = started => { programs.set(started.address, Bun.spawn([...started.argv], { cwd: dir, env: paneEnv, stdin: "ignore", stdout: "ignore", stderr: "ignore" })); };
    connection = new HcConnection(() => fake.transport());
    const hc: AcpHc = { call: (method, params) => {
      if (method === "terminal.kill" && "terminal" in params && typeof params.terminal === "string") programs.get(params.terminal)?.kill();
      if (method === "terminal.run" && "env" in params) paneEnv = { ...coreEnv, ...params.env };
      return connection.call(method, params);
    } };
    acp = new AcpChildren(join(dir, "acp"), { hc, keeperBin: () => KEEPER_BUILD, sessionMs: 5000 });
    hub = new AgentToolHub({ dir: join(dir, "tools"), acp, setting: () => ({ level: "start", depth: 1, harnesses: [harness] }),
      resolve: kind => {
        if (kind !== harness) return null;
        const path = process.env.PATH;
        process.env.PATH = dir;
        try {
          const command = resolveHarness(kind);
          return command && { ...command, env: { ...command.env, VERSION_CONTEXT: "child" } };
        } finally {
          if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
        }
      } });
    hub.listen();
    const parent = hub.runs.reserve();
    parent.bind({ self: "top", harness: "claude", depth: 0, root: parent.id, started_by: null });
    token = readFileSync(parent.tokenFile, "utf8");
  });
  afterEach(async () => {
    hub.close(); acp.close();
    for (const proc of programs.values()) { proc.kill(); await proc.exited; }
    programs.clear(); connection.close(); serveRuntime(null); rmSync(dir, { recursive: true, force: true });
  });
  async function call(verb: string, args: object) {
    const value = await lineCall(hub.address, { id: 1, contract: HARNESS_CONTRACT, token, verb, args }, 10_000);
    if (!isRecord(value)) throw new Error("invalid answer");
    return value;
  }
  const rejectOf = (id: string) => requests.find(message => message.params.toolCall.toolCallId === id)!.params.options.find((option: { kind: string }) => option.kind === "reject_once").optionId;
  const replayed = () => readFileSync(join(dir, "replay.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>);
  const scenario = (options: {
    readonly startMode?: string; readonly openingAllowAll?: "on" | "off";
    readonly updatedMode?: string; readonly updatedAllowAll?: "on" | "off"; readonly refuseSetMode?: boolean;
  }) => writeFileSync(join(dir, "scenario.json"), JSON.stringify(options));
  async function rejectEveryCard(session: string) {
    const child = acp.forPane(session)!;
    for (const toolCall of asked) {
      expect(await call("wait", { session, timeout_s: 5 })).toMatchObject({ state: { state: "waiting_human" } });
      const card = child.client.pending()[0]!;
      expect(card.options.map(option => option.kind)).toEqual(["allow_once", "reject_once"]);
      expect(JSON.stringify(card)).toContain(toolCall);
      expect(await child.client.answer(card.keeperId, card.options.find(option => option.kind === "reject_once")!.optionId)).toBe("won");
    }
    expect(await call("wait", { session, timeout_s: 5 })).toMatchObject({ state: { state: "done" } });
  }

  it("accepts the mode reported at start and routes every recorded card to a person with one-time choices", async () => {
    const started = await call("start", { harness, cwd: dir, task: "do the actions" });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
    const session = started.session.address;
    if (harness === "claude") {
      expect(replayed()[0]?.sessionNew).toMatchObject({
        configOptions: [{ configId: "mode", value: "default" }],
        _meta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } },
      });
    } else expect(replayed()[0]?.sessionNew).not.toHaveProperty("configOptions");
    // Kimi Code reports `default` whatever mode the person saved: the child sets it before its first task
    if (harness === "kimi") expect(replayed().slice(1, 3)).toEqual([{ setMode: "default" }, { prompt: expect.stringContaining("do the actions") }]);
    else expect(replayed().some(row => "setMode" in row)).toBe(false);
    expect(started.session.version).toBe(version.match(/\d+\.\d+\.\d+/)?.[0]);
    expect(acp.forPane(session)?.client.sessionMode).toBe(mode);
    await rejectEveryCard(session);
    expect(await call("send", { session, task: "again" })).toMatchObject({ accepted: true });
    await rejectEveryCard(session);
    expect(acp.forPane(session)?.client.sessionMode).toBe(mode);
    expect(replayed().filter(row => row.answered).map(row => [row.answered, row.answer.outcome.optionId])).toEqual([...asked, ...asked].map(id => [id, rejectOf(id)]));
  });

  it("takes no new task once the child reports a wider mode", async () => {
    const started = await call("start", { harness, cwd: dir });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
    const session = started.session.address;
    expect(await call("send", { session, task: "widen" })).toMatchObject({ accepted: true });
    const child = acp.forPane(session)!;
    await until(child.client, "the wider mode", () => child.client.sessionMode === "acceptEdits");
    expect(await call("wait", { session, timeout_s: 5 })).toMatchObject({ state: { state: "done" } });
    expect(await call("send", { session, task: "do the actions" })).toMatchObject({ error: { code: "not_granted" } });
    expect(replayed().filter(row => row.prompt)).toEqual([expect.objectContaining({ prompt: expect.stringContaining("widen") })]);
  });

  it("never hands the child a slash command as a task, which could change its permissions unasked", async () => {
    // Copilot 1.0.109 turns every card off on a prompt of `/allow-all` and keeps reporting the same mode
    const started = await call("start", { harness, cwd: dir });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
    const session = started.session.address;
    expect(await call("send", { session, task: "/allow-all" })).toMatchObject({ error: { code: "bad_request" } });
    expect(await call("send", { session, task: "  /permissions" })).toMatchObject({ error: { code: "bad_request" } });
    expect(await call("start", { harness, cwd: dir, task: "/allow-all" })).toMatchObject({ error: { code: "bad_request" } });
    expect(replayed().filter(row => row.prompt)).toEqual([]);
  });

  it("opens and reports an unrecognized version", async () => {
    writeFileSync(join(dir, "version"), version.replace(/\d+\.\d+\.\d+/, "99.1.2"));
    const defaultMode = harness === "codex" ? "agent" : mode;
    scenario({ startMode: defaultMode });
    const started = await call("start", { harness, cwd: dir });
    expect(started).toMatchObject({ kind: "session", session: { version: "99.1.2" } });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error("No child address");
    expect(acp.forPane(started.session.address)?.client.sessionMode).toBe(defaultMode);
  });

  const elevatedModes = new Map<string, readonly string[]>([
    ["claude-agent-acp-0.110.0-ask", ["auto", "acceptEdits", "bypassPermissions"]],
    ["agy-1.5.16-ask-write", ["auto", "accept-edits"]],
    ["codex-acp-2.10.0-ask", ["agent-full-access"]],
    ["copilot-1.0.109-ask", ["https://agentclientprotocol.com/protocol/session-modes#autopilot"]],
    ["gemini-0.71.1-ask-write", ["autoEdit", "yolo"]],
    ["kiro-3.6.2-ask-write", ["autonomous"]],
    ["kimi-2.8.1-ask-write", ["auto", "yolo"]],
    ["qwen-0.28.7-ask-write", ["auto-edit", "auto", "yolo"]],
  ]).get(fixture);
  if (elevatedModes) {
    it.each([...elevatedModes])("stops a child in wider mode %s before sending its initial task", async (startMode) => {
      scenario({ startMode });
      expect(await call("start", { harness, cwd: dir, task: "do the actions" })).toMatchObject({ kind: "refusal", error: { code: "not_granted" } });
      expect((await acp.terminals()).filter(row => row.state === "live")).toHaveLength(0);
      expect(replayed().filter(row => !("setMode" in row))).toEqual([expect.objectContaining({ sessionNew: expect.any(Object) })]);
    });
  }

  if (fixture === "kimi-2.8.1-ask-write") {
    // Kimi Code reports `default` whatever mode the person saved, so only the mode it is set to proves the start
    it("does not start a child whose mode it could not set", async () => {
      scenario({ refuseSetMode: true });
      expect(await call("start", { harness, cwd: dir, task: "do the actions" })).toMatchObject({ kind: "refusal", error: { code: "not_granted" } });
      expect((await acp.terminals()).filter(row => row.state === "live")).toHaveLength(0);
      expect(replayed().some(row => "prompt" in row)).toBe(false);
    });
  }

  if (fixture === "claude-agent-acp-0.110.0-ask" || fixture === "copilot-1.0.109-ask") {
    it("stops a child that widens between opening and registration", async () => {
      scenario(harness === "claude" ? { updatedMode: "acceptEdits" } : { openingAllowAll: "off", updatedAllowAll: "on" });
      const start = acp.start.bind(acp);
      const wrapped = spyOn(acp, "start").mockImplementation(async options => {
        const child = await start(options);
        await child.client.request("fixture/barrier", {});
        return child;
      });
      try {
        expect(await call("start", { harness, cwd: dir })).toMatchObject({ kind: "refusal", error: { code: "not_granted" } });
        expect((await acp.terminals()).filter(row => row.state === "live")).toHaveLength(0);
      } finally { wrapped.mockRestore(); }
    });
  }

  if (fixture === "copilot-1.0.109-ask") {
    it("lets the parent retry the same start key after a refused child is stopped", async () => {
      const args = { harness, cwd: dir, key: "retry-start" };
      scenario({ openingAllowAll: "on" });
      expect(await call("start", args)).toMatchObject({ kind: "refusal", error: { code: "not_granted" } });
      expect((await acp.terminals()).filter(row => row.state === "live")).toHaveLength(0);

      scenario({ openingAllowAll: "off" });
      const started = await call("start", args);

      expect(started).toMatchObject({ kind: "session" });
      expect(await call("start", args)).toMatchObject(started);
    });

    it("stops Copilot whose Allow All selector is on even in Agent mode", async () => {
      scenario({ openingAllowAll: "on" });
      expect(await call("start", { harness, cwd: dir })).toMatchObject({ kind: "refusal", error: { code: "not_granted" } });
      expect((await acp.terminals()).filter(row => row.state === "live")).toHaveLength(0);
    });

    it("refuses delegated prompts when only Copilot's Allow All selector changes", async () => {
      scenario({ openingAllowAll: "off" });
      const started = await call("start", { harness, cwd: dir, task: "enable allow all" });
      if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
      const session = started.session.address;
      expect(await call("wait", { session, timeout_s: 5 })).toMatchObject({ state: { state: "done" } });
      const child = acp.forPane(session);
      if (!child) throw new Error("missing child");
      expect(child.client.sessionMode).toBe(mode);
      // Even a client behind on the keeper's update must not get its prompt through.
      await expect(child.client.submit("do the actions", mode)).rejects.toMatchObject({ code: -32004 });
      expect(await call("send", { session, task: "do the actions" })).toMatchObject({ error: { code: "not_granted" } });
      expect(replayed().filter(row => row.prompt)).toHaveLength(1);
    });

    it("reports the full prerelease version read in the child's folder and core environment", async () => {
      writeFileSync(join(dir, "require-version-context"), "");
      writeFileSync(join(dir, "version"), "GitHub Copilot CLI 99.1.2-alpha.10.2.\n");
      expect(await call("start", { harness, cwd: dir })).toMatchObject({ session: { version: "99.1.2-alpha.10.2" } });
    });
  }
});
