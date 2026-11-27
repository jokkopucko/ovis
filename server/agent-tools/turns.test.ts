import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CONTRACT, isRecord } from "../../shared/harness-tool.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { AcpChildren, type AcpHc } from "../acp/children.ts";
import { FAKE_AGENT, KEEPER_BUILD, keeperBuilt, until } from "../acp/keeper.fake.ts";
import { lineCall } from "../line-call.ts";
import { AgentToolHub } from "./hub.ts";
import { KeeperClient, KeeperRequestError } from "../acp/client.ts";
import { acpPrompt, answerAcpPrompt } from "../approvals/acp.ts";

describe.skipIf(!keeperBuilt)("the agent tool through its socket and real keepers", () => {
  let dir: string, hub: AgentToolHub, acp: AcpChildren, token: string, connection: HcConnection, hc: AcpHc, now: number;
  const programs = new Map<string, ReturnType<typeof Bun.spawn>>();
  const open = () => {
    acp = new AcpChildren(join(dir, "acp"), { hc, keeperBin: () => KEEPER_BUILD, sessionMs: 1500 });
    hub = new AgentToolHub({ dir: join(dir, "tools"), acp, now: () => now, setting: () => ({ level: "start", depth: 2, harnesses: ["test", "mute", "opencode"] }),
      resolve: kind => ({ argv: kind === "mute" ? ["/bin/sleep", "600"] : [FAKE_AGENT] }) });
    hub.listen();
  };
  beforeEach(() => {
    now = Date.now();
    serveRuntime(HERDR_CORE);
    dir = mkdtempSync(join(tmpdir(), "at-"));
    const fake = new FakeHcCore();
    fake.onStart = program => { programs.set(program.address, Bun.spawn([...program.argv], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })); };
    connection = new HcConnection(() => fake.transport());
    hc = { call: (method, params) => {
      if (method === "terminal.kill" && "terminal" in params && typeof params.terminal === "string") programs.get(params.terminal)?.kill();
      return connection.call(method, params);
    } };
    open();
    const root = hub.runs.reserve();
    root.bind({ self: "top", harness: "fixture-parent", depth: 0, root: root.id, started_by: null });
    token = readFileSync(root.tokenFile, "utf8");
  });
  afterEach(async () => {
    hub.close(); acp.close();
    for (const proc of programs.values()) { proc.kill(); await proc.exited; }
    programs.clear(); connection.close(); serveRuntime(null); rmSync(dir, { recursive: true, force: true });
  });
  async function call(verb: string, args: object) {
    const value = await lineCall(hub.address, { id: 1, contract: HARNESS_CONTRACT, token, verb, args }, 5000);
    if (!isRecord(value)) throw new Error("invalid answer");
    return value;
  }
  async function start(task?: string) {
    const value = await call("start", { harness: "test", cwd: dir, ...(task ? { task } : {}) });
    if (!isRecord(value.session) || typeof value.session.address !== "string") throw new Error(JSON.stringify(value));
    return value.session.address;
  }
  it("the same key sends one prompt; the second send does not change mode", async () => {
    const session = await start();
    const first = await call("send", { session, task: "echo A", key: "one" });
    expect(await call("send", { session, task: "echo A", key: "one" })).toMatchObject({ duplicate: true, turn_id: first.turn_id });
    await call("wait", { session });
    expect(await call("send", { session, task: "echo B", key: "two" })).toMatchObject({ duplicate: false });
    await call("wait", { session });
    expect(await call("result", { session })).toMatchObject({ final_message: { untrusted: true, from: session, text: "echo bytes=6" } });
    const child = acp.forPane(session);
    if (!child) throw new Error("missing keeper");
    const rows = readFileSync(join(child.root, "archive.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
    const messages = rows.filter(row => row.dir === "to-agent").map(row => JSON.parse(row.raw));
    expect(messages.map(m => m.method)).toEqual(["initialize", "session/new", "session/prompt", "session/prompt"]);
    for (const msg of messages.slice(2)) expect(Object.keys(msg.params).sort()).toEqual(["prompt", "sessionId"]);
    expect(await call("stop", { session })).toMatchObject({ stopped: true });
    const verbs = readFileSync(join(dir, "tools/audit.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s).verb);
    expect(verbs.sort()).toEqual(["send", "send", "start", "stop", "turn", "turn"]);
  });
  it("a tool child past its lifetime cannot start a grandchild", async () => {
    const session = await start();
    const [row] = JSON.parse(readFileSync(join(dir,"tools/children.json"),"utf8"));
    token = readFileSync(join(dir,"tools/tokens",`${row.run}.token`),"utf8");
    now += 3_600_000;
    expect(await call("start", { harness:"test", cwd:dir })).toMatchObject({error:{code:"time_limit"}});
    expect(acp.forPane(session)).toBeDefined();
    expect(programs.size).toBe(1);
  });
  it("the keeper reserves a tool prompt before accepting another client's prompt", async () => {
    const session = await start(), child = acp.forPane(session);
    if (!child) throw new Error("missing child");
    const submitted = await Promise.allSettled([child.client.submit("hold","ask"), child.client.submit("hold","ask")]);
    expect(submitted.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(submitted.find(r=>r.status==="rejected")).toMatchObject({ reason: {code:-32005} });
  });
  it("returns the live child even when the initial prompt is rejected", async () => {
    const reject = spyOn(KeeperClient.prototype,"submit").mockRejectedValueOnce(new KeeperRequestError(-32004,"mode changed"));
    try {
      const reply = await call("ask", { harness:"test", cwd:dir, task:"echo hello", key:"first" });
      expect(reply).toMatchObject({kind:"session", sent:null, send_error:{code:"not_granted"}});
      if (!isRecord(reply.session)) throw new Error("no address");
      expect(await call("send", {session:reply.session.address,task:"echo hello",key:"first"})).toMatchObject({accepted:true,duplicate:false});
    } finally { reject.mockRestore(); }
  });
  it("reuses a start key after a confirmed failed handshake with no child", async () => {
    const args = { harness:"mute", cwd:dir, key:"retry" };
    expect(await call("start",args)).toMatchObject({error:{code:"start_failed"}});
    expect(await call("start",args)).toMatchObject({error:{code:"start_failed"}});
    expect(programs.size).toBe(2);
  });
  it("does not acknowledge a key whose delivery was never confirmed", async () => {
    const session = await start(), args={session,task:"echo hello",key:"uncertain"};
    const submit=spyOn(KeeperClient.prototype,"submit").mockRejectedValueOnce(new Error("receipt lost"));
    try {
      expect(await call("send",args)).toMatchObject({error:{code:"unavailable"}});
      expect(await call("send",args)).toMatchObject({error:{code:"unavailable"}});
      expect(submit).toHaveBeenCalledTimes(1);
      expect(readFileSync(join(dir,"tools/audit.jsonl"),"utf8")).not.toContain('"verb":"send"');
    } finally { submit.mockRestore(); }
  });
  it("reports the model confirmed by the keeper after a human model switch", async () => {
    const session = await start();
    const child = acp.forPane(session);
    if (!child) throw new Error("missing child");
    await child.client.request("session/set_model", { sessionId: child.client.session, modelId: "m2" });
    await call("send", { session, task: "echo again" });
    await call("wait", { session });
    expect(await call("result", { session })).toMatchObject({ model: "m2" });
  });
  it("refuses another agent prompt in a changed mode even after the hub restarts", async () => {
    const session = await start("echo first");
    await call("wait", { session });
    const child = acp.forPane(session);
    if (!child) throw new Error("missing child");
    await child.client.request("session/set_mode", { sessionId: child.client.session, modeId: "code" });
    hub.close(); acp.close(); open(); await acp.restore();
    expect(await call("send", { session, task: "echo next" })).toMatchObject({ error: { code: "not_granted" } });
    expect(acp.forPane(session)?.client.turn?.text).toBe("echo bytes=10");
  });
  it("wait and read show only waiting_human at a card, including after restart", async () => {
    const session = await start("ask");
    expect(await call("wait", { session })).toMatchObject({ state: { state: "waiting_human" } });
    hub.close(); acp.close(); open(); await acp.restore();
    expect(await call("wait", { session })).toMatchObject({ state: { state: "waiting_human" } });
    for (const what of ["transcript","screen","result"]) {
      const value = await call("read", { session, what });
      expect(value).toMatchObject({ state: { state: "waiting_human" } });
      expect(JSON.stringify(value)).not.toContain("touch x");
    }
    expect(await call("send", { session, task: "answer" })).toMatchObject({ error: { code: "waiting_human" } });
    const child = acp.forPane(session);
    const approval = child?.client.pending()[0];
    if (!child || !approval) throw new Error("missing card");
    expect(await call("answer", { session, question_id: approval.keeperId, choice: 0 })).toMatchObject({ error: { code: "waiting_human" } });
    expect(await child.client.answer(approval.keeperId, "reject")).toBe("won");
    expect(await call("wait", { session })).toMatchObject({ state: { state: "done" } });
    expect(await call("result", { session })).toMatchObject({ final_message: { text: "answered reject", untrusted: true } });
  });
  it.each(["parent", "pass", "timeout"] as const)("routes a native question to its parent before the person's card (%s)", async path => {
    const started = await call("start", { harness: "opencode", cwd: dir, task: "question" });
    if (!isRecord(started.session) || typeof started.session.address !== "string") throw new Error("no child");
    const session = started.session.address;
    const child = acp.forPane(session);
    if (!child) throw new Error("no keeper");
    const wait = await call("wait", { session, timeout_s: 1 });
    expect(wait).toMatchObject({ state: { state: "waiting_parent", on: "question", question: {
      prompt: { untrusted: true, from: session, text: "Which color?" }, choices: [{ text: "Red", untrusted: true }, { text: "Blue", untrusted: true }],
    } } });
    if (!isRecord(wait.state) || !isRecord(wait.state.question)) throw new Error("no question");
    const args = { session, question_id: wait.state.question.id };
    expect((await call("result", { session })).state).toEqual(wait.state);
    expect((await call("read", { session, what: "transcript" })).state).toEqual(wait.state);
    expect(acpPrompt(child)).toBeNull();
    if (path === "parent") {
      const parent = token, other = hub.runs.reserve();
      other.bind({ self: "other", root: other.id, started_by: null, depth: 0, harness: "fixture" });
      token = readFileSync(other.tokenFile, "utf8");
      expect((await call("read", { session, what: "state" })).state).not.toHaveProperty("question");
      expect(await call("answer", { ...args, choice: 0 })).toMatchObject({ error: { code: "not_owner" } });
      token = parent;
      await child.client.request("session/set_mode", { sessionId: child.client.session, modeId: "code" });
      await until(child.client, "new mode", () => child.client.sessionMode === "code");
      expect(await call("answer", { ...args, choice: 1 })).toMatchObject({ error: { code: "not_granted" } });
      await child.client.request("session/set_mode", { sessionId: child.client.session, modeId: "ask" });
      await until(child.client, "original mode", () => child.client.sessionMode === "ask");
      expect(await call("answer", { ...args, choice: 1 })).toMatchObject({ kind: "answered" });
    } else {
      if (path === "pass") expect(await call("answer", args)).toMatchObject({ kind: "state", state: { state: "waiting_human" } });
      else await until(child.client, "handoff notification", () => child.client.status === "blocked", 33_000);
      expect(await call("answer", { ...args, choice: 0 })).toMatchObject({ error: { code: "waiting_human" } });
      const card = acpPrompt(child);
      expect(card).toMatchObject({ kind: "question", question: "Which color?" });
      if (!card) throw new Error("no card");
      expect(await answerAcpPrompt(child, { pane_id: session, prompt_id: card.id, option_index: 1 })).toBe("answered");
    }
    await call("wait", { session });
    expect(await call("result", { session })).toMatchObject({ final_message: { text: JSON.stringify({ action: "accept", content: { q0: "blue" } }) } });
    expect((await call("answer", { ...args, choice: 0 })).kind).toBe("refusal");
    const audit = readFileSync(join(dir, "tools/audit.jsonl"), "utf8");
    expect(audit.split("\n").filter(line => line.includes('"verb":"answer"'))).toHaveLength(path === "timeout" ? 0 : 1);
    expect(audit).not.toContain("Which color?");
  }, 38_000);
  it.each(["parent", "person"])("stops without answering a question waiting for its %s", async owner => {
    const started = await call("start", { harness: "opencode", cwd: dir, task: "question" });
    if (!isRecord(started.session)) throw new Error("no child");
    const session = started.session.address;
    const waiting = await call("wait", { session });
    if (!isRecord(waiting.state) || !isRecord(waiting.state.question)) throw new Error("no question");
    if (owner === "person") expect(await call("answer", { session, question_id: waiting.state.question.id })).toMatchObject({ state: { state: "waiting_human" } });
    expect(await call("stop", { session })).toMatchObject({ stopped: true });
  });
  it("refuses an unrelated run as not_owner without changing the child or audit", async () => {
    const session = await start();
    const unrelated = hub.runs.reserve();
    unrelated.bind({ self: "another-parent", root: unrelated.id, started_by: null, depth: 0, harness: "fixture" });
    token = readFileSync(unrelated.tokenFile, "utf8");
    const audit = join(dir, "tools/audit.jsonl"), before = readFileSync(audit, "utf8");
    for (const verb of ["send","stop","result","wait"]) expect(await call(verb, { session, ...(verb === "send" ? { task: "unused" } : {}) })).toMatchObject({ error: { code: "not_owner" } });
    expect(acp.forPane(session)?.client.turn).toBeNull();
    expect(readFileSync(audit, "utf8")).toBe(before);
  });
  it("wait already in flight wakes when the child asks a person, before the turn ends", async () => {
    const session = await start("hold");
    // The ninth refusal is the server's receipt that all eight other waits are held.
    const waits = Array.from({ length: 9 }, () => call("wait", { session, timeout_s: 45 }));
    expect(await Promise.race(waits)).toMatchObject({ error: { code: "rate_limited" } });
    const child = acp.forPane(session);
    if (!child) throw new Error("missing child");
    child.client.notify("fixture/ask", { sessionId: child.client.session });
    const responses = await Promise.all(waits);
    expect(responses.filter(r => isRecord(r.state) && r.state.state === "waiting_human")).toHaveLength(8);
    expect(child.client.turn?.running).toBe(true);
  });
  it("does not even open the transcript when the keeper cannot prove ACP ownership", async () => {
    const session = await start("echo test");
    await call("wait", { session });
    const child = acp.forPane(session);
    if (!child) throw new Error("missing child");
    Object.defineProperty(child.client, "status", { configurable: true, value: "unknown" });
    const read = spyOn(child.client.history, "page");
    try {
      expect(await call("read", { session, what: "transcript" })).toMatchObject({ error: { code: "taken_over" } });
      expect(read).not.toHaveBeenCalled();
    } finally { Reflect.deleteProperty(child.client, "status"); read.mockRestore(); }
  });
  it("a person's cancel holds the child until release", async () => {
    const session = await start("hold");
    const child = acp.forPane(session);
    if (!child) throw new Error("missing child");
    // A hold's receipt says the cancel reached the agent; the agent's cancelled answer to the prompt comes on its own.
    const cancelled = until(child.client, "cancelled turn", () => child.client.turn?.stopReason === "cancelled");
    // if a hold throws first, its error is the test's; the await below still sees this wait's own failure
    cancelled.catch(() => {});
    const first = await child.client.request("_keeper/hold", { sessionId: child.client.session });
    const second = await child.client.request("_keeper/hold", { sessionId: child.client.session });
    if (!isRecord(first) || !isRecord(second)) throw new Error("missing hold receipt");
    expect(second.generation).not.toBe(first.generation);
    await cancelled;
    expect(await call("send", { session, task: "ignored" })).toMatchObject({ error: { code: "taken_over" } });
    await expect(child.client.request("_keeper/release", { generation: first.generation, sessionId: child.client.session })).rejects.toThrow();
    await child.client.request("_keeper/release", { generation: second.generation, sessionId: child.client.session });
    await call("wait", { session });
    expect(await call("send", { session, task: "echo again" })).toMatchObject({ accepted: true });
  });
  it("two simultaneous asks with one key run one child and stop never makes that key fresh again", async () => {
    const args = { harness: "test", cwd: dir, task: "echo exactly once", key: "dedup" };
    const [one, two] = await Promise.all([call("ask", args), call("ask", args)]);
    expect(one.kind).toBe("ask");
    expect(two.session).toEqual(one.session);
    expect(programs.size).toBe(1);
    if (!isRecord(one.session)) throw new Error("missing session");
    await call("stop", { session: one.session.address });
    expect(await call("ask", args)).toMatchObject({ error: { code: "unknown_session" } });
    expect(programs.size).toBe(1);
  });
  it("keeps the original send receipt after 256 other keys", async () => {
    const session = await start();
    const args = { session, task: "echo", key: "first" };
    const first = await call("send", args);
    for (let i = 0; i < 256; i++) {
      now += 7000;
      await call("wait", { session });
      expect(await call("send", { ...args, key: `next${i}` })).toMatchObject({ accepted: true });
    }
    expect(await call("send", args)).toMatchObject({ turn_id: first.turn_id, duplicate: true });
  }, 30000);
  it("six concurrent starts from one parent all start; old children accept no new work but stay alive", async () => {
    const outputs = await Promise.all(Array.from({ length: 6 }, () => call("start", { harness: "test", cwd: dir })));
    expect(outputs.filter(v => v.kind === "session")).toHaveLength(6);
    expect(programs.size).toBe(6);
    now += 3_600_000;
    for (const [session, proc] of programs) {
      expect(await call("send", { session, task: "late" })).toMatchObject({ error: { code: "time_limit" } });
      expect(proc.exitCode).toBeNull();
    }
  });
  it("recovers a keeper whose completed launch intent has not yet become a child row", async () => {
    const session = await start();
    const folder = join(dir, "tools");
    const [row] = JSON.parse(readFileSync(join(folder, "children.json"), "utf8"));
    hub.close(); acp.close();
    writeFileSync(join(folder, "children.json"), "[]");
    writeFileSync(join(folder, "launches.json"), JSON.stringify([{ run: row.run, parent: row.parent, starter: row.starter, harness: row.harness, created: row.created }]));
    open(); await acp.restore();
    await hub.reconcileLaunches();
    expect(await call("send", { session, task: "echo restored" })).toMatchObject({ accepted: true });
  });
  it("a keeper that never opens its session is refused cleanly", async () => {
    expect(await call("start", { cwd: dir, harness: "mute" })).toMatchObject({ error: { code: "start_failed" } });
    for (const proc of programs.values()) expect(await proc.exited).toBeNumber();
  });
  it("normalizes non-protocol stop reasons before exposing or auditing them", async () => {
    const session = await start("fixture-stop-reason");
    await call("wait", { session });
    expect(await call("result", { session })).toMatchObject({ stop_reason: "unknown" });
    expect(readFileSync(join(dir, "tools/audit.jsonl"), "utf8")).not.toContain("fixture annotation");
  });

  it("only allows once: another turn on either child still waits for a person", async () => {
    const a = await start("widen");
    const first = acp.forPane(a);
    const awaiting = await call("wait", { session: a });
    expect(awaiting).toMatchObject({ state: { state: "waiting_human" } });
    const asked = first?.client.pending()[0];
    if (!first || !asked) throw new Error("missing approval");
    expect(await first.client.answer(asked.keeperId, "always")).toBe("gone");
    expect(await first.client.answer(asked.keeperId, "allow")).toBe("won");
    await call("wait", { session: a });
    const previous = await call("result", { session: a });
    const next = await call("send", { session: a, task: "widen" });
    expect(next).toMatchObject({ accepted: true, duplicate: false });
    expect(typeof next.turn_id).toBe("string");
    expect(next.turn_id).not.toBe(previous.turn_id);
    expect(await call("wait", { session: a, turn: next.turn_id })).toMatchObject({ state: { state: "waiting_human", turn: 2 } });
    const b = await start("widen");
    expect(await call("wait", { session: b })).toMatchObject({ state: { state: "waiting_human" } });
    expect(acp.forPane(b)?.client.sessionMode).toBe("ask");
  });
});
