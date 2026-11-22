import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import type { ReactNode } from "react";
import * as ReactDom from "react-dom";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import { LOCAL_MACHINE } from "../../shared/machines.ts";
import type { MovePane, MovePlanResponse, MoveStatus } from "../../shared/runtime-move.ts";
import { SettingsProvider } from "../lib/settings.ts";

await mock.module("react-dom", () => ({ ...ReactDom, createPortal: (node: ReactNode) => node }));
const { RuntimeMove } = await import("./RuntimeMove.tsx");

const descriptors = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let requests: { method: string; path: string; body: unknown }[];
let answers: Record<string, (body: unknown) => Response>;

beforeEach(() => {
  requests = [];
  answers = {};
  for (const key of ["window", "document", "navigator", "getComputedStyle", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: "http://127.0.0.1:7421/", origin: "http://127.0.0.1:7421", pathname: "/" },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, history: { state: null, pushState() {}, replaceState() {}, back() {} },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
    querySelector: () => null, activeElement: null, addEventListener() {}, removeEventListener() {},
  } });
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input instanceof Request ? input.url : input), "http://127.0.0.1:7421").pathname;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ method: init?.method ?? "GET", path, body });
    const answer = answers[path];
    return answer ? answer(body) : Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }));
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  mock.restore();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  descriptors.clear();
});

const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const mount = async (onOpenPane?: (machineId: string, paneId: string) => void) => {
  await act(async () => { renderer = create(<SettingsProvider><RuntimeMove bootId="boot-1" hidden={false} {...(onOpenPane ? { onOpenPane } : {})} /></SettingsProvider>); });
};
const buttons = (label: string) => renderer!.root.findAll((node) => node.type === "button" && text(node).trim() === label);
const button = (label: string) => { const found = buttons(label); expect(found).toHaveLength(1); return found[0]!; };
const press = async (node: ReactTestInstance) => { await act(async () => { node.props.onClick(); }); };
const posts = () => requests.filter((request) => request.method === "POST");

describe("the move to herdr-core where herdr-core is missing", () => {
  beforeEach(() => {
    const plan: MovePlanResponse = { available: false, reason: "no_herdr_core", install: { version: "0.1.17" }, status: { state: "idle" } };
    answers["/api/runtime/move"] = () => Response.json(plan);
    answers["/api/runtime/move/install"] = () => Response.json({ error: { code: "install_failed", message: "the herdr-core download does not match its checksum" } }, { status: 502 });
  });

  it("shows the row with the version it installs, and keeps it with the reason when the install fails", async () => {
    await mount();
    expect(text(renderer!.root)).toContain("Install herdr-core and move everything");
    expect(text(renderer!.root)).toContain("herdr-core 0.1.17");
    const install = button("Install and move…");

    await press(install);
    expect(posts().map(({ method, path }) => ({ method, path }))).toEqual([{ method: "POST", path: "/api/runtime/move/install" }]);
    expect(text(renderer!.root.find((node) => node.props.role === "alert"))).toContain("does not match its checksum");
    expect(install.props.disabled).toBe(false);
  });
});

