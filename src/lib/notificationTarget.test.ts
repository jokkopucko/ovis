import { describe, expect, it } from "bun:test";
import type { SessionSnapshot } from "../../shared/protocol.ts";
import { resolveLink, type AppLink } from "./deepLink.ts";
import { linkLanding, linkTarget, machineGone, machineMissing, notificationLanding, notificationTargetFromSearch, notificationTargets, notificationViewForPane, sameLink, SELECT_PANE_EVENT, type NotificationTarget } from "./notificationTarget.ts";

function messages() {
  let receive!: (event: MessageEvent) => void;
  const subscribe = notificationTargets({ addEventListener: (_type, listener) => { receive = listener; } });
  return { subscribe, send: (data: unknown) => receive({ data } as MessageEvent) };
}

describe("notification pane delivery", () => {
  it("retains only the newest exact PC and pane while the app is starting", () => {
    const source = messages();
    source.send({ type: "select-pane", pane_id: "older", machine_id: "local" });
    source.send({ type: "select-pane", pane_id: "latest pane/?", machine_id: "remote&pc" });
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    expect(selected).toEqual([{ machine_id: "remote&pc", pane_id: "latest pane/?" }]);
  });

  it("preserves the requested chat view with a pane target", () => {
    const source = messages();
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    source.send({ type: "select-pane", pane_id: "pi-pane", machine_id: "local", view: "chat" });
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pi-pane", view: "chat" }]);
  });

  it("reads a chat target from a cold-start notification URL only when a pane is present", () => {
    expect(notificationTargetFromSearch("?machine=remote%26pc&pane=pi%2F1&view=chat")).toEqual({
      machine_id: "remote&pc",
      pane_id: "pi/1",
      view: "chat",
    });
    expect(notificationTargetFromSearch("?pane=pi-pane&view=chat")).toEqual({
      machine_id: "local",
      pane_id: "pi-pane",
      view: "chat",
    });
    expect(notificationTargetFromSearch("?pane=pi-pane")).toBeNull();
    expect(notificationTargetFromSearch("?view=chat")).toBeNull();
  });

  it("forces the requested view only for that exact PC and pane", () => {
    const target = { machine_id: "remote", pane_id: "pi-pane", view: "chat" as const };
    expect(notificationViewForPane(target, "remote", "pi-pane")).toBe("chat");
    expect(notificationViewForPane(target, "local", "pi-pane")).toBeNull();
    expect(notificationViewForPane(target, "remote", "another-pane")).toBeNull();
    expect(notificationViewForPane({ machine_id: "remote", pane_id: "pi-pane" }, "remote", "pi-pane")).toBeNull();
  });

  it("carries the workspace the worker names, and nothing for an empty or malformed one", () => {
    const source = messages();
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    source.send({ type: "select-pane", pane_id: "w1:p9", machine_id: "local", view: "chat", workspace_id: "w1" });
    source.send({ type: "select-pane", pane_id: "w1:p9", machine_id: "local", workspace_id: "" });
    source.send({ type: "select-pane", pane_id: "w1:p9", machine_id: "local", workspace_id: 7 });
    expect(selected).toEqual([
      { machine_id: "local", pane_id: "w1:p9", view: "chat", workspace_id: "w1" },
      { machine_id: "local", pane_id: "w1:p9" },
      { machine_id: "local", pane_id: "w1:p9" },
    ]);
  });

  it("delivers directly once the app subscribes", () => {
    const source = messages();
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    source.send({ type: "select-pane", pane_id: "pane-a" });
    source.send({ type: "select-pane", pane_id: "pane-b", machine_id: "second/pc" });
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pane-a" }, { machine_id: "second/pc", pane_id: "pane-b" }]);
  });

  it("ignores malformed messages without losing a valid pending selection", () => {
    const source = messages();
    source.send({ type: "select-pane", pane_id: "pane-a", machine_id: 42 });
    for (const data of [null, "select-pane", { type: "other", pane_id: "pane-b" }, { type: "select-pane", pane_id: null }]) source.send(data);
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pane-a" }]);
  });

  it("holds messages after cleanup and does not replay a consumed target on remount", () => {
    const source = messages();
    const selected: unknown[] = [];
    const unsubscribe = source.subscribe((target) => selected.push(target));
    source.send({ type: "select-pane", pane_id: "pane-a" });
    unsubscribe();
    source.send({ type: "select-pane", pane_id: "pane-b" });
    const resumed: unknown[] = [];
    source.subscribe((target) => resumed.push(target))();
    const remounted: unknown[] = [];
    source.subscribe((target) => remounted.push(target));
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pane-a" }]);
    expect(resumed).toEqual([{ machine_id: "local", pane_id: "pane-b" }]);
    expect(remounted).toEqual([]);
  });

  it("takes the Android app's page event as the worker's message, and tells the app it was heard", () => {
    const worker = new EventTarget();
    const page = new EventTarget();
    const subscribe = notificationTargets(worker, undefined, page);
    const selected: unknown[] = [];
    subscribe((target) => selected.push(target));
    const data = { type: "select-pane", pane_id: "w1:p9", machine_id: "build box", view: "chat", workspace_id: "w1" };
    worker.dispatchEvent(new MessageEvent("message", { data }));
    expect(page.dispatchEvent(new MessageEvent(SELECT_PANE_EVENT, { data, cancelable: true }))).toBe(false);
    expect(selected).toEqual([
      { machine_id: "build box", pane_id: "w1:p9", view: "chat", workspace_id: "w1" },
      { machine_id: "build box", pane_id: "w1:p9", view: "chat", workspace_id: "w1" },
    ]);
    page.dispatchEvent(new MessageEvent("message", { data }));
    expect(selected).toHaveLength(2);
  });

  it("ignores a malformed page event without losing a valid pending selection", () => {
    const page = new EventTarget();
    const subscribe = notificationTargets(undefined, undefined, page);
    page.dispatchEvent(new MessageEvent(SELECT_PANE_EVENT, { data: { type: "select-pane", pane_id: "pane-a" } }));
    for (const data of [null, "select-pane", { type: "other", pane_id: "pane-b" }, { type: "select-pane", pane_id: 7 }]) {
      page.dispatchEvent(new MessageEvent(SELECT_PANE_EVENT, { data }));
    }
    page.dispatchEvent(new Event(SELECT_PANE_EVENT));
    const selected: unknown[] = [];
    subscribe((target) => selected.push(target));
    expect(selected).toEqual([{ machine_id: "local", pane_id: "pane-a" }]);
  });

  it("an old cleanup cannot detach a later app subscriber", () => {
    const source = messages();
    const unsubscribe = source.subscribe(() => {});
    const selected: unknown[] = [];
    source.subscribe((target) => selected.push(target));
    unsubscribe();
    source.send({ type: "select-pane", pane_id: "pane-b", machine_id: "remote" });
    expect(selected).toEqual([{ machine_id: "remote", pane_id: "pane-b" }]);
  });
});

