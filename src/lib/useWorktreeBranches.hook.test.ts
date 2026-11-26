import { afterEach, beforeEach, describe, expect, it, jest, spyOn } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";
import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { useWorktreeBranches } from "./useWorktreeBranches.ts";
import type { WorkspaceBranch } from "./worktreeBranches.ts";

const repository = { workspace_id: "w1", worktree: { repo_key: "repo", repo_name: "repo", repo_root: "/work/repo", checkout_path: "/work/repo", is_linked_worktree: false } } as WorkspaceInfo;
const snapshot = { workspaces: [repository], tabs: [], panes: [], agents: [] } as unknown as SessionSnapshot;
const other = { workspace_id: "w2", worktree: { repo_key: "other", repo_name: "other", repo_root: "/work/other", checkout_path: "/work/other", is_linked_worktree: false } } as WorkspaceInfo;
const wide = { workspaces: [repository, other, { workspace_id: "w3" } as WorkspaceInfo], tabs: [], panes: [], agents: [] } as unknown as SessionSnapshot;
const listings: Record<string, unknown> = {
  w1: { source: { repo_key: "repo", source_checkout_path: "/work/repo" }, worktrees: [{ path: "/work/repo", branch: "main", is_detached: false, open_workspace_id: "w1" }] },
  w2: { source: { repo_key: "other", source_checkout_path: "/work/other" }, worktrees: [{ path: "/work/other", branch: "dev", is_detached: false, open_workspace_id: "w2" }] },
  w3: { source: { repo_key: "loose", source_checkout_path: "/work/loose" }, worktrees: [{ path: "/work/loose", branch: "spike", is_detached: false, open_workspace_id: null }] },
};

