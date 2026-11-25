import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";

import type { RelayPairingRequest } from "../../shared/machines.ts";
import { TAILNET_NODE_ROUTES } from "../../shared/tailnet-nodes.ts";
import type { PromptPairing } from "../components/RelayPairingPrompt.tsx";
import { nativeTransport, setTransport } from "./transport.ts";
import { useOwnWindowPrompts } from "./useOwnWindowPrompts.ts";

const JOINS = [{ id: "join-1", label: "Phone", digits: "123456", left_ms: 60_000 }, { id: "join-2", label: "Galaxy", left_ms: 60_000 }];
const TAILNET = { pending: { id: "nPhone1CNTRL", hostname: "pixel", login: "owner@example.com", asked_at: "2026-11-21T00:00:00.000Z" }, nodes: [] };
// the real useOwnJoins and useTailnetNodes read these through the app's transport: no module of theirs is replaced, so
// another file in the same process (OwnJoins.test.tsx, DevicesPanel's) still gets the real ones
let joinReads = 0;
/** What GET /api/account/list/add answers: a PC that follows no list (404) unless a test says otherwise. */
let listAdd: Response | (() => Response | Promise<Response>) = () => Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
let addReads = 0;
const documentBefore = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeEach(() => {
  joinReads = 0;
  addReads = 0;
  listAdd = () => Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
  setTransport({ ...nativeTransport, fetch: (async (input: string | URL | Request) => {
    const path = new URL(String(input), "http://127.0.0.1:7317").pathname;
    if (path === "/api/relay/joins") { joinReads++; return Response.json({ joins: JOINS }); }
    if (path === TAILNET_NODE_ROUTES.list) return Response.json(TAILNET);
    if (path === "/api/account/list/add") { addReads++; return typeof listAdd === "function" ? listAdd() : listAdd; }
    return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  }) as typeof nativeTransport.fetch });
});
const settle = (): Promise<void> => act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });

let renderer: ReactTestRenderer | undefined;
let prompts: readonly PromptPairing[] = [];
let joins: readonly { id: string }[] = [];
function Probe({ pairings, ownWindow = true, unlocked = true }: { pairings: readonly RelayPairingRequest[]; ownWindow?: boolean; unlocked?: boolean }) {
  ({ prompts, joins } = useOwnWindowPrompts(pairings, [], ownWindow, unlocked));
  return null;
}

afterEach(async () => {
  await act(async () => { renderer?.unmount(); });
  renderer = undefined;
  jest.useRealTimers();
  setTransport(nativeTransport);
  if (documentBefore) Object.defineProperty(globalThis, "document", documentBefore); else Reflect.deleteProperty(globalThis, "document");
});

it("keeps a first join's deadline when an unrelated update rebuilds the prompts", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  const first = prompts.find((prompt) => prompt.id === "join-1")?.expires_at;
  expect(first).toBe("2026-11-21T00:01:00.000Z");
  jest.setSystemTime(new Date("2026-11-21T00:00:02Z"));
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [] })); });
  expect(prompts.find((prompt) => prompt.id === "join-1")?.expires_at).toBe(first);
});

it("puts a removed Tailscale device on this PC's own window alone, with its node id and login", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  expect(prompts.find((prompt) => prompt.own_window === "tailnet")).toMatchObject({ id: "nPhone1CNTRL", label: "pixel", digits: "nPhone1CNTRL", login: "owner@example.com" });
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [], ownWindow: false })); });
  expect(prompts.filter((prompt) => prompt.own_window === "tailnet")).toEqual([]);
});

it("#16: a members join (no digits) goes to the own window's card, not the tap prompts; a locked PC is not asked", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window !== "tailnet").map((prompt) => prompt.id)).toEqual(["join-1"]);
  expect(joins.map((join) => join.id)).toEqual(["join-1", "join-2"]);
  const reads = joinReads;
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [], unlocked: false })); });
  await settle();
  expect(joinReads).toBe(reads);
  expect(joins).toEqual([]);
});

it("shows this PC's own window the number of an add by its account's list, and reads the add no more where the PC follows no list", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const number = { state: "number", run: "0123456789abcdef", account: "acct_1", list: "ab".repeat(32), digits: "482913", until: "2026-11-21T00:02:00.000Z" };
  listAdd = () => Response.json(number);
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([{ id: "add-0123456789abcdef-482913", label: "acct_1", digits: "482913", expires_at: number.until, own_window: "add", run: "0123456789abcdef" }]);
  // not in a window that is not this PC's own
  await act(async () => { renderer!.update(createElement(Probe, { pairings: [], ownWindow: false })); });
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([]);
  // a PC that follows no list answers 404 once, and is asked no more
  await act(async () => { renderer!.unmount(); });
  listAdd = () => Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  jest.useFakeTimers();
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  const reads = addReads;
  await act(async () => { jest.advanceTimersByTime(10_000); });
  await settle();
  expect(addReads).toBe(reads);
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([]);
});

it("keeps the newest read of the add when an older one answers after it", async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const number = { state: "number", run: "0123456789abcdef", account: "acct_1", list: "ab".repeat(32), digits: "482913", until: "2026-11-21T00:02:00.000Z" };
  let release: (response: Response) => void = () => {};
  const late = new Promise<Response>((resolve) => { release = resolve; });
  listAdd = () => addReads === 1 ? late : Response.json({ state: "ended", why: "cancelled" });
  jest.useFakeTimers();
  await act(async () => { renderer = create(createElement(Probe, { pairings: [] })); });
  await settle();
  await act(async () => { jest.advanceTimersByTime(3_000); });
  await settle();
  expect(addReads).toBe(2);
  await act(async () => { release(Response.json(number)); });
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([]);
});