describe("notification landing", () => {
  const roster = [
    { id: "local", snapshot: { panes: [{ pane_id: "w1:p1" }] } },
    { id: "pc2", snapshot: null },
  ];

  it("knows a PC is missing only once the roster is in", () => {
    expect(machineMissing([], "pc-gone")).toBe(false);
    expect(machineMissing(roster, "pc-gone")).toBe(true);
    expect(machineMissing(roster, "pc2")).toBe(false);
  });

  it("calls a PC gone only from a roster the server sent after it was named", () => {
    expect(machineGone(roster, 4, 4, "pc-new")).toBe(false);
    expect(machineGone(roster, 5, 4, "pc-new")).toBe(true);
    expect(machineGone([...roster, { id: "pc-new", snapshot: null }], 5, 4, "pc-new")).toBe(false);
    expect(machineGone(roster, 1, 0, "pc-gone")).toBe(true);
    expect(machineGone(roster, 9, null, "pc-gone")).toBe(false);
  });

  it("waits on a PC the roster in hand lacks instead of discarding the tap, and asks again", () => {
    expect(notificationLanding(roster, { machine_id: "pc-gone", pane_id: "w1:p1", view: "chat" })).toEqual({
      kind: "link", link: { machine: "pc-gone", workspace: null, pane: "w1:p1", view: "chat", settings: null }, stale: true,
    });
  });

  it("selects a pane the roster lists at once", () => {
    expect(notificationLanding(roster, { machine_id: "local", pane_id: "w1:p1", view: "chat" })).toEqual({ kind: "select" });
  });

  it("waits as a link while the roster, the PC's panes or the pane are not known", () => {
    const link = (machine: string, pane: string) => ({ kind: "link" as const, link: { machine, workspace: null, pane, view: "chat" as const, settings: null }, stale: false });
    expect(notificationLanding([], { machine_id: "pc-gone", pane_id: "w1:p1", view: "chat" })).toEqual(link("pc-gone", "w1:p1"));
    expect(notificationLanding(roster, { machine_id: "pc2", pane_id: "w1:p1", view: "chat" })).toEqual(link("pc2", "w1:p1"));
    expect(notificationLanding(roster, { machine_id: "local", pane_id: "w1:p9", view: "chat" })).toEqual(link("local", "w1:p9"));
    expect(notificationLanding(roster, { machine_id: "local", pane_id: "w1:p9" })).toEqual({ kind: "link", link: { machine: "local", workspace: null, pane: "w1:p9", view: null, settings: null }, stale: false });
  });

  it("names the workspace an ended pane was last seen in, so its workspace opens with the pane-closed note", () => {
    const landing = notificationLanding(roster, { machine_id: "local", pane_id: "w1:p9", view: "chat", workspace_id: "w1" });
    expect(landing.kind).toBe("link");
    const link = landing.kind === "link" ? landing.link : null;
    expect(link?.workspace).toBe("w1");
    const snapshot = {
      workspaces: [{ workspace_id: "w1", label: "app" }, { workspace_id: "w2", label: "other" }],
      panes: [{ pane_id: "w1:p1", workspace_id: "w1" }, { pane_id: "w2:p1", workspace_id: "w2" }],
      layouts: [],
    } as unknown as Parameters<typeof resolveLink>[0];
    expect(resolveLink(snapshot, link!)).toEqual({ pane: "w1:p1", workspace: "w1", note: "pane-closed" });
  });

  it("tells a second delivery of one tap from another place", () => {
    const link = { machine: "local", workspace: "w1", pane: "w1:p9", view: "chat" as const, settings: null };
    expect(sameLink(null, link)).toBe(false);
    expect(sameLink({ ...link }, link)).toBe(true);
    expect(sameLink({ ...link, pane: "w1:p8" }, link)).toBe(false);
    expect(sameLink({ ...link, machine: "pc2" }, link)).toBe(false);
    expect(sameLink({ ...link, view: null }, link)).toBe(false);
  });
});

