import { afterEach, expect, spyOn, test } from "bun:test";
import { handleRequest, type ServerContext } from "../dispatch.ts";
import { ACCOUNT, createListedPc } from "./listed-pc.test-helpers.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { accountRouteAction, accountRouteGuard } from "./account-row-rights.ts";
import { DISPATCH_MUTATIONS, RELAY_CONTROLS } from "../dispatch-routes.ts";
import { relayConnection } from "../relay/test-helpers.ts";
import { ask, phone } from "./pairing.test-helpers.ts";

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });

test("R1/T37: signed-in listed row can Revoke a newer listing but not its older member", async () => {
  const { fixture, device, member, serverId, service } = await createListedPc(close => closes.push(close));
  const { accountRows, accountMailbox } = fixture.app.context.services;
  const newer = await phone();
  service.registerDevice(ACCOUNT, newer.spki, "Newer");
  expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  const [target] = accountRows?.rowsByKey(newer.spki) ?? [];
  if (!target) throw new Error("Missing newer listing");
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    const link = await relayConnection(fixture, { serverId });
    await link.auth(device);
    const revoke = (id: string) => ask(link, `/api/devices/${id}`, { method: "DELETE", body: {} });
    expect((await revoke(target.id)).status).toBe(204);
    expect(accountRows?.row(target.id)).toBeNull();
    const older = await revoke(member.id);
    expect([older.status, older.body.error?.code]).toEqual([403, "older_device"]);
    // R1: the refusal says where the older device can be removed
    expect(older.body.error?.message).toBe("removing an older device is done from that PC or from an older device");
  } finally { clock.mockRestore(); }
});

async function listedDispatcher() {
  const { fixture, device, serverId } = await createListedPc(close => closes.push(close));
  const ctx: ServerContext = {
    ...fixture.app.context,
    peer: { kind: "relay", device: { id: device.id, label: "Laptop", role: "drive" }, key: device.publicKey, sessionId: "test", serverId },
    timeout() {}, requestIP: () => null, upgrade: () => false,
  };
  const request = (method: string, path: string) => handleRequest(new Request(`https://relay.ovis.invalid${path}`, {
    method, headers: { "x-herdr-machine": "1", "x-herdr-update": "1" }, ...(method === "POST" ? { body: "{}" } : {}),
  }), ctx);
  const rows = ctx.services.accountRows?.store();
  if (!rows) throw new Error("Listed PC has no account store");
  return { rows, device, request, fixture, serverId, ctx };
}

test("R3: a signed-in account row renames only itself on this PC", async () => {
  const { fixture, device, member, serverId } = await createListedPc(close => closes.push(close));
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    const link = await relayConnection(fixture, { serverId });
    await link.auth(device);
    const rename = (id: string) => ask(link, `/api/devices/${id}`, { method: "PATCH", body: { label: "Work laptop" } });
    const other = await rename(member.id);
    expect([other.status, other.body.error?.code]).toEqual([403, "not_yours"]);
    const own = await rename(device.id);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ id: device.id, label: "Work laptop", role: "drive" });
    const { accountMailbox, accountRows } = fixture.app.context.services;
    expect(await accountMailbox.readSnapshot()).toMatchObject({ committed: true });
    expect(accountRows?.row(device.id)?.label).toBe("Work laptop");
  } finally { clock.mockRestore(); }
});

test("R1-R10: only registered methods and explicitly allowed reads reach dispatch", async () => {
  const { rows, device, request } = await listedDispatcher();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    expect(rows.access(device.id)).toEqual({ ok: true });
    expect((await request("GET", "/api/preferences"))?.status).toBe(200);
    for (const [method, path] of [
      ["POST", "/api/unregistered"], ["GET", "/api/unregistered"], ["PATCH", "/api/preferences"],
      ["HEAD", "/api/preferences"], ["OPTIONS", "/api/preferences"], ["PUT", "/api/unregistered"],
      ["DELETE", "/api/unregistered"], ["PATCH", "/api/unregistered"],
      ["POST", "/api/machines/local/unregistered"], ["GET", "/api/machines/local/unregistered"],
      ["GET", "/api/machines/local/machines/local/unregistered"], ["GET", "/ws?machine_id=other"],
    ] as const) {
      const response = await request(method, path);
      expect({ method, path, status: response?.status }).toEqual({ method, path, status: 403 });
    }
  } finally { clock.mockRestore(); }
});

test("R1-R10: every mutation registered by dispatch has an action or a proven handler guard", () => {
  for (const [method, paths] of Object.entries(DISPATCH_MUTATIONS)) {
    for (const path of paths) {
      const pathname = path.replace(":id", "aaaaaaaaaaaaaaaa");
      expect(accountRouteAction(method, pathname) !== null || accountRouteGuard(method, pathname), `${method} ${path}`).toBe(true);
    }
  }
});

test("R5, R6, R8: registered relay controls and introductions refuse account-joined callers at their handler guards", async () => {
  const { rows, device, request } = await listedDispatcher();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    expect(rows.access(device.id)).toEqual({ ok: true });
    for (const path of [...Object.values(RELAY_CONTROLS), "/api/account/introduce"]) {
      const response = await request("POST", path);
      expect(response?.status, path).toBe(403);
      const code = path === RELAY_CONTROLS.pairing || path === "/api/account/introduce" ? "account_required" : "local_required";
      expect(await response?.json(), path).toMatchObject({ error: { code } });
    }
    for (const method of ["PUT", "DELETE"]) {
      const response = await request(method, "/api/alerts/webhook");
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ error: { code: "member_required" } });
    }
  } finally { clock.mockRestore(); }
});