describe("useWorktreeBranches", () => {
  let page: Page;
  let refused = false;
  /** while set, the PC's bridge is from before GET /api/worktree/inventory and answers it as an unknown endpoint */
  let before = false;
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
  const asked = () => fetchSpy.mock.calls.map(([input]) => new URL(String(input), "http://pc"));
  function Probe({ watching = false }: { watching?: boolean }) { useWorktreeBranches(snapshot, true, false, undefined, watching); return null; }
  let shown: ReadonlyMap<string, WorkspaceBranch> = new Map();
  const unmarked = new Set(["w3"]);
  function Wide({ online = true }: { online?: boolean }) { shown = useWorktreeBranches(wide, online, false, unmarked).branches; return null; }
  const words = () => [...shown].map(([id, branch]) => `${id}:${branch.branch}`).sort();
  const settle = async (done: () => boolean) => { for (let turn = 0; turn < 50 && !done(); turn++) await act(async () => { await Promise.resolve(); }); };

  beforeEach(() => {
    page = openPage();
    Object.defineProperty(page.window.document, "visibilityState", { configurable: true, value: "visible" });
    jest.useFakeTimers();
    refused = false;
    before = false;
    shown = new Map();
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: string | URL | Request) => {
      if (refused) return Response.json({ error: { code: "read_only", message: "this device can only watch" } }, { status: 403 });
      const url = new URL(String(input), "http://pc");
      const ids = url.searchParams.getAll("workspace_id");
      if (url.pathname.endsWith("/worktree/inventory")) {
        if (before) return Response.json({ error: { code: "not_found", message: `unknown endpoint ${url.pathname}` } }, { status: 404 });
        return Response.json({ entries: ids.map((id) => ({ workspace_id: id, listing: listings[id] })) });
      }
      return Response.json(listings[ids[0]!]);
    }, { preconnect: globalThis.fetch.preconnect }));
  });
  afterEach(async () => {
    jest.useRealTimers();
    await page.close();
    fetchSpy.mockRestore();
  });

  it("asks a driving device's PC again on its next poll", async () => {
    await page.render(createElement(Probe));
    await settle(() => fetchSpy.mock.calls.length >= 1);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle(() => fetchSpy.mock.calls.length >= 2);
    expect(fetchSpy.mock.calls.length).toBe(2);
  });

  it("does not ask again when the device may only watch (#2250)", async () => {
    refused = true;
    await page.render(createElement(Probe));
    await settle(() => fetchSpy.mock.calls.length >= 1);
    await settle(() => false);
    await act(async () => { jest.advanceTimersByTime(120_000); });
    await settle(() => false);
    expect(fetchSpy.mock.calls.length).toBe(1);
  });

  it("asks nothing while watching, and reads branches once the device may drive (#2250)", async () => {
    await page.render(createElement(Probe, { watching: true }));
    await settle(() => false);
    await act(async () => { jest.advanceTimersByTime(60_000); });
    await settle(() => false);
    expect(fetchSpy.mock.calls.length).toBe(0);
    refused = true;
    await page.render(createElement(Probe, { watching: false }));
    await settle(() => fetchSpy.mock.calls.length >= 1);
    refused = false;
    await page.render(createElement(Probe, { watching: true }));
    await page.render(createElement(Probe, { watching: false }));
    await settle(() => fetchSpy.mock.calls.length >= 2);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle(() => fetchSpy.mock.calls.length >= 3);
    expect(fetchSpy.mock.calls.length).toBe(3);
  });

  it("reads every repository and unmarked git workspace of the PC in one request per poll, each poll starting one further on (#2661)", async () => {
    await page.render(createElement(Wide));
    await settle(() => words().length === 3);
    expect(words()).toEqual(["w1:main", "w2:dev", "w3:spike"]);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle(() => fetchSpy.mock.calls.length >= 2);
    await settle(() => false);
    expect(asked().map((url) => [url.pathname, url.searchParams.getAll("workspace_id")])).toEqual([
      ["/api/worktree/inventory", ["w2", "w1", "w3"]],
      ["/api/worktree/inventory", ["w1", "w3", "w2"]],
    ]);
  });

  it("applies the reads that answered when a later inventory read of the same poll fails (#2661)", async () => {
    const long = "l".repeat(2100);
    listings[long] = listings["w3"];
    const fetched = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(Object.assign(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://pc");
      if (url.searchParams.getAll("workspace_id").includes(long)) return Response.json({ error: { code: "machine_offline", message: "This PC is disconnected" } }, { status: 503 });
      return fetched(input);
    }, { preconnect: globalThis.fetch.preconnect }));
    const twoReads = { ...snapshot, workspaces: [repository, { workspace_id: long } as WorkspaceInfo] } as SessionSnapshot;
    const longUnmarked = new Set([long]);
    function Two() { shown = useWorktreeBranches(twoReads, true, false, longUnmarked).branches; return null; }
    try {
      await page.render(createElement(Two));
      await settle(() => words().length === 1);
      await settle(() => false);
      expect(words()).toEqual(["w1:main"]);
      expect(asked().map((url) => url.pathname)).toEqual(["/api/worktree/inventory", "/api/worktree/inventory"]);
    } finally { delete listings[long]; }
  });

  it("reads a PC from before the inventory one workspace at a time, without asking it for the inventory again (#2661)", async () => {
    before = true;
    await page.render(createElement(Wide));
    await settle(() => words().length === 3);
    expect(words()).toEqual(["w1:main", "w2:dev", "w3:spike"]);
    await act(async () => { jest.advanceTimersByTime(30_000); });
    await settle(() => fetchSpy.mock.calls.length >= 7);
    await settle(() => false);
    expect(asked().map((url) => `${url.pathname.split("/").pop()} ${url.searchParams.getAll("workspace_id").join(",")}`)).toEqual([
      "inventory w2,w1,w3", "list w2", "list w1", "list w3",
      "list w2", "list w1", "list w3",
    ]);
  });

  it("does not let an older bridge's answer that arrives after the PC went offline outlive the reconnect (#2661)", async () => {
    before = true;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetched = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(Object.assign(async (input: string | URL | Request) => {
      const answer = await fetched(input);
      if (fetchSpy.mock.calls.length === 1) await held;
      return answer;
    }, { preconnect: globalThis.fetch.preconnect }));
    await page.render(createElement(Wide));
    await settle(() => fetchSpy.mock.calls.length >= 1);
    await page.render(createElement(Wide, { online: false }));
    await act(async () => { release(); });
    await settle(() => false);
    before = false;
    await page.render(createElement(Wide, { online: true }));
    await settle(() => fetchSpy.mock.calls.length >= 2);
    await settle(() => false);
    expect(asked().map((url) => url.pathname.split("/").pop())).toEqual(["inventory", "inventory"]);
  });

  it("asks a PC that read one workspace at a time for the inventory again once it reconnects, as after an update (#2661)", async () => {
    before = true;
    await page.render(createElement(Wide));
    await settle(() => fetchSpy.mock.calls.length >= 4);
    before = false;
    await page.render(createElement(Wide, { online: false }));
    await page.render(createElement(Wide, { online: true }));
    await settle(() => fetchSpy.mock.calls.length >= 5);
    await settle(() => false);
    expect(asked().map((url) => url.pathname.split("/").pop())).toEqual(["inventory", "list", "list", "list", "inventory"]);
  });
});
