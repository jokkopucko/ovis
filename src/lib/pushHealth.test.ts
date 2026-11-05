import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { PushDeliveryFailure, PushSubscriptionStatus } from "../../shared/protocol.ts";
import { classifyPushHealth, dismissPushNotice, failureIsNewer, readPushHealth, refreshPushHealth, resetPushHealth, runPushAction, type PushHealthInput } from "./pushHealth.ts";
import { refreshNotificationState } from "./notifications.ts";
import { ensurePushSubscription, registeredPushEndpoint } from "./push.ts";

const at = (seconds: number): string => new Date(1_700_000_000_000 + seconds * 1000).toISOString();
const status = (fields: Partial<PushSubscriptionStatus> = {}): PushSubscriptionStatus =>
  ({ registered: true, last_success_at: null, last_failure_at: null, last_failure: null, ...fields });
const fine: PushHealthInput = { wanted: true, supported: true, permission: "granted", subscribed: true, keyMatches: true, status: status() };
const FAILURES: readonly PushDeliveryFailure[] = ["gone", "key-mismatch", "rejected", "throttled", "server", "network"];

describe("classifyPushHealth", () => {
  it("only newer permanent failures alarm", () => {
    expect(classifyPushHealth(fine)).toEqual({ problem: null, repair: false, transient: null });
    // newer than the last success, or never a success: a permanent failure is a fault (a key refusal the
    // browser's own key does not explain is told as a refusal)
    for (const [failure, problem] of [["gone", "gone"], ["key-mismatch", "rejected"], ["rejected", "rejected"]] as const) {
      expect(classifyPushHealth({ ...fine, status: status({ last_success_at: at(0), last_failure_at: at(1), last_failure: failure }) }).problem).toBe(problem);
      expect(classifyPushHealth({ ...fine, status: status({ last_failure_at: at(1), last_failure: failure }) }).problem).toBe(problem);
      // at the same time as the success, or before it: history
      expect(classifyPushHealth({ ...fine, status: status({ last_success_at: at(1), last_failure_at: at(1), last_failure: failure }) }).problem).toBeNull();
      expect(classifyPushHealth({ ...fine, status: status({ last_success_at: at(2), last_failure_at: at(1), last_failure: failure }) }).problem).toBeNull();
    }
    // a transient failure, however new, is a line for Settings and never a notice
    for (const failure of ["throttled", "server", "network"] as const) {
      expect(classifyPushHealth({ ...fine, status: status({ last_success_at: at(0), last_failure_at: at(1), last_failure: failure }) })).toEqual({ problem: null, repair: false, transient: failure });
      expect(classifyPushHealth({ ...fine, status: status({ last_success_at: at(1), last_failure_at: at(0), last_failure: failure }) })).toEqual({ problem: null, repair: false, transient: null });
    }
    // the tombstone of a retired subscription
    expect(classifyPushHealth({ ...fine, status: status({ registered: false, last_success_at: at(0), last_failure_at: at(5), last_failure: "gone" }) })).toEqual({ problem: "gone", repair: true, transient: null });
    // nothing seen, nothing said: not wanted, unsupported, no answer, not looked at, an unanswered permission
    expect(classifyPushHealth({ ...fine, wanted: false, status: status({ last_failure_at: at(1), last_failure: "gone" }) })).toEqual({ problem: null, repair: false, transient: null });
    expect(classifyPushHealth({ ...fine, supported: false, status: status({ last_failure_at: at(1), last_failure: "gone" }) })).toEqual({ problem: null, repair: false, transient: null });
    expect(classifyPushHealth({ ...fine, status: null })).toEqual({ problem: null, repair: false, transient: null });
    expect(classifyPushHealth({ ...fine, subscribed: null, status: null })).toEqual({ problem: null, repair: false, transient: null });
    expect(classifyPushHealth({ ...fine, permission: "default" })).toEqual({ problem: null, repair: false, transient: null });
    // a malformed time is not newer than anything
    expect(failureIsNewer(status({ last_success_at: at(0), last_failure_at: "yesterday", last_failure: "gone" }))).toBe(false);
    expect(failureIsNewer(status({ last_failure_at: at(0), last_failure: "gone" }))).toBe(true);
    expect(failureIsNewer(status({ last_failure_at: at(0) }))).toBe(false);
  });

  it("repair is limited to subscription faults", () => {
    const repairs = (input: PushHealthInput): [string | null, boolean] => { const health = classifyPushHealth(input); return [health.problem, health.repair]; };
    expect(repairs({ ...fine, status: "unknown" })).toEqual(["missing", true]);
    expect(repairs({ ...fine, status: status({ registered: false, last_failure_at: at(1), last_failure: "gone" }) })).toEqual(["gone", true]);
    expect(repairs({ ...fine, keyMatches: false })).toEqual(["key-mismatch", true]);
    // a browser looked at and holding no subscription, while alerts are wanted and allowed
    expect(repairs({ ...fine, subscribed: false, keyMatches: null, status: null })).toEqual(["missing", true]);
    // the push service refused the server's key (401/403) while the browser's key is the server's own: subscribing
    // anew would make the same subscription, so it is a refusal with no repair; unknown local key alike
    expect(repairs({ ...fine, status: status({ last_failure_at: at(1), last_failure: "key-mismatch" }) })).toEqual(["rejected", false]);
    // a key nobody can read (the phone app's) refused: most likely the old key after the server's changed, and
    // subscribing anew replaces a subscription whose key is not proven
    expect(repairs({ ...fine, keyMatches: null, status: status({ last_failure_at: at(1), last_failure: "key-mismatch" }) })).toEqual(["key-mismatch", true]);
    // a refusal is told, and not mended by subscribing again
    expect(repairs({ ...fine, status: status({ last_failure_at: at(1), last_failure: "rejected" }) })).toEqual(["rejected", false]);
    // a denied permission is the browser's to mend
    expect(repairs({ ...fine, permission: "denied", status: status({ registered: false, last_failure_at: at(1), last_failure: "gone" }) })).toEqual(["permission", false]);
    // transient failures mend themselves
    for (const failure of ["throttled", "server", "network"] as const) expect(repairs({ ...fine, status: status({ last_failure_at: at(1), last_failure: failure }) })).toEqual([null, false]);
    expect(FAILURES.filter((failure) => classifyPushHealth({ ...fine, status: status({ last_failure_at: at(1), last_failure: failure }) }).repair)).toEqual(["gone"]);
  });
});

