import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signRelayPass } from "../../shared/relay-pass.ts";
import { loadRelayIdentity } from "./identity.ts";
import { RelayPassKeeper, retryAfterMs } from "./pass.ts";
import { bounded, deferred, TestClock } from "./test-helpers.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A keeper over an account service that answers the pass request with `answer` (the challenge always works). */
async function keeper(answer: () => Response | Promise<Response>) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-pass-keeper-"));
  dirs.push(stateDir);
  const identity = loadRelayIdentity(stateDir);
  const clock = new TestClock();
  const passes: string[] = [];
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const fetch = async (request: Request) => new URL(request.url).pathname === "/v1/pc/challenge"
    ? Response.json({ challenge_id: "0".repeat(32), frame: JSON.stringify({ type: "server_challenge", public_key: "9".repeat(64), nonce: "1".repeat(64) }) })
    : answer();
  const signed = () => signRelayPass(keys.privateKey, "0badc0de", identity.server_id, Math.floor(clock.now() / 1000));
  const made = new RelayPassKeeper({ stateDir, identity: () => identity, account: () => "acct_1", service: "https://account.test", fetch, clock, onPass: (pass) => passes.push(pass) });
  return { made, clock, passes, signed, stateDir, identity };
}

test("a pass saved under another account service (a staging one, say) is never sent where that service's passes go", async () => {
  const k = await keeper(async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 }));
  k.made.start();
  await k.made.refresh();
  k.made.stop();
  const saved = (service: string) => new RelayPassKeeper({ stateDir: k.stateDir, identity: () => k.identity, account: () => "acct_1", service, clock: k.clock, onPass: () => {} }).current();
  expect(saved("https://account.test")).toBe(k.passes[0]!);
  expect(saved("https://account-staging.test")).toBeNull();
});

test("the account's refusals are told apart, and asked again later", async () => {
  for (const [status, code, state] of [[403, "not_listed", "not_listed"], [409, "relay_limit", "limit"]] as const) {
    const k = await keeper(() => Response.json({ error: { code } }, { status }));
    k.made.start();
    await k.made.refresh();
    expect(k.made.state).toBe(state);
    expect(k.made.current()).toBeNull();
    expect([...k.clock.tasks.values()].map((task) => task.at)).toEqual([30 * 60_000]);
    k.made.stop();
  }
});

test("a service that cannot answer keeps the pass that holds, and waits as long as it asks", async () => {
  let answer: () => Promise<Response> = async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 });
  const k = await keeper(() => answer());
  k.made.start();
  await k.made.refresh();
  expect(k.made.state).toBe("ok");
  const pass = k.passes[0]!;
  answer = async () => new Response("busy", { status: 503, headers: { "retry-after": "600" } });
  await k.made.refresh();
  expect(k.made.state).toBe("ok");
  expect(k.made.current()).toBe(pass);
  expect([...k.clock.tasks.values()].map((task) => task.at)).toEqual([600_000]);
  k.made.stop();
});

test("a fresh pass the relay refuses too is kept, and the keeper backs off instead of asking again", async () => {
  let asked = 0;
  const k = await keeper(async () => { asked++; return Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 }); });
  k.made.start();
  await k.made.refresh();
  expect(asked).toBe(1);
  await k.made.rejected();
  expect(asked).toBe(2);
  const replacement = k.made.current();
  k.clock.advance(120_000);
  await k.made.rejected();
  expect(asked).toBe(2);
  expect(k.made.current()).toBe(replacement);
  k.made.stop();
});

test("Retry-After in seconds or as an HTTP date, never past 24 hours", () => {
  const now = Date.parse("2026-12-01T00:00:00Z");
  expect(retryAfterMs("120", now)).toBe(120_000);
  expect(retryAfterMs("Tue, 01 Dec 2026 00:10:00 GMT", now)).toBe(600_000);
  expect(retryAfterMs("99999999", now)).toBe(24 * 3600_000);
  for (const bad of [null, "", "-5", "soon", "Mon, 30 Nov 2026 00:00:00 GMT"]) expect(retryAfterMs(bad, now)).toBe(0);
});

