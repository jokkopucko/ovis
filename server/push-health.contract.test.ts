import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushSubscriptionStatus } from "../shared/protocol.ts";
import { DEVICE_COOKIE } from "./auth.ts";
import { DeviceStore } from "./devices.ts";
import { createServer } from "./index.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";

const guard = { "x-herdr-machine": "1", "content-type": "application/json" };
const NOT_FOUND = { error: { code: "subscription_not_found", message: "this device is not subscribed" } };

const withOtherKeys = (subscription: FakePushService["subscription"]) => ({ ...subscription, keys: { ...subscription.keys, auth: Buffer.alloc(16, 9).toString("base64url") } });

async function status(base: string, headers: Record<string, string>, subscription: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}/api/push/status`, { method: "POST", headers: { ...guard, ...headers }, body: JSON.stringify({ subscription }) });
  return { status: response.status, body: await response.json() };
}

it("answers a paired device, a token sign-in and a watching device about their own subscription only", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-push-health-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  let clock = Date.now();
  const server = createServer({ port: 0, stateDir: root, token: "test-push-health", tailscaleOwner: null, machines: false, pushLoopbackHttp: true, statusNow: () => clock });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-push-health" };
  const phone = await startFakePushService();
  const desk = await startFakePushService();
  const watcher = await startFakePushService();
  try {
    const pair = async (label: string) => {
      const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
      const response = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code, label }) });
      expect(response.status).toBe(204);
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    const a = { cookie: (await pair("A")).cookie };
    const b = { cookie: (await pair("B")).cookie };
    const watching = { cookie: `${DEVICE_COOKIE}=${watch.token}` };

    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, ...a }, body: JSON.stringify({ subscription: phone.subscription }) })).status).toBe(204);
    expect(await status(base, a, phone.subscription)).toEqual({ status: 200, body: { registered: true, last_success_at: null, last_failure_at: null, last_failure: null } });
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: { ...guard, ...a }, body: JSON.stringify({ endpoint: phone.subscription.endpoint }) })).status).toBe(204);
    await phone.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    const own = await status(base, a, phone.subscription);
    expect(own.status).toBe(200);
    expect((own.body as PushSubscriptionStatus).registered).toBe(true);
    expect((own.body as PushSubscriptionStatus).last_success_at).not.toBeNull();
    expect((own.body as PushSubscriptionStatus).last_failure).toBeNull();

    // another paired device, the token sign-in and the wrong keys get the unknown subscription's answer
    const unknown = await status(base, a, { ...phone.subscription, endpoint: `${phone.subscription.endpoint}-never-known` });
    expect(unknown).toEqual({ status: 404, body: NOT_FOUND });
    expect(await status(base, b, phone.subscription)).toEqual(unknown);
    expect(await status(base, admin, phone.subscription)).toEqual(unknown);
    expect(await status(base, a, withOtherKeys(phone.subscription))).toEqual(unknown);

    // the token sign-in (owner null) proves itself with the exact keys
    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: admin, body: JSON.stringify({ subscription: desk.subscription }) })).status).toBe(204);
    expect(await status(base, admin, desk.subscription)).toEqual({ status: 200, body: { registered: true, last_success_at: null, last_failure_at: null, last_failure: null } });
    expect(await status(base, admin, withOtherKeys(desk.subscription))).toEqual(unknown);
    expect(await status(base, a, desk.subscription)).toEqual(unknown);

    // a retired subscription answers its owner with why, and nobody else
    clock += 1000;
    phone.answerWith(410);
    const retired = await fetch(`${base}/api/push/test`, { method: "POST", headers: { ...guard, ...a }, body: JSON.stringify({ endpoint: phone.subscription.endpoint }) });
    expect(retired.status).toBe(410);
    const tombstone = await status(base, a, phone.subscription);
    expect(tombstone.status).toBe(200);
    expect(tombstone.body).toEqual({ registered: false, last_success_at: new Date(clock - 1000).toISOString(), last_failure_at: new Date(clock).toISOString(), last_failure: "gone" });
    expect(await status(base, b, phone.subscription)).toEqual(unknown);
    expect(await status(base, admin, phone.subscription)).toEqual(unknown);
    expect(await status(base, a, withOtherKeys(phone.subscription))).toEqual(unknown);
    // the record names neither the endpoint nor the keys
    const raw = readFileSync(join(root, "push-delivery.json"), "utf8");
    expect(raw).not.toContain(phone.subscription.endpoint);
    expect(raw).not.toContain(phone.subscription.keys.auth);

    // a watching device reads its own, and still cannot send
    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, ...watching }, body: JSON.stringify({ subscription: watcher.subscription }) })).status).toBe(204);
    expect(await status(base, watching, watcher.subscription)).toEqual({ status: 200, body: { registered: true, last_success_at: null, last_failure_at: null, last_failure: null } });
    expect(await status(base, watching, desk.subscription)).toEqual(unknown);
    const sent = await fetch(`${base}/api/push/test`, { method: "POST", headers: { ...guard, ...watching }, body: JSON.stringify({ endpoint: watcher.subscription.endpoint }) });
    expect(sent.status).toBe(403);
    expect(await sent.json()).toMatchObject({ error: { code: "read_only" } });

    // the shape of the request: a subscription, never an endpoint in the address or a list
    const malformed = await status(base, a, { endpoint: phone.subscription.endpoint });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ error: { code: "invalid_subscription" } });
    expect((await fetch(`${base}/api/push/status`, { headers: { ...guard, ...a } })).status).toBe(400);
    expect((await fetch(`${base}/api/push/status?endpoint=${encodeURIComponent(phone.subscription.endpoint)}`, { headers: { ...guard, ...a } })).status).toBe(400);
  } finally { phone.stop(); desk.stop(); watcher.stop(); server.stop(); rmSync(root, { recursive: true, force: true }); }
});

it("tells a stranger, the open LAN and a revoked device nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-push-health-gate-"));
  const server = createServer({ port: 0, stateDir: root, token: "test-push-health-gate", tailscaleOwner: null, machines: false, pushLoopbackHttp: true });
  const base = `http://127.0.0.1:${server.port}`;
  const admin = { ...guard, authorization: "Bearer test-push-health-gate" };
  const fake = await startFakePushService();
  try {
    // unauthenticated: the gate, before any subscription is looked at
    const stranger = await fetch(`${base}/api/push/status`, { method: "POST", headers: { ...guard, "x-forwarded-for": "192.0.2.1" }, body: JSON.stringify({ subscription: fake.subscription }) });
    expect(stranger.status).toBe(401);

    // a paired device whose cookie is revoked: refused at the gate, and its record is gone with it
    const { code } = await (await fetch(`${base}/api/devices/pair/start`, { method: "POST", headers: admin })).json() as { code: string };
    const paired = await fetch(`${base}/api/devices/pair`, { method: "POST", headers: guard, body: JSON.stringify({ code, label: "Revoked" }) });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: { ...guard, cookie }, body: JSON.stringify({ subscription: fake.subscription }) })).status).toBe(204);
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: { ...guard, cookie }, body: JSON.stringify({ endpoint: fake.subscription.endpoint }) })).status).toBe(204);
    await fake.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    expect((await status(base, { cookie }, fake.subscription)).status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, "push-delivery.json"), "utf8"))).toHaveLength(1);
    const { devices } = await (await fetch(`${base}/api/devices`, { headers: admin })).json() as { devices: { id: string }[] };
    expect((await fetch(`${base}/api/devices/${devices[0]!.id}`, { method: "DELETE", headers: admin })).status).toBe(204);
    expect((await fetch(`${base}/api/push/status`, { method: "POST", headers: { ...guard, cookie }, body: JSON.stringify({ subscription: fake.subscription }) })).status).toBe(401);
    expect(JSON.parse(readFileSync(join(root, "push-delivery.json"), "utf8"))).toEqual([]);
    // the token sign-in holding the very same subscription JSON learns nothing of the revoked device's history
    expect(await status(base, admin, fake.subscription)).toEqual({ status: 404, body: NOT_FOUND });
  } finally { fake.stop(); server.stop(); rmSync(root, { recursive: true, force: true }); }

  // the open LAN (no token, nobody paired): a subscription it makes has no owner, so no record is read
  const openRoot = mkdtempSync(join(tmpdir(), "herdr-push-health-open-"));
  const open = createServer({ port: 0, stateDir: openRoot, token: "", tailscaleOwner: null, machines: false, pushLoopbackHttp: true });
  const openBase = `http://127.0.0.1:${open.port}`;
  const lan = await startFakePushService();
  try {
    const forwarded = { "x-forwarded-for": "198.51.100.24" };
    expect((await fetch(`${openBase}/api/push/subscribe`, { method: "POST", headers: { ...guard, ...forwarded }, body: JSON.stringify({ subscription: lan.subscription }) })).status).toBe(204);
    expect((await fetch(`${openBase}/api/push/test`, { method: "POST", headers: { ...guard, ...forwarded }, body: JSON.stringify({ endpoint: lan.subscription.endpoint }) })).status).toBe(204);
    await lan.waitFor((push) => push.payload.tag === "herdr-test", "confirmation push", 5000);
    // told it has no device to answer for, the same whatever subscription it names, so its device stays quiet
    const unavailable = { status: 403, body: { error: { code: "status_unavailable", message: "this sign-in has no device to answer for" } } };
    expect(await status(openBase, forwarded, lan.subscription)).toEqual(unavailable);
    expect(await status(openBase, forwarded, { ...lan.subscription, endpoint: "https://push.example.test/unknown" })).toEqual(unavailable);
    // this PC itself (owner null) does not own what the LAN registered either
    expect(await status(openBase, {}, lan.subscription)).toEqual({ status: 404, body: NOT_FOUND });
  } finally { lan.stop(); open.stop(); rmSync(openRoot, { recursive: true, force: true }); }
});

