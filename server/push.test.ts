import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";

import { paneAlertsMuted, type AlertPrefs } from "../shared/notify-policy.ts";
import { paneStorageId } from "../shared/machines.ts";
import type { AgentStatus, HerdrPane, InteractivePrompt, SessionSnapshot } from "../shared/protocol.ts";
import { CompletionTracker } from "./completion.ts";
import { handlePreferencesRequest, PreferenceStore } from "./preferences.ts";
import { DeviceStore } from "./devices.ts";
import { createPushService, handlePushRequest, parseSubscription, RELAY_MAX_BODY_BYTES, type PushService } from "./push.ts";
import { startFakePushService, type FakePushService } from "./push.fake.ts";
import { privateStateFs } from "./private-state.ts";
import { parseInteractivePrompt } from "./prompt.ts";

/**
 * The server half of web push, end to end against a fake push service that decrypts
 * and verifies like a real device would.
 */

function pane(paneId: string, status: AgentStatus, title: string): HerdrPane {
  return {
    pane_id: paneId,
    agent_status: status,
    terminal_title: title,
    focused: false,
    revision: 0,
    tab_id: "t1",
    terminal_id: "term_1",
    workspace_id: "w1",
  };
}

let stateDir: string;
let fake: FakePushService;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "ovis-push-"));
  fake = await startFakePushService();
});

afterEach(() => {
  fake.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function relaySubscription() {
  return { ...fake.subscription, endpoint: fake.subscription.endpoint.replace(/\/push\/[^/]+$/, `/v1/push/${crypto.randomUUID()}`) };
}

function subscribed(options: Partial<Parameters<typeof createPushService>[0]> = {}, subscription = fake.subscription): PushService {
  const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, ...options });
  push.subscribe(subscription);
  const onStatus = push.onStatus;
  push.onStatus = async (...args) => {
    await onStatus(...args);
    await push.settled();
  };
  return push;
}

describe("parseSubscription", () => {
  it("accepts what a browser's PushSubscription.toJSON() produces", () => {
    const browserJson = { ...fake.subscription, expirationTime: null };
    // the fake's endpoint is loopback http, which only a service made for it accepts
    expect(parseSubscription(browserJson, { loopbackHttp: true })).toEqual(fake.subscription);
  });

  it("rejects endpoints and keys a push service could never have issued", () => {
    const { endpoint, keys } = fake.subscription;
    expect(parseSubscription({ endpoint: "ftp://push.example/x", keys })).toBeNull();
    expect(parseSubscription({ endpoint: "not a url", keys })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, p256dh: keys.p256dh.slice(0, 40) } })).toBeNull();
    expect(parseSubscription({ endpoint, keys: { ...keys, auth: "AAAA" } })).toBeNull();
    expect(parseSubscription({ endpoint })).toBeNull();
    expect(parseSubscription("subscription")).toBeNull();
    // a plain-http endpoint is never a browser subscription, and it is the shape that
    // would turn the sender into a POST from inside the user's network
    expect(parseSubscription({ endpoint: "http://169.254.169.254/latest/meta-data/", keys })).toBeNull();
    expect(parseSubscription({ endpoint: "http://192.168.0.10:9000/push/1", keys })).toBeNull();
  });

  it("refuses http on loopback too, unless the push service was made for the tests' fake", () => {
    const { keys } = fake.subscription;
    for (const endpoint of ["http://127.0.0.1:9000/push/1", "http://[::1]:9000/push/1", "http://localhost:9000/push/1"]) {
      expect(parseSubscription({ endpoint, keys })).toBeNull();
      expect(parseSubscription({ endpoint, keys }, { loopbackHttp: true })).not.toBeNull();
    }
    expect(parseSubscription({ endpoint: "https://127.0.0.1:9000/push/1", keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: "https://push.example/x", keys })).not.toBeNull();
    expect(parseSubscription({ endpoint: "http://192.168.0.10:9000/push/1", keys }, { loopbackHttp: true })).toBeNull();
  });
});

