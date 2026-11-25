import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as prompts from "../prompt.ts";
import * as conversation from "../conversation.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CONTRACT, harnessToolSetting, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { AcpChildren } from "../acp/children.ts";
import { lineCall } from "../line-call.ts";
import { PreferenceStore } from "../preferences.ts";
import { AgentToolHub } from "./hub.ts";

let dir: string, hub: AgentToolHub, token: string;
let setting: HarnessToolSetting;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ath-"));
  setting = harnessToolSetting(new PreferenceStore(dir).get().settings.agentHarnessTool);
  hub = new AgentToolHub({ dir, setting: () => setting, acp: new AcpChildren(join(dir, "acp")) });
  const key = hub.runs.reserve();
  key.bind({ self: "t1", root: key.id, started_by: null, depth: 0, harness: "fixture" });
  token = readFileSync(key.tokenFile, "utf8");
  hub.listen();
});
afterEach(() => { hub.close(); rmSync(dir, { recursive: true, force: true }); });
const call = (verb: string, args: object = {}, credential = token) =>
  lineCall(hub.address, { id: 1, contract: HARNESS_CONTRACT, token: credential, verb, args }, 2000);
const start = () => { setting = { level: "start", depth: 1, harnesses: ["gjc"] }; };

it("a pane registry that cannot be written does not stop a token run", async () => {
  mkdirSync(join(dir, "pane-runs.json"));
  expect(await call("scope")).toMatchObject({ kind: "scope" });
});

it("never consults a plain shell's prompt or contents for agent read", async () => {
  const snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ protocol: 22, version: "fixture", agents: [], workspaces: [], tabs: [], layouts: [],
    panes: [{ pane_id: "shell", terminal_id: "term", agent: null, tab_id: "tab", workspace_id: "ws", focused: false, revision: 1, agent_status: "unknown" }] });
  const prompt = spyOn(prompts, "readPrompt").mockRejectedValue(new Error("unexpected content read"));
  try {
    expect(await call("ls")).toMatchObject({ sessions: [] });
    expect(await call("read", { session: "shell", what: "state" })).toMatchObject({ error: { code: "unknown_session" } });
    expect(prompt).not.toHaveBeenCalled();
  } finally { snapshot.mockRestore(); prompt.mockRestore(); }
});
it("drops a terminal result when its agent returns to work during the read", async () => {
  start();
  const pane = { pane_id:"agent", terminal_id:"term", agent:"claude", tab_id:"tab", workspace_id:"ws", focused:false, revision:1, agent_status:"done" as const };
  const snapshot = { protocol:22,version:"fixture",agents:[],workspaces:[],tabs:[],layouts:[],panes:[pane] };
  const snap = spyOn(herdr,"sessionSnapshot").mockResolvedValue(snapshot);
  const info = {agent:"claude",status:"done",prompt:null,pane,panes:[pane],snapshot};
  const prompt = spyOn(prompts,"readPrompt").mockResolvedValueOnce(info).mockResolvedValueOnce({...info,status:"working"});
  const history = spyOn(conversation,"paneConversation").mockResolvedValue({source:"claude-transcript",turns:[],metadata:{model:null,reasoning_effort:null},cursor:null,history_id:"fixture",version:"1"});
  try {
    const reply = await call("read",{session:"agent",what:"result"});
    expect(reply).toMatchObject({kind:"state",state:{state:"working"}});
    expect(reply).not.toHaveProperty("final_message");
  } finally { history.mockRestore(); prompt.mockRestore(); snap.mockRestore(); }
});

it("defaults to local delegation after an unrelated preference is saved and reloaded", async () => {
  new PreferenceStore(dir).set({ settings: { theme: "dark" } });
  setting = harnessToolSetting(new PreferenceStore(dir).get().settings.agentHarnessTool);
  expect(setting).toEqual({ level: "start", depth: 1, harnesses: ["claude", "codex", "copilot", "opencode", "agy", "gjc"] });
  expect(await call("scope")).toMatchObject({ verbs: expect.arrayContaining(["start", "send"]) });
});

