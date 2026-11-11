import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { PendingMessage, ServerMessage } from "../shared/protocol.ts";
import { MAX_INVENTORY_WORKSPACES } from "../shared/workspace-lifecycle.ts";
import * as agentLaunchModule from "./agent-launch.ts";
import * as directories from "./directories.ts";
import * as herdr from "./herdr/client.ts";
import { handleWorkspaceRequest, INVENTORY_BUDGET_MS, MAX_ENV_BYTES, MAX_ENV_VARS } from "./workspace-routes.ts";

/** each herdr create, launch, queued message and broadcast a create makes, in the order made */
const calls: string[] = [];
const made = (workspace: string) => ({ workspace: { workspace_id: workspace }, tab: { workspace_id: workspace, tab_id: `${workspace}:t1` }, root_pane: { pane_id: `${workspace}:p1` } });
// no herdr answers here: the create calls stand in for it, and the launch starts nothing
beforeEach(() => {
  calls.length = 0;
  spyOn(herdr, "tabCreate").mockImplementation(async () => { calls.push("tab.create"); return made("w1") as never; });
  spyOn(herdr, "workspaceCreate").mockImplementation(async () => { calls.push("workspace.create"); return made("w2") as never; });
  spyOn(herdr, "worktreeCreate").mockImplementation(async () => { calls.push("worktree.create"); return { ...made("w3"), worktree: { path: "/repo-feature", branch: "feature" } } as never; });
  spyOn(agentLaunchModule, "agentLaunch").mockImplementation(async () => { await Promise.resolve(); calls.push("launch"); return { agent_started: true }; });
});
afterEach(() => mock.restore());

