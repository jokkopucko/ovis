import assert from "node:assert/strict";
import { it } from "bun:test";

/** herdr moves an automatic tab name up when an earlier tab closes; a renamed tab keeps its name. */
it("the demo relabels automatic tab names by place and leaves custom numeric names alone", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?tabs";
    await import(transport);
    const demo = (globalThis as any).window;
    const post = async (url: string, body: unknown) => (await demo.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const labels = async (workspaceId: string) =>
      (await (await demo.fetch("/api/session")).json()).snapshot.tabs.filter((tab: any) => tab.workspace_id === workspaceId).map((tab: any) => `${tab.tab_id.split(":")[1]}=${tab.label}`);

    const made = await post("/api/workspace/create", { cwd: "/home/demo/tabs-check", label: "tabs-check" });
    const workspace = made.workspace_id as string;
    for (let i = 0; i < 3; i += 1) await post("/api/tab/create", { workspace_id: workspace });
    assert.deepEqual(await labels(workspace), ["t1=tabs-check", "t2=2", "t3=3", "t4=4"]);

    await post("/api/tab/close", { tab_id: `${workspace}:t1` });
    assert.deepEqual(await labels(workspace), ["t2=1", "t3=2", "t4=3"]);

    await post("/api/tab/rename", { tab_id: `${workspace}:t4`, label: "3" });
    await post("/api/tab/close", { tab_id: `${workspace}:t2` });
    assert.deepEqual(await labels(workspace), ["t3=1", "t4=3"]);

    await post("/api/tab/create", { workspace_id: workspace });
    const after = (await (await demo.fetch("/api/session")).json()).snapshot;
    const unnamed = after.tabs.filter((tab: any) => tab.workspace_id === workspace).at(-1).tab_id as string;
    const pane = after.panes.find((candidate: any) => candidate.tab_id === unnamed);
    await post("/api/pane/close", { pane_id: pane.pane_id });
    await post("/api/tab/create", { workspace_id: workspace, label: "build" });
    assert.deepEqual((await labels(workspace)).map((entry: string) => entry.split("=")[1]), ["1", "3", "build"]);
    const beforeMove = (await (await demo.fetch("/api/session")).json()).snapshot;
    const ordered = beforeMove.tabs.filter((tab: any) => tab.workspace_id === workspace);
    const moved = await post("/api/tab/move", { tab_id: ordered[0].tab_id, insert_index: 3 });
    assert.deepEqual(moved.tabs.map((tab: any) => tab.tab_id), [ordered[1].tab_id, ordered[2].tab_id, ordered[0].tab_id]);
    assert.deepEqual((await labels(workspace)).map((entry: string) => entry.split("=")[1]), ["3", "build", "3"]);
    const afterMove = (await (await demo.fetch("/api/session")).json()).snapshot;
    assert.equal(afterMove.focused_pane_id, beforeMove.focused_pane_id);
    assert.equal(afterMove.focused_tab_id, beforeMove.focused_tab_id);
    const invalid = await demo.fetch("/api/tab/move", { method: "POST", body: JSON.stringify({ tab_id: ordered[0].tab_id, insert_index: -1 }) });
    assert.equal(invalid.status, 400);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});