describe("push state", () => {
  it("keeps one owner-only VAPID key pair across restarts", () => {
    const key = createPushService({ loopbackHttp: true, stateDir }).publicKey();
    expect(Buffer.from(key, "base64url").length).toBe(65);
    expect(createPushService({ loopbackHttp: true, stateDir }).publicKey()).toBe(key);
    expect(statSync(join(stateDir, "vapid.json")).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("regression: takes others' write access away from the key pair before it is read", () => {
    const dir = mkdtempSync(join(tmpdir(), "push-untrusted-"));
    try {
      chmodSync(dir, 0o777);
      const key = createPushService({ loopbackHttp: true, stateDir: dir }).publicKey();
      expect(statSync(dir).mode & 0o777).toBe(0o755);
      chmodSync(join(dir, "vapid.json"), 0o666);
      expect(createPushService({ loopbackHttp: true, stateDir: dir }).publicKey()).toBe(key);
      expect(statSync(join(dir, "vapid.json")).mode & 0o777).toBe(0o644);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a malformed key file instead of rotating the key under every device", () => {
    writeFileSync(join(stateDir, "vapid.json"), "{}\n");
    expect(() => createPushService({ loopbackHttp: true, stateDir }).publicKey()).toThrow("malformed");
    expect(readFileSync(join(stateDir, "vapid.json"), "utf8")).toBe("{}\n");
  });

  it("keeps subscriptions across restarts", async () => {
    subscribed();
    expect(statSync(join(stateDir, "push-subscriptions.json")).mode & 0o777).toBe(0o600);
    const restarted = createPushService({ loopbackHttp: true, stateDir });
    expect(await restarted.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received).toHaveLength(1);
  });

  it("does not publish an unpersisted VAPID key", () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try {
      expect(() => push.publicKey()).toThrow("EIO");
      // no second call may hand out the key that never reached disk
      expect(() => push.publicKey()).toThrow("EIO");
    } finally { fsync.mockRestore(); }
    expect(readdirSync(stateDir)).toEqual([]);
    const key = push.publicKey();
    expect(createPushService({ loopbackHttp: true, stateDir }).publicKey()).toBe(key);
  });

  it("keeps the subscriptions in use unchanged when their write fails", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const rename = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw new Error("EXDEV: rename refused"); });
    try {
      expect(() => push.subscribe(fake.subscription, undefined, "0123456789abcdef")).toThrow("EXDEV");
    } finally { rename.mockRestore(); }
    expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
    expect(existsSync(join(stateDir, "push-subscriptions.json"))).toBe(false);
    expect(readdirSync(stateDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    push.subscribe(fake.subscription, undefined, "0123456789abcdef");
    const fsync = spyOn(privateStateFs, "fsyncSync").mockImplementation(() => { throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }); });
    try {
      expect(() => push.revokeDevice("0123456789abcdef")).toThrow("EIO");
      expect(() => push.unsubscribe(fake.subscription.endpoint)).toThrow("EIO");
    } finally { fsync.mockRestore(); }
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(await createPushService({ loopbackHttp: true, stateDir }).sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });
});

describe("push delivery", () => {
  it("delivers the real finish after a late unknown snapshot arrives during a new Codex turn", async () => {
    const push = subscribed();
    const completions = new CompletionTracker();
    const id = "w1:p1";
    const atRest = { panes: [{ ...pane(id, "unknown", "Codex regression"), agent: "codex" }], agents: [] } as unknown as SessionSnapshot;
    push.seed(atRest.panes);
    let release!: (value: SessionSnapshot) => void;
    const pending = new Promise<SessionSnapshot>((resolve) => { release = resolve; });
    const reading = completions.readSnapshot(() => pending);
    await push.onStatus(id, completions.observe(id, "working", "codex"));
    release(atRest);
    expect((await reading).panes[0]!.agent_status).toBe("working");
    expect(completions.seen(id)).toBe(false);
    expect(fake.received).toHaveLength(0);

    expect(completions.observe(id, "unknown", "codex")).toBe("done");
    await push.onStatus(id, "done");
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.payload.body).toBe("work finished");
    expect(fake.received[0]!.vapidValid).toBe(true);
  });

  it("delivers one done alert per Codex finish while an agent handoff keeps working", async () => {
    const push = subscribed();
    const completions = new CompletionTracker();
    const id = "w1:p1";
    push.seed([pane(id, "unknown", "Codex regression")]);
    const report = async (status: AgentStatus, agent: string) => {
      const presented = completions.observe(id, status, agent);
      await push.onStatus(id, presented);
      return presented;
    };

    for (let turn = 0; turn < 2; turn++) {
      expect(await report("working", "codex")).toBe("working");
      expect(await report("unknown", "codex")).toBe("done");
      expect(await report("unknown", "codex")).toBe("done");
      expect(fake.received).toHaveLength(turn + 1);
    }
    expect(fake.received.every((message) => message.payload.body === "work finished" && message.vapidValid)).toBe(true);

    await report("working", "pi");
    expect(await report("unknown", "claude")).toBe("working");
    expect(fake.received).toHaveLength(2);
    expect(await report("idle", "claude")).toBe("done");
    expect(fake.received).toHaveLength(3);
  });

  it("sends a status alert the device can decrypt, signed with the server's key", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");

    expect(fake.received).toHaveLength(1);
    const [received] = fake.received;
    expect(received!.payload).toEqual({
      pane_id: "w1:p1",
      workspace_id: "w1",
      title: "claude: fix the build",
      body: "waiting for your input",
      tag: "herdr-pane-w1:p1",
      kind: "input",
    });
    expect(received!.urgency).toBe("high");
    expect(received!.ttl).toBe(12 * 60 * 60);
    expect(received!.vapidValid).toBe(true);
    expect(received!.vapidKey).toBe(push.publicKey());
    expect(received!.vapidClaims.aud).toBe(new URL(fake.subscription.endpoint).origin);
    expect(received!.vapidClaims.sub).toBe("https://github.com/devswha/ovis");
  });

  it("keeps equal pane IDs, titles, status baselines and push links separated by PC", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "alpha")], "pc-a", "Work PC");
    push.seed([pane("w1:p1", "working", "beta")], "pc-b", "Home PC");
    await push.onStatus("w1:p1", "blocked", "pc-a");
    await push.onStatus("w1:p1", "done", "pc-b");
    expect(fake.received.map((r) => r.payload.machine_id)).toEqual(["pc-a", "pc-b"]);
    expect(fake.received.map((r) => r.payload.title)).toEqual(["Work PC · alpha", "Home PC · beta"]);
    expect(fake.received[0]!.payload.tag).not.toBe(fake.received[1]!.payload.tag);
    expect(fake.received.every((r) => r.vapidValid)).toBe(true);
  });

  it("measures the first change after a restart against the seeded baseline", async () => {
    const push = subscribed();
    await push.onStatus("w1:p9", "blocked");
    expect(fake.received).toHaveLength(0);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.pane_id)).toEqual(["w1:p1"]);
    expect(fake.received[0]!.urgency).toBe("normal");
  });

  it("does not let a later snapshot overwrite a status an event already reported", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(1);
  });

  it("names the pane by its current title, falling back to the seeded one", async () => {
    let fresh: string | Error = "claude: new task";
    const push = subscribed({
      lookupPane: async () => {
        if (fresh instanceof Error) throw fresh;
        return { title: fresh };
      },
    });
    push.seed([pane("w1:p1", "working", "claude: old task")]);
    await push.onStatus("w1:p1", "blocked");
    fresh = new Error("herdr busy");
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((received) => received.payload.title)).toEqual(["claude: new task", "claude: old task"]);
  });

  it("names a pane titled by its path after its folder, as the client's alerts do", async () => {
    const push = subscribed();
    const { terminal_title: _untitled, ...shell } = pane("w1:p1", "working", "");
    push.seed([{ ...shell, cwd: "/home/u/projects/api" }, pane("w1:p2", "working", "C:\\work\\site"), pane("w1:p3", "working", "vim /etc/hosts"),
      pane("w1:p4", "working", "me@host:~/work/web"), { ...pane("w1:p5", "working", "π ⠋ /home/u/projects/cli"), agent: "pi" },
      { ...pane("w1:p6", "working", "/srv/a/api"), label: "billing" }, pane("w1:p7", "working", "me@host:")]);
    for (const id of ["w1:p1", "w1:p2", "w1:p3", "w1:p4", "w1:p5", "w1:p6", "w1:p7"]) await push.onStatus(id, "blocked");
    expect(fake.received.map((received) => received.payload.title)).toEqual(["api", "site", "vim /etc/hosts", "web", "cli", "billing", "w1:p7"]);
  });

  it("tells the device a pane's terminal ended, under its last known title", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "vim notes.md")]);
    await push.onEnded("w1:p1");
    expect(fake.received[0]!.payload).toEqual({
      pane_id: "w1:p1",
      workspace_id: "w1",
      title: "vim notes.md",
      body: "terminal ended",
      tag: "herdr-pane-w1:p1",
      kind: "ended",
    });
  });

  it("names the PC in a pane alert, by the endpoint it went to and its relay ID, for the phone app's tap", async () => {
    const serverId = "0123456789abcdef0123456789abcdef";
    const app = relaySubscription();
    const push = subscribed({ serverId: () => serverId }, app);
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received[0]!.payload).toMatchObject({ pane_id: "w1:p1", endpoint: app.endpoint, server_id: serverId });
    fake.received.length = 0;
    await push.sendTest(app.endpoint);
    expect(fake.received[0]!.payload).not.toHaveProperty("endpoint");
    expect(fake.received[0]!.payload).not.toHaveProperty("server_id");
  });

  it("never names the PC to a browser, whose worker knows it by its own scope", async () => {
    const push = subscribed({ serverId: () => "0123456789abcdef0123456789abcdef" });
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(1);
    expect(fake.received[0]!.payload).not.toHaveProperty("endpoint");
    expect(fake.received[0]!.payload).not.toHaveProperty("server_id");
  });

  it("sends a relay alert without naming the PC when that would take it past what the relay passes on", async () => {
    let delivered = 0;
    const app = relaySubscription();
    const push = subscribed({ serverId: () => "0123456789abcdef0123456789abcdef", onAlertDelivered: () => { delivered += 1; } }, app);
    const sent = spyOn(globalThis, "fetch");
    try {
      // the relay takes a 2,790-character title without the fields, about 2,660 with them on this endpoint
      for (const [length, named] of [[2600, true], [2740, false]] as const) {
        sent.mockClear();
        fake.received.length = 0;
        push.seed([pane("w1:p1", "working", "x".repeat(length))]);
        await push.onStatus("w1:p1", "working");
        await push.onStatus("w1:p1", "blocked");
        const payload = fake.received[0]!.payload;
        expect(payload.title).toBe("x".repeat(length));
        expect(payload.endpoint).toBe(named ? app.endpoint : undefined);
        expect(payload.server_id).toBe(named ? "0123456789abcdef0123456789abcdef" : undefined);
        const [[, init]] = sent.mock.calls as unknown as [[string, { body: Uint8Array }]];
        expect(init.body.byteLength).toBeLessThanOrEqual(RELAY_MAX_BODY_BYTES);
      }
    } finally { sent.mockRestore(); }
    expect(delivered).toBe(2);
  });

  it("counts a pane alert a device took, never the test push or one the push service refused", async () => {
    let delivered = 0;
    const push = subscribed({ onAlertDelivered: () => { delivered += 1; } });
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(delivered).toBe(0);
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received.at(-1)!.payload).toMatchObject({ pane_id: "w1:p1" });
    expect(delivered).toBe(1);
    fake.answerWith(500);
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    expect(delivered).toBe(1);
  });

  it("forgets a device its push service reports gone", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
  });

  it.each([404, 410])("answers subscription_gone on the first test when the push service returns %i", async (status) => {
    const push = subscribed();
    fake.answerWith(status);

    const response = await handlePushRequest(new Request("http://localhost/api/push/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: fake.subscription.endpoint }),
    }), "/api/push/test", push, null);

    expect(response?.status).toBe(410);
    expect((await response?.json()).error.code).toBe("subscription_gone");
  });

  // regression (fails on main): the browser can keep handing over the endpoint its push service retired (#1038)
  it("refuses a re-registration of an endpoint its push service retired, so the device subscribes anew", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const post = (path: string, body: unknown) => handlePushRequest(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), path, push, null);
    const again = (await post("/api/push/subscribe", { subscription: fake.subscription }))!;
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    const tested = (await post("/api/push/test", { endpoint: fake.subscription.endpoint }))!;
    expect(tested.status).toBe(410);
    expect(((await tested.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    const unknown = (await post("/api/push/test", { endpoint: "https://push.example/never-known" }))!;
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("subscription_not_found");
  });

  it("still refuses a retired endpoint after a server restart", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const path = join(stateDir, "push-retired.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(fake.subscription.endpoint);
    const restarted = createPushService({ loopbackHttp: true, stateDir });
    const post = (path: string, body: unknown) => handlePushRequest(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), path, restarted, null);
    const again = (await post("/api/push/subscribe", { subscription: fake.subscription }))!;
    expect(again.status).toBe(410);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    const other = { ...fake.subscription, endpoint: `${fake.subscription.endpoint}-other` };
    expect((await post("/api/push/subscribe", { subscription: other }))?.status).toBe(204);
  });

  // regression (fails on main): 30 days after the retirement the mark expired, and a watch device registered the owner's endpoint (#2012)
  it("never hands a retired endpoint to another device, however long ago it was retired, and ignores a malformed file", async () => {
    let clock = 1_000_000;
    const push = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    push.subscribe(fake.subscription, undefined, "owner");
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    clock += 31 * 24 * 60 * 60 * 1000;
    const theirs = { endpoint: fake.subscription.endpoint, keys: { p256dh: Buffer.alloc(65, 4).toString("base64url"), auth: Buffer.alloc(16, 7).toString("base64url") } };
    const subscribeAs = (service: PushService) => handlePushRequest(new Request("http://localhost/api/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: theirs }),
    }), "/api/push/subscribe", service, "watch");
    for (const service of [push, createPushService({ loopbackHttp: true, stateDir, now: () => clock })]) {
      const response = (await subscribeAs(service))!;
      expect(response.status).toBe(410);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("subscription_gone");
    }
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect(readFileSync(join(stateDir, "push-retired.json"), "utf8")).toContain("owner");
    writeFileSync(join(stateDir, "push-retired.json"), "not json");
    expect(createPushService({ loopbackHttp: true, stateDir }).retired(fake.subscription.endpoint)).toBe(false);
  });

  // a mark written before #2012 is the hash of the spelling handed over, and so is the history
  it("keeps refusing, and forgets on goodbye, an endpoint retired under the spelling it was handed over", async () => {
    const legacy = `${fake.subscription.endpoint}#legacy`;
    const raw = createHash("sha256").update(legacy).digest("base64url");
    writeFileSync(join(stateDir, "push-retired.json"), JSON.stringify([{ hash: raw, at: 1, owner: "owner" }]));
    writeFileSync(join(stateDir, "push-delivery.json"), JSON.stringify([{ hash: raw, owner: "owner", keys: "k", success_at: null, failure_at: Date.now(), failure: "gone", at: Date.now() }]));
    const push = createPushService({ loopbackHttp: true, stateDir });
    const request = (method: string, path: string, body: unknown) => handlePushRequest(new Request(`http://localhost${path}`, {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), path, push, "watch");
    expect((await request("POST", "/api/push/subscribe", { subscription: { ...fake.subscription, endpoint: legacy } }))?.status).toBe(410);
    expect((await request("POST", "/api/push/test", { endpoint: legacy }))?.status).toBe(410);
    expect(existsSync(join(stateDir, "push-subscriptions.json"))).toBe(false);
    expect((await request("DELETE", "/api/push/subscribe", { endpoint: legacy }))?.status).toBe(204);
    expect(JSON.parse(readFileSync(join(stateDir, "push-delivery.json"), "utf8"))).toEqual([]);
  });

  it("stops pushing to a retired subscription when the subscription file cannot be written", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    push.subscribe(fake.subscription, undefined, null);
    push.publicKey();
    fake.answerWith(410);
    const rename = spyOn(privateStateFs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); });
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
      expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
      expect(fake.received).toHaveLength(0);
      expect(quiet.mock.calls.some(([line]) => String(line).includes("push-subscriptions.json"))).toBe(true);
    } finally { rename.mockRestore(); quiet.mockRestore(); }
    expect(await createPushService({ loopbackHttp: true, stateDir }).sendTest(fake.subscription.endpoint)).toBeNull();
    expect(fake.received).toHaveLength(0);
    push.unsubscribe(fake.subscription.endpoint);
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
    expect(await createPushService({ loopbackHttp: true, stateDir }).sendTest(fake.subscription.endpoint)).toBeNull();
    push.subscribe({ ...fake.subscription, endpoint: `${fake.subscription.endpoint}-other` }, undefined, null);
    expect((JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8")) as { endpoint: string }[]).map((entry) => entry.endpoint)).toEqual([`${fake.subscription.endpoint}-other`]);
  });

  // regression: storing endpoints normalized let a key pair push-keys.json kept for another spelling sign for this one
  it("keeps a subscription and the key pair it was made for under the spelling it was handed over", async () => {
    const { endpoint, keys } = fake.subscription;
    expect(parseSubscription({ endpoint: `${endpoint}#x`, keys }, { loopbackHttp: true })?.endpoint).toBe(`${endpoint}#x`);
    const stale = webpush.generateVAPIDKeys();
    writeFileSync(join(stateDir, "push-keys.json"), JSON.stringify({ keys: [{ ...stale, endpoints: [`${endpoint}#old-import`] }] }));
    const push = subscribed();
    expect(await push.sendTest(endpoint)).toEqual({ ok: true });
    expect(fake.received[0]).toMatchObject({ vapidKey: push.publicKey(), vapidValid: true });
  });

  // regression (fails on main): a fragment, or any other spelling of the same URL, got past the retired check (#2012)
  it("refuses another spelling of a retired endpoint as that endpoint", async () => {
    const push = subscribed();
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const post = (path: string, body: unknown) => handlePushRequest(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }), path, push, "watch");
    const url = new URL(fake.subscription.endpoint);
    const variants = [`${fake.subscription.endpoint}#attacker`, `HTTP://${url.host}/push/x/..${url.pathname.slice("/push".length)}`];
    for (const endpoint of variants) {
      const again = (await post("/api/push/subscribe", { subscription: { ...fake.subscription, endpoint } }))!;
      expect(again.status).toBe(410);
      const tested = (await post("/api/push/test", { endpoint }))!;
      expect(tested.status).toBe(410);
    }
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
  });

  it("keeps a device through a failure that is not a goodbye", async () => {
    const push = subscribed();
    fake.answerWith(500);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 500, gone: false });
    const response = await handlePushRequest(new Request("http://localhost/api/push/test", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: fake.subscription.endpoint }),
    }), "/api/push/test", push, null);
    expect(response?.status).toBe(502);
    expect((await response?.json()).error.code).toBe("push_failed");
    fake.answerWith(201);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });
});

