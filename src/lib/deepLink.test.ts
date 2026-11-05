import { describe, expect, it } from "bun:test";

import { fileFromLink, isNavigation, linkSearch, linksSomewhere, readLink, resolveLink, slugOf, workspacePane } from "./deepLink.ts";

describe("deep links", () => {
  it("keeps an absolute file on its PC without requiring a live pane", () => {
    for (const file of ["/tmp/한글 #1 & notes.MD", "C:\\docs\\notes.markdown"]) {
      const link = { machine: "remote-box", workspace: null, pane: null, view: null, file, settings: null };
      expect(readLink(linkSearch(link))).toMatchObject(link);
      expect(fileFromLink(link)).toBe(file);
    }
    expect(linkSearch({ machine: "local", workspace: null, pane: null, view: null, file: "relative.md", settings: null })).toBe("");
    expect(fileFromLink({ pane: null, file: "relative.md" })).toBeNull();
    expect(fileFromLink({ pane: "w1:p1", file: "relative.md" })).toBe("relative.md");
  });
  it("reads every place an address can name, with the local PC by default", () => {
    expect(readLink("?ws=w2&pane=w2%3Ap1&view=chat&settings=appearance")).toEqual({ machine: "local", workspace: "w2", workspaceSlug: null, pane: "w2:p1", view: "chat", file: null, settings: "appearance", section: null, create: null, sidebar: null });
    expect(readLink("?machine=box&pane=w1:p3")).toMatchObject({ machine: "box", pane: "w1:p3", workspace: null, view: null });
    expect(readLink("?view=sideways&pane=%20%20")).toMatchObject({ view: null, pane: null });
    expect(readLink("")).toEqual({ machine: "local", workspace: null, workspaceSlug: null, pane: null, view: null, file: null, settings: null, section: null, create: null, sidebar: null });
  });

  it("writes the shortest address, keeps what is not its own, and reads back what it wrote", () => {
    const link = { machine: "local", workspace: "w2", workspaceSlug: null, pane: "w2:p1", view: "terminal" as const, file: null, settings: null, section: null, create: null, sidebar: null };
    expect(linkSearch(link)).toBe("?ws=w2&pane=w2%3Ap1&view=terminal");
    expect(readLink(linkSearch(link))).toEqual(link);
    expect(linkSearch({ ...link, machine: "box" }, "?debug=1&pane=old")).toBe("?debug=1&machine=box&ws=w2&pane=w2%3Ap1&view=terminal");
    // a lens means nothing without a pane; nothing to say is no query at all
    expect(linkSearch({ machine: "local", workspace: null, pane: null, view: "chat", settings: null })).toBe("");
    expect(linkSearch({ machine: "local", workspace: null, pane: null, view: null, settings: "about" })).toBe("?settings=about");
  });

  it("lands a link to the pages Agents replaced on Agents, keeping the group it names", () => {
    expect(readLink("?settings=usage&section=accounts-claude")).toMatchObject({ settings: "agents", section: "accounts-claude" });
    expect(readLink("?settings=integrations&section=guide")).toMatchObject({ settings: "agents", section: "guide" });
    expect(readLink("?settings=chat")).toMatchObject({ settings: "chat" });
  });

  it("tells an address that names a place from the app's plain start", () => {
    expect(linksSomewhere("?pane=w1:p1")).toBe(true);
    expect(linksSomewhere("?settings=chat")).toBe(true);
    expect(linksSomewhere("?pair=ABC")).toBe(false);
    expect(linksSomewhere("")).toBe(false);
  });

  it("opens the pane a workspace's row opens: in front in its active tab, then focused, then first", () => {
    const panes = [
      { pane_id: "w2:p1", workspace_id: "w2", focused: false },
      { pane_id: "w2:p2", workspace_id: "w2", focused: true },
      { pane_id: "w2:p3", workspace_id: "w2", focused: false },
      { pane_id: "w3:p1", workspace_id: "w3", focused: false },
    ];
    const workspaces = [{ workspace_id: "w2", active_tab_id: "w2:t2" }, { workspace_id: "w3", active_tab_id: "w3:t1" }];
    const snapshot = (layouts: unknown[]) => ({ workspaces, panes, layouts }) as never;
    expect(workspacePane(snapshot([{ tab_id: "w2:t2", focused_pane_id: "w2:p3" }]), "w2")).toBe("w2:p3");
    expect(workspacePane(snapshot([]), "w2")).toBe("w2:p2");
    expect(workspacePane(snapshot([]), "w3")).toBe("w3:p1");
    expect(workspacePane(snapshot([]), "gone")).toBeNull();
  });

  it("keeps a history entry for a move to another pane or PC, not for staying put", () => {
    expect(isNavigation({ machine: "local", pane: "a" }, { machine: "local", pane: "b" })).toBe(true);
    expect(isNavigation({ machine: "local", pane: "a" }, { machine: "box", pane: "a" })).toBe(true);
    expect(isNavigation({ machine: "local", pane: "a" }, { machine: "local", pane: "a" })).toBe(false);
    expect(isNavigation({ machine: "local", pane: "a" }, { machine: "local", pane: null })).toBe(false);
  });
});

