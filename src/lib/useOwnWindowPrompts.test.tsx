import { afterEach, beforeEach, expect, it, jest } from "bun:test";
import { act, createElement } from "react";
import { openPage, type Page } from "./page.fixture.ts";

import type { RelayPairingRequest } from "../../shared/machines.ts";
import { TAILNET_NODE_ROUTES } from "../../shared/tailnet-nodes.ts";
import type { PromptPairing } from "../components/RelayPairingPrompt.tsx";
import { nativeTransport, setTransport } from "./transport.ts";
import { holdListNumber } from "./account/addThisPc.ts";
import { useOwnWindowPrompts } from "./useOwnWindowPrompts.ts";

const JOINS = [{ id: "join-1", label: "Phone", digits: "123456", left_ms: 60_000 }, { id: "join-2", label: "Galaxy", left_ms: 60_000 }];
const TAILNET = { pending: { id: "nPhone1CNTRL", hostname: "pixel", login: "owner@example.com", asked_at: "2026-11-21T00:00:00.000Z" }, nodes: [] };
// the real useOwnJoins and useTailnetNodes read these through the app's transport: no module of theirs is replaced, so
// another file in the same process (OwnJoins.test.tsx, DevicesPanel's) still gets the real ones
let joinReads = 0;
/** What GET /api/account/list/add answers: a PC that follows no list (404) unless a test says otherwise. */
let listAdd: Response | (() => Response | Promise<Response>) = () => Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
let addReads = 0;
beforeEach(() => {
  joinReads = 0;
  addReads = 0;
  listAdd = () => Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  page = openPage();
  Object.defineProperty(page.window.document, "hidden", { configurable: true, value: false });
  setTransport({ ...nativeTransport, fetch: (async (input: string | URL | Request) => {
    const path = new URL(String(input), "http://127.0.0.1:7317").pathname;
    if (path === "/api/relay/joins") { joinReads++; return Response.json({ joins: JOINS }); }
    if (path === TAILNET_NODE_ROUTES.list) return Response.json(TAILNET);
    if (path === "/api/account/list/add") { addReads++; return typeof listAdd === "function" ? listAdd() : listAdd; }
    return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  }) as typeof nativeTransport.fetch });
});
const settle = (): Promise<void> => act(async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); });

let page: Page;
let prompts: readonly PromptPairing[] = [];
let joins: readonly { id: string }[] = [];
function Probe({ pairings, ownWindow = true, unlocked = true }: { pairings: readonly RelayPairingRequest[]; ownWindow?: boolean; unlocked?: boolean }) {
  ({ prompts, joins } = useOwnWindowPrompts(pairings, [], ownWindow, unlocked));
  return null;
}

afterEach(async () => {
  jest.useRealTimers();
  await page.close();
  setTransport(nativeTransport);
});

it("keeps a first join's deadline when an unrelated update rebuilds the prompts", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date("2026-11-21T00:00:00Z"));
  await page.render(createElement(Probe, { pairings: [] }));
  await settle();
  const first = prompts.find((prompt) => prompt.id === "join-1")?.expires_at;
  expect(first).toBe("2026-11-21T00:01:00.000Z");
  jest.setSystemTime(new Date("2026-11-21T00:00:02Z"));
  await page.render(createElement(Probe, { pairings: [] }));
  expect(prompts.find((prompt) => prompt.id === "join-1")?.expires_at).toBe(first);
});

it("puts a removed Tailscale device on this PC's own window alone, with its node id and login", async () => {
  await page.render(createElement(Probe, { pairings: [] }));
  await settle();
  expect(prompts.find((prompt) => prompt.own_window === "tailnet")).toMatchObject({ id: "nPhone1CNTRL", label: "pixel", digits: "nPhone1CNTRL", login: "owner@example.com" });
  await page.render(createElement(Probe, { pairings: [], ownWindow: false }));
  expect(prompts.filter((prompt) => prompt.own_window === "tailnet")).toEqual([]);
});

it("#16: a members join (no digits) goes to the own window's card, not the tap prompts; a locked PC is not asked", async () => {
  await page.render(createElement(Probe, { pairings: [] }));
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window !== "tailnet").map((prompt) => prompt.id)).toEqual(["join-1"]);
  expect(joins.map((join) => join.id)).toEqual(["join-1", "join-2"]);
  const reads = joinReads;
  await page.render(createElement(Probe, { pairings: [], unlocked: false }));
  await settle();
  expect(joinReads).toBe(reads);
  expect(joins).toEqual([]);
});

it("shows this PC's own window the number of an add by its account's list, and reads the add no more where the PC follows no list", async () => {
  const number = { state: "number", run: "0123456789abcdef", account: "acct_1", list: "ab".repeat(32), digits: "482913", until: "2026-11-21T00:02:00.000Z" };
  listAdd = () => Response.json(number);
  await page.render(createElement(Probe, { pairings: [] }));
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([{ id: "add-0123456789abcdef-482913", label: "acct_1", digits: "482913", expires_at: number.until, own_window: "add", run: "0123456789abcdef" }]);
  // not in a window that is not this PC's own
  await page.render(createElement(Probe, { pairings: [], ownWindow: false }));
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([]);
  // a PC that follows no list answers 404 once, and is asked no more
  await page.render(null);
  listAdd = () => Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
  jest.useFakeTimers();
  await page.render(createElement(Probe, { pairings: [] }));
  await settle();
  const reads = addReads;
  await act(async () => { jest.advanceTimersByTime(10_000); });
  await settle();
  expect(addReads).toBe(reads);
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([]);
});

it("leaves the number of an add to the wait that shows it in a dialog, so one place alone takes the yes, and shows it again once that wait lets it go", async () => {
  const number = { state: "number", run: "0123456789abcdef", account: "acct_1", list: "ab".repeat(32), digits: "482913", until: "2026-11-21T00:02:00.000Z" };
  listAdd = () => Response.json(number);
  const release = holdListNumber(number.run);
  await page.render(createElement(Probe, { pairings: [] }));
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([]);
  // the dialog closed: the window's own prompt takes the number again
  await act(async () => { release(); });
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add").map((prompt) => prompt.digits)).toEqual(["482913"]);
  // a hold of another run leaves this one's number where it is
  const other = holdListNumber("fedcba9876543210");
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add").map((prompt) => prompt.digits)).toEqual(["482913"]);
  other();
});

it("keeps the newest read of the add when an older one answers after it", async () => {
  const number = { state: "number", run: "0123456789abcdef", account: "acct_1", list: "ab".repeat(32), digits: "482913", until: "2026-11-21T00:02:00.000Z" };
  let release: (response: Response) => void = () => {};
  const late = new Promise<Response>((resolve) => { release = resolve; });
  listAdd = () => addReads === 1 ? late : Response.json({ state: "ended", why: "cancelled" });
  jest.useFakeTimers();
  await page.render(createElement(Probe, { pairings: [] }));
  await settle();
  await act(async () => { jest.advanceTimersByTime(3_000); });
  await settle();
  expect(addReads).toBe(2);
  await act(async () => { release(Response.json(number)); });
  await settle();
  expect(prompts.filter((prompt) => prompt.own_window === "add")).toEqual([]);
});