describe("alert timing and each device's choice", () => {
  const SHORT = 40;
  const LONG = 80;
  function timed(alerts?: AlertPrefs) {
    let clock = 0;
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: SHORT, long: LONG, longTurn: 1_000 }, now: () => clock });
    push.subscribe(fake.subscription, alerts);
    push.seed([pane("w1:p1", "idle", "claude")]);
    return { push, advance: (ms: number) => { clock += ms; } };
  }

  it("calls off a derived Codex finish when it is seen or a new turn begins", async () => {
    const { push } = timed({ input: true, done: "always" });
    const completions = new CompletionTracker();
    const report = (status: AgentStatus) => push.onStatus("w1:p1", completions.observe("w1:p1", status, "codex"));
    await report("working");
    await report("unknown");
    expect(completions.seen("w1:p1")).toBe(true);
    await push.onStatus("w1:p1", "idle");
    await push.settled();
    expect(fake.received).toHaveLength(0);

    await report("working");
    await report("unknown");
    await report("working");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await report("unknown");
    await push.settled();
    expect(fake.received.map((message) => message.payload.body)).toEqual(["work finished"]);
  });

  function holdAlertTimers() {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const held = new Map<object, () => void>();
    const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== SHORT && ms !== LONG) return realSet(callback, ms, ...args);
      const handle = {};
      held.set(handle, () => callback(...args));
      return handle;
    }) as never);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
      if (!held.delete(handle as object)) realClear(handle as Parameters<typeof clearTimeout>[0]);
    }) as never);
    return {
      pending: () => held.size,
      fire() {
        const due = [...held.values()];
        held.clear();
        for (const run of due) run();
      },
      restore() { set.mockRestore(); clear.mockRestore(); },
    };
  }

  it("calls off a question answered before it goes out, and sends one left waiting", async () => {
    const timers = holdAlertTimers();
    try {
      const { push } = timed();
      await push.onStatus("w1:p1", "working");
      await push.onStatus("w1:p1", "blocked");
      expect(timers.pending()).toBe(1);
      await push.onStatus("w1:p1", "working");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      await push.onStatus("w1:p1", "blocked");
      timers.fire();
      await push.settled();
      expect(fake.received.map((r) => r.payload.body)).toEqual(["waiting for your input"]);
    } finally { timers.restore(); }
  });

  it("tells a finish only after a turn that worked a while, and not one followed by the next prompt", async () => {
    const timers = holdAlertTimers();
    try {
      const { push, advance } = timed();
      await push.onStatus("w1:p1", "working");
      advance(500);
      await push.onStatus("w1:p1", "done");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      await push.onStatus("w1:p1", "working");
      advance(2_000);
      await push.onStatus("w1:p1", "done");
      expect(timers.pending()).toBe(1);
      await push.onStatus("w1:p1", "working");
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
      advance(2_000);
      await push.onStatus("w1:p1", "done");
      timers.fire();
      await push.settled();
      expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
    } finally { timers.restore(); }
  });

  it("tells a new pane's first reading as a change from its creation, once, never between two readings at rest nor for a pane it heard of", async () => {
    const timers = holdAlertTimers();
    try {
      const { push } = timed({ input: true, done: "always" });
      await push.firstStatus("w2:p1", "unknown", "blocked");
      await push.onStatus("w2:p1", "blocked");
      expect(timers.pending()).toBe(1);
      await push.firstStatus("w3:p1", "unknown", "done");
      await push.firstStatus("w4:p1", "idle", "done");
      await push.firstStatus("w5:p1", "unknown", "working");
      await push.firstStatus("w1:p1", "unknown", "blocked");
      expect(timers.pending()).toBe(2);
      timers.fire();
      await push.settled();
      expect(fake.received.map((r) => `${r.payload.pane_id} ${r.payload.body}`).sort()).toEqual(["w2:p1 waiting for your input", "w3:p1 work finished"]);
      // what it was first read as is what the next change is measured against
      await push.onStatus("w4:p1", "done");
      await push.onStatus("w5:p1", "working");
      expect(timers.pending()).toBe(0);
    } finally { timers.restore(); }
  });

  it("calls off a new pane's first question once a snapshot no longer lists it", async () => {
    const timers = holdAlertTimers();
    try {
      const { push } = timed();
      await push.firstStatus("w2:p1", "unknown", "blocked");
      expect(timers.pending()).toBe(1);
      push.gone([pane("w1:p1", "idle", "claude")], new Set());
      expect(timers.pending()).toBe(0);
      await push.settled();
      expect(fake.received).toHaveLength(0);
    } finally { timers.restore(); }
  });

  it("does not time a turn from a new pane's first reading: it began before anyone read it", async () => {
    const timers = holdAlertTimers();
    try {
      const { push, advance } = timed();
      await push.firstStatus("w2:p1", "unknown", "working");
      await push.firstStatus("w3:p1", "unknown", "blocked");
      timers.fire();
      await push.settled();
      fake.received.length = 0;
      advance(500);
      await push.onStatus("w2:p1", "done");
      await push.onStatus("w3:p1", "done");
      expect(timers.pending()).toBe(2);
      timers.fire();
      await push.settled();
      expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished", "work finished"]);
    } finally { timers.restore(); }
  });

  it("follows what the device chose: no questions, every finish, or no finish at all", async () => {
    const quiet = timed({ input: false, done: "always" });
    await quiet.push.onStatus("w1:p1", "blocked");
    await quiet.push.onStatus("w1:p1", "done");
    await quiet.push.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
    fake.received.length = 0;
    const none = timed({ input: true, done: "off" });
    await none.push.onStatus("w1:p1", "working");
    none.advance(5_000);
    await none.push.onStatus("w1:p1", "done");
    await none.push.onEnded("w1:p1");
    await none.push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("tells a permission apart from a question, and one never chosen follows questions", async () => {
    let agentKind: string | undefined = "permission";
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 },
      lookupPane: async () => ({ title: "claude", ...(agentKind ? { agent_kind: agentKind } : {}) }) });
    push.seed([pane("w1:p1", "working", "claude")]);
    const ask = async (alerts: AlertPrefs) => {
      push.subscribe(fake.subscription, alerts);
      await push.onStatus("w1:p1", "working");
      await push.onStatus("w1:p1", "blocked");
      await push.settled();
      const kinds = fake.received.map((r) => r.payload.kind);
      fake.received.length = 0;
      return kinds;
    };
    expect(await ask({ input: false, done: "off", permission: true })).toEqual(["permission"]);
    expect(await ask({ input: false, done: "off" })).toEqual([]);
    expect(await ask({ input: true, done: "off" })).toEqual(["permission"]);
    expect(await ask({ input: true, done: "off", permission: false })).toEqual([]);
    agentKind = undefined;
    expect(await ask({ input: true, done: "off", permission: false })).toEqual(["input"]);
    expect(await ask({ input: false, done: "off", permission: true })).toEqual([]);
  });

  it("tells a turn that stopped on an error only to a device that asked, unless the pane moves on first", async () => {
    const off = timed({ input: true, done: "always" });
    await off.push.onStatus("w1:p1", "working");
    await off.push.onStatus("w1:p1", "idle");
    await off.push.onFailed("w1:p1");
    await off.push.settled();
    expect(fake.received).toHaveLength(0);

    const on = timed({ input: true, done: "off", error: true });
    await on.push.onStatus("w1:p1", "working");
    await on.push.onStatus("w1:p1", "idle");
    await on.push.onFailed("w1:p1");
    await on.push.settled();
    expect(fake.received.map((r) => [r.payload.kind, r.payload.body])).toEqual([["error", "stopped on an error"]]);
    fake.received.length = 0;
    await on.push.onStatus("w1:p1", "working");
    await on.push.onStatus("w1:p1", "idle");
    await on.push.onFailed("w1:p1");
    await on.push.onStatus("w1:p1", "working");
    await on.push.settled();
    expect(fake.received).toHaveLength(0);
    await on.push.onFailed("w1:p1");
    await on.push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("asks a waiting alert's device again for the PC as the alert goes out", async () => {
    const { push } = timed({ input: true, done: "off" });
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    push.subscribe(fake.subscription, { input: true, done: "off", pcs_off: [hostname()] });
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("tells nothing of a PC the device turned off, by the name the roster gives it", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir, localName: "Desk", timing: { short: 0, long: 0, longTurn: 0 } });
    push.subscribe(fake.subscription, { input: true, done: "always", pcs_off: ["Home PC"] });
    push.seed([pane("w1:p1", "working", "alpha")]);
    push.seed([pane("w1:p1", "working", "beta")], "pc-b", "Home PC");
    await push.onStatus("w1:p1", "blocked", "pc-b");
    await push.onEnded("w1:p1", "pc-b");
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(fake.received.map((r) => r.payload.machine_id ?? "local")).toEqual(["local"]);
    fake.received.length = 0;
    push.subscribe(fake.subscription, { input: true, done: "always", pcs_off: ["Desk"] });
    await push.onStatus("w1:p1", "done");
    await push.onEnded("w1:p1");
    await push.onStatus("w1:p1", "working", "pc-b");
    await push.onStatus("w1:p1", "done", "pc-b");
    await push.settled();
    expect(fake.received.map((r) => r.payload.machine_id ?? "local")).toEqual(["pc-b"]);
  });

  it("tells nothing of a PC the device turned off by its relay ID, whatever the roster it was turned off in calls it (#2876)", async () => {
    const own = "ab".repeat(16), other = "cd".repeat(16);
    const push = createPushService({ loopbackHttp: true, stateDir, serverId: () => own, timing: { short: 0, long: 0, longTurn: 0 } });
    push.subscribe(fake.subscription, { input: true, done: "always", pcs_off: [own, other] });
    push.seed([pane("w1:p1", "working", "alpha")]);
    push.seed([pane("w1:p1", "working", "beta")], "pc-b", "Home PC", other);
    push.seed([pane("w1:p1", "working", "gamma")], "pc-c", "Laptop");
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p1", "blocked", "pc-b");
    await push.onStatus("w1:p1", "blocked", "pc-c");
    await push.settled();
    expect(fake.received.map((r) => r.payload.machine_id ?? "local")).toEqual(["pc-c"]);
  });

  it("keeps a device's choice through a re-registration without one, and a restart", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    push.subscribe(fake.subscription, { input: false, done: "off" });
    push.subscribe(fake.subscription);
    const stored = JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8")) as Array<{ alerts?: AlertPrefs }>;
    expect(stored[0]!.alerts).toEqual({ input: false, done: "off" });
    const restarted = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 } });
    restarted.seed([pane("w1:p1", "working", "claude")]);
    await restarted.onStatus("w1:p1", "blocked");
    await restarted.settled();
    expect(fake.received).toHaveLength(0);
  });
});