describe("desktop link delivery", () => {
  function links() {
    let open!: (query: string) => void;
    const subscribe = notificationTargets(undefined, { onOpen: (listener) => { open = listener; } });
    return { subscribe, open: (query: string) => open(query) };
  }
  const place = (fields: Partial<AppLink>): AppLink => ({ machine: "local", workspace: null, workspaceSlug: null, pane: null, view: null, settings: null, ...fields });
  // workspace 3 is "alpha"; herdr handed pane t3 to workspace 4 ("beta"), and t1 is alpha's
  const roster = [{
    id: "local",
    state: "connected",
    snapshot: {
      workspaces: [{ workspace_id: "3", label: "alpha", active_tab_id: "3:1" }, { workspace_id: "4", label: "beta", active_tab_id: "4:1" }],
      panes: [{ pane_id: "t1", workspace_id: "3", focused: true }, { pane_id: "t3", workspace_id: "4", focused: true }],
      layouts: [],
    } as unknown as Pick<SessionSnapshot, "workspaces" | "panes" | "layouts">,
  }];

  it("reads a link's place with the deep link's own reading", () => {
    expect(linkTarget("?ws=3-my-app&pane=t3&view=terminal")).toEqual({
      machine_id: "local", pane_id: "t3", view: "terminal", link: place({ workspace: "3", workspaceSlug: "my-app", pane: "t3", view: "terminal" }),
    });
    expect(linkTarget("?machine=home%20pc&pane=p2")).toEqual({ machine_id: "home pc", pane_id: "p2", link: place({ machine: "home pc", pane: "p2" }) });
    expect(linkTarget("?pane=p2&view=files")?.link).toEqual(place({ pane: "p2" }));
    expect(linkTarget("?ws=3")).toBeNull();
    expect(linkTarget("")).toBeNull();
  });

  it("keeps the newest link until the app listens, then delivers each one at once", () => {
    const source = links();
    source.open("?pane=older");
    source.open("?ws=3&pane=t3&view=chat");
    source.open("?ws=4");
    const selected: NotificationTarget[] = [];
    source.subscribe((target) => selected.push(target));
    expect(selected.map((target) => target.link)).toEqual([place({ workspace: "3", pane: "t3", view: "chat" })]);
    source.open("?pane=t4&view=terminal");
    expect(selected.map((target) => target.link)).toEqual([place({ workspace: "3", pane: "t3", view: "chat" }), place({ pane: "t4", view: "terminal" })]);
  });

  it("selects a pane only where the roster lists it in the link's workspace, as a deep link resolves it", () => {
    expect(linkLanding(roster, linkTarget("?ws=4-beta&pane=t3&view=terminal")!.link!)).toEqual({ kind: "select", pane: "t3" });
    expect(linkLanding(roster, linkTarget("?ws=4&pane=t3")!.link!)).toEqual({ kind: "select", pane: "t3" });
    expect(linkLanding(roster, linkTarget("?pane=t3")!.link!)).toEqual({ kind: "select", pane: "t3" });
  });

  it("never selects a pane of another workspace than the link names, with or without its slug", () => {
    expect(linkLanding(roster, linkTarget("?ws=3&pane=t3")!.link!)).toEqual({ kind: "wait", stale: false });
    expect(linkLanding(roster, linkTarget("?ws=3-alpha&pane=t3")!.link!)).toEqual({ kind: "wait", stale: false });
    expect(resolveLink(roster[0]!.snapshot, place({ workspace: "3", pane: "t3" }))).toEqual({ pane: "t1", workspace: "3", note: "pane-closed" });
    expect(linkLanding(roster, linkTarget("?ws=3-beta&pane=t3")!.link!)).toEqual({ kind: "select", pane: "t3" });
  });

  it("selects nothing before the link's PC has a roster", () => {
    const link = linkTarget("?ws=4-beta&pane=t3")!.link!;
    expect(linkLanding([], link)).toEqual({ kind: "wait", stale: false });
    expect(linkLanding([{ id: "local", snapshot: null }], link)).toEqual({ kind: "wait", stale: false });
    expect(linkLanding(roster, { ...link, machine: "pc-gone" })).toEqual({ kind: "wait", stale: true });
  });

  it("selects nothing from an offline PC's cached roster: the link waits until the PC is connected", () => {
    const link = linkTarget("?ws=4-beta&pane=t3")!.link!;
    for (const state of ["disconnected", "reconnecting", "connecting", undefined]) {
      expect(linkLanding([{ ...roster[0]!, state }], link)).toEqual({ kind: "wait", stale: false });
    }
  });

  it("tells a link from one to the same pane id in another workspace by its slug", () => {
    const alpha = linkTarget("?ws=3-alpha&pane=t3")!.link!;
    expect(sameLink(alpha, linkTarget("?ws=3-alpha&pane=t3")!.link!)).toBe(true);
    expect(sameLink(alpha, linkTarget("?ws=3-beta&pane=t3")!.link!)).toBe(false);
    expect(sameLink(alpha, linkTarget("?ws=3&pane=t3")!.link!)).toBe(false);
  });
});
