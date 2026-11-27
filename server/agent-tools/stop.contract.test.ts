import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_CONTRACT, HARNESS_TOOL_OFF, isRecord, type HarnessToolSetting } from "../../shared/harness-tool.ts";
import { AcpChildren, type AcpHc } from "../acp/children.ts";
import { FAKE_AGENT, KEEPER_BUILD, keeperBuilt, until } from "../acp/keeper.fake.ts";
import { HcConnection } from "../herdr-core/connection.ts";
import { FakeHcCore } from "../herdr-core/core.fake.ts";
import * as runtime from "../herdr-core/runtime.ts";
import { createServer } from "../index.ts";
import { lineCall } from "../line-call.ts";
import { HERDR_CORE, serveRuntime } from "../runtime/capabilities.ts";
import { AgentToolHub } from "./hub.ts";

it("names a child whose terminal is live but whose ACP session is still opening (#4677, #4626)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "as-"));
  const fake = new FakeHcCore();
  const hc = new HcConnection(() => fake.transport());
  const appeared = Promise.withResolvers<string>();
  const runReceipt = Promise.withResolvers<void>();
  fake.onStart = ({ address }) => appeared.resolve(address);
  const call: AcpHc["call"] = async (method, params) => {
    const result = await hc.call(method, params);
    if (method === "terminal.run") await runReceipt.promise;
    return result;
  };
  serveRuntime(HERDR_CORE);
  const acp = new AcpChildren(join(dir, "acp"), { keeperBin: () => KEEPER_BUILD, hc: { call }, socketMs: 0 });
  const starting = acp.start({ harness: "fixture", argv: [FAKE_AGENT], cwd: dir, parentPane: "parent" }).catch(() => {});
  serveRuntime(null);
  const registry = spyOn(runtime, "coreAcp").mockReturnValue(acp);
  const credential = "fixture-driver";
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: credential, machines: false, sidecar: false, tailscaleOwner: null });
  try {
    const terminal = await appeared.promise;
    const response = await fetch(`http://127.0.0.1:${app.port}/api/pane/turn/cancel-children`, {
      method: "POST", headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: JSON.stringify({ pane_id: "parent" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, held: [], failed: [terminal] });
  } finally {
    runReceipt.resolve();
    await starting;
    app.stop();
    registry.mockRestore();
    acp.close();
    hc.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(!keeperBuilt)("stopping delegated work", () => {
  let dir: string, hc: HcConnection, acp: AcpChildren;
  const programs = new Map<string, ReturnType<typeof Bun.spawn>>();

  beforeEach(() => {
    serveRuntime(HERDR_CORE);
    dir = mkdtempSync(join(tmpdir(), "as-"));
    const fake = new FakeHcCore();
    fake.onStart = program => {
      programs.set(program.address, Bun.spawn([...program.argv], { env: process.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }));
    };
    hc = new HcConnection(() => fake.transport());
    acp = new AcpChildren(join(dir, "acp"), { keeperBin: () => KEEPER_BUILD, hc: { call: (method, params) => {
      if (method === "terminal.kill" && "terminal" in params && typeof params.terminal === "string") programs.get(params.terminal)?.kill();
      return hc.call(method, params);
    } } });
  });

  afterEach(async () => {
    acp.close();
    for (const program of programs.values()) { program.kill(); await program.exited; }
    programs.clear();
    hc.close();
    serveRuntime(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const reductions = [
    { name: "the switch goes to view", policy: { level: "view" }, depth: 0 },
    { name: "the depth limit drops to the parent's depth", policy: { depth: 1 }, depth: 1 },
    { name: "the child's harness is removed", policy: { harnesses: [] }, depth: 0 },
  ] as const;
  it.each([...reductions])("a parent can discover and stop its child at an approval after $name", async ({ policy, depth }) => {
    let setting: HarnessToolSetting = { level: "start", depth: 2, harnesses: ["agy"] };
    const adapter = join(dir, "agy");
    const replay = join(import.meta.dir, "replay-agent.fake.ts");
    const fixture = join(import.meta.dir, "fixtures", "agy-1.5.16-ask-write.jsonl");
    writeFileSync(adapter, `#!/bin/sh\n[ "$1" = --version ] && exec echo 1.5.16\nexec "${process.execPath}" "${replay}" "${fixture}" "${join(dir, "replay.jsonl")}"\n`, { mode: 0o700 });
    const hub = new AgentToolHub({ dir: join(dir, "tools"), acp, setting: () => setting, resolve: kind => kind === "agy" ? { argv: [adapter] } : null });
    try {
      hub.listen();
      const root = hub.runs.reserve();
      root.bind({ self: "root", harness: "fixture", depth: 0, root: root.id, started_by: null });
      const parent = depth === 0 ? root : hub.runs.reserve(depth);
      if (depth > 0) parent.bind({ self: "parent", harness: "fixture", depth, root: root.id, started_by: root.id });
      const token = readFileSync(parent.tokenFile, "utf8");
      const call = (verb: string, args: object = {}) => lineCall(hub.address, { id: 1, contract: HARNESS_CONTRACT, token, verb, args }, 5000);
      const started = await call("start", { harness: "agy", cwd: dir, task: "do the recorded action" });
      if (!isRecord(started) || !isRecord(started.session) || typeof started.session.address !== "string") throw new Error(JSON.stringify(started));
      const session = started.session.address;
      const child = acp.forPane(session);
      if (!child) throw new Error("missing child");
      await until(child.client, "the pending approval", () => child.client.pending().length === 1);

      setting = { ...setting, ...policy };
      hub.settingsChanged();
      const scope = await call("scope");
      expect(await call("stop", { session })).toMatchObject({ kind: "stopped", stopped: true, session });
      expect(scope).toMatchObject({ verbs: expect.arrayContaining(["stop"]) });
      expect(scope).not.toMatchObject({ verbs: expect.arrayContaining(["send"]) });
      expect(child.client.pending()).toEqual([]);
      expect(acp.forPane(session)).toBeUndefined();
    } finally {
      hub.close();
    }
  });

  it.each(["cancel", "cancel-children"] as const)("a driving device can %s with agent tools off", async action => {
    const child = await acp.start({ harness: "fixture", argv: [FAKE_AGENT], cwd: dir, parentPane: "parent" });
    await child.client.submit("hold");
    serveRuntime(null);
    const registry = spyOn(runtime, "coreAcp").mockReturnValue(acp);
    const credential = "fixture-driver";
    const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir: dir, token: credential, machines: false, sidecar: false, tailscaleOwner: null });
    try {
      const url = `http://127.0.0.1:${app.port}`;
      const headers = { authorization: `Bearer ${credential}`, "content-type": "application/json" };
      const changed = await fetch(`${url}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ settings: { agentHarnessTool: HARNESS_TOOL_OFF } }) });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({ settings: { agentHarnessTool: { level: "off" } } });

      const response = await fetch(`${url}/api/pane/turn/${action}`, { method: "POST", headers, body: JSON.stringify({ pane_id: action === "cancel" ? child.terminal : "parent" }) });
      expect(response.status).toBe(200);
      const hold = { child_id: child.id, generation: expect.any(Number) };
      expect(await response.json()).toMatchObject(action === "cancel" ? { ok: true, ...hold } : { ok: true, held: [{ pane_id: child.terminal, ...hold }], failed: [] });
      await until(child.client, "the cancelled turn", () => child.client.turn?.stopReason === "cancelled");
    } finally {
      app.stop();
      registry.mockRestore();
    }
  });
});