it("cancels the remaining delay group after an earlier device already received its finish", async () => {
  const slower = await startFakePushService();
  try {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 10_000, longTurn: 0 } });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.subscribe(slower.subscription, { input: true, done: "long" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await fake.waitFor((message) => message.payload.body === "work finished", "early finish", 2000);
    await push.onStatus("w1:p1", "working");
    await push.settled();
    expect(slower.received).toHaveLength(0);
  } finally { slower.stop(); }
});

it("settles only after a delivery already under way, when a later group is called off", async () => {
  let release!: () => void;
  let asked!: () => void;
  const titleAsked = new Promise<void>((resolve) => { asked = resolve; });
  const push = createPushService({
    loopbackHttp: true,
    stateDir, timing: { short: 0, long: 10_000, longTurn: 0 },
    lookupPane: () => { asked(); return new Promise((resolve) => { release = () => resolve({ title: "claude" }); }); },
  });
  const slower = await startFakePushService();
  try {
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.subscribe(slower.subscription, { input: true, done: "long" });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await titleAsked;
    await push.onStatus("w1:p1", "working");
    const settling = push.settled().then(() => fake.received.length);
    release();
    expect(await settling).toBe(1);
    expect(slower.received).toHaveLength(0);
  } finally { slower.stop(); }
});


it("persists device ownership and refuses revoked and legacy subscriptions after restart", async () => {
  const active = new Set(["device-a"]);
  const canDeliver = (id: string | null | undefined) => id === null || typeof id === "string" && active.has(id);
  const push = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  push.subscribe(fake.subscription, undefined, "device-a");
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0].device_id).toBe("device-a");
  active.clear();
  const restarted = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  await restarted.onEnded("w1:p1");
  expect(fake.received).toHaveLength(0);
  restarted.revokeDevice("device-a");
  expect(await restarted.sendTest(fake.subscription.endpoint)).toBeNull();
  // Legacy records cannot identify a revoked device; re-registration supplies an owner.
  push.subscribe(fake.subscription);
  const migrated = createPushService({ loopbackHttp: true, stateDir, canDeliver });
  await migrated.onEnded("w1:p1");
  expect(fake.received).toHaveLength(0);
  migrated.subscribe(fake.subscription, undefined, null);
  await migrated.onEnded("w1:p1");
  expect(fake.received).toHaveLength(1);
});

it("keeps a pending alert across re-registration but drops it after device revocation", async () => {
  const active = new Set(["device-a"]);
  const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 20 }, canDeliver: (id) => typeof id === "string" && active.has(id) });
  push.subscribe(fake.subscription, undefined, "device-a");
  push.seed([pane("w1:p1", "working", "claude")]);
  await push.onStatus("w1:p1", "blocked");
  push.subscribe(fake.subscription, undefined, "device-a");
  await push.settled();
  expect(fake.received).toHaveLength(1);
  await push.onStatus("w1:p1", "working");
  await push.onStatus("w1:p1", "blocked");
  active.clear();
  // The registry still blocks delivery if push-file cleanup cannot run.
  await push.settled();
  expect(fake.received).toHaveLength(1);
});

it("revoked owner cannot receive queued push", async () => {
  const devices = new DeviceStore(stateDir);
  const owner = devices.pair(devices.startPairing().code, "Owner", "drive")!;
  devices.match(owner.token);
  // the server's rule (server/core/status.ts): a device's subscription delivers only while that device is paired
  const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 20 }, canDeliver: (id) => id === null || (id === undefined ? !devices.gated : devices.has(id)) });
  push.subscribe(fake.subscription, undefined, owner.device.id);
  push.seed([pane("w1:p1", "working", "claude")]);
  await push.onStatus("w1:p1", "blocked");
  // every device is revoked while the alert waits: the registry alone keeps it from going out,
  // before any push-file cleanup has run
  expect(devices.revokeAll()).toEqual([owner.device.id]);
  await push.settled();
  expect(fake.received).toHaveLength(0);
  await push.onStatus("w1:p1", "working");
  await push.onStatus("w1:p1", "blocked");
  await push.settled();
  expect(fake.received).toHaveLength(0);
  // the cleanup that follows works from the revoked ids and forgets the subscription for good
  push.revokeDevice(owner.device.id);
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
});

it("tells every other subscriber of a durable enrollment at once, and never the new device", async () => {
  const other = await startFakePushService();
  try {
    const devices = new DeviceStore(stateDir);
    // a window in use holds alerts back (#751); an enrollment is told regardless, since that window may be the new device's
    const push = createPushService({ loopbackHttp: true, stateDir, inUse: () => true, canDeliver: (id) => id === null || (id === undefined ? !devices.gated : devices.has(id)) });
    const deliveries: Promise<void>[] = [];
    devices.onPaired((event) => deliveries.push(push.devicePaired(event)));
    // the first device: its credential is issued unconfirmed, so its id is known before it is enrolled
    const tablet = devices.pair(devices.startPairing().code, "Tablet", "drive")!;
    push.subscribe(fake.subscription, undefined, null);
    push.subscribe(other.subscription, undefined, tablet.device.id);
    expect(deliveries).toHaveLength(0);
    // its first request back is the durable enrollment
    devices.match(tablet.token);
    expect(deliveries).toHaveLength(1);
    await Promise.all(deliveries);
    expect(fake.received.map((push) => push.payload)).toEqual([{ pane_id: null, title: "Ovis", body: "New device paired: Tablet", tag: expect.stringMatching(/^herdr-device-paired-[0-9a-f]{16}$/) }]);
    expect(fake.received[0]!.urgency).toBe("high");
    expect(other.received).toHaveLength(0);
    // a gated pairing is durable at once: both the PC's browser and the tablet hear of the phone
    const phone = devices.pair(devices.startPairing().code, "Phone", "drive")!;
    expect(deliveries).toHaveLength(2);
    await Promise.all(deliveries);
    expect(fake.received.map((push) => push.payload.body)).toEqual(["New device paired: Tablet", "New device paired: Phone"]);
    expect(other.received.map((push) => push.payload.body)).toEqual(["New device paired: Phone"]);
    expect(fake.received[1]!.payload.tag).not.toBe(fake.received[0]!.payload.tag);
    devices.match(phone.token, Date.now() + 120_000);
    devices.update(phone.device.id, { label: "Pixel" });
    expect(deliveries).toHaveLength(2);
  } finally { other.stop(); }
});