describe("workspace slugs", () => {
  it("makes a short, readable slug from a workspace's name, cut at a word", () => {
    expect(slugOf("HERDR WEB UI")).toBe("herdr-web-ui");
    expect(slugOf("Crème brûlée: v2!")).toBe("creme-brulee-v2");
    expect(slugOf("FRG-845 CLOUDFLARE CUSTOM CHALLENGES")).toBe("frg-845-cloudflare");
    expect(slugOf("supercalifragilisticexpialidocious")).toBe("supercalifragilisticexpi");
    expect(slugOf("한국어 작업")).toBe("");
    expect(slugOf(null)).toBe("");
  });

  it("writes and reads the id and the slug as one ws value", () => {
    const link = { machine: "local", workspace: "w2K", workspaceSlug: "herdr-web-ui", pane: "w2K:p1", view: "chat" as const, file: null, settings: null, section: null, create: null, sidebar: null };
    expect(linkSearch(link)).toBe("?ws=w2K-herdr-web-ui&pane=w2K%3Ap1&view=chat");
    expect(readLink(linkSearch(link))).toEqual(link);
    expect(readLink("?ws=w2K")).toMatchObject({ workspace: "w2K", workspaceSlug: null });
  });

  it("carries a file over its pane and a section on its Settings page, and nothing without them", () => {
    const base = { machine: "local", workspace: "w2", workspaceSlug: null, pane: "w2:p1", view: null, file: "src/App.tsx", settings: "about", section: "updates" };
    expect(linkSearch(base)).toBe("?ws=w2&pane=w2%3Ap1&file=src%2FApp.tsx&settings=about&section=updates");
    expect(readLink(linkSearch(base))).toMatchObject({ file: "src/App.tsx", section: "updates" });
    expect(linkSearch({ ...base, pane: null, settings: null })).toBe("?ws=w2");
    expect(readLink("?section=updates").section).toBeNull();
  });
});

describe("resolving a link", () => {
  const roster = (workspaces: Array<[string, string]>, panes: Array<[string, string]>) => ({
    workspaces: workspaces.map(([workspace_id, label]) => ({ workspace_id, label, active_tab_id: `${workspace_id}:t1` })),
    panes: panes.map(([pane_id, workspace_id]) => ({ pane_id, workspace_id, focused: false })),
    layouts: [],
  }) as never;
  const two = roster([["w2", "HERDR WEB UI"], ["w3", "Billing"]], [["w2:p1", "w2"], ["w2:p2", "w2"], ["w3:p1", "w3"]]);

  it("opens the linked pane when it is still in the linked workspace", () => {
    expect(resolveLink(two, { workspace: "w2", workspaceSlug: "herdr-web-ui", pane: "w2:p2" })).toEqual({ pane: "w2:p2", workspace: "w2", note: null });
    // a renamed workspace keeps its links: no other workspace has the old slug
    expect(resolveLink(two, { workspace: "w3", workspaceSlug: "old-name", pane: "w3:p1" })).toEqual({ pane: "w3:p1", workspace: "w3", note: null });
  });

  it("opens the workspace's pane, with a note, when the linked pane has closed", () => {
    expect(resolveLink(two, { workspace: "w2", workspaceSlug: null, pane: "w2:p9" })).toEqual({ pane: "w2:p1", workspace: "w2", note: "pane-closed" });
  });

  it("follows the slug when herdr has handed the id to another workspace", () => {
    const reused = roster([["w2", "Billing"], ["w9", "HERDR WEB UI"]], [["w2:p1", "w2"], ["w9:p1", "w9"]]);
    expect(resolveLink(reused, { workspace: "w2", workspaceSlug: "herdr-web-ui", pane: "w2:p1" })).toEqual({ pane: "w9:p1", workspace: "w9", note: "pane-closed" });
  });

  it("finds a workspace by slug alone, and says so when nothing it names is open", () => {
    expect(resolveLink(two, { workspace: "w7", workspaceSlug: "billing", pane: null })).toEqual({ pane: "w3:p1", workspace: "w3", note: null });
    expect(resolveLink(two, { workspace: "w7", workspaceSlug: "gone", pane: "w7:p1" })).toEqual({ pane: null, workspace: null, note: "workspace-closed" });
    expect(resolveLink(two, { workspace: null, workspaceSlug: null, pane: null })).toEqual({ pane: null, workspace: null, note: null });
  });
});