it("a saved view policy still refuses start, send, wait, result and ask after restart", async () => {
  new PreferenceStore(dir).set({ settings: { agentHarnessTool: { level: "view", depth: 1, harnesses: ["gjc"] } } });
  setting = harnessToolSetting(new PreferenceStore(dir).get().settings.agentHarnessTool);
  for (const verb of ["start", "send", "wait", "result", "ask"]) expect(await call(verb)).toMatchObject({ error: { code: "not_granted" } });
  expect(await call("stop", { session: "other" })).toMatchObject({ error: { code: "unknown_session" } });
  expect(await call("scope")).toMatchObject({ verbs: ["machines", "harnesses", "ls", "read"] });
});
it("refuses a start on another machine without starting it", async () => {
  start();
  expect(await call("start", { on: "other", harness: "gjc" })).toMatchObject({ error: { code: "approval_required" } });
});
it("start takes no mode, args, model or env", async () => {
  start();
  for (const name of ["mode", "args", "model", "env"]) expect(await call("start", { harness: "gjc", [name]: "x" })).toMatchObject({ error: { code: "bad_request" } });
});
it("a send to oneself is refused", async () => {
  start();
  expect(await call("send", { session: "t1", task: "ignored" })).toMatchObject({ error: { code: "self_target" } });
});
it("tool discovery during session opening confers no data access; the depth ceiling also applies to RPC", async () => {
  start();
  const parent = hub.runs.verify(token);
  if (!parent) throw new Error("missing parent");
  const child = hub.runs.reserve(1);
  const secret = readFileSync(child.tokenFile, "utf8");
  expect(await call("scope", {}, secret)).toMatchObject({ verbs: ["machines","harnesses","ls","read"] });
  expect(await call("machines", {}, secret)).toMatchObject({ error: { code: "not_granted" } });
  child.bind({ self: "child", harness: "gjc", started_by: parent.id, root: parent.id, depth: 1 });
  expect(await call("send", { session: "other", task: "hello" }, secret)).toMatchObject({ error: { code: "not_granted" } });
  expect(await call("stop", { session: "other" }, secret)).toMatchObject({ error: { code: "unknown_session" } });
});
it.each([1,2,3] as const)("a run at depth %d cannot start, even with the local harness granted", async depth => {
  setting = { level: "start", depth, harnesses: ["gjc"] };
  const parent = hub.runs.verify(token);
  if (!parent) throw new Error("missing parent");
  let starter = parent.id;
  let leaf = "";
  for (let i = 1; i <= depth; i++) {
    const r = hub.runs.reserve();
    r.bind({ self: `child-${i}`, root: parent.id, depth: i, started_by: starter, harness: "gjc" });
    leaf = readFileSync(r.tokenFile, "utf8");
    starter = r.id;
  }
  expect(await call("start", { harness: "gjc" }, leaf)).toMatchObject({ error: { code: "depth_exceeded" } });
});
it("neither an unticked harness nor an approval verb can act", async () => {
  start();
  expect(await call("start", { harness: "other" })).toMatchObject({ error: { code: "not_granted" } });
  expect(await call("approve", { session: "t1" })).toMatchObject({ error: { code: "bad_request" } });
  expect(await call("scope", {}, "ordinary-http-token")).toMatchObject({ error: { code: "not_granted" } });
});
it("the 31st call in a minute is refused", async () => {
  for (let i = 0; i < 30; i++) expect(await call("scope")).toMatchObject({ kind: "scope" });
  hub.close();
  hub = new AgentToolHub({ dir, setting: () => setting, acp: new AcpChildren(join(dir, "acp")) });
  hub.listen();
  expect(await call("scope")).toMatchObject({ error: { code: "rate_limited" } });
});
it("the off switch rejects every verb and revokes credentials already issued", async () => {
  setting = { ...setting, level: "off" };
  hub.settingsChanged();
  expect(await call("read")).toMatchObject({ error: { code: "tools_off" } });
  expect(await call("stop", { session: "other" })).toMatchObject({ error: { code: "tools_off" } });
  start();
  expect(await call("scope")).toMatchObject({ error: { code: "not_granted" } });
});
it("depth holds from another process that uses the child's token", async () => {
  start();
  const parent = hub.runs.verify(token);
  if (!parent) throw new Error("missing parent");
  const child = hub.runs.reserve();
  child.bind({ self: "t2", root: parent.id, started_by: parent.id, depth: 1, harness: "gjc" });
  const relay = Bun.spawn([process.execPath, join(import.meta.dir, "mcp.ts"), "--socket", hub.address, "--token-file", child.tokenFile], {
    stdin: new Response(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_start", arguments: { harness: "gjc" } } })}\n`),
    stdout: "pipe", stderr: "inherit",
  });
  const response = JSON.parse(await new Response(relay.stdout).text());
  expect(await relay.exited).toBe(0);
  expect(response.result.structuredContent).toMatchObject({ error: { code: "depth_exceeded" } });
  expect(await call("send", { session: "t1", task: "x" }, readFileSync(child.tokenFile, "utf8"))).toMatchObject({ error: { code: "ancestor_target" } });
});
