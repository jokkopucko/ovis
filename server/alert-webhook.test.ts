import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AgentStatus, HerdrPane } from "../shared/protocol.ts";
import { createAlertWebhook, handleAlertWebhookRequest, type AlertWebhook } from "./alert-webhook.ts";
import { createPushService } from "./push.ts";

interface Received { path: string; headers: Headers; body: string }

function startDestination() {
  const received: Received[] = [];
  const waiters: Array<() => void> = [];
  let gate: Promise<void> | null = null;
  let statuses: number[] = [];
  let status = 200;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({ path: new URL(request.url).pathname, headers: request.headers, body: await request.text() });
      for (const wake of waiters.splice(0)) wake();
      if (gate) await gate;
      return new Response("ok", { status: statuses.shift() ?? status });
    },
  });
  return {
    url: (path = "/hook") => `http://127.0.0.1:${server.port}${path}`,
    received,
    posts(count: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`fewer than ${count} posts`)), 5_000);
        const check = () => { if (received.length >= count) { clearTimeout(timer); resolve(); } else waiters.push(check); };
        check();
      });
    },
    hold(): () => void {
      let release!: () => void;
      gate = new Promise<void>((resolve) => { release = () => { gate = null; resolve(); }; });
      return release;
    },
    answer(next: number | number[]) { if (Array.isArray(next)) statuses = [...next]; else status = next; },
    stop: () => server.stop(true),
  };
}

let stateDir: string;
let destination: ReturnType<typeof startDestination>;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "ovis-webhook-"));
  destination = startDestination();
});

afterEach(() => {
  destination.stop();
  rmSync(stateDir, { recursive: true, force: true });
});

function webhook(retryDelays: number[] = [1, 1, 1]): AlertWebhook {
  return createAlertWebhook({ stateDir, retryDelays, telegramApi: destination.url(""), loopbackHttp: true });
}

const alert = { kind: "input" as const, title: "codex", body: "waiting for your input", pc: "Work PC", pane_id: "w1:p1", workspace_id: "w1" };

