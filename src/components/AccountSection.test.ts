import { expect, it } from "bun:test";

import { AccountService } from "../lib/account/service.ts";
import { memoryAccountStore, memoryLock, type AccountSession } from "../lib/account/store.ts";
import { translate } from "../lib/i18n.ts";
import { accountListsOf, accountLimitsOf, formatAccountLimits, formatRelayBytes, probeUntilReachable, reachabilityProbe, REPROBE_MS } from "./AccountSection.tsx";

// the relay tab offers the relay's own pairing while the account service cannot be reached (ConnectPhoneDialog's RelayTab)
it("counts an answer the service could give as reachable, and a server error or no answer as not", async () => {
  const seen: boolean[] = [];
  const answering = (status: number) => reachabilityProbe((reachable) => seen.push(reachable), Object.assign(async () => new Response(null, { status }), { preconnect: fetch.preconnect }));
  await answering(200)("https://account.example/v1/providers");
  await answering(404)("https://account.example/v1/providers");
  await answering(503)("https://account.example/v1/providers");
  await answering(502)("https://account.example/v1/providers");
  const offline = reachabilityProbe((reachable) => seen.push(reachable), Object.assign(async (): Promise<Response> => { throw new TypeError("offline"); }, { preconnect: fetch.preconnect }));
  await expect(offline("https://account.example/v1/providers")).rejects.toThrow("offline");
  expect(seen).toEqual([true, true, false, false, false]);
});

it("asks an account service that did not answer again, sooner first, until it answers, and stops when told", async () => {
  const flush = async () => { for (let turn = 0; turn < 5; turn += 1) await Promise.resolve(); };
  const waits: number[] = [];
  let next: (() => void) | null = null;
  const timers = { set: (run: () => void, ms: number) => { waits.push(ms); next = run; return ms; }, clear: () => { next = null; } };
  const answers = [false, false, false, false, true];
  let asked = 0;
  probeUntilReachable(async () => answers[asked++]!, timers);
  for (let turn = 0; turn < 4; turn += 1) { await flush(); next!(); }
  await flush();
  expect(asked).toBe(5);
  expect(waits).toEqual([REPROBE_MS[0], REPROBE_MS[1], REPROBE_MS[2], REPROBE_MS[2]]);
  // stopped (Settings closed, or a new probe took over): nothing is asked again
  asked = 0;
  waits.length = 0;
  const stop = probeUntilReachable(async () => { asked += 1; return false; }, timers);
  await flush();
  stop();
  expect(next).toBeNull();
  expect(asked).toBe(1);
});

it("reads the limits for the sign-in the section shows, and none once another account signed in", async () => {
  const session = (account: string): AccountSession => ({ service: "https://account.test", account, provider: "github", access_token: `at_${account}`, refresh_token: `rt_${account}`, expires_at: Date.now() + 3_600_000, sign_in_id: account });
  const store = memoryAccountStore();
  // the service answers for whichever account the token belongs to
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const account = new Headers(init?.headers).get("authorization")?.replace("Bearer at_", "") ?? "";
    return Response.json({ plan: `plan of ${account}`, pcs_max: 3 });
  };
  const service = new AccountService({ store, fetch: fetch as typeof globalThis.fetch, lock: memoryLock() });
  const shown = session("acct_a");
  await store.set("session", shown);
  expect(await accountLimitsOf(service, shown)).toEqual({ plan: "plan of acct_a", pcs_max: 3 });
  await store.set("session", session("acct_b"));
  expect(await accountLimitsOf(service, shown)).toBeNull();
});

it("drops a limits answer that arrives after the sign-in it was asked for ended in another tab", async () => {
  const session = (account: string): AccountSession => ({ service: "https://account.test", account, provider: "github", access_token: `at_${account}`, refresh_token: `rt_${account}`, expires_at: Date.now() + 3_600_000, sign_in_id: account });
  for (const meanwhile of [session("acct_b"), undefined]) {
    const store = memoryAccountStore();
    const shown = session("acct_a");
    await store.set("session", shown);
    // another tab signs in as someone else, or signs out, while the request is on its way
    const fetch = async (_input: RequestInfo | URL, _init?: RequestInit) => {
      await store.set("session", meanwhile);
      return Response.json({ plan: "plan of acct_a", pcs_max: 3 });
    };
    const service = new AccountService({ store, fetch: fetch as typeof globalThis.fetch, lock: memoryLock() });
    expect(await accountLimitsOf(service, shown)).toBeNull();
  }
});

it("reads the PCs and sign-in methods for the sign-in the section shows, and none once another one is stored", async () => {
  const session = (account: string): AccountSession => ({ service: "https://account.test", account, provider: "github", access_token: `at_${account}`, refresh_token: `rt_${account}`, expires_at: Date.now() + 3_600_000 });
  const answer = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const owner = new Headers(init?.headers).get("authorization")?.replace("Bearer at_", "") ?? "nobody";
    return String(input).endsWith("/v1/pcs")
      ? Response.json({ pcs: [{ server_id: "ab".repeat(16), label: `PC of ${owner}`, added_at: "2026-11-01T00:00:00.000Z", last_seen_at: null }] })
      : Response.json({ identities: [] });
  };
  // stored before the reads: nothing is asked with the other account's token
  {
    const store = memoryAccountStore();
    const asked: string[] = [];
    const service = new AccountService({ store, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { asked.push(new Headers(init?.headers).get("authorization") ?? ""); return answer(input, init); }) as typeof globalThis.fetch, lock: memoryLock() });
    const shown = session("acct_a");
    await store.set("session", shown);
    expect((await accountListsOf(service, shown))?.pcs.map((pc) => pc.label)).toEqual(["PC of acct_a"]);
    await store.set("session", session("acct_b"));
    asked.length = 0;
    expect(await accountListsOf(service, shown)).toBeNull();
    expect(asked).toEqual([]);
  }
  // stored while the answers were on their way: account A's lists are dropped
  {
    const store = memoryAccountStore();
    const shown = session("acct_a");
    await store.set("session", shown);
    const service = new AccountService({ store, fetch: (async (input: RequestInfo | URL, init?: RequestInit) => { await store.set("session", session("acct_b")); return answer(input, init); }) as typeof globalThis.fetch, lock: memoryLock() });
    expect(await accountListsOf(service, shown)).toBeNull();
  }
});

it("formats account limits with server-provided plan name, PCs used/max, and optional relay data", () => {
  const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
  expect(formatRelayBytes(500)).toBe("500 B");
  expect(formatRelayBytes(2048)).toBe("2 KB");
  expect(formatRelayBytes(5 * 1024 * 1024)).toBe("5 MB");
  expect(formatRelayBytes(5 * 1024 * 1024 * 1024)).toBe("5 GB");

  expect(formatAccountLimits(t, { plan: "personal", pcs_max: 3 }, 1)).toEqual({
    label: "Plan · Personal",
    summary: "1/3 PCs",
  });
  expect(formatAccountLimits(t, { plan: "personal", pcs_max: 7, pcs_used: 3, data_cap_bytes: 50 * 1024 * 1024 * 1024, data_used_bytes: Math.round(4.2 * 1024 * 1024 * 1024) }, 1)).toEqual({
    label: "Plan · Personal",
    summary: "3/7 PCs · 4.2 GB / 50 GB relay data",
  });
});
