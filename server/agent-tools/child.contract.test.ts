import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CONTRACT, isRecord } from "../../shared/harness-tool.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { AcpChildren, type AcpHc } from "../acp/children.ts";
import { KEEPER_BUILD, keeperBuilt, until } from "../acp/keeper.fake.ts";
import { lineCall } from "../line-call.ts";
import { AgentToolHub } from "./hub.ts";

const REPLAY = join(import.meta.dir, "replay-agent.fake.ts");
interface Recorded { harness: string; fixture: string; version: string; mode: string; kinds: readonly string[]; opened?: (sessionNew: Record<string, any>) => void }
const claudeOpened = (sessionNew: Record<string, any>) => {
  expect(sessionNew.configOptions).toEqual([{ configId: "mode", value: "default" }]);
  expect(sessionNew._meta.claudeCode.options).toMatchObject({ settingSources: [], allowDangerouslySkipPermissions: false, tools: expect.not.arrayContaining(["EnterWorktree", "Agent", "Skill"]),
    settings: { disableAllHooks: true, permissions: { defaultMode: "default", ask: expect.arrayContaining(["Write", "Edit", "Bash", "WebFetch", "WebSearch", "mcp__ovis-agent"]) } } });
};
/** Real adapters' side of a child of a parent whose permissions Ovis cannot prove, each in its recipe's launch.
 * `-ask`: no allow rule of the person's, so the write, mkdir, web request and MCP call each came as a card.
 * `-own-rule`: a rule the person set in the harness let some through unasked; the rest still came as cards. */
const RECORDED: readonly Recorded[] = [
  ...["0.110.0", "0.112.0"].map(adapter => ({ harness: "claude", fixture: `claude-agent-acp-${adapter}-ask`, version: "2.1.330 (Claude Code)", mode: "default", kinds: ["edit", "execute", "execute", "fetch", "fetch", "other"], opened: claudeOpened })),
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
];

describe.skipIf(!keeperBuilt).each([...RECORDED])("a $harness child replaying $fixture", ({ harness, fixture, version, mode, kinds, opened }) => {
  const FIXTURE = join(import.meta.dir, "fixtures", `${fixture}.jsonl`);
  const requests = readFileSync(FIXTURE, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, any>)
    .filter(message => message.method === "session/request_permission");
  const asked = requests.map(message => String(message.params.toolCall.toolCallId));
  it("was recorded with a card for each action its run had to ask about", () => {
    expect(requests.map(message => message.params.toolCall.kind)).toEqual([...kinds]);
  });
  let dir: string, hub: AgentToolHub, acp: AcpChildren, token: string, connection: HcConnection;
  const programs = new Map<string, ReturnType<typeof Bun.spawn>>();
  beforeEach(() => {
    serveRuntime(HERDR_CORE);
    dir = mkdtempSync(join(tmpdir(), "cc-"));
    writeFileSync(join(dir, "version"), `${version}\n`);
    // the harness's own program: it answers `--version` and otherwise plays the recorded adapter
    const program = join(dir, harness);
    writeFileSync(program, `#!/bin/sh\n[ "$1" = --version ] && exec cat "${join(dir, "version")}"\nexec "${process.execPath}" "${REPLAY}" "${FIXTURE}" "${join(dir, "replay.jsonl")}"\n`);
    chmodSync(program, 0o755);
    const fake = new FakeHcCore();
    fake.onStart = started => { programs.set(started.address, Bun.spawn([...started.argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })); };
    connection = new HcConnection(() => fake.transport());
    const hc: AcpHc = { call: (method, params) => {
      if (method === "terminal.kill" && "terminal" in params && typeof params.terminal === "string") programs.get(params.terminal)?.kill();
      return connection.call(method, params);
    } };
    acp = new AcpChildren(join(dir, "acp"), { hc, keeperBin: () => KEEPER_BUILD, sessionMs: 5000 });
    hub = new AgentToolHub({ dir: join(dir, "tools"), acp, setting: () => ({ level: "start", depth: 1, harnesses: [harness] }),
      resolve: kind => kind === harness ? { argv: [program], env: { CLAUDE_CODE_EXECUTABLE: program, CODEX_PATH: program } } : null });
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

  it("opens in the recipe's mode, brings every recorded card to a person with one-time choices only, and keeps asking on the next send", async () => {
    const started = await call("start", { harness, cwd: dir, task: "do the actions" });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
    const session = started.session.address;
    opened?.(replayed()[0]!.sessionNew);
    expect(acp.forPane(session)?.client.sessionMode).toBe(mode);
    await rejectEveryCard(session);
    expect(await call("send", { session, task: "again" })).toMatchObject({ accepted: true });
    await rejectEveryCard(session);
    expect(acp.forPane(session)?.client.sessionMode).toBe(mode);
    expect(replayed().slice(1).map(row => [row.answered, row.answer.outcome.optionId])).toEqual([...asked, ...asked].map(id => [id, rejectOf(id)]));
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
    expect(replayed().filter(row => row.answered)).toEqual([]);
  });

  it("never hands the child a slash command as a task, which could change its permissions unasked", async () => {
    // Copilot 1.0.109 turns every card off on a prompt of `/allow-all` and keeps reporting the same mode
    const started = await call("start", { harness, cwd: dir });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
    const session = started.session.address;
    expect(await call("send", { session, task: "/allow-all" })).toMatchObject({ error: { code: "bad_request" } });
    expect(await call("send", { session, task: "  /permissions" })).toMatchObject({ error: { code: "bad_request" } });
    expect(await call("start", { harness, cwd: dir, task: "/allow-all" })).toMatchObject({ error: { code: "bad_request" } });
    expect(replayed().filter(row => row.answered)).toEqual([]);
  });

  it("refuses a version its launch was not run against, and starts nothing", async () => {
    writeFileSync(join(dir, "version"), version.replace(/\d+(?=\D*$)/, (n: string) => String(Number(n) + 1)));
    expect(await call("start", { harness, cwd: dir })).toMatchObject({ error: { code: "not_granted" } });
    expect(programs.size).toBe(0);
  });
});