describe("the shared health state", () => {
  const SERVER_KEY = Buffer.from(new Uint8Array(65).fill(4)).toString("base64url");
  let live: { endpoint: string; options: { applicationServerKey: ArrayBuffer }; unsubscribe: () => Promise<boolean>; toJSON: () => unknown } | null;
  let answer: (init?: RequestInit) => Promise<Response>;
  let statusRequests: number;
  let issued: number;
  const saved = { fetch: globalThis.fetch, PushManager: (globalThis as { PushManager?: unknown }).PushManager, Notification: (globalThis as { Notification?: unknown }).Notification };

  const standIn = (endpoint: string) => ({
    endpoint,
    options: { applicationServerKey: new Uint8Array(65).fill(4).buffer as ArrayBuffer },
    unsubscribe: async () => { live = null; return true; },
    toJSON: () => ({ endpoint, keys: { p256dh: "p", auth: "a" } }),
  });
  const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; };
  const gone = status({ registered: false, last_failure_at: at(1), last_failure: "gone" });
  /**
   * Holds every status answer until the test releases it, and tells when the nth request has gone
   * out: a race is set up on the requests actually in flight, never on timing.
   */
  const held = () => {
    const replies: { endpoint: string; reply: ReturnType<typeof deferred<Response>> }[] = [];
    const waiters: { count: number; resolve: () => void }[] = [];
    answer = (init) => {
      const reply = deferred<Response>();
      replies.push({ endpoint: (JSON.parse(String(init?.body)) as { subscription: { endpoint: string } }).subscription.endpoint, reply });
      for (const waiter of waiters.filter((w) => replies.length >= w.count)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); }
      return reply.promise;
    };
    const sent = (count: number): Promise<void> => replies.length >= count ? Promise.resolve() : new Promise((resolve) => { waiters.push({ count, resolve }); });
    return { replies, sent };
  };

  beforeEach(() => {
    live = standIn("https://push.example/1");
    issued = 1;
    answer = async () => Response.json(status());
    statusRequests = 0;
    const pushManager = {
      getSubscription: async () => live,
      subscribe: async () => { issued += 1; live = standIn(`https://push.example/${issued}`); return live; },
    };
    Object.defineProperty(globalThis.navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve({ pushManager }), getRegistration: async () => ({ pushManager }) } });
    Object.assign(globalThis, { PushManager: class {}, Notification: { permission: "granted" } });
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/push") return Response.json({ public_key: SERVER_KEY });
      if (url === "/api/push/status") { statusRequests += 1; return answer(init); }
      if (url === "/api/push/subscribe" && init?.method === "POST") return new Response(null, { status: 204 });
      if (url === "/api/push/test") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    resetPushHealth();
  });

  afterEach(() => {
    delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
    Object.assign(globalThis, { PushManager: saved.PushManager, Notification: saved.Notification, fetch: saved.fetch });
    resetPushHealth();
  });

  it("reads the server's answer for this browser's subscription, and says nothing when alerts are off", async () => {
    answer = async () => Response.json(gone);
    await refreshPushHealth(true);
    expect(readPushHealth().health).toEqual({ problem: "gone", repair: true, transient: null });
    await refreshPushHealth(false);
    expect(readPushHealth().health).toEqual({ problem: null, repair: false, transient: null });
  });

  it("says nothing in the desktop app, whose PushManager has no push service behind it", async () => {
    // Electron grants the page the notification permission and offers a PushManager whose subscribe
    // always fails: alerts on by default then read as a missing subscription on the first launch
    live = null;
    Object.defineProperty(globalThis.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Ovis/0.5.0 Chrome/156.0.8078.80 Electron/45.2.2 Safari/537.36" });
    try {
      await refreshPushHealth(true);
      expect(readPushHealth().health).toEqual({ problem: null, repair: false, transient: null });
    } finally {
      delete (globalThis.navigator as { userAgent?: string }).userAgent;
    }
    // the same page in a browser holding no subscription is told
    await refreshPushHealth(true);
    expect(readPushHealth().health).toEqual({ problem: "missing", repair: true, transient: null });
  });

  it("takes an unknown subscription, an older server and an unreachable PC apart", async () => {
    answer = async () => Response.json({ error: { code: "subscription_not_found", message: "no" } }, { status: 404 });
    await refreshPushHealth(true);
    expect(readPushHealth().health).toEqual({ problem: "missing", repair: true, transient: null });
    // the PC out of reach: what was known stands
    answer = async () => { throw new TypeError("Failed to fetch"); };
    await refreshPushHealth(true);
    expect(readPushHealth().health).toEqual({ problem: "missing", repair: true, transient: null });
    // a server from before the question: nothing to go on, nothing wrong
    answer = async () => Response.json({ error: { code: "not_found", message: "no such route" } }, { status: 404 });
    await refreshPushHealth(true);
    expect(readPushHealth().health).toEqual({ problem: null, repair: false, transient: null });
    // the open LAN signs in as nobody, so its subscription has no record to read: quiet, never "missing"
    answer = async () => Response.json({ error: { code: "subscription_not_found", message: "no" } }, { status: 404 });
    await refreshPushHealth(true);
    expect(readPushHealth().health.problem).toBe("missing");
    answer = async () => Response.json({ error: { code: "status_unavailable", message: "no device" } }, { status: 403 });
    await refreshPushHealth(true);
    expect(readPushHealth().health).toEqual({ problem: null, repair: false, transient: null });
  });

  it("drops a late answer after a later success, a disable or a new subscription", async () => {
    // two looks in flight at once; the first is answered last: the later look's clean answer stands
    let race = held();
    const first = refreshPushHealth(true);
    await race.sent(1);
    const second = refreshPushHealth(true);
    await race.sent(2);
    expect(statusRequests).toBe(2);
    race.replies[1]!.reply.resolve(Response.json(status({ last_success_at: at(2), last_failure_at: at(1), last_failure: "gone" })));
    await second;
    expect(readPushHealth().health.problem).toBeNull();
    race.replies[0]!.reply.resolve(Response.json(gone));
    await first;
    expect(readPushHealth().health.problem).toBeNull();

    // a look in flight when alerts are turned off here
    race = held();
    const stale = refreshPushHealth(true);
    await race.sent(1);
    resetPushHealth();
    race.replies[0]!.reply.resolve(Response.json(gone));
    await stale;
    expect(readPushHealth().health.problem).toBeNull();

    // a look in flight for the old subscription while a new one replaces it: the old answer is dropped and
    // the new subscription is looked at instead
    race = held();
    const look = refreshPushHealth(true);
    await race.sent(1);
    expect(race.replies[0]!.endpoint).toBe("https://push.example/1");
    live!.options.applicationServerKey = new Uint8Array(65).fill(7).buffer as ArrayBuffer;
    expect(await ensurePushSubscription()).toBe("https://push.example/2");
    // what a repair proved: the endpoint this page's registration ended with
    expect(registeredPushEndpoint()).toBe("https://push.example/2");
    race.replies[0]!.reply.resolve(Response.json(gone));
    await race.sent(2);
    expect(race.replies[1]!.endpoint).toBe("https://push.example/2");
    race.replies[1]!.reply.resolve(Response.json(status()));
    await look;
    expect(readPushHealth().health.problem).toBeNull();
    expect(statusRequests).toBe(5);
  });

  it("waits for a registration begun while it waited for the one before", async () => {
    // every registration POST is held until the test answers it, and says when it has gone out
    const posts: ReturnType<typeof deferred<Response>>[] = [];
    const postWaiters: { count: number; resolve: () => void }[] = [];
    const posted = (count: number): Promise<void> => posts.length >= count ? Promise.resolve() : new Promise((resolve) => { postWaiters.push({ count, resolve }); });
    const base = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url !== "/api/push/subscribe" || init?.method !== "POST") return base(url, init);
      const reply = deferred<Response>();
      posts.push(reply);
      for (const waiter of postWaiters.filter((w) => posts.length >= w.count)) { postWaiters.splice(postWaiters.indexOf(waiter), 1); waiter.resolve(); }
      return reply.promise;
    }) as typeof fetch;
    const race = held();
    // registration A; B starts from A's own completion, while a look is waiting for A
    const a = ensurePushSubscription();
    const b = a.then(() => ensurePushSubscription());
    const look = refreshPushHealth(true);
    await posted(1);
    posts[0]!.resolve(new Response(null, { status: 204 }));
    // B registers /1 again, is told it was retired, and replaces it with /2
    await posted(2);
    posts[1]!.resolve(Response.json({ error: { code: "subscription_gone", message: "retired" } }, { status: 410 }));
    await posted(3);
    posts[2]!.resolve(new Response(null, { status: 204 }));
    expect(await b).toBe("https://push.example/2");
    // whatever the look asked, the retired endpoint's answer is gone and the new one's is clean
    await race.sent(1);
    for (const { endpoint, reply } of race.replies) reply.resolve(Response.json(endpoint === "https://push.example/1" ? gone : status()));
    await look;
    expect(race.replies.map((reply) => reply.endpoint)).toEqual(["https://push.example/2"]);
    expect(readPushHealth().health.problem).toBeNull();
  });

  it("tells a subscription the browser no longer holds as missing, without asking the server", async () => {
    live = null;
    await refreshPushHealth(true);
    expect(readPushHealth().health).toEqual({ problem: "missing", repair: true, transient: null });
    expect(statusRequests).toBe(0);
    // no worker registered yet: nothing was looked at, nothing is said
    resetPushHealth();
    Object.defineProperty(globalThis.navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => undefined } });
    await refreshPushHealth(true);
    expect(readPushHealth().health.problem).toBeNull();
  });

  it("lets an action that ends after a reset or a later action say nothing", async () => {
    const first = deferred<"sent">();
    const a = runPushAction("test", () => first.promise, () => true);
    expect(readPushHealth().busy).toBe("test");
    resetPushHealth();
    const second = deferred<"sent">();
    const b = runPushAction("repair", () => second.promise, () => true);
    expect(readPushHealth().busy).toBe("repair");
    // A ends while B is under way: B's state stands, and a third action is still refused
    first.resolve("sent");
    await a;
    expect(readPushHealth()).toMatchObject({ busy: "repair", result: null });
    let ran = false;
    await runPushAction("test", async () => { ran = true; return "sent"; }, () => true);
    expect(ran).toBe(false);
    expect(statusRequests).toBe(0);
    second.resolve("sent");
    await b;
    expect(readPushHealth()).toMatchObject({ busy: null, result: "sent" });
    expect(statusRequests).toBe(1);
  });

  it("runs one test or repair at a time and looks again when it is done", async () => {
    answer = async () => Response.json(gone);
    await refreshPushHealth(true);
    expect(readPushHealth().health.problem).toBe("gone");
    const release = deferred<void>();
    const repair = runPushAction("repair", async () => { await release.promise; answer = async () => Response.json(status({ last_success_at: at(3) })); return "sent"; }, () => true);
    expect(readPushHealth().busy).toBe("repair");
    // a second action while one is under way is refused, not queued
    let ran = false;
    await runPushAction("test", async () => { ran = true; return "sent"; }, () => true);
    expect(ran).toBe(false);
    expect(readPushHealth().busy).toBe("repair");
    release.resolve();
    await repair;
    expect(readPushHealth()).toEqual({ health: { problem: null, repair: false, transient: null }, busy: null, result: "sent", dismissed: null });
    // a failing action still frees the state, as failed
    await expect(runPushAction("test", async () => { throw new Error("no"); }, () => true)).rejects.toThrow("no");
    expect(readPushHealth().busy).toBeNull();
    expect(readPushHealth().result).toBe("failed");
  });

  it("drops an answer and a test's line once another tab or the service worker replaced the subscription", async () => {
    // replaced outside this page's own operations while the answer for the old one was out
    const race = held();
    const look = refreshPushHealth(true);
    await race.sent(1);
    live = standIn("https://push.example/9");
    race.replies[0]!.reply.resolve(Response.json(gone));
    await race.sent(2);
    expect(race.replies[1]!.endpoint).toBe("https://push.example/9");
    race.replies[1]!.reply.resolve(Response.json(status()));
    await look;
    expect(readPushHealth().health.problem).toBeNull();

    // a failed test whose subscription only had a passing failure: its line stands while that subscription does
    answer = async () => Response.json(status({ last_failure_at: at(1), last_failure: "network" }));
    await runPushAction("test", async () => "failed", () => true);
    expect(readPushHealth().result).toBe("failed");
    await refreshPushHealth(true);
    expect(readPushHealth().result).toBe("failed");
    // and goes once a clean subscription replaced it
    live = standIn("https://push.example/10");
    answer = async () => Response.json(status({ last_success_at: at(2) }));
    await refreshPushHealth(true);
    expect(readPushHealth()).toMatchObject({ health: { problem: null }, result: null });

    // a test whose push is out while another tab replaces the subscription: its line is not the new one's
    const release = deferred<void>();
    const pending = runPushAction("test", async () => { await release.promise; return { result: "sent", endpoint: "https://push.example/10" }; }, () => true);
    live = standIn("https://push.example/11");
    release.resolve();
    await pending;
    expect(readPushHealth()).toMatchObject({ health: { problem: null }, result: null });
    // the line stays when the subscription tested is the one held
    await runPushAction("test", async () => ({ result: "sent", endpoint: "https://push.example/11" }), () => true);
    expect(readPushHealth().result).toBe("sent");
    // a test that found no subscription while a registration made one: its "missing" is not the new one's
    await runPushAction("test", async () => ({ result: "missing", endpoint: null }), () => true);
    expect(readPushHealth()).toMatchObject({ health: { problem: null }, result: null });
  });

  it("keeps why a repair failed while the fault it was meant to mend stands", async () => {
    // a browser that will not make a subscription (Brave with its push service off): the repair fails every time
    live = null;
    await refreshPushHealth(true);
    expect(readPushHealth().health.problem).toBe("missing");
    await runPushAction("repair", async () => ({ result: "refused" }), () => true);
    expect(readPushHealth()).toMatchObject({ health: { problem: "missing", repair: true }, busy: null, result: "refused" });
    // a later look at the same fault keeps the reason, rather than asking for the repair that just failed
    await refreshPushHealth(true);
    expect(readPushHealth().result).toBe("refused");
    // a test's failure is still dropped by a fault found later
    await runPushAction("test", async () => ({ result: "failed" }), () => true);
    expect(readPushHealth().result).toBeNull();
    // once a subscription works, the reason has nothing left to explain
    await runPushAction("repair", async () => ({ result: "no-worker" }), () => true);
    expect(readPushHealth().result).toBe("no-worker");
    live = standIn("https://push.example/9");
    await refreshPushHealth(true);
    expect(readPushHealth()).toMatchObject({ health: { problem: null }, result: null });
  });

  it("keeps a no-worker repair failure through looks with no health evidence", async () => {
    live = null;
    await refreshPushHealth(true);
    const worker = Object.getOwnPropertyDescriptor(navigator, "serviceWorker")!;
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => undefined } });
    await runPushAction("repair", async () => ({ result: "no-worker" }), () => true);
    await refreshPushHealth(true);
    expect(readPushHealth()).toMatchObject({ health: { problem: "missing", repair: true }, result: "no-worker" });
    // An older server also supplies no evidence that the failed repair worked.
    Object.defineProperty(navigator, "serviceWorker", worker);
    live = standIn("https://push.example/9");
    answer = async () => Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 });
    await refreshPushHealth(true);
    expect(readPushHealth().result).toBe("no-worker");
    answer = async () => Response.json(status({ last_success_at: at(3) }));
    await refreshPushHealth(true);
    expect(readPushHealth()).toMatchObject({ health: { problem: null }, result: null });
  });

  it("ends a repair failure when another fault replaces it or alerts turn off", async () => {
    answer = async () => Response.json(gone);
    await refreshPushHealth(true);
    await runPushAction("repair", async () => ({ result: "refused" }), () => true);
    live!.options.applicationServerKey = new Uint8Array(65).fill(7).buffer as ArrayBuffer;
    await refreshPushHealth(true);
    expect(readPushHealth()).toMatchObject({ health: { problem: "key-mismatch" }, result: null });
    await runPushAction("repair", async () => ({ result: "unregistered" }), () => true);
    expect(readPushHealth().result).toBe("unregistered");
    await refreshPushHealth(false);
    expect(readPushHealth()).toMatchObject({ health: { problem: null }, result: null });
  });

  describe("a dismissed notice", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "window");
    let records: Map<string, string>;
    let events: EventTarget;
    let tabs = 0;
    const openTab = async (): Promise<typeof import("./pushHealth.ts")> => {
      const path = `./pushHealth.ts?dismissal-tab-${++tabs}`;
      return import(path);
    };
    const storageEvent = (newValue: string | null, key: string | null = "ovis:push-notice-dismissed") => {
      events.dispatchEvent(Object.assign(new Event("storage"), { key, newValue, storageArea: window.localStorage }));
    };
    beforeEach(() => {
      records = new Map();
      events = new EventTarget();
      Object.defineProperty(globalThis, "window", { configurable: true, value: {
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        localStorage: { getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => void records.set(key, value), removeItem: (key: string) => void records.delete(key) },
      } });
    });
    afterEach(() => {
      if (original) Object.defineProperty(globalThis, "window", original);
      else Reflect.deleteProperty(globalThis, "window");
    });

    it("clears a persisted dismissal when another already-open tab sees recovery", async () => {
      const other = await openTab();
      expect(other.readPushHealth().dismissed).toBeNull();
      live = null;
      await refreshPushHealth(true);
      dismissPushNotice();
      live = standIn("https://push.example/9");
      answer = async () => Response.json(status({ last_success_at: at(3) }));
      await other.refreshPushHealth(true);
      expect(records.has("ovis:push-notice-dismissed")).toBe(false);
      live = null;
      const later = await openTab();
      await later.refreshPushHealth(true);
      expect(later.readPushHealth()).toMatchObject({ health: { problem: "missing" }, dismissed: null });
    });

    it("shares dismissals and clears through storage events without replaying stale values", async () => {
      live = null;
      const other = await openTab();
      await other.refreshPushHealth(true);
      await refreshPushHealth(true);
      dismissPushNotice();
      storageEvent("missing");
      expect(other.readPushHealth().dismissed).toBe("missing");
      records.set("ovis:push-notice-dismissed", "gone");
      // A queued event for the earlier dismissal must read the newer stored value.
      storageEvent("missing");
      expect(other.readPushHealth().dismissed).toBe("gone");
      // A tab with a cached "missing" must not overwrite a newer matching dismissal.
      live = standIn("https://push.example/9");
      answer = async () => Response.json(gone);
      await refreshPushHealth(true);
      expect(records.get("ovis:push-notice-dismissed")).toBe("gone");
      records.delete("ovis:push-notice-dismissed");
      storageEvent(null);
      expect(other.readPushHealth().dismissed).toBeNull();
      records.set("ovis:push-notice-dismissed", "invalid");
      storageEvent("invalid");
      expect(other.readPushHealth().dismissed).toBeNull();
      records.set("ovis:push-notice-dismissed", "missing");
      storageEvent(null, null);
      expect(other.readPushHealth().dismissed).toBe("missing");
    });

    it("stays closed for its fault on this device, until another fault or a look that finds alerts working", async () => {
      // nothing to close while nothing is wrong
      dismissPushNotice();
      expect(readPushHealth().dismissed).toBeNull();
      live = null;
      await refreshPushHealth(true);
      dismissPushNotice();
      expect(readPushHealth()).toMatchObject({ health: { problem: "missing" }, dismissed: "missing" });
      expect(records.get("ovis:push-notice-dismissed")).toBe("missing");
      // the same fault again, and a look that saw nothing (no worker registered yet), keep it closed
      await refreshPushHealth(true);
      expect(readPushHealth().dismissed).toBe("missing");
      const worker = Object.getOwnPropertyDescriptor(globalThis.navigator, "serviceWorker")!;
      Object.defineProperty(globalThis.navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => undefined } });
      await refreshPushHealth(true);
      Object.defineProperty(globalThis.navigator, "serviceWorker", worker);
      expect(readPushHealth()).toMatchObject({ health: { problem: null }, dismissed: "missing" });
      // another fault is news
      live = standIn("https://push.example/2");
      answer = async () => Response.json(gone);
      await refreshPushHealth(true);
      expect(readPushHealth()).toMatchObject({ health: { problem: "gone" }, dismissed: null });
      expect(records.has("ovis:push-notice-dismissed")).toBe(false);
      // a look that finds alerts working ends a dismissal, so the next time they fail is news again
      dismissPushNotice();
      answer = async () => Response.json(status({ last_success_at: at(3) }));
      await refreshPushHealth(true);
      expect(readPushHealth()).toMatchObject({ health: { problem: null }, dismissed: null });
      // and so does turning alerts off
      answer = async () => Response.json(gone);
      await refreshPushHealth(true);
      dismissPushNotice();
      expect(records.get("ovis:push-notice-dismissed")).toBe("gone");
      resetPushHealth();
      expect(readPushHealth().dismissed).toBeNull();
      expect(records.has("ovis:push-notice-dismissed")).toBe(false);
    });
  });

  it("keeps a known fault through an answer that proves nothing", async () => {
    answer = async () => Response.json(gone);
    await refreshPushHealth(true);
    expect(readPushHealth().health.problem).toBe("gone");
    // a failing PC (5xx) or a refused key read says nothing of the subscription: the notice stands
    for (const failing of [500, 503]) {
      answer = async () => Response.json({ error: { code: "internal_error", message: "no" } }, { status: failing });
      await refreshPushHealth(true);
      expect(readPushHealth().health).toEqual({ problem: "gone", repair: true, transient: null });
    }
  });

  it("reads the phone app's subscription for this PC, which has no service worker", async () => {
    let held: string | null = "https://push.ovis.sh/v1/push/1";
    const asked: unknown[] = [];
    delete (globalThis.navigator as { serviceWorker?: unknown }).serviceWorker;
    Object.assign(globalThis, { PushManager: undefined, Notification: undefined });
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      PluginHeaders: [{ name: "HerdrShell" }, { name: "OvisPush" }],
      nativePromise: async (_plugin: string, method: string) => {
        if (method === "checkPermissions") return { notifications: "granted" };
        if (method === "getSubscription") return { subscription: held && { endpoint: held, expirationTime: null, keys: { p256dh: "p", auth: "a" } } };
        return undefined;
      },
    };
    answer = async (init) => { asked.push(JSON.parse(String(init?.body))); return Response.json(gone); };
    try {
      await refreshNotificationState();
      await refreshPushHealth(true);
      expect(asked).toEqual([{ subscription: { endpoint: "https://push.ovis.sh/v1/push/1", expirationTime: null, keys: { p256dh: "p", auth: "a" } } }]);
      expect(readPushHealth().health).toEqual({ problem: "gone", repair: true, transient: null });
      // the app keeps no endpoint for this PC: missing, and the server is not asked
      held = null;
      await refreshPushHealth(true);
      expect(readPushHealth().health).toEqual({ problem: "missing", repair: true, transient: null });
      expect(asked).toHaveLength(1);
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
      await refreshNotificationState();
    }
  });
});