async function post(path: string, body: unknown): Promise<Response> {
  const request = new Request(`http://127.0.0.1${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const queue = async (): Promise<PendingMessage> => { await Promise.resolve(); calls.push("queue"); return { id: "m1" } as PendingMessage; };
  const response = await handleWorkspaceRequest(request, new URL(request.url), path, { timeout: () => {} },
    (message: ServerMessage) => { calls.push(message.type); }, queue, () => ({ order_epoch: "e", moved_seq: 1 }));
  calls.push("answer");
  return response!;
}

describe("GET /api/worktree/inventory reads several workspaces' checkouts in one request (#2661)", () => {
  async function inventory(ids: string[]): Promise<Response> {
    const request = new Request(`http://127.0.0.1/api/worktree/inventory?${ids.map((id) => `workspace_id=${encodeURIComponent(id)}`).join("&")}`);
    const response = await handleWorkspaceRequest(request, new URL(request.url), "/api/worktree/inventory", { timeout: () => {} },
      () => {}, async () => ({ id: "m1" }) as PendingMessage, () => ({ order_epoch: "e", moved_seq: 1 }));
    return response!;
  }

  it("answers each workspace once, in the order asked, with the error /api/worktree/list would have answered", async () => {
    const list = spyOn(herdr, "worktreeList").mockImplementation(async (workspaceId) => {
      if (workspaceId === "w2") throw new herdr.HerdrError("not_git_worktree", "w2 is not a git checkout");
      if (workspaceId === "w3") throw new herdr.HerdrError("timeout", "herdr did not answer");
      return { source: { repo_key: workspaceId }, worktrees: [] } as never;
    });
    const response = await inventory(["w1", "w2", "w3", "w1"]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [
      { workspace_id: "w1", listing: { source: { repo_key: "w1" }, worktrees: [] } },
      { workspace_id: "w2", error: { status: 404, code: "not_git_worktree", message: "w2 is not a git checkout" } },
      { workspace_id: "w3", error: { status: 502, code: "timeout", message: "herdr did not answer" } },
    ] });
    expect(list.mock.calls.map(([workspaceId]) => workspaceId).sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("stops asking herdr once the read's budget is spent, answering the rest as timed out", async () => {
    let now = 1_000_000;
    spyOn(Date, "now").mockImplementation(() => now);
    // a herdr that answers, slowly: each call takes most of the budget
    const list = spyOn(herdr, "worktreeList").mockImplementation(async (workspaceId) => { now += INVENTORY_BUDGET_MS * 0.6; return { source: { repo_key: workspaceId }, worktrees: [] } as never; });
    const body = (await (await inventory(["w1", "w2", "w3"])).json()) as { entries: { workspace_id: string; listing?: unknown; error?: { status: number; code: string } }[] };
    expect(body.entries.map((entry) => [entry.workspace_id, entry.listing ? "listing" : `${entry.error?.status} ${entry.error?.code}`])).toEqual([["w1", "listing"], ["w2", "listing"], ["w3", "502 timeout"]]);
    expect(list.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(["w1", "w2"]);
  });

  it.each([
    ["no workspace", [], "missing_workspace_id"],
    ["an empty workspace id", ["w1", ""], "missing_workspace_id"],
    ["more workspaces than the limit", Array.from({ length: MAX_INVENTORY_WORKSPACES + 1 }, (_, at) => `w${at}`), "too_many_workspaces"],
  ])("refuses %s with 400 before herdr is asked", async (_, ids, code) => {
    const list = spyOn(herdr, "worktreeList");
    const response = await inventory(ids);
    expect([response.status, ((await response.json()) as { error: { code: string } }).error.code]).toEqual([400, code]);
    expect(list).not.toHaveBeenCalled();
  });
});

describe("a create passes the request's env to the new pane (#2745)", () => {
  /** what each herdr create was asked for */
  const asked = () => [herdr.tabCreate, herdr.workspaceCreate].flatMap((create) => (create as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0]));

  it.each([
    ["/api/tab/create", { workspace_id: "w1" }],
    ["/api/workspace/create", {}],
  ] as const)("%s hands env to herdr, and leaves it out when null or absent", async (path, base) => {
    expect((await post(path, { ...base, env: { API_URL: "http://localhost:3000", _Key2: "" } })).status).toBe(200);
    expect((await post(path, { ...base, env: null })).status).toBe(200);
    expect((await post(path, base)).status).toBe(200);
    expect(asked().map((options) => (options as { env?: unknown }).env)).toEqual([{ API_URL: "http://localhost:3000", _Key2: "" }, undefined, undefined]);
  });

  const many = Object.fromEntries(Array.from({ length: MAX_ENV_VARS + 1 }, (_, at) => [`V${at}`, "x"]));
  it.each([
    ["an array", ["A=1"]],
    ["a string", "A=1"],
    ["a name that starts with a digit", { "1A": "x" }],
    ["a name with a dash", { "A-B": "x" }],
    ["a name with =", { "A=B": "x" }],
    ["an empty name", { "": "x" }],
    ["a value that is no string", { A: 1 }],
    ["a value with a line break", { A: "one\ntwo" }],
    ["a value with an escape", { A: "\u001b[31m" }],
    ["a value with a NUL", { A: "a\u0000b" }],
    ["too many names", many],
    ["too many bytes", { BIG: "x".repeat(MAX_ENV_BYTES) }],
  ])("refuses %s with 400 invalid_env before herdr makes anything", async (_, env) => {
    for (const [path, base] of [["/api/tab/create", { workspace_id: "w1" }], ["/api/workspace/create", {}]] as const) {
      const response = await post(path, { ...base, env });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_env");
    }
    expect(asked()).toEqual([]);
  });

  it("takes exactly the limits", async () => {
    const most = Object.fromEntries(Array.from({ length: MAX_ENV_VARS }, (_, at) => [`V${at}`, "x"]));
    expect((await post("/api/workspace/create", { env: most })).status).toBe(200);
    expect((await post("/api/workspace/create", { env: { BIG: "x".repeat(MAX_ENV_BYTES - 3) } })).status).toBe(200);
  });
});

describe("a create answers after the roster is told", () => {
  // the page draws a new pane only once the roster lists it: without this push, the roster is read
  // only after the collector's debounced pane.created, about 500 ms after herdr made the pane
  it.each([
    ["/api/tab/create", { workspace_id: "w1" }, ["tab.create", "session-changed", "answer"]],
    ["/api/tab/create", { workspace_id: "w1", agent: { kind: "claude" } }, ["tab.create", "launch", "session-changed", "answer"]],
    ["/api/tab/create", { workspace_id: "w1", agent: { kind: "claude" }, first_message: "hello" }, ["tab.create", "launch", "queue", "session-changed", "answer"]],
    ["/api/workspace/create", {}, ["workspace.create", "session-changed", "answer"]],
    ["/api/workspace/create", { agent: { kind: "claude" } }, ["workspace.create", "launch", "session-changed", "answer"]],
    ["/api/worktree/create", { workspace_id: "w1", branch: "feature" }, ["worktree.create", "session-changed", "answer"]],
    ["/api/worktree/create", { workspace_id: "w1", branch: "feature", agent: { kind: "claude" } }, ["worktree.create", "launch", "session-changed", "answer"]],
  ] as const)("%s %j", async (path, body, order) => {
    const response = await post(path, body);
    expect(response.status).toBe(200);
    // once, and after the launch: a roster read beside the launch's own herdr calls slows both
    expect(calls).toEqual([...order]);
  });
});

describe("a folder a workspace route is given", () => {
  it("is taken as chosen for a create request, and read with its pane's own folder for a repository route", async () => {
    // the share rule (directories.ts expandedPath) refuses another host's share on a Windows PC unless the folder was
    // chosen, or is on the share its pane works on
    const expanded = spyOn(directories, "expandedDirectory").mockImplementation((value, own) => own === "chosen" ? value : null);
    for (const path of ["/api/workspace/create", "/api/tab/create"]) {
      await post(path, { ...(path === "/api/tab/create" ? { workspace_id: "w1" } : {}), cwd: "//nas/work/proj", label: "x", agent: null });
    }
    expect(expanded.mock.calls).toEqual([["//nas/work/proj", "chosen"], ["//nas/work/proj", "chosen"]]);
    expanded.mockClear();
    spyOn(herdr, "paneGet").mockResolvedValue({ pane_id: "p", cwd: "/work/repo" } as never);
    for (const [directory, asked] of [["sub", "/work/repo/sub"], ["/elsewhere", "/elsewhere"]] as const) {
      const url = new URL(`http://127.0.0.1/api/workspace/diff/files?pane_id=p&directory=${encodeURIComponent(directory)}`);
      const response = await handleWorkspaceRequest(new Request(url), url, "/api/workspace/diff/files", { timeout: () => {} },
        () => {}, async () => ({ id: "m1" }) as PendingMessage, () => ({ order_epoch: "e", moved_seq: 1 }));
      expect(((await response!.json()) as { error: { code: string } }).error.code, directory).toBe("invalid_cwd");
      expect(expanded.mock.calls.at(-1), directory).toEqual([asked, ["/work/repo"]]);
    }
  });
});