it("never lets a watching device clear another owner's retired endpoint and register it with its own keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-push-health-takeover-"));
  const store = new DeviceStore(root);
  const watch = store.pair(store.startPairing().code, "Watch", "watch")!;
  store.match(watch.token);
  const server = createServer({ port: 0, stateDir: root, token: "test-push-health-takeover", tailscaleOwner: null, machines: false, pushLoopbackHttp: true });
  const base = `http://127.0.0.1:${server.port}`;
  const owner = { ...guard, authorization: "Bearer test-push-health-takeover" };
  const watching = { ...guard, cookie: `${DEVICE_COOKIE}=${watch.token}` };
  const victim = await startFakePushService();
  try {
    expect((await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: owner, body: JSON.stringify({ subscription: victim.subscription }) })).status).toBe(204);
    victim.answerWith(410);
    expect((await fetch(`${base}/api/push/test`, { method: "POST", headers: owner, body: JSON.stringify({ endpoint: victim.subscription.endpoint }) })).status).toBe(410);
    // a watching device that learned the endpoint says goodbye for it, then registers it with keys of its own
    expect((await fetch(`${base}/api/push/subscribe`, { method: "DELETE", headers: watching, body: JSON.stringify({ endpoint: victim.subscription.endpoint }) })).status).toBe(204);
    const takeover = await fetch(`${base}/api/push/subscribe`, { method: "POST", headers: watching, body: JSON.stringify({ subscription: withOtherKeys(victim.subscription) }) });
    expect(takeover.status).toBe(410);
    expect(await takeover.json()).toMatchObject({ error: { code: "subscription_gone" } });
  } finally { victim.stop(); server.stop(); rmSync(root, { recursive: true, force: true }); }
});
