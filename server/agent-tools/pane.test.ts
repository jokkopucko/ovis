import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CONTRACT, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { lineCall } from "../line-call.ts";
import * as herdr from "../herdr/client.ts";
import { AcpChildren } from "../acp/children.ts";
import { AgentToolHub } from "./hub.ts";
import { useAgentToolHub } from "./launch.ts";
import { handleAgentPanesRequest } from "./pane-routes.ts";
import { procLink, stillIn, type PaneTerminal } from "./pane-proof.ts";

const CLI = join(import.meta.dir, "../../scripts/plugin-agent.ts");
const START: HarnessToolSetting = { level: "start", depth: 1, harnesses: ["opencode"] };
let state: string, hub: AgentToolHub, setting: HarnessToolSetting, terminals: PaneTerminal[];
let snapshot: ReturnType<typeof spyOn>;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), "athp-"));
  setting = START;
  terminals = [];
  hub = new AgentToolHub({ dir: join(state, "agent-tools"), setting: () => setting, acp: new AcpChildren(join(state, "acp")),
    panes: { list: async () => terminals, get: async address => terminals.find(t => t.address === address) ?? null } });
  hub.listen();
  snapshot = spyOn(herdr, "sessionSnapshot").mockResolvedValue({ protocol: 22, version: "fixture", agents: [], workspaces: [], tabs: [], layouts: [], panes: [] });
});
afterEach(() => { snapshot.mockRestore(); hub.close(); rmSync(state, { recursive: true, force: true }); });

const callerEnv = (hint?: string) => {
  const env: Record<string, string> = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", OVIS_STATE_DIR: state };
  if (hint) env["HC_TERMINAL_ID"] = hint;
  return env;
};
const callerArgv = (words: readonly string[]) => [process.execPath, "-e", `const { runAgent } = await import(${JSON.stringify(CLI)}); process.exit(await runAgent(${JSON.stringify(words)}));`];

/** A pane: a shell hc would run, whose pid is the pane's root, that starts the command once it is told the pane exists. */
async function inPane(address: string, words: readonly string[], options: { hint?: string; raw?: boolean } = {}) {
  const command = options.raw ? words : callerArgv(words);
  const shell = Bun.spawn(["/bin/sh", "-c", 'read go; "$@"; status=$?; exit $status', "pane", ...command], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: callerEnv(options.hint) });
  terminals = [...terminals.filter(t => t.address !== address), { address, state: "live", pid: shell.pid, created_ms: shell.pid, labels: {}, name: `pane ${address}` }];
  shell.stdin.write("go\n"); await shell.stdin.end();
  const lines = (await new Response(shell.stdout).text()).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  return { code: await shell.exited, reply: lines[0]!, lines };
}
async function outside(words: readonly string[]) {
  const caller = Bun.spawn(callerArgv(words), { stdout: "pipe", stderr: "inherit", env: callerEnv() });
  return { code: await caller.exited, reply: JSON.parse(await new Response(caller.stdout).text()) as Record<string, unknown> };
}
const quote = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
const code = (reply: Record<string, unknown>) => (reply["error"] as { code?: string } | undefined)?.code;

