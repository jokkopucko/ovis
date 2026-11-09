import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { ApiError } from "./api.ts";
import { useRepositoryWorkspaces } from "./repositoryWorkspaces.ts";

const unmarked = (id: string): WorkspaceInfo => ({ workspace_id: id, label: id, active_tab_id: `${id}:t1`, number: 1, pane_count: 1, tab_count: 1, agent_status: "idle", focused: false, worktree: null });
const snapshot = { protocol: 22, version: "test", agents: [], workspaces: [unmarked("w1"), unmarked("w2")], tabs: [], panes: [] } as unknown as SessionSnapshot;

describe("useRepositoryWorkspaces", () => {
  let renderer: ReactTestRenderer | undefined;
  let shown: ReadonlySet<string> = new Set();
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
    return null;
  }

  beforeEach(() => {
    descriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    shown = new Set();
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
});