it("the demo moves a one-pane tab to another workspace without stale tab or workspace IDs", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?move-to-workspace";
    await import(transport);
    const demo = (globalThis as any).window;
    const post = async (url: string, body: unknown) => (await demo.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const session = async () => (await (await demo.fetch("/api/session")).json()).snapshot;
    const consistent = (snap: any) => {
      const tabs = new Set(snap.tabs.map((tab: any) => tab.tab_id));
      const workspaces = new Set(snap.workspaces.map((workspace: any) => workspace.workspace_id));
      for (const workspace of snap.workspaces) assert.ok(tabs.has(workspace.active_tab_id), `${workspace.workspace_id} opens a tab it has`);
      for (const agent of snap.agents) assert.ok(tabs.has(agent.tab_id) && workspaces.has(agent.workspace_id), `${agent.pane_id}'s agent names its place`);
      assert.ok(snap.focused_tab_id === null || tabs.has(snap.focused_tab_id));
      assert.ok(snap.focused_workspace_id === null || workspaces.has(snap.focused_workspace_id));
      assert.deepEqual(snap.tabs.filter((tab: any) => tab.focused).map((tab: any) => tab.tab_id), snap.focused_tab_id === null ? [] : [snap.focused_tab_id]);
    };

    const from = (await post("/api/workspace/create", { cwd: "/home/demo/move-from", label: "move-from", agent: { kind: "claude" } })).workspace_id as string;
    const to = (await post("/api/workspace/create", { cwd: "/home/demo/move-to", label: "move-to" })).workspace_id as string;
    await post("/api/tab/create", { workspace_id: from, label: "build" });
    const before = await session();
    const agentPane = before.panes.find((pane: any) => pane.tab_id === `${from}:t1`).pane_id as string;
    await post("/api/pane/focus", { pane_id: agentPane });
    assert.equal((await session()).workspaces.find((workspace: any) => workspace.workspace_id === from).active_tab_id, `${from}:t1`);

    const moved = await post("/api/tab/move-to-workspace", { tab_id: `${from}:t1`, workspace_id: to });
    const after = await session();
    consistent(after);
    assert.deepEqual(after.agents.filter((agent: any) => agent.pane_id === moved.pane_id).map((agent: any) => [agent.tab_id, agent.workspace_id]), [[moved.tab_id, to]]);
    assert.equal(after.workspaces.find((workspace: any) => workspace.workspace_id === from).active_tab_id, `${from}:t2`, "the workspace left behind opens its other tab");
    assert.deepEqual([after.focused_pane_id, after.focused_tab_id, after.focused_workspace_id], [moved.pane_id, moved.tab_id, to], "herdr's focus goes with the pane");
    assert.equal(after.tabs.find((tab: any) => tab.tab_id === moved.tab_id).label, "move-from", "a named tab keeps its name");

    // a name herdr gave by the tab's place stays behind: its place in the new workspace names it
    // (the fixtures' tabs carry that name as their label, as herdr reports it)
    await post("/api/tab/create", { workspace_id: from, label: "2" });
    const unnamed = (await session()).tabs.filter((tab: any) => tab.workspace_id === from).at(-1).tab_id as string;
    const placed = await post("/api/tab/move-to-workspace", { tab_id: unnamed, workspace_id: to });
    assert.equal((await session()).tabs.find((tab: any) => tab.tab_id === placed.tab_id).label, "3");
    const before3 = (await session()).tabs.filter((tab: any) => tab.workspace_id === to);
    await post("/api/tab/close", { tab_id: before3[0].tab_id });
    assert.equal((await session()).tabs.find((tab: any) => tab.tab_id === placed.tab_id).label, "2");

    await post("/api/tab/move-to-workspace", { tab_id: `${from}:t2`, workspace_id: to });
    const emptied = await session();
    consistent(emptied);
    assert.equal(emptied.workspaces.some((workspace: any) => workspace.workspace_id === from), false);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});

it("the demo reads a resumed session from an agent's own resume flag, never from other launch arguments", async () => {
  const saved = new Map(["window", "location", "PushManager"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    const storage = new Map<string, string>();
    (globalThis as any).location = new URL("http://demo.test/demo/app/");
    (globalThis as any).window = {
      fetch, WebSocket, EventSource: class {},
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    };
    const transport = "../site/demo/transport.ts?resume";
    await import(transport);
    const demo = (globalThis as any).window;
    const post = async (url: string, body: unknown) => (await demo.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    const workspace = (await post("/api/workspace/create", { cwd: "/home/demo/resume-check", label: "resume-check" })).workspace_id as string;
    const session = async (kind: string, args: string[]) => {
      const made = await post("/api/tab/create", { workspace_id: workspace, agent: { kind, args } });
      return (await (await demo.fetch("/api/session")).json()).snapshot.panes.find((pane: any) => pane.pane_id === made.pane_id).agent_session;
    };
    const resumeArgs = async (agent: string) => {
      const rows = (await (await demo.fetch(`/api/sessions/history?workspace_id=${encodeURIComponent(workspace)}&agent=${agent}`)).json()).sessions;
      return { id: rows[0].id as string, args: (rows[0].resume.argv as string[]).slice(1) };
    };

    assert.equal(await session("claude", ["--settings", "{\"ultracode\":true}"]), null, "Ultracode's settings object is no session id");
    assert.equal(await session("claude", ["--effort", "high"]), null, "nor is an effort level");
    const claude = await resumeArgs("claude");
    assert.deepEqual(claude.args, ["--resume", claude.id]);
    assert.equal((await session("claude", claude.args))?.value, claude.id);
    const codex = await resumeArgs("codex");
    assert.deepEqual(codex.args, ["resume", codex.id]);
    assert.equal((await session("codex", codex.args))?.value, codex.id);
    assert.equal(await session("codex", claude.args), null);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as any)[key];
    }
  }
});
