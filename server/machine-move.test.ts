import { afterAll, beforeEach, expect, it } from "bun:test";
import { createServer, type Socket } from "node:net";
import type { Machine, MoveAllResponse } from "../shared/machines.ts";
import { handleMachineRequest, slowMachinePath } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";

type Asked = { pc: string; method: string; path: string; search: string; authorization: string | null; update: string | null; cookie: string | null; body: string };
const asked: Asked[] = [];
const PLAN = { available: true, plan: { workspaces: [], panes: [], ready: true, revision: "shown" }, status: { state: "idle" } };
const pc = (name: string, answer: (request: Request) => Response | Promise<Response>) => Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  const url = new URL(request.url);
  const body = await request.text();
  asked.push({ pc: name, method: request.method, path: url.pathname, search: url.search, authorization: request.headers.get("authorization"), update: request.headers.get("x-herdr-update"), cookie: request.headers.get("cookie"), body });
  return answer(new Request(request.url, { method: request.method, headers: request.headers, ...(body ? { body } : {}) }));
} });
const current = async (request: Request) => {
  if (request.method === "GET") return Response.json(PLAN);
  const path = new URL(request.url).pathname;
  if (path === "/api/runtime/move/stop" && JSON.parse(await request.text()).pane_id === "gone") return Response.json({ error: { code: "pane_not_found", message: "pane gone not found" } }, { status: 404 });
  if (request.method !== "POST" || path !== "/api/runtime/move") return Response.json({ ok: true });
  return JSON.parse(await request.text()).revision === "shown"
    ? Response.json({ accepted: true }, { status: 202 })
    : Response.json({ error: { code: "plan_changed", message: "the panes changed since the plan was shown: look again" } }, { status: 409 });
};
const remotes = {
  pc: pc("pc", current),
  relay: pc("relay", current),
  old: pc("old", () => Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 })),
  gateway: pc("gateway", () => Response.json({ error: { code: "upstream_lost", message: "the relay lost the answer" } }, { status: 502 })),
  refusing: pc("refusing", () => Response.json({ error: { code: "unauthorized", message: "unauthorized" } }, { status: 401 })),
};
const droppedAt: string[] = [];
const sockets = new Set<Socket>();
const dropping = createServer((socket) => { sockets.add(socket); socket.once("data", (data) => { droppedAt.push(String(data).split("\r\n")[0]!); socket.destroy(); }); });
await new Promise<void>((resolve) => dropping.listen(0, "127.0.0.1", resolve));
afterAll(() => { for (const remote of Object.values(remotes)) remote.stop(true); for (const socket of sockets) socket.destroy(); dropping.close(); });

const machines: Pick<Machine, "id" | "kind">[] = [
  { id: "pc", kind: "ssh" }, { id: "relay", kind: "relay" }, { id: "old", kind: "ssh" }, { id: "refusing", kind: "ssh" },
  { id: "relay-refusing", kind: "relay" }, { id: "offline", kind: "ssh" }, { id: "local", kind: "local" }, { id: "hc", kind: "hc" }, { id: "dropping", kind: "ssh" }, { id: "gateway", kind: "relay" },
];
const soon: string[] = [];
const manager = {
  list: () => machines,
  endpoint: (id: string) => {
    if (id === "dropping") return { url: `http://127.0.0.1:${(dropping.address() as { port: number }).port}`, token: "dropping-token" };
    const remote = id === "relay-refusing" ? remotes.refusing : remotes[id as keyof typeof remotes];
    return remote ? { url: `http://127.0.0.1:${remote.port}`, token: `${id}-token` } : undefined;
  },
  retryNow: () => {},
  trackTerminal: () => () => undefined,
  moveOfferSoon: (id: string) => { soon.push(id); },
} as unknown as MachineManager;
beforeEach(() => { asked.length = 0; soon.length = 0; });

const guard = { origin: "http://127.0.0.1", "x-herdr-machine": "1", "x-herdr-update": "1", "content-type": "application/json", cookie: "ovis_device=browser-secret" };
const call = (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}, readOnly = false) => handleMachineRequest(new Request(`http://127.0.0.1/api/machines/${path}`, {
  method: init.method ?? "GET", headers: init.headers ?? guard, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
}), manager, undefined, undefined, readOnly, undefined, undefined, undefined, undefined, true);
const code = async (response: Response) => [response.status, ((await response.json()) as { error?: { code: string } }).error?.code ?? null];

it("forwards a PC's move routes with that PC's credential and the app's header, and nothing of the browser's", async () => {
  const plan = await call("pc/runtime/move");
  expect([plan.status, await plan.json()]).toEqual([200, PLAN]);
  const started = await call("pc/runtime/move", { method: "POST", body: { revision: "shown" } });
  expect(started.status).toBe(202);
  for (const path of ["runtime/move/stop", "runtime/move/stop-all", "runtime/move/install"]) expect((await call(`pc/${path}`, { method: "POST", body: {} })).status).toBe(200);
  expect((await call("pc/runtime/move", { method: "DELETE" })).status).toBe(200);
  expect(asked.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "GET /api/runtime/move", "POST /api/runtime/move", "POST /api/runtime/move/stop", "POST /api/runtime/move/stop-all", "POST /api/runtime/move/install", "DELETE /api/runtime/move",
  ]);
  for (const request of asked) expect([request.authorization, request.update, request.cookie]).toEqual(["Bearer pc-token", "1", null]);
  expect(asked[1]!.body).toBe(JSON.stringify({ revision: "shown" }));
  expect(soon).toEqual(["pc", "pc", "pc", "pc", "pc"]);
  expect(slowMachinePath("runtime/move/install")).toBe(true);
});