// The dialog while the move waits for busy panes: each shell running a command can be ended there,
// an agent only opened.
describe("ending busy panes from the move's wait", () => {
  const panes: MovePane[] = [
    { pane_id: "p1", cwd: "/demo", name: null, verdict: { kind: "busy", reason: "command_running", agent: null, command: "top" } },
    { pane_id: "p2", cwd: "/demo/site", name: null, verdict: { kind: "busy", reason: "command_running", agent: null, command: "python3" } },
    { pane_id: "p3", cwd: "/demo/app", name: null, verdict: { kind: "busy", reason: "agent_working", agent: "claude", command: null } },
    { pane_id: "p4", cwd: "/demo", name: null, verdict: { kind: "shell" } },
  ];
  let status: MoveStatus;

  beforeEach(() => {
    status = { state: "waiting", revision: "r1" };
    answers["/api/runtime/move"] = () => Response.json({
      available: true, status,
      plan: { ready: false, revision: "r1", panes, workspaces: [{ workspace_id: "w1", name: "demo", tabs: [{ tab_id: "t1", name: "1", root: { pane: "p1" } }] }] },
    } satisfies MovePlanResponse);
    answers["/api/runtime/move/stop"] = () => Response.json({ ok: true });
  });

  const open = async (onOpenPane?: (machineId: string, paneId: string) => void) => {
    await mount(onOpenPane);
    await press(button("Waiting…"));
  };
  const row = (name: string) => renderer!.root.find((node) => node.props.className === "runtime-move-pane" && text(node).includes(name));
  const rowButtons = (name: string) => row(name).findAll((node) => node.type === "button").map((node) => text(node).trim());

  it("ends only the pane whose button is pressed, and offers an agent's pane only to open", async () => {
    const opened: [string, string][] = [];
    await open((machineId, paneId) => opened.push([machineId, paneId]));
    expect(rowButtons("top running")).toEqual(["End"]);
    expect(rowButtons("Answering")).toEqual(["Open the agent's pane"]);

    await press(row("top running").find((node) => node.type === "button"));
    expect(posts()).toEqual([{ method: "POST", path: "/api/runtime/move/stop", body: { pane_id: "p1", command: "top" } }]);

    await press(button("Open the agent's pane"));
    expect(opened).toEqual([[LOCAL_MACHINE, "p3"]]);
    expect(posts()).toHaveLength(1);
  });

  const offerStopAll = (confirm: () => Response) => {
    let offers = 0;
    answers["/api/runtime/move/stop-all"] = (body) => (body as { token?: string }).token === undefined
      ? Response.json({ token: `t${++offers}`, panes: [{ pane_id: "p1", command: "top" }, { pane_id: "p2", command: "python3" }] })
      : confirm();
  };

  it("asks before ending every running command, ends only the list the server offered, and no agent", async () => {
    offerStopAll(() => Response.json({ ok: true }));
    await open();
    await press(button("End all and move now"));
    expect(posts()).toEqual([{ method: "POST", path: "/api/runtime/move/stop-all", body: {} }]);
    expect(text(renderer!.root)).toContain("Ends 2 running commands. Unsaved work may be lost.");
    // the confirm names each pane the token covers (its command and folder), not what the last poll showed
    const covered = renderer!.root.find((node) => node.props.className === "runtime-move-confirm-list").findAll((node) => node.type === "li").map(text);
    expect(covered).toEqual(["top · /demo", "python3 · /demo/site"]);

    await press(button("Back"));
    expect(posts()).toHaveLength(1);
    expect(text(renderer!.root)).not.toContain("Unsaved work may be lost.");

    await press(button("End all and move now"));
    await press(button("End and move"));
    expect(posts().map((request) => request.body)).toEqual([{}, {}, { token: "t2" }]);
    expect(posts().some((request) => request.path === "/api/runtime/move/stop")).toBe(false);
  });

  it("asks again when the panes changed since the confirm", async () => {
    offerStopAll(() => Response.json({ error: { code: "changed", message: "the panes changed since you looked: look again" } }, { status: 409 }));
    await open();
    await press(button("End all and move now"));
    await press(button("End and move"));
    expect(text(renderer!.root.find((node) => node.props.role === "alert"))).toContain("the panes changed since you looked");
    expect(buttons("End and move")).toEqual([]);
    expect(buttons("End all and move now")).toHaveLength(1);
  });

  it("offers to force a pane only once the server says Ctrl+C had its time", async () => {
    status = { state: "waiting", revision: "r1", stopping: [{ pane_id: "p1", force: false }] };
    await open();
    expect(rowButtons("top running")).toEqual(["Ending…"]);
    expect(row("top running").find((node) => node.type === "button").props.disabled).toBe(true);
    expect(buttons("Force end")).toEqual([]);
    await act(async () => { await renderer!.unmount(); });

    status = { state: "waiting", revision: "r1", stopping: [{ pane_id: "p1", force: true }] };
    await open();
    expect(rowButtons("top running")).toEqual(["Force end"]);
    await press(button("Force end"));
    expect(posts()).toEqual([{ method: "POST", path: "/api/runtime/move/stop", body: { pane_id: "p1", command: "top", force: true } }]);
  });
});