describe("alert webhook presets", () => {
  it("posts each preset's own format, naming the PC, the pane and what happened, with a link to the pane", async () => {
    const hook = webhook();
    const base = "https://pc.tail.ts.net:7421";
    hook.save({ preset: "slack", url: destination.url("/slack") }, base);
    hook.send(alert);
    await hook.settled();
    hook.save({ preset: "discord", url: destination.url("/discord") }, base);
    hook.send(alert);
    await hook.settled();
    hook.save({ preset: "ntfy", url: destination.url("/topic") }, base);
    hook.send(alert);
    await hook.settled();
    hook.save({ preset: "telegram", token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chat_id: "-1001" }, base);
    hook.send({ ...alert, machine_id: "pc-b" });
    await hook.settled();
    hook.save({ preset: "json", url: destination.url("/json") }, base);
    hook.send(alert);
    await hook.settled();

    const link = "https://pc.tail.ts.net:7421/?pane=w1%3Ap1&view=chat";
    const [slack, discord, ntfy, telegram, json] = destination.received;
    expect(JSON.parse(slack!.body)).toEqual({ text: `Work PC · codex: waiting for your input\n<${link}|Open in Ovis>` });
    expect(JSON.parse(discord!.body)).toEqual({ content: `Work PC · codex: waiting for your input\n${link}`, allowed_mentions: { parse: [] } });
    expect(ntfy!.body).toBe("Work PC · codex: waiting for your input");
    expect(ntfy!.headers.get("click")).toBe(link);
    expect(ntfy!.headers.get("priority")).toBe("high");
    expect(telegram!.path).toBe("/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ/sendMessage");
    expect(JSON.parse(telegram!.body)).toEqual({ chat_id: "-1001", text: "Work PC · codex: waiting for your input\nhttps://pc.tail.ts.net:7421/?machine=pc-b&pane=w1%3Ap1&view=chat", disable_web_page_preview: true });
    expect(JSON.parse(json!.body)).toEqual({ type: "alert", kind: "input", text: "Work PC · codex: waiting for your input", title: "codex", body: "waiting for your input", pc: "Work PC", pane_id: "w1:p1", workspace_id: "w1", url: link });
  });

  it("keeps the secret owner-only on disk and answers it only masked", () => {
    const hook = webhook();
    const view = hook.save({ preset: "discord", url: "https://discord.com/api/webhooks/1/SECRETabcd" }, undefined);
    expect(view.target).toBe("discord.com/…");
    // an ntfy topic is the whole secret: no part of it is answered
    expect(hook.save({ preset: "ntfy", url: "https://ntfy.sh/abcd" }, undefined).target).toBe("ntfy.sh/…");
    expect(hook.save({ preset: "telegram", token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chat_id: "1" }, undefined).target).toBe("…");
    hook.save({ preset: "discord", url: "https://discord.com/api/webhooks/1/SECRETabcd" }, undefined);
    expect(JSON.stringify(view)).not.toContain("SECRET");
    if (process.platform !== "win32") expect(statSync(join(stateDir, "alert-webhook.json")).mode & 0o777).toBe(0o600);
    // a save without the URL keeps it: the form never has it to send back
    hook.save({ preset: "discord", alerts: { input: false, done: "always" } }, undefined);
    expect(JSON.parse(readFileSync(join(stateDir, "alert-webhook.json"), "utf8")).secret).toBe("https://discord.com/api/webhooks/1/SECRETabcd");
    expect(webhook().view()).toMatchObject({ configured: true, preset: "discord", alerts: { input: false, done: "always" } });
  });

  it("keeps the link base a relay request cannot give", async () => {
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url() }, "https://pc.example:7421");
    hook.save({ preset: "json", alerts: { input: true, done: "always" } }, "https://relay.ovis.invalid");
    hook.send(alert);
    await hook.settled();
    expect(JSON.parse(destination.received[0]!.body).url).toBe("https://pc.example:7421/?pane=w1%3Ap1&view=chat");
  });

  it("keeps a reachable link base when this PC's own loopback address saves, and says when none is known", async () => {
    const hook = webhook();
    expect(hook.save({ preset: "json", url: destination.url() }, "https://relay.ovis.invalid").reachable_link).toBe(false);
    expect(hook.save({ preset: "json" }, "http://127.0.0.1:7317").reachable_link).toBe(false);
    expect(hook.save({ preset: "json" }, "https://pc.tailnet.example").reachable_link).toBe(true);
    expect(hook.save({ preset: "json", alerts: { input: true, done: "always" } }, "http://127.0.0.1:7317").reachable_link).toBe(true);
    expect(hook.save({ preset: "json" }, "http://[::ffff:127.0.0.1]:7317").reachable_link).toBe(true);
    expect(hook.save({ preset: "json" }, "http://0.0.0.0:7317").reachable_link).toBe(true);
    expect(hook.save({ preset: "json" }, "http://[::]:7317").reachable_link).toBe(true);
    hook.send(alert);
    await hook.settled();
    expect(JSON.parse(destination.received[0]!.body).url).toBe("https://pc.tailnet.example/?pane=w1%3Ap1&view=chat");
    expect(webhook().view().reachable_link).toBe(true);
  });

  it("refuses a destination it could not post to", () => {
    const hook = webhook();
    expect(() => hook.save({ preset: "slack", url: "http://hooks.slack.com/services/x" }, undefined)).toThrow("https://");
    expect(() => hook.save({ preset: "json", url: "ftp://example.com/x" }, undefined)).toThrow();
    expect(() => hook.save({ preset: "json", url: "https://user:pw@example.com/x" }, undefined)).toThrow("password");
    expect(() => hook.save({ preset: "telegram", token: "nope", chat_id: "1" }, undefined)).toThrow("bot token");
    expect(() => hook.save({ preset: "telegram", token: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chat_id: "x y" }, undefined)).toThrow("chat id");
    expect(hook.view().configured).toBe(false);
  });
});

describe("alert webhook delivery", () => {
  it("retries a destination that is down, and replaces what waits instead of piling it up", async () => {
    destination.answer(503);
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url() }, undefined);
    hook.send({ ...alert, title: "first" });
    hook.send({ ...alert, title: "second" });
    hook.send({ ...alert, title: "third" });
    await hook.settled();
    const titles = destination.received.map((post) => JSON.parse(post.body).title);
    expect(titles).toEqual(["first", "third", "third", "third", "third"]);
    expect(hook.view()).toMatchObject({ last_error: "HTTP 503", last_success_at: null });
  });

  it("does not retry an answer that will not change, and a success clears the error", async () => {
    destination.answer([404, 200]);
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url() }, undefined);
    hook.send(alert);
    await hook.settled();
    expect(destination.received).toHaveLength(1);
    expect(hook.view().last_error).toBe("HTTP 404");
    expect(await hook.test()).toEqual({ ok: true });
    expect(hook.view()).toMatchObject({ last_error: null });
    expect(JSON.parse(destination.received[1]!.body)).toEqual({ type: "test", text: "Ovis: alerts reach this destination" });
  });
});