it("never asks a PC about its move for a watching device, its plan included", async () => {
  for (const path of ["runtime/move", "runtime/move/stop", "runtime/move/stop-all", "runtime/move/install"]) {
    for (const method of ["GET", "POST"]) expect([path, method, ...await code(await call(`pc/${path}`, { method, ...(method === "POST" ? { body: {} } : {}) }, true))]).toEqual([path, method, 403, "read_only"]);
  }
  expect(asked).toEqual([]);
});

it("tells an Ovis too old to be moved from here as an update to make first", async () => {
  expect(await code(await call("old/runtime/move"))).toEqual([409, "pc_update_required"]);
  expect(await code(await call("refusing/runtime/move", { method: "POST", body: { revision: "shown" } }))).toEqual([409, "pc_update_required"]);
  expect(await code(await call("relay-refusing/runtime/move"))).toEqual([401, "unauthorized"]);
  expect(await code(await call("pc/runtime/move/stop", { method: "POST", body: { pane_id: "gone" } }))).toEqual([404, "pane_not_found"]);
  expect(await code(await call("pc/runtime/move?x=1"))).toEqual([400, "invalid_query"]);
  expect(asked.map((request) => request.pc)).toEqual(["old", "refusing", "refusing", "pc"]);
});

it("starts every previewed PC's move at once and says in plain words why each other one did not start", async () => {
  const plans = [
    { machine_id: "pc", revision: "shown" }, { machine_id: "relay", revision: "older" }, { machine_id: "old", revision: "shown" },
    { machine_id: "offline", revision: "shown" }, { machine_id: "local", revision: "shown" }, { machine_id: "hc", revision: "shown" }, { machine_id: "gone", revision: "shown" },
  ];
  const response = await call("runtime/move-all", { method: "POST", body: { plans } });
  expect(response.status).toBe(202);
  const answer = await response.json() as MoveAllResponse;
  expect(answer.started).toEqual(["pc"]);
  expect(answer.refused.map(({ machine_id, code }) => [machine_id, code])).toEqual([
    ["relay", "plan_changed"], ["old", "pc_update_required"], ["offline", "machine_offline"], ["local", "move_unavailable"], ["hc", "move_unavailable"], ["gone", "machine_not_found"],
  ]);
  for (const refused of answer.refused) expect(refused.message.length).toBeGreaterThan(0);
  expect(asked.filter((request) => request.method === "POST").map(({ pc, body, update, authorization }) => [pc, JSON.parse(body).revision, update, authorization]).sort()).toEqual([
    ["old", "shown", "1", "Bearer old-token"], ["pc", "shown", "1", "Bearer pc-token"], ["relay", "older", "1", "Bearer relay-token"],
  ]);
  expect(answer.unknown).toEqual([]);
  expect(soon).toEqual(["pc"]);
});

it("tells a start whose answer never came apart from a refusal: that PC may have started", async () => {
  const response = await call("runtime/move-all", { method: "POST", body: { plans: [{ machine_id: "dropping", revision: "shown" }] } });
  const answer = await response.json() as MoveAllResponse;
  expect([response.status, answer.started, answer.refused, answer.unknown.map(({ machine_id }) => machine_id)]).toEqual([202, [], [], ["dropping"]]);
  expect(answer.unknown[0]!.message.length).toBeGreaterThan(0);
  expect(droppedAt).toEqual(["POST /api/runtime/move HTTP/1.1"]);
  const gateway = await (await call("runtime/move-all", { method: "POST", body: { plans: [{ machine_id: "gateway", revision: "shown" }] } })).json() as MoveAllResponse;
  expect([gateway.refused, gateway.unknown.map(({ machine_id }) => machine_id)]).toEqual([[], ["gateway"]]);
});

it("takes a move of every PC only from a driving device of this app, as one list of plans", async () => {
  const body = { plans: [{ machine_id: "pc", revision: "shown" }] };
  expect(await code(await call("runtime/move-all", { method: "POST", body, headers: { origin: "http://127.0.0.1", "content-type": "application/json" } }))).toEqual([403, "invalid_machine_request"]);
  expect(await code(await call("runtime/move-all", { method: "POST", body, headers: { ...guard, origin: "https://elsewhere.example" } }))).toEqual([403, "invalid_origin"]);
  expect(await code(await call("runtime/move-all", { method: "POST", body }, true))).toEqual([403, "read_only"]);
  expect(await code(await call("runtime/move-all", { method: "POST", body: { plans: [{ machine_id: "pc" }] } }))).toEqual([400, "invalid_body"]);
  expect(await code(await call("runtime/move-all"))).toEqual([405, "method_not_allowed"]);
  expect(await code(await call("runtime/move-all", { method: "POST", body: { plans: [{ machine_id: "pc", revision: "shown" }, { machine_id: "pc", revision: "other" }] } }))).toEqual([400, "invalid_body"]);
  const tooMany = Array.from({ length: machines.length + 1 }, (_, index) => ({ machine_id: `pc-${index}`, revision: "shown" }));
  expect(await code(await call("runtime/move-all", { method: "POST", body: { plans: tooMany } }))).toEqual([400, "invalid_body"]);
  expect(asked).toEqual([]);
});