describe.skipIf(process.platform !== "linux")("ovis agent from a pane hc started", () => {
  it("asks the owner once, and does nothing until he allows the pane", async () => {
    const shell = await holdPane("t7");
    try {
      const line = callerArgv(["ls", "--json"]).map(quote).join(" ");
      expect((await shell.run(`${line} & ${line}; wait`, 2)).map(code)).toEqual(["approval_required", "approval_required"]);
      const card = hub.grants.view().pending;
      expect(card.map(p => p.pane)).toEqual(["t7"]);
      expect(code(await shell.call(["ls", "--json"]))).toBe("approval_required");
      expect(hub.grants.view().pending).toEqual(card);
      expect(existsSync(join(state, "agent-tools", "pane-runs.json"))).toBe(false);
    } finally { await shell.close(); }
    expect((await inPane("t8", ["ls", "--json"])).code).toBe(1);
  });

  it("after the owner allows it, every later process of the pane calls as that pane's one run", async () => {
    const shell = await holdPane("t7", "t7");
    try {
      expect(code(await shell.call(["ls", "--json"]))).toBe("approval_required");
      expect(await hub.answerPane(hub.grants.view().pending[0]!.id, true)).toBe("ok");
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      expect(hub.grants.view().allowed.map(p => p.pane)).toEqual(["t7"]);
      // one run for the pane, charged for both calls: its children, keys and limit are the pane's, not each process's
      const runs = JSON.parse(readFileSync(join(state, "agent-tools", "pane-runs.json"), "utf8")) as { run: { self: string; harness: string }; calls: number[] }[];
      expect(runs.map(r => [r.run.self, r.run.harness, r.calls.length])).toEqual([["t7", "hc-pane", 2]]);
    } finally { await shell.close(); }
  });

  it("refuses a card that Ovis's own launch in the pane has since taken over", async () => {
    expect(code((await inPane("t7", ["ls", "--json"])).reply)).toBe("approval_required");
    hub.runs.reserve().bind({ self: "t7", root: "0123456789abcdef", depth: 0, started_by: null, harness: "omo" });
    expect(await hub.answerPane(hub.grants.view().pending[0]!.id, true)).toBe("gone");
    expect(hub.grants.view().allowed).toEqual([]);
  });

  it("turning back to look-only forgets every grant even when a revoke fails", async () => {
    await allowWhileRunning("t7");
    await allowWhileRunning("t8");
    const revoke = spyOn(hub.runs, "revoke").mockImplementationOnce(() => { throw new Error("disk full"); });
    setting = { ...START, level: "view" };
    expect(() => hub.settingsChanged()).toThrow("disk full");
    revoke.mockRestore();
    expect(hub.grants.view()).toEqual({ pending: [], allowed: [] });
    setting = START;
    expect(code((await inPane("t8", ["ls", "--json"])).reply)).toBe("approval_required");
  });

  it("a pane registry that cannot be written does not stop a token run", async () => {
    const key = hub.runs.reserve();
    key.bind({ self: "t1", root: key.id, started_by: null, depth: 0, harness: "omo" });
    mkdirSync(join(state, "agent-tools", "pane-runs.json"));
    const reply = await lineCall(hub.address, { id: 1, contract: HARNESS_CONTRACT, token: readFileSync(key.tokenFile, "utf8"), verb: "scope", args: {} }, 2000);
    expect(reply).toMatchObject({ kind: "scope" });
  });

  it("a card answered after its pane closed grants nothing", async () => {
    expect(code((await inPane("t7", ["ls", "--json"])).reply)).toBe("approval_required");
    const id = hub.grants.view().pending[0]!.id;
    terminals = [];
    expect(await hub.answerPane(id, true)).toBe("gone");
    expect(hub.grants.view()).toEqual({ pending: [], allowed: [] });
  });

  it("refuses a process outside every pane without raising a card", async () => {
    terminals = [{ address: "t7", state: "live", pid: 999_999_999, created_ms: 1, labels: {} }];
    const reply = await outside(["ls", "--json"]);
    expect(reply.code).toBe(1);
    expect(code(reply.reply)).toBe("not_granted");
    expect(hub.grants.view()).toEqual({ pending: [], allowed: [] });
  });

  it("refuses another pane's process that claims to be pane X, and never grants it X's run", async () => {
    await allowWhileRunning("t7");
    const posing = await inPane("t9", ["ls", "--json"], { hint: "t7" });
    expect(code(posing.reply)).toBe("not_granted");
    const own = await inPane("t9", ["ls", "--json"]);
    expect(code(own.reply)).toBe("approval_required");
    expect(hub.grants.view().allowed.map(p => p.pane)).toEqual(["t7"]);
    expect(hub.grants.view().pending.map(p => p.pane)).toEqual(["t9"]);
  });

  it("a denied or removed pane stays refused while it lives", async () => {
    const shell = await holdPane("t7");
    try {
      expect(code(await shell.call(["ls", "--json"]))).toBe("approval_required");
      expect(await hub.answerPane(hub.grants.view().pending[0]!.id, false)).toBe("ok");
      expect(code(await shell.call(["ls", "--json"]))).toBe("approval_denied");
    } finally { await shell.close(); }
    const allowed = await holdPane("t8");
    try {
      await allowed.call(["ls", "--json"]);
      expect(await hub.answerPane(hub.grants.view().pending[0]!.id, true)).toBe("ok");
      expect(await allowed.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
      expect(hub.grants.remove(hub.grants.view().allowed[0]!.id)).toBe(true);
      expect(code(await allowed.call(["ls", "--json"]))).toBe("approval_denied");
    } finally { await allowed.close(); }
  });

  it("a closed pane's grant ends, and a new pane at the same address is asked again", async () => {
    const shell = await holdPane("t7");
    try {
      await shell.call(["ls", "--json"]);
      await hub.answerPane(hub.grants.view().pending[0]!.id, true);
      expect(await shell.call(["ls", "--json"])).toMatchObject({ kind: "sessions" });
    } finally { await shell.close(); }
    terminals = [];
    await hub.reconcilePanes();
    expect(hub.grants.view()).toEqual({ pending: [], allowed: [] });
    expect(code((await inPane("t7", ["ls", "--json"])).reply)).toBe("approval_required");
  });

  it("is refused without a card at look-only or off, and turning it back to look-only forgets every grant", async () => {
    await allowWhileRunning("t7");
    setting = { ...START, level: "view" };
    hub.settingsChanged();
    expect(hub.grants.view()).toEqual({ pending: [], allowed: [] });
    expect(code((await inPane("t7", ["ls", "--json"])).reply)).toBe("not_granted");
    setting = { ...START, level: "off" };
    hub.settingsChanged();
    expect(code((await inPane("t7", ["ls", "--json"])).reply)).toBe("tools_off");
    expect(hub.grants.view()).toEqual({ pending: [], allowed: [] });
  });

  it("only this PC's owner lists, answers or removes panes", async () => {
    useAgentToolHub(hub);
    try {
      expect(code((await inPane("t7", ["ls", "--json"])).reply)).toBe("approval_required");
      const id = hub.grants.view().pending[0]!.id;
      const post = (path: string, body: object, owner: boolean) => handleAgentPanesRequest(new Request(`http://x${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), path, owner);
      expect((await handleAgentPanesRequest(new Request("http://x/api/agent-tools/panes"), "/api/agent-tools/panes", false)).status).toBe(403);
      expect((await post("/api/agent-tools/panes/answer", { id, decision: "allow" }, false)).status).toBe(403);
      expect(await (await handleAgentPanesRequest(new Request("http://x/api/agent-tools/panes"), "/api/agent-tools/panes", true)).json()).toEqual({ pending: [{ id, pane: "t7", label: "pane t7" }], allowed: [] });
      expect(hub.grants.view().pending).toHaveLength(1);
    } finally { useAgentToolHub(null); }
  });

  it("keeps the hub's limits: an unticked harness is not started for a pane", async () => {
    const shell = await holdPane("t7");
    try {
      await shell.call(["ls", "--json"]);
      await hub.answerPane(hub.grants.view().pending[0]!.id, true);
      expect(code(await shell.call(["start", "--harness", "gjc", "--json"]))).toBe("not_granted");
    } finally { await shell.close(); }
  });
});

/** A pane whose shell stays, running each command it is given as its own child, as a person types into it. */
async function holdPane(address: string, hint?: string) {
  const shell = Bun.spawn(["/bin/sh", "-c", 'while read -r line; do eval "$line"; done'], { stdin: "pipe", stdout: "pipe", stderr: "inherit", env: callerEnv(hint) });
  terminals = [...terminals.filter(t => t.address !== address), { address, state: "live", pid: shell.pid, created_ms: shell.pid, labels: {}, name: `pane ${address}` }];
  const reader = shell.stdout.getReader();
  let buffered = "";
  const line = async () => {
    for (;;) {
      const at = buffered.indexOf("\n");
      if (at >= 0) { const out = buffered.slice(0, at); buffered = buffered.slice(at + 1); return out; }
      const { value, done } = await reader.read();
      if (done) throw new Error("pane shell ended");
      buffered += new TextDecoder().decode(value);
    }
  };
  const run = async (text: string, count: number) => {
    shell.stdin.write(`${text}\n`);
    await shell.stdin.flush();
    const out: Record<string, unknown>[] = [];
    while (out.length < count) out.push(JSON.parse(await line()) as Record<string, unknown>);
    return out;
  };
  return {
    run,
    call: async (words: readonly string[]) => (await run(callerArgv(words).map(quote).join(" "), 1))[0]!,
    close: async () => { await shell.stdin.end(); await shell.exited; },
  };
}
async function allowWhileRunning(address: string) {
  const shell = await holdPane(address);
  try {
    await shell.call(["ls", "--json"]);
    const pending = hub.grants.view().pending.find(p => p.pane === address);
    if (!pending || await hub.answerPane(pending.id, true) !== "ok") throw new Error("could not allow the pane");
    return { reply: await shell.call(["ls", "--json"]) };
  } finally { await shell.close(); }
}

describe.skipIf(process.platform !== "linux")("a call's caller stays a process of its pane", () => {
  it("is in the pane while the pane's root, born when proved, is among its parents, and out once it is not", () => {
    const parent = procLink(process.ppid)!;
    const peer = { pid: process.pid, alive: () => true, close: () => {} };
    expect(stillIn(peer, { pane: "t1", created_ms: 1, root: parent.pid, birth: parent.birth })).toBe(true);
    expect(stillIn(peer, { pane: "t1", created_ms: 1, root: parent.pid, birth: "another-birth" })).toBe(false);
    expect(stillIn({ ...peer, alive: () => false }, { pane: "t1", created_ms: 1, root: parent.pid, birth: parent.birth })).toBe(false);
  });
});