it("never pushes a browser's own pairing to it, before or after it paired, while others sharing its sign-in hear it", async () => {
  const sibling = await startFakePushService();
  const keyless = await startFakePushService();
  try {
    const devices = new DeviceStore(stateDir);
    devices.match(devices.pair(devices.startPairing().code, "First", "drive")!.token);
    let push = createPushService({ loopbackHttp: true, stateDir, inUse: () => true, canDeliver: (id) => id === null || (id === undefined ? !devices.gated : devices.has(id)) });
    const deliveries: Promise<void>[] = [];
    devices.onPaired((event, origin) => deliveries.push(push.devicePaired(event, origin)));
    const self = "a".repeat(32);
    const raced = "c".repeat(32);
    const subscribe = (subscription: unknown, owner: string | null, keys: string[]) => handlePushRequest(new Request("http://localhost/api/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription }),
    }), "/api/push/subscribe", push, owner, keys);
    expect((await subscribe(fake.subscription, null, [self]))?.status).toBe(204);
    expect((await subscribe(sibling.subscription, null, ["b".repeat(32)]))?.status).toBe(204);
    expect((await subscribe(keyless.subscription, null, []))?.status).toBe(204);
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0]).toMatchObject({ device_id: null, browser_keys: [self] });
    push = createPushService({ loopbackHttp: true, stateDir, inUse: () => true, canDeliver: (id) => id === null || (id === undefined ? !devices.gated : devices.has(id)) });
    const own = devices.pair(devices.startPairing().code, "Self", "drive", Date.now(), [raced, self])!;
    await Promise.all(deliveries);
    expect(fake.received).toHaveLength(0);
    expect(sibling.received.map((push) => push.payload.body)).toEqual(["New device paired: Self"]);
    expect(keyless.received.map((push) => push.payload.body)).toEqual(["New device paired: Self"]);
    // re-registered on load, now owned by the device it paired, with no key this time: it keeps its browser
    expect((await subscribe(fake.subscription, own.device.id, []))?.status).toBe(204);
    // a key this browser was issued later (it had lost its cookie) is added to the ones it had, not swapped for them
    const reissued = "e".repeat(32);
    expect((await subscribe(fake.subscription, own.device.id, [reissued]))?.status).toBe(204);
    expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0]).toMatchObject({ device_id: own.device.id, browser_keys: [self, reissued] });
    devices.pair(devices.startPairing().code, "Again", "drive", Date.now(), [self]);
    await Promise.all(deliveries);
    expect(fake.received).toHaveLength(0);
    expect(sibling.received.map((push) => push.payload.body)).toEqual(["New device paired: Self", "New device paired: Again"]);
    devices.pair(devices.startPairing().code, "Elsewhere", "drive", Date.now(), ["d".repeat(32)]);
    await Promise.all(deliveries);
    expect(fake.received.map((push) => push.payload.body)).toEqual(["New device paired: Elsewhere"]);
  } finally { sibling.stop(); keyless.stop(); }
});

it("keeps a subscription made through the open LAN only while the LAN stays open", async () => {
  let gated = false;
  // the server's rule (index.ts): owners null always, undefined only while ungated
  const push = createPushService({ loopbackHttp: true, stateDir, canDeliver: (id) => id === null || (id === undefined ? !gated : false) });
  const request = new Request("http://192.168.1.20:8787/api/push/subscribe", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: fake.subscription }),
  });
  expect((await handlePushRequest(request, "/api/push/subscribe", push, undefined))?.status).toBe(204);
  expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))[0]).not.toHaveProperty("device_id");
  await push.onEnded("w1:p1");
  expect(fake.received).toHaveLength(1);
  // pairing a device closes the open LAN: its earlier subscriber hears nothing more
  gated = true;
  await push.onEnded("w1:p2");
  expect(fake.received).toHaveLength(1);
});