describe("alert webhook ownership", () => {
  it("posts nothing once whoever set it lost access, as a push subscription's device would get nothing", async () => {
    const allowed = new Set<string | null>([null, "dev-a"]);
    let gated = false;
    const hook = createAlertWebhook({ stateDir, loopbackHttp: true, retryDelays: [1], canDeliver: (owner) => owner === undefined ? !gated : allowed.has(owner) });
    hook.save({ preset: "json", url: destination.url() }, undefined, "dev-a");
    hook.send(alert);
    await hook.settled();
    allowed.delete("dev-a");
    hook.send(alert);
    await hook.settled();
    expect(destination.received).toHaveLength(1);
    // the open LAN (no owner) is heard only while it stays open, also after a restart
    hook.save({ preset: "json", url: destination.url() }, undefined, undefined);
    gated = true;
    const restarted = createAlertWebhook({ stateDir, loopbackHttp: true, canDeliver: (owner) => owner === undefined ? !gated : allowed.has(owner) });
    restarted.send(alert);
    await restarted.settled();
    expect(destination.received).toHaveLength(1);
  });
});

describe("alert webhook staleness and bounds", () => {
  it("does not retry an alert that is no longer news", async () => {
    destination.answer([503, 200]);
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url() }, undefined);
    let news = true;
    hook.send({ ...alert, current: () => news });
    news = false;
    await hook.settled();
    expect(destination.received).toHaveLength(1);
  });

  it("sends to a new destination at once, not after the old one's backoff", async () => {
    destination.answer(503);
    const hook = webhook([60_000]);
    hook.save({ preset: "json", url: destination.url("/old") }, undefined);
    hook.send(alert);
    await destination.posts(1);
    destination.answer(200);
    hook.save({ preset: "json", url: destination.url("/new") }, undefined);
    hook.send(alert);
    await hook.settled();
    expect(destination.received.map((post) => post.path)).toEqual(["/old", "/new"]);
  });

  it("tests a new destination, not the one a test was still out for", async () => {
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url("/a") }, undefined);
    const first = hook.test();
    hook.save({ preset: "json", url: destination.url("/b") }, undefined);
    await Promise.all([first, hook.test()]);
    expect(destination.received.map((post) => post.path).sort()).toEqual(["/a", "/b"]);
  });

  it("sends one test at a time, and a test of a removed destination records nothing", async () => {
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url() }, undefined);
    await Promise.all(Array.from({ length: 5 }, () => hook.test()));
    expect(destination.received).toHaveLength(1);
    destination.answer(500);
    const pending = hook.test();
    hook.remove();
    await pending;
    expect(hook.view().last_error).toBeNull();
  });
});