test("a renewal time is held to 60 s .. 24 h, and a lifetime the relay would not honor is not taken", async () => {
  for (const [refresh, due] of [[-1, 60_000], [0, 60_000], [43_200, 43_200_000], [172_800, 86_400_000]]) {
    const k = await keeper(async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: refresh }));
    k.made.start();
    await k.made.refresh();
    expect(k.made.current()).not.toBeNull();
    expect([...k.clock.tasks.values()].map((task) => task.at)).toEqual([due!]);
    k.made.stop();
  }
  for (const expires of [172_800 * 2, 100]) {
    const k = await keeper(async () => Response.json({ pass: await k.signed(), expires_in: expires, refresh_in: 43_200 }));
    k.made.start();
    await k.made.refresh();
    expect([expires, k.made.current()]).toEqual([expires, null]);
    k.made.stop();
  }
});

test("a pass that ran out with no new one is no longer reported ok", async () => {
  let answer: () => Promise<Response> = async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 });
  const k = await keeper(() => answer());
  k.made.start();
  await k.made.refresh();
  expect(k.made.state).toBe("ok");
  answer = async () => new Response("down", { status: 503 });
  k.clock.advance(172_800_000);
  expect(k.made.current()).toBeNull();
  expect(k.made.state).toBe("unavailable");
  k.made.stop();
});

test("a pass no longer sent is still the one a relay holds the PC to, until the relay stops honoring it", async () => {
  let answer: () => Promise<Response> = async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 });
  const k = await keeper(() => answer());
  k.made.start();
  await k.made.refresh();
  const pass = k.passes[0]!;
  expect(k.made.honored()).toBe(pass);
  answer = async () => new Response("down", { status: 503 });
  // sent until 5 minutes before it runs out, honored by the relay until 5 minutes after
  k.clock.advance(172_800_000 - 300_000 - 1);
  expect([k.made.current(), k.made.honored()]).toEqual([pass, pass]);
  k.clock.advance(1);
  expect([k.made.current(), k.made.honored()]).toEqual([null, pass]);
  k.clock.advance(600_000 - 1);
  expect([k.made.current(), k.made.honored(), k.made.issuer()]).toEqual([null, pass, "https://account.test"]);
  k.clock.advance(1);
  expect([k.made.current(), k.made.honored(), k.made.issuer()]).toEqual([null, null, null]);
  k.made.stop();
});

test("a pass the relay refused is no longer one it holds the PC to", async () => {
  const k = await keeper(async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 }));
  k.made.start();
  await k.made.refresh();
  expect(k.made.honored()).toBe(k.passes[0]!);
  k.made.stop();
  // dropped, so no limit it named outlives it
  await k.made.rejected();
  expect(k.made.honored()).toBeNull();
});

test("a refresh asked for while a request is out is asked again once it ends", async () => {
  let asked = 0;
  const entered = deferred<void>();
  const gate = deferred<void>();
  const again = deferred<void>();
  const k = await keeper(async () => {
    asked++;
    if (asked === 1) { entered.resolve(); await gate.promise; }
    if (asked === 2) again.resolve();
    return Response.json({ error: { code: "not_listed" } }, { status: 403 });
  });
  k.made.start();
  const first = k.made.refresh();
  await entered.promise;
  // the owner names an account while the old request is out
  void k.made.refresh();
  gate.resolve();
  await first;
  await bounded(again.promise, 2000);
  expect(asked).toBe(2);
  k.made.stop();
});

test("the account proof is never sent on to the origin a redirect names", async () => {
  const elsewhere: string[] = [];
  const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => { elsewhere.push(await request.text()); return Response.json({}); } });
  const service = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new URL(request.url).pathname === "/v1/pc/challenge"
    ? Response.json({ challenge_id: "0".repeat(32), frame: JSON.stringify({ type: "server_challenge", public_key: "9".repeat(64), nonce: "1".repeat(64) }) })
    : new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${other.port}/steal` } }) });
  try {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-pass-keeper-"));
    dirs.push(stateDir);
    const identity = loadRelayIdentity(stateDir);
    const made = new RelayPassKeeper({ stateDir, identity: () => identity, account: () => "acct_1", service: `http://127.0.0.1:${service.port}`, clock: new TestClock(), onPass: () => {} });
    made.start();
    await made.refresh();
    expect(elsewhere).toEqual([]);
    expect(made.state).toBe("unavailable");
    made.stop();
  } finally { await service.stop(true); await other.stop(true); }
});