describe("push delivery health (#1039)", () => {
  const statusRequest = (push: PushService, subscription: unknown, owner: string | null | undefined) => handlePushRequest(new Request("http://localhost/api/push/status", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription }),
  }), "/api/push/status", push, owner);

  it("gone history survives restart", async () => {
    let clock = 1_700_000_000_000;
    const push = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    push.subscribe(fake.subscription, undefined, null);
    expect(push.status(fake.subscription, null)).toEqual({ registered: true, last_success_at: null, last_failure_at: null, last_failure: null });
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    clock += 1000;
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const expected = { registered: false, last_success_at: new Date(1_700_000_000_000).toISOString(), last_failure_at: new Date(1_700_000_001_000).toISOString(), last_failure: "gone" as const };
    expect(push.status(fake.subscription, null)).toEqual(expected);
    // the record is owner-only and names neither the endpoint nor the keys
    const path = join(stateDir, "push-delivery.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(fake.subscription.endpoint);
    expect(raw).not.toContain(fake.subscription.keys.p256dh);
    expect(raw).not.toContain(fake.subscription.keys.auth);
    // a restart keeps it, and the key pair every device is bound to
    const vapid = readFileSync(join(stateDir, "vapid.json"), "utf8");
    const restarted = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    expect(restarted.status(fake.subscription, null)).toEqual(expected);
    expect(restarted.publicKey()).toBe(push.publicKey());
    expect(readFileSync(join(stateDir, "vapid.json"), "utf8")).toBe(vapid);
    const response = (await statusRequest(restarted, fake.subscription, null))!;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    // forgotten after its time to live (the retired mark is not: #2012)
    expect(createPushService({ loopbackHttp: true, stateDir, now: () => clock + 31 * 24 * 60 * 60 * 1000 }).status(fake.subscription, null)).toBeNull();
    restarted.unsubscribe(fake.subscription.endpoint);
    expect(restarted.status(fake.subscription, null)).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual([]);
  });

  it("expires the history on the running service, never the retired mark; a goodbye takes the history, and only a revocation also the mark", async () => {
    let clock = 1_700_000_000_000;
    const push = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    const endpoint = fake.subscription.endpoint;
    const retire = async (owner: string | null): Promise<void> => {
      push.subscribe(fake.subscription, undefined, owner);
      fake.answerWith(410);
      expect(await push.sendTest(endpoint)).toEqual({ ok: false, status: 410, gone: true });
      expect(push.status(fake.subscription, owner)?.last_failure).toBe("gone");
      expect(push.retired(endpoint)).toBe(true);
    };
    // 31 days on, without a restart: the history is gone, on disk too, and the retired mark stays (#2012)
    await retire(null);
    clock += 31 * 24 * 60 * 60 * 1000;
    expect(push.status(fake.subscription, null)).toBeNull();
    expect(push.retired(endpoint)).toBe(true);
    expect(JSON.parse(readFileSync(join(stateDir, "push-delivery.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(stateDir, "push-retired.json"), "utf8"))).toHaveLength(1);
    // an explicit unsubscribe forgets the history, and keeps the mark: it proves neither owner nor keys
    await retire(null);
    push.unsubscribe(endpoint);
    expect(push.status(fake.subscription, null)).toBeNull();
    expect(push.retired(endpoint)).toBe(true);
    await retire("device-a");
    push.revokeDevice("device-a");
    expect(push.status(fake.subscription, "device-a")).toBeNull();
    expect(push.retired(endpoint)).toBe(false);
    expect(createPushService({ loopbackHttp: true, stateDir, now: () => clock }).retired(endpoint)).toBe(false);
  });

  it("revocation removes owned health", async () => {
    const other = await startFakePushService();
    try {
      const push = createPushService({ loopbackHttp: true, stateDir });
      push.subscribe(fake.subscription, undefined, "device-a");
      push.subscribe(other.subscription, undefined, "device-b");
      expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
      expect(await push.sendTest(other.subscription.endpoint)).toEqual({ ok: true });
      expect(push.status(fake.subscription, "device-a")?.last_success_at).not.toBeNull();
      push.revokeDevice("device-a");
      expect(push.status(fake.subscription, "device-a")).toBeNull();
      expect(JSON.parse(readFileSync(join(stateDir, "push-delivery.json"), "utf8"))).toHaveLength(1);
      expect(push.status(other.subscription, "device-b")?.last_success_at).not.toBeNull();
      // the revoked device's record is not recreated by a restart either
      expect(createPushService({ loopbackHttp: true, stateDir }).status(fake.subscription, "device-a")).toBeNull();
    } finally { other.stop(); }
  });

  it("revocation removes a retired mark whose history was evicted", async () => {
    let clock = 1_700_000_000_000;
    const push = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    const endpoint = fake.subscription.endpoint;
    push.subscribe(fake.subscription, undefined, "device-a");
    fake.answerWith(410);
    expect(await push.sendTest(endpoint)).toEqual({ ok: false, status: 410, gone: true });
    expect(push.retired(endpoint)).toBe(true);
    const path = join(stateDir, "push-delivery.json");
    const [owned] = JSON.parse(readFileSync(path, "utf8")) as { keys: string }[];
    const later = Array.from({ length: 999 }, (_, index) => ({ hash: `later-${index}`, owner: "device-b", keys: owned!.keys, success_at: clock + index + 1, failure_at: null, failure: null, at: clock + index + 1 }));
    writeFileSync(path, JSON.stringify([owned, ...later]));
    clock += 2000;
    const restarted = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    const newest = { ...fake.subscription, endpoint: `${endpoint}-b` };
    restarted.subscribe(newest, undefined, "device-b");
    fake.answerWith(201);
    expect(await restarted.sendTest(newest.endpoint)).toEqual({ ok: true });
    expect(restarted.status(fake.subscription, "device-a")).toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(1000);
    expect(restarted.retired(endpoint)).toBe(true);
    // the retired mark knows its owner by itself: the revocation takes it, and a restart does not bring it back
    restarted.revokeDevice("device-a");
    expect(restarted.retired(endpoint)).toBe(false);
    expect(createPushService({ loopbackHttp: true, stateDir, now: () => clock }).retired(endpoint)).toBe(false);
    // another device's revocation leaves a mark it does not own
    fake.answerWith(410);
    const third = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    third.subscribe(fake.subscription, undefined, "device-c");
    expect(await third.sendTest(endpoint)).toEqual({ ok: false, status: 410, gone: true });
    third.revokeDevice("device-b");
    expect(third.retired(endpoint)).toBe(true);
    expect(createPushService({ loopbackHttp: true, stateDir, now: () => clock }).retired(endpoint)).toBe(true);
  });

  // regression: two owners' spellings of one endpoint share its mark, and the last retirement took it for its owner alone
  it("keeps a mark two owners' spellings were retired under through either owner's revocation", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const endpoint = fake.subscription.endpoint;
    push.subscribe(fake.subscription, undefined, "device-a");
    push.subscribe({ ...fake.subscription, endpoint: `${endpoint}#b` }, undefined, "device-b");
    fake.answerWith(410);
    expect(await push.sendTest(endpoint)).toEqual({ ok: false, status: 410, gone: true });
    expect(await push.sendTest(`${endpoint}#b`)).toEqual({ ok: false, status: 410, gone: true });
    push.revokeDevice("device-b");
    expect(push.retired(endpoint)).toBe(true);
    push.revokeDevice("device-a");
    expect(push.retired(endpoint)).toBe(true);
    expect(createPushService({ loopbackHttp: true, stateDir }).retired(endpoint)).toBe(true);
  });

  it("writes the marks a revocation removed before the endpoint is subscribed again", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    push.subscribe(fake.subscription, undefined, "device-a");
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    const blocker = join(stateDir, `push-retired.json.${process.pid}.tmp`);
    mkdirSync(blocker);
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try { push.revokeDevice("device-a"); } finally { quiet.mockRestore(); }
    rmSync(blocker, { recursive: true });
    const response = await handlePushRequest(new Request("http://localhost/api/push/subscribe", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: fake.subscription }),
    }), "/api/push/subscribe", push, "device-b");
    expect(response?.status).toBe(204);
    fake.answerWith(201);
    expect(await createPushService({ loopbackHttp: true, stateDir }).sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
  });

  it("revocation takes the device's history and marks when the retired list cannot be written", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    push.subscribe(fake.subscription, undefined, "device-a");
    fake.answerWith(410);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
    rmSync(join(stateDir, "push-retired.json"));
    mkdirSync(join(stateDir, "push-retired.json"));
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      push.revokeDevice("device-a");
      expect(push.retired(fake.subscription.endpoint)).toBe(false);
      expect(push.status(fake.subscription, "device-a")).toBeNull();
      expect(JSON.parse(readFileSync(join(stateDir, "push-delivery.json"), "utf8"))).toEqual([]);
    } finally { quiet.mockRestore(); }
  });

  it("foreign and unknown health are indistinguishable", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir });
    push.subscribe(fake.subscription, undefined, "device-a");
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    const own = (await statusRequest(push, fake.subscription, "device-a"))!;
    expect(own.status).toBe(200);
    expect(((await own.json()) as { registered: boolean }).registered).toBe(true);
    const unknown = (await statusRequest(push, { ...fake.subscription, endpoint: `${fake.subscription.endpoint}-never-known` }, "device-a"))!;
    const unknownBody = await unknown.json();
    expect(unknown.status).toBe(404);
    expect(unknownBody).toEqual({ error: { code: "subscription_not_found", message: "this device is not subscribed" } });
    const wrongKeys = { ...fake.subscription, keys: { ...fake.subscription.keys, auth: Buffer.alloc(16, 9).toString("base64url") } };
    for (const [label, subscription, owner] of [
      ["another device", fake.subscription, "device-b"],
      ["a local sign-in", fake.subscription, null],
      ["the owner with the wrong keys", wrongKeys, "device-a"],
    ] as const) {
      const response = (await statusRequest(push, subscription, owner))!;
      expect([label, response.status]).toEqual([label, 404]);
      expect([label, await response.json()]).toEqual([label, unknownBody]);
    }
    // the open LAN signs in as no device: told so alike for a known and an unknown subscription, before either is looked at
    for (const subscription of [fake.subscription, { ...fake.subscription, endpoint: `${fake.subscription.endpoint}-never-known` }]) {
      const response = (await statusRequest(push, subscription, undefined))!;
      expect([response.status, await response.json()]).toEqual([403, { error: { code: "status_unavailable", message: "this sign-in has no device to answer for" } }]);
    }
    // a retired subscription keeps the same rule: the tombstone answers its owner alone
    fake.answerWith(410);
    await push.sendTest(fake.subscription.endpoint);
    expect((await statusRequest(push, fake.subscription, "device-a"))!.status).toBe(200);
    expect((await statusRequest(push, fake.subscription, "device-b"))!.status).toBe(404);
    expect((await statusRequest(push, wrongKeys, "device-a"))!.status).toBe(404);
    // a legacy owner's own deliveries are recorded for nobody
    const legacy = createPushService({ loopbackHttp: true, stateDir: join(stateDir, "legacy") });
    fake.answerWith(201);
    legacy.subscribe(fake.subscription);
    expect(await legacy.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(legacy.status(fake.subscription, undefined)).toBeNull();
    expect(legacy.status(fake.subscription, null)).toBeNull();
  });

  it("late delivery cannot retire replacement", async () => {
    let arrived!: () => void;
    const requested = new Promise<void>((resolve) => { arrived = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const slow = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch() { arrived(); await held; return new Response(null, { status: 410 }); } });
    try {
      const push = createPushService({ loopbackHttp: true, stateDir });
      const endpoint = `http://127.0.0.1:${slow.port}/push/1`;
      const first = { ...fake.subscription, endpoint };
      push.subscribe(first, undefined, null);
      const delivery = push.sendTest(endpoint);
      await requested;
      const replacement = { endpoint, keys: { ...fake.subscription.keys, auth: Buffer.alloc(16, 7).toString("base64url") } };
      push.subscribe(replacement, undefined, "device-b");
      release();
      expect(await delivery).toEqual({ ok: false, status: 410, gone: true });
      // the replacement stays registered, is not retired, and carries no failure of the subscription before it
      expect(push.retired(endpoint)).toBe(false);
      expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toMatchObject([{ endpoint, device_id: "device-b" }]);
      expect(push.status(replacement, "device-b")).toEqual({ registered: true, last_success_at: null, last_failure_at: null, last_failure: null });
      expect(push.status(first, null)).toBeNull();
    } finally { release(); slow.stop(true); }
  });

  it("keeps at most as many records as retired endpoints, the oldest written forgotten first", async () => {
    const now = 1_700_000_000_000;
    const hashOf = (endpoint: string) => createHash("sha256").update(endpoint).digest("base64url");
    const keysOf = (keys: { p256dh: string; auth: string }) => createHash("sha256").update(`${keys.p256dh}.${keys.auth}`).digest("base64url");
    const endpointAt = (index: number) => `${fake.subscription.endpoint}-${index}`;
    const records = Array.from({ length: 1200 }, (_, index) => ({ hash: hashOf(endpointAt(index)), owner: null, keys: keysOf(fake.subscription.keys), success_at: now + index, failure_at: null, failure: null, at: now + index }));
    writeFileSync(join(stateDir, "push-delivery.json"), JSON.stringify(records));
    const push = createPushService({ loopbackHttp: true, stateDir, now: () => now + 2000 });
    for (const index of [0, 199]) expect(push.status({ ...fake.subscription, endpoint: endpointAt(index) }, null)).toBeNull();
    for (const index of [200, 1199]) expect(push.status({ ...fake.subscription, endpoint: endpointAt(index) }, null)?.registered).toBe(false);
    push.subscribe(fake.subscription, undefined, null);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(push.status({ ...fake.subscription, endpoint: endpointAt(200) }, null)).toBeNull();
    expect(push.status({ ...fake.subscription, endpoint: endpointAt(201) }, null)?.registered).toBe(false);
    expect(JSON.parse(readFileSync(join(stateDir, "push-delivery.json"), "utf8"))).toHaveLength(1000);
  });

  it("records a test push and every kind of answer, and a failure after a success stays history", async () => {
    let clock = 1_700_000_000_000;
    const push = createPushService({ loopbackHttp: true, stateDir, now: () => clock });
    push.subscribe(fake.subscription, undefined, null);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    for (const [status, failure] of [[503, "server"], [429, "throttled"], [403, "key-mismatch"], [401, "key-mismatch"], [400, "rejected"], [413, "rejected"]] as const) {
      clock += 1000;
      fake.answerWith(status);
      expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status, gone: false });
      expect(push.status(fake.subscription, null)).toEqual({ registered: true, last_success_at: new Date(1_700_000_000_000).toISOString(), last_failure_at: new Date(clock).toISOString(), last_failure: failure });
    }
    const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) });
    const unreachable = `http://127.0.0.1:${closed.port}/push/none`;
    closed.stop(true);
    push.subscribe({ ...fake.subscription, endpoint: unreachable }, undefined, null);
    clock += 1000;
    expect(await push.sendTest(unreachable)).toEqual({ ok: false, status: null, gone: false });
    expect(push.status({ ...fake.subscription, endpoint: unreachable }, null)?.last_failure).toBe("network");
    // delivery denied by the registry never went out: nothing is recorded for it
    const gated = createPushService({ loopbackHttp: true, stateDir, now: () => clock, canDeliver: () => false });
    clock += 1000;
    expect(await gated.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: null, gone: false });
    expect(gated.status(fake.subscription, null)?.last_failure_at).toBe(new Date(clock - 2000).toISOString());
    writeFileSync(join(stateDir, "push-delivery.json"), "not json");
    expect(createPushService({ loopbackHttp: true, stateDir }).status(fake.subscription, null)).toEqual({ registered: true, last_success_at: null, last_failure_at: null, last_failure: null });
    const hash = createHash("sha256").update(fake.subscription.endpoint).digest("base64url");
    const keys = createHash("sha256").update(`${fake.subscription.keys.p256dh}.${fake.subscription.keys.auth}`).digest("base64url");
    for (const times of [{ success_at: 1e100 }, { failure_at: -1e100, failure: "gone" }, { at: 1e100 }]) {
      writeFileSync(join(stateDir, "push-delivery.json"), JSON.stringify([{ hash, owner: null, keys, success_at: clock, failure_at: null, failure: null, at: clock, ...times }]));
      expect(createPushService({ loopbackHttp: true, stateDir, now: () => clock }).status(fake.subscription, null)).toEqual({ registered: true, last_success_at: null, last_failure_at: null, last_failure: null });
    }
  });

  it("rewrites its files without what expired, so a revocation leaves nothing of the device on disk", () => {
    const now = 1_700_000_000_000;
    const old = now - 31 * 24 * 60 * 60 * 1000;
    writeFileSync(join(stateDir, "push-delivery.json"), JSON.stringify([
      { hash: "h-old", owner: "device-x", keys: "k", success_at: old, failure_at: null, failure: null, at: old },
      { hash: "h-new", owner: "device-y", keys: "k", success_at: now, failure_at: null, failure: null, at: now },
    ]));
    writeFileSync(join(stateDir, "push-retired.json"), JSON.stringify([{ hash: "h-old", at: old, owner: "device-x" }, { hash: "h-new", at: now, owner: "device-y" }]));
    // the expired history of device-x is already gone from memory: revoking it must still clear it from disk
    createPushService({ loopbackHttp: true, stateDir, now: () => now }).revokeDevice("device-x");
    const hashes = (file: string) => (JSON.parse(readFileSync(join(stateDir, file), "utf8")) as { hash: string }[]).map((entry) => entry.hash);
    expect(hashes("push-delivery.json")).toEqual(["h-new"]);
    expect(hashes("push-retired.json")).toEqual(["h-new"]);
  });

  it("forgets a retired subscription when the retired list cannot be written, and keeps the mark in memory", async () => {
    mkdirSync(join(stateDir, "push-retired.json"));
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const push = createPushService({ loopbackHttp: true, stateDir });
      push.subscribe(fake.subscription, undefined, null);
      fake.answerWith(410);
      expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
      expect(JSON.parse(readFileSync(join(stateDir, "push-subscriptions.json"), "utf8"))).toEqual([]);
      expect(await push.sendTest(fake.subscription.endpoint)).toBeNull();
      expect(push.retired(fake.subscription.endpoint)).toBe(true);
      // the browser handing it over again is still told to subscribe anew
      const response = await handlePushRequest(new Request("http://localhost/api/push/subscribe", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription: fake.subscription }),
      }), "/api/push/subscribe", push, null);
      expect(response?.status).toBe(410);
      expect(quiet.mock.calls.some(([line]) => String(line).includes("push-retired.json"))).toBe(true);
    } finally { quiet.mockRestore(); }
  });

  it("counts a push's outcome, a retirement included, when its record cannot be written", async () => {
    mkdirSync(join(stateDir, "push-delivery.json"));
    const quiet = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const push = createPushService({ loopbackHttp: true, stateDir });
      push.subscribe(fake.subscription, undefined, null);
      expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
      expect(push.status(fake.subscription, null)?.last_success_at).not.toBeNull();
      fake.answerWith(410);
      expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: false, status: 410, gone: true });
      expect(push.retired(fake.subscription.endpoint)).toBe(true);
      expect(push.status(fake.subscription, null)).toMatchObject({ registered: false, last_failure: "gone" });
      expect(quiet.mock.calls.some(([line]) => String(line).includes("push-delivery.json"))).toBe(true);
    } finally { quiet.mockRestore(); }
  });
});