test("R5, R8, R9: PC maintenance and webhook require authority; push unsubscribe has an explicit action", () => {
  for (const [method, path] of [
    ["POST", "/api/runtime/move"], ["DELETE", "/api/runtime/move"], ["POST", "/api/runtime/move/install"],
    ["POST", "/api/runtime/move/stop"], ["POST", "/api/runtime/move/stop-all"], ["POST", "/api/updates/cancel"],
  ] as const) {
    expect(accountRouteAction(method, path), `${method} ${path}`).toEqual({ action: "drive" });
  }
  for (const method of ["PUT", "DELETE"]) expect(accountRouteAction(method, "/api/alerts/webhook")).toEqual({ action: "webhook" });
  expect(accountRouteAction("DELETE", "/api/push/subscribe")).toEqual({ action: "push_subscribe" });
});

test("P5, R7, R9: signed-in account sees refusals instead of PC catalogs, remote routes or webhook writes", async () => {
  const { rows, device, fixture, serverId } = await listedDispatcher();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    expect(rows.access(device.id)).toEqual({ ok: true });
    const link = await relayConnection(fixture, { serverId });
    await link.auth(device);
    expect((await ask(link, "/api/preferences")).status).toBe(200);
    // P5: an ordinary drive read stays; Settings and the Setup Guide read where this PC answers
    expect((await ask(link, "/api/access")).status).toBe(200);
    for (const [path, method, code] of [
      ["/api/unregistered", "GET", "account_route_denied"],
      ["/api/unregistered", "POST", "account_route_denied"],
      ["/api/alerts/webhook", "PUT", "member_required"],
      ["/api/alerts/webhook", "DELETE", "member_required"],
      ["/api/alerts/webhook", "POST", "member_required"],
      ["/api/machines", "GET", "local_only"],
      ["/api/machines/events", "GET", "local_only"],
      ["/api/preferences?machine_id=other", "GET", "local_only"],
      ["/ws?machine_id=other", "GET", "local_only"],
    ] as const) {
      const response = await ask(link, path, { method, ...(method === "GET" ? {} : { body: {} }) });
      expect({ status: response.status, code: response.body.error?.code }).toEqual({ status: 403, code });
    }
  } finally { clock.mockRestore(); }
});

test("R7: a local terminal upgrade grants no multi-PC event document", async () => {
  const { rows, device, ctx } = await listedDispatcher();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    expect(rows.access(device.id)).toEqual({ ok: true });
    expect(ctx.services.core.machines).not.toBeNull();
    const grants: boolean[] = [];
    const response = await handleRequest(new Request("https://relay.ovis.invalid/ws"), {
      ...ctx, upgrade: (_request, { data }) => { grants.push(data.machineEvents !== undefined); return false; },
    });
    expect(response?.status).toBe(426);
    expect(grants).toEqual([false]);
  } finally { clock.mockRestore(); }
});

test("R7: a listed event socket receives only this PC's roster, never its sibling or pairing prompts", async () => {
  const { fixture, serverId, device } = await listedDispatcher();
  const { core } = fixture.app.context.services;
  const local = core.machines?.list().find(machine => machine.id === "local");
  if (!core.machines || !local) throw new Error("Missing local machine");
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  const subscription = spyOn(core.machines, "subscribe").mockImplementation(listener => {
    listener({ type: "remote-pairings", pairings: [] });
    listener({ type: "machines", machines: [local, { ...local, id: "other-pc" }] });
    return () => {};
  });
  try {
    const link = await relayConnection(fixture, { serverId, websocket: core.socketHandlers });
    await link.auth(device);
    const ws = link.openSocket();
    await ws.opened;
    const features = await ws.until(frame => frame.type === "features");
    expect(features.type === "features" && features.features.includes("machine-events")).toBe(true);
    ws.send({ type: "machine-events", enabled: true });
    const frame = await ws.until(message => message.type === "machine-event" && message.event.type === "machines");
    expect(frame.type === "machine-event" && frame.event.type === "machines" && frame.event.machines.map(machine => machine.id)).toEqual(["local"]);
    expect(ws.messages.some(message => message.type === "machine-event" && message.event.type === "remote-pairings")).toBe(false);
  } finally { subscription.mockRestore(); clock.mockRestore(); }
});

test("R7: every machine selector must name this PC before HTTP or WS dispatch", async () => {
  const { fixture, serverId, device } = await listedDispatcher();
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
  try {
    const link = await relayConnection(fixture, { serverId, websocket: fixture.app.context.services.core.socketHandlers });
    await link.auth(device);
    const socket = link.mux.openWs({ target: "/ws?machine_id=other", headers: [], protocols: [] });
    await link.flush();
    expect(socket.rejection?.response?.status).toBe(403);
    expect(await new Response(socket.rejection?.body).json()).toMatchObject({ error: { code: "local_only" } });
    expect((await ask(link, "/api/preferences?machine_id=local")).status).toBe(200);
    for (const [target, headers] of [
      ["/api/preferences?machine_id=local&machine_id=other", []],
      ["/api/preferences?machineId=other", []],
      ["/api/preferences", [["x-herdr-machine", "other"]]],
    ] as const) {
      const response = await link.open(target, { headers }).response;
      expect(response.status, target).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: "local_only" } });
    }
  } finally { clock.mockRestore(); }
});

test.each(["join_hold", "catching_up"] as const)("S25, T36-T40: a request at dispatch while %s cannot drive", async reason => {
  const { rows, request } = await listedDispatcher();
  if (reason === "catching_up") rows.waitForRead();
  const response = await request("GET", "/api/preferences");
  expect(response?.status).toBe(403);
  expect(await response?.json()).toMatchObject({ error: { code: reason } });
});