test("an early refresh waits out the service's Retry-After", async () => {
  let asked = 0;
  const k = await keeper(() => { asked++; return new Response("busy", { status: 429, headers: { "retry-after": "600" } }); });
  k.made.start();
  await k.made.refresh();
  expect(asked).toBe(1);
  await k.made.refresh();
  expect(asked).toBe(1);
  expect([...k.clock.tasks.values()].map((task) => task.at)).toEqual([600_000]);
  k.made.stop();
});

test("a refusal held back by the keeper's own limit never delays the ask a newly named account makes", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-relay-pass-keeper-"));
  dirs.push(stateDir);
  const identity = loadRelayIdentity(stateDir);
  const clock = new TestClock();
  let account: string | null = null;
  let asked = 0;
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const fetch = async (request: Request) => {
    if (new URL(request.url).pathname === "/v1/pc/challenge") return Response.json({ challenge_id: "0".repeat(32), frame: JSON.stringify({ type: "server_challenge", public_key: "9".repeat(64), nonce: "1".repeat(64) }) });
    asked++;
    return Response.json({ pass: await signRelayPass(keys.privateKey, "0badc0de", identity.server_id, Math.floor(clock.now() / 1000)), expires_in: 172_800, refresh_in: 43_200 });
  };
  const made = new RelayPassKeeper({ stateDir, identity: () => identity, account: () => account, service: "https://account.test", fetch, clock, onPass: () => {} });
  made.start();
  // the global and the regional relay refuse this PC at once, before it names any account
  await made.rejected();
  await made.rejected();
  expect(made.state).toBe("no_account");
  account = "acct_1";
  await made.refresh();
  expect(asked).toBe(1);
  expect(made.state).toBe("ok");
  made.stop();
});

test("neither a local limit nor a queued refresh shortens the service's Retry-After", async () => {
  let asked = 0;
  const entered = deferred<void>();
  const gate = deferred<void>();
  const k = await keeper(async () => {
    asked++;
    entered.resolve();
    await gate.promise;
    return new Response("busy", { status: 429, headers: { "retry-after": "600" } });
  });
  k.made.start();
  const first = k.made.refresh();
  await entered.promise;
  // the account changes while the request is out: queued
  void k.made.refresh();
  gate.resolve();
  await first;
  await Promise.resolve();
  expect(asked).toBe(1);
  // the global and the regional relay refuse within the minute
  await k.made.rejected();
  await k.made.rejected();
  expect(asked).toBe(1);
  expect([...k.clock.tasks.values()].map((task) => task.at)).toEqual([600_000]);
  k.made.stop();
});

test("a refusal while a pass still holds is kept apart from the state it shows", async () => {
  let answer: () => Promise<Response> = async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 });
  const k = await keeper(() => answer());
  k.made.start();
  await k.made.refresh();
  answer = async () => Response.json({ error: { code: "not_listed" } }, { status: 403 });
  await k.made.refresh();
  expect([k.made.state, k.made.refusal]).toEqual(["ok", "not_listed"]);
  answer = async () => Response.json({ pass: await k.signed(), expires_in: 172_800, refresh_in: 43_200 });
  await k.made.refresh();
  expect([k.made.state, k.made.refusal]).toEqual(["ok", null]);
  k.made.stop();
});

test("a pass for another PC is not kept", async () => {
  const other = await keeper(async () => Response.json({ pass: await other.signed(), expires_in: 172_800, refresh_in: 43_200 }));
  const k = await keeper(async () => Response.json({ pass: await other.signed(), expires_in: 172_800, refresh_in: 43_200 }));
  k.made.start();
  await k.made.refresh();
  expect(k.made.current()).toBeNull();
  expect(k.passes).toEqual([]);
  k.made.stop();
});