it("never follows a redirect: an https endpoint cannot send the alert on to a local service", async () => {
  // a push service never redirects; one that does is an endpoint pointing the POST elsewhere
  const redirector = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { location: fake.subscription.endpoint } }) });
  try {
    const push = createPushService({ loopbackHttp: true, stateDir });
    const endpoint = `http://127.0.0.1:${redirector.port}/push/1`;
    push.subscribe({ ...fake.subscription, endpoint });
    const delivery = await push.sendTest(endpoint);
    expect(delivery?.ok).toBe(false);
    expect(fake.received).toHaveLength(0);
  } finally { redirector.stop(true); }
});

describe("a window of the app in use (#751)", () => {
  it("sends no device an alert while some window is in use, and sends again once none is", async () => {
    let inUse = true;
    const push = subscribed({ inUse: () => inUse });
    push.seed([pane("w1:p1", "working", "claude: fix the build")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onEnded("w1:p1");
    expect(fake.received).toHaveLength(0);
    expect(await push.sendTest(fake.subscription.endpoint)).toEqual({ ok: true });
    expect(fake.received.map((r) => r.payload.tag)).toEqual(["herdr-test"]);
    inUse = false;
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received.map((r) => r.payload.body)).toEqual(["Alerts are on for this device", "waiting for your input"]);
  });

  it("asks when the alert would go out, not when the status changed", async () => {
    let inUse = false;
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, inUse: () => inUse });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    inUse = true;
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("holds an alert when a window comes into use while its title is looked up", async () => {
    let inUse = false;
    const push = subscribed({ inUse: () => inUse, lookupPane: async () => { inUse = true; return { title: "claude" }; } });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(0);
  });
});

describe("push resync after lost status events", () => {
  it("calls off the waiting alert of a pane that closed while events were lost", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 50, long: 50, longTurn: 0 } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "gone"), pane("w1:p2", "working", "kept"), pane("w1:p3", "working", "new")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p3", "blocked");
    push.resync([pane("w1:p2", "working", "kept")], new Set(["w1:p3"]));
    await push.settled();
    expect(fake.received.map((r) => r.payload.title)).toEqual(["new"]);
  });

  it("takes a clean pane's snapshot status as its baseline and announces nothing", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "claude")]);
    push.resync([pane("w1:p1", "blocked", "claude")], new Set());
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p1", "done");
    expect(fake.received.map((r) => r.payload.body)).toHaveLength(1);
  });

  it("calls off an alert still waiting for a pane that is at rest by the snapshot", async () => {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 50, long: 50, longTurn: 0 } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    push.resync([pane("w1:p1", "idle", "claude")], new Set());
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it.each([
    ["closes", (push: PushService) => push.closed("w1:p1")],
    ["is gone from a snapshot", (push: PushService) => push.gone([], new Set())],
  ])("drops a finish already under way when its pane %s", async (_name, away) => {
    const asked = Promise.withResolvers<void>();
    const looked = Promise.withResolvers<void>();
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 },
      lookupPane: async () => { asked.resolve(); await looked.promise; return { title: "claude" }; } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "done");
    await asked.promise;
    away(push);
    looked.resolve();
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("leaves a pane with a newer event, and done versus idle, as they are", async () => {
    const push = subscribed();
    push.seed([pane("w1:p1", "working", "a"), pane("w1:p2", "working", "b")]);
    await push.onStatus("w1:p2", "done");
    const sent = fake.received.length;
    push.resync([pane("w1:p1", "idle", "a"), pane("w1:p2", "idle", "b")], new Set(["w1:p1"]));
    await push.onStatus("w1:p1", "done");
    expect(fake.received.length).toBe(sent + 1);
    await push.onStatus("w1:p2", "working");
    await push.onStatus("w1:p2", "done");
    expect(fake.received.length).toBe(sent + 2);
  });
});

describe("the shared pane mute (shared/preferences.ts muted_panes)", () => {
  function mutable(timing = { short: 0, long: 0, longTurn: 0 }) {
    const list: string[] = [];
    const push = createPushService({ loopbackHttp: true, stateDir, timing, muted: (machineId, paneId) => paneAlertsMuted(list, machineId, paneId) });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    return { push, list };
  }

  it("mute cancels delayed push", async () => {
    const { push, list } = mutable({ short: 10_000, long: 10_000, longTurn: 0 });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    list.push(paneStorageId("local", "w1:p1"));
    push.mutesChanged();
    await push.settled();
    expect(fake.received).toHaveLength(0);
    list.length = 0;
    push.mutesChanged();
    await push.settled();
    expect(fake.received).toHaveLength(0);
    const prompt = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 }, muted: (machineId, paneId) => paneAlertsMuted(list, machineId, paneId) });
    prompt.seed([pane("w1:p1", "blocked", "claude")]);
    await prompt.onStatus("w1:p1", "working");
    await prompt.onStatus("w1:p1", "blocked");
    await prompt.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["waiting for your input"]);
  });

  it("a persisted mute and unmute while the title is looked up sends nothing", async () => {
    const store = new PreferenceStore(stateDir);
    let release!: () => void;
    let asked!: () => void;
    const titleAsked = new Promise<void>((resolve) => { asked = resolve; });
    const push = createPushService({
      loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 },
      muted: (machineId, paneId) => paneAlertsMuted(store.get().muted_panes, machineId, paneId),
      lookupPane: () => { asked(); return new Promise((resolve) => { release = () => resolve({ title: "claude" }); }); },
    });
    const stop = store.subscribe(() => push.mutesChanged());
    const put = (keys: string[]) => handlePreferencesRequest(new Request("http://test/api/preferences", { method: "PUT", body: JSON.stringify({ settings: {}, muted_panes: keys }) }), store);
    try {
      push.subscribe(fake.subscription, { input: true, done: "always" });
      push.seed([pane("w1:p1", "working", "claude")]);
      await push.onStatus("w1:p1", "done");
      await titleAsked;
      expect((await put([paneStorageId("local", "w1:p1")])).status).toBe(200);
      expect((await put([])).status).toBe(200);
      expect(store.get().revision).toBe(2);
      release();
      await push.settled();
      expect(fake.received).toHaveLength(0);
    } finally {
      stop();
      release?.();
    }
  });

  it("holds back the phone app's native push as the browser's", async () => {
    const { push, list } = mutable();
    const app = { ...fake.subscription, endpoint: fake.subscription.endpoint.replace(/\/push\/[^/]+$/, `/v1/push/${crypto.randomUUID()}`) };
    push.subscribe(app, { input: true, done: "always" });
    list.push(paneStorageId("local", "w1:p1"));
    push.seed([pane("w1:p1", "working", "mine"), pane("w1:p2", "working", "other")]);
    await push.onStatus("w1:p1", "blocked");
    await push.onEnded("w1:p1");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p2", "blocked");
    await push.settled();
    expect(fake.received.map((r) => r.payload.title)).toEqual(["other", "other"]);
  });

  it("asks the list again right before a waiting alert goes out", async () => {
    const { push, list } = mutable({ short: 20, long: 20, longTurn: 0 });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    list.push(paneStorageId("local", "w1:p1"));
    await push.settled();
    expect(fake.received).toHaveLength(0);
  });

  it("all four paths suppress only the keyed pane", async () => {
    const { push, list } = mutable();
    list.push(paneStorageId("local", "w1:p1"));
    push.seed([pane("w1:p1", "working", "mine"), pane("w1:p2", "working", "other")]);
    push.seed([pane("w1:p1", "working", "theirs")], "pc-2", "Laptop");
    await push.onStatus("w1:p1", "blocked");
    await push.onStatus("w1:p1", "done");
    await push.onEnded("w1:p1");
    await push.settled();
    expect(fake.received).toHaveLength(0);
    await push.onStatus("w1:p1", "blocked", "pc-2");
    await push.settled();
    await push.onStatus("w1:p2", "blocked");
    await push.settled();
    await push.onEnded("w1:p1", "pc-2");
    await push.settled();
    expect(fake.received.map((r) => [r.payload.title, r.payload.body])).toEqual([
      ["Laptop · theirs", "waiting for your input"], ["other", "waiting for your input"], ["Laptop · theirs", "terminal ended"],
    ]);
    list.length = 0;
    await push.onStatus("w1:p1", "done");
    await push.settled();
    expect(fake.received).toHaveLength(3);
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    expect(fake.received.at(-1)?.payload.title).toBe("mine");
  });
});