describe("/api/alerts/webhook", () => {
  it("saves, tests and removes a destination, the secret never in an answer", async () => {
    const hook = webhook();
    const call = (method: string, path = "/api/alerts/webhook", body?: unknown) => handleAlertWebhookRequest(new Request(`http://127.0.0.1${path}`, {
      method, headers: { origin: "https://pc.example:7421", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), path, hook);
    const saved = (await call("PUT", undefined, { preset: "json", url: destination.url("/secret-path") }))!;
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("secret-path");
    expect((await call("POST", "/api/alerts/webhook/test"))!.status).toBe(204);
    expect((await call("PUT", undefined, { preset: "slack", url: "nope" }))!.status).toBe(400);
    expect((await call("DELETE"))!.status).toBe(204);
    expect((await call("POST", "/api/alerts/webhook/test"))!.status).toBe(404);
    expect(await (await call("GET"))!.json()).toMatchObject({ configured: false });
  });
});

let inUseNow = false;
let mutedNow = false;

describe("web push alerts reach the webhook", () => {
  function pane(paneId: string, status: AgentStatus): HerdrPane {
    return { pane_id: paneId, agent_status: status, terminal_title: "codex", focused: false, revision: 0, tab_id: "t1", terminal_id: "term_1", workspace_id: "w1" };
  }

  it("tells the destination the alerts it chose, as push tells a device, and nothing while the app is in use", async () => {
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url() }, "https://pc.example");
    let inUse = false;
    const push = createPushService({ stateDir, localName: "Work PC", timing: { short: 0, long: 0, longTurn: 0 }, webhook: hook, inUse: () => inUse });
    push.seed([pane("w1:p1", "working")]);
    const step = async (run: () => Promise<void>) => { await run(); await push.settled(); await hook.settled(); };

    await step(() => push.onStatus("w1:p1", "blocked"));
    await step(() => push.onStatus("w1:p1", "working"));
    await step(() => push.onStatus("w1:p1", "done"));
    await step(() => push.onEnded("w1:p1"));
    const kinds = destination.received.map((post) => JSON.parse(post.body));
    expect(kinds.map((post) => post.kind)).toEqual(["input", "done", "ended"]);
    expect(kinds[0]).toMatchObject({ text: "Work PC · codex: waiting for your input", url: "https://pc.example/?pane=w1%3Ap1&view=chat" });

    hook.save({ preset: "json", alerts: { input: true, done: "off" } }, undefined);
    await step(() => push.onStatus("w1:p1", "working"));
    await step(() => push.onStatus("w1:p1", "done"));
    expect(destination.received).toHaveLength(3);

    inUse = true;
    await step(() => push.onStatus("w1:p1", "blocked"));
    expect(destination.received).toHaveLength(3);
  });

  it("still posts an exit waiting behind another post once a snapshot no longer lists its pane", async () => {
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url() }, undefined);
    const push = createPushService({ stateDir, timing: { short: 0, long: 0, longTurn: 0 }, webhook: hook });
    push.seed([pane("w1:p1", "working"), pane("w1:p2", "working")]);
    const answer = destination.hold();
    await push.onStatus("w1:p2", "blocked");
    await push.settled();
    await destination.posts(1);
    await push.onEnded("w1:p1");
    push.gone([pane("w1:p2", "blocked")], new Set());
    answer();
    await hook.settled();
    expect(destination.received.map((post) => JSON.parse(post.body).kind)).toEqual(["input", "ended"]);
  });

  it("does not tell a destination set after the alert arose", async () => {
    const hook = webhook();
    hook.save({ preset: "json", url: destination.url("/a") }, undefined);
    const push = createPushService({ stateDir, timing: { short: 0, long: 0, longTurn: 0 }, webhook: hook });
    push.seed([pane("w1:p1", "working")]);
    await push.onStatus("w1:p1", "blocked");
    hook.save({ preset: "json", url: destination.url("/b") }, undefined);
    await push.settled();
    await hook.settled();
    expect(destination.received).toHaveLength(0);
    await push.onStatus("w1:p1", "working");
    await push.onStatus("w1:p1", "blocked");
    await push.settled();
    await hook.settled();
    expect(destination.received.map((post) => post.path)).toEqual(["/b"]);
  });

  it.each([
    ["the terminal ended", async (push: ReturnType<typeof createPushService>) => { await push.onEnded("w1:p1"); }],
    ["it went working and blocked again", async (push: ReturnType<typeof createPushService>) => { inUseNow = true; await push.onStatus("w1:p1", "working"); await push.onStatus("w1:p1", "blocked"); await push.settled(); inUseNow = false; }],
    ["it was muted and unmuted", async (push: ReturnType<typeof createPushService>) => { mutedNow = true; push.mutesChanged(); mutedNow = false; push.mutesChanged(); }],
  ])("drops a retry once %s", async (_name, change) => {
    destination.answer([503, 200]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = createAlertWebhook({ stateDir, loopbackHttp: true, retryDelays: [1] });
    hook.save({ preset: "json", url: destination.url(), alerts: { input: true, done: "off" } }, undefined);
    const push = createPushService({ stateDir, timing: { short: 0, long: 0, longTurn: 0 }, inUse: () => inUseNow, muted: () => mutedNow,
      webhook: { prefs: hook.prefs, wants: hook.wants, generation: hook.generation, send: (sent) => { hook.send(sent); release(); } } });
    push.seed([pane("w1:p1", "working")]);
    const answer = destination.hold();
    await push.onStatus("w1:p1", "blocked");
    await held;
    await destination.posts(1);
    await change(push);
    answer();
    await push.settled();
    await hook.settled();
    expect(destination.received).toHaveLength(1);
  });

  it("drops a retry once the pane changed, as an answered question calls off a device's alert", async () => {
    destination.answer([503, 200]);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const hook = createAlertWebhook({ stateDir, loopbackHttp: true, retryDelays: [1] });
    hook.save({ preset: "json", url: destination.url() }, undefined);
    const push = createPushService({ stateDir, timing: { short: 0, long: 0, longTurn: 0 }, webhook: { prefs: hook.prefs, wants: hook.wants, generation: hook.generation, send: (sent) => { hook.send(sent); release(); } } });
    push.seed([pane("w1:p1", "working")]);
    await push.onStatus("w1:p1", "blocked");
    await held;
    await push.onStatus("w1:p1", "working");
    await push.settled();
    await hook.settled();
    expect(destination.received).toHaveLength(1);
  });
});
