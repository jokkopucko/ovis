import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, StrictMode } from "react";
import { openPage, type Page } from "./page.fixture.ts";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { useRepositoryWorkspaces, worktreesStartHere } from "./repositoryWorkspaces.ts";

const unmarked = (id: string): WorkspaceInfo => ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false, worktree: null });
const snapshot = { protocol: 22, version: "test", agents: [], workspaces: [unmarked("w1"), unmarked("w2")], tabs: [], panes: [] } as unknown as SessionSnapshot;
const herdr = (lifetime: string): SessionSnapshot => ({ ...snapshot, herdr_lifetime: lifetime });
const closed = () => new ApiError("worktree/list", 404, "herdr closed the connection before answering worktree.list", "closed");

describe("useRepositoryWorkspaces", () => {
  let page: Page;
  let shown: ReadonlySet<string> = new Set();
  let drawn: { lifetime: string | undefined; shown: string[]; startsWorktrees: boolean }[] = [];
  let pending: { id: string; answer: () => void; refuse: (error: unknown) => void }[] = [];
  const listWorktrees = (id: string) => new Promise<unknown>((resolve, reject) => { pending.push({ id, answer: () => resolve({ worktrees: [] }), refuse: reject }); });
  const answer = async (only?: string) => {
    const now = pending.filter((question) => only === undefined || question.id === only);
    pending = pending.filter((question) => !now.includes(question));
    await act(async () => { for (const question of now) question.answer(); for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });
  };
  const answerAll = () => answer();
  const refuse = async (id: string, error: unknown) => {
    const now = pending.filter((question) => question.id === id);
    pending = pending.filter((question) => !now.includes(question));
    await act(async () => { for (const question of now) question.refuse(error); for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });
  };
  const asked = () => pending.map((question) => question.id).sort();

  function Reader({ online, roster = snapshot }: { online: boolean; roster?: SessionSnapshot }) {
    shown = useRepositoryWorkspaces({ machineId: "pc", snapshot: roster, online, watching: false, offered: true, listWorktrees }).repositoryWorkspaces;
    drawn.push({ lifetime: roster.herdr_lifetime, shown: [...shown].sort(), startsWorktrees: worktreesStartHere("pc", unmarked("w2"), roster.herdr_lifetime) });
    return null;
  }

  function Readers({ count }: { count: number }) {
    return <>{Array.from({ length: count }, (_, index) => <Reader key={index} online />)}</>;
  }

  beforeEach(() => {
    page = openPage();
    shown = new Set();
    drawn = [];
    pending = [];
  });

  afterEach(async () => { await page.close(); });

  it("keeps the answer under StrictMode, whose remount drops the first mount's question", async () => {
    await page.render(<StrictMode><Reader online /></StrictMode>);
    await answerAll();
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("keeps the answer when the PC comes back while the question before it is still out", async () => {
    await page.render(<Reader online />);
    await answer("w1");
    await page.render(<Reader online={false} />);
    await page.render(<Reader online />);
    await answerAll();
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("shows each answer as it comes, while another question is still out", async () => {
    await page.render(<Reader online />);
    await answer("w1");
    expect([...shown]).toEqual(["w1"]);
  });

  it("asks again after a connection herdr closed before answering, which is no refusal", async () => {
    await page.render(<Reader online />);
    await answer("w2");
    await refuse("w1", new ApiError("worktree/list", 404, "herdr closed the connection before answering worktree.list", "closed"));
    const more = { ...snapshot, workspaces: [...snapshot.workspaces, unmarked("w3")] } as SessionSnapshot;
    await page.render(<Reader online roster={more} />);
    expect(asked()).toEqual(["w1", "w3"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("asks again when another herdr answers for the PC, whose workspaces may reuse the ids", async () => {
    const first = { ...snapshot, herdr_lifetime: "a" } as SessionSnapshot;
    await page.render(<Reader online roster={first} />);
    await answer("w2");
    await refuse("w1", new ApiError("worktree/list", 404, "not in a git worktree", "not_git_worktree"));
    expect([...shown]).toEqual(["w2"]);
    await page.render(<Reader online roster={{ ...snapshot, herdr_lifetime: "b" } as SessionSnapshot} />);
    expect(asked()).toEqual(["w1", "w2"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("shows none of the last herdr's answers in the first render of another herdr's snapshot", async () => {
    await page.render(<Reader online roster={herdr("a")} />);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
    drawn = [];
    await page.render(<Reader online roster={herdr("b")} />);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter((render) => render.lifetime !== "b")).toEqual([]);
    expect(drawn.flatMap((render) => render.shown)).toEqual([]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("starts no worktree from the last herdr's answer in a workspace of another herdr's snapshot", async () => {
    await page.render(<Reader online roster={herdr("a")} />);
    await answerAll();
    expect(worktreesStartHere("pc", unmarked("w2"), "a")).toBe(true);
    drawn = [];
    await page.render(<Reader online roster={herdr("b")} />);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter((render) => render.startsWorktrees)).toEqual([]);
    expect(worktreesStartHere("pc", unmarked("w2"), "b")).toBe(false);
    await answerAll();
    expect(worktreesStartHere("pc", unmarked("w2"), "b")).toBe(true);
    expect(worktreesStartHere("pc", unmarked("w2"), "a")).toBe(false);
  });

  it("shows a workspace a snapshot names twice once, and settles", async () => {
    const twice = { ...snapshot, workspaces: [unmarked("w1"), unmarked("w1"), unmarked("w2")] } as unknown as SessionSnapshot;
    await page.render(<Reader online roster={twice} />);
    expect(asked()).toEqual(["w1", "w2"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
    const renders = drawn.length;
    await page.render(<Reader online roster={twice} />);
    expect(drawn.length).toBe(renders + 1);
  });

  it("does not ask a failed question again when the workspaces only change places", async () => {
    await page.render(<Reader online />);
    await answer("w2");
    await refuse("w1", closed());
    const reordered = { ...snapshot, workspaces: [unmarked("w2"), unmarked("w1")] } as SessionSnapshot;
    await page.render(<Reader online roster={reordered} />);
    expect(asked()).toEqual([]);
    expect([...shown]).toEqual(["w2"]);
  });

  it("does not ask a failed question again when another reader of the PC mounts", async () => {
    await page.render(<Readers count={1} />);
    await answer("w2");
    await refuse("w1", closed());
    await page.render(<Readers count={2} />);
    expect(asked()).toEqual([]);
    expect([...shown]).toEqual(["w2"]);
  });

  it("asks a failed question again when the PC comes back, and when another herdr answers for it", async () => {
    await page.render(<Reader online roster={herdr("a")} />);
    await answer("w2");
    await refuse("w1", closed());
    await page.render(<Reader online={false} roster={herdr("a")} />);
    await page.render(<Reader online roster={herdr("a")} />);
    expect(asked()).toEqual(["w1", "w2"]);
    await answer("w2");
    await refuse("w1", closed());
    await page.render(<Reader online roster={herdr("b")} />);
    expect(asked()).toEqual(["w1", "w2"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("asks again when the PC comes back, though a question it was asked before it left failed meanwhile", async () => {
    await page.render(<Reader online />);
    await answer("w2");
    await page.render(<Reader online={false} />);
    await refuse("w1", closed());
    await page.render(<Reader online />);
    expect(asked()).toEqual(["w1", "w2"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });
});