describe("the New workspace dialog", () => {
  it("reads what a link puts in its fields, and only what a person could type", () => {
    expect(readLink("?new=workspace&cwd=%2Fhome%2Fben%2FLocally&name=VOR-12&agent=claude").create).toEqual({ kind: "workspace", cwd: "/home/ben/Locally", name: "VOR-12", agent: "claude" });
    expect(readLink("?new=tab&ws=w2&agent=shell").create).toEqual({ kind: "tab", cwd: null, name: null, agent: "" });
    expect(readLink(`?new=workspace&name=${"x".repeat(300)}&agent=rm%20-rf%20%2F`).create).toEqual({ kind: "workspace", cwd: null, name: "x".repeat(120), agent: null });
    expect(readLink("?new=window").create).toBeNull();
    expect(readLink("?cwd=%2Ftmp").create).toBeNull();
    expect(linksSomewhere("?new=workspace")).toBe(true);
  });

  it("writes the dialog and its fields, and nothing of it once it is closed", () => {
    const base = { machine: "local", workspace: "w2", workspaceSlug: null, pane: "w2:p1", view: null, file: null, settings: null, section: null };
    const open = { ...base, create: { kind: "workspace" as const, cwd: "/srv/app", name: "Billing fix", agent: "codex" } };
    expect(linkSearch(open)).toBe("?ws=w2&pane=w2%3Ap1&new=workspace&cwd=%2Fsrv%2Fapp&name=Billing+fix&agent=codex");
    expect(readLink(linkSearch(open)).create).toEqual(open.create);
    expect(linkSearch({ ...base, create: { kind: "tab", cwd: null, name: null, agent: "" } })).toBe("?ws=w2&pane=w2%3Ap1&new=tab&agent=shell");
    expect(linkSearch({ ...base, create: null }, "?new=workspace&cwd=%2Fsrv")).toBe("?ws=w2&pane=w2%3Ap1");
  });
});

describe("the sidebar", () => {
  it("reads whether a link opens with the sidebar collapsed or out, in a few spellings", () => {
    for (const value of ["hidden", "hide", "closed", "0"]) expect(readLink(`?sidebar=${value}`).sidebar).toBe("hidden");
    for (const value of ["shown", "show", "open", "1"]) expect(readLink(`?sidebar=${value}`).sidebar).toBe("shown");
    expect(readLink("?sidebar=sideways").sidebar).toBeNull();
    expect(linksSomewhere("?sidebar=hidden")).toBe(true);
  });

  it("writes it beside the place, and nothing when it is as the screen opens it", () => {
    const base = { machine: "local", workspace: "w2", workspaceSlug: null, pane: "w2:p1", view: null, file: null, settings: null, section: null, create: null };
    expect(linkSearch({ ...base, sidebar: "hidden" })).toBe("?ws=w2&pane=w2%3Ap1&sidebar=hidden");
    expect(linkSearch({ ...base, sidebar: null }, "?sidebar=hidden")).toBe("?ws=w2&pane=w2%3Ap1");
  });
});
