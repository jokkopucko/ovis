import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { useRepositoryWorkspaces, worktreesStartHere } from "./repositoryWorkspaces.ts";

const unmarked = (id: string): WorkspaceInfo => ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false, worktree: null });
const snapshot = { protocol: 22, version: "test", agents: [], workspaces: [unmarked("w1"), unmarked("w2")], tabs: [], panes: [] } as unknown as SessionSnapshot;
const herdr = (lifetime: string): SessionSnapshot => ({ ...snapshot, herdr_lifetime: lifetime });
// herdr's connection closing before it answered: the question failed, and nothing was refused
const closed = () => new ApiError("worktree/list", 404, "herdr closed the connection before answering worktree.list", "closed");

describe("useRepositoryWorkspaces", () => {
  let renderer: ReactTestRenderer | undefined;
  let shown: ReadonlySet<string> = new Set();
  // what each render returned, with the herdr its snapshot is of: a render comes before any effect of it
  let drawn: { lifetime: string | undefined; shown: string[]; startsWorktrees: boolean }[] = [];
  let pending: { id: string; answer: () => void; refuse: (error: unknown) => void }[] = [];
  let descriptor: PropertyDescriptor | undefined;
  // each question waits until the test answers it: git answers for both folders
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

  // several readers of the one PC, as the sidebar's roster and the palette are
  function Readers({ count }: { count: number }) {
    return <>{Array.from({ length: count }, (_, index) => <Reader key={index} online />)}</>;
  }

  beforeEach(() => {
    descriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    shown = new Set();
    drawn = [];
    pending = [];
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    if (descriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", descriptor);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps the answer under StrictMode, whose remount drops the first mount's question", async () => {
    await act(async () => { renderer = create(<StrictMode><Reader online /></StrictMode>); });
    await answerAll();
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("keeps the answer when the PC comes back while the question before it is still out", async () => {
    await act(async () => { renderer = create(<Reader online />); });
    await answer("w1");
    await act(async () => { renderer!.update(<Reader online={false} />); });
    await act(async () => { renderer!.update(<Reader online />); });
    await answerAll();
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("shows each answer as it comes, while another question is still out", async () => {
    await act(async () => { renderer = create(<Reader online />); });
    await answer("w1");
    expect([...shown]).toEqual(["w1"]);
  });

  it("asks again after a connection herdr closed before answering, which is no refusal", async () => {
    await act(async () => { renderer = create(<Reader online />); });
    await answer("w2");
    await refuse("w1", new ApiError("worktree/list", 404, "herdr closed the connection before answering worktree.list", "closed"));
    const more = { ...snapshot, workspaces: [...snapshot.workspaces, unmarked("w3")] } as SessionSnapshot;
    await act(async () => { renderer!.update(<Reader online roster={more} />); });
    expect(asked()).toEqual(["w1", "w3"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2", "w3"]);
  });

  it("asks again when another herdr answers for the PC, whose workspaces may reuse the ids", async () => {
    const first = { ...snapshot, herdr_lifetime: "a" } as SessionSnapshot;
    await act(async () => { renderer = create(<Reader online roster={first} />); });
    await answer("w2");
    await refuse("w1", new ApiError("worktree/list", 404, "not in a git worktree", "not_git_worktree"));
    expect([...shown]).toEqual(["w2"]);
    await act(async () => { renderer!.update(<Reader online roster={{ ...snapshot, herdr_lifetime: "b" } as SessionSnapshot} />); });
    expect(asked()).toEqual(["w1", "w2"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("shows none of the last herdr's answers in the first render of another herdr's snapshot", async () => {
    await act(async () => { renderer = create(<Reader online roster={herdr("a")} />); });
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
    drawn = [];
    await act(async () => { renderer!.update(<Reader online roster={herdr("b")} />); });
    // the new herdr has answered nothing yet, and its w2 may be another folder: no render of its
    // snapshot shows an answer, the one before the effect that drops the old answers included
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter((render) => render.lifetime !== "b")).toEqual([]);
    expect(drawn.flatMap((render) => render.shown)).toEqual([]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("starts no worktree from the last herdr's answer in a workspace of another herdr's snapshot", async () => {
    await act(async () => { renderer = create(<Reader online roster={herdr("a")} />); });
    await answerAll();
    expect(worktreesStartHere("pc", unmarked("w2"), "a")).toBe(true);
    drawn = [];
    await act(async () => { renderer!.update(<Reader online roster={herdr("b")} />); });
    // as App's Open worktree action asks, from the render that first has the new snapshot on
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter((render) => render.startsWorktrees)).toEqual([]);
    expect(worktreesStartHere("pc", unmarked("w2"), "b")).toBe(false);
    await answerAll();
    expect(worktreesStartHere("pc", unmarked("w2"), "b")).toBe(true);
    expect(worktreesStartHere("pc", unmarked("w2"), "a")).toBe(false);
  });

  it("shows a workspace a snapshot names twice once, and settles", async () => {
    const twice = { ...snapshot, workspaces: [unmarked("w1"), unmarked("w1"), unmarked("w2")] } as unknown as SessionSnapshot;
    await act(async () => { renderer = create(<Reader online roster={twice} />); });
    expect(asked()).toEqual(["w1", "w2"]);
    // the set drawn stays the same object while its ids do: a longer list of the same ids is no other set
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
    const renders = drawn.length;
    await act(async () => { renderer!.update(<Reader online roster={twice} />); });
    expect(drawn.length).toBe(renders + 1);
  });

  it("does not ask a failed question again when the workspaces only change places", async () => {
    await act(async () => { renderer = create(<Reader online />); });
    await answer("w2");
    await refuse("w1", closed());
    const reordered = { ...snapshot, workspaces: [unmarked("w2"), unmarked("w1")] } as SessionSnapshot;
    await act(async () => { renderer!.update(<Reader online roster={reordered} />); });
    expect(asked()).toEqual([]);
    expect([...shown]).toEqual(["w2"]);
  });

  it("does not ask a failed question again when another reader of the PC mounts", async () => {
    await act(async () => { renderer = create(<Readers count={1} />); });
    await answer("w2");
    await refuse("w1", closed());
    await act(async () => { renderer!.update(<Readers count={2} />); });
    expect(asked()).toEqual([]);
    expect([...shown]).toEqual(["w2"]);
  });

  it("asks a failed question again when the PC comes back, and when another herdr answers for it", async () => {
    await act(async () => { renderer = create(<Reader online roster={herdr("a")} />); });
    await answer("w2");
    await refuse("w1", closed());
    await act(async () => { renderer!.update(<Reader online={false} roster={herdr("a")} />); });
    await act(async () => { renderer!.update(<Reader online roster={herdr("a")} />); });
    expect(asked()).toEqual(["w1", "w2"]);
    await answer("w2");
    await refuse("w1", closed());
    await act(async () => { renderer!.update(<Reader online roster={herdr("b")} />); });
    expect(asked()).toEqual(["w1", "w2"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });

  it("asks again when the PC comes back, though a question it was asked before it left failed meanwhile", async () => {
    await act(async () => { renderer = create(<Reader online />); });
    await answer("w2");
    await act(async () => { renderer!.update(<Reader online={false} />); });
    // the round that asked it is over: its failure says nothing of the next round's question
    await refuse("w1", closed());
    await act(async () => { renderer!.update(<Reader online />); });
    expect(asked()).toEqual(["w1", "w2"]);
    await answerAll();
    expect([...shown].sort()).toEqual(["w1", "w2"]);
  });
});