describe("answer buttons on a question's alert (#2916)", () => {
  const prompt = (overrides: Partial<InteractivePrompt> = {}): InteractivePrompt => ({
    id: "prompt-1", agent: "omp", kind: "approval", title: "Allow dangerous command?", question: "Allow dangerous command?", body: null,
    options: [{ label: "Allow once", description: null }, { label: "Deny", description: null }],
    multi_select: false, custom_option_index: null, ...overrides,
  });
  const onScreen = (shown: InteractivePrompt) => ({ prompt: shown, screen: drawn(shown) });
  const drawn = (shown: InteractivePrompt, between: string[] = []) => [
    "─".repeat(40), ...(shown.title === shown.question ? [] : [` ${shown.title}`]), ...(shown.body ?? "").split("\n").filter(Boolean).map((line) => `   ${line}`),
    ...between, ` ${shown.question}`, ...shown.options.map((option, index) => ` ${index === 0 ? "❯" : " "} ${index + 1}. ${option.label}`), "", " Esc to cancel",
  ].join("\n");
  const alertFor = async (shown: InteractivePrompt | null, options: Partial<Parameters<typeof createPushService>[0]> = {}) => {
    fake.received.length = 0;
    const push = subscribed({ lookupPrompt: async () => shown && onScreen(shown), ...options });
    push.seed([pane("w1:p1", "working", "omp")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received).toHaveLength(1);
    const { prompt_id, actions } = fake.received[0]!.payload;
    return { prompt_id, actions };
  };

  it("carries the prompt's identity and its two short options", async () => {
    expect(await alertFor(prompt())).toEqual({ prompt_id: "prompt-1", actions: [{ option_index: 0, label: "Allow once" }, { option_index: 1, label: "Deny" }] });
    expect(await alertFor(prompt({ kind: "question", options: [{ label: "Yes", description: null }, { label: "No", description: null }] })))
      .toEqual({ prompt_id: "prompt-1", actions: [{ option_index: 0, label: "Yes" }, { option_index: 1, label: "No" }] });
  });

  it("says what the buttons answer: the prompt's title, question and the first lines it shows", async () => {
    fake.received.length = 0;
    const push = subscribed({ lookupPrompt: async () => onScreen(prompt({ title: "Bash command", question: "Do you want to proceed?", body: "rm -rf build\nDelete the build directory" })) });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received[0]!.payload.body).toBe("Bash command\nDo you want to proceed?\nrm -rf build\nDelete the build directory");
  });

  it("keeps every line of what is approved, a repeated one too", async () => {
    fake.received.length = 0;
    const push = subscribed({ lookupPrompt: async () => onScreen(prompt({ title: "Bash command", question: "Do you want to proceed?", body: "cd ..\ncd ..\nrm -rf project" })) });
    push.seed([pane("w1:p1", "working", "claude")]);
    await push.onStatus("w1:p1", "blocked");
    expect(fake.received[0]!.payload.body).toBe("Bash command\nDo you want to proceed?\ncd ..\ncd ..\nrm -rf project");
  });

  it("drops an alert whose pane moved on while its prompt was read, so it never replaces the newer one", async () => {
    fake.received.length = 0;
    const slow = deferred();
    const started = deferred();
    let read = 0;
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 },
      lookupPrompt: async () => {
        const id = `prompt-${++read}`;
        if (read === 1) { started.resolve(); await slow.promise; }
        return onScreen(prompt({ id }));
      } });
    push.subscribe(fake.subscription);
    push.seed([pane("w1:p1", "working", "omp")]);
    await push.onStatus("w1:p1", "blocked");
    await started.promise;
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    await fake.waitFor((r) => r.payload.prompt_id === "prompt-2", "the second asking's alert", 5_000);
    slow.resolve();
    await push.settled();
    expect(fake.received.map((r) => r.payload.prompt_id)).toEqual(["prompt-2"]);
  });

  it("never lets a question's slow read send it after the finish that followed", async () => {
    fake.received.length = 0;
    const slow = deferred();
    const started = deferred();
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: 0, long: 0, longTurn: 0 },
      lookupPrompt: async () => { started.resolve(); await slow.promise; return onScreen(prompt()); } });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    push.seed([pane("w1:p1", "working", "omp")]);
    await push.onStatus("w1:p1", "blocked");
    await started.promise;
    await push.onStatus("w1:p1", "done");
    await fake.waitFor((r) => r.payload.body === "work finished", "the finish", 5_000);
    slow.resolve();
    await push.settled();
    expect(fake.received.map((r) => r.payload.body)).toEqual(["work finished"]);
  });

  it("offers buttons only for what the screen shows whole, verbatim, whichever reader read it", async () => {
    const shown = prompt({ title: "Bash command", question: "Do you want to proceed?", body: "echo safe" });
    const none = { prompt_id: undefined, actions: undefined };
    const read = (screen: string | undefined) => alertFor(null, { lookupPrompt: async () => ({ prompt: shown, ...(screen === undefined ? {} : { screen }) }) });
    expect((await read(drawn(shown))).actions).toHaveLength(2);
    // a line the reader left out of the body (Claude's `Tip:` filter took a line of the command)
    expect(await read(drawn(shown, ["   Tip:; rm -rf production"]))).toEqual(none);
    // a line over the body the reader's window did not take: nothing over it says the prompt begins there
    expect(await read(drawn(shown).replace(" Bash command", " Bash command\n   rm -rf production"))).toEqual(none);
    // a marker between the body and the question (Claude's older approval keeps only the lines over it)
    expect(await read(drawn(shown, [" This command requires approval"]))).toEqual(none);
    // the body begins at the top of the screen: the rest of it may have scrolled away
    expect(await read(drawn(shown).split("\n").slice(2).join("\n"))).toEqual(none);
    // an option row that is not where the card says
    expect(await read(drawn(shown).replace("2. Deny", "2. Maybe\n    3. Deny"))).toEqual(none);
    // a prompt not read off a screen at all
    expect(await read(undefined)).toEqual(none);
  });

  it("gives no buttons for the screens Claude's reader takes only part of (#2916 review)", async () => {
    const none = { prompt_id: undefined, actions: undefined };
    const real = (screen: string) => alertFor(null, { lookupPrompt: async () => ({ prompt: parseInteractivePrompt("claude", screen)!, screen }) });
    const whole = ["─".repeat(40), " Bash command", "", "   echo safe", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"];
    expect((await real(whole.join("\n"))).actions).toHaveLength(2);
    // its `Tip:` filter dropping a line of the command
    expect(await real([...whole.slice(0, 4), "   Tip:; rm -rf production", ...whole.slice(4)].join("\n"))).toEqual(none);
    // the older approval: its body is only the few lines over its marker
    expect(await real([" Bash command", "", "   rm -rf production", "", "   echo one", "", "   echo two", "", "   echo three", "", "   echo four", "",
      " This command requires approval", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"].join("\n"))).toEqual(none);
    // a long command scrolled past the panel's top: only its tail is on the screen
    expect(await real(["   │ rm -rf production", "   │ echo tail", "   ╌╌╌╌╌╌╌╌╌╌╌╌", "", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel"].join("\n"))).toEqual(none);
  });

  it("keeps today's alert for a prompt the buttons cannot answer whole", async () => {
    const none = { prompt_id: undefined, actions: undefined };
    const three = [{ label: "Yes", description: null }, { label: "Yes, don't ask again", description: null }, { label: "No", description: null }];
    for (const shown of [
      null,
      prompt({ options: three }),
      prompt({ options: [{ label: "Yes, and allow every edit in this folder for the session", description: null }, { label: "No", description: null }] }),
      prompt({ multi_select: true }),
      prompt({ custom_option_index: 1 }),
      prompt({ kind: "plan" }),
      // what it allows does not fit the alert whole: the part cut off could be the one that matters
      prompt({ body: `npm run build && ${"x".repeat(300)}; rm -rf production` }),
      prompt({ body: "one\ntwo\nthree\nfour\nrm -rf production" }),
      prompt({ options: [{ label: "Yes", description: "and remember it for this folder" }, { label: "No", description: null }] }),
      prompt({ kind: "menu" }),
      prompt({ steps: [{ label: "One", answered: false, current: true }, { label: "Two", answered: false, current: false }] }),
      prompt({ queued: "collapsed" }),
    ]) expect(await alertFor(shown)).toEqual(none);
  });

  it("gives no buttons to a device that may only watch, nor when the prompt cannot be read", async () => {
    const none = { prompt_id: undefined, actions: undefined };
    expect(await alertFor(prompt(), { canAnswer: () => false })).toEqual(none);
    expect(await alertFor(prompt(), { lookupPrompt: async () => { throw new Error("herdr busy"); } })).toEqual(none);
  });

  it("asks for the prompt only for this PC's panes", async () => {
    fake.received.length = 0;
    let asked = 0;
    const push = subscribed({ lookupPrompt: async () => { asked += 1; return onScreen(prompt()); } });
    push.seed([pane("w1:p1", "working", "omp")], "pc-2", "Laptop");
    await push.onStatus("w1:p1", "blocked", "pc-2");
    expect(asked).toBe(0);
    expect(fake.received[0]!.payload.actions).toBeUndefined();
  });
});

describe("a card's wait told to web push (server/card-waits.ts)", () => {
  const SHORT = 40;
  /** the short wait's timer, held until the test fires it; every other timer runs for real */
  function heldShortWait() {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const held = new Map<object, () => void>();
    const set = spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== SHORT) return realSet(callback, ms, ...args);
      const handle = {};
      held.set(handle, () => callback(...args));
      return handle;
    }) as never);
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((handle: unknown) => {
      if (!held.delete(handle as object)) realClear(handle as Parameters<typeof clearTimeout>[0]);
    }) as never);
    return { pending: () => held.size, fire: () => { const due = [...held.values()]; held.clear(); for (const run of due) run(); }, restore: () => { set.mockRestore(); clear.mockRestore(); } };
  }
  const service = () => {
    const push = createPushService({ loopbackHttp: true, stateDir, timing: { short: SHORT, long: SHORT, longTurn: 1_000 } });
    push.subscribe(fake.subscription, { input: true, done: "always" });
    return push;
  };

  it("alerts once, after its short wait, for a wait first heard as blocked once the agent's own status was assumed", async () => {
    const timers = heldShortWait();
    try {
      const push = service();
      push.assume("t1", "unknown");
      await push.onStatus("t1", "blocked");
      expect(timers.pending()).toBe(1);
      timers.fire();
      await push.settled();
      expect(fake.received).toHaveLength(1);
      // the same card read again is no change
      await push.onStatus("t1", "blocked");
      expect(timers.pending()).toBe(0);
    } finally { timers.restore(); }
  });
});
